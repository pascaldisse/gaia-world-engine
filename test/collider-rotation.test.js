import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';
import { planarYaw, pointToInteractDistance } from '../shared/collider.js';

function fixture(rotation, box, position = [0, 0, 0]) {
  const group = new THREE.Group();
  group.position.fromArray(position);
  group.rotation.set(...rotation);
  const scene = new THREE.Scene(); scene.add(group);
  const shape = new THREE.Object3D();
  shape.position.fromArray(box.position ?? [0, 0, 0]);
  shape.rotation.set(...(box.rotation ?? [0, 0, 0]));
  group.add(shape); scene.updateMatrixWorld(true);
  const entity = { transform: { position, rotation }, collider: { boxes: [box] } };
  const view = Object.create(View.prototype);
  Object.assign(view, { scene, ownPresence: null, activeScenes: null, store: new Map([['building', entity]]), groups: new Map([['building', group]]), colliderIds: new Set(['building']) });
  return { view, shape, entity };
}

test('live Boomtown rotated apartment does not push a player beside the parked car', () => {
  const { view, shape } = fixture([Math.PI, 0, Math.PI], { size: [29.079895, 29.886528, 29.548618], position: [44.351006, 14.943263, 20.299002], rotation: [Math.PI, 0, Math.PI], blocker: true }, [-25, 0, -35]);
  const player = new THREE.Vector3(19.4, 1.7, -16.4);
  view.resolveBlockers(player, 1.7);
  expect(player.toArray()).toEqual([19.4, 1.7, -16.4]);
  const center = shape.localToWorld(new THREE.Vector3()); center.y = 1.7;
  const before = center.clone(); view.resolveBlockers(center, 1.7);
  expect(center.distanceTo(before)).toBeGreaterThan(10);
});

test('XYZ alternate Euler forms agree with renderer matrices for push-out, floor support, and interaction', () => {
  for (const yaw of [0, 0.61, 2.384, -2.384, Math.PI]) {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
    const rotation = [euler.x, euler.y, euler.z];
    expect(Math.cos(planarYaw(rotation))).toBeCloseTo(Math.cos(yaw), 8);
    expect(Math.sin(planarYaw(rotation))).toBeCloseTo(Math.sin(yaw), 8);
    const box = { position: [7, 1, -4], size: [2, 2, 8], rotation: [0, 0.4, 0], blocker: true };
    const { view, shape, entity } = fixture(rotation, box);
    const outside = shape.localToWorld(new THREE.Vector3(2, 0, 0));
    expect(pointToInteractDistance(outside, entity)).toBeCloseTo(1, 8);
    const inside = shape.localToWorld(new THREE.Vector3(0.8, 0, 0)); inside.y = 1.7;
    const before = inside.clone(); view.resolveBlockers(inside, 1.7);
    expect(inside.distanceTo(before)).toBeCloseTo(0.55, 8);
    box.blocker = false;
    const surface = shape.localToWorld(new THREE.Vector3(0, 0, 3));
    expect(view.walkableAt(surface.x, surface.z, 3)).toEqual({ id: 'building', top: 2 });
    expect(view.walkableAt(outside.x, outside.z, 3)).toBeNull();
  }
});
