// FILM LANE C · a CDP client that cannot eat the lane.
// tools/cdp.mjs has no timeouts: one blocked main thread and the shell hangs
// forever (it ate two turns on 07-28). Every call here is deadlined, every
// failure prints and exits non-zero, and the socket is closed on the way out.
//
//   node tools/film-c-cdp.mjs eval '<js>'            evaluate, print result
//   node tools/film-c-cdp.mjs shot out.png           screenshot the page
//   node tools/film-c-cdp.mjs shots <dir> <t0> <t1> <fps>
//        REAL-TIME window capture: rolls the film from t0 (dry clock, speed 1)
//        and shoots every 1/fps second until t1, naming each plate by the film
//        clock it was actually taken at — the only honest proof that a birth
//        MOVES (a seek still cannot show motion).
//   node tools/film-c-cdp.mjs seek <t> out.png       seek + settle + shoot
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = process.env.CDP_PORT ?? 9227;
const CLIENT = process.env.GAIA_CLIENT_PORT ?? 5179;
const DEADLINE = Number(process.env.CDP_TIMEOUT ?? 25000);

async function connect() {
  const targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(`:${CLIENT}`));
  if (!page) throw new Error(`no :${CLIENT} page on CDP ${PORT}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ws open timeout')), 8000);
    ws.on('open', () => { clearTimeout(to); res(); });
    ws.on('error', (e) => { clearTimeout(to); rej(e); });
  });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  });
  const send = (method, params = {}, ms = DEADLINE) => new Promise((res, rej) => {
    const id = ++seq;
    const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${ms}ms`)); }, ms);
    pending.set(id, (msg) => { clearTimeout(to); res(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send };
}

const { ws, send } = await connect();
async function evalIn(expr, ms = DEADLINE) {
  const msg = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
  const r = msg.result?.result;
  if (msg.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails)}`);
  return r?.value;
}
// PAGE-SIDE CAPTURE. Page.captureScreenshot waits for the compositor to hand
// over a fresh frame; with four software-WebGPU chromiums on one machine that
// wait is minutes, and it times out. The recorder plugin already proves the
// honest way to get the picture: inside a rAF the WebGL drawing buffer is
// still intact, so drawImage(canvas) into a 2D canvas and read THAT. Same
// pixels, no compositor round trip. Set SHOT_MODE=cdp to force the old path.
const PAGE_SHOT = `(() => new Promise((res) => {
  const gl = document.querySelector('canvas');
  if (!gl) return res(null);
  requestAnimationFrame(() => {
    try {
      const k = ${Number(process.env.SHOT_SCALE ?? 1)};
      const c = document.createElement('canvas');
      c.width = Math.round(gl.width * k); c.height = Math.round(gl.height * k);
      const x = c.getContext('2d');
      x.drawImage(gl, 0, 0, c.width, c.height);
      res(c.toDataURL('image/png').slice(22));
    } catch (e) { res('ERR:' + e.message); }
  });
}))()`;

const shoot = async (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.env.SHOT_MODE === 'cdp') {
    const msg = await send('Page.captureScreenshot', { format: 'png' }, DEADLINE);
    if (!msg.result?.data) throw new Error('no screenshot data');
    fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
    return fs.statSync(file).size;
  }
  const data = await evalIn(PAGE_SHOT, DEADLINE);
  if (!data || String(data).startsWith('ERR:')) throw new Error(`page shot failed: ${data}`);
  fs.writeFileSync(file, Buffer.from(String(data), 'base64'));
  return fs.statSync(file).size;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THE FRAME BUDGET IS THE LANE'S REAL CONSTRAINT. Four lanes share one
// machine and this browser has no hardware WebGPU adapter: at 1600×900 a frame
// costs 4 SECONDS (measured, cosmos.measureFps), which makes a 2fps real-time
// capture physically impossible. The picture is resolution-bound, not
// logic-bound, so the viewport is shrunk for motion windows (the choreography
// is what is being proved) and opened back up for hero stills.
const viewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, DEADLINE);
  await sleep(500);
  return evalIn('(()=>{const c=document.querySelector("canvas");return c?`${c.width}x${c.height}`:"no canvas";})()');
};

const [, , cmd, a, b, c, d, e] = process.argv;
try {
  if (cmd === 'eval') {
    console.log(await evalIn(a));
  } else if (cmd === 'viewport') {
    console.log(await viewport(Number(a), Number(b)));
  } else if (cmd === 'shot') {
    console.log(`${a} (${await shoot(a)} bytes)`);
  } else if (cmd === 'seek') {
    const t = Number(a);
    console.log(await evalIn(`(async()=>{const r=await gaia.director.seek(${t});return JSON.stringify(r);})()`));
    await sleep(600);
    console.log(`${b} (${await shoot(b)} bytes)`);
  } else if (cmd === 'shots') {
    // WINDOWED CAPTURE. The film clock is the director's own (audio:false →
    // virtual += dt·speed), so `speed` is the only honest way to sample motion
    // on a machine where one frame costs seconds: at speed 0.2 a 25s window
    // renders ~25 plates one film-second apart, and every plate is LABELLED
    // with the film time it was actually taken at. Nothing about the picture
    // changes — every effect in atlas-fx-rites is f(t), not an integration.
    const dir = a;
    const t0 = Number(b);
    const t1 = Number(c);
    const speed = Number(d ?? 0.2);
    if (e) { const [w, h] = e.split('x').map(Number); console.log(`viewport ${await viewport(w, h)}`); }
    fs.mkdirSync(dir, { recursive: true });
    await evalIn(`(async()=>{try{gaia.director.stop({restore:false});}catch(err){}
      const r=await gaia.director.play({record:false,audio:false,speed:${speed},from:${t0},subtitles:true});
      return JSON.stringify(r);})()`, 240000);
    let shots = 0;
    let last = -1;
    for (;;) {
      const s0 = JSON.parse(await evalIn('JSON.stringify(gaia.director.status())'));
      const fx = await evalIn('JSON.stringify(gaia.fxRites?.status?.()??null)');
      if (s0.t >= t1 || !s0.playing) break;
      const name = `${dir}/t${s0.t.toFixed(2).replace('.', '_')}.png`;
      const bytes = await shoot(name);
      shots += 1;
      const f = JSON.parse(fx) ?? {};
      console.log(`${s0.t.toFixed(2)} ${s0.scene} fx[e${f.ember ?? '-'} s${f.streak ?? '-'} h${f.shell ?? '-'}] forged:${s0.forged} rev:${s0.reveal} ${bytes}b${last >= 0 ? ` Δt=${(s0.t - last).toFixed(2)}` : ''}`);
      last = s0.t;
    }
    await evalIn('JSON.stringify(gaia.director.stop({restore:false}))');
    console.log(`captured ${shots} plates → ${dir}`);
  } else {
    console.log('usage: film-c-cdp.mjs eval <js> | shot <f.png> | seek <t> <f.png> | shots <dir> <t0> <t1> [fps]');
  }
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  ws.close();
  process.exit(1);
}
ws.close();
process.exit(0);
