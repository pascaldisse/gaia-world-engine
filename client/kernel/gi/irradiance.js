// Probe irradiance integration + temporal hysteresis (§GI-PROBES.md, eq(1) of
// Majercik et al. arXiv:2009.10796). Pure math — no GPU, no textures; the
// compute kernel in gi-nodes.js runs the same formula per-texel on device.

/**
 * Monte-Carlo estimate of the cosine-weighted hemisphere integral for one
 * octahedral texel direction, given N ray samples drawn uniformly over the
 * FULL sphere (pdf = 1/4π each). Estimator: (4π/N) Σ max(0,n·ω) L(ω).
 * Converges to ∫ cosθ L dω = π·L for constant surround radiance L
 * (Lambertian identity) — asserted by test/gi-irradiance.test.js.
 *
 * @param {[number,number,number]} texelDir unit direction of the atlas texel
 * @param {Array<{dir:[number,number,number], radiance:[number,number,number]}>} rays
 * @returns {[number,number,number]} raw (un-blended) irradiance estimate
 */
export function integrateProbeIrradiance(texelDir, rays) {
  const n = rays.length;
  if (n === 0) return [0, 0, 0];
  let r = 0, g = 0, b = 0;
  for (const ray of rays) {
    const w = Math.max(0, dot(texelDir, ray.dir));
    if (w === 0) continue;
    r += w * ray.radiance[0];
    g += w * ray.radiance[1];
    b += w * ray.radiance[2];
  }
  const k = (4 * Math.PI) / n;
  return [r * k, g * k, b * k];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * eq(1): E' = alpha*E + (1-alpha)*newEstimate — per-channel scalar blend.
 * Works for both the irradiance atlas (higher alpha, slow/smooth) and the
 * depth atlas (lower alpha, snaps to new occluders faster).
 */
export function blendHysteresis(oldVal, newVal, alpha) {
  return alpha * oldVal + (1 - alpha) * newVal;
}

export function blendHysteresisVec3(oldVec, newVec, alpha) {
  return [
    blendHysteresis(oldVec[0], newVec[0], alpha),
    blendHysteresis(oldVec[1], newVec[1], alpha),
    blendHysteresis(oldVec[2], newVec[2], alpha),
  ];
}

// PLACEHOLDER defaults (§GI-PROBES.md Irradiance/depth atlas + update):
// flat alphas, no adaptive per-texel convergence heuristic (paper §4.3) yet.
export const GI_HYSTERESIS = {
  irradianceAlpha: 0.97,
  depthAlpha: 0.9,
};

/** Fixed spherical-Fibonacci ray directions, randomly rotated per update
 *  (§GI-PROBES.md Ray budget — kills banding without per-ray RNG divergence). */
export function fibonacciSphereDirs(count, rotation = null) {
  const dirs = [];
  const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = phi * i;
    let x = Math.cos(theta) * radius;
    let z = Math.sin(theta) * radius;
    if (rotation) [x, y, z] = applyRotation([x, y, z], rotation); // eslint-disable-line no-unused-vars
    dirs.push(rotation ? applyRotation([x, y, z], rotation) : [x, y, z]);
  }
  return dirs;
}

function applyRotation(v, m) {
  // m: row-major 3x3
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
