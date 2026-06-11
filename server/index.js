import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { World } from './world.js';
import { Sense } from './sense.js';
import { Intents } from './intents.js';
import { Triggers } from './triggers.js';
import { normalizeScenes, sceneAt } from '../shared/scenes.js';
import { SCHEMA } from '../shared/schema.js';

// GAIA_PORT moves the whole stack (vite injects the same value into the
// client as __GAIA_PORT__) so two worlds can run side by side
const PORT = Number(process.env.GAIA_PORT ?? 8420);
// GAIA_WORLD points the engine at any world project directory (separate repo);
// defaults to the engine's own world/.
const worldDir = process.env.GAIA_WORLD
  ? path.resolve(process.env.GAIA_WORLD)
  : fileURLToPath(new URL('../world', import.meta.url));
const assetsDir = path.join(worldDir, 'assets');
const scenesDir = path.join(worldDir, 'scenes');
// debug snapshots land NEXT TO the world dir (game/debug, not game/world/debug)
// so they sit at the project's top level — gitignored, never committed
const debugDir = path.join(worldDir, '..', 'debug');
console.log(`[gaia] world dir: ${worldDir}`);

// game.json: a world can declare itself a titled game — title screen text
// plus level-select entries (spawn pose, setup ops with `$id` standing for
// the choosing presence). Worlds without one keep the default GAIA overlay.
let game = null;
try {
  game = JSON.parse(fs.readFileSync(path.join(worldDir, 'game.json'), 'utf8'));
  console.log(`[gaia] game: ${game.title ?? 'untitled'} (${game.levels?.length ?? 0} levels)`);
} catch {
  game = null;
}

// ---- prefab library: reusable objects, one file per prefab ----
// world/prefabs/<name>.json is the canonical home (small files, small diffs,
// small context loads); a legacy single prefabs.json list still reads in.
const prefabsFile = path.join(worldDir, 'prefabs.json');
const prefabsDir = path.join(worldDir, 'prefabs');
let prefabs = [];
try {
  prefabs = JSON.parse(fs.readFileSync(prefabsFile, 'utf8'));
} catch {
  prefabs = [];
}
if (fs.existsSync(prefabsDir)) {
  for (const f of fs.readdirSync(prefabsDir).filter((n) => n.endsWith('.json'))) {
    try {
      const prefab = JSON.parse(fs.readFileSync(path.join(prefabsDir, f), 'utf8'));
      const idx = prefabs.findIndex((p) => p.name === prefab.name);
      if (idx >= 0) prefabs[idx] = prefab;
      else prefabs.push(prefab);
    } catch {
      console.warn(`[gaia] unreadable prefab: ${f}`);
    }
  }
}

// ---- material library: named looks, referenced by mesh parts as data ----
// world/materials.json — `{"obsidian": {color, roughness, …}}`. A part says
// `"material": "obsidian"` and may override any field locally. The `material`
// op edits the library live (and every client rebuilds what references it).
const materialsFile = path.join(worldDir, 'materials.json');
let materials = {};
try {
  materials = JSON.parse(fs.readFileSync(materialsFile, 'utf8'));
} catch {
  materials = {};
}

// ---- the world file: the superscene ----
// world/world.json — the composition: which scenes exist, where each sits
// and streams (bounds, neighbors, load volumes), world defaults (voidY).
// Unity's master-scene pattern: scenes are subscenes loaded by position,
// the world file owns them. The `scene` op edits an entry here live.
const worldFile = path.join(worldDir, 'world.json');
let worldMeta = null;
try {
  worldMeta = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
} catch {
  worldMeta = null;
}
worldMeta = worldMeta ?? {};
worldMeta.scenes = worldMeta.scenes ?? {};

