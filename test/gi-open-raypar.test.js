// Ray-parallel GI (gi-open-raypar.js): (1) ray buffer layout, (2) blend math == reference integrate/depth moments, (3) structural WGSL-hazard scans of the 3 kernels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../client/kernel/gi/gi-open-raypar.js';
import { integrateProbeIrradiance, fibonacciSphereDirs } from '../client/kernel/gi/irradiance.js';
import { decodeOct } from '../client/kernel/gi/octahedral.js';
const SRC = readFileSync(new URL('../client/kernel/gi/gi-open-raypar.js', import.meta.url), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const rng = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
/** synthetic ray buffer: probes × rays vec4 (radiance, hitT) */
function mkBuf(probes, rays, seed = 7) {
  const r = rng(seed); const buf = new Float32Array(R.rayBufferLength(probes, rays) * 4);
  for (let p = 0; p < probes; p++) for (let i = 0; i < rays; i++) { const o = R.rayBufferIndex(p, i, rays) * 4; buf[o] = r() * 2; buf[o + 1] = r(); buf[o + 2] = r() * 0.5; buf[o + 3] = r() < 0.3 ? -1 : r() * 40; }
  return buf;
}
test('layout: (probe,ray) -> dense unique slot probe*rays+ray; buffer sized probes*rays vec4', () => {
  const P = 5, N = 32; const seen = new Set();
  for (let p = 0; p < P; p++) for (let i = 0; i < N; i++) seen.add(R.rayBufferIndex(p, i, N));
  assert.equal(seen.size, P * N); assert.equal(Math.min(...seen), 0); assert.equal(Math.max(...seen), P * N - 1);
  assert.equal(R.rayBufferLength(P, N), P * N); assert.equal(R.rayBufferIndex(3, 7, 32), 3 * 32 + 7);
  // thread index (trace pass) decomposes back: probeLocal = t / N, rayI = t % N  ⇒ slot == t
  for (let t = 0; t < P * N; t++) assert.equal(R.rayBufferIndex(Math.floor(t / N), t % N, N), t);
});
test('fibDirJS == irradiance.js fibonacciSphereDirs (same dirs as legacy kernel/reference)', () => {
  for (const n of [16, 32, 64]) { const ref = fibonacciSphereDirs(n, null); for (let i = 0; i < n; i++) { const d = R.fibDirJS(i, n); for (let k = 0; k < 3; k++) assert.ok(Math.abs(d[k] - ref[i][k]) < 1e-9, `n${n} i${i}`); } }
});
test('irradiance blend == reference integrateProbeIrradiance over the same rays (all 64 texels, 2 probes)', () => {
  const N = 32, P = 2, buf = mkBuf(P, N); const dirs = Array.from({ length: N }, (_, i) => R.fibDirJS(i, N));
  for (let p = 0; p < P; p++) for (let t = 0; t < 64; t++) {
    const td = decodeOct([((t % 8) + 0.5) / 8 * 2 - 1, (Math.floor(t / 8) + 0.5) / 8 * 2 - 1]);
    const rays = dirs.map((dir, i) => { const o = R.rayBufferIndex(p, i, N) * 4; return { dir, radiance: [buf[o], buf[o + 1], buf[o + 2]] }; });
    const ref = integrateProbeIrradiance(td, rays); const got = R.blendIrradianceTexelJS(buf, p, N, td);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(ref[k] - got[k]) < 1e-5 * Math.max(1, Math.abs(ref[k])), `p${p} t${t} k${k}: ${ref[k]} vs ${got[k]}`);
  }
});
test('depth blend: cosine-weighted (mean, mean2); miss -> maxDist; second moment >= mean^2', () => {
  const N = 32, buf = mkBuf(1, N, 11), maxDist = 48; const dirs = Array.from({ length: N }, (_, i) => R.fibDirJS(i, N));
  for (let t = 0; t < 256; t++) {
    const td = R.texelOctDir(t, 16); let wS = 0, dS = 0, d2S = 0;
    dirs.forEach((dir, i) => { const hit = buf[R.rayBufferIndex(0, i, N) * 4 + 3]; const dist = hit >= 0 ? hit : maxDist; const w = Math.max(0, td[0] * dir[0] + td[1] * dir[1] + td[2] * dir[2]); wS += w; dS += w * dist; d2S += w * dist * dist; });
    const [m, m2] = R.blendDepthTexelJS(buf, 0, N, td, maxDist);
    assert.ok(Math.abs(m - dS / Math.max(wS, 1e-5)) < 1e-9 && Math.abs(m2 - d2S / Math.max(wS, 1e-5)) < 1e-9);
    assert.ok(m2 + 1e-9 >= m * m, 'Jensen');
  }
  // all-miss probe: every texel sees maxDist
  const miss = new Float32Array(N * 4); for (let i = 0; i < N; i++) miss[i * 4 + 3] = -1;
  const [m, m2] = R.blendDepthTexelJS(miss, 0, N, [0, 1, 0], maxDist); assert.ok(Math.abs(m - maxDist) < 1e-4 && Math.abs(m2 - maxDist * maxDist) < 1e-2);
});
test('disabled probe flag lives in ray 0 .w (DISABLED_HIT = -2, distinct from miss -1)', () => {
  const N = 8, buf = new Float32Array(2 * N * 4); buf[R.rayBufferIndex(1, 0, N) * 4 + 3] = R.DISABLED_HIT; buf[R.rayBufferIndex(0, 0, N) * 4 + 3] = -1;
  assert.equal(R.probeDisabledJS(buf, 1, N), true); assert.equal(R.probeDisabledJS(buf, 0, N), false, 'plain miss is not disabled'); assert.equal(R.DISABLED_HIT, -2);
});
// ---------------------------------------------------------------- structural hazard scans
const kernelSrc = (name, next) => CODE.slice(CODE.indexOf(`export function ${name}`), next ? CODE.indexOf(`export function ${next}`) : undefined);
const TRACE = kernelSrc('createOpenTraceKernel', 'createOpenIrradianceBlendKernel'), IRR = kernelSrc('createOpenIrradianceBlendKernel', 'createOpenDepthBlendKernel'), DEP = kernelSrc('createOpenDepthBlendKernel', 'createRayParallelKernels');
function hazards(code, { trace = TRACE, irr = IRR, dep = DEP } = {}) {
  const bad = [];
  if (/\bBreak\(/.test(code)) bad.push('Break()'); if ((code.match(/\bLoop\(\s*[^{]/g) || []).length) bad.push('bare Loop()');
  const loopNames = (s) => [...s.matchAll(/Loop\(\s*\{([^}]*)\}/g)].map((m) => (m[1].match(/name:\s*'(\w+)'/) ?? [])[1]);
  if (loopNames(irr).join() !== 'rayI') bad.push(`irr blend loops: ${loopNames(irr)}`); if (loopNames(dep).join() !== 'rayI') bad.push(`dep blend loops: ${loopNames(dep)}`);
  if (loopNames(trace).length !== 0) bad.push('trace kernel has a ray Loop (must be one thread per ray)');
  const marches = [...trace.matchAll(/marchVoxelsTSL\(vs, [^;]*?, '(\w+)'/g)].map((m) => m[1]); if (marches.join() !== 'stepI,shadowStepI') bad.push(`trace march names ${marches}`);
  for (const [n, k] of [['trace', trace], ['irr', irr], ['dep', dep]]) if ((k.match(/If\(uint\((?:threadIndex|texelIndex)\)\.lessThan\(validCount\)/g) || []).length !== 1) bad.push(`${n} validCount guard`);
  if (!/const dir = fibonacciDirTSL\(rayI, raysPerProbe\)\.toVar\(\)/.test(trace) || !/const dir = fibonacciDirTSL\(rayI, raysPerProbe\)\.toVar\(\)/.test(irr)) bad.push('dir not materialised');
  if (!trace.includes('bounce.assign(vec3(0, 0, 0));')) bad.push('bounce reset');
  if (!trace.includes('threadIndex).div(int(raysPerProbe))') || !trace.includes('threadIndex).mod(int(raysPerProbe))')) bad.push('thread -> (probe, ray) decomposition');
  if (!trace.includes('rayBuf.element(probeLocal.mul(int(raysPerProbe)).add(rayI))')) bad.push('trace write slot != rayBufferIndex');
  for (const k of [irr, dep]) if (!k.includes('rayBuf.element(rayBase.add(rayI))') || !k.includes('probeLocal.mul(int(raysPerProbe))')) bad.push('blend read slot != rayBufferIndex');
  return bad;
}
test('real source passes every hazard scan (no Break, unique loop names, validCount guard, slot math == rayBufferIndex)', () => assert.deepEqual(hazards(CODE), []));
test('mutants: scan catches each regression class', () => {
  const m = (a, b) => { assert.ok(CODE.includes(a), a); const c = CODE.replace(a, b); return hazards(c, { trace: kernelSrcOf(c, 'createOpenTraceKernel', 'createOpenIrradianceBlendKernel'), irr: kernelSrcOf(c, 'createOpenIrradianceBlendKernel', 'createOpenDepthBlendKernel'), dep: kernelSrcOf(c, 'createOpenDepthBlendKernel', 'createRayParallelKernels') }); };
  const kernelSrcOf = (c, n, nx) => c.slice(c.indexOf(`export function ${n}`), c.indexOf(`export function ${nx}`));
  assert.ok(m('rayBuf.element(probeLocal.mul(int(raysPerProbe)).add(rayI))', 'rayBuf.element(rayI.mul(int(raysPerProbe)).add(probeLocal))').length > 0, 'transposed layout');
  assert.ok(m("name: 'rayI' }, ({ rayI }) => {\n        const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();\n        const radiance", "name: 'rayJ' }, ({ rayI }) => {\n        const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();\n        const radiance").length > 0, 'loop rename');
  assert.ok(m('bounce.assign(vec3(0, 0, 0));', '').length > 0, 'bounce reset');
  assert.ok(m('If(uint(threadIndex).lessThan(validCount)', 'If(uint(threadIndex).greaterThan(int(-1))').length > 0, 'guard');
  assert.ok(hazards(CODE + '\nBreak();').length > 0);
});
test('storage budget (≤8): kernels reference only their accounted buffers', () => {
  assert.equal(R.countRayTraceKernelBuffers(), 4); assert.equal(R.countRayIrradianceBlendBuffers({ touched: true }), 4); assert.equal(R.countRayDepthBlendBuffers(), 2);
  for (const n of [R.countRayTraceKernelBuffers(), R.countRayIrradianceBlendBuffers({ touched: true }), R.countRayDepthBlendBuffers()]) assert.ok(n <= 8);
  const bufs = (s) => [...new Set([...s.matchAll(/\b(rayBuf|irradiance|depth|touched)\.element\(/g)].map((m) => m[1]))].sort();
  assert.deepEqual(bufs(TRACE), ['rayBuf']); // + irradiance/depth/voxels via queryCascadesTSL/readVoxel (accounted: 4)
  assert.deepEqual(bufs(IRR), ['depth', 'irradiance', 'rayBuf', 'touched']); assert.deepEqual(bufs(DEP), ['depth', 'rayBuf']);
});
test('kernels construct with real nodes (graph builds headless) and share bounceScale', async () => {
  const { GIController } = await import('../client/kernel/gi/gi-controller.js'); const THREE = await import('three');
  const gi = new GIController({ renderer: { compute() {} }, scene: new THREE.Scene() });
  gi.configure({ enabled: true, mode: 'open', raysPerProbe: 16, voxel: { bricks: { x: 4, y: 2, z: 4 } }, cascades: { dims: [{ x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 }] } });
  const o = gi.resources.open; assert.equal(o.trace.totalThreads, o.atlases.probeCount * 16); assert.equal(o.irr.bounceScale, o.trace.bounceScale);
  assert.equal(o.rayBuf.value.count, o.atlases.probeCount * 16);
});
