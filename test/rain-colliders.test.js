import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { makeRain } from '../client/kernel/rain.js';

function world(comps, mutate = null, { mesh = true } = {}) {
  const scene = new THREE.Scene();
  const groups = new Map();
  const instancedModels = { entries: new Set() };
  const view = { groups, getGroup: (id) => groups.get(id), ownPresence: null, animatedModels: new Map(), instancedModels };
  const g = new THREE.Group();
  g.position.set(10, 0, -4);
  if (mesh) g.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4)));
  if (mutate) mutate(g);
  scene.add(g);
  groups.set('car', g);
  const store = { entities: new Map([['car', comps]]) };
  return { view, store, g, instancedModels };
}
const row = (out, i) => out.split('\n')[i].trim().split(/\s+/);
const nums = (cells, a, b) => cells.slice(a, b).map(Number);

test('colliders: aligned box → OK, planar label, world-aabb cm rows, mesh row', () => {
  const { view, store } = world({ mesh: {}, collider: { boxes: [{ size: [2, 1, 4], position: [0, 0, 0] }] } });
  const out = makeRain({ store, view }).colliders('car');
  expect(out.split('\n')[0]).toBe('#rain colliders car n=1 space=planar-yaw+scale box=world-aabb bounds=group q=cm OK');
  expect(row(out, 1)).toEqual(['i', 'cx', 'cy', 'cz', 'sx', 'sy', 'sz', 'blk', 'gap']);
  const b = row(out, 2);
  expect(nums(b, 0, 7)).toEqual([0, 1000, 0, -400, 200, 100, 400]);
  expect(b[7]).toBe('T'); expect(Number(b[8])).toBe(100);
  expect(row(out, 3)[0]).toBe('mesh');
});

test('colliders: 8-corner AABB is exact under rotation — box yaw 90° swaps x/z extents; group yaw in full space too', () => {
  const rot = { mesh: {}, collider: { boxes: [{ size: [2, 1, 4], position: [0, 0, 0], rotation: [0, Math.PI / 2, 0] }] } };
  const a = makeRain(world(rot)).colliders('car');
  expect(nums(row(a, 2), 4, 7)).toEqual([400, 100, 200]);
  expect(a.split('\n')[0]).not.toContain('UNSUPPORTED');
  const plain = { mesh: {}, collider: { boxes: [{ size: [2, 1, 4], position: [0, 0, 0] }] } };
  const b = makeRain(world(plain, (g) => { g.rotation.y = Math.PI / 2; })).colliders('car', { space: 'full' });
  expect(nums(row(b, 2), 4, 7)).toEqual([400, 100, 200]);
  const euler = { mesh: {}, collider: { boxes: [{ size: [2, 1, 4], position: [0, 0, 0], rotation: [Math.PI / 2, 0, 0] }] } };
  expect(nums(row(makeRain(world(euler)).colliders('car', { space: 'full' }), 2), 4, 7)).toEqual([200, 400, 100]);
});

test('colliders: unknown box.rotation format → ? cells + !BOX_ROTATION_UNSUPPORTED, never wrong cm', () => {
  const { view, store } = world({ mesh: {}, collider: { boxes: [{ size: [1, 1, 1], position: [0, 0, 0], rotation: 'north' }] } });
  const out = makeRain({ store, view }).colliders('car');
  expect(out.split('\n')[0]).toContain('!BOX_ROTATION_UNSUPPORTED');
  expect(row(out, 2).slice(1, 7)).toEqual(['?', '?', '?', '?', '?', '?']);
});

test('colliders: planar = group.position + rotation.y + SIGNED scale; full = matrixWorld (pitch moves the box)', () => {
  const comps = { mesh: {}, collider: { boxes: [{ size: [1, 1, 1], position: [0, 0, 2] }] } };
  const pitched = world(comps, (g) => { g.rotation.x = Math.PI / 2; });
  const rain = makeRain(pitched);
  expect(nums(row(rain.colliders('car'), 2), 1, 4)).toEqual([1000, 0, -200]);
  const fc = nums(row(rain.colliders('car', { space: 'full' }), 2), 1, 4);
  expect(fc[0]).toBe(1000); expect(fc[1]).toBe(-200); expect(Math.abs(fc[2] - -400)).toBeLessThanOrEqual(1);
  const mirrored = world(comps, (g) => { g.rotation.y = Math.PI / 2; g.scale.set(2, 2, -2); });
  const m = row(makeRain(mirrored).colliders('car'), 2);
  expect(nums(m, 1, 4).map(Math.round)).toEqual([600, 0, -400]); // local +Z × −2 → −Z local → −X world under yaw π/2
  expect(nums(m, 4, 7)).toEqual([200, 200, 200]);
  expect(makeRain(pitched).colliders('car', { space: 'nope' })).toBe('#rain colliders car !BADSPACE nope');
});

test('colliders: instanced hold (empty group Box3) → bounds from templates; none at all → !BOUNDS_UNAVAILABLE and no mesh verdict', () => {
  const comps = { mesh: {}, collider: { boxes: [{ size: [2, 1, 4], position: [0, 0, 0] }] } };
  const { view, store, g, instancedModels } = world(comps, null, { mesh: false });
  const holder = new THREE.Group(); holder.userData.solid = false; g.add(holder);
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  instancedModels.entries.add({ holder, spec: { templates: [{ geometry, matrix: new THREE.Matrix4().makeTranslation(0, 0.5, 0) }] } });
  const out = makeRain({ store, view }).colliders('car');
  expect(out.split('\n')[0]).toContain('bounds=instanced');
  expect(out.split('\n')[0]).toMatch(/ OK$/);
  expect(nums(row(out, 3), 1, 7)).toEqual([1000, 50, -400, 200, 100, 400]);
  const bare = world({ mesh: {} }, null, { mesh: false });
  const head = makeRain(bare).colliders('car').split('\n')[0];
  expect(head).toContain('bounds=none');
  expect(head).toContain('!BOUNDS_UNAVAILABLE');
  expect(head).not.toContain('!NOCOLLIDER'); expect(head).not.toContain('!NOMESH');
});

test('colliders: shifted box → !OFFSET only; no collider → !NOCOLLIDER; unknown → !NOBODY', () => {
  const head = makeRain(world({ mesh: {}, collider: { boxes: [{ size: [1, 1, 1], position: [8, 0, 0], blocker: true }] } })).colliders('car').split('\n')[0];
  expect(head).toContain('!OFFSET'); expect(head).not.toContain('PHANTOM');
  const rain = makeRain(world({ mesh: {} }));
  expect(rain.colliders('car').split('\n')[0]).toContain('!NOCOLLIDER');
  expect(rain.colliders('nope')).toBe('#rain colliders nope !NOBODY');
});
