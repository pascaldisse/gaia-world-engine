import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { World } from './world.js';
import { Sense } from './sense.js';
import { Intents } from './intents.js';
import { Triggers } from './triggers.js';
import { normalizeManifest, placeEntity, zoneAt } from '../shared/zones.js';

const PORT = 8420;
// GAIA_WORLD points the engine at any world project directory (separate repo);
// defaults to the engine's own world/.
const worldDir = process.env.GAIA_WORLD
  ? path.resolve(process.env.GAIA_WORLD)
  : fileURLToPath(new URL('../world', import.meta.url));
const worldFile = path.join(worldDir, 'world.json');
const seedFile = path.join(worldDir, 'seed.json');
const assetsDir = path.join(worldDir, 'assets');
console.log(`[gaia] world dir: ${worldDir}`);

// zoned world: manifest.json assembles independently authored zone seeds
// into one world-space; without it the world is a single implicit zone
let manifest = null;
try {
  manifest = normalizeManifest(JSON.parse(fs.readFileSync(path.join(worldDir, 'manifest.json'), 'utf8')));
} catch {
  manifest = null;
}

// zone seeds are read at boot and again by the `reset` op — placed into
// world-space and stamped with their zone every time
function loadZoneSeedOps(zone) {
  const zoneSeed = path.join(worldDir, 'zones', zone.name, 'seed.json');
  if (!fs.existsSync(zoneSeed)) return [];
  return JSON.parse(fs.readFileSync(zoneSeed, 'utf8')).map((op) =>
    op.op === 'spawn'
      ? { ...op, components: { ...placeEntity(op.components ?? {}, zone), zone: { name: zone.name } } }
      : op,
  );
}

function loadLegacySeedOps() {
  return fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, 'utf8')) : [];
}

const world = new World(worldFile);
if (!world.load()) {
  if (manifest) {
    for (const zone of manifest.zones) world.applyOps(loadZoneSeedOps(zone));
    console.log(`[gaia] seeded ${world.entities.size} entities from ${manifest.zones.length} zones`);
  } else {
    world.applyOps(loadLegacySeedOps());
    console.log(`[gaia] seeded world with ${world.entities.size} entities`);
  }
}

// the Braid rule as a primitive: `reset` re-seeds a zone (or the world), but
// `persist`-tagged entities, presences, and unzoned entities (world state)
// keep their current truth
function expandReset(op) {
  const zones = op.zone
    ? manifest?.zones.filter((z) => z.name === op.zone) ?? []
    : manifest?.zones ?? [null];
  const ops = [{ op: 'event', name: 'reset', data: { zone: op.zone ?? null } }];
  for (const zone of zones) {
    for (const [id, comps] of world.entities) {
      if (comps.persist || comps.presence) continue;
      if (zone && comps.zone?.name !== zone.name) continue;
      ops.push({ op: 'despawn', id });
    }
    const seedOps = zone ? loadZoneSeedOps(zone) : loadLegacySeedOps();
    for (const sop of seedOps) {
      if (sop.op === 'spawn' && world.entities.get(sop.id)?.persist) continue;
      ops.push(sop);
    }
  }
  return ops;
}

// world clock — one time base for every observer
const bootTime = Date.now();
const worldTime = () => (Date.now() - bootTime) / 1000;

const sense = new Sense(world, worldTime, manifest);

// ---- prefab library: brushes for the palette, addable by agents at runtime ----
const prefabsFile = path.join(worldDir, 'prefabs.json');
let prefabs = [];
try {
  prefabs = JSON.parse(fs.readFileSync(prefabsFile, 'utf8'));
} catch {
  prefabs = [];
}

function savePrefabs() {
  fs.writeFileSync(prefabsFile, JSON.stringify(prefabs, null, 2));
}

// ---- op journal: the world's nervous system ----
const journal = [];
let seq = 0;

function record(applied, from) {
  const t = Date.now();
  for (const op of applied) journal.push({ seq: ++seq, t, from, ...op });
  if (journal.length > 2000) journal.splice(0, journal.length - 2000);
}

function applyAndBroadcast(ops, from) {
  if (ops.some((op) => op.op === 'reset')) {
    ops = ops.flatMap((op) => (op.op === 'reset' ? expandReset(op) : [op]));
  }
  // runtime spawns inherit the zone their position lands in (presences,
  // editor stamps, agent avatars) so streaming clients know what to build
  if (manifest) {
    for (const op of ops) {
      if (op.op !== 'spawn' || !op.components || op.components.zone) continue;
      const p = op.components.transform?.position;
      const zone = p ? zoneAt(manifest, p[0], p[2]) : null;
      if (zone) op.components.zone = { name: zone };
    }
  }
  const applied = world.applyOps(ops);
  if (applied.length) {
    record(applied, from);
    broadcast({ type: 'ops', ops: applied, from });
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
      const rain =
        Math.round((Math.sin((worldTime() * Math.PI * 2) / w.rainCycle) * 0.5 + 0.5) * (w.rainAmount ?? 1) * 100) / 100;
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
      return json(res, { ...world.snapshot(), manifest });
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
    if (req.method === 'GET' && url.pathname === '/screenshot') {
      if (![...wss.clients].some((c) => c.readyState === WebSocket.OPEN)) {
        return json(res, { ok: false, error: 'no client connected — open the world in a browser first' }, 503);
      }
      const id = ++shotSeq;
      shots.set(id, res);
      broadcast({ type: 'screenshot-request', id });
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
      savePrefabs();
      applyAndBroadcast([{ op: 'event', name: 'prefabs-changed', data: { name: prefab.name } }], 'http');
      console.log(`[gaia] prefab ${idx >= 0 ? 'updated' : 'added'}: ${prefab.name}`);
      return json(res, { ok: true, count: prefabs.length });
    }
    if (req.method === 'POST' && url.pathname === '/op') {
      const parsed = await body(req);
      const ops = Array.isArray(parsed) ? parsed : parsed.ops ?? [parsed];
      const applied = applyAndBroadcast(ops, parsed.from ?? 'http');
      for (const op of applied) console.log(`[gaia] ${describe(op)}`);
      return json(res, { ok: true, applied });
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
  socket.send(JSON.stringify({ type: 'snapshot', time: worldTime(), manifest, ...world.snapshot() }));
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ops') applyAndBroadcast(msg.ops ?? [], msg.from ?? 'ws');
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
  return op.op;
}

server.listen(PORT, () => {
  console.log(`[gaia] world server on http://localhost:${PORT} (ws + http + sense + act)`);
});
