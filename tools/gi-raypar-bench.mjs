// Live-WebGPU A/B: legacy per-texel kernels (rayParallel:false) vs ray-parallel 2-pass (rayParallel:true). docs/GI-RAYPAR.md.
//  (1) PARITY: two GIControllers, same scene/camera/params, N updates, bounceScale 0 (race-free → deterministic) → max abs diff on irradiance + depth atlases.
//  (2) TIME: per-update wall time with queue sync each update (static scene: voxel CPU idle → GPU-bound), secs×reps per variant, interleaved; + timestamp-query compute ms when the adapter has it.
//  (3) 0 GPU errors via withGpuValidation.
import * as THREE from 'three/webgpu';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { withGpuValidation } from './gi-parity.mjs';
const layers = (axis, a0, a1, lo0, hi0, lo1, hi1) => { const t = []; for (let a = a0 + 0.5; a < a1; a += 1) {
  if (axis === 'y') t.push(lo0, a, lo1, hi0, a, lo1, hi0, a, hi1, lo0, a, lo1, hi0, a, hi1, lo0, a, hi1);
  if (axis === 'x') t.push(a, lo0, lo1, a, hi0, lo1, a, hi0, hi1, a, lo0, lo1, a, hi0, hi1, a, lo0, hi1); }
  return t; };
const SKY = { zenith: [0.3, 0.5, 1], horizon: [0.6, 0.7, 0.9], ground: [0.1, 0.1, 0.1] };
const mkCfg = (rayParallel, over = {}) => ({ enabled: true, mode: 'open', rayParallel, raysPerProbe: 32, bounceScale: 0, irradianceAlpha: 0.9, depthAlpha: 0.9, sky: SKY,
  sun: { direction: [1, -0.4, 0.2], color: [1, 1, 1], intensity: 3 }, voxel: { bricks: { x: 8, y: 4, z: 8 } },
  cascades: { count: 3, spacings: [2, 4, 8], dims: [{ x: 8, y: 4, z: 8 }, { x: 8, y: 4, z: 8 }, { x: 8, y: 4, z: 8 }], updateFractions: [1, 1, 1] }, ...over }); // 3×256 = 768 probes (BP ~896)