// ---- scene files: the world's single source of truth for content ----
// world/scenes/<name>.json — pure entity documents `{ id: {components…} }`,
// world-space, written back on every dev edit (Unity semantics: change a
// thing in the editor, the scene file changes). Entries with a `prefab` key
// are instances: the prefab's components deep-merged under the entry's own
// (the entry stores only its deltas). A world with no scenes/ dir gets one
// implicit scene, `main`, created on the first write — the blank page.
const scenes = new Map(); // scene name -> { file, entities, timer }
if (fs.existsSync(scenesDir)) {
  for (const f of fs.readdirSync(scenesDir).filter((n) => n.endsWith('.json')).sort()) {
    const name = f.slice(0, -5);
    try {
      const entities = JSON.parse(fs.readFileSync(path.join(scenesDir, f), 'utf8'));
      scenes.set(name, { file: path.join(scenesDir, f), entities, timer: null });
    } catch (err) {
      console.warn(`[gaia] unreadable scene ${name}: ${err.message}`);
    }
  }
}
if (!scenes.size) {
  scenes.set('main', { file: path.join(scenesDir, 'main.json'), entities: {}, timer: null });
}
// every scene file gets a world entry; a file the world doesn't list still
// seeds (always-loaded) so content never silently vanishes
for (const name of scenes.keys()) {
  if (!worldMeta.scenes[name]) {
    worldMeta.scenes[name] = scenes.size > 1 ? { always: true } : {};
    if (scenes.size > 1) console.warn(`[gaia] scene ${name} missing from world.json — loading it always`);
  }
}

let index = normalizeScenes(worldMeta);

function saveWorldMeta() {
  fs.writeFileSync(worldFile, JSON.stringify(worldMeta, null, 2) + '\n');
}

function deepMerge(base, over) {
  if (!base || !over || Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object') {
    return structuredClone(over);
  }
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in out ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out;
}

function expandDoc(doc, sceneName) {
  let comps = doc;
  const prefabName = typeof doc.prefab === 'string' ? doc.prefab : doc.prefab?.name;
  if (prefabName) {
    const base = prefabs.find((p) => p.name === prefabName)?.components;
    const { prefab, ...own } = doc;
    comps = base ? deepMerge(base, own) : own;
    // instances keep their link as a component — write-back diffs against
    // the prefab, so a moved torch stays three lines in the scene file
    comps.prefab = { name: prefabName };
  } else {
    comps = structuredClone(comps);
  }
  comps.scene = comps.scene ?? { name: sceneName };
  return comps;
}

function sceneSeedOps(name) {
  const scene = scenes.get(name);
  if (!scene) return [];
  return Object.entries(scene.entities).map(([id, doc]) => ({ op: 'spawn', id, components: expandDoc(doc, name) }));
}

function scheduleSceneSave(name) {
  const scene = scenes.get(name);
  if (!scene) return;
  clearTimeout(scene.timer);
  scene.timer = setTimeout(() => {
    fs.mkdirSync(scenesDir, { recursive: true });
    fs.writeFileSync(scene.file, JSON.stringify(scene.entities, null, 2) + '\n');
  }, 400);
}

// the scene file may change OUTSIDE the server (a generator re-run, a hand
// edit) — `reset` re-reads it from disk, so the op is the official "pick up
// my file changes" gesture. Pending write-backs for the scene are dropped:
// the disk is newer truth than the memory that scheduled them.
function reloadScene(name) {
  const scene = scenes.get(name);
  if (!scene || !fs.existsSync(scene.file)) return;
  clearTimeout(scene.timer);
  scene.timer = null;
  try {
    scene.entities = JSON.parse(fs.readFileSync(scene.file, 'utf8'));
  } catch (err) {
    console.warn(`[gaia] scene reload failed for ${name}: ${err.message}`);
  }
}

// the world file may change outside the server too — reset re-reads it
function reloadWorldMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
    worldMeta = raw ?? {};
    worldMeta.scenes = worldMeta.scenes ?? {};
    for (const name of scenes.keys()) worldMeta.scenes[name] = worldMeta.scenes[name] ?? {};
    index = normalizeScenes(worldMeta);
    sense.index = index;
  } catch {
    // no world file on disk yet — keep the in-memory composition
  }
}

// the player layer: what belongs to a SAVE, not a scene — presences, things
// players made (`persist`), and entities no scene claims (quest flags etc.)
const playerLayer = (id, comps) => !!(comps.presence || comps.persist || !comps.scene);

// state splits like a shipped game: the scenes are the world, the save file
// is the player
const saveName = process.env.GAIA_SAVE ?? 'default';
const saveFile = path.join(worldDir, 'saves', `player_${saveName}_state.json`);

const world = new World(saveFile, { saveFilter: playerLayer });
const hadSave = world.load();
{
  // scenes are ALWAYS the truth for the world itself — every boot reads them
  // fresh (a scene edited while the server was down just appears). The save
  // only overlays the player layer on top.
  let seeded = 0;
  for (const name of scenes.keys()) {
    for (const op of sceneSeedOps(name)) {
      if (world.entities.has(op.id)) continue;
      world.applyOp(op);
      seeded += 1;
    }
  }
  console.log(
    `[gaia] ${seeded} entities from ${scenes.size} scene${scenes.size === 1 ? '' : 's'}` +
      (hadSave ? ` + save '${saveName}' (${world.entities.size - seeded} player-layer)` : ''),
  );
}

