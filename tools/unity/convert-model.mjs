#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { xxh64, signed, parseMetaRecycleNames, safeBase as sharedSafeBase } from './fileid.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultOutDir = path.join(repoRoot, 'world', 'assets', 'models');
const defaultGuidDb = path.join(__dirname, 'out', 'guids.json');

function die(message, code = 1) {
  console.error(`convert-model: ${message}`);
  process.exit(code);
}

function usage() {
  console.log(`Usage:
  node tools/unity/convert-model.mjs <in.fbx> <out.glb> [--materials <dir>] [--unity-root <project>]
  node tools/unity/convert-model.mjs --batch [dir] [--out-dir world/assets/models] [--unity-root <project>] [--materials <dir>] [--texture-root <dir>]
  node tools/unity/convert-model.mjs --materials <dir> [--out-dir world/assets/models] [--unity-root <project>]

Batch mode reads tools/unity/out/guids.json when present; otherwise it recursively scans the supplied directory for .fbx files.
Outputs a models.json manifest and Unity .mat PBR JSON sidecars under <out-dir>/materials.`);
}

function parseArgs(argv) {
  const args = { positional: [], batch: false, outDir: defaultOutDir, unityRoot: null, materials: null, guidDb: defaultGuidDb, textureRoots: [], dryRun: false, meshFileID: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--batch') args.batch = true;
    else if (a === '--mesh-fileid') args.meshFileID = argv[++i] ?? die('--mesh-fileid requires an id');
    else if (a === '--repair-narrowed') args.repairNarrowed = path.resolve(argv[++i] ?? die('--repair-narrowed requires a dir'));
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i] ?? die('--out-dir requires a path'));
    else if (a === '--unity-root') args.unityRoot = path.resolve(argv[++i] ?? die('--unity-root requires a path'));
    else if (a === '--materials') args.materials = path.resolve(argv[++i] ?? die('--materials requires a path'));
    else if (a === '--texture-root') args.textureRoots.push(path.resolve(argv[++i] ?? die('--texture-root requires a path')));
    else if (a === '--guid-db') args.guidDb = path.resolve(argv[++i] ?? die('--guid-db requires a path'));
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--')) die(`unknown option ${a}`);
    else args.positional.push(a);
  }
  return args;
}

function which(name) {
  const r = spawnSync('bash', ['-lc', `command -v ${shellQuote(name)}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function shellQuote(s) { return `'${String(s).replaceAll("'", "'\\''")}'`; }

function unityMeshFileID(name) { return signed(xxh64(`Type:Mesh->${name}0`, 0n)); }

function availableConverters() {
  const out = [];
  const fbx2 = which('FBX2glTF') || which('fbx2gltf');
  if (fbx2) out.push({ kind: 'fbx2gltf', bin: fbx2 });
  const assimp = which('assimp');
  if (assimp) out.push({ kind: 'assimp', bin: assimp });
  const blender = which('blender');
  if (blender) out.push({ kind: 'blender', bin: blender });
  return out;
}

function pickConverter() {
  return availableConverters()[0] ?? null;
}

function runChecked(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.stdio ?? 'pipe', ...opts });
  if (r.status !== 0) {
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${cmd} ${args.map(shellQuote).join(' ')} failed${out ? `:\n${out}` : ''}`);
  }
  return r;
}

function convertWithFbx2gltf(bin, inFile, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  // Godot/FBX2glTF variants accept -i/-o, --binary, and optionally --embed.
  runChecked(bin, ['-i', inFile, '-o', outFile, '--binary', '--embed']);
}

function convertWithAssimp(bin, inFile, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  // glb2 is Assimp's glTF 2 binary exporter. Pre-transform keeps Unity FBX hierarchies simple for GAIA import.
  runChecked(bin, ['export', inFile, outFile, '-f', 'glb2', '-triangulate', '-joinidenticalvertices', '-pretransformvertices']);
}

function convertWithBlender(bin, inFile, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const script = path.join(os.tmpdir(), `gaia-fbx2glb-${process.pid}.py`);
  writeFileSync(script, `
import bpy, sys
in_file = ${JSON.stringify(inFile)}
out_file = ${JSON.stringify(outFile)}
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.import_scene.fbx(filepath=in_file)
bpy.ops.export_scene.gltf(filepath=out_file, export_format='GLB', export_yup=True, export_texcoords=True, export_normals=True, export_materials='EXPORT', export_images='AUTO')
`, 'utf8');
  runChecked(bin, ['--background', '--factory-startup', '--python', script]);
}

function findBlenderBin() {
  if (process.env.BLENDER_BIN && existsSync(process.env.BLENDER_BIN)) return process.env.BLENDER_BIN;
  if (existsSync('/opt/homebrew/bin/blender')) return '/opt/homebrew/bin/blender';
  return which('blender');
}

function convertWithBlendFile(inFile, outFile) {
  const bin = findBlenderBin();
  if (!bin) throw new Error('no Blender CLI found (set BLENDER_BIN, install /opt/homebrew/bin/blender, or add blender to PATH)');
  mkdirSync(path.dirname(outFile), { recursive: true });
  // .blend is already a native Blender scene, so open it directly and export --
  // no import step needed (unlike the FBX-via-Blender path above).
  const pyExpr = `import bpy; bpy.ops.export_scene.gltf(filepath=${JSON.stringify(outFile)}, export_apply=True)`;
  try {
    execFileSync(bin, ['--background', inFile, '--python-expr', pyExpr], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).map((b) => b.toString('utf8')).join('\n').trim();
    throw new Error(`${bin} --background ${shellQuote(inFile)} --python-expr ... failed${out ? `:\n${out}` : ''}`);
  }
}

function convertWithLegacyFbx(inFile, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const fbx = readLegacyFbx6100(inFile);
  const mesh = meshFromLegacyFbx(fbx);
  writeSimpleGlb(outFile, mesh);
}


const BLANK_TEXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwrO8wAAAABJRU5ErkJggg==',
  'base64',
);

function uniqueExisting(paths) {
  return [...new Set(paths.filter(Boolean).map(p => path.resolve(p)).filter(p => existsSync(p) && statSync(p).isDirectory()))];
}

function discoverTextureRoots(args, modelFiles = []) {
  const roots = [...args.textureRoots];
  if (args.materials) {
    const m = path.resolve(args.materials);
    const base = existsSync(m) && statSync(m).isDirectory() ? m : path.dirname(m);
    roots.push(path.resolve(base, '..', 'Textures'));
  }
  if (args.unityRoot) roots.push(path.join(args.unityRoot, 'Assets', 'PolygonCity', 'Textures'));
  for (const f of modelFiles) {
    const dir = path.dirname(path.resolve(f));
    roots.push(path.resolve(dir, '..', 'Textures'));
    roots.push(path.resolve(dir, '..', '..', 'Textures'));
  }
  return uniqueExisting(roots);
}

function buildTextureIndex(roots) {
  const idx = new Map();
  for (const root of roots) {
    for (const f of walk(root, p => /\.(png|jpe?g|webp|tga|psd)$/i.test(p))) {
      const base = path.basename(f).toLowerCase();
      const stem = base.replace(/\.[^.]+$/, '');
      if (!idx.has(base)) idx.set(base, f);
      if (!idx.has(stem)) idx.set(stem, f);
    }
  }
  return idx;
}

function readGlbJson(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (chunkType === 0x4e4f534a) {
      const jsonText = buf.subarray(dataStart, dataEnd).toString('utf8').trim();
      return { buf, json: JSON.parse(jsonText), jsonStart: dataStart, jsonEnd: dataEnd, jsonHeader: offset };
    }
    offset = dataEnd;
  }
  return null;
}

function writeGlbJson(file, glb, json) {
  const jsonBufRaw = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBufRaw.length % 4)) % 4;
  const jsonBuf = Buffer.concat([jsonBufRaw, Buffer.alloc(pad, 0x20)]);
  const out = Buffer.concat([
    glb.buf.subarray(0, glb.jsonHeader),
    (() => { const h = Buffer.alloc(8); h.writeUInt32LE(jsonBuf.length, 0); h.writeUInt32LE(0x4e4f534a, 4); return h; })(),
    jsonBuf,
    glb.buf.subarray(glb.jsonEnd),
  ]);
  out.writeUInt32LE(out.length, 8);
  writeFileSync(file, out);
}

