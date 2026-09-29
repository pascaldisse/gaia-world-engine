// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §6 rigid sim + §16 #18-20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RFWorld, RF_WORLD_DEFAULTS } from '../client/extensions/rayfire/world.js';

const sph = r => ({ type: 'sphere', radius: r });
const v = (x = 0, y = 0, z = 0) => ({ x, y, z });

test('defaults: gravity -9.81, ground 0, sleep .02/10, restitution .05, friction .6; ctor overrides', () => {
  assert.deepEqual({ ...RF_WORLD_DEFAULTS, gravity: { ...RF_WORLD_DEFAULTS.gravity } }, { gravity: v(0, -9.81, 0), groundY: 0, sleepLinear: 0.02, sleepFrames: 10, restitution: 0.05, friction: 0.6 });
  const w = new RFWorld();
  assert.deepEqual(w.gravity, v(0, -9.81, 0)); assert.equal(w.groundY, 0);
  const w2 = new RFWorld({ gravity: v(0, -1, 0), groundY: 2, restitution: 0.5, friction: 0, sleepFrames: 3, sleepLinear: 0.1 });
  assert.equal(w2.groundY, 2); assert.equal(w2.gravity.y, -1);
  assert.ok(w.bodies instanceof Map && w.bodies.size === 0);
});

test('ids strictly increasing, never reused after removal; removeBody boolean; getBody live/undefined', () => {
  const w = new RFWorld();
  const a = w.addBody({ position: v(0, 5, 0), shape: sph(1) }), b = w.addBody({ position: v(0, 5, 0), shape: sph(1) });
  assert.ok(b > a);
  assert.equal(w.removeBody(a), true);
  assert.equal(w.removeBody(a), false);
  assert.equal(w.getBody(a), undefined);
  const c = w.addBody({ position: v(0, 5, 0), shape: sph(1) });
  assert.ok(c > b, 'id reused');
  assert.equal(w.bodies.size, 2);
  const live = w.getBody(b); live.position.x = 9;
  assert.equal(w.getBody(b).position.x, 9, 'getBody returns the live object');
});

test('addBody validates shape/mass and fills body fields', () => {
  const w = new RFWorld();
  assert.throws(() => w.addBody({ position: v() }), /shape/);
  assert.throws(() => w.addBody({ position: v(), shape: { type: 'cone' } }), /shape/);
  assert.throws(() => w.addBody({ position: v(), shape: sph(1), mass: 0 }), /mass/);
  const id = w.addBody({ position: v(1, 2, 3), shape: { type: 'obb', halfExtents: v(1, 2, 3) }, mass: 4 });
  const b = w.getBody(id);
  assert.deepEqual(Object.keys(b).sort(), ['angularVelocity', 'awake', 'id', 'kinematic', 'mass', 'position', 'rotation', 'shape', 'sleepCounter', 'velocity'].sort());
  assert.equal(b.mass, 4); assert.equal(b.awake, true); assert.equal(b.kinematic, false); assert.equal(b.sleepCounter, 0);
  const src = v(1, 1, 1); const id2 = w.addBody({ position: src, shape: sph(1) }); src.x = 99;
  assert.equal(w.getBody(id2).position.x, 1, 'position is copied, not aliased');
});

test('#18 sphere dropped above ground settles ON the plane (±0.05), then SLEEPS; never below ground; at dt 1/60, 0.05 and 0.005', () => {
  for (const dt of [1 / 60, 0.05, 0.005]) {
    const w = new RFWorld();
    const id = w.addBody({ position: v(0, 6, 0), shape: sph(0.5), mass: 2 });
    let minBottom = Infinity, slept = -1;
    for (let i = 0; i < 20000 && slept < 0; i++) {
      w.step(dt);
      const b = w.getBody(id); minBottom = Math.min(minBottom, b.position.y - 0.5);
      if (!b.awake) slept = i;
    }
    const b = w.getBody(id);
    assert.ok(slept >= 0, `never slept at dt=${dt}`);
    assert.ok(minBottom >= -1e-9, `fell through ground at dt=${dt}: ${minBottom}`);
    assert.ok(Math.abs(b.position.y - 0.5) < 0.05, `not resting on plane: y=${b.position.y}`);
    assert.deepEqual([b.velocity.x, b.velocity.y, b.velocity.z, b.angularVelocity.x], [0, 0, 0, 0], 'sleeping body has zero velocity');
  }
});

