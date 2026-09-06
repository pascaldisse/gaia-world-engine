import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseFile } from './parse.mjs';

export const STAGES = ['validate', 'guids', 'compose', 'authoring', 'convert', 'emit', 'game-data', 'audit', 'play'];
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink not permitted in output inventory: ${p}`);
    return e.isDirectory() ? files(p) : [p];
  });
}
export function assetKind(file) {
 const ext=path.extname(file).slice(1).toLowerCase();
 if(!ext)return 'folder';
 for(const [kind,extensions] of Object.entries({scene:['unity'],model:['fbx','obj','dae','blend','glb','gltf'],texture:['png','jpg','jpeg','tga','psd','tif','tiff','exr','hdr'],material:['mat'],script:['cs'],animation:['anim'],animator:['controller','overridecontroller'],audio:['wav','mp3','ogg']}))if(extensions.includes(ext))return kind;
 return ext;
}
const within = (root, p) => p === root || p.startsWith(root + path.sep);
export function validateInputs(options) {
  for (const key of ['projectRoot', 'scene', 'enginePath', 'engineVersion', 'outDir']) if (!options[key]) throw new Error(`missing ${key}`);
  const projectRoot = fs.realpathSync(options.projectRoot), scene = fs.realpathSync(options.scene), enginePath = fs.realpathSync(options.enginePath);
  if (!fs.statSync(path.join(projectRoot, 'Assets')).isDirectory()) throw new Error('Unity Assets directory required');
  if (!fs.existsSync(path.join(projectRoot, 'ProjectSettings/ProjectVersion.txt'))) throw new Error('Unity ProjectSettings/ProjectVersion.txt required');
  if (!within(projectRoot, scene) || !/\.(unity|prefab)$/i.test(scene)) throw new Error(`scene outside project or invalid extension: ${scene}`);
  let outDir = path.resolve(options.outDir);
  let ancestor = outDir;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  outDir = path.join(fs.realpathSync(ancestor), path.relative(ancestor, outDir));
  if (within(projectRoot, outDir) || within(outDir, projectRoot) || within(outDir, enginePath)) throw new Error('output overlaps Unity source or engine');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`output must be empty: ${outDir}`);
  const git = args => {
    const r = spawnSync('git', ['-C', enginePath, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`engine version validation: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const expected = git(['rev-parse', '--verify', `${options.engineVersion}^{commit}`]);
  const actual = git(['rev-parse', 'HEAD']);
  git(['merge-base', '--is-ancestor', expected, actual]);
  fs.mkdirSync(outDir, { recursive: true });
  return { ...options, projectRoot, scene, enginePath, outDir, engineRevision: actual, engineBaseRevision: expected, engineWorktreeStatus: git(['status', '--porcelain']), sceneSha256: createHash('sha256').update(fs.readFileSync(scene)).digest('hex'), engineVersionPolicy: 'configured revision must be ancestor of HEAD', unityVersion: fs.readFileSync(path.join(projectRoot, 'ProjectSettings/ProjectVersion.txt'), 'utf8').trim() };
}

export function scanGuids(projectRoot, { guidDatabase, packageRoots = [] } = {}) {
  const guids = {}, conflicts = [], missingAssets = [], roots = ['Assets', 'Packages', 'Library/PackageCache'].map(p => path.join(projectRoot, p)).filter(fs.existsSync).concat(packageRoots.map(p => fs.realpathSync(p)));
  let metaCount = 0;
  for (const root of roots) for (const meta of files(root).filter(p => p.endsWith('.meta'))) {
    metaCount++;
    const guid = /^guid:\s*([a-f0-9]{32})\s*$/im.exec(fs.readFileSync(meta, 'utf8'))?.[1].toLowerCase();
    if (!guid) continue;
    const asset = meta.slice(0, -5), rel = within(projectRoot, asset) ? path.relative(projectRoot, asset) : asset;
    if (guids[guid] && guids[guid].path !== rel) conflicts.push({ guid, paths: [guids[guid].path, rel] });
    else guids[guid] = { path: rel, kind: assetKind(asset) };
  }
  if (guidDatabase) {
    if (!fs.existsSync(guidDatabase)) throw new Error(`required GUID database missing: ${guidDatabase}`);
    const db = readJSON(guidDatabase);
    if (!db.guids || typeof db.guids !== 'object') throw new Error(`invalid GUID database: ${guidDatabase}`);
    for (const [guid, rec] of Object.entries(db.guids)) {
      if (!rec.path) throw new Error(`GUID ${guid}: missing database path`);
      if (guids[guid] && guids[guid].path !== rec.path) conflicts.push({ guid, paths: [guids[guid].path, rec.path], database: true });
      guids[guid] = rec;
    }
  }
  for (const [guid, rec] of Object.entries(guids)) if (!fs.existsSync(path.resolve(projectRoot, rec.path))) missingAssets.push({ guid, path: rec.path });
  return { unityProjectRoot: projectRoot, metaCount, guidCount: Object.keys(guids).length, guids, conflicts, missingAssets, roots, guidDatabase: guidDatabase ?? null };
}

