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
  // ---- nt-tslbudget (docs/NATIVE.md §tsl-budget)
  exportBudgetMs: 8,      // ?nativeExportBudgetMs  scene-adapter: TSL exports (build/rebind + createShaderMaterial) per sync stop being started once this many ms are spent (>=1 always runs); the rest is deferred to later syncs (stats.exportDeferred, census ad_expPend*). 0 = unlimited (old: a cell load exported 170 materials in one 10 s sync)
  tslLean: true,          // ?nativeTslLean=0      tsl-export: templates keep ONLY what rebind reads (lean package, WeakRef node stubs: no live closure -> mesh/scene/camera/material/renderer, no textureSources), module-level getter closures (rebound packages no longer pin their template), lazy per-package NodeFrame, shared frame object/camera/scene/material cleared after update
  tslBound: true,         // ?nativeTslBound=0     tsl-export: shared-frame `done` Set -> WeakSet (re-created per frame); wgslOf / keySamples / SHARED_OK FIFO-capped at tslMapMax
  tslMapMax: 256,         // ?nativeTslMapMax      cap for the tslBound maps (0 = unlimited)
  // ---- nt-imgdecode (docs/NATIVE.md §image-decode): WebKit-malloc decode artifacts (ImageBitmap / HTMLImageElement frame cache / canvas backing / blob+Cache refs)
  releaseDecoded: true,   // ?nativeReleaseDecoded=0  after the host acked an ImageBitmap/HTMLImageElement/cube-face texture: ImageBitmap.close(), Image detached, texture.image -> {width,height} stub (size kept), cube RGBA dropped. Clones sharing the Source reuse the host texture. =0 keeps the decoded image forever (old behaviour)
  detachImages: true,     // ?nativeDetachImg=0       with releaseDecoded: HTMLImageElement.removeAttribute('src') so WebKit drops its CachedImage client (decoded frame cache) now, not at GC
  threeCache: false,      // ?nativeThreeCache=1      keep THREE.Cache as the game left it. Default: native mode forces Cache.enabled=false + Cache.clear() (FileLoader would pin every GLB/ArrayBuffer, ImageLoader every Image, ImageBitmapLoader every ImageBitmap/promise)
  scratchIdleMs: 500,     // ?nativeScratchIdleMs     material-map shared decode canvas is shrunk to 1x1 this long after the last texture read, whatever its size (0 = off; scratchKeepPx still shrinks big ones at once)
  shrinkEnvCanvas: true,  // ?nativeEnvShrink=0      env-image (scene.background / environment / cube faces) decode canvases are shrunk to 1x1 right after getImageData (they were left to GC)
});
export const PAGE_MEM_PARAMS = Object.freeze({ inflight: 'nativeInflight', chunkMB: 'nativeChunkMB', flushMB: 'nativeFlushMB', initialMB: 'nativeInitialMB', busyMB: 'nativeBusyMB', busyMs: 'nativeBusyMs', watchMs: 'nativeWatchMs', writerShrinkMB: 'nativeWriterShrinkMB', coalesceKB: 'nativeCoalesceKB', encodeCapMB: 'nativeEncodeCapMB', retainPixels: 'nativeRetainPixels', scratchKeepPx: 'nativeScratchKeepPx', releaseSources: 'nativeReleaseSrc', weakRegistries: 'nativeWeakRegs', memTrackSweepAt: 'nativeMemTrackSweep', idleCoalesce: 'nativeIdleCoalesce', errorLogMax: 'nativeErrorLogMax', statsMapMax: 'nativeStatsMapMax', tslTemplateMax: 'nativeTslTemplateMax', releaseDecoded: 'nativeReleaseDecoded', detachImages: 'nativeDetachImg', threeCache: 'nativeThreeCache', exportBudgetMs: 'nativeExportBudgetMs', tslLean: 'nativeTslLean', tslBound: 'nativeTslBound', tslMapMax: 'nativeTslMapMax', scratchIdleMs: 'nativeScratchIdleMs', shrinkEnvCanvas: 'nativeEnvShrink' });
const BOOL = new Set(['tslLean', 'tslBound', 'retainPixels', 'releaseSources', 'weakRegistries', 'idleCoalesce', 'releaseDecoded', 'detachImages', 'threeCache', 'shrinkEnvCanvas']);
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
