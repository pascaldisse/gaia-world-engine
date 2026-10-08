// render-api/wgpu-backend.js — backend #2: gaia-render (Rust/wgpu) compiled to wasm, WebGPU canvas.
// Implements interface.js on top of client-rs/packages/render-wasm (wasm-bindgen: typed arrays in, integer handles out).
// NO three imports. Creation is ASYNC (adapter/device request); every method of the returned backend is sync.
//
//   const backend = await createWgpuBackend({ canvas, wasm: await import('/pkg/render_wasm.js'), renderHeight: 720 });
//   // `wasm` = the wasm-bindgen --target web module ({ default: init, GaiaRender }); `wasmUrl` optional override for init().
//
// Core handles: mesh/material ids come straight from the wasm core. NodeId (groups + instances) and LightId are minted here:
// the core only knows flat world-space instances, so node hierarchy (parent × local) + visibility are resolved in JS and
// pushed down as world mat4s. Capabilities are the honest subset gaia-render has TODAY (see NOTES in crates/gaia-render).
import { RENDER_API_VERSION, validateMeshArrays, isMat4, IDENTITY_MAT4, normalizeGroups, bitsToWords } from './interface.js';
import { textureData, arrayTextureData, cubeTextureData } from './material-map.js';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// '#rrggbb' | 0xrrggbb are authoring (sRGB) colors → linear (three ColorManagement); [r,g,b] arrays are taken as linear.
// r10-5: exact equality of live uniform plain values (number | number[] | bool) - shared-value dedupe must be lossless.
function sameNum(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function colorOf(c, fallback = [1, 1, 1]) {
  if (c == null) return fallback;
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0], c[1], c[2]];
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c;
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