// the Braid rule as a primitive: `reset` re-seeds a scene (or the world), but
// `persist`-tagged entities, presences, and unclaimed entities (world state)
// keep their current truth. Reset re-reads the scene files from disk first,
// so it also picks up external edits (and re-shares refreshed meta).
function expandReset(op) {
  const names = op.scene ? [op.scene].filter((n) => scenes.has(n)) : [...scenes.keys()];
  const ops = [{ op: 'event', name: 'reset', data: { scene: op.scene ?? null } }];
  reloadWorldMeta();
  for (const name of names) {
    reloadScene(name);
    ops.push({ op: 'scene', name, value: worldMeta.scenes[name] });
    for (const [id, comps] of world.entities) {
      if (comps.persist || comps.presence) continue;
      if (comps.scene?.name !== name) continue;
      ops.push({ op: 'despawn', id });
    }
    for (const sop of sceneSeedOps(name)) {
      if (world.entities.get(sop.id)?.persist) continue;
      ops.push(sop);
    }
  }
  return ops;
}

// world clock — one time base for every observer
const bootTime = Date.now();
const worldTime = () => (Date.now() - bootTime) / 1000;

const sense = new Sense(world, worldTime, index);

// new/updated prefabs land one-per-file in prefabs/; a legacy single
// prefabs.json list still reads in (and stays untouched)
function savePrefab(prefab) {
  fs.mkdirSync(prefabsDir, { recursive: true });
  fs.writeFileSync(path.join(prefabsDir, `${prefab.name}.json`), JSON.stringify(prefab, null, 2) + '\n');
}

// ---- op journal: the world's nervous system ----
const journal = [];
let seq = 0;

function record(applied, from) {
  const t = Date.now();
  for (const op of applied) journal.push({ seq: ++seq, t, from, ...op });
  if (journal.length > 2000) journal.splice(0, journal.length - 2000);
}

// the `scene` op: a scene's entry in the world file (bounds, load volumes,
// neighbors…) edited like everything else — merged into world.json,
// broadcast so every client re-derives its streaming live (value null
// deletes a key)
function applySceneOp(op) {
  if (!scenes.has(op.name)) return false;
  const meta = (worldMeta.scenes[op.name] = worldMeta.scenes[op.name] ?? {});
  for (const [key, value] of Object.entries(op.value ?? {})) {
    if (key === 'name') continue;
    if (value === null) delete meta[key];
    else meta[key] = value;
  }
  index = normalizeScenes(worldMeta);
  sense.index = index;
  saveWorldMeta();
  console.log(`[gaia] scene ${op.name} updated in world.json (${Object.keys(op.value ?? {}).join(', ')})`);
  return true;
}

// the `material` op edits the shared library: merge into the named entry
// (value null deletes it), persist materials.json, broadcast — clients
// rebuild whatever references the name
function applyMaterialOp(op) {
  if (!op.name) return false;
  if (op.value === null) delete materials[op.name];
  else materials[op.name] = { ...(materials[op.name] ?? {}), ...op.value };
  fs.writeFileSync(materialsFile, JSON.stringify(materials, null, 2) + '\n');
  console.log(`[gaia] material ${op.name} ${op.value === null ? 'deleted' : 'updated'}`);
  return true;
}

// dev edits write through to the scene files — the single source of truth.
// The op itself carries no file knowledge: the entity's scene stamp picks the
// file. The player layer (presences, persist, unclaimed) never lands here.
function writeBackScenes(applied) {
  for (const op of applied) {
    if (op.op === 'spawn' || op.op === 'set') {
      const comps = world.entities.get(op.id);
      if (!comps || playerLayer(op.id, comps)) continue;
      const sceneName = comps.scene?.name;
      if (!scenes.has(sceneName)) continue;
      scenes.get(sceneName).entities[op.id] = sceneDoc(comps);
      scheduleSceneSave(sceneName);
    } else if (op.op === 'despawn') {
      for (const [name, scene] of scenes) {
        if (!(op.id in scene.entities)) continue;
        delete scene.entities[op.id];
        scheduleSceneSave(name);
      }
    }
  }
}

