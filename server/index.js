import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { World } from './world.js';
import { Sense } from './sense.js';
import { Intents } from './intents.js';

const PORT = 8420;
const worldFile = fileURLToPath(new URL('../world/world.json', import.meta.url));
const seedFile = fileURLToPath(new URL('../world/seed.json', import.meta.url));

const world = new World(worldFile);
if (!world.load() && fs.existsSync(seedFile)) {
  const seedOps = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  world.applyOps(seedOps);
  console.log(`[gaia] seeded world with ${world.entities.size} entities`);
}

const sense = new Sense(world);

// ---- op journal: the world's nervous system ----
const journal = [];
let seq = 0;

function record(applied, from) {
  const t = Date.now();
  for (const op of applied) journal.push({ seq: ++seq, t, from, ...op });
  if (journal.length > 2000) journal.splice(0, journal.length - 2000);
}

function applyAndBroadcast(ops, from) {
  const applied = world.applyOps(ops);
  if (applied.length) {
    record(applied, from);
    broadcast({ type: 'ops', ops: applied, from });
  }
  return applied;
}

const intents = new Intents({ world, apply: applyAndBroadcast });
setInterval(() => intents.tick(0.1), 100);

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
      return json(res, world.snapshot());
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
  socket.send(JSON.stringify({ type: 'snapshot', ...world.snapshot() }));
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ops') applyAndBroadcast(msg.ops ?? [], msg.from ?? 'ws');
    } catch {
      // malformed message — ignore
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
