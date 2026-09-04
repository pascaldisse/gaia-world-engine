import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Player } from '../client/kernel/player.js';
import { Scenes } from '../client/kernel/scenes.js';

function withPlayer(run) {
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {}, activeElement: null };
  try {
    const player = new Player({ camera: new THREE.PerspectiveCamera(), dom: {}, overlay: { addEventListener() {} } });
    player.locked = true;
    player.position.set(0, player.eyeHeight, 0);
    run(player);
  } finally {
    globalThis.document = previous;
  }
}

function measuredSpeed(player, keys) {
  player.keys = new Set(keys);
  for (let i = 0; i < 120; i++) player.update(1 / 60);
  const start = player.position.clone();
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  return Math.hypot(player.position.x - start.x, player.position.z - start.z);
}

test('unconfigured worlds retain engine walk/run/crouch/backward defaults', () => withPlayer((player) => {
  expect(measuredSpeed(player, ['KeyW'])).toBeCloseTo(6, 6);
  expect(measuredSpeed(player, ['KeyW', 'ShiftLeft'])).toBeCloseTo(14, 6);
  expect(measuredSpeed(player, ['KeyW', 'KeyC'])).toBeCloseTo(3, 6);
  expect(measuredSpeed(player, ['KeyS'])).toBeCloseTo(6, 6);
}));

test('scene values reach displacement; crouch wins over sprint; backward multiplies each gait', () => withPlayer((player) => {
  player.setLocomotion({ walk: 4, run: 9, crouch: 0.8, backwardFactor: 0.5 });
  for (const [keys, speed] of [
    [['KeyW'], 4], [['KeyW', 'ShiftRight'], 9], [['KeyS'], 2],
    [['KeyS', 'ShiftLeft'], 4.5], [['KeyW', 'ControlLeft', 'ShiftLeft'], 0.8],
    [['KeyS', 'ControlRight'], 0.4], [['KeyW', 'KeyD'], 4],
  ]) expect(measuredSpeed(player, keys)).toBeCloseTo(speed, 6);
}));

test('partial/absent scene spec resets stale values without mutating authored data', () => withPlayer((player) => {
  const spec = Object.freeze({ walk: 4, crouch: 0.8 });
  player.setLocomotion(spec);
  player.setLocomotion({ run: 9 });
  expect(player.locomotion).toEqual({ walk: 6, run: 9, crouch: 3, backwardFactor: 1 });
  player.setLocomotion(null);
  expect(player.locomotion).toEqual({ walk: 6, run: 14, crouch: 3, backwardFactor: 1 });
  expect(spec).toEqual({ walk: 4, crouch: 0.8 });
}));

test('snapshot hydration, live locomotion edits, and scene crossings re-derive settings', () => withPlayer((player) => {
  const cameras = [];
  const store = { entities: new Map() };
  const scenes = new Scenes({
    store,
    view: { setActiveScenes() {}, updateAmbience() {} }, environment: {},
    onCamera: (spec) => cameras.push(spec),
    onLocomotion: (spec) => player.setLocomotion(spec),
  });
  scenes.setWorld({ scenes: { tuned: { bounds: { center: [0, 0], radius: 10 } }, plain: { bounds: { center: [30, 0], radius: 10 } } } });
  scenes.update({ x: 0, y: 2, z: 0 });
  const camera = { mode: 'side', fov: 35, height: 40 };
  const entity = { scene: { name: 'tuned' }, camera, locomotion: { walk: 4, crouch: 0.8 } };
  store.entities.set('environment', entity);
  scenes.applyCamera();
  scenes.applyLocomotion();
  expect(cameras.at(-1)).toBe(camera);
  expect(measuredSpeed(player, ['KeyW', 'KeyC'])).toBeCloseTo(0.8, 6);
  entity.locomotion = { walk: 5 };
  scenes.applyLocomotion();
  expect(player.locomotion.crouch).toBe(3);
  expect(measuredSpeed(player, ['KeyW'])).toBeCloseTo(5, 6);
  scenes.update({ x: 30, y: 2, z: 0 });
  expect(cameras.at(-1)).toBeNull();
  expect(measuredSpeed(player, ['KeyW'])).toBeCloseTo(6, 6);
}));