// Ancestors of a narrowed mesh contribute ONLY unit-conversion scale.
// Their translation/rotation (or matrix) is source-scene placement junk:
// the consuming mesh part's own transform positions the mesh, so baked
// placement here double-applies (wheels rendering ~30m from their hulls).
function cloneTransformNode(node) {
  const out = {};
  if (node?.name != null) out.name = node.name;
  if (node?.scale != null) out.scale = Array.isArray(node.scale) ? [...node.scale] : node.scale;
  else if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    const m = node.matrix;
    const s = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
    if (s.some((v) => Math.abs(v - 1) > 1e-6)) out.scale = s;
  }
  return out;
}

function parentPathToNode(json, targetIndex) {
  const parents = new Map();
  for (let i = 0; i < (json.nodes ?? []).length; i++) {
    for (const child of json.nodes[i]?.children ?? []) {
      if (!parents.has(child)) parents.set(child, i);
    }
  }
  const roots = new Set((json.scenes ?? []).flatMap((s) => s.nodes ?? []));
  const path = [];
  const seen = new Set();
  let cur = targetIndex;
  while (parents.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const parent = parents.get(cur);
    path.unshift(parent);
    cur = parent;
    if (roots.has(cur)) break;
  }
  return path;
}

function findModelMeshFileIDTarget(json, targetFileID, fidToName = null) {
  const want = String(targetFileID);
  for (let i = 0; i < (json.nodes ?? []).length; i++) {
    const name = json.nodes[i]?.name;
    if (typeof name === 'string' && unityMeshFileID(name) === want) return { kind: 'node', nodeIndex: i, meshIndex: json.nodes[i].mesh, name };
  }
  for (let i = 0; i < (json.meshes ?? []).length; i++) {
    const name = json.meshes[i]?.name;
    if (typeof name !== 'string' || unityMeshFileID(name) !== want) continue;
    const nodeIndex = (json.nodes ?? []).findIndex((n) => n?.mesh === i);
    return { kind: 'mesh', nodeIndex: nodeIndex >= 0 ? nodeIndex : null, meshIndex: i, name };
  }
  // Hash match found nothing; fall back to the .meta recycle-name table (gen-1/legacy fileIDs).
  if (fidToName && fidToName.has(want)) {
    const name = fidToName.get(want);
    const nodeIndex = (json.nodes ?? []).findIndex((n) => n?.name === name && n.mesh != null);
    if (nodeIndex >= 0) return { kind: 'node', nodeIndex, meshIndex: json.nodes[nodeIndex].mesh, name };
    const meshIndex = (json.meshes ?? []).findIndex((mesh) => mesh?.name === name);
    if (meshIndex >= 0) {
      const nIdx = (json.nodes ?? []).findIndex((n) => n?.mesh === meshIndex);
      return { kind: 'mesh', nodeIndex: nIdx >= 0 ? nIdx : null, meshIndex, name };
    }
  }
  return null;
}

function keepOnlyModelMeshFileID(glbFile, targetFileID, fidToName = null) {
  const glb = readGlbJson(glbFile);
  const json = glb?.json;
  if (String(targetFileID) === '100100000') return false; // prefab-asset handle: whole model IS the target.
  if (json && (json.meshes || []).length <= 1) return false; // single-mesh model: nothing to narrow.
  const target = json ? findModelMeshFileIDTarget(json, targetFileID, fidToName) : null;
  if (!target) {
    console.warn(`convert-model: warning: --mesh-fileid ${targetFileID} did not match any GLB node/mesh name in ${glbFile}; keeping whole model`);
    return false;
  }

  const nodes = [];
  let lastIndex = null;
  if (target.nodeIndex != null) {
    for (const originalIndex of parentPathToNode(json, target.nodeIndex)) {
      const clone = cloneTransformNode(json.nodes[originalIndex]);
      if (lastIndex != null) nodes[lastIndex].children = [nodes.length];
      lastIndex = nodes.length;
      nodes.push(clone);
    }
  }
  const meshNode = {};
  if (target.name != null) meshNode.name = target.name;
  if (target.meshIndex != null) meshNode.mesh = target.meshIndex;
  if (lastIndex != null) nodes[lastIndex].children = [nodes.length];
  nodes.push(meshNode);

  // TODO: Trim unused meshes/accessors/bufferViews/buffers after the scene is narrowed.
  const outJson = JSON.parse(JSON.stringify(json));
  outJson.nodes = nodes;
  const sceneIndex = Number.isInteger(outJson.scene) ? outJson.scene : 0;
  if (!outJson.scenes?.length) outJson.scenes = [{}];
  outJson.scene = sceneIndex;
  outJson.scenes[sceneIndex] ??= {};
  outJson.scenes[sceneIndex].nodes = [0];
  writeGlbJson(glbFile, glb, outJson);
  return true;
}

function makeGlbDoubleSided(glbFile) {
  const glb = readGlbJson(glbFile);
  if (!glb?.json?.materials?.length) return 0;
  let changed = 0;
  for (const mat of glb.json.materials) {
    if (mat.doubleSided !== true) {
      mat.doubleSided = true;
      changed += 1;
    }
    const pbr = mat.pbrMetallicRoughness ??= {};
    const base = pbr.baseColorFactor;
    const hasTexture = pbr.baseColorTexture || mat.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture;
    if (!hasTexture && (!Array.isArray(base) || Math.max(Number(base[0] ?? 0), Number(base[1] ?? 0), Number(base[2] ?? 0)) < 0.08)) {
      pbr.baseColorFactor = [0.86, 0.9, 0.92, Number(base?.[3] ?? 1)];
      pbr.roughnessFactor ??= 0.72;
      pbr.metallicFactor ??= 0;
      changed += 1;
    }
  }
  if (changed) writeGlbJson(glbFile, glb, glb.json);
  return changed;
}

