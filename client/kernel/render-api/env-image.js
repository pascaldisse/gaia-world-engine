// render-api/env-image.js — CPU side of scene.background Texture/Cube + scene.environment IBL (r6-scene). NO three import (duck-typed).
//   readTexture(tex)      → { w, h, rgba8:Uint8Array (rows TOP-first), srgb:boolean, linear?:Float32Array rgba (HDR sources), hdrClamped }
//   readCube(tex)         → { size, faces:Uint8Array(6·size²·4), srgb, linear?:Float32Array[6], hdrClamped }
//   shIrradiance(src)     → Float32Array(27): SH9 of the radiance, cosine-convolved (A0=π, A1=2π/3, A2=π/4) and /π → forward.wgsl sh_irradiance(n) = E(n)/π
// Image sources: typed-array data (DataTexture: Uint8/Uint8Clamped/Float32/HalfFloat Uint16, RGBA) or decodable images (ImageBitmap/HTMLImage/canvas via OffscreenCanvas).
// Row order: 2D DataTexture rows are GL-order (row 0 = v 0 = bottom) unless flipY → reversed to top-first; decoded images / cube faces are used as-is.
// nt-imgdecode: native page-memory policy (material-map.configureMaterialMap <- native/page-memory.js shrinkEnvCanvas). Browser default = off (canvas left to GC, old behaviour).
export const envConfig = { shrinkCanvas: false };
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const isSrgb = (t) => t.colorSpace === 'srgb';
function halfToFloat(h) { const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff; return (s ? -1 : 1) * (e === 0 ? 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : Infinity) : 2 ** (e - 15) * (1 + f / 1024)); }

function rawPixels(img) { // → { w, h, data (RGBA typed array), isData }
  if (img?.data && img.width && img.height) {
    const n = img.width * img.height, d = img.data;
    if (d.length !== n * 4) throw new Error(`env-image: only RGBA data supported (got ${d.length / n} channels)`);
    return { w: img.width, h: img.height, data: d, isData: true };
  }
  const w = img?.width ?? img?.videoWidth, h = img?.height ?? img?.videoHeight;
  if (!w || !h) throw new Error('env-image: texture has no readable image');
  const Canvas = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
  const c = Canvas ? new Canvas(w, h) : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
  if (!c) throw new Error('env-image: no canvas to decode image (node): supply DataTexture-like {data,width,height}');
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, h).data; // ImageData owns its own bytes: the canvas backing store (w*h*4, WebKit malloc, kept until GC) can go now
  if (envConfig.shrinkCanvas) { try { c.width = 1; c.height = 1; } catch { /* detached */ } }
  return { w, h, data, isData: false };
}
// → { w, h, rgba8 (top-first), srgb, linear? }
function toRGBA8(tex, img, reverseData) {
  const { w, h, data, isData } = rawPixels(img);
  const reverse = isData && reverseData(); // DataTexture 2D w/o flipY: row 0 = bottom → flip to top-first. images + cube faces: already top-first.
  const out = new Uint8Array(w * h * 4); let linear = null, hdr = false;
  const isFloat = data instanceof Float32Array, isHalf = data instanceof Uint16Array;
  if (isFloat || isHalf) { linear = new Float32Array(w * h * 4); hdr = true; }
  for (let y = 0; y < h; y++) {
    const sy = reverse ? h - 1 - y : y;
    for (let x = 0; x < w * 4; x++) {
      const si = sy * w * 4 + x, di = y * w * 4 + x, ch = x & 3, v = data[si];
      if (isFloat || isHalf) { const f = isHalf ? halfToFloat(v) : v; linear[di] = f; out[di] = ch === 3 ? Math.round(Math.min(1, Math.max(0, f)) * 255) : Math.round(l2s(Math.min(1, Math.max(0, f))) * 255); }
      else out[di] = v;
    }
  }
  return { w, h, rgba8: out, srgb: (isFloat || isHalf) ? true : isSrgb(tex), linear, hdrClamped: hdr };
}
export function readTexture(tex) {
  if (!tex || tex.isRenderTargetTexture) throw new Error('env-image: render-target / PMREM textures are not CPU-readable');
  return toRGBA8(tex, tex.image, () => !tex.flipY);
}
export function readCube(tex) {
  const imgs = tex?.image;
  if (!Array.isArray(imgs) || imgs.length !== 6) throw new Error('env-image: CubeTexture needs image[6]');
  const faces = imgs.map((im) => toRGBA8(tex, im, () => false));
  const size = faces[0].w;
  if (faces.some((f) => f.w !== size || f.h !== size)) throw new Error('env-image: cube faces must be square and equal');
  const out = new Uint8Array(6 * size * size * 4); faces.forEach((f, i) => out.set(f.rgba8, i * size * size * 4));
  return { size, faces: out, srgb: faces[0].srgb, linear: faces[0].linear ? faces.map((f) => f.linear) : null, hdrClamped: faces.some((f) => f.hdrClamped) };
}

