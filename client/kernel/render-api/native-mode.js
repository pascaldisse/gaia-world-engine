// render-api/native-mode.js — "three holds NO GPU state" (lane nt-gi, docs/NATIVE.md §three-gpu).
// In the native app all drawing + GPU compute lives in gaia-render (Metal). three still owns the scene graph + TSL node graphs, but must never request a GPU device
// (a second device doubled memory and grew ~20 MB/s). Flag: `?threeGpu=0` (explicit, needs `?renderBackend=wgpu`) or `window.__GAIA_NATIVE__ === true` (injected by the native host
// before the page script runs). Default = three owns a device (browser).
// What it relies on (checked in three r180 source): a WebGPURenderer that is NEVER init()'d requests no adapter/device (WebGPUBackend.init is the only requester), keeps plain
// property setters (toneMapping, toneMappingExposure, shadowMap, setSize/setPixelRatio guard on _initialized) and still builds node graphs (tsl-export.js headlessRenderer does exactly this).
export const nativeBackend = (g = globalThis) => (g.location ? new URLSearchParams(g.location.search).get('renderBackend') === 'native' : false);
/** true = three must hold no GPU state. `renderBackend=native` always; `renderBackend=wgpu` only with `threeGpu=0`/`__GAIA_NATIVE__`. Accepts URLSearchParams (tests/presenter) or a global. */
export function threeGpuOff(src = globalThis) {
  const g = src instanceof URLSearchParams ? globalThis : src;
  const q = src instanceof URLSearchParams ? src : g.location ? new URLSearchParams(g.location.search) : null;
  const rb = q?.get('renderBackend');
  if (rb === 'native') return true;
  const flag = q?.get('threeGpu');
  const off = flag === '0' || (flag === null && g.__GAIA_NATIVE__ === true);
  if (off && rb !== 'wgpu') throw new Error('threeGpu=0 / __GAIA_NATIVE__ needs ?renderBackend=wgpu|native: with three\'s GPU off nothing else can draw');
  return off;
}
// Only installed for renderBackend=native (the browser wgpu A/B mode needs its own webgpu canvas context for the wasm renderer).
// The page must create NO GPU context at all (WKWebView: no WebGPU, and a WebGPURenderer.init() would silently fall back to a WebGL2 context). Belt and braces on top of never
// init()ing the renderer: any getContext('webgl'|'webgl2'|'webgpu'|'experimental-webgl') on a page canvas returns null and is counted in globalThis.__gaiaGpuContextBlocked.
const GPU_CTX = /^(webgl2?|experimental-webgl2?|webgpu)$/;
export function installGpuContextGuard(g = globalThis) {
  if (g.__gaiaGpuContextBlocked) return false;
  const counts = (g.__gaiaGpuContextBlocked = {});
  for (const C of [g.HTMLCanvasElement, g.OffscreenCanvas]) {
    const proto = C?.prototype; const orig = proto?.getContext; if (!orig) continue;
    proto.getContext = function (type, ...rest) {
      if (GPU_CTX.test(String(type))) { counts[type] = (counts[type] ?? 0) + 1; if (counts[type] === 1) console.warn(`[gaia] native mode: getContext('${type}') blocked — the page holds no GPU context (docs/NATIVE.md §three-gpu)`); return null; }
      return orig.call(this, type, ...rest);
    };
  }
  return true;
}
// Everything on WebGPURenderer that would lazily init() (=> request a device) or run GPU work. Replaced by counted no-ops: a stray call becomes a visible number in
// renderer.userData.threeGpuBlocked instead of a silent second device. Rejecting variants are for readbacks (callers already .catch them).
const NOOP = ['render', 'compile', 'compute', 'initTexture', 'copyTextureToTexture', 'copyFramebufferToTexture', 'setAnimationLoop', 'clear', 'clearColor', 'clearDepth', 'clearStencil'];
const ASYNC_OK = ['init', 'renderAsync', 'compileAsync', 'computeAsync', 'initTextureAsync', 'waitForGPU', 'clearAsync', 'clearColorAsync', 'clearDepthAsync', 'clearStencilAsync'];
const ASYNC_REJECT = ['getArrayBufferAsync', 'readRenderTargetPixelsAsync', 'hasFeatureAsync'];
export function lockThreeGpu(renderer, warn = (m) => console.warn(m)) {
  const blocked = (renderer.userData ??= {}).threeGpuBlocked = {};
  const hit = (name) => { if (!blocked[name]) warn(`[gaia] three GPU is OFF (native mode): renderer.${name}() blocked — this feature has no native path yet (docs/NATIVE.md §three-gpu)`); blocked[name] = (blocked[name] ?? 0) + 1; };
  // own-property define (not assignment): some entry points are prototype GETTERS (r180 `get compile()` -> compileAsync), and assigning over a getter-only accessor throws in module (strict) code
  const put = (n, fn) => Object.defineProperty(renderer, n, { value: fn, writable: true, configurable: true, enumerable: false });
  for (const n of NOOP) if (typeof renderer[n] === 'function') put(n, () => { hit(n); });
  for (const n of ASYNC_OK) if (typeof renderer[n] === 'function') put(n, async () => { if (n !== 'init') hit(n); return renderer; });
  for (const n of ASYNC_REJECT) if (typeof renderer[n] === 'function') put(n, async () => { hit(n); throw new Error(`renderer.${n}: three GPU is off (native mode)`); });
  renderer.userData.threeGpuLocked = true;
  return renderer;
}
