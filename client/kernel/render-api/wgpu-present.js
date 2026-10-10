// render-api/wgpu-present.js — run the WHOLE live scene through the wasm wgpu renderer (engine seam, ?renderBackend=wgpu).
// three still builds/animates the scene graph (game code unchanged); this replaces only the draw: scene-adapter.sync → wgpu backend → overlay canvas.
// ?renderBackend=native: same pipeline, but the draw goes to the NATIVE Rust/wgpu Metal renderer over Tauri IPC (native/gaia-render-native.js; wasm + overlay canvas unused).
//   native params: &nativeTransport=ws|invoke|protocol (default ws = localhost WebSocket, host --ipc-ws) &nativeInflight=2 (ws: messages in flight) &nativeCommand=gaia_render_apply &nativeScheme=gaiarender &nativeChunkMB=16 (max IPC message) &nativeFlushMB=4 (stream bulk uploads mid-frame) &nativeInitialMB=1
// Params: ?renderBackend=wgpu &wgpuPkg=<url of render_wasm.js (default /pkg/render_wasm.js)> &wgpuHeight=<internal render height> &wgpuShadows=0|1 &wgpuTsl=0|1 (r14: DEFAULT ON — NodeMaterials with custom nodes are translated to WGSL; =0 = PBR fallback for those) &wgpuStats=1 &wgpuGi=0|1 (probe GI atlases, default on when gi open mode is live) &wgpuGiEvery=30
import { installGpuMirror } from './gpu-mirror.js';
import { createWgpuBackend } from './wgpu-backend.js';
import { createSceneAdapter } from './scene-adapter.js';
import { exportNodeMaterial, structCache, exportProbe } from './tsl-export.js';
import { createGiBridge } from './gi-bridge.js';
import { createGiNative } from './gi-native.js';
import { threeGpuOff } from './native-mode.js';
import { createPostBridge } from './post-bridge.js';
import { configureMaterialMap } from './material-map.js';
import { pageMemConfig, configureLeakGuards } from './native/page-memory.js';
import { registerLine as memLine } from './native/mem-account.js';
import { lightRegistryCensus } from './light-registry.js';
import { tslCensus } from './tsl-export.js';

