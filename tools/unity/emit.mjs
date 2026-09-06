#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnityMaterial } from './convert-model.mjs';
import { unitySubAssetFileID, parseExternalObjectsMaterials, safeBase } from './fileid.mjs';
import { boxToCenterSize, glbAABB, partsAABB } from './glb-aabb.mjs';
import { M4_IDENTITY, m4Mul, m4Decompose, m4IsDecomposable } from './prefab-roots.mjs';
import { PARSER_VERSION } from './parse.mjs';

// The emitter needs IR v2+ (root-relative transforms + authored-root instance
// poses). Anything older carries the OLD meaning and must be re-parsed, never
// silently consumed.
function assertIRVersion(doc, where) {
  // An IR parsed in 'collect' mode may carry instances whose authored root could
  // not be resolved. Their placement is unknown, so emitting is refused outright.
  if (Array.isArray(doc?.rootProblems) && doc.rootProblems.length) {
    throw new Error(`emit: ${where} has ${doc.rootProblems.length} unresolved prefab root(s) -- placement would be wrong:\n  `
      + `${doc.rootProblems.slice(0, 5).join('\n  ')}`);
  }
  const version = Number(doc?.version ?? 0);
  if (Number.isFinite(version) && version >= PARSER_VERSION) return;
  throw new Error(`emit: IR schema v${doc?.version ?? '?'} at ${where} is older than v${PARSER_VERSION} `
    + '(root-relative prefab transforms). Re-run: node tools/unity/parse.mjs <source> --guids <guids.json> --out <ir.json>');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultGuidDb = path.join(__dirname, 'out', 'guids.json');
let sourceModelDir = path.join(repoRoot, 'world', 'assets', 'models');
let policyPath = null, cachePath = null, prepareOnly = false;

function usage() {
  console.error(`usage: node tools/unity/emit.mjs <ir.json> <worldDir> [--guids <guids.json>] [--policy <json>] [--cache-dir <dir>] [--model-cache <models-dir>] [--prepare-assets] [--scene <name>] [--merge-world] [--reuse-models] [--mesh-collider-aabb <true|false>] [--mesh-collider-min-size <meters>] [--mesh-collider-max-boxes <count>] [--max-collider-boxes <count>] [--camera-override <file.json>] [--world-override <file.json>] [--scene-override <file.json>]\n\nMeshCollider hull AABBs default on; caps and minimum extent are policy parameters. Camera override merges authored pose data over the converted rig. World override deep-merges authored GAME declarations (peds, ...) over the emitted world.json, so re-emits cannot delete them.`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args[0] || !args[1] || args[0] === '-h' || args[0] === '--help') usage();
const irPath = path.resolve(args[0]);
const worldDir = path.resolve(args[1]);
let guidDbPath = defaultGuidDb;
let sceneNameOverride = null;
let mergeWorld = false;
let reuseModels = false;
const colliderPolicy = { meshAabb: true, meshMinSize: 0.01, meshMaxBoxes: 16, maxBoxes: 32 };
let meshColliderAabbUnresolved = 0;
let cameraOverridePath = null;
// Authored GAME declarations (pedestrian appearance, ...) live in a DATA file,
// never in this emitter: emit derives world.json from the Unity IR, and the IR
// has no notion of them, so every re-emit used to delete whatever a human had
// hand-written into world.json (BT-011 kept resurrecting). The override file is
// deep-merged last and always wins.
let worldOverridePath = null;
let assetSourcesPath = null;
let sceneOverridePath = null;
function positiveArg(flag, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${flag} requires a positive number`);
    usage();
  }
  return n;
}
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--guids') guidDbPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--scene') sceneNameOverride = args[++i] ?? usage();
  else if (args[i] === '--merge-world') mergeWorld = true;
  else if (args[i] === '--reuse-models') reuseModels = true;
  else if (args[i] === '--policy') policyPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--cache-dir') cachePath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--model-cache') sourceModelDir = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--prepare-assets') prepareOnly = true;
  else if (args[i] === '--mesh-collider-aabb') {
    const value = String(args[++i] ?? '').toLowerCase();
    if (value !== 'true' && value !== 'false') usage();
    colliderPolicy.meshAabb = value === 'true';
  } else if (args[i] === '--mesh-collider-min-size') colliderPolicy.meshMinSize = positiveArg(args[i], args[++i]);
  else if (args[i] === '--mesh-collider-max-boxes') colliderPolicy.meshMaxBoxes = Math.floor(positiveArg(args[i], args[++i]));
  else if (args[i] === '--max-collider-boxes') colliderPolicy.maxBoxes = Math.floor(positiveArg(args[i], args[++i]));
  else if (args[i] === '--camera-override') cameraOverridePath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--world-override') worldOverridePath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--asset-sources') assetSourcesPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--scene-override') sceneOverridePath = path.resolve(args[++i] ?? usage());
  else usage();
}

const policy = policyPath ? JSON.parse(readFileSync(policyPath, 'utf8')) : {};
const ir = JSON.parse(readFileSync(irPath, 'utf8'));
// SCHEMA GATE. An IR produced before the root-relative fix looks perfectly
// valid -- it just carries the old, double-baked meaning. Emitting from it would
// silently reproduce the bug, so refuse with the exact command that fixes it.
// (Prefab IR caches are re-parsed automatically; see parsePrefab.)
assertIRVersion(ir, irPath);
const guidDb = existsSync(guidDbPath) ? JSON.parse(readFileSync(guidDbPath, 'utf8')) : { guids: {} };
const guidMap = normalizeGuidMap(guidDb);
const unityRoot = ir.unityProjectRoot ?? guidDb.unityProjectRoot ?? inferUnityRoot(guidDb) ?? path.dirname(ir.source ?? '.');
const sceneName = safeSlug(sceneNameOverride ?? path.basename(ir.source ?? irPath, path.extname(ir.source ?? irPath))) || 'main';
const targetModelDir = path.join(worldDir, 'assets', 'models');
const targetSceneDir = path.join(worldDir, 'scenes');
const targetPrefabDir = path.join(worldDir, 'prefabs');
const prefabCacheDir = cachePath ?? path.join(worldDir, '.import-cache', 'prefab-ir');

mkdirSync(targetModelDir, { recursive: true });
mkdirSync(targetSceneDir, { recursive: true });
mkdirSync(targetPrefabDir, { recursive: true });
mkdirSync(prefabCacheDir, { recursive: true });

// Unity is left-handed Y-up; GAIA/three is right-handed Y-up. We mirror the Z
// axis exactly once at the emitter boundary. For rotations, the quaternion
// basis-change is q' = (-x, -y, z, w), then GAIA stores the equivalent XYZ
// Euler radians. FBX importers may bake their own mesh-axis fix into GLBs; this
// function is ONLY for authored placement transforms from Unity YAML/IR.
function unityToGaiaTransform(t = {}) {
  const p = t.position ?? { x: 0, y: 0, z: 0 };
  const q = t.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const s = t.scale ?? { x: 1, y: 1, z: 1 };
  const out = {
    position: roundVec([num(p.x), num(p.y), -num(p.z)]),
    rotation: quatToEulerXYZ({ x: -num(q.x), y: -num(q.y), z: num(q.z), w: num(q.w, 1) }),
    scale: roundVec([num(s.x, 1), num(s.y, 1), num(s.z, 1)]),
  };
  if (nearVec(out.rotation, [0, 0, 0], 1e-5)) delete out.rotation;
  if (nearVec(out.scale, [1, 1, 1], 1e-5)) delete out.scale;
  return out;
}

function unityVecToGaiaLocal(v, fallback = [0, 0, 0]) {
  if (!v) return fallback;
  return roundVec([num(v.x, fallback[0]), num(v.y, fallback[1]), -num(v.z, fallback[2])]);
}

function unitySizeToGaia(v, fallback = [1, 1, 1]) {
  if (!v) return fallback;
  return roundVec([Math.abs(num(v.x, fallback[0])), Math.abs(num(v.y, fallback[1])), Math.abs(num(v.z, fallback[2]))]);
}

function quatToEulerXYZ(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  const x = q.x / n, y = q.y / n, z = q.z / n, w = q.w / n;
  const sx = 2 * (w * x + y * z);
  const cx = 1 - 2 * (x * x + y * y);
  const rx = Math.atan2(sx, cx);
  const sy = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const ry = Math.asin(sy);
  const sz = 2 * (w * z + x * y);
  const cz = 1 - 2 * (y * y + z * z);
  const rz = Math.atan2(sz, cz);
  return roundVec([rx, ry, rz]);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round(n) { return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6; }
function roundVec(v) { return v.map(round); }
function nearVec(a, b, eps) { return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps); }

// --- Unity-space transform composition (for descending nested/variant prefabs)
// Prefab IR world transforms are prefab-local; we compose child-under-parent in
// Unity space, then convert to GAIA once at the leaf via unityToGaiaTransform.
const U_ZERO = { x: 0, y: 0, z: 0 }, U_ONE = { x: 1, y: 1, z: 1 }, U_IDQ = { x: 0, y: 0, z: 0, w: 1 };
function uMul(a, b) { return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z }; }
function uAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function uQMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function uQRot(q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
function uNormWorld(w) {
  return {
    position: { x: num(w?.position?.x), y: num(w?.position?.y), z: num(w?.position?.z) },
    rotation: { x: num(w?.rotation?.x), y: num(w?.rotation?.y), z: num(w?.rotation?.z), w: num(w?.rotation?.w, 1) },
    scale: { x: num(w?.scale?.x, 1), y: num(w?.scale?.y, 1), z: num(w?.scale?.z, 1) },
  };
}
function uCompose(parent, local) {
  const p = uNormWorld(parent), l = uNormWorld(local);
  return {
    position: uAdd(p.position, uQRot(p.rotation, uMul(p.scale, l.position))),
    rotation: uQMul(p.rotation, l.rotation),
    scale: uMul(p.scale, l.scale),
  };
}
const U_IDENTITY = { position: { ...U_ZERO }, rotation: { ...U_IDQ }, scale: { ...U_ONE } };

function inferUnityRoot(db) {
  for (const e of Object.values(db.guids ?? db)) {
    const p = e?.path;
    if (p && path.isAbsolute(p)) {
      const parts = p.split(path.sep);
      const idx = parts.lastIndexOf('Assets');
      if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
    }
  }
  return null;
}
function normalizeGuidMap(raw) {
  const map = new Map();
  const add = (guid, value) => {
    if (!guid) return;
    const entry = typeof value === 'string' ? { path: value } : { ...(value ?? {}) };
    entry.guid = entry.guid ?? guid;
    map.set(String(guid), entry);
  };
  if (Array.isArray(raw)) {
    for (const v of raw) add(v?.guid, v);
  } else if (raw?.guids && typeof raw.guids === 'object') {
    for (const [guid, v] of Object.entries(raw.guids)) add(guid, v);
  } else if (Array.isArray(raw?.assets)) {
    for (const v of raw.assets) add(v?.guid, v);
  } else if (raw && typeof raw === 'object') {
    for (const [guid, v] of Object.entries(raw)) add(guid, v);
  }
  return map;
}
function resolveUnityPath(assetPath) {
  if (!assetPath) return null;
  return path.isAbsolute(assetPath) ? assetPath : path.resolve(unityRoot, assetPath);
}
function safeSlug(s) {
  return String(s ?? '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}
function shortHash(s) { return createHash('sha1').update(String(s)).digest('hex').slice(0, 8); }
function sha256File(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function relAssetUrl(file) { return `/assets/models/${path.basename(file)}`; }
function shellQuote(s) { return `'${String(s).replaceAll("'", "'\\''")}'`; }

const modelRecords = new Map(); // source abs -> manifest rec
const skippedModels = [];
const modelBySource = new Map();
const modelBySourceAndFileID = new Map();
const loadedManifestRecords = []; // raw records as read from disk, across all loaded manifests
loadExistingModelManifest(path.join(sourceModelDir, 'models.json'));
loadExistingModelManifest(path.join(targetModelDir, 'models.json'));

function modelCacheKey(source, fileID = '') { return `${path.resolve(source)}\0${String(fileID ?? '')}`; }
function loadExistingModelManifest(file) {
  if (!existsSync(file)) return;
  const base = path.dirname(file);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const rec of data.models ?? []) {
    loadedManifestRecords.push(rec);
    const source = path.resolve(rec.source);
    const output = path.isAbsolute(rec.output) ? rec.output : path.resolve(base, '..', '..', rec.output);
    const fileID = rec.fileID ?? path.basename(output).match(/-m(-?\d+|n\d+)\.glb$/)?.[1]?.replace(/^n/, '-');
    const cached = { ...rec, fileID, source, output, manifestBase: base };
    if (!fileID) modelBySource.set(source, cached);
    modelBySourceAndFileID.set(modelCacheKey(source, fileID ?? ''), cached);
  }
}

function copyGlbSidecarImages(srcGlb, destDir) {
  const images = readGlbImageUris(srcGlb);
  for (const uri of images) {
    if (!uri || uri.startsWith('data:') || /^https?:/i.test(uri)) continue;
    const src = path.resolve(path.dirname(srcGlb), uri);
    if (existsSync(src)) copyFileSync(src, path.join(destDir, path.basename(uri)));
  }
}
function readGlbImageUris(file) {
  try {
    const buf = readFileSync(file);
    if (buf.readUInt32LE(0) !== 0x46546c67) return [];
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const len = buf.readUInt32LE(offset);
      const type = buf.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (type === 0x4e4f534a) {
        const json = JSON.parse(buf.subarray(start, start + len).toString('utf8').trim());
        return (json.images ?? []).map((i) => i.uri).filter(Boolean);
      }
      offset = start + len;
    }
  } catch {}
  return [];
}
function readGlbJson(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      return { buf, json: JSON.parse(buf.subarray(start, start + len).toString('utf8').trim()), jsonHeader: offset, jsonEnd: start + len };
    }
    offset = start + len;
  }
  return null;
}
function glbMeshCount(file) {
  try {
    return readGlbJson(file)?.json?.meshes?.length ?? 0;
  } catch {
    return 0;
  }
}
function writeGlbJson(file, glb, json) {
  const jsonRaw = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBuf = Buffer.concat([jsonRaw, Buffer.alloc(pad, 0x20)]);
  const out = Buffer.concat([
    glb.buf.subarray(0, glb.jsonHeader),
    (() => { const h = Buffer.alloc(8); h.writeUInt32LE(jsonBuf.length, 0); h.writeUInt32LE(0x4e4f534a, 4); return h; })(),
    jsonBuf,
    glb.buf.subarray(glb.jsonEnd),
  ]);
  out.writeUInt32LE(out.length, 8);
  writeFileSync(file, out);
}
function makeGlbDoubleSided(file) {
  try {
    const glb = readGlbJson(file);
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
    if (changed) writeGlbJson(file, glb, glb.json);
    return changed;
  } catch (err) {
    console.warn(`[emit] could not mark GLB materials double-sided for ${file}: ${err.message}`);
    return 0;
  }
}

// Unity's built-in primitive meshes live in the default-resources library
// (guid all-zero + 'e000...'); their MeshFilter references have NO asset path,
// so ensureModel() can't resolve them and the entity would emit meshless. Map
// the well-known fileIDs to a GAIA box part at the primitive's BASE size — the
// entity's transform.scale (kept when non-unit) scales it at render, exactly as
// it does for model parts, so we do NOT bake localScale into the size here.
const BUILTIN_MESH_GUID = '0000000000000000e000000000000000';
const BUILTIN_PRIMITIVE_SIZE = {
  '10202': [1, 1, 1],       // Cube          (1×1×1 m)
  '10209': [10, 0.02, 10],  // Plane         (10×10 m, ~flat)
  '10206': [1, 2, 1],       // Cylinder      (box approx: Ø1 × 2 m tall)
  '10207': [1, 1, 1],       // Sphere        (box approx: Ø1 m)
};
function isBuiltinMeshRef(meshRef) {
  return Boolean(meshRef && !meshRef.path
    && String(meshRef.guid ?? '').toLowerCase() === BUILTIN_MESH_GUID
    && BUILTIN_PRIMITIVE_SIZE[String(meshRef.fileID)]);
}
function builtinMeshPart(meshRef, entity) {
  const size = BUILTIN_PRIMITIVE_SIZE[String(meshRef.fileID)];
  if (!size) return null;
  // Unity built-in primitives ship with a collider by default — they are floors
  // and blockers (the boomtown ground Plane among them), so emit them solid.
  const part = { shape: 'box', size: [...size], solid: true, castShadow: entity.components?.meshRenderer?.castShadows !== 0 };
  const mat = ensureMaterial((entity.components?.meshRenderer?.materials ?? [])[0]);
  if (mat) part.material = mat;
  else part.color = '#9aa0a6';
  return part;
}

const assetSources = assetSourcesPath ? JSON.parse(readFileSync(assetSourcesPath, 'utf8')) : {};
function textureAliasArgs(source) {
  const aliases = assetSources.textureAliases?.[path.relative(unityRoot, source)];
  if (!aliases) return [];
  const file = path.join(prefabCacheDir, `aliases-${shortHash(source)}.json`);
  writeFileSync(file, JSON.stringify(aliases));
  return ['--texture-aliases', file];
}
function fidSafe(fid) { return String(fid).replace('-', 'n'); }
function ensureModel(meshRef) {
  if (!meshRef?.path) return null;
  const source = resolveUnityPath(meshRef.path);
  if (!source || !existsSync(source)) {
    console.warn(`[emit] missing mesh source: ${meshRef.path}`);
    skippedModels.push({ source: meshRef.path, reason: 'missing' });
    return null;
  }
  if (!/\.(fbx|glb|gltf|asset|blend)$/i.test(source)) {
    console.warn(`[emit] unsupported mesh asset (skipping; not FBX/GLB/asset/blend): ${meshRef.path}`);
    skippedModels.push({ source: meshRef.path, reason: 'unsupported' });
    return null;
  }
  // Unity .asset files can hold MANY serialized meshes; model files can expose
  // MANY named GLB meshes/nodes. The meshFilter picks one by fileID anchor.
  const isAsset = /\.asset$/i.test(source);
  const fid = meshRef.fileID != null ? String(meshRef.fileID) : '';
  const wantFid = fid && fid !== '0';
  const hash = sha256File(source);
  const baseName = `${safeBase(source)}-${hash.slice(0, 12)}`;
  const outFile = path.join(targetModelDir, `${baseName}${isAsset && wantFid ? `-m${fidSafe(fid)}` : ''}.glb`);
  const existing = modelBySource.get(path.resolve(source));
  const cached = wantFid ? (modelBySourceAndFileID.get(modelCacheKey(source, fid)) ?? existing) : existing;
  if (reuseModels) {
    const cachedFile = cached?.output && existsSync(cached.output) ? cached.output : existsSync(outFile) ? outFile : null;
    if (!cachedFile) {
      skippedModels.push({ source, reason: 'reuse-cache-missing' });
      return null;
    }
    const rec = { source: path.resolve(source), fileID: cached?.fileID, hash, output: path.relative(worldDir, cachedFile), bytes: statSync(cachedFile).size };
    modelRecords.set(cachedFile, rec);
    return { src: relAssetUrl(cachedFile), source: rec.source, file: cachedFile };
  }
  if (!existsSync(outFile) || statSync(outFile).size === 0) {
    if (!isAsset && existing?.output && existsSync(existing.output)) {
      copyFileSync(existing.output, outFile);
      copyGlbSidecarImages(existing.output, targetModelDir);
    } else {
      const extra = isAsset && fid ? ['--mesh-fileid', fid] : [];
      const r = spawnSync(process.execPath, [path.join(__dirname, 'convert-model.mjs'), source, outFile, '--unity-root', unityRoot, '--guid-db', guidDbPath, ...textureAliasArgs(source), ...extra], { encoding: 'utf8' });
      if (r.status !== 0) {
        const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        console.warn(`[emit] model conversion failed (skipping): ${source}\n${out.split('\n').slice(0, 8).join('\n')}`);
        skippedModels.push({ source, reason: 'convert-failed' });
        return null;
      }
      process.stderr.write(r.stdout);
    }
  }
  let finalOutFile = outFile;
  let recFileID = isAsset && wantFid ? fid : '';
  if (!isAsset && wantFid && glbMeshCount(outFile) > 1) {
    const subOutFile = path.join(targetModelDir, `${baseName}-m${fid}.glb`);
    const cached = modelBySourceAndFileID.get(modelCacheKey(source, fid));
    if (!existsSync(subOutFile) || statSync(subOutFile).size === 0) {
      if (cached?.output && existsSync(cached.output)) {
        copyFileSync(cached.output, subOutFile);
        copyGlbSidecarImages(cached.output, targetModelDir);
      } else {
        const r = spawnSync(process.execPath, [path.join(__dirname, 'convert-model.mjs'), source, subOutFile, '--unity-root', unityRoot, '--guid-db', guidDbPath, ...textureAliasArgs(source), '--mesh-fileid', fid], { encoding: 'utf8' });
        if (r.status !== 0) {
          const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
          console.warn(`[emit] model sub-mesh conversion failed (using whole model): ${source} fileID=${fid}\n${out.split('\n').slice(0, 8).join('\n')}`);
        } else {
          process.stderr.write(r.stdout);
        }
      }
    }
    if (existsSync(subOutFile) && statSync(subOutFile).size > 0) {
      finalOutFile = subOutFile;
      recFileID = fid;
    }
  }
  if (!isAsset) makeGlbDoubleSided(finalOutFile);
  const rec = {
    source: path.resolve(source),
    fileID: recFileID || undefined,
    hash,
    output: path.relative(worldDir, finalOutFile),
    bytes: statSync(finalOutFile).size,
  };
  modelRecords.set(finalOutFile, rec);
  return { src: relAssetUrl(finalOutFile), source: rec.source, file: finalOutFile };
}

function materialName(ref) {
  if (!ref?.path) return null;
  return `${safeSlug(path.basename(ref.path, path.extname(ref.path)))}_${shortHash(ref.path)}`;
}
function colorToHex(c, fallback = '#ffffff') {
  if (!Array.isArray(c)) return fallback;
  const to = (v) => Math.max(0, Math.min(255, Math.round(num(v, 1) * 255))).toString(16).padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}
function alphaOf(c) { return Array.isArray(c) && Number.isFinite(Number(c[3])) ? Number(c[3]) : 1; }
function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

const pbrByMaterialPath = new Map();
for (const dir of [path.join(sourceModelDir, 'materials'), path.join(targetModelDir, 'materials')]) {
  for (const file of walk(dir, (p) => p.endsWith('.pbr.json'))) {
    try {
      const pbr = JSON.parse(readFileSync(file, 'utf8'));
      const src = pbr?.source?.path;
      if (src) pbrByMaterialPath.set(path.resolve(src), pbr);
    } catch (err) {
      console.warn(`[emit] bad material sidecar ${file}: ${err.message}`);
    }
  }
}
const gaiaMaterials = loadExistingMaterials(path.join(worldDir, 'materials.json'));
const builtMaterialNames = new Set(); // names refreshed this run (see ensureMaterial)
function loadExistingMaterials(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return {}; }
}
// Model files (FBX/blend/obj/glb/gltf) can carry embedded sub-asset materials.
// Unity's ModelImporter lets a .fbx.meta remap those embedded materials to real
// .mat assets via `externalObjects`; without a remap the embedded material
// should render as-is (the GLB's own material), never as a default white
// override. This resolves ref (a MeshRenderer material ref pointing INTO a
// model file) through that remap when one exists.
function modelEmbeddedMaterialRemap(ref) {
  const abs = resolveUnityPath(ref?.path);
  if (!abs || !/\.(fbx|blend|obj|glb|gltf)$/i.test(abs)) return undefined; // not a model ref
  const metaFile = `${abs}.meta`;
  if (!existsSync(metaFile)) return null;
  const entries = parseExternalObjectsMaterials(readFileSync(metaFile, 'utf8'));
  let match = entries.find((entry) => String(unitySubAssetFileID('Material', entry.name)) === String(ref.fileID));
  if (!match && entries.length === 1) match = entries[0];
  if (!match) return null;
  const target = guidMap.get(match.guid);
  if (!target?.path || !/\.mat$/i.test(target.path)) return null;
  return { path: target.path, fileID: '2100000' };
}

function ensureMaterial(ref) {
  const remapped = modelEmbeddedMaterialRemap(ref);
  if (remapped === null) return null; // embedded material, no external remap: keep the GLB's own material
  if (remapped) ref = remapped;
  const name = materialName(ref);
  if (!name) return null;
  // refresh each doc once per run (docs are pure functions of the source .mat,
  // and a stale loaded doc would never learn new fields like normalMap);
  // loaded entries no ref touches this run survive as-is
  if (builtMaterialNames.has(name)) return name;
  builtMaterialNames.add(name);
  let pbr = ref.path ? pbrByMaterialPath.get(resolveUnityPath(ref.path)) : null;
  if (!pbr) pbr = parseMaterialPbr(ref);
  const base = pbr?.pbr?.baseColor ?? [1, 1, 1, 1];
  const emission = pbr?.pbr?.emission ?? [0, 0, 0, 0];
  const doc = {
    color: colorToHex(base),
    roughness: num(pbr?.pbr?.roughness, 0.55),
    metalness: num(pbr?.pbr?.metallic, 0),
  };
  const map = materialTextureMap(pbr?.pbr?.mainTex);
  if (map) doc.map = map;
  // URP Lit _BumpMap -> part normalMap (the client loads normalMap linear,
  // never sRGB-decoded); _BumpScale rides along when it isn't the default 1
  const normalMap = materialTextureMap(pbr?.unity?.textures?._BumpMap);
  if (normalMap) {
    doc.normalMap = normalMap;
    const bumpScale = pbr?.unity?.floats?._BumpScale;
    if (Number.isFinite(bumpScale) && bumpScale !== 1) doc.normalScale = bumpScale;
  }
  if (alphaOf(base) < 0.999) doc.opacity = alphaOf(base);
  if (emission.some?.((v, i) => i < 3 && num(v) > 0.001)) {
    doc.emissive = colorToHex(emission, '#000000');
    doc.emissiveIntensity = Math.max(0.1, Math.min(6, Math.max(num(emission[0]), num(emission[1]), num(emission[2]))));
  }
  gaiaMaterials[name] = doc;
  return name;
}

function parseMaterialPbr(ref) {
  const absMat = resolveUnityPath(ref?.path);
  if (!absMat || !/\.mat$/i.test(absMat) || !existsSync(absMat)) return null;
  try {
    return parseUnityMaterial(absMat, guidMap, unityRoot);
  } catch (err) {
    console.warn(`[emit] failed to parse material ${absMat}: ${err.message}`);
    return null;
  }
}

function materialTextureMap(tex) {
  const src = resolveUnityPath(tex?.path);
  if (!src || !existsSync(src)) return null;
  const textureDir = path.join(worldDir, 'assets', 'textures');
  const file = `${safeSlug(path.basename(src, path.extname(src))) || 'texture'}-${shortHash(src)}.png`;
  const dst = path.join(textureDir, file);
  try {
    mkdirSync(textureDir, { recursive: true });
    if (!existsSync(dst)) execSync(`sips -s format png --resampleHeightWidthMax 2048 ${shellQuote(src)} --out ${shellQuote(dst)}`, { stdio: 'ignore' });
    return `/assets/textures/${file}`;
  } catch (err) {
    console.warn(`[emit] failed to convert texture ${src}: ${err.message}`);
    return null;
  }
}

function modelPartFromEntity(entity, includeLocalTransform = false) {
  const meshRef = entity.components?.meshFilter?.mesh;
  if (isBuiltinMeshRef(meshRef)) {
    const part = builtinMeshPart(meshRef, entity);
    if (part && includeLocalTransform && entity.transform?.world) Object.assign(part, unityToGaiaTransform(entity.transform.world));
    return part;
  }
  const model = ensureModel(meshRef);
  if (!model) return null;
  const mats = entity.components?.meshRenderer?.materials ?? [];
  const part = { shape: 'model', src: model.src, solid: false, castShadow: entity.components?.meshRenderer?.castShadows !== 0 };
  const mat = ensureMaterial(mats[0]);
  if (mat) part.material = mat;
  const placeholder = firstColliderSize(entity) ?? [2, 2, 2];
  part.placeholderSize = placeholder;
  if (includeLocalTransform && entity.transform?.world) Object.assign(part, unityToGaiaTransform(entity.transform.world));
  return part;
}
function firstColliderSize(entity) {
  const c = (entity.components?.colliders ?? []).find((x) => x.enabled !== false && x.kind === 'BoxCollider' && x.size);
  return c ? unitySizeToGaia(c.size) : null;
}
function emittedModelFile(model) {
  if (model?.file && existsSync(model.file)) return model.file;
  // Reused manifest entries may retain only their emitted public asset URL.
  // Resolve it against this output world, never against the caller's cwd.
  if (!model?.src || !model.src.startsWith('/assets/models/')) return null;
  const file = path.resolve(worldDir, `.${model.src}`);
  const assetsDir = path.resolve(worldDir, 'assets', 'models');
  return (file.startsWith(`${assetsDir}${path.sep}`) && existsSync(file)) ? file : null;
}
// Source-model pivots are asset data, not a ground-placement contract. Emit
// geometry bounds with visual parts so generic runtime inspection can measure
// the rendered shape rather than infer it from an arbitrary model origin.
function meshComponent(parts) {
  const mesh = { parts };
  const bounds = partsAABB(parts, (src) => path.resolve(worldDir, `.${src}`));
  if (bounds) mesh.bounds = { center: roundVec(bounds.center), size: roundVec(bounds.size) };
  return mesh;
}
function unresolvedMeshColliderAabb(ref, reason) {
  meshColliderAabbUnresolved++;
  console.warn(`[emit] MeshCollider AABB unresolved for ${ref ?? '<unknown mesh>'}: ${reason}`);
  return [];
}
function meshColliderBoxes(c) {
  if (!colliderPolicy.meshAabb || colliderPolicy.meshMaxBoxes < 1) return [];
  const model = ensureModel(c.mesh);
  const file = emittedModelFile(model);
  if (!file) return unresolvedMeshColliderAabb(c.mesh?.path, 'emitted GLB unavailable');
  let bounds;
  try { bounds = glbAABB(file); }
  catch (err) { return unresolvedMeshColliderAabb(c.mesh?.path ?? file, err.message); }
  if (!bounds) return unresolvedMeshColliderAabb(c.mesh?.path ?? file, 'GLB has no mesh bounds');
  const { center, size } = boxToCenterSize(bounds);
  if (size.some((v) => !Number.isFinite(v) || v < colliderPolicy.meshMinSize)) {
    console.warn(`[emit] MeshCollider AABB below --mesh-collider-min-size for ${c.mesh?.path ?? file}`);
    return [];
  }
  // The converted GLB is already in GAIA's local frame. Entity transform,
  // including scale, is applied by the runtime rather than baked here.
  return [{ size: roundVec(size), position: roundVec(center), blocker: true }];
}
function placeColliderBoxes(boxes, unityTransform) {
  if (!unityTransform) return boxes;
  const t = unityToGaiaTransform(unityTransform);
  const p = t.position ?? [0, 0, 0];
  const s = t.scale ?? [1, 1, 1];
  const uq = unityTransform.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  // Unity→GAIA basis change mirrors both the quaternion and local vector.
  const q = { x: -num(uq.x), y: -num(uq.y), z: num(uq.z), w: num(uq.w, 1) };
  return boxes.map((box) => {
    const local = box.position ?? [0, 0, 0];
    const rotated = uQRot(q, { x: local[0] * s[0], y: local[1] * s[1], z: local[2] * s[2] });
    const out = {
      ...box,
      position: roundVec([p[0] + rotated.x, p[1] + rotated.y, p[2] + rotated.z]),
      size: roundVec(box.size.map((v, i) => Math.abs(v * s[i]))),
    };
    if (t.rotation) out.rotation = t.rotation;
    return out;
  });
}
function colliderBoxes(entity, localTransform = null) {
  const boxes = [];
  let meshBoxes = 0;
  for (const c of entity.components?.colliders ?? []) {
    if (c.enabled === false || c.isTrigger) continue;
    if (c.kind === 'BoxCollider' && c.size) {
      boxes.push({ size: unitySizeToGaia(c.size), position: unityVecToGaiaLocal(c.center), blocker: true });
    } else if (c.kind === 'SphereCollider' && c.radius != null) {
      const r = Math.abs(num(c.radius, 0.5));
      boxes.push({ size: roundVec([r * 2, r * 2, r * 2]), position: unityVecToGaiaLocal(c.center), blocker: true });
    } else if (c.kind === 'CapsuleCollider') {
      const r = Math.abs(num(c.radius, 0.5));
      const h = Math.abs(num(c.height, r * 2));
      const dir = Number(c.direction ?? 1); // 0=x, 1=y, 2=z
      const size = dir === 0 ? [h, r * 2, r * 2] : dir === 2 ? [r * 2, r * 2, h] : [r * 2, h, r * 2];
      boxes.push({ size: roundVec(size), position: unityVecToGaiaLocal(c.center), blocker: true });
    } else if (c.kind === 'MeshCollider' && meshBoxes < colliderPolicy.meshMaxBoxes) {
      const next = meshColliderBoxes(c);
      meshBoxes += next.length;
      boxes.push(...next);
    }
  }
  return placeColliderBoxes(boxes.slice(0, colliderPolicy.maxBoxes), localTransform);
}
function lightComponent(entity) {
  const l = entity.components?.light;
  if (!l || l.enabled === false) return null;
  const type = Number(l.type);
  const out = {
    type: type === 0 ? 'spot' : type === 1 ? 'directional' : 'point',
    color: colorObjToHex(l.color),
    intensity: Math.max(0, Math.min(120, num(l.intensity, 1) * (type === 1 ? 1 : 10))),
    distance: Math.max(0, Math.min(120, num(l.range, 10))),
  };
  if (out.type === 'spot') out.angle = Math.max(0.01, Math.min(1.57, (num(l.spotAngle, 30) * Math.PI / 180) / 2));
  return out;
}
function colorObjToHex(c) { return colorToHex([num(c?.r, 1), num(c?.g, 1), num(c?.b, 1), num(c?.a, 1)]); }

// Cached prefab IR is invalid when EITHER the Unity source changed OR the parser
// schema moved on. mtime alone was not enough: a parser fix leaves every source
// file untouched, so stale caches kept feeding the old meaning into the emitter
// until someone deleted them by hand.
function prefabIRStale(cacheFile, sourceFile) {
  if (!existsSync(cacheFile)) return 'missing';
  if (statSync(cacheFile).mtimeMs < statSync(sourceFile).mtimeMs) return 'source is newer';
  let cached;
  try { cached = JSON.parse(readFileSync(cacheFile, 'utf8')); }
  catch { return 'unreadable'; }
  const version = Number(cached?.version ?? 0);
  if (!Number.isFinite(version) || version < PARSER_VERSION) return `schema v${cached?.version ?? '?'} < v${PARSER_VERSION}`;
  // A prefab IR also depends on the prefabs it read for their AUTHORED ROOTS
  // (variant bases, nested sources). Editing one of those leaves this prefab's
  // own mtime untouched, so the recorded dependency stamps are checked too.
  for (const dep of cached.sourceDependencies ?? []) {
    if (!dep?.path) continue;
    let current = null;
    try { current = statSync(dep.path).mtimeMs; } catch { return `dependency missing: ${dep.path}`; }
    if (dep.mtimeMs == null || current > dep.mtimeMs) return `dependency changed: ${path.basename(dep.path)}`;
  }
  return null;
}
function parsePrefab(sourcePath) {
  const abs = resolveUnityPath(sourcePath);
  const out = path.join(prefabCacheDir, `${safeSlug(path.basename(sourcePath))}-${shortHash(sourcePath)}.ir.json`);
  const stale = prefabIRStale(out, abs);
  if (stale) {
    if (stale.startsWith('schema')) console.warn(`[emit] re-parsing ${path.basename(sourcePath)}: cached IR ${stale}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'parse.mjs'), abs, '--guids', guidDbPath, '--out', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`prefab parse failed for ${sourcePath}\n${[r.stdout, r.stderr].filter(Boolean).join('\n')}`);
  }
  const parsed = JSON.parse(readFileSync(out, 'utf8'));
  // belt and braces: a re-parse that still produces an old schema is a broken
  // toolchain, not something to emit from
  assertIRVersion(parsed, out);
  return parsed;
}

