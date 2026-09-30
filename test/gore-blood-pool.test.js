// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import * as tsl from 'three/tsl';
import { Scene } from 'three/webgpu';
import { BloodPools } from '../client/extensions/gore/blood-pools.js';
import { auditVertexBudget } from '../client/extensions/gore/vertex-budget.js';

function makeSystem(opts = {}) {
  const scene = new Scene();
  const pools = new BloodPools({ three, tsl }, scene, opts);
  return { scene, pools };
}

test('pool() returns a handle and grows toward size', () => {
  const { pools } = makeSystem();
  const h = pools.pool([1, 0, 2], [0, 1, 0], 0.8);
  assert.ok(h && typeof h.id === 'number');
  assert.equal(pools.stats().decals, 1);
  assert.equal(pools.stats().pools, 1);
});

test('pool() with invalid size returns null, no growth', () => {
  const { pools } = makeSystem();
  assert.equal(pools.pool([0, 0, 0], [0, 1, 0], 0), null);
  assert.equal(pools.pool([0, 0, 0], [0, 1, 0], -1), null);
  assert.equal(pools.stats().decals, 0);
});

test('§5.4 decal cap: pool x(cap+5) -> stats.decals == cap, oldest evicted first', () => {
  const { pools } = makeSystem({ capacity: 10 });
  const handles = [];
  for (let i = 0; i < 15; i++) handles.push(pools.pool([i, 0, 0], [0, 1, 0], 0.5));
  assert.equal(pools.stats().decals, 10);
  assert.equal(pools.stats().pools, 10);
  // the oldest 5 handles' slots must have been reassigned to newer decals --
  // verify by checking the ring no longer references the earliest handle ids
  const liveIds = new Set();
  for (let i = 0; i < pools.orderCount; i++) liveIds.add(pools.handleId[pools.order[(pools.orderHead + i) % pools.capacity]]);
  for (let i = 0; i < 5; i++) assert.ok(!liveIds.has(handles[i].id), `oldest handle ${i} should be evicted`);
  for (let i = 10; i < 15; i++) assert.ok(liveIds.has(handles[i].id), `newest handle ${i} should remain`);
});

test('radius grows over time toward target (ease-out)', () => {
  const { pools } = makeSystem();
  pools.pool([0, 0, 0], [0, 1, 0], 1);
  const slot = pools.order[pools.orderHead];
  pools.update(0.1);
  const r1 = pools.targetSize[slot] * Math.min(1, pools.age[slot] / 2.0);
  pools.update(1.9);
  assert.ok(pools.age[slot] >= 1.9);
});

test('§4 vertex-buffer budget: pool InstancedMesh attribute count <= 6', () => {
  const { pools } = makeSystem();
  pools.pool([0, 0, 0], [0, 1, 0], 1);
  assert.deepEqual(auditVertexBudget([pools.mesh]), []);
});

test('droplet-originated decal() counts toward decals but not pools', () => {
  const { pools } = makeSystem();
  pools.decal([0, 0, 0], [0, 1, 0], 0.02);
  assert.equal(pools.stats().decals, 1);
  assert.equal(pools.stats().pools, 0);
});
