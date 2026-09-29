// CPU reference implementation of the probe update + query kernels
// (§GI-PROBES.md). This IS the ground truth the TSL graph in gi-nodes.js is
// built to structurally mirror op-by-op (parity proven by construction +
// structural graph checks, test/gi-nodes-parity.test.js) — numeric TSL==CPU
// equality itself is UNVERIFIED without a real GPU device (see docs), but
// this reference is fully exercised against analytic scenes below.
//
// Reuses the SAME pure modules the TSL side reuses formula-for-formula:
// octahedral encode/decode, Chebyshev visibility, hysteresis + MC
// integration, probe-grid indexing, occupancy-grid ray marching.

import { encodeOct, decodeOct } from './octahedral.js';
import { chebyshevWeight } from './chebyshev.js';
import { fibonacciSphereDirs, integrateProbeIrradiance } from './irradiance.js';
import { probeIndex, gridToWorld } from './probe-grid.js';
import { marchOccupancy } from './voxelize.js';

export const GI_REFERENCE_DEFAULTS = {
  albedo: 0.5, // PLACEHOLDER flat grey albedo when no surfaceAlbedoColor callback is given
  skyColor: [0.4, 0.5, 0.7], // PLACEHOLDER miss/ambient color
};

// ---- tiny vec3 helpers (kept local: this file is the one place both the
// ray-march shading math and the trilinear query math need them) ----
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const mul3 = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize3 = (a) => {
  const len = length3(a);
  return len > 1e-9 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 1];
};
const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Standard trilinear corner weight: offsets (ox,oy,oz) are each 0 or 1. */
export function trilinearWeight(frac, ox, oy, oz) {
  return (ox ? frac[0] : 1 - frac[0]) * (oy ? frac[1] : 1 - frac[1]) * (oz ? frac[2] : 1 - frac[2]);
}

function octUvToTexelIndex(u, v, res) {
  const tu = clampI(Math.floor(((u + 1) / 2) * res), 0, res - 1);
  const tv = clampI(Math.floor(((v + 1) / 2) * res), 0, res - 1);
  return tu + res * tv;
}

/**
 * One probe's full ray-cast update pass (§GI-PROBES.md "Representation for
 * software ray tracing" + "Irradiance/depth atlas + update"). Traces
 * `raysPerProbe` spherical-Fibonacci rays from `probePos` against the
 * occupancy grid; on hit shades sun (N.L + shadow march) + point lights +
 * previous-bounce irradiance (infinite bounce via `sampleAtlasIrradiance`),
 * all tinted by the hit surface's albedo color (flat PLACEHOLDER constant
 * unless `surfaceAlbedoColor(hitPos)` is given — the "per-voxel avg color
 * if cheap" option); on miss returns sky/hemi color.
 *
 * @returns {{irradianceTexels:Array<[number,number,number]>, depthTexels:Array<[number,number]>}}
 */
