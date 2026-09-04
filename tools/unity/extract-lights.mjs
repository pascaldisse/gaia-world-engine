#!/usr/bin/env node
// Extract DotsCity TrafficLightCrossroad/TrafficLightHandler data from the
// Boomtown Unity subscene into tools/unity/out/lights.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitUnityDocuments, parseUnityYamlBody, normalizeFileID, loadGuidDb } from './unity-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const DEFAULT_SCENE = '/Users/pascaldisse/projects/boomtown-rampage/Assets/Scenes/boomtown/EntitySubScene.unity';
const DEFAULT_OUT = path.join(OUT_DIR, 'lights.json');
const DEFAULT_GUIDS = path.join(OUT_DIR, 'guids.json');
const CROSSROAD_GUID = '2708c5958a22f4344b2b6ab2fd9eaa63';
const HANDLER_GUID = 'c27a552e32a343a4fa46a7a2c37f3716';
const TRAFFIC_NODE_GUID = '909a80ce9df91e84db88d0d59a44f45c';
const SHARED_STATES_PATH = '/Users/pascaldisse/projects/boomtown-rampage/Assets/DotsCity/Prefabs/CityEditor/Configs/Other/Shared Light States.asset';
const SHARED_STATES = [
  [['green', 12], ['yellow', 2], ['red', 28], ['redyellow', 2]],
  [['red', 20], ['redyellow', 2], ['green', 12], ['yellow', 2], ['red', 8]],
];
const STATE_NAMES = { 0: 'redyellow', 1: 'green', 2: 'yellow', 3: 'red' };

function usage() {
  console.error('usage: node tools/unity/extract-lights.mjs [subscene.unity] [--out <lights.json>] [--guids <guids.json>]');
  process.exit(2);
}
const args = process.argv.slice(2);
let scenePath = DEFAULT_SCENE, outPath = DEFAULT_OUT, guidPath = DEFAULT_GUIDS;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--guids') guidPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '-h' || args[i] === '--help') usage();
  else positional.push(args[i]);
}
if (positional[0]) scenePath = positional[0];
scenePath = path.resolve(scenePath);