function build(renderer, rayParallel, over) {
  const gi = new GIController({ renderer, scene: new THREE.Scene() }); gi.configure(mkCfg(rayParallel, over));
  gi.addMesh('ground', { triangles: layers('y', 0, 2, 0, 64, 0, 64), color: [0.4, 0.4, 0.4] });
  gi.addMesh('redwall', { triangles: layers('x', 40, 42, 0, 12, 0, 64), color: [0.9, 0.05, 0.05] });
  gi.addMesh('roof', { triangles: layers('y', 8, 10, 0, 30, 0, 64), color: [0.4, 0.4, 0.4] });
  gi.addMesh('pillar', { triangles: layers('y', 3, 6, 18, 22, 18, 22), color: [0.8, 0.8, 0.2] });
  return gi;
}
const CAM = [32, 6, 32];
const read = async (renderer, a) => new Float32Array(await renderer.getArrayBufferAsync(a.value));
function diff(a, b) { let max = 0, sum = 0, nz = 0, maxAt = -1; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (!(d <= max)) { max = d; maxAt = i; } sum += d; if (a[i] !== 0) nz++; } return { maxAbs: max, meanAbs: sum / a.length, nonzero: nz, n: a.length, maxAt }; }
async function parity(renderer, over, frames) {
  const A = build(renderer, false, over), B = build(renderer, true, over);
  for (let i = 0; i < 40; i++) { A.update(0.016, CAM); B.update(0.016, CAM); } // settle bricks (16/frame)
  for (let i = 0; i < frames; i++) { A.update(0.016, CAM); B.update(0.016, CAM); }
  const [ia, ib, da, db] = await Promise.all([read(renderer, A.resources.open.atlases.irradiance), read(renderer, B.resources.open.atlases.irradiance), read(renderer, A.resources.open.atlases.depth), read(renderer, B.resources.open.atlases.depth)]);
  const r = { irradiance: diff(ia, ib), depth: diff(da, db), probes: A.resources.open.atlases.probeCount, rayParallelFlags: [A.resources.open.rayParallel, B.resources.open.rayParallel] };
  A.dispose?.(); B.dispose?.(); return r;
}
const sync = (device) => device.queue.onSubmittedWorkDone();
async function timeVariant(renderer, gi, secs) {
  const device = renderer.backend.device; const ts = []; let n = 0; const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) { const a = performance.now(); gi.update(0.016, CAM); await sync(device); ts.push(performance.now() - a); n++; }
  ts.sort((x, y) => x - y); const total = performance.now() - t0;
  return { updates: n, meanMs: total / n, medianMs: ts[Math.floor(ts.length / 2)], p95Ms: ts[Math.floor(ts.length * 0.95)] };
}
// GPU-side compute time via timestamp-query (own renderer: trackTimestamp). Per update: resolve compute timestamps -> info.compute.timestamp (ms, sum of that update's compute passes).
async function timeTs(frames = 40) {
  const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true }); await renderer.init();
  if (!renderer.backend.device.features.has('timestamp-query')) return { supported: false };
  const A = build(renderer, false), B = build(renderer, true);
  for (let i = 0; i < 60; i++) { A.update(0.016, CAM); B.update(0.016, CAM); }
  await renderer.resolveTimestampsAsync('compute');
  const sample = async (gi) => { const v = []; for (let i = 0; i < frames; i++) { gi.update(0.016, CAM); await renderer.resolveTimestampsAsync('compute'); v.push(renderer.info.compute.timestamp); } v.sort((a, b) => a - b); return { medianMs: v[v.length >> 1], minMs: v[0], maxMs: v[v.length - 1], meanMs: v.reduce((a, b) => a + b, 0) / v.length }; };
  const old = await sample(A), nw = await sample(B);
  return { supported: true, old, new: nw, speedupMedian: old.medianMs / nw.medianMs, speedupMean: old.meanMs / nw.meanMs };
}
export async function runRayparBench({ secs = 5, reps = 3, rendererFactory } = {}) {
  const hasTs = (() => { return true; })();
  const renderer = rendererFactory ? await rendererFactory() : new THREE.WebGPURenderer({ antialias: false }); void hasTs;
  await renderer.init?.();
  const out = { pass: true, parity: {}, timing: { secs, reps, runs: [] }, notes: [], tsSupported: !!renderer.backend?.device?.features?.has?.('timestamp-query') };
  const res = await withGpuValidation(renderer, async () => {
    out.parity.bounce0 = await parity(renderer, {}, 20);
    out.parity.bounce0_alpha0 = await parity(renderer, { irradianceAlpha: 0, depthAlpha: 0 }, 1);
    out.parity.bounce0_rays64 = await parity(renderer, { raysPerProbe: 64 }, 5);
    out.parity.bounce1_informational = await parity(renderer, { bounceScale: 1 }, 20); // legacy has intra-dispatch races under bounce → not a pass criterion
    const A = build(renderer, false), B = build(renderer, true);
    for (let i = 0; i < 40; i++) { A.update(0.016, CAM); B.update(0.016, CAM); }
    for (let i = 0; i < 20; i++) { A.update(0.016, CAM); B.update(0.016, CAM); } // warm (pipeline compile)
    await sync(renderer.backend.device);
    for (let r = 0; r < reps; r++) { const old = await timeVariant(renderer, A, secs); const nw = await timeVariant(renderer, B, secs); out.timing.runs.push({ rep: r, old, new: nw, speedupMean: old.meanMs / nw.meanMs, speedupMedian: old.medianMs / nw.medianMs }); }
    const m = (f) => out.timing.runs.reduce((s, x) => s + f(x), 0) / out.timing.runs.length;
    out.timing.summary = { oldMeanMs: m((x) => x.old.meanMs), newMeanMs: m((x) => x.new.meanMs), speedupMean: m((x) => x.old.meanMs) / m((x) => x.new.meanMs), speedupMedian: m((x) => x.old.medianMs) / m((x) => x.new.medianMs) };
    // batched: 30 updates queued per sync (pipelined GPU throughput)
    const bat = async (gi, k = 30, rounds = 5) => { const dev = renderer.backend.device; const v = []; for (let r = 0; r < rounds; r++) { const a = performance.now(); for (let i = 0; i < k; i++) gi.update(0.016, CAM); await sync(dev); v.push((performance.now() - a) / k); } v.sort((x, y) => x - y); return v[v.length >> 1]; };
    out.timing.batchedMedianMs = { old: await bat(A), new: await bat(B) }; out.timing.batchedMedianMs.speedup = out.timing.batchedMedianMs.old / out.timing.batchedMedianMs.new;
  });
  try { out.timing.timestampQuery = await timeTs(); } catch (e) { out.timing.timestampQuery = { error: String(e?.stack ?? e) }; }
  out.gpuErrors = res.errors ?? [];
  const p = out.parity;
  for (const k of ['bounce0', 'bounce0_alpha0', 'bounce0_rays64']) { p[k].pass = p[k].irradiance.maxAbs <= 1e-3 && p[k].depth.maxAbs <= 1e-3 && p[k].irradiance.nonzero > 100; if (!p[k].pass) out.pass = false; }
  if (out.gpuErrors.length) out.pass = false;
  if (res.thrown) { out.pass = false; out.thrown = String(res.thrown?.stack ?? res.thrown); }
  return out;
}
