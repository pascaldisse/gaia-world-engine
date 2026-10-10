// render-api/scene-adapter.js — mirrors a three.js scene graph into render-api calls (RENDER-API.md §4a). NO three import:
// objects are duck-typed (isMesh/isInstancedMesh/isBatchedMesh/isLight/isCamera…), so it works on the engine-INJECTED
// `three` namespace (ctx.three) and on real imports alike. Games keep mutating three objects; sync() diffs per frame.
//
// Change tracking (no full re-upload): matrixWorld compared 16 floats vs last sent · visible/castShadow/receiveShadow/renderOrder
// compared · geometry: attribute.version + index.version (+ draw range) · material: params tuple compared (cheap, once per
// distinct material per frame) + texture.version · InstancedMesh: instanceMatrix.version + count · removal: epoch sweep.
// Optional backend methods (interface.js OPTIONAL_METHODS): createInstanced/updateInstances, updateMesh, updateMaterial,
// createShaderMaterial. Missing ones degrade loudly through `stats.degraded` (never silent): see below.
import { materialToParams, materialSig, customNodeMaterial } from './material-map.js';
import { IDENTITY_MAT4 } from './interface.js';
import { observeLights } from './light-registry.js';
import { readTexture, readCube, shIrradiance } from './env-image.js';