function mul4(a, b, out = new Float64Array(16)) { // out = a × b (column-major)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

// general 4×4 inverse (view → camera-to-world)
export function invert4(m) {
  const o = new Float64Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) throw new Error('render-api(wgpu): singular view matrix');
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

// perspective projection → { yfov, znear, zfar(0 = infinite) }. 'gl' = z∈[-1,1] (three default), 'zo' = z∈[0,1] (WebGPU coord system).
export function decomposePerspective(p, depth = 'gl') {
  const yfov = 2 * Math.atan(1 / p[5]);
  const a = p[10], b = p[14];
  let znear, zfar;
  if (depth === 'zo') { znear = b / a; zfar = b / (a + 1); } else { znear = b / (a - 1); zfar = b / (a + 1); }
  if (!(zfar > znear) || !Number.isFinite(zfar)) zfar = 0;
  return { yfov, znear, zfar };
}

function computeNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area-weighted
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// three Texture → {width,height,data:Uint8Array rgba8} (DataTexture rgba8 as-is; image/canvas/bitmap via 2D canvas). null = unreadable.
export function texturePixels(t) {
  const img = t?.image;
  if (!img) return null;
  if (img.data && img.width > 0 && img.height > 0) {
    const d = img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray ? img.data : null;
    return d && d.length === img.width * img.height * 4 ? { width: img.width, height: img.height, data: new Uint8Array(d.buffer, d.byteOffset, d.length) } : null;
  }
  const w = img.width ?? img.videoWidth, h = img.height ?? img.videoHeight;
  if (!(w > 0 && h > 0) || typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(w, h).getContext('2d'); c.drawImage(img, 0, 0);
  return { width: w, height: h, data: new Uint8Array(c.getImageData(0, 0, w, h).data.buffer) };
}
// r10-shadow-8: ?wgpuDbg=<term> = diagnostic bisect, generic (NO game edits): every exported package's final colour is replaced by ONE lighting term, so a
// wrong term shows up as a flat/black image. Terms: normal (world N*.5+.5) | ndl (clamp(N.sunDir)) | shadow (core CSM factor) | direct | indirect | albedo | gi (indirect only).
const DBG_EXPR = {
  normal: 'normalWorld * 0.5 + vec3<f32>(0.5)',
  ndl: 'vec3<f32>(clamp(dot(normalWorld, object.gaiaSunDir), 0.0, 1.0))',
  shadow: 'vec3<f32>(gaia_sun_shadow_core(v_positionWorld, render.cameraPosition, normalWorld, max(dot(normalWorld, object.gaiaSunDir), 0.0)))',
  combo: 'vec3<f32>(clamp(dot(normalWorld, object.gaiaSunDir), 0.0, 1.0), gaia_sun_shadow_core(v_positionWorld, render.cameraPosition, normalWorld, max(dot(normalWorld, object.gaiaSunDir), 0.0)), clamp(dot(directDiffuse, vec3<f32>(0.3333)) * 3.0, 0.0, 1.0))', // R=N.L G=core shadow B=direct lum*3
  direct: 'directDiffuse', indirect: 'indirectDiffuse', albedo: 'DiffuseColor.xyz',
};
function debugOutPkg(pkg) {
  const term = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('wgpuDbg') : null;
  // r10-shadow-16: ?wgpuDbg=gigrid packs the GI query into one colour: R = finest-cascade coverage weight, G = GI query .y (pre-hemi-substitution), B = irradiance.y (after substitution). Names are three's generated vars, found by shape (debug only).
  if (term === 'gigrid') {
    const m = /irradiance \+ \( vec3<f32>\( max\( max\( (\w+), (\w+) \), (\w+) \) \) \* \( (\w+) - mix\( /.exec(pkg.fragment);
    if (!m || !/output\.color = [^;]+;/.test(pkg.fragment)) return pkg;
    return { ...pkg, fragment: pkg.fragment.replace(/output\.color = [^;]+;/, `output.color = vec4<f32>(${m[3]}, ${m[4]}.y, irradiance.y, 1.0);`) };
  }
  const expr = term && DBG_EXPR[term];
  if (!expr || !/output\.color = [^;]+;/.test(pkg.fragment)) return pkg;
  if (/gaiaSunDir/.test(expr) && !pkg.fragment.includes('object.gaiaSunDir')) return pkg; // non-receiver: left as lit
  return { ...pkg, fragment: pkg.fragment.replace(/output\.color = [^;]+;/, `output.color = vec4<f32>(${expr}, 1.0);`) };
}

// r4-browser (additive): `options.shadows` = ShadowOptions object (camelCase keys, passed to wasm create). `staticInstances`:
// 'none' (default) = every instance DYNAMIC in the shadow system (safe for moving games) · 'non-skinned' = every instance whose mesh is NOT a
// skinned mesh is marked static (cached shadow layers; moving one re-renders the cache) — per-node override: flags.static / updateNode({static}).
// flags.castShadow (three semantics; the adapter always sends a bool) → core per-instance cast flag; undefined = core default (casts).
export async function createWgpuBackend({ canvas, wasm, wasmUrl, renderHeight = 720, options = {}, depth = 'gl', staticInstances = 'none' } = {}) {
  if (!canvas) throw new Error('createWgpuBackend requires { canvas }');
  if (!wasm?.GaiaRender) throw new Error('createWgpuBackend requires { wasm } = the render_wasm.js module');
  if (!navigator.gpu) throw new Error('createWgpuBackend: WebGPU unavailable (navigator.gpu missing)');
  await (wasmUrl ? wasm.default(wasmUrl) : wasm.default());
  // r11-pipe: ?wgpuPipeShare=0 turns off content-keyed three-material pipeline sharing + pipeline-sorted opaque draws (default on); options.pipeShare wins.
  const pipeShare = options.pipeShare ?? !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('wgpuPipeShare') === '0');
  // r11-sort: ?wgpuPipeSort=1 sorts opaque shader-mat draws by pipeline key (default OFF: lampas measured sort +1.5ms worse); options.pipeSort wins.
  const pipeSort = options.pipeSort ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('wgpuPipeSort') === '1');
  const gpu = await wasm.GaiaRender.create(canvas, { renderHeight, ...options, pipeShare, pipeSort });

  let next = 1;
  const nodes = new Map();      // NodeId → { id, kind, parent, children:Set, local, world, visible, mesh, material, rid }
  const lights = new Map();     // LightId → { kind:'sun'|'point', ... }
  const skinnedMeshes = new Set(); // wasm mesh ids that are skinned (always dynamic casters)
const matTextures = new Map(); // MaterialId → [texture handles {id,key}] owned by that material
  const texByKey = new Map();    // texture descriptor key (uuid:version, material-map) → { id, refs } — one GPU texture shared by every material using it
const texStats = { uploads: 0, hits: 0 };
const refusedTex = new Set(); // r13-bc: texture uploads the core refused (drained into the adapter's stats.unsupported via backend.drainUnsupported)
  // textures[slot] = {width,height,data,key?}. With a `key` the GPU texture is shared + refcounted and `data` (lazy getter in material-map) is only
  // read on a MISS → an idle frame / a second material on the same image does 0 pixel reads and 0 uploads.
  function acquireTexture(t) {
if (t.refused) throw new Error(`createMaterial: texture refused — ${t.refused}`);
if (t.key) {
const c = texByKey.get(t.key);
if (c) {
c.refs++; texStats.hits++;
if (t.array && t.version !== c.version) { // layered upload: only the layers three marked dirty (all when unknown)
const dirty = t.takeLayerUpdates?.() ?? Array.from({ length: t.layers }, (_, i) => i), S = t.width * t.height * 4;
for (const l of dirty) gpu.updateTextureLayer(c.id, l, t.data.subarray(l * S, (l + 1) * S));
c.version = t.version; texStats.layerUploads = (texStats.layerUploads ?? 0) + dirty.length;
}
return { id: c.id, key: t.key };
}
}
if (t.compressed) { // r13-bc: block-compressed 2D texture (mip chain concatenated). Core = native BC when the device has it, else CPU decode (counted in gpu.compressedStats()). Failure = id 0 (white) + RECORDED in unsupported, never a thrown frame.
  let id = 0;
  try {
    if (!gpu.createTextureCompressed) throw new Error('wasm pkg predates createTextureCompressed');
    id = gpu.createTextureCompressed(t.format, t.width, t.height, t.mipCount, t.data, t.srgb !== false, !!t.flipY);
    texStats.uploads++; texStats.compressed = (texStats.compressed ?? 0) + 1;
  } catch (e) { refusedTex.add(`texture:compressed ${t.format} ${t.width}x${t.height}: ${String(e?.message ?? e).slice(0, 120)}`); return { id: 0, key: null }; }
  if (t.key) texByKey.set(t.key, { id, refs: 1, version: t.version, fresh: null });
  return { id, key: t.key ?? null };
}
const data = t.data;
if (!data || !(t.cube ? t.size > 0 : (t.width > 0 && t.height > 0))) throw new Error('createMaterial: texture map needs { width, height, data }');
const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data);
let id;
if (t.cube) id = gpu.createTextureCube(t.size, bytes, t.srgb !== false);
else if (t.array) { id = gpu.createTextureArray(t.width, t.height, t.layers, bytes, t.srgb !== false); t.takeLayerUpdates?.(); }
else id = t.srgb === false ? gpu.createTextureLinear(t.width, t.height, bytes) : gpu.createTexture(t.width, t.height, bytes); // colour space flag honored (three colorSpace)
texStats.uploads++;
if (t.key) texByKey.set(t.key, { id, refs: 1, version: t.version, fresh: t.fresh ?? null });
return { id, key: t.key ?? null };
}
// r6-tsl-2: storage buffers shared per three BufferAttribute (refcounted); host bytes = the attribute's typed array as-is.
const storByAttr = new Map(); // BufferAttribute -> { id, refs, version }
const matStorage = new Map(); // MaterialId -> [{key, attr, h}]
const storStats = { creates: 0, hits: 0, updates: 0 };
const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
// r10-shadow-6: a storage attribute whose authoritative data lives on THREE's GPU (compute-written probe atlases) carries a CPU readback mirror; its upload version is
// userData.gpuMirrorVersion (bumped by gi-bridge per readback) — NOT attr.version, which three itself would re-upload (clobbering partial compute updates).
const verOf = (attr) => attr.userData?.gpuMirrorVersion ?? attr.version;
function acquireStorage(attr) {
const c = storByAttr.get(attr);
if (c) { c.refs++; storStats.hits++; return c; }
const h = { id: gpu.createStorageBuffer(bytesOf(attr.array)), refs: 1, version: verOf(attr), attr };
storByAttr.set(attr, h); storStats.creates++;
return h;
}
function releaseStorage(h) { if (--h.refs <= 0) { gpu.destroyStorageBuffer(h.id); storByAttr.delete(h.attr); } }
function releaseTexture(h) {
if (h.key) { const c = texByKey.get(h.key); if (c && --c.refs <= 0) { gpu.destroyTexture(c.id); texByKey.delete(h.key); } }
else if (h.id) gpu.destroyTexture(h.id); // id 0 = refused compressed upload (nothing to free)
}
// side: three Side (FrontSide=cull back -> 1, BackSide -> 2, DoubleSide -> 0 in the core encoding). Render FLAGS (blend/unlit/depthWrite/renderOrder/shadow) = r8/r9 setMatFlags below.
// r7: emissiveMap === map (same key) -> emissive x base texel (4th emissive float = flag), emissive slot NOT bound (would multiply twice); distinct emissiveMap -> bound in its own slot (r6 maps).
function matArgs(params, textures) {
const [r, g, b] = colorOf(params.color);
const e = colorOf(params.emissive, [0, 0, 0]);
const k = params.emissiveIntensity ?? 1;
const emBase = !!(textures?.emissiveMap?.key && textures.emissiveMap.key === textures.map?.key);
const owned = [], ids = {};
for (const slot of ['map', 'array', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
if (!textures?.[slot] || (slot === 'emissiveMap' && emBase)) continue;
const h = acquireTexture(textures[slot]); owned.push(h); ids[slot] = h.id;
}
const side = params.doubleSide ? 0 : params.backSide ? 2 : 1;
return { owned, args: [Float32Array.of(r, g, b, params.opacity ?? 1), params.metalness ?? 0, params.roughness ?? 1, ids.map ?? 0, params.alphaTest > 0 ? params.alphaTest : -1, emBase ? Float32Array.of(e[0] * k, e[1] * k, e[2] * k, 1) : Float32Array.of(e[0] * k, e[1] * k, e[2] * k)],
maps: [ids.array ?? 0, ids.normalMap ?? 0, ids.roughnessMap ?? 0, ids.metalnessMap ?? 0, ids.emissiveMap ?? 0, ids.aoMap ?? 0, params.normalScale ?? 1, side] };
}
  // r8: three material state the core takes as FLAGS (setMaterialFlags): blend (transparent / opacity<1 / additive), unlit (plain Basic), depthWrite:false, per-object renderOrder
  // (core order is per MATERIAL: last node to set it wins — Eden sky layers have one material each), toneMapped (unlit only). No game names.
  const flagStats = { noColorWrite: 0, noDepthTest: 0 }; // r11: counts of per-material colorWrite:false / depthTest:false pushes to the core (live-proof counters, generic)
  const matFlags = new Map(); // MaterialId → { blend, unlit, dw, toneMapped, ro, pushed }
  function flagsFromParams(params = {}) {
    const blend = params.blending === 'additive' ? 2 : (params.transparent || (params.opacity ?? 1) < 1) ? 1 : 0;
    // r9: three r180 renders `shadowSide ?? side` into the shadow map -> a FrontSide material casts only from its front faces (core caster pass culls back faces); Double/Back keep the double-sided caster
    return { blend, unlit: !!params.unlit, dw: params.depthWrite === false ? 0 : -1, nocw: params.colorWrite === false, nodt: params.depthTest === false, toneMapped: params.toneMapped !== false, cull: !params.doubleSide && !params.backSide, nogi: !!params.noGi };
  }
  function pushFlags(id) {
    const f = matFlags.get(id); if (!f) return;
    const nondefault = f.blend || f.unlit || f.dw >= 0 || f.nocw || f.nodt || f.ro || f.norecv;
    let reset = false;
    if (nondefault || f.pushed) {
      gpu.setMaterialFlags(id, f.blend, f.unlit, f.dw, f.ro, -1); reset = true; // resets every core flag incl. shadow_cull_back
      if (f.unlit) gpu.setMaterialUnlitToneMapped(id, f.toneMapped);
      if (f.norecv) gpu.setMaterialNoReceiveShadow(id, true);
      if (f.nocw) { flagStats.noColorWrite++; gpu.setMaterialNoColorWrite?.(id, true); } // r11: three colorWrite:false (depth-only occluder) → empty colour write mask; ?. = older wasm pkg draws colour
      if (f.nodt) { flagStats.noDepthTest++; gpu.setMaterialNoDepthTest?.(id, true); } // r11: three depthTest:false → depth compare ALWAYS (draws over nearer geometry); ?. = older wasm pkg stays depth-tested
      f.pushed = !!nondefault;
    }
    if (f.nogi) gpu.setMaterialNoGi?.(id, true); // r9: material not GI-eligible in three (plain non-node material) → hemisphere only. Default (eligible) materials push nothing.
    if (reset) f.cullPushed = false;
    if (!!f.cull !== !!f.cullPushed) { gpu.setMaterialShadowCullBack?.(id, !!f.cull); f.cullPushed = !!f.cull; } // ?. = older wasm pkg without the r9 export keeps the double-sided caster
  }
  function setMatFlags(id, params) { const prev = matFlags.get(id); matFlags.set(id, { ...flagsFromParams(params), ro: prev?.ro ?? 0, norecv: prev?.norecv ?? false, cullPushed: prev?.cullPushed ?? false, pushed: prev?.pushed ?? false }); pushFlags(id); }
  // r8 receiveShadow:false → core per-MATERIAL flag: a material stops sampling the sun shadow only when EVERY instance using it has receiveShadow false (mixed = receives, the old behaviour).
  const recvUsers = new Map(); // MaterialId → Map<NodeId, bool receive>
  function trackReceive(node) {
    if (node.kind !== 'instance' || !node.material) return;
    if (node.recvMat && node.recvMat !== node.material) { recvUsers.get(node.recvMat)?.delete(node.id); refreshReceive(node.recvMat); }
    let m = recvUsers.get(node.material); if (!m) recvUsers.set(node.material, m = new Map());
    m.set(node.id, node.receiveShadow !== false); node.recvMat = node.material; refreshReceive(node.material);
  }
  function untrackReceive(node) { if (node.recvMat) { recvUsers.get(node.recvMat)?.delete(node.id); refreshReceive(node.recvMat); node.recvMat = 0; } }
  function refreshReceive(id) {
    const m = recvUsers.get(id); let none = !!m && m.size > 0; if (m) for (const r of m.values()) if (r) { none = false; break; }
    let f = matFlags.get(id); if (!f) { f = { blend: 0, unlit: false, dw: -1, toneMapped: true, ro: 0, norecv: false, pushed: false }; matFlags.set(id, f); }
    if (f.norecv === none) return; f.norecv = none; pushFlags(id);
  }
  function setMatOrder(id, ro) { // renderOrder is a node property; the core sorts per material
    let f = matFlags.get(id); if (!f) { f = { blend: 0, unlit: false, dw: -1, toneMapped: true, ro: 0, norecv: false, pushed: false }; matFlags.set(id, f); }
    if ((f.ro || 0) === (ro || 0)) return; f.ro = ro || 0; pushFlags(id);
  }
  let lightsDirty = false;
  let sunId = 0;

  const need = (map, id, what) => { const v = map.get(id); if (!v) throw new Error(`render-api(wgpu): unknown ${what} ${id}`); return v; };
  const asMat = (m) => { if (!isMat4(m)) throw new Error('render-api(wgpu): mat4 must be 16 finite numbers'); return m; };

  // resolve world transform + effective visibility for a node subtree, push to the core
  function sync(node, parentWorld, parentVisible) {
    node.world = parentWorld ? mul4(parentWorld, node.local, node.world || new Float64Array(16)) : Float64Array.from(node.local);
    const eff = parentVisible && node.visible;
    if (node.kind === 'instance') {
      if (eff) {
        const w = Float32Array.from(node.world);
        if (node.rid && node.ridMat === node.material && node.ridMesh === node.mesh) gpu.updateInstance(node.rid, w);
        else {
          if (node.rid) gpu.removeInstance(node.rid);
          node.rid = gpu.createInstance(node.mesh, node.material, w);
if (node.instAttrs) for (const [k, v] of Object.entries(node.instAttrs)) gpu.setInstanceAttribute(node.rid, k, v.length, v);
          node.ridMat = node.material; node.ridMesh = node.mesh;
          applyShadowFlags(node); applyGroups(node); relinkGroupChildren(node);
        }
      } else if (node.rid) { gpu.removeInstance(node.rid); node.rid = 0; }
    }
    for (const cid of node.children) sync(nodes.get(cid), node.world, eff);
  }
  const parentState = (node) => {
    const p = node.parent ? nodes.get(node.parent) : null;
    if (!p) return [null, true];
    let vis = true; for (let q = p; q; q = q.parent ? nodes.get(q.parent) : null) vis = vis && q.visible;
    return [p.world, vis];
  };
  // visibility groups: node.groups = { words:Uint32Array, parent?:NodeId } → core instance mask (+ parent = that node's CORE instance).
  // A parent without a core instance yet (created later / hidden) → applied when it gets one (relinkGroupChildren).
    function applyGroups(node) {
    if (!node.groups || !node.rid || node.kind !== 'instance') return; // blocks carry no groups (core: always drawn)
    gpu.setInstanceGroups(node.rid, node.groups.words);
    const p = node.groups.parent ? nodes.get(node.groups.parent) : null;
    gpu.setInstanceGroupParent(node.rid, p?.rid ? p.rid : 0xffffffff);
  }
  function relinkGroupChildren(parentNode) { for (const n of nodes.values()) if (n.groups?.parent === parentNode.id) applyGroups(n); }
  // native block upload: create / update / remove per visibility; `flagsDirty` re-applies shadow flags (material change = recreate).
function pushBlock(node, flagsDirty = false) {
  if (!node.visible || node.count === 0) { if (node.rid) { gpu.removeInstanceBlock(node.rid); node.rid = 0; } return; }
  const colors = node.colors ?? new Float32Array(0), stride = node.colors ? node.stride : 0;
  if (node.rid && (node.ridMat !== node.material || node.ridMesh !== node.mesh)) { gpu.removeInstanceBlock(node.rid); node.rid = 0; }
  if (!node.rid) {
    node.rid = gpu.createInstanceBlock(node.mesh, node.material, node.mats, colors, stride, node.count, node.world);
    node.ridMat = node.material; node.ridMesh = node.mesh; flagsDirty = true;
  } else gpu.updateInstanceBlock(node.rid, node.mats, colors, stride, node.count, node.world);
  if (flagsDirty) {
    const st = node.static !== undefined ? node.static : (staticInstances === 'non-skinned' && !skinnedMeshes.has(node.mesh));
    gpu.setInstanceBlockFlags(node.rid, node.castShadow !== false, !!st);
    if (gpu.setInstanceBlockShadowOnly) gpu.setInstanceBlockShadowOnly(node.rid, !!node.shadowOnly);
  }
}
function applyShadowFlags(node) {
  if (node.castShadow !== undefined) gpu.setInstanceCastShadow(node.rid, node.castShadow);
  if (node.shadowOnly && gpu.setInstanceShadowOnly) gpu.setInstanceShadowOnly(node.rid, true); // r10: depth-only caster (main camera's layers exclude it)
  const st = node.static !== undefined ? node.static : (staticInstances === 'non-skinned' && !skinnedMeshes.has(node.mesh));
  if (st) gpu.setInstanceStatic(node.rid, true);
  }
  function link(node, parentId) {
    if (parentId) need(nodes, parentId, 'parent node').children.add(node.id);
    node.parent = parentId || 0;
  }
  function dropRids(node) {
    if (node.rid) { if (node.kind === 'instanced') gpu.removeInstanceBlock(node.rid); else gpu.removeInstance(node.rid); node.rid = 0; }
    for (const cid of node.children) dropRids(nodes.get(cid));
  }

  function pushLights() {
    const pts = [...lights.values()].filter((l) => l.kind === 'point');
    const packed = new Float32Array(pts.length * 8);
    pts.forEach((l, i) => {
      packed.set([...l.position, l.distance > 0 ? l.distance : 1e4, ...l.color, l.intensity], i * 8);
    });
    gpu.setPointLights(packed);
    const sun = lights.get(sunId);
    if (sun) gpu.setSun(Float32Array.from(sun.direction.map((v) => -v)), Float32Array.from(sun.color), sun.intensity);
    lightsDirty = false;
  }

  const backend = {
    name: 'wgpu',
    apiVersion: RENDER_API_VERSION,
    capabilities: ['mesh-arrays', 'pbr', 'textures-rgba8', 'instances', 'instanced-blocks', 'instance-color', 'nodes', 'sun', 'point-lights', 'shader-material-wgsl', 'skinning', 'sun-shadows', 'ambient-hemisphere', 'background-color', 'background-texture', 'fog', 'environment-diffuse-ibl', 'probe-gi', 'visibility-groups', 'webgpu', 'texture-array', 'texture-mips', 'texture-colorspace', 'material-maps', 'material-side', 'material-blend', 'vertex-layer-colour', 'shader-vertex-attributes', 'shader-texture-array', 'shader-storage-buffer', gpu.hasTimestamps() ? 'timestamp-query' : 'no-timestamp-query'],
    flagStats,
    gpu, // raw wasm handle (frame stats / renderTimed / createShaderMaterial live here, not in the neutral interface)

    createMesh(arrays) {
      const n = validateMeshArrays(arrays);
      const indices = arrays.indices instanceof Uint32Array ? arrays.indices : Uint32Array.from(arrays.indices || Array.from({ length: n }, (_, i) => i));
      const positions = arrays.positions instanceof Float32Array ? arrays.positions : Float32Array.from(arrays.positions);
      const normals = arrays.normals ? Float32Array.from(arrays.normals) : computeNormals(positions, indices);
      const uvs = arrays.uvs ? Float32Array.from(arrays.uvs) : new Float32Array(n * 2);
      const mid = gpu.createMesh(positions, normals, uvs, indices);
      if (arrays.uv1) gpu.setMeshUv1(mid, arrays.uv1);
      if (arrays.colors) gpu.setMeshColors(mid, arrays.colors);
      return mid;
    },
    destroyMesh(id) { gpu.destroyMesh(id); },
// r6-tsl: extra named per-vertex attribute (uv1, vertex colour, custom, `node:<uuid>`) for TSL shader materials; f32 x itemSize per vertex.
setMeshAttribute(mesh, key, itemSize, data) { gpu.setMeshAttribute(mesh, key, itemSize, data instanceof Float32Array ? data : Float32Array.from(data)); },
// r6-tsl: backend-side count of three draws skipped last frame because a material's vertex attribute was missing (loud counter).
threeSkipped() { return gpu.threeSkipped(); },
    // ---- skinning (gaia-render skin.rs: one compute pre-pass for all skinned meshes) ----
    // ibm = jointCount col-major mat4s; updateSkin = joint WORLD matrices; skinned instances use identity mat4.
    createSkin(inverseBind, jointCount) { return gpu.createSkin(jointCount, Float32Array.from(inverseBind)); },
    updateSkin(id, jointMatrices) { gpu.setSkinPose(id, jointMatrices instanceof Float32Array ? jointMatrices : Float32Array.from(jointMatrices)); },
    destroySkin(id) { gpu.destroySkin(id); },
    createSkinnedMesh(arrays, skin) {
      const n = validateMeshArrays(arrays);
      const indices = arrays.indices instanceof Uint32Array ? arrays.indices : Uint32Array.from(arrays.indices || Array.from({ length: n }, (_, i) => i));
      const positions = Float32Array.from(arrays.positions);
      const normals = arrays.normals ? Float32Array.from(arrays.normals) : computeNormals(positions, indices);
      const uvs = arrays.uvs ? Float32Array.from(arrays.uvs) : new Float32Array(n * 2);
      const mid = gpu.createSkinnedMesh(skin, positions, normals, uvs, Uint32Array.from(arrays.joints), Float32Array.from(arrays.weights), indices);
      skinnedMeshes.add(mid); return mid;
    },
    destroySkinnedMesh(id) { skinnedMeshes.delete(id); gpu.destroySkinnedMesh(id); },

    // params = three-style; preset → degrades to pbr; opacity/doubleSide/fog/flatShading not in the core yet (drawn opaque, no cull).
    createMaterial(params = {}, textures = null) {
      const ma = matArgs(params, textures); const { owned, args } = ma;
      const id = gpu.createMaterial(...args);
      gpu.setMaterialMaps(id, ...ma.maps); setMatFlags(id, params);
      if (owned.length) matTextures.set(id, owned);
      return id;
    },
    // in-place re-description (same MaterialId; users keep their handle). New texture handles are acquired BEFORE the old ones are released.
    updateMaterial(id, params = {}, textures = null) {
      const ma = matArgs(params, textures); const { owned, args } = ma;
      const old = matTextures.get(id) || [];
      gpu.updateMaterial(id, ...args); gpu.setMaterialMaps(id, ...ma.maps); setMatFlags(id, params);
      for (const h of old) releaseTexture(h);
      if (owned.length) matTextures.set(id, owned); else matTextures.delete(id);
    },
textureStats() { return { ...texStats, live: texByKey.size, storage: { ...storStats, live: storByAttr.size }, compressedCore: gpu.compressedStats ? Array.from(gpu.compressedStats()) : null /* [gpu_native, cpu_no_bc_feature, cpu_bc1rgb_punchthrough, cpu_unaligned_or_unflippable, cpu_single_mip, refused] */ }; },
    drainUnsupported() { const r = [...refusedTex]; refusedTex.clear(); return r; }, // r13-bc: texture refusals since the last drain -> scene-adapter stats.unsupported
    // three r180 TSL package (tsl-export.js) as-is → gaia-render create_three_material. Texture bindings resolved through the
    // package's non-enumerable textureSources (uuid → three Texture); a texture binding without readable pixels = loud Error.
    createShaderMaterial(pkg) {
      if (!pkg?.vertex || !pkg?.fragment || !Array.isArray(pkg.bindGroups)) throw new Error('createShaderMaterial: tsl-export package required');
      const names = [], ids = [], owned = [], stor = [];
      const fail = (msg) => { for (const h of owned) releaseTexture(h); for (const s of stor) releaseStorage(s.h); throw new Error(msg); };
      for (const g of pkg.bindGroups) for (const b of g.bindings) {
        const kind = String(b.kind);
        if (kind === 'storage-buffer') {
          const attr = pkg.bufferSources?.[`${g.group}.${b.binding}`];
          if (!attr?.array?.buffer) fail(`createShaderMaterial: storage binding '${b.name}' (${g.group}.${b.binding}) has no readable buffer data`);
          stor.push({ key: `${g.group}.${b.binding}`, attr, h: acquireStorage(attr) });
          continue;
        }
        if (!kind.startsWith('texture')) continue;
        const t = pkg.textureSources?.[b.textureUuid];
        let h;
        if (kind === 'texture-2d-array') {
          const d = t && arrayTextureData(t);
          if (!d || d.refused) fail(`createShaderMaterial: texture array '${b.name}' (uuid ${b.textureUuid}) ${d?.refused ?? 'has no readable layer data'}`);
          h = acquireTexture(d);
        } else if (kind === 'texture-cube') { // r12-water: static CubeTexture (6 faces + GPU mips); render-target cube (CubeCamera) = loud refusal
          const d = t && cubeTextureData(t);
          if (!d || d.refused) fail(`createShaderMaterial: texture cube '${b.name}' (uuid ${b.textureUuid}) ${d?.refused ?? 'has no readable faces'}`);
          h = acquireTexture(d);
        } else if (kind === 'texture-2d') {
          // r5 adapter texture cache: ONE CPU read per (texture, version), GPU texture shared + refcounted across materials. three samples non-sRGB textures without decode (r4) → linear upload.
          const d = t && textureData(t);
          if (!d) fail(`createShaderMaterial: texture binding '${b.name}' (uuid ${b.textureUuid}) has no readable pixels`);
          h = acquireTexture(d);
        } else fail(`createShaderMaterial: texture binding '${b.name}' kind ${kind} unsupported`);
        owned.push(h); names.push(b.name); ids.push(h.id);
      }
      let id;
      try { id = gpu.createThreeMaterial(JSON.stringify(debugOutPkg(pkg)), names, Uint32Array.from(ids)); } catch (e) { fail(String(e?.message ?? e)); }
      for (const s of stor) gpu.bindThreeStorage(id, s.key, s.h.id);
      if (owned.length) matTextures.set(id, owned);
      if (stor.length) matStorage.set(id, stor);
      return id;
    },
    // r6-tsl-2: storage-buffer data follows three's BufferAttribute.version (re-uploaded only when it moved).
    updateShaderBuffers(id) {
      let n = 0;
      for (const h of matTextures.get(id) ?? []) { // data-less array pages: layers written to three's device after material creation (gpu-mirror)
        const c = h.key && texByKey.get(h.key); if (!c?.fresh) continue;
        const t = c.fresh(); if (!t || t.version === c.version) continue;
        const dirty = t.takeLayerUpdates(), S = t.width * t.height * 4;
        for (const l of dirty) gpu.updateTextureLayer(c.id, l, t.data.subarray(l * S, (l + 1) * S));
        c.version = t.version; texStats.layerUploads = (texStats.layerUploads ?? 0) + dirty.length; n++;
      }
      const stor = matStorage.get(id);
      if (!stor) return n;
      for (const s of stor) { const v = verOf(s.attr); if (s.h.version !== v) { gpu.updateStorageBuffer(s.h.id, bytesOf(s.attr.array)); s.h.version = v; n++; } }
      storStats.updates += n;
      return n;
    },
    setShaderTime(seconds) { gpu.setThreeTime(seconds); },
    // r4: changed live uniform values [{key,value}] (tsl-export pkg.live.update()) → core reflected uniform buffer.
    setShaderUniforms(id, changed) { if (changed.length) gpu.setThreeUniforms(id, JSON.stringify(changed)); },
    // r10-5: one wasm call per frame. list = [[materialId, changed[]]]; values identical across materials (shared camera/light/viewport nodes) are shipped + parsed once ("s"), materials reference them by index. batch.on=false -> legacy per-material calls (A/B flag, live: backend.uniBatch.on).
    uniBatch: { on: true, calls: 0, mats: 0, shared: 0, own: 0 },
    setShaderUniformsBatch(list) {
      const B = backend.uniBatch;
      if (!B.on) { for (const [id, ch] of list) backend.setShaderUniforms(id, ch); return; }
      const s = [], at = new Map(), m = [];
      for (const [id, ch] of list) {
        const idx = [], own = [];
        for (const c of ch) {
          const h = at.get(c.key);
          if (h === undefined) { at.set(c.key, { i: s.length, v: c.value }); idx.push(s.length); s.push(c); }
          else if (sameNum(h.v, c.value)) idx.push(h.i);
          else own.push(c);
        }
        m.push(own.length ? [id, idx, own] : [id, idx]);
      }
      B.calls++; B.mats += m.length; B.shared += s.length; B.own += m.reduce((a, x) => a + (x[2]?.length ?? 0), 0);
      if (m.length) gpu.setThreeUniformsBatch(JSON.stringify({ s, m }));
    },
    destroyMaterial(id) {
      gpu.destroyMaterial(id); matFlags.delete(id); recvUsers.delete(id);
      for (const h of matTextures.get(id) || []) releaseTexture(h);
      matTextures.delete(id);
for (const s of matStorage.get(id) || []) releaseStorage(s.h);
matStorage.delete(id);
},
createNode(mat4, parent = 0) {
      const node = { id: next++, kind: 'group', parent: 0, children: new Set(), local: Float64Array.from(asMat(mat4)), world: null, visible: true };
      nodes.set(node.id, node); link(node, parent);
      const [pw, pv] = parentState(node); sync(node, pw, pv);
      return node.id;
    },
    createInstance(mesh, material, mat4, flags = {}) {
      const node = { id: next++, kind: 'instance', parent: 0, children: new Set(), local: Float64Array.from(asMat(mat4)), world: null,
        visible: flags.visible !== false, mesh, material, rid: 0, ridMat: 0, ridMesh: 0, castShadow: flags.castShadow, shadowOnly: !!flags.shadowOnly, static: flags.static, groups: flags.groups ? normalizeGroups(flags.groups) : undefined, instAttrs: flags.instAttrs ?? null, renderOrder: flags.renderOrder || 0, receiveShadow: flags.receiveShadow };
      nodes.set(node.id, node); link(node, flags.parent);
      if (node.renderOrder) setMatOrder(material, node.renderOrder);
      trackReceive(node);
      const [pw, pv] = parentState(node); sync(node, pw, pv);
      return node.id;
    },
    // ---- native instancing (InstancedMesh / BatchedMesh geometry): ONE core instance block, matrices stay in the caller's typed array ----
    // mats = count×16 local mat4s (three instanceMatrix.array), flags.matrix = node matrixWorld (premultiplied in the core), flags.colors = count×stride rgb(a) (three instanceColor.array; stride 3|4).
    createInstanced(mesh, material, mats, count, flags = {}) {
      const node = { id: next++, kind: 'instanced', parent: 0, children: new Set(), mesh, material, rid: 0, mats, count, world: Float32Array.from(flags.matrix ?? IDENTITY_MAT4),
        colors: flags.colors ?? null, stride: flags.colorStride ?? 3, visible: flags.visible !== false, castShadow: flags.castShadow, shadowOnly: !!flags.shadowOnly, static: flags.static, ridMat: 0, ridMesh: 0 };
      nodes.set(node.id, node); pushBlock(node); return node.id;
    },
    updateInstances(id, mats, count, matrixWorld, colors = null, colorStride = 3) {
      const node = need(nodes, id, 'node');
      node.mats = mats; node.count = count; if (matrixWorld) node.world = Float32Array.from(matrixWorld); node.colors = colors; node.stride = colorStride;
      pushBlock(node);
    },
    updateNode(id, patch = {}) {
      const node = need(nodes, id, 'node');
      if (node.kind === 'instanced') {
        if (patch.visible !== undefined) node.visible = !!patch.visible;
        if (patch.material !== undefined) node.material = patch.material;
        if (patch.castShadow !== undefined) node.castShadow = !!patch.castShadow;
        if (patch.castShadow !== undefined) node.shadowOnly = !!patch.shadowOnly;
        if (patch.static !== undefined) node.static = !!patch.static;
        if (patch.mat4) node.world = Float32Array.from(patch.mat4);
        pushBlock(node, true); return;
      }
      if (patch.mat4) node.local = Float64Array.from(asMat(patch.mat4));
      if (patch.visible !== undefined) node.visible = !!patch.visible;
      if (patch.material !== undefined && node.kind === 'instance') node.material = patch.material;
      if (node.kind === 'instance' && (patch.receiveShadow !== undefined || patch.material !== undefined)) { if (patch.receiveShadow !== undefined) node.receiveShadow = patch.receiveShadow; trackReceive(node); }
      if (node.kind === 'instance' && (patch.renderOrder !== undefined || (patch.material !== undefined && node.renderOrder))) { if (patch.renderOrder !== undefined) node.renderOrder = patch.renderOrder || 0; setMatOrder(node.material, node.renderOrder); } // r8: core sorts per material
      if (node.kind === 'instance') {
      if (patch.castShadow !== undefined && patch.castShadow !== node.castShadow) { node.castShadow = !!patch.castShadow; if (node.rid) gpu.setInstanceCastShadow(node.rid, node.castShadow); }
      if (patch.castShadow !== undefined && !!patch.shadowOnly !== !!node.shadowOnly) { node.shadowOnly = !!patch.shadowOnly; /* adapter flags are always the full set: absent = false */ if (node.rid && gpu.setInstanceShadowOnly) gpu.setInstanceShadowOnly(node.rid, node.shadowOnly); }
      if (patch.groups !== undefined) { node.groups = patch.groups ? normalizeGroups(patch.groups) : { words: new Uint32Array(0) }; if (node.rid) { applyGroups(node); relinkGroupChildren(node); } }
      if (patch.static !== undefined && patch.static !== node.static) { node.static = !!patch.static; if (node.rid) gpu.setInstanceStatic(node.rid, node.static); }
      }
      // receiveShadow/euler: accepted, no-ops (core receivers = all opaque). renderOrder (r8) → material order flag above
      const [pw, pv] = parentState(node); sync(node, pw, pv);
    },
    removeNode(id) {
      const node = need(nodes, id, 'node');
      for (const cid of [...node.children]) backend.removeNode(cid);
      dropRids(node); untrackReceive(node);
      if (node.parent) nodes.get(node.parent)?.children.delete(id);
      nodes.delete(id);
    },

    // view = world→camera (as three's matrixWorldInverse); proj = perspective (see decomposePerspective for depth convention)
    setCamera(view, proj) {
      asMat(view); asMat(proj);
      const { yfov, znear, zfar } = decomposePerspective(proj, depth);
      gpu.setCamera(Float32Array.from(invert4(view)), yfov, znear, zfar);
    },

    // visibility groups: ACTIVE set (bit indices and/or u32 words; union of everything given). null = culling off (default).
    // An instance with groups is drawn iff its mask ∩ active ≠ ∅; no groups = always drawn. Main + shadow passes.
    setActiveGroups(active) {
      if (active == null) { gpu.clearActiveGroups(); return; }
      gpu.setActiveGroups(normalizeGroups(active).words);
    },
    setSun({ direction = [0, 1, 0], color = [1, 1, 1], intensity = 1 } = {}) {
      if (!sunId) sunId = next++;
      lights.set(sunId, { kind: 'sun', direction: [...direction], color: colorOf(color), intensity });
      lightsDirty = true;
      return sunId;
    },
    addPointLight({ position = [0, 0, 0], color = [1, 1, 1], intensity = 1, distance = 0, decay = 2 } = {}) {
      const id = next++;
      lights.set(id, { kind: 'point', position: [...position], color: colorOf(color), intensity, distance, decay });
      lightsDirty = true;
      return id;
    },
    updatePointLight(id, patch = {}) {
      const l = need(lights, id, 'light');
      if (patch.color) patch = { ...patch, color: colorOf(patch.color) };
      Object.assign(l, patch); lightsDirty = true;
    },
    removeLight(id) { need(lights, id, 'light'); lights.delete(id); if (id === sunId) sunId = 0; lightsDirty = true; },

    // r6: hemisphere + ambient light = irradiance E in three units (colour x intensity, linear; AmbientLight folded in by the adapter).
    // {sky:[r,g,b] (up-facing), ground:[r,g,b] (down-facing)}. Core divides by PI (three: E x BRDF_Lambert = E x albedo / PI).
    setAmbient({ sky = [0, 0, 0], ground = sky } = {}) { gpu.setHemisphereIrradiance(Float32Array.from(sky), Float32Array.from(ground)); },
    // r6: scene.background Color -> frame clear colour. rgb = LINEAR working-space colour (three Color.r/g/b), tone-mapped in the core (three tone-maps its background: measured r6 S4). null -> black.
    // r6 S3: probe-GI atlases (gi-bridge.js readback of three's GI compute). irradiance Float32Array 4/texel, depth 2/texel, params = packGiParams(). See gaia-render gi.rs.
    setGiProbes(irradiance, depth, params) { gpu.setGiProbes(irradiance, depth, params); },
    clearGiProbes() { gpu.clearGiProbes(); },
    // r6-scene: scene.background Texture/CubeTexture. {kind:'cube'|'equirect'|'screen', width, height, rgba (Uint8Array; cube = 6 faces), srgb, intensity}
    setBackgroundTexture({ kind, width, height, rgba, srgb = true, intensity = 1 }) {
      if (kind === 'cube') gpu.setBackgroundCube(width, rgba, srgb, intensity); else gpu.setBackgroundTexture(width, height, rgba, srgb, kind === 'equirect', intensity);
    },
    // r6-scene: scene.fog. {mode:1 Fog(smoothstep near..far)|2 FogExp2, color:[r,g,b] linear, near, far, density} | null = off
    setFog(f) { gpu.setFog(f?.mode ?? 0, Float32Array.from(f?.color ?? [0, 0, 0]), f?.near ?? 0, f?.far ?? 0, f?.density ?? 0); },
    // r6-scene: scene.environment diffuse IBL. {sh: Float32Array(27) (cosine-convolved, /PI), intensity} | null
    setEnvironment(e) { if (e) gpu.setEnvironmentSh(Float32Array.from(e.sh), e.intensity ?? 1); else gpu.clearEnvironment(); },
    // r10 post (core must be created with options.hdrScene=1; otherwise the core throws and the presenter stays on the legacy per-fragment path)
    setToneMapping(mode) { gpu.setToneMapping(mode); },
    setExposure(e) { gpu.setExposure(e); },
    setBloom(b) { if (b) gpu.setBloom(b.strength, b.radius, b.threshold, b.smoothWidth ?? 0.01); else gpu.setBloom(-1, 0, 0, 0); },
    // r12-post GTAO (three GTAONode + rig composite) or null = off. Normals are reconstructed from depth in the core.
    setGtao(g) { if (g) gpu.setGtao(true, g.radius, g.thickness, g.samples, g.distanceExponent ?? 1, g.distanceFallOff ?? 1, g.scale ?? 1, g.resolutionScale ?? 1, g.intensity ?? 1, g.fadeStart ?? 1e9, g.fadeEnd ?? 2e9); else gpu.setGtao(false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); },
    // r10-shadow-18 eye adaptation: GPU meter on/off + host multiplier; grid = Float32Array(64) mean log2 luma (raw HDR) or empty
    setAutoExposure(on, mul) { gpu.setAutoExposure(!!on, mul); },
    autoExposureGrid() { return gpu.autoExposureGrid(); },
    setBackground(rgb) { gpu.setBackgroundColor(Float32Array.of(rgb?.[0] ?? 0, rgb?.[1] ?? 0, rgb?.[2] ?? 0)); },
    renderFrame(/* dt */) {
    if (lightsDirty) pushLights();
      return gpu.render();
    },
    // wgpu-only: render + Promise<ms submit→queue-done> (wall clock incl. queue latency, not pure GPU time)
    renderFrameTimed() {
      if (lightsDirty) pushLights();
      return gpu.renderTimed();
    },
    // wgpu-only: render + Promise<{scene,upscale,total} GPU-timestamp ms | null> (null: no timestamp-query / sample in flight)
    renderFrameGpuTimed() {
      if (lightsDirty) pushLights();
      const frame = gpu.renderGpuTimed(), skin = gpu.skinGpuMs?.() ?? Promise.resolve(null);
      // per-pass GPU ms: scene / upscale / shadow (timestamp-pairs, sum = total) + skin compute (own pair; total excludes it, totalAll adds it) + span (earliest begin → latest end of the timed passes: includes GPU idle gaps / overlap)
      return Promise.all([frame, skin]).then(([t, sk]) => (t ? { ...t, skin: sk ?? 0, totalAll: t.total + (sk ?? 0) } : null));
    },
    resize(renderHeight) { gpu.setRenderHeight(renderHeight); },
    // wgpu-only (r4-browser): last frame's shadow work (passes/draws/cache hits) + runtime option change (re-creates the shadow system)
    shadowStats() { return gpu.shadowStats(); },
    setShadowOptions(o) { gpu.setShadowOptions(o); },
    dispose() { for (const id of [...nodes.keys()]) if (nodes.has(id) && !nodes.get(id).parent) backend.removeNode(id); gpu.free(); },
  };
  return backend;
}

export { IDENTITY_MAT4 };
