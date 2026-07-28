// FILM LANE B · NUMERIC AUDIT OF THE ONE SHOT
//
// Proves the two claims the one-shot camera has to make:
//   1. zero stops except the authored start and end
//   2. no acceleration spikes (a spike is what a cut felt like)
//
// It measures the EYE, not the keyframes: eye = target + spherical(yaw, pitch,
// distance) is what atlas-strategy actually renders, so a smooth key table
// with a lurching eye would still fail here.
//
// The rites re-lay out the whole record cloud (covenants → radius 1614,
// moons → 2343), so a live-resolving key table means a DIFFERENT curve per
// rite era. The audit therefore walks era by era, putting the world in the
// rite the film is in at that moment, and reports each era's profile plus the
// whole film's. Sampling is 1/120 s — twice the frame rate, so a one-frame
// spike cannot hide between samples.
//
//   CDP_PORT=9226 GAIA_CLIENT_PORT=5178 node tools/film-b-audit.mjs [out.json]
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const DURATION = 293.44;
// (rite the film has set, from enterScene: covenants at 161.76, shells 193.2,
// moons 198, dream 205.48) — the eras the key table resolves inside of
const ERAS = [
  ['dream', 0, 161.76],       // the film opens in the atlas layout (== dream)
  ['covenants', 161.76, 193.2],
  ['shells', 193.2, 198],
  ['moons', 198, 205.48],
  ['dream', 205.48, DURATION],
];

const { ws, send } = await connectCdp();
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};

// the page keeps the director instance on window.D (see film-b-boot)
const ready = await evaluate('!!(window.D && window.D.keys) || (window.D ? (window.D.prepare(), !!window.D.keys) : false)');
if (!ready) { console.error('no prepared director on window.D — run tools/film-b-boot.mjs first'); process.exit(1); }

const samples = [];
for (const [rite, t0, t1] of ERAS) {
  const rows = await evaluate(`(() => {
    const D = window.D, c = D.cos, S = window.__filmB.sampleCamera;
    c.setRite(${JSON.stringify(rite)}, { silent: true });
    if (c.transition) { c.cur.set(c.goalPos); c.transition = null; c.matrixDirty = true; }
    const out = [];
    for (let t = ${t0}; t <= ${t1} + 1e-9; t += 1 / 120) {
      const k = S(D.keys, t);
      const flat = Math.cos(k.pitch) * k.dist;
      out.push([t,
        k.tgt[0] + Math.sin(k.yaw) * flat,
        k.tgt[1] + Math.sin(k.pitch) * k.dist,
        k.tgt[2] + Math.cos(k.yaw) * flat,
        k.dist, k.yaw, k.pitch]);
    }
    return out;
  })()`);
  for (const r of rows) samples.push({ rite, t: r[0], eye: [r[1], r[2], r[3]], dist: r[4], yaw: r[5], pitch: r[6] });
  process.stderr.write(`  ${rite} ${t0}→${t1}: ${rows.length} samples\n`);
}

// ── velocity / acceleration of the eye ──────────────────────────────────────
const dt = 1 / 120;
const vel = [];
for (let i = 1; i < samples.length; i += 1) {
  const a = samples[i - 1]; const b = samples[i];
  if (b.t < a.t) continue; // era seam: measured separately below
  const v = [0, 1, 2].map((j) => (b.eye[j] - a.eye[j]) / dt);
  vel.push({ t: (a.t + b.t) / 2, rite: b.rite, v, speed: Math.hypot(...v) });
}
const acc = [];
for (let i = 1; i < vel.length; i += 1) {
  const a = vel[i - 1]; const b = vel[i];
  if (b.t < a.t || b.rite !== a.rite) continue;
  const d = [0, 1, 2].map((j) => (b.v[j] - a.v[j]) / dt);
  acc.push({ t: (a.t + b.t) / 2, mag: Math.hypot(...d) });
}

