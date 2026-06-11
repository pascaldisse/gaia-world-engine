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
import { Outliner } from './kernel/outliner.js';
import { Gizmos } from './kernel/gizmos.js';
import { EventConsole } from './kernel/console.js';
import { Editor } from './kernel/editor.js';
import { Environment } from './kernel/environment.js';
import { Zones } from './kernel/zones.js';
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
const view = new View({ scene, store, audio, effects, environment, camera, renderer });
const player = new Player({ camera, dom: renderer.domElement, overlay, view });
const zones = new Zones({ store, view, environment });

// world clock: synced from the server so motion agrees across all observers
const clock = { offset: 0, now: () => clock.offset + performance.now() / 1000 };
const behaviors = new Behaviors({ store, view, clock });

const presenceId = `player-${clientId}`;
view.ownPresence = presenceId;
let pendingShot = null;

const net = connect({
  url: `ws://${location.hostname}:${__GAIA_PORT__}`,
  presence: presenceId,
  onSnapshot: (entities, time, manifest, game) => {
    clock.offset = time - performance.now() / 1000;
    let spawnComp = null;
    for (const comps of Object.values(entities)) {
      if (comps.spawn) {
        spawnComp = comps.spawn;
        player.spawnPose = { position: comps.spawn.position ?? [0, 2, 22], yaw: comps.spawn.yaw ?? 0 };
        break;
      }
    }
    if (!player.spawned) {
      player.spawned = true;
      // the overlay text is the world's to claim — index.html ships it empty
      // so a titled game never flashes the GAIA defaults on boot
      overlayTitleEl.textContent = game?.title ?? 'GAIA';
      overlaySubEl.textContent = game ? '' : 'click to enter the world';
      // dev deep-links: ?create=1 opens creator mode (?select=<id> selects,
      // ?gizmos=a,b,c switches overlay categories on) — so tools and agents
      // can screenshot the editor without touching the keyboard
      const params = new URLSearchParams(location.search);
      const lvl = params.get('level');
      const deepLevel = lvl && game?.levels?.find((l) => l.id === lvl || l.name === lvl);
      if (game && !params.has('create') && !deepLevel) {
        // the title menu IS a scene: the camera holds game.json's menu shot
        // while the world streams and renders behind the card — but no body
        // exists (frozen, no presence spawned) until a level is chosen
        const cam = game.menu?.camera ?? {};
        player.position.set(...(cam.position ?? player.spawnPose?.position ?? [0, 2, 22]));
        player.yaw = cam.yaw ?? 0;
        player.pitch = cam.pitch ?? 0;
        player.frozen = true;
        if (spawnComp?.gameMode && !player.gameMode) editor.toggleGameMode();
        buildTitleScreen(game);
      } else {
        player.respawn();
        if (params.has('create')) {
          setTimeout(() => {
            overlay.style.display = 'none';
            editor.enterCreate();
            for (const key of (params.get('gizmos') ?? '').split(',').filter(Boolean)) gizmos.toggle(key);
            const sel = params.get('select');
            if (sel) {
              editor.select(sel);
              editor.frameSelected();
            }
            // explicit camera pose beats framing when you know the shot you want
            const pos = params.get('pos')?.split(',').map(Number);
            if (pos?.length === 3 && pos.every((n) => Number.isFinite(n))) player.position.set(...pos);
            if (params.has('yaw')) player.yaw = Number(params.get('yaw')) || 0;
            if (params.has('pitch')) player.pitch = Number(params.get('pitch')) || 0;
          }, 800);
        } else if (spawnComp?.gameMode && !player.gameMode) {
          // a world can declare itself a game: editing locked until G
          editor.toggleGameMode();
        }
        // ?level=<id> starts straight at a level select entry with the SAME
        // setup logic as the menu (agents and humans alike skip the walk)
        if (deepLevel) {
          setTimeout(() => {
            overlay.style.display = 'none';
            applyLevel(deepLevel, { lock: false });
          }, 400);
        }
      }
    }
    // zone set must be known before the snapshot builds, so only the
    // player's surroundings (plus backdrops) turn into meshes
    zones.setManifest(manifest);
    zones.update(player.position);
    store.applySnapshot(entities);
    countEl.textContent = store.entities.size;
    // while the title menu is up there is no body in the world — the
    // presence spawns when a level is chosen (and re-spawns on reconnect)
    if (!overlay.dataset.menu) ensurePresence();
  },
  onOps: (ops, from) => {
    // zone ops edit the manifest, not an entity — streaming re-derives live
    for (const op of ops) {
      if (op.op === 'zone') {
        zones.applyZoneOp(op);
        zones.update(player.position);
        gizmos.dirty = true;
      }
    }
    store.applyOps(ops);
    countEl.textContent = store.entities.size;
    panel.refresh();
    econsole.add(ops, from);
    handleEvents(ops);
  },
  onStatus: (s) => {
    statusEl.textContent = s;
  },
  onScreenshot: (id, from) => {
    if (from && from !== presenceId) return; // addressed to another tab
    pendingShot = id;
  },
});

