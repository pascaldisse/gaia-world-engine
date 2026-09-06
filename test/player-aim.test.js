import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Player } from '../client/kernel/player.js';
import { yawTo } from '../client/kernel/aim.js';

const RECT = { left: 0, top: 0, width: 320, height: 180 };

function placeTopDown(camera, px, pz, height = 158) {
  camera.fov = 18; camera.aspect = 320 / 180; camera.near = 0.1; camera.far = 5000;
  camera.position.set(px, height, pz);
  camera.up.set(0, 0, -1);
  camera.lookAt(px, 0, pz);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}

// oracle: world ground point -> pixel via THREE.project (independent of aim.js)
function pixelOf(camera, tx, ty, tz) {
  const ndc = new THREE.Vector3(tx, ty, tz).project(camera);
  return {
    x: RECT.left + ((ndc.x + 1) / 2) * RECT.width,
    y: RECT.top + ((1 - ndc.y) / 2) * RECT.height,
  };
}

function withPlayer(run, rig = null) {
  const prev = globalThis.document;
  globalThis.document = { addEventListener() {}, activeElement: null };
  try {
    const camera = new THREE.PerspectiveCamera(18, 320 / 180, 0.1, 5000);
    const dom = { getBoundingClientRect: () => RECT, requestPointerLock() {}, addEventListener() {}, removeEventListener() {} };
    const overlay = { addEventListener() {}, dataset: {}, style: {} };
    const player = new Player({ camera, dom, overlay, view: undefined });
    if (rig) player.rig = rig;
    player.activateControls();
    run(player, camera);
  } finally {
    globalThis.document = prev;
  }
}

const AIM_RIG = { yaw: 0, pitch: -Math.PI / 2, mode: 'side', distance: 0, height: 158, damp: 20, aim: 'pointer' };
const PLAIN_RIG = { yaw: 0, pitch: -Math.PI / 2, mode: 'side', distance: 0, height: 158, damp: 20 };

// --- opt-in gating ----------------------------------------------------------

test('pointerAimActive/pointerAimYaw are OFF unless the rig declares aim:pointer', () => {
  withPlayer((player) => {
    // no rig
    expect(player.pointerAimActive()).toBe(false);
    expect(player.pointerAimYaw()).toBeNull();
    // a plain side rig (generic 2.5D game) stays movement-faced
    player.rig = PLAIN_RIG;
    expect(player.pointerAimActive()).toBe(false);
    expect(player.pointerAimYaw()).toBeNull();
    // editor overrides pointer aim off even under an aim rig
    player.rig = AIM_RIG; player.editorMode = true;
    expect(player.pointerAimActive()).toBe(false);
    expect(player.pointerAimYaw()).toBeNull();
  });
});

test('pointer aim needs a cursor: null until a pointer pixel is known', () => {
  withPlayer((player, camera) => {
    placeTopDown(camera, 10, -0.82);
    player.position.set(10, 1.7, -0.82); // feet at 0
    expect(player.pointerClient).toBeNull();
    expect(player.pointerAimYaw()).toBeNull();
  }, AIM_RIG);
});

// --- projection correctness (independent oracle) ----------------------------

test('pointerAimYaw points the body from its feet toward the cursor ground hit', () => {
  withPlayer((player, camera) => {
    const px = 10, pz = -0.82;
    placeTopDown(camera, px, pz);
    player.position.set(px, 1.7, pz); // eyeHeight 1.7 => feet 0 => aim plane 0
    for (const [tx, tz] of [[px, pz - 20], [px - 15, pz], [px + 25, pz + 5], [px, pz + 18]]) {
      player.pointerClient = pixelOf(camera, tx, 0, tz);
      const yaw = player.pointerAimYaw();
      const want = yawTo(px, pz, tx, tz);
      expect(Math.abs(Math.atan2(Math.sin(yaw - want), Math.cos(yaw - want)))).toBeCloseTo(0, 3);
    }
  }, AIM_RIG);
});

// --- update integration: aim is independent of strafing ---------------------

test('under aim rig, bodyYaw follows the cursor while strafing (aim != movement)', () => {
  withPlayer((player, camera) => {
    const px = 10, pz = -0.82;
    placeTopDown(camera, px, pz);
    player.position.set(px, 1.7, pz);
    player.locked = false; // pointer-aim runs WITHOUT pointer lock
    // cursor to the WEST (-X) => aim yaw ~ +PI/2
    player.pointerClient = pixelOf(camera, px - 40, 0, pz);
    player.keys = new Set(['KeyW']); // strafe NORTH (movement -Z)
    player.aimHeld = true;
    for (let i = 0; i < 40; i++) player.update(1 / 60);
    // moved north (canMove worked without lock)
    expect(player.position.z).toBeLessThan(pz - 0.05);
    // but the body faces the cursor, NOT the movement direction
    const aim = player.pointerAimYaw();
    expect(Math.abs(Math.atan2(Math.sin(player.bodyYaw - aim), Math.cos(player.bodyYaw - aim)))).toBeCloseTo(0, 3);
    // movement-facing (north) would be yaw ~0; aim (west) is ~+PI/2 -> they differ
    expect(Math.abs(player.bodyYaw)).toBeGreaterThan(1.0);
  }, AIM_RIG);
});

test('a plain side rig still faces movement (pointer aim does not leak in)', () => {
  withPlayer((player, camera) => {
    const px = 10, pz = -0.82;
    placeTopDown(camera, px, pz);
    player.position.set(px, 1.7, pz);
    player.locked = true;
    player.pointerClient = pixelOf(camera, px - 40, 0, pz); // a cursor is present but ignored
    player.keys = new Set(['KeyW']); // north
    for (let i = 0; i < 60; i++) player.update(1 / 60);
    // faces north (movement) => yaw ~ 0, NOT the west cursor
    expect(Math.abs(Math.atan2(Math.sin(player.bodyYaw), Math.cos(player.bodyYaw)))).toBeCloseTo(0, 1);
  }, PLAIN_RIG);
});

// --- fire yaw == rendered body yaw ------------------------------------------

test('authoritative fire yaw (bodyYaw) equals the rendered aim after update', () => {
  withPlayer((player, camera) => {
    const px = 10, pz = -0.82;
    placeTopDown(camera, px, pz);
    player.position.set(px, 1.7, pz);
    player.locked = false;
    player.pointerClient = pixelOf(camera, px + 30, 0, pz - 12);
    player.keys = new Set(['KeyD']); // strafe while aiming
    player.aimHeld = true;
    for (let i = 0; i < 20; i++) player.update(1 / 60);
    // weapons.fire() sends yaw: player.bodyYaw; it must equal the live aim
    const aim = player.pointerAimYaw();
    expect(player.bodyYaw).toBeCloseTo(aim, 6);
  }, AIM_RIG);
});

test('motion compensation doubles horizontal movement without doubling gravity', () => {
  const measure = (multiplier) => {
    let result;
    withPlayer((player) => {
      player.position.set(0, 100, 0);
      player.keys.add('KeyW');
      player.weaponSpeedMultiplier = 0.5;
      player.motionSpeedMultiplier = multiplier;
      for (let i = 0; i < 40; i++) player.update(0.005);
      result = player.position.clone();
    }, AIM_RIG);
    return result;
  };
  const normal = measure(1); const compensated = measure(2);
  expect(normal.z).toBeLessThan(0);
  expect(compensated.z).toBeCloseTo(normal.z * 2, 7);
  expect(compensated.y).toBeCloseTo(normal.y, 7);
});
