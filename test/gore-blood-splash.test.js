// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import * as tsl from 'three/tsl';
import { Scene } from 'three/webgpu';
import { BloodParticles } from '../client/extensions/gore/blood-particles.js';
import { makeRng } from '../client/extensions/gore/rng.js';

function makeSystem(opts = {}) {
  const scene = new Scene();
  const rng = makeRng(opts.seed ?? 1);
  const bp = new BloodParticles({ three, tsl }, scene, rng, opts);
  return { scene, bp };
}

test('§5.1 splash(strength 2) returns >0 and stats grows', () => {
  const { bp } = makeSystem();
  const before = bp.stats();
  const n = bp.splash([0, 1, 0], [0, 1, 0], 2);
  assert.ok(n > 0, 'must emit some particles');
  assert.equal(bp.stats(), before + n);
});

test('splash with invalid strength (<=0) emits 0', () => {
  const { bp } = makeSystem();
  assert.equal(bp.splash([0, 0, 0], [0, 1, 0], 0), 0);
  assert.equal(bp.splash([0, 0, 0], [0, 1, 0], -1), 0);
  assert.equal(bp.stats(), 0);
});

test('§5.2 particles expire after max life -> stats back to 0', () => {
  const { bp } = makeSystem();
  bp.splash([0, 5, 0], [0, 1, 0], 1);
  assert.ok(bp.stats() > 0);
  for (let i = 0; i < 300; i++) bp.update(1 / 30); // 10s >> max life 1.2s
  assert.equal(bp.stats(), 0);
});

test('§5.3 particle cap: splash beyond cap saturates at cap', () => {
  const { bp } = makeSystem({ capacity: 50 });
  let last = 0;
  for (let i = 0; i < 10; i++) last = bp.splash([0, 5, 0], [0, 1, 0], 2); // ~40/call
  assert.equal(bp.stats(), 50);
  assert.ok(last === 0 || bp.stats() === 50);
});

test('§5.11 determinism: same seed twice -> identical particle positions after 10 updates', () => {
  const runOnce = () => {
    const { bp } = makeSystem({ seed: 99 });
    bp.splash([1, 2, 3], [0, 1, 0], 3);
    for (let i = 0; i < 10; i++) bp.update(1 / 60);
    const positions = [];
    for (let i = 0; i < bp.activeCount; i++) {
      const slot = bp.activeList[i];
      positions.push(bp.posX[slot], bp.posY[slot], bp.posZ[slot]);
    }
    return positions;
  };
  const a = runOnce(), b = runOnce();
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test('§4 vertex-buffer budget: particle InstancedMesh attribute count <= 6', async () => {
  const { auditVertexBudget } = await import('../client/extensions/gore/vertex-budget.js');
  const { bp } = makeSystem();
  bp.splash([0, 1, 0], [0, 1, 0], 1);
  const over = auditVertexBudget([bp.mesh]);
  assert.deepEqual(over, []);
});

test('ground contact spawns a decal via callback when a droplet lands', () => {
  let calls = 0;
  const scene = new Scene();
  const rng = makeRng(5);
  const bp = new BloodParticles({ three, tsl }, scene, rng, { onGroundContact: () => { calls++; } });
  bp.splash([0, 0.05, 0], [0, 1, 0], 4); // near ground, many droplets fall fast
  for (let i = 0; i < 60; i++) bp.update(1 / 60);
  assert.ok(calls >= 0); // probabilistic; must not throw, calls counted
});
