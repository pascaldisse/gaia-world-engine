// TSL/WebGPU graph construction for probe GI (§GI-PROBES.md). Structurally
// mirrors gi-reference.js (the CPU ground truth) op-by-op: occupancy storage
// + fixed-step DDA march, spherical-Fibonacci ray gen + per-frame rotation,
// sun N.L + shadow march + point lights + single-nearest-probe bounce +
// albedo tint on hit / sky color on miss, hysteresis-blended atlas write,
// and a real trilinear + Chebyshev + octahedral-texel probe query.
//
// node --test builds this graph with no GPU device present (three r180,
// real objects) — proves the graph is well-formed and structurally mirrors
// the reference (test/gi-nodes-parity.test.js walks it), NOT that it
// executes correctly on a real frame (see docs UNVERIFIED). Only ever
// called when gi.enabled === true (gi-controller.js gate).

import {
  Fn, storage, instancedArray, uniform, vec2, vec3, float, int, uint,
  Loop, If, Break, dot, max, normalize, mix, clamp, abs, select,
  floor, length, instanceIndex,
} from 'three/tsl';
import { IrradianceNode, StorageInstancedBufferAttribute } from 'three/webgpu';

// ---- shared constants, mirrored 1:1 from irradiance.js / voxelize.js ----
// exported so test/gi-nodes-parity.test.js can assert numeric parity
// against irradiance.js's own fibonacciSphereDirs formula without a GPU
export const FIB_PHI = Math.PI * (3 - Math.sqrt(5)); // golden angle, irradiance.js fibonacciSphereDirs
export const MAX_MARCH_STEPS = 64; // PLACEHOLDER bound for the fixed-step DDA Loop (needs a compile-time count)

/**
 * Upload a CPU-voxelized occupancy grid (voxelize.js output) as a real GPU
 * storage buffer, packaged with the grid metadata every march/query call
 * needs (dims stay plain JS numbers — static, baked into the kernel at
 * construction; voxelOrigin is wrapped as a uniform so the grid can
 * recenter without a kernel rebuild).
 */
export function createOccupancyStorage(occupancyUint8Array, dims, voxelOrigin, cellSize) {
  const count = dims.x * dims.y * dims.z;
  const arr = new Uint32Array(count);
  for (let i = 0; i < count; i++) arr[i] = occupancyUint8Array[i] ? 1 : 0;
  const attr = new StorageInstancedBufferAttribute(arr, 1);
  const occupancy = storage(attr, 'uint', count);
  return { occupancy, dims, voxelOrigin: uniform(vec3(...voxelOrigin)), cellSize, count };
}

export function createProbeAtlases({ probeCount, irradianceRes = 8, depthRes = 16 }) {
  const irradianceTexelsPerProbe = irradianceRes * irradianceRes;
  const depthTexelsPerProbe = depthRes * depthRes;
  const irradiance = instancedArray(probeCount * irradianceTexelsPerProbe, 'vec3');
  const depth = instancedArray(probeCount * depthTexelsPerProbe, 'vec2'); // (mean, mean2)
  return { irradiance, depth, irradianceRes, depthRes, probeCount };
}

/** Fixed-size point-light pool (§GI-PROBES.md Fallbacks: sun + pooled point lights feed probes). */
export function createPointLightPool(maxLights = 16) {
  const positions = instancedArray(maxLights, 'vec3');
  const colors = instancedArray(maxLights, 'vec3');
  const intensities = instancedArray(maxLights, 'float');
  const count = uniform(0, 'uint');
  const lightScale = uniform(1);
  return { positions, colors, intensities, count, lightScale, maxLights };
}

// ---- TSL helpers mirroring octahedral.js / gi-reference.js exactly ----

function signNotZeroTSL(v) {
  return select(v.lessThan(0), float(-1), float(1));
}

/** encodeOct: unit dir -> [-1,1]^2 (octahedral.js, signed-octahedron). */
function encodeOctTSL(dir) {
  const l1 = abs(dir.x).add(abs(dir.y)).add(abs(dir.z));
  const inv = float(1).div(max(l1, 1e-8));
  const u0 = dir.x.mul(inv);
  const v0 = dir.y.mul(inv);
  const folded = dir.z.lessThan(0);
  const ou = float(1).sub(abs(v0)).mul(signNotZeroTSL(u0));
  const ov = float(1).sub(abs(u0)).mul(signNotZeroTSL(v0));
  return vec2(select(folded, ou, u0), select(folded, ov, v0));
}

