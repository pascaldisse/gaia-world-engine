// render-api/tsl-export.js — three TSL NodeMaterial → WGSL package, HEADLESS (no GPU, no canvas, node/bun).
// Runs three r180's own WGSLNodeBuilder against a stub renderer/backend and returns a data-only package
//   { vertex, fragment, bindGroups[{group,name,shared,bindings[{binding,name,kind,type,stage,size,value?,textureKey?}]}],
//     attributes[{name,type,location}], varyings[{name,type}], vertexEntry:'main', fragmentEntry:'main' }
// that a non-three backend feeds to create_shader_material (RENDER-API.md §6). No three import here: the caller
// passes the (possibly engine-injected) THREE namespace (`three/webgpu`) → works for the ctx.three case too.
const STAGES = { 1: 'vertex', 2: 'fragment', 4: 'compute' };
const stageOf = (v) => STAGES[v] ?? ([v & 1 ? 'vertex' : null, v & 2 ? 'fragment' : null].filter(Boolean).join('|') || 'none');

const kindOf = (b) => (b.isUniformsGroup ? 'uniform-buffer' : b.isSampledTexture ? (b.isSampledCubeTexture ? 'texture-cube' : b.isSampledTexture3D ? 'texture-3d' : b.isStorageTexture ? 'storage-texture' : (b.texture?.isArrayTexture || b.texture?.isDataArrayTexture || b.texture?.isCompressedArrayTexture) ? 'texture-2d-array' : 'texture-2d') : b.isSampler ? 'sampler' : b.isStorageBuffer ? 'storage-buffer' : 'unknown');