function prefabNameForSource(source) {
  return `${safeSlug(path.basename(source.path ?? 'prefab', path.extname(source.path ?? '')))}_${shortHash(source.path ?? source.guid ?? '')}`;
}

// Prefabs whose collected mesh-part count exceeds this are collapsed to a single
// massing box (RayFire pre-fractured buildings carry ~485 fragment meshes; at
// dozens of instances that would spawn tens of thousands of scene nodes).
const MAX_PREFAB_MESH_PARTS = policy.maxPrefabMeshParts ?? 96;
const PREFAB_DESCENT_DEPTH = policy.prefabDescentDepth ?? 8;

// RayFire pre-fractured prefabs render ASSEMBLED before play, as hundreds of
// separate shard meshes. The converter CAN read those serialized meshes now, but
// emitting hundreds of nodes per building (times dozens of instances) is a
// runtime cost, not a fidelity gain — so the intact sibling prefab's visual is
// emitted in their place. Keyed by prefab basename (lowercase, extension
// stripped); value is the intact sibling's basename in the SAME directory.
// The proxy is placed on exactly the same ROOT-RELATIVE basis as the prefab it
// stands in for: no extra authored transform is introduced anywhere.
const PREFAB_VISUAL_PROXY = new Map(Object.entries(policy.visualProxies ?? {}));
const emittedPrefabs = new Map();
function ensurePrefabForSource(source) {
  if (!source?.path) return null;
  const proxy = PREFAB_VISUAL_PROXY.get(path.basename(source.path, path.extname(source.path)).toLowerCase());
  if (proxy) {
    const proxyPath = path.join(path.dirname(source.path), `${proxy}.prefab`);
    if (existsSync(resolveUnityPath(proxyPath))) {
      console.warn(`[emit] prefab ${path.basename(source.path)} -> visual proxy ${proxy}`);
      return ensurePrefabForSource({ path: proxyPath });
    }
    console.warn(`[emit] visual proxy missing for ${source.path}: ${proxyPath}`);
  }
  const name = prefabNameForSource(source);
  if (emittedPrefabs.has(name)) return name;

  // Precheck: a prefab with an enormous flat mesh set (RayFire pre-fractured
  // buildings carry hundreds of fragment meshes) is collapsed to a massing box
  // straight from entity bounds — no per-fragment GLB conversion, no thousands
  // of runtime scene nodes.
  if (!(source.kind === 'model' || /\.(fbx|glb|gltf|asset|blend)$/i.test(source.path))) {
    let pir = null;
    try { pir = parsePrefab(source.path); } catch { pir = null; }
    const renderCount = (pir?.entities ?? []).filter((e) => e.active !== false && e.renderable && e.components?.meshFilter && e.components?.meshRenderer?.enabled !== false).length;
    if (pir && renderCount > MAX_PREFAB_MESH_PARTS) {
      const components = { transform: { position: [0, 0, 0] } };
      const box = massingBoxFromEntities(pir);
      if (box) components.mesh = { parts: [box] };
      const boxes = [];
      for (const e of pir.entities ?? []) {
        if (e.active === false) continue;
        boxes.push(...colliderBoxes(e, rootRelativeTRS(e, `${name} collider`)));
      }
      if (boxes.length) components.collider = { boxes: boxes.slice(0, colliderPolicy.maxBoxes) };
      console.warn(`[emit] prefab ${name}: ${renderCount} renderable meshes -> massing box (no conversion)`);
      emittedPrefabs.set(name, components);
      if (!prepareOnly) writeFileSync(path.join(targetPrefabDir, `${name}.json`), `${JSON.stringify({ name, components }, null, 2)}\n`);
      return name;
    }
  }

  const acc = { parts: [], boxes: [], light: null };
  collectPrefabParts(source, M4_IDENTITY, 0, new Set(), acc);
  const components = { transform: { position: [0, 0, 0] } };
  if (acc.parts.length > MAX_PREFAB_MESH_PARTS) {
    const box = massingBoxFromParts(acc.parts);
    if (box) components.mesh = { parts: [box] };
    console.warn(`[emit] prefab ${name}: ${acc.parts.length} mesh parts collapsed to a massing box`);
  } else if (acc.parts.length) {
    components.mesh = meshComponent(acc.parts);
  }
  if (acc.boxes.length) components.collider = { boxes: acc.boxes.slice(0, colliderPolicy.maxBoxes) };
  if (acc.light) components.light = acc.light;
  emittedPrefabs.set(name, components);
  if (!prepareOnly) writeFileSync(path.join(targetPrefabDir, `${name}.json`), `${JSON.stringify({ name, components }, null, 2)}\n`);
  return name;
}