const MAT_EPS = 0;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export function createSceneAdapter(backend, { exportNodeMaterial = null, three = null, updateMatrices = true, tslOptions = {}, nativeInstancing = true, recvVariants: useRecvVariants = false, dbgNoAlphaCast = false, dbgNoCast = false, pointsViewportHeight = 720 } = {}) {
// nativeInstancing=false (A/B probe): ignore backend.createInstanced/updateInstances → per-instance expansion (degraded path)
const nativeInst = () => nativeInstancing && typeof backend.createInstanced === 'function' && typeof backend.updateInstances === 'function';
const recs = new Map();        // Object3D → rec { parts:[{node,geoKey,mat,matSig}], matrix:Float64Array, flags, inst? }
const geos = new Map();        // geometry → { id, sig, users:Set<rec> }  (key = geometry object; uuid dedup is implicit)
const mats = new Map();        // material → { id, sig, epoch, params, users:Set }
const lights = new Map();      // Light → { id, kind, sig }
const stats = { frames: 0, created: 0, updated: 0, removed: 0, uploadsGeometry: 0, updatedBy: {}, degraded: new Set(), unsupported: new Set() };
// r6-tsl: every TSL NodeMaterial is accounted: ok (shader material created) | refused (stage + normalised reason; material drawn as PBR) | attribute gaps (draw skipped by the core).
const sub = stats.sub = { updateShaderBuffers: 0, liveUpdate: 0, liveMats: 0, setShaderUniforms: 0, ensureMaterial: 0, feedMeshAttrs: 0, exportCalls: 0, materialToParams: 0 }; // r10: cumulative per-stage ms (stats.sub / frames = per-frame)
const tsl = stats.tsl = { ok: 0, refused: 0, byReason: {}, samples: {}, detail: {}, missingAttr: {}, attrUploads: 0, instAttrRows: 0 };
const normReason = (r) => String(r).replace(/\s+/g, ' ').replace(/0x[0-9a-f]+|\b\d+\b/gi, 'N').slice(0, 160);
function tslRefuse(m, stage, reason, pkg = null) {
  const key = `${stage}: ${normReason(reason)}`;
  tsl.refused++; tsl.byReason[key] = (tsl.byReason[key] ?? 0) + 1;
  if (pkg && !(key in tsl.detail)) tsl.detail[key] = { bindings: pkg.bindGroups.map((g) => ({ g: g.group, b: g.bindings.map((b) => `${b.kind}:${b.name}:${b.stage}`) })), attrs: pkg.attributes.map((a) => `${a.name}:${a.type}:${a.source}${a.instanced ? ':inst' : ''}`), storageSrc: (pkg.fragment.match(/.*var<storage.*/g) ?? []).concat(pkg.vertex.match(/.*var<storage.*/g) ?? []).slice(0, 4) };
if (!(key in tsl.samples)) { tsl.samples[key] = `${m.name || m.type || '?'} (${m.uuid.slice(0, 8)})`; console.warn(`[render-api] TSL material REFUSED → PBR fallback (${key}) first: ${tsl.samples[key]}`); }
}
// geometry/node attribute feed for a material's non-core vertex attributes (uv1, colour, custom, node buffers). Core attrs (position/normal/uv) ride the mesh.
const CORE_ATTRS = new Set(['position', 'normal', 'uv']);
function attrFloats(at, items) {
  if (!at.isInterleavedBufferAttribute && at.itemSize === items && at.array instanceof Float32Array) return at.array;
  const out = new Float32Array(at.count * items);
  for (let i = 0; i < at.count; i++) { out[i * items] = at.getX(i); if (items > 1) out[i * items + 1] = at.getY(i); if (items > 2) out[i * items + 2] = at.getZ(i); if (items > 3) out[i * items + 3] = at.getW(i); }
  return out;
}
const TYPE_ITEMS = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
function feedMeshAttrs(gp, g, me, m) {
  const pkg = me.conv?.kind === 'wgsl' && !me.fellBack ? me.conv.package : null;
  if (!pkg || !backend.setMeshAttribute) return;
  gp.attrVer ??= new Map();
  for (const a of pkg.attributes) {
    if (a.instanced || (a.source === 'geometry' && CORE_ATTRS.has(a.name))) continue;
    const at = a.source === 'node' ? pkg.attributeSources?.[a.key] : g.attributes?.[a.name];
    if (!at) { const k = `${m.name || m.type}:${a.name}`; if (!(k in tsl.missingAttr)) { tsl.missingAttr[k] = 'geometry lacks attribute'; console.warn(`[render-api] TSL attribute missing → draws SKIPPED: material ${k}`); } continue; }
    const ver = `${at.version}:${at.count}`;
    if (gp.attrVer.get(a.key) === ver) continue;
    try { backend.setMeshAttribute(gp.id, a.key, TYPE_ITEMS[a.type] ?? at.itemSize, attrFloats(at, TYPE_ITEMS[a.type] ?? at.itemSize)); gp.attrVer.set(a.key, ver); tsl.attrUploads++; }
    catch (e) { const k = `${m.name || m.type}:${a.name}`; tsl.missingAttr[k] = String(e.message ?? e).slice(0, 120); console.warn(`[render-api] TSL attribute upload FAILED: ${k}: ${tsl.missingAttr[k]}`); gp.attrVer.set(a.key, ver); }
  }
}
// per-INSTANCE rows (instancedBufferAttribute of an InstancedMesh, expanded to one backend instance each): { key: Float32Array(items) } for row i
function instAttrRow(me, i) {
  const pkg = me.conv?.kind === 'wgsl' && !me.fellBack ? me.conv.package : null;
  if (!pkg) return null;
  let out = null;
  for (const a of pkg.attributes) {
    if (!a.instanced) continue;
    const at = pkg.attributeSources?.[a.key]; if (!at) continue;
    const items = TYPE_ITEMS[a.type] ?? at.itemSize, row = new Float32Array(items);
    if (!at.isInterleavedBufferAttribute && at.array) for (let k = 0; k < items; k++) row[k] = at.array[i * at.itemSize + k] ?? 0;
    else { row[0] = at.getX(i); if (items > 1) row[1] = at.getY(i); if (items > 2) row[2] = at.getZ(i); if (items > 3) row[3] = at.getW(i); }
    (out ??= {})[a.key] = row; tsl.instAttrRows++;
  }
  return out;
}
const instAttrSig = (me) => { const pkg = me.conv?.kind === 'wgsl' && !me.fellBack ? me.conv.package : null; let s = ''; if (pkg) for (const a of pkg.attributes) if (a.instanced) s += `${pkg.attributeSources?.[a.key]?.version ?? ''},`; return s; };
let epoch = 0, cameraSig = ''; let lightSetSig = null, lightGen = 0, lightGenSfx = '';
// r6: HemisphereLight/AmbientLight accumulate per frame into one irradiance pair (sum = three: every light node `+=` into context.irradiance); scene.background -> setBackground
const amb = { sky: [0, 0, 0], ground: [0, 0, 0], n: 0, sig: null, bgSig: null };
// every backend-visible change is attributed (stats.updatedBy[reason]) — names the per-frame dirty source on a live scene; idle frame = no increments
const upd = (why) => { stats.updated++; stats.updatedBy[why] = (stats.updatedBy[why] ?? 0) + 1; };

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
if (backend.updateMesh) { backend.updateMesh(p.id, arrays); p.sig = sig; stats.uploadsGeometry++; upd('geometry'); }
else { // degrade: new mesh, users re-created by caller (flag)
stats.degraded.add('updateMesh-missing:recreate');
const old = p.id; p.id = backend.createMesh(arrays); p.sig = sig; p.stale = old; p.attrVer = null; stats.uploadsGeometry++;
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
  let batch = null;
  for (const [, e] of mats) {
    const wg = e.conv?.kind === 'wgsl' && !e.fellBack && e.epoch === epoch;
if (wg && backend.updateShaderBuffers) { const tb = now(); const n = backend.updateShaderBuffers(e.id); sub.updateShaderBuffers += now() - tb; if (n) stats.bufferWrites = (stats.bufferWrites ?? 0) + n; } // r6-tsl-2: storage buffers follow BufferAttribute.version
const live = wg ? e.conv.package?.live : null;
if (!live) continue;
    const tl = now(); sub.liveMats++;
    const changed = live.update({ scene: frameScene, camera: frameCamera ?? undefined, frameToken: epoch });
    sub.liveUpdate += now() - tl;
    if (!changed.length) continue;
    const ts = now();
    if (backend.setShaderUniformsBatch) { (batch ??= []).push([e.id, changed]); stats.uniformWrites = (stats.uniformWrites ?? 0) + changed.length; } // r10-5: one backend call per frame
    else if (backend.setShaderUniforms) { backend.setShaderUniforms(e.id, changed); stats.uniformWrites = (stats.uniformWrites ?? 0) + changed.length; }
    else stats.degraded.add('setShaderUniforms-missing:tsl-values-frozen');
    sub.setShaderUniforms += now() - ts;
  }
  if (batch) { const ts = now(); backend.setShaderUniformsBatch(batch); sub.setShaderUniforms += now() - ts; }
}
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
// r10-shadow-4: three semantics are per OBJECT (object.receiveShadow) but a TSL package is per MATERIAL → a custom-TSL material used by receivers gets its own export (variant key = Object.create(material), reads through live); non-receivers keep the base entry.
const recvVariants = new WeakMap();
const recvAny = new WeakSet();
// lampas L-wgpu-tex: object.userData.dsChrLight (character mesh) -> a per-material VARIANT whose userData reads through live + dsChrLight:true (core flag is per MATERIAL; DS1 chr LightBank = character-only extra directional lights).
const chrVariants = new WeakMap();
function chrKey(src) { let v = chrVariants.get(src); if (!v) { v = Object.create(src); Object.defineProperty(v, '__gwSrc', { value: src }); v.userData = Object.create(src.userData ?? {}); v.userData.dsChrLight = true; chrVariants.set(src, v); } return v; }
function matKey(m0, o) {
let src = m0?.__gwSrc ?? m0;
if (o?.userData?.dsChrLight && src && !src.userData?.dsChrLight && !(src.isNodeMaterial && customNodeMaterial(src))) return chrKey(src);
if (!useRecvVariants || !o || !o.receiveShadow || !exportNodeMaterial || !src?.isNodeMaterial || !customNodeMaterial(src)) return src;
let v = recvVariants.get(src); if (!v) { v = Object.create(src); Object.defineProperty(v, '__gwSrc', { value: src }); recvVariants.set(src, v); }
return v;
}
function ensureMaterial(m0, o = null) {
const m = matKey(m0, o);
let e = mats.get(m);
const srcM = m0?.__gwSrc ?? m0; // r10-shadow-5 latch (see below): flips BEFORE the once-per-frame early return so a receiver visited after a non-receiver still re-exports
if (!useRecvVariants && o?.receiveShadow && exportNodeMaterial && srcM?.isNodeMaterial && !recvAny.has(srcM)) { recvAny.add(srcM); if (e) e.epoch = -1; }
if (e && e.epoch === epoch) return e;                       // once per material per frame (was: once per MESH per frame)
// r10-shadow-5: a TSL package is per MATERIAL, three's receiveShadow per OBJECT. Package = receiver as soon as ANY user object receives (one-way latch, <=1 re-export per material) -- NOT the first user's flag (road: 13 receivers / 85 non-receivers, first exporter a non-receiver -> never received). Same 'mixed = receives' rule as the core's per-material flag (r8).
const anyRecv = recvAny.has(srcM);
const sig0 = materialSig(m, { exportNodeMaterial });
const sigSfx = (anyRecv ? '|rcv' : '') + (sig0.startsWith('wgsl:') ? lightGenSfx : ''); // r15b: a TSL package bakes the scene's light SET at export (LightsNode) -> light add/remove re-exports it (visibility/intensity ride the live uniforms)
const sig = sig0 + sigSfx;          // cheap string, no params/texture work
if (e && e.sig === sig) { e.epoch = epoch; if (e.degraded) stats.degraded.add(e.degraded); if (e.conv?.unsupported) for (const u of e.conv.unsupported) stats.unsupported.add(u); return e; } // idle frame: 0 texture work
const exportCtx = o ? (o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || (anyRecv && !o.receiveShadow) ? { geometry: o.geometry } : { object: o }) : {};
if (o) { exportCtx.receiveShadow = anyRecv || !!o.receiveShadow; exportCtx.castShadow = !!o.castShadow; }
sub.exportCalls++; const tmp = now(); const conv = materialToParams(m, { three, exportNodeMaterial, tslOptions: { ...tslOptions, ...exportCtx, scene: frameScene, camera: frameCamera ?? tslOptions.camera } });
{ const dt = now() - tmp; sub.materialToParams += dt; // r10-2 counters: why did this export run? (newMat / versionBump = same material, version moved / sigChange) + structural key = hash of generated WGSL
 const x = stats.exportWhy ??= { newMat: 0, versionBump: 0, sigChange: 0, ms: { newMat: 0, versionBump: 0, sigChange: 0 }, keys: new Map(), log: [] };
 const why = !e ? 'newMat' : (conv.kind === 'wgsl' && e.conv?.kind === 'wgsl' ? 'versionBump' : 'sigChange'); x[why]++; x.ms[why] += dt;
 if (conv.package) { const k = conv.package.vertex.length + ':' + conv.package.fragment.length + ':' + hashStr(conv.package.vertex + conv.package.fragment); const r = x.keys.get(k) ?? { n: 0, ms: 0, name: m.name || m.type }; r.n++; r.ms += dt; x.keys.set(k, r); }
 if (x.log.length < 40) x.log.push({ why, ms: +dt.toFixed(1), name: m.name || m.type, ver: m.version }); }
if (conv.tslRefused) tslRefuse(m, conv.tslRefused.stage, conv.tslRefused.reason);
if (conv.unsupported) for (const u of conv.unsupported) stats.unsupported.add(u); // r13-bc: refused/unreadable textures (material-map), recorded not silent
if (!e) {
const id = createMat(conv, m);
e = { id, sig: conv.sig + sigSfx, conv, users: new Set(), epoch, degraded: conv.degraded, first: o ? { name: o.name, recv: !!o.receiveShadow } : null };
e.fellBack = !!conv.fellBack;
mats.set(m, e); stats.created++;
} else {
if (conv.kind === 'pbr' && e.conv.kind === 'pbr' && backend.updateMaterial) { backend.updateMaterial(e.id, conv.params, conv.textures); }
else { // swap handle on every user
const old = e.id; e.id = createMat(conv, m); e.fellBack = !!conv.fellBack;
for (const u of e.users) { if (u.parts) { for (const part of u.parts) if (part.mat === m && part.node) backend.updateNode(part.node, { material: e.id }); } else if (u.node && u.mat === m) backend.updateNode(u.node, { material: e.id }); }
backend.destroyMaterial(old);
}
e.sig = conv.sig + sigSfx; e.conv = conv; e.degraded = conv.degraded; e.epoch = epoch; upd('material');
}
if (conv.degraded) stats.degraded.add(conv.degraded);
if (backend.drainUnsupported) for (const u of backend.drainUnsupported()) stats.unsupported.add(u); // r13-bc: backend-side texture upload refusals
return e;
}
function createMat(conv, m) {
if (conv.kind === 'wgsl') {
  if (backend.createShaderMaterial) {
    try { const id = backend.createShaderMaterial(conv.package); tsl.ok++; if (conv.package.fragment.includes('gaia_sun_shadow')) tsl.shadowReceivers = (tsl.shadowReceivers ?? 0) + 1; return id; }
    catch (e) { tslRefuse(m, 'backend', e?.message ?? e, conv.package); stats.degraded.add('tsl-backend-refused:pbr-fallback'); conv.fellBack = true; return backend.createMaterial(conv.fallbackParams ?? {}, conv.fallbackTextures ?? null); }
  }
  stats.degraded.add('createShaderMaterial-missing:pbr-fallback');
  conv.fellBack = true;
  return backend.createMaterial(conv.fallbackParams ?? {}, null);
}
return backend.createMaterial(conv.params, conv.textures);
}

// r10: an object the MAIN camera's layers exclude but that casts (three: it renders only in the shadow pass, when a shadow camera's layers include it) = SHADOW-ONLY caster: sent visible + shadowOnly (depth-only, never in the main passes).
// shadowMask = OR of the sun's cascade-camera layer masks when three has built them (a mask of exactly layer 0 adopts the main camera's mask, as ShadowNode does); null = unknown -> a layer-gated caster is assumed to be meant for the shadow pass.
let shadowMask = null;
const isShadowOnly = (o) => !!o.castShadow && !!frameCamera?.layers && !!o.layers && !o.layers.test(frameCamera.layers) && (shadowMask === null || (o.layers.mask & shadowMask) !== 0);
// r10-shadow-11 DEBUG bisect (?wgpuDbgNoAlphaCast=1): objects whose material has alphaTest>0 do NOT cast -> isolates 'alpha-tested lattice casts as solid' (core casts package materials opaque)
const dbgCast = (o) => !!o.castShadow && !dbgNoCast && !(dbgNoAlphaCast && (Array.isArray(o.material) ? o.material : [o.material]).some((m) => m?.alphaTest > 0));
// r18-perf: static shadow-cache hints (three semantics): userData.static boolean = explicit; matrixAutoUpdate===false = hint (starts static, a move demotes it). Everything else = backend auto (static only once settled).
const staticFlags = (o) => (typeof o.userData?.static === 'boolean' ? { static: o.userData.static } : o.matrixAutoUpdate === false ? { staticHint: true } : null);
const nodeFlags = (o, vis) => ({ castShadow: dbgCast(o), receiveShadow: !!o.receiveShadow, visible: vis, renderOrder: o.renderOrder ?? 0, ...(isShadowOnly(o) ? { shadowOnly: true } : null), ...staticFlags(o) });
const flagBits = (o, vis) => (dbgCast(o) ? 1 : 0) | (o.receiveShadow ? 2 : 0) | (vis ? 4 : 0) | (isShadowOnly(o) ? 8 : 0) | (typeof o.userData?.static === 'boolean' ? (o.userData.static ? 16 : 32) : 0); // + renderOrder compared separately (no string alloc)

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
const mk = matKey(m, o);
const me = ensureMaterial(mk, o);
me.users.add(rec);
feedMeshAttrs(gp, g, me, m);
const flags = nodeFlags(o, vis);
const part = { geo: g, geoKey: `${start}:${count}`, start, count, mat: mk, flags, node: 0, gp };
if (o.isInstancedMesh) {
// native instance blocks carry matrix + colour only; a TSL material reading per-INSTANCE custom attributes takes the expanded path (rows per instance)
const hasInstAttrs = (me) => { const pkg = me?.conv?.kind === 'wgsl' && !me.fellBack ? me.conv.package : null; return !!pkg?.attributes?.some((a) => a.instanced); };
if (nativeInst() && !hasInstAttrs(me)) { part.pk = {}; const pkx = packInst(o, part.pk, isPremult(m)); part.node = backend.createInstanced(gp.id, me.id, instanceMats(o, part.pk), o.count, { ...flags, dynamic: o.instanceMatrix.usage === 35048 /* THREE.DynamicDrawUsage -> core dynamic block path */, matrix: Array.from(o.matrixWorld.elements), ...(pkx.colors ? { colors: pkx.colors, colorStride: 4 } : {}) }); if (pkx.uvs) { if (backend.setInstanceUvs) { backend.setInstanceUvs(part.node, pkx.uvs); part.hasUv = true; } else stats.unsupported.add('instanceUv:no-backend-setInstanceUvs'); } part.instV = o.instanceMatrix.version; part.instC = instVers(o); part.instCount = o.count; }
else { stats.degraded.add(nativeInst() ? 'instanced-custom-attrs:expanded-per-instance' : 'createInstanced-missing:expanded-per-instance'); part.expanded = []; for (let i = 0; i < o.count; i++) part.expanded.push(backend.createInstance(gp.id, me.id, instanceWorld(o, i), { ...flags, instAttrs: instAttrRow(me, i) })); part.instV = o.instanceMatrix.version; part.instCount = o.count; part.instSig = instAttrSig(me); }
} else part.node = backend.createInstance(gp.id, me.id, Array.from(o.matrixWorld.elements), flags);
rec.parts.push(part); stats.created++;
}
return rec.parts.length > 0;
}
// nt-dyninst: live-range view [0,count*16) cached per (array,count) in `st` (the part's pk scratch) -> no per-frame view allocation while the count is steady
const instanceMats = (o, st) => { const a = o.instanceMatrix.array, n = o.count * 16; if (!st) return a.subarray(0, n); if (st.mArr !== a || st.mats?.length !== n) { st.mArr = a; st.mats = a.subarray(0, n); } return st.mats; };
// ---- r19-pcol per-instance render attributes of an InstancedMesh (all ride the ONE native block; conventions, generic, no game names):
//   instanceColor (setColorAt)           rgb itemSize 3 = colour multiply; itemSize 4 = rgba (alpha = per-instance opacity)
//   geometry attribute 'instanceOpacity' itemSize 1 InstancedBufferAttribute = per-instance opacity, MULTIPLIED with instanceColor.a
//   geometry attribute 'instanceUv'      itemSize 4 InstancedBufferAttribute = (offsetU, offsetV, scaleU, scaleV): uv' = uv*scale + offset (flipbook / atlas cell)
// colour+opacity pack into ONE rgba Float32Array (core slot @location(9), multiplies base colour rgb+alpha); uv is passed as-is (core slot @location(10)).
// Material premultiplied blending (Custom One/OneMinusSrcAlpha): rgb is pre-scaled by the pack alpha so opacity fades the whole premultiplied sample.
// Partial updates: each attribute's own version + updateRanges (r180 addUpdateRange) -> only the touched instances are re-packed (ranges consumed + cleared here); no ranges = full re-pack.
const INST_OPACITY = 'instanceOpacity', INST_UV = 'instanceUv';
const isPremult = (m) => m?.blending === 5 && m.blendSrc === 201 && m.blendDst === 205;
const instVers = (o) => { const a = o.geometry?.attributes; return `${o.instanceColor?.version ?? -1}:${a?.[INST_OPACITY]?.version ?? -1}:${a?.[INST_UV]?.version ?? -1}:${o.count}`; };
function instRanges(at, n, out) { // at.updateRanges (element units) -> instance index ranges merged into out ([s,e) pairs); false = unknown/full
  const rs = at.updateRanges; if (!rs?.length) return false;
  for (const r of rs) out.push(Math.max(0, Math.floor(r.start / at.itemSize)), Math.min(n, Math.ceil((r.start + r.count) / at.itemSize)));
  return true;
}
function packInst(o, st, premult) {
  const n = o.count, ic = o.instanceColor, op = o.geometry?.attributes?.[INST_OPACITY], uv = o.geometry?.attributes?.[INST_UV];
  let colors = null, uvs = null;
  if (ic || op) {
    const need = !st.col || st.col.length !== n * 4 || st.premult !== premult || st.hasIc !== !!ic || st.hasOp !== !!op;
    const ranges = []; let full = need;
    if (!full && ic && ic.version !== st.vIc) full = !instRanges(ic, n, ranges);
    if (!full && op && op.version !== st.vOp) full = !instRanges(op, n, ranges);
    if (full) { // nt-dyninst: grow-only scratch (capacity doubling); `st.col` = live-range [0,n*4) view only (the wire sends exactly the view, nothing beyond count)
  if (!st.buf || st.buf.length < n * 4) st.buf = new Float32Array(Math.max(n * 4, (st.buf?.length ?? 0) * 2, 64));
  if (!st.col || st.col.length !== n * 4 || st.col.buffer !== st.buf.buffer) st.col = st.buf.subarray(0, n * 4);
  ranges.length = 0; ranges.push(0, n);
}
    const col = st.col, ia = ic?.array, is = ic?.itemSize ?? 0, oa = op?.array, os = op?.itemSize ?? 1;
    for (let r = 0; r < ranges.length; r += 2) for (let i = ranges[r]; i < ranges[r + 1]; i++) {
      let a = (is >= 4 ? ia[i * is + 3] : 1) * (oa ? oa[i * os] : 1);
      const k = premult ? a : 1, j = i * 4;
      col[j] = (ia ? ia[i * is] : 1) * k; col[j + 1] = (ia ? ia[i * is + 1] : 1) * k; col[j + 2] = (ia ? ia[i * is + 2] : 1) * k; col[j + 3] = a;
    }
    ic?.clearUpdateRanges?.(); op?.clearUpdateRanges?.();
    st.premult = premult; st.hasIc = !!ic; st.hasOp = !!op; st.vIc = ic?.version; st.vOp = op?.version; colors = col;
  }
  if (uv && uv.itemSize === 4 && uv.array instanceof Float32Array) { if (st.uvArr !== uv.array || st.uvs?.length !== n * 4) { st.uvArr = uv.array; st.uvs = uv.array.subarray(0, n * 4); } uvs = st.uvs; uv.clearUpdateRanges?.(); }
  return { colors, colorStride: 4, uvs };
}
const instColors = (o, st, premult) => { const p = packInst(o, st, premult); return p.colors ? { colors: p.colors, colorStride: 4 } : {}; };
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

