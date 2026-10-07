// render-api/wgpu-present.js — run the WHOLE live scene through the wasm wgpu renderer (engine seam, ?renderBackend=wgpu).
// three still builds/animates the scene graph (game code unchanged); this replaces only the draw: scene-adapter.sync → wgpu backend → overlay canvas.
// Params: ?renderBackend=wgpu &wgpuPkg=<url of render_wasm.js (default /pkg/render_wasm.js)> &wgpuHeight=<internal render height> &wgpuShadows=0|1 &wgpuTsl=1 (opt-in: export NodeMaterials to WGSL — dies on game custom vertex attributes today) &wgpuStats=1 &wgpuGi=0|1 (probe GI atlases, default on when gi open mode is live) &wgpuGiEvery=30
import { installGpuMirror } from './gpu-mirror.js';
import { createWgpuBackend } from './wgpu-backend.js';
import { createSceneAdapter } from './scene-adapter.js';
import { exportNodeMaterial, structCache } from './tsl-export.js';
import { createGiBridge } from './gi-bridge.js';

export async function createWgpuPresenter({ renderer, scene, camera, THREE, getGi = null, params = new URLSearchParams(location.search) }) {
  const pkg = params.get('wgpuPkg') ?? '/pkg/render_wasm.js';
  const wasm = await import(/* @vite-ignore */ pkg);
  installGpuMirror(renderer); // array pages the game writes straight into three's device stay readable for the wgpu core
  const host = renderer.domElement;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:1';
  host.style.visibility = 'hidden'; // three draws nothing in this mode
  host.parentNode.insertBefore(canvas, host.nextSibling);
  const size = () => { canvas.width = Math.max(1, Math.round(innerWidth)); canvas.height = Math.max(1, Math.round(innerHeight)); };
  size();
  const renderHeight = Number(params.get('wgpuHeight') ?? Math.min(innerHeight, 720));
  const backend = await createWgpuBackend({ canvas, wasm, renderHeight, staticInstances: 'non-skinned', options: { shadows: { enabled: params.get('wgpuShadows') !== '0' } } });
  { const mt = Number(params.get('wgpuTslCacheMax')); if (Number.isFinite(mt) && mt > 0) structCache.maxTemplates = mt; } // r10-7 template retention bound
  structCache.share = params.get('wgpuShare') !== '0'; // r10-4 A/B flag (also togglable live: __wgpu.tslCache.share)
  const adapter = createSceneAdapter(backend, { three: THREE, exportNodeMaterial: params.get('wgpuTsl') !== '1' ? null : exportNodeMaterial, tslOptions: { THREE, cache: params.get('wgpuTslCache') === '0' ? 'off' : params.get('wgpuTslCache') === 'verify' ? 'verify' : 'on' }, nativeInstancing: params.get('wgpuInst') !== '0' });
  // r6: engine probe GI (?wgpuGi=0 off · &wgpuGiEvery=<frames between atlas readbacks, default 30>). three still runs the GI compute; the atlases are read back async.
  const giBridge = getGi && params.get('wgpuGi') !== '0' ? createGiBridge({ backend, renderer, getController: getGi, everyFrames: Number(params.get('wgpuGiEvery') ?? 30) }) : null;
  addEventListener('resize', size);
  const st = { frames: 0, adapterMs: 0, giMs: 0, syncMs: 0, submitMs: 0, gpu: [], lastSync: 0, lastSubmit: 0 };
  return {
    backend, adapter, canvas, stats: st, giBridge, tslCache: structCache,
    // one frame: world matrices → adapter diff/push → core render. Replaces renderer.render(scene, camera) / post.render().
    frame() {
      const a = performance.now();
      camera.updateMatrixWorld?.();
      adapter.sync(scene, camera);
      const g0 = performance.now();
      giBridge?.tick();
      const b = performance.now(); st.adapterMs += g0 - a; st.giMs += b - g0;
      backend.renderFrame();
      const c = performance.now();
      st.frames++; st.lastSync = b - a; st.lastSubmit = c - b; st.syncMs += b - a; st.submitMs += c - b;
    },
  };
}
