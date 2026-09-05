// Directional sun shadow — a generic renderer option with documented defaults.
//
// bias/normalBias are NOT cosmetic. The sun shadow map is an orthographic depth
// texture of finite resolution (mapSize taps over a 2*radius frustum). Its texel
// footprint (2*radius/mapSize; ~0.12 m at the defaults) means a surface can
// shadow ITSELF where the sampled depth rounds below the surface — acne. On
// large flat up-facing surfaces (building roofs) viewed straight down this reads
// as the whole roof going black — the top-down city then looks like solid black
// occluders. A small negative depth `bias` plus a world-space `normalBias`
// offset pushes the comparison off the surface and clears the acne.
//
// Shadows STAY ENABLED (castShadow true): directional cast shadows still render.
// The normalBias offset is a world-space nudge, so it can soften or peter-pan
// SMALL/THIN contact shadows — it is a tunable tradeoff, not a guarantee that
// every contact shadow is preserved pixel-for-pixel. Worlds that need tighter
// contacts lower normalBias (at the cost of some acne) via the env override.
//
// This module touches lighting only — the camera contract is untouched.
export const SHADOW_DEFAULTS = Object.freeze({
  enabled: true,
  mapSize: 2048, // shadow depth texture is mapSize x mapSize
  radius: 120, // half-extent of the orthographic shadow frustum, world metres
  near: 0.5,
  far: 400,
  bias: -0.0004, // depth bias (shadow-map depth units); small negative
  normalBias: 0.4, // world-space offset along the surface normal, metres
});

// Pure resolver: merge a partial/absent spec over the engine defaults and
// coerce every field to a sane value. Never mutates the input.
export function shadowSpec(spec = null) {
  const s = spec && typeof spec === 'object' ? spec : {};
  return {
    enabled: s.enabled === undefined ? SHADOW_DEFAULTS.enabled : !!s.enabled,
    mapSize: posInt(s.mapSize, SHADOW_DEFAULTS.mapSize),
    radius: posNum(s.radius, SHADOW_DEFAULTS.radius),
    near: posNum(s.near, SHADOW_DEFAULTS.near),
    far: posNum(s.far, SHADOW_DEFAULTS.far),
    bias: Number.isFinite(s.bias) ? s.bias : SHADOW_DEFAULTS.bias,
    normalBias: Number.isFinite(s.normalBias) && s.normalBias >= 0 ? s.normalBias : SHADOW_DEFAULTS.normalBias,
  };
}

// Configure a THREE.DirectionalLight's shadow from a (partial) spec. Returns the
// resolved spec. Idempotent for equal specs: it never toggles castShadow or
// resizes the map when the values already match, so re-applying the default on
// every environment load does not trigger a pipeline recompile.
export function applyShadow(light, spec = null) {
  const s = shadowSpec(spec);
  if (light.castShadow !== s.enabled) light.castShadow = s.enabled;
  const sh = light.shadow;
  if (sh) {
    if (sh.mapSize.x !== s.mapSize || sh.mapSize.y !== s.mapSize) sh.mapSize.set(s.mapSize, s.mapSize);
    const cam = sh.camera;
    cam.left = -s.radius; cam.right = s.radius;
    cam.top = s.radius; cam.bottom = -s.radius;
    cam.near = s.near; cam.far = s.far;
    sh.bias = s.bias;
    sh.normalBias = s.normalBias;
    cam.updateProjectionMatrix?.();
  }
  return s;
}

function posNum(v, d) { return Number.isFinite(v) && v > 0 ? v : d; }
function posInt(v, d) { return Number.isFinite(v) && v > 0 ? Math.round(v) : d; }
