// AUTO-EXPOSURE: CPU mirrors (metering, target, adaptation) + chain wiring. GPU path is proven live (docs/AUTO-EXPOSURE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { AE_DEFAULTS, resolveAE, trimmedMean, gridWeights, cellWeight, targetEV, adaptEV, evToMul, logLum, lumaOf, AutoExposure, GRID } from '../client/kernel/lighting/autoexposure.js';
import { buildChain, POST_DEFAULTS, resolvePost } from '../client/kernel/lighting/post.js';
import { LightingController } from '../client/kernel/lighting/index.js';
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const cam = () => new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);

test('defaults: opt-in (disabled), partial config merges, percentile clamp', () => {
  assert.equal(AE_DEFAULTS.enabled, false);
  assert.equal(POST_DEFAULTS.autoExposure.enabled, false);
  const r = resolvePost({ autoExposure: { enabled: true, maxEV: 2 } }).autoExposure;
  assert.equal(r.enabled, true); assert.equal(r.maxEV, 2); assert.equal(r.speedUp, AE_DEFAULTS.speedUp);
  const bad = resolveAE({ lowPct: 0.95, highPct: 0.5, minEV: 5, maxEV: 1 });
  assert.ok(bad.highPct >= bad.lowPct + 0.02 - 1e-12); assert.ok(bad.minEV <= bad.maxEV);
});

test('cellWeight: 1 when centerWeight 0; centre > corner when centred; symmetric', () => {
  for (const w of gridWeights(0)) near(w, 1);
  const g = gridWeights(1);
  assert.ok(cellWeight(3, 3, 1) > cellWeight(0, 0, 1) * 5);
  near(g[0], g[GRID - 1]); near(g[0], g[GRID * GRID - 1]);
});

test('trimmedMean: uniform weights, no clip = plain mean; clip drops outliers; ties stable', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], w = v.map(() => 1);
  near(trimmedMean(v, w, 0, 1), 5.5);
  near(trimmedMean(v, w, 0.1, 0.9), 5.5);                    // symmetric clip of 1 each end
  near(trimmedMean([...v.slice(0, 9), 1000], w, 0, 0.9), 5);  // outlier (sun) clipped by highPct
  near(trimmedMean([0, 0, 0, 0, 10], [1, 1, 1, 1, 1], 0.2, 1), 2.5); // ties: lowest-index tied cell clipped first
  assert.ok(Number.isFinite(trimmedMean(new Array(64).fill(3), new Array(64).fill(1), 0.1, 0.9)));
  near(trimmedMean(new Array(64).fill(3), new Array(64).fill(1), 0.1, 0.9), 3);
});

test('trimmedMean: weighted — heavy centre cell dominates', () => {
  const v = [0, 0, 0, 8], w = [1, 1, 1, 100];
  assert.ok(trimmedMean(v, w, 0, 1) > 7);
  near(trimmedMean(v, [1, 1, 1, 1], 0, 1), 2);
});

test('targetEV: scene at key => comp only; dark => +EV; bright => -EV; clamped; strength 0 = meter only', () => {
  const c = resolveAE({ compensation: 0, minEV: -2, maxEV: 3 });
  near(targetEV(Math.log2(0.18), c), 0);
  near(targetEV(Math.log2(0.18) - 2, c), 2);
  near(targetEV(Math.log2(0.18) + 1, c), -1);
  near(targetEV(-20, c), 3, 1e-12); near(targetEV(20, c), -2, 1e-12);        // clamp
  near(targetEV(Math.log2(0.18), { ...c, compensation: 0.5 }), 0.5);
  near(targetEV(-9, { ...c, strength: 0, compensation: 0.25 }), 0.25);
});