// ---- title screen: a world's game.json replaces the default overlay with
// NEW GAME / LEVEL SELECT. A level entry is pure data: { id, name, spawn:
// {position, yaw}, reset, ops } — its ops run with `$id` resolved to the
// choosing presence (the same convention interacts use), so "equipment and
// stats" are just components granted by ops. The same entries power ?level=.
const menuEl = document.getElementById('menu');
const overlayTitleEl = document.getElementById('overlay-title');
const overlaySubEl = document.getElementById('overlay-sub');

// the player's body, spawned on demand: immediately on plain worlds, only
// when a level is chosen on menu worlds (the menu scene has no body in it)
function ensurePresence() {
  if (store.get(presenceId)) return;
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

function applyLevel(level, { lock = true } = {}) {
  player.frozen = false;
  if (level.spawn?.position) {
    player.spawnPose = { position: level.spawn.position, yaw: level.spawn.yaw ?? 0 };
  }
  player.respawn();
  // the body must exist BEFORE the level ops run — their `$id` merges
  // (equipment, the carried flame) land on the presence entity
  ensurePresence();
  const ops = [];
  if (level.reset) ops.push({ op: 'reset' });
  for (const op of level.ops ?? []) {
    ops.push(JSON.parse(JSON.stringify(op).replaceAll('"$id"', JSON.stringify(presenceId))));
  }
  if (ops.length) net.send(ops);
  // the menu's job is done — from here the overlay is a plain pause screen
  delete overlay.dataset.menu;
  menuEl.style.display = 'none';
  overlaySubEl.textContent = 'click to continue';
  if (lock) renderer.domElement.requestPointerLock();
}

function buildTitleScreen(game) {
  overlayTitleEl.textContent = game.title ?? 'GAIA';
  overlaySubEl.textContent = game.subtitle ?? '';
  overlay.dataset.menu = '1';
  menuEl.replaceChildren();
  menuEl.style.display = 'flex';
  const levels = game.levels ?? [];
  const option = (label, onPick) => {
    const el = document.createElement('div');
    el.className = 'menu-option';
    el.textContent = label;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick();
    });
    menuEl.appendChild(el);
    return el;
  };
  option('NEW GAME', () => applyLevel(levels[0] ?? { reset: true }));
  if (levels.length > 1) {
    const list = document.createElement('div');
    list.className = 'menu-levels';
    option('LEVEL SELECT', () => {
      list.style.display = list.style.display === 'flex' ? 'none' : 'flex';
    });
    for (const level of levels) {
      const el = document.createElement('div');
      el.className = 'menu-level';
      el.textContent = level.name ?? level.id;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        applyLevel(level);
      });
      list.appendChild(el);
    }
    menuEl.appendChild(list);
  }
}

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
    if (op.name === 'title') showTitle(op.data?.text ?? '');
    for (const [id, comps] of store.entities) {
      if (comps.sfx?.on === op.name) audio.oneShot(comps.sfx, view.getGroup(id));
    }
  }
}