export async function composeScene(scene, db, outDir) {
  const documents = new Map(), unresolved = [], visiting = new Set();
  async function visit(source) {
    if (visiting.has(source)) throw new Error(`prefab cycle: ${source}`);
    if (documents.has(source)) return documents.get(source);
    visiting.add(source);
    const ir = await parseFile(source, db, { onUnresolvedRoot: 'collect' });
    documents.set(source, ir);
    for (const instance of ir.prefabInstances) {
      const ref = instance.source;
      if (!ref?.path || !fs.existsSync(path.resolve(db.unityProjectRoot, ref.path))) unresolved.push({ source, instance: instance.fileID, ref });
      else if (/\.prefab$/i.test(ref.path)) await visit(path.resolve(db.unityProjectRoot, ref.path));
    }
    visiting.delete(source);
    return ir;
  }
  const ir = await visit(scene);
  writeJSON(path.join(outDir, 'scene.ir.json'), ir);
  for (const [source, prefab] of documents) if (source !== scene) writeJSON(path.join(outDir, 'prefabs', createHash('sha256').update(source).digest('hex') + '.json'), prefab);
  return { ir, unresolved, sources: [...documents.keys()], totalDocuments: [...documents.values()].reduce((n,d) => n+d.documentCount,0), limitation: 'hierarchy/stripped transforms composed; instance modifications retained; arbitrary component/child override application not yet verified' };
}

export function inventory(dir) {
  return files(dir).map(file => ({ path: path.relative(dir, file), bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
}
export function diffTrees(baseline, output) {
  const old = new Map(inventory(baseline).map(r => [r.path, r])), next = new Map(inventory(output).map(r => [r.path,r]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().filter(p => old.get(p)?.sha256 !== next.get(p)?.sha256).map(p => ({ path: p, change: !old.has(p) ? 'added' : !next.has(p) ? 'removed' : 'changed', before: old.get(p)?.sha256, after: next.get(p)?.sha256 }));
}

export async function runPipeline(options, hooks = {}) {
  const context = validateInputs(options);
  const report = { countBasis: 'input scene IR; stage-specific counts in result.json', status: 'running', inputs: { ...context }, stages: [] };
  let counts = { documents: 0, directEntities: 0, prefabInstances: 0, unresolved: 0 };
  const persist = () => writeJSON(path.join(context.outDir, 'report.json'), report);
  for (let i=0; i<STAGES.length; i++) {
    const name = STAGES[i], dir = path.join(context.outDir, `${String(i+1).padStart(2,'0')}-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    const row = { stage: i+1, name, status: 'running', counts: { ...counts }, artifacts: [] };
    report.stages.push(row); persist();
    try {
      let result;
      if (i === 0) result = context;
      else if (i === 1) {
        context.db = scanGuids(context.projectRoot, context);
        writeJSON(path.join(dir, 'guids.json'), context.db);
        context.guidPath = path.join(dir, 'guids.json');
        if (context.db.conflicts.length) throw new Error(`conflicting GUIDs: ${context.db.conflicts.length}; inspect guids.json`);
        result = { guidCount: context.db.guidCount, missingAssets: context.db.missingAssets, roots: context.db.roots };
      } else if (i === 2) {
        result = await composeScene(context.scene, context.db, dir);
        context.ir = result.ir; context.irPath = path.join(dir, 'scene.ir.json');
        counts = { documents: result.ir.documentCount, directEntities: result.ir.entities.length, prefabInstances: result.ir.prefabInstances.length, unresolved: result.unresolved.length };
        row.counts = { ...counts };
        writeJSON(path.join(dir, 'composition.json'), { ...result, ir: undefined });
        if (result.unresolved.length) throw new Error(`unresolved prefab references: ${result.unresolved.length}; inspect composition.json`);
        result = { ...result, ir: undefined };
      } else if (hooks[name]) result = await hooks[name](context, dir);
      else result = { status: 'blocked', reason: `stage adapter not implemented: ${name}` };
      row.status = result?.status ?? 'passed';
      writeJSON(path.join(dir, 'result.json'), result ?? {});
      row.artifacts = inventory(dir);
      writeJSON(path.join(dir, 'report.json'), row); persist();
      if (row.status === 'blocked' || row.status === 'failed') { report.status = 'incomplete'; break; }
      if (context.stopAfter === i+1) { report.status = 'partial'; break; }
    } catch (err) {
      row.status = 'failed'; row.error = err.message; row.artifacts = inventory(dir);
      writeJSON(path.join(dir, 'report.json'), row);
      report.status = 'failed'; persist();
      return report;
    }
  }
  if (report.status === 'running') report.status = report.stages.every(r => r.status === 'passed') ? 'passed' : 'incomplete';
  // Mutable context → omit runtime payloads from root report.
  report.inputs = { ...context, db: undefined, ir: undefined };
  persist(); return report;
}

export function jsonDifferences(before, after, pointer = '') {
  if (Object.is(before, after)) return [];
  const object = value => value !== null && typeof value === 'object';
  if (!object(before) || !object(after) || Array.isArray(before) !== Array.isArray(after)) return [{ pointer: pointer || '/', before, after }];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap(key => jsonDifferences(before[key], after[key], `${pointer}/${key.replaceAll('~','~0').replaceAll('/','~1')}`));
}
