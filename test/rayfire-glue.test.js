// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §5 demolish glue (#17) + §16 #35-36 end-to-end crumble built from the public API exactly the way a consumer drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { register } from '../client/extensions/rayfire/index.js';
import { demolish } from '../client/extensions/rayfire/render.js';
import { RFWorld } from '../client/extensions/rayfire/world.js';

const api = register().api;
const v = (x = 0, y = 0, z = 0) => ({ x, y, z });

function worldCentroid(mesh) {
  const c = mesh.userData.rayfire.centroidLocal;
  return new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(mesh.matrix);
}

test('#17 demolish(Object3D,{point,impulse}): one body per fragment, world holds exactly that many, impulsed fragment = NEAREST to point (not the first)', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.position.set(10, 2, -3); mesh.updateMatrixWorld(true);
  const point = new THREE.Vector3(11.8, 3.5, -1.5);
  const r = demolish(mesh, { amount: 12, seed: 6, point, impulse: v(20, 0, 0) });
  assert.ok(r.meshes.length > 3);
  assert.equal(r.bodies.length, r.meshes.length);
  assert.equal(r.world.bodies.size, r.meshes.length);
  assert.ok(r.world instanceof RFWorld);
  assert.ok(r.closest > 0 && r.closest < r.meshes.length);
  const d = m => worldCentroid(m).distanceTo(point);
  const best = r.meshes.reduce((a, m, i) => (d(m) < d(r.meshes[a]) ? i : a), 0);
  assert.equal(r.closest, best, 'the impulsed fragment is the nearest, not fragment 0');
  r.meshes.forEach((m, i) => {
    const body = r.world.getBody(m.userData.rayfire.bodyId);
    assert.ok(body, 'bodyId set on userData.rayfire');
    assert.equal(body, r.bodies[i]);
    assert.equal(body.kinematic, false);
    const moving = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z) > 0;
    assert.equal(moving, i === r.closest, `only fragment ${r.closest} is impulsed (i=${i})`);
  });
  const cb = r.bodies[r.closest]; assert.ok(cb.velocity.x > 0 && cb.velocity.y === 0);
  assert.ok(Math.abs(cb.position.x - worldCentroid(r.meshes[r.closest]).x) < 1e-9, 'body starts at the fragment world centroid');
});

test('demolish: supplied world is reused (bodies added on top); scalar impulse = along +y; no point -> closest -1 and no impulse; BufferGeometry input', () => {
  const world = new RFWorld({ gravity: v(0, 0, 0) });
  world.addBody({ position: v(0, 0, 0), shape: { type: 'sphere', radius: 1 } });
  const r = demolish(new THREE.BoxGeometry(2, 2, 2), { amount: 6, seed: 2, world, point: v(0, 0, 0), impulse: 7 });
  assert.equal(r.world, world);
  assert.equal(world.bodies.size, 1 + r.meshes.length);
  const moved = r.bodies.filter(b => b.velocity.y !== 0);
  assert.equal(moved.length, 1); assert.equal(moved[0], r.bodies[r.closest]);
  const q = demolish(new THREE.BoxGeometry(2, 2, 2), { amount: 6, seed: 2 });
  assert.equal(q.closest, -1);
  assert.ok(q.bodies.every(b => b.velocity.x === 0 && b.velocity.y === 0 && b.velocity.z === 0));
  assert.throws(() => demolish(null, {}), /fracture: input/);
});

test('demolish: impulse mode is mass-dependent by default, velocityChange on request', () => {
  const mk = mode => demolish(new THREE.BoxGeometry(2, 2, 2), { amount: 6, seed: 2, point: v(0, 0, 0), impulse: v(10, 0, 0), impulseMode: mode });
  const a = mk(undefined), b = mk('velocityChange');
  const va = a.bodies[a.closest].velocity.x, vb = b.bodies[b.closest].velocity.x;
  assert.ok(Math.abs(vb - 10) < 1e-9);
  assert.ok(Math.abs(va * a.bodies[a.closest].mass - 10) < 1e-9);
});

