// AMBIENT-REPLACE (docs/GI-AMBIENT.md): GI replaces the hemi sky ambient where it has coverage. Headless (no GPU): CPU reference math
// (gi-reference.js referenceCoverage/ambientReplace), real r180 node construction, controller wiring, structural mirror scans of the TSL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { vec3, float } from 'three/tsl';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { buildCascades } from '../client/kernel/gi/cascade.js';
import * as N from '../client/kernel/gi/gi-open-nodes.js';
import { referenceCoverage, hemiIrradiance, ambientReplace, skyIrradiance, COVERAGE_WEIGHT_FADE, COVERAGE_WEIGHT_EPS } from '../client/kernel/gi/gi-reference.js';

const CODE = readFileSync(new URL('../client/kernel/gi/gi-open-nodes.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const casc = buildCascades({ count: 3, spacings: [2, 6, 18], dims: [{ x: 16, y: 8, z: 16 }, { x: 16, y: 8, z: 16 }, { x: 16, y: 8, z: 16 }] });
const base = casc.map((c) => [0, 0, 0]); // all windows anchored at cell 0 -> coarsest spans x,z in [0,270], y in [0,126]; finest [0,30]x[0,14]
const W = [1, 1, 1];

// ---------------------------------------------------------------- coverage fade
test('coverage: 1 deep inside the coarsest cascade, 0 outside it', () => {
  near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [135, 60, 135], weights: W }), 1);
  for (const p of [[-1, 60, 135], [271, 60, 135], [135, -1, 135], [135, 127, 135], [135, 60, 400]]) assert.equal(referenceCoverage({ cascades: casc, baseCells: base, worldPos: p, weights: W }), 0, `outside ${p}`);
});
test('coverage: smooth monotone fade over the outer blendCells (1.5) of the coarsest cascade, 0 at the edge, 1 from blendCells in', () => {
  const sp = 18, bc = 1.5; let prev = -1;
  near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [0, 60, 135], weights: W }), 0); // exactly on the edge
  for (let i = 0; i <= 20; i++) {
    const cells = (i / 20) * bc; const c = referenceCoverage({ cascades: casc, baseCells: base, worldPos: [cells * sp, 60, 135], weights: W });
    assert.ok(c >= prev - 1e-12, 'monotone'); assert.ok(c >= 0 && c <= 1); prev = c;
  }
  near(prev, 1); near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [bc * sp * 0.5, 60, 135], weights: W }), 0.5); // smoothstep(0.5) = 0.5
  near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [bc * sp * 2, 60, 135], weights: W }), 1);
  // far side edge fades identically
  near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [270 - bc * sp * 0.5, 60, 135], weights: W }), 0.5);
  // y edge as well
  near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [135, 126 - bc * sp * 0.5, 135], weights: W }), 0.5);
});
test('coverage: unusable / vanishing probe weight -> 0, smooth ramp over [EPS..FADE], never a hard step', () => {
  const p = [135, 60, 135];
  assert.equal(referenceCoverage({ cascades: casc, baseCells: base, worldPos: p, weights: [0, 0, 0] }), 0);
  assert.equal(referenceCoverage({ cascades: casc, baseCells: base, worldPos: p, weights: [0, 0, COVERAGE_WEIGHT_EPS] }), 0); // gate is strict >
  let prev = 0; for (let i = 1; i <= 50; i++) { const w = (i / 50) * COVERAGE_WEIGHT_FADE * 1.5; const c = referenceCoverage({ cascades: casc, baseCells: base, worldPos: p, weights: [0, 0, w] }); assert.ok(c >= prev); assert.ok(c - prev < 0.1, 'no jump'); prev = c; }
  near(prev, 1);
});
test('coverage: a finer cascade that still has weight keeps coverage 1 when the coarse one has none', () => {
  near(referenceCoverage({ cascades: casc, baseCells: base, worldPos: [10, 5, 10], weights: [1, 0, 0] }), 1);
});

