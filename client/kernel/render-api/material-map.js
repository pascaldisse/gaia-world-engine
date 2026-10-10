// render-api/material-map.js — three Material → render-api material description. NO three import (duck-typed).
import { arrayMirror } from './gpu-mirror.js';
import { readCube } from './env-image.js';
import { lightRegistry } from './light-registry.js';
//   MeshStandard/Physical/Basic/Lambert/Phong-ish → { kind:'pbr', params, textures, sig }  (createMaterial)
//   NodeMaterial (TSL)                           → { kind:'wgsl', package, fallbackParams, sig }  (createShaderMaterial; package from tsl-export.js)
// sig = cheap string compared every frame to detect edits that three's `version` counter does not cover (m.color.set(), m.opacity=…).
export const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
const rgb = (c) => (c ? [c.r, c.g, c.b] : [1, 1, 1]);
const nodeCache = new WeakMap(); // NodeMaterial → { version, package }

// ---- textures: ONE CPU read per (texture, version), lazy. textureData(t) returns a descriptor {width,height,srgb,key,data(getter)}:
//   key = `${uuid}:${version}` (backend caches GPU textures by it, refcounted); `data` is only touched on a backend cache MISS, so an idle frame
//   and every material sharing the texture cost 0 reads. Sources: Uint8 DataTexture as-is · canvas/ImageBitmap/HTMLImageElement/VideoFrame/ImageData
//   via ONE drawImage+getImageData (image-level WeakMap: texture clones sharing an ImageBitmap read it once; canvases are re-read only when texture.version moves).
const texCache = new WeakMap();   // Texture → { version, image, desc }
const pixelCache = new WeakMap(); // immutable image (ImageBitmap/HTMLImageElement/ImageData) → Uint8Array rgba
export const textureReads = { count: 0, ms: 0 }; // instrumentation: how many CPU pixel reads happened (proof: idle frame = 0)
let scratch = null;
// nt-pagemem (docs/NATIVE.md §page-memory): native mode = the host owns the pixels after upload, so the page must not keep a CPU copy. Defaults = browser behaviour (unchanged);
// wgpu-present.js calls configureMaterialMap(pageMemConfig(params)) when renderBackend=native (defaults + URL params: native/page-memory.js).
export const mapConfig = { retainPixels: true, scratchKeepPx: 1 << 20, releaseSources: false, released: 0 };
export function configureMaterialMap(o = {}) { for (const k of ['retainPixels', 'scratchKeepPx', 'releaseSources']) if (o[k] !== undefined) mapConfig[k] = o[k]; return mapConfig; }
const EMPTY_U8 = new Uint8Array(0);
const releasedTex = new WeakSet(); // textures whose CPU source was dropped after upload (materialSig must still see 'has image')
const releaseFlag = (t) => (t.userData?.nativeRelease !== undefined ? !!t.userData.nativeRelease : mapConfig.releaseSources);
const isBytes = (d) => d instanceof Uint8Array || d instanceof Uint8ClampedArray;
function drawable(im) {
  return (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && im instanceof HTMLImageElement) ||
    (typeof VideoFrame !== 'undefined' && im instanceof VideoFrame) || (typeof OffscreenCanvas !== 'undefined' && im instanceof OffscreenCanvas) || (typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement);
}
function readPixels(im, w, h, keep = true) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let out = null;
  if (isBytes(im.data) && im.data.length === w * h * 4) out = new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.length);
  else if (typeof ImageData !== 'undefined' && im instanceof ImageData) out = new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength);
  else if (typeof im.getContext === 'function' && !drawable(im)) { // duck-typed canvas (own 2d context): re-read only when texture.version moves
    const d = im.getContext('2d')?.getImageData(0, 0, w, h);
    if (d) out = new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength);
  } else if (drawable(im)) {
    const immutable = !(typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement) && !(typeof OffscreenCanvas !== 'undefined' && im instanceof OffscreenCanvas);
    if (immutable && keep && pixelCache.has(im)) return pixelCache.get(im);
    if (!scratch) scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    const c = scratch.getContext('2d', { willReadFrequently: true });
    c.globalCompositeOperation = 'copy'; c.drawImage(im, 0, 0, w, h);
    out = new Uint8Array(c.getImageData(0, 0, w, h).data.buffer);
    if (immutable && keep) pixelCache.set(im, out);
    if (!keep && w * h > mapConfig.scratchKeepPx) { scratch.width = 1; scratch.height = 1; } // frees the CPU backing store of a big decode canvas (re-grown on demand)
  }
  if (out) { textureReads.count++; textureReads.ms += (typeof performance !== 'undefined' ? performance.now() : 0) - t0; }
  return out;
}
// r13-bc: three CompressedTexture (DDS/KTX2 loaders: image {width,height}, mipmaps[{data,width,height}], format = GL internal format) -> compressed descriptor
// {compressed,format,width,height,mipCount,flipY,srgb,key,data(getter: mip chain concatenated)}. The GPU core decides native BC upload vs CPU decode (gaia-render create_texture_compressed).
// Anything we cannot hand over (unknown format / no mips / mip data not bytes / mips not a halving chain) = { compressed, refused } -> materialToParams records it in unsupported (never silent).
export const COMPRESSED_GL = { 33776: 'BC1-rgb', 33777: 'BC1-rgba', 33778: 'BC2', 33779: 'BC3', 36283: 'BC4', 36285: 'BC5', 36492: 'BC7' }; // GL internal formats the core uploads (mirrors gaia-render bc::from_gl)
function compressedData(t) {
  const im = t.image, mm = t.mipmaps;
  const w = im?.width ?? mm?.[0]?.width, h = im?.height ?? mm?.[0]?.height;
  if (!COMPRESSED_GL[t.format]) return { compressed: true, refused: `compressed format ${t.format} (only ${Object.values(COMPRESSED_GL).join('/')} are uploaded; ASTC/ETC2/PVRTC/BC6H/signed-RGTC refused)` };
  if (!Array.isArray(mm) || !mm.length) return { compressed: true, refused: 'CompressedTexture without mipmaps[]' };
  if (!(w > 0 && h > 0)) return { compressed: true, refused: 'CompressedTexture without image size' };
  const levels = [];
  for (let l = 0; l < mm.length; l++) {
    const m = mm[l], d = m?.data;
    if (!d || !ArrayBuffer.isView(d)) return { compressed: true, refused: `mip ${l} data is not a byte view (${d?.constructor?.name})` };
    if (m.width !== Math.max(1, w >> l) || m.height !== Math.max(1, h >> l)) return { compressed: true, refused: `mip ${l} size ${m.width}x${m.height} is not ${Math.max(1, w >> l)}x${Math.max(1, h >> l)}` };
    levels.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  }
  let bytes; // lazy: concatenated only on a backend cache MISS; kept only while mapConfig.retainPixels (browser) — native writes `chunks` straight into the stream (no concat, no memo)
  const total = levels.reduce((a, b) => a + b.length, 0);
  const desc = { compressed: true, format: t.format, width: w, height: h, mipCount: levels.length, flipY: !!t.flipY, srgb: t.colorSpace === 'srgb', key: `${t.uuid}:${t.version}`, bytes: total, released: false,
    get data() { if (desc.released) return null; if (bytes) return bytes; const b = new Uint8Array(total); let o = 0; for (const l of levels) { b.set(l, o); o += l.length; } if (mapConfig.retainPixels) bytes = b; return b; },
    get chunks() { return desc.released ? null : levels; },
    /** after the host acked the upload: drop the game-owned mip views (opt-in: texture.userData.nativeRelease / ?nativeReleaseSrc=1). Re-upload of this texture is then impossible (loud). */
    release: !releaseFlag(t) ? null : () => { if (desc.released) return; desc.released = true; bytes = null; levels.length = 0; for (const m of mm) m.data = EMPTY_U8; releasedTex.add(t); mapConfig.released++; } };
  return desc;
}
const isImageSource = (im) => (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && im instanceof HTMLImageElement);
/** cheap pre-flight (NO pixel read, no descriptor): { key, bytes } a texture would cost on the wire if its key is not yet on the host. Used by the adapter's encode budget. */
export function textureEstimate(t) {
  if (!t) return null;
  if (t.isCompressedTexture) { let n = 0; for (const m of t.mipmaps ?? []) n += m?.data?.byteLength ?? 0; return { key: `${t.uuid}:${t.version}`, bytes: n }; }
  const im = t.image; if (!im) return releasedTex.has(t) ? { key: `${t.uuid}:${t.version}`, bytes: 0 } : null;
  const w = im.width ?? im.videoWidth ?? im.displayWidth ?? 0, h = im.height ?? im.videoHeight ?? im.displayHeight ?? 0;
  return { key: `${t.uuid}:${t.version}`, bytes: w * h * 4 };
}
function textureData(t) {
  if (t?.isCompressedTexture) { const c = texCache.get(t); if (c && c.version === t.version && c.mm === t.mipmaps) return c.desc; const desc = compressedData(t); texCache.set(t, { version: t.version, image: t.image, mm: t.mipmaps, desc }); return desc; }
  const rc = texCache.get(t);
  if (rc && rc.desc.released && rc.version === t.version) return rc.desc; // source dropped after upload: the cached key descriptor is all that is left (backend GPU cache hit)
  const im = t?.image;
  if (!im) return null;
  const c = rc;
  if (c && c.version === t.version && c.image === im) return c.desc;
  const w = im.width ?? im.videoWidth ?? im.displayWidth, h = im.height ?? im.videoHeight ?? im.displayHeight;
  const readable = isBytes(im.data) || drawable(im) || typeof im.getContext === 'function' || (typeof ImageData !== 'undefined' && im instanceof ImageData);
  if (!readable || !(w > 0 && h > 0)) return undefined; // present but not CPU-readable here
  let px; // lazy; memoised only while mapConfig.retainPixels (browser). Native: every read is a transient (the host owns the pixels once uploaded)
  const desc = { width: w, height: h, srgb: t.colorSpace === 'srgb', key: `${t.uuid}:${t.version}`, bytes: w * h * 4, released: false,
    get data() { if (desc.released) return null; if (!mapConfig.retainPixels) return readPixels(im, w, h, false); return px ??= readPixels(im, w, h); },
    release: !releaseFlag(t) || !(isImageSource(im)) ? null : () => { if (desc.released) return; desc.released = true; px = null; if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) im.close(); try { t.source.data = null; } catch { /* three Source setter */ } releasedTex.add(t); mapConfig.released++; } };
  texCache.set(t, { version: t.version, image: im, desc });
  return desc;
}
// r6-tsl-2: DataArrayTexture (image {data,width,height,depth}) -> array descriptor {array,layers,key,version,data,takeLayerUpdates}; generic three type, no game contract.
// Compressed arrays are REFUSED loudly (BC/ASTC upload not implemented). Layer updates = three's own texture.layerUpdates set (null = all layers).
export function arrayTextureData(t) {
  const im = t?.image;
  if (t && !im?.data && (t.isDataArrayTexture || t.isArrayTexture)) { // data-less page uploaded straight to three's GPU: read the queue.writeTexture mirror (gpu-mirror.js)
    const m = arrayMirror(t); if (!m) return null;
    return { array: true, width: m.w, height: m.h, layers: m.layers, srgb: t.colorSpace === 'srgb', key: `${t.uuid}:array`, version: `${t.version}:${m.version}`, data: m.data, fresh: () => arrayTextureData(t),
      takeLayerUpdates() { const d = [...m.dirty]; m.dirty.clear(); return d; } };
  }
  if (!im?.data || !(im.width > 0 && im.height > 0 && im.depth > 0)) return null;
  if (t.isCompressedArrayTexture || t.isCompressedTexture) return { array: true, refused: 'compressed texture array (BC/ASTC upload not implemented)' };
  if (!isBytes(im.data) || im.data.length !== im.width * im.height * 4 * im.depth) return { array: true, refused: `array texture data is not rgba8 (${im.data.constructor?.name} len ${im.data.length} vs ${im.width}x${im.height}x4x${im.depth})` };
  return { array: true, width: im.width, height: im.height, layers: im.depth, srgb: t.colorSpace === 'srgb', key: `${t.uuid}:array`, version: t.version, data: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.length),
    takeLayerUpdates() { const s = t.layerUpdates; const d = s && s.size ? [...s] : null; t.clearLayerUpdates?.(); return d; } };
}
// r12-water: three CubeTexture (image = 6 faces +X -X +Y -Y +Z -Z) -> cube descriptor {cube,size,srgb,key,version,data(6 faces RGBA8, top-first)}. Generic three type, no game contract.
// Static cubes only: a render-target cube (CubeCamera / WebGLCubeRenderTarget texture) or unreadable faces = LOUD { cube, refused } (caller throws), never a silent skip.
const cubeCache = new WeakMap();
export function cubeTextureData(t) {
  if (!t) return null;
  if (t.isRenderTargetTexture || t.isCompressedCubeTexture) return { cube: true, refused: t.isCompressedCubeTexture ? 'compressed CubeTexture (BC/ASTC upload not implemented)' : 'render-target cube (dynamic CubeCamera / PMREM render-to-cube not implemented; only static CubeTexture)' };
  const c = cubeCache.get(t); if (c && c.version === t.version && c.image === t.image) return c.desc;
  let r; try { r = readCube(t); } catch (e) { return { cube: true, refused: String(e?.message ?? e) }; }
  if (r.hdrClamped) return { cube: true, refused: 'HDR/float CubeTexture (RGBA8 upload only; clamping would be a silent downgrade)' };
  const desc = { cube: true, size: r.size, srgb: r.srgb, key: `${t.uuid}:cube:${t.version}`, version: t.version, data: r.faces };
  cubeCache.set(t, { version: t.version, image: t.image, desc });
  return desc;
}
export { textureData };
export function pbrParams(m) {
const kind = m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial || m.isSpriteMaterial || m.isPointsMaterial ? 'basic' : m.isMeshLambertMaterial ? 'lambert' : m.isMeshPhysicalMaterial ? 'physical' : 'standard';
const p = {
color: rgb(m.color), opacity: m.opacity ?? 1, transparent: !!m.transparent, doubleSide: m.side === 2, backSide: m.side === 1,
flatShading: !!m.flatShading, fog: m.fog !== false, wireframe: !!m.wireframe, depthWrite: m.depthWrite !== false, depthTest: m.depthTest !== false, colorWrite: m.colorWrite !== false,
alphaTest: m.alphaTest ?? 0, visible: m.visible !== false,
roughness: kind === 'lambert' ? 1 : kind === 'basic' ? 1 : (m.roughness ?? 1), metalness: kind === 'standard' || kind === 'physical' ? (m.metalness ?? 0) : 0,
emissive: rgb(m.emissive ?? { r: 0, g: 0, b: 0 }), emissiveIntensity: m.emissiveIntensity ?? 1,
};
// r8: Basic = no lighting (three MeshBasic*Material). NOT for a NodeMaterial with custom *Node slots: its look comes from those nodes (TSL package path); the plain-PBR fallback of such a material stays lit (r6: flat white walls).
if (kind === 'basic' && !(m.isNodeMaterial && hasNodes(m))) { p.unlit = true; p.toneMapped = true; /* r8 MEASURED (r8-blend.html): three r180 WebGPURenderer with renderer.toneMapping set tone-maps EVERY canvas fragment, `material.toneMapped:false` white opaque reads 188 (= Reinhard(1) sRGB) not 255 → unlit stays tone-mapped in the core */ }
if (kind === 'physical') for (const k of ['clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'sheen', 'iridescence']) if (m[k]) p[k] = m[k];
if (m.userData?.preset) p.preset = m.userData.preset;
if (m.userData?.dsChrLight) p.chrLight = true; // lampas L-wgpu-tex: set on the mesh (adapter matKey chr variant) or the material -> core extra directional lights (setExtraDirs) apply to this material only
// r9: three's GI attach (kernel/gi/gi-attach.js isGIEligibleMaterial) only wires probe GI into Standard/Physical/Lambert *NodeMaterial*; a plain MeshStandardMaterial (GLTFLoader figure, skinned or not) is lit by the hemisphere light only → tell the core not to sample the probes for it.
if (!(m.isMeshStandardNodeMaterial || m.isMeshPhysicalNodeMaterial || m.isMeshLambertNodeMaterial)) p.noGi = true;
if (m.isSpriteMaterial || m.isPointsMaterial) p.doubleSide = true; // r19-pcol: PointsMaterial quads are camera-facing too // r18: THREE.Sprite billboard quad is drawn from either side (camera-facing; never culled)
// r19-pcol blend modes -> core BlendKind. three: 2 Additive, 3 Subtractive, 4 Multiply, 5 Custom (blendSrc/blendDst decoded: One/OneMinusSrcAlpha = premultiplied, SrcAlpha/One = additive, Zero/SrcColor = multiply; other = normal alpha).
// Normal + premultipliedAlpha:true = three multiplies rgb by alpha in the shader then blends One/OneMinusSrcAlpha == plain alpha blending -> 'alpha' (no extra mode needed).
if (m.blending === 2) p.blending = 'additive';
else if (m.blending === 3) p.blending = 'subtractive';
else if (m.blending === 4) p.blending = 'multiply';
else if (m.blending === 5) { const bs = m.blendSrc, bd = m.blendDst; p.blending = bs === 201 && bd === 205 ? 'premultiplied' : (bs === 204 || bs === 201) && bd === 201 ? 'additive' : (bs === 208 && bd === 200) || (bs === 200 && bd === 202) ? 'multiply' : 'alpha'; } // three consts: Zero 200, One 201, SrcColor 202, SrcAlpha 204, OneMinusSrcAlpha 205, DstColor 208
return p;
}

const SLOT_SIG = (m) => { let s = ''; for (const slot of TEX_SLOTS) { const t = m[slot]; if (t) s += `|${slot}:${t.uuid}:${t.version}:${t.image || releasedTex.has(t) ? 1 : 0}`; } return s; };
// cheap per-frame change signature (NO allocation of params/textures, NO pixel reads). conv.sig === materialSig(m) by construction.
export function materialSig(m, { exportNodeMaterial = null } = {}) {
  if (m.isNodeMaterial && exportNodeMaterial && customNode(m)) return `wgsl:${m.uuid}:${m.version}`;
  const c = m.color, e = m.emissive;
  return `pbr:${c ? c.r + ',' + c.g + ',' + c.b : ''}|${m.opacity}|${+!!m.transparent}|${m.side}|${+!!m.flatShading}|${m.roughness}|${m.metalness}|${e ? e.r + ',' + e.g + ',' + e.b : ''}|${m.emissiveIntensity}|${m.alphaTest}|${+(m.visible !== false)}|${m.blending}|${m.blendSrc ?? ''}|${m.blendDst ?? ''}|${+!!m.premultipliedAlpha}|${m.toneMapped}|${+!!m.wireframe}|${+(m.depthWrite !== false)}|${+(m.depthTest !== false)}|${+(m.colorWrite !== false)}|${m.clearcoat ?? ''}|${m.clearcoatRoughness ?? ''}|${m.transmission ?? ''}|${m.ior ?? ''}|${m.thickness ?? ''}|${m.sheen ?? ''}|${m.iridescence ?? ''}|${m.userData?.preset ?? ''}|f${+(m.fog !== false)}|c${+!!m.userData?.dsChrLight}${SLOT_SIG(m)}`; // r18: fog flag is a core material flag -> part of the sig
}
const customCache = new WeakMap(); // NodeMaterial → { version, v }
export function customNodeMaterial(m) { return customNode(m); }
function customNode(m) { let c = customCache.get(m); if (!c || c.version !== m.version) { c = { version: m.version, v: isCustomNode(m) }; customCache.set(m, c); } return c.v; }
export function materialToParams(m, { exportNodeMaterial = null, three = null, tslOptions = {} } = {}) {
  const params = pbrParams(m);
  // r6: legacy GLSL ShaderMaterial/RawShaderMaterial (bp-sky dome) — WebGPURenderer rejects it ('Material "ShaderMaterial" is not compatible'), so three draws NOTHING; match it (never a default-PBR sphere) + say so loudly. GLSL->WGSL translation REFUSED (see docs §10).
  if (m.isShaderMaterial || m.isRawShaderMaterial) return { kind: 'pbr', params: { ...params, visible: false }, textures: null, sig: materialSig(m), degraded: 'ShaderMaterial-GLSL-unsupported:not-drawn(three-parity)' };
const textures = {}, unsupported = [];
  for (const slot of TEX_SLOTS) {
    const t = m[slot]; if (!t) continue;
    const d = textureData(t);
    if (d?.refused) unsupported.push(`texture:${slot}:${d.refused}`); // r13-bc: a refused texture is dropped from the material but RECORDED (stats.unsupported), never silent
    else if (d) textures[slot] = d;
    else if (t.image) unsupported.push(`texture:${slot}:image not CPU-readable (${t.image.constructor?.name ?? typeof t.image})`);
  }
  const hasTex = Object.keys(textures).length > 0;
  const sig = materialSig(m, { exportNodeMaterial });
  if (m.isNodeMaterial && customNode(m)) {
    if (!exportNodeMaterial) return { kind: 'pbr', unsupported: unsupported.length ? unsupported : undefined, params, textures: hasTex ? textures : null, sig, degraded: 'NodeMaterial-without-exporter:pbr-fallback' };
    let c = nodeCache.get(m);
    const recv = !!tslOptions?.receiveShadow; // r10-shadow-5: the package depends on the receiver flag (hook) → part of the cache key
const lg = tslOptions?.scene ? lightRegistry(tslOptions.scene).gen : 0; // r16-fcull: the package BAKES the scene's light set -> a never-seen light (grow-only registry gen) must rebuild it; adapter's sig-suffix re-export alone hit this cache and re-shipped the STALE package (new lights never entered the LightsNode)
if (!c || c.version !== m.version || c.recv !== recv || c.lg !== lg) {
  // r6: an export failure is a LOUD per-material refusal (adapter counts + logs it, material drops to PBR) — never a thrown frame
  try { c = { version: m.version, recv, lg, package: exportNodeMaterial(m, { ...tslOptions }) }; } catch (e) { c = { version: m.version, recv, lg, error: String(e?.message ?? e) }; }
  nodeCache.set(m, c);
}
if (c.error) return { kind: 'pbr', unsupported: unsupported.length ? unsupported : undefined, params, textures: hasTex ? textures : null, sig, degraded: 'tsl-export-refused:pbr-fallback', tslRefused: { stage: 'export', reason: c.error } };
return { kind: 'wgsl', unsupported: unsupported.length ? unsupported : undefined, package: c.package, fallbackParams: params, fallbackTextures: hasTex ? textures : null, sig };
  }
  return { kind: 'pbr', unsupported: unsupported.length ? unsupported : undefined, params, textures: hasTex ? textures : null, sig, degraded: m.isNodeMaterial ? 'NodeMaterial-without-exporter:pbr-fallback' : undefined }; // emissiveMap: === map -> emissive x base texel (r7), distinct -> own slot (r6 maps)
}
// a *NodeMaterial with no custom *Node slot set renders exactly like its non-node twin → plain PBR is faithful
function hasNodes(m) {
for (const k in m) if (k.endsWith('Node') && m[k]) return true;
return false;
}
// only Mesh*NodeMaterial have a plain-PBR twin the backend draws faithfully; Sprite/Points/Line*NodeMaterial carry their own
// vertex stage (billboard, point size, line width) → always the shader package (Round 3b: SpriteNodeMaterial drew as a PBR cube).
const PBR_TWIN = /^Mesh(Basic|Standard|Physical|Lambert|Phong|Toon|Matcap|Normal)NodeMaterial$/;
const isCustomNode = (m) => !PBR_TWIN.test(m.type ?? '') || hasNodes(m) || (m.constructor?.name && m.type && m.constructor.name !== m.type) || typeof m.setupDiffuseColor === 'function' && m.setupDiffuseColor !== Object.getPrototypeOf(Object.getPrototypeOf(m))?.setupDiffuseColor;