const ZERO_VEC = { x: 0, y: 0, z: 0 };
const ONE_VEC = { x: 1, y: 1, z: 1 };
const ID_QUAT = { x: 0, y: 0, z: 0, w: 1 };
const IDENTITY_WORLD = { position: ZERO_VEC, rotation: ID_QUAT, scale: ONE_VEC };
function num(v, fallback = 0) { if (v == null || v === '') return fallback; const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function v3(v, fallback = ZERO_VEC) { return { x: num(v?.x, fallback.x), y: num(v?.y, fallback.y), z: num(v?.z, fallback.z) }; }
function q4(q, fallback = ID_QUAT) { return { x: num(q?.x, fallback.x), y: num(q?.y, fallback.y), z: num(q?.z, fallback.z), w: num(q?.w, fallback.w) }; }
function mulV(a, b) { return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z }; }
function addV(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function quatMul(a, b) { return { x: a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y, y: a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x, z: a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w, w: a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z }; }
function quatRotate(q, v) { const x=v.x,y=v.y,z=v.z,qx=q.x,qy=q.y,qz=q.z,qw=q.w; const ix=qw*x+qy*z-qz*y, iy=qw*y+qz*x-qx*z, iz=qw*z+qx*y-qy*x, iw=-qx*x-qy*y-qz*z; return { x: ix*qw+iw*-qx+iy*-qz-iz*-qy, y: iy*qw+iw*-qy+iz*-qx-ix*-qz, z: iz*qw+iw*-qz+ix*-qy-iy*-qx }; }
function compose(parent, local) { return { position: addV(parent.position, quatRotate(parent.rotation, mulV(parent.scale, local.position))), rotation: quatMul(parent.rotation, local.rotation), scale: mulV(parent.scale, local.scale) }; }
function localTransform(t) { return { position: v3(t?.m_LocalPosition), rotation: q4(t?.m_LocalRotation), scale: v3(t?.m_LocalScale, ONE_VEC) }; }
function localFromMods(mods) { const tr = { position: { ...ZERO_VEC }, rotation: { ...ID_QUAT }, scale: { ...ONE_VEC } }; for (const m of mods) { const p = m.propertyPath; const n = num(m.value, undefined); if (!Number.isFinite(n)) continue; if (p?.startsWith('m_LocalPosition.')) tr.position[p.split('.').at(-1)] = n; else if (p?.startsWith('m_LocalRotation.')) tr.rotation[p.split('.').at(-1)] = n; else if (p?.startsWith('m_LocalScale.')) tr.scale[p.split('.').at(-1)] = n; } return tr; }
function round(n) { return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6; }
function toGaiaPoint(worldPos) { return [round(worldPos.x), round(worldPos.y), round(-worldPos.z)]; }
function deepClone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function buildIndex(text) {
  const byFileID = new Map(), transformByGameObject = new Map();
  for (const d of splitUnityDocuments(text)) {
    const parsed = parseUnityYamlBody(d.lines);
    let data = parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { const keys = Object.keys(parsed); if (keys.length === 1) data = parsed[keys[0]]; }
    data ??= {};
    byFileID.set(d.fileID, { classId: d.classId, data, stripped: d.stripped });
    if (d.classId === 4) { const goId = normalizeFileID(data.m_GameObject); if (goId !== '0') transformByGameObject.set(goId, d.fileID); }
  }
  return { byFileID, transformByGameObject };
}

function setModValue(obj, propertyPath, value) {
  if (!propertyPath) return;
  const arr = propertyPath.match(/^([^.]*)\.Array\.data\[(\d+)\]$/);
  if (arr) { obj[arr[1]] ??= []; obj[arr[1]][Number(arr[2])] = value; return; }
  const size = propertyPath.match(/^([^.]*)\.Array\.size$/);
  if (size) { obj[size[1]] = Array.from({ length: Number(value) || 0 }, (_, i) => obj[size[1]]?.[i] ?? { fileID: 0 }); return; }
  if (!propertyPath.includes('.')) obj[propertyPath] = value;
}
function valueFromMod(m) { return m.objectReference && normalizeFileID(m.objectReference) !== '0' ? m.objectReference : m.value; }
function dataWithMods(srcData, mods, sourceGuid, sourceFileID) {
  const out = deepClone(srcData) ?? {};
  for (const m of mods) {
    if (m.target?.guid !== sourceGuid || normalizeFileID(m.target?.fileID) !== normalizeFileID(sourceFileID)) continue;
    setModValue(out, m.propertyPath, valueFromMod(m));
  }
  return out;
}
function parseStates(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => [STATE_NAMES[num(s.LightState, -99)] ?? String(s.LightState), num(s.Duration)]).filter((s) => Number.isFinite(s[1]));
}
function scriptGuid(entry) { return entry?.data?.m_Script?.guid; }

