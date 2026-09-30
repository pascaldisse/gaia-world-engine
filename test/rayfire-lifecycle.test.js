// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §12 activation, §13 fade lifecycle, §14 bomb & gun impulses; §16 #37.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivationState, shouldActivate, activate } from '../client/extensions/rayfire/activation.js';
import { createFadeState, tickFade, FadeType, FADE_DEFAULTS } from '../client/extensions/rayfire/fade.js';
import { explode, shoot } from '../client/extensions/rayfire/impulses.js';
import { RFWorld } from '../client/extensions/rayfire/world.js';

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const sph = r => ({ type: 'sphere', radius: r });

// ---- §12 -----------------------------------------------------------------------------------------
test('createActivationState: trigger fields default 0/false; stored as given', () => {
  const s = createActivationState();
  assert.deepEqual([s.off, s.vel, s.dmg, s.con, s.uny, s.atb, s.activated], [0, 0, 0, false, false, false, false]);
  const t = createActivationState({ off: 2, vel: 3, dmg: 4, con: true, uny: true, atb: true });
  assert.deepEqual([t.off, t.vel, t.dmg, t.con, t.uny, t.atb], [2, 3, 4, true, true, true]);
});

test('shouldActivate: every trigger alone; nothing enabled -> never; already activated -> never; protected unyielding -> never', () => {
  const body = { position: v(0, 0, 0), velocity: v(0, 0, 0) };
  assert.equal(shouldActivate(createActivationState({}), body, { connectivityLost: true, damage: 1e9 }), false, 'no trigger enabled');
  // velocity
  const sv = createActivationState({ vel: 2 });
  assert.equal(shouldActivate(sv, { position: v(), velocity: v(0, 2, 0) }, {}), false, 'speed must EXCEED');
  assert.equal(shouldActivate(sv, { position: v(), velocity: v(0, 2.1, 0) }, {}), true);
  assert.equal(shouldActivate(sv, { position: v(), velocity: v(1.5, 1.5, 0) }, {}), true, 'magnitude, not one axis');
  // offset from stored original position (captured at first look)
  const so = createActivationState({ off: 1 });
  assert.equal(shouldActivate(so, { position: v(5, 5, 5), velocity: v() }, {}), false, 'first look records the origin');
  assert.equal(shouldActivate(so, { position: v(5.9, 5, 5), velocity: v() }, {}), false);
  assert.equal(shouldActivate(so, { position: v(6.2, 5, 5), velocity: v() }, {}), true);
  // damage
  const sd = createActivationState({ dmg: 10 });
  assert.equal(shouldActivate(sd, body, { damage: 9.99 }), false);
  assert.equal(shouldActivate(sd, body, { damage: 10 }), true, 'reaches');
  assert.equal(shouldActivate(sd, body, {}), false, 'no damage supplied');
  // connectivity
  const sc = createActivationState({ con: true });
  assert.equal(shouldActivate(sc, body, {}), false);
  assert.equal(shouldActivate(sc, body, { connectivityLost: false }), false);
  assert.equal(shouldActivate(sc, body, { connectivityLost: true }), true);
  // con:false ignores connectivityLost
  assert.equal(shouldActivate(createActivationState({ vel: 100 }), body, { connectivityLost: true }), false);
  // protected unyielding never; unyielding + atb may
  assert.equal(shouldActivate(createActivationState({ con: true, uny: true }), body, { connectivityLost: true }), false);
  assert.equal(shouldActivate(createActivationState({ con: true, uny: true, atb: true }), body, { connectivityLost: true }), true);
  const done = createActivationState({ con: true }); done.activated = true;
  assert.equal(shouldActivate(done, body, { connectivityLost: true }), false);
});

