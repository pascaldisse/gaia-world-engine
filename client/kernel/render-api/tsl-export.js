// render-api/tsl-export.js — three TSL NodeMaterial → WGSL package, HEADLESS (no GPU, no canvas, node/bun).
// Runs three r180's own WGSLNodeBuilder against a stub renderer/backend and returns a data-only package
//   { vertex, fragment, bindGroups[{group,name,shared,bindings[{binding,name,kind,type,stage,size,value?,textureKey?}]}],
//     attributes[{name,type,location}], varyings[{name,type}], vertexEntry:'main', fragmentEntry:'main' }
// that a non-three backend feeds to create_shader_material (RENDER-API.md §6). No three import here: the caller
// passes the (possibly engine-injected) THREE namespace (`three/webgpu`) → works for the ctx.three case too.
import { observeLights } from './light-registry.js';
import { leakGuards } from './native/page-memory.js';
const STAGES = { 1: 'vertex', 2: 'fragment', 4: 'compute' };
const stageOf = (v) => STAGES[v] ?? ([v & 1 ? 'vertex' : null, v & 2 ? 'fragment' : null].filter(Boolean).join('|') || 'none');

const kindOf = (b) => (b.isUniformsGroup ? 'uniform-buffer' : b.isSampledTexture ? (b.isSampledCubeTexture ? 'texture-cube' : b.isSampledTexture3D ? 'texture-3d' : b.isStorageTexture ? 'storage-texture' : (b.texture?.isArrayTexture || b.texture?.isDataArrayTexture || b.texture?.isCompressedArrayTexture) ? 'texture-2d-array' : 'texture-2d') : b.isSampler ? 'sampler' : b.isStorageBuffer ? 'storage-buffer' : 'unknown');

// builder → data package. `THREE` = three/webgpu namespace; `WGSLNodeBuilder` is not exported publicly, so we reach it
// through three's own backend factory (WebGPUBackend.prototype.createNodeBuilder) without constructing a device.
function buildPackage(material, { THREE, object = null, geometry = null, camera = null, scene = null, wgslBuilderCtor = null, renderer = null, receiveShadow = false, castShadow = false, coreShadow = true } = {}, gate = null) {
const Ctor0 = wgslBuilderCtor ?? headlessRenderer(THREE)._ctor;
const Ctor = gate ? gatedCtor(THREE, Ctor0) : Ctor0;
const r = renderer ?? headlessRenderer(THREE);
// `object` = the real mesh (its geometry attributes decide which TSL attribute() nodes resolve); `geometry` = same without the object (InstancedMesh/Skinned: instancing is expanded by the adapter, never exported).
const obj = object ?? new THREE.Mesh(geometry ?? new THREE.BoxGeometry(1, 1, 1), material);
// r10-shadow-4: the stand-in Mesh (instanced/skinned) carries the SOURCE object's three shadow flags; a real object already has its own.
if (!object) { obj.receiveShadow = !!receiveShadow; obj.castShadow = !!castShadow; }
obj.updateMatrixWorld?.();
const cam = camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
const sc = scene ?? new THREE.Scene();
const b = new Ctor(obj, r);
if (gate) b._gate = gate;
b.scene = sc; b.material = material; b.camera = cam; b.context.material = material;
// (b) real lights: three's own LightsNode over the scene's Directional/Point lights (shadows not exported) → lit node materials shade.
// Light uniform VALUES come from three's light nodes per frame (live.update) — same objects the adapter maps to setSun/addPointLight.
const { live: lights, all: bakedLights } = observeLights(sc); // r16-perf: baked set = grow-only registry (light-registry.js), NOT the current scene lights -> torch-pool churn never changes the set
b.lightsNode = bakedLights.length ? sharedLightsNode(r, sc, bakedLights, THREE) : null; b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
// r10-shadow-3: the sun's shadow = the CORE's cascaded shadow map (three's own light math × a shadow factor from three's light.shadow.shadowNode hook).
// The hook node calls `gaia_sun_shadow(...)`; the wgpu core appends its own forward.wgsl CSM receiver to such packages (three_material.rs). three's ShadowNode
// (own depth texture/matrices) is NOT exported — the core owns the cascades. Receivers only (object.receiveShadow, three semantics).
const restoreShadow = coreShadow === false ? () => {} : installCoreShadow(THREE, lights, r); // coreShadow:false = A/B switch (?wgpuCoreShadow=0)
try { b.build(); } finally { restoreShadow(); }
// uniform node uuid → ReferenceNode that drives it (material.opacity, color, …) for source tags
const refs = new Map();
for (const n of [...b.updateNodes, ...b.updateBeforeNodes]) if ('property' in n && 'reference' in n && n.node?.uuid) refs.set(n.node.uuid, n);
// uniform node uuid → light uuid for light-node-owned uniforms (color, cutoff, decay; view-space positions stay 'uniform')
const lightUuids = new Map();
for (const n of b.updateNodes) if (n.light?.isLight) for (const v of Object.values(n)) if (v?.isUniformNode) lightUuids.set(v.uuid, n.light.uuid);
const liveUniforms = [];
  const semantics = builtinSemantics(THREE);
const bufferSources = {}; // r6-tsl-2: "group.binding" -> live three BufferAttribute behind a storage binding (non-enumerable on the package)
const groups = b.getBindings().map((g) => ({
group: g.index, name: g.name,
bindings: g.bindings.map((bd, i) => {
const out = { binding: i, name: bd.name, kind: kindOf(bd), stage: stageOf(bd.visibility) };
if (bd.isUniformsGroup) {
out.size = bd.bytesPerElement ? undefined : undefined;
out.uniforms = bd.uniforms.map((u) => {
  const semantic = semantics.get(u.nodeUniform?.node?.uuid) ?? (/^camera|^time$|^deltaTime$/.test(u.name) ? u.name : null);
  const node = u.nodeUniform?.node, source = semantic ? { kind: 'host', semantic } : sourceOf(node, refs, lightUuids);
  // key = stable id the backend uses for set_three_uniforms (uniform node uuid; unique per package)
  const key = semantic ? null : (node?.uuid ?? `${g.index}.${i}.${u.name}`);
  if (key) liveUniforms.push(structCache.lean ? { key, node, get: uGet(u) } : { key, u, node, get: () => u.getValue?.() }); // nt-tslbudget lean: module-level getter factory (the inline arrow's context chain pinned buildPackage's refs/lightUuids/semantics/bufferSources); `u` field was never read
  return { name: u.name, semantic, key, source, type: u.type, offset: u.offset, itemSize: u.itemSize, boundary: u.boundary, value: toPlain(u.getValue?.()) };
});
} else if (bd.texture) { out.textureUuid = bd.texture.uuid; out.colorSpace = bd.texture.colorSpace ?? null; }
else if (bd.isStorageBuffer && bd.attribute) { out.access = bd.access ?? null; out.byteLength = bd.attribute.array?.byteLength ?? 0; out.itemSize = bd.attribute.itemSize; bufferSources[`${g.index}.${i}`] = bd.attribute; }
return out;
}),
}));
const pkg = {
vertex: b.vertexShader, fragment: b.fragmentShader,
bindGroups: groups,
attributes: b.getAttributesArray().map((a, i) => attributeInfo(a, i)),
varyings: (b.varyings ?? []).map((v) => ({ name: v.name, type: v.type })),
vertexEntry: 'main', fragmentEntry: 'main',
material: { name: material.name, type: material.type, transparent: !!material.transparent, side: material.side, depthWrite: material.depthWrite, depthTest: material.depthTest, colorWrite: material.colorWrite, blending: material.blending },
};
// live three Texture per textureUuid, NON-enumerable → JSON stays as-is; backends read pixels from it (wgpu-backend createShaderMaterial).
const textureSources = {};
for (const g of b.getBindings()) for (const bd of g.bindings) if (bd.texture) textureSources[bd.texture.uuid] = bd.texture;
Object.defineProperty(pkg, 'textureSources', { value: textureSources, enumerable: false });
Object.defineProperty(pkg, 'bufferSources', { value: bufferSources, enumerable: false });
// r6: node-held BufferAttributes (instancedBufferAttribute()/bufferAttribute() nodes → nodeAttributeN): key `node:<uuid>` → live three BufferAttribute (non-enumerable).
const attributeSources = {};
for (const a of b.getAttributesArray()) if (a.node?.attribute) attributeSources[`node:${a.node.uuid}`] = a.node.attribute;
Object.defineProperty(pkg, 'attributeSources', { value: attributeSources, enumerable: false });
defineLive(pkg, { THREE, r, material, obj, cam, sc, updateNodes: [...b.updateNodes], updateBeforeNodes: [...b.updateBeforeNodes], live: liveUniforms });
Object.defineProperty(pkg, 'tpl', { enumerable: false, value: { updateNodes: [...b.updateNodes], updateBeforeNodes: [...b.updateBeforeNodes], liveUniforms } });
return pkg;
}
// r10-4 shared frame-scope update session (per renderer) + shared LightsNode per (renderer, scene, light set).
const sharedFrames = new WeakMap();
function shared(r, THREE, token, time) {
let s = sharedFrames.get(r);
if (!s) { const frame = new (THREE.NodeFrame ?? THREE.TSL?.NodeFrame)(); frame.renderer = r; sharedFrames.set(r, (s = { frame, token: undefined, done: new Set(), T: THREE.NodeUpdateType })); }
if (s.token !== token) { s.token = token; s.frame.update(); s.frame.renderId++; if (structCache.bound) s.done = new WeakSet(); else if (s.done.clear) s.done.clear(); else s.done = new Set(); structCache.frames++; /* nt-tslbudget bound: WeakSet - the strong Set pinned every update node (-> material/mesh) of the last frame between frames */ }
if (time != null) s.frame.time = time;
return s;
}
// r16-perf: three's LightsNode emits every light's BRDF straight-line (no branch) -> DS's 25-PointLight torch pool costs 25x per fragment although ~all have intensity 0 / are out of range. Wrap each Point/Spot light's direct() in a TSL If (uniform colour > 0, then attenuated colour > 0): identical result (a zero lightColor adds nothing), dead lights cost one uniform compare. ?wgpuLightCull=0 / lightCull.on=false = A/B off.
export const lightCull = { on: !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('wgpuLightCull') === '0') };
function cullLights(THREE, node) {
const proto = node && Object.getPrototypeOf(node), If = (THREE?.TSL ?? THREE)?.If;
// patched on the PROTOTYPE: a material with its own light nodes (lightMap) gets a fresh LightsNode from renderer.lighting.createNode, bypassing any per-instance patch
if (!proto || !If || proto.__lightCull || typeof proto.setupDirectLight !== 'function') return node;
const orig = proto.setupDirectLight; proto.__lightCull = true; let seen = null;
const lit = (c) => c.x.add(c.y).add(c.z).greaterThan(0);
proto.setupDirectLight = function (builder, lightNode, data) {
const l = lightNode?.light;
// three caches flow-coded nodes (lightingModel.direct()'s accumulator inits `directDiffuse = 0`, normalView, positionViewDirection ...) and re-emits their code per If-block -> the FIRST direct() call must run in the OUTER scope (shared nodes live there; a later block re-zeroing the accumulator wiped earlier lights = measured bug in the WIP). Only subsequent lights are branched. Shadowed lights stay straight-line (shadow-map sampling needs uniform control flow).
(seen ??= new WeakSet());
if (!lightCull.on || !(l?.isPointLight || l?.isSpotLight) || l.castShadow || !lightNode.colorNode?.x || !data?.lightColor?.x || !seen.has(builder)) { seen.add(builder); return orig.call(this, builder, lightNode, data); }
If(lit(lightNode.colorNode), () => { If(lit(data.lightColor), () => { orig.call(this, builder, lightNode, data); }); }); // outer = uniform test (attenuation maths emitted inside it), inner = out-of-range test
};
return node;
}
const lightsCache = new WeakMap(); // scene -> { sig, node }
function sharedLightsNode(r, sc, lights, THREE = null) {
if (!structCache.share) return cullLights(THREE, r.lighting.createNode(lights));
const sig = lights.map((l) => l.uuid).join(',');
const c = lightsCache.get(sc);
if (c && c.sig === sig && c.r === r) { structCache.lightsReused++; return c.node; }
const node = cullLights(THREE, r.lighting.createNode(lights)); lightsCache.set(sc, { sig, node, r }); structCache.lightsBuilt++; return node;
}
// (a) live values, NON-enumerable: runs three's OWN node updates (NodeFrame over updateNodes - reference(), uniform
// onFrame/onRender/onObjectUpdate, light nodes) and returns only uniforms whose packed value changed since the last call.
function defineLive(pkg, { THREE, r, material, obj, cam, sc, updateNodes, updateBeforeNodes, live: liveUniforms, initial = null, pre = [] }) {
const mkOwn = () => { const f = new (THREE.NodeFrame ?? THREE.TSL?.NodeFrame)(); f.renderer = r; return f; }; let own = structCache.lean ? null : mkOwn(); /* nt-tslbudget lean: the per-package frame (3 WeakMaps) only exists for share=off */ const lightObjs = [...new Set(updateNodes.filter((n) => n.light?.isLight).map((n) => n.light))]; const NUT = THREE.NodeUpdateType ?? { FRAME: 'frame', RENDER: 'render' };
const last = new Map(liveUniforms.map(({ key, get }) => [key, initial && initial.has(key) ? initial.get(key) : toPlain(get())])); // initial = the package's own shipped values (rebound builder-singleton uniforms carry a stale value until the first update) // r10-2: plain snapshots compared component-wise (was JSON.stringify per uniform per frame per material)
let version = 0;
Object.defineProperty(pkg, 'live', { enumerable: false, value: {
keys: liveUniforms.map((x) => x.key),
// nt-exportcost dedupe: CURRENT plain value of every live uniform, positional (same order as keys). ok=false when a non-null raw value has no plain form (cannot be compared -> never deduped).
snapshot() { const vals = new Array(liveUniforms.length); let ok = true; for (let i = 0; i < liveUniforms.length; i++) { const raw = liveUniforms[i].get(); const v = toPlain(raw); if (v === null && raw != null) ok = false; vals[i] = v; } return { vals, ok }; },
get version() { return version; },
update({ object = obj, camera = cam, scene = sc, time, frameToken } = {}) {
// r10-4: share=on -> ONE NodeFrame per renderer; frame-scope work (time, renderId, camera/viewport/light RENDER|FRAME nodes) runs once per frameToken, not once per material. share=off -> legacy per-package frame (A/B flag: structCache.share / URL wgpuShare=0).
const sh = structCache.share && frameToken != null ? shared(r, THREE, frameToken, time) : null;
const frame = sh ? sh.frame : (own ??= mkOwn());
if (!sh) { frame.update(); if (time != null) frame.time = time; frame.renderId++; }
frame.object = object; frame.camera = camera; frame.scene = scene; frame.material = material;
for (const f of pre) f();
// r15b: three's renderer drops invisible lights (Lighting.getNode -> render list); the exported LightsNode holds ALL lights, so an invisible light (or one under an invisible ancestor) must read as intensity 0 while its light node updates, else it keeps shading.
const hid = []; for (const l of lightObjs) { let v = true, top = l; for (let p = l; p; p = p.parent) { top = p; if (p.visible === false) { v = false; break; } } if (v && scene && top !== scene) v = false; /* r16-perf: detached from the frame's scene = not in three's render list either */ if (!v && l.intensity !== 0) hid.push([l, l.intensity]); }
for (const [l] of hid) l.intensity = 0;
try {
if (sh) {
const done = sh.done, T = sh.T;
for (const n of updateBeforeNodes) frame.updateBeforeNode(n);
for (const n of updateNodes) { if (done.has(n)) { structCache.updSkipped++; continue; } frame.updateNode(n); const ty = n.getUpdateType(); if ((ty === NUT.FRAME || ty === NUT.RENDER) && n.updateReference(frame) === n) { const m = frame.updateMap.get(n); if (m && (ty === NUT.FRAME ? m.frameMap : m.renderMap).get(n) === (ty === NUT.FRAME ? frame.frameId : frame.renderId)) done.add(n); } }
} else {
for (const n of updateBeforeNodes) frame.updateBeforeNode(n);
for (const n of updateNodes) frame.updateNode(n);
}
} finally { for (const [l, i] of hid) l.intensity = i; if (structCache.lean) { frame.object = frame.camera = frame.scene = frame.material = null; /* nt-tslbudget: the shared frame pinned the LAST updated mesh/scene/camera/material until the next update */ } }
const changed = [];
for (const { key, get } of liveUniforms) {
const raw = get();
if (sameValue(raw, last.get(key))) continue;
const v = toPlain(raw); last.set(key, v); changed.push({ key, value: v });
}
if (changed.length) version++;
return changed;
},
} });
}

