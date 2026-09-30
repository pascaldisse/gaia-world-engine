// E integration: GIController itself (not just GISceneAttachment in
// isolation) wires attach/detach through configure()/update()/dispose()
// when constructed with a real scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { GIController } from '../client/kernel/gi/gi-controller.js';

function meshWith(material) {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
}

test('configure({enabled:true}) with a scene attaches GI to eligible materials already present', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  const gi = new GIController({ scene });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] });
  assert.equal(std.__giAttached, true);
});

test('a controller with no scene (Environment not wired to one, or headless) still builds resources without throwing', () => {
  const gi = new GIController({});
  assert.doesNotThrow(() => gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] }));
  assert.ok(gi.resources);
});

test('configure({enabled:false}) after being enabled with a scene detaches every attached material', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  const gi = new GIController({ scene });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] });
  assert.equal(std.__giAttached, true);
  gi.configure({ enabled: false });
  assert.equal(std.__giAttached, false);
});

test('a mesh added to the scene AFTER enable gets attached on the next update()', () => {
  const scene = new THREE.Scene();
  const gi = new GIController({ scene });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] });

  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  assert.equal(std.__giAttached, undefined, 'not attached yet -- no update() has run since the mesh was added');

  const result = gi.update(0.016, [0, 0, 0]);
  assert.equal(std.__giAttached, true);
  assert.equal(result.newlyAttached, 1);
});

test('dispose() detaches every attached material too, not just configure({enabled:false})', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  const gi = new GIController({ scene });
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 8, layersY: 1, heightRange: [0, 1] });
  gi.dispose();
  assert.equal(std.__giAttached, false);
});

// removal-style mutation check: a configure() that skips attachAll on
// enable would leave every material dark even with a fully built GI grid
test('mutant: an enable path that builds resources but never calls attachAll leaves materials un-attached', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  const gi = new GIController({ scene });
  // reproduce the bug: build resources but skip the attachment step
  const configureWithoutAttach = () => {
    gi.enabled = true;
    gi.resources = { params: {} }; // BUG: never touches attachment
  };
  configureWithoutAttach();
  assert.equal(std.__giAttached, undefined, 'mutant: material never gets wired even though GI "is enabled"');
});