test('activate: kinematic->dynamic, wakes, small SEEDED spin only if perfectly still; idempotent; refuses protected', () => {
  const w = new RFWorld({ gravity: v(0, 0, 0) });
  const id = w.addBody({ position: v(0, 5, 0), shape: sph(1), kinematic: true });
  const st = createActivationState({ con: true, seed: 7 });
  assert.equal(activate(st, w, id), true);
  const b = w.getBody(id);
  assert.equal(b.kinematic, false); assert.equal(b.awake, true); assert.equal(st.activated, true);
  const spin = [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z];
  assert.ok(spin.some(x => x !== 0), 'a perfectly still body gets a tumble');
  assert.ok(spin.every(x => Math.abs(x) <= 0.3 + 1e-12));
  assert.equal(activate(st, w, id), false, 'idempotent');
  assert.deepEqual([b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z], spin, 'second call must not re-roll');
  // deterministic per (seed, body)
  const w2 = new RFWorld(); const id2 = w2.addBody({ position: v(0, 5, 0), shape: sph(1), kinematic: true });
  const st2 = createActivationState({ con: true, seed: 7 }); activate(st2, w2, id2);
  assert.deepEqual(w2.getBody(id2).angularVelocity, w.getBody(id).angularVelocity);
  const w3 = new RFWorld(); const id3 = w3.addBody({ position: v(0, 5, 0), shape: sph(1), kinematic: true });
  activate(createActivationState({ con: true, seed: 8 }), w3, id3);
  assert.notDeepEqual(w3.getBody(id3).angularVelocity, w.getBody(id).angularVelocity);
  // already moving -> no extra spin
  const id4 = w.addBody({ position: v(0, 5, 0), shape: sph(1), kinematic: true, velocity: v(0, 1, 0) });
  activate(createActivationState({ con: true }), w, id4);
  assert.deepEqual(w.getBody(id4).angularVelocity, v(0, 0, 0));
  // protected / missing body
  const id5 = w.addBody({ position: v(), shape: sph(1), kinematic: true });
  const prot = createActivationState({ uny: true }); assert.equal(activate(prot, w, id5), false); assert.equal(w.getBody(id5).kinematic, true);
  assert.equal(activate(createActivationState({}), w, 9999), false);
});

// ---- §13 -----------------------------------------------------------------------------------------
test('FADE_DEFAULTS fadeTime 5 lifeTime 7 lifeVariation 3; FadeType members frozen', () => {
  assert.deepEqual({ ...FADE_DEFAULTS }, { fadeType: FadeType.SCALE_DOWN, fadeTime: 5, lifeTime: 7, lifeVariation: 3 });
  assert.deepEqual({ ...FadeType }, { NONE: 'none', DESTROY: 'destroy', SCALE_DOWN: 'scaleDown' });
  assert.ok(Object.isFrozen(FadeType) && Object.isFrozen(FADE_DEFAULTS));
});

test('createFadeState: deterministic per seed, decorrelated across seeds; fresh state living/scale 1', () => {
  const a = createFadeState(5), b = createFadeState(5), c = createFadeState(6);
  assert.deepEqual(a, b);
  assert.notEqual(a.roll, c.roll);
  assert.deepEqual([a.phase, a.scale, a.removed, a.age], ['living', 1, false, 0]);
  assert.ok(a.roll >= 0 && a.roll < 1);
});

test('#37 SCALE_DOWN: full scale during life, then linear 1 - t/fadeTime, then scale 0 + removed', () => {
  const s = createFadeState(3);
  const opts = { fadeType: FadeType.SCALE_DOWN, fadeTime: 4, lifeTime: 2, lifeVariation: 0 };
  tickFade(s, 1, opts); assert.equal(s.scale, 1); assert.equal(s.removed, false); assert.equal(s.phase, 'living');
  tickFade(s, 1, opts); assert.equal(s.scale, 1, 'lifetime exactly elapsed, fade not started');
  tickFade(s, 1, opts); assert.ok(Math.abs(s.scale - 0.75) < 1e-12); assert.equal(s.phase, 'fading');
  tickFade(s, 1, opts); assert.ok(Math.abs(s.scale - 0.5) < 1e-12);
  tickFade(s, 1, opts); assert.ok(Math.abs(s.scale - 0.25) < 1e-12); assert.equal(s.removed, false);
  const r = tickFade(s, 1, opts);
  assert.equal(r, s, 'returns the mutated state');
  assert.equal(s.scale, 0); assert.equal(s.removed, true); assert.equal(s.phase, 'faded');
  tickFade(s, 10, opts); assert.equal(s.scale, 0); assert.equal(s.removed, true);
});