test('adaptEV: framerate independent (1 s @1 step == @60 == @240 == jittery), converges, never overshoots', () => {
  const c = resolveAE({ speedUp: 3, speedDown: 1 });
  const run = (steps) => { let ev = 0; for (let i = 0; i < steps; i++) ev = adaptEV(ev, 2, 1 / steps, c); return ev; };
  near(run(1), run(60), 1e-9); near(run(60), run(240), 1e-9);
  near(run(1), 2 * (1 - Math.exp(-1)), 1e-9);                      // speedDown 1 (scene darker, ev rising)
  let ev = 0; const dts = [0.016, 0.033, 0.008, 0.05, 0.016, 0.0166, 0.2, 0.0034]; let t = 0;
  for (const d of dts) { ev = adaptEV(ev, 2, d, c); t += d; }
  near(ev, 2 * (1 - Math.exp(-t)), 1e-9);                           // jittery dt sums exactly
  let e2 = 0; for (let i = 0; i < 1000; i++) { e2 = adaptEV(e2, 2, 0.1, c); assert.ok(e2 <= 2 + 1e-12); }
  near(e2, 2, 1e-9);
  near(adaptEV(0, 2, 0, c), 0);                                      // dt 0 holds
});

test('adaptEV: asymmetric — brighter scene (ev falls) uses speedUp, darker uses speedDown', () => {
  const c = resolveAE({ speedUp: 3, speedDown: 1 });
  const fall = 0 - adaptEV(0, -2, 0.5, c), rise = adaptEV(0, 2, 0.5, c);
  assert.ok(fall > rise, 'dark->bright adapts faster');
  near(fall, 2 * (1 - Math.exp(-1.5))); near(rise, 2 * (1 - Math.exp(-0.5)));
});

test('AutoExposure: first reading snaps; then smooth; uniform follows; clamp; no oscillation on constant input; live knob change', () => {
  const ae = new AutoExposure({ enabled: true, minEV: -2, maxEV: 3, key: 0.18 });
  near(ae.update(0.016), 0); assert.equal(ae.state.lum, null);
  ae.ingest(Math.log2(0.18) - 2);                    // dark scene
  near(ae.ev, 2); near(ae.update(0.016), 2); near(ae.expMul.value, 4);
  ae.ingest(Math.log2(0.18) + 1);                    // jump to bright: target -1
  const trace = []; for (let i = 0; i < 600; i++) trace.push(ae.update(1 / 60));
  for (let i = 1; i < trace.length; i++) assert.ok(trace[i] <= trace[i - 1] + 1e-12, 'monotonic, no overshoot/oscillation');
  near(trace.at(-1), -1, 1e-6);
  const i90 = trace.findIndex((e) => (2 - e) / 3 >= 0.9);
  near((i90 + 1) / 60, Math.log(10) / 3, 0.03);       // speedUp 3 => 90% at ln10/3 = 0.77 s
  ae.ingest(-30); for (let i = 0; i < 1200; i++) ae.update(1 / 60);
  near(ae.ev, 3, 1e-6);                                // clamp at maxEV
  ae.configure({ ...ae.cfg, maxEV: 1 }); ae.update(1 / 60); assert.ok(ae.ev <= 1 + 1e-12);
  assert.equal(ae.ingest(NaN), undefined); assert.ok(Number.isFinite(ae.ev));
});

test('lum helpers: Rec709 luma, log floor', () => {
  near(lumaOf(1, 1, 1), 1, 1e-12);
  near(logLum(0), Math.log2(1e-4)); near(logLum(1e9), 14); near(logLum(1), 0);
  near(evToMul(3), 8);
});

test('buildChain: disabled => no rig (zero cost); enabled => rig + expMul uniform multiplied into the chain; composes with static exposure (separate)', () => {
  const off = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: {} });
  assert.equal(off.nodes.autoExposure, null);
  const on = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: { exposure: 2, autoExposure: { enabled: true, compensation: 0.5 } } });
  const rig = on.nodes.autoExposure;
  assert.ok(rig, 'rig built'); assert.equal(rig.expMul.isNode, true);
  assert.equal(rig.meter.stages.length, 3); assert.equal(rig.meter.final.renderTarget.width, 1);
  assert.deepEqual(rig.meter.stages.map((s) => s.renderTarget.width), [128, 32, 8]);
  assert.equal(rig.meter.final.renderTarget.texture.type, THREE.FloatType);
  near(rig.update(0.016), 0.5);                         // no reading yet => compensation
  near(rig.expMul.value, Math.pow(2, 0.5));
  assert.equal(rig.state.cfg.compensation, 0.5);
});

test('LightingController: exposes autoExposureState (null when off)', () => {
  const lc = new LightingController({ renderer: null, scene: new THREE.Scene(), sun: null, hemi: null, camera: cam(), post: null });
  assert.equal(lc.autoExposureState, null);
});
