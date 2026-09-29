// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §2 determinism law. Small counter-style 32-bit generator (public-domain "mulberry32" family, Tommy Ettinger)
// + a stateless keyed roll built from a murmur3-style finalizer (https://github.com/aappleby/smhasher).
const u32 = x => x >>> 0;

// Avalanche finalizer (murmur3 fmix32).
function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Stream generator: uniform [0,1). Seed = any number, coerced to uint32.
export function createRng(seed) {
  let s = u32(seed);
  return function next() {
    s = u32(s + 0x6d2b79f5);
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return u32(t ^ (t >>> 14)) / 4294967296;
  };
}

// Decorrelate distinct uses that share one caller seed: fold a per-use constant into the seed.
export function mixSeed(seed, salt) {
  return fmix(u32(u32(seed) ^ Math.imul(u32(salt) + 0x9e3779b9, 0x85ebca6b)) + 0x7f4a7c15);
}

// Stateless keyed roll in [0,1): same (seed, keys...) -> same value, independent of call order.
export function rand01(seed, ...keys) {
  let h = fmix(u32(seed) ^ 0x2545f491);
  for (const k of keys) h = fmix(u32(h + Math.imul(u32(k) + 0x9e3779b9, 0xcc9e2d51)));
  return h / 4294967296;
}