// a prefab instance is stored as its deltas: `prefab` plus whichever
// components differ from the prefab's. Everything else is the full document.
// The scene stamp is the file it sits in — never stored.
function sceneDoc(comps) {
  const doc = structuredClone(comps);
  delete doc.scene;
  const base = prefabs.find((p) => p.name === doc.prefab?.name)?.components;
  if (!base) return doc;
  const out = { prefab: doc.prefab.name };
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'prefab') continue;
    if (key in base && JSON.stringify(base[key]) === JSON.stringify(value)) continue;
    out[key] = value;
  }
  return out;
}

function applyAndBroadcast(ops, from, { dev = false } = {}) {
  if (ops.some((op) => op.op === 'reset')) {
    ops = ops.flatMap((op) => (op.op === 'reset' ? expandReset(op) : [op]));
  }
  // scene ops target the world file, not an entity — peel them off, apply,
  // and re-attach the applied ones so they broadcast and journal like the rest
  let metaOps = [];
  if (ops.some((op) => op.op === 'scene')) {
    metaOps = ops.filter((op) => op.op === 'scene' && applySceneOp(op));
    ops = ops.filter((op) => op.op !== 'scene');
  }
  // material ops target the library, same treatment
  if (ops.some((op) => op.op === 'material')) {
    metaOps = metaOps.concat(ops.filter((op) => op.op === 'material' && applyMaterialOp(op)));
    ops = ops.filter((op) => op.op !== 'material');
  }
  // `use` expands server-side like `reset`: the interact component decides
  // what actually happens (and whether it happens at all)
  if (ops.some((op) => op.op === 'use')) {
    ops = ops.flatMap((op) => (op.op === 'use' ? triggers.use(op.id, op.by) : [op]));
  }
  // runtime spawns inherit the scene their position lands in (presences,
  // editor stamps, agent avatars) so streaming clients know what to build
  if (index) {
    for (const op of ops) {
      if (op.op !== 'spawn' || !op.components || op.components.scene) continue;
      const p = op.components.transform?.position;
      const scene = p ? sceneAt(index, p[0], p[2]) : null;
      if (scene) op.components.scene = { name: scene };
    }
    // presences move: re-stamp their scene as they cross bounds, so senses
    // scope correctly and a client never streams out its own body (or the
    // light it carries)
    const stamps = [];
    for (const op of ops) {
      if ((op.op !== 'merge' && op.op !== 'set') || op.component !== 'transform') continue;
      const p = op.value?.position;
      if (!p) continue;
      const comps = world.entities.get(op.id);
      if (!comps?.presence) continue;
      const scene = sceneAt(index, p[0], p[2]);
      if (scene && comps.scene?.name !== scene) stamps.push({ op: 'merge', id: op.id, component: 'scene', value: { name: scene } });
    }
    ops = ops.concat(stamps);
  }
  const applied = world.applyOps(ops).concat(metaOps);
  if (applied.length) {
    record(applied, from);
    broadcast({ type: 'ops', ops: applied, from });
    if (dev) writeBackScenes(applied);
  }
  return applied;
}

const intents = new Intents({ world, apply: applyAndBroadcast });
setInterval(() => intents.tick(0.1), 100);

const triggers = new Triggers({ world, sense, apply: applyAndBroadcast, now: worldTime });
setInterval(() => triggers.tick(), 250);

