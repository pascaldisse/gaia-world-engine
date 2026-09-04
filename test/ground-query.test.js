import { describe, test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';
import { Player } from '../client/kernel/player.js';
import { Effects } from '../client/kernel/effects.js';

function fixture() {
  const store = { entities: new Map(), get(id) { return this.entities.get(id); }, onChange() {} };
  const scene = new THREE.Scene();
  const view = new View({ scene, store });
  const add = (id, top, { collider = false, nested = false, placeholder = false, visible = true } = {}) => {
    const group = new THREE.Group(); group.name = id;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4), new THREE.MeshBasicMaterial());
    mesh.position.y = top - 0.5; mesh.visible = visible;
    mesh.userData = { kind: placeholder ? 'model-placeholder' : 'mesh-part', solid: true };
    if (nested) {
      const holder = new THREE.Group(); holder.userData = { kind: 'mesh-part', solid: true };
      holder.add(mesh); group.add(holder);
    } else group.add(mesh);
    scene.add(group); view.groups.set(id, group);
    store.entities.set(id, { mesh: { parts: [] }, ...(collider ? { collider: { boxes: [{ position: [0, top - 0.5, 0], size: [4, 1, 4] }] } } : {}) });
    view.indexEntity(id, store.get(id));
    return { group, mesh };
  };
  return { store, scene, view, add };
}

describe('ground queries — generic scene graph / actual Three raycasts', () => {
  for (const nested of [false, true]) test(`own body excluded; nested=${nested}; render/collision flags retained`, () => {
    const { view, add } = fixture();
    const own = add('self', 1.2, { nested, collider: true }); view.ownPresence = 'self';
    add('floor', 0.4, { visible: false, collider: true });
    expect(view.surfaceAt(0, 0, 3)).toBeCloseTo(0.4);
    expect(view.walkableAt(0, 0, 3)).toEqual({ id: 'floor', top: 0.4 });
    expect(own.group.visible).toBe(true); expect(own.mesh.userData.solid).toBe(true);
    view.ownPresence = 'other';
    expect(view.surfaceAt(0, 0, 3)).toBeCloseTo(1.2);
  });

  test('loading/failure placeholder cannot mask a valid floor; authored fallback collider retained', () => {
    const { view, add } = fixture();
    add('loading', 1.2, { nested: true, placeholder: true, collider: true });
    add('floor', 0.4);
    expect(view.surfaceAt(0, 0, 3)).toBeCloseTo(0.4);
    expect(view.walkableAt(0, 0, 3)).toEqual({ id: 'loading', top: 1.2 });
  });

  for (const state of ['hidden', 'inactive', 'despawned', 'detached']) test(`${state} surface/collider excluded`, () => {
    const { view, add, store, scene } = fixture();
    const { group } = add('invalid', 1.2, { collider: true }); add('floor', 0.4, { collider: true });
    if (state === 'hidden') group.userData.hidden = true;
    if (state === 'inactive') { view.activeScenes = new Set(['main']); store.get('invalid').scene = { name: 'off' }; }
    if (state === 'despawned') store.entities.delete('invalid');
    if (state === 'detached') scene.remove(group);
    expect(view.surfaceAt(0, 0, 3)).toBeCloseTo(0.4);
    expect(view.walkableAt(0, 0, 3)).toEqual({ id: 'floor', top: 0.4 });
  });

  test('explicit exclusions and stacked-floor ceiling preserve lower support', () => {
    const { view, add } = fixture();
    add('car', 1.2, { collider: true }); add('overhead', 1.8); add('floor', 0.4);
    const excludeIds = new Set(['car']);
    expect(view.surfaceAt(0, 0, 3, { excludeIds, maxTop: 0.65 })).toBeCloseTo(0.4);
    expect(view.walkableAt(0, 0, 3, { excludeIds })).toBeNull();
  });

  test('moving mesh matrices refresh before rendering; collider platform identity retained', () => {
    const { view, add } = fixture();
    const { group } = add('platform', 0.4, { collider: true });
    expect(view.surfaceAt(0, 0, 3)).toBeCloseTo(0.4);
    group.position.y += 0.2;
    expect(view.surfaceAt(0, 0, 3)).toBeCloseTo(0.6);
    expect(view.walkableAt(0, 0, 3)?.id).toBe('platform');
    expect(view.walkableAt(0, 0, 3)?.top).toBeCloseTo(0.6);
  });

  test('foot and vehicle samplers share self/car exclusions, retain other floors', () => {
    const { view, add } = fixture();
    view.ownPresence = 'self'; add('self', 0.5, { collider: true }); add('car', 0.6, { collider: true }); add('floor', 0.3, { collider: true });
    const player = Object.create(Player.prototype);
    Object.assign(player, { view, eyeHeight: 1.7, vehicle: { carId: 'car' } });
    expect(player.groundAt(0, 0, 1.7).y).toBeCloseTo(0.3);
    expect(player.groundAt(0, 0, 1.7).platformId).toBe('floor');
    expect(player.driveGroundAt(0, 0, 1.7)).toEqual(player.groundAt(0, 0, 1.7));
    player.vehicle = null;
    expect(player.groundAt(0, 0, 1.7).y).toBeCloseTo(0.6);
  });

  test('spawn wisp/scale transients become support only after the real effect completes', () => {
    const { view, store, scene } = fixture();
    view.effects = new Effects({ scene });
    store.entities.set('deck', { mesh: { parts: [{ shape: 'box', size: [4, 0.2, 4], solid: true }] }, collider: { boxes: [{ size: [4, 0.2, 4] }] } });
    view.indexEntity('deck', store.get('deck'));
    view.buildAnimated('deck');
    expect(view.surfaceAt(0, 0, 2)).toBeNull();
    expect(view.walkableAt(0, 0, 2)).toBeNull();
    view.effects.update(0.55);
    expect(view.surfaceAt(0, 0, 2)).toBeNull();
    view.effects.update(0.4);
    expect(view.surfaceAt(0, 0, 2)).toBeCloseTo(0.1);
    expect(view.walkableAt(0, 0, 2)?.id).toBe('deck');
  });

  test('Float32 mesh seam does not erase an analytic platform identity', () => {
    const { view, add } = fixture();
    const { mesh } = add('platform', 0.3, { collider: true });
    mesh.geometry = new THREE.BoxGeometry(4, 0.2, 4); mesh.position.y = 0.2;
    const player = Object.create(Player.prototype);
    Object.assign(player, { view, eyeHeight: 1.7 });
    expect(view.surfaceAt(0, 0, 2)).toBeGreaterThan(0.3);
    expect(player.groundAt(0, 0, 1.7).platformId).toBe('platform');
  });

  test('nonfinite input/hits never become support', () => {
    const { view, add } = fixture(); add('floor', 0.4, { collider: true });
    expect(view.walkableAt(NaN, 0, 3)).toBeNull();
    expect(view.walkableAt(0, Infinity, 3)).toBeNull();
    expect(view.walkableAt(0, 0, NaN)).toBeNull();
    expect(view.surfaceAt(NaN, 0, 3)).toBeNull();
    expect(view.surfaceAt(0, 0, Infinity)).toBeNull();
    expect(view.surfaceAt(0, 0, 3, { maxTop: NaN })).toBeNull();
  });
});