export function traceProbeRays({
  probePos,
  occupancy, voxelOrigin, cellSize, dims, maxDist,
  raysPerProbe, rotation = null,
  sun = null, pointLights = [],
  albedo = GI_REFERENCE_DEFAULTS.albedo,
  surfaceAlbedoColor = null, // (hitPos) => [r,g,b], overrides `albedo` when given
  skyColor = GI_REFERENCE_DEFAULTS.skyColor,
  sampleAtlasIrradiance = null, // (worldPos) => [r,g,b] previous-bounce lookup
}) {
  const rayDirs = fibonacciSphereDirs(raysPerProbe, rotation);
  return rayDirs.map((dir) => {
    const hitT = marchOccupancy(occupancy, dims, voxelOrigin, cellSize, probePos, dir, maxDist);
    if (hitT === null) return { dir, radiance: skyColor, dist: maxDist };

    const hitPos = add3(probePos, scale3(dir, hitT));
    // flat-voxel assumption: no true surface normal from the occupancy
    // grid, so the hit normal is approximated as facing back at the probe
    // (PLACEHOLDER — correct for a probe looking straight at a wall, wrong
    // for glancing hits; a real mesh-normal lookup is future work)
    const N = scale3(dir, -1);
    // self-shadow bias (§GI-PROBES.md Chebyshev/self-shadow note): the
    // occupancy march is FIXED-STEP (voxelize.js: step=cellSize*0.5), so
    // hitPos can land anywhere up to one step INSIDE the voxel that was
    // detected — not exactly on its surface. Biasing along the approximate
    // hit normal N is unreliable (N itself is only an approximation, see
    // above), so instead each shadow ray's origin is advanced one march
    // STEP along its OWN direction before marching — the same resolution
    // the occupancy detection itself used to find this hit, so it neither
    // under- nor over-shoots relative to what "one wall" means to this grid.
    const SHADOW_STEP = cellSize * 0.5;

    let direct = [0, 0, 0];
    if (sun) {
      const L = normalize3(scale3(sun.direction, -1)); // surface -> sun
      const ndotl = Math.max(0, dot3(N, L));
      if (ndotl > 0) {
        const shadowOrigin = add3(hitPos, scale3(L, SHADOW_STEP));
        const shadowT = marchOccupancy(occupancy, dims, voxelOrigin, cellSize, shadowOrigin, L, maxDist);
        const lit = shadowT === null ? 1 : 0;
        direct = add3(direct, scale3(sun.color, ndotl * (sun.intensity ?? 1) * lit));
      }
    }
    for (const pl of pointLights) {
      const toLight = sub3(pl.position, hitPos);
      const dist = length3(toLight);
      if (dist < 1e-6) continue;
      const Ldir = scale3(toLight, 1 / dist);
      const ndotl = Math.max(0, dot3(N, Ldir));
      if (ndotl <= 0) continue;
      const atten = 1 / Math.max(dist * dist, 1e-4);
      const shadowOrigin = add3(hitPos, scale3(Ldir, SHADOW_STEP));
      const shadowT = marchOccupancy(occupancy, dims, voxelOrigin, cellSize, shadowOrigin, Ldir, Math.max(0, dist - SHADOW_STEP - cellSize * 0.5));
      const lit = shadowT === null ? 1 : 0;
      const intensity = (pl.intensity ?? 1) * (pl.lightScale ?? 1);
      direct = add3(direct, scale3(pl.color, ndotl * intensity * atten * lit));
    }

    const bounce = sampleAtlasIrradiance ? sampleAtlasIrradiance(hitPos) : [0, 0, 0];
    const incident = add3(direct, bounce);
    const tint = surfaceAlbedoColor ? surfaceAlbedoColor(hitPos) : [albedo, albedo, albedo];
    const radiance = mul3(tint, incident);
    return { dir, radiance, dist: hitT };
  });
}

/**
 * One probe's full ray-cast-and-bake update pass: traces `traceProbeRays`
 * then bakes the result into the octahedral irradiance + depth atlas
 * (§GI-PROBES.md "Irradiance/depth atlas + update"). Split from the tracing
 * step so scene tests can inspect individual ray radiance directly (the
 * color-bleed test below needs to see a single hit's tinted radiance, not
 * only the fully baked/aggregated texel field).
 *
 * @returns {{irradianceTexels:Array<[number,number,number]>, depthTexels:Array<[number,number]>}}
 */
