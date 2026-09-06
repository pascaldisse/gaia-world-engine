import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';

test('actual View + Three mixers: global dt, per-actor compensation, quantized clips', () => {
  const scene = new THREE.Scene();
  const view = new View({ scene, store: { entities: new Map(), onChange() {} } });
  const add = (id, step = 0) => {
    const holder = new THREE.Group(); scene.add(holder); view.groups.set(id, holder);
    const clip = new THREE.AnimationClip('move', 1, [new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 10])]);
    const entry = { holder, mixer: new THREE.AnimationMixer(holder), clips: new Map([['move', clip]]), actions: new Map(), spec: { clip: 'move', step }, acc: 0 };
    view.animatedModels.set(id, entry);
    return entry;
  };
  const npc = add('npc'); const actor = add('actor'); const quantized = add('quantized', 10);
  view.updateAnimatedModels(0.03, (id) => id === 'actor' || id === 'quantized' ? 2 : 1);
  expect(npc.holder.position.x).toBeCloseTo(0.3, 6);
  expect(actor.holder.position.x).toBeCloseTo(0.6, 6);
  expect(quantized.holder.position.x).toBe(0);
  view.updateAnimatedModels(0.03, (id) => id === 'actor' || id === 'quantized' ? 2 : 1);
  expect(quantized.holder.position.x).toBeCloseTo(1, 6);
  expect(quantized.acc).toBeCloseTo(0.02, 6);
  view.updateAnimatedModels(0.01, () => NaN);
  expect(actor.holder.position.x).toBeCloseTo(1.3, 6);
  for (const entry of [npc, actor, quantized]) { entry.mixer.stopAllAction(); entry.mixer.uncacheRoot(entry.holder); }
});
