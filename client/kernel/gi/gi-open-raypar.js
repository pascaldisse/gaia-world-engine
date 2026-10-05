// v2 open-world RAY-PARALLEL GI kernels (docs/GI-RAYPAR.md). DDGI-standard 2-pass replacing gi-open-nodes' per-TEXEL full-ray loops:
//   pass 1 TRACE : one thread per (probe, ray) → ray buffer vec4(radiance.rgb, hitT)   [probes × rays, indexed by BATCH ordinal]
//   pass 2 BLEND : irradiance kernel (per texel) + depth kernel (per texel) sum the ray buffer — same weights/hysteresis as the old kernels
// Old path (rayParallel:false) untouched in gi-open-nodes.js. One march serves BOTH atlases (old: depth kernel re-marched everything).
// Ray buffer w channel: ≥0 hit distance, -1 miss, DISABLED_HIT (-2) = probe disabled (written by the trace pass, ray 0 is the flag).
// Hazard rules as gi-open-nodes: unique Loop names per kernel, no Break(), loop-carried vars .toVar()+assign reset, validCount guard on every body.
import { Fn, uniform, vec2, vec3, vec4, float, int, uint, Loop, If, dot, max, abs, select, mix, clamp, normalize, instanceIndex } from 'three/tsl';
import { instancedArray } from 'three/tsl';
import { FIB_PHI } from './gi-nodes.js';
import { decodeOct } from './octahedral.js';
import {
  marchVoxelsTSL, voxelNormalTSL, unpackAlbedoTSL, readVoxelAtWorldTSL, skyRadianceTSL, queryCascadesTSL, resolveProbeTSL,
  probeWorldPos, batchProbeIndex, fibonacciDirTSL, decodeOctTSL, luma,
} from './gi-open-nodes.js';
const RECIP_PI = 1 / Math.PI;
export const DISABLED_HIT = -2;
/** storage accounting mirrored by test/gi-open-raypar.test.js's source scan */
export const countRayTraceKernelBuffers = () => 4; // rayBuf, irradiance, depth (bounce query), voxels
export const countRayIrradianceBlendBuffers = ({ touched = false } = {}) => 3 + (touched ? 1 : 0); // rayBuf, irradiance, depth (fresh sentinel) (+touched)
export const countRayDepthBlendBuffers = () => 2; // rayBuf, depth

// ------------------------------------------------------------------ pure JS layout + blend math (unit-tested; GPU graph below is its structural twin)
/** ray buffer slot (in vec4s) of ray `rayI` of the probe at BATCH ordinal `probeLocal` */
export const rayBufferIndex = (probeLocal, rayI, raysPerProbe) => probeLocal * raysPerProbe + rayI;
export const rayBufferLength = (maxProbes, raysPerProbe) => maxProbes * raysPerProbe;
/** mirror of fibonacciDirTSL */
export function fibDirJS(i, n) {
  const y = 1 - (i / Math.max(n - 1, 1)) * 2; const rad = Math.sqrt(Math.min(1, Math.max(0, 1 - y * y))); const th = i * FIB_PHI;
  return [Math.cos(th) * rad, y, Math.sin(th) * rad];
}
const texelOctDir = (t, res) => decodeOct([((t % res) + 0.5) / res * 2 - 1, (Math.floor(t / res) + 0.5) / res * 2 - 1]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** irradiance estimate of ONE atlas texel from a probe's ray buffer slice (Float32Array-like, vec4/ray). Mirrors the blend kernel's loop. */
export function blendIrradianceTexelJS(ray, probeLocal, raysPerProbe, texelDir) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < raysPerProbe; i++) {
    const o = rayBufferIndex(probeLocal, i, raysPerProbe) * 4; const w = Math.max(0, dot3(texelDir, fibDirJS(i, raysPerProbe)));
    r += ray[o] * w; g += ray[o + 1] * w; b += ray[o + 2] * w;
  }
  const k = (4 * Math.PI) / raysPerProbe; return [r * k, g * k, b * k];
}
/** (mean, mean2) depth moments of ONE depth texel; miss (hitT<0) → maxDist. Mirrors the depth blend kernel. */
export function blendDepthTexelJS(ray, probeLocal, raysPerProbe, texelDir, maxDist) {
  let wS = 0, dS = 0, d2S = 0;
  for (let i = 0; i < raysPerProbe; i++) {
    const o = rayBufferIndex(probeLocal, i, raysPerProbe) * 4; const hitT = ray[o + 3]; const dist = hitT >= 0 ? hitT : maxDist;
    const w = Math.max(0, dot3(texelDir, fibDirJS(i, raysPerProbe)));
    wS += w; dS += w * dist; d2S += w * dist * dist;
  }
  const sw = Math.max(wS, 1e-5); return [dS / sw, d2S / sw];
}
export const probeDisabledJS = (ray, probeLocal, raysPerProbe) => ray[rayBufferIndex(probeLocal, 0, raysPerProbe) * 4 + 3] < DISABLED_HIT + 0.5;
export { texelOctDir };

