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
export function exportNodeMaterial(material, { THREE, object = null, camera = null, scene = null, wgslBuilderCtor = null, renderer = null } = {}) {
if (!material?.isNodeMaterial) throw new Error('exportNodeMaterial: material.isNodeMaterial required');
const Ctor = wgslBuilderCtor ?? headlessRenderer(THREE)._ctor;
const r = renderer ?? headlessRenderer(THREE);
const obj = object ?? new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
obj.updateMatrixWorld?.();
const cam = camera ?? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
const sc = scene ?? new THREE.Scene();
const b = new Ctor(obj, r);
b.scene = sc; b.material = material; b.camera = cam; b.context.material = material;
b.lightsNode = null; b.environmentNode = null; b.fogNode = null; b.clippingContext = null;
b.build();
const groups = b.getBindings().map((g) => ({
group: g.index, name: g.name,
bindings: g.bindings.map((bd, i) => {
const out = { binding: i, name: bd.name, kind: kindOf(bd), stage: stageOf(bd.visibility) };
if (bd.isUniformsGroup) {
out.size = bd.bytesPerElement ? undefined : undefined;
out.uniforms = bd.uniforms.map((u) => ({ name: u.name, type: u.type, offset: u.offset, itemSize: u.itemSize, boundary: u.boundary, value: toPlain(u.getValue?.()) }));
} else if (bd.texture) out.textureUuid = bd.texture.uuid;
return out;
}),
}));
return {
vertex: b.vertexShader, fragment: b.fragmentShader,
bindGroups: groups,
attributes: b.getAttributesArray().map((a, i) => ({ name: a.name, type: a.type, location: i })),
varyings: (b.varyings ?? []).map((v) => ({ name: v.name, type: v.type })),
vertexEntry: 'main', fragmentEntry: 'main',
material: { name: material.name, type: material.type, transparent: !!material.transparent, side: material.side, depthWrite: material.depthWrite },
};
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
