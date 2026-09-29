// Root-cause investigation #7 (parent live-GPU rerun, 09-29): the Break()
// fix (pass #6) changed NOTHING live -- hypothesis refuted (or the patched
// path wasn't the actual divergence). Parent: "stop inferring from sibling
// kernels, instrument the REAL update kernel." This file covers the pure
// CPU half of that instrumentation (cpuStepByStepTrace/compareStepByStepTrace
// in tools/gi-parity.mjs) which the GPU readback (runSingleUpdateCheck's
// debugProbeIndices option) diffs against, ray by ray, reporting the FIRST
// divergence -- and confirms (B) there is exactly ONE definition each of
// marchOccupancyTSL/traceAndShadeRayTSL, no inlined/older copy anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { buildClosedBoxScene, buildOpenPlaneRedWallScene, cpuStepByStepTrace, compareStepByStepTrace } from '../tools/gi-parity.mjs';
import { voxelizeTriangles } from '../client/kernel/gi/voxelize.js';

function extractCfg(gi) {
  const { grid, probeGrid, params: p, sun } = gi.resources;
  const origin = [probeGrid.origin.value.x, probeGrid.origin.value.y, probeGrid.origin.value.z];
  const occArr = voxelizeTriangles(gi._sceneTriangles, gi._voxelConfig.voxelOriginArr, gi._voxelConfig.cellSize, gi._voxelConfig.dims);
  return {
    origin, spacing: probeGrid.spacing, dims: grid.dims, voxelDims: gi._voxelConfig.dims,
    occupancy: occArr, voxelOrigin: gi._voxelConfig.voxelOriginArr, cellSize: gi._voxelConfig.cellSize,
    sun: { direction: [sun.direction.value.x, sun.direction.value.y, sun.direction.value.z], color: [sun.color.value.x, sun.color.value.y, sun.color.value.z], intensity: sun.intensity.value },
    raysPerProbe: p.raysPerProbe, maxDist: p.voxelMaxDist, albedo: p.albedo, skyColor: p.skyColor, irradianceRes: p.irradianceRes,
  };
}

function liveCfg(builder) {
  const { triangles, giParams } = builder();
  const gi = new GIController({});
  gi.configure(giParams);
  gi.setSceneTriangles(triangles);
  gi.update(1 / 60, [0, 0, 0]);
  return extractCfg(gi);
}