// ------------------------------------------------------------------ ray buffer
export function createRayBuffer({ maxProbes, raysPerProbe }) { return instancedArray(rayBufferLength(maxProbes, raysPerProbe), 'vec4'); }

// ------------------------------------------------------------------ pass 1: trace
export function createOpenTraceKernel({ atlases, vs, cascades, baseCellU, batch, sun, sky, raysPerProbe, maxDist, relocateMax, blendCells, rayBuf }) {
  const { irradiance, depth } = atlases; void irradiance; void depth; // bounce query reads both atlases inside queryCascadesTSL
  const totalDefault = atlases.probeCount * raysPerProbe; const validCount = uniform(totalDefault, 'uint');
  const bounceScale = uniform(1);
  const fn = Fn(() => {
    const threadIndex = instanceIndex;
    If(uint(threadIndex).lessThan(validCount), () => {
      const probeLocal = int(threadIndex).div(int(raysPerProbe)); const rayI = int(threadIndex).mod(int(raysPerProbe));
      const probeIdx = batchProbeIndex(cascades, batch, probeLocal).toVar();
      const probePos0 = probeWorldPos(cascades, baseCellU, probeIdx).toVar();
      const st = resolveProbeTSL(vs, probePos0, relocateMax);
      const probePos = st.pos.toVar(); const disabled = st.disabled.toVar();
      const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();
      const hitT = marchVoxelsTSL(vs, probePos, dir, maxDist, 'stepI', disabled.not());
      const hit = hitT.greaterThanEqual(0).toVar();
      const hitPos = probePos.add(dir.mul(max(hitT, 0))).toVar();
      const N = voxelNormalTSL(vs, hitPos, dir).toVar();
      const albedo = unpackAlbedoTSL(readVoxelAtWorldTSL(vs, hitPos));
      const outPos = hitPos.add(N.mul(vs.cellSize * 1.01)).toVar();
      const L = normalize(sun.direction.negate()); const ndotl = max(0, dot(N, L));
      const sunT = marchVoxelsTSL(vs, outPos, L, maxDist, 'shadowStepI', hit.and(ndotl.greaterThan(0)));
      const sunE = select(hit.and(ndotl.greaterThan(0)).and(sunT.lessThan(0)), sun.color.mul(ndotl).mul(sun.intensity), vec3(0, 0, 0));
      const bounce = vec3(0, 0, 0).toVar(); bounce.assign(vec3(0, 0, 0));
      If(hit, () => { bounce.assign(queryCascadesTSL({ atlases, cascades, baseCellU, worldPos: outPos, normal: N, blendCells, tag: 'b' }).mul(bounceScale)); });
      const radiance = select(hit, albedo.mul(sunE.add(bounce)).mul(RECIP_PI), skyRadianceTSL(dir, sky));
      rayBuf.element(probeLocal.mul(int(raysPerProbe)).add(rayI)).assign(select(disabled, vec4(0, 0, 0, DISABLED_HIT), vec4(radiance, hitT)));
    });
  });
  return { kernel: fn().compute(totalDefault, [64]), bounceScale, validCount, totalThreads: totalDefault };
}

// ------------------------------------------------------------------ pass 2a: irradiance blend (per texel)
export function createOpenIrradianceBlendKernel({ atlases, cascades, batch, raysPerProbe, hysteresis, adaptive, rayBuf, bounceScale, touched = null }) {
  const { irradiance, depth, irradianceRes } = atlases;
  const alpha = uniform(hysteresis?.irradianceAlpha ?? 0.97);
  const totalDefault = atlases.probeCount * irradianceRes * irradianceRes; const validCount = uniform(totalDefault, 'uint');
  const fastAlpha = float(adaptive.fast), thr = float(adaptive.threshold);
  const fn = Fn(() => {
    const texelIndex = instanceIndex;
    If(uint(texelIndex).lessThan(validCount), () => {
      const tpp = int(irradianceRes * irradianceRes);
      const probeLocal = int(texelIndex).div(tpp); const localTexel = int(texelIndex).mod(tpp);
      const probeIdx = batchProbeIndex(cascades, batch, probeLocal).toVar();
      const atlasIndex = probeIdx.mul(tpp).add(localTexel);
      const octu = float(localTexel.mod(int(irradianceRes))).add(0.5).div(irradianceRes).mul(2).sub(1);
      const octv = float(localTexel.div(int(irradianceRes))).add(0.5).div(irradianceRes).mul(2).sub(1);
      const texelDir = decodeOctTSL(vec2(octu, octv));
      const rayBase = probeLocal.mul(int(raysPerProbe));
      const disabled = rayBuf.element(rayBase).w.lessThan(float(DISABLED_HIT + 0.5)).toVar();
      const sampleEstimate = vec3(0, 0, 0).toVar();
      Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }, ({ rayI }) => {
        const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();
        const radiance = rayBuf.element(rayBase.add(rayI)).xyz;
        sampleEstimate.assign(sampleEstimate.add(radiance.mul(max(0, dot(texelDir, dir)))));
      });
      const newEstimate = sampleEstimate.mul(float((4 * Math.PI) / raysPerProbe));
      const old = irradiance.element(atlasIndex);
      const rel = abs(luma(newEstimate).sub(luma(old))).div(max(luma(newEstimate), luma(old)).add(1e-3));
      const freshProbe = depth.element(probeIdx.mul(int(atlases.depthRes * atlases.depthRes))).x.lessThan(0); // depth sentinel (-1)
      const aEff = select(freshProbe, float(0), mix(alpha, fastAlpha, clamp(rel.div(thr), 0, 1)));
      irradiance.element(atlasIndex).assign(select(disabled, vec3(0, 0, 0), mix(newEstimate, old, aEff)));
      if (touched) touched.element(probeIdx).assign(uint(1));
    });
  });
  return { kernel: fn().compute(totalDefault, [64]), alpha, bounceScale, validCount, totalTexels: totalDefault };
}