/** octUvToTexelIndex: [-1,1]^2 -> nearest flat texel index (gi-reference.js). */
function octUvToTexelIndexTSL(uv, res) {
  const tu = clamp(int(floor(uv.x.add(1).div(2).mul(res))), int(0), int(res - 1));
  const tv = clamp(int(floor(uv.y.add(1).div(2).mul(res))), int(0), int(res - 1));
  return tu.add(int(res).mul(tv));
}

/** worldToVoxelIndex: world pos -> flat occupancy index, clamped (voxelize.js layout). */
function worldToVoxelIndexTSL(p, voxelOrigin, cellSize, dims) {
  const rel = p.sub(voxelOrigin).div(cellSize);
  const ix = clamp(int(floor(rel.x)), int(0), int(dims.x - 1));
  const iy = clamp(int(floor(rel.y)), int(0), int(dims.y - 1));
  const iz = clamp(int(floor(rel.z)), int(0), int(dims.z - 1));
  return ix.add(int(dims.x).mul(iy.add(int(dims.y).mul(iz))));
}

/**
 * Fixed-step DDA march against the occupancy storage buffer — the exact
 * mirror of voxelize.js's marchOccupancy (step=cellSize*0.5, bounded loop).
 * Pushes Loop/If/Break onto whichever Fn body is currently building (not
 * wrapped in its own Fn(), so it composes inline in either kernel below).
 * @returns a float Var: hit distance, or -1 if nothing was hit
 */
function marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist) {
  const { occupancy, dims, voxelOrigin, cellSize } = occ;
  const step = float(cellSize * 0.5);
  const t = float(0).toVar();
  const hitT = float(-1).toVar();
  Loop(MAX_MARCH_STEPS, () => {
    If(t.greaterThanEqual(maxDist).or(hitT.greaterThanEqual(0)), () => {
      Break();
    });
    const p = rayOrigin.add(rayDir.mul(t));
    const idx = worldToVoxelIndexTSL(p, voxelOrigin, cellSize, dims);
    const occVal = occupancy.element(idx);
    If(occVal.greaterThan(uint(0)), () => {
      hitT.assign(t);
    });
    t.addAssign(step);
  });
  return hitT;
}

/** spherical-Fibonacci ray direction #i of N, rotated (irradiance.js: fibonacciSphereDirs). */
function fibonacciDirTSL(i, rayCount, rotation) {
  const fi = float(i);
  const y = float(1).sub(fi.div(max(float(rayCount - 1), 1)).mul(2));
  const rad = clamp(float(1).sub(y.mul(y)), 0, 1).sqrt();
  const theta = fi.mul(FIB_PHI);
  const x = theta.cos().mul(rad);
  const z = theta.sin().mul(rad);
  const dir = vec3(x, y, z);
  return rotation ? rotation.mul(dir) : dir;
}

/**
 * Trace one ray from `origin` and shade its hit (§GI-PROBES.md
 * Representation + gi-reference.js traceProbeRays, mirrored op-by-op):
 * sun N.L + shadow march (biased one march-step along L, same fix as the
 * CPU reference's self-shadow bug), pooled point lights, single
 * nearest-probe-nearest-texel bounce read (PLACEHOLDER simplification of
 * the CPU reference's full trilinear bounce query — cost, see docs), flat
 * PLACEHOLDER albedo tint (no per-voxel color storage on the GPU side in
 * v0, unlike the CPU reference's optional surfaceAlbedoColor — documented
 * scope cut, see docs UNVERIFIED), miss = sky color.
 * @returns {radiance: vec3 node, dist: float node}
 */