// ---------------------------------------------------------------- replace math
test('replace math: net = hemi + c*(gi-hemi) = mix(hemi, gi, c); identity at c=0 (hemi) and c=1 (gi)', () => {
  const sky = [0.37, 0.6, 0.9], ground = [0.34, 0.42, 0.45], gi = [1.5, 2.5, 3.5];
  for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.6, 0.8, 0]]) {
    const h = hemiIrradiance(n, sky, ground);
    const net = (c) => { const t = ambientReplace(gi, c, n, sky, ground); return h.map((v, i) => v + t[i]); };
    net(0).forEach((v, i) => near(v, h[i])); net(1).forEach((v, i) => near(v, gi[i]));
    net(0.3).forEach((v, i) => near(v, h[i] * 0.7 + gi[i] * 0.3));
  }
  // hemi weights: up -> sky, down -> ground, horizon -> mean
  hemiIrradiance([0, 1, 0], sky, ground).forEach((v, i) => near(v, sky[i])); hemiIrradiance([0, -1, 0], sky, ground).forEach((v, i) => near(v, ground[i]));
  hemiIrradiance([1, 0, 0], sky, ground).forEach((v, i) => near(v, (sky[i] + ground[i]) / 2));
});
test('skyIrradiance: uniform sky -> pi*L (up) ; matches analytic gradient bounds', () => {
  const u = { zenith: [2, 2, 2], horizon: [2, 2, 2], ground: [2, 2, 2] };
  skyIrradiance([0, 1, 0], u).forEach((v) => near(v, Math.PI * 2, 2e-3));
  const g = { zenith: [1, 1, 1], horizon: [3, 3, 3], ground: [0.5, 0.5, 0.5] }; const up = skyIrradiance([0, 1, 0], g)[0];
  assert.ok(up > Math.PI * 1 && up < Math.PI * 3); assert.ok(skyIrradiance([0, -1, 0], g)[0] < up);
});

// ---------------------------------------------------------------- real r180 node construction + structural mirror
const fixture = () => { const atlases = N.createProbeAtlases({ probeCount: 3 * 2048, irradianceRes: 8, depthRes: 16 }); return { atlases, cascades: casc, baseCellU: N.createCascadeUniforms(casc) }; };
test('TSL: queryCascadesCoverageTSL builds {value, coverage} real nodes; queryCascadesTSL still returns the bare vec3 node', () => {
  const f = fixture(); const a = { ...f, worldPos: vec3(1, 2, 3), normal: vec3(0, 1, 0), tag: 't' };
  const q = N.queryCascadesCoverageTSL(a); assert.ok(q.value.isNode && q.coverage.isNode);
  assert.ok(N.queryCascadesTSL({ ...a, tag: 'u' }).isNode);
});
test('TSL: createOpenQueryNode default (add) unchanged; replace needs ambient uniforms and builds', () => {
  const f = fixture(); const arg = { ...f, worldPositionNode: vec3(1, 2, 3), normalNode: vec3(0, 1, 0), blendCells: 1.5 };
  assert.ok(N.createOpenQueryNode(arg).isNode);
  assert.throws(() => N.createOpenQueryNode({ ...arg, ambient: 'replace' }), /ambientU/);
  const amb = N.createAmbientUniforms({ sky: [1, 1, 1], ground: [0.5, 0.5, 0.5] });
  assert.ok(N.createOpenQueryNode({ ...arg, ambient: 'replace', ambientU: amb }).isNode);
  assert.ok(N.ambientReplaceTSL(vec3(1, 1, 1), float(0.5), vec3(0, 1, 0), amb).isNode); assert.ok(N.hemiIrradianceTSL(vec3(0, 1, 0), amb).isNode);
});
test('TSL structural mirror: coverage = max over cascades of usable*smooth(weight/FADE)*(coarsest: smooth(border/blendCells)); replace = coverage*(gi - hemi); hemi = mix(ground, sky, 0.5y+0.5)', () => {
  for (const must of ['COVERAGE_WEIGHT_EPS', 'smooth01(q[k].weight.div(COVERAGE_WEIGHT_FADE))', 'k === n - 1 ? smooth01(cb[k].border.div(blendCells))', 'coverage = max(coverage, cover(k))',
    'coverage.mul(gi.sub(hemiIrradianceTSL(n, amb)))', 'mix(amb.ground, amb.sky, n.y.mul(0.5).add(0.5))', 'queryCascadesCoverageTSL(args).value']) assert.ok(CODE.includes(must), must);
  assert.equal(N.COVERAGE_WEIGHT_FADE, COVERAGE_WEIGHT_FADE); assert.equal(N.COVERAGE_WEIGHT_EPS, COVERAGE_WEIGHT_EPS);
});

