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
const evalIn = async (expr, ms = DEADLINE) => {
  const msg = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
  const r = msg.result?.result;
  if (msg.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails)}`);
  return r?.value;
};
const shoot = async (file) => {
  const msg = await send('Page.captureScreenshot', { format: 'png' }, DEADLINE);
  if (!msg.result?.data) throw new Error('no screenshot data');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  return fs.statSync(file).size;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , cmd, a, b, c, d] = process.argv;
try {
  if (cmd === 'eval') {
    console.log(await evalIn(a));
  } else if (cmd === 'shot') {
    console.log(`${a} (${await shoot(a)} bytes)`);
  } else if (cmd === 'seek') {
    const t = Number(a);
    console.log(await evalIn(`(async()=>{const r=await gaia.director.seek(${t});return JSON.stringify(r);})()`));
    await sleep(600);
    console.log(`${b} (${await shoot(b)} bytes)`);
  } else if (cmd === 'shots') {
    const dir = a;
    const t0 = Number(b);
    const t1 = Number(c);
    const fps = Number(d ?? 2);
    fs.mkdirSync(dir, { recursive: true });
    // roll REAL TIME from t0: audio:false gives the virtual clock at speed 1,
    // which is the same picture the scored take shows, minus the sound
    await evalIn(`(async()=>{gaia.director.stop({restore:false});const r=await gaia.director.play({record:false,audio:false,speed:1,from:${t0},subtitles:true});return JSON.stringify(r);})()`);
    const step = 1000 / fps;
    let shots = 0;
    for (;;) {
      const st = await evalIn('JSON.stringify(gaia.director.status())');
      const s = JSON.parse(st);
      if (s.t >= t1 || !s.playing) break;
      const name = `${dir}/t${s.t.toFixed(2).replace('.', '_')}.png`;
      const bytes = await shoot(name);
      shots += 1;
      console.log(`${s.t.toFixed(2)} ${s.scene} forged:${s.forged} reveal:${s.reveal} ${path.basename(name)} ${bytes}b`);
      await sleep(step);
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