// ---- FBX unit-scale correction (Unity parity) -------------------------------
// FBX files carry a GlobalSettings UnitScaleFactor (cm per unit). Assimp folds
// the file→meter conversion into a pure uniform scale on scene nodes (e.g.
// Synty SimpleTown: USF=100 → a 0.01 node matrix over meter-sized vertices).
// Unity's ModelImporter with `useFileScale: 0` (every Synty .meta in this
// project) IGNORES that file scale and treats raw vertex units as meters —
// so a faithful port must strip the unit-conversion scale, or the whole pack
// renders at 1/100. We strip any node whose transform is a PURE uniform scale
// equal to 1/USF (no rotation, no translation) when the .meta opts out of
// file scale, and apply the importer's globalScale on top.
function readFbxUnitScaleFactor(fbxFile) {
  try {
    const buf = readFileSync(fbxFile);
    const idx = buf.indexOf('UnitScaleFactor');
    if (idx < 0) return 1;
    if (buf.subarray(0, 18).toString('binary').startsWith('Kaydara FBX Binary')) {
      for (let i = idx + 15; i < Math.min(idx + 240, buf.length - 9); i++) {
        if (buf[i] === 0x44) return buf.readDoubleLE(i + 1); // 'D' double property
      }
      return 1;
    }
    // ASCII FBX: P: "UnitScaleFactor", "double", "Number", "",100
    const line = buf.subarray(idx, idx + 200).toString('utf8');
    const m = line.match(/"UnitScaleFactor"[^,]*,[^,]*,[^,]*,[^,]*,\s*([\d.eE+-]+)/);
    return m ? Number(m[1]) || 1 : 1;
  } catch {
    return 1;
  }
}
function readUnityImporterScale(fbxFile) {
  const out = { useFileScale: 1, globalScale: 1 };
  try {
    const meta = readFileSync(`${fbxFile}.meta`, 'utf8');
    const ufs = meta.match(/^\s*useFileScale:\s*(\d+)/m);
    if (ufs) out.useFileScale = Number(ufs[1]);
    const gs = meta.match(/^\s*globalScale:\s*([\d.eE+-]+)/m);
    if (gs) out.globalScale = Number(gs[1]) || 1;
  } catch {}
  return out;
}
function pureUniformScaleOf(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const m = node.matrix;
    const s = m[0];
    const zeros = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14];
    if (Math.abs(m[5] - s) > 1e-6 * Math.abs(s) || Math.abs(m[10] - s) > 1e-6 * Math.abs(s)) return null;
    if (zeros.some((i) => Math.abs(m[i]) > 1e-9)) return null;
    if (Math.abs(m[15] - 1) > 1e-9) return null;
    return s;
  }
  if (node.rotation || node.translation) return null;
  if (Array.isArray(node.scale) && node.scale.length === 3) {
    const [x, y, z] = node.scale;
    if (Math.abs(y - x) > 1e-6 * Math.abs(x) || Math.abs(z - x) > 1e-6 * Math.abs(x)) return null;
    return x;
  }
  return null;
}
function fixFbxUnitScale(glbFile, fbxFile) {
  // Unity ModelImporter parity. The scale Unity applies to RAW FBX vertex units:
  //   effective = (useFileScale ? UnitScaleFactor / 100 : 1) * globalScale
  // (FBX's native unit is the centimeter; USF = cm per file unit, so USF/100 is
  //  exactly Unity's "File Scale". useFileScale: 0 opts out → raw units = meters.)
  // Assimp instead bakes a pure uniform 1/USF node scale into the GLB. Strip that
  // artifact, then apply Unity's effective scale at the scene roots.
  const importer = readUnityImporterScale(fbxFile);
  const usf = readFbxUnitScaleFactor(fbxFile);
  const effective = (importer.useFileScale !== 0 ? usf / 100 : 1) * importer.globalScale;
  const glb = readGlbJson(glbFile);
  if (!glb?.json?.nodes?.length) return 0;
  let changed = 0;
  for (const node of glb.json.nodes) {
    const s = pureUniformScaleOf(node);
    if (s == null || Math.abs(s - 1) < 1e-6) continue;
    if (Math.abs(s * usf - 1) > 0.02) continue; // only the unit-conversion artifact
    delete node.matrix;
    delete node.scale;
    changed += 1;
  }
  if (Math.abs(effective - 1) > 1e-6) {
    const sceneRoots = glb.json.scenes?.[glb.json.scene ?? 0]?.nodes ?? [];
    for (const idx of sceneRoots) {
      const node = glb.json.nodes[idx];
      if (!node) continue;
      if (Array.isArray(node.matrix) && node.matrix.length === 16) {
        for (let c = 0; c < 12; c += 1) node.matrix[c] *= effective; // scale basis columns
      } else {
        const prev = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
        node.scale = prev.map((v) => v * effective);
      }
      changed += 1;
    }
  }
  if (changed) writeGlbJson(glbFile, glb, glb.json);
  return changed;
}

function readLegacyFbx6100(file) {
  const buf = readFileSync(file);
  if (!buf.subarray(0, 23).toString('binary').startsWith('Kaydara FBX Binary')) {
    throw new Error('legacy fallback only supports binary FBX files');
  }
  const version = buf.readUInt32LE(23);
  if (version >= 7100) throw new Error(`legacy fallback is only for old FBX; got ${version}`);
  const root = { name: '__root__', props: [], children: [] };
  let offset = 27;
  while (offset + 13 <= buf.length) {
    if (isNullRecord(buf, offset)) break;
    const parsed = readLegacyNode(buf, offset);
    if (!parsed.node) break;
    root.children.push(parsed.node);
    offset = parsed.next;
  }
  return root;
}

function isNullRecord(buf, offset) {
  if (offset + 13 > buf.length) return true;
  for (let i = 0; i < 13; i++) if (buf[offset + i] !== 0) return false;
  return true;
}

function readLegacyNode(buf, offset) {
  const endOffset = buf.readUInt32LE(offset); offset += 4;
  const propCount = buf.readUInt32LE(offset); offset += 4;
  const propLen = buf.readUInt32LE(offset); offset += 4;
  const nameLen = buf.readUInt8(offset); offset += 1;
  if (!endOffset && !propCount && !propLen && !nameLen) return { node: null, next: offset };
  const name = buf.subarray(offset, offset + nameLen).toString('utf8'); offset += nameLen;
  const propEnd = offset + propLen;
  const props = [];
  for (let i = 0; i < propCount && offset < propEnd; i++) {
    const r = readLegacyProp(buf, offset);
    props.push(r.value);
    offset = r.next;
  }
  offset = Math.max(offset, propEnd);
  const children = [];
  while (offset + 13 <= endOffset) {
    if (isNullRecord(buf, offset)) { offset += 13; break; }
    const parsed = readLegacyNode(buf, offset);
    if (!parsed.node) { offset = parsed.next; break; }
    children.push(parsed.node);
    offset = parsed.next;
  }
  return { node: { name, props, children }, next: endOffset };
}

function readLegacyProp(buf, offset) {
  const type = String.fromCharCode(buf[offset++]);
  if (type === 'C') return { value: Boolean(buf.readUInt8(offset)), next: offset + 1 };
  if (type === 'Y') return { value: buf.readInt16LE(offset), next: offset + 2 };
  if (type === 'I') return { value: buf.readInt32LE(offset), next: offset + 4 };
  if (type === 'F') return { value: buf.readFloatLE(offset), next: offset + 4 };
  if (type === 'D') return { value: buf.readDoubleLE(offset), next: offset + 8 };
  if (type === 'L') return { value: Number(buf.readBigInt64LE(offset)), next: offset + 8 };
  if (type === 'S' || type === 'R') {
    const len = buf.readUInt32LE(offset); offset += 4;
    const bytes = buf.subarray(offset, offset + len);
    return { value: type === 'S' ? bytes.toString('utf8') : bytes, next: offset + len };
  }
  if ('fdi lbc'.replaceAll(' ', '').includes(type)) {
    const len = buf.readUInt32LE(offset); offset += 4;
    const encoding = buf.readUInt32LE(offset); offset += 4;
    const byteLen = buf.readUInt32LE(offset); offset += 4;
    if (encoding) throw new Error(`compressed FBX arrays are not supported in legacy fallback (${type})`);
    const value = [];
    const stride = type === 'd' || type === 'l' ? 8 : type === 'b' || type === 'c' ? 1 : 4;
    for (let i = 0; i < len; i++) {
      const p = offset + i * stride;
      if (type === 'f') value.push(buf.readFloatLE(p));
      else if (type === 'd') value.push(buf.readDoubleLE(p));
      else if (type === 'i') value.push(buf.readInt32LE(p));
      else if (type === 'l') value.push(Number(buf.readBigInt64LE(p)));
      else value.push(buf.readUInt8(p));
    }
    return { value, next: offset + byteLen };
  }
  throw new Error(`unsupported FBX property type ${type}`);
}

function findNodes(node, name, out = []) {
  if (node.name === name) out.push(node);
  for (const c of node.children ?? []) findNodes(c, name, out);
  return out;
}

function findChild(node, name) {
  return (node.children ?? []).find((c) => c.name === name) ?? null;
}

function firstProp(node, fallback = null) {
  return node?.props?.[0] ?? fallback;
}