// r6: where a TSL vertex attribute's data comes from. geometry = geometry.getAttribute(name); node = a BufferAttributeNode's own attribute (instanced → per-instance row).
function attributeInfo(a, location) {
  const at = a.node?.attribute;
  if (!at) return { name: a.name, type: a.type, location, source: 'geometry', instanced: false, key: a.name };
  return { name: a.name, type: a.type, location, source: 'node', instanced: !!(at.isInstancedBufferAttribute || at.data?.isInstancedInterleavedBuffer), key: `node:${a.node.uuid}`, itemSize: at.itemSize };
}
// three source of a uniform: material/object property (reference) · TSL uniform() node · light uniform.
function sourceOf(node, refs, lightUuids) {
  if (!node) return null;
  const ref = refs.get(node.uuid);
  if (ref) return { kind: (ref.material ?? ref.reference)?.isMaterial || ref.type === 'MaterialReferenceNode' ? 'material' : 'reference', property: ref.property };
  return { kind: lightUuids.get(node.uuid) ? 'light' : 'uniform', uuid: node.uuid, name: node.name || null, update: node.updateType ?? 'none', light: lightUuids.get(node.uuid) ?? undefined };
}
// true when raw three value `v` equals the plain snapshot `p` (= toPlain(v) at last change) - no allocation.
function sameValue(v, p) {
  if (v == null) return p == null;
  if (typeof v === 'number' || typeof v === 'boolean') return v === p || (v !== v && p !== p);
  if (p == null) return !(v.isColor || v.isVector2 || v.isVector3 || v.isVector4 || v.elements); // toPlain(unknown) === null
  if (typeof p !== 'object') return false;
  if (v.isColor) return p.length === 3 && v.r === p[0] && v.g === p[1] && v.b === p[2];
  if (v.isVector2) return p.length === 2 && v.x === p[0] && v.y === p[1];
  if (v.isVector3) return p.length === 3 && v.x === p[0] && v.y === p[1] && v.z === p[2];
  if (v.isVector4) return p.length === 4 && v.x === p[0] && v.y === p[1] && v.z === p[2] && v.w === p[3];
  if (v.elements) { const e = v.elements; if (p.length !== e.length) return false; for (let i = 0; i < e.length; i++) if (e[i] !== p[i] && !(e[i] !== e[i] && p[i] !== p[i])) return false; return true; }
  return false;
}
function toPlain(v) {
if (v == null) return null;
if (typeof v === 'number' || typeof v === 'boolean') return v;
if (v.isColor) return [v.r, v.g, v.b];
if (v.isVector2) return [v.x, v.y];
if (v.isVector3) return [v.x, v.y, v.z];
if (v.isVector4) return [v.x, v.y, v.z, v.w];
if (v.elements) return Array.from(v.elements);
return null;
}