async function main() {
  // Parse shared-state asset as a sanity/read-only source; use fixed table above for the requested GetStates values.
  if (fs.existsSync(SHARED_STATES_PATH)) buildIndex(fs.readFileSync(SHARED_STATES_PATH, 'utf8'));
  const guidDb = await loadGuidDb(guidPath);
  const unityRoot = guidDb.unityProjectRoot ?? path.dirname(scenePath);
  const mainIdx = buildIndex(fs.readFileSync(scenePath, 'utf8'));

  const strippedByKey = new Map();
  for (const [fid, entry] of mainIdx.byFileID) {
    if (!entry.stripped) continue;
    const corr = entry.data.m_CorrespondingSourceObject;
    const inst = normalizeFileID(entry.data.m_PrefabInstance);
    if (corr?.guid && inst !== '0') strippedByKey.set(`${inst}:${corr.guid}:${normalizeFileID(corr.fileID)}`, fid);
  }
  const prefabIndexCache = new Map();
  function loadPrefabIndex(guid) {
    if (prefabIndexCache.has(guid)) return prefabIndexCache.get(guid);
    const rec = guidDb.guids?.[guid]; let idx = null;
    if (rec?.path) { try { idx = buildIndex(fs.readFileSync(path.isAbsolute(rec.path) ? rec.path : path.join(unityRoot, rec.path), 'utf8')); } catch { idx = null; } }
    prefabIndexCache.set(guid, idx); return idx;
  }
  function resolveTransformFileIDIn(idx, ref) {
    const fid = normalizeFileID(ref); if (fid === '0') return null;
    const entry = idx.byFileID.get(fid); if (!entry) return null;
    if (entry.classId === 4) return fid;
    if (entry.classId === 1) return idx.transformByGameObject.get(fid) ?? null;
    if (entry.classId === 114) return idx.transformByGameObject.get(normalizeFileID(entry.data.m_GameObject)) ?? null;
    return null;
  }
  const worldCache = new Map(); let missingParents = 0;
  function worldOfTransform(ctxKey, idx, tid) {
    tid = normalizeFileID(tid); if (tid === '0') return IDENTITY_WORLD;
    const cacheKey = `${ctxKey}#T#${tid}`; if (worldCache.has(cacheKey)) return worldCache.get(cacheKey);
    const entry = idx.byFileID.get(tid); if (!entry || entry.classId !== 4) { missingParents++; return IDENTITY_WORLD; }
    let world;
    if (entry.stripped) {
      const instFileID = normalizeFileID(entry.data.m_PrefabInstance), corr = entry.data.m_CorrespondingSourceObject;
      const instWorld = worldOfInstance(ctxKey, idx, instFileID); const childIdx = corr?.guid ? loadPrefabIndex(corr.guid) : null;
      world = childIdx ? compose(instWorld, worldOfTransform(`prefab:${corr.guid}`, childIdx, corr.fileID)) : instWorld;
    } else {
      const parentTid = normalizeFileID(entry.data.m_Father);
      world = compose(parentTid === '0' ? IDENTITY_WORLD : worldOfTransform(ctxKey, idx, parentTid), localTransform(entry.data));
    }
    worldCache.set(cacheKey, world); return world;
  }
  function worldOfInstance(ctxKey, idx, instFileID) {
    instFileID = normalizeFileID(instFileID); const cacheKey = `${ctxKey}#I#${instFileID}`; if (worldCache.has(cacheKey)) return worldCache.get(cacheKey);
    const entry = idx.byFileID.get(instFileID); if (!entry || entry.classId !== 1001) { missingParents++; return IDENTITY_WORLD; }
    const mod = entry.data.m_Modification ?? {}; const parentTid = normalizeFileID(mod.m_TransformParent);
    const world = compose(parentTid === '0' ? IDENTITY_WORLD : worldOfTransform(ctxKey, idx, parentTid), localFromMods(mod.m_Modifications ?? []));
    worldCache.set(cacheKey, world); return world;
  }
  function sceneRefForLocal(inst, guid, ref) { const fid = normalizeFileID(ref); return fid === '0' ? '0' : (strippedByKey.get(`${inst}:${guid}:${fid}`) ?? fid); }
  function getEffective(entry) {
    if (!entry.stripped) return { data: entry.data, inst: null, guid: null, sourceFileID: null, sourceIdx: mainIdx };
    const corr = entry.data.m_CorrespondingSourceObject, inst = normalizeFileID(entry.data.m_PrefabInstance);
    const sourceIdx = corr?.guid ? loadPrefabIndex(corr.guid) : null;
    const srcEntry = sourceIdx?.byFileID.get(normalizeFileID(corr?.fileID));
    if (!srcEntry) return null;
    const mods = mainIdx.byFileID.get(inst)?.data?.m_Modification?.m_Modifications ?? [];
    return { data: dataWithMods(srcEntry.data, mods, corr.guid, corr.fileID), inst, guid: corr.guid, sourceFileID: normalizeFileID(corr.fileID), sourceIdx };
  }
  function worldPointOfRef(ref, eff = null) {
    let fid = normalizeFileID(ref); if (fid === '0') return null;
    if (eff?.inst && eff?.guid) fid = sceneRefForLocal(eff.inst, eff.guid, fid);
    const tid = resolveTransformFileIDIn(mainIdx, fid);
    return tid ? toGaiaPoint(worldOfTransform('scene', mainIdx, tid).position) : null;
  }

  const handlersById = new Map();
  for (const [fid, entry] of mainIdx.byFileID) {
    if (entry.classId !== 114) continue;
    const isHandler = entry.stripped ? scriptGuid(entry) === HANDLER_GUID : scriptGuid(entry) === HANDLER_GUID;
    if (!isHandler) continue;
    const eff = getEffective(entry); if (!eff) continue;
    const groupsNodes = (Array.isArray(eff.data.triggers) ? eff.data.triggers : []).map((r) => worldPointOfRef(r, eff)).filter(Boolean);
    handlersById.set(fid, { fid, index: num(eff.data.relatedLightIndex), nodes: groupsNodes, ownStates: parseStates(eff.data.lightStates), eff });
  }

  // Some Boomtown prefab instances keep TrafficLightHandler.triggers as null
  // overrides, while each TrafficNode PrefabInstance carries a
  // relatedTrafficLightHandler override. Fold that inverse relation back into
  // handler nodes.
  const nodePositionsByHandler = new Map();
  for (const [instFileID, entry] of mainIdx.byFileID) {
    if (entry.classId !== 1001) continue;
    const mods = entry.data.m_Modification?.m_Modifications ?? [];
    for (const m of mods) {
      if (m.propertyPath !== 'relatedTrafficLightHandler') continue;
      const hid = normalizeFileID(m.objectReference);
      if (hid === '0') continue;
      const pos = toGaiaPoint(worldOfInstance('scene', mainIdx, instFileID).position);
      if (!nodePositionsByHandler.has(hid)) nodePositionsByHandler.set(hid, []);
      nodePositionsByHandler.get(hid).push(pos);
    }
  }
  for (const [hid, nodes] of nodePositionsByHandler) {
    const h = handlersById.get(hid);
    if (h && h.nodes.length === 0) {
      const seen = new Set();
      h.nodes = nodes.filter((p) => { const k = p.join(','); if (seen.has(k)) return false; seen.add(k); return true; });
    }
  }


  const crossroads = [];
  let totalCrossroads = 0, skippedNoGroups = 0;
  for (const [fid, entry] of mainIdx.byFileID) {
    if (entry.classId !== 114) continue;
    const isCross = entry.stripped ? scriptGuid(entry) === CROSSROAD_GUID : scriptGuid(entry) === CROSSROAD_GUID;
    if (!isCross) continue;
    const eff = getEffective(entry); if (!eff) continue;
    totalCrossroads++;
    const pos = worldPointOfRef(eff.data.m_GameObject, eff);
    const vals = eff.data.trafficLightHandlerData?.values ?? [];
    const groups = [];
    for (const hRef of vals) {
      let hid = normalizeFileID(hRef); if (eff.inst && eff.guid) hid = sceneRefForLocal(eff.inst, eff.guid, hid);
      const h = handlersById.get(hid); if (!h) continue;
      groups.push({ index: h.index, states: num(eff.data.customSettings) ? h.ownStates : deepClone(SHARED_STATES[h.index] ?? SHARED_STATES[0]), nodes: h.nodes });
    }
    if (!groups.length) { skippedNoGroups++; continue; }
    crossroads.push({ id: num(eff.data.uniqueId) || fid, position: pos ?? [0, 0, 0], groups });
  }
  crossroads.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(crossroads, null, 2)}\n`);
  const handlerGroups = crossroads.reduce((n, c) => n + c.groups.length, 0);
  console.log(`[extract-lights] crossroads=${crossroads.length} totalCrossroads=${totalCrossroads} handlerGroups=${handlerGroups} handlers=${handlersById.size} skippedNoGroups=${skippedNoGroups} missingParents=${missingParents} out=${outPath}`);
}

await main();