export function referenceUpdateProbe(config) {
  const { irradianceRes, depthRes } = config;
  const rays = traceProbeRays(config);

  const irradianceTexels = [];
  for (let v = 0; v < irradianceRes; v++) {
    for (let u = 0; u < irradianceRes; u++) {
      const uv = [((u + 0.5) / irradianceRes) * 2 - 1, ((v + 0.5) / irradianceRes) * 2 - 1];
      const n = decodeOct(uv);
      irradianceTexels.push(integrateProbeIrradiance(n, rays));
    }
  }

  const depthTexels = [];
  for (let v = 0; v < depthRes; v++) {
    for (let u = 0; u < depthRes; u++) {
      const uv = [((u + 0.5) / depthRes) * 2 - 1, ((v + 0.5) / depthRes) * 2 - 1];
      const n = decodeOct(uv);
      let wSum = 0, dSum = 0, d2Sum = 0;
      for (const ray of rays) {
        const w = Math.max(0, dot3(n, ray.dir));
        if (w === 0) continue;
        wSum += w; dSum += w * ray.dist; d2Sum += w * ray.dist * ray.dist;
      }
      depthTexels.push(wSum > 0 ? [dSum / wSum, d2Sum / wSum] : [0, 0]);
    }
  }

  return { irradianceTexels, depthTexels };
}

/**
 * Trilinear + Chebyshev + octahedral-texel probe query at a shaded point
 * (§GI-PROBES.md "Material sampling"). Real 8 enclosing corners from
 * `worldPos` (base cell = floor((p-origin)/spacing), clamped to dims), true
 * trilinear weights, `probeDir = normalize(probePos - p)` for the backface
 * weight, octahedral-encoded normal picks the irradiance texel per corner,
 * octahedral-encoded probe->point direction picks the depth texel,
 * Chebyshev visibility per corner.
 *
 * Exact-position law: querying AT a probe's own world position collapses
 * to exactly that probe's stored value at the query normal's texel (the
 * other 7 corners get trilinear weight 0; see the epsilon guard below).
 */
export function referenceQueryIrradiance({
  worldPos, normal,
  origin, spacing, dims,
  irradianceAtlas, depthAtlas, irradianceRes, depthRes,
}) {
  const rel = [
    (worldPos[0] - origin[0]) / spacing,
    (worldPos[1] - origin[1]) / spacing,
    (worldPos[2] - origin[2]) / spacing,
  ];
  const base = rel.map((v) => Math.floor(v));
  const frac = rel.map((v, i) => v - base[i]);

  let total = [0, 0, 0];
  let weightSum = 0;
  for (let c = 0; c < 8; c++) {
    const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
    const ix = clampI(base[0] + ox, 0, dims.x - 1);
    const iy = clampI(base[1] + oy, 0, dims.y - 1);
    const iz = clampI(base[2] + oz, 0, dims.z - 1);
    const cornerWorld = gridToWorld(ix, iy, iz, origin, spacing);
    const trilW = trilinearWeight(frac, ox, oy, oz);
    if (trilW <= 0) continue; // never touch the atlas for a zero-weight corner

    const toProbe = sub3(cornerWorld, worldPos);
    const testDist = length3(toProbe);
    // epsilon guard: at testDist~0 (query exactly at a probe) normalize()
    // would be undefined; the exact-position law only needs *a* forward
    // hemisphere so the sole nonzero corner is never spuriously zeroed
    const backface = testDist < 1e-6 ? 1 : Math.max(0, dot3(normal, normalize3(toProbe)));

    const pIdx = probeIndex(ix, iy, iz, dims);
    const [iu, iv] = encodeOct(normal);
    const iTexel = octUvToTexelIndex(iu, iv, irradianceRes);
    const irr = irradianceAtlas[pIdx * irradianceRes * irradianceRes + iTexel];

    const dDir = testDist < 1e-6 ? normal : normalize3(sub3(worldPos, cornerWorld));
    const [du, dv] = encodeOct(dDir);
    const dTexel = octUvToTexelIndex(du, dv, depthRes);
    const [mean, mean2] = depthAtlas[pIdx * depthRes * depthRes + dTexel];
    const vis = chebyshevWeight(mean, mean2, testDist);

    const w = trilW * backface * vis;
    total = add3(total, scale3(irr, w));
    weightSum += w;
  }
  if (weightSum < 1e-6) return [0, 0, 0];
  return scale3(total, 1 / weightSum);
}
