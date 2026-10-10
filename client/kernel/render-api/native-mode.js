// render-api/native-mode.js — "three holds NO GPU state" (lane nt-gi, docs/NATIVE.md §three-gpu).
// In the native app all drawing + GPU compute lives in gaia-render (Metal). three still owns the scene graph + TSL node graphs, but must never request a GPU device
// (a second device doubled memory and grew ~20 MB/s). Flag: `?threeGpu=0` (explicit, needs `?renderBackend=wgpu`) or `window.__GAIA_NATIVE__ === true` (injected by the native host
// before the page script runs). Default = three owns a device (browser).
// What it relies on (checked in three r180 source): a WebGPURenderer that is NEVER init()'d requests no adapter/device (WebGPUBackend.init is the only requester), keeps plain
// property setters (toneMapping, toneMappingExposure, shadowMap, setSize/setPixelRatio guard on _initialized) and still builds node graphs (tsl-export.js headlessRenderer does exactly this).
export function threeGpuOff(g = globalThis) {
  const q = g.location ? new URLSearchParams(g.location.search) : null;
  const flag = q?.get('threeGpu');
  const off = flag === '0' || (flag === null && g.__GAIA_NATIVE__ === true);
  if (off && q?.get('renderBackend') !== 'wgpu') throw new Error('native mode (threeGpu=0 / __GAIA_NATIVE__) needs ?renderBackend=wgpu: with three\'s GPU off nothing else can draw');
  return off;
}
// Everything on WebGPURenderer that would lazily init() (=> request a device) or run GPU work. Replaced by counted no-ops: a stray call becomes a visible number in
// renderer.userData.threeGpuBlocked instead of a silent second device. Rejecting variants are for readbacks (callers already .catch them).
const NOOP = ['render', 'compile', 'compute', 'initTexture', 'copyTextureToTexture', 'copyFramebufferToTexture', 'setAnimationLoop', 'clear', 'clearColor', 'clearDepth', 'clearStencil'];
const ASYNC_OK = ['init', 'renderAsync', 'compileAsync', 'computeAsync', 'initTextureAsync', 'waitForGPU', 'clearAsync', 'clearColorAsync', 'clearDepthAsync', 'clearStencilAsync'];
const ASYNC_REJECT = ['getArrayBufferAsync', 'readRenderTargetPixelsAsync', 'hasFeatureAsync'];
export function lockThreeGpu(renderer, warn = (m) => console.warn(m)) {
  const blocked = (renderer.userData ??= {}).threeGpuBlocked = {};
  const hit = (name) => { if (!blocked[name]) warn(`[gaia] three GPU is OFF (native mode): renderer.${name}() blocked — this feature has no native path yet (docs/NATIVE.md §three-gpu)`); blocked[name] = (blocked[name] ?? 0) + 1; };
  for (const n of NOOP) if (typeof renderer[n] === 'function') renderer[n] = () => { hit(n); };
  for (const n of ASYNC_OK) if (typeof renderer[n] === 'function') renderer[n] = async () => { if (n !== 'init') hit(n); return renderer; };
  for (const n of ASYNC_REJECT) if (typeof renderer[n] === 'function') renderer[n] = async () => { hit(n); throw new Error(`renderer.${n}: three GPU is off (native mode)`); };
  renderer.userData.threeGpuLocked = true;
  return renderer;
}
