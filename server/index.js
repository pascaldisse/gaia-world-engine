import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { World } from './world.js';

const PORT = 8420;
const worldFile = fileURLToPath(new URL('../world/world.json', import.meta.url));
const seedFile = fileURLToPath(new URL('../world/seed.json', import.meta.url));

const world = new World(worldFile);
if (!world.load() && fs.existsSync(seedFile)) {
  const seedOps = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  world.applyOps(seedOps);
  console.log(`[gaia] seeded world with ${world.entities.size} entities`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/world') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(world.snapshot(), null, 2));
    return;
  }
  if (req.method === 'POST' && req.url === '/op') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const ops = Array.isArray(parsed) ? parsed : parsed.ops ?? [parsed];
        const applied = world.applyOps(ops);
        broadcast({ type: 'ops', ops: applied });
        for (const op of applied) console.log(`[gaia] ${describe(op)}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'snapshot', ...world.snapshot() }));
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ops') {
        const applied = world.applyOps(msg.ops ?? []);
        broadcast({ type: 'ops', ops: applied });
      }
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
  return op.op;
}

server.listen(PORT, () => {
  console.log(`[gaia] world server on http://localhost:${PORT} (ws + http)`);
});
