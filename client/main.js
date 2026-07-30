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
import { Scenes } from './kernel/scenes.js';
import { Shading } from './kernel/shading.js';
import { ViewFx } from './kernel/viewfx.js';
import { CharacterCreator } from './plugins/character-creator.js';
import { VrmEditor } from './plugins/vrm-editor.js';
import { loadExtensions, gateModule } from './kernel/extensions.js';
import { updateVrms } from './kernel/vrm.js';
import { makeRain } from './kernel/rain.js';
import { updateParticles, rainDebug } from './kernel/particles.js';
import { setMaterialLibrary, mergeMaterial, partsOf } from './kernel/geometry.js';
import { connect, clientId } from './kernel/net.js';
import { connectStatic, staticModeRequested } from './kernel/static-world.js';
import { isTyping } from './kernel/dom.js';
import { substitute } from '../shared/ops.js';
import { r2 } from '../shared/num.js';

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const overlay = document.getElementById('overlay');
const crosshairEl = document.getElementById('crosshair');
const hintEl = document.getElementById('hint');

const { renderer, scene, camera, hemi, sun, post, pixels } = await createRenderer();
const store = new WorldStore();
const audio = new AudioEngine(camera);
const effects = new Effects({ scene, audio });
const environment = new Environment({ renderer, scene, hemi, sun, post, audio });
const view = new View({ scene, store, audio, effects, environment, camera, renderer });
const player = new Player({ camera, dom: renderer.domElement, overlay, view });
view.player = player;
// EXTENSIONS ARE A PARAMETER (kernel/extensions.js). The default list is this
// engine's own historical wiring, so nothing here changes unless a host page
// passes `window.__GAIA_EXTENSIONS__` — which is how the Paleblood Atlas boots
// its OWN copies from paloptic instead of these.
const extensions = await loadExtensions({ store, view, camera, player, dom: renderer.domElement, renderer, scene, audio, effects, environment });
// a scene's `camera` component drives the rig: side mode fixes the frame,
// shows the body, and retires the crosshair (E picks by the body instead)
const scenes = new Scenes({
  store,
  view,
  environment,
  onCamera: (spec) => {
    player.rig = spec ?? null;
    view.showOwnBody = !!spec;
    syncCrosshair();
  },
});
const shading = new Shading({ view, renderer });
const viewFx = new ViewFx({ scene, view, environment, post });

// ■ stop — the editor's rest state, like any game editor's edit mode: world
// motion (behaviors), vfx (particles), interactions and sound hold still.
// You still move, streaming still streams, edits still apply and broadcast.
const sim = { stopped: false };

// world clock: synced from the server so motion agrees across all observers
const clock = { offset: 0, now: () => clock.offset + performance.now() / 1000 };
const behaviors = new Behaviors({ store, view, clock });

const presenceId = `player-${clientId}`;
view.ownPresence = presenceId;
let pendingShot = null;

// THE GATE, BEFORE THE BOOT: everything below this line is the world's data
// path — the WS connect a few lines down, and (sequentially, same top-level
// module) every fetch every plugin constructed after it fires eagerly
// (Palette's /prefabs load chief among them). atlas-gate.js's overlay alone
// is presentation-layer only (see its own HONESTY NOTE) — the real stop has
// to be this await, not a DOM layer sitting on top of an already-booted
// client. Mirrors atlas-intro.js's waitForGate(): passedAlready() (valid
// localStorage token) lets a returning visitor through with zero delay, and
// an unreachable gate config never becomes a second, silent lock.
async function waitForGate() {
  try {
    const mod = gateModule();
    if (!mod) return;                       // explicitly no gate: boot straight in
    // a string is a URL to fetch; anything else the host page already imported
    // (the only form a bundler can see — see kernel/extensions.js)
    if (typeof mod === 'string') await import(/* @vite-ignore */ mod);
    const gate = window.gaia?.atlasGate?.gate;
    if (gate && (await gate.passedAlready())) return;
  } catch (err) {
    console.warn('[gaia] gate unavailable — booting anyway', err);
    return;
  }
  await new Promise((res) => window.addEventListener('atlas-gate-passed', res, { once: true }));
}
await waitForGate();

