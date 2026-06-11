// Talk to a Chromium tab over the DevTools protocol — the way to verify the
// editor's DOM (outliner, inspector), which canvas screenshots can't see.
// The browser must run with --remote-debugging-port=9222, e.g.:
//   "Brave Browser" --user-data-dir=/tmp/gaia-profile --remote-debugging-port=9222 <url>
//
// usage:
//   node tools/cdp.mjs eval '<js expression>'   evaluate in the page, print result
//   node tools/cdp.mjs shot out.png             full-page screenshot (DOM + canvas)
import WebSocket from 'ws';
import fs from 'node:fs';

const [, , cmd, arg] = process.argv;
const port = process.env.CDP_PORT ?? 9222;
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
// match localhost AND [::1] — when another project squats the IPv4 port,
// the engine's vite still binds IPv6 and the tab runs on http://[::1]:5173
// (set GAIA_CLIENT_PORT when the stack runs on alternate ports)
const clientPort = process.env.GAIA_CLIENT_PORT ?? '5173';
const page = targets.find((t) => t.type === 'page' && t.url.includes(`:${clientPort}`));
if (!page) {
  console.error(`no localhost:${clientPort} page — launch the browser with --remote-debugging-port`);
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

if (cmd === 'eval') {
  const msg = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
  const r = msg.result?.result;
  console.log(r?.value ?? JSON.stringify(msg.result));
} else if (cmd === 'shot') {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  const file = arg ?? 'cdp-shot.png';
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  console.log(`${file} (${fs.statSync(file).size} bytes)`);
} else {
  console.log('usage: cdp.mjs eval <expression> | shot [file.png]');
}
ws.close();
process.exit(0);