test('#18b fast fall cannot tunnel through the ground; OBB uses halfExtents.y; custom groundY', () => {
  const w = new RFWorld({ groundY: 3 });
  const s = w.addBody({ position: v(0, 4, 0), shape: sph(0.25), velocity: v(0, -500, 0) });
  const o = w.addBody({ position: v(1, 10, 0), shape: { type: 'obb', halfExtents: v(1, 0.4, 1) } });
  for (let i = 0; i < 400; i++) w.step(1 / 60);
  assert.ok(w.getBody(s).position.y >= 3.25 - 1e-9);
  assert.ok(Math.abs(w.getBody(o).position.y - 3.4) < 0.05);
});

test('sleep: needs `sleepFrames` consecutive slow steps ON the ground; a slow body in free fall never sleeps; sleeping body is skipped', () => {
  const w = new RFWorld({ gravity: v(0, 0, 0), sleepFrames: 3 });
  const id = w.addBody({ position: v(0, 50, 0), shape: sph(1), velocity: v(0.001, 0, 0) });
  for (let i = 0; i < 100; i++) w.step(0.01);
  assert.equal(w.getBody(id).awake, true, 'mid-air (no ground contact) must not sleep');
  const g = new RFWorld({ sleepFrames: 4 });
  const b = g.addBody({ position: v(0, 1, 0), shape: sph(1) });      // resting exactly on the plane
  let steps = 0; while (g.getBody(b).awake && steps < 100) { g.step(1 / 60); steps++; }
  assert.ok(steps >= 4 && steps <= 8, `slept after ${steps} steps`);
  const p = { ...g.getBody(b).position };
  g.step(1 / 60); assert.deepEqual(g.getBody(b).position, p, 'sleeping body does not integrate');
});

test('#19 applyImpulse: default mass-dependent (10 on mass 10 -> dv 1), velocityChange mass-independent (dv 10); wakes; kinematic ignores', () => {
  const w = new RFWorld({ gravity: v(0, 0, 0) });
  const a = w.addBody({ position: v(0, 5, 0), shape: sph(1), mass: 10 });
  const b = w.addBody({ position: v(0, 5, 0), shape: sph(1), mass: 10 });
  w.applyImpulse(a, v(10, 0, 0));
  w.applyImpulse(b, v(10, 0, 0), 'velocityChange');
  assert.ok(Math.abs(w.getBody(a).velocity.x - 1) < 1e-12);
  assert.ok(Math.abs(w.getBody(b).velocity.x - 10) < 1e-12);
  w.applyImpulse(a, v(10, 0, 0), 'impulse');
  assert.ok(Math.abs(w.getBody(a).velocity.x - 2) < 1e-12, 'impulses accumulate');
  assert.throws(() => w.applyImpulse(a, v(1, 0, 0), 'bogus'), /mode/);
  const k = w.addBody({ position: v(), shape: sph(1), kinematic: true });
  w.applyImpulse(k, v(5, 5, 5), 'velocityChange');
  assert.deepEqual(w.getBody(k).velocity, v(0, 0, 0));
  const s = new RFWorld(); const sid = s.addBody({ position: v(0, 1, 0), shape: sph(1) });
  while (s.getBody(sid).awake) s.step(1 / 60);
  s.applyImpulse(sid, v(0, 3, 0), 'velocityChange');
  assert.equal(s.getBody(sid).awake, true); assert.equal(s.getBody(sid).sleepCounter, 0);
  assert.doesNotThrow(() => s.applyImpulse(9999, v(1, 1, 1)));
});

test('applyAngularVelocity sets (not adds) on dynamic, wakes; kinematic ignored; rotation integrates', () => {
  const w = new RFWorld({ gravity: v(0, 0, 0) });
  const a = w.addBody({ position: v(0, 9, 0), shape: sph(1) });
  w.applyAngularVelocity(a, v(0, 2, 0)); w.applyAngularVelocity(a, v(0, 3, 0));
  assert.equal(w.getBody(a).angularVelocity.y, 3);
  for (let i = 0; i < 10; i++) w.step(0.1);
  assert.ok(Math.abs(w.getBody(a).rotation.y - 3) < 1e-9);
  const k = w.addBody({ position: v(), shape: sph(1), kinematic: true });
  w.applyAngularVelocity(k, v(1, 1, 1)); assert.deepEqual(w.getBody(k).angularVelocity, v());
});