// lane dynlight: directional lights -> core. primary = the shadow caster (else the strongest) -> setSun; the rest (<= MAX) -> setExtraDirs (unshadowed). Before this the core kept ONE sun and every
// further DirectionalLight silently overwrote it (DS1 characters = 3 directional + hemisphere: 2 of 3 lost). sunRec = { id, sig }.
let seen_dirs = [], sunRec = null, xdirSig = '';
const updShadowMask = (o) => { const sl = o.shadow?.shadowNode?.lights; if (sl?.length && o.castShadow) { let m = 0; const cm0 = frameCamera?.layers?.mask ?? 1; for (const l of sl) { const cm = l.shadow?.camera?.layers?.mask ?? 1; m |= cm === 1 ? cm0 : cm; } shadowMask = m; } else shadowMask = null; }
const MAX_EXTRA_DIRS = 4;
function dirInfo(x) {
const o = x.o, d = [o.position.x - (o.target?.position.x ?? 0), o.position.y - (o.target?.position.y ?? 0), o.position.z - (o.target?.position.z ?? 0)];
const len = Math.hypot(...d) || 1; return { ...x, dir: d.map((v) => v / len), power: x.vis ? (o.intensity ?? 0) * Math.max(...x.c) : 0 };
}
function syncDirs() {
const L = seen_dirs.map(dirInfo); seen_dirs = [];
let pi = L.findIndex((x) => x.vis && x.o.castShadow && x.power > 0); if (pi < 0) { let best = -1; L.forEach((x, i) => { if (x.vis && x.power > best) { best = x.power; pi = i; } }); }
const prim = pi >= 0 ? L[pi] : null;
if (prim) {
const o = prim.o;
const sun = { direction: prim.dir, color: prim.c, intensity: prim.vis ? o.intensity : 0, castShadow: !!o.castShadow }, sig = `${prim.dir}|${prim.c}|${o.intensity}|${o.castShadow}`;
if (!sunRec) { sunRec = { id: backend.setSun(sun), sig }; stats.created++; } else if (sunRec.sig !== sig) { backend.removeLight(sunRec.id); sunRec.id = backend.setSun(sun); sunRec.sig = sig; upd('sun'); }
} else if (sunRec) { backend.removeLight(sunRec.id); sunRec = null; stats.removed++; shadowMask = null; }
const xs = L.filter((x, i) => i !== pi && x.power > 0).sort((a, b) => b.power - a.power).slice(0, MAX_EXTRA_DIRS);
if (L.filter((x, i) => i !== pi && x.power > 0).length > MAX_EXTRA_DIRS) stats.degraded.add(`DirectionalLight>${MAX_EXTRA_DIRS + 1}:extras-dropped`);
const packed = new Float32Array(xs.length * 7); xs.forEach((x, i) => packed.set([-x.dir[0], -x.dir[1], -x.dir[2], ...x.c, x.o.intensity], i * 7)); // dir the light TRAVELS (core), adapter dir = toward the light
const sig = Array.from(packed).join(',');
if (sig !== xdirSig) { backend.setExtraDirs(packed); xdirSig = sig; upd('extraDirs'); }
}
function syncLight(o, vis) {
let r = lights.get(o);
const c = o.color ? [o.color.r, o.color.g, o.color.b] : [1, 1, 1];
if (o.isDirectionalLight && backend.setExtraDirs) { updShadowMask(o); seen_dirs.push({ o, c, vis }); return; } // lane dynlight: the core has ONE shadowed sun + <=4 unshadowed extra directionals -> resolved after the walk (syncDirs)
if (o.isDirectionalLight) {
{ const sl = o.shadow?.shadowNode?.lights; if (sl?.length && o.castShadow) { let m = 0; const cm0 = frameCamera?.layers?.mask ?? 1; for (const l of sl) { const cm = l.shadow?.camera?.layers?.mask ?? 1; m |= cm === 1 ? cm0 : cm; } shadowMask = m; } else shadowMask = null; }
const d = [o.position.x - (o.target?.position.x ?? 0), o.position.y - (o.target?.position.y ?? 0), o.position.z - (o.target?.position.z ?? 0)];
const len = Math.hypot(...d) || 1; const dir = d.map((v) => v / len);
const sig = `${dir}|${c}|${o.intensity}|${o.castShadow}|${vis}`;
if (!r) { lights.set(o, { id: backend.setSun({ direction: dir, color: c, intensity: vis ? o.intensity : 0, castShadow: !!o.castShadow }), kind: 'sun', sig }); stats.created++; }
else if (r.sig !== sig) { // interface has no updateSun: recreate (removeLight exists for all LightIds)
backend.removeLight(r.id); r.id = backend.setSun({ direction: dir, color: c, intensity: vis ? o.intensity : 0, castShadow: !!o.castShadow }); r.sig = sig; upd('sun'); }
return;
}
if (o.isPointLight) {
const e = o.matrixWorld.elements, pos = [e[12], e[13], e[14]];
const p = { position: pos, color: c, intensity: vis ? o.intensity : 0, distance: o.distance ?? 0, decay: o.decay ?? 2 };
if (o.userData?.pointRampBegin != null) p.rampBegin = o.userData.pointRampBegin; // lane dynlight: DS1 point ramp sat((R-d)/(R-begin)) (docs/DS-LIGHTING-SHADERS.md s5), R = distance; three has no such term -> only backends that implement it (wgpu core) honour it
const sig = JSON.stringify(p);
if (!r) { lights.set(o, { id: backend.addPointLight(p), kind: 'point', sig }); stats.created++; }
else if (r.sig !== sig) { backend.updatePointLight(r.id, p); r.sig = sig; upd('pointLight'); }
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
const skMat = matKey(Array.isArray(o.material) ? o.material[0] : o.material, o);
const me = ensureMaterial(skMat, o);
const node = backend.createInstance(mesh, me.id, IDENTITY_MAT4.slice(), nodeFlags(o, vis));
const rr = {}; me.users.add(rr);
r = Object.assign(rr, { geo: g, ver: attrVer(g), nb, mref: o.material, skin, mesh, node, mat: skMat, pal: new Float32Array(nb * 16), fbits: flagBits(o, vis), fro: o.renderOrder ?? 0, sk, lastWorld: new Float64Array(16).fill(NaN), lastBind: new Float64Array(16).fill(NaN), seenSkel: -1 });
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
const ts0 = now(); backend.updateSkin(r.skin, pal); skinMs += now() - ts0; skinCalls++; upd('skin'); stats.skinUploads = (stats.skinUploads ?? 0) + 1;
}
const fb = flagBits(o, vis), fro = o.renderOrder ?? 0;
if (fb !== r.fbits || fro !== r.fro) { backend.updateNode(r.node, nodeFlags(o, vis)); r.fbits = fb; r.fro = fro; upd('skinFlags'); }
ensureMaterial(r.mat, o);
}
function destroySkinned(r) { mats.get(r.mat)?.users.delete(r); backend.removeNode(r.node); backend.destroySkinnedMesh?.(r.mesh); backend.destroySkin?.(r.skin); stats.removed++; }
// ---- BatchedMesh: one native instance block per geometryIndex (shared material); per-geometry vertex/index slice uploaded ONCE (geometryInfo is append-only),
// matrices/colors/visibility re-packed only when matricesTexture/colorsTexture version, visibility bits or the instance table changed.
const batchRecs = new Map();
// ---- r18: THREE.Sprite (Object3D, NOT isMesh; used by hit bursts / glow cards). Translated to ONE shared unit quad instance whose matrix is the camera-facing billboard (three sprite shader: scale from matrixWorld, material.rotation, center, sizeAttenuation=false => scale *= view depth under perspective) ----
const spriteRecs = new Map();
let spriteMesh = 0;
const SPRITE_M = new Float64Array(16);
function spriteQuad() { return spriteMesh ||= backend.createMesh({ positions: Float32Array.of(-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1), uvs: Float32Array.of(0, 0, 1, 0, 1, 1, 0, 1), indices: Uint32Array.of(0, 1, 2, 0, 2, 3) }); }
function spriteMatrix(o, out) {
 const cam = frameCamera?.matrixWorld?.elements; if (!cam) return false;
 const e = o.matrixWorld.elements, m = o.material;
 let sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]);
 const px = e[12], py = e[13], pz = e[14];
 const rl = Math.hypot(cam[0], cam[1], cam[2]) || 1, ul = Math.hypot(cam[4], cam[5], cam[6]) || 1, bl = Math.hypot(cam[8], cam[9], cam[10]) || 1;
 const R = [cam[0] / rl, cam[1] / rl, cam[2] / rl], U = [cam[4] / ul, cam[5] / ul, cam[6] / ul], B = [cam[8] / bl, cam[9] / bl, cam[10] / bl];
 const persp = frameCamera.isPerspectiveCamera ?? (frameCamera.projectionMatrix?.elements[11] === -1);
 if (m?.sizeAttenuation === false && persp) { const depth = (px - cam[12]) * -B[0] + (py - cam[13]) * -B[1] + (pz - cam[14]) * -B[2]; sx *= depth; sy *= depth; } // three: scale *= -mvPosition.z
 const rot = m?.rotation ?? 0, c = Math.cos(rot), s = Math.sin(rot);
 const c0 = [sx * (c * R[0] + s * U[0]), sx * (c * R[1] + s * U[1]), sx * (c * R[2] + s * U[2])];
 const c1 = [sy * (-s * R[0] + c * U[0]), sy * (-s * R[1] + c * U[1]), sy * (-s * R[2] + c * U[2])];
 const cx = (o.center?.x ?? 0.5) - 0.5, cy = (o.center?.y ?? 0.5) - 0.5; // quad spans [-.5,.5]; three offsets by (center - .5)
 out.set([c0[0], c0[1], c0[2], 0, c1[0], c1[1], c1[2], 0, B[0], B[1], B[2], 0, px - cx * c0[0] - cy * c1[0], py - cx * c0[1] - cy * c1[1], pz - cx * c0[2] - cy * c1[2], 1]);
 return true;
}
function syncSprite(o, vis) {
 if (!o.material) return;
 let rec = spriteRecs.get(o);
 const me = ensureMaterial(o.material, o);
 if (!spriteMatrix(o, SPRITE_M)) return;
 const mat = Array.from(SPRITE_M), ro = o.renderOrder ?? 0, v = vis && o.material.visible !== false;
 if (!rec) {
  rec = { mat: o.material, matId: me.id, vis: v, ro, m: SPRITE_M.slice(), node: backend.createInstance(spriteQuad(), me.id, mat, { castShadow: false, receiveShadow: false, visible: v, renderOrder: ro, static: false }) };
  me.users.add(rec); spriteRecs.set(o, rec); stats.created++; stats.sprites = (stats.sprites ?? 0) + 1; return;
 }
 if (rec.mat !== o.material) { mats.get(rec.mat)?.users.delete(rec); rec.mat = o.material; me.users.add(rec); }
 const u = {};
 if (me.id !== rec.matId) { u.material = me.id; rec.matId = me.id; }
 if (!eqArr(rec.m, SPRITE_M)) { u.mat4 = mat; rec.m.set(SPRITE_M); }
 if (v !== rec.vis) { u.visible = v; rec.vis = v; }
 if (ro !== rec.ro) { u.renderOrder = ro; rec.ro = ro; }
 for (const _ in u) { backend.updateNode(rec.node, u); upd('sprite'); break; }
}
function destroySprite(rec) { backend.removeNode(rec.node); mats.get(rec.mat)?.users.delete(rec); stats.removed++; }
// ---- r19-pcol: THREE.Points + PointsMaterial. ONE native instance block of the shared unit quad, one camera-facing billboard matrix per point (same basis as Sprite).
// size: PointsMaterial.size x optional per-point geometry attribute 'size' (itemSize 1). sizeAttenuation:true => world size = size / proj[5] (= size*tan(fov/2): three WebGL gl_PointSize=size*(H/2)/depth);
//   false => constant pixels (size px at `pointsViewportHeight`, default 720 = backend render height). Ortho: size px-equivalent either way. NOTE the WebGL point-size contract, not WebGPU 1px points.
// colour: material.vertexColors + geometry 'color' (itemSize 3|4) -> per-instance rgba; 'instanceOpacity' (itemSize 1) -> alpha; PointsMaterial.map = sprite texture (full quad uv); blending/depthWrite/depthTest = material flags.
// Rebuilt only when camera, object matrix, position/size/color/opacity versions or material size change; drawRange honoured.
const pointRecs = new Map();
const PT_IDENT = typeof Float32Array !== 'undefined' ? Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) : null;
function syncPoints(o, vis) {
  const g = o.geometry, pos = g?.attributes?.position, m = Array.isArray(o.material) ? o.material[0] : o.material;
  if (!pos || !m || !frameCamera?.matrixWorld) return;
  const cam = frameCamera.matrixWorld.elements, proj = frameCamera.projectionMatrix?.elements ?? [], mw = o.matrixWorld.elements;
  const dr = g.drawRange ?? { start: 0, count: Infinity }, st = Math.max(0, dr.start ?? 0), n = Math.max(0, Math.min(pos.count - st, dr.count ?? Infinity));
  const sa = g.attributes.size, ca = m.vertexColors ? g.attributes.color : null, oa = g.attributes[INST_OPACITY];
  const me = ensureMaterial(m, o), v = vis && m.visible !== false, ro = o.renderOrder ?? 0, premult = isPremult(m);
  const key = `${pos.version}:${sa?.version ?? ''}:${ca?.version ?? ''}:${oa?.version ?? ''}:${st}:${n}:${m.size}:${+(m.sizeAttenuation !== false)}:${proj[5]}:${proj[11]}:${+premult}`;
  let rec = pointRecs.get(o);
  const stale = !rec || rec.key !== key || !eqArr(rec.cam, cam) || !eqArr(rec.mw, mw);
  if (stale && n > 0) {
    const mats = rec && rec.mats.length === n * 16 ? rec.mats : new Float32Array(n * 16);
    const cols = ca || oa ? (rec && rec.cols?.length === n * 4 ? rec.cols : new Float32Array(n * 4)) : null;
    const rl = Math.hypot(cam[0], cam[1], cam[2]) || 1, ul = Math.hypot(cam[4], cam[5], cam[6]) || 1, bl = Math.hypot(cam[8], cam[9], cam[10]) || 1;
    const R0 = cam[0] / rl, R1 = cam[1] / rl, R2 = cam[2] / rl, U0 = cam[4] / ul, U1 = cam[5] / ul, U2 = cam[6] / ul, B0 = cam[8] / bl, B1 = cam[9] / bl, B2 = cam[10] / bl;
    const persp = proj[11] === -1, p5 = proj[5] || 1, base = m.size ?? 1, att = m.sizeAttenuation !== false, pa = pos.array, pis = pos.itemSize;
    for (let k = 0; k < n; k++) {
      const i = st + k, x = pa[i * pis], y = pa[i * pis + 1], z = pis > 2 ? pa[i * pis + 2] : 0;
      const wx = mw[0] * x + mw[4] * y + mw[8] * z + mw[12], wy = mw[1] * x + mw[5] * y + mw[9] * z + mw[13], wz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
      let s = base * (sa ? sa.array[i * sa.itemSize] : 1);
      if (persp && att) s /= p5; else { const depth = persp ? Math.max((wx - cam[12]) * -B0 + (wy - cam[13]) * -B1 + (wz - cam[14]) * -B2, 0) : 1; s = s * 2 * depth / (p5 * pointsViewportHeight); }
      const j = k * 16;
      mats[j] = R0 * s; mats[j + 1] = R1 * s; mats[j + 2] = R2 * s; mats[j + 3] = 0; mats[j + 4] = U0 * s; mats[j + 5] = U1 * s; mats[j + 6] = U2 * s; mats[j + 7] = 0;
      mats[j + 8] = B0; mats[j + 9] = B1; mats[j + 10] = B2; mats[j + 11] = 0; mats[j + 12] = wx; mats[j + 13] = wy; mats[j + 14] = wz; mats[j + 15] = 1;
      if (cols) {
        const cs = ca?.itemSize ?? 0, a = (cs >= 4 ? ca.array[i * cs + 3] : 1) * (oa ? oa.array[i * oa.itemSize] : 1), q = premult ? a : 1, c = k * 4;
        cols[c] = (ca ? ca.array[i * cs] : 1) * q; cols[c + 1] = (ca ? ca.array[i * cs + 1] : 1) * q; cols[c + 2] = (ca ? ca.array[i * cs + 2] : 1) * q; cols[c + 3] = a;
      }
    }
    if (!rec) {
      rec = { mat: m, matId: me.id, vis: v, ro, n, key, cam: new Float64Array(16), mw: new Float64Array(16), mats, cols, node: backend.createInstanced(spriteQuad(), me.id, mats, n, { castShadow: false, receiveShadow: false, visible: v, renderOrder: ro, static: false, matrix: PT_IDENT, ...(cols ? { colors: cols, colorStride: 4 } : {}) }) };
      me.users.add(rec); pointRecs.set(o, rec); stats.created++; stats.points = (stats.points ?? 0) + 1;
    } else { backend.updateInstances(rec.node, mats, n, PT_IDENT, cols, 4); rec.mats = mats; rec.cols = cols; rec.n = n; upd('points'); }
    rec.key = key; rec.cam.set(cam); rec.mw.set(mw);
    for (const a of [pos, sa, ca, oa]) a?.clearUpdateRanges?.();
  }
  if (!rec) return;
  if (rec.mat !== m) { mats.get(rec.mat)?.users.delete(rec); rec.mat = m; me.users.add(rec); }
  const u = {};
  if (me.id !== rec.matId) { u.material = me.id; rec.matId = me.id; }
  if (v !== rec.vis) { u.visible = v; rec.vis = v; }
  if (ro !== rec.ro) { u.renderOrder = ro; rec.ro = ro; }
  for (const _ in u) { backend.updateNode(rec.node, u); upd('points'); break; }
}
function destroyPoints(rec) { backend.removeNode(rec.node); mats.get(rec.mat)?.users.delete(rec); stats.removed++; }
const _bm = typeof Float32Array !== 'undefined' ? new Float32Array(16) : null;
function batchGeometry(o, gi) {
  const g = o.geometry, gInfo = o._geometryInfo[gi], pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
  const vs = gInfo.vertexStart, vc = gInfo.vertexCount;
  const positions = Float32Array.from(pos.array.subarray(vs * 3, (vs + vc) * 3));
  const arrays = { positions };
  if (nrm) arrays.normals = Float32Array.from(nrm.array.subarray(vs * 3, (vs + vc) * 3));
  if (uv) arrays.uvs = Float32Array.from(uv.array.subarray(vs * 2, (vs + vc) * 2));
  if (g.index) { const src = g.index.array.subarray(gInfo.indexStart, gInfo.indexStart + gInfo.indexCount), ix = new Uint32Array(src.length); for (let i = 0; i < src.length; i++) ix[i] = src[i] - vs; arrays.indices = ix; }
  return arrays;
}
function syncBatched(o, vis) {
  const mat = Array.isArray(o.material) ? o.material[0] : o.material;
  let r = batchRecs.get(o);
  if (r && (r.mref !== mat || r.geo !== o.geometry)) { destroyBatched(r); batchRecs.delete(o); r = null; }
  if (!r) { r = { users: null, mref: mat, geo: o.geometry, groups: new Map(), mv: -1, cv: -1, vbits: '', ninfo: -1, fbits: -1, world: new Float64Array(16).fill(NaN), mat }; batchRecs.set(o, r); r.me = ensureMaterial(mat); r.me.users.add(r); stats.created++; }
  ensureMaterial(mat);
  const info = o._instanceInfo, mtex = o._matricesTexture, ctex = o._colorsTexture;
  if (!mtex) return;
  let vb = ''; for (let i = 0; i < info.length; i++) vb += info[i].active && info[i].visible ? '1' : '0'; // cheap: one char per instance
  const fb = flagBits(o, vis), mw = o.matrixWorld.elements;
  const dirty = r.mv !== mtex.version || r.cv !== (ctex?.version ?? -1) || r.vbits !== vb || r.ninfo !== info.length || !eqArr(r.world, mw);
  if (!dirty && fb === r.fbits) return;
  const fl = nodeFlags(o, vis);
  if (dirty) {
    const by = new Map();
    for (let i = 0; i < info.length; i++) if (info[i].active && info[i].visible) { let l = by.get(info[i].geometryIndex); if (!l) by.set(info[i].geometryIndex, l = []); l.push(i); }
    const md = mtex.image.data, cd = ctex?.image.data;
    for (const [gi, ids] of by) {
      const mats = new Float32Array(ids.length * 16), cols = cd ? new Float32Array(ids.length * 4) : null;
      ids.forEach((id, k) => { mats.set(md.subarray(id * 16, id * 16 + 16), k * 16); if (cols) cols.set(cd.subarray(id * 4, id * 4 + 4), k * 4); });
      let gr = r.groups.get(gi);
      if (!gr) { const arrays = batchGeometry(o, gi); gr = { mesh: backend.createMesh(arrays), node: 0 }; r.groups.set(gi, gr); stats.uploadsGeometry++; }
      if (!gr.node) gr.node = backend.createInstanced(gr.mesh, r.me.id, mats, ids.length, { ...fl, matrix: Array.from(mw), ...(cols ? { colors: cols, colorStride: 4 } : {}) });
      else backend.updateInstances(gr.node, mats, ids.length, mw, cols, 4);
      gr.n = ids.length; upd('batched');
    }
    for (const [gi, gr] of r.groups) if (!by.has(gi) && gr.node) { backend.updateInstances(gr.node, new Float32Array(0), 0, mw, null, 4); gr.n = 0; upd('batched'); }
    r.mv = mtex.version; r.cv = ctex?.version ?? -1; r.vbits = vb; r.ninfo = info.length; r.world.set(mw);
  }
  if (fb !== r.fbits) { for (const gr of r.groups.values()) if (gr.node) backend.updateNode(gr.node, fl); r.fbits = fb; upd('batchedFlags'); }
}
function destroyBatched(r) { for (const gr of r.groups.values()) { if (gr.node) backend.removeNode(gr.node); backend.destroyMesh(gr.mesh); } r.groups.clear(); r.me.users.delete(r); stats.removed++; }
function visit(o, parentVis, seen) {
const treeVis = parentVis && o.visible !== false; // children inherit this; layers are per OBJECT (three Renderer.js: object.layers.test(camera.layers), no inheritance)
// r10: three draws (main pass AND shadow pass — ShadowNode adopts camera.layers.mask when the shadow camera sits on layer 0 only) only objects whose layers intersect the camera's. Honour it, else layer-gated helpers (depth-only proxies) draw in the main view.
const vis = treeVis && (!frameCamera?.layers || !o.layers || o.layers.test(frameCamera.layers) || ((o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) && isShadowOnly(o)));
if (!vis && treeVis && (o.isMesh || o.isLight)) stats.layerCulled = (stats.layerCulled ?? 0) + 1;
if (vis && treeVis && o.isMesh && isShadowOnly(o)) { stats.shadowOnly = (stats.shadowOnly ?? 0) + 1; if (o.isInstancedMesh) stats.shadowOnlyInst = (stats.shadowOnlyInst ?? 0) + (o.count ?? 0); } // r10 census
if (o.isLight) { seen.add(o); syncLight(o, vis); }
else if (o.isSprite) { seen.add(o); syncSprite(o, vis); }
else if (o.isPoints && nativeInst()) { seen.add(o); syncPoints(o, vis); }
else if (o.isPoints) stats.unsupported.add('Points:no-createInstanced')
else if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh) {
if (o.isBatchedMesh) { if (backend.createInstanced && backend.updateInstances) { seen.add(o); syncBatched(o, vis); } else stats.unsupported.add('BatchedMesh:no-createInstanced'); }
else {
if (o.isSkinnedMesh && skinCapable()) { seen.add(o); syncSkinned(o, vis); for (const c of o.children) visit(c, treeVis, seen); return; }
if (o.isSkinnedMesh) stats.unsupported.add('SkinnedMesh:static-bind-pose-only'); // backend lacks createSkin/updateSkin/createSkinnedMesh
seen.add(o);
let rec = recs.get(o);
if (!rec) { rec = { parts: [], matrix: new Float64Array(16), fbits: 0, fro: 0, dirtyGeo: false }; recs.set(o, rec); buildParts(o, rec, vis); rec.matrix.set(o.matrixWorld.elements); rec.fbits = flagBits(o, vis); rec.fro = o.renderOrder ?? 0; rec.mref = o.material; rec.geoRef = o.geometry; }
else updateMesh(o, rec, vis);
}
}
for (const c of o.children) visit(c, treeVis, seen);
}
// background: Color -> setBackground (linear, as three's clear colour); Texture/CubeTexture/other -> loud unsupported, clear colour kept. Never throws.
function syncEnvironment(scene) {
if (backend.setAmbient) {
const sig = `${amb.sky}|${amb.ground}`;
if (sig !== amb.sig) { backend.setAmbient({ sky: amb.sky.slice(), ground: amb.ground.slice() }); amb.sig = sig; stats.updated++; }
}
const bg = scene.background;
if (!backend.setBackground) { if (bg) stats.unsupported.add('background'); }
else {
let sig, rgb = null, tex = null;
const bi = scene.backgroundIntensity ?? 1;
if (bg && bg.isColor) { rgb = [bg.r, bg.g, bg.b]; sig = `c${rgb}`; }
else if (bg && bg.isTexture && backend.setBackgroundTexture && !bg.isRenderTargetTexture) { tex = bg; sig = `t${bg.uuid}:${bg.version}:${bi}`; }
else if (bg) { sig = 'x'; stats.unsupported.add(bg.isCubeTexture ? 'background:CubeTexture' : bg.isTexture ? 'background:Texture' : `background:${bg.constructor?.name ?? typeof bg}`); }
else sig = 'null';
if (sig !== amb.bgSig) {
if (tex) { // r6-scene: Texture (2D screen-aligned | equirect) / CubeTexture → core background pass (tone-mapped like three's bg)
try {
if (tex.isCubeTexture) { const c = readCube(tex); backend.setBackgroundTexture({ kind: 'cube', width: c.size, height: c.size, rgba: c.faces, srgb: c.srgb, intensity: bi }); if (c.hdrClamped) stats.degraded.add('background:hdr-clamped-to-ldr'); }
else { const t = readTexture(tex); backend.setBackgroundTexture({ kind: tex.mapping === 303 || tex.mapping === 304 ? 'equirect' : 'screen', width: t.w, height: t.h, rgba: t.rgba8, srgb: t.srgb, intensity: bi }); if (t.hdrClamped) stats.degraded.add('background:hdr-clamped-to-ldr'); }
} catch (e) { stats.unsupported.add(`background:${String(e.message ?? e).slice(0, 80)}`); sig = 'x'; }
} else if (sig !== 'x') { backend.setBackground(rgb); }
amb.bgSig = sig; stats.updated++;
}
}
// fog: THREE.Fog (linear, smoothstep) / FogExp2 → setFog (change-tracked; the game animates near/far/color per frame → 1 cheap sig compare)
if (backend.setFog) {
const f = scene.fog;
const sig = f ? (f.isFogExp2 ? `2|${f.color.r},${f.color.g},${f.color.b}|${f.density}` : f.isFog ? `1|${f.color.r},${f.color.g},${f.color.b}|${f.near}|${f.far}` : 'x') : '0';
if (sig !== amb.fogSig) {
if (sig === '0' || sig === 'x') backend.setFog(null);
else backend.setFog({ mode: f.isFogExp2 ? 2 : 1, color: [f.color.r, f.color.g, f.color.b], near: f.near ?? 0, far: f.far ?? 0, density: f.density ?? 0 });
if (sig === 'x') stats.unsupported.add('fog:unknown-type');
amb.fogSig = sig; stats.updated++;
}
} else if (scene.fog) stats.unsupported.add('fog');
// environment IBL (diffuse irradiance only; specular IBL NOT implemented): scene.environment CubeTexture / equirect Texture → SH9 on the CPU → setEnvironment
if (backend.setEnvironment) {
const env = scene.environment, ei = scene.environmentIntensity ?? 1;
const sig = env ? `${env.uuid}:${env.version}:${ei}` : '0';
if (sig !== amb.envSig) {
if (!env) backend.setEnvironment(null);
else {
try {
const eq = !env.isCubeTexture && (env.mapping === 303 || env.mapping === 304);
if (!env.isCubeTexture && !eq) throw new Error(`mapping ${env.mapping} (needs cube or equirect; PMREM/render-target textures are unreadable)`);
const src = env.isCubeTexture ? readCube(env) : readTexture(env);
backend.setEnvironment({ sh: shIrradiance(src, { equirect: eq }), intensity: ei });
stats.degraded.add('environment:diffuse-only(no specular IBL)');
} catch (e) { stats.unsupported.add(`environment:${String(e.message ?? e).slice(0, 100)}`); backend.setEnvironment(null); }
}
amb.envSig = sig; stats.updated++;
}
} else if (scene.environment) stats.unsupported.add('environment');
}
function updateMesh(o, rec, vis) {
const gone = rec.geoRef !== o.geometry || rec.dirtyGeo || (rec.mref !== o.material && (Array.isArray(o.material) || Array.isArray(rec.mref)));
if (gone) { destroyParts(rec); rec.dirtyGeo = false; buildParts(o, rec, vis); rec.mref = o.material; rec.geoRef = o.geometry; rec.matrix.set(o.matrixWorld.elements); rec.fbits = flagBits(o, vis); rec.fro = o.renderOrder ?? 0; upd('rebuild'); return; }
const fb = flagBits(o, vis), fro = o.renderOrder ?? 0, flagsChanged = fb !== rec.fbits || fro !== rec.fro, moved = !eqArr(rec.matrix, o.matrixWorld.elements);
const f = flagsChanged || o.isInstancedMesh ? nodeFlags(o, vis) : null;
const single = rec.parts.length === 1 && !Array.isArray(o.material);
let swapped = single && rec.parts[0].mat !== matKey(o.material, o);
for (const p of rec.parts) {
if (p.expanded) { // instanced fallback
const isg = instAttrSig(mats.get(p.mat)); if (moved || p.instV !== o.instanceMatrix.version || p.instCount !== o.count || p.instSig !== isg) { destroyExpanded(p); const gp = geos.get(p.geo).parts.get(p.geoKey), me = mats.get(p.mat); p.expanded = []; for (let i = 0; i < o.count; i++) p.expanded.push(backend.createInstance(gp.id, me.id, instanceWorld(o, i), { ...f, instAttrs: instAttrRow(me, i) })); p.instV = o.instanceMatrix.version; p.instCount = o.count; p.instSig = isg; upd('expandedRebuild'); }
continue;
}
if (!p.gp || !geoSame(p.geo, p.start, p.count, p.gp.sig)) { const gp2 = ensureGeometry(rec, p.geo, p.start, p.count); if (gp2) p.gp = gp2; } // fast path: in-place version compare, no key string / Map lookups
let u = null;
if (moved && !o.isInstancedMesh) (u ??= {}).mat4 = Array.from(o.matrixWorld.elements);
if (flagsChanged) u = Object.assign(u ?? {}, f);
if (swapped) { const mk2 = matKey(o.material, o), me = ensureMaterial(mk2, o); me.users.add(rec); mats.get(p.mat)?.users.delete(rec); p.mat = mk2; (u ??= {}).material = me.id; rec.mref = o.material; }
if (o.isInstancedMesh) {
const ic = instVers(o);
if (moved || p.instV !== o.instanceMatrix.version || p.instCount !== o.count || p.instC !== ic) { const pk = packInst(o, p.pk ??= {}, isPremult(p.mat)); backend.updateInstances(p.node, instanceMats(o, p.pk), o.count, o.matrixWorld.elements, pk.colors ?? null, pk.colorStride); if ((pk.uvs || p.hasUv) && backend.setInstanceUvs) { backend.setInstanceUvs(p.node, pk.uvs ?? null); p.hasUv = !!pk.uvs; } p.instV = o.instanceMatrix.version; p.instC = ic; p.instCount = o.count; upd('instances'); }
}
if (u) { backend.updateNode(p.node, u); upd('node'); }
// refresh material conversion (property edits) — cheap, once per material per frame (epoch-gated inside)
{ const ta = now(); const me = ensureMaterial(p.mat, o); const tb = now(); const gpp = geos.get(p.geo)?.parts.get(p.geoKey); if (gpp) feedMeshAttrs(gpp, p.geo, me, p.mat); sub.ensureMaterial += tb - ta; sub.feedMeshAttrs += now() - tb; }
}
if (moved) rec.matrix.set(o.matrixWorld.elements);
rec.fbits = fb; rec.fro = fro;
}
function destroyExpanded(p) { for (const n of p.expanded) backend.removeNode(n); }