function meshFromLegacyFbx(root) {
  const model = findNodes(root, 'Model').find((n) => n.props.includes('Mesh')) ?? findNodes(root, 'Geometry')[0] ?? root;
  const vertsNode = findNodes(model, 'Vertices')[0] ?? findNodes(root, 'Vertices')[0];
  const pviNode = findNodes(model, 'PolygonVertexIndex')[0] ?? findNodes(root, 'PolygonVertexIndex')[0];
  if (!vertsNode || !pviNode) throw new Error('old FBX has no Vertices/PolygonVertexIndex nodes');
  const vertices = propsToNumbers(vertsNode.props);
  const pvi = propsToNumbers(pviNode.props).map((v) => Math.trunc(v));
  const normalRoot = findNodes(model, 'LayerElementNormal')[0] ?? findNodes(root, 'LayerElementNormal')[0];
  const normals = propsToNumbers((findChild(normalRoot, 'Normals')?.props) ?? []);
  const uvRoot = findNodes(model, 'LayerElementUV')[0] ?? findNodes(root, 'LayerElementUV')[0];
  const uvs = propsToNumbers((findChild(uvRoot, 'UV')?.props) ?? []);
  const uvIndex = propsToNumbers((findChild(uvRoot, 'UVIndex')?.props) ?? []).map((v) => Math.trunc(v));
  const textureNode = findNodes(root, 'RelativeFilename')[0] ?? findNodes(root, 'Filename')[0] ?? findNodes(root, 'FileName')[0];
  const textureUri = textureNode ? path.basename(String(firstProp(textureNode, '')).replaceAll('\\', '/')) : null;

  const positions = [];
  const outNormals = [];
  const outUvs = [];
  const indices = [];
  const poly = [];
  let pvCursor = 0;
  const emitVertex = (srcIndex, cursor) => {
    const outIndex = positions.length / 3;
    positions.push(vertices[srcIndex * 3] ?? 0, vertices[srcIndex * 3 + 1] ?? 0, vertices[srcIndex * 3 + 2] ?? 0);
    if (normals.length >= (cursor + 1) * 3) outNormals.push(normals[cursor * 3], normals[cursor * 3 + 1], normals[cursor * 3 + 2]);
    if (uvs.length) {
      const ui = uvIndex.length ? uvIndex[cursor] : cursor;
      outUvs.push(uvs[(ui ?? 0) * 2] ?? 0, 1 - (uvs[(ui ?? 0) * 2 + 1] ?? 0));
    }
    return outIndex;
  };
  for (const raw of pvi) {
    const end = raw < 0;
    const vi = end ? -raw - 1 : raw;
    poly.push({ vi, cursor: pvCursor++ });
    if (end) {
      for (let i = 1; i + 1 < poly.length; i++) {
        indices.push(emitVertex(poly[0].vi, poly[0].cursor), emitVertex(poly[i].vi, poly[i].cursor), emitVertex(poly[i + 1].vi, poly[i + 1].cursor));
      }
      poly.length = 0;
    }
  }
  if (!outNormals.length) outNormals.push(...computeFlatNormals(positions, indices));
  return { positions, normals: outNormals, uvs: outUvs, indices, textureUri };
}

function propsToNumbers(props) {
  return props.flatMap((p) => Array.isArray(p) ? p : [p]).map(Number).filter(Number.isFinite);
}

// ---- Unity .asset serialized Mesh (class !u!43) extraction ------------------
// EasyRoads/RoadConstructor and Unity's runtime mesh bakers write meshes as
// standalone .asset YAML docs. We decode the interleaved vertex buffer
// (`_typelessdata`) + index buffer straight into a GLB. Unity is left-handed
// (+Z forward); GAIA/three is right-handed. The emitter's placement transform
// mirrors Z (see unityToGaiaTransform), so mesh vertices/normals get the SAME
// Z mirror here and triangle winding is reversed to keep faces outward.
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
function vertexFormatBytes(fmt) {
  // Unity VertexAttributeFormat: 0 Float32, 1 Float16, 2 UNorm8, 3 SNorm8,
  // 4 UNorm16, 5 SNorm16, 10 UInt8, 11 SInt8, 12 UInt16, 13 SInt16, ...
  if (fmt === 0) return 4;
  if (fmt === 1 || fmt === 4 || fmt === 5 || fmt === 12 || fmt === 13) return 2;
  return 1;
}
function readVertexComponent(buf, at, fmt) {
  if (fmt === 0) return buf.readFloatLE(at);
  if (fmt === 1) return halfToFloat(buf.readUInt16LE(at));
  if (fmt === 2) return buf.readUInt8(at) / 255;      // UNorm8
  if (fmt === 3) return (buf.readInt8(at)) / 127;      // SNorm8
  if (fmt === 4) return buf.readUInt16LE(at) / 65535;  // UNorm16
  if (fmt === 5) return buf.readInt16LE(at) / 32767;   // SNorm16
  return buf.readUInt8(at);
}
function splitAssetMeshDocs(text) {
  const docs = new Map();
  const re = /--- !u!43 &(-?\d+)[^\n]*\r?\nMesh:\r?\n([\s\S]*?)(?=\r?\n--- !u!|\s*$)/g;
  let m;
  while ((m = re.exec(text))) docs.set(String(m[1]), m[2]);
  return docs;
}
function decodeUnityMeshBody(body) {
  const indexFormat = Number(body.match(/m_IndexFormat:\s*(\d+)/)?.[1] ?? 0); // 0=uint16,1=uint32
  const subs = [...body.matchAll(/firstByte:\s*(\d+)\s*\r?\n\s*indexCount:\s*(\d+)/g)]
    .map((x) => ({ firstByte: +x[1], indexCount: +x[2] }));
  const indexHex = (body.match(/m_IndexBuffer:\s*([0-9a-fA-F]+)/)?.[1] ?? '').trim();
  const vertexCount = Number(body.match(/m_VertexCount:\s*(\d+)/)?.[1] ?? 0);
  const chBlock = body.match(/m_Channels:\s*\r?\n([\s\S]*?)m_DataSize:/)?.[1] ?? '';
  const channels = [...chBlock.matchAll(/-\s*stream:\s*(\d+)\s*\r?\n\s*offset:\s*(\d+)\s*\r?\n\s*format:\s*(\d+)\s*\r?\n\s*dimension:\s*(\d+)/g)]
    .map((x) => ({ stream: +x[1], offset: +x[2], format: +x[3], dimension: +x[4] }));
  const dataSize = Number(body.match(/m_DataSize:\s*(\d+)/)?.[1] ?? 0);
  const typeless = (body.match(/_typelessdata:\s*([0-9a-fA-F]+)/)?.[1] ?? '').trim();
  if (!vertexCount || !typeless || !indexHex) {
    throw new Error('mesh has no uncompressed vertex/index data (empty or m_CompressedMesh)');
  }
  const vbuf = Buffer.from(typeless, 'hex');
  const stride = Math.round(dataSize / vertexCount) || (vbuf.length / vertexCount);
  // Channel index → semantic (Unity VertexAttribute order): 0 pos, 1 normal,
  // 2 tangent, 3 color, 4 uv0 …
  const chan = (i) => (channels[i] && channels[i].dimension > 0 ? channels[i] : null);
  const posC = chan(0), normC = chan(1), uvC = chan(4);
  if (!posC) throw new Error('mesh has no position channel');
  const readAttr = (c, vi) => {
    const base = vi * stride + c.offset;
    const size = vertexFormatBytes(c.format);
    const out = [];
    for (let k = 0; k < c.dimension; k++) out.push(readVertexComponent(vbuf, base + k * size, c.format));
    return out;
  };
  const positions = [], normals = [], uvs = [];
  for (let vi = 0; vi < vertexCount; vi++) {
    const p = readAttr(posC, vi);
    positions.push(p[0], p[1], -p[2]); // mirror Z to match placement transform
    if (normC) { const n = readAttr(normC, vi); normals.push(n[0], n[1], -n[2]); }
    if (uvC) { const u = readAttr(uvC, vi); uvs.push(u[0], 1 - (u[1] ?? 0)); }
  }
  const ibuf = Buffer.from(indexHex, 'hex');
  const totalIdx = subs.reduce((s, x) => s + x.indexCount, 0) || (indexFormat === 1 ? ibuf.length / 4 : ibuf.length / 2);
  const raw = [];
  for (let i = 0; i < totalIdx; i++) raw.push(indexFormat === 1 ? ibuf.readUInt32LE(i * 4) : ibuf.readUInt16LE(i * 2));
  const indices = [];
  for (let i = 0; i + 2 < raw.length; i += 3) indices.push(raw[i], raw[i + 2], raw[i + 1]); // reverse winding
  if (!normals.length) normals.push(...computeFlatNormals(positions, indices));
  return { positions, normals, uvs, indices, textureUri: null };
}
function meshFromUnityAsset(assetFile, targetFileID = null) {
  const text = readFileSync(assetFile, 'utf8');
  const docs = splitAssetMeshDocs(text);
  if (!docs.size) throw new Error(`no serialized Mesh (class 43) in ${assetFile}`);
  const want = targetFileID != null ? String(targetFileID) : null;
  let body = (want && docs.has(want)) ? docs.get(want) : null;
  if (!body) body = docs.get('4300000') ?? docs.values().next().value; // single-mesh fallback
  return decodeUnityMeshBody(body);
}