// ---- weather sim: lightning events + rain cycles for entities with `weather` ----
const weatherState = new Map();
// frequency is a live multiplier (the debug panel's storm knob merges it)
const gap = (w) =>
  (((w.minGap ?? 8) + Math.random() * ((w.maxGap ?? 30) - (w.minGap ?? 8))) / Math.max(0.05, w.frequency ?? 1)) * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, comps] of world.entities) {
    const w = comps.weather;
    if (!w) {
      weatherState.delete(id);
      continue;
    }
    let st = weatherState.get(id);
    if (!st) {
      st = { nextStrike: now + gap(w) };
      weatherState.set(id, st);
    }
    if (w.lightning !== false && now >= st.nextStrike) {
      st.nextStrike = now + gap(w);
      const intensity = Math.round((0.5 + Math.random() * 0.7) * 100) / 100;
      applyAndBroadcast(
        [
          {
            op: 'event',
            name: 'lightning',
            data: { intensity, delay: Math.round((0.8 + Math.random() * 2) * 10) / 10 },
          },
        ],
        'weather',
      );
      // sometimes the sky stutters — a second strike right on the first's heels
      if (Math.random() < (w.double ?? 0.3)) {
        setTimeout(
          () =>
            applyAndBroadcast(
              [
                {
                  op: 'event',
                  name: 'lightning',
                  data: { intensity: Math.round(intensity * (0.5 + Math.random() * 0.4) * 100) / 100, delay: 0.4 },
                },
              ],
              'weather',
            ),
          120 + Math.random() * 280,
        );
      }
    }
    if (w.rainCycle) {
      // the cycle swells between rainBase and rainAmount — a floor means the
      // storm never quite stops (rain that reads as "gone" half the time
      // is rain the player decides is broken)
      const cycle = Math.sin((worldTime() * Math.PI * 2) / w.rainCycle) * 0.5 + 0.5;
      const base = w.rainBase ?? 0;
      const rain = Math.round((base + cycle * Math.max(0, (w.rainAmount ?? 1) - base)) * 100) / 100;
      if (Math.abs(rain - (w.rain ?? 0)) > 0.05) {
        applyAndBroadcast([{ op: 'merge', id, component: 'weather', value: { rain } }], 'weather');
      }
    }
  }
}, 1000);

// ---- screenshots: client-rendered, relayed over the ws ----
const shots = new Map();
let shotSeq = 0;

