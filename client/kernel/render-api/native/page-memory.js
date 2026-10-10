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
// ---- nt-frameleak: retention guards (default = FIXED behaviour; native only, see leakGuards below)
weakRegistries: true,   // ?nativeWeakRegs=0  light-registry + gi-attach hold lights/materials WEAKLY (WeakRef + WeakSet) instead of strong grow-only Set/Map: a removed light/material (+ its parent chain, geometry, textures) can be collected
memTrackSweepAt: 2048,  // ?nativeMemTrackSweep  mem-account sweeps dead WeakRefs out of trackBuffer/trackTexture sets once a set exceeds this many entries (0 = only the periodic probe prunes: with --page-mem-ms 0 the sets grew forever)
idleCoalesce: true,     // ?nativeIdleCoalesce=0  transport.idle() shares ONE promise/waiter while the pipe is busy (a per-frame renderTimed() under load pushed one waiter per call, released only when the pipe fully drained)
errorLogMax: 64,        // ?nativeErrorLogMax     host-report / IPC errors console.error'd at most this many times (then counted only: every console.error is also a gaia_page_log invoke + string per call; 0 = unlimited)
statsMapMax: 256,       // ?nativeStatsMapMax     scene-adapter stats.exportWhy.keys (one entry per distinct exported WGSL hash) is capped at this many entries (0 = unlimited)
tslTemplateMax: 64,     // ?nativeTslTemplateMax  tsl-export structCache.maxTemplates (browser 128): each template pins a node graph + package -> live material, mesh, geometry, textures. &wgpuTslCacheMax still wins
});
export const PAGE_MEM_PARAMS = Object.freeze({ inflight: 'nativeInflight', chunkMB: 'nativeChunkMB', flushMB: 'nativeFlushMB', initialMB: 'nativeInitialMB', busyMB: 'nativeBusyMB', busyMs: 'nativeBusyMs', watchMs: 'nativeWatchMs', writerShrinkMB: 'nativeWriterShrinkMB', coalesceKB: 'nativeCoalesceKB', encodeCapMB: 'nativeEncodeCapMB', retainPixels: 'nativeRetainPixels', scratchKeepPx: 'nativeScratchKeepPx', releaseSources: 'nativeReleaseSrc', weakRegistries: 'nativeWeakRegs', memTrackSweepAt: 'nativeMemTrackSweep', idleCoalesce: 'nativeIdleCoalesce', errorLogMax: 'nativeErrorLogMax', statsMapMax: 'nativeStatsMapMax', tslTemplateMax: 'nativeTslTemplateMax' });
const BOOL = new Set(['retainPixels', 'releaseSources', 'weakRegistries', 'idleCoalesce']);
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
// nt-frameleak: runtime switches read by modules that have no config plumbing (light-registry, gi-attach, mem-account, transport, scene-adapter). ALL OFF until configureLeakGuards() ran
// (wgpu-present.js calls it for renderBackend=native only) -> the browser path keeps its old behaviour.
export const leakGuards = { on: false, weakRegistries: false, memTrackSweepAt: 0, idleCoalesce: false, errorLogMax: 0, statsMapMax: 0 };
export function configureLeakGuards(pm) { for (const k of ['weakRegistries', 'memTrackSweepAt', 'idleCoalesce', 'errorLogMax', 'statsMapMax']) if (pm[k] !== undefined) leakGuards[k] = pm[k]; leakGuards.on = true; return leakGuards; }
