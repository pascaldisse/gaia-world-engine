// One-off: CPU-profile the page across a scene seam and print the hottest
// functions by self time. Reuses the cdp.mjs connection pattern.
import WebSocket from 'ws';

const port = process.env.CDP_PORT ?? 9222;
const clientPort = process.env.GAIA_CLIENT_PORT ?? '5173';
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes(`:${clientPort}`));
if (!page) {
  console.error(`no :${clientPort} page`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.on('open', resolve));
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (pending.has(msg.id)) pending.get(msg.id)(msg);
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
const evalJs = (expression) => send('Runtime.evaluate', { expression, returnByValue: true });

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
await evalJs(process.argv[2] ?? 'gaia.player.position.set(0, 3.5, 22); gaia.player.velocityY = 0;');
await new Promise((r) => setTimeout(r, 4000));
const { result } = await send('Profiler.stop');
const profile = result.profile;

const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const counts = new Map();
for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
const interval = 0.2; // ms per sample at 200us
for (const [id, count] of counts) {
  const node = byId.get(id);
  const f = node.callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + count * interval);
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [key, ms] of top) console.log(`${ms.toFixed(1).padStart(8)}ms  ${key}`);
ws.close();
process.exit(0);