// ---- http ----
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);
  try {
    if (req.method === 'GET' && url.pathname === '/world') {
      return json(res, { ...world.snapshot(), world: worldMeta, materials });
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(q.since ?? 0);
      const limit = Math.min(Number(q.limit ?? 200), 500);
      const events = journal.filter((e) => e.seq > since).slice(-limit);
      return json(res, { latest: seq, events });
    }
    if (req.method === 'GET' && url.pathname === '/sense/look') {
      if (q.as) intents.ensureAvatar(q.as);
      return text(res, sense.look({ ...nums(q, ['x', 'y', 'z', 'yaw', 'fov', 'range']), as: q.as }));
    }
    if (req.method === 'GET' && url.pathname === '/sense/map') {
      return text(res, sense.map(nums(q, ['x', 'z', 'radius', 'cells'])));
    }
    if (req.method === 'GET' && url.pathname === '/sense/describe') {
      const comps = world.entities.get(q.id);
      if (!comps) return json(res, { error: `no entity ${q.id}` }, 404);
      return text(res, `${q.id}: ${sense.describe(comps)} · at (${sense.positionOf(comps).map((v) => Math.round(v * 10) / 10).join(', ')})`);
    }
    if (req.method === 'GET' && url.pathname === '/sense/query') {
      return json(res, sense.query({ ...nums(q, ['nearX', 'nearZ', 'radius']), has: q.has, name: q.name }));
    }
    if (req.method === 'GET' && url.pathname === '/sense/check') {
      return text(res, sense.check());
    }
    if (req.method === 'GET' && url.pathname === '/schema') {
      // the component vocabulary, self-documented — agents read this
      // instead of guessing what a field means or what values are sane
      return json(res, SCHEMA);
    }
    if (req.method === 'GET' && url.pathname === '/screenshot') {
      if (![...wss.clients].some((c) => c.readyState === WebSocket.OPEN)) {
        return json(res, { ok: false, error: 'no client connected — open the world in a browser first' }, 503);
      }
      const id = ++shotSeq;
      shots.set(id, res);
      // ?from=<presence-id> targets one session's tab — without it, the
      // first (frontmost) tab to render answers, which with several tabs
      // open is a race
      broadcast({ type: 'screenshot-request', id, from: q.from });
      setTimeout(() => {
        if (shots.has(id)) {
          shots.delete(id);
          json(res, { ok: false, error: 'screenshot timed out' }, 504);
        }
      }, 8000);
      return undefined;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const rel = path.normalize(url.pathname.slice('/assets/'.length)).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(assetsDir, rel);
      if (!file.startsWith(assetsDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end();
        return undefined;
      }
      const mime =
        { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' }[path.extname(file)] ??
        'application/octet-stream';
      res.writeHead(200, { 'content-type': mime });
      fs.createReadStream(file).pipe(res);
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/prefabs') {
      return json(res, prefabs);
    }
    if (req.method === 'POST' && url.pathname === '/prefabs') {
      const prefab = await body(req);
      if (!prefab.name || !prefab.components) throw new Error('prefab needs name and components');
      const idx = prefabs.findIndex((p) => p.name === prefab.name);
      if (idx >= 0) prefabs[idx] = prefab;
      else prefabs.push(prefab);
      savePrefab(prefab);
      applyAndBroadcast([{ op: 'event', name: 'prefabs-changed', data: { name: prefab.name } }], 'http');
      console.log(`[gaia] prefab ${idx >= 0 ? 'updated' : 'added'}: ${prefab.name}`);
      return json(res, { ok: true, count: prefabs.length });
    }
    if (req.method === 'POST' && url.pathname === '/op') {
      const parsed = await body(req);
      const ops = Array.isArray(parsed) ? parsed : parsed.ops ?? [parsed];
      const applied = applyAndBroadcast(ops, parsed.from ?? 'http', { dev: parsed.dev === true });
      for (const op of applied) console.log(`[gaia] ${describe(op)}`);
      return json(res, { ok: true, applied });
    }
    if (req.method === 'POST' && url.pathname === '/snapshot') {
      // '+' in the client: the rendered frame plus what the world (and an
      // agent's senses) knew at that moment — png + json, same stamp
      const snap = await body(req);
      const p = snap.player ?? {};
      const [x, y, z] = p.position ?? [0, 0, 0];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const state = {};
      for (const [id, comps] of world.entities) if (comps.state) state[id] = comps.state;
      const data = {
        time: { wall: new Date().toISOString(), world: Math.round(worldTime() * 10) / 10 },
        player: p,
        carried: world.entities.get(p.id) ?? null,
        state,
        nearby: sense.query({ nearX: x, nearZ: z, radius: snap.radius ?? 20 }),
        look: sense.look({ x, y: y + 1.2, z, yaw: p.yaw ?? 0 }).split('\n'),
      };
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, `${stamp}.json`), JSON.stringify(data, null, 2));
      if (snap.image) {
        fs.writeFileSync(path.join(debugDir, `${stamp}.png`), Buffer.from(snap.image.split(',')[1], 'base64'));
      }
      console.log(`[gaia] snapshot ${stamp}`);
      return json(res, { ok: true, file: `debug/${stamp}` });
    }
    if (req.method === 'POST' && url.pathname === '/act') {
      const cmd = await body(req);
      const result = await intents.run(cmd);
      const frame = sense.look({ as: cmd.as ?? 'agent-claude' });
      return json(res, { ok: true, result, frame });
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    json(res, { ok: false, error: String(err.message ?? err) }, 400);
  }
});

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function text(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(data);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function nums(q, keys) {
  const out = {};
  for (const key of keys) if (q[key] !== undefined) out[key] = Number(q[key]);
  return out;
}

// ---- websocket ----
const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  // clients get the RAW world file — they normalize themselves, and the
  // editor edits the authored form (the `scene` op round-trips through it)
  socket.send(JSON.stringify({ type: 'snapshot', time: worldTime(), world: worldMeta, game, materials, ...world.snapshot() }));
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ops') applyAndBroadcast(msg.ops ?? [], msg.from ?? 'ws', { dev: msg.dev === true });
      else if (msg.type === 'hello') socket.presenceId = msg.presence;
      else if (msg.type === 'screenshot') {
        const res = shots.get(msg.id);
        if (res) {
          shots.delete(msg.id);
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(Buffer.from(msg.data, 'base64'));
        }
      }
    } catch {
      // malformed message — ignore
    }
  });
  socket.on('close', () => {
    if (socket.presenceId && world.entities.has(socket.presenceId)) {
      applyAndBroadcast([{ op: 'despawn', id: socket.presenceId }], 'server');
    }
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function describe(op) {
  if (op.op === 'spawn') return `spawn ${op.id} [${Object.keys(op.components).join(', ')}]`;
  if (op.op === 'set') return `set ${op.id}.${op.component}`;
  if (op.op === 'despawn') return `despawn ${op.id}`;
  if (op.op === 'event') return `event ${op.name}`;
  if (op.op === 'scene') return `scene ${op.name} [${Object.keys(op.value ?? {}).join(', ')}]`;
  if (op.op === 'material') return `material ${op.name}`;
  return op.op;
}

server.listen(PORT, () => {
  console.log(`[gaia] world server on http://localhost:${PORT} (ws + http + sense + act)`);
});