// ---- #35 / #36: a consumer-style crumble driven purely through the public api -------------------
function crumble({ seed = 11, y0 = 3 } = {}) {
  const geo = new THREE.BoxGeometry(2, 6, 2); const src = new THREE.Mesh(geo);
  src.position.set(0, y0 + 3, 0); src.updateMatrixWorld(true);
  const tris = api.geometryToTriangles(geo);
  const cells = api.demolishMesh(tris, { am: 24, sd: seed });
  const group = new THREE.Group(); const meshes = cells.map(c => { const m = new THREE.Mesh(api.facesToBufferGeometry(c.faces)); m.matrixAutoUpdate = false; m.matrix.copy(src.matrixWorld); group.add(m); return m; });
  const recs = cells.map(c => { const p = new THREE.Vector3(c.centroid.x, c.centroid.y, c.centroid.z).applyMatrix4(src.matrixWorld); return { volume: c.volume, centroid: { x: p.x, y: p.y, z: p.z }, aabb: { min: { x: c.aabb.min.x, y: c.aabb.min.y + src.position.y, z: c.aabb.min.z }, max: { x: c.aabb.max.x, y: c.aabb.max.y + src.position.y, z: c.aabb.max.z } }, unyielding: false }; });
  const joints = api.buildAdjacency(recs, { expand: 0.02 }).map(([i, j]) => ({ i, j, broken: false, area: 1 }));
  const world = new api.RFWorld({});
  recs.forEach(r => { r.bodyId = world.addBody({ position: r.centroid, shape: { type: 'sphere', radius: 0.3 * Math.cbrt(r.volume) }, mass: Math.max(0.01, r.volume), kinematic: true }); });
  return { group, meshes, recs, joints, world, cells };
}

test('#35 fractured building: anchor ground band (>=1 supported) -> clear anchors (ALL false) -> activate all via connectivity -> every fragment drops, sleeps within a bound, none tunnels', () => {
  const { recs, joints, world } = crumble();
  const n = api.markUnyielding(recs, { center: v(0, 3.4, 0), size: v(6, 1.2, 6) }); // the lowest slab
  assert.ok(n > 0 && n < recs.length);
  const before = api.computeSupport(recs, joints, {});
  assert.ok(before.filter(Boolean).length >= 1);
  for (const r of recs) r.unyielding = false;
  const after = api.computeSupport(recs, joints, {});
  assert.ok(after.every(x => x === false), 'nothing supported once every anchor is gone');
  const y0 = recs.map(r => world.getBody(r.bodyId).position.y);
  const states = recs.map(() => api.createActivationState({ con: true, seed: 3 }));
  recs.forEach((r, i) => { const b = world.getBody(r.bodyId); assert.equal(api.shouldActivate(states[i], b, { connectivityLost: true }), true); assert.equal(api.activate(states[i], world, r.bodyId), true); });
  let steps = 0, minBottom = Infinity;
  while (steps < 4000 && recs.some(r => world.getBody(r.bodyId).awake)) {
    world.step(1 / 60); steps++;
    for (const r of recs) { const b = world.getBody(r.bodyId); minBottom = Math.min(minBottom, b.position.y - b.shape.radius); }
  }
  assert.ok(steps < 4000, `not all asleep after ${steps} steps`);
  assert.ok(minBottom >= -1e-9, `fell through ground: ${minBottom}`);
  recs.forEach((r, i) => assert.ok(world.getBody(r.bodyId).position.y < y0[i], `fragment ${i} did not drop`));
});

test('#36 dispose: every mesh removed from its group AND every body removed from the world (no leaked bodies) AND handle done', () => {
  const c = crumble({ seed: 5 });
  const handle = { done: false, dispose() { for (const r of c.recs) { c.group.remove(c.meshes[c.recs.indexOf(r)]); c.world.removeBody(r.bodyId); } this.done = true; } };
  assert.equal(c.world.bodies.size, c.recs.length); assert.equal(c.group.children.length, c.recs.length);
  handle.dispose();
  assert.equal(c.group.children.length, 0);
  assert.equal(c.world.bodies.size, 0, 'a stub that only hides meshes would leak bodies');
  for (const r of c.recs) assert.equal(c.world.getBody(r.bodyId), undefined);
  assert.equal(handle.done, true);
  const later = c.world.addBody({ position: v(), shape: { type: 'sphere', radius: 1 } });
  assert.ok(later > Math.max(...c.recs.map(r => r.bodyId)), 'ids never reused after disposal');
});
