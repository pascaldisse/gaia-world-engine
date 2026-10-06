// render-api/scene-adapter.js — mirrors a three.js scene graph into render-api calls (RENDER-API.md §4a). NO three import:
// objects are duck-typed (isMesh/isInstancedMesh/isBatchedMesh/isLight/isCamera…), so it works on the engine-INJECTED
// `three` namespace (ctx.three) and on real imports alike. Games keep mutating three objects; sync() diffs per frame.
//
// Change tracking (no full re-upload): matrixWorld compared 16 floats vs last sent · visible/castShadow/receiveShadow/renderOrder
// compared · geometry: attribute.version + index.version (+ draw range) · material: params tuple compared (cheap, once per
// distinct material per frame) + texture.version · InstancedMesh: instanceMatrix.version + count · removal: epoch sweep.
// Optional backend methods (interface.js OPTIONAL_METHODS): createInstanced/updateInstances, updateMesh, updateMaterial,
// createShaderMaterial. Missing ones degrade loudly through `stats.degraded` (never silent): see below.
import { materialToParams, materialSig } from './material-map.js';
import { IDENTITY_MAT4 } from './interface.js';

const MAT_EPS = 0;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export function createSceneAdapter(backend, { exportNodeMaterial = null, three = null, updateMatrices = true, tslOptions = {} } = {}) {
const recs = new Map();        // Object3D → rec { parts:[{node,geoKey,mat,matSig}], matrix:Float64Array, flags, inst? }
const geos = new Map();        // geometry → { id, sig, users:Set<rec> }  (key = geometry object; uuid dedup is implicit)
const mats = new Map();        // material → { id, sig, epoch, params, users:Set }
const lights = new Map();      // Light → { id, kind, sig }
const stats = { frames: 0, created: 0, updated: 0, removed: 0, uploadsGeometry: 0, degraded: new Set(), unsupported: new Set() };
let epoch = 0, cameraSig = '';
// r6: HemisphereLight/AmbientLight accumulate per frame into one irradiance pair (sum = three: every light node `+=` into context.irradiance); scene.background -> setBackground
const amb = { sky: [0, 0, 0], ground: [0, 0, 0], n: 0, sig: null, bgSig: null };

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
const GEO_ATTRS = ['position', 'normal', 'uv'];
// numeric signature [start,count,(version,count)×3,index version,index count] — compared in place, no per-frame string/array alloc
const geoSig = (g, start, count) => {
const s = [start, count];
for (const k of GEO_ATTRS) { const a = g.attributes?.[k]; s.push(a ? a.version : -1, a ? a.count : 0); }
s.push(g.index ? g.index.version : -1, g.index ? g.index.count : 0);
return s;
};
function geoSame(g, start, count, sig) {
if (sig[0] !== start || sig[1] !== count) return false;
const at = g.attributes;
for (let i = 0; i < 3; i++) { const a = at?.[GEO_ATTRS[i]]; if (sig[2 + i * 2] !== (a ? a.version : -1) || sig[3 + i * 2] !== (a ? a.count : 0)) return false; }
return sig[8] === (g.index ? g.index.version : -1) && sig[9] === (g.index ? g.index.count : 0);
}

function ensureGeometry(rec, g, start, count) {
const key = `${start}:${count}`;
let e = geos.get(g);
if (!e) { e = { parts: new Map(), users: new Set() }; geos.set(g, e); }
let p = e.parts.get(key);
if (!p) {
const sig = geoSig(g, start, count);
const arrays = geometryArrays(g, start, count);
if (!arrays) { stats.unsupported.add('geometry-without-position'); return null; }
p = { id: backend.createMesh(arrays), sig, users: new Set() };
e.parts.set(key, p); stats.uploadsGeometry++; stats.created++;
} else if (!geoSame(g, start, count, p.sig)) {
const sig = geoSig(g, start, count);
const arrays = geometryArrays(g, start, count);
if (backend.updateMesh) { backend.updateMesh(p.id, arrays); p.sig = sig; stats.uploadsGeometry++; stats.updated++; }
else { // degrade: new mesh, users re-created by caller (flag)
stats.degraded.add('updateMesh-missing:recreate');
const old = p.id; p.id = backend.createMesh(arrays); p.sig = sig; p.stale = old; stats.uploadsGeometry++;
for (const u of p.users) u.dirtyGeo = true;
}
}
if (!p.users.has(rec)) p.users.add(rec);
return p;
}

// r4 live TSL uniforms: per frame, three's own node updates (pkg.live) → only changed values → backend.setShaderUniforms.
// Lights are baked into the package's lightsNode at export (scene passed below); their VALUES ride the same path.
let frameScene = null, frameCamera = null;
function syncLiveUniforms() {
  for (const [, e] of mats) {
    const live = e.conv?.kind === 'wgsl' && e.epoch === epoch ? e.conv.package?.live : null;
    if (!live) continue;
    const changed = live.update({ scene: frameScene, camera: frameCamera ?? undefined });
    if (!changed.length) continue;
    if (backend.setShaderUniforms) { backend.setShaderUniforms(e.id, changed); stats.uniformWrites = (stats.uniformWrites ?? 0) + changed.length; }
    else stats.degraded.add('setShaderUniforms-missing:tsl-values-frozen');
  }
}
function ensureMaterial(m) {
let e = mats.get(m);
if (e && e.epoch === epoch) return e;                       // once per material per frame (was: once per MESH per frame)
const sig = materialSig(m, { exportNodeMaterial });          // cheap string, no params/texture work
if (e && e.sig === sig) { e.epoch = epoch; if (e.degraded) stats.degraded.add(e.degraded); return e; } // idle frame: 0 texture work
const conv = materialToParams(m, { three, exportNodeMaterial, tslOptions: { ...tslOptions, scene: frameScene, camera: frameCamera ?? tslOptions.camera } });
if (!e) {
const id = createMat(conv);
e = { id, sig: conv.sig, conv, users: new Set(), epoch, degraded: conv.degraded };
mats.set(m, e); stats.created++;
} else {
if (conv.kind === 'pbr' && e.conv.kind === 'pbr' && backend.updateMaterial) { backend.updateMaterial(e.id, conv.params, conv.textures); }
else { // swap handle on every user
const old = e.id; e.id = createMat(conv);
for (const u of e.users) { if (u.parts) { for (const part of u.parts) if (part.mat === m && part.node) backend.updateNode(part.node, { material: e.id }); } else if (u.node && u.mat === m) backend.updateNode(u.node, { material: e.id }); }
backend.destroyMaterial(old);
}
e.sig = conv.sig; e.conv = conv; e.degraded = conv.degraded; e.epoch = epoch; stats.updated++;
}
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
const flagBits = (o, vis) => (o.castShadow ? 1 : 0) | (o.receiveShadow ? 2 : 0) | (vis ? 4 : 0); // + renderOrder compared separately (no string alloc)

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
if ((o.isHemisphereLight || o.isAmbientLight) && backend.setAmbient) { // r6: three HemisphereLightNode/AmbientLightNode: E = colour x intensity (linear), hemi mixes ground->sky by 0.5 n.y + 0.5 (light dir +Y)
if (!vis) return;
const k = o.intensity ?? 1, s = o.color ? [o.color.r * k, o.color.g * k, o.color.b * k] : [k, k, k];
const g = o.isHemisphereLight && o.groundColor ? [o.groundColor.r * k, o.groundColor.g * k, o.groundColor.b * k] : s;
for (let i = 0; i < 3; i++) { amb.sky[i] += s[i]; amb.ground[i] += g[i]; }
amb.n++;
if (o.isHemisphereLight && o.position && (o.position.x || o.position.z || !(o.position.y > 0))) stats.degraded.add('HemisphereLight-direction-not-+Y:assumed-+Y');
return;
}
stats.unsupported.add(`light:${o.type}`); // Spot/RectArea (and Ambient/Hemisphere on a backend without setAmbient)
}

// ---- SkinnedMesh: skin (IBM = boneInverse x bindMatrix) + skinned mesh (JOINTS/WEIGHTS) + identity instance;
// per frame joint matrices = matrixWorld x bindMatrixInverse x bone.matrixWorld (backend skins to WORLD space,
// == three's skinning + modelMatrix), uploaded via updateSkin ONLY when the palette changed.
const skinRecs = new Map();
let skinMs = 0, skinCalls = 0;
const skelState = new WeakMap(); // Skeleton → { last:Float64Array(nb*16), ver, epoch }
// out = a × b[off..off+16] (column-major), b read in place (no per-bone subarray)
function mul4b(a, b, off, out) { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[off + c * 4 + k]; out[c * 4 + r] = v; } return out; }
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
r = Object.assign(rr, { geo: g, ver: attrVer(g), nb, mref: o.material, skin, mesh, node, mat: Array.isArray(o.material) ? o.material[0] : o.material, pal: new Float32Array(nb * 16), fbits: flagBits(o, vis), fro: o.renderOrder ?? 0, sk, lastWorld: new Float64Array(16).fill(NaN), lastBind: new Float64Array(16).fill(NaN), seenSkel: -1 });
skinRecs.set(o, r); stats.created++; stats.uploadsGeometry++;
}
// per-SKELETON change detection (once per frame, shared by every SkinnedMesh on that skeleton): bone.matrixWorld vs last frame.
// A mesh recomputes + uploads its palette ONLY when its skeleton moved (skelVer), its own matrixWorld or its bindMatrixInverse changed.
let st = skelState.get(sk);
if (!st) { st = { last: new Float64Array(nb * 16).fill(NaN), ver: 0, epoch: -1 }; skelState.set(sk, st); }
if (st.epoch !== epoch) {
st.epoch = epoch; let ch = false; const L = st.last, B = sk.bones;
for (let i = 0; i < nb; i++) { const e = B[i].matrixWorld.elements, off = i * 16; for (let k = 0; k < 16; k++) if (L[off + k] !== e[k]) { L[off + k] = e[k]; ch = true; } }
if (ch) st.ver++;
}
const mw = o.matrixWorld.elements, bi = o.bindMatrixInverse.elements;
const stale = r.seenSkel !== st.ver || !eqArr(r.lastWorld, mw) || !eqArr(r.lastBind, bi);
if (stale) {
const pre = mul4(mw, bi, r.pre ??= new Float64Array(16)), tmp = r.tmp ??= new Float64Array(16), L = st.last, pal = r.pal;
for (let i = 0; i < nb; i++) { mul4b(pre, L, i * 16, tmp); pal.set(tmp, i * 16); }
r.seenSkel = st.ver; r.lastWorld.set(mw); r.lastBind.set(bi);
const ts0 = now(); backend.updateSkin(r.skin, pal); skinMs += now() - ts0; skinCalls++; stats.updated++; stats.skinUploads = (stats.skinUploads ?? 0) + 1;
}
const fb = flagBits(o, vis), fro = o.renderOrder ?? 0;
if (fb !== r.fbits || fro !== r.fro) { backend.updateNode(r.node, nodeFlags(o, vis)); r.fbits = fb; r.fro = fro; stats.updated++; }
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
if (!rec) { rec = { parts: [], matrix: new Float64Array(16), fbits: 0, fro: 0, dirtyGeo: false }; recs.set(o, rec); buildParts(o, rec, vis); rec.matrix.set(o.matrixWorld.elements); rec.fbits = flagBits(o, vis); rec.fro = o.renderOrder ?? 0; rec.mref = o.material; rec.geoRef = o.geometry; }
else updateMesh(o, rec, vis);
}
}
for (const c of o.children) visit(c, vis, seen);
}
// background: Color -> setBackground (linear, as three's clear colour); Texture/CubeTexture/other -> loud unsupported, clear colour kept. Never throws.
function syncEnvironment(scene) {
if (backend.setAmbient) {
const sig = `${amb.sky}|${amb.ground}`;
if (sig !== amb.sig) { backend.setAmbient({ sky: amb.sky.slice(), ground: amb.ground.slice() }); amb.sig = sig; stats.updated++; }
}
const bg = scene.background;
if (!backend.setBackground) { if (bg) stats.unsupported.add('background'); return; }
let sig, rgb = null;
if (bg && bg.isColor) { rgb = [bg.r, bg.g, bg.b]; sig = `c${rgb}`; }
else if (bg) { sig = 'x'; stats.unsupported.add(bg.isCubeTexture ? 'background:CubeTexture' : bg.isTexture ? 'background:Texture' : `background:${bg.constructor?.name ?? typeof bg}`); }
else sig = 'null';
if (sig !== amb.bgSig) { if (sig !== 'x') backend.setBackground(rgb); amb.bgSig = sig; stats.updated++; }
}
function updateMesh(o, rec, vis) {
const gone = rec.geoRef !== o.geometry || rec.dirtyGeo || (rec.mref !== o.material && (Array.isArray(o.material) || Array.isArray(rec.mref)));
if (gone) { destroyParts(rec); rec.dirtyGeo = false; buildParts(o, rec, vis); rec.mref = o.material; rec.geoRef = o.geometry; rec.matrix.set(o.matrixWorld.elements); rec.fbits = flagBits(o, vis); rec.fro = o.renderOrder ?? 0; stats.updated++; return; }
const fb = flagBits(o, vis), fro = o.renderOrder ?? 0, flagsChanged = fb !== rec.fbits || fro !== rec.fro, moved = !eqArr(rec.matrix, o.matrixWorld.elements);
const f = flagsChanged || o.isInstancedMesh ? nodeFlags(o, vis) : null;
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
if (flagsChanged) Object.assign(u, f);
if (swapped) { const me = ensureMaterial(o.material); me.users.add(rec); mats.get(p.mat)?.users.delete(rec); p.mat = o.material; u.material = me.id; rec.mref = o.material; }
if (o.isInstancedMesh) {
if (moved || p.instV !== o.instanceMatrix.version || p.instCount !== o.count) { backend.updateInstances(p.node, instanceMats(o), o.count, Array.from(o.matrixWorld.elements)); p.instV = o.instanceMatrix.version; p.instCount = o.count; stats.updated++; }
}
if (Object.keys(u).length) { backend.updateNode(p.node, u); stats.updated++; }
// refresh material conversion (property edits) — cheap, once per material per frame (epoch-gated inside)
ensureMaterial(p.mat);
}
if (moved) rec.matrix.set(o.matrixWorld.elements);
rec.fbits = fb; rec.fro = fro;
}
function destroyExpanded(p) { for (const n of p.expanded) backend.removeNode(n); }

