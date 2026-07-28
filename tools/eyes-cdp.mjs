// BEAUTY LANE · EYES — the lane's CDP driver. Every plate in proof/eyes/ came
// out of here, so the rules that make a plate honest live in ONE file:
//
//  1. IN-PAGE READBACK IS BLACK. drawImage(webgpuCanvas) inside a rAF returns
//     an empty buffer — a WebGPU canvas only reads back in the same task that
//     DREW it (client/main.js:519 states the law). So plates are taken with
//     CDP Page.captureScreenshot, never with a canvas.toDataURL.
//  2. TWO GATES BEFORE ANY PLATE. localStorage atlas_gate + atlas_seen_intro,
//     and ?intro=off — otherwise every shot is the gate's "We are born of the
//     blood" card.
//  3. MUTED, ALWAYS. --mute-audio on the process, ?mute=1 on the URL, and
//     every director roll here is audio:false (the virtual clock).
//
// usage:
//   node tools/eyes-cdp.mjs boot
//   node tools/eyes-cdp.mjs eval 'gaia.eyes.stats()'
//   node tools/eyes-cdp.mjs shot proof/eyes/foo.png
//   node tools/eyes-cdp.mjs fps 3
//   node tools/eyes-cdp.mjs seek 187.8 proof/eyes/watchers_eye.png
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.CDP_PORT ?? 9251;
const CLIENT = process.env.GAIA_CLIENT_PORT ?? 5187;

export async function connect() {
  const list = await (await fetch(`http://localhost:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes(`:${CLIENT}`))
    ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error(`no page on CDP ${CDP}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`EXCEPTION ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  async function ev(expr, { awaitPromise = true, timeout = 120000 } = {}) {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise, returnByValue: true }),
      new Promise((res) => setTimeout(() => res({ timedOut: true }), timeout)),
    ]);
    if (r.timedOut) throw new Error(`eval timed out after ${timeout}ms`);
    const d = r.result?.result;
    if (r.result?.exceptionDetails) {
      throw new Error(`page threw: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    }
    return d?.value;
  }

  async function shot(file, { fromSurface = true } = {}) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface, captureBeyondViewport: false });
    if (!r.result?.data) throw new Error('captureScreenshot returned nothing');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.from(r.result.data, 'base64');
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length };
  }

  return { ws, send, ev, shot, logs, close: () => ws.close() };
}

/** the two gates + a reload, then wait for the cosmos. */
export async function boot(c, { url = `http://localhost:${CLIENT}/?mute=1&intro=off`, waitMs = 120000 } = {}) {
  await c.ev(`localStorage.setItem('atlas_gate','1'); localStorage.setItem('atlas_seen_intro','1'); return 1;`);
  await c.send('Page.navigate', { url });
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > waitMs) throw new Error('cosmos never became ready');
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await c.ev(`return !!(window.gaia?.cosmos?.cosmos?.ready ?? window.gaia?.cosmos?.ready);`).catch(() => false);
    if (ok) break;
  }
  return Date.now() - t0;
}

/** fps over `sec` seconds, measured in the page's own rAF. */
export async function fps(c, sec = 3) {
  return c.ev(`
    return await new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const step = () => { n += 1; if (performance.now() - t0 < ${sec * 1000}) requestAnimationFrame(step); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); };
      requestAnimationFrame(step);
    });
  `, { timeout: (sec + 20) * 1000 });
}

/** draw calls of the last rendered frame, off the renderer's own counter. */
export async function draws(c) {
  return c.ev(`const r = window.gaia?.view?.renderer ?? window.gaia?.renderer; return r ? { calls: r.info.render.calls, tris: r.info.render.triangles } : null;`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const c = await connect();
  try {
    if (cmd === 'boot') console.log('booted in', await boot(c), 'ms');
    else if (cmd === 'eval') console.log(JSON.stringify(await c.ev(`return (${rest.join(' ')})`), null, 1));
    else if (cmd === 'raw') console.log(JSON.stringify(await c.ev(rest.join(' ')), null, 1));
    else if (cmd === 'shot') console.log(await c.shot(rest[0]));
    else if (cmd === 'fps') console.log('fps', await fps(c, Number(rest[0] ?? 3)), await draws(c));
    else if (cmd === 'seek') {
      await c.ev(`const d = (await import('/plugins/atlas-director.js')).default ?? window.gaia.director; await (window.gaia.director?.seek ?? d.seek)(${Number(rest[0])}); return 1;`);
      await new Promise((r) => setTimeout(r, 900));
      if (rest[1]) console.log(await c.shot(rest[1]));
    } else console.log('cmds: boot | eval <js> | raw <stmts> | shot <file> | fps [sec] | seek <t> [file]');
    if (c.logs.length) console.log('--- page logs ---\n' + c.logs.slice(-40).join('\n'));
  } finally { c.close(); }
}
