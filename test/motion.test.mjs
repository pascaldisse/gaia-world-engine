// headless Rapier tests — REAL sim numbers, printed via t.diagnostic. node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import R, { ground } from './_rapier.mjs';
import { createMotion, humanoidRig, BEHAVIOURS } from '../index.js';

const DT = 1 / 60;
function scene(opts = {}) { const m = createMotion({ rapier: R, ...opts }); ground(m.world, R, 100); return m; }
const y = (h, n) => h.transforms().get(n).p[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// EE consumer rig: 6 boxes, EE names (head, torso, armL/R, legL/R), no pelvis/forearms/shins
function eeRig() {
  const B = (name, parent, c, he, mass) => ({ name, parent, center: c, halfExtents: he, mass });
  return {
    bodies: [
      B('torso', null, [0, 1.15, 0], [0.17, 0.3, 0.1], 36), B('head', 'torso', [0, 1.62, 0], [0.1, 0.12, 0.1], 6),
      B('armL', 'torso', [0.24, 1.1, 0], [0.05, 0.3, 0.05], 4), B('armR', 'torso', [-0.24, 1.1, 0], [0.05, 0.3, 0.05], 4),
      B('legL', 'torso', [0.09, 0.42, 0], [0.07, 0.42, 0.12], 10), B('legR', 'torso', [-0.09, 0.42, 0], [0.07, 0.42, 0.12], 10),
    ],
    joints: [
      { name: 'neck', a: 'torso', b: 'head', anchor: [0, 1.47, 0], type: 'spherical', limits: { twist: 0.8, swing: 0.6 } },
      { name: 'shoulderL', a: 'torso', b: 'armL', anchor: [0.23, 1.41, 0], type: 'spherical', limits: { x: [-2.8, 0.9], y: [-1, 1], z: [-0.3, 2.6] } },
      { name: 'shoulderR', a: 'torso', b: 'armR', anchor: [-0.23, 1.41, 0], type: 'spherical', limits: { x: [-2.8, 0.9], y: [-1, 1], z: [-2.6, 0.3] } },
      { name: 'hipL', a: 'torso', b: 'legL', anchor: [0.09, 0.85, 0], type: 'spherical', limits: { x: [-1.8, 0.4], y: [-0.5, 0.5], z: [-0.3, 0.8] } },
      { name: 'hipR', a: 'torso', b: 'legR', anchor: [-0.09, 0.85, 0], type: 'spherical', limits: { x: [-1.8, 0.4], y: [-0.5, 0.5], z: [-0.8, 0.3] } },
    ],
  };
}

test('BEHAVIOURS vocabulary', () => {
  for (const k of ['balance', 'stagger', 'catchFall', 'protectHead', 'death', 'bodyWrithe', 'shot', 'limp']) assert.ok(BEHAVIOURS[k], k);
});

test('humanoidRig: roles, bodies, joints', () => {
  const r = humanoidRig({ bounds: { min: [-0.3, 0, -0.15], max: [0.3, 1.8, 0.15] } });
  const names = r.bodies.map((b) => b.name);
  for (const n of ['head', 'torso', 'pelvis', 'armL', 'armR', 'foreArmL', 'foreArmR', 'legL', 'legR', 'shinL', 'shinR']) assert.ok(names.includes(n), n);
  assert.equal(r.joints.length, names.length - 1);
  assert.ok(Math.abs(r.bodies.reduce((a, b) => a + b.mass, 0) - 70) < 1e-6);
});

test('balance: stands idle 5 s (pelvis height held)', (t) => {
  const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'balance', seed: 1 });
  const y0 = y(h, 'pelvis'); let lo = y0;
  for (let i = 0; i < 300; i++) { m.step(DT); lo = Math.min(lo, y(h, 'pelvis')); }
  t.diagnostic(`pelvis y0=${y0.toFixed(3)} min=${lo.toFixed(3)} phase=${h.phase}`);
  assert.equal(h.phase, 'stand'); assert.ok(lo > y0 - 0.05);
  m.dispose();
});

