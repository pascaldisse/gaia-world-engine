// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// Own seeded PRNG (§4 "Seeded: same seed + same call sequence → identical
// particle/cut output (own PRNG, no Math.random)"). A closed-form mulberry32
// step: deterministic, allocation-free per call, 32-bit state. Not shared with
// any other extension so gore's determinism never depends on call order
// elsewhere in the engine touching a shared generator.

/**
 * @param {number} seed integer seed (defaults deterministically to 1)
 * @returns {() => number} a function returning a float in [0, 1)
 */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** float in [min, max) drawn from an makeRng() generator */
export function rngRange(rng, min, max) {
  return min + rng() * (max - min);
}

/** unit vector uniformly sampled over the hemisphere around `normal` (array [x,y,z]) */
export function rngHemisphere(rng, normal) {
  // cosine-agnostic uniform hemisphere sample: pick a uniform point on the
  // full sphere, flip it to the normal's side if it landed on the wrong one.
  const z = rngRange(rng, -1, 1);
  const theta = rngRange(rng, 0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  let x = r * Math.cos(theta), y = r * Math.sin(theta), zz = z;
  const dot = x * normal[0] + y * normal[1] + zz * normal[2];
  if (dot < 0) { x = -x; y = -y; zz = -zz; }
  return [x, y, zz];
}