function computeFlatNormals(positions, indices) {
  const normals = new Array(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const j of [ia, ib, ic]) { normals[j] += nx; normals[j + 1] += ny; normals[j + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return normals;
}

function writeSimpleGlb(file, mesh) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const add = (array, componentType, type, target, minMax = false) => {
    const byteOffset = chunks.reduce((n, b) => n + b.length, 0);
    const buf = componentType === 5125
      ? Buffer.from(new Uint32Array(array).buffer)
      : Buffer.from(new Float32Array(array).buffer);
    const pad = (4 - (buf.length % 4)) % 4;
    chunks.push(pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf);
    const view = { buffer: 0, byteOffset, byteLength: buf.length };
    if (target) view.target = target;
    bufferViews.push(view);
    const acc = { bufferView: bufferViews.length - 1, componentType, count: array.length / (type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1), type };
    if (minMax) {
      acc.min = [Infinity, Infinity, Infinity];
      acc.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i += 3) {
        for (let j = 0; j < 3; j++) { acc.min[j] = Math.min(acc.min[j], array[i + j]); acc.max[j] = Math.max(acc.max[j], array[i + j]); }
      }
    }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const posAccessor = add(mesh.positions, 5126, 'VEC3', 34962, true);
  const normalAccessor = add(mesh.normals, 5126, 'VEC3', 34962);
  const uvAccessor = mesh.uvs?.length ? add(mesh.uvs, 5126, 'VEC2', 34962) : null;
  const indexAccessor = add(mesh.indices, 5125, 'SCALAR', 34963);
  const material = { doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.75 } };
  const json = {
    asset: { version: '2.0', generator: 'GAIA legacy FBX 6100 fallback' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'legacy-fbx-mesh' }],
    meshes: [{ primitives: [{ attributes: { POSITION: posAccessor, NORMAL: normalAccessor, ...(uvAccessor != null ? { TEXCOORD_0: uvAccessor } : {}) }, indices: indexAccessor, material: 0 }] }],
    materials: [material],
    buffers: [{ byteLength: chunks.reduce((n, b) => n + b.length, 0) }],
    bufferViews,
    accessors,
  };
  if (mesh.textureUri) {
    json.images = [{ uri: mesh.textureUri }];
    json.textures = [{ source: 0 }];
    material.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  const bin = Buffer.concat(chunks);
  const jsonRaw = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBuf = Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)]);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  writeFileSync(file, Buffer.concat([header, jh, jsonBuf, bh, bin]));
}

function resolveTextureSource(uri, textureIndex) {
  const raw = String(uri || '').replaceAll('\\\\', '/').replaceAll('\\', '/');
  const base = path.basename(raw).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  return textureIndex.get(base) ?? textureIndex.get(stem) ?? textureIndex.get(stem.replace(/_cars\d+$/, '')) ?? null;
}

// Last-resort fallback when the heuristic textureRoots (sibling Textures/ dirs,
// PolygonCity/Textures) don't have the wanted file: search every path the guid
// DB knows about for one whose basename matches, case-insensitively, first the
// exact wanted filename, then the same stem with a swapped web-loadable
// extension. Mirrors the ambiguity a human would resolve by hand: if exactly
// one distinct file matches, use it; if several do, prefer one with the exact
// wanted extension, else the shortest path (fewest/shallowest folders, i.e.
// most likely the "canonical" copy of a texture duplicated across packages).
function resolveTextureViaGuidMap(uri, guidMap, unityRoot) {
  if (!guidMap || !guidMap.size) return null;
  const raw = String(uri || '').replaceAll('\\\\', '/').replaceAll('\\', '/');
  const wantedBase = path.basename(raw);
  const wantedExt = path.extname(wantedBase).toLowerCase();
  const wantedStem = wantedExt ? wantedBase.slice(0, -wantedExt.length) : wantedBase;
  const passes = [
    [wantedBase],
    ['.png', '.jpg', '.jpeg', '.tga'].map((ext) => `${wantedStem}${ext}`),
  ];
  for (const candidates of passes) {
    const wantSet = new Set(candidates.map((c) => c.toLowerCase()));
    const found = new Map(); // absolute path -> guid-db path (for the log note)
    for (const entry of guidMap.values()) {
      const p = entry?.path ?? entry?.assetPath ?? entry?.file;
      if (!p) continue;
      const base = path.basename(String(p).replaceAll('\\\\', '/').replaceAll('\\', '/'));
      if (!wantSet.has(base.toLowerCase())) continue;
      const abs = resolveUnityPath(p, unityRoot);
      if (abs && existsSync(abs)) found.set(abs, p);
    }
    if (!found.size) continue;
    const distinct = [...found.keys()];
    if (distinct.length === 1) return { path: distinct[0], note: null };
    const extMatches = distinct.filter((abs) => path.extname(abs).toLowerCase() === wantedExt);
    const chosen = extMatches.length === 1
      ? extMatches[0]
      : [...(extMatches.length ? extMatches : distinct)].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    const reason = extMatches.length === 1 ? 'exact-extension match' : 'shortest path';
    const others = distinct.filter((abs) => abs !== chosen).map((abs) => found.get(abs));
    const note = `guid-map fallback for "${wantedBase}": ${distinct.length} matches, chose ${found.get(chosen)} (${reason}) over ${others.join(', ')}`;
    return { path: chosen, note };
  }
  return null;
}

function makeAdjacentTextures(glbFile, textureRoots, guidMap = null, unityRoot = null) {
  const hasGuidFallback = Boolean(guidMap && guidMap.size);
  if (!textureRoots.length && !hasGuidFallback) return { rewritten: 0, placeholders: 0, notes: [] };
  const glb = readGlbJson(glbFile);
  if (!glb?.json?.images?.length) return { rewritten: 0, placeholders: 0, notes: [] };
  const idx = buildTextureIndex(textureRoots);
  let changed = false;
  let rewritten = 0;
  let placeholders = 0;
  const notes = [];
  for (const image of glb.json.images) {
    if (!image.uri || image.uri.startsWith('data:')) continue;
    let src = resolveTextureSource(image.uri, idx);
    if (!src && hasGuidFallback) {
      const fallback = resolveTextureViaGuidMap(image.uri, guidMap, unityRoot);
      if (fallback) {
        src = fallback.path;
        if (fallback.note) notes.push(fallback.note);
      }
    }
    const wanted = path.basename(String(image.uri).replaceAll('\\\\', '/').replaceAll('\\', '/')).replace(/\.[^.]+$/, '') || 'texture';
    let destName;
    if (src) {
      const ext = path.extname(src).toLowerCase();
      // Keep only web/loadable image formats adjacent to the GLB. When an FBX points at a PSD,
      // prefer a same-stem PNG/JPEG if the Unity texture folder has one.
      const loadable = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
      if (!loadable) continue;
      destName = `${wanted.replace(/[^A-Za-z0-9._-]+/g, '_')}${ext}`;
      copyFileSync(src, path.join(path.dirname(glbFile), destName));
    } else {
      destName = `${wanted.replace(/[^A-Za-z0-9._-]+/g, '_')}.missing.png`;
      writeFileSync(path.join(path.dirname(glbFile), destName), BLANK_TEXTURE_PNG);
      placeholders += 1;
    }
    image.uri = destName;
    changed = true;
    rewritten += 1;
  }
  if (changed) writeGlbJson(glbFile, glb, glb.json);
  return { rewritten, placeholders, notes };
}

