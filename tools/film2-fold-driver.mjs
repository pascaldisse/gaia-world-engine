// FILM2 FOLD · boot smoke + the real-time strip. One CDP session, one run.
//
//   node tools/film2-fold-driver.mjs smoke
//   node tools/film2-fold-driver.mjs strip
//
// Laws obeyed here: the browser is hidden + --mute-audio (tools/film2-fold-stack.sh),
// screenshots go through CDP Page.captureScreenshot (an in-page readback of a
// WebGPU canvas is black), the two gates (atlas_gate, atlas_seen_intro) are
// set before anything is measured, and the clock read is the film's own audio
// element — never a wall clock.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CDP = Number(process.env.CDP_PORT ?? 9256);
const PORT = Number(process.env.GAIA_CLIENT_PORT ?? 5196);
const OUT = process.env.OUT ?? 'proof/film2-fold';
const cmd = process.argv[2] ?? 'smoke';

const list = await (await fetch(`http://localhost:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes(`${PORT}`)) ?? list.find((t) => t.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let id = 0;
const pend = new Map();
const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    logs.push({ kind: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ') });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push({ kind: 'exception', text: m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text });
  }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return { error: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text };
  return m.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gates, then a reload so the page boots past them
await ev(`localStorage.setItem('atlas_gate','8fc666825e1a4b06'); localStorage.setItem('atlas_seen_intro','1'); 1`);
await send('Page.navigate', { url: `http://localhost:${PORT}/?mute=1&intro=off` });
for (let i = 0; i < 90; i += 1) {
  await sleep(1000);
  const ready = await ev('!!(window.gaia?.atlasStrategy?.cosmos?.ready)');
  if (ready === true) break;
}
const census = await ev('window.gaia?.atlasStrategy?.cosmos?.nodes?.length ?? -1');

if (cmd === 'smoke') {
  const out = { census, steps: [] };
  // Witness click = a REAL user gesture (the audio graph needs activation)
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll('button, .atlas-gate-btn, #atlas-intro button, [data-action]')]
      .find((x) => /witness|begin|enter/i.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim() };
  })()`);
  out.witness = btn;
  if (btn) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    }
  } else {
    await ev(`window.gaia?.director?.play?.({ audio: true, mode: 'live' })`);
  }
  await sleep(6000);
  const a1 = await ev(`(() => { const d = window.gaia?.director?.director; const el = d?.audio?.el;
    return { t: d?.t ?? null, audioT: el?.currentTime ?? null, paused: el?.paused ?? null, muted: el?.muted ?? null, playing: d?.playing ?? null, waiting: d?.waitingForAudio ?? null }; })()`);
  await sleep(5000);
  const a2 = await ev(`(() => { const d = window.gaia?.director?.director; const el = d?.audio?.el;
    return { t: d?.t ?? null, audioT: el?.currentTime ?? null, paused: el?.paused ?? null }; })()`);
  out.clock = { at6s: a1, at11s: a2, advanced: (a2?.audioT ?? 0) > (a1?.audioT ?? 0) };
  out.film2 = await ev(`JSON.parse(JSON.stringify(window.gaia?.film2?.status?.() ?? null))`);
  const scrub = await ev(`window.gaia?.director?.scrub?.(160).then((r) => JSON.parse(JSON.stringify(r)))`);
  await sleep(2500);
  out.scrub = { result: scrub, after: await ev(`(() => ({ t: window.gaia?.director?.director?.t, seg: window.gaia?.film2?.status?.().current }))()`) };
  out.console = logs;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'boot-smoke.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  ws.close();
  process.exit(0);
}

if (cmd === 'strip') {
  const dir = path.join(OUT, 'strip');
  fs.mkdirSync(dir, { recursive: true });
  await ev(`window.gaia?.director?.scrub?.(0)`);
  await sleep(3000);
  await ev(`(() => { const d = window.gaia?.director?.director; d.resume(0); return 1; })()`);
  const t0 = Date.now();
  for (let n = 0; n < 293; n += 1) {
    const want = t0 + n * 1000;
    const wait = want - Date.now();
    if (wait > 0) await sleep(wait);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
    const data = shot.result?.data;
    if (data) fs.writeFileSync(path.join(dir, `f${String(n).padStart(3, '0')}.jpg`), Buffer.from(data, 'base64'));
    if (n % 30 === 0) {
      const st = await ev(`(() => ({ t: window.gaia?.director?.director?.t, seg: window.gaia?.film2?.status?.().current }))()`);
      console.log(n, JSON.stringify(st));
    }
  }
  fs.writeFileSync(path.join(OUT, 'strip-console.json'), JSON.stringify(logs, null, 2));
  console.log('strip done', dir);
  ws.close();
  process.exit(0);
}
