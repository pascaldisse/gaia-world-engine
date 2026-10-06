// render-api/wgpu-present.js — run the WHOLE live scene through the wasm wgpu renderer (engine seam, ?renderBackend=wgpu).
// three still builds/animates the scene graph (game code unchanged); this replaces only the draw: scene-adapter.sync → wgpu backend → overlay canvas.
// Params: ?renderBackend=wgpu &wgpuPkg=<url of render_wasm.js (default /pkg/render_wasm.js)> &wgpuHeight=<internal render height> &wgpuShadows=0|1 &wgpuTsl=1 (opt-in: export NodeMaterials to WGSL — dies on game custom vertex attributes today) &wgpuStats=1
import { createWgpuBackend } from './wgpu-backend.js';
import { createSceneAdapter } from './scene-adapter.js';
import { exportNodeMaterial } from './tsl-export.js';

export async function createWgpuPresenter({ renderer, scene, camera, THREE, params = new URLSearchParams(location.search) }) {
  const pkg = params.get('wgpuPkg') ?? '/pkg/render_wasm.js';
  const wasm = await import(/* @vite-ignore */ pkg);
  const host = renderer.domElement;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:1';
  host.style.visibility = 'hidden'; // three draws nothing in this mode
  host.parentNode.insertBefore(canvas, host.nextSibling);
  const size = () => { canvas.width = Math.max(1, Math.round(innerWidth)); canvas.height = Math.max(1, Math.round(innerHeight)); };
  size();
  const renderHeight = Number(params.get('wgpuHeight') ?? Math.min(innerHeight, 720));
  const backend = await createWgpuBackend({ canvas, wasm, renderHeight, staticInstances: 'non-skinned', options: { shadows: { enabled: params.get('wgpuShadows') !== '0' } } });
  const adapter = createSceneAdapter(backend, { three: THREE, exportNodeMaterial: params.get('wgpuTsl') !== '1' ? null : exportNodeMaterial, tslOptions: { THREE } });
  addEventListener('resize', size);
  const st = { frames: 0, syncMs: 0, submitMs: 0, gpu: [], lastSync: 0, lastSubmit: 0 };
  return {
    backend, adapter, canvas, stats: st,
    // one frame: world matrices → adapter diff/push → core render. Replaces renderer.render(scene, camera) / post.render().
    frame() {
      const a = performance.now();
      camera.updateMatrixWorld?.();
      adapter.sync(scene, camera);
      const b = performance.now();
      backend.renderFrame();
      const c = performance.now();
      st.frames++; st.lastSync = b - a; st.lastSubmit = c - b; st.syncMs += b - a; st.submitMs += c - b;
    },
  };
}