// builder → data package. `THREE` = three/webgpu namespace; `WGSLNodeBuilder` is not exported publicly, so we reach it
// through three's own backend factory (WebGPUBackend.prototype.createNodeBuilder) without constructing a device.
function buildPackage(material, { THREE, object = null, geometry = null, camera = null, scene = null, wgslBuilderCtor = null, renderer = null } = {}, gate = null) {
const Ctor0 = wgslBuilderCtor ?? headlessRenderer(THREE)._ctor;
const Ctor = gate ? gatedCtor(THREE, Ctor0) : Ctor0;
const r = renderer ?? headlessRenderer(THREE);
// `object` = the real mesh (its geometry attributes decide which TSL attribute() nodes resolve); `geometry` = same without the object (InstancedMesh/Skinned: instancing is expanded by the adapter, never exported).
const obj = object ?? new THREE.Mesh(geometry ?? new THREE.BoxGeometry(1, 1, 1), material);
obj.updateMatrixWorld?.();
const cam = camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
const sc = scene ?? new THREE.Scene();
const b = new Ctor(obj, r);
if (gate) b._gate = gate;
b.scene = sc; b.material = material; b.camera = cam; b.context.material = material;
// (b) real lights: three's own LightsNode over the scene's Directional/Point lights (shadows not exported) → lit node materials shade.
// Light uniform VALUES come from three's light nodes per frame (live.update) — same objects the adapter maps to setSun/addPointLight.
const lights = []; sc.traverse?.((o) => { if (o.isLight && (o.isDirectionalLight || o.isPointLight || o.isAmbientLight || o.isHemisphereLight)) lights.push(o); });
b.lightsNode = lights.length ? sharedLightsNode(r, sc, lights) : null; b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
b.build();
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
  if (key) liveUniforms.push({ key, u, node, get: () => u.getValue?.() });
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
material: { name: material.name, type: material.type, transparent: !!material.transparent, side: material.side, depthWrite: material.depthWrite },
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
if (s.token !== token) { s.token = token; s.frame.update(); s.frame.renderId++; s.done.clear(); structCache.frames++; }
if (time != null) s.frame.time = time;
return s;
}
const lightsCache = new WeakMap(); // scene -> { sig, node }
function sharedLightsNode(r, sc, lights) {
if (!structCache.share) return r.lighting.createNode(lights);
const sig = lights.map((l) => l.uuid).join(',');
const c = lightsCache.get(sc);
if (c && c.sig === sig && c.r === r) { structCache.lightsReused++; return c.node; }
const node = r.lighting.createNode(lights); lightsCache.set(sc, { sig, node, r }); structCache.lightsBuilt++; return node;
}
// (a) live values, NON-enumerable: runs three's OWN node updates (NodeFrame over updateNodes - reference(), uniform
// onFrame/onRender/onObjectUpdate, light nodes) and returns only uniforms whose packed value changed since the last call.
function defineLive(pkg, { THREE, r, material, obj, cam, sc, updateNodes, updateBeforeNodes, live: liveUniforms, initial = null, pre = [] }) {
const own = new (THREE.NodeFrame ?? THREE.TSL?.NodeFrame)(); own.renderer = r; const NUT = THREE.NodeUpdateType ?? { FRAME: 'frame', RENDER: 'render' };
const last = new Map(liveUniforms.map(({ key, get }) => [key, initial && initial.has(key) ? initial.get(key) : toPlain(get())])); // initial = the package's own shipped values (rebound builder-singleton uniforms carry a stale value until the first update) // r10-2: plain snapshots compared component-wise (was JSON.stringify per uniform per frame per material)
let version = 0;
Object.defineProperty(pkg, 'live', { enumerable: false, value: {
keys: liveUniforms.map((x) => x.key),
get version() { return version; },
update({ object = obj, camera = cam, scene = sc, time, frameToken } = {}) {
// r10-4: share=on -> ONE NodeFrame per renderer; frame-scope work (time, renderId, camera/viewport/light RENDER|FRAME nodes) runs once per frameToken, not once per material. share=off -> legacy per-package frame (A/B flag: structCache.share / URL wgpuShare=0).
const sh = structCache.share && frameToken != null ? shared(r, THREE, frameToken, time) : null;
const frame = sh ? sh.frame : own;
if (!sh) { frame.update(); if (time != null) frame.time = time; frame.renderId++; }
frame.object = object; frame.camera = camera; frame.scene = scene; frame.material = material;
for (const f of pre) f();
if (sh) {
const done = sh.done, T = sh.T;
for (const n of updateBeforeNodes) frame.updateBeforeNode(n);
for (const n of updateNodes) { if (done.has(n)) { structCache.updSkipped++; continue; } frame.updateNode(n); const ty = n.getUpdateType(); if ((ty === NUT.FRAME || ty === NUT.RENDER) && n.updateReference(frame) === n) { const m = frame.updateMap.get(n); if (m && (ty === NUT.FRAME ? m.frameMap : m.renderMap).get(n) === (ty === NUT.FRAME ? frame.frameId : frame.renderId)) done.add(n); } }
} else {
for (const n of updateBeforeNodes) frame.updateBeforeNode(n);
for (const n of updateNodes) frame.updateNode(n);
}
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
export const structCache = { share: true, frames: 0, updSkipped: 0, lightsBuilt: 0, lightsReused: 0, map: new Map(), hits: 0, misses: 0, uncacheable: 0, rebindFail: 0, mismatch: 0, layoutMismatch: 0, valueMismatch: 0, verified: 0, keyMs: 0, rebindMs: 0, buildMs: 0, reasons: {}, log: [], wgslOf: new Map(), maxTemplates: 128, evicted: 0, keySamples: null, keyProf: null, walkCheck: false, walkChecked: 0, walkMismatch: 0, refKeyMs: 0 };
// r10-7: a template retains the whole node graph + package (nodes -> textures/geometry/closures). Keys that never repeat (per-mesh splits) piled up unbounded -> V8 OOM (~4 GB) at ~900 exports on Burnout. FIFO-bounded; a hit refreshes recency.
export function retainTemplate(C, key, tpl) { C.map.delete(key); C.map.set(key, tpl); while (C.map.size > Math.max(1, C.maxTemplates)) { C.map.delete(C.map.keys().next().value); C.evicted++; } }
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
const L = []; scene?.traverse?.((x) => { if (x.isLight && (x.isDirectionalLight || x.isPointLight || x.isAmbientLight || x.isHemisphereLight)) L.push(x.type + (x.castShadow ? 's' : '')); }); parts.push('L:' + L.join(','));
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
const names = Object.getOwnPropertyNames(n);
for (let i = 0; i < names.length; i++) {
const k = names[i]; if (k.charCodeAt(0) === 95) continue; // '_' private: neither signature nor child
const v = n[k], t = typeof v;
if (t === 'object') {
if (v === null) { if (!SKIP_PROPS.has(k) && !(slot && k === 'value')) s += `${k}=null;`; if (!leaf) continue; }
if (leaf || v === null) continue;
if (Array.isArray(v)) { for (let j = 0; j < v.length; j++) { const c = v[j]; if (c && c.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(c); (ki ??= []).push(j); } } }
else if (v.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(v); (ki ??= []).push(undefined); }
else if (Object.getPrototypeOf(v) === ObjProto) { for (const sp in v) { if (sp.charCodeAt(0) === 95) continue; const c = v[sp]; if (c && c.isNode === true) { (kp ??= []).push(k); (kk ??= []).push(c); (ki ??= []).push(sp); }; } }
} else if (t === 'boolean' || t === 'string' || t === 'number') { if (!SKIP_PROPS.has(k) && !(slot && k === 'value')) s += `${k}=${v};`; }
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
const tj0 = Pf ? nowMs() : 0; const key = parts.join(''); if (Pf) { Pf.join += nowMs() - tj0; Pf.parts += parts.length; Pf.walks++; }
return { key, nodes, parts };
}
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
const HIT = Symbol('tslCacheHit');
export function exportNodeMaterial(material, opts = {}) {
if (!material?.isNodeMaterial) throw new Error('exportNodeMaterial: material.isNodeMaterial required');
const mode = opts.cache ?? 'on';
if (mode === 'off') return buildPackage(material, opts);
const THREE = opts.THREE, C = structCache; let t0 = nowMs(), w = null, hit = null, decision = 'miss';
let pre; try { pre = preParts(THREE, material, opts); } catch (e) { pre = null; w = { refuse: 'walk-error:' + (e?.message ?? e) }; }
const gate = (b) => {
if (!pre) return; const t1 = nowMs();
try { w = builderWalk(THREE, b, pre); } catch (e) { w = { refuse: 'walk-error:' + (e?.message ?? e) }; }
C.keyMs += nowMs() - t1;
if (C.walkCheck && !w.refuse) { const t2 = nowMs(); const r = builderWalkRef(THREE, b, pre); C.refKeyMs += nowMs() - t2; C.walkChecked++; if (r.key !== w.key || r.nodes.length !== w.nodes.length || r.nodes.some((x, i) => x !== w.nodes[i])) { C.walkMismatch++; let d = 0; while (d < r.parts.length && r.parts[d] === w.parts[d]) d++; why('WALKMISMATCH', `${material.name || material.type} @${d}: ref ${r.parts[d]?.slice(0, 160)} <> fused ${w.parts[d]?.slice(0, 160)}`); } } // fused walker == reference walker (tests / ?wgpuTslWalkCheck=1)
if (w.refuse) return;
const tpl = C.map.get(w.key); if (!tpl || tpl.nodes.length !== w.nodes.length || tpl.noRebind) return;
if (tpl.unproven?.size || tpl.unprovenBuf?.size) { decision = 'prove'; hit = tpl; return; }
hit = tpl; retainTemplate(C, w.key, tpl); throw HIT;
};
let pkg = null;
try { pkg = buildPackage(material, opts, gate); } catch (e) { if (e !== HIT) throw e; }
if (!pkg) { // setup-stage hit: analyze+generate skipped
const tpl = hit; t0 = nowMs(); let rb = null;
try { rb = rebind(tpl, w, material, opts); } catch (e) { C.rebindFail++; why('rebindFail', String(e?.message ?? e)); }
C.rebindMs += nowMs() - t0;
if (rb) {
if (mode !== 'verify') { C.hits++; return rb; }
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
if (C.keySamples) { const h = strHash(pkg.vertex + pkg.fragment); const e = C.keySamples.get(h) ?? { n: 0, s: [] }; C.keySamples.set(h, e); e.n++; if (e.s.length < 8) e.s.push({ name: material.name || material.type, parts: w.parts }); } // diagnostic (?wgpuTslKeyDump=1): per-WGSL-hash key parts, for diffing over-split terms
if (decision === 'prove') { const tpl = hit; const have = new Set(pkg.tpl.liveUniforms.map((x) => x.node?.uuid)); for (const [bk, a0] of [...(tpl.unprovenBuf ?? [])]) { if (pkg.bufferSources[bk] === a0) tpl.unprovenBuf.delete(bk); else { tpl.noRebind = true; why('noRebind:buffer-differs-per-material', bk); } }
for (const u of [...(tpl.unproven ?? [])]) { if (have.has(u)) { SHARED_OK.add(u); tpl.unproven.delete(u); } else { tpl.noRebind = true; why('noRebind:singleton-not-shared', u); } } return pkg; }
if (mode === 'verify') { const k = pkg.vertex.length + ':' + pkg.fragment.length + ':' + strHash(pkg.vertex + pkg.fragment); const prev = C.wgslOf.get(w.key); if (prev && prev !== k) { C.mismatch++; why('MISMATCH', `struct key -> 2 WGSL (${material.name})`); } C.wgslOf.set(w.key, k); }
if (!C.map.has(w.key)) { const t = { nodes: w.nodes, pkg }; const bad = templateBinds(t, material); if (bad) { t.noRebind = true; why('noRebind:' + bad.split(':')[0], bad); } retainTemplate(C, w.key, t); }
return pkg;
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
// template validation + slot index: every non-shared binding must resolve to a walked node (else rebind would alias M0's data into M1 = wrong pixels).
function templateBinds(t, material) {
const { pkg, nodes } = t;
t.slotOf = new Map(); for (const k of Object.keys(material)) if (material[k]?.isTexture) t.slotOf.set(material[k].uuid, k);
t.slotMatrix = new Map(); t.slotTexNodes = new Set(); for (const n of pkg.tpl.updateNodes) if (n.isTextureNode && n.value?.uuid && t.slotOf.has(n.value.uuid) && !nodes.some((x) => x.uuid === n.uuid)) { t.slotTexNodes.add(n.uuid); if (n._matrixUniform) t.slotMatrix.set(n._matrixUniform.uuid, t.slotOf.get(n.value.uuid)); } const idx = new Map(nodes.map((n, i) => [n.uuid, i]));
const lightKeys = new Set(); for (const n of pkg.tpl.updateNodes) if (n.light?.isLight) for (const v of Object.values(n)) if (v?.isUniformNode) lightKeys.add(v.uuid);
t.texNode = new Map(); for (const n of nodes) if (n.isTextureNode && n.value?.uuid) t.texNode.set(n.value.uuid, n);
t.bufNode = new Map(); for (const n of nodes) if (n.value?.isBufferAttribute) t.bufNode.set(n.value, n);
t.uniNode = new Map(); for (const { key, node } of pkg.tpl.liveUniforms) if (node) t.uniNode.set(key, node);
for (const g of pkg.bindGroups) for (const b of g.bindings) {
if (b.textureUuid && !t.texNode.has(b.textureUuid) && !t.slotOf.has(b.textureUuid)) return `texture-unmapped:${b.name}`;
if (b.kind === 'storage-buffer') { const a = pkg.bufferSources[`${g.group}.${b.binding}`]; if (!t.bufNode.has(a)) (t.unprovenBuf ??= new Map()).set(`${g.group}.${b.binding}`, a); /* builder-side buffer: shared iff a 2nd build binds the SAME BufferAttribute object (proven below) */ }
}
t.attrNode = new Map(); for (const k of Object.keys(pkg.attributeSources)) { const n = nodes.find((x) => `node:${x.uuid}` === k); if (!n) return `node-attribute-unmapped:${k}`; t.attrNode.set(k, n); }
for (const { key, node } of pkg.tpl.liveUniforms) if (node && !idx.has(node.uuid) && !t.slotMatrix.has(node.uuid) && !lightKeys.has(node.uuid) && !SHARED_OK.has(node.uuid)) { let ref = null, prop = null; for (const n of nodes) { for (const p of ['node', '_matrixUniform']) if (n[p]?.uuid === node.uuid) { ref = n; prop = p; break; } if (ref) break; } if (ref) { t.refOwner ??= new Map(); t.refOwner.set(node.uuid, { owner: ref, prop }); } else if (pkg.tpl.updateNodes.some((n) => n.node?.uuid === node.uuid && !idx.has(n.uuid))) (t.unproven ??= new Set()).add(node.uuid); /* builder-side singleton (materialOpacity & co): shared iff a 2nd build resolves the same uuid -> proven below */ else return `uniform-unmapped:${key}`; }
return null;
}
const SHARED_OK = new Set(); // reserved: process-wide singleton uniform nodes proven shared
function rebind(t, w, material, opts) {
const { THREE } = opts, T = t.pkg, map = new Map();
for (let i = 0; i < t.nodes.length; i++) { const a = t.nodes[i], b = w.nodes[i]; if (a.uuid !== b.uuid) { if (a.constructor !== b.constructor || (a.type ?? null) !== (b.type ?? null)) throw new Error('slot type mismatch at ' + i); map.set(a.uuid, b); } }
const m = (n) => { const x = map.get(n.uuid); if (x) return x; const o = t.refOwner?.get(n.uuid); if (o) { const ox = map.get(o.owner.uuid); if (ox) { if (ox[o.prop] == null) { if (o.prop === '_matrixUniform' && ox.isTextureNode && ox.value?.matrix) ox._matrixUniform = (THREE.TSL ?? THREE).uniform(ox.value.matrix); else throw new Error('owned node not materialised: ' + o.prop); } return ox[o.prop]; } } return n; };
const r = opts.renderer ?? headlessRenderer(THREE);
const obj = opts.object ?? new THREE.Mesh(opts.geometry ?? new THREE.BoxGeometry(1, 1, 1), material);
obj.updateMatrixWorld?.();
const cam = opts.camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000), sc = opts.scene ?? new THREE.Scene();
const textureSources = {}, bufferSources = {};
const texUuid = (u) => { let tx; if (t.texNode.has(u)) { const n = t.texNode.get(u), n1 = map.get(n.uuid) ?? n; tx = n1.value; } else tx = material[t.slotOf.get(u)]; if (!tx?.isTexture) throw new Error('slot texture missing: ' + t.slotOf.get(u)); textureSources[tx.uuid] = tx; return tx.uuid; };
const groups = T.bindGroups.map((g) => ({ group: g.group, name: g.name, bindings: g.bindings.map((b) => {
const o = { ...b };
if (b.uniforms) o.uniforms = b.uniforms.map((u) => {
const n0 = t.uniNode.get(u.key); if (n0 && t.slotMatrix.has(n0.uuid)) return { ...u, value: toPlain(material[t.slotMatrix.get(n0.uuid)]?.matrix) };
const n1 = n0 && m(n0);
if (!n0 || n1 === n0) return { ...u };
const src = u.source?.kind === 'uniform' ? { ...u.source, uuid: n1.uuid, name: n1.name || null } : u.source;
const ro = t.refOwner?.get(n0.uuid); const own = ro?.prop === '_matrixUniform' ? (map.get(ro.owner.uuid) ?? ro.owner) : null; // texture-matrix uniform: ship the NEW texture's matrix (its node holds the pre-update value)
return { ...u, key: n1.uuid, source: src, value: toPlain(own?.value?.matrix ?? n1.value) };
});
else if (b.textureUuid) o.textureUuid = texUuid(b.textureUuid);
else if (b.kind === 'storage-buffer') { const a0 = T.bufferSources[`${g.group}.${b.binding}`]; const n0b = t.bufNode.get(a0); bufferSources[`${g.group}.${b.binding}`] = n0b ? (map.get(n0b.uuid) ?? n0b).value : a0; }
return o;
}) }));
const attributeSources = {}, attrKey = new Map(); for (const [k, n0] of t.attrNode) { const n1 = map.get(n0.uuid) ?? n0; attrKey.set(k, `node:${n1.uuid}`); attributeSources[`node:${n1.uuid}`] = n1.attribute; }
const pkg = { vertex: T.vertex, fragment: T.fragment, bindGroups: groups, attributes: T.attributes.map((a) => (attrKey.has(a.key) ? { ...a, key: attrKey.get(a.key) } : a)), varyings: T.varyings, vertexEntry: 'main', fragmentEntry: 'main',
material: { name: material.name, type: material.type, transparent: !!material.transparent, side: material.side, depthWrite: material.depthWrite } };
Object.defineProperty(pkg, 'textureSources', { value: textureSources, enumerable: false });
Object.defineProperty(pkg, 'bufferSources', { value: bufferSources, enumerable: false });
Object.defineProperty(pkg, 'attributeSources', { value: attributeSources, enumerable: false });
const live = T.tpl.liveUniforms.map(({ key, node, get }) => { if (node && t.slotMatrix.has(node.uuid)) { const sl = t.slotMatrix.get(node.uuid); return { key, get: () => material[sl]?.matrix }; } const n1 = node && m(node); return !node || n1 === node ? { key, get } : { key: n1.uuid, get: () => n1.value }; });
const upd = T.tpl.updateNodes.filter((n) => !t.slotTexNodes.has(n.uuid)).map(m), updB = T.tpl.updateBeforeNodes.map(m);
const pre = [...new Set(t.slotMatrix.values())].map((sl) => () => { const x = material[sl]; if (x?.matrixAutoUpdate) x.updateMatrix(); });
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
