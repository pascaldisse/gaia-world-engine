// BEAUTY LANE · the ART-REVIEW camera. The film's own framings (beauty-plate)
// judge the SHOT; this judges the SCULPTURE — any subject, any distance, any
// angle, so a form can be inspected at the distance a human would walk up to.
//
// It drives the atlas' own strategy rig (target / goalDistance / yaw / pitch)
// rather than the raw camera, because the rig lerps and a plate taken mid-lerp
// is not the framing that was asked for — so every shot waits for the settle.
//
//   CDP_PORT=9241 GAIA_CLIENT_PORT=5191 node tools/beauty-look.mjs \
//     --at=ebrietas --dist=150 --yaw=0.6 --pitch=0.12 --tag=ebri --out=proof/beauty/ebrietas
//
// --at: ebrietas | doll | galaxy:N | node:<id> | x,y,z
// --perf: also measure fps + draw calls at that framing (Metal-3 adapter only —
//         a fps from SwiftShader is not a measurement, it is a rumour).
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const at = flag('at', 'ebrietas');
const dist = Number(flag('dist', 150));
const yaw = Number(flag('yaw', 0.6));
const pitch = Number(flag('pitch', 0.1));
const tag = flag('tag', 'look');
const OUT = flag('out', 'proof/beauty/look');
const wantPerf = args.includes('--perf');
const settle = Number(flag('settle', 2600)); // 2.6 s: the rig's own lerp needed
// ~2 s from a cold target at 1250 units away; 1.2 s left it visibly short.
fs.mkdirSync(OUT, { recursive: true });

const { ws, send } = await connectCdp();
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};

await evaluate(`(() => { localStorage.setItem('atlas_gate','1'); localStorage.setItem('atlas_seen_intro','1'); return 1; })()`);
const state = await evaluate(`(async () => {
  for (let i = 0; i < 240; i += 1) { if (window.gaia?.atlasCosmos?.ready) break; await new Promise((r) => setTimeout(r, 250)); }
  const c = window.gaia?.atlasCosmos;
  if (!c?.ready) return { ok: false, why: 'cosmos never became ready — reload the tab with ?static=1&intro=off&mute=1' };
  c.cinematic(true);
  return { ok: true, nodes: c.nodes.length, forsaken: c.forsaken.length };
})()`);
if (!state?.ok) { console.error(state?.why); ws.close(); process.exit(1); }

const framing = await evaluate(`(() => {
  const g = window.gaia, s = g.atlasStrategy, c = g.atlasCosmos;
  let p = null;
  const want = ${JSON.stringify(at)};
  if (/^-?[\\d.]+,/.test(want)) p = want.split(',').map(Number);
  else if (want === 'ebrietas' || want === 'doll') p = (c.figures.find((f) => f.kind === want)?.group.position.toArray()) ?? null;
  else { const e = g.store.entities.get(want); p = e?.transform?.position ?? null; }
  if (!p) return { ok: false, why: 'no such subject: ' + want };
  s.target.set(p[0], p[1], p[2]); s.goal.set(p[0], p[1], p[2]);
  s.distance = ${dist}; s.goalDistance = ${dist};
  s.yaw = ${yaw}; s.pitch = ${pitch};
  s.autoFrame = false;
  return { ok: true, at: p.map(Math.round) };
})()`);
if (!framing?.ok) { console.error(framing?.why); ws.close(); process.exit(1); }
await new Promise((r) => setTimeout(r, settle));

const shot = `${OUT}/${tag}-d${dist}-y${yaw}.png`;
const msg = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(shot, Buffer.from(msg.result.data, 'base64'));

let perf = null;
if (wantPerf) {
  perf = await evaluate(`(async () => {
    const r = window.gaia.view.renderer;
    const dt = [];
    await new Promise((done) => { let last = performance.now(), n = 0;
      const tick = (now) => { dt.push(now - last); last = now; if (++n >= 150) return done(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick); });
    dt.shift();
    const sorted = [...dt].sort((a, b) => a - b);
    const mean = dt.reduce((a, b) => a + b, 0) / dt.length;
    const i = r.info.render;
    let adapter = null;
    try { const a = await navigator.gpu.requestAdapter(); adapter = a?.info ? a.info.vendor + '/' + a.info.architecture : 'unknown'; } catch {}
    return { fps: +(1000 / mean).toFixed(1), p95: +(1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1),
      worst: +(1000 / sorted[sorted.length - 1]).toFixed(1), drawCalls: i.drawCalls, triangles: i.triangles,
      points: i.points, pixelRatio: r.getPixelRatio(), adapter };
  })()`);
}

const row = { at, target: framing.at, dist, yaw, pitch, file: shot, bytes: fs.statSync(shot).size, perf };
fs.appendFileSync(`${OUT}/${tag}-log.jsonl`, `${JSON.stringify(row)}\n`);
console.log(JSON.stringify(row, null, 2));
ws.close();
process.exit(0);
