// Shared DevTools-protocol connection for the CDP tools (cdp.mjs,
// profile-seam.mjs): find the GAIA tab, open the ws, return send().
// The browser must run with --remote-debugging-port=9222.
import WebSocket from 'ws';

export async function connectCdp() {
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
  return { ws, send };
}
