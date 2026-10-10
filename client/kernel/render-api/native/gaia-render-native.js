// gaia-render-native.js — GaiaRenderNative: drop-in for render-wasm's `GaiaRender` that drives the NATIVE Rust/wgpu Metal renderer
// (gaia-render-host) over Tauri IPC instead of running wasm in the webview. wgpu-backend.js is unchanged except it skips the
// navigator.gpu check for `GaiaRender.native`.
//
// Method surface = GENERATED (gaia-render-native.gen.js ← render-wasm lib.rs, tools/gen-render-native.mjs). This file only owns what cannot
// be generated: create/free, render* (frame commit + flush), the transport, the report/query cache.
//
// Semantics vs render-wasm (the honest differences):
//   • create* return JS-allocated handles immediately (no round trip); the host uses those ids.
//   • Errors cannot throw at the call site (the call already returned): they come back in the next IPC report -> `gpu.errors`, `gpu.onError`, console.
//     Consequence: createThreeMaterial's "throw → adapter falls back to PBR" path does not fire natively (the material is just absent).
//   • Queries (drawCalls, passStats, shadowStats, sizes, autoExposureGrid, …) return the value from the LAST frame-commit report (≥1 frame stale).
//   • render() = flush the frame batch; returns true optimistically. renderTimed resolves with IPC round-trip ms (host apply time, not GPU time);
//     renderGpuTimed / skinGpuMs resolve null (the host owns submit/present; no timestamp path over IPC yet).
import { API_HASH, GaiaRenderNativeGen, OP_FRAME_COMMIT, QUERIES } from './gaia-render-native.gen.js';
import { Writer } from './native-wire.js';
import { createTransport, customProtocolSend, tauriInvokeSend } from './native-transport.js';

const OP_HELLO = 0, OP_FREE = 0xffff; // wire.rs
const MiB = 1 << 20;

export class GaiaRenderNative extends GaiaRenderNativeGen {
  /** wgpu-backend.js: skip the navigator.gpu requirement (the GPU is native). */
  static native = true;

  /**
   * @param canvas unused (the native host owns the surface); kept for signature parity with render-wasm.
   * @param options render-wasm create options (renderHeight, hdrScene, shadows, …) → HELLO json.
   * @param cfg { send?: async(Uint8Array)=>report, transport?:'invoke'|'protocol', command, scheme, chunkMB, flushMB, initialMB }
   */
  static async create(canvas, options = {}, cfg = {}) {
    const counters = new Map();
    const q = Object.create(null);
    let pendingGrid = null;
    const self = { errors: [], onError: null, frames: 0 };
    const onReport = (rep) => {
      if (rep.errors?.length) for (const e of rep.errors) {
        if (self.errors.length < 256) self.errors.push(e);
        if (self.onError) self.onError(e); else console.error(`[GaiaRenderNative] ${e.op}${e.id ? `#${e.id}` : ''}: ${e.msg}`);
      }
      if (rep.q) {
        Object.assign(q, rep.q);
        if (rep.q.autoExposureGrid?.length) pendingGrid = rep.q.autoExposureGrid;
        self.frames = rep.frame ?? self.frames;
      }
    };
    const send = cfg.send ?? (cfg.transport === 'protocol' ? customProtocolSend({ scheme: cfg.scheme }) : tauriInvokeSend({ command: cfg.command }));
    const transport = createTransport({ send, maxChunkBytes: (cfg.chunkMB ?? 16) * MiB, onReport, onError: (e) => console.error('[GaiaRenderNative] IPC send failed', e) });
    const w = new Writer({ initialBytes: (cfg.initialMB ?? 1) * MiB, flushBytes: (cfg.flushMB ?? 4) * MiB, onFlush: (c) => transport.push(c) });
    const rt = {
      w,
      alloc: (kind) => { const n = (counters.get(kind) ?? 0) + 1; counters.set(kind, n); return n; },
      q: (name) => {
        const spec = QUERIES[name];
        if (spec.drain) { const g = pendingGrid; pendingGrid = null; return Float32Array.from(g ?? []); }
        const v = name in q ? q[name] : spec.dflt;
        return spec.type === 'f32' ? Float32Array.from(v) : spec.type === 'u32' ? Uint32Array.from(v) : v;
      },
    };
    const gpu = new GaiaRenderNative(rt, transport, self);
    // HELLO: api hash + options; await the host's answer so a stale JS/host pair fails here, loudly.
    w.begin(OP_HELLO); w.u32(API_HASH); w.json(options); w.end(); w.flush();
    await transport.idle();
    const bad = self.errors.find((e) => e.op === 'hello');
    if (bad) throw new Error(`GaiaRenderNative hello refused: ${bad.msg}`);
    if (!('hdrScene' in q)) throw new Error('GaiaRenderNative: host answered hello without queries (no renderer created)');
    return gpu;
  }

  constructor(rt, transport, shared) {
    super(rt);
    this._t = transport; this._s = shared;
  }
  /** errors reported by the host since creation (max 256). */
  get errors() { return this._s.errors; }
  set onError(fn) { this._s.onError = fn; }
  /** { messages, bytes, maxQueued, lastMs, maxMs, queuedBytes, frames } — IPC diagnostics (wgpuStats). */
  ipcStats() { return { ...this._t.stats, queuedBytes: this._t.queuedBytes, frames: this._s.frames, written: this._rt.w.sent }; }

  _commit() { const w = this._rt.w; w.begin(OP_FRAME_COMMIT); w.end(); w.flush(); }
  render() { this._commit(); return true; }
  renderTimed() { const t0 = performance.now(); this._commit(); return this._t.idle().then(() => performance.now() - t0); }
  renderGpuTimed() { this._commit(); return Promise.resolve(null); }
  skinGpuMs() { return Promise.resolve(null); }
  free() { const w = this._rt.w; w.begin(OP_FREE); w.end(); w.flush(); }
}

/** The `wasm`-module-shaped object createWgpuBackend({ wasm }) expects. `params` = URLSearchParams (all optional, defaults in create()). */
export function nativeModule(params = new URLSearchParams()) {
  const num = (k) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : undefined);
  const cfg = {
    transport: params.get('nativeTransport') ?? 'invoke',
    command: params.get('nativeCommand') ?? undefined,
    scheme: params.get('nativeScheme') ?? undefined,
    chunkMB: num('nativeChunkMB'), flushMB: num('nativeFlushMB'), initialMB: num('nativeInitialMB'),
  };
  return { default: async () => {}, GaiaRender: { native: true, create: (canvas, options) => GaiaRenderNative.create(canvas, options, cfg) } };
}