return {
stats,
// mirror `scene` (+ camera) into the backend. Call once per frame before backend.renderFrame().
sync(scene, camera = null) {
const t0 = now();
skinMs = 0; skinCalls = 0;
epoch++; stats.frames++; frameScene = scene; frameCamera = camera;
if (updateMatrices) scene.updateMatrixWorld(true);
const t1 = now();
const seen = new Set();
amb.sky.fill(0); amb.ground.fill(0); amb.n = 0;
visit(scene, true, seen);
syncEnvironment(scene);
const t2 = now();
for (const [o, rec] of recs) if (!seen.has(o)) { destroyParts(rec); recs.delete(o); }
for (const [o, r] of skinRecs) if (!seen.has(o)) { destroySkinned(r); skinRecs.delete(o); }
for (const [o, r] of lights) if (!seen.has(o)) { backend.removeLight(r.id); lights.delete(o); stats.removed++; }
gc();
const t3 = now();
syncLiveUniforms();
if (camera) {
if (updateMatrices) camera.updateMatrixWorld?.();
const view = Array.from(camera.matrixWorldInverse?.elements ?? []), proj = Array.from(camera.projectionMatrix?.elements ?? []);
const sig = `${view}|${proj}`;
if (view.length === 16 && proj.length === 16 && sig !== cameraSig) { backend.setCamera(view, proj); cameraSig = sig; stats.updated++; }
}
const t4 = now();
// last-frame phase breakdown (ms): matrixWorld (three's own updateMatrixWorld, 0 when updateMatrices=false) · visit (per-object diff + backend calls) · sweep (removed objects + gc) · camera/live uniforms
stats.phase = { matrixWorld: t1 - t0, visit: t2 - t1, sweep: t3 - t2, camera: t4 - t3, total: t4 - t0, backendSkinUpload: skinMs, skinUploads: skinCalls };
},
dispose() { for (const [, rec] of recs) destroyParts(rec); recs.clear(); for (const [, r] of skinRecs) destroySkinned(r); skinRecs.clear(); for (const [, r] of lights) backend.removeLight(r.id); lights.clear(); gc(); },
};
}
