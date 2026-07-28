// cdp-static-test.mjs — the static-mode gate check: opens a FRESH tab
// (never reuses whatever's already open, unlike cdp-lib.mjs's connectCdp)
// against a running static server + ?static=1, confirms the universe
// renders, selects a node via the atlas API, screenshots the result.
//
// usage:
//   node tools/cdp-static-test.mjs <url> [out.png]
//   node tools/cdp-static-test.mjs http://127.0.0.1:4173/?static=1 proof/static-mode.png
//
// Requires a Chromium instance with --remote-debugging-port=9222 (CDP_PORT
// env var overrides) already running, same as the other tools/cdp-*.mjs.
import WebSocket from 'ws';
import fs from 'node:fs';

const [, , url, outFile] = process.argv;
if (!url) {
  console.log('usage: cdp-static-test.mjs <url> [out.png]');
  process.exit(1);
}
const port = process.env.CDP_PORT ?? 9222;

async function bcall(bws, seqRef, method, params = {}) {
  const id = ++seqRef.n;
  return new Promise((resolve) => {
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        bws.off('message', handler);
        resolve(msg);
      }
    };
    bws.on('message', handler);
    bws.send(JSON.stringify({ id, method, params }));
  });
}

const { webSocketDebuggerUrl: browserWsUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const bws = new WebSocket(browserWsUrl);
await new Promise((r) => bws.on('open', r));
const bseq = { n: 0 };
const created = await bcall(bws, bseq, 'Target.createTarget', { url: 'about:blank', newWindow: false });
const targetId = created.result.targetId;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.id === targetId);
if (!page) {
  console.error('new target not found via /json/list');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.text);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 4000));

const boot = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasGaia: !!window.gaia,
    entityCount: window.gaia?.store?.entities?.size,
    status: document.getElementById('status')?.textContent,
    graphNodes: window.gaia?.atlasStrategy?.graph?.nodes?.length,
  })`,
  returnByValue: true,
});
console.log('boot:', boot.result?.result?.value);

const select = await send('Runtime.evaluate', {
  expression: `(() => {
    const as = window.gaia?.atlasStrategy;
    const node = as?.graph?.nodes?.find((n) => n.kind) ?? as?.graph?.nodes?.[0];
    if (!node) return JSON.stringify({ selected: false });
    as.select(node.id);
    return JSON.stringify({ selected: true, nodeId: node.id, panelMode: as.panelMode, panelId: as.panelId });
  })()`,
  returnByValue: true,
});
console.log('select:', select.result?.result?.value);
await new Promise((r) => setTimeout(r, 1500));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const file = outFile ?? 'cdp-static-shot.png';
fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
console.log(`screenshot: ${file} (${fs.statSync(file).size} bytes)`);

if (exceptions.length) {
  console.log('EXCEPTIONS:');
  for (const e of exceptions) console.log(' ', e);
}

ws.close();
bws.close();
process.exit(exceptions.length ? 1 : 0);