return {
stats,
// r10-shadow-5 diagnostics: material → { id, first export's object, package carries gaia_sun_shadow }
matPkg(m) { const e = mats.get(m) ?? mats.get(recvVariants.get(m)); return e?.conv?.package ?? null; },
matInfo(m) { const e = mats.get(m) ?? mats.get(recvVariants.get(m)); return e ? { id: e.id, kind: e.conv?.kind, first: e.first, shadow: !!e.conv?.package?.fragment?.includes('gaia_sun_shadow'), fell: !!e.fellBack } : null; },
// mirror `scene` (+ camera) into the backend. Call once per frame before backend.renderFrame().
sync(scene, camera = null) {
const t0 = now();
skinMs = 0; skinCalls = 0;
{ const ls = observeLights(scene).gen; /* r16-perf: grow-only light registry -> re-export only when a NEVER-SEEN light object appears; pool reassign/visibility/detach = uniforms only */ if (lightSetSig !== null && ls !== lightSetSig) { lightGen++; lightGenSfx = '|L' + lightGen; stats.lightSetChanges = (stats.lightSetChanges ?? 0) + 1; } lightSetSig = ls; }
epoch++; stats.frames++; stats.layerCulled = 0; stats.shadowOnly = 0; stats.shadowOnlyInst = 0; stats.shadowMask = shadowMask; frameScene = scene; frameCamera = camera;
if (updateMatrices) { scene.updateMatrixWorld(true); camera?.updateMatrixWorld?.(); /* r18: sprites billboard against THIS frame's camera */ }
const t1 = now();
const seen = new Set();
amb.sky.fill(0); amb.ground.fill(0); amb.n = 0;
seen_dirs = [];
visit(scene, true, seen);
if (backend.setExtraDirs) syncDirs();
syncEnvironment(scene);
const t2 = now();
for (const [o, rec] of recs) if (!seen.has(o)) { destroyParts(rec); recs.delete(o); }
for (const [o, r] of skinRecs) if (!seen.has(o)) { destroySkinned(r); skinRecs.delete(o); }
for (const [o, r] of batchRecs) if (!seen.has(o)) { destroyBatched(r); batchRecs.delete(o); }
for (const [o, r] of spriteRecs) if (!seen.has(o)) { destroySprite(r); spriteRecs.delete(o); }
for (const [o, r] of pointRecs) if (!seen.has(o)) { destroyPoints(r); pointRecs.delete(o); }
for (const [o, r] of lights) if (!seen.has(o)) { backend.removeLight(r.id); lights.delete(o); stats.removed++; }
gc();
const t3 = now();
syncLiveUniforms();
if (camera) {
if (updateMatrices) camera.updateMatrixWorld?.();
const view = Array.from(camera.matrixWorldInverse?.elements ?? []), proj = Array.from(camera.projectionMatrix?.elements ?? []);
const sig = `${view}|${proj}`;
if (view.length === 16 && proj.length === 16 && sig !== cameraSig) { backend.setCamera(view, proj); cameraSig = sig; upd('camera'); }
}
const t4 = now();
// last-frame phase breakdown (ms): matrixWorld (three's own updateMatrixWorld, 0 when updateMatrices=false) · visit (per-object diff + backend calls) · sweep (removed objects + gc) · camera/live uniforms
stats.phase = { matrixWorld: t1 - t0, visit: t2 - t1, sweep: t3 - t2, camera: t4 - t3, total: t4 - t0, backendSkinUpload: skinMs, skinUploads: skinCalls };
},
dispose() { for (const [, rec] of recs) destroyParts(rec); recs.clear(); for (const [, r] of skinRecs) destroySkinned(r); skinRecs.clear(); for (const [, r] of batchRecs) destroyBatched(r); batchRecs.clear(); for (const [, r] of spriteRecs) destroySprite(r); spriteRecs.clear(); for (const [, r] of pointRecs) destroyPoints(r); pointRecs.clear(); if (spriteMesh) { backend.destroyMesh(spriteMesh); spriteMesh = 0; } for (const [, r] of lights) backend.removeLight(r.id); lights.clear(); gc(); },
};
}
