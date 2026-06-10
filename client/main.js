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
import { connect, clientId } from './kernel/net.js';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const overlay = document.getElementById('overlay');
const crosshairEl = document.getElementById('crosshair');
const hintEl = document.getElementById('hint');

const { renderer, scene, camera, hemi, sun, post } = await createRenderer();
const store = new WorldStore();
const audio = new AudioEngine(camera);
const effects = new Effects({ scene, audio });
const environment = new Environment({ renderer, scene, hemi, sun, post, audio });
const view = new View({ scene, store, audio, effects, environment });
const player = new Player({ camera, dom: renderer.domElement, overlay });

// world clock: synced from the server so motion agrees across all observers
const clock = { offset: 0, now: () => clock.offset + performance.now() / 1000 };
const behaviors = new Behaviors({ store, view, clock });

const presenceId = `player-${clientId}`;
view.ownPresence = presenceId;
let pendingShot = null;

const net = connect({
  url: `ws://${location.hostname}:8420`,
  presence: presenceId,
  onSnapshot: (entities, time) => {
    clock.offset = time - performance.now() / 1000;
    store.applySnapshot(entities);
    countEl.textContent = store.entities.size;
    if (!store.get(presenceId)) {
      net.send([
        {
          op: 'spawn',
          id: presenceId,
          components: {
            presence: { kind: 'player', yaw: 0 },
            transform: { position: [player.position.x, player.position.y, player.position.z] },
            mesh: {
              parts: [
                { shape: 'sphere', radius: 0.3, color: '#cfe3ff', emissive: '#aac8ff', emissiveIntensity: 1.4, castShadow: false },
              ],
            },
          },
        },
      ]);
    }
  },
  onOps: (ops) => {
    store.applyOps(ops);
    countEl.textContent = store.entities.size;
    panel.refresh();
    handleEvents(ops);
  },
  onStatus: (s) => {
    statusEl.textContent = s;
  },
  onScreenshot: (id) => {
    pendingShot = id;
  },
});

function handleEvents(ops) {
  for (const op of ops) {
    if (op.op === 'set' && op.component === 'weather') {
      const rain = op.value?.rain ?? 0;
      for (const state of view.particleSystems.values()) {
        if (state.spec.motion?.type === 'rain') state.mesh.count = Math.round(state.count * rain);
      }
    }
    if (op.op !== 'event') continue;
    if (op.name === 'prefabs-changed') palette.load();
    if (op.name === 'lightning') {
      environment.flash(op.data?.intensity ?? 0.8);
      audio.thunder(op.data?.intensity ?? 0.8, op.data?.delay ?? 1.4);
    }
    for (const [id, comps] of store.entities) {
      if (comps.sfx?.on === op.name) audio.oneShot(comps.sfx, view.getGroup(id));
    }
  }
}

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

// publish the player's pose so agents can sense them
let lastPresence = { x: 0, y: 0, z: 0, yaw: 0, t: 0 };
function publishPresence(now) {
  if (now - lastPresence.t < 300 || !store.get(presenceId)) return;
  const { x, y, z } = player.position;
  const moved = Math.hypot(x - lastPresence.x, y - lastPresence.y, z - lastPresence.z) > 0.3;
  const turned = Math.abs(player.yaw - lastPresence.yaw) > 0.15;
  if (!moved && !turned) return;
  lastPresence = { x, y, z, yaw: player.yaw, t: now };
  net.send([
    { op: 'merge', id: presenceId, component: 'transform', value: { position: [r2(x), r2(y), r2(z)] } },
    { op: 'merge', id: presenceId, component: 'presence', value: { yaw: r2(player.yaw) } },
  ]);
}

function captureShot() {
  const id = pendingShot;
  pendingShot = null;
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => net.sendRaw({ type: 'screenshot', id, data: reader.result.split(',')[1] });
    reader.readAsDataURL(blob);
  }, 'image/png');
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = clock.now();
  behaviors.update(dt);
  effects.update(dt);
  environment.update(dt);
  for (const state of view.particleSystems.values()) updateParticles(state, t);
  player.update(dt);
  interact.update(dt, now);
  editor.update();
  publishPresence(now);
  if (post) post.render();
  else renderer.render(scene, camera);
  if (pendingShot !== null) captureShot();
});