test('stagger: small impulse recovers (pelvis > 0.75 m), big impulse falls (pelvis < 0.35 m)', (t) => {
  const run = (mag) => {
    const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'stagger', seed: 2, impulse: { body: 'all', dir: [0, 0, 1], magnitude: mag } });
    let lo = 9; for (let i = 0; i < 240; i++) { m.step(DT); lo = Math.min(lo, y(h, 'pelvis')); }
    const r = { lo, end: y(h, 'pelvis'), phase: h.phase, steps: h.state().steps }; m.dispose(); return r;
  };
  const small = run(25), big = run(200);
  t.diagnostic(`25 N·s: min pelvis ${small.lo.toFixed(3)} phase ${small.phase} steps ${small.steps} | 200 N·s: end pelvis ${big.end.toFixed(3)} phase ${big.phase}`);
  assert.equal(small.phase, 'stand'); assert.ok(small.lo > 0.75);
  assert.notEqual(big.phase, 'stand'); assert.ok(big.end < 0.35);
});

test('stagger: mid push takes ≥1 recovery step', (t) => {
  const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'stagger', seed: 2, impulse: { body: 'all', dir: [0, 0, 1], magnitude: 40 } });
  let lo = 9; for (let i = 0; i < 240; i++) { m.step(DT); lo = Math.min(lo, y(h, 'pelvis')); }
  t.diagnostic(`40 N·s fwd: steps ${h.state().steps} phase ${h.phase} min pelvis ${lo.toFixed(3)}`);
  assert.ok(h.state().steps >= 1); assert.equal(h.phase, 'stand');
  m.dispose();
});

test('death: motors decay monotonically to 0, body falls and rests (asleep) < 4 s', (t) => {
  const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'death', seed: 3 });
  const str = []; let restT = null;
  for (let i = 0; i < 360; i++) {
    m.step(DT); if (i % 12 === 0) str.push(h.state().strength);
    if (restT == null && h.asleep) restT = (i + 1) * DT;
  }
  t.diagnostic(`strength samples ${str.slice(0, 12).map((s) => s.toFixed(2)).join(' ')} | asleep at ${restT?.toFixed(2)} s | pelvis ${y(h, 'pelvis').toFixed(3)} head ${y(h, 'head').toFixed(3)}`);
  for (let i = 1; i < str.length; i++) assert.ok(str[i] <= str[i - 1] + 1e-9);
  assert.equal(str.at(-1), 0);
  assert.ok(restT != null && restT < 4, `rest ${restT}`);
  assert.ok(y(h, 'pelvis') < 0.35 && y(h, 'head') < 0.35);
  m.dispose();
});

test('catchFall: hands reach the ground before the head', (t) => {
  const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'catchFall', seed: 4, impulse: { body: 'all', dir: [0, 0, 1], magnitude: 150 } });
  let tHand = null, tHead = null;
  for (let i = 0; i < 240; i++) {
    m.step(DT); const tr = h.transforms();
    if (tHand == null && Math.min(tr.get('foreArmL').p[1], tr.get('foreArmR').p[1]) < 0.12) tHand = i * DT;
    if (tHead == null && tr.get('head').p[1] < 0.2) tHead = i * DT;
  }
  t.diagnostic(`hands <0.12 m at ${tHand?.toFixed(2)} s, head <0.2 m at ${tHead?.toFixed(2)} s`);
  assert.ok(tHand != null && (tHead == null || tHand < tHead));
  m.dispose();
});

test('protectHead: forearms come within 0.3 m of head while falling (limp baseline farther)', (t) => {
  const run = (beh) => {
    const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: beh, seed: 5, impulse: { body: 'all', dir: [0, 0, -1], magnitude: 150 } });
    let best = 9;
    for (let i = 0; i < 90; i++) { m.step(DT); const tr = h.transforms(); const hd = tr.get('head').p; best = Math.min(best, dist(hd, tr.get('foreArmL').p), dist(hd, tr.get('foreArmR').p)); }
    m.dispose(); return best;
  };
  const prot = run('protectHead'), limp = run('limp');
  t.diagnostic(`min forearm–head: protectHead ${prot.toFixed(3)} m vs limp ${limp.toFixed(3)} m`);
  assert.ok(prot < 0.3); assert.ok(prot < limp - 0.1);
});

test('shot: local impulse + flinch → stagger; lethal → death', (t) => {
  const m = scene();
  const a = m.spawn(humanoidRig({}), { position: [0, 0, 0], behaviour: 'shot', seed: 6, params: { lethal: false }, impulse: { body: 'torso', dir: [0, 0, -1], magnitude: 8 } });
  const b = m.spawn(humanoidRig({}), { position: [3, 0, 0], behaviour: 'shot', seed: 6, params: { lethal: true }, impulse: { body: 'torso', dir: [0, 0, -1], magnitude: 8 } });
  const seen = new Set();
  for (let i = 0; i < 300; i++) { m.step(DT); seen.add(a.behaviour + ':' + a.phase); }
  t.diagnostic(`non-lethal path ${[...seen].join(' → ')} | lethal end ${b.behaviour}/${b.phase}`);
  assert.ok(seen.has('stagger:stand') || seen.has('balance:stand'));
  assert.equal(b.phase, 'dead');
  m.dispose();
});

