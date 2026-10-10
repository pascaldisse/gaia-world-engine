// native-wire.js — command-stream writer for GaiaRenderNative. Format spec: client-rs/crates/gaia-render-host/src/wire.rs (little-endian).
//   command = u16 op | u16 0 | u32 payload_len | payload ; every field 4-aligned ; typed arrays = u32 byte_len + raw bytes + pad.
// Bulk (mesh/texture/matrix arrays) is memcpy'd as raw bytes — no JSON, no per-element work. JSON only for small option objects.
const enc = new TextEncoder();
const viewBytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const jsonReplacer = (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);

export class Writer {
  /** @param {{initialBytes?:number, flushBytes?:number, shrinkBytes?:number, onFlush:(chunk:Uint8Array)=>void}} o  (defaults live in page-memory.js PAGE_MEM_DEFAULTS; shrinkBytes 0 = never shrink) */
  constructor({ initialBytes = 1 << 20, flushBytes = 4 << 20, shrinkBytes = 8 << 20, onFlush }) {
    this.initialBytes = initialBytes;
    this.shrinkBytes = shrinkBytes; // buffer capacity above this is released after a flush (nt-pagemem)
    this.buf = new ArrayBuffer(initialBytes);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.len = 0;
    this.start = 0;
    this.flushBytes = flushBytes; // streaming threshold: a finished command pushes the buffer out once it holds this much
    this.onFlush = onFlush;
    this.sent = 0;                // total bytes handed to onFlush (diagnostics)
  }
  ensure(n) {
    if (this.len + n <= this.buf.byteLength) return;
    // nt-pagemem: before growing, push the already-FINISHED commands [0,start) out so the grow-copy only moves the command in progress (the buffer is never sized for the backlog)
    if (this.start > 0 && this.start <= this.len) this.flushFinished();
    if (this.len + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    if (this.len + n > cap * 2) cap = this.len + n; // one big payload: exact fit, no power-of-2 overshoot (a 40 MB texture used to allocate 64-128 MB and keep it)
    else while (cap < this.len + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.u8.subarray(0, this.len));
    this.buf = nb; this.dv = new DataView(nb); this.u8 = new Uint8Array(nb);
  }
  begin(op) { this.ensure(8); this.start = this.len; this.dv.setUint16(this.len, op, true); this.dv.setUint16(this.len + 2, 0, true); this.len += 8; }
  /** hand [0,start) (finished commands) to onFlush, keep the unfinished command [start,len) at the buffer front. */
  flushFinished() {
    const n = this.start;
    if (n <= 0) return;
    const chunk = this.u8.slice(0, n);
    this.u8.copyWithin(0, n, this.len);
    this.len -= n; this.start = 0; this.sent += n;
    this.onFlush(chunk);
  }
  end() {
    this.dv.setUint32(this.start + 4, this.len - this.start - 8, true);
    if (this.len >= this.flushBytes) this.flush();
  }
  u32(v) { this.ensure(4); this.dv.setUint32(this.len, v >>> 0, true); this.len += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.len, v | 0, true); this.len += 4; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.len, v, true); this.len += 4; }
  bool(v) { this.u32(v ? 1 : 0); }
  /** u32 byte_len | bytes | pad4 */
  bytes(u8) {
    const n = u8.byteLength, pad = (4 - (n & 3)) & 3;
    this.ensure(4 + n + pad);
    this.dv.setUint32(this.len, n, true); this.len += 4;
    this.u8.set(u8, this.len); this.len += n;
    if (pad) { this.u8.fill(0, this.len, this.len + pad); this.len += pad; }
  }
  typed(a, Ctor) {
    if (a instanceof Ctor) return this.bytes(viewBytes(a));
    if (a == null) return this.bytes(new Uint8Array(0));
    return this.bytes(viewBytes(Ctor.from(a))); // plain array / other view: coerce (wasm-bindgen would have thrown; be lenient)
  }
  f32s(a) { this.typed(a, Float32Array); }
  u32s(a) { this.typed(a, Uint32Array); }
  u8s(a) {
    if (a && Array.isArray(a.chunks)) { this.chunked(a.chunks); return; } // { chunks: Uint8Array[] }: logical concatenation written straight into the stream (no concat copy)
    this.bytes(a instanceof ArrayBuffer ? new Uint8Array(a) : ArrayBuffer.isView(a) ? viewBytes(a) : Uint8Array.from(a ?? []));
  }
  /** u32 total_len | part0 | part1 | ... | pad4 — byte-identical to bytes(concat(parts)). */
  chunked(parts) {
    let n = 0; for (const p of parts) n += p.byteLength;
    const pad = (4 - (n & 3)) & 3;
    this.ensure(4 + n + pad);
    this.dv.setUint32(this.len, n, true); this.len += 4;
    for (const p of parts) { this.u8.set(p, this.len); this.len += p.byteLength; }
    if (pad) { this.u8.fill(0, this.len, this.len + pad); this.len += pad; }
  }
  str(s) { this.bytes(enc.encode(s ?? '')); }
  json(o) { this.str(o == null ? '' : JSON.stringify(o, jsonReplacer)); }
  strlist(a) { const l = Array.from(a ?? []); this.u32(l.length); for (const s of l) this.str(String(s)); }
  /** [{kind:'uniform'|'texture'|'sampler', binding, data?, vertex?, texture?}] — same shape render-wasm createShaderMaterial takes. */
  bindings(a) {
    const l = Array.from(a ?? []);
    this.u32(l.length);
    for (const b of l) {
      const kind = b.kind === 'uniform' ? 0 : b.kind === 'texture' ? 1 : b.kind === 'sampler' ? 2 : -1;
      if (kind < 0) throw new Error(`createShaderMaterial: unknown binding kind '${b.kind}'`);
      if (typeof b.binding !== 'number') throw new Error('createShaderMaterial: binding: number required');
      this.u32(kind); this.u32(b.binding); this.u32(b.vertex ? 1 : 0); this.u32(b.texture ?? 0);
      this.u8s(kind === 0 ? b.data : new Uint8Array(0));
    }
  }
  /** Hand the buffered bytes (whole commands only) to onFlush and reset. nt-pagemem: a mostly-full buffer is HANDED OFF (zero copy; a fresh initial-size buffer replaces it),
   *  a mostly-empty one is sliced (small copy); an oversize buffer is never kept (shrinkBytes). */
  flush() {
    if (this.len === 0) return;
    const len = this.len, cap = this.buf.byteLength;
    let chunk;
    if (len * 2 >= cap) { chunk = new Uint8Array(this.buf, 0, len); this._fresh(); }
    else { chunk = this.u8.slice(0, len); if (this.shrinkBytes > 0 && cap > this.shrinkBytes) this._fresh(); }
    this.len = 0; this.start = 0; this.sent += len;
    this.onFlush(chunk);
  }
  _fresh() { this.buf = new ArrayBuffer(this.initialBytes); this.dv = new DataView(this.buf); this.u8 = new Uint8Array(this.buf); }
}

export { jsonReplacer };
