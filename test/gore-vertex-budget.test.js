// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §5 test 7, holistic: enumerate every geometry+material the WHOLE extension
// creates (particles + pools + a cut stump/piece) via the real createGore()
// entry point, not a single module in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import * as tsl from 'three/tsl';
import { Scene, Mesh, BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { createGore } from '../client/extensions/gore/index.js';
import { auditVertexBudget, countVertexBuffers } from '../client/extensions/gore/vertex-budget.js';

test('§5.7 every mesh createGore() ever adds to the scene stays ≤ 6 vertex buffers', () => {
  const scene = new Scene();
  const gore = createGore({ three, tsl, scene });
  gore.blood.splash([0, 1, 0], [0, 1, 0], 3);
  gore.blood.pool([1, 0, 1], [0, 1, 0], 0.8);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial());
  mesh.updateMatrixWorld(true);
  gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });

  const meshes = scene.children.filter((c) => c.geometry);
  assert.ok(meshes.length >= 4);
  const over = auditVertexBudget(meshes, 6);
  assert.deepEqual(over.map((e) => ({ count: e.count })), [], `over budget: ${JSON.stringify(over.map((e) => e.count))}`);
  for (const m of meshes) assert.ok(countVertexBuffers(m) <= 6, `mesh over budget: ${countVertexBuffers(m)}`);
});

test('mutant: adding one extra instanced attribute crosses the threshold -> RED', () => {
  const scene = new Scene();
  const gore = createGore({ three, tsl, scene });
  gore.blood.splash([0, 1, 0], [0, 1, 0], 1);
  const anyInstanced = scene.children.find((c) => c.isInstancedMesh);
  assert.ok(anyInstanced);
  const before = countVertexBuffers(anyInstanced);
  assert.ok(auditVertexBudget([anyInstanced], 6).length === 0, 'sanity: starts within budget');
  // simulate the mutant directly: bolt extra instanced attributes on until
  // the real budget threshold (6) is actually crossed, whatever the
  // baseline happened to be.
  let n = 0;
  while (countVertexBuffers(anyInstanced) <= 6) {
    const extra = new three.InstancedBufferAttribute(new Float32Array((anyInstanced.count || 1) * 4), 4);
    anyInstanced.geometry.setAttribute(`goreXMutantExtra${n++}`, extra);
  }
  const after = countVertexBuffers(anyInstanced);
  assert.equal(after, before + n);
  assert.ok(auditVertexBudget([anyInstanced], 6).length > 0, 'crossing 6 must now be flagged');
});
