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
import { isSolid, unpackAlbedo } from './voxel-window.js';
import { selectCascades, cellToWorld, slotOfCell, CASCADE_DEFAULTS, cascadeContains, borderDistanceCells } from './cascade.js';

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
/**
 * Single-ray trace+shade, exposing every intermediate value a GPU-vs-CPU
 * debug diff needs (§GI-PROBES.md, parent review 09-29 4th pass: "extend
 * rayDebug with per-ray radiance + shadowT + normal"). `traceProbeRays`
 * below is a thin wrapper over this — single source of truth, so the debug
 * export can never silently drift from what actually gets baked into the
 * atlas.
 * @returns {{dir, hit:boolean, hitT:number|null, N:[number,number,number]|null, shadowT:number|null, radiance:[number,number,number], dist:number}}
 */
export function traceSingleRay({
  probePos, dir,
  occupancy, voxelOrigin, cellSize, dims, maxDist,
  sun = null, pointLights = [],
  albedo = GI_REFERENCE_DEFAULTS.albedo,
  surfaceAlbedoColor = null,
  skyColor = GI_REFERENCE_DEFAULTS.skyColor,
  sampleAtlasIrradiance = null,
}) {
  const hitT = marchOccupancy(occupancy, dims, voxelOrigin, cellSize, probePos, dir, maxDist);
  if (hitT === null) return { dir, hit: false, hitT: null, N: null, shadowT: null, radiance: skyColor, dist: maxDist };

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
  let sunShadowT = null;
  if (sun) {
    const L = normalize3(scale3(sun.direction, -1)); // surface -> sun
    const ndotl = Math.max(0, dot3(N, L));
    if (ndotl > 0) {
      const shadowOrigin = add3(hitPos, scale3(L, SHADOW_STEP));
      sunShadowT = marchOccupancy(occupancy, dims, voxelOrigin, cellSize, shadowOrigin, L, maxDist);
      const lit = sunShadowT === null ? 1 : 0;
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
  return { dir, hit: true, hitT, N, shadowT: sunShadowT, radiance, dist: hitT };
}

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
  return rayDirs.map((dir) => traceSingleRay({
    probePos, dir, occupancy, voxelOrigin, cellSize, dims, maxDist,
    sun, pointLights, albedo, surfaceAlbedoColor, skyColor, sampleAtlasIrradiance,
  }));
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

// ======================================================================
// v2 open-world reference (docs/GI-PROBES.md §v2 open-world). ADDITIVE — nothing
// above changed (RTS mode pinned bit-identical by test/gi-rts-regression.test.js).
// ======================================================================
export const OPEN_DEFAULTS = {
  sky: { zenith: [0.25, 0.45, 0.9], horizon: [0.6, 0.7, 0.85], ground: [0.15, 0.13, 0.1] }, // PLACEHOLDER 3-colour gradient
  adaptive: { fast: 0.5, threshold: 0.5 }, // PLACEHOLDER hysteresis adaptation
  relocateSteps: 3, // PLACEHOLDER max cells probed per axis dir when relocating a solid-embedded probe
};
export const RECIP_PI = 1 / Math.PI;

/** sky radiance for a direction: horizon→zenith above, horizon→ground below (sky visibility = the under-bridge/tunnel darkening) */
export function skyRadiance(dir, sky = OPEN_DEFAULTS.sky) {
  const y = dir[1];
  const t = Math.min(1, Math.max(0, Math.abs(y)));
  const s = t * t * (3 - 2 * t);
  const end = y >= 0 ? sky.zenith : sky.ground;
  return [sky.horizon[0] + (end[0] - sky.horizon[0]) * s, sky.horizon[1] + (end[1] - sky.horizon[1]) * s, sky.horizon[2] + (end[2] - sky.horizon[2]) * s];
}

/** fixed-step march over a VoxelWindow-like {cellSize,getVoxelAtWorld}; step=cell/2 (same as RTS march). @returns t|null */
export function marchVoxelWindow(vox, origin, dir, maxDist) {
  const step = vox.cellSize * 0.5;
  for (let t = 0; t < maxDist; t += step) {
    const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    if (isSolid(vox.getVoxelAtWorld(p))) return t;
  }
  return null;
}
/** hit normal from the occupancy gradient (6-neighbour central difference), facing the ray; zero gradient (thin wall) → -dir */
export function voxelNormal(vox, hitPos, dir) {
  const s = vox.cellSize;
  const cx = Math.floor(hitPos[0] / s), cy = Math.floor(hitPos[1] / s), cz = Math.floor(hitPos[2] / s);
  const o = (x, y, z) => (isSolid(vox.getVoxel(x, y, z)) ? 1 : 0);
  let g = [o(cx - 1, cy, cz) - o(cx + 1, cy, cz), o(cx, cy - 1, cz) - o(cx, cy + 1, cz), o(cx, cy, cz - 1) - o(cx, cy, cz + 1)];
  if (g[0] === 0 && g[1] === 0 && g[2] === 0) return scale3(dir, -1);
  g = normalize3(g);
  return dot3(g, dir) > 0 ? scale3(g, -1) : g;
}

/**
 * v2 single-ray trace+shade. miss → sky radiance. hit → voxelAlbedo/π × (sun·N.L w/ occupancy shadow march + multi-bounce).
 * `sampleAtlasIrradiance(pos, normal)` = trilinear cascade query of the PREVIOUS atlas (irradiance E).
 */
export function traceSingleRayOpen({ probePos, dir, vox, maxDist, sun = null, sky = OPEN_DEFAULTS.sky, sampleAtlasIrradiance = null }) {
  const hitT = marchVoxelWindow(vox, probePos, dir, maxDist);
  if (hitT === null) return { dir, hit: false, hitT: null, N: null, radiance: skyRadiance(dir, sky), dist: maxDist };
  const hitPos = add3(probePos, scale3(dir, hitT));
  const N = voxelNormal(vox, hitPos, dir);
  const albedo = unpackAlbedo(vox.getVoxelAtWorld(hitPos));
  const bias = vox.cellSize * 1.01; // leave the hit voxel along N before shadow marching
  const outPos = add3(hitPos, scale3(N, bias));
  let E = [0, 0, 0];
  let shadowT = null;
  if (sun) {
    const L = normalize3(scale3(sun.direction, -1));
    const ndotl = Math.max(0, dot3(N, L));
    if (ndotl > 0) {
      shadowT = marchVoxelWindow(vox, outPos, L, maxDist);
      if (shadowT === null) E = add3(E, scale3(sun.color, ndotl * (sun.intensity ?? 1)));
    }
  }
  if (sampleAtlasIrradiance) E = add3(E, sampleAtlasIrradiance(outPos, N));
  return { dir, hit: true, hitT, N, shadowT, radiance: scale3(mul3(albedo, E), RECIP_PI), dist: hitT };
}

/** probe in a solid voxel: relocate along axis to nearest empty cell (≤ maxOffset) else disable (state: 'active'|'relocated'|'disabled') */
export function resolveProbePosition(vox, pos, maxOffset, steps = OPEN_DEFAULTS.relocateSteps) {
  if (!isSolid(vox.getVoxelAtWorld(pos))) return { state: 'active', pos };
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let k = 1; k <= steps; k++) {
    if (k * vox.cellSize > maxOffset) break;
    for (const d of dirs) {
      const q = [pos[0] + d[0] * k * vox.cellSize, pos[1] + d[1] * k * vox.cellSize, pos[2] + d[2] * k * vox.cellSize];
      if (!isSolid(vox.getVoxelAtWorld(q))) return { state: 'relocated', pos: q };
    }
  }
  return { state: 'disabled', pos };
}
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** adaptive hysteresis: big relative luminance change → faster alpha (DDGI §4.3 style). returns alpha actually used */
export function adaptiveAlpha(oldRGB, newRGB, alpha, { fast = OPEN_DEFAULTS.adaptive.fast, threshold = OPEN_DEFAULTS.adaptive.threshold } = {}) {
  const lo = luma(oldRGB), ln = luma(newRGB);
  const rel = Math.abs(ln - lo) / (Math.max(lo, ln) + 1e-3);
  const t = Math.min(1, Math.max(0, rel / threshold));
  return alpha + (fast - alpha) * t;
}

/** one probe's v2 update: resolve state, trace (sky/hit/multibounce), bake atlas texels. Disabled → irradiance 0, depth sentinel (-1,-1). */
export function openUpdateProbe({ probePos, vox, maxDist, raysPerProbe, rotation = null, sun = null, sky, sampleAtlasIrradiance = null, irradianceRes = 8, depthRes = 16, relocateMax = Infinity }) {
  const st = resolveProbePosition(vox, probePos, relocateMax);
  if (st.state === 'disabled') {
    return { state: 'disabled', irradianceTexels: Array.from({ length: irradianceRes * irradianceRes }, () => [0, 0, 0]), depthTexels: Array.from({ length: depthRes * depthRes }, () => [-1, -1]) };
  }
  const rays = fibonacciSphereDirs(raysPerProbe, rotation).map((dir) => traceSingleRayOpen({ probePos: st.pos, dir, vox, maxDist, sun, sky, sampleAtlasIrradiance }));
  const irradianceTexels = [], depthTexels = [];
  for (let v = 0; v < irradianceRes; v++) for (let u = 0; u < irradianceRes; u++) irradianceTexels.push(integrateProbeIrradiance(decodeOct([((u + 0.5) / irradianceRes) * 2 - 1, ((v + 0.5) / irradianceRes) * 2 - 1]), rays));
  for (let v = 0; v < depthRes; v++) for (let u = 0; u < depthRes; u++) {
    const n = decodeOct([((u + 0.5) / depthRes) * 2 - 1, ((v + 0.5) / depthRes) * 2 - 1]);
    let wS = 0, dS = 0, d2S = 0;
    for (const r of rays) { const w = Math.max(0, dot3(n, r.dir)); if (w === 0) continue; wS += w; dS += w * r.dist; d2S += w * r.dist * r.dist; }
    depthTexels.push(wS > 0 ? [dS / wS, d2S / wS] : [0, 0]);
  }
  return { state: st.state, irradianceTexels, depthTexels };
}

/**
 * Trilinear + Chebyshev query of ONE toroidal cascade (corner slots via slotOfCell; disabled probes (depth mean<0) get weight 0).
 * @returns {{value:[number,number,number], weight:number}} weight = Σ corner weights (0 = no usable probe)
 */
export function queryCascade({ worldPos, normal, cascade, baseCell, irradianceAtlas, depthAtlas, irradianceRes, depthRes }) {
  const sp = cascade.spacing; const o = cellToWorld(baseCell, sp);
  const rel = [(worldPos[0] - o[0]) / sp, (worldPos[1] - o[1]) / sp, (worldPos[2] - o[2]) / sp];
  const b = rel.map(Math.floor); const f = rel.map((v, i) => v - b[i]);
  let total = [0, 0, 0], wSum = 0;
  for (let c = 0; c < 8; c++) {
    const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
    const trilW = trilinearWeight(f, ox, oy, oz); if (trilW <= 0) continue;
    const cx = baseCell[0] + b[0] + ox, cy = baseCell[1] + b[1] + oy, cz = baseCell[2] + b[2] + oz;
    const slot = slotOfCell(cascade, cx, cy, cz);
    const cornerWorld = [cx * sp, cy * sp, cz * sp];
    const toProbe = sub3(cornerWorld, worldPos); const testDist = length3(toProbe);
    const backface = testDist < 1e-6 ? 1 : Math.max(0, dot3(normal, normalize3(toProbe)));
    const [iu, iv] = encodeOct(normal);
    const irr = irradianceAtlas[(cascade.baseIndex + slot) * irradianceRes * irradianceRes + octUvToTexelIndex(iu, iv, irradianceRes)];
    const dDir = testDist < 1e-6 ? normal : normalize3(sub3(worldPos, cornerWorld));
    const [du, dv] = encodeOct(dDir);
    const [mean, mean2] = depthAtlas[(cascade.baseIndex + slot) * depthRes * depthRes + octUvToTexelIndex(du, dv, depthRes)];
    if (mean < 0) continue; // disabled probe sentinel
    const w = trilW * backface * chebyshevWeight(mean, mean2, testDist);
    total = add3(total, scale3(irr, w)); wSum += w;
  }
  return wSum < 1e-6 ? { value: [0, 0, 0], weight: 0 } : { value: scale3(total, 1 / wSum), weight: wSum };
}
/** multi-cascade query: finest containing cascade + border blend; falls through to coarser if the finer has no usable probe */
export function referenceQueryCascades({ worldPos, normal, cascades, baseCells, irradianceAtlas, depthAtlas, irradianceRes, depthRes, blendCells = CASCADE_DEFAULTS.blendCells }) {
  const sel = selectCascades(cascades, baseCells, worldPos, blendCells);
  let total = [0, 0, 0], wTot = 0;
  for (const { index, weight } of sel) {
    const q = queryCascade({ worldPos, normal, cascade: cascades[index], baseCell: baseCells[index], irradianceAtlas, depthAtlas, irradianceRes, depthRes });
    if (q.weight === 0) continue;
    total = add3(total, scale3(q.value, weight)); wTot += weight;
  }
  if (wTot === 0) { // fallback: any coarser cascade that contains p
    for (let k = (sel[sel.length - 1]?.index ?? -1) + 1; k < cascades.length; k++) {
      const q = queryCascade({ worldPos, normal, cascade: cascades[k], baseCell: baseCells[k], irradianceAtlas, depthAtlas, irradianceRes, depthRes });
      if (q.weight > 0) return q.value;
    }
    return [0, 0, 0];
  }
  return scale3(total, 1 / wTot);
}

// ---- AMBIENT-REPLACE (docs/GI-AMBIENT.md): GI substitutes the hemi sky ambient where it has coverage. CPU mirror of gi-open-nodes queryCascadesCoverageTSL / hemiIrradianceTSL / ambientReplaceTSL.
export const COVERAGE_WEIGHT_EPS = 1e-6;   // cascade 'usable' gate (unchanged from the pre-coverage hard gate)
export const COVERAGE_WEIGHT_FADE = 1e-3;  // coverage ramps in smoothly over weightSum in [EPS .. FADE]
const smoothC = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
/** coverage c in [0,1]: max over cascades of usable(k) * smooth(weightSum/FADE) * (coarsest: smooth(borderCells/blendCells) else 1). weights[k] = that cascade's weightSum at worldPos */
export function referenceCoverage({ cascades, baseCells, worldPos, weights, blendCells = CASCADE_DEFAULTS.blendCells }) {
  const n = cascades.length; let c = 0;
  for (let k = 0; k < n; k++) {
    if (!cascadeContains(cascades[k], baseCells[k], worldPos) || !(weights[k] > COVERAGE_WEIGHT_EPS)) continue;
    const edge = k === n - 1 ? smoothC(borderDistanceCells(cascades[k], baseCells[k], worldPos) / blendCells) : 1;
    c = Math.max(c, smoothC(weights[k] / COVERAGE_WEIGHT_FADE) * edge);
  }
  return c;
}
/** three r180 HemisphereLightNode: mix(ground, sky, 0.5*n.y+0.5); sky/ground already x intensity */
export function hemiIrradiance(normal, sky, ground) {
  const w = normal[1] * 0.5 + 0.5; return [0, 1, 2].map((i) => ground[i] + (sky[i] - ground[i]) * w);
}
/** 'replace' term added next to the hemi light's own contribution: c*(gi - hemi(n)) -> net = mix(hemi, gi, c) */
export function ambientReplace(gi, coverage, normal, sky, ground) {
  const h = hemiIrradiance(normal, sky, ground); return [0, 1, 2].map((i) => coverage * (gi[i] - h[i]));
}
/** GI open-sky irradiance for an unoccluded normal: E(n) = integral over the sphere of skyRadiance(dir) * max(0, dot(n,dir)) (what an unobstructed probe converges to; midpoint quadrature) */
export function skyIrradiance(normal, sky, nTheta = 400, nPhi = 64) {
  const E = [0, 0, 0];
  for (let i = 0; i < nTheta; i++) {
    const th = ((i + 0.5) / nTheta) * Math.PI; const dy = Math.cos(th); const sr = Math.sin(th);
    for (let j = 0; j < nPhi; j++) {
      const ph = ((j + 0.5) / nPhi) * 2 * Math.PI; const d = [sr * Math.cos(ph), dy, sr * Math.sin(ph)];
      const cs = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]; if (cs <= 0) continue;
      const r = skyRadiance(d, sky); const w = cs * sr * (Math.PI / nTheta) * ((2 * Math.PI) / nPhi);
      E[0] += r[0] * w; E[1] += r[1] * w; E[2] += r[2] * w;
    }
  }
  return E;
}
