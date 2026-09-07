import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Gizmos } from '../client/kernel/gizmos.js';
import { View } from '../client/kernel/view.js';

test('collider overlay follows actual planar yaw, entity scale, box yaw and later movement', () => {
  const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
  group.position.set(5, 0, -5); group.rotation.set(Math.PI, 0, Math.PI); group.scale.set(2.5, 2.5, 2.5);
  const boxes = [{ position: [1, 2, 3], size: [2, 4, 6], rotation: [0, Math.PI / 4, 0], blocker: true }];
  const doc = { collider: { boxes } }, store = { entities: new Map([['building', doc]]), get: () => doc, onChange() {} };
  const gizmos = new Gizmos({ scene, store, view: { getGroup: () => group }, scenes: {} });
  try {
    gizmos.show.add('colliders'); gizmos.setEnabled(true); scene.updateMatrixWorld(true);
    const wrapper = gizmos.root.children[0], edges = wrapper.children[0];
    const expected = new THREE.Vector3(1, 2, 3).applyMatrix4(group.matrixWorld);
    expect(edges.getWorldPosition(new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-10);
    expect(wrapper.scale.toArray()).toEqual([2.5, 2.5, 2.5]);
    expect(edges.rotation.y).toBeCloseTo(Math.PI / 4, 10);
    group.position.x += 4; group.rotation.set(0, .6, 0); group.scale.set(2, 3, 4);
    gizmos.update(); scene.updateMatrixWorld(true);
    expect(edges.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(1, 2, 3).applyMatrix4(group.matrixWorld))).toBeLessThan(1e-10);
  } finally { gizmos.setEnabled(false); }
});

test('walkable query applies source entity scale to horizontal extent and top height', () => {
  const group = new THREE.Group(); group.position.set(10, 2, 20); group.scale.set(2, 3, 4);
  const view = Object.create(View.prototype);
  view.colliderIds = new Set(['floor']); view.groups = new Map([['floor', group]]);
  view.store = { get: () => ({ collider: { boxes: [{ position: [1, 1, 2], size: [2, .4, 2] }] } }) };
  view.groundEntityEligible = () => true;
  expect(view.walkableAt(13.5, 31.5).top).toBeCloseTo(5.6, 10);
  expect(view.walkableAt(14.1, 31.5)).toBeNull();
  expect(view.walkableAt(13.5, 31.5, 5.5)).toBeNull();
});

test('dynamic pose FPS holds actual mixer bones while translation stays live; smooth restores pending time', () => {
  const scene = new THREE.Scene(), holder = new THREE.Group(), bone = new THREE.Bone(); bone.name = 'leg'; holder.add(bone); scene.add(holder);
  const mixer = new THREE.AnimationMixer(holder);
  const clip = new THREE.AnimationClip('move', 1, [new THREE.NumberKeyframeTrack('leg.position[x]', [0, 1], [0, 1])]);
  mixer.clipAction(clip).play();
  const view = Object.create(View.prototype), entry = { holder, mixer, acc: 0, spec: { step: 8 }, clips: new Map(), actions: new Map() };
  view.scene = scene; view.groups = new Map([['actor', holder]]); view.animatedModels = new Map([['actor', entry]]); view.driveAnimationEntry = () => {};
  view.setAnimationStepOverride(4);
  for (let i = 0; i < 4; i++) { holder.position.z += 1; view.updateAnimatedModels(.05); expect(bone.position.x).toBe(0); }
  expect(holder.position.z).toBe(4);
  view.updateAnimatedModels(.05); expect(bone.position.x).toBeCloseTo(.25, 8);
  view.updateAnimatedModels(.1); expect(bone.position.x).toBeCloseTo(.25, 8);
  view.setAnimationStepOverride(0); view.updateAnimatedModels(.05); expect(bone.position.x).toBeCloseTo(.4, 8);
  view.setAnimationStepOverride(null); expect(view.animationStepOverride).toBeNull();
  expect(() => view.setAnimationStepOverride(NaN)).toThrow();
  expect(() => view.setAnimationStepOverride(-1)).toThrow();
});
