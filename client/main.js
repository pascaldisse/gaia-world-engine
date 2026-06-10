import { createRenderer } from './kernel/renderer.js';
import { WorldStore } from './kernel/world.js';
import { View } from './kernel/view.js';
import { Player } from './kernel/player.js';
import { AudioEngine } from './kernel/audio.js';
import { Behaviors } from './kernel/behaviors.js';
import { Effects } from './kernel/effects.js';
import { Interact } from './kernel/interact.js';
import { History } from './kernel/history.js';
import { Panel } from './kernel/panel.js';
import { Palette } from './kernel/palette.js';
import { Editor } from './kernel/editor.js';
import { Environment } from './kernel/environment.js';
import { updateParticles } from './kernel/particles.js';
import { connect } from './kernel/net.js';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const overlay = document.getElementById('overlay');
const crosshairEl = document.getElementById('crosshair');
const hintEl = document.getElementById('hint');

const { renderer, scene, camera, hemi, sun, post } = await createRenderer();
const store = new WorldStore();
const audio = new AudioEngine(camera);
const effects = new Effects({ scene, audio });
const environment = new Environment({ renderer, scene, hemi, sun, post });
const view = new View({ scene, store, audio, effects, environment });
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
    panel.refresh();
    for (const op of ops) {
      if (op.op === 'event' && op.name === 'prefabs-changed') palette.load();
    }
  },
  onStatus: (s) => {
    statusEl.textContent = s;
  },
});

const history = new History(net.send);
const interact = new Interact({ camera, scene, store, view, send: net.send, player, hintEl, history });
const panel = new Panel({
  el: document.getElementById('panel'),
  store,
  send: net.send,
  history,
  onDuplicate: (id) => editor.duplicate(id),
  onDelete: (id) => editor.delete(id),
});
const palette = new Palette({
  el: document.getElementById('palette'),
  store,
  view,
  send: net.send,
  history,
  camera,
  renderer,
});
const editor = new Editor({
  camera,
  scene,
  renderer,
  store,
  view,
  send: net.send,
  player,
  history,
  panel,
  palette,
  modeEl: document.getElementById('mode'),
});

document.addEventListener('pointerlockchange', () => {
  crosshairEl.style.display = player.locked && !player.editorMode ? 'block' : 'none';
});

let last = performance.now();
let elapsed = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;
  behaviors.update(dt);
  effects.update(dt);
  for (const state of view.particleSystems.values()) updateParticles(state, elapsed);
  player.update(dt);
  interact.update(dt, now);
  editor.update();
  if (post) post.render();
  else renderer.render(scene, camera);
});
