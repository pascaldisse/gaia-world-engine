// mem-account.js — page-side byte accounting for the NATIVE app (docs/NATIVE.md §page-mem-log). WKWebView has no performance.memory / CDP, so the page counts what it holds itself
// and prints ONE line per tick through gaia_page_log(level 'mem') -> host stderr `[page:mem] …` (host appends its own footprint + WebContent's).
// Registry other modules feed:  register(name, probeFn)  probeFn() -> flat {key: number|string}; key ending 'Bytes' prints as `<key>_MB`.
//                               trackBuffer(cat, ArrayBuffer|view)  weak (WeakRef) — live bytes per category, deduped by ArrayBuffer identity
//                               trackTexture(texture)               weak — textures the render-api sent to the host (material-map textureData choke point)
// DOM-free at import (headless imports ok). Nothing runs until attachNative()/startMemLog().
import { leakGuards } from './page-memory.js'; // nt-frameleak
export const MEM_PARAMS = {
  // single place for tunables (the interval itself is host-owned: --page-mem-ms -> __GAIA_NATIVE__.pageMemMs)
  decodedBytesPerPixel: 4,   // ImageBitmap/HTMLImageElement/canvas: decoded backing estimate = w*h*this (WebKit gives no real size)
  maxLineChars: 1800,        // cap of one [page:mem] line (page-log-max default 2000 minus host suffix)
  logLevel: 'mem',           // gaia_page_log level -> `[page:mem]`
  sceneGetter: () => globalThis.gaia?.scene ?? null, // root walked once per tick for geometry + material textures
};
const MB = 1048576;
const probes = new Map();
const bufs = new Map();           // category -> Set<WeakRef<ArrayBuffer>>
const texRefs = new Set();         // WeakRef<Texture>
const texSeen = new WeakSet();
const isBuf = (b) => b instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer);
const bufOf = (a) => (isBuf(a) ? a : ArrayBuffer.isView(a) ? a.buffer : null);
export function register(name, fn) { probes.set(name, fn); }
export function unregister(name) { probes.delete(name); }
// nt-frameleak: EXTRA lines printed after the main one every tick (own 1800-char budget: the main line is already near the cap). registerLine(name, fn) fn() -> flat {key: number|string}.
const lines = new Map();
export function registerLine(name, fn) { lines.set(name, fn); }
export function unregisterLine(name) { lines.delete(name); }
/** weak: the buffer is counted only while the page still references it. Safe to call per allocation (one WeakRef). */
// nt-frameleak (page-memory.js memTrackSweepAt): the sets only shed dead WeakRefs inside the periodic probe -> with --page-mem-ms 0 (timer never starts) they grew by one WeakRef per tracked buffer/texture forever.
// Sweep dead refs inline once a set passes the threshold; the next threshold doubles over the survivors (amortised O(1) per add).
const sweepAt = new Map();
function sweepSet(key, set) {
  const lim = leakGuards.memTrackSweepAt; if (!(lim > 0) || set.size < (sweepAt.get(key) ?? lim)) return;
  for (const r of set) if (!r.deref()) set.delete(r);
  sweepAt.set(key, Math.max(lim, set.size * 2));
}
export function trackBuffer(cat, a) {
  const b = bufOf(a); if (!b) return;
  let s = bufs.get(cat); if (!s) bufs.set(cat, (s = new Set()));
  s.add(new WeakRef(b)); sweepSet(cat, s);
}
export function trackTexture(t) { if (t && !texSeen.has(t)) { texSeen.add(t); texRefs.add(new WeakRef(t)); sweepSet('\0tex', texRefs); } }
// ---- scene walk (once per tick) -------------------------------------------------------------------------------------------------------------------
const drawableDims = (im) => { const w = im.width ?? im.videoWidth ?? im.displayWidth ?? 0, h = im.height ?? im.videoHeight ?? im.displayHeight ?? 0; return w > 0 && h > 0 ? w * h : 0; };
function newAcc() {
  return { seen: new Set(),            // ArrayBuffers already counted (all categories share it: a buffer is counted once)
    texObjs: new Set(), imgObjs: new Set(), geos: new Set(), mats: new Set(),
    texData: 0, texDataN: 0, texMip: 0, texDecoded: 0, texDecodedN: 0, texReleasedN: 0, texN: 0, texNoImage: 0,
    geoBytes: 0, geoViewBytes: 0, geoAttrN: 0, geoN: 0, instBytes: 0, skinBytes: 0, meshN: 0, nodeN: 0 };
}
function addBuf(acc, a, field) { // returns bytes newly attributed
  const b = bufOf(a); if (!b || acc.seen.has(b)) return 0;
  acc.seen.add(b); acc[field] += b.byteLength; return b.byteLength;
}
function addImage(acc, im, mip) {
  if (!im || typeof im !== 'object') return;
  if (Array.isArray(im)) { for (const x of im) addImage(acc, x, mip); return; }
  if (acc.imgObjs.has(im)) return; acc.imgObjs.add(im);
  if (im.gaiaReleased) { acc.texReleasedN++; return; } // nt-imgdecode: size-only stub left after the host acked the upload (material-map releaseTextureImage) — no decoded backing behind it
  if (im.data && ArrayBuffer.isView(im.data)) { if (addBuf(acc, im.data, mip ? 'texMip' : 'texData')) acc.texDataN++; return; } // DataTexture / ImageData / array textures: real CPU bytes
  if (isBuf(im)) { if (addBuf(acc, im, 'texData')) acc.texDataN++; return; }
  const px = drawableDims(im); // ImageBitmap / HTMLImageElement / canvas / VideoFrame: ESTIMATE (decoded backing)
  if (px) { acc.texDecoded += px * MEM_PARAMS.decodedBytesPerPixel; acc.texDecodedN++; }
}
function addTexture(acc, t) {
  if (!t || acc.texObjs.has(t)) return; acc.texObjs.add(t); acc.texN++;
  if (!t.image && !t.mipmaps?.length) acc.texNoImage++;
  addImage(acc, t.image, false);
  if (t.source?.data && t.source.data !== t.image) addImage(acc, t.source.data, false);
  if (Array.isArray(t.mipmaps)) for (const m of t.mipmaps) addImage(acc, m, true); // mip chain / compressed levels: {data,width,height}
}
function addAttr(acc, a) {
  if (!a) return; acc.geoAttrN++;
  const arr = a.isInterleavedBufferAttribute ? a.data?.array : a.array; if (!arr) return;
  acc.geoViewBytes += arr.byteLength ?? 0;
  addBuf(acc, arr, 'geoBytes');
}
function walkScene(acc, root) {
  const onMat = (m) => {
    if (!m || acc.mats.has(m)) return; acc.mats.add(m);
    for (const k in m) { const v = m[k]; if (v?.isTexture) addTexture(acc, v); } // map, normalMap, envMap, … (any own texture property)
    const u = m.uniforms; if (u) for (const k in u) { const v = u[k]?.value; if (v?.isTexture) addTexture(acc, v); } // ShaderMaterial
  };
  const onGeo = (g) => {
    if (!g || acc.geos.has(g)) return; acc.geos.add(g); acc.geoN++;
    for (const k in g.attributes) addAttr(acc, g.attributes[k]);
    addAttr(acc, g.index);
    for (const k in g.morphAttributes) for (const a of g.morphAttributes[k]) addAttr(acc, a);
  };
  root.traverse((o) => {
    acc.nodeN++;
    if (o.geometry) { acc.meshN++; onGeo(o.geometry); }
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) onMat(m);
    if (o.instanceMatrix) addBuf(acc, o.instanceMatrix.array, 'instBytes');
    if (o.instanceColor) addBuf(acc, o.instanceColor.array, 'instBytes');
    if (o.skeleton) { if (o.skeleton.boneMatrices) addBuf(acc, o.skeleton.boneMatrices, 'skinBytes'); if (o.skeleton.boneTexture) addTexture(acc, o.skeleton.boneTexture); }
  });
  for (const k of ['background', 'environment']) if (root[k]?.isTexture) addTexture(acc, root[k]);
}
// ---- built-in probes ------------------------------------------------------------------------------------------------------------------------------
function sceneProbe() {
  const acc = newAcc(), t0 = performance.now();
  const scene = MEM_PARAMS.sceneGetter();
  if (scene?.traverse) walkScene(acc, scene);
  let sentTex = 0;
  for (const r of texRefs) { const t = r.deref(); if (!t) { texRefs.delete(r); continue; } sentTex++; addTexture(acc, t); } // textures the adapter shipped (incl. ones no longer in the scene but still referenced)
  const tracked = {}; let trackedTotal = 0, trackedN = 0;
  for (const [cat, set] of bufs) {
    let n = 0, bytes = 0;
    for (const r of set) { const b = r.deref(); if (!b) { set.delete(r); continue; } if (acc.seen.has(b)) continue; acc.seen.add(b); n++; bytes += b.byteLength; }
    tracked[cat] = { n, bytes }; trackedTotal += bytes; trackedN += n;
  }
  const texBytes = acc.texData + acc.texMip + acc.texDecoded;
  const out = {
    tex_n: acc.texN, tex_sent_n: sentTex, tex_noimg: acc.texNoImage,
    texBytes, tex_dataBytes: acc.texData, tex_dataN: acc.texDataN, tex_mipBytes: acc.texMip, tex_decodedEstBytes: acc.texDecoded, tex_decodedN: acc.texDecodedN, tex_releasedN: acc.texReleasedN,
    geo_n: acc.geoN, geo_attrN: acc.geoAttrN, geoBytes: acc.geoBytes, geo_viewBytes: acc.geoViewBytes, instBytes: acc.instBytes, skinBytes: acc.skinBytes,
    nodes: acc.nodeN, meshes: acc.meshN,
  };
  for (const [cat, v] of Object.entries(tracked)) { out[`buf_${cat}_n`] = v.n; out[`buf_${cat}Bytes`] = v.bytes; }
  out.scan_ms = performance.now() - t0;
  out.__total = texBytes + acc.geoBytes + acc.instBytes + acc.skinBytes + trackedTotal;
  return out;
}
const jsProbe = () => {
  const pm = globalThis.performance?.memory;
  return pm ? { js_heapBytes: pm.usedJSHeapSize, js_heapTotalBytes: pm.totalJSHeapSize } : { js_heap: 'none' }; // WKWebView: no performance.memory, no measureUserAgentSpecificMemory
};
// ---- formatting -----------------------------------------------------------------------------------------------------------------------------------
function fmt(obj) {
  let s = '';
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__total' || v === undefined || v === null) continue;
    if (k.endsWith('Bytes')) s += ` ${k.slice(0, -5)}_MB=${(v / MB).toFixed(1)}`;
    else if (typeof v === 'number') s += ` ${k}=${Number.isInteger(v) ? v : v.toFixed(1)}`;
    else s += ` ${k}=${String(v).replace(/\s+/g, '_')}`;
  }
  return s;
}
/** One snapshot: { line, total } (total = tracked live bytes across all probes that report __total / Bytes sums). */
export function snapshot(upMs = performance.now()) {
  let line = `up=${(upMs / 1000).toFixed(1)}s`, total = 0;
  const run = (name, fn) => {
    try {
      const o = fn(); if (!o) return;
      total += o.__total ?? 0;
      line += ` |${name}${fmt(o)}`;
    } catch (e) { line += ` |${name} ERR=${String(e?.message ?? e).slice(0, 80)}`; }
  };
  for (const [name, fn] of probes) run(name, fn);
  run('scene', sceneProbe);
  run('js', jsProbe);
  line += ` |tracked_total_MB=${(total / MB).toFixed(1)} glb=untracked(three-loader-bytes;vrm-via-buf_vrmBytes)`;
  return { line: line.slice(0, MEM_PARAMS.maxLineChars), total };
}
let timer = null;
function invokeLog(text) {
  try { globalThis.__TAURI_INTERNALS__.invoke('gaia_page_log', { level: MEM_PARAMS.logLevel, text }).catch(() => {}); } catch { /* host gone */ }
}
/** Start the periodic line. ms defaults to the host's --page-mem-ms (window.__GAIA_NATIVE__.pageMemMs); 0/absent = off. Idempotent. */
export function startMemLog(ms = globalThis.__GAIA_NATIVE__?.pageMemMs) {
  if (timer || !(ms > 0)) return false;
  timer = setInterval(() => { const t = performance.now(); invokeLog(snapshot(t).line); for (const [n, fn] of lines) { try { invokeLog(`up=${(t / 1000).toFixed(1)}s |${n}${fmt(fn())}`.slice(0, MEM_PARAMS.maxLineChars)); } catch (e) { invokeLog(`up=${(t / 1000).toFixed(1)}s |${n} ERR=${String(e?.message ?? e).slice(0, 80)}`); } } }, ms);
  return true;
}
export function stopMemLog() { if (timer) { clearInterval(timer); timer = null; } }
/** GaiaRenderNative.create hook: ipc probe (transport queue + in-flight + ws bufferedAmount + writer scratch) and start the timer. */
export function attachNative({ transport, writer, send }) {
  register('ipc', () => {
    const st = transport.stats, inflightBytes = Math.max(0, st.bytes - st.ackedBytes);
    return {
      tx_queuedBytes: transport.queuedBytes, tx_maxQueuedBytes: st.maxQueued, tx_inflightBytes: inflightBytes, tx_inflight: transport.inflightCount, tx_inflightAgeMs: Math.round(transport.inflightAgeMs),
      tx_sentBytes: st.bytes, tx_msgs: st.messages, ws_bufferedBytes: send?.socket?.bufferedAmount ?? undefined,
      wr_scratchBytes: writer.buf.byteLength, wr_fillBytes: writer.len, wr_sentBytes: writer.sent,
      __total: transport.queuedBytes + inflightBytes + writer.buf.byteLength, // queued + in-flight messages are page-held copies; ws_buffered is a subset of in-flight (not added)
    };
  });
  return startMemLog();
}
