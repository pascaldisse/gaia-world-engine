// render-api/gpu-mirror.js — CPU mirror of array-texture uploads that go straight to three's OWN GPU device (queue.writeTexture, DataArrayTexture.image.data == null).
// Generic three/WebGPU fact, no game hint: three's GPUTexture is a different device than the wgpu core's → pixels are only readable by shadowing the writes.
// install(renderer) wraps device.queue.writeTexture once; arrayMirror(texture) → {data,version,dirty} bound lazily (pending → GPUTexture on first write).
const mirrors = new WeakMap(); // GPUTexture → m
const byTex = new WeakMap(); // three Texture → m
const pending = new Set(); // three Textures awaiting their first write
let be = null;
const bytesOf = (d) => (d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
export function installGpuMirror(renderer) {
  const b = renderer?.backend, q = b?.device?.queue;
  if (!q || q.__gaiaMirror) return false;
  be = b; q.__gaiaMirror = true;
  const orig = q.writeTexture.bind(q);
  q.writeTexture = (dst, data, layout, size) => {
    try { shadow(dst, data, layout, size); } catch (e) { console.warn('[gpu-mirror]', e); }
    return orig(dst, data, layout, size);
  };
  return true;
}
function bind(gtex) {
  let m = mirrors.get(gtex); if (m) return m;
  for (const t of pending) { const g = be.get(t)?.texture; if (g === gtex) { m = byTex.get(t); mirrors.set(gtex, m); pending.delete(t); return m; } }
  return null;
}
function shadow(dst, data, layout, size) {
  const gtex = dst.texture; if (!gtex || (dst.mipLevel ?? 0) !== 0) return;
  const m = bind(gtex); if (!m) return;
  const o = dst.origin ?? {}, x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0, w = size.width, h = size.height ?? 1, d = size.depthOrArrayLayers ?? 1;
  const src = bytesOf(data), bpr = layout.bytesPerRow ?? w * 4, rpi = layout.rowsPerImage ?? h, off = layout.offset ?? 0;
  if (w !== m.w && x === 0) return; // only whole-width rgba8 rows (what three/the game write)
  for (let l = 0; l < d; l++) { for (let r = 0; r < h; r++) { const s = off + l * bpr * rpi + r * bpr; m.data.set(src.subarray(s, s + w * 4), ((z + l) * m.h + y + r) * m.w * 4 + x * 4); } m.dirty.add(z + l); }
  m.version++;
}
/** mirror for a data-less DataArrayTexture (allocated on first ask; zeros until three's device gets writes). */
export function arrayMirror(t) {
  let m = byTex.get(t); if (m) return m;
  const im = t.image; if (!be || !(im?.width > 0 && im.height > 0 && im.depth > 0)) return null;
  m = { w: im.width, h: im.height, layers: im.depth, data: new Uint8Array(im.width * im.height * 4 * im.depth), version: 0, dirty: new Set() };
  byTex.set(t, m); pending.add(t); return m;
}
