import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Player } from '../client/kernel/player.js';
import { Weapons } from '../client/kernel/weapons.js';

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, preventDefault() {}, stopPropagation() {}, ...event }); }
}

let prevWin, prevDoc, prevFetch, win, doc;
beforeEach(() => {
  prevWin = globalThis.window; prevDoc = globalThis.document; prevFetch = globalThis.fetch;
  win = new Events(); doc = new Events();
  Object.assign(doc, { activeElement: null, hidden: false, pointerLockElement: null });
  globalThis.window = win; globalThis.document = doc;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ weapons: [] }) });
});
afterEach(() => { globalThis.window = prevWin; globalThis.document = prevDoc; globalThis.fetch = prevFetch; });

function makePlayer({ menu = false, pointer = true } = {}) {
  const overlay = new Events(); overlay.style = { display: 'flex' }; overlay.dataset = menu ? { menu: '1' } : {};
  const dom = new Events(); dom.style = {}; dom.lockRequests = 0;
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 180 });
  dom.requestPointerLock = () => { dom.lockRequests += 1; doc.pointerLockElement = dom; doc.emit('pointerlockchange'); };
  const camera = new THREE.PerspectiveCamera(18, 320 / 180, 0.1, 5000);
  camera.position.set(0, 158, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const player = new Player({ camera, dom, overlay, view: undefined });
  player.rig = pointer ? { mode: 'side', yaw: 0, pitch: -Math.PI / 2, height: 158, aim: 'pointer' } : null;
  return { player, overlay, dom, camera };
}

function makeWeapons(player, dom, entity = { health: { hp: 100, max: 100 }, weapon: { name: 'Revolver', ammo: 6 } }) {
  const store = new Map([['p1', entity]]); const sent = [];
  const weapons = new Weapons({ store, player, send: (ops) => sent.push(...ops), domElement: dom });
  weapons.setPresence('p1'); weapons.byName = new Map([['Revolver', { name: 'Revolver', fireRate: 0, maxAmmo: 6 }]]);
  weapons.play = () => {};
  return { weapons, store, sent };
}

test('frozen title rejects overlay activation, movement and pointer aim', () => {
  const { player, overlay, dom } = makePlayer({ menu: true });
  player.frozen = true; overlay.emit('click');
  expect(player.controlsActive()).toBe(false);
  expect(player.pointerAimActive()).toBe(false);
  expect(dom.lockRequests).toBe(0);
  doc.emit('keydown', { code: 'KeyW' });
  expect(player.keys.size).toBe(0);
  player.syncOverlay(); expect(overlay.style.display).toBe('flex');
});

test('New Game activation; Escape pauses; overlay click resumes pointer aim without lock', () => {
  const { player, overlay, dom } = makePlayer({ menu: true });
  player.frozen = false; delete overlay.dataset.menu; // applyLevel lifecycle
  player.activateControls();
  expect(player.pointerAimActive()).toBe(true);
  expect(overlay.style.display).toBe('none');
  doc.emit('keydown', { code: 'Escape' });
  expect(player.controlsPaused).toBe(true);
  expect(overlay.style.display).toBe('flex');
  overlay.emit('click');
  expect(player.controlsActive()).toBe(true);
  expect(overlay.style.display).toBe('none');
  expect(dom.lockRequests).toBe(0);
});

test('pointer→generic mode switch exposes click-to-lock; editor excludes pointer aim', () => {
  const { player, overlay, dom } = makePlayer({ pointer: true });
  player.activateControls();
  expect(overlay.style.display).toBe('none');
  player.rig = null; player.syncOverlay();
  expect(player.controlsActive()).toBe(true);
  expect(player.inputActive()).toBe(false);
  expect(overlay.style.display).toBe('flex');
  doc.emit('keydown', { code: 'KeyW' });
  expect(player.keys.has('KeyW')).toBe(false);
  overlay.emit('click');
  expect(dom.lockRequests).toBe(1);
  expect(player.locked).toBe(true);
  expect(player.inputActive()).toBe(true);
  player.rig = { aim: 'pointer' }; player.editorMode = true;
  expect(player.pointerAimActive()).toBe(false);
});

test('blur and hidden visibility pause controls and clear movement', () => {
  const { player } = makePlayer(); player.activateControls(); player.keys.add('KeyW');
  win.emit('blur');
  expect(player.controlsPaused).toBe(true); expect(player.keys.size).toBe(0);
  player.activateControls(); player.keys.add('KeyD'); doc.hidden = true; doc.emit('visibilitychange');
  expect(player.controlsPaused).toBe(true); expect(player.keys.size).toBe(0);
});

test('window pointerup and hidden visibility clear firing outside canvas', () => {
  const { player, dom } = makePlayer(); player.activateControls();
  const { weapons } = makeWeapons(player, dom);
  dom.emit('pointerdown', { button: 0, clientX: 120, clientY: 80 });
  expect(weapons.firing).toBe(true); expect(player.aimHeld).toBe(true);
  win.emit('pointerup', { button: 0 });
  expect(weapons.firing).toBe(false); expect(player.aimHeld).toBe(false);
  dom.emit('pointerdown', { button: 0, clientX: 121, clientY: 81 });
  doc.hidden = true; doc.emit('visibilitychange');
  expect(weapons.firing).toBe(false); expect(player.aimHeld).toBe(false);
  weapons.dispose();
});

test('frozen/paused/dead controls cannot fire, reload or equip', () => {
  const { player, dom } = makePlayer();
  const { weapons, store, sent } = makeWeapons(player, dom);
  for (const state of ['paused', 'frozen', 'dead']) {
    player.frozen = state === 'frozen'; player.controlsPaused = state === 'paused';
    store.get('p1').health.hp = state === 'dead' ? 0 : 100;
    weapons.equip('Revolver'); weapons.reload(); weapons.fire();
  }
  expect(sent).toEqual([]);
  weapons.dispose();
});

test('first click coordinates aim body and first shot identically while strafing', () => {
  const { player, dom, camera } = makePlayer(); player.activateControls();
  player.position.set(0, 1.7, 0); player.keys.add('KeyW');
  const { weapons, sent } = makeWeapons(player, dom);
  // No preceding mousemove: click right of centre is the sole pointer sample.
  dom.emit('pointerdown', { button: 0, clientX: 240, clientY: 90 });
  expect(player.pointerClient).toEqual({ x: 240, y: 90 });
  player.update(1 / 60);
  const aimedYaw = player.bodyYaw;
  weapons.update();
  const fire = sent.find((op) => op.op === 'fire');
  expect(fire).toBeDefined();
  expect(fire.yaw).toBeCloseTo(aimedYaw, 9);
  expect(Math.abs(aimedYaw)).toBeGreaterThan(0.1);
  expect(player.position.z).toBeLessThan(0); // strafing/movement remains independent
  win.emit('pointerup', { button: 0 }); weapons.dispose();
});

test('idle cursor motion does not rotate source body; driving blocks fire', () => {
  const { player, dom } = makePlayer(); player.activateControls(); player.bodyYaw = 0.4;
  player.pointerClient = { x: 250, y: 90 }; player.update(1 / 60);
  expect(player.bodyYaw).toBeCloseTo(0.4, 9);
  const { weapons, sent } = makeWeapons(player, dom);
  player.vehicle = { carId: 'car' }; dom.emit('pointerdown', { button: 0, clientX: 250, clientY: 90 }); weapons.update();
  expect(sent.some((op) => op.op === 'fire')).toBe(false);
  weapons.dispose();
});
