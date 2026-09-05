import { beforeEach, afterEach, test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Player } from '../client/kernel/player.js';
import { Interact } from '../client/kernel/interact.js';

class Events {
  constructor() { this.listeners = new Map(); this.style = {}; this.dataset = {}; }
  addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, preventDefault() {}, ...event }); }
}

let priorDocument, priorWindow, doc, win;
beforeEach(() => {
  priorDocument = globalThis.document; priorWindow = globalThis.window;
  doc = new Events(); Object.assign(doc, { activeElement: null, hidden: false, pointerLockElement: null });
  win = new Events(); globalThis.document = doc; globalThis.window = win;
});
afterEach(() => { globalThis.document = priorDocument; globalThis.window = priorWindow; });

function setupInteract({ id = 'bank-door', prompt = 'Enter bank' } = {}) {
  const camera = new THREE.PerspectiveCamera();
  const canvas = new Events(); canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 180 }); canvas.requestPointerLock = () => {};
  const overlay = new Events(); overlay.style.display = 'flex';
  const player = new Player({ camera, dom: canvas, overlay, view: undefined });
  player.rig = { mode: 'side', aim: 'pointer', yaw: 0, pitch: -Math.PI / 2 };
  player.position.set(0, 1.7, 0); player.activateControls();
  const components = { transform: { position: [1, 0, 0] }, interact: { prompt, radius: 3.5, ops: [{ op: 'noop' }] } };
  const entities = new Map([[id, components]]);
  const store = { entities, get: (query) => entities.get(query) };
  const group = new THREE.Group(); group.position.set(1, 0, 0); group.userData.hidden = false;
  const view = {
    groups: new Map([[id, group]]), getGroup: (query) => query === id ? group : null,
    suppress() {}, unsuppress() {}, rootIdOf: () => id,
  };
  const sent = []; const hintEl = { textContent: '' };
  const interact = new Interact({
    camera, scene: new THREE.Scene(), store, view, send: (ops) => sent.push(...ops),
    player, hintEl, presence: 'player', clock: { now: () => 0 },
  });
  return { player, interact, sent, hintEl, id };
}

function pressE() { doc.emit('keydown', { code: 'KeyE' }); }

test('unlocked pointer-aim Player gets bank prompt and real E sends use', () => {
  const { player, interact, sent, hintEl, id } = setupInteract();
  expect(player.locked).toBe(false); expect(player.inputActive()).toBe(true);
  interact.update(1 / 60, 0);
  expect(hintEl.textContent).toBe('Enter bank — E');
  pressE();
  expect(sent).toEqual([{ op: 'use', id, by: 'player' }]);
});

test('unlocked pointer-aim Player gets car prompt, real E enters, and mounted E exits', () => {
  const { player, interact, sent, hintEl, id } = setupInteract({ id: 'parked-car', prompt: 'Steal car' });
  interact.update(1 / 60, 0);
  expect(hintEl.textContent).toBe('Steal car — E');
  pressE();
  expect(sent.at(-1)).toEqual({ op: 'use', id, by: 'player' });
  player.vehicle = { carId: id };
  interact.update(1 / 60, 1);
  expect(hintEl.textContent).toBe('driving — E exit');
  pressE();
  expect(sent.at(-1)).toEqual({ op: 'carexit', by: 'player' });
});

test('typing, pause, frozen, editor and gameover block prompt and real E', () => {
  const { player, interact, sent, hintEl } = setupInteract();
  const cases = [
    () => { doc.activeElement = { tagName: 'INPUT' }; },
    () => { doc.activeElement = null; player.pauseControls(); },
    () => { player.activateControls(); player.frozen = true; },
    () => { player.frozen = false; player.activateControls(); player.editorMode = true; },
    () => { player.editorMode = false; player.activateControls(); player.addInputBlock('hud-gameover'); },
  ];
  for (const apply of cases) {
    apply(); interact.update(1 / 60, 0);
    expect(hintEl.textContent).toBe('');
    pressE(); expect(sent).toHaveLength(0);
  }
});

test('generic documented player.locked seam still enables prompt and E', () => {
  const { player, interact, sent } = setupInteract();
  player.rig = null; player.controlsPaused = true; player.locked = true;
  interact.pick = () => ({ id: 'bank-door', distance: 1 });
  expect(player.inputActive()).toBe(true);
  interact.update(1 / 60, 0); pressE();
  expect(sent.at(-1)?.op).toBe('use');
});
