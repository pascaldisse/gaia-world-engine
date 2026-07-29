// One-off verification script (not committed) — dual CDP session:
// browser-level ws for Browser.setDownloadBehavior, page-level ws for
// Runtime.evaluate (recorder API). Prints JSON status lines to stdout.
import WebSocket from 'ws';

const PORT = process.env.CDP_PORT || 9222;

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  }
  return { ws, send };
}

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes(':5174'));
if (!page) throw new Error('no :5174 page target found');

const browserConn = await connect(version.webSocketDebuggerUrl);
const pageConn = await connect(page.webSocketDebuggerUrl);

async function evalPage(expression) {
  const { result } = await pageConn.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

const cmd = process.argv[2];

if (cmd === 'reload') {
  await pageConn.send('Page.enable');
  await pageConn.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 2000));
  console.log('reloaded');
} else if (cmd === 'setdl') {
  const path = process.argv[3];
  const r = await browserConn.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path,
  });
  console.log('setDownloadBehavior ->', JSON.stringify(r));
} else if (cmd === 'eval') {
  const expr = process.argv[3];
  const v = await evalPage(expr);
  console.log(JSON.stringify(v, null, 2));
} else {
  console.log('usage: setdl <path> | eval <expr>');
}

browserConn.ws.close();
pageConn.ws.close();