// Recursively collect mesh parts from a prefab source, descending prefab
// variants and nested prefab instances (DotsCity wraps visual prefabs in logic
// wrappers). `parentWorld` is the accumulated Unity-space transform; `ancestors`
// is the current path chain (cycle guard); depth is capped.
function collectPrefabParts(source, parentMatrix, depth, ancestors, acc) {
  if (!source?.path || depth > PREFAB_DESCENT_DEPTH) return;
  if (ancestors.has(source.path)) return; // cycle
  if (source.kind === 'model' || /\.(fbx|glb|gltf|asset|blend)$/i.test(source.path)) {
    const model = ensureModel(source);
    if (model?.src) {
      const part = { shape: 'model', src: model.src, solid: false, placeholderSize: [2, 2, 2] };
      Object.assign(part, unityToGaiaTransform(matrixToUnityTRS(parentMatrix, `${source.path} model part`)));
      acc.parts.push(part);
    }
    return;
  }
  let pir;
  try { pir = parsePrefab(source.path); }
  catch (err) { console.warn(`[emit] prefab parse failed (skipping): ${source.path}: ${err.message}`); return; }
  const childAncestors = new Set(ancestors).add(source.path);
  for (const e of pir.entities ?? []) {
    if (e.active === false) continue;
    // ROOT-RELATIVE: the prefab's own root contributes NOTHING here. Its pose is
    // supplied by whoever instantiates the prefab (a scene PrefabInstance root
    // REPLACES the authored root); baking it in as well displaced every prefab
    // by its authored root offset.
    const matrix = m4Mul(parentMatrix, rootRelativeMatrix(e.transform));
    if (e.renderable && e.components?.meshFilter && e.components?.meshRenderer?.enabled !== false) {
      const part = modelPartFromEntityWorld(e, matrixToUnityTRS(matrix, `${source.path}#${e.id} mesh`));
      if (part) acc.parts.push(part);
    }
    if (depth === 0) acc.boxes.push(...colliderBoxes(e, matrixToUnityTRS(matrix, `${source.path}#${e.id} collider`)));
    if (!acc.light) acc.light = lightComponent(e);
    if (acc.parts.length > MAX_PREFAB_MESH_PARTS + 4) return; // stop early; will be collapsed
  }
  for (const pi of pir.prefabInstances ?? []) {
    if (pi.active === false) continue;
    const matrix = m4Mul(parentMatrix, rootRelativeMatrix(pi.transform));
    collectPrefabParts(pi.source, matrix, depth + 1, childAncestors, acc);
    if (acc.parts.length > MAX_PREFAB_MESH_PARTS + 4) return;
  }
}