test('#37 SCALE_DOWN run to completion with defaults reaches scale 0 + removed; lifetime jitter within lifeTime +/- lifeVariation', () => {
  const life = [];
  for (let seed = 0; seed < 40; seed++) {
    const s = createFadeState(seed); let t = 0, firstFade = -1;
    while (!s.removed && t < 100) { tickFade(s, 0.05, { fadeType: FadeType.SCALE_DOWN }); t += 0.05; if (firstFade < 0 && s.scale < 1) firstFade = t; }
    assert.equal(s.removed, true); assert.equal(s.scale, 0);
    life.push(firstFade);
  }
  assert.ok(Math.min(...life) >= 4 - 0.11 && Math.max(...life) <= 10 + 0.11, `fade starts within 7+-3s: ${Math.min(...life)}..${Math.max(...life)}`);
  assert.ok(Math.max(...life) - Math.min(...life) > 1, 'jitter actually varies');
});

test('#37 NONE: scale stays 1 and removed stays false forever (no-op)', () => {
  const s = createFadeState(1);
  for (let i = 0; i < 2000; i++) tickFade(s, 1, { fadeType: FadeType.NONE, lifeTime: 0, lifeVariation: 0, fadeTime: 0.1 });
  assert.equal(s.scale, 1); assert.equal(s.removed, false); assert.equal(s.phase, 'living');
});

test('DESTROY: pops (removed) right after the seeded jittered lifetime; scale unaffected before', () => {
  const s = createFadeState(2);
  const opts = { fadeType: FadeType.DESTROY, lifeTime: 3, lifeVariation: 0, fadeTime: 100 };
  tickFade(s, 2.9, opts); assert.equal(s.removed, false); assert.equal(s.scale, 1);
  tickFade(s, 0.2, opts); assert.equal(s.removed, true);
});

test('consumer call shape (lifeTime 0, variation 0, fadeTime 0.5): fades linearly from the first tick, deterministic', () => {
  const a = createFadeState(9), b = createFadeState(9);
  const o = { fadeType: FadeType.SCALE_DOWN, fadeTime: 0.5, lifeTime: 0, lifeVariation: 0 };
  const sa = [], sb = [];
  for (let i = 0; i < 40 && !a.removed; i++) { tickFade(a, 0.016, o); sa.push(a.scale); }
  for (let i = 0; i < 40 && !b.removed; i++) { tickFade(b, 0.016, o); sb.push(b.scale); }
  assert.deepEqual(sa, sb);
  assert.ok(sa[0] < 1 && sa[0] > 0.9);
  assert.equal(a.removed, true);
  for (let i = 1; i < sa.length; i++) assert.ok(sa[i] <= sa[i - 1]);
});

// ---- §14 -----------------------------------------------------------------------------------------
function bombField() {
  const w = new RFWorld({ gravity: v(0, 0, 0) });
  const frags = [];
  for (const [x, mass] of [[1, 1], [3, 1], [4.9, 1], [6, 1], [2, 4]]) { const id = w.addBody({ position: v(x, 0, 0), shape: sph(0.2), mass }); frags.push({ bodyId: id }); }
  return { w, frags };
}

test('explode: only fragments within range affected; outward direction; falls off with distance; returns affected list', () => {
  const { w, frags } = bombField();
  const aff = explode(w, frags, v(0, 0, 0), { range: 5, strength: 1, variation: 0, chaos: 0, forceByMass: false, seed: 1 });
  assert.deepEqual(aff.map(a => a.index), [0, 1, 2, 4]);
  const vel = i => w.getBody(frags[i].bodyId).velocity;
  assert.equal(vel(3).x, 0, 'outside range untouched');
  assert.ok(vel(0).x > vel(1).x && vel(1).x > vel(2).x && vel(2).x > 0, 'closer = stronger, all outward (+x)');
  assert.ok(Math.abs(vel(0).y) < 1e-12 && Math.abs(vel(0).z) < 1e-12);
  // reference: strength*(1 - d/range)*10 with variation 0
  assert.ok(Math.abs(vel(0).x - 1 * (1 - 1 / 5) * 10) < 1e-9);
  for (const a of aff) { assert.ok(a.distance <= 5); assert.ok(a.magnitude > 0); assert.equal(typeof a.bodyId, 'number'); }
});