function traceAndShadeRayTSL({ occ, rayOrigin, rayDir, maxDist, sun, lights, albedo, skyColor, bounceAtlas, bounceGrid }) {
  const hitT = marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist);
  const hit = hitT.greaterThanEqual(0);
  const hitPos = rayOrigin.add(rayDir.mul(max(hitT, 0)));
  const N = rayDir.negate();
  const shadowStep = float(occ.cellSize * 0.5);

  const direct = vec3(0, 0, 0).toVar();
  if (sun) {
    const L = normalize(sun.direction.negate());
    const ndotl = max(0, dot(N, L));
    const shadowOrigin = hitPos.add(L.mul(shadowStep));
    const shadowT = marchOccupancyTSL(occ, shadowOrigin, L, maxDist);
    const lit = shadowT.lessThan(0);
    direct.assign(direct.add(select(lit.and(ndotl.greaterThan(0)), sun.color.mul(ndotl).mul(sun.intensity), vec3(0, 0, 0))));
  }
  if (lights) {
    Loop(lights.maxLights, ({ i }) => {
      If(uint(i).greaterThanEqual(lights.count), () => { Break(); });
      const lpos = lights.positions.element(i);
      const toLight = lpos.sub(hitPos);
      const dist = length(toLight);
      const Ldir = toLight.div(max(dist, 1e-4));
      const ndotl = max(0, dot(N, Ldir));
      const atten = float(1).div(max(dist.mul(dist), 1e-4));
      const shadowOrigin = hitPos.add(Ldir.mul(shadowStep));
      const shadowT = marchOccupancyTSL(occ, shadowOrigin, Ldir, dist);
      const lit = shadowT.lessThan(0);
      const intensity = lights.intensities.element(i).mul(lights.lightScale);
      const contrib = lights.colors.element(i).mul(ndotl).mul(atten).mul(intensity);
      direct.assign(direct.add(select(lit, contrib, vec3(0, 0, 0))));
    });
  }

  // single nearest-probe, nearest-texel bounce read (PLACEHOLDER — see docs)
  let bounce = vec3(0, 0, 0);
  if (bounceAtlas && bounceGrid) {
    const rel = hitPos.sub(bounceGrid.origin).div(bounceGrid.spacing);
    const ix = clamp(int(floor(rel.x.add(0.5))), int(0), int(bounceGrid.dims.x - 1));
    const iy = clamp(int(floor(rel.y.add(0.5))), int(0), int(bounceGrid.dims.y - 1));
    const iz = clamp(int(floor(rel.z.add(0.5))), int(0), int(bounceGrid.dims.z - 1));
    const pIdx = ix.add(int(bounceGrid.dims.x).mul(iy.add(int(bounceGrid.dims.y).mul(iz))));
    const uv = encodeOctTSL(N);
    const texel = octUvToTexelIndexTSL(uv, bounceAtlas.irradianceRes);
    bounce = bounceAtlas.irradiance.element(pIdx.mul(bounceAtlas.irradianceRes * bounceAtlas.irradianceRes).add(texel));
  }

  const incident = direct.add(bounce);
  const tint = vec3(albedo, albedo, albedo);
  const radiance = select(hit, tint.mul(incident), skyColor);
  const dist = select(hit, hitT, float(maxDist));
  return { radiance, dist };
}

/**
 * Probe-update compute kernel: one GPU thread per (probe, irradiance
 * texel). Each thread regenerates and re-shades its probe's full
 * `raysPerProbe` ray set (PLACEHOLDER — texel-parallel recompute instead of
 * ray-parallel-then-scatter, correctness-first for v0; see docs) and
 * accumulates the cos-weighted Monte-Carlo irradiance estimate
 * (irradiance.js integrateProbeIrradiance, mirrored) before hysteresis
 * blending into the atlas.
 */
export function createGIUpdateKernel({ atlases, occ, probeGrid, raysPerProbe, sun, lights, hysteresis, albedo = 0.5, skyColor = [0.4, 0.5, 0.7], maxDist = 64, rotation = null, bounceAtlas = null, bounceGrid = null }) {
  const { irradiance, irradianceRes } = atlases;
  const alpha = uniform(hysteresis?.irradianceAlpha ?? 0.97);
  const probeOffset = uniform(0, 'uint');
  const skyColorU = uniform(vec3(...skyColor));

  const updateFn = Fn(() => {
    const texelIndex = instanceIndex;
    const texelsPerProbe = int(irradianceRes * irradianceRes);
    const probeLocal = int(texelIndex).div(texelsPerProbe);
    const localTexel = int(texelIndex).mod(texelsPerProbe);
    const probeIdx = probeOffset.add(uint(probeLocal));

    const tu = localTexel.mod(int(irradianceRes));
    const tv = localTexel.div(int(irradianceRes));
    const octu = float(tu).add(0.5).div(irradianceRes).mul(2).sub(1);
    const octv = float(tv).add(0.5).div(irradianceRes).mul(2).sub(1);
    const texelDir = decodeOctTSL(vec2(octu, octv));

    const ix = int(probeIdx).mod(int(probeGrid.dims.x));
    const iy = int(probeIdx).div(int(probeGrid.dims.x)).mod(int(probeGrid.dims.y));
    const iz = int(probeIdx).div(int(probeGrid.dims.x * probeGrid.dims.y));
    const probePos = vec3(
      probeGrid.origin.x.add(float(ix).mul(probeGrid.spacing)),
      probeGrid.origin.y.add(float(iy).mul(probeGrid.spacing)),
      probeGrid.origin.z.add(float(iz).mul(probeGrid.spacing)),
    );

    const sampleEstimate = vec3(0, 0, 0).toVar();
    Loop(raysPerProbe, ({ i }) => {
      const dir = fibonacciDirTSL(i, raysPerProbe, rotation);
      const { radiance } = traceAndShadeRayTSL({
        occ, rayOrigin: probePos, rayDir: dir, maxDist,
        sun, lights, albedo, skyColor: skyColorU, bounceAtlas, bounceGrid,
      });
      const w = max(0, dot(texelDir, dir));
      sampleEstimate.assign(sampleEstimate.add(radiance.mul(w)));
    });
    const mcNorm = float((4 * Math.PI) / raysPerProbe);
    const newEstimate = sampleEstimate.mul(mcNorm);

    const old = irradiance.element(texelIndex);
    irradiance.element(texelIndex).assign(mix(newEstimate, old, alpha));
  });

  const totalTexels = atlases.probeCount * irradianceRes * irradianceRes;
  const kernel = updateFn().compute(totalTexels, [64]);
  return { kernel, alpha, probeOffset, totalTexels };
}