// ---- External Unity .mat texture embedding ---------------------------------
// FBX/blend files whose textures bind through EXTERNAL Unity .mat assets export
// as textureless GLBs (assimp/blender only see the mesh, the material lives in a
// sibling Materials/ folder). makeAdjacentTextures can't help — it only rewrites
// images that ALREADY exist in the GLB. Here we locate the source model's own
// .mat files, parse m_TexEnvs, resolve the texture guids via guids.json, and
// EMBED the PNGs into the GLB as data-URI images wired to baseColorTexture
// (_BaseMap/_MainTex) and normalTexture (_BumpMap).
function findSourceMatDirs(sourceFile) {
  const dir = path.dirname(path.resolve(sourceFile));
  const parent = path.dirname(dir);
  // Unity packs a mesh's materials either beside the FBX or in a Material(s)
  // folder that is a SIBLING of the mesh's own folder (Prefabs/<Name>/Meshes ->
  // Prefabs/<Name>/Materials). Both spellings occur (Material / Materials).
  const cand = [
    dir,
    path.join(dir, 'Materials'), path.join(dir, 'Material'),
    path.join(parent, 'Materials'), path.join(parent, 'Material'),
  ];
  return cand.filter((d) => existsSync(d) && statSync(d).isDirectory());
}

function findSourceMatFiles(sourceFile) {
  const files = [];
  for (const d of findSourceMatDirs(sourceFile)) {
    for (const f of readdirSync(d)) if (/\.mat$/i.test(f)) files.push(path.join(d, f));
  }
  return [...new Set(files)];
}

function matTokens(s) { return String(s).toLowerCase().replace(/\.[^.]+$/, '').match(/[a-z0-9]+/g) || []; }
function matMatchScore(a, b) {
  const B = new Set(matTokens(b));
  let s = 0;
  for (const t of matTokens(a)) if (B.has(t)) s += (t.length <= 2 ? 2 : 1); // weight discriminators like A/B/1/2
  return s;
}
function chooseSourceMat(parsedMats, sourceFile) {
  if (parsedMats.length === 1) return parsedMats[0];
  const base = path.basename(sourceFile);
  let best = null;
  let bestScore = -1;
  for (const p of parsedMats) {
    const s = Math.max(matMatchScore(base, p.name), matMatchScore(base, path.basename(p.source?.path ?? '')));
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best ?? parsedMats[0];
}

function embedSourceMaterialTextures(glbFile, sourceFile, guidMap, unityRoot) {
  const none = { images: 0 };
  if (!guidMap || !guidMap.size) return none;
  const glb = readGlbJson(glbFile);
  if (!glb?.json) return none;
  const json = glb.json;
  if (json.images?.length) return none; // already textured — leave the model's own textures alone
  const matFiles = findSourceMatFiles(sourceFile);
  if (!matFiles.length) return none;
  let parsed = [];
  for (const f of matFiles) { try { parsed.push(parseUnityMaterial(f, guidMap, unityRoot)); } catch {} }
  parsed = parsed.filter((p) => {
    const t = p?.unity?.textures ?? {};
    return t._BaseMap || t._MainTex || t._BumpMap;
  });
  if (!parsed.length) return none;
  const chosen = chooseSourceMat(parsed, sourceFile);
  const tex = chosen.unity.textures;
  const baseRef = tex._BaseMap ?? tex._MainTex ?? null;
  const normRef = tex._BumpMap ?? null;
  const resolveAbs = (ref) => {
    if (!ref) return null;
    if (ref.absolutePath && existsSync(ref.absolutePath)) return ref.absolutePath;
    const full = resolveUnityPath(ref.path, unityRoot);
    return full && existsSync(full) ? full : null;
  };
  const baseAbs = resolveAbs(baseRef);
  const normAbs = resolveAbs(normRef);
  if (!baseAbs && !normAbs) return none;
  json.images ??= [];
  json.textures ??= [];
  const cache = new Map();
  const addTexture = (abs) => {
    if (cache.has(abs)) return cache.get(abs);
    const ext = path.extname(abs).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) return null; // only web-loadable formats
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const data = readFileSync(abs).toString('base64');
    const imgIndex = json.images.push({ mimeType: mime, uri: `data:${mime};base64,${data}`, name: path.basename(abs) }) - 1;
    const texIndex = json.textures.push({ source: imgIndex }) - 1;
    cache.set(abs, texIndex);
    return texIndex;
  };
  const baseTex = baseAbs ? addTexture(baseAbs) : null;
  const normTex = normAbs ? addTexture(normAbs) : null;
  if (baseTex == null && normTex == null) return none;
  json.materials ??= [];
  if (!json.materials.length) json.materials.push({ name: chosen.name, doubleSided: true });
  for (const mat of json.materials) {
    const pbr = (mat.pbrMetallicRoughness ??= {});
    if (baseTex != null && !pbr.baseColorTexture) {
      pbr.baseColorTexture = { index: baseTex };
      pbr.baseColorFactor = [1, 1, 1, Array.isArray(pbr.baseColorFactor) ? Number(pbr.baseColorFactor[3] ?? 1) : 1];
    }
    if (normTex != null && !mat.normalTexture) mat.normalTexture = { index: normTex };
  }
  writeGlbJson(glbFile, glb, json);
  return {
    images: json.images.length,
    material: chosen.name,
    base: baseAbs ? path.basename(baseAbs) : null,
    normal: normAbs ? path.basename(normAbs) : null,
  };
}