// STATIC BOOT MODE: no world server, no vite dev — ?static=1 (or a build
// baked with GAIA_STATIC_BUILD=1) hydrates from client/assets/world-snapshot.json
// instead of opening a websocket. Same callbacks, same `net` shape either way
// (see kernel/static-world.js) — nothing below this line knows which one ran.
const staticMode = __GAIA_STATIC__ || staticModeRequested();
const netConfig = {
  url: `ws://${location.hostname}:${__GAIA_PORT__}`,
  presence: presenceId,
  onSnapshot: (entities, time, world, game, materials) => {
    clock.offset = time - performance.now() / 1000;
    // named materials resolve at mesh build — the library must be known
    // before the snapshot turns into meshes (geometry.js owns the copy)
    setMaterialLibrary(materials ?? {});
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
    // the active scene set must be known before the snapshot builds, so only
    // the player's surroundings (plus backdrops) turn into meshes
    scenes.setWorld(world);
    scenes.update(player.position);
    store.applySnapshot(entities);
    extensions.sync();
    // the scene was current before its entities existed (setWorld precedes
    // the snapshot apply) — now that they do, derive its camera rig
    scenes.applyCamera();
    countEl.textContent = store.entities.size;
    // while the title menu is up there is no body in the world — the
    // presence spawns when a level is chosen (and re-spawns on reconnect)
    if (!overlay.dataset.menu) ensurePresence();
    // a warp that landed while we were away still executes (edge = the value
    // existing, not the op arriving — reconnects must not strand the body)
    const pendingWarp = store.get(presenceId)?.warp;
    if (pendingWarp?.position) applyWarp(pendingWarp);
  },
  onOps: (ops, from) => {
    // scene ops edit the world file, not an entity — streaming re-derives live
    for (const op of ops) {
      if (op.op === 'scene') {
        scenes.applySceneOp(op);
        scenes.update(player.position);
        gizmos.dirty = true;
      } else if (op.op === 'material') {
        // library edit: re-resolve and rebuild whatever references the name —
        // shared caches make untouched parts free
        mergeMaterial(op.name, op.value);
        for (const [id, comps] of store.entities) {
          if (partsOf(comps.mesh).some((p) => p.material === op.name)) view.applyComponent(id, 'mesh');
        }
      }
    }
    store.applyOps(ops);
    extensions.sync();
    countEl.textContent = store.entities.size;
    for (const op of ops) {
      // a warp landed on OUR presence: world logic moved the body
      if (op.id === presenceId && op.component === 'warp' && op.value?.position) applyWarp(op.value);
      // a scene's camera rig edited live — re-derive the active one
      if (op.component === 'camera') scenes.applyCamera();
    }
    panel.refresh(ops);
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
};
const net = staticMode ? connectStatic(netConfig) : connect(netConfig);

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
    // the same $-token convention triggers and interacts use (shared/ops.js)
    ops.push(substitute(structuredClone(op), { $id: presenceId, $now: r2(clock.now()) }));
  }
  if (ops.length) net.send(ops);
  // the menu's job is done — from here the overlay is a plain pause screen
  delete overlay.dataset.menu;
  menuEl.style.display = 'none';
  overlaySubEl.textContent = 'click to continue';
  if (lock) renderer.domElement.requestPointerLock();
}