// --- root-relative helpers ---------------------------------------------------
// The IR carries an EXACT root-relative matrix built from the raw local chain
// (parse.mjs). Older IR caches may predate it; those are rebuilt by parse.mjs
// itself (the cache is keyed on the source mtime), so a missing field here is a
// hard error rather than a silent fall back to the double-baked world.
function rootRelativeMatrix(transform) {
  const matrix = transform?.rootRelative;
  if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite)) {
    throw new Error('emit: IR entry has no rootRelative matrix — re-run tools/unity/parse.mjs (stale prefab IR cache)');
  }
  return matrix;
}
function rootRelativeTRS(entity, what) {
  return matrixToUnityTRS(rootRelativeMatrix(entity.transform), what);
}
// A mesh part / collider box is a TRS triple in this schema. A matrix carrying
// SHEAR (a rotated child under a non-uniformly scaled ancestor) has no such
// representation: refuse loudly instead of emitting a plausible wrong pose.
function matrixToUnityTRS(matrix, what) {
  if (!m4IsDecomposable(matrix)) {
    throw new Error(`emit: ${what} needs a SHEARED transform (non-uniform ancestor scale + rotated child). `
      + 'The mesh-part schema is TRS-only: bake the shear into the model or extend the schema — this emitter will not approximate it.');
  }
  return m4Decompose(matrix);
}

