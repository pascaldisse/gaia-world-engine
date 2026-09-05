import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Player } from '../client/kernel/player.js';
import { Weapons } from '../client/kernel/weapons.js';

// --- Player: overlay follows control liveness; focus loss drops held keys ----

function makePlayer() {
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener() {}, activeElement: null, hidden: false };
  const overlay = { style: { display: 'flex' }, dataset: {}, addEventListener() {} };
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }), requestPointerLock() {}, addEventListener() {}, removeEventListener() {} };
  const player = new Player({ camera: new THREE.PerspectiveCamera(), dom, overlay, view: undefined });
  return { player, overlay, restore: () => { globalThis.document = prevDoc; } };
}

test('syncOverlay: hidden under a pointer-aim rig (no lock), shown when idle', () => {
  const { player, overlay, restore } = makePlayer();
  try {
    player.locked = false; player.editorMode = false;
    player.rig = { mode: 'side', aim: 'pointer' };
    player.syncOverlay();
    expect(overlay.style.display).toBe('none'); // visible-cursor play, no card
    player.rig = { mode: 'side' }; // plain rig, not locked -> pause card shows
    player.syncOverlay();
    expect(overlay.style.display).toBe('flex');
    player.locked = true; // locked FPS -> hidden
    player.syncOverlay();
    expect(overlay.style.display).toBe('none');
  } finally { restore(); }
});

test('syncOverlay never fights the title menu (dataset.menu)', () => {
  const { player, overlay, restore } = makePlayer();
  try {
    overlay.dataset.menu = '1';
    overlay.style.display = 'flex';
    player.rig = { aim: 'pointer' };
    player.syncOverlay();
    expect(overlay.style.display).toBe('flex'); // menu stays up
  } finally { restore(); }
});

test('focus loss releases held keys (no stuck sprint) — the blur handler', () => {
  const { player, restore } = makePlayer();
  try {
    player.keys.add('KeyW');
    player.keys.add('ShiftLeft');
    expect(player.keys.size).toBe(2);
    player._releaseKeys(); // what window blur / visibilitychange invoke
    expect(player.keys.size).toBe(0);
  } finally { restore(); }
});

// --- Weapons: focus loss stops firing; fire yaw is the body yaw --------------

let prevWin, prevDoc, prevFetch;
beforeEach(() => {
  prevWin = globalThis.window; prevDoc = globalThis.document; prevFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { addEventListener() {}, activeElement: null };
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ weapons: [] }) });
});
afterEach(() => { globalThis.window = prevWin; globalThis.document = prevDoc; globalThis.fetch = prevFetch; });

function makeWeapons(player) {
  const dom = { addEventListener() {}, removeEventListener() {} };
  return new Weapons({ view: {}, store: new Map(), camera: {}, player, send: () => {}, domElement: dom });
}

test('focus loss stops firing (no frozen trigger) — Weapons blur handler', () => {
  const w = makeWeapons({ locked: true, pointerAimActive: () => false });
  w.firing = true;
  w.onBlur();
  expect(w.firing).toBe(false);
});

test('fire() sends op fire with yaw = the authoritative body yaw', () => {
  const player = { locked: false, pointerAimActive: () => true, bodyYaw: 1.2345, vehicle: null };
  const w = makeWeapons(player);
  const sent = [];
  w.send = (ops) => sent.push(...ops);
  w.play = () => {}; // isolate from the animation view
  w.ownWeapon = () => ({ name: 'Revolver' }); // equipped weapon (server-authoritative in prod)
  w.byName = new Map([['Revolver', { fireRate: 0 }]]);
  w.presence = 'p1';
  w.nextFireAt = 0;
  w.fire();
  expect(sent.length).toBe(1);
  expect(sent[0].op).toBe('fire');
  expect(sent[0].by).toBe('p1');
  expect(sent[0].yaw).toBe(1.2345); // == rendered bodyYaw => body and shot agree
});
