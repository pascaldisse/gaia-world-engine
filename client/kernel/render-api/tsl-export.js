// render-api/tsl-export.js — three TSL NodeMaterial → WGSL package, HEADLESS (no GPU, no canvas, node/bun).
// Runs three r180's own WGSLNodeBuilder against a stub renderer/backend and returns a data-only package
//   { vertex, fragment, bindGroups[{group,name,shared,bindings[{binding,name,kind,type,stage,size,value?,textureKey?}]}],
//     attributes[{name,type,location}], varyings[{name,type}], vertexEntry:'main', fragmentEntry:'main' }
// that a non-three backend feeds to create_shader_material (RENDER-API.md §6). No three import here: the caller
// passes the (possibly engine-injected) THREE namespace (`three/webgpu`) → works for the ctx.three case too.
const STAGES = { 1: 'vertex', 2: 'fragment', 4: 'compute' };
const stageOf = (v) => STAGES[v] ?? ([v & 1 ? 'vertex' : null, v & 2 ? 'fragment' : null].filter(Boolean).join('|') || 'none');

const kindOf = (b) => (b.isUniformsGroup ? 'uniform-buffer' : b.isSampledTexture ? (b.isSampledCubeTexture ? 'texture-cube' : b.isSampledTexture3D ? 'texture-3d' : b.isStorageTexture ? 'storage-texture' : 'texture-2d') : b.isSampler ? 'sampler' : b.isStorageBuffer ? 'storage-buffer' : 'unknown');

// builder → data package. `THREE` = three/webgpu namespace; `WGSLNodeBuilder` is not exported publicly, so we reach it
// through three's own backend factory (WebGPUBackend.prototype.createNodeBuilder) without constructing a device.
export function exportNodeMaterial(material, { THREE, object = null, geometry = null, camera = null, scene = null, wgslBuilderCtor = null, renderer = null } = {}) {
if (!material?.isNodeMaterial) throw new Error('exportNodeMaterial: material.isNodeMaterial required');
const Ctor = wgslBuilderCtor ?? headlessRenderer(THREE)._ctor;
const r = renderer ?? headlessRenderer(THREE);
// `object` = the real mesh (its geometry attributes decide which TSL attribute() nodes resolve); `geometry` = same without the object (InstancedMesh/Skinned: instancing is expanded by the adapter, never exported).
const obj = object ?? new THREE.Mesh(geometry ?? new THREE.BoxGeometry(1, 1, 1), material);
obj.updateMatrixWorld?.();
const cam = camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
const sc = scene ?? new THREE.Scene();
const b = new Ctor(obj, r);
b.scene = sc; b.material = material; b.camera = cam; b.context.material = material;
// (b) real lights: three's own LightsNode over the scene's Directional/Point lights (shadows not exported) → lit node materials shade.
// Light uniform VALUES come from three's light nodes per frame (live.update) — same objects the adapter maps to setSun/addPointLight.
const lights = []; sc.traverse?.((o) => { if (o.isLight && (o.isDirectionalLight || o.isPointLight || o.isAmbientLight || o.isHemisphereLight)) lights.push(o); });
b.lightsNode = lights.length ? r.lighting.createNode(lights) : null; b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
b.build();
// uniform node uuid → ReferenceNode that drives it (material.opacity, color, …) for source tags
const refs = new Map();
for (const n of [...b.updateNodes, ...b.updateBeforeNodes]) if ('property' in n && 'reference' in n && n.node?.uuid) refs.set(n.node.uuid, n);
// uniform node uuid → light uuid for light-node-owned uniforms (color, cutoff, decay; view-space positions stay 'uniform')
const lightUuids = new Map();
for (const n of b.updateNodes) if (n.light?.isLight) for (const v of Object.values(n)) if (v?.isUniformNode) lightUuids.set(v.uuid, n.light.uuid);
const liveUniforms = [];
  const semantics = builtinSemantics(THREE);
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
  if (key) liveUniforms.push({ key, u });
  return { name: u.name, semantic, key, source, type: u.type, offset: u.offset, itemSize: u.itemSize, boundary: u.boundary, value: toPlain(u.getValue?.()) };
});
} else if (bd.texture) { out.textureUuid = bd.texture.uuid; out.colorSpace = bd.texture.colorSpace ?? null; }
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
// r6: node-held BufferAttributes (instancedBufferAttribute()/bufferAttribute() nodes → nodeAttributeN): key `node:<uuid>` → live three BufferAttribute (non-enumerable).
const attributeSources = {};
for (const a of b.getAttributesArray()) if (a.node?.attribute) attributeSources[`node:${a.node.uuid}`] = a.node.attribute;
Object.defineProperty(pkg, 'attributeSources', { value: attributeSources, enumerable: false });
// (a) live values, NON-enumerable: runs three's OWN node updates (NodeFrame over builder.updateNodes — reference(), uniform
// onFrame/onRender/onObjectUpdate, light nodes) and returns only uniforms whose packed value changed since the last call.
const frame = new (THREE.NodeFrame ?? THREE.TSL?.NodeFrame)(); frame.renderer = r;
const last = new Map(liveUniforms.map(({ key, u }) => [key, JSON.stringify(toPlain(u.getValue?.()))]));
let version = 0;
Object.defineProperty(pkg, 'live', { enumerable: false, value: {
  keys: liveUniforms.map((x) => x.key),
  get version() { return version; },
  update({ object = obj, camera = cam, scene = sc, time } = {}) {
    frame.update(); if (time != null) frame.time = time;
    frame.renderId++; frame.object = object; frame.camera = camera; frame.scene = scene; frame.material = material;
    for (const n of b.updateBeforeNodes) frame.updateBeforeNode(n);
    for (const n of b.updateNodes) frame.updateNode(n);
    const changed = [];
    for (const { key, u } of liveUniforms) {
      const v = toPlain(u.getValue?.()), j = JSON.stringify(v);
      if (j !== last.get(key)) { last.set(key, j); changed.push({ key, value: v }); }
    }
    if (changed.length) version++;
    return changed;
  },
} });
return pkg;
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