function convertOne(inFile, outFile, converter = null, textureRoots = [], meshFileID = null, guidMap = null, unityRoot = null) {
  if (!existsSync(inFile)) die(`input model not found: ${inFile}`);
  if (/\.asset$/i.test(inFile)) {
    mkdirSync(path.dirname(outFile), { recursive: true });
    const mesh = meshFromUnityAsset(inFile, meshFileID);
    writeSimpleGlb(outFile, mesh);
    if (!existsSync(outFile) || statSync(outFile).size === 0) throw new Error(`asset mesh produced no GLB: ${outFile}`);
    const doubleSided = makeGlbDoubleSided(outFile);
    return { converter: 'unity-asset', bin: 'internal', bytes: statSync(outFile).size, tried: ['unity-asset'], textures: { rewritten: 0, placeholders: 0, notes: [] }, doubleSided };
  }
  if (/\.blend$/i.test(inFile)) {
    const bin = findBlenderBin();
    convertWithBlendFile(inFile, outFile);
    if (!existsSync(outFile) || statSync(outFile).size === 0) throw new Error(`blend export produced no GLB: ${outFile}`);
    embedSourceMaterialTextures(outFile, inFile, guidMap, unityRoot);
    const doubleSided = makeGlbDoubleSided(outFile);
    const textures = makeAdjacentTextures(outFile, textureRoots, guidMap, unityRoot);
    if (meshFileID != null) {
      const metaFile = inFile + '.meta';
      const table = existsSync(metaFile) ? parseMetaRecycleNames(readFileSync(metaFile, 'utf8')) : null;
      keepOnlyModelMeshFileID(outFile, meshFileID, table);
    }
    return { converter: 'blender-blend', bin, bytes: statSync(outFile).size, tried: ['blender-blend'], textures, doubleSided };
  }
  const candidates = converter ? [converter] : availableConverters();
  if (!candidates.length) {
    die('no FBX converter found. Install/build FBX2glTF or assimp, or install Blender CLI. On this Mac, `brew install assimp` provides an arm64 GLB exporter.');
  }
  const errors = [];
  for (const c of candidates) {
    const tmp = `${outFile}.tmp-${process.pid}-${c.kind}.glb`;
    try {
      if (existsSync(tmp)) runChecked('rm', ['-f', tmp]);
      if (c.kind === 'fbx2gltf') convertWithFbx2gltf(c.bin, inFile, tmp);
      else if (c.kind === 'assimp') convertWithAssimp(c.bin, inFile, tmp);
      else convertWithBlender(c.bin, inFile, tmp);
      if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error(`converter produced no GLB: ${tmp}`);
      copyFileSync(tmp, outFile);
      runChecked('rm', ['-f', tmp]);
      if (/\.fbx$/i.test(inFile)) fixFbxUnitScale(outFile, inFile);
      embedSourceMaterialTextures(outFile, inFile, guidMap, unityRoot);
      const doubleSided = makeGlbDoubleSided(outFile);
      const textures = makeAdjacentTextures(outFile, textureRoots, guidMap, unityRoot);
      if (meshFileID != null) {
        const metaFile = inFile + '.meta';
        const table = existsSync(metaFile) ? parseMetaRecycleNames(readFileSync(metaFile, 'utf8')) : null;
        keepOnlyModelMeshFileID(outFile, meshFileID, table);
      }
      return { converter: c.kind, bin: c.bin, bytes: statSync(outFile).size, tried: candidates.map(x => x.kind), textures, doubleSided };
    } catch (err) {
      errors.push(`${c.kind}: ${err.message || err}`);
      try { if (existsSync(tmp)) runChecked('rm', ['-f', tmp]); } catch {}
    }
  }
  try {
    const tmp = `${outFile}.tmp-${process.pid}-legacy-fbx6100.glb`;
    if (existsSync(tmp)) runChecked('rm', ['-f', tmp]);
    convertWithLegacyFbx(inFile, tmp);
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error(`converter produced no GLB: ${tmp}`);
    copyFileSync(tmp, outFile);
    runChecked('rm', ['-f', tmp]);
    if (/\.fbx$/i.test(inFile)) fixFbxUnitScale(outFile, inFile);
    embedSourceMaterialTextures(outFile, inFile, guidMap, unityRoot);
    const doubleSided = makeGlbDoubleSided(outFile);
    const textures = makeAdjacentTextures(outFile, textureRoots, guidMap, unityRoot);
    if (meshFileID != null) {
      const metaFile = inFile + '.meta';
      const table = existsSync(metaFile) ? parseMetaRecycleNames(readFileSync(metaFile, 'utf8')) : null;
      keepOnlyModelMeshFileID(outFile, meshFileID, table);
    }
    return { converter: 'legacy-fbx6100', bin: 'internal', bytes: statSync(outFile).size, tried: [...candidates.map(x => x.kind), 'legacy-fbx6100'], textures, doubleSided };
  } catch (err) {
    errors.push(`legacy-fbx6100: ${err.message || err}`);
  }
  throw new Error(`all converters failed for ${inFile}:\n${errors.join('\n')}`);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function safeBase(file) {
  return path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

function walk(dir, pred = () => true, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

// --repair-narrowed manifest-miss recovery: when a narrowed GLB's own record
// is gone from models.json, rebuild a safeBase(source)->[sources] index by
// scanning unityRoot once, then match the GLB filename's base+hash12 back to
// a unique source file so its .meta recycle-name table can still be used.
const SKIP_SOURCE_SCAN_DIRS = new Set(['Library', 'Temp', 'Logs', 'obj', '.git']);
let sourceBaseMapCache = null;
let sourceBaseMapRoot = null;
function buildSourceBaseMap(unityRoot) {
  const map = new Map();
  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_SOURCE_SCAN_DIRS.has(ent.name)) continue;
        scan(p);
      } else if (/\.(fbx|blend|obj|glb|gltf)$/i.test(ent.name)) {
        const base = sharedSafeBase(p);
        const list = map.get(base);
        if (list) list.push(p); else map.set(base, [p]);
      }
    }
  };
  scan(unityRoot);
  return map;
}
function getSourceBaseMap(unityRoot) {
  if (!sourceBaseMapCache || sourceBaseMapRoot !== unityRoot) {
    sourceBaseMapCache = buildSourceBaseMap(unityRoot);
    sourceBaseMapRoot = unityRoot;
  }
  return sourceBaseMapCache;
}
// Filename shape: <base>-<hash12>-m<fid>.glb (fid may use 'n' for '-', the fidSafe encoding).
function recoverNarrowedSource(glbFileName, unityRoot) {
  if (!unityRoot) return null;
  const stripFid = glbFileName.match(/^(.*)-m[0-9n]+\.glb$/i);
  if (!stripFid) return null;
  const stripHash = stripFid[1].match(/^(.*)-([0-9a-f]{12})$/i);
  if (!stripHash) return null;
  const [, base, hash12] = stripHash;
  const map = getSourceBaseMap(unityRoot);
  const candidates = (map.get(base) ?? []).filter((p) => sha256File(p).startsWith(hash12.toLowerCase()));
  return candidates.length === 1 ? candidates[0] : null;
}

function normalizeGuidDb(raw) {
  const map = new Map();
  if (!raw) return map;
  const add = (guid, value) => {
    if (!guid) return;
    const entry = typeof value === 'string' ? { path: value } : { ...value };
    entry.guid = entry.guid ?? guid;
    map.set(String(guid), entry);
  };
  if (Array.isArray(raw)) {
    for (const v of raw) add(v.guid, v);
  } else if (raw.guids && typeof raw.guids === 'object') {
    for (const [guid, v] of Object.entries(raw.guids)) add(guid, v);
  } else if (raw.assets && Array.isArray(raw.assets)) {
    for (const v of raw.assets) add(v.guid, v);
  } else {
    for (const [guid, v] of Object.entries(raw)) add(guid, v);
  }
  return map;
}

function readGuidDb(file) {
  if (!existsSync(file)) return new Map();
  return normalizeGuidDb(JSON.parse(readFileSync(file, 'utf8')));
}

function inferUnityRoot(args, guidMap) {
  if (args.unityRoot) return args.unityRoot;
  const boomtown = '/Users/pascaldisse/projects/boomtown-rampage';
  if (existsSync(path.join(boomtown, 'Assets'))) return boomtown;
  for (const e of guidMap.values()) {
    if (e.path && path.isAbsolute(e.path)) {
      const idx = e.path.split(path.sep).lastIndexOf('Assets');
      if (idx > 0) return e.path.split(path.sep).slice(0, idx).join(path.sep) || path.sep;
    }
  }
  return null;
}

function resolveUnityPath(assetPath, unityRoot) {
  if (!assetPath) return null;
  if (path.isAbsolute(assetPath)) return assetPath;
  if (unityRoot) return path.resolve(unityRoot, assetPath);
  return path.resolve(assetPath);
}

function sourceFilesFromGuidDb(guidMap, unityRoot) {
  const files = [];
  for (const e of guidMap.values()) {
    const p = e.path ?? e.assetPath ?? e.file;
    if (!p || !/\.(fbx|blend)$/i.test(p)) continue;
    const full = resolveUnityPath(p, unityRoot);
    if (existsSync(full)) files.push(full);
  }
  return [...new Set(files)].sort();
}

function sourceFilesFromDir(dirOrGlob) {
  const input = path.resolve(dirOrGlob);
  if (!existsSync(input)) die(`batch input not found: ${input}`);
  if (statSync(input).isDirectory()) return walk(input, p => /\.(fbx|blend)$/i.test(p)).sort();
  if (/\.(fbx|blend)$/i.test(input)) return [input];
  die(`batch input must be a directory or .fbx file: ${input}`);
}

function parseInlineMap(s) {
  const obj = {};
  for (const part of s.split(',')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) v = Number(v);
    obj[k] = v;
  }
  return obj;
}

function textureRefFromBlock(block, guidMap, unityRoot) {
  const m = block.match(/m_Texture:\s*\{([^}]*)\}/);
  if (!m) return null;
  const inline = parseInlineMap(m[1]);
  if (!inline.guid && Number(inline.fileID ?? 0) === 0) return null;
  const ref = { fileID: inline.fileID ?? null };
  if (inline.guid) {
    ref.guid = String(inline.guid);
    const entry = guidMap.get(ref.guid);
    if (entry?.path) ref.path = entry.path;
    if (entry?.kind) ref.kind = entry.kind;
    const full = resolveUnityPath(ref.path, unityRoot);
    if (ref.path && full && existsSync(full)) ref.absolutePath = full;
  }
  return ref;
}