// M mutes (persists per browser); ?mute=1 starts muted — agents open their
// work tabs with it so verification never makes noise on the player's machine
const mutedEl = document.getElementById('muted');
function applyMuted(on, persist = true) {
  audio.setMuted(on);
  mutedEl.style.display = on ? '' : 'none';
  if (persist) localStorage.setItem('gaia-muted', on ? '1' : '0');
}
if (new URLSearchParams(location.search).has('mute')) applyMuted(true, false);
else if (localStorage.getItem('gaia-muted') === '1') applyMuted(true, false);
document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.metaKey || e.ctrlKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
  applyMuted(!audio.muted);
});

// ~ toggles the debug panel: live look-dev knobs
const debugEl = document.getElementById('debug');
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Backquote') return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  debugEl.style.display = debugEl.style.display === 'flex' ? 'none' : 'flex';
  if (debugEl.style.display === 'flex') highlightDebugKnob();
});
function debugKnob(name, onChange, format = (v) => `${v.toFixed(2)}×`) {
  const input = document.getElementById(`debug-${name}`);
  const label = document.getElementById(`debug-${name}-value`);
  input.addEventListener('input', () => {
    label.textContent = format(Number(input.value));
    onChange(Number(input.value));
  });
}
debugKnob('exposure', (v) => (environment.debugMul = v));
// skylight ADDS a global ambient — zone hemispheres are often near-black on
// purpose, so a multiplier would do nothing
debugKnob('skylight', (v) => (environment.debugAmbient = v), (v) => `+${v.toFixed(2)}`);
debugKnob('fog', (v) => (environment.debugFog = v));
// storm writes the world's weather (it is a live world — everyone gets your sky)
let stormTimer = null;
debugKnob('storm', (v) => {
  clearTimeout(stormTimer);
  stormTimer = setTimeout(() => {
    for (const [id, comps] of store.entities) {
      if (comps.weather) {
        net.send([{ op: 'merge', id, component: 'weather', value: { frequency: v } }]);
        break;
      }
    }
  }, 250);
});
// flame: reach of the light YOUR presence carries — does nothing until a
// world has granted you one. distance alone is only a cutoff (inverse-square
// decay has long faded by then), so intensity scales with the square of the
// reach — that's what actually grows or shrinks the lit area. Scaling off the
// current spec makes the mapping round-trip: 30→60→30 lands back on the
// granted intensity exactly.
let flameTimer = null;
debugKnob('flame', (v) => {
  clearTimeout(flameTimer);
  flameTimer = setTimeout(() => {
    const light = store.get(presenceId)?.light;
    if (!light) return;
    const d = light.distance || 30;
    const intensity = (light.intensity ?? 10) * (v / d) ** 2;
    net.send([{ op: 'merge', id: presenceId, component: 'light', value: { distance: v, intensity } }]);
  }, 150);
}, (v) => `${v.toFixed(0)}m`);

// '+' drops a debug snapshot: the rendered frame + a json of what the world
// knew at that moment (pose, carried components, quest state, nearby ids,
// the agent-sense look) — written by the server into debug/, same stamp.
// Captured in the render loop right after render: a WebGPU canvas only
// reads back reliably in the same task that drew it.
let pendingSnapshot = false;
document.addEventListener('keydown', (e) => {
  if (e.key !== '+' || e.metaKey || e.ctrlKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  pendingSnapshot = true;
});
function captureSnapshot() {
  pendingSnapshot = false;
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch(`http://${location.hostname}:${__GAIA_PORT__}/snapshot`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            image: reader.result,
            player: {
              id: presenceId,
              position: [r2(player.position.x), r2(player.position.y), r2(player.position.z)],
              yaw: r2(player.yaw),
              pitch: r2(player.pitch),
              zone: zones.current,
            },
          }),
        });
        const { file } = await res.json();
        console.log(`[gaia] snapshot ${file}`);
        const prev = statusEl.textContent;
        statusEl.textContent = `snapshot ${file}`;
        setTimeout(() => {
          if (statusEl.textContent.startsWith('snapshot')) statusEl.textContent = prev;
        }, 2500);
      } catch (err) {
        console.warn('[gaia] snapshot failed', err);
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

// the debug menu drives with arrow keys too: ↑/↓ pick a knob, ←/→ nudge it
const debugKnobNames = ['exposure', 'skylight', 'fog', 'storm', 'flame'];
let debugSelected = 0;
function highlightDebugKnob() {
  debugKnobNames.forEach((name, i) => {
    document.getElementById(`debug-${name}`).parentElement.classList.toggle('selected', i === debugSelected);
  });
}
document.addEventListener('keydown', (e) => {
  if (debugEl.style.display !== 'flex') return;
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    debugSelected = (debugSelected + (e.code === 'ArrowDown' ? 1 : debugKnobNames.length - 1)) % debugKnobNames.length;
    highlightDebugKnob();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault(); // ours, not the focused slider's — no double steps
    const input = document.getElementById(`debug-${debugKnobNames[debugSelected]}`);
    const step = Number(input.step) || 1;
    const next = Number(input.value) + (e.code === 'ArrowRight' ? step : -step);
    input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
    input.dispatchEvent(new Event('input'));
  }
});

