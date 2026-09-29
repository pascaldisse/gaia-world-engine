// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import * as tsl from 'three/tsl';
import { Scene, Mesh, BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { createGore, register } from '../client/extensions/gore/index.js';

function makeGore(opts = {}) {
  const scene = new Scene();
  const gore = createGore({ three, tsl, scene }, opts);
  return { scene, gore };
}

test('§1 createGore requires three+tsl+scene', () => {
  assert.throws(() => createGore({}));
});

test('stats() reports all four live counts', () => {
  const { scene, gore } = makeGore();
  gore.blood.splash([0, 1, 0], [0, 1, 0], 1);
  gore.blood.pool([1, 0, 1], [0, 1, 0], 0.5);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial());
  mesh.updateMatrixWorld(true);
  gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
  const s = gore.stats();
  assert.ok(s.particles > 0);
  assert.equal(s.decals, 1);
  assert.equal(s.pools, 1);
  assert.equal(s.pieces, 1);
});

test('§5.5 setRecipes() -> all particle/decal/pool counts 0, scene children removed/hidden', () => {
  const { scene, gore } = makeGore();
  gore.blood.splash([0, 1, 0], [0, 1, 0], 3);
  gore.blood.pool([0, 0, 0], [0, 1, 0], 1);
  const before = gore.stats();
  assert.ok(before.particles > 0 && before.decals > 0);
  gore.setRecipes({});
  const after = gore.stats();
  assert.equal(after.particles, 0);
  assert.equal(after.decals, 0);
  assert.equal(after.pools, 0);
  // "scene children for decals/particles hidden/removed": the shared
  // instanced meshes stay in the scene graph (GPU buffers kept per §1) but
  // must render nothing -- InstancedMesh.count === 0 is the render-time cull.
  const instancedCounts = scene.children.filter((c) => c.isInstancedMesh).map((c) => c.count);
  assert.ok(instancedCounts.every((c) => c === 0), `expected all instanced counts 0, got ${instancedCounts}`);
});

test('setRecipes() keeps GPU buffers (same mesh/geometry objects, not rebuilt)', () => {
  const { scene, gore } = makeGore();
  const before = scene.children.slice();
  gore.blood.splash([0, 1, 0], [0, 1, 0], 2);
  gore.setRecipes({});
  const after = scene.children.slice();
  assert.deepEqual(before, after, 'same object identities, no rebuild');
});

test('§5.6 dispose() removes every gore child from the scene, disposes geometry (spy)', () => {
  const { scene, gore } = makeGore();
  gore.blood.splash([0, 1, 0], [0, 1, 0], 2);
  gore.blood.pool([0, 0, 0], [0, 1, 0], 1);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial());
  mesh.updateMatrixWorld(true);
  gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
  assert.ok(scene.children.length > 0);
  const disposeSpies = [];
  for (const child of scene.children) {
    const original = child.geometry.dispose.bind(child.geometry);
    let called = false;
    child.geometry.dispose = () => { called = true; original(); };
    disposeSpies.push(() => called);
  }
  gore.dispose();
  assert.equal(scene.children.length, 0, 'no gore children left in the scene');
  assert.ok(disposeSpies.every((wasCalled) => wasCalled()), 'every geometry.dispose() must have been called');
});

test('§5.13 register(ctx without three) -> no throw, returns {}', () => {
  assert.doesNotThrow(() => {
    const d = register({});
    assert.deepEqual(d, {});
  });
  assert.doesNotThrow(() => register(undefined));
  assert.doesNotThrow(() => register({ three, tsl })); // missing scene
});

test('register(ctx) with a full context returns a working {name, api, update}', () => {
  const scene = new Scene();
  const d = register({ three, tsl, scene });
  assert.equal(d.name, 'gore');
  assert.equal(typeof d.api.blood.splash, 'function');
  assert.equal(typeof d.update, 'function');
  assert.doesNotThrow(() => d.update(1 / 60));
});

test('setRecipes drives the render-visible instanced count to 0 (not just a logical counter)', () => {
  const { scene, gore } = makeGore();
  gore.blood.splash([0, 1, 0], [0, 1, 0], 3);
  gore.update(1 / 60); // splash() alone doesn't touch mesh.count; a render tick does
  const before = scene.children.find((c) => c.isInstancedMesh && c.count > 0);
  assert.ok(before, 'sanity: after a real update tick the instanced mesh must show a positive count');
  gore.setRecipes({});
  const after = scene.children.filter((c) => c.isInstancedMesh).every((c) => c.count === 0);
  assert.ok(after, 'setRecipes must drive every instanced mesh count back to 0');
});