const Y = (x, y, z) => [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
const A = [Math.PI, 2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
function finishSh(L) { const o = new Float32Array(27); for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) o[i * 3 + c] = (A[i] * L[i * 3 + c]) / Math.PI; return o; }
const texel = (rgba8, linear, i, srgb) => linear ? [linear[i], linear[i + 1], linear[i + 2]] : (srgb ? [s2l(rgba8[i] / 255), s2l(rgba8[i + 1] / 255), s2l(rgba8[i + 2] / 255)] : [rgba8[i] / 255, rgba8[i + 1] / 255, rgba8[i + 2] / 255]);
// world dir of a cube texel as the SHADER sees it: lookup dir s (GL face table) then three's x flip (CubeTextureNode flipEnvMap=-1) → d = (-s.x, s.y, s.z)
const FACE = [(u, v) => [1, -v, -u], (u, v) => [-1, -v, u], (u, v) => [u, 1, v], (u, v) => [u, -1, -v], (u, v) => [u, -v, 1], (u, v) => [-u, -v, -1]];
/** cube = readCube() result, or equirect = readTexture() result (+ `equirect:true`). `maxN` per-face / per-axis sample cap (stride). */
export function shIrradiance(src, { equirect = false, maxN = 64 } = {}) {
  const L = new Float64Array(27);
  if (!equirect) {
    const n = src.size, st = Math.max(1, Math.floor(n / maxN));
    for (let f = 0; f < 6; f++) for (let y = 0; y < n; y += st) for (let x = 0; x < n; x += st) {
      const u = 2 * (x + 0.5) / n - 1, v = 2 * (y + 0.5) / n - 1, s = FACE[f](u, v), l = Math.hypot(...s), d = [-s[0] / l, s[1] / l, s[2] / l];
      const dw = (4 / (n * n)) * st * st / (1 + u * u + v * v) ** 1.5, i = (f * n * n + y * n + x) * 4;
      const c = texel(src.faces, src.linear?.[f] ? src.linear[f] : null, src.linear?.[f] ? (y * n + x) * 4 : i, src.srgb), Yv = Y(...d);
      for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) L[k * 3 + ch] += c[ch] * Yv[k] * dw;
    }
  } else {
    const { w, h } = src, sx = Math.max(1, Math.floor(w / (maxN * 4))), sy = Math.max(1, Math.floor(h / (maxN * 2)));
    for (let y = 0; y < h; y += sy) for (let x = 0; x < w; x += sx) {
      const phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI, th = (0.5 - (y + 0.5) / h) * Math.PI, c0 = Math.cos(th);
      const d = [Math.cos(phi) * c0, Math.sin(th), Math.sin(phi) * c0], dw = (2 * Math.PI / w) * sx * (Math.PI / h) * sy * c0;
      const c = texel(src.rgba8, src.linear, (y * w + x) * 4, src.srgb), Yv = Y(...d);
      for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) L[k * 3 + ch] += c[ch] * Yv[k] * dw;
    }
  }
  return finishSh(L);
}
/** reference: evaluate E(n)/π from sh27 (same formula as forward.wgsl) */
export function evalSh(sh, n) { const Yv = Y(n[0], n[1], n[2]); return [0, 1, 2].map((c) => Math.max(0, Yv.reduce((s, y, k) => s + y * sh[k * 3 + c], 0))); }