const titleEl = document.getElementById('title');
let titleTimer = null;
function showTitle(text) {
  if (!titleEl || !text) return;
  titleEl.textContent = text;
  titleEl.style.opacity = '1';
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    titleEl.style.opacity = '0';
  }, 5200);
}

// the body speaks: splash/sinking/drown from the player controller become
// world events (journaled — agents hear them too) and local presentation
player.onEvent = (name, data) => {
  net.send([{ op: 'event', name, data: { ...data, by: presenceId } }]);
  if (name === 'splash') audio.splash();
  if (name === 'drown') {
    environment.dip(2.2);
    audio.thunder(0.35, 0.1);
  }
  if (name === 'void') environment.dip(1.4);
};

// L toggles the world log: the op stream, live (?log=1 starts it open)
const econsole = new EventConsole({ el: document.getElementById('console') });
if (new URLSearchParams(location.search).has('log')) econsole.toggle();

const history = new History(net.send);
const interact = new Interact({ camera, scene, store, view, send: net.send, player, hintEl, history, presence: presenceId });
const panel = new Panel({
  el: document.getElementById('panel'),
  store,
  view,
  zones,
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
const gizmos = new Gizmos({ scene, store, view, zones });
const outliner = new Outliner({
  el: document.getElementById('outliner'),
  store,
  view,
  zones,
  gizmos,
  onPick: (id) => editor.select(id),
  onFocus: (id) => {
    editor.select(id);
    editor.frameSelected();
  },
  // the streaming geography is editable like everything else: the zone's
  // manifest entry opens in the inspector, commits as `zone` ops
  onZone: (name) => {
    editor.select(null);
    panel.showZone(name);
  },
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
  outliner,
  gizmos,
  modeEl: document.getElementById('mode'),
});

document.addEventListener('pointerlockchange', () => {
  crosshairEl.style.display = player.locked && !player.editorMode ? 'block' : 'none';
});

// debug handle: poke the kernel from the devtools console (or CDP)
window.gaia = { store, view, zones, gizmos, outliner, editor, panel, econsole, environment, player, audio, net };

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
  for (const [id, state] of view.particleSystems) {
    if (view.getGroup(id)?.userData.hidden) continue; // streamed-out zones sleep
    updateParticles(state, t);
  }
  player.update(dt);
  zones.update(player.position);
  player.voidY = zones.currentVoidY;
  view.update();
  interact.update(dt, now);
  // drowning overrides the interaction hint — the water is the message
  if (player.sinking) hintEl.textContent = 'the water takes you…';
  else if (player.swimming && player.swimTime > player.swimLimit * 0.5) {
    hintEl.textContent = 'your strength fades — reach for the boat';
  }
  editor.update();
  gizmos.update();
  outliner.update();
  publishPresence(now);
  if (post) post.render();
  else renderer.render(scene, camera);
  if (pendingShot !== null) captureShot();
  if (pendingSnapshot) captureSnapshot();
});