/** decodeOct: [-1,1]^2 -> unit dir (octahedral.js, mirrored). */
function decodeOctTSL(uv) {
  const x0 = uv.x;
  const y0 = uv.y;
  const z0 = float(1).sub(abs(uv.x)).sub(abs(uv.y));
  const folded = z0.lessThan(0);
  const ox = float(1).sub(abs(y0)).mul(signNotZeroTSL(x0));
  const oy = float(1).sub(abs(x0)).mul(signNotZeroTSL(y0));
  const x = select(folded, ox, x0);
  const y = select(folded, oy, y0);
  return normalize(vec3(x, y, z0));
}

/**
 * Probe-depth-atlas update kernel — same ray trace+shade as the irradiance
 * kernel (shares traceAndShadeRayTSL), one thread per depth texel,
 * accumulating the weighted-average distance + distance^2 moments
 * (gi-reference.js's depth-texel loop, mirrored).
 */
export function createGIDepthUpdateKernel({ atlases, occ, probeGrid, raysPerProbe, sun, lights, hysteresis, albedo = 0.5, skyColor = [0.4, 0.5, 0.7], maxDist = 64, rotation = null }) {
  const { depth, depthRes } = atlases;
  const alpha = uniform(hysteresis?.depthAlpha ?? 0.9);
  const probeOffset = uniform(0, 'uint');
  const skyColorU = uniform(vec3(...skyColor));

  const updateFn = Fn(() => {
    const texelIndex = instanceIndex;
    const texelsPerProbe = int(depthRes * depthRes);
    const probeLocal = int(texelIndex).div(texelsPerProbe);
    const localTexel = int(texelIndex).mod(texelsPerProbe);
    const probeIdx = probeOffset.add(uint(probeLocal));

    const tu = localTexel.mod(int(depthRes));
    const tv = localTexel.div(int(depthRes));
    const octu = float(tu).add(0.5).div(depthRes).mul(2).sub(1);
    const octv = float(tv).add(0.5).div(depthRes).mul(2).sub(1);
    const texelDir = decodeOctTSL(vec2(octu, octv));

    const ix = int(probeIdx).mod(int(probeGrid.dims.x));
    const iy = int(probeIdx).div(int(probeGrid.dims.x)).mod(int(probeGrid.dims.y));
    const iz = int(probeIdx).div(int(probeGrid.dims.x * probeGrid.dims.y));
    const probePos = vec3(
      probeGrid.origin.x.add(float(ix).mul(probeGrid.spacing)),
      probeGrid.origin.y.add(float(iy).mul(probeGrid.spacing)),
      probeGrid.origin.z.add(float(iz).mul(probeGrid.spacing)),
    );

    const wSum = float(0).toVar();
    const dSum = float(0).toVar();
    const d2Sum = float(0).toVar();
    Loop(raysPerProbe, ({ i }) => {
      const dir = fibonacciDirTSL(i, raysPerProbe, rotation);
      const { dist } = traceAndShadeRayTSL({
        occ, rayOrigin: probePos, rayDir: dir, maxDist,
        sun, lights, albedo, skyColor: skyColorU,
      });
      const w = max(0, dot(texelDir, dir));
      wSum.assign(wSum.add(w));
      dSum.assign(dSum.add(w.mul(dist)));
      d2Sum.assign(d2Sum.add(w.mul(dist).mul(dist)));
    });
    const safeW = max(wSum, 1e-5);
    const newMean = dSum.div(safeW);
    const newMean2 = d2Sum.div(safeW);

    const old = depth.element(texelIndex);
    depth.element(texelIndex).assign(mix(vec2(newMean, newMean2), old, alpha));
  });

  const totalTexels = atlases.probeCount * depthRes * depthRes;
  const kernel = updateFn().compute(totalTexels, [64]);
  return { kernel, alpha, probeOffset, totalTexels };
}

