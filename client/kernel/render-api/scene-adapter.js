// render-api/scene-adapter.js — mirrors a three.js scene graph into render-api calls (RENDER-API.md §4a). NO three import:
// objects are duck-typed (isMesh/isInstancedMesh/isBatchedMesh/isLight/isCamera…), so it works on the engine-INJECTED
// `three` namespace (ctx.three) and on real imports alike. Games keep mutating three objects; sync() diffs per frame.
//
// Change tracking (no full re-upload): matrixWorld compared 16 floats vs last sent · visible/castShadow/receiveShadow/renderOrder
// compared · geometry: attribute.version + index.version (+ draw range) · material: params tuple compared (cheap, once per
// distinct material per frame) + texture.version · InstancedMesh: instanceMatrix.version + count · removal: epoch sweep.
// Optional backend methods (interface.js OPTIONAL_METHODS): createInstanced/updateInstances, updateMesh, updateMaterial,
// createShaderMaterial. Missing ones degrade loudly through `stats.degraded` (never silent): see below.
import { materialToParams } from './material-map.js';
import { IDENTITY_MAT4 } from './interface.js';

const MAT_EPS = 0;
export function createSceneAdapter(backend, { exportNodeMaterial = null, three = null, updateMatrices = true, tslOptions = {} } = {}) {
const recs = new Map();        // Object3D → rec { parts:[{node,geoKey,mat,matSig}], matrix:Float64Array, flags, inst? }
const geos = new Map();        // geometry → { id, sig, users:Set<rec> }  (key = geometry object; uuid dedup is implicit)
const mats = new Map();        // material → { id, sig, epoch, params, users:Set }
const lights = new Map();      // Light → { id, kind, sig }
const stats = { frames: 0, created: 0, updated: 0, removed: 0, uploadsGeometry: 0, degraded: new Set(), unsupported: new Set() };
let epoch = 0, cameraSig = '';

const eqArr = (a, b) => { for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false; return true; };
function geometryArrays(g, start = 0, count = Infinity) {
const pos = g.attributes?.position;
if (!pos) return null;
const flat = (attr, n) => {
if (!attr) return undefined;
if (!attr.isInterleavedBufferAttribute && attr.itemSize === n && attr.array instanceof Float32Array) return attr.array;
const out = new Float32Array(attr.count * n);
for (let i = 0; i < attr.count; i++) { out[i * n] = attr.getX(i); if (n > 1) out[i * n + 1] = attr.getY(i); if (n > 2) out[i * n + 2] = attr.getZ(i); }
return out;
};
const arrays = { positions: flat(pos, 3) };
const nrm = flat(g.attributes.normal, 3), uvs = flat(g.attributes.uv, 2);
if (nrm) arrays.normals = nrm;
if (uvs) arrays.uvs = uvs;
if (g.index) {
const a = g.index.array, s = start, n = Math.min(count, g.index.count - s);
const whole = s === 0 && n === g.index.count;
arrays.indices = whole ? (a instanceof Uint16Array || a instanceof Uint32Array ? a : Uint32Array.from(a)) : Uint32Array.from(a.subarray(s, s + n));
}
return arrays;
}
const geoSig = (g, start, count) => {
let s = `${start}:${count}`;
for (const k of ['position', 'normal', 'uv']) { const a = g.attributes?.[k]; s += `|${a ? a.version : '-'}:${a ? a.count : 0}`; }
return s + `|${g.index ? g.index.version + ':' + g.index.count : '-'}`;
};

function ensureGeometry(rec, g, start, count) {
const key = `${start}:${count}`;
let e = geos.get(g);
if (!e) { e = { parts: new Map(), users: new Set() }; geos.set(g, e); }
let p = e.parts.get(key);
const sig = geoSig(g, start, count);
if (!p) {
const arrays = geometryArrays(g, start, count);
if (!arrays) { stats.unsupported.add('geometry-without-position'); return null; }
p = { id: backend.createMesh(arrays), sig, users: new Set() };
e.parts.set(key, p); stats.uploadsGeometry++; stats.created++;
} else if (p.sig !== sig) {
const arrays = geometryArrays(g, start, count);
if (backend.updateMesh) { backend.updateMesh(p.id, arrays); p.sig = sig; stats.uploadsGeometry++; stats.updated++; }
else { // degrade: new mesh, users re-created by caller (flag)
stats.degraded.add('updateMesh-missing:recreate');
const old = p.id; p.id = backend.createMesh(arrays); p.sig = sig; p.stale = old; stats.uploadsGeometry++;
for (const u of p.users) u.dirtyGeo = true;
}
}
p.users.add(rec);
return p;
}

function ensureMaterial(m) {
let e = mats.get(m);
const conv = materialToParams(m, { three, exportNodeMaterial, tslOptions });
const sig = conv.sig;
if (!e) {
const id = createMat(conv);
e = { id, sig, conv, users: new Set(), epoch };
mats.set(m, e); stats.created++;
} else if (e.sig !== sig && e.epoch !== epoch) {
if (conv.kind === 'pbr' && backend.updateMaterial) { backend.updateMaterial(e.id, conv.params, conv.textures); }
else { // swap handle on every user
const old = e.id; e.id = createMat(conv);
for (const u of e.users) for (const part of u.parts) if (part.mat === m && part.node) backend.updateNode(part.node, { material: e.id });
backend.destroyMaterial(old);
}
e.sig = sig; e.conv = conv; stats.updated++;
}
e.epoch = epoch;
if (conv.degraded) stats.degraded.add(conv.degraded);
return e;
}
function createMat(conv) {
if (conv.kind === 'wgsl') {
if (backend.createShaderMaterial) return backend.createShaderMaterial(conv.package);
stats.degraded.add('createShaderMaterial-missing:pbr-fallback');
return backend.createMaterial(conv.fallbackParams ?? {}, null);
}
return backend.createMaterial(conv.params, conv.textures);
}

const nodeFlags = (o, vis) => ({ castShadow: !!o.castShadow, receiveShadow: !!o.receiveShadow, visible: vis, renderOrder: o.renderOrder ?? 0 });
const flagSig = (f) => `${+f.castShadow}${+f.receiveShadow}${+f.visible}:${f.renderOrder}`;

function buildParts(o, rec, vis) {
// returns false when nothing renderable
const g = o.geometry;
if (!g?.attributes?.position) { stats.unsupported.add('no-geometry'); return false; }
const mm = Array.isArray(o.material) ? o.material : [o.material];
const groups = Array.isArray(o.material) && g.groups?.length ? g.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
const dr = g.drawRange ?? { start: 0, count: Infinity };
for (const grp of groups) {
const m = mm[grp.materialIndex ?? 0];
if (!m) continue;
const start = grp.start + (dr.start ?? 0) * 0, count = grp.count === Infinity ? (dr.count ?? Infinity) : grp.count;
const gp = ensureGeometry(rec, g, start, count);
if (!gp) continue;
const me = ensureMaterial(m);
me.users.add(rec);
const flags = nodeFlags(o, vis);
const part = { geo: g, geoKey: `${start}:${count}`, start, count, mat: m, flags, node: 0 };
if (o.isInstancedMesh) {
if (backend.createInstanced) { part.node = backend.createInstanced(gp.id, me.id, instanceMats(o), o.count, { ...flags, matrix: Array.from(o.matrixWorld.elements) }); part.instV = o.instanceMatrix.version; part.instCount = o.count; }
else { stats.degraded.add('createInstanced-missing:expanded-per-instance'); part.expanded = []; for (let i = 0; i < o.count; i++) part.expanded.push(backend.createInstance(gp.id, me.id, instanceWorld(o, i), flags)); part.instV = o.instanceMatrix.version; part.instCount = o.count; }
} else part.node = backend.createInstance(gp.id, me.id, Array.from(o.matrixWorld.elements), flags);
rec.parts.push(part); stats.created++;
}
return rec.parts.length > 0;
}
const instanceMats = (o) => o.instanceMatrix.array.subarray(0, o.count * 16);
function instanceWorld(o, i) { // instanceMatrix[i] * matrixWorld (column-major 4x4)
const a = o.matrixWorld.elements, b = o.instanceMatrix.array, off = i * 16, out = new Array(16);
for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[off + c * 4 + k]; out[c * 4 + r] = s; }
return out;
}
function destroyParts(rec) {
for (const p of rec.parts) {
if (p.expanded) for (const n of p.expanded) backend.removeNode(n); else if (p.node) backend.removeNode(p.node);
const e = geos.get(p.geo); e?.parts.get(p.geoKey)?.users.delete(rec);
mats.get(p.mat)?.users.delete(rec);
stats.removed++;
}
rec.parts = [];
}
function gc() { // drop unused geometries/materials
for (const [g, e] of geos) { for (const [k, p] of e.parts) if (p.users.size === 0) { backend.destroyMesh(p.id); e.parts.delete(k); } if (e.parts.size === 0) geos.delete(g); }
for (const [m, e] of mats) if (e.users.size === 0) { backend.destroyMaterial(e.id); mats.delete(m); }
}