// ------------------------------------------------------------------ pass 2b: depth blend (per texel)
export function createOpenDepthBlendKernel({ atlases, cascades, batch, raysPerProbe, maxDist, hysteresis, rayBuf }) {
  const { depth, depthRes } = atlases;
  const alpha = uniform(hysteresis?.depthAlpha ?? 0.9);
  const totalDefault = atlases.probeCount * depthRes * depthRes; const validCount = uniform(totalDefault, 'uint');
  const fn = Fn(() => {
    const texelIndex = instanceIndex;
    If(uint(texelIndex).lessThan(validCount), () => {
      const tpp = int(depthRes * depthRes);
      const probeLocal = int(texelIndex).div(tpp); const localTexel = int(texelIndex).mod(tpp);
      const probeIdx = batchProbeIndex(cascades, batch, probeLocal).toVar();
      const atlasIndex = probeIdx.mul(tpp).add(localTexel);
      const octu = float(localTexel.mod(int(depthRes))).add(0.5).div(depthRes).mul(2).sub(1);
      const octv = float(localTexel.div(int(depthRes))).add(0.5).div(depthRes).mul(2).sub(1);
      const texelDir = decodeOctTSL(vec2(octu, octv));
      const rayBase = probeLocal.mul(int(raysPerProbe));
      const disabled = rayBuf.element(rayBase).w.lessThan(float(DISABLED_HIT + 0.5)).toVar();
      const wSum = float(0).toVar(), dSum = float(0).toVar(), d2Sum = float(0).toVar();
      Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }, ({ rayI }) => {
        const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();
        const hitT = rayBuf.element(rayBase.add(rayI)).w;
        const dist = select(hitT.greaterThanEqual(0), hitT, float(maxDist));
        const w = max(0, dot(texelDir, dir));
        wSum.assign(wSum.add(w)); dSum.assign(dSum.add(w.mul(dist))); d2Sum.assign(d2Sum.add(w.mul(dist).mul(dist)));
      });
      const sw = max(wSum, 1e-5); const fresh = vec2(dSum.div(sw), d2Sum.div(sw));
      const old = depth.element(atlasIndex);
      const blended = select(old.x.lessThan(0), fresh, mix(fresh, old, alpha));
      depth.element(atlasIndex).assign(select(disabled, vec2(-1, -1), blended));
    });
  });
  return { kernel: fn().compute(totalDefault, [64]), alpha, validCount, totalTexels: totalDefault };
}

/** all three kernels sharing one ray buffer + one bounceScale uniform */
export function createRayParallelKernels({ atlases, vs, cascades, baseCellU, batch, sun, sky, raysPerProbe, maxDist, hysteresis, relocateMax, adaptive, blendCells, touched = null }) {
  const rayBuf = createRayBuffer({ maxProbes: atlases.probeCount, raysPerProbe });
  const trace = createOpenTraceKernel({ atlases, vs, cascades, baseCellU, batch, sun, sky, raysPerProbe, maxDist, relocateMax, blendCells, rayBuf });
  const irr = createOpenIrradianceBlendKernel({ atlases, cascades, batch, raysPerProbe, hysteresis, adaptive, rayBuf, bounceScale: trace.bounceScale, touched });
  const dep = createOpenDepthBlendKernel({ atlases, cascades, batch, raysPerProbe, maxDist, hysteresis, rayBuf });
  return { rayBuf, trace, irr, dep };
}