// the `warp` component: the one sanctioned way for world logic (a daemon, a
// trigger's ops, a level) to move a player — set it on the presence and the
// OWNING client executes it. The client still owns its body: it moves itself,
// carries streaming + voidY + safe-ground along in the same frame (a cross-
// scene warp can never void-bounce), publishes the arrival, and clears the
// component so the warp is edge-fired like a trigger.
function applyWarp(spec) {
  const clear = [{ op: 'set', id: presenceId, component: 'warp', value: null }];
  if (!spec?.position || player.frozen) {
    // no body yet (title menu) or nothing to do — just burn the component
    net.send(clear);
    return;
  }
  player.warpTo(spec);
  scenes.update(player.position);
  player.voidY = scenes.currentVoidY;
  if (spec.fade) environment.dip(spec.fade);
  const { x, y, z } = player.position;
  net.send([
    ...clear,
    { op: 'merge', id: presenceId, component: 'transform', value: { position: [r2(x), r2(y), r2(z)] } },
    { op: 'merge', id: presenceId, component: 'presence', value: { yaw: r2(player.bodyYaw) } },
  ]);
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

// rain particle counts: the world's weather level × the local debug
// intensity knob (knob applies only to streaked rain — souls ride the
// same motion type but belong to the weather alone)
let weatherRainLevel = 1;
let rainIntensity = 1;
function applyRainCounts() {
  for (const state of view.particleSystems.values()) {
    if (state.spec.motion?.type !== 'rain') continue;
    const local = state.spec.streak ? rainIntensity : 1;
    state.mesh.count = Math.max(0, Math.min(state.count, Math.round(state.count * weatherRainLevel * local)));
  }
}

function handleEvents(ops) {
  for (const op of ops) {
    if (op.op === 'set' && op.component === 'weather') {
      weatherRainLevel = op.value?.rain ?? 0;
      applyRainCounts();
    }
    if (op.op !== 'event') continue;
    if (op.name === 'prefabs-changed') palette.load();
    if (op.name === 'lightning' && !sim.stopped) {
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
// work tabs with it so verification never makes noise on the player's machine.
// The user's mute, the editor's ■ stop, and the view-options audio toggle are
// separate gates on one switch: resuming the sim (or re-enabling editor
// audio) never unmutes a muted player.
const mutedEl = document.getElementById('muted');
let userMuted = false;
function applyAudioGate() {
  audio.setMuted(userMuted || sim.stopped || !viewFx.on.audio);
}
function applyMuted(on, persist = true) {
  userMuted = on;
  applyAudioGate();
  mutedEl.style.display = on ? '' : 'none';
  if (persist) localStorage.setItem('gaia-muted', on ? '1' : '0');
}
if (new URLSearchParams(location.search).has('mute')) applyMuted(true, false);
else if (localStorage.getItem('gaia-muted') === '1') applyMuted(true, false);
document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTyping()) return;
  applyMuted(!userMuted);
});

// the editor viewbar: lit / unlit / wire draw modes, the ■ stop toggle, and
// the `view ▾` effects dropdown (Unity's scene-view toggles) — shown only in
// create mode, and leaving the editor always restores lit + everything on +
// running (the GAME never plays through a scene-view lens)
const viewbarEl = document.getElementById('viewbar');
const drawModeButtons = new Map(
  ['lit', 'unlit', 'wireframe'].map((mode) => [mode, document.getElementById(`vb-${mode}`)]),
);
const stopBtn = document.getElementById('vb-stop');
const vbViewBtn = document.getElementById('vb-view');
const vbMenu = document.getElementById('vb-menu');
function syncFxMenu() {
  for (const input of vbMenu.querySelectorAll('input[data-fx]')) {
    input.checked = viewFx.on[input.dataset.fx];
  }
}
function setDrawMode(mode) {
  shading.setMode(mode);
  // each mode brings its own toggle defaults (vfx off in unlit/wire, skybox
  // off in wire); the dropdown can then override any of them
  viewFx.applyDefaults(mode);
  applyAudioGate();
  syncFxMenu();
  for (const [m, btn] of drawModeButtons) btn.classList.toggle('active', m === mode);
  // an open mesh-edit session rebuilds its ghosts to match the mode
  window.gaia?.editor?.refreshMeshHandles();
}
function setStopped(on) {
  sim.stopped = on;
  applyAudioGate();
  stopBtn.classList.toggle('active', on);
  stopBtn.innerHTML = on ? '&#9654; resume' : '&#9632; stop';
  if (on) hintEl.textContent = ''; // a frozen prompt would lie
}
for (const [mode, btn] of drawModeButtons) {
  btn.addEventListener('click', () => {
    setDrawMode(mode);
    btn.blur(); // keep Space/Enter for the world, not the button
  });
}
stopBtn.addEventListener('click', () => {
  setStopped(!sim.stopped);
  stopBtn.blur();
});
vbViewBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  vbMenu.style.display = vbMenu.style.display === 'flex' ? 'none' : 'flex';
  syncFxMenu();
  vbViewBtn.blur();
});
vbMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  vbMenu.style.display = 'none';
});
for (const input of vbMenu.querySelectorAll('input[data-fx]')) {
  input.addEventListener('change', () => {
    viewFx.on[input.dataset.fx] = input.checked;
    if (input.dataset.fx === 'audio') applyAudioGate();
  });
}
const viewbar = {
  show: () => (viewbarEl.style.display = 'flex'),
  hide: () => {
    viewbarEl.style.display = 'none';
    vbMenu.style.display = 'none';
  },
  reset: () => {
    setDrawMode('lit');
    viewFx.on.audio = true;
    applyAudioGate();
    setStopped(false);
  },
};

