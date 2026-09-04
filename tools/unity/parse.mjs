#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASS_NAMES, splitUnityDocuments, parseUnityYamlBody, loadGuidDb, normalizeFileID, cleanRef, withoutKeys, pathBaseNoExt
} from './unity-yaml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function usage() {
  console.error('usage: node tools/unity/parse.mjs <sceneOrPrefab.unity|.prefab> [--guids <guids.json>] [--out <ir.json>] [--stdout]');
  process.exit(2);
}

const ZERO_VEC = { x: 0, y: 0, z: 0 };
const ONE_VEC = { x: 1, y: 1, z: 1 };
const ID_QUAT = { x: 0, y: 0, z: 0, w: 1 };

function v3(v, fallback = ZERO_VEC) {
  return { x: num(v?.x, fallback.x), y: num(v?.y, fallback.y), z: num(v?.z, fallback.z) };
}
function q4(q, fallback = ID_QUAT) {
  return { x: num(q?.x, fallback.x), y: num(q?.y, fallback.y), z: num(q?.z, fallback.z), w: num(q?.w, fallback.w) };
}
function num(v, fallback = 0) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function mulV(a, b) { return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z }; }
function addV(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function quatMul(a, b) {
  return {
    x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
    w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z
  };
}
function quatRotate(q, v) {
  const x = v.x, y = v.y, z = v.z;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx
  };
}
function compose(parent, local) {
  return {
    position: addV(parent.position, quatRotate(parent.rotation, mulV(parent.scale, local.position))),
    rotation: quatMul(parent.rotation, local.rotation),
    scale: mulV(parent.scale, local.scale)
  };
}
function localTransform(t) {
  return {
    position: v3(t?.m_LocalPosition),
    rotation: q4(t?.m_LocalRotation),
    scale: v3(t?.m_LocalScale, ONE_VEC)
  };
}
function localFromMods(mods) {
  const tr = { position: { ...ZERO_VEC }, rotation: { ...ID_QUAT }, scale: { ...ONE_VEC } };
  const set = (path, value) => {
    if (!path) return;
    const n = num(value, undefined);
    if (!Number.isFinite(n)) return;
    if (path.startsWith('m_LocalPosition.')) tr.position[path.split('.').at(-1)] = n;
    else if (path.startsWith('m_LocalRotation.')) tr.rotation[path.split('.').at(-1)] = n;
    else if (path.startsWith('m_LocalScale.')) tr.scale[path.split('.').at(-1)] = n;
  };
  for (const m of mods) set(m.propertyPath, m.value);
  return tr;
}
function objPathSet(root, prop, value) {
  const parts = String(prop).split('.');
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts.at(-1)] = value;
}

function componentRefs(go) {
  return (go?.m_Component ?? []).map(x => normalizeFileID(x?.component)).filter(id => id !== '0');
}
function gameObjectRef(comp) { return normalizeFileID(comp?.m_GameObject); }
function childTransformRefs(t) { return (t?.m_Children ?? []).map(normalizeFileID).filter(id => id !== '0'); }