export function parseUnityMaterial(matFile, guidMap = new Map(), unityRoot = null) {
  const text = readFileSync(matFile, 'utf8');
  const name = text.match(/^\s*m_Name:\s*(.*)$/m)?.[1]?.trim() || path.basename(matFile, '.mat');
  const shaderGuid = text.match(/^\s*m_Shader:\s*\{[^}]*guid:\s*([0-9a-fA-F]+)[^}]*\}/m)?.[1] ?? null;
  const floats = {};
  const colors = {};
  const textures = {};

  for (const m of text.matchAll(/^\s*-\s+([A-Za-z0-9_]+):\s+([-+0-9.eE]+)\s*$/gm)) floats[m[1]] = Number(m[2]);
  for (const m of text.matchAll(/^\s*-\s+([A-Za-z0-9_]+):\s*\{([^}]*)\}\s*$/gm)) {
    const v = parseInlineMap(m[2]);
    if (['r', 'g', 'b', 'a'].some(k => k in v)) colors[m[1]] = [Number(v.r ?? 0), Number(v.g ?? 0), Number(v.b ?? 0), Number(v.a ?? 1)];
  }
  const texRe = /^\s*-\s+([A-Za-z0-9_]+):\s*\n([\s\S]*?)(?=^\s*-\s+[A-Za-z0-9_]+:\s*\n|^\s*m_(Ints|Floats|Colors):|\z)/gm;
  for (const m of text.matchAll(texRe)) {
    const ref = textureRefFromBlock(m[2], guidMap, unityRoot);
    if (ref) textures[m[1]] = ref;
  }

  const smoothness = finite(floats._Smoothness, finite(floats._Glossiness, 0.5));
  const metallic = finite(floats._Metallic, 0);
  const baseColor = colors._BaseColor ?? colors._Color ?? [1, 1, 1, 1];
  const emission = colors._EmissionColor ?? [0, 0, 0, 0];
  const mainTex = textures._MainTex ?? textures._BaseMap ?? null;
  return {
    source: { path: matFile },
    name,
    shaderGuid,
    pbr: {
      baseColor,
      metallic,
      roughness: clamp01(1 - smoothness),
      emission,
      mainTex,
    },
    unity: {
      smoothness,
      surface: finite(floats._Surface, 0),
      renderQueue: finite(Number(text.match(/^\s*m_CustomRenderQueue:\s*(-?\d+)/m)?.[1]), null),
      textures,
      floats,
      colors,
    },
  };
}

function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function clamp01(v) { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); }

function writeMaterials(materialRoot, outDir, guidMap, unityRoot) {
  if (!materialRoot) return [];
  if (!existsSync(materialRoot)) die(`materials path not found: ${materialRoot}`);
  const rootIsDir = statSync(materialRoot).isDirectory();
  const files = rootIsDir ? walk(materialRoot, p => /\.mat$/i.test(p)).sort() : [/\.mat$/i.test(materialRoot) ? materialRoot : die(`--materials expects a .mat or directory: ${materialRoot}`)];
  const matOut = path.join(outDir, 'materials');
  mkdirSync(matOut, { recursive: true });
  const wrote = [];
  for (const f of files) {
    const parsed = parseUnityMaterial(f, guidMap, unityRoot);
    const rel = rootIsDir ? path.relative(materialRoot, f) : path.basename(f);
    const stem = (rel.replace(/\.mat$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_') || safeBase(f));
    const out = path.join(matOut, `${stem}.pbr.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(parsed, null, 2)}\n`);
    wrote.push(out);
  }
  return wrote;
}

function batchConvert(files, outDir, textureRoots = [], guidMap = null, unityRoot = null) {
  mkdirSync(outDir, { recursive: true });
  const converters = availableConverters();
  if (!converters.length) die('no FBX converter found. Install/build FBX2glTF or assimp, or install Blender CLI.');
  const byHash = new Map();
  const manifest = [];
  for (const inFile of files) {
    const hash = sha256File(inFile);
    const short = hash.slice(0, 12);
    const existing = byHash.get(hash);
    const outFile = existing?.outFile ?? path.join(outDir, `${safeBase(inFile)}-${short}.glb`);
    let converted = false;
    let converterKind = existing?.converter ?? null;
    let textureNotes = [];
    if (!existing) {
      if (!existsSync(outFile) || statSync(outFile).size === 0) {
        const r = convertOne(inFile, outFile, null, textureRoots, null, guidMap, unityRoot);
        converted = true;
        converterKind = r.converter;
        textureNotes = r.textures?.notes ?? [];
        byHash.set(hash, { outFile, bytes: r.bytes, converter: r.converter });
      } else {
        byHash.set(hash, { outFile, bytes: statSync(outFile).size, converter: null });
      }
    }
    const rec = {
      source: inFile,
      hash,
      output: path.relative(repoRoot, outFile),
      bytes: statSync(outFile).size,
      deduped: Boolean(existing),
      converted,
      converter: converterKind,
    };
    manifest.push(rec);
    console.log(`${rec.deduped ? 'dedup' : converted ? 'convert' : 'exists'} ${inFile} -> ${rec.output} (${rec.bytes} bytes)`);
    for (const note of textureNotes) console.log(`  ${note}`);
  }
  const manifestPath = path.join(outDir, 'models.json');
  writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: manifest.length, unique: byHash.size, models: manifest }, null, 2)}\n`);
  return { manifestPath, manifest };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) { usage(); process.exit(args.help ? 0 : 1); }
  const guidMap = readGuidDb(args.guidDb);
  const unityRoot = inferUnityRoot(args, guidMap);

  if (args.repairNarrowed) {
    const files = readdirSync(args.repairNarrowed).filter((f) => /-m(-?\d+)\.glb$/i.test(f));
    const manifestPath = path.join(args.repairNarrowed, 'models.json');
    const manifestByOutput = new Map();
    if (existsSync(manifestPath)) {
      const manifestData = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const rec of manifestData.models ?? []) manifestByOutput.set(path.basename(rec.output), rec);
    }
    let repaired = 0;
    for (const f of files) {
      const fid = f.match(/-m(-?\d+)\.glb$/i)[1];
      const rec = manifestByOutput.get(f);
      const source = rec?.source ?? recoverNarrowedSource(f, unityRoot);
      const metaFile = source ? `${source}.meta` : null;
      const table = metaFile && existsSync(metaFile) ? parseMetaRecycleNames(readFileSync(metaFile, 'utf8')) : null;
      if (keepOnlyModelMeshFileID(path.join(args.repairNarrowed, f), fid, table)) repaired += 1;
    }
    console.log('repair-narrowed: ' + repaired + '/' + files.length + ' files re-narrowed');
    process.exit(0);
  }

  try {
    if (args.batch) {
      let files = [];
      if (args.positional[0]) files = sourceFilesFromDir(args.positional[0]);
      else if (existsSync(args.guidDb)) files = sourceFilesFromGuidDb(guidMap, unityRoot);
      else die('--batch needs tools/unity/out/guids.json or a directory argument');
      if (!files.length) die('no FBX files found for batch conversion');
      const textureRoots = discoverTextureRoots(args, files);
      const { manifestPath, manifest } = batchConvert(files, args.outDir, textureRoots, guidMap, unityRoot);
      const matRoot = args.materials ?? (args.positional[0] && existsSync(args.positional[0]) && statSync(path.resolve(args.positional[0])).isDirectory() ? path.resolve(args.positional[0]) : null);
      const materials = writeMaterials(matRoot, args.outDir, guidMap, unityRoot);
      console.log(`wrote ${manifest.length} model records: ${path.relative(repoRoot, manifestPath)}`);
      if (materials.length) console.log(`wrote ${materials.length} material sidecars under ${path.relative(repoRoot, path.join(args.outDir, 'materials'))}`);
    } else if (args.materials && args.positional.length === 0) {
      const materials = writeMaterials(args.materials, args.outDir, guidMap, unityRoot);
      console.log(`wrote ${materials.length} material sidecars under ${path.relative(repoRoot, path.join(args.outDir, 'materials'))}`);
    } else {
      if (args.positional.length < 2) die('single mode requires <in.fbx> <out.glb>');
      const inFile = path.resolve(args.positional[0]);
      const outFile = path.resolve(args.positional[1]);
      const textureRoots = discoverTextureRoots(args, [inFile]);
      const r = convertOne(inFile, outFile, null, textureRoots, args.meshFileID, guidMap, unityRoot);
      console.log(`converted ${inFile} -> ${outFile} with ${r.converter} (${r.bytes} bytes)`);
      for (const note of r.textures?.notes ?? []) console.log(`  ${note}`);
      const materials = writeMaterials(args.materials, path.dirname(outFile), guidMap, unityRoot);
      if (materials.length) console.log(`wrote ${materials.length} material sidecars under ${path.join(path.dirname(outFile), 'materials')}`);
    }
  } catch (err) {
    die(err.stack || err.message || String(err));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