// ---------------------------------------------------------------- controller wiring
const OPEN = { enabled: true, mode: 'open', raysPerProbe: 16, voxel: { bricks: { x: 4, y: 2, z: 4 } }, cascades: { dims: [{ x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 }] } };
const mk = (extra = {}) => { const scene = new THREE.Scene(); const hemi = new THREE.HemisphereLight(new THREE.Color(0.2, 0.4, 0.8), new THREE.Color(0.1, 0.1, 0.05), 0.9); scene.add(hemi); const gi = new GIController({ renderer: { compute() {} }, scene }); gi.configure({ ...OPEN, ...extra }); return { gi, scene, hemi, open: gi.resources.open }; };
test('default ambient is add: no sync, ambientMode add, skyScale 1', () => {
  const { gi, open } = mk(); assert.equal(open.ambientMode, 'add'); assert.equal(open.skyScale, 1);
  gi.update(0.016, [0, 0, 0]); assert.equal(open.ambientSyncs, 0); assert.equal(open.syncAmbient(), false);
});
test('replace: update() syncs the scene HemisphereLight (colour x intensity) each frame, live', () => {
  const { gi, hemi, open } = mk({ ambient: 'replace' }); assert.equal(open.ambientMode, 'replace');
  gi.update(0.016, [0, 0, 0]);
  const lin = new THREE.Color(0.2, 0.4, 0.8); const s = open.ambientU.sky.value;
  near(s.x, lin.r * 0.9, 1e-6); near(s.y, lin.g * 0.9, 1e-6); near(s.z, lin.b * 0.9, 1e-6); near(open.ambientU.ground.value.z, hemi.groundColor.b * 0.9, 1e-6);
  hemi.intensity = 0.3; hemi.color.setRGB(1, 0.5, 0.25); gi.update(0.016, [0, 0, 0]);
  near(open.ambientU.sky.value.x, 0.3, 1e-6); near(open.ambientU.sky.value.y, 0.15, 1e-6); near(open.ambientU.sky.value.z, 0.075, 1e-6);
});
test('replace: explicit ambientLight param wins over scene search; setAmbient pins manual values and stops the sync', () => {
  const own = { color: { r: 1, g: 1, b: 1 }, groundColor: { r: 0.5, g: 0.5, b: 0.5 }, intensity: 2, parent: null };
  const { gi, open } = mk({ ambient: 'replace', ambientLight: own }); gi.update(0.016, [0, 0, 0]);
  near(open.ambientU.sky.value.x, 2); near(open.ambientU.ground.value.x, 1);
  gi.setAmbient({ sky: [0.1, 0.2, 0.3], ground: { r: 0.01, g: 0.02, b: 0.03 }, intensity: 2 });
  near(open.ambientU.sky.value.y, 0.4); near(open.ambientU.ground.value.z, 0.06);
  own.intensity = 9; gi.update(0.016, [0, 0, 0]); near(open.ambientU.sky.value.y, 0.4); // manual: no resync
});
test('replace: no hemi in scene -> uniforms stay 0, search throttled (no per-frame traverse)', () => {
  const scene = new THREE.Scene(); let walks = 0; const tr = scene.traverse.bind(scene); scene.traverse = (f) => { if (String(f).includes('isHemisphereLight')) walks++; tr(f); }; // other walks (attachment mesh count) are not ours
  const gi = new GIController({ renderer: { compute() {} }, scene }); gi.configure({ ...OPEN, ambient: 'replace' }); const w0 = walks;
  for (let i = 0; i < 10; i++) gi.update(0.016, [0, 0, 0]);
  assert.ok(walks - w0 <= 1, `hemi searches ${walks - w0}`); assert.equal(gi.resources.open.ambientU.sky.value.x, 0);
});
test('skyScale: scales the probe-side sky radiance (config + setSkySummary + live setSkyScale); default 1 leaves values untouched', () => {
  const sum = { zenith: [1, 2, 3], horizon: [4, 5, 6], ground: [0.5, 0.25, 0.125] };
  const a = mk(); a.gi.setSkySummary(sum); [1, 2, 3].forEach((v, i) => near(a.open.sky.zenith.value.toArray()[i], v));
  const { gi, open } = mk({ skyScale: 0.5 }); gi.setSkySummary(sum);
  near(open.sky.zenith.value.y, 1); near(open.sky.horizon.value.z, 3); near(open.sky.ground.value.x, 0.25);
  gi.setSkyScale(0.1); near(open.sky.zenith.value.z, 0.3); near(open.sky.horizon.value.x, 0.4); // re-applies the last summary
  const d = mk({ skyScale: 0.25 }); assert.ok(d.open.sky.zenith.value.y > 0, 'default sky scaled at construction'); 
});