// WGSLNodeBuilder isn't a public export. A WebGPURenderer constructs its WebGPUBackend WITHOUT touching the GPU
// (init() is what requests the adapter), so a never-init'ed renderer on a stub canvas hands us the builder class.
const stubCanvas = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => null, width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 });
let _r = null;
// never-init'ed WebGPURenderer: real node library + backend class, no GPU. Only the feature/limits queries are stubbed.
function headlessRenderer(THREE, features = ['float32-filterable']) {
if (_r) return _r;
const r = new THREE.WebGPURenderer({ canvas: stubCanvas() });
r._ctor = r.backend.createNodeBuilder(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial()), r).constructor;
const fs = new Set(features);
r.hasFeature = (f) => fs.has(f);
r.backend.utils = { getTextureSampleData: () => ({ primarySamples: 1, isMSAA: false }) };
r.backend.compatibilityMode = false;
return (_r = r);
}

// Built-in TSL uniforms the HOST must supply (RENDER-API §6.4), keyed by the node uuid of three's own singletons.
// Object-group members get generated names (nodeUniformN), so the name alone cannot tell the host what they mean.
function builtinSemantics(THREE) {
  const T = THREE.TSL ?? THREE, m = new Map();
  const put = (node, sem) => { const u = node?.uniformNode ?? node; if (u?.uuid) m.set(u.uuid, sem); };
  for (const n of ['modelWorldMatrix', 'modelNormalMatrix', 'modelWorldMatrixInverse', 'modelPosition', 'modelScale', 'modelViewPosition', 'modelDirection',
    'cameraNear', 'cameraFar', 'time', 'deltaTime', 'frameId']) put(T[n], n);
  return m;
}
// ===== r10-3 STRUCTURAL EXPORT CACHE =====
// Same node graph (types + connections + constants + function identity + non-value props) => identical WGSL. A key hit skips three's node
// builder (~175 ms) and REBINDS the cached package: uniform key/value, texture, storage buffer, own live closure per material.
// Key can only be trusted, not proven, pre-build -> cache:'verify' builds every material anyway and compares (loud mismatch counters).
// cache: 'on' (default) | 'off' (A/B flag, URL wgpuTslCache=0) | 'verify'. Anything the walk cannot map 1:1 = uncacheable (counted by reason, full build).
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export const structCache = { share: true, frames: 0, updSkipped: 0, lightsBuilt: 0, lightsReused: 0, map: new Map(), hits: 0, misses: 0, uncacheable: 0, rebindFail: 0, mismatch: 0, layoutMismatch: 0, valueMismatch: 0, verified: 0, keyMs: 0, rebindMs: 0, buildMs: 0, preMs: 0, setupMs: 0, lookMs: 0, genMs: 0, reasons: {}, log: [], wgslOf: new Map(), maxTemplates: 128, evicted: 0, keySamples: null, keyProf: null, walkCheck: false, walkChecked: 0, walkMismatch: 0, refKeyMs: 0,
  // nt-tslbudget (wgpu-present sets these from native/page-memory.js tslLean/tslBound/tslMapMax; defaults = old behaviour for the browser path)
  hashKey: false, bindIdx: false, lean: false, bound: 0, nodesWalked: 0, nodesMax: 0, nodeWalks: 0, slimmed: 0, collected: 0,
// nt-tslrecipe (wgpu-present sets `recipe` from native/page-memory.js tslRecipe; default off = browser path unchanged). recipes: rk -> { key, sig, ids, pos, ln, state:'learn'|'ok'|'bad' }
recipe: false, recipes: new Map(), recipeHit: 0, recipeMiss: 0, recipeMismatch: 0, recipeBad: 0, recipeLearned: 0, recipeVerified: 0, recipeMs: 0 };
// r10-7: a template retains the whole node graph + package (nodes -> textures/geometry/closures). Keys that never repeat (per-mesh splits) piled up unbounded -> V8 OOM (~4 GB) at ~900 exports on Burnout. FIFO-bounded; a hit refreshes recency.
export function retainTemplate(C, key, tpl) { C.map.delete(key); C.map.set(key, tpl); while (C.map.size > Math.max(1, C.maxTemplates)) { C.map.delete(C.map.keys().next().value); C.evicted++; } }
/** nt-frameleak census: structCache sizes (templates pin node graph + package -> material/mesh/textures). */
export function tslCensus() { return { tpl: structCache.map.size, tplMax: structCache.maxTemplates, evicted: structCache.evicted, hits: structCache.hits, miss: structCache.misses, unc: structCache.uncacheable, wgslOf: structCache.wgslOf.size, ks: structCache.keySamples ? structCache.keySamples.size : 0, shOk: SHARED_OK.size, nodesAvg: structCache.nodeWalks ? Math.round(structCache.nodesWalked / structCache.nodeWalks) : 0, nodesMax: structCache.nodesMax, slim: structCache.slimmed, collected: structCache.collected, keyKB: tplKeyKB(), msPre: Math.round(structCache.preMs), msSetup: Math.round(structCache.setupMs), msKey: Math.round(structCache.keyMs), msLook: Math.round(structCache.lookMs), msRebind: Math.round(structCache.rebindMs), msGen: Math.round(structCache.genMs), msBuild: Math.round(structCache.buildMs), recipes: structCache.recipes.size, recipeHit: structCache.recipeHit, recipeMiss: structCache.recipeMiss, recipeMismatch: structCache.recipeMismatch, recipeBad: structCache.recipeBad, recipeLearned: structCache.recipeLearned, recipeVerified: structCache.recipeVerified, msRecipe: Math.round(structCache.recipeMs) }; }
// nt-exportcost: per-sync phase timings (ms). The scene-adapter brackets each sync with begin()/delta() and publishes the delta in the census (ad_exp*Ms) -> a live run names the dominant phase.
// pre = preParts (material flags + light scan) · setup = buildPackage start -> gate (builder ctor, observeLights, three's SETUP stage over the whole node graph) · key = structural walk · look = template lookup/retain · rebind = cache-hit rebind · gen = analyze+generate+package (MISS only) · build = rebind-failed full rebuild
const PHASES = ['preMs', 'setupMs', 'keyMs', 'lookMs', 'rebindMs', 'genMs', 'buildMs', 'recipeMs'];
const probeMark = {};
export const exportProbe = {
begin() { for (const k of PHASES) probeMark[k] = structCache[k]; probeMark.h = structCache.hits; probeMark.m = structCache.misses; },
delta() { const o = {}; for (const k of PHASES) o[k] = structCache[k] - (probeMark[k] ?? 0); o.hits = structCache.hits - (probeMark.h ?? 0); o.miss = structCache.misses - (probeMark.m ?? 0); return o; },
};
function tplKeyKB() { let n = 0; for (const k of structCache.map.keys()) n += k.length; return n >> 10; } // structural-key strings kept as Map keys (2 B/char in JSC if non-latin1, else 1)
const why = (k, detail) => { structCache.reasons[k] = (structCache.reasons[k] ?? 0) + 1; if (structCache.log.length < 40) structCache.log.push(detail ? `${k}: ${detail}` : k); };
const fnIds = new WeakMap(); let fnN = 0;
const fnId = (f) => { let i = fnIds.get(f); if (i === undefined) fnIds.set(f, (i = ++fnN)); return i; };
const SKIP_PROPS = new Set(['uuid', 'id', 'name', 'version', 'userData', 'needsUpdate', 'object3d']);
const primSig = (o, skipValue, fnBySource, skipFn, skipKeys) => { let s = ''; for (const k of Object.keys(o)) { if (k[0] === '_' || SKIP_PROPS.has(k) || skipKeys?.has(k) || (skipValue && k === 'value')) continue; const v = o[k]; const t = typeof v; if (t === 'boolean' || t === 'string') s += `${k}=${v};`; else if (t === 'number') s += `${k}=${v};`; else if (t === 'function') { if (!skipFn) s += fnBySource ? `${k}=${strHash(Function.prototype.toString.call(v))};` : `${k}=f${fnId(v)};`; } else if (v === null) s += `${k}=null;`; } return s; };
// r10-6: key = structure of the builder's OWN post-setup graph (builder.nodes after the setup stage: material-owned nodes + everything setup() created,
// custom subclasses + setup-created uniforms included). Slot nodes (uniform/texture/buffer/attribute) contribute type only, never value/uuid.
// pre = pre-build parts (material flags, slot textures, geometry attribute layout, light signature) -- not reachable from the node graph.
function preParts(THREE, material, { object = null, geometry = null, scene = null } = {}) {
const parts = [];
for (const k of Object.keys(material).sort()) { const v = material[k]; if (v && v.isTexture) parts.push(`S:${k}:${v.constructor?.name}:${v.format}:${v.type}:${v.colorSpace}:${+!!v.isDepthTexture}:${+!!v.isArrayTexture}:${+!!v.isCubeTexture}:${v.image?.depth ?? ''}`); }
parts.push(`M:${material.type}:${material.constructor?.name}:${primSig(material, false, true, false, customKeys(THREE, material)).replace(/(opacity|roughness|metalness|ior|thickness|clearcoat\w*|sheen\w*|iridescence\w*|emissiveIntensity|envMapIntensity|reflectivity|specularIntensity|dispersion|anisotropy\w*|attenuationDistance|lightMapIntensity|aoMapIntensity|bumpScale|displacementScale|displacementBias|shininess|linewidth|size|dashSize|gapSize|scale|polygonOffsetFactor|polygonOffsetUnits|alphaTest|blendAlpha|stencilRef|depthFunc)=[^;]*;/g, (m, k2) => (k2 === 'alphaTest' ? `alphaTest=${material.alphaTest > 0 ? 1 : 0};` : ''))}`);
const g = object?.geometry ?? geometry; const o = object;
parts.push(`O:${o ? (o.isInstancedMesh ? 'I' : '') + (o.isSkinnedMesh ? 'S' : '') + (o.isBatchedMesh ? 'B' : '') + (o.isPoints ? 'P' : '') + (o.isLine ? 'L' : '') + (o.isSprite ? 'Q' : '') : ''}`);
if (g?.attributes) for (const n of Object.keys(g.attributes).sort()) { const a = g.attributes[n]; parts.push(`a:${n}:${a.itemSize}:${a.isInstancedBufferAttribute ? 1 : 0}${a.normalized ? 'n' : ''}`); }
parts.push(`ix:${g?.index ? 1 : 0}:mo:${g?.morphAttributes ? Object.keys(g.morphAttributes).length : 0}`);
const L = []; if (scene && leakGuards.exportLightMemo) { for (const x of observeLights(scene).live) L.push(x.type + (x.castShadow ? 's' : '')); } /* nt-exportcost: same lights, same traverse order (observeLights' isShadingLight == the filter below), but the scene is scanned once per sync */ else scene?.traverse?.((x) => { if (x.isLight && (x.isDirectionalLight || x.isPointLight || x.isAmbientLight || x.isHemisphereLight)) L.push(x.type + (x.castShadow ? 's' : '')); }); parts.push('L:' + L.join(','));
return parts;
}
// r10-6: a custom subclass's own numeric/string props are consumed by its setup*() -> their effect is already IN the post-setup graph (constants/slots); keying on the raw value would split every instance. Booleans (structure flags) stay.
const baseKeys = new WeakMap();
function customKeys(THREE, material) {
let C = material.constructor; if (THREE[C?.name] === C) return null;
let B = C; while (B && THREE[B.name] !== B) B = Object.getPrototypeOf(B); if (!B || B === Function.prototype) return null;
let base = baseKeys.get(B); if (!base) { try { base = new Set(Object.keys(new B())); } catch { base = new Set(); } baseKeys.set(B, base); }
const skip = new Set(); for (const k of Object.keys(material)) { const t = typeof material[k]; if (!base.has(k) && (t === 'number' || t === 'string')) skip.add(k); }
return skip;
}
const isSlot = (n) => n.isUniformNode || n.isTextureNode || n.isBufferAttributeNode || n.isStorageBufferNode || n.isBufferNode;
// walk the builder's post-setup graph: ordered unique nodes + key. Roots = builder.nodes (visit order is deterministic for equal structure).
// r10-9: FUSED walker -- one pass over each node's own props yields BOTH the primitive signature and the child list (was primSig loop + NodeUtils.getNodeChildren generator + spread per node: ~7M nodes / 25 s on Burnout).
// Byte-identical to builderWalkRef (test-proven): same part order, same ids, same key.
const fnHashes = new WeakMap();
function fnHash(f) { let h = fnHashes.get(f); if (h === undefined) fnHashes.set(f, (h = strHash(Function.prototype.toString.call(f)))); return h; }
function builderWalk(THREE, b, pre) {
const NU = THREE.NodeUtils; if (!NU?.getNodeChildren) return { refuse: 'no-NodeUtils.getNodeChildren' };
const parts = pre.slice(), nodes = [], ids = new Map(), Pf = structCache.keyProf, ObjProto = Object.prototype;
const visit = (n) => {
const seen = ids.get(n.uuid); if (seen !== undefined) { parts.push('#' + seen); return; }
ids.set(n.uuid, nodes.length); nodes.push(n);
const slot = isSlot(n);
let s = `(${n.constructor?.name}:${n.type ?? ''}:${n.nodeType ?? ''}:${n.updateType ?? ''}${n.updateBeforeType ?? ''}${n.updateAfterType ?? ''}:`;
if (n.isTextureNode) { const t = n.value; s += `T${t?.constructor?.name}:${t?.format}:${t?.type}:${t?.colorSpace}:${+!!t?.isDepthTexture}:${+!!t?.isArrayTexture}:${+!!t?.isCubeTexture}:${t?.image?.depth ?? ''}`; }
else if (n.isBufferAttributeNode || n.isStorageBufferNode || n.isBufferNode) { const a = n.value; s += `B${a?.constructor?.name}:${a?.itemSize}:${a?.array?.constructor?.name}:${a?.count ?? ''}`; }
const tp0 = Pf ? nowMs() : 0;
const leaf = n.isUniformNode; let kp = null, kk = null, ki = null; // pending children (property, index, node) -- flat arrays, no per-child objects
const names = Object.getOwnPropertyNames(n), en = typeof n === 'function' ? new Set(Object.keys(n)) : null; // function-valued nodes (FnNode): own non-enumerable length/name must not enter the signature (reference = Object.keys)
for (let i = 0; i < names.length; i++) {
const k = names[i]; if (k.charCodeAt(0) === 95) continue; // '_' private: neither signature nor child
const v = n[k], t = typeof v;
if (t === 'object') {
if (v === null) { if (!SKIP_PROPS.has(k) && !(slot && k === 'value')) s += `${k}=null;`; if (!leaf) continue; }
if (leaf || v === null) continue;
if (Array.isArray(v)) { for (let j = 0; j < v.length; j++) { const c = v[j]; if (c && c.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(c); (ki ??= []).push(j); } } }
else if (v.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(v); (ki ??= []).push(undefined); }
else if (Object.getPrototypeOf(v) === ObjProto) { for (const sp in v) { if (sp.charCodeAt(0) === 95) continue; const c = v[sp]; if (c && c.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(c); (ki ??= []).push(sp); }; } }
} else if (en && !en.has(k)) continue;
else if (t === 'boolean' || t === 'string' || t === 'number') { if (!SKIP_PROPS.has(k) && !(slot && k === 'value')) s += `${k}=${v};`; }
else if (t === 'function') { if (!slot && !SKIP_PROPS.has(k)) s += `${k}=${fnHash(v)};`; }
}
if (Pf) { Pf.prim += nowMs() - tp0; Pf.nodes++; }
parts.push(s);
if (!leaf) {
if (kp) for (let i = 0; i < kp.length; i++) { parts.push(`.${kp[i]}${ki[i] ?? ''}`); visit(kk[i]); }
const props = b.getNodeProperties(n); for (const k of Object.keys(props)) { const c = props[k]; if (c && c.isNode === true && c !== n) { parts.push(`~${k}`); visit(c); } }
}
parts.push(')');
};
for (const n of b.nodes) visit(n);
const tj0 = Pf ? nowMs() : 0; const key = structCache.hashKey ? hashParts(parts) : parts.join(''); if (Pf) { Pf.join += nowMs() - tj0; Pf.parts += parts.length; Pf.walks++; }
return { key, nodes, parts };
}
// nt-exportcost (structCache.hashKey / knob tslKeyHash): key = length + two independent 32-bit string hashes (FNV-1a, x33) streamed over the parts -> no ~1 MB join per export, no 1 MB Map key per template. 64-bit + length: collision odds ~2^-64 per template pair (tpl <= 64). Not valid with walkCheck (the reference walker joins).
function hashParts(parts) {
  let h1 = 2166136261, h2 = 5381, len = 0;
  for (let i = 0; i < parts.length; i++) { const p = parts[i]; const n = p.length; len += n; for (let j = 0; j < n; j++) { const c = p.charCodeAt(j); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; } }
  return `H${len}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}
// compact id of a template key for dedupe (hashKey on: the key already is one)
const keyId = (k) => (k.length <= 64 ? k : `${k.length}:${strHash(k)}`);
// reference walker (r10-8, NodeUtils.getNodeChildren + primSig): kept ONLY so tests prove the fused builderWalk emits byte-identical keys/node order.
export function builderWalkRef(THREE, b, pre) {
const NU = THREE.NodeUtils; if (!NU?.getNodeChildren) return { refuse: 'no-NodeUtils.getNodeChildren' };
const parts = pre.slice(), nodes = [], ids = new Map();
const visit = (n) => {
const seen = ids.get(n.uuid); if (seen !== undefined) { parts.push('#' + seen); return; }
ids.set(n.uuid, nodes.length); nodes.push(n);
const slot = isSlot(n);
let s = `(${n.constructor?.name}:${n.type ?? ''}:${n.nodeType ?? ''}:${n.updateType ?? ''}${n.updateBeforeType ?? ''}${n.updateAfterType ?? ''}:`;
if (n.isTextureNode) { const t = n.value; s += `T${t?.constructor?.name}:${t?.format}:${t?.type}:${t?.colorSpace}:${+!!t?.isDepthTexture}:${+!!t?.isArrayTexture}:${+!!t?.isCubeTexture}:${t?.image?.depth ?? ''}`; }
else if (n.isBufferAttributeNode || n.isStorageBufferNode || n.isBufferNode) { const a = n.value; s += `B${a?.constructor?.name}:${a?.itemSize}:${a?.array?.constructor?.name}:${a?.count ?? ''}`; }
s += primSig(n, slot, true, slot); // r10-8: function props keyed by SOURCE (not identity) -- Burnout: every material's ShaderNodeInternal.jsFunc is a fresh closure of the same source -> 1415 keys / 22 WGSL. What the closure captured is already in the post-setup graph (constants/slots); verify mode proves it.
parts.push(s);
if (!n.isUniformNode) {
for (const { property, index, childNode } of NU.getNodeChildren(n)) { parts.push(`.${property}${index ?? ''}`); visit(childNode); }
const props = b.getNodeProperties(n); for (const k of Object.keys(props)) { const c = props[k]; if (c && c.isNode === true && c !== n) { parts.push(`~${k}`); visit(c); } }
}
parts.push(')');
};
for (const n of b.nodes) visit(n);
const tj0 = structCache.keyProf ? nowMs() : 0; const key = parts.join(''); if (structCache.keyProf) { structCache.keyProf.join += nowMs() - tj0; structCache.keyProf.parts += parts.length; structCache.keyProf.walks++; } return { key, nodes, parts };
}
// builder subclass: build() = three r180 NodeBuilder.build with ONE addition -- after the setup stage, this._gate(builder) may throw to skip analyze+generate.
// The builder (and every builder-side Map: nodeData/uniforms/bindings) is dropped by the caller; node objects only carry what a full setup would have left.
const gatedCtors = new WeakMap();
function gatedCtor(THREE, Ctor) {
let G = gatedCtors.get(Ctor); if (G) return G;
G = class extends Ctor {
build() {
const { object, material, renderer } = this;
if (material !== null) { let nm = renderer.library.fromMaterial(material); if (nm === null) { console.error(`NodeMaterial: Material "${material.type}" is not compatible.`); nm = new THREE.NodeMaterial(); } nm.build(this); } else this.addFlow('compute', object);
for (const buildStage of THREE.defaultBuildStages) {
this.setBuildStage(buildStage);
if (this.context.vertex && this.context.vertex.isNode) this.flowNodeFromShaderStage('vertex', this.context.vertex);
for (const shaderStage of THREE.shaderStages) { this.setShaderStage(shaderStage); for (const node of this.flowNodes[shaderStage]) { if (buildStage === 'generate') this.flowNode(node); else node.build(this); } }
if (buildStage === 'setup' && this._gate) { this.setBuildStage(null); this.setShaderStage(null); this._gate(this); this.setBuildStage(buildStage); }
}
this.setBuildStage(null); this.setShaderStage(null);
this.buildCode(); this.buildUpdateNodes();
return this;
}
};
gatedCtors.set(Ctor, G); return G;
}
// ===== nt-tslrecipe (docs/NATIVE.md §tsl-recipe) =====
// Opt-in DECLARED identity: material.userData.gaiaTslRecipe = string the CREATOR guarantees fixes the node-graph STRUCTURE (the engine knows no game semantics). A material whose recipe + context (light set, shadow flags, preParts) has a PROVEN template skips builder+SETUP entirely:
// pre-setup walk of its OWN node slots (visit order deterministic) -> positional map template-walk-node -> this material's node -> existing rebind. Anything ambiguous = full path (never a guess).
// Lifecycle per recipe key rk: M0 full build registers {state:'learn'} (+ its pre-walk) · M1 full (singleton 'prove') · M2 full+rebind = PROOF (every node rebind maps by position must be a pre-walk node or a light-owned node; end-to-end compare of the pre-walk-mapped rebind vs the position-mapped rebind) -> 'ok' · M3.. fast path. Failed proof = 'bad' (full path forever, census recipeBad + reason).
const HOST_SEM = /^camera|^time$|^deltaTime$/; // host-supplied uniforms (buildPackage: semantic, key null - never in the package's live set): their per-build update nodes are benign to keep from the template
const lnOf = (sc) => (sc ? lightsCache.get(sc)?.node?.uuid ?? '' : '');
function recipeKeyOf(material, pre, opts, pw) { // pw.sig in the key: same recipe + different pre-walk structure (e.g. other texture format/colorSpace) = its own recipe entry (own template), never a mismatch
  const o = opts.object, recv = o ? o.receiveShadow : opts.receiveShadow, cast = o ? o.castShadow : opts.castShadow; // buildPackage: a real object carries its own shadow flags, a stand-in the source's
  let ls = ''; if (opts.scene) { try { ls = observeLights(opts.scene).all.map((l) => l.uuid).join(','); } catch { ls = '?'; } } // baked light set (LightsNode) - NOT in preParts (live light types only)
  return hashParts([material.userData.gaiaTslRecipe, `${recv ? 1 : 0}${cast ? 1 : 0}${opts.coreShadow === false ? 0 : 1}`, ls, pw.sig, ...pre]);
}
// pre-setup walk of the material's own enumerable Node props (sorted keys). Same per-node signature as builderWalk (class/type/update types/texture format+colorSpace/primitive props incl. CONST values, slot values excluded) + back-refs by first-visit index.
function preWalk(THREE, material) {
  const parts = [], nodes = [], ids = new Map(), ObjProto = Object.prototype;
  const visit = (n) => {
    const seen = ids.get(n.uuid); if (seen !== undefined) { parts.push('#' + seen); return; }
    ids.set(n.uuid, nodes.length); nodes.push(n);
    const slot = isSlot(n), leaf = n.isUniformNode === true;
    let s = `(${n.constructor?.name}:${n.type ?? ''}:${n.nodeType ?? ''}:${n.updateType ?? ''}${n.updateBeforeType ?? ''}${n.updateAfterType ?? ''}:`;
    if (n.isTextureNode) { const t = n.value; s += `T${t?.constructor?.name}:${t?.format}:${t?.type}:${t?.colorSpace}:${+!!t?.isDepthTexture}:${+!!t?.isArrayTexture}:${+!!t?.isCubeTexture}:${t?.image?.depth ?? ''}`; }
    else if (n.isBufferAttributeNode || n.isStorageBufferNode || n.isBufferNode) { const a = n.value; s += `B${a?.constructor?.name}:${a?.itemSize}:${a?.array?.constructor?.name}:${a?.count ?? ''}`; }
    else if (n.isConstNode && n.value && typeof n.value === 'object') s += `C${JSON.stringify(toPlain(n.value))};`; // object-valued constants (Vector/Color) are baked into the WGSL; the generic prop loop below skips non-plain objects
    let kp = null, kk = null, ki = null;
    const names = Object.getOwnPropertyNames(n), en = typeof n === 'function' ? new Set(Object.keys(n)) : null;
    for (let i = 0; i < names.length; i++) {
      const k = names[i]; if (k.charCodeAt(0) === 95) continue;
      const v = n[k], t = typeof v;
      if (t === 'object') {
        if (v === null) { if (!SKIP_PROPS.has(k) && !(slot && k === 'value')) s += `${k}=null;`; continue; }
        if (leaf) continue;
        if (Array.isArray(v)) { for (let j = 0; j < v.length; j++) { const c = v[j]; if (c && c.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(c); (ki ??= []).push(j); } } }
        else if (v.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(v); (ki ??= []).push(undefined); }
        else if (Object.getPrototypeOf(v) === ObjProto) { for (const sp in v) { if (sp.charCodeAt(0) === 95) continue; const c = v[sp]; if (c && c.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(c); (ki ??= []).push(sp); } } }
      } else if (en && !en.has(k)) continue;
      else if (t === 'boolean' || t === 'string' || t === 'number') { if (!SKIP_PROPS.has(k) && !(slot && k === 'value')) s += `${k}=${v};`; }
      else if (t === 'function') { if (!slot && !SKIP_PROPS.has(k)) s += `${k}=${fnHash(v)};`; }
    }
    parts.push(s);
    if (!leaf && kp) for (let i = 0; i < kp.length; i++) { parts.push(`.${kp[i]}${ki[i] ?? ''}`); visit(kk[i]); }
    parts.push(')');
  };
  for (const k of Object.keys(material).sort()) { const v = material[k]; if (v && v.isNode === true) { parts.push('@' + k); visit(v); } }
  return { sig: hashParts(parts), nodes };
}
const recipeIds = (pw) => pw.nodes.map((n) => ({ uuid: n.uuid, ctor: n.constructor, type: n.type ?? null }));
// template-walk uuid -> this material's pre-walk node, for every position whose uuid differs (rebind's `map`, built from the pre-walk instead of the post-setup walk)
function recipeMap(rec, pw) {
  const map = new Map();
  for (let j = 0; j < rec.ids.length; j++) { const a = rec.ids[j], b = pw.nodes[j]; if (a.uuid === b.uuid) continue; if (a.ctor !== b.constructor || a.type !== (b.type ?? null)) return null; map.set(a.uuid, b); }
  return map;
}
function registerRecipe(C, rk, pw, tplKey, opts) {
  const pos = new Map(); pw.nodes.forEach((n, j) => pos.set(n.uuid, j));
  C.recipes.delete(rk); C.recipes.set(rk, { key: tplKey, sig: pw.sig, ids: recipeIds(pw), pos, ln: lnOf(opts.scene), state: 'learn' });
  const cap = Math.max(64, C.maxTemplates * 2); while (C.recipes.size > cap) C.recipes.delete(C.recipes.keys().next().value);
}
// PROOF on the first position-mapped hit (M2): see lifecycle above. `A` = the position-mapped rebind of THIS material (reference), `B` = the pre-walk-mapped rebind -> comparePackages(B, A). Both are fresh packages, discarded (comparePackages runs live.update).
function learnRecipe(C, rec, tpl, w, pw, material, opts) {
  const bad = (m) => { rec.state = 'bad'; C.recipeBad++; why('recipeBad', `${material.name || material.type}: ${m}`); };
  try {
    if (pw.sig !== rec.sig || pw.nodes.length !== rec.ids.length) { C.recipeMismatch++; why('recipeMismatch', `learn: ${material.name || material.type} pre-walk differs from the recipe's first material`); return; } // not provable by this material - keep learning
    if (tpl.noRebind || !tpl.pkg || !tpl.texNode) return bad('template not rebindable');
    const T = tpl.pkg, idx = new Map(); for (let i = 0; i < tpl.nodes.length; i++) idx.set(tpl.nodes[i].uuid, i);
    const R = new Set(); // every node rebind() resolves through its position map
    for (const mp of [tpl.texNode, tpl.uniNode, tpl.attrNode, tpl.bufNode]) if (mp) for (const n of mp.values()) R.add(n.uuid);
    if (tpl.refOwner) for (const o of tpl.refOwner.values()) R.add(o.owner.uuid);
    for (const n of T.tpl.updateNodes) R.add(n.uuid); for (const n of T.tpl.updateBeforeNodes) R.add(n.uuid);
    for (const x of T.tpl.liveUniforms) if (x.node) R.add(x.node.uuid);
    const A = rebind(tpl, w, material, opts); // reference
    const lu = new Set(); // light-owned set of THIS build (AnalyticLightNode + its own uniforms): per-material LightsNode instances (material.setupLights) differ per build but follow the same light objects
    for (const n of A.tpl.updateNodes) if (n.light?.isLight) { lu.add(n.uuid); for (const v of Object.values(n)) if (v?.isUniformNode) lu.add(v.uuid); }
    for (const u of R) {
      const i = idx.get(u); if (i === undefined) continue; // not in the walk: rebind falls to the template's own node (shared / builder-side) exactly as the position-mapped hit does
      const b = w.nodes[i], j = rec.pos.get(u);
      if (j === undefined) { if (b.uuid !== u && !lu.has(b.uuid) && !(b.isUniformNode && HOST_SEM.test(b.name || ''))) return bad(`rebound node #${i} ${b.constructor?.name}:${b.type ?? ''}:${b.nodeType ?? ''}:${b.scope ?? ''}:${b.name ?? ''} (after ${w.nodes.slice(Math.max(0, i - 3), i).map((x) => x.constructor?.name + ':' + (x.scope ?? x.name ?? '')).join('>')}) differs per build but is not in the pre-walk (setup-created / closure-captured)`); continue; }
      if (pw.nodes[j].uuid !== b.uuid) return bad(`pre-walk #${j} != walk #${i} (${b.constructor?.name})`);
    }
    const map = recipeMap(rec, pw); if (!map) return bad('pre-walk class/type differs');
    const B = rebind(tpl, null, material, opts, map);
    const diff = comparePackages(B, A, tpl); if (diff) return bad('compare: ' + String(diff).slice(0, 240));
    rec.state = 'ok'; C.recipeLearned++;
  } catch (e) { bad('learn-error: ' + String(e?.message ?? e)); }
}
// fast path: returns the rebound package, or null (-> caller takes the full path). Never throws.
function recipeFast(C, rk, rec, pw, material, opts, mode) {
  const tpl = C.map.get(rec.key);
  if (!tpl) { C.recipes.delete(rk); return null; }
  if (tpl.noRebind || tpl.unproven?.size || tpl.unprovenBuf?.size || rec.ln !== lnOf(opts.scene)) return null;
  if (pw.sig !== rec.sig || pw.nodes.length !== rec.ids.length) { C.recipeMismatch++; why('recipeMismatch', `${material.name || material.type}: pre-walk differs (declared recipe lies, or an input the recipe omits)`); return null; }
  const map = recipeMap(rec, pw); if (!map) { C.recipeMismatch++; why('recipeMismatch', 'class/type'); return null; }
  const t0 = nowMs(); let rb = null;
  try { rb = rebind(tpl, null, material, opts, map); } catch (e) { C.rebindFail++; if (String(e?.message).startsWith('template node collected')) { C.map.delete(rec.key); C.recipes.delete(rk); } why('rebindFail', 'recipe: ' + String(e?.message ?? e)); }
  C.rebindMs += nowMs() - t0;
  if (!rb) return null;
  retainTemplate(C, rec.key, tpl); if (tpl.kh) Object.defineProperty(rb, 'kh', { value: tpl.kh });
  if (mode !== 'verify') { C.hits++; C.recipeHit++; return rb; }
  const full = buildPackage(material, opts); C.verified++; C.recipeVerified++; // verify: the recipe hit is checked against a FULL build of the same material
  const diff = comparePackages(rb, full, tpl);
  if (diff) { C.recipeMismatch++; if (diff.startsWith('WGSL')) C.mismatch++; else if (diff.startsWith('VALUE')) C.valueMismatch++; else C.layoutMismatch++; rec.state = 'bad'; why('MISMATCH', `recipe ${material.name || material.type}: ${diff}`); return full; }
  C.hits++; C.recipeHit++; return full;
}
const HIT = Symbol('tslCacheHit');
export function exportNodeMaterial(material, opts = {}) {
if (!material?.isNodeMaterial) throw new Error('exportNodeMaterial: material.isNodeMaterial required');
const mode = opts.cache ?? 'on';
if (mode === 'off') return buildPackage(material, opts);
const THREE = opts.THREE, C = structCache; let t0 = nowMs(), w = null, hit = null, decision = 'miss';
let pre; try { pre = preParts(THREE, material, opts); } catch (e) { pre = null; w = { refuse: 'walk-error:' + (e?.message ?? e) }; }
C.preMs += nowMs() - t0; let tb0 = 0, tGE = 0;
// nt-tslrecipe: declared-recipe fast path (no builder, no SETUP) -- see recipeFast/learnRecipe. rk = recipe + context; pw = this material's pre-setup walk (taken BEFORE the build; the full build below registers/proves from it)
let rk = null, rec = null, pw = null;
if (C.recipe && pre && typeof material.userData?.gaiaTslRecipe === 'string' && material.userData.gaiaTslRecipe) {
  const tr = nowMs();
  try { pw = preWalk(THREE, material); rk = recipeKeyOf(material, pre, opts, pw); rec = C.recipes.get(rk) ?? null; } catch (e) { rk = null; rec = null; pw = null; why('recipeError', String(e?.message ?? e)); }
  if (pw && rec?.state === 'ok') { const fr = recipeFast(C, rk, rec, pw, material, opts, mode); if (fr) { C.recipeMs += nowMs() - tr; return fr; } }
  C.recipeMs += nowMs() - tr; if (rk) C.recipeMiss++;
} // nt-exportcost phase timing: tb0 = buildPackage start, tGE = gate exit
const gate = (b) => { C.setupMs += nowMs() - tb0; try { gate1(b); } finally { tGE = nowMs(); } };
const gate1 = (b) => {
if (!pre) return; const t1 = nowMs();
try { w = builderWalk(THREE, b, pre); } catch (e) { w = { refuse: 'walk-error:' + (e?.message ?? e) }; }
C.keyMs += nowMs() - t1; if (w.nodes) { C.nodesWalked += w.nodes.length; C.nodeWalks++; if (w.nodes.length > C.nodesMax) C.nodesMax = w.nodes.length; }
if (C.walkCheck && !w.refuse) { const t2 = nowMs(); const r = builderWalkRef(THREE, b, pre); C.refKeyMs += nowMs() - t2; C.walkChecked++; if (r.key !== w.key || r.nodes.length !== w.nodes.length || r.nodes.some((x, i) => x !== w.nodes[i])) { C.walkMismatch++; let d = 0; while (d < r.parts.length && r.parts[d] === w.parts[d]) d++; why('WALKMISMATCH', `${material.name || material.type} @${d}: ref ${r.parts[d]?.slice(0, 160)} <> fused ${w.parts[d]?.slice(0, 160)}`); } } // fused walker == reference walker (tests / ?wgpuTslWalkCheck=1)
if (w.refuse) return;
const tl0 = nowMs(); const tpl = C.map.get(w.key); if (!tpl || tpl.nodes.length !== w.nodes.length || tpl.noRebind) { C.lookMs += nowMs() - tl0; return; }
if (tpl.unproven?.size || tpl.unprovenBuf?.size) { decision = 'prove'; hit = tpl; C.lookMs += nowMs() - tl0; return; }
hit = tpl; retainTemplate(C, w.key, tpl); C.lookMs += nowMs() - tl0; throw HIT;
};
let pkg = null; tb0 = nowMs();
try { pkg = buildPackage(material, opts, gate); } catch (e) { if (e !== HIT) throw e; }
if (pkg && tGE) C.genMs += nowMs() - tGE;
if (!pkg) { // setup-stage hit: analyze+generate skipped
const tpl = hit; t0 = nowMs(); let rb = null;
try { rb = rebind(tpl, w, material, opts); } catch (e) { C.rebindFail++; if (String(e?.message).startsWith('template node collected')) C.map.delete(w.key); /* nt-tslbudget lean: a shared node the template needed was collected -> drop the template, the next full build re-registers it */ why('rebindFail', String(e?.message ?? e)); }
C.rebindMs += nowMs() - t0;
if (rb) {
if (rec?.state === 'learn' && pw && rec.key === w.key) learnRecipe(C, rec, tpl, w, pw, material, opts); // nt-tslrecipe: PROOF on the first position-mapped hit
if (mode !== 'verify') { C.hits++; if (tpl.kh) Object.defineProperty(rb, 'kh', { value: tpl.kh }); return rb; } // nt-exportcost: kh = template id (dedupe key part)
const full = buildPackage(material, opts); C.verified++;
const diff = comparePackages(rb, full, tpl);
if (diff) { if (diff.startsWith('WGSL')) C.mismatch++; else if (diff.startsWith('VALUE')) C.valueMismatch++; else C.layoutMismatch++; why('MISMATCH', `${material.name || material.type}: ${diff}`); return full; }
C.hits++; return full;
}
t0 = nowMs(); pkg = buildPackage(material, opts); C.buildMs += nowMs() - t0; C.misses++; return pkg;
}
if (w?.refuse) { C.uncacheable++; why('uncacheable:' + w.refuse.split(':')[0], w.refuse); return pkg; }
C.misses++;
if (!w) return pkg;
if (C.keySamples) { const h = strHash(pkg.vertex + pkg.fragment); if (C.bound > 0 && C.keySamples.size >= C.bound && !C.keySamples.has(h)) C.keySamples.delete(C.keySamples.keys().next().value); const e = C.keySamples.get(h) ?? { n: 0, s: [] }; C.keySamples.set(h, e); e.n++; if (e.s.length < 8) e.s.push({ name: material.name || material.type, parts: w.parts }); } // diagnostic (?wgpuTslKeyDump=1): per-WGSL-hash key parts, for diffing over-split terms
if (decision === 'prove') { const tpl = hit; const have = new Set(pkg.tpl.liveUniforms.map((x) => x.node?.uuid)); for (const [bk, a0] of [...(tpl.unprovenBuf ?? [])]) { if (pkg.bufferSources[bk] === a0) tpl.unprovenBuf.delete(bk); else { tpl.noRebind = true; why('noRebind:buffer-differs-per-material', bk); } }
for (const u of [...(tpl.unproven ?? [])]) { if (have.has(u)) { if (C.bound > 0 && SHARED_OK.size >= C.bound) SHARED_OK.delete(SHARED_OK.values().next().value); SHARED_OK.add(u); tpl.unproven.delete(u); } else { tpl.noRebind = true; why('noRebind:singleton-not-shared', u); } }
if (rec?.state === 'learn' && pw && rec.key === w.key && !tpl.noRebind && !tpl.unproven?.size && !tpl.unprovenBuf?.size) learnRecipe(C, rec, tpl, w, pw, material, opts); /* nt-tslrecipe: the prove build already has template + walk + pre-walk -> proof here saves one full build per recipe */ return pkg; }
if (mode === 'verify') { const k = pkg.vertex.length + ':' + pkg.fragment.length + ':' + strHash(pkg.vertex + pkg.fragment); const prev = C.wgslOf.get(w.key); if (prev && prev !== k) { C.mismatch++; why('MISMATCH', `struct key -> 2 WGSL (${material.name})`); } if (C.bound > 0 && C.wgslOf.size >= C.bound && !C.wgslOf.has(w.key)) C.wgslOf.delete(C.wgslOf.keys().next().value); C.wgslOf.set(w.key, k); }
if (!C.map.has(w.key)) { const t = { nodes: w.nodes, pkg, kh: keyId(w.key) }; const bad = templateBinds(t, material); if (bad) { t.noRebind = true; why('noRebind:' + bad.split(':')[0], bad); } if (C.lean) slimTemplate(t, !!bad); retainTemplate(C, w.key, t); if (rk && pw && !t.noRebind && !(rec && rec.state !== 'learn' && C.map.has(rec.key))) registerRecipe(C, rk, pw, w.key, opts); /* nt-tslrecipe: this build created the template -> its pre-walk is the recipe's reference (M0) */ }
{ const tt = C.map.get(w.key); if (tt?.kh && !tt.noRebind) Object.defineProperty(pkg, 'kh', { value: tt.kh }); }
return pkg;
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
// template validation + slot index: every non-shared binding must resolve to a walked node (else rebind would alias M0's data into M1 = wrong pixels).
function templateBinds(t, material) {
const { pkg, nodes } = t;
t.slotOf = new Map(); for (const k of Object.keys(material)) if (material[k]?.isTexture) t.slotOf.set(material[k].uuid, k);
const idx = new Map(nodes.map((n, i) => [n.uuid, i])), fast = structCache.bindIdx; // nt-exportcost bindIdx: Map lookups instead of nodes.some()/find()/scan per update node (O(updates x nodes))
const inNodes = fast ? (u) => idx.has(u) : (u) => nodes.some((x) => x.uuid === u);
t.slotMatrix = new Map(); t.slotTexNodes = new Set(); for (const n of pkg.tpl.updateNodes) if (n.isTextureNode && n.value?.uuid && t.slotOf.has(n.value.uuid) && !inNodes(n.uuid)) { t.slotTexNodes.add(n.uuid); if (n._matrixUniform) t.slotMatrix.set(n._matrixUniform.uuid, t.slotOf.get(n.value.uuid)); }
let owners = null; const lightKeys = new Set(); for (const n of pkg.tpl.updateNodes) if (n.light?.isLight) for (const v of Object.values(n)) if (v?.isUniformNode) lightKeys.add(v.uuid);
t.texNode = new Map(); for (const n of nodes) if (n.isTextureNode && n.value?.uuid) t.texNode.set(n.value.uuid, n);
t.bufNode = new Map(); for (const n of nodes) if (n.value?.isBufferAttribute) t.bufNode.set(n.value, n);
t.uniNode = new Map(); for (const { key, node } of pkg.tpl.liveUniforms) if (node) t.uniNode.set(key, node);
for (const g of pkg.bindGroups) for (const b of g.bindings) {
if (b.textureUuid && !t.texNode.has(b.textureUuid) && !t.slotOf.has(b.textureUuid)) return `texture-unmapped:${b.name}`;
if (b.kind === 'storage-buffer') { const a = pkg.bufferSources[`${g.group}.${b.binding}`]; if (!t.bufNode.has(a)) (t.unprovenBuf ??= new Map()).set(`${g.group}.${b.binding}`, a); /* builder-side buffer: shared iff a 2nd build binds the SAME BufferAttribute object (proven below) */ }
}
t.attrNode = new Map(); for (const k of Object.keys(pkg.attributeSources)) { const n = fast ? (idx.has(k.slice(5)) ? nodes[idx.get(k.slice(5))] : undefined) : nodes.find((x) => `node:${x.uuid}` === k); if (!n) return `node-attribute-unmapped:${k}`; t.attrNode.set(k, n); }
for (const { key, node } of pkg.tpl.liveUniforms) if (node && !idx.has(node.uuid) && !t.slotMatrix.has(node.uuid) && !lightKeys.has(node.uuid) && !SHARED_OK.has(node.uuid)) { let ref = null, prop = null; if (fast) { owners ??= ownerIndex(nodes); const o = owners.get(node.uuid); if (o) { ref = o.n; prop = o.p; } } else for (const n of nodes) { for (const p of ['node', '_matrixUniform']) if (n[p]?.uuid === node.uuid) { ref = n; prop = p; break; } if (ref) break; } if (ref) { t.refOwner ??= new Map(); t.refOwner.set(node.uuid, { owner: ref, prop }); } else if (pkg.tpl.updateNodes.some((n) => n.node?.uuid === node.uuid && !idx.has(n.uuid))) (t.unproven ??= new Set()).add(node.uuid); /* builder-side singleton (materialOpacity & co): shared iff a 2nd build resolves the same uuid -> proven below */ else return `uniform-unmapped:${key}`; }
return null;
}
// uuid of a node's `node` / `_matrixUniform` child -> first (node, prop) in walk order (identical to the nested scan it replaces)
function ownerIndex(nodes) { const m = new Map(); for (const n of nodes) for (const p of ['node', '_matrixUniform']) { const u = n[p]?.uuid; if (u && !m.has(u)) m.set(u, { n, p }); } return m; }
// ---- nt-tslbudget: retention helpers ----
// Closure-context hygiene: these arrows are created at MODULE level so a surviving package getter keeps only its 1-2 captured values alive (an arrow created inside rebind()/buildPackage() chained rebind's context: `t` (template: whole M0 node graph + package), `map`, `m` ... -> a rebound package pinned its template, so FIFO eviction freed nothing).
const uGet = (u) => () => u.getValue?.();
const nGet = (n) => () => n.value;
const matGet = (material, sl) => () => material[sl]?.matrix;
const slotPre = (material, sl) => () => { const x = material[sl]; if (x?.matrixAutoUpdate) x.updateMatrix(); };
// Template node stubs: rebind only needs a node's uuid/constructor/type (map new->old by position) + the node itself for the SHARED case (same uuid in both builds = a global singleton, alive anyway). Per-material nodes (M0's graph: textures, ReferenceNode.reference = material, geometry attributes) are held WEAKLY.
const real = (n) => { if (n.__wk === undefined) return n; const x = n.__wk.deref(); if (x === undefined) { structCache.collected++; throw new Error('template node collected'); } return x; };
const ctorOf = (a) => (a.__wk === undefined ? a.constructor : a.ctor);
const sameNode = (n1, n0) => n1 === n0 || (n0.__wk !== undefined && n1 === n0.__wk.deref());
function slimTemplate(t, noRebind) {
if (typeof WeakRef !== 'function') return;
const n0 = t.nodes.length; structCache.slimmed++;
if (noRebind) { t.nodes = { length: n0 }; t.pkg = null; t.texNode = t.bufNode = t.uniNode = t.attrNode = t.refOwner = null; return; } // never rebinds: the graph is only a length check
const sw = new Map(), st = (n) => { if (!n || n.__wk !== undefined) return n; let x = sw.get(n); if (!x) sw.set(n, (x = { uuid: n.uuid, ctor: n.constructor, type: n.type ?? null, __wk: new WeakRef(n) })); return x; };
t.nodes = t.nodes.map(st);
for (const mp of [t.texNode, t.uniNode, t.attrNode, t.bufNode]) if (mp) for (const [k, n] of mp) mp.set(k, st(n));
if (t.refOwner) for (const [k, o] of t.refOwner) t.refOwner.set(k, { owner: st(o.owner), prop: o.prop });
const P = t.pkg, tp = P.tpl; // keep ONLY what rebind reads: WGSL + layout data + storage-buffer map + update/uniform node lists. Dropped: live closure (-> real mesh/scene/camera/material/renderer/NodeFrame), textureSources, attributeSources, material meta
t.pkg = { vertex: P.vertex, fragment: P.fragment, bindGroups: P.bindGroups, attributes: P.attributes, varyings: P.varyings, bufferSources: P.bufferSources, tpl: { updateNodes: tp.updateNodes.map(st), updateBeforeNodes: tp.updateBeforeNodes.map(st), liveUniforms: tp.liveUniforms.map((x) => (x.node ? { key: x.key, node: st(x.node), get: null } : { key: x.key, node: x.node, get: x.get })) } };
}
const SHARED_OK = new Set(); // reserved: process-wide singleton uniform nodes proven shared
function rebind(t, w, material, opts, mapIn = null) {
const { THREE } = opts, T = t.pkg, map = mapIn ?? new Map(); // nt-tslrecipe: mapIn = map built from the pre-setup walk (no post-setup walk exists)
if (!mapIn) for (let i = 0; i < t.nodes.length; i++) { const a = t.nodes[i], b = w.nodes[i]; if (a.uuid !== b.uuid) { if (ctorOf(a) !== b.constructor || (a.type ?? null) !== (b.type ?? null)) throw new Error('slot type mismatch at ' + i); map.set(a.uuid, b); } }
const m = (n) => { const x = map.get(n.uuid); if (x) return x; const o = t.refOwner?.get(n.uuid); if (o) { const ox = map.get(o.owner.uuid); if (ox) { if (ox[o.prop] == null) { if (o.prop === '_matrixUniform' && ox.isTextureNode && ox.value?.matrix) ox._matrixUniform = (THREE.TSL ?? THREE).uniform(ox.value.matrix); else throw new Error('owned node not materialised: ' + o.prop); } return ox[o.prop]; } } return real(n); };
const r = opts.renderer ?? headlessRenderer(THREE);
const obj = opts.object ?? new THREE.Mesh(opts.geometry ?? new THREE.BoxGeometry(1, 1, 1), material);
obj.updateMatrixWorld?.();
const cam = opts.camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000), sc = opts.scene ?? new THREE.Scene();
const textureSources = {}, bufferSources = {};
const texUuid = (u) => { let tx; if (t.texNode.has(u)) { const n = t.texNode.get(u), n1 = map.get(n.uuid) ?? real(n); tx = n1.value; } else tx = material[t.slotOf.get(u)]; if (!tx?.isTexture) throw new Error('slot texture missing: ' + t.slotOf.get(u)); textureSources[tx.uuid] = tx; return tx.uuid; };
const groups = T.bindGroups.map((g) => ({ group: g.group, name: g.name, bindings: g.bindings.map((b) => {
const o = { ...b };
if (b.uniforms) o.uniforms = b.uniforms.map((u) => {
const n0 = t.uniNode.get(u.key); if (n0 && t.slotMatrix.has(n0.uuid)) return { ...u, value: toPlain(material[t.slotMatrix.get(n0.uuid)]?.matrix) };
const n1 = n0 && m(n0);
if (!n0 || sameNode(n1, n0)) return { ...u };
const src = u.source?.kind === 'uniform' ? { ...u.source, uuid: n1.uuid, name: n1.name || null } : u.source;
const ro = t.refOwner?.get(n0.uuid); const own = ro?.prop === '_matrixUniform' ? (map.get(ro.owner.uuid) ?? real(ro.owner)) : null; // texture-matrix uniform: ship the NEW texture's matrix (its node holds the pre-update value)
return { ...u, key: n1.uuid, source: src, value: toPlain(own?.value?.matrix ?? n1.value) };
});
else if (b.textureUuid) o.textureUuid = texUuid(b.textureUuid);
else if (b.kind === 'storage-buffer') { const a0 = T.bufferSources[`${g.group}.${b.binding}`]; const n0b = t.bufNode.get(a0); bufferSources[`${g.group}.${b.binding}`] = n0b ? (map.get(n0b.uuid) ?? real(n0b)).value : a0; }
return o;
}) }));
const attributeSources = {}, attrKey = new Map(); for (const [k, n0] of t.attrNode) { const n1 = map.get(n0.uuid) ?? real(n0); attrKey.set(k, `node:${n1.uuid}`); attributeSources[`node:${n1.uuid}`] = n1.attribute; }
const pkg = { vertex: T.vertex, fragment: T.fragment, bindGroups: groups, attributes: T.attributes.map((a) => (attrKey.has(a.key) ? { ...a, key: attrKey.get(a.key) } : a)), varyings: T.varyings, vertexEntry: 'main', fragmentEntry: 'main',
material: { name: material.name, type: material.type, transparent: !!material.transparent, side: material.side, depthWrite: material.depthWrite, depthTest: material.depthTest, colorWrite: material.colorWrite, blending: material.blending } };
Object.defineProperty(pkg, 'textureSources', { value: textureSources, enumerable: false });
Object.defineProperty(pkg, 'bufferSources', { value: bufferSources, enumerable: false });
Object.defineProperty(pkg, 'attributeSources', { value: attributeSources, enumerable: false });
const live = T.tpl.liveUniforms.map(({ key, node, get }) => { if (node && t.slotMatrix.has(node.uuid)) { const sl = t.slotMatrix.get(node.uuid); return { key, get: structCache.lean ? matGet(material, sl) : () => material[sl]?.matrix }; } const n1 = node && m(node); return !node || sameNode(n1, node) ? { key, get: get ?? nGet(real(node)) } : { key: n1.uuid, get: structCache.lean ? nGet(n1) : () => n1.value }; });
const upd = T.tpl.updateNodes.filter((n) => !t.slotTexNodes.has(n.uuid)).map(m), updB = T.tpl.updateBeforeNodes.map(m);
const pre = [...new Set(t.slotMatrix.values())].map((sl) => (structCache.lean ? slotPre(material, sl) : () => { const x = material[sl]; if (x?.matrixAutoUpdate) x.updateMatrix(); }));
const initial = new Map(); for (const g of groups) for (const b of g.bindings) for (const u of b.uniforms ?? []) if (u.key) initial.set(u.key, u.value);
defineLive(pkg, { THREE, r, material, obj, cam, sc, updateNodes: upd, updateBeforeNodes: updB, live, initial, pre });
Object.defineProperty(pkg, 'tpl', { enumerable: false, value: { updateNodes: upd, updateBeforeNodes: updB, liveUniforms: live } });
return pkg;
}
// rebound vs fully built: identical WGSL + identical JSON except material meta; same texture/buffer sources; same uniform key sets. null = equal.
function comparePackages(a, b, tpl) {
if (a.vertex !== b.vertex || a.fragment !== b.fragment) return 'WGSL differs (struct key collision)';
const ja = JSON.parse(JSON.stringify(a)), jb = JSON.parse(JSON.stringify(b)); delete ja.material.name; delete jb.material.name;
for (const j of [ja, jb]) for (const g of j.bindGroups) for (const b of g.bindings) for (const u of b.uniforms ?? []) if (true) u.value = null; // r10-8: LAYOUT compare only (keys/names/types/offsets/sources) -- uniform VALUES are rebind's job, checked below against the material's own after the first live.update // builder-singleton reference uniforms hold the PREVIOUS material's value at ship time; live.update's first call corrects it (initial-map logic)
// node uuids are per-build identities (setup-created nodes differ between two independent setups): compare by first-appearance order
const canon = (j) => { const ids = new Map(); return JSON.stringify(j).replace(/(StorageBuffer|Uniform|Texture|Sampler)_\d+/g, '$1_N' /* builder-global counter in binding labels: per-build identity, not layout (WGSL equal => not referenced) */).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => { if (!ids.has(u)) ids.set(u, 'U' + ids.size); return ids.get(u); }); };
const sa = canon(ja), sb = canon(jb);
if (sa !== sb) { let i = 0; while (sa[i] === sb[i]) i++; return `JSON differs @${i}: rebound ${sa.slice(Math.max(0, i - 60), i + 80)} <> built ${sb.slice(Math.max(0, i - 60), i + 80)}`; }
for (const k of ['textureSources', 'bufferSources']) { const ka = Object.keys(a[k]), kb = Object.keys(b[k]); if (ka.join() !== kb.join()) return `${k} keys differ`; for (const x of ka) if (a[k][x] !== b[k][x]) return `${k}[${x}] object differs`; }
if (a.live.keys.length !== b.live.keys.length || canon(a.live.keys) !== canon(b.live.keys)) return 'LAYOUT live keys differ';
// values: after the first live.update the rebound package must carry the SAME effective uniform values as the full build of the same material (position-ordered; uuids differ per build)
const eff = (p) => { const m = new Map(); for (const g of p.bindGroups) for (const x of g.bindings) for (const u of x.uniforms ?? []) m.set(u.key, u.value); for (const c of p.live.update()) m.set(c.key, c.value); const o = []; for (const g of p.bindGroups) for (const x of g.bindings) for (const u of x.uniforms ?? []) o.push(u.key == null ? undefined : m.get(u.key)); return o; }; // r10-9: host-semantic uniforms (key null: camera*/time) are supplied by the HOST backend per frame, never by the package -> their shipped value is build-time noise (the singleton's last-updated state), not compared; (was: m.set(null,..) collapsed them all into one phantom -> 1330 false VALUE mismatches)
const ea = eff(a), eb = eff(b); const sj = (x) => JSON.stringify(x); if (sj(ea) !== sj(eb)) { let i = 0; while (i < ea.length && sj(ea[i]) === sj(eb[i])) i++; const ids = []; for (const g of b.bindGroups) for (const x of g.bindings) for (const u of x.uniforms ?? []) ids.push(`${x.name}.${u.name ?? u.key}(${u.source?.kind}${u.source?.name ? ':' + u.source.name : ''})`); return `VALUE differs after first update @uniform ${i} ${ids[i]}: rebound ${sj(ea[i])?.slice(0, 120)} <> built ${sj(eb[i])?.slice(0, 120)}`; }
return null;
}