test('breakJoint: detached piece separates and stays simulated', (t) => {
  const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'death', seed: 7 });
  for (let i = 0; i < 10; i++) m.step(DT);
  const r = h.breakJoint('neck');
  assert.equal(r.body, 'head'); assert.equal(r.velocity.length, 3);
  h._h.B.find((b) => b.name === 'head').rb.applyImpulse({ x: 0, y: 2, z: 1.5 }, true);
  for (let i = 0; i < 90; i++) m.step(DT);
  const tr = h.transforms(); const d = dist(tr.get('head').p, tr.get('torso').p);
  t.diagnostic(`head–torso distance after break: ${d.toFixed(3)} m (bind ~0.26)`);
  assert.ok(d > 0.4);
  assert.equal(h.breakJoint('neck'), null);
  m.dispose();
});

test('determinism: same seed + inputs → bit-identical transforms', () => {
  const run = () => {
    const m = scene(); const h = m.spawn(humanoidRig({}), { behaviour: 'stagger', seed: 9, impulse: { body: 'all', dir: [0.6, 0, 0.8], magnitude: 45 } });
    for (let i = 0; i < 180; i++) m.step(DT);
    const out = [...h.transforms()].map(([n, v]) => n + v.p.join() + v.q.join()).join('|'); m.dispose(); return out;
  };
  assert.equal(run(), run());
});

test('EE 6-body rig (head/torso/armL/armR/legL/legR, no pelvis): roles resolve, death falls, balance holds 3 s', (t) => {
  const m = scene();
  const d = m.spawn(eeRig(), { position: [0, 0, 0], behaviour: 'death', seed: 1 });
  const b = m.spawn(eeRig(), { position: [3, 0, 0], behaviour: 'balance', seed: 1 });
  assert.equal(b._h.roles.pelvis, 'torso'); assert.equal(b._h.roles.upperArmL, 'armL'); assert.equal(b._h.roles.thighR, 'legR');
  for (let i = 0; i < 180; i++) m.step(DT);
  t.diagnostic(`death torso y ${y(d, 'torso').toFixed(3)} (${d.phase}) | balance torso y ${y(b, 'torso').toFixed(3)} (${b.phase})`);
  assert.ok(y(d, 'torso') < 0.4); assert.equal(b.phase, 'stand'); assert.ok(y(b, 'torso') > 1.0);
  m.dispose();
});

test('LOD: over maxActive → oldest go passive limp', () => {
  const m = scene({ maxActive: 4 });
  const hs = []; for (let i = 0; i < 8; i++) hs.push(m.spawn(humanoidRig({}), { position: [i * 1.5, 0, 0], behaviour: 'balance', seed: i }));
  m.step(DT);
  const dg = m.diagnostics();
  assert.equal(dg.active, 4); assert.equal(dg.passive, 4);
  assert.ok(hs[0].passive && !hs[7].passive);
  m.dispose();
});

test('budget: 16 active ragdolls — ms per 60 Hz step', (t) => {
  const m = scene();
  const rig = humanoidRig({});
  for (let i = 0; i < 16; i++) m.spawn(rig, { position: [(i % 8) * 1.5 - 6, 0, Math.floor(i / 8) * 1.5], behaviour: i % 2 ? 'balance' : 'stagger', seed: i, impulse: i % 2 ? undefined : { body: 'all', dir: [0, 0, 1], magnitude: 30 } });
  for (let i = 0; i < 30; i++) m.step(DT); // warm-up (JIT)
  const ts = []; for (let i = 0; i < 300; i++) { const t0 = performance.now(); m.step(DT); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b); const avg = ts.reduce((a, b) => a + b) / ts.length;
  t.diagnostic(`16 ragdolls × ${m.diagnostics().bodies / 16} bodies, ${m.config.substeps} substeps: avg ${avg.toFixed(2)} ms/step, p50 ${ts[150].toFixed(2)}, p95 ${ts[285].toFixed(2)}, max ${ts[299].toFixed(2)} (active ${m.diagnostics().active})`);
  assert.ok(avg < 16);
  m.dispose();
});