function syncLight(o, vis) {
let r = lights.get(o);
const c = o.color ? [o.color.r, o.color.g, o.color.b] : [1, 1, 1];
if (o.isDirectionalLight) {
const d = [o.position.x - (o.target?.position.x ?? 0), o.position.y - (o.target?.position.y ?? 0), o.position.z - (o.target?.position.z ?? 0)];
const len = Math.hypot(...d) || 1; const dir = d.map((v) => v / len);
const sig = `${dir}|${c}|${o.intensity}|${o.castShadow}|${vis}`;
if (!r) { lights.set(o, { id: backend.setSun({ direction: dir, color: c, intensity: vis ? o.intensity : 0, castShadow: !!o.castShadow }), kind: 'sun', sig }); stats.created++; }
else if (r.sig !== sig) { // interface has no updateSun: recreate (removeLight exists for all LightIds)
backend.removeLight(r.id); r.id = backend.setSun({ direction: dir, color: c, intensity: vis ? o.intensity : 0, castShadow: !!o.castShadow }); r.sig = sig; stats.updated++; }
return;
}
if (o.isPointLight) {
const e = o.matrixWorld.elements, pos = [e[12], e[13], e[14]];
const p = { position: pos, color: c, intensity: vis ? o.intensity : 0, distance: o.distance ?? 0, decay: o.decay ?? 2 };
const sig = JSON.stringify(p);
if (!r) { lights.set(o, { id: backend.addPointLight(p), kind: 'point', sig }); stats.created++; }
else if (r.sig !== sig) { backend.updatePointLight(r.id, p); r.sig = sig; stats.updated++; }
return;
}
stats.unsupported.add(`light:${o.type}`); // Ambient/Hemisphere/Spot/RectArea: no interface call yet
}

