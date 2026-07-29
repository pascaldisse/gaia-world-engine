// FILM2 FOLD · DOM probe. Enumerates every VISIBLE fixed/absolute layer and
// every canvas, with rect + z-index + a snippet of its text, so a panel that
// squats in a frame can be NAMED instead of guessed.
//
//   node tools/film2-fold-probe.mjs [outfile]
//
// Read-only: it never navigates, never plays, never seeks — safe to run while
// a take is rolling.
import fs from 'node:fs';
import WebSocket from 'ws';

const CDP = Number(process.env.CDP_PORT ?? 9256);
const PORT = Number(process.env.GAIA_CLIENT_PORT ?? 5196);
const out = process.argv[2] ?? null;

const list = await (await fetch(`http://localhost:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes(`${PORT}`)) ?? list.find((t) => t.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let id = 0;
const pend = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return { error: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text };
  return m.result?.result?.value;
};
await send('Runtime.enable');

const report = await ev(`(() => {
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      parts.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
    }
    return parts.join(' > ');
  };
  const layers = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!['fixed', 'absolute', 'sticky'].includes(cs.position) && el.tagName !== 'CANVAS') continue;
    const r = el.getBoundingClientRect();
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02 && r.width > 2 && r.height > 2;
    if (!visible) continue;
    layers.push({
      sel: path(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: typeof el.className === 'string' ? el.className : null,
      pos: cs.position,
      z: cs.zIndex,
      opacity: Number(cs.opacity),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
    });
  }
  // only the OUTERMOST visible layers matter for "what squats in the frame"
  const d = window.gaia?.director?.director;
  return {
    t: d?.t ?? null,
    audioT: d?.audio?.el?.currentTime ?? null,
    bodyClass: document.body.className,
    subText: d?.subText ?? null,
    domSub: document.querySelector('#atlas-director-ui .dir-sub')?.textContent ?? null,
    topLeft: layers.filter((l) => l.rect.x < 420 && l.rect.y < 460 && l.rect.w < 900),
    layers,
  };
})()`);
const json = JSON.stringify(report, null, 2);
if (out) { fs.writeFileSync(out, json); console.log('wrote', out, '·', report.layers?.length, 'layers'); }
else console.log(json);
ws.close();
process.exit(0);