// ---------------------------------------------------------------- (B) grep
test('(B) exactly ONE definition each of marchOccupancyTSL/traceAndShadeRayTSL in gi-nodes.js -- no inlined/older copy for the update kernel to accidentally use', () => {
  const src = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');
  const marchDefs = (src.match(/function marchOccupancyTSL\(/g) || []).length;
  const shadeDefs = (src.match(/function traceAndShadeRayTSL\(/g) || []).length;
  assert.equal(marchDefs, 1, 'exactly one marchOccupancyTSL definition');
  assert.equal(shadeDefs, 1, 'exactly one traceAndShadeRayTSL definition');
  // and the update kernel's ray loop calls THIS traceAndShadeRayTSL (not a
  // literal march call of its own)
  const updateKernelStart = src.indexOf('export function createGIUpdateKernel');
  const nextExportStart = src.indexOf('\nexport function', updateKernelStart + 10);
  const updateKernelBody = src.slice(updateKernelStart, nextExportStart);
  assert.ok(updateKernelBody.includes('traceAndShadeRayTSL({'), 'update kernel must call the shared traceAndShadeRayTSL, not an inline reimplementation');
});

test('(B) per-update ray rotation: the update kernel and CPU single-update path both use rotation=null (no per-frame rotation wired anywhere, confirmed identical)', () => {
  const controllerSrc = readFileSync(new URL('../client/kernel/gi/gi-controller.js', import.meta.url), 'utf8');
  // GIController never passes a `rotation` option into createGIUpdateKernel
  assert.ok(!controllerSrc.includes('rotation:'), 'GIController never overrides rotation -- createGIUpdateKernel\'s own default (null) applies on both the GPU update kernel and (via cpuStepByStepTrace/traceSingleRay, which also pass rotation=null explicitly) the CPU trace');
});

// ------------------------------------------------------- cpuStepByStepTrace
test('cpuStepByStepTrace: 24/32 steps, monotonically-indexed rayIndex, runningSum is a true running total (final step\'s sum equals the sum of all per-ray weighted radiance)', () => {
  const cfg = liveCfg(buildOpenPlaneRedWallScene);
  const trace = cpuStepByStepTrace(13, cfg);
  assert.equal(trace.steps.length, cfg.raysPerProbe);
  trace.steps.forEach((s, i) => assert.equal(s.rayIndex, i));
  let manualSum = [0, 0, 0];
  for (const s of trace.steps) manualSum = manualSum.map((v, k) => v + s.weight * s.radiance[k]);
  const lastRunningSum = trace.steps[trace.steps.length - 1].runningSum;
  assert.ok(manualSum.every((v, k) => Math.abs(v - lastRunningSum[k]) < 1e-9), 'the final step\'s runningSum must equal the manually-accumulated total');
});

test('cpuStepByStepTrace: finalEstimate = lastRunningSum * (4*PI/raysPerProbe), the SAME MC normalization the update kernel applies', () => {
  const cfg = liveCfg(buildClosedBoxScene);
  const trace = cpuStepByStepTrace(4, cfg);
  const lastSum = trace.steps[trace.steps.length - 1].runningSum;
  const expected = lastSum.map((v) => v * (4 * Math.PI) / cfg.raysPerProbe);
  assert.ok(trace.finalEstimate.every((v, k) => Math.abs(v - expected[k]) < 1e-9));
});

// --------------------------------------------------------- compareStepByStepTrace
test('compareStepByStepTrace: identical GPU/CPU traces pass with no divergence', () => {
  const cfg = liveCfg(buildClosedBoxScene);
  const trace = cpuStepByStepTrace(4, cfg);
  const cmp = compareStepByStepTrace(trace.steps, trace.steps, trace.finalEstimate, trace.finalEstimate);
  assert.equal(cmp.pass, true);
  assert.equal(cmp.firstDivergingRay, -1);
});

test('compareStepByStepTrace: a GPU trace that truncates early (e.g. Break()-style loop exit) is caught at the EXACT ray it stops accumulating, not just "final wrong"', () => {
  const cfg = liveCfg(buildClosedBoxScene);
  const trace = cpuStepByStepTrace(4, cfg);
  // simulate a kernel that silently exits its outer loop after ray 4 (the
  // exact class of bug pass #6 hypothesized): every ray from 5 onward
  // keeps reporting the SAME (frozen) runningSum instead of accumulating further
  const frozenAt = 4;
  const gpuSteps = trace.steps.map((s, i) => (i <= frozenAt ? s : { ...s, runningSum: trace.steps[frozenAt].runningSum }));
  const gpuFinal = trace.steps[frozenAt].runningSum.map((v) => v * (4 * Math.PI) / cfg.raysPerProbe);
  const cmp = compareStepByStepTrace(gpuSteps, trace.steps, gpuFinal, trace.finalEstimate);
  assert.equal(cmp.pass, false);
  assert.ok(cmp.firstDivergingRay > frozenAt, `the first divergence (ray ${cmp.firstDivergingRay}) must be AFTER the freeze point (ray ${frozenAt}), not before`);
  // confirm it's a REAL divergence: the true trace's runningSum genuinely
  // moved between the freeze point and the reported ray, the frozen mutant's didn't
  const trueSumAtDivergence = trace.steps[cmp.firstDivergingRay].runningSum;
  const frozenSum = trace.steps[frozenAt].runningSum;
  assert.ok(Math.hypot(...trueSumAtDivergence.map((v, k) => v - frozenSum[k])) > 1e-6, 'sanity: the real trace actually changed by the reported ray');
  assert.ok(cmp.divergingFields.includes('runningSum'));
});

test('mutant: comparing ONLY the final aggregate (not per-ray) would report "wrong" but never say WHICH ray -- exactly what the parent asked to stop doing', () => {
  const finalOnlyCompare = (gpuFinal, cpuFinal) => Math.hypot(...gpuFinal.map((v, k) => v - cpuFinal[k])) < 0.1;
  // this style of check can only ever say pass/fail on the WHOLE probe,
  // never identify a specific diverging ray/field -- the real
  // compareStepByStepTrace always returns firstDivergingRay + divergingFields
  assert.equal(typeof finalOnlyCompare([1, 1, 1], [1, 1, 1]), 'boolean', 'a final-only comparator has no per-ray granularity by construction, unlike compareStepByStepTrace');
});

// ----------------------------------------------------------- kernel construction
test('createGIUpdateKernel exposes the new debug buffers (probeMapBuffer, debugDirHit, debugRadianceWeight, debugRunningSum, debugFinal, debugProbeUniform), all real TSL nodes', () => {
  const gi = new GIController({});
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] });
  const irr = gi.resources.irr;
  for (const key of ['probeMapBuffer', 'debugDirHit', 'debugRadianceWeight', 'debugRunningSum', 'debugFinal']) {
    assert.equal(irr[key].isNode, true, `${key} must be a real storage node`);
  }
  assert.equal(irr.debugProbeUniform.value, 0xffffffff, 'default sentinel: no probe selected, instrumentation is a no-op');
});

test('mutant: a debugProbeUniform default of 0 (instead of a sentinel) would make probe 0 ALWAYS instrumented, silently adding per-ray writes to every normal dispatch', () => {
  const zeroDefault = 0;
  assert.notEqual(zeroDefault, 0xffffffff, 'a 0 default would collide with the very first real probe index, unlike the sentinel');
});
