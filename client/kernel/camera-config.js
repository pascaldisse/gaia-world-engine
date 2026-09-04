export const CAMERA_DEFAULTS = Object.freeze({
  projection: 'perspective',
  fov: 70,
  near: 0.1,
  far: 4000,
  orthoSize: 10,
});
export function cameraSpec(spec = null) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const pixel = source.pixel && typeof source.pixel === 'object'
    && Number.isFinite(source.pixel.width) && source.pixel.width > 0
    && Number.isFinite(source.pixel.height) && source.pixel.height > 0
    ? { width: Math.round(source.pixel.width), height: Math.round(source.pixel.height) }
    : null;
  return {
    ...CAMERA_DEFAULTS,
    ...source,
    projection: source.projection === 'orthographic' ? 'orthographic' : 'perspective',
    fov: finite(source.fov, CAMERA_DEFAULTS.fov),
    near: finite(source.near, CAMERA_DEFAULTS.near),
    far: finite(source.far, CAMERA_DEFAULTS.far),
    orthoSize: finite(source.orthoSize, CAMERA_DEFAULTS.orthoSize),
    pixel,
  };
}
export function activeCameraRig(spec, vehicle = false) {
  if (!spec) return null;
  const variant = vehicle ? spec.vehicle : spec.onFoot;
  return variant && typeof variant === 'object' ? { ...spec, ...variant } : spec;
}
function finite(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