test('explode: forceByMass selects impulse (mass-scaled) vs velocityChange; variation seeded [strength, strength+var%]; chaos spin bounded; deterministic', () => {
  const a = bombField(), b = bombField();
  explode(a.w, a.frags, v(0, 0, 0), { range: 10, variation: 0, chaos: 0, forceByMass: true });
  explode(b.w, b.frags, v(0, 0, 0), { range: 10, variation: 0, chaos: 0, forceByMass: false });
  const heavyA = a.w.getBody(a.frags[4].bodyId).velocity.x, lightA = a.w.getBody(a.frags[0].bodyId).velocity.x;
  assert.ok(lightA > 0 && heavyA > 0);
  // fragment 4 is mass 4 at d=2, fragment 0 mass 1 at d=1 -> forceByMass:false ignores mass
  const dv = (bf, i, d) => bf.w.getBody(bf.frags[i].bodyId).velocity.x / (1 - d / 10);
  assert.ok(Math.abs(dv(b, 4, 2) - dv(b, 0, 1)) < 1e-9, 'velocityChange is mass independent');
  assert.ok(Math.abs(dv(a, 4, 2) * 4 - dv(a, 0, 1)) < 1e-9, 'impulse mode divides by mass');
  const s1 = bombField(), s2 = bombField(), s3 = bombField();
  const o = { range: 10, variation: 50, chaos: 30, seed: 4 };
  explode(s1.w, s1.frags, v(0, 0, 0), o); explode(s2.w, s2.frags, v(0, 0, 0), o); explode(s3.w, s3.frags, v(0, 0, 0), { ...o, seed: 5 });
  const snap = s => JSON.stringify(s.frags.map(f => s.w.getBody(f.bodyId)));
  assert.equal(snap(s1), snap(s2)); assert.notEqual(snap(s1), snap(s3));
  for (const f of s1.frags) { const w = s1.w.getBody(f.bodyId).angularVelocity; for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(w[k]) <= (30 / 2) * Math.PI / 180 + 1e-12); }
  assert.ok(s1.frags.some(f => { const w = s1.w.getBody(f.bodyId).angularVelocity; return w.x !== 0 || w.y !== 0 || w.z !== 0; }), 'chaos adds spin');
  // strength scales magnitude linearly
  const t1 = bombField(), t2 = bombField();
  explode(t1.w, t1.frags, v(0, 0, 0), { range: 10, variation: 0, chaos: 0, strength: 1 }); explode(t2.w, t2.frags, v(0, 0, 0), { range: 10, variation: 0, chaos: 0, strength: 3 });
  assert.ok(Math.abs(t2.w.getBody(t2.frags[0].bodyId).velocity.x - 3 * t1.w.getBody(t1.frags[0].bodyId).velocity.x) < 1e-9);
});

test('explode: skips fragments without a live/dynamic body; centred-on-body falls back to up; empty list ok', () => {
  const w = new RFWorld({ gravity: v(0, 0, 0) });
  const k = w.addBody({ position: v(1, 0, 0), shape: sph(0.2), kinematic: true });
  const d = w.addBody({ position: v(0, 0, 0), shape: sph(0.2) });
  const aff = explode(w, [{ bodyId: k }, { bodyId: 12345 }, {}, { bodyId: d }], v(0, 0, 0), { variation: 0, chaos: 0 });
  assert.deepEqual(aff.map(a => a.index), [3]);
  assert.ok(w.getBody(d).velocity.y > 0, 'coincident with the blast: pushed up, not NaN');
  assert.deepEqual(explode(w, [], v(), {}), []);
});

test('shoot: raycast then strength-magnitude velocityChange along the ray; miss -> null; maxDistance; kinematic hit ignored by world', () => {
  const w = new RFWorld({ gravity: v(0, 0, 0) });
  const near = w.addBody({ position: v(0, 0, 10), shape: sph(1), mass: 50 });
  const far = w.addBody({ position: v(0, 0, 20), shape: sph(1), mass: 50 });
  const r = shoot(w, v(0, 0, 0), v(0, 0, 3), { strength: 10 });
  assert.equal(r.hit.id, near);
  assert.deepEqual([r.impulse.x, r.impulse.y, r.impulse.z], [0, 0, 10]);
  assert.ok(Math.abs(w.getBody(near).velocity.z - 10) < 1e-12, 'velocityChange: mass independent (mass 50)');
  assert.equal(w.getBody(far).velocity.z, 0);
  assert.equal(shoot(w, v(5, 0, 0), v(0, 0, 1), {}), null);
  assert.equal(shoot(w, v(0, 0, 0), v(0, 0, 1), { maxDistance: 5 }), null);
  const d = shoot(w, v(0, 0, 0), v(0, 0, 1), {});
  assert.ok(Math.abs(d.impulse.z - 10) < 1e-12, 'default strength 10');
});