function buildPrefabInstance(doc, data, guidDb, transformByFile) {
  const mod = data?.m_Modification ?? {};
  const mods = mod.m_Modifications ?? [];
  const overrides = {};
  let name = null, active = null;
  for (const m of mods) {
    const target = cleanRef(m.target, guidDb);
    const targetKey = `${target?.guid ?? 'local'}:${target?.fileID ?? '0'}`;
    overrides[targetKey] ??= { target, properties: {} };
    const value = (m.objectReference && normalizeFileID(m.objectReference) !== '0') ? cleanRef(m.objectReference, guidDb) : m.value;
    objPathSet(overrides[targetKey].properties, m.propertyPath, value);
    if (m.propertyPath === 'm_Name') name = String(m.value ?? '');
    if (m.propertyPath === 'm_IsActive') active = Boolean(Number(m.value));
  }
  const source = cleanRef(data?.m_SourcePrefab, guidDb);
  const parentTransform = normalizeFileID(mod.m_TransformParent);
  const stripped = [...transformByFile.values()].find(t => normalizeFileID(t?.m_PrefabInstance) === doc.fileID);
  // Overrides span every object below a PrefabInstance. The instance pose comes
  // only from its stripped root Transform; taking every transform override
  // silently substituted a child mesh pose for the root.
  const strippedSource = cleanRef(stripped?.m_CorrespondingSourceObject, guidDb);
  const transformMods = strippedSource
    ? mods.filter((m) => {
      const target = cleanRef(m.target, guidDb);
      return target?.fileID === strippedSource.fileID && target?.guid === strippedSource.guid;
    })
    : mods;
  return {
    id: `prefab:${doc.fileID}`,
    fileID: doc.fileID,
    classId: doc.classId,
    type: 'PrefabInstance',
    name: name || (source?.path ? pathBaseNoExt(source.path) : `PrefabInstance ${doc.fileID}`),
    active: active ?? true,
    transformFileID: stripped?._fileID ?? null,
    parentTransformFileID: parentTransform === '0' ? null : parentTransform,
    source,
    transform: { local: localFromMods(transformMods), world: null },
    prefab: {
      modifications: Object.values(overrides),
      removedComponents: mod.m_RemovedComponents ?? [],
      removedGameObjects: mod.m_RemovedGameObjects ?? [],
      addedGameObjects: mod.m_AddedGameObjects ?? [],
      addedComponents: mod.m_AddedComponents ?? []
    }
  };
}

function classKeyForDoc(parsed, className) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (className && parsed[className]) return className;
  const keys = Object.keys(parsed);
  return keys.length === 1 ? keys[0] : null;
}