// ---- SkinnedMesh: skin (IBM = boneInverse x bindMatrix) + skinned mesh (JOINTS/WEIGHTS) + identity instance;
// per frame joint matrices = matrixWorld x bindMatrixInverse x bone.matrixWorld (backend skins to WORLD space,
// == three's skinning + modelMatrix), uploaded via updateSkin ONLY when the palette changed.
const skinRecs = new Map();
const skinCapable = () => typeof backend.createSkin === 'function' && typeof backend.updateSkin === 'function' && typeof backend.createSkinnedMesh === 'function';
function mul4(a, b, out = new Float64Array(16)) { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]; out[c * 4 + r] = v; } return out; }
const attrVer = (g) => `${g.index?.version ?? -1}|${['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].map(k => g.attributes[k]?.version ?? -1)}`;
function syncSkinned(o, vis) {
const g = o.geometry, sk = o.skeleton, nb = sk?.bones?.length ?? 0;
if (!g?.attributes?.position || !g.attributes.skinIndex || !g.attributes.skinWeight || !nb) { stats.unsupported.add('SkinnedMesh:no-skin-attributes'); return; }
let r = skinRecs.get(o);
if (r && (r.geo !== g || r.ver !== attrVer(g) || r.nb !== nb || r.mref !== o.material)) { destroySkinned(r); r = null; }
if (!r) {
const n = g.attributes.position.count, a = (k, w) => g.attributes[k] ? Float32Array.from({ length: n * w }, (_, i) => g.attributes[k].getComponent(Math.floor(i / w), i % w)) : null;
const positions = a('position', 3), normals = a('normal', 3) ?? new Float32Array(n * 3), uvs = a('uv', 2) ?? new Float32Array(n * 2);
const joints = Uint32Array.from(a('skinIndex', 4)), weights = a('skinWeight', 4);
const indices = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
const ibm = new Float32Array(nb * 16);
for (let i = 0; i < nb; i++) ibm.set(mul4(sk.boneInverses[i].elements, o.bindMatrix.elements), i * 16);
const skin = backend.createSkin(ibm, nb);
const mesh = backend.createSkinnedMesh({ positions, normals, uvs, joints, weights, indices }, skin);
const me = ensureMaterial(Array.isArray(o.material) ? o.material[0] : o.material);
const node = backend.createInstance(mesh, me.id, IDENTITY_MAT4.slice(), nodeFlags(o, vis));
const rr = {}; me.users.add(rr);
r = Object.assign(rr, { geo: g, ver: attrVer(g), nb, mref: o.material, skin, mesh, node, mat: Array.isArray(o.material) ? o.material[0] : o.material, pal: new Float32Array(nb * 16), last: new Float32Array(nb * 16).fill(NaN), flagsSig: flagSig(nodeFlags(o, vis)) });
skinRecs.set(o, r); stats.created++; stats.uploadsGeometry++;
}
const pre = mul4(o.matrixWorld.elements, o.bindMatrixInverse.elements), tmp = new Float64Array(16);
for (let i = 0; i < nb; i++) r.pal.set(mul4(pre, sk.bones[i].matrixWorld.elements, tmp), i * 16);
let changed = false; for (let i = 0; i < r.pal.length; i++) if (r.pal[i] !== r.last[i]) { changed = true; break; }
if (changed) { backend.updateSkin(r.skin, r.pal); r.last.set(r.pal); stats.updated++; stats.skinUploads = (stats.skinUploads ?? 0) + 1; }
const f = nodeFlags(o, vis), fs = flagSig(f); if (fs !== r.flagsSig) { backend.updateNode(r.node, f); r.flagsSig = fs; stats.updated++; }
ensureMaterial(r.mat);
}
function destroySkinned(r) { mats.get(r.mat)?.users.delete(r); backend.removeNode(r.node); backend.destroySkinnedMesh?.(r.mesh); backend.destroySkin?.(r.skin); stats.removed++; }
function visit(o, parentVis, seen) {
const vis = parentVis && o.visible !== false;
if (o.isLight) { seen.add(o); syncLight(o, vis); }
else if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh) {
if (o.isBatchedMesh) stats.unsupported.add('BatchedMesh'); // needs createBatched (per-instance geometry ids + indirect draw) — not in interface
else {
if (o.isSkinnedMesh && skinCapable()) { seen.add(o); syncSkinned(o, vis); for (const c of o.children) visit(c, vis, seen); return; }
if (o.isSkinnedMesh) stats.unsupported.add('SkinnedMesh:static-bind-pose-only'); // backend lacks createSkin/updateSkin/createSkinnedMesh
seen.add(o);
let rec = recs.get(o);
if (!rec) { rec = { parts: [], matrix: new Float64Array(16), flagsSig: '', matSig: '', dirtyGeo: false }; recs.set(o, rec); buildParts(o, rec, vis); rec.matrix.set(o.matrixWorld.elements); rec.flagsSig = flagSig(nodeFlags(o, vis)); rec.mref = o.material; rec.geoRef = o.geometry; }
else updateMesh(o, rec, vis);
}
}
for (const c of o.children) visit(c, vis, seen);
}
function updateMesh(o, rec, vis) {
const gone = rec.geoRef !== o.geometry || rec.dirtyGeo || (rec.mref !== o.material && (Array.isArray(o.material) || Array.isArray(rec.mref)));
if (gone) { destroyParts(rec); rec.dirtyGeo = false; buildParts(o, rec, vis); rec.mref = o.material; rec.geoRef = o.geometry; rec.matrix.set(o.matrixWorld.elements); rec.flagsSig = flagSig(nodeFlags(o, vis)); stats.updated++; return; }
const f = nodeFlags(o, vis), fs = flagSig(f), moved = !eqArr(rec.matrix, o.matrixWorld.elements);
const single = rec.parts.length === 1 && !Array.isArray(o.material);
let swapped = single && rec.parts[0].mat !== o.material;
for (const p of rec.parts) {
if (p.expanded) { // instanced fallback
if (moved || p.instV !== o.instanceMatrix.version || p.instCount !== o.count) { destroyExpanded(p); const gp = geos.get(p.geo).parts.get(p.geoKey), me = mats.get(p.mat); p.expanded = []; for (let i = 0; i < o.count; i++) p.expanded.push(backend.createInstance(gp.id, me.id, instanceWorld(o, i), f)); p.instV = o.instanceMatrix.version; p.instCount = o.count; stats.updated++; }
continue;
}
ensureGeometry(rec, p.geo, p.start, p.count); // version-compare only (no upload unless attribute/index version moved)
const u = {};
if (moved && !o.isInstancedMesh) u.mat4 = Array.from(o.matrixWorld.elements);
if (fs !== rec.flagsSig) Object.assign(u, f);
if (swapped) { const me = ensureMaterial(o.material); me.users.add(rec); mats.get(p.mat)?.users.delete(rec); p.mat = o.material; u.material = me.id; rec.mref = o.material; }
if (o.isInstancedMesh) {
if (moved || p.instV !== o.instanceMatrix.version || p.instCount !== o.count) { backend.updateInstances(p.node, instanceMats(o), o.count, Array.from(o.matrixWorld.elements)); p.instV = o.instanceMatrix.version; p.instCount = o.count; stats.updated++; }
}
if (Object.keys(u).length) { backend.updateNode(p.node, u); stats.updated++; }
// refresh material conversion (property edits) — cheap, once per material per frame (epoch-gated inside)
ensureMaterial(p.mat);
}
if (moved) rec.matrix.set(o.matrixWorld.elements);
rec.flagsSig = fs;
}
function destroyExpanded(p) { for (const n of p.expanded) backend.removeNode(n); }

