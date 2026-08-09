// varuna-shot.mjs — park the camera on a target and take a plate, optionally
// with an fps sample. Everything is a parameter with a default; nothing about
// the world is scripted, only the observer moves.
//   CDP_PORT=9347 GAIA_CLIENT_PORT=5191 node tools/varuna-shot.mjs \
//     --out=proof/varuna/a.png --pos=0,3.2,7 --look=0,1.0,0 [--fps=600] [--wait=2000]
import fs from 'node:fs';
import path from 'node:path';
import { connectCdp } from './cdp-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const out = flag('out', 'proof/varuna/plate.png');
const pos = flag('pos', '0,3.2,7').split(',').map(Number);
const look = flag('look', '0,1.0,0').split(',').map(Number);
const frames = Number(flag('fps', 0));
const wait = Number(flag('wait', 1500));

const { ws, send } = await connectCdp();
const evaluate = async (expression, timeoutMs = 60000) => {
  const msg = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    new Promise((_, rj) => setTimeout(() => rj(new Error('eval timeout')), timeoutMs)),
  ]);
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};

// The observer is the only thing this tool moves: the player rig is parked and
// frozen, the entry overlay is hidden for the plate. No world state is touched.
await evaluate(`(() => {
  const g = window.gaia; const p = g.player; const cam = g.view?.camera || g.camera;
  const P = [${pos.join(',')}], L = [${look.join(',')}];
  const d = [L[0]-P[0], L[1]-P[1], L[2]-P[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (p) {
    p.position.set(P[0], P[1] - (p.eyeHeight ?? 0), P[2]);
    p.yaw = Math.atan2(-d[0], -d[2]);
    p.pitch = Math.asin(d[1] / len);
    p.velocity?.set?.(0, 0, 0);
    p.frozen = true; p.spawned = true;
  }
  cam.position.set(P[0], P[1], P[2]);
  cam.lookAt(L[0], L[1], L[2]);
  for (const el of document.querySelectorAll('body > div, body > section')) {
    if (el.contains(document.querySelector('canvas'))) continue;
    el.style.visibility = 'hidden';
  }
  return 1;
})()`);
await new Promise((r) => setTimeout(r, wait));

fs.mkdirSync(path.dirname(out), { recursive: true });
const msg = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(msg.result.data, 'base64'));
console.log(`plate ${out} ${fs.statSync(out).size} bytes`);

if (frames > 0) {
  const fps = await evaluate(`(async () => {
    const N = ${frames}; const dts = []; let last = performance.now();
    await new Promise((res) => {
      const tick = () => { const t = performance.now(); dts.push(t - last); last = t;
        if (dts.length >= N) res(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const s = dts.slice(1).sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const info = (window.gaia.view?.renderer || window.gaia.renderer)?.info?.render || {};
    return JSON.stringify({ frames: s.length + 1, meanFps: +(1000 / mean).toFixed(1),
      p50Fps: +(1000 / s[Math.floor(s.length / 2)]).toFixed(1),
      p95msFrame: +s[Math.floor(s.length * 0.95)].toFixed(2),
      drawCalls: info.drawCalls, triangles: info.triangles });
  })()`, 120000);
  console.log(fps);
}
ws.close();
process.exit(0);