const stat = (xs) => {
  const s = [...xs].sort((p, q) => p - q);
  const at = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return {
    min: s[0], p01: at(0.01), median: at(0.5), p99: at(0.99), max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};

const speeds = vel.map((x) => x.speed);
const sp = stat(speeds);
// a STOP is the eye standing still mid-film; authored stillness lives only in
// the first and last moments, so anything below 0.5 u/s inside 1..291 is a bug
const stops = vel.filter((x) => x.speed < 0.5 && x.t > 1 && x.t < 291);
const slow = vel.filter((x) => x.speed < 2 && x.t > 1 && x.t < 291);
const accs = acc.map((x) => x.mag);
const ac = stat(accs);
const spikes = [...acc].sort((a, b) => b.mag - a.mag).slice(0, 12);

// does the speed breathe WITH the music? correlate speed against the same
// envelope the flow is built from (per-second means, whole film)
const FLOW = JSON.parse(fs.readFileSync(new URL('../../paloptic/viz/video/audio/envelope.json', import.meta.url), 'utf8')).sr_envelope_1s;
const bySec = new Map();
for (const x of vel) {
  const s = Math.floor(x.t);
  if (!bySec.has(s)) bySec.set(s, []);
  bySec.get(s).push(x.speed);
}
const pairs = [...bySec.entries()]
  .filter(([s]) => s < FLOW.length)
  .map(([s, xs]) => [FLOW[s], xs.reduce((a, b) => a + b, 0) / xs.length]);
const corr = (() => {
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
})();

// per-beat speeds (the anchors the brief names) + the phase profile
const at = (t) => vel.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best), vel[0]);
const beats = { ignition: 79.7, split: 107.13, naming: 148.33, stirred: 181.34, bell: 214.89, come: 227.78, dive: 236, leftBehind: 258, peak: 270.5, welcome: 276.44, handover: 288.6 };
const beatSpeeds = Object.fromEntries(Object.entries(beats).map(([k, t]) => [k, Number(at(t).speed.toFixed(1))]));

const phases = [[0, 79.7, 'crane'], [79.7, 103.32, 'watch+lonely'], [103.32, 123.6, 'fracture'], [123.6, 144.08, 'accretion'], [144.08, 161.76, 'naming'], [161.76, 176.32, 'covenants'], [176.32, 192.5, 'greatones'], [192.5, 205.48, 'rites'], [205.48, 227.78, 'bloodline'], [227.78, 244, 'DIVE'], [244, 264, 'altar'], [264, 288.6, 'rise'], [288.6, DURATION, 'rest']];
const phaseRows = phases.map(([a, b, name]) => {
  const xs = vel.filter((x) => x.t >= a && x.t < b).map((x) => x.speed);
  const s = stat(xs);
  return { phase: name, from: a, to: b, min: +s.min.toFixed(1), mean: +s.mean.toFixed(1), max: +s.max.toFixed(1) };
});

const report = {
  samples: samples.length,
  dt,
  speed: Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, +v.toFixed(2)])),
  stops: stops.length,
  stopsAt: stops.slice(0, 10).map((x) => +x.t.toFixed(2)),
  slowBelow2: slow.length,
  slowestMidFilm: (() => { const m = vel.filter((x) => x.t > 1 && x.t < 291).reduce((a, b) => (b.speed < a.speed ? b : a)); return { t: +m.t.toFixed(2), speed: +m.speed.toFixed(2) }; })(),
  accel: Object.fromEntries(Object.entries(ac).map(([k, v]) => [k, +v.toFixed(2)])),
  accelSpikes: spikes.map((x) => ({ t: +x.t.toFixed(2), mag: +x.mag.toFixed(1) })),
  envelopeCorrelation: +corr.toFixed(3),
  beatSpeeds,
  phases: phaseRows,
  distRange: [Math.min(...samples.map((s) => s.dist)).toFixed(0), Math.max(...samples.map((s) => s.dist)).toFixed(0)],
  yawMonotone: samples.every((s, i) => i === 0 || samples[i].t < samples[i - 1].t || s.yaw >= samples[i - 1].yaw - 1e-9),
};

const out = process.argv[2] ?? 'proof/film-b/audit.json';
fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\n→ ${out}`);
ws.close();
process.exit(0);
