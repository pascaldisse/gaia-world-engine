// native-wire.js — command-stream writer for GaiaRenderNative. Format spec: client-rs/crates/gaia-render-host/src/wire.rs (little-endian).
//   command = u16 op | u16 0 | u32 payload_len | payload ; every field 4-aligned ; typed arrays = u32 byte_len + raw bytes + pad.
// Bulk (mesh/texture/matrix arrays) is memcpy'd as raw bytes — no JSON, no per-element work. JSON only for small option objects.
const enc = new TextEncoder();
const viewBytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const jsonReplacer = (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);

export class Writer {
  /** @param {{initialBytes?:number, flushBytes?:number, onFlush:(chunk:Uint8Array)=>void}} o */
  constructor({ initialBytes = 1 << 20, flushBytes = 4 << 20, onFlush }) {
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
    let cap = this.buf.byteLength;
    while (cap < this.len + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.u8.subarray(0, this.len));
    this.buf = nb; this.dv = new DataView(nb); this.u8 = new Uint8Array(nb);
  }
  begin(op) { this.ensure(8); this.start = this.len; this.dv.setUint16(this.len, op, true); this.dv.setUint16(this.len + 2, 0, true); this.len += 8; }
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
  u8s(a) { this.bytes(a instanceof ArrayBuffer ? new Uint8Array(a) : ArrayBuffer.isView(a) ? viewBytes(a) : Uint8Array.from(a ?? [])); }
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
  /** Hand the buffered bytes (whole commands only) to onFlush as an owned copy and reset. */
  flush() {
    if (this.len === 0) return;
    const chunk = this.u8.slice(0, this.len);
    this.len = 0;
    this.sent += chunk.byteLength;
    this.onFlush(chunk);
  }
}

export { jsonReplacer };
