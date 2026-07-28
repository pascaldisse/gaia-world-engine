// SCRATCH PROBE — the Altar, three distances, one session, after a reload.
// Answers with pictures instead of opinion: does a forged record keep its light
// at the distance openFigure('ebrietas') stands at, and does the pair still
// read as one thing when you walk in? Reports the pixels each tier spends.
//   CDP_PORT=9223 GAIA_CLIENT_PORT=5176 node tools/altar-ab.mjs /tmp/ab
import { writeFileSync, mkdirSync } from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const [, , outDir = '/tmp/ab'] = process.argv;
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ws, send } = await connectCdp();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.bringToFront');
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`${e.slice(0, 70)} → ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
  return r.result?.result?.value;
};
const evJson = async (e) => JSON.parse((await ev(`JSON.stringify(${e})`)) ?? 'null');

// the module is served by vite: a code change is only in the picture after a reload
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i += 1) {
  await sleep(1000);
  if (await ev('!!window.gaia?.atlasForge?.cosmos?.ready').catch(() => false)) break;
}
await ev(`(() => { const c = window.gaia.atlasCosmos; c.setRite?.('dream', { silent: true }); })()`);
await sleep(1500);

// how many pixels a record spends on screen, in each tier
const MEASURE = `(() => {
  const c = window.gaia.atlasCosmos, f = window.gaia.atlasForge;
  const V = c.camera.position.constructor;
  const eye = new V(); const e = c.camera.matrixWorld.elements; eye.set(e[12], e[13], e[14]);
  const pxPerRad = window.innerHeight / (2 * Math.tan(c.camera.fov * Math.PI / 360));
  const p = new V(); const rows = [];
  for (const i of c.flockRing.keys()) {
    f.worldPos(i, p);
    const d = eye.distanceTo(p);
    const cap = Math.max(c.moteOpts.minScale, d * c.moteOpts.maxAngle);
    rows.push({ i, d: +d.toFixed(0), forged: f.active.has(i),
      bodyPx: +(2 * f.radiusOf(i) / d * pxPerRad).toFixed(1),
      motePx: +(2 * Math.min(c.scaleOf(i) * c.moteOpts.scale, cap) * (1 - f.cover[i]) / d * pxPerRad).toFixed(1),
      cover: +f.cover[i].toFixed(2) });
  }
  rows.sort((a, b) => a.d - b.d);
  const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[rows.length >> 1];
  return { toEbrietas: +eye.distanceTo(new V(0, -1250, 0)).toFixed(0),
    ebrietasPx: +(2 * 46 / eye.distanceTo(new V(0, -1250, 0)) * pxPerRad).toFixed(0),
    n: rows.length, forged: rows.filter((r) => r.forged).length,
    medBodyPx: med('bodyPx'), medMotePx: med('motePx'), medCover: med('cover'),
    near: rows[0], far: rows[rows.length - 1] };
})()`;

const shoot = async (name) => {
  await send('Page.bringToFront');
  await sleep(250);
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(cap.result.data, 'base64'));
  return `${outDir}/${name}.png`;
};

const out = {};
// autoFrame off first: left on it re-fits the universe and drags the camera off
await ev(`(() => { const s = window.gaia.atlasStrategy; s.autoFrame = false; window.gaia.atlasCosmos.openFigure('ebrietas'); })()`);
await sleep(3600);
out.A_altar = { png: await shoot('A-altar'), m: await evJson(MEASURE) };

for (const [name, radius] of [['B-mid', 200], ['C-close', 150]]) {
  await ev(`window.gaia.atlasStrategy.frameOn(new window.gaia.atlasCosmos.camera.position.constructor(0, -1250, 0), ${radius}, 800)`);
  await sleep(2600);
  out[name] = { png: await shoot(name), m: await evJson(MEASURE) };
}

writeFileSync(`${outDir}/ab.json`, `${JSON.stringify(out, null, 1)}\n`);
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify(v.m));
ws.close();
process.exit(0);
