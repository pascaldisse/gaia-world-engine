// v2 TSL graph (gi-open-nodes.js): no GPU/builder in node → (1) the NON-loop helpers are really constructed with
// real r180 nodes (catches missing-method / bad-arity errors), (2) structural WGSL-hazard scans of the source
// (mirror of gi-loop-naming-mirror / gi-storage-buffer-budget / gi-workgroup-guard-mirror, passes #6–#10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { int, float, vec3, uniform } from 'three/tsl';
import * as N from '../client/kernel/gi/gi-open-nodes.js';
import { VoxelWindow } from '../client/kernel/gi/voxel-window.js';
import { buildCascades } from '../client/kernel/gi/cascade.js';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-open-nodes.js', import.meta.url), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('non-loop helpers construct with real nodes (voxel read/albedo/sky/normal/probe-state)', () => {
  const win = new VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); win.setCenter([0, 0, 0]);
  const vs = N.createVoxelStorage(win);
  const v = N.readVoxelTSL(vs, int(1), int(-2), int(3)); assert.ok(v.isNode);
  assert.ok(N.unpackAlbedoTSL(v).isNode); assert.ok(N.isSolidTSL(v).isNode);
  assert.ok(N.readVoxelAtWorldTSL(vs, vec3(1.5, 2, 3)).isNode);
  const sky = N.createSkyUniforms({ zenith: [1, 0, 0], horizon: [0, 1, 0], ground: [0, 0, 1] });
  assert.ok(N.skyRadianceTSL(vec3(0, 1, 0), sky).isNode);
  assert.ok(N.voxelNormalTSL(vs, vec3(1, 1, 1), vec3(0, -1, 0)).isNode);
  assert.ok(N.resolveProbeTSL(vs, vec3(1, 1, 1), 2).pos.isNode);
  assert.equal(N.flushVoxelUploads(vs, []), 0);
});
test('flushVoxelUploads issues ONE update range per rebuilt brick (partial write, not whole buffer)', () => {
  const win = new VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); win.setCenter([16, 8, 16]);
  const vs = N.createVoxelStorage(win);
  win.addMesh('a', { triangles: [1, 3.5, 1, 5, 3.5, 1, 5, 3.5, 5] });
  const r = win.update(); assert.equal(N.flushVoxelUploads(vs, r.rebuilt), r.rebuilt.length);
  assert.equal(vs.attr.updateRanges.length, r.rebuilt.length);
  assert.deepEqual(vs.attr.updateRanges[0], { start: r.rebuilt[0].start, count: 512 });
  assert.ok(vs.attr.updateRanges.length < win.bricks.x * win.bricks.y * win.bricks.z);
});
test('setVoxelBase mirrors window base (biased) — scrolling updates the uniform, no rebuild', () => {
  const win = new VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); win.setCenter([0, 0, 0]);
  const vs = N.createVoxelStorage(win); const a = vs.baseBrickB.value.x;
  win.setCenter([64, 0, 0]); N.setVoxelBase(vs, win); assert.equal(vs.baseBrickB.value.x - a, 8);
});
test('cascade uniforms: one per cascade, set from base cells', () => {
  const cs = buildCascades(); const u = N.createCascadeUniforms(cs); assert.equal(u.length, 3);
  N.setCascadeBases(u, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]); assert.deepEqual([u[2].value.x, u[2].value.y, u[2].value.z], [7, 8, 9]);
});
// ---------------------------------------------------------------- structural hazard scans
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
function hazards(code) {
  const bad = [];
  if ((code.match(/\bLoop\(\s*[^{]/g) || []).length) bad.push('bare Loop()');
  if (/\bBreak\(/.test(code)) bad.push('Break()');
  const loops = [...code.matchAll(/Loop\(\s*\{([^}]*)\}/g)].map((m) => m[1]);
  if (loops.length < 5) bad.push(`only ${loops.length} loops found`);
  if (loops.some((l) => !/\bname\b/.test(l))) bad.push('Loop without name');
  const marchCalls = [...code.matchAll(/marchVoxelsTSL\(vs, [^;]*?, '(\w+)'/g)].map((m) => m[1]);
  if (new Set(marchCalls).size !== marchCalls.filter((n, i) => marchCalls.indexOf(n) === i).length) bad.push('dup');
  if (!marchCalls.includes('stepI') || !marchCalls.includes('shadowStepI')) bad.push('march names stepI/shadowStepI missing');
  if (marchCalls.some((n) => n === 'rayI')) bad.push('march loop named rayI (shadows ray index)');
  if (new Set(marchCalls.filter((n) => n !== 'stepI')).has('stepI')) bad.push('x');
  const irr = code.slice(code.indexOf('export function createOpenIrradianceKernel'), code.indexOf('export function createOpenDepthKernel'));
  const names = [...irr.matchAll(/'(stepI|shadowStepI|rayI)'/g)].map((m) => m[1]);
  if (new Set(names).size !== 3 || names.length !== 3) bad.push(`irradiance kernel must use rayI/stepI/shadowStepI once each, got ${names}`);
  if (!/name: `qx\$\{tag\}`/.test(code) || !/tag: `\$\{tag\}\$\{k\}`/.test(code)) bad.push('query loop names not per-cascade tagged');
  if (!(/tag: 'b'/.test(code) && /tag: 'mat'/.test(code))) bad.push('query tags b/mat');
  for (const must of ['t.assign(0); hitT.assign(-1);', 'total.assign(vec3(0, 0, 0)); wSum.assign(0);', 'bounce.assign(vec3(0, 0, 0));']) if (!code.includes(must)) bad.push(`missing reset: ${must}`);
  if (!/const dir = fibonacciDirTSL\(rayI, raysPerProbe\)\.toVar\(\)/.test(code)) bad.push('dir not materialised');
  if ((code.match(/If\(uint\(texelIndex\)\.lessThan\(validCount\)/g) || []).length !== 2) bad.push('validCount guard');
  return bad;
}
test('real source passes every WGSL-hazard scan (#6 no Break, #9 resets, #10 unique names, validCount guard)', () => assert.deepEqual(hazards(CODE), []));
const mutate = (a, b) => { assert.ok(CODE.includes(a), a); return hazards(CODE.replace(a, b)); };
test('mutants: each hazard class is caught by the scan', () => {
  assert.ok(mutate('name: `qx${tag}`', 'name: `qx`').length > 0, 'unnamed-per-cascade query loops');
  assert.ok(mutate("'shadowStepI', hit", "'stepI', hit").length > 0, 'shadow march reuses stepI');
  assert.ok(mutate("maxDist, 'stepI');\n        const hit =", "maxDist, 'rayI');\n        const hit =").length > 0, 'march loop named rayI');
  assert.ok(mutate('t.assign(0); hitT.assign(-1);', '').length > 0, 'reset removed');
  assert.ok(mutate('bounce.assign(vec3(0, 0, 0));', '').length > 0, 'bounce reset removed');
  assert.ok(hazards(CODE + '\nBreak();').length > 0);
  assert.ok(hazards(CODE + '\nLoop(4, () => {});').length > 0);
  assert.ok(mutate('If(uint(texelIndex).lessThan(validCount), () => {\n      const tpp = int(depthRes', 'If(texelIndex.greaterThan(-1), () => {\n      const tpp = int(depthRes').length > 0, 'guard removed');
});
test('storage budget (\u22648): kernel buffer references match accounting', () => {
  assert.equal(N.countOpenIrradianceKernelBuffers({ touched: true }), 4);
  assert.equal(N.countOpenDepthKernelBuffers(), 2);
  assert.ok(N.countOpenIrradianceKernelBuffers({ touched: true }) <= N.OPEN_STORAGE_BUFFER_LIMIT);
  assert.equal((CODE.match(/instancedArray\(/g) || []).length, 0);
  assert.equal((CODE.match(/\bstorage\(/g) || []).length, 1);
  // an extra buffer in the kernels would break the accounting: kernels reference only irradiance/depth/voxels/touched
  const kern = CODE.slice(CODE.indexOf('export function createOpenIrradianceKernel'));
  const bufs = new Set([...kern.matchAll(/\b(irradiance|depth|vs\.voxels|touched|debugBuffer|skyHits|lights)\.element\(/g)].map((m) => m[1]));
  assert.deepEqual([...bufs].sort(), ['depth', 'irradiance', 'touched']);
});
test('S4: probe-state + adaptive-alpha + sentinel are wired in the kernels', () => {
  for (const must of ['resolveProbeTSL(vs, probePos0', 'select(disabled, vec3(0, 0, 0)', 'select(disabled, vec2(-1, -1)', 'old.x.lessThan(0)', 'mix(alpha, fastAlpha', 'md.x.greaterThanEqual(0)']) assert.ok(CODE.includes(must), must);
});
test('S3: miss \u2192 sky, hit \u2192 voxel albedo \u00d7 (sun w/ shadow march + trilinear bounce) / \u03c0', () => {
  for (const must of ['skyRadianceTSL(dir, sky)', 'unpackAlbedoTSL(readVoxelAtWorldTSL(vs, hitPos))', 'sunT.lessThan(0)', 'queryCascadesTSL({ atlases, cascades, baseCellU, worldPos: outPos', 'mul(RECIP_PI)', 'voxelNormalTSL(vs, hitPos, dir)']) assert.ok(CODE.includes(must), must);
});