// ~ toggles the debug panel: live look-dev knobs
const debugEl = document.getElementById('debug');
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Backquote' || isTyping()) return;
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
// skylight ADDS a global ambient — scene hemispheres are often near-black on
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
// rain submenu: live look-dev over the streaked rain systems — slant the
// fall (the streaks lean to match), scale its speed, thin or thicken the
// sheet. `save` bakes the multipliers into the specs they multiplied.
debugKnob('rain-angle', (v) => (rainDebug.angle = (v * Math.PI) / 180), (v) => `${v.toFixed(0)}°`);
debugKnob('rain-speed', (v) => (rainDebug.speed = v));
debugKnob('rain-intensity', (v) => {
  rainIntensity = v;
  applyRainCounts();
});

// '+' drops a debug snapshot: the rendered frame + a json of what the world
// knew at that moment (pose, carried components, quest state, nearby ids,
// the agent-sense look) — written by the server into debug/, same stamp.
// Captured in the render loop right after render: a WebGPU canvas only
// reads back reliably in the same task that drew it.
let pendingSnapshot = false;
document.addEventListener('keydown', (e) => {
  if (e.key !== '+' || e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
  pendingSnapshot = true;
});

// WebGPU canvas → png data URL; only reliable in the same task that drew it
function canvasToDataURL(cb) {
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => cb(reader.result);
    reader.readAsDataURL(blob);
  }, 'image/png');
}

