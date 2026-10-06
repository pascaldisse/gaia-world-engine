// run.mjs — build-free proof driver: own server + own headless Brave (own profile/ports) → CDP → wait for window.__result → screenshot.
//   bun tools/render-wasm/run.mjs [--page three.html (TSL proof strip) --w 1280 --h 800 --rh 720 --frames 120 --out .scratch/render-wasm.png --port 5391 --cdp 9391 --gpu angle-flag...]
import { serve } from './serve.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 5391)), cdp = Number(arg('cdp', 9391));
const w = arg('w', 1280), h = arg('h', 800), rh = arg('rh', 720), frames = arg('frames', 120);
const out = resolve(root, arg('out', '.scratch/render-wasm.png')), page = arg('page', '');
const profile = resolve(root, '.scratch/brave-profile');
const brave = process.env.BRAVE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
mkdirSync(profile, { recursive: true }); mkdirSync(dirname(out), { recursive: true });
const server = serve({ port });
const proc = Bun.spawn([brave, '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdp}`, `--window-size=${w},${h}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--enable-unsafe-webgpu', '--enable-features=WebGPUDeveloperFeatures',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); if (tabs.find((t) => t.type === 'page')) break; } catch {} await sleep(500); }
const tab = tabs.find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${port}/${page}?w=${w}&h=${h}&rh=${rh}&frames=${frames}` });
  let res = null;
  for (let i = 0; i < 600; i++) { await sleep(500); const r = await send('Runtime.evaluate', { expression: 'window.__result && window.__result.done ? JSON.stringify(window.__result) : null', returnByValue: true }); if (r.result?.result?.value) { res = JSON.parse(r.result.result.value); break; } }
  if (!res) throw new Error('timeout waiting for window.__result');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify({ ...res, console: logs.slice(-40) }, null, 1));
  console.log(JSON.stringify(res, null, 1)); console.log('screenshot', out);
} finally { try { ws.close(); } catch {} proc.kill(); server.stop(true); }