// light.shadow.shadowNode hook (AnalyticLightNode.setupShadow): swap the sun's shadow node for the core-CSM sampler for the duration of one build.
let warnedNoWgslFn = false;
function installCoreShadow(THREE, lights, r) {
  const sun = lights.find((l) => l.isDirectionalLight && l.castShadow && l.shadow);
  const T = THREE.TSL ?? THREE;
  if (!sun) return () => {};
  if (!T.wgslFn || !T.positionWorld || !T.normalWorld || !T.cameraPosition) { if (!warnedNoWgslFn) { warnedNoWgslFn = true; console.warn('[tsl-export] core sun shadow NOT exported: this three build lacks wgslFn/positionWorld/normalWorld/cameraPosition'); } return () => {}; }
  const toLight = new THREE.Vector3();
  const dirOf = (v) => v.copy(sun.position).sub(sun.target?.position ?? toLight.set(0, 0, 0)).normalize();
  const sunDir = T.uniform(dirOf(new THREE.Vector3())).setName('gaiaSunDir').onRenderUpdate((f, self) => dirOf(self.value));
  const call = T.wgslFn('fn gaia_sun_shadow(world: vec3<f32>, cam: vec3<f32>, n: vec3<f32>, nl: f32) -> f32 { return gaia_sun_shadow_core(world, cam, n, nl); }');
  const node = call({ world: T.positionWorld, cam: T.cameraPosition, n: T.normalWorld, nl: T.max(T.dot(T.normalWorld, sunDir), 0.0) });
  const prev = sun.shadow.shadowNode, prevEnabled = r.shadowMap.enabled;
  sun.shadow.shadowNode = node; r.shadowMap.enabled = true;
  return () => { if (prev === undefined) delete sun.shadow.shadowNode; else sun.shadow.shadowNode = prev; r.shadowMap.enabled = prevEnabled; };
}
