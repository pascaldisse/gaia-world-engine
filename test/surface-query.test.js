import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';

function fixture({ nested = false } = {}) {
  const view = Object.create(View.prototype);
  view.ownPresence = 'self';
  view.groups = new Map();
  view.store = { get: () => ({ mesh: {} }) };
  for (const [id, y] of [['floor', 0], ['self', 2]]) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(5, 1, 5), new THREE.MeshBasicMaterial());
    const part = nested ? new THREE.Group() : mesh;
    if (nested) part.add(mesh);
    part.userData = { kind: 'mesh-part', solid: true };
    group.add(part);
    group.position.y = y;
    group.updateMatrixWorld(true);
    view.groups.set(id, group);
  }
  return view;
}
for (const nested of [false, true]) {
  test(`surface query excludes own ${nested ? 'loaded model group' : 'fallback mesh'}`, () => {
    const view = fixture({ nested });
    expect(view.surfaceAt(0, 0, 4)).toBeCloseTo(0.5);
    expect(view.surfaceAt(0, 0, 4, { exclude: 'floor' })).toBeCloseTo(2.5);
    view.groups.get('floor').userData.hidden = true;
    expect(view.surfaceAt(0, 0, 4)).toBeNull();
  });
}
test('transient invisible surfaces and query range are excluded', () => {
  const view = fixture();
  view.groups.get('floor').visible = false;
  expect(view.surfaceAt(0, 0, 4)).toBeNull();
  view.groups.get('floor').visible = true;
  expect(view.surfaceAt(0, 0, 4, { maxDrop: 1 })).toBeNull();
});
