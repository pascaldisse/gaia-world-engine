import { createRenderer } from './kernel/renderer.js';
import { WorldStore } from './kernel/world.js';
import { View } from './kernel/view.js';
import { Player } from './kernel/player.js';
import { AudioEngine } from './kernel/audio.js';
import { Behaviors } from './kernel/behaviors.js';
import { Effects } from './kernel/effects.js';
import { Interact } from './kernel/interact.js';
import { connect } from './kernel/net.js';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const overlay = document.getElementById('overlay');
const crosshairEl = document.getElementById('crosshair');
const hintEl = document.getElementById('hint');

const { renderer, scene, camera } = await createRenderer();
const store = new WorldStore();
const audio = new AudioEngine(camera);
const effects = new Effects({ scene, audio });
const view = new View({ scene, store, audio, effects });
const player = new Player({ camera, dom: renderer.domElement, overlay });
const behaviors = new Behaviors({ store, view });

const net = connect({
  url: `ws://${location.hostname}:8420`,
  onSnapshot: (entities) => {
    store.applySnapshot(entities);
    countEl.textContent = store.entities.size;
  },
  onOps: (ops) => {
    store.applyOps(ops);
    countEl.textContent = store.entities.size;
  },
  onStatus: (s) => {
    statusEl.textContent = s;
  },
});

const interact = new Interact({ camera, scene, store, view, send: net.send, player, hintEl });

document.addEventListener('pointerlockchange', () => {
  crosshairEl.style.display = player.locked ? 'block' : 'none';
});

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  behaviors.update(dt);
  effects.update(dt);
  player.update(dt);
  interact.update(dt, now);
  renderer.render(scene, camera);
});