function modelPartFromEntityWorld(entity, world) {
  const meshRef = entity.components?.meshFilter?.mesh;
  if (isBuiltinMeshRef(meshRef)) {
    const part = builtinMeshPart(meshRef, entity);
    if (part) Object.assign(part, unityToGaiaTransform(world));
    return part;
  }
  const model = ensureModel(meshRef);
  if (!model) return null;
  const mats = entity.components?.meshRenderer?.materials ?? [];
  const part = { shape: 'model', src: model.src, solid: false, castShadow: entity.components?.meshRenderer?.castShadows !== 0 };
  const mat = ensureMaterial(mats[0]);
  if (mat) part.material = mat;
  part.placeholderSize = firstColliderSize(entity) ?? [2, 2, 2];
  Object.assign(part, unityToGaiaTransform(world));
  return part;
}

function massingBoxFromEntities(pir) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const e of pir.entities ?? []) {
    if (e.active === false || !e.renderable || !e.components?.meshFilter || e.components?.meshRenderer?.enabled === false) continue;
    // root-relative, exactly like the mesh parts: the box must sit in the same
    // frame the instance root places
    const t = unityToGaiaTransform(rootRelativeTRS(e, 'massing box'));
    const c = t.position ?? [0, 0, 0];
    const h = (firstColliderSize(e) ?? [1, 1, 1]).map((v) => Math.abs(v) / 2);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], c[i] - h[i]); max[i] = Math.max(max[i], c[i] + h[i]); }
  }
  if (!Number.isFinite(min[0])) return null;
  const size = roundVec([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).map((v) => Math.max(0.5, v));
  const center = roundVec([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
  return { shape: 'box', size, position: center, solid: true, castShadow: true, material: 'SimpleTown_9c448a03' };
}

function massingBoxFromParts(parts) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const c = p.position ?? [0, 0, 0];
    const h = (p.placeholderSize ?? [2, 2, 2]).map((v) => Math.abs(v) / 2);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], c[i] - h[i]); max[i] = Math.max(max[i], c[i] + h[i]); }
  }
  if (!Number.isFinite(min[0])) return null;
  const size = roundVec([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).map((v) => Math.max(0.5, v));
  const center = roundVec([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
  return { shape: 'box', size, position: center, solid: true, castShadow: true, material: 'SimpleTown_9c448a03' };
}

function sceneDocFromEntity(e) {
  const doc = {};
  if (e.transform?.world) doc.transform = unityToGaiaTransform(e.transform.world);
  if (e.renderable && e.components?.meshFilter && e.components?.meshRenderer?.enabled !== false) {
    const part = modelPartFromEntity(e, false);
    if (part) doc.mesh = meshComponent([part]);
  }
  const boxes = colliderBoxes(e);
  if (boxes.length) doc.collider = { boxes };
  const light = lightComponent(e);
  if (light) doc.light = light;
  return Object.keys(doc).length ? doc : null;
}

function transformSignature(t = {}) {
  const p = t.position ?? { x: 0, y: 0, z: 0 };
  const r = t.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const s = t.scale ?? { x: 1, y: 1, z: 1 };
  return [
    round(num(p.x)), round(num(p.y)), round(num(p.z)),
    round(num(r.x)), round(num(r.y)), round(num(r.z)), round(num(r.w, 1)),
    round(num(s.x, 1)), round(num(s.y, 1)), round(num(s.z, 1)),
  ].join('|');
}

function entityDedupeSignature(e) {
  const meshPath = e.components?.meshFilter?.mesh?.path;
  if (!meshPath || !e.transform?.world) return null;
  return `mesh:${meshPath}|${transformSignature(e.transform.world)}`;
}

function prefabDedupeSignature(pi) {
  const sourcePath = pi.source?.path;
  if (!sourcePath || !pi.transform?.world) return null;
  return `prefab:${sourcePath}|${transformSignature(pi.transform.world)}`;
}

function positionSignature(t = {}) {
  const p = t.position ?? { x: 0, y: 0, z: 0 };
  return [round(num(p.x)), round(num(p.y)), round(num(p.z))].join('|');
}

function isRedundantRawPrefab(pi) {
  return policy.dedupeRoads?.raw && new RegExp(policy.dedupeRoads.raw, 'i').test(pi.source?.path ?? '');
}

function isComposedPrefab(pi) {
  return policy.dedupeRoads?.composed && new RegExp(policy.dedupeRoads.composed, 'i').test(pi.source?.path ?? '');
}

// Environment mapping: Unity RenderSettings + directional light extracted by
// tools/unity/extract-env.mjs -> env-settings.json. boomtown.unity has FOG
// DISABLED, ambient mode 0 (skybox) with Unity's builtin default procedural
// skybox, and one warm directional light at Unity's default sun angle.
// GAIA's sky/hemisphere/exposure/bloom stay at the engine's daylight defaults
// as the closest expression of Unity's builtin default skybox + tonemapping;
// everything else is data-driven.
const UNITY_SUN_INTENSITY_TO_GAIA = 2.1; // unit conversion: Unity directional intensity 1.0 renders like GAIA sun 2.1 under engine exposure defaults
const AMBIENT_FILL_SCALE = 0.28;         // Unity ambientIntensity 1.0 -> GAIA flat ambient fill level
const SUN_DISTANCE = 150;                // GAIA sun is positional; distance along the extracted direction

function rgbHex(rgb) {
  return '#' + rgb.slice(0, 3).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
}

// Rotate Unity forward (0,0,1) by the light's quaternion [x,y,z,w], then
// mirror z (Unity left-handed -> GAIA right-handed, same convention as
// toGaiaPosition above).
function sunPositionFromQuaternion(q, dist) {
  const [x, y, z, w] = q;
  const fx = 2 * (x * z + w * y);
  const fy = 2 * (y * z - w * x);
  const fz = 1 - 2 * (x * x + y * y);
  const dir = [fx, fy, -fz]; // mirrored z
  return [Number((-dir[0] * dist).toFixed(2)), Number((-dir[1] * dist).toFixed(2)), Number((-dir[2] * dist).toFixed(2))];
}

function unityEnvironment(env) {
  const rs = env.renderSettings;
  const light = rs.sun ?? env.directionalLights?.[0];
  if (!light) throw new Error('env-settings.json has no sun and no directional lights — cannot derive GAIA sun');
  // fog:false -> density 0 (stays in the exp fog family per engine perf rules);
  // fog:true exp/exp2 -> use fogDensity; linear -> approximate exp density as 3/fogEnd.
  const fogDensity = !rs.fog ? 0 : (rs.fogMode === 1 ? 3 / Math.max(1, rs.fogEnd) : rs.fogDensity);
  return {
    environment: {
      background: '#87b9e8',
      fog: { color: rgbHex(rs.fogColor), density: Number(fogDensity.toFixed(5)) },
      exposure: 1.15,
      hemisphere: { sky: '#dbeeff', ground: '#7a6a55', intensity: 1.15 },
      sun: {
        color: rgbHex(light.color),
        intensity: Number((light.intensity * UNITY_SUN_INTENSITY_TO_GAIA).toFixed(2)),
        position: sunPositionFromQuaternion(light.rotation, SUN_DISTANCE),
      },
      ambient: { color: rgbHex(rs.ambientSkyColor), intensity: Number((rs.ambientIntensity * AMBIENT_FILL_SCALE).toFixed(2)) },
      bloom: { strength: 0.12, radius: 0.35, threshold: 0.92 },
      lightScale: 0.7,
    },
  };
}

// Camera mapping: DotsCity "Main Camera City.prefab" rigs extracted by
// tools/unity/extract-camera.mjs -> camera-rigs.json. Preserve the source lens
// and follow offset as scene data; renderer/player consume this generic surface.
// `_`-prefixed and `*Note` keys are authoring commentary, never world data.
function stripAnnotations(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_') || /Note$/.test(k)) continue;
    out[k] = stripAnnotations(v);
  }
  return out;
}

function cinemachineRigToGaiaCamera(rig) {
  const off = rig.follow.offset;
  const horiz = Math.hypot(off[0], off[2]);
  const pitch = -Math.atan2(off[1], horiz);
  const meanDamp = (rig.follow.damping[0] + rig.follow.damping[1] + rig.follow.damping[2]) / 3;
  return {
    mode: 'side',
    projection: rig.lens.orthographic ? 'orthographic' : 'perspective',
    fov: rig.lens.fov,
    near: rig.lens.near,
    far: rig.lens.far,
    orthoSize: rig.lens.orthoSize,
    yaw: 0,
    pitch: Number(pitch.toFixed(4)),
    distance: Number(horiz.toFixed(2)),
    height: Number(off[1].toFixed(2)),
    lookAhead: rig.lookahead?.time ?? 0,
    damp: Number(Math.max(1, 20 / (1 + meanDamp)).toFixed(1)),
  };
}

const envSettingsPath = path.join(path.dirname(irPath), 'env-settings.json');
const unityEnv = existsSync(envSettingsPath) ? JSON.parse(readFileSync(envSettingsPath, 'utf8')) : null;

const cameraRigsPath = path.join(path.dirname(irPath), 'camera-rigs.json');
const ACTIVE_RIG_NAME = policy.activeRig; // mirrors DotsCity runtime switching: both on-foot and in-car modes resolve to the same top-down pose (code audit)
if (ACTIVE_RIG_NAME && !existsSync(cameraRigsPath)) {
  throw new Error(`camera rig data missing: ${cameraRigsPath}`);
}
const cameraRigs = existsSync(cameraRigsPath) ? JSON.parse(readFileSync(cameraRigsPath, 'utf8')) : { rigs: [] };
const cameraRigSource = (cameraRigs.rigs ?? []).find((r) => r.name === ACTIVE_RIG_NAME);
if (ACTIVE_RIG_NAME && !cameraRigSource) {
  throw new Error(`camera rig "${ACTIVE_RIG_NAME}" not found in ${cameraRigsPath}`);
}
const scene = {};
let directEntities = 0;
let prefabInstances = 0;
let lightEntities = 0;
let colliderEntities = 0;
let duplicateEntities = 0;
const positions = [];
const emittedSignatures = new Map();
const roadSegmentPositions = new Set(
  sceneName === policy.scene
    ? (ir.prefabInstances ?? []).filter(isComposedPrefab).map((pi) => positionSignature(pi.transform?.world ?? {}))
    : [],
);

for (const e of ir.entities ?? []) {
  if (e.active === false) continue;
  const sig = entityDedupeSignature(e);
  if (sig && emittedSignatures.has(sig)) {
    duplicateEntities++;
    continue;
  }
  const doc = sceneDocFromEntity(e);
  if (!doc) continue;
  const id = `unity-${e.fileID ?? e.id}`;
  if (sig) emittedSignatures.set(sig, id);
  scene[id] = doc;
  directEntities++;
  if (doc.light) lightEntities++;
  if (doc.collider) colliderEntities++;
  if (doc.transform?.position) positions.push(doc.transform.position);
}

for (const pi of ir.prefabInstances ?? []) {
  if (pi.active === false) continue;
  if (isRedundantRawPrefab(pi) && roadSegmentPositions.has(positionSignature(pi.transform?.world ?? {}))) {
    duplicateEntities++;
    continue;
  }
  const sig = prefabDedupeSignature(pi);
  if (sig && emittedSignatures.has(sig)) {
    duplicateEntities++;
    continue;
  }
  const name = ensurePrefabForSource(pi.source);
  if (!name) continue;
  const doc = { prefab: name, transform: unityToGaiaTransform(pi.transform?.world ?? {}) };
  scene[`unity-${pi.fileID}`] = doc;
  if (sig) emittedSignatures.set(sig, `unity-${pi.fileID}`);
  prefabInstances++;
  if (doc.transform?.position) positions.push(doc.transform.position);
}

// A minimal authored spawn lets the imported world boot in front of the city.
const bounds = boundsFromPositions(positions);
const spawn = { position: [round(bounds.center[0]), 2, round(bounds.center[1] + Math.min(40, Math.max(12, bounds.radius * 0.25)))], yaw: Math.PI };
scene.env = unityEnv ? unityEnvironment(unityEnv) : {};
if (sceneName === policy.scene && cameraRigSource) {
  const rawOverride = cameraOverridePath ? JSON.parse(readFileSync(cameraOverridePath, 'utf8')) : {};
  // Declaration files carry their rationale with them (_doc, *Note). Prose is
  // for the author, not for the runtime: strip it so the emitted world holds
  // camera VALUES only.
  const override = stripAnnotations(rawOverride);
  const { onFoot: onFootOverride, vehicle: vehicleOverride, ...sharedOverride } = override;
  const converted = cinemachineRigToGaiaCamera(cameraRigSource);
  const onFootCamera = { ...converted, ...sharedOverride, ...(onFootOverride ?? {}) };
  const vehicleCamera = { ...converted, ...sharedOverride, ...(vehicleOverride ?? onFootOverride ?? {}) };
  scene.env.camera = {
    ...onFootCamera,
    onFoot: onFootCamera,
    vehicle: vehicleCamera,
  };
}
// Game-owned placement corrections are data merged after Unity emission: a
// re-emit keeps authored world truth while the engine stays game-agnostic.
if (sceneOverridePath) {
const sceneOverrides = JSON.parse(readFileSync(sceneOverridePath, 'utf8'));
// Game-owned environment declarations (including impostor tuning) merge after
// Unity emission just like entity placement corrections.  Omit the key and the
// engine remains declared-off; the emitter never silently enables a feature.
if (sceneOverrides.env) scene.env = deepMerge(scene.env, sceneOverrides.env);
for (const [id, patch] of Object.entries(sceneOverrides.entities ?? {})) {
if (!scene[id]) throw new Error(`scene override references missing entity: ${id}`);
scene[id] = deepMerge(scene[id], patch);
}
}
if (sceneName === policy.scene) Object.assign(scene, policy.extraEntities ?? {});
scene.spawn = { spawn };

const emittedWorldJson = {
  voidY: -80,
  spawn,
  scenes: {
    [sceneName]: {
      bounds: { center: bounds.center, radius: Math.max(25, round(bounds.radius + 20)) },
      load: [{ center: bounds.center, radius: Math.max(30, round(bounds.radius + 30)), y: [-50, 250] }],
    },
  },
};
const mergedWorldJson = mergeWorld ? mergeWorldJson(path.join(worldDir, 'world.json'), emittedWorldJson) : emittedWorldJson;
const worldJson = worldOverridePath
  ? deepMerge(mergedWorldJson, JSON.parse(readFileSync(worldOverridePath, 'utf8')))
  : mergedWorldJson;

// Plain-object recursive merge; arrays and scalars are replaced wholesale so an
// authored variant list is exactly what ships (no accidental concatenation).
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeWorldJson(file, next) {
  let prev = {};
  if (existsSync(file)) {
    try { prev = JSON.parse(readFileSync(file, 'utf8')); }
    catch { prev = {}; }
  }
  return {
    ...prev,
    ...next,
    scenes: {
      ...(prev.scenes ?? {}),
      ...(next.scenes ?? {}),
    },
  };
}

if (!prepareOnly) writeFileSync(path.join(targetSceneDir, `${sceneName}.json`), `${JSON.stringify(sortObject(scene), null, 2)}\n`);
if (!prepareOnly) writeFileSync(path.join(worldDir, 'world.json'), `${JSON.stringify(worldJson, null, 2)}\n`);
if (!prepareOnly) writeFileSync(path.join(worldDir, 'materials.json'), `${JSON.stringify(sortObject(gaiaMaterials), null, 2)}\n`);
// game.json: title screen + level. The WORLD owns the player body and clip
// declaration; this emitter only carries that data into the level entry.
if (!prepareOnly && sceneName === policy.scene && policy.game) {
  const player = worldJson.player ?? {};
  const playerOps = [
    ...(player.mesh ? [{ op: 'set', id: '$id', component: 'mesh', value: player.mesh }] : []),
    ...(player.animation ? [{ op: 'set', id: '$id', component: 'animation', value: player.animation }] : []),
    ...(policy.game.playerOps ?? []),
  ];
  const gameJson = {
    title: policy.game.title,
    subtitle: policy.game.subtitle,
    menu: { camera: { position: [spawn.position[0], policy.game.menuHeight, spawn.position[2] + policy.game.menuOffsetZ], yaw: policy.game.menuYaw, pitch: policy.game.menuPitch } },
    levels: [
      {
        id: policy.game.levelId,
        name: policy.game.levelName,
        spawn: { position: spawn.position, yaw: spawn.yaw },
        ops: playerOps,
      },
    ],
  };
  writeFileSync(path.join(worldDir, 'game.json'), `${JSON.stringify(gameJson, null, 2)}\n`);
}
// Union: keep any previously-loaded manifest record whose output file is still
// on disk and isn't already covered by a record written this run (repair/other
// tooling can narrow files this run never touched — don't drop them).
const writtenOutputs = new Set([...modelRecords.keys()].map((k) => path.resolve(k)));
const unionExtraRecords = [];
for (const rec of loadedManifestRecords) {
  const resolvedOutput = path.resolve(worldDir, rec.output);
  if (!existsSync(resolvedOutput)) continue;
  if (writtenOutputs.has(resolvedOutput)) continue;
  writtenOutputs.add(resolvedOutput);
  unionExtraRecords.push(rec);
}
const allModelRecords = [...modelRecords.values(), ...unionExtraRecords];
writeFileSync(path.join(targetModelDir, 'models.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), count: allModelRecords.length, unique: new Set(allModelRecords.map((r) => r.hash)).size, models: allModelRecords.sort((a, b) => a.source.localeCompare(b.source)) }, null, 2)}\n`);
writeFileSync(path.join(targetModelDir, 'skipped-models.json'), `${JSON.stringify(skippedModels, null, 2)}\n`);

const prefabComponents = [...emittedPrefabs.values()];
const sanity = sanitySamples(ir.prefabInstances ?? []);
const summary = {
  worldDir,
  unityRoot,
  scene: sceneName,
  sceneEntities: Object.keys(scene).length,
  directEntities,
  prefabInstances,
  duplicateEntities,
  prefabs: emittedPrefabs.size,
  prefabsWithMesh: prefabComponents.filter((c) => c.mesh).length,
  prefabsWithCollider: prefabComponents.filter((c) => c.collider).length,
  materials: Object.keys(gaiaMaterials).length,
  models: modelRecords.size,
  skippedModels: skippedModels.length,
  skippedModelReasons: skippedModels.reduce((acc, s) => (acc[s.reason] = (acc[s.reason] ?? 0) + 1, acc), {}),
  lights: lightEntities,
  colliderEntities,
  meshColliderAabbUnresolved,
  bounds,
  sanity,
};
writeFileSync(path.join(worldDir, 'emission-report.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log(`[emit] MeshCollider AABB unresolved: ${meshColliderAabbUnresolved}`);

function boundsFromPositions(pos) {
  if (!pos.length) return { center: [0, 0], radius: 50, min: [0, 0], max: [0, 0] };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pos) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const center = roundVec([(minX + maxX) / 2, (minZ + maxZ) / 2]);
  let radius = 0;
  for (const p of pos) radius = Math.max(radius, Math.hypot(p[0] - center[0], p[2] - center[1]));
  return { center, radius: round(radius), min: roundVec([minX, minZ]), max: roundVec([maxX, maxZ]) };
}
function sanitySamples(instances) {
  return instances.slice(0, 8).map((pi) => {
    const u = pi.transform?.world?.position ?? {};
    const g = unityToGaiaTransform(pi.transform?.world ?? {}).position;
    return { id: pi.fileID, name: pi.name, unity: roundVec([num(u.x), num(u.y), num(u.z)]), gaia: g };
  });
}
function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortObject(v)]));
}