export async function parseFile(scenePath, guidDb) {
  const text = await fs.readFile(scenePath, 'utf8');
  const docsRaw = splitUnityDocuments(text);
  const docs = [];
  const byFileID = new Map();
  const byClass = new Map();
  for (const d of docsRaw) {
    const parsed = parseUnityYamlBody(d.lines);
    const className = CLASS_NAMES[d.classId] ?? classKeyForDoc(parsed, null) ?? `Class${d.classId}`;
    const key = classKeyForDoc(parsed, className);
    const data = key ? parsed?.[key] : parsed;
    const doc = { ...d, className, data };
    docs.push(doc);
    byFileID.set(doc.fileID, doc);
    if (!byClass.has(doc.classId)) byClass.set(doc.classId, []);
    byClass.get(doc.classId).push(doc);
  }

  const gameObjects = new Map();
  const transforms = new Map();
  const componentsByGo = new Map();
  const componentByFile = new Map();
  for (const doc of docs) {
    doc.data ??= {};
    doc.data._fileID = doc.fileID;
    if (doc.classId === 1) gameObjects.set(doc.fileID, doc.data);
    if (doc.classId === 4 || doc.classId === 224) transforms.set(doc.fileID, doc.data);
    if (![1, 4, 224, 1001].includes(doc.classId)) {
      componentByFile.set(doc.fileID, doc);
      const go = gameObjectRef(doc.data);
      if (go !== '0') {
        if (!componentsByGo.has(go)) componentsByGo.set(go, []);
        componentsByGo.get(go).push(doc);
      }
    }
  }

  const transformToGo = new Map();
  const goToTransform = new Map();
  for (const [goId, go] of gameObjects) {
    for (const cid of componentRefs(go)) {
      if (transforms.has(cid)) { goToTransform.set(goId, cid); transformToGo.set(cid, goId); break; }
    }
  }

  // Stripped transforms have no local pose in scene YAML; their pose is stored
  // on the owning PrefabInstance's root-target override. Build this relation
  // before resolving hierarchy so children compose through their real parent.
  const prefabInstances = [];
  for (const doc of byClass.get(1001) ?? []) prefabInstances.push(buildPrefabInstance(doc, doc.data, guidDb, transforms));
  const prefabByTransform = new Map(
    prefabInstances.filter((pi) => pi.transformFileID).map((pi) => [pi.transformFileID, pi]),
  );
  const worldByTransform = new Map();
  const visiting = new Set();
  function resolveWorldTransform(tid) {
    tid = normalizeFileID(tid);
    if (worldByTransform.has(tid)) return worldByTransform.get(tid);
    if (visiting.has(tid)) return { position: ZERO_VEC, rotation: ID_QUAT, scale: ONE_VEC };
    visiting.add(tid);
    const t = transforms.get(tid);
    const prefab = prefabByTransform.get(tid);
    const local = prefab?.transform.local ?? localTransform(t);
    const parentTid = prefab?.parentTransformFileID ?? normalizeFileID(t?.m_Father);
    const parentWorld = parentTid !== '0' ? resolveWorldTransform(parentTid) : { position: ZERO_VEC, rotation: ID_QUAT, scale: ONE_VEC };
    const world = compose(parentWorld, local);
    worldByTransform.set(tid, world);
    visiting.delete(tid);
    return world;
  }
  for (const tid of transforms.keys()) resolveWorldTransform(tid);

  function transformIR(tid) {
    const t = transforms.get(tid);
    if (!t) return null;
    const parentTid = normalizeFileID(t.m_Father);
    return {
      fileID: tid,
      parentTransformFileID: parentTid === '0' ? null : parentTid,
      parent: transformToGo.get(parentTid) ?? null,
      children: childTransformRefs(t).map(id => transformToGo.get(id) ?? id),
      local: localTransform(t),
      world: worldByTransform.get(tid) ?? { position: ZERO_VEC, rotation: ID_QUAT, scale: ONE_VEC }
    };
  }

  const entities = [];
  for (const [goId, go] of gameObjects) {
    const tid = goToTransform.get(goId);
    const comps = componentsByGo.get(goId) ?? [];
    const ent = {
      id: goId,
      fileID: goId,
      type: 'GameObject',
      name: String(go.m_Name ?? `GameObject ${goId}`),
      active: Boolean(Number(go.m_IsActive ?? 1)),
      tag: go.m_TagString ?? null,
      layer: go.m_Layer ?? 0,
      staticEditorFlags: go.m_StaticEditorFlags ?? 0,
      transform: transformIR(tid),
      componentFileIDs: componentRefs(go),
      components: {}
    };
    for (const c of comps) {
      const d = c.data;
      if (c.classId === 33) ent.components.meshFilter = { mesh: cleanRef(d.m_Mesh, guidDb) };
      else if (c.classId === 23) ent.components.meshRenderer = {
        enabled: Boolean(Number(d.m_Enabled ?? 1)),
        materials: (d.m_Materials ?? []).map(m => cleanRef(m, guidDb)),
        castShadows: d.m_CastShadows, receiveShadows: d.m_ReceiveShadows, lightmapIndex: d.m_LightmapIndex
      };
      else if (c.classId === 108) ent.components.light = {
        enabled: Boolean(Number(d.m_Enabled ?? 1)), type: d.m_Type, shape: d.m_Shape, color: d.m_Color,
        intensity: d.m_Intensity, range: d.m_Range, spotAngle: d.m_SpotAngle, innerSpotAngle: d.m_InnerSpotAngle,
        cookie: cleanRef(d.m_Cookie, guidDb), renderMode: d.m_RenderMode, shadows: d.m_Shadows
      };
      else if (c.classId === 20) ent.components.camera = {
        enabled: Boolean(Number(d.m_Enabled ?? 1)), fov: d.fieldOfView, orthographic: Boolean(Number(d.orthographic ?? 0)),
        orthographicSize: d.orthographicSize, near: d.near_clip_plane, far: d.far_clip_plane, backgroundColor: d.m_BackGroundColor,
        clearFlags: d.m_ClearFlags, depth: d.m_Depth, viewport: d.normalizedViewPortRect
      };
      else if ([64, 65, 135, 136].includes(c.classId)) {
        ent.components.colliders ??= [];
        ent.components.colliders.push({
          fileID: c.fileID, kind: c.className, enabled: Boolean(Number(d.m_Enabled ?? 1)), isTrigger: Boolean(Number(d.m_IsTrigger ?? 0)),
          center: d.m_Center, size: d.m_Size, radius: d.m_Radius, height: d.m_Height, direction: d.m_Direction, mesh: cleanRef(d.m_Mesh, guidDb), material: cleanRef(d.m_Material, guidDb)
        });
      } else if (c.classId === 114) {
        ent.components['unity.script'] ??= [];
        ent.components['unity.script'].push({
          fileID: c.fileID,
          enabled: d.m_Enabled == null ? undefined : Boolean(Number(d.m_Enabled)),
          script: cleanRef(d.m_Script, guidDb),
          fields: withoutKeys(d, ['_fileID', 'm_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_Name', 'm_EditorClassIdentifier'])
        });
      } else if (c.classId === 218) ent.components.terrain = { terrainData: cleanRef(d.m_TerrainData, guidDb), enabled: Boolean(Number(d.m_Enabled ?? 1)) };
      else {
        ent.components.unity ??= [];
        ent.components.unity.push({ fileID: c.fileID, classId: c.classId, className: c.className });
      }
    }
    ent.renderable = Boolean(ent.components.meshFilter || ent.components.meshRenderer || ent.components.terrain);
    entities.push(ent);
  }

  for (const pi of prefabInstances) {
    pi.parent = transformToGo.get(pi.parentTransformFileID) ?? null;
    pi.transform.world = pi.transformFileID
      ? resolveWorldTransform(pi.transformFileID)
      : compose(worldByTransform.get(pi.parentTransformFileID) ?? { position: ZERO_VEC, rotation: ID_QUAT, scale: ONE_VEC }, pi.transform.local);
  }

  const statsByClass = {};
  for (const doc of docs) statsByClass[doc.className] = (statsByClass[doc.className] ?? 0) + 1;
  return {
    version: 1,
    source: scenePath,
    sourceKind: path.extname(scenePath).slice(1).toLowerCase(),
    unityProjectRoot: guidDb.unityProjectRoot ?? null,
    documentCount: docs.length,
    strippedDocumentCount: docs.filter(d => d.stripped).length,
    stats: {
      byClass: statsByClass,
      gameObjects: gameObjects.size,
      transforms: transforms.size,
      renderableEntities: entities.filter(e => e.renderable).length,
      prefabInstances: prefabInstances.length,
      monoBehaviours: (byClass.get(114) ?? []).length,
      colliders: [...componentByFile.values()].filter(d => [64,65,135,136].includes(d.classId)).length
    },
    entities,
    prefabInstances
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const args = process.argv.slice(2);
if (!args[0] || args[0] === '-h' || args[0] === '--help') usage();
const inputPath = path.resolve(args[0]);
let guidPath = path.join(OUT_DIR, 'guids.json');
let outPath = null;
let fullStdout = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--guids') guidPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--out') outPath = path.resolve(args[++i] ?? usage());
  else if (args[i] === '--stdout') fullStdout = true;
  else usage();
}

const guidDb = await loadGuidDb(guidPath);
const ir = await parseFile(inputPath, guidDb);
if (!outPath) outPath = path.join(OUT_DIR, `${pathBaseNoExt(inputPath)}.ir.json`);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(ir, null, 2));
if (fullStdout) console.log(JSON.stringify(ir, null, 2));
else console.log(JSON.stringify({ out: outPath, source: ir.source, documentCount: ir.documentCount, strippedDocumentCount: ir.strippedDocumentCount, entityCount: ir.entities.length, prefabInstanceCount: ir.prefabInstances.length, renderableEntityCount: ir.stats.renderableEntities }, null, 2));

}