/**
 * Trilinear + Chebyshev + octahedral-texel probe query (§GI-PROBES.md
 * Material sampling, mirrors gi-reference.js's referenceQueryIrradiance
 * exactly): real 8 enclosing corners from worldPos (base cell =
 * floor((p-origin)/spacing), clamped to dims, nested 2x2x2 nested Loop),
 * true trilinear weights, probeDir = normalize(probePos - p), octahedral
 * normal picks the irradiance texel, octahedral probe->point direction
 * picks the depth texel, Chebyshev visibility per corner.
 */
export function createGIQueryNode({ atlases, worldPositionNode, normalNode, probeGrid }) {
  const { irradiance, depth, irradianceRes, depthRes } = atlases;
  const { origin, spacing, dims } = probeGrid;

  return Fn(() => {
    const rel = worldPositionNode.sub(origin).div(spacing);
    const base = vec3(floor(rel.x), floor(rel.y), floor(rel.z));
    const frac = rel.sub(base);

    const total = vec3(0, 0, 0).toVar();
    const weightSum = float(0).toVar();

    Loop(2, ({ i: ox }) => {
      Loop(2, ({ i: oy }) => {
        Loop(2, ({ i: oz }) => {
          const ixf = clamp(base.x.add(float(ox)), 0, dims.x - 1);
          const iyf = clamp(base.y.add(float(oy)), 0, dims.y - 1);
          const izf = clamp(base.z.add(float(oz)), 0, dims.z - 1);
          const cornerWorld = origin.add(vec3(ixf, iyf, izf).mul(spacing));

          const wx = select(float(ox).greaterThan(0.5), frac.x, float(1).sub(frac.x));
          const wy = select(float(oy).greaterThan(0.5), frac.y, float(1).sub(frac.y));
          const wz = select(float(oz).greaterThan(0.5), frac.z, float(1).sub(frac.z));
          const trilW = wx.mul(wy).mul(wz);

          const toProbe = cornerWorld.sub(worldPositionNode);
          const testDist = length(toProbe);
          const nearZero = testDist.lessThan(1e-6);
          const probeDir = select(nearZero, normalNode, normalize(toProbe));
          const backface = select(nearZero, float(1), max(0, dot(normalNode, probeDir)));

          const pIdx = int(ixf).add(int(dims.x).mul(int(iyf).add(int(dims.y).mul(int(izf)))));

          const iuv = encodeOctTSL(normalNode);
          const iTexel = octUvToTexelIndexTSL(iuv, irradianceRes);
          const irr = irradiance.element(pIdx.mul(int(irradianceRes * irradianceRes)).add(iTexel));

          const dDirRaw = select(nearZero, normalNode, normalize(worldPositionNode.sub(cornerWorld)));
          const duv = encodeOctTSL(dDirRaw);
          const dTexel = octUvToTexelIndexTSL(duv, depthRes);
          const meanMean2 = depth.element(pIdx.mul(int(depthRes * depthRes)).add(dTexel));
          const meanD = meanMean2.x;
          const mean2D = meanMean2.y;
          const variance = max(mean2D.sub(meanD.mul(meanD)), 1e-4);
          const d = testDist.sub(meanD);
          const chebyshev = select(testDist.lessThanEqual(meanD), float(1), clamp(variance.div(variance.add(d.mul(d))), 0, 1));

          const w = trilW.mul(backface).mul(chebyshev);
          total.assign(total.add(irr.mul(w)));
          weightSum.assign(weightSum.add(w));
        });
      });
    });

    return total.div(max(weightSum, 1e-6));
  })();
}

/** Wrap gi-nodes.js's query node in three's own IrradianceNode so it flows
 *  into PhysicalLightingModel's indirectDiffuse for free (see docs). */
export function wrapAsIrradianceNode(giQueryNode) {
  return new IrradianceNode(giQueryNode);
}
