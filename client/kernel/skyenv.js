import * as THREE from 'three/webgpu';

// §ENVIRONMENT. A transmissive material refracts whatever the ENVIRONMENT
// holds — not what the lights do. With `scene.environment === null` every
// glass surface samples one flat colour, so ior/roughness/thickness tuning is
// pure placebo: measured on the Surya basin (envMap:false, environment:null,
// background #101c30 ⇒ refraction = solid navy). This module supplies the
// missing half: a procedural equirect sky, uploaded once, no file assets.
//
// WebGPU note: three's node pipeline runs PMREM on an equirect environment
// texture itself (PMREMNode), so no PMREMGenerator pass is needed here.
export const SKY_ENV = {
  enabled: true,
  size: 256,                 // equirect height in px (width = 2×); 256 is ample for IBL
  intensity: 1.0,            // scene.environmentIntensity
  zenith: '#20406e',         // top of the dome
  horizon: '#9fc6ff',        // the band the glass will actually pick up
  ground: '#241d16',         // below the horizon
  horizonSoftness: 0.12,     // fraction of the dome the horizon band blends over
  sun: { enabled: true, color: '#fff0cc', elevation: 0.55, azimuth: 0.25, size: 0.06, intensity: 1.0 },
  applyBackground: false,    // leave scene.background to the environment system
};

// NOTE: `client/kernel/environment.js` is a DIFFERENT thing (background/fog/
// light moods). This module touches `scene.environment` (three's IBL slot),
// which the engine has never set. Worlds that do not carry the component keep
// `scene.environment === null` — Atlas's look is bit-identical.

/**
 * Build the sky texture. Pure: returns a THREE.Texture, touches nothing.
 * @param {object} [options] overrides for SKY_ENV
 */
export function createSkyTexture(options = {}) {
  const O = { ...SKY_ENV, ...options, sun: { ...SKY_ENV.sun, ...(options.sun || {}) } };
  const h = Math.max(16, Math.floor(O.size));
  const w = h * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const soft = Math.min(0.49, Math.max(0.001, O.horizonSoftness));
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, O.zenith);
  grad.addColorStop(Math.max(0, 0.5 - soft), O.horizon);
  grad.addColorStop(Math.min(1, 0.5 + soft * 0.25), O.ground);
  grad.addColorStop(1, O.ground);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (O.sun.enabled) {
    // elevation 0..1 = horizon..zenith; azimuth 0..1 wraps the equirect u axis
    const cx = (O.sun.azimuth % 1) * w;
    const cy = (1 - O.sun.elevation) * 0.5 * h;
    const r = Math.max(1, O.sun.size * h);
    const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 4);
    disc.addColorStop(0, O.sun.color);
    disc.addColorStop(0.25, O.sun.color);
    disc.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = Math.min(1, Math.max(0, O.sun.intensity));
    ctx.fillStyle = disc;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Install the environment on a scene. Returns a handle with dispose().
 * @param {THREE.Scene} scene
 * @param {object} [options] overrides for SKY_ENV
 */
export function installSkyEnvironment(scene, options = {}) {
  const O = { ...SKY_ENV, ...options, sun: { ...SKY_ENV.sun, ...(options.sun || {}) } };
  if (!scene || O.enabled === false) return null;
  const texture = createSkyTexture(O);
  scene.environment = texture;
  scene.environmentIntensity = O.intensity;
  if (O.applyBackground) scene.background = texture;
  const prevIntensity = scene.environmentIntensity;
  return {
    texture,
    params: O,
    dispose() {
      if (scene.environment === texture) {
        scene.environment = null;
        scene.environmentIntensity = prevIntensity;
      }
      if (scene.background === texture) scene.background = null;
      texture.dispose();
    },
  };
}

// ───────────────────────────────────────────────────────── extension gate ──
// Opt-in by WORLD DATA only, exactly like the fluid: one entity may carry a
// `skyEnvironment` component. No component (or more than one — ambiguity is
// not consent) ⇒ nothing is installed and nothing is allocated.
export function register(ctx = {}) {
  const { scene, store } = ctx;
  let handle = null;
  let activeConfig = null;

  const worldConfig = () => {
    const matches = [...(store?.entities?.values?.() ?? [])]
      .map((components) => components?.skyEnvironment)
      .filter((sky) => sky?.enabled === true);
    return matches.length === 1 ? matches[0] : null;
  };
  const stop = () => { handle?.dispose(); handle = null; activeConfig = null; };

  return {
    name: 'skyEnvironment',
    api: {
      SKY_ENV,
      createSkyTexture,
      install: (opts) => { stop(); handle = installSkyEnvironment(scene, opts); return handle; },
      stop,
      get handle() { return handle; },
    },
    sync() {
      const config = worldConfig();
      if (!config) { stop(); return; }
      if (JSON.stringify(config) === JSON.stringify(activeConfig)) return;
      stop();
      activeConfig = config;
      handle = installSkyEnvironment(scene, config);
    },
  };
}

export default register;
