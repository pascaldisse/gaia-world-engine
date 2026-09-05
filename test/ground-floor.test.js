import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';
import { Player } from '../client/kernel/player.js';

// Reproduces the Boomtown ground-plane correction as engine geometry: a large
// NON-BLOCKER collider box (world dims 1380 x 2.76 x 1380, TOP at world y=0)
// on a scaled group at (95,-260), plus a small higher road collider (top 0.2).
// Exercises the REAL View.walkableAt / Player.groundAt (walkableAt has no
// origin-distance cull, so one box grounds the whole footprint).

const SCENE = {}; // sentinel; groups whose parent === this stay eligible

function groundGroup(position, scale = 1) {
  return {
    position: new THREE.Vector3(...position),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(scale, scale, scale),
    parent: SCENE,
    userData: {},
    children: [],
    updateWorldMatrix() {},
  };
}

function makeView() {
  const view = Object.create(View.prototype);
  view.scene = SCENE;
  view.ownPresence = null;
  view.activeScenes = null; // isActive() => true for every entity
  view.store = new Map([
    // the corrected ground plane: box top = pos.y(-1.38) + by(0) + sy/2(1.38) = 0
    ['floor', { collider: { boxes: [{ position: [0, 0, 0], size: [1380, 2.76, 1380], blocker: false }] } }],
    // a road patch around spawn, its walkable surface at y = 0.2 (higher than the floor)
    ['road', { collider: { boxes: [{ position: [0, 0, 0], size: [40, 0.4, 40], blocker: false }] } }],
  ]);
  view.groups = new Map([
    ['floor', groundGroup([95, -1.38, -260], 138)],
    ['road', groundGroup([10, 0, -0.82], 1)],
  ]);
  view.colliderIds = new Set(['floor', 'road']);
  return view;
}

// --- View.walkableAt: broad support, exact top, no road masking ------------

test('walkableAt: the floor grounds the whole footprint at exactly top y=0', () => {
  const v = makeView();
  // plaza (inside floor bounds, away from the road patch) -> floor at 0
  expect(v.walkableAt(60, -120, Infinity).top).toBeCloseTo(0, 6);
  // distant but in-bounds (walkableAt has NO 60m origin cull) -> still 0
  expect(v.walkableAt(700, -900, Infinity).top).toBeCloseTo(0, 6); // x<=785, z>=-950
  expect(v.walkableAt(-500, 400, Infinity).top).toBeCloseTo(0, 6);
});

test('walkableAt: outside the plane footprint returns null', () => {
  const v = makeView();
  expect(v.walkableAt(900, -260, Infinity)).toBeNull(); // x>785
  expect(v.walkableAt(95, 500, Infinity)).toBeNull(); // z>430
  expect(v.walkableAt(-700, -260, Infinity)).toBeNull(); // x<-595
});

test('walkableAt: a higher road box wins over the floor (floor never masks roads)', () => {
  const v = makeView();
  // spawn sits on the road patch AND inside the floor -> the higher road (0.2) is returned,
  // proving the top-0 floor does not raise over / mask the road surface.
  const at = v.walkableAt(10, -0.82, Infinity);
  expect(at.top).toBeCloseTo(0.2, 6);
  expect(at.id).toBe('road');
});

// --- Player.groundAt: real combine of heightAt + walkableAt + surfaceAt -----

function withPlayer(view, run) {
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {}, activeElement: null };
  try {
    const player = new Player({ camera: new THREE.PerspectiveCamera(), dom: {}, overlay: { addEventListener() {} }, view });
    run(player);
  } finally {
    globalThis.document = previous;
  }
}

test('Player.groundAt: stands on the floor in the plaza (y=0) and on the road (y=0.2)', () => {
  withPlayer(makeView(), (player) => {
    const eye = player.eyeHeight; // feet at 0 => standing on ground
    // plaza: floor only -> ground 0
    expect(player.groundAt(60, -120, eye).y).toBeCloseTo(0, 6);
    // road point: road collider (0.2) wins -> not masked to 0
    expect(player.groundAt(10, -0.82, eye).y).toBeCloseTo(0.2, 6);
    // distant in-bounds: floor still supports (no origin cull) -> 0
    expect(player.groundAt(700, -900, eye).y).toBeCloseTo(0, 6);
  });
});

test('Player.groundAt: a raised collider (road) is named as the platform', () => {
  // NOTE: heightAt() is a global 0 here (no terrain registered), so the floor
  // top (0) TIES the base plane and groundAt keeps platformId null at the
  // plaza — the ground is 0 either way. The collider is proven load-bearing by
  // the walkableAt tests above (explicit top-0 support with no origin cull);
  // it only becomes the named platform where it is strictly higher, e.g. the road.
  withPlayer(makeView(), (player) => {
    expect(player.groundAt(60, -120, player.eyeHeight).platformId).toBeNull();
    expect(player.groundAt(10, -0.82, player.eyeHeight).platformId).toBe('road');
  });
});