function captureSnapshot() {
  pendingSnapshot = false;
  canvasToDataURL(async (image) => {
    try {
      const res = await fetch(`http://${location.hostname}:${__GAIA_PORT__}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image,
          player: {
            id: presenceId,
            position: [r2(player.position.x), r2(player.position.y), r2(player.position.z)],
            yaw: r2(player.yaw),
            pitch: r2(player.pitch),
            scene: scenes.current,
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
  });
}

// the debug menu drives with arrow keys: ↑/↓ pick a row, ←/→ nudge a
// slider, Enter follows a link row (rain ▸ submenu, ◂ back, save),
// Esc backs out of a submenu
const debugPages = {
  main: ['exposure', 'skylight', 'fog', 'storm', 'flame', 'rain-link', 'save'],
  rain: ['rain-back', 'rain-angle', 'rain-speed', 'rain-intensity', 'rain-save'],
};
let debugPage = 'main';
let debugSelected = 0;

// save: bake the knobs into the world itself — no override layer. Look knobs
// (exposure/skylight/fog) merge into the current scene's environment entity;
// rain knobs bake into every streaked rain system's spec. The ops are
// dev-tagged, so the server writes them through to the scene files: the debug
// menu edits the same single state as the editor. After the bake the knobs
// return to neutral — the world now IS the look. Storm and flame already
// write the world live, so they have nothing to save.
function saveDebug() {
  const ops = [];
  const knob = (name) => Number(document.getElementById(`debug-${name}`).value);
  let envId = null;
  for (const [id, comps] of store.entities) {
    if (comps.environment && comps.scene?.name === scenes.current) {
      envId = id;
      break;
    }
  }
  if (envId) {
    const env = store.get(envId).environment ?? {};
    const value = {};
    if (knob('exposure') !== 1) value.exposure = r2((env.exposure ?? environment.defaults.exposure) * knob('exposure'));
    if (knob('skylight') !== 0) value.ambient = { ...(env.ambient ?? {}), intensity: r2((env.ambient?.intensity ?? 0) + knob('skylight')) };
    // the fog knob scales density — linear fog never moved with it, so skip
    if (knob('fog') !== 1 && env.fog?.density) value.fog = { ...env.fog, density: Math.round(env.fog.density * knob('fog') * 1e5) / 1e5 };
    if (Object.keys(value).length) ops.push({ op: 'merge', id: envId, component: 'environment', value });
  }
  if (rainDebug.speed !== 1 || rainDebug.angle !== 0 || rainIntensity !== 1) {
    for (const [id, comps] of store.entities) {
      const spec = comps.particles;
      if (!spec?.streak) continue;
      const motion = { ...(spec.motion ?? {}) };
      motion.speed = r2((motion.speed ?? 1) * rainDebug.speed);
      const tilt = [...(motion.tilt ?? [0, 0])];
      tilt[0] = r2((tilt[0] ?? 0) + Math.tan(rainDebug.angle));
      motion.tilt = tilt;
      const value = { motion };
      if (rainIntensity !== 1) value.count = Math.max(0, Math.round((spec.count ?? 400) * rainIntensity));
      ops.push({ op: 'merge', id, component: 'particles', value });
    }
  }
  if (ops.length) net.sendDev(ops);
  // baked in — the round-tripped world data re-applies the exact same look
  const neutral = { exposure: 1, skylight: 0, fog: 1, 'rain-angle': 0, 'rain-speed': 1, 'rain-intensity': 1 };
  for (const [name, v] of Object.entries(neutral)) {
    const input = document.getElementById(`debug-${name}`);
    input.value = String(v);
    input.dispatchEvent(new Event('input'));
  }
  for (const id of ['debug-save', 'debug-rain-save']) {
    const el = document.getElementById(id);
    el.textContent = ops.length ? 'saved → world ✓' : 'nothing to save';
    setTimeout(() => (el.textContent = 'save'), 1600);
  }
}

const debugLinks = {
  'rain-link': () => showDebugPage('rain'),
  'rain-back': () => showDebugPage('main'),
  save: saveDebug,
  'rain-save': saveDebug,
};
for (const [name, action] of Object.entries(debugLinks)) {
  document.getElementById(`debug-${name}`).addEventListener('click', action);
}

function debugRowEl(name) {
  const el = document.getElementById(`debug-${name}`);
  return el.tagName === 'LABEL' ? el : el.parentElement;
}
function showDebugPage(name) {
  debugPage = name;
  debugSelected = 0;
  for (const page of Object.keys(debugPages)) {
    document.getElementById(`debug-page-${page}`).style.display = page === name ? 'flex' : 'none';
  }
  highlightDebugKnob();
}
function highlightDebugKnob() {
  for (const page of Object.keys(debugPages)) {
    debugPages[page].forEach((name, i) => {
      debugRowEl(name).classList.toggle('selected', page === debugPage && i === debugSelected);
    });
  }
}
document.addEventListener('keydown', (e) => {
  if (debugEl.style.display !== 'flex') return;
  const names = debugPages[debugPage];
  const current = names[debugSelected];
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    debugSelected = (debugSelected + (e.code === 'ArrowDown' ? 1 : names.length - 1)) % names.length;
    highlightDebugKnob();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    const input = document.getElementById(`debug-${current}`);
    if (input.tagName !== 'INPUT') return;
    e.preventDefault(); // ours, not the focused slider's — no double steps
    const step = Number(input.step) || 1;
    const next = Number(input.value) + (e.code === 'ArrowRight' ? step : -step);
    input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
    input.dispatchEvent(new Event('input'));
  } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (debugLinks[current]) {
      e.preventDefault();
      debugLinks[current]();
    }
  } else if (e.code === 'Escape' && debugPage !== 'main') {
    e.preventDefault();
    showDebugPage('main');
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
const econsole = new EventConsole({ el: document.getElementById('console'), store });
if (new URLSearchParams(location.search).has('log')) econsole.toggle();

// everything that AUTHORS the world sends dev-tagged ops: the server writes
// them through to the scene files (single state — the editor edits the world's
// actual files). Gameplay traffic (presence moves, use, carry streams) stays
// plain and lands only in the runtime world / the save.
const history = new History(net.sendDev);
const interact = new Interact({ camera, scene, store, view, send: net.send, sendDev: net.sendDev, player, hintEl, history, presence: presenceId });
const panel = new Panel({
  el: document.getElementById('panel'),
  store,
  view,
  scenes,
  send: net.sendDev,
  history,
  onDuplicate: (id) => editor.duplicate(id),
  onDelete: (id) => editor.delete(id),
  onEditMesh: (id) => editor.editMesh(id),
  getMeshEdit: () => editor.meshEdit,
});
const palette = new Palette({
  el: document.getElementById('palette'),
  store,
  view,
  send: net.sendDev,
  history,
  camera,
  renderer,
});
const gizmos = new Gizmos({ scene, store, view, scenes });
const outliner = new Outliner({
  el: document.getElementById('outliner'),
  store,
  view,
  scenes,
  gizmos,
  onPick: (id) => editor.select(id),
  onFocus: (id) => {
    editor.select(id);
    editor.frameSelected();
  },
  // the streaming geography is editable like everything else: the scene's
  // world.json entry opens in the inspector, commits as `scene` ops
  onScene: (name) => {
    editor.select(null);
    panel.showScene(name);
  },
  // mesh edit: the holes list as children of the edited entity, right here
  onPickHole: (part, index) => editor.selectHandle({ kind: 'cutter', part, index }),
  onFocusHole: (part, index) => {
    editor.selectHandle({ kind: 'cutter', part, index });
    editor.frameSelected();
  },
  onAddHole: () => editor.addCarve(),
  getMeshEdit: () => editor.meshEdit,
});
const editor = new Editor({
  camera,
  scene,
  renderer,
  store,
  view,
  send: net.sendDev,
  player,
  history,
  panel,
  palette,
  outliner,
  gizmos,
  viewbar,
  shading,
  modeEl: document.getElementById('mode'),
});
const characterCreator = new CharacterCreator({
  store,
  send: net.sendDev,
  history,
  editor,
  player,
});
const vrmEditor = new VrmEditor({
  store,
  view,
  send: net.sendDev,
  history,
  editor,
  player,
});

function syncCrosshair() {
  crosshairEl.style.display = player.locked && !player.editorMode && !player.rig ? 'block' : 'none';
}
document.addEventListener('pointerlockchange', syncCrosshair);

// debug handle: poke the kernel from the devtools console (or CDP)
// plugins self-register on window.gaia before this line — never overwrite, extend
// (3 independent victims 07-28: scrubber, QA intro, frame-check menu)
window.gaia = Object.assign(window.gaia ?? {}, {
  pixels, // §IRON pixel governor — proofs pin it to measure at a known ratio
  store,
  view,
  rain: makeRain({ store, view }),
  scenes,
  gizmos,
  outliner,
  editor,
  panel,
  econsole,
  environment,
  player,
  audio,
  net,
  shading,
  viewFx,
  sim,
  characterCreator,
  vrmEditor,
  ...extensions.published,          // e.g. atlasStrategy, when that extension is loaded
  setDrawMode,
  setStopped,
});

// publish the player's pose so agents can sense them
let lastPresence = { x: 0, y: 0, z: 0, yaw: 0, t: 0 };
function publishPresence(now) {
  if (now - lastPresence.t < 300 || !store.get(presenceId)) return;
  const { x, y, z } = player.position;
  // bodyYaw is the facing the world should see — identical to the look yaw in
  // first person, the movement direction under a camera rig
  const moved = Math.hypot(x - lastPresence.x, y - lastPresence.y, z - lastPresence.z) > 0.3;
  const turned = Math.abs(player.bodyYaw - lastPresence.yaw) > 0.15;
  if (!moved && !turned) return;
  lastPresence = { x, y, z, yaw: player.bodyYaw, t: now };
  net.send([
    { op: 'merge', id: presenceId, component: 'transform', value: { position: [r2(x), r2(y), r2(z)] } },
    { op: 'merge', id: presenceId, component: 'presence', value: { yaw: r2(player.bodyYaw) } },
  ]);
}

function captureShot() {
  const id = pendingShot;
  pendingShot = null;
  canvasToDataURL((data) => net.sendRaw({ type: 'screenshot', id, data: data.split(',')[1] }));
}

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // §IRON adaptive pixel ratio (kernel/renderer.js PIXEL_IRON): a procedural
  // sky is fragment-bound, so resolution is the budget that gives way first.
  pixels?.sample(dt, now);
  const t = clock.now();
  // ■ stop skips the world's own motion — behaviors, particles, triggers —
  // but not you (the body still answers), not the streaming, not edits.
  // Effects keep running: spawn/despawn tweens are edit feedback, and a
  // frozen scaleOut would leave deleted entities haunting the scene.
  if (!sim.stopped) behaviors.update(dt);
  // VRM avatars tick every frame (spring-bone hair/skirt physics, expression
  // fades) — even under ■ stop: a frozen face is edit feedback gone wrong
  updateVrms(dt);
  effects.update(dt);
  environment.update(dt);
  if (!sim.stopped) {
    for (const [id, state] of view.particleSystems) {
      if (view.getGroup(id)?.userData.hidden) continue; // streamed-out scenes sleep
      updateParticles(state, t);
    }
  }
  player.update(dt);
  extensions.update(dt);
  scenes.update(player.position);
  player.voidY = scenes.currentVoidY;
  view.update();
  shading.update();
  viewFx.update();
  if (!sim.stopped) {
    interact.update(dt, now);
    // drowning overrides the interaction hint — the water is the message
    if (player.sinking) hintEl.textContent = 'the water takes you…';
    else if (player.swimming && player.swimTime > player.swimLimit * 0.5) {
      hintEl.textContent = 'your strength fades — reach for the boat';
    }
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
