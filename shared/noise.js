// Pure, deterministic terrain math shared by the renderer client, the world
// server, and any headless agent — every observer computes the same ground.

export function hash2(x, z, seed) {
  const s = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx);
  const uz = smooth(fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm(x, z, seed, octaves = 4) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise(x * frequency, z * frequency, seed + i * 13);
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value;
}

export function terrainHeight(x, z, params) {
  if (!params) return 0;
  const { seed = 1, amplitude = 6, frequency = 0.015 } = params;
  return (fbm(x * frequency, z * frequency, seed) - 0.5) * 2 * amplitude;
}
