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
import { createTransport, customProtocolSend, tauriInvokeSend, wsSend } from './native-transport.js';
import { attachNative as memAttach } from './mem-account.js'; // §page-mem-log

const OP_HELLO = 0, OP_FREE = 0xffff; // wire.rs
const MiB = 1 << 20;

export class GaiaRenderNative extends GaiaRenderNativeGen {
  /** wgpu-backend.js: skip the navigator.gpu requirement (the GPU is native). */
  static native = true;

  /**
   * @param canvas unused (the native host owns the surface); kept for signature parity with render-wasm.
   * @param options render-wasm create options (renderHeight, hdrScene, shadows, …) → HELLO json.
   * @param cfg { send?: async(Uint8Array)=>report, transport?:'ws'(default)|'invoke'|'protocol', inflight (ws only, default 2), command, scheme, chunkMB, flushMB, initialMB }
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
    const kind = cfg.transport ?? 'ws';
    if (!cfg.send && !['ws', 'invoke', 'protocol'].includes(kind)) throw new Error(`GaiaRenderNative: unknown ?nativeTransport=${kind} (ws|invoke|protocol)`);
    // ws = localhost WebSocket to the host's ipc_ws server (default; invoke measured ~16 MB/s in WKWebView). Rejects loudly when unavailable.
    const send = cfg.send ?? (kind === 'ws' ? await wsSend({ inflight: cfg.inflight }) : kind === 'protocol' ? customProtocolSend({ scheme: cfg.scheme }) : tauriInvokeSend({ command: cfg.command }));
    const transport = createTransport({ send, maxInflight: send.maxInflight, maxChunkBytes: (cfg.chunkMB ?? 16) * MiB, onReport, onError: (e) => console.error('[GaiaRenderNative] IPC send failed', e) });
    // transport watch (?nativeWatchMs, default 2000, 0 = off): logs queued bytes + in-flight age so a stalled pipe is visible in the host's page log
    if ((cfg.watchMs ?? 2000) > 0) {
      // ackMBps = host-acknowledged bytes / wall time over the watch interval (true throughput); lastMBps = one message's round trip (understates when pipelined)
      let last = 0, lastAcked = 0, lastT = performance.now();
      const every = cfg.watchMs ?? 2000;
      setInterval(() => {
        const s = transport.stats, qb = transport.queuedBytes, now = performance.now();
        if (qb || transport.inflightCount || s.messages !== last) console.info(`[GaiaRenderNative] ${kind} msgs=${s.messages} sentMB=${(s.bytes / MiB).toFixed(1)} ackMBps=${((s.ackedBytes - lastAcked) / MiB / Math.max((now - lastT) / 1e3, 1e-3)).toFixed(1)} lastMBps=${s.lastMBps.toFixed(1)} queuedMB=${(qb / MiB).toFixed(1)} maxQueuedMB=${(s.maxQueued / MiB).toFixed(1)} inflight=${transport.inflightCount}/${s.maxInflight} lastMs=${s.lastMs.toFixed(0)} maxMs=${s.maxMs.toFixed(0)} inflightAgeMs=${transport.inflightAgeMs.toFixed(0)}`);
        last = s.messages; lastAcked = s.ackedBytes; lastT = now;
      }, every);
    }
    const w = new Writer({ initialBytes: (cfg.initialMB ?? 1) * MiB, flushBytes: (cfg.flushMB ?? 4) * MiB, onFlush: (c) => transport.push(c) });
    const rt = {
      w, busyMB: cfg.busyMB, busyMs: cfg.busyMs,
      alloc: (kind) => { const n = (counters.get(kind) ?? 0) + 1; counters.set(kind, n); return n; },
      q: (name) => {
        const spec = QUERIES[name];
        if (spec.drain) { const g = pendingGrid; pendingGrid = null; return Float32Array.from(g ?? []); }
        const v = name in q ? q[name] : spec.dflt;
        return spec.type === 'f32' ? Float32Array.from(v) : spec.type === 'u32' ? Uint32Array.from(v) : v;
      },
    };
    const gpu = new GaiaRenderNative(rt, transport, self);
memAttach({ transport, writer: w, send }); // [page:mem] probes + timer (--page-mem-ms)
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
    this._t = transport; this._s = shared; this._busyBytes = (rt.busyMB ?? 8) * 1048576; this._busyMs = rt.busyMs ?? 250;
  }
  /** errors reported by the host since creation (max 256). */
  get errors() { return this._s.errors; }
  set onError(fn) { this._s.onError = fn; }
  /** { messages, bytes, maxQueued, lastMs, maxMs, queuedBytes, frames } — IPC diagnostics (wgpuStats). */
  /** backpressure: true while the pipe still holds more than `busyMB` (?nativeBusyMB, default 8) queued or a frame commit is un-acked.
   *  The presenter skips adapter.sync+render while busy (sync is a diff -> the next frame carries the latest state; nothing is dropped). */
  busy() { const t = this._t; return t.queuedBytes > this._busyBytes || t.inflightAgeMs > this._busyMs; }
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
    transport: params.get('nativeTransport') ?? undefined, // ws (default) | invoke | protocol
    inflight: num('nativeInflight'), // ws only: messages in flight (default 2)
    command: params.get('nativeCommand') ?? undefined,
    scheme: params.get('nativeScheme') ?? undefined,
    chunkMB: num('nativeChunkMB'), watchMs: num('nativeWatchMs'), busyMB: num('nativeBusyMB'), busyMs: num('nativeBusyMs'), flushMB: num('nativeFlushMB'), initialMB: num('nativeInitialMB'),
  };
  return { default: async () => {}, GaiaRender: { native: true, create: (canvas, options) => GaiaRenderNative.create(canvas, options, cfg) } };
}