return {
stats,
// mirror `scene` (+ camera) into the backend. Call once per frame before backend.renderFrame().
sync(scene, camera = null) {
epoch++; stats.frames++;
if (updateMatrices) scene.updateMatrixWorld(true);
const seen = new Set();
visit(scene, true, seen);
for (const [o, rec] of recs) if (!seen.has(o) || (o.isInstancedMesh && !backend.updateInstances && !backend.createInstanced && false)) { destroyParts(rec); recs.delete(o); }
for (const [o, r] of skinRecs) if (!seen.has(o)) { destroySkinned(r); skinRecs.delete(o); }
for (const [o, r] of lights) if (!seen.has(o)) { backend.removeLight(r.id); lights.delete(o); stats.removed++; }
gc();
if (camera) {
if (updateMatrices) camera.updateMatrixWorld?.();
const view = Array.from(camera.matrixWorldInverse?.elements ?? []), proj = Array.from(camera.projectionMatrix?.elements ?? []);
const sig = `${view}|${proj}`;
if (view.length === 16 && proj.length === 16 && sig !== cameraSig) { backend.setCamera(view, proj); cameraSig = sig; stats.updated++; }
}
},
dispose() { for (const [, rec] of recs) destroyParts(rec); recs.clear(); for (const [, r] of skinRecs) destroySkinned(r); skinRecs.clear(); for (const [, r] of lights) backend.removeLight(r.id); lights.clear(); gc(); },
};
}