export async function createWgpuPresenter({ renderer, scene, camera, THREE, getGi = null, getPost = () => null, getAutoExposure = () => null, params = new URLSearchParams(location.search) }) {
  const native = params.get('renderBackend') === 'native';
  // nt-pagemem: native page-memory policy (defaults + &native* params: native/page-memory.js, docs/NATIVE.md §page-memory). null in the browser = old behaviour everywhere.
  const pm = native ? pageMemConfig(params) : null;
  if (pm) { configureMaterialMap(pm); configureLeakGuards(pm); } // nt-frameleak: retention guards (native/page-memory.js leakGuards)
  // nt-imgdecode (docs/NATIVE.md §image-decode): three never uploads in native mode, so THREE.Cache (FileLoader ArrayBuffers, ImageLoader Images, ImageBitmapLoader bitmaps) would pin every asset for the page's life. Off + cleared (&nativeThreeCache=1 keeps the game's setting).
  const st0 = { cacheDisabled: 0, cacheCleared: 0 };
  const dropThreeCache = () => { const C = THREE?.Cache; if (!pm || pm.threeCache || !C) return; if (C.enabled) { C.enabled = false; st0.cacheDisabled++; } if (C.files && Object.keys(C.files).length) { C.clear(); st0.cacheCleared++; } };
  dropThreeCache();
  const pkg = params.get('wgpuPkg') ?? '/pkg/render_wasm.js';
  const wasm = native ? (await import('./native/gaia-render-native.js')).nativeModule(params) : await import(/* @vite-ignore */ pkg);
  // three has NO device in native mode (renderBackend=native, or wgpu + threeGpu=0): nothing can be written into it, so there is nothing to mirror.
  // Pages must then live in DataArrayTexture.image.data (docs/NATIVE.md §three-gpu).
  const noThreeGpu = threeGpuOff(params);
  if (!noThreeGpu) installGpuMirror(renderer); // array pages the game writes straight into three's device stay readable for the wgpu core
  const host = renderer.domElement;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:1';
  host.style.visibility = 'hidden'; // three draws nothing in this mode
  if (!native) host.parentNode.insertBefore(canvas, host.nextSibling); // native: the Metal layer is the display; the webview stays transparent UI on top
  const size = () => { canvas.width = Math.max(1, Math.round(innerWidth)); canvas.height = Math.max(1, Math.round(innerHeight)); };
  size();
  const renderHeight = Number(params.get('wgpuHeight') ?? Math.min(innerHeight, 720));
  const backend = await createWgpuBackend({ canvas, wasm, renderHeight, staticInstances: 'non-skinned', options: { shadows: { enabled: params.get('wgpuShadows') !== '0' }, hdrScene: params.get('wgpuPost') === '0' ? 0 : 1 } });
  if (pm) { structCache.lean = !!pm.tslLean; structCache.bound = pm.tslBound ? (pm.tslMapMax > 0 ? pm.tslMapMax : Infinity) : 0; } // nt-tslbudget: template/closure/map retention fixes (native only; browser path = old behaviour)
  if (pm?.tslTemplateMax > 0) structCache.maxTemplates = pm.tslTemplateMax; // nt-frameleak: native default 64 (browser 128): each template pins node graph + package -> material/mesh/textures; &wgpuTslCacheMax below still wins
  { const mt = Number(params.get('wgpuTslCacheMax')); if (Number.isFinite(mt) && mt > 0) structCache.maxTemplates = mt; } // r10-7 template retention bound
  if (params.get('wgpuTslKeyDump') === '1') structCache.keySamples = new Map();
  if (params.get('wgpuTslWalkCheck') === '1') structCache.walkCheck = true;
  if (pm) { structCache.hashKey = !!pm.tslKeyHash && !structCache.walkCheck; structCache.bindIdx = !!pm.tslBindIdx; } if (pm) structCache.recipe = !!pm.tslRecipe; // nt-tslrecipe (native only) // nt-exportcost (native only; browser path = old behaviour): compact template key + indexed templateBinds. exportLightMemo rides leakGuards, exportDedupe the adapter option below
  if (params.get('wgpuTslKeyProf') === '1') structCache.keyProf = { prim: 0, kids: 0, props: 0, join: 0, nodes: 0, parts: 0, walks: 0 }; // r10-9 key-walk cost breakdown (opt-in)
  structCache.share = params.get('wgpuShare') !== '0'; // r10-4 A/B flag (also togglable live: __wgpu.tslCache.share)
  const adapter = createSceneAdapter(backend, { three: THREE, exportNodeMaterial: params.get('wgpuTsl') === '0' ? null : exportNodeMaterial, tslOptions: { THREE, coreShadow: params.get('wgpuCoreShadow') !== '0', cache: params.get('wgpuTslCache') === '0' ? 'off' : params.get('wgpuTslCache') === 'verify' ? 'verify' : 'on' }, nativeInstancing: params.get('wgpuInst') !== '0', recvVariants: params.get('wgpuRecvVar') === '1', dbgNoAlphaCast: params.get('wgpuDbgNoAlphaCast') === '1', dbgNoCast: params.get('wgpuDbgNoCast') === '1', exportProbe, ...(pm ? { encodeCapBytes: pm.encodeCapBytes, releaseSources: pm.releaseSources, exportBudgetMs: pm.exportBudgetMs, exportDedupe: !!pm.exportDedupe, exportNearFirst: !!pm.exportNearFirst } : null) });
  // r6: engine probe GI (?wgpuGi=0 off · &wgpuGiEvery=<frames between atlas readbacks, default 30>). three still runs the GI compute; the atlases are read back async.
  // lane nt-gi: NATIVE GI (default when three has no GPU; &wgpuGiNative=1 to A/B it in a browser, =0 forces the readback bridge): gaia-render computes the atlases itself, the page ships
  // voxel bricks + frame params only (gi-native.js) -> NO three compute, NO readback, NO atlas mirror.
  const giNativeFlag = params.get('wgpuGiNative');
  if (noThreeGpu && giNativeFlag === '0') throw new Error('wgpuGiNative=0 (three compute + readback) is impossible with three\'s GPU off');
  const giNative = getGi && params.get('wgpuGi') !== '0' && (noThreeGpu || giNativeFlag === '1') ? createGiNative({ backend }) : null;
  if (giNative) getGi()?.attachNative?.(giNative);
  const giBridge = getGi && params.get('wgpuGi') !== '0' && !giNative ? createGiBridge({ backend, renderer, getController: getGi, everyFrames: Number(params.get('wgpuGiEvery') ?? 30) }) : null;
  // r10: three's tone mapping / exposure / BloomNode values -> core post chain (&wgpuPost=0 = legacy per-fragment Reinhard)
  const postBridge = params.get('wgpuPost') === '0' ? null : createPostBridge({ backend, renderer, getPost, getAutoExposure, autoExposure: params.get('wgpuAE') !== '0', gtao: params.get('wgpuGtao') !== '0' });
  addEventListener('resize', size);
  // nt-frameleak: ONE extra [page:mem] line per tick (|census) with the size of every long-lived container on the native path. Diff two ticks: whatever grows with `frames` is the leak. Keys: ad_ scene-adapter, be_ wgpu-backend, tx_ transport/acks/writer, tsl_ TSL template cache, lr_ light registry, gi_ GI attachment.
  if (native) memLine('census', () => { const o = { frames: st.frames, busySkips: st.busySkips ?? 0 }; const add = (p, c) => { if (c) for (const k in c) if (typeof c[k] === 'number') o[p + k] = c[k]; }; add('ad_', adapter.census?.()); o.ad_updated = adapter.stats.updated; add('be_', backend.census?.()); add('tx_', backend.gpu?.census?.()); add('tsl_', tslCensus()); add('lr_', lightRegistryCensus(scene)); o.gi_att = getGi?.()?._attachment?.attachedCount; return o; });
  const st = Object.assign(st0, { frames: 0, adapterMs: 0, giMs: 0, syncMs: 0, submitMs: 0, gpu: [], lastSync: 0, lastSubmit: 0 });
  return {
    backend, adapter, canvas, stats: st, giBridge, giNative, noThreeGpu, postBridge, tslCache: structCache,
    // one frame: world matrices → adapter diff/push → core render. Replaces renderer.render(scene, camera) / post.render().
    frame() {
      if (backend.gpu?.busy?.()) { st.busySkips = (st.busySkips ?? 0) + 1; return; } // native transport backpressure (GaiaRenderNative.busy): never queue frames faster than the host applies them
      dropThreeCache(); // the game may re-enable Cache after boot
      const a = performance.now();
      camera.updateMatrixWorld?.();
      adapter.sync(scene, camera);
      const g0 = performance.now();
      giBridge?.tick();
      giNative?.poll();
      postBridge?.tick();
      const b = performance.now(); st.adapterMs += g0 - a; st.giMs += b - g0;
      backend.renderFrame();
      const c = performance.now();
      st.frames++; st.lastSync = b - a; st.lastSubmit = c - b; st.syncMs += b - a; st.submitMs += c - b;
    },
  };
}