test('kinematic bodies are neither integrated nor ground-clamped; flipping kinematic=false makes them fall', () => {
  const w = new RFWorld();
  const k = w.addBody({ position: v(0, -3, 0), shape: sph(1), kinematic: true, velocity: v(1, 1, 1) });
  for (let i = 0; i < 30; i++) w.step(1 / 60);
  assert.deepEqual(w.getBody(k).position, v(0, -3, 0));
  w.getBody(k).kinematic = false;
  w.step(1 / 60);
  assert.ok(w.getBody(k).position.y >= 1 - 1e-9, 'once dynamic it is clamped to rest on the plane');
});

test('ground contact: restitution reflects impact speed; friction damps horizontal+angular only while in contact', () => {
  const w = new RFWorld({ restitution: 0.5, gravity: v(0, -10, 0) });
  const id = w.addBody({ position: v(0, 1.0, 0), shape: sph(1), velocity: v(0, -8, 0) });
  w.step(1 / 60);
  assert.ok(Math.abs(w.getBody(id).velocity.y - 4) < 0.3, `bounce vy=${w.getBody(id).velocity.y}`);
  const f = new RFWorld({ friction: 0.6 });
  const air = f.addBody({ position: v(0, 100, 0), shape: sph(1), velocity: v(5, 0, 0) });
  const gnd = f.addBody({ position: v(20, 1, 0), shape: sph(1), velocity: v(5, 0, 0), angularVelocity: v(0, 4, 0) });
  for (let i = 0; i < 30; i++) f.step(1 / 60);
  assert.equal(f.getBody(air).velocity.x, 5, 'no drag in the air');
  assert.ok(f.getBody(gnd).velocity.x < 5 && f.getBody(gnd).velocity.x > 0);
  assert.ok(f.getBody(gnd).angularVelocity.y < 4);
});

test('step is deterministic and ignores non-positive / NaN dt', () => {
  const run = () => { const w = new RFWorld(); const id = w.addBody({ position: v(1, 9, 2), shape: sph(0.3), velocity: v(1, 2, 3), angularVelocity: v(1, 0, 1) }); for (let i = 0; i < 200; i++) w.step(1 / 60); return JSON.stringify(w.getBody(id)); };
  assert.equal(run(), run());
  const w = new RFWorld(); const id = w.addBody({ position: v(0, 9, 0), shape: sph(1) });
  for (const dt of [0, -1, NaN, undefined]) w.step(dt);
  assert.deepEqual(w.getBody(id).position, v(0, 9, 0));
});

test('#20 raycast: two spheres along a ray -> NEARER id; miss/maxDistance/behind -> null; direction normalised', () => {
  const w = new RFWorld();
  const far = w.addBody({ position: v(0, 5, 20), shape: sph(1), kinematic: true });
  const near = w.addBody({ position: v(0, 5, 10), shape: sph(1), kinematic: true });
  const h = w.raycast(v(0, 5, 0), v(0, 0, 1), 100);
  assert.equal(h.id, near);
  assert.ok(Math.abs(h.distance - 9) < 1e-9);
  assert.deepEqual([h.point.x, h.point.y, Math.round(h.point.z * 1e9) / 1e9], [0, 5, 9]);
  assert.ok(Math.abs(h.normal.z + 1) < 1e-9 && Math.abs(Math.hypot(h.normal.x, h.normal.y, h.normal.z) - 1) < 1e-9);
  assert.equal(w.raycast(v(0, 5, 0), v(0, 0, 40), 100).id, near, 'non-unit direction normalised');
  assert.equal(w.raycast(v(0, 5, 0), v(0, 0, 1), 5), null, 'beyond maxDistance');
  assert.equal(w.raycast(v(0, 5, 0), v(0, 0, -1), 100), null, 'behind origin');
  assert.equal(w.raycast(v(3, 5, 0), v(0, 0, 1), 100), null, 'misses');
  assert.equal(w.raycast(v(0, 5, 0), v(0, 0, 0), 100), null, 'zero direction');
  w.removeBody(near);
  assert.equal(w.raycast(v(0, 5, 0), v(0, 0, 1), 100).id, far);
  const o = w.addBody({ position: v(0, 5, 5), shape: { type: 'obb', halfExtents: v(1, 1, 1) }, kinematic: true });
  const ho = w.raycast(v(0, 5, 0), v(0, 0, 1), 100);
  assert.equal(ho.id, o);
  assert.ok(Math.abs(ho.distance - (5 - Math.sqrt(3))) < 1e-9, 'OBB tested by conservative bounding sphere r=|halfExtents|');
});
