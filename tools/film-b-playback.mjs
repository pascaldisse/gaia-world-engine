// FILM LANE B · THE PLAYBACK AUDIT (the real camera, not the key table)
//
// The analytic audit samples sampleCamera() era by era. This one rolls the
// ACTUAL FILM at 1× with audio off and measures window.gaia.atlasStrategy's
// camera position every frame — so it includes everything the key table cannot
// know about:
//   · the strategy rig's first-order lag (target/distance are lerped toward
//     the goal at 1-exp(-dt·8), so the rendered camera is a filtered version
//     of the authored one)
//   · the live 2s rite transitions, where the WORLD moves under a shot whose
//     targets resolve live
//   · whatever the other lanes' staging does while it rolls
//
// Everything is reduced IN THE PAGE (per-second bins + the worst excursions),
// because pulling 18000 samples back through Runtime.evaluate is how you lose
// a five-minute run.
//
// AUDIO IS OFF (audio:false → the director runs its virtual clock) and the
// browser is muted at the process level; this never makes a sound.
//
//   CDP_PORT=9226 GAIA_CLIENT_PORT=5178 node tools/film-b-playback.mjs [out.json]
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const out = process.argv[2] ?? 'proof/film-b/playback.json';
const { ws, send } = await connectCdp();
const evaluate = async (expression, awaitPromise = true) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};

const started = await evaluate(`(async () => {
  const D = window.D;
  if (D.audio?.el) D.audio.el.muted = true;
  window.__probe = { rows: [], last: null };
  const s = D.s;
  const tick = () => {
    const t = D.t;
    const p = s.camera.position;
    const r = window.__probe;
    if (r.last && t > r.last.t) {
      const dt = t - r.last.t;
      const v = [(p.x - r.last.p[0]) / dt, (p.y - r.last.p[1]) / dt, (p.z - r.last.p[2]) / dt];
      const speed = Math.hypot(v[0], v[1], v[2]);
      let accel = null;
      if (r.last.v) {
        const dv = [v[0] - r.last.v[0], v[1] - r.last.v[1], v[2] - r.last.v[2]];
        accel = Math.hypot(dv[0], dv[1], dv[2]) / dt;
      }
      r.rows.push([t, speed, accel, dt]);
      r.last = { t, p: [p.x, p.y, p.z], v };
    } else if (!r.last) {
      r.last = { t, p: [p.x, p.y, p.z], v: null };
    }
    if (D.playing) window.__probe.raf = requestAnimationFrame(tick);
  };
  const res = await D.play({ audio: false, mode: 'film', subtitles: false, record: false });
  requestAnimationFrame(tick);
  return res;
})()`);
console.log('play:', JSON.stringify(started));

// poll until the film ends (293.44s of film at 1x)
let last = -1;
for (let i = 0; i < 400; i += 1) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await evaluate('JSON.stringify({ t: window.D.t, playing: window.D.playing, n: window.__probe.rows.length })');
  const { t, playing, n } = JSON.parse(st);
  if (t !== last) process.stderr.write(`  t=${t.toFixed(1)} samples=${n}\r`);
  last = t;
  if (!playing || t >= 293.4) break;
}
process.stderr.write('\n');

const report = JSON.parse(await evaluate(`(() => {
  const rows = window.__probe.rows.filter((r) => r[2] !== null);
  const speeds = rows.map((r) => r[1]);
  const accels = rows.map((r) => r[2]);
  const sorted = (xs) => [...xs].sort((a, b) => a - b);
  const q = (xs, f) => { const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  const bins = new Map();
  for (const [t, sp] of rows) {
    const k = Math.floor(t);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(sp);
  }
  const perSecond = [...bins.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, xs]) => [k, +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1), +Math.max(...xs).toFixed(1)]);
  const stops = rows.filter((r) => r[1] < 0.5 && r[0] > 1 && r[0] < 291);
  const worstAccel = [...rows].sort((a, b) => b[2] - a[2]).slice(0, 10).map((r) => ({ t: +r[0].toFixed(2), accel: +r[2].toFixed(1), speed: +r[1].toFixed(1) }));
  const fps = rows.length / (rows[rows.length - 1][0] - rows[0][0]);
  return JSON.stringify({
    samples: rows.length,
    fps: +fps.toFixed(1),
    span: [+rows[0][0].toFixed(2), +rows[rows.length - 1][0].toFixed(2)],
    speed: { min: +q(speeds, 0).toFixed(2), p01: +q(speeds, 0.01).toFixed(2), median: +q(speeds, 0.5).toFixed(2), p99: +q(speeds, 0.99).toFixed(2), max: +q(speeds, 1).toFixed(2) },
    accel: { median: +q(accels, 0.5).toFixed(2), p99: +q(accels, 0.99).toFixed(2), max: +q(accels, 1).toFixed(2) },
    stops: stops.length,
    stopsAt: stops.slice(0, 8).map((r) => +r[0].toFixed(2)),
    slowestMidFilm: (() => { const m = rows.filter((r) => r[0] > 1 && r[0] < 291).reduce((a, b) => (b[1] < a[1] ? b : a)); return { t: +m[0].toFixed(2), speed: +m[1].toFixed(2) }; })(),
    worstAccel,
    perSecond,
  });
})()`));

fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
const { perSecond, ...head } = report;
console.log(JSON.stringify(head, null, 2));
console.log(`\n→ ${out} (${perSecond.length} per-second bins)`);
ws.close();
process.exit(0);
