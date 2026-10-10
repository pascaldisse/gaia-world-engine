// page-memory.js — ONE place for every native-mode page-memory tunable (lane nt-pagemem, docs/NATIVE.md §page-memory). Defaults here; URL params override (names below).
// Native mode only: the browser/wasm path never reads this (material-map/adapter keep their old behaviour unless configured).
const MiB = 1 << 20, KiB = 1 << 10;
export const PAGE_MEM_DEFAULTS = Object.freeze({
  // ---- transport / writer (were hardcoded in gaia-render-native.js)
  inflight: 2,            // ?nativeInflight   ws messages in flight
  chunkMB: 16,            // ?nativeChunkMB    max IPC message
  flushMB: 4,             // ?nativeFlushMB    writer streams a finished command out once it holds this much
  initialMB: 1,           // ?nativeInitialMB  writer buffer initial capacity
  busyMB: 8,              // ?nativeBusyMB     presenter skips sync+render while the pipe holds more than this queued
  busyMs: 250,            // ?nativeBusyMs     ... or a frame commit is un-acked this long
  watchMs: 2000,          // ?nativeWatchMs    transport log interval (0 = off)
  // ---- new (nt-pagemem)
  writerShrinkMB: 8,      // ?nativeWriterShrinkMB  writer buffer capacity above this is dropped back to initialMB after every flush (a 64 MB texture no longer pins 128 MB forever)
  coalesceKB: 1024,       // ?nativeCoalesceKB      queued pieces >= this are NEVER copied into a coalesced message (sent as-is / split by subarray); only small pieces are batched
  encodeCapMB: 32,        // ?nativeEncodeCapMB     scene-adapter encodes no NEW big create while (queued + in-flight + unflushed writer) bytes exceed this (0 = off). Default = inflight x chunkMB: keeps the pipe full, never further ahead
  retainPixels: false,    // ?nativeRetainPixels=1  material-map keeps CPU RGBA / mip-chain copies after the host has them (browser behaviour). Native default: do not
  scratchKeepPx: 1 << 20, // ?nativeScratchKeepPx   material-map decode canvas bigger than this many pixels is shrunk to 1x1 after each read (frees the CPU backing store)
  releaseSources: false,  // ?nativeReleaseSrc=1    after the host acked the upload, DROP game-owned CPU sources (geometry arrays, compressed mip data, ImageBitmap) of EVERY texture/geometry; default off: per-object opt-in via userData.nativeRelease (see NATIVE.md)
});
export const PAGE_MEM_PARAMS = Object.freeze({ inflight: 'nativeInflight', chunkMB: 'nativeChunkMB', flushMB: 'nativeFlushMB', initialMB: 'nativeInitialMB', busyMB: 'nativeBusyMB', busyMs: 'nativeBusyMs', watchMs: 'nativeWatchMs', writerShrinkMB: 'nativeWriterShrinkMB', coalesceKB: 'nativeCoalesceKB', encodeCapMB: 'nativeEncodeCapMB', retainPixels: 'nativeRetainPixels', scratchKeepPx: 'nativeScratchKeepPx', releaseSources: 'nativeReleaseSrc' });
const BOOL = new Set(['retainPixels', 'releaseSources']);
/** params = URLSearchParams | null, overrides = plain object (wins over params). Returns { ...defaults, ...params, ...overrides } with bytes helpers. */
export function pageMemConfig(params = null, overrides = {}) {
  const c = { ...PAGE_MEM_DEFAULTS };
  for (const [k, p] of Object.entries(PAGE_MEM_PARAMS)) {
    if (params?.has?.(p)) { const raw = params.get(p); const n = Number(raw); if (BOOL.has(k)) c[k] = raw === '1' || raw === 'true'; else if (Number.isFinite(n) && n >= 0) c[k] = n; }
  }
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) c[k] = v;
  c.chunkBytes = c.chunkMB * MiB; c.flushBytes = c.flushMB * MiB; c.initialBytes = c.initialMB * MiB; c.busyBytes = c.busyMB * MiB;
  c.writerShrinkBytes = c.writerShrinkMB * MiB; c.coalesceBytes = c.coalesceKB * KiB; c.encodeCapBytes = c.encodeCapMB * MiB;
  return c;
}
