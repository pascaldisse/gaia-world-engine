// BEAUTY UNIVERSE LANE · the look-dev loop for the nebula shader.
//
// Regenerating paloptic's ops + the 933 KB snapshot for every shader tweak is
// a 40-second round trip, so this injects the SAME shell parts the generator
// will emit straight onto the live `galaxy:*` entities as ops (static mode
// applies ops locally) and photographs the result. What this tool proves is
// the CLIENT half — the shader, the draw-call cost, the depth grade. The
// generator half is proved by the regen plates.
//
// NO WINDOW: it talks to the already-running headless browser over CDP and
// plates come from Page.captureScreenshot only (an in-page readback of a
// WebGPU canvas returns an empty buffer).
//
//   CDP_PORT=9243 GAIA_CLIENT_PORT=5193 node tools/universe-probe.mjs \
//     --tag=n1 --dist=520 --dist=150 --dist=42 [--patch='{"arms":3.1}'] [--off]
//
// --patch: a JSON object merged into every shell part (look-dev without an
//          edit-reload cycle). --off: strip the shells again (A/B).
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const tag = flag('tag', 'probe');
const OUT = flag('out', 'proof/beauty/universe/probe');
const at = flag('at', 'galaxy:0');
const yaw = Number(flag('yaw', 0.7));
const pitch = Number(flag('pitch', 0.18));
const patch = flag('patch', '{}');
// shell radius as a multiple of the galaxy CORE radius. 4.6 (first take) put
// the cloud INSIDE the core's own bloom halo — it read as caviar sitting next
// to a headlight. A galaxy's cloud has to be wider than its star field
// (areaRadius 59–101 here, core radius 10–16), so the multiple is ~10.
const rscale = Number(flag('rscale', 10.2));
const coreGain = Number(flag('core', 0.34));
const coreR = Number(flag('coreR', 0.62));
const off = args.includes('--off');
const dists = args.filter((a) => a.startsWith('--dist=')).map((a) => Number(a.slice(7)));
if (!dists.length) dists.push(520, 150, 42);
fs.mkdirSync(OUT, { recursive: true });

const { ws, send } = await connectCdp();
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};

await evaluate(`(() => { localStorage.setItem('atlas_gate','1'); localStorage.setItem('atlas_seen_intro','1'); return 1; })()`);
const ready = await evaluate(`(async () => {
  for (let i = 0; i < 240; i += 1) { if (window.gaia?.atlasCosmos?.ready) break; await new Promise((r) => setTimeout(r, 250)); }
  const c = window.gaia?.atlasCosmos;
  if (!c?.ready) return { ok: false, why: 'cosmos never became ready' };
  c.cinematic(true);
  return { ok: true, nodes: c.nodes.length };
})()`);
if (!ready?.ok) { console.error(ready?.why); ws.close(); process.exit(1); }

// ── the shells, exactly as world-build will declare them ──────────────────
// This mirrors paloptic viz/pipeline/world-build.ts nebulaShellParts(); any
// number that differs between the two is a bug in one of them.
const inject = await evaluate(`(() => {
  const g = window.gaia;
  const PATCH = ${JSON.stringify(JSON.parse(patch))};
  const RSCALE = ${rscale};
  const CORE_GAIN = ${coreGain};
  const CORE_R = ${coreR};
  const OFF = ${off};
  const out = [];
  const seen = [];
  for (const [id, comps] of g.store.entities) {
    if (!id.startsWith('galaxy:')) continue;
    const parts = (comps.mesh?.parts ?? []).filter((p) => p.preset !== 'nebula');
    if (OFF) { out.push({ op: 'set', id, component: 'mesh', value: { parts } }); seen.push(id); continue; }
    // THE CORE MUST YIELD. At emissiveIntensity 5.8 + halo 0.28 + bloom
    // threshold 0.5 the two core spheres ARE the galaxy: a headlight whose
    // bloom covers every filament the cloud draws. Dimming them is what lets
    // the nebula carry the light (the --core knob mirrors world-build's
    // coreEmissiveIntensity / coreHaloOpacity).
    const CG = CORE_GAIN;
    if (parts[0]) parts[0] = { ...parts[0], emissiveIntensity: (parts[0].emissiveIntensity ?? 5.8) * CG, radius: (parts[0].radius ?? 12) * CORE_R };
    if (parts[1]) parts[1] = { ...parts[1], emissiveIntensity: (parts[1].emissiveIntensity ?? 1.6) * CG, opacity: (parts[1].opacity ?? 0.28) * CG };
    const core = parts[0] ?? {};
    const R = core.radius ?? 12;
    const hue = core.color ?? '#a8c6ff';
    const i = seen.length;
    // per-galaxy decorrelation: seed, disc axes and tilt all differ, so three
    // galaxies never read as three copies of one cloud.
    const seed = 3.7 + i * 5.31;
    const lean = 0.13 + i * 0.09;
    const RS = R * RSCALE;
    const glow = {
      // a camera-facing quad: size is the DIAMETER, norm the half-size the
      // shader normalises cloud space by
      shape: 'plane', size: [RS * 2, RS * 2], preset: 'nebula', mode: 'glow',
      norm: RS, seed,
      color: hue, edge: ['#2b1c56', '#3a2038', '#1c2a55'][i % 3],
      accent: ['#ff6ad5', '#ffb46a', '#6affd5'][i % 3],
      accent2: ['#7fe6d2', '#c05cff', '#ffd166'][i % 3],
      arms: 2.4 + i * 0.35, thick: 2.1, warp: 0.4,
      // MENSIS: a tilted lens, different axes and angles per galaxy
      axes: [1, 0.38 + i * 0.06, 0.9 - i * 0.07],
      tilt: [lean * 1.6, -lean * 2.1 + i * 0.2],
      opacity: 0.5, glowStrength: 1.25,
      castShadow: false, renderOrder: 1, fog: false, solid: false,
      ...PATCH,
    };
    const lanes = {
      ...glow, mode: 'lanes', size: [RS * 1.86, RS * 1.86], norm: RS * 0.93,
      color: '#0a0710', warm: '#2a1408', opacity: 0.72,
      octaves: 3, renderOrder: 2,
      ...PATCH,
    };
    out.push({ op: 'set', id, component: 'mesh', value: { parts: [...parts, glow, lanes] } });
    seen.push(id);
  }
  g.net.send(out);
  return { galaxies: seen, ops: out.length, off: OFF };
})()`);
console.log(JSON.stringify(inject));

const target = await evaluate(`(() => {
  const g = window.gaia, s = g.atlasStrategy;
  const e = g.store.entities.get(${JSON.stringify(at)});
  const p = e?.transform?.position;
  if (!p) return { ok: false };
  s.target.set(p[0], p[1], p[2]); s.goal.set(p[0], p[1], p[2]);
  s.yaw = ${yaw}; s.pitch = ${pitch}; s.autoFrame = false;
  return { ok: true, at: p.map(Math.round) };
})()`);
if (!target?.ok) { console.error('no such subject'); ws.close(); process.exit(1); }

const rows = [];
for (const d of dists) {
  await evaluate(`(() => { const s = window.gaia.atlasStrategy; s.distance = ${d}; s.goalDistance = ${d}; return 1; })()`);
  await new Promise((r) => setTimeout(r, 2600)); // the rig lerps; a mid-lerp plate is not the framing asked for
  const file = `${OUT}/${tag}-d${d}.png`;
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  const perf = await evaluate(`(async () => {
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
    const errs = (window.__gaiaWarn ?? []).slice(-4);
    return { fps: +(1000 / mean).toFixed(1), p95: +(1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1),
      worst: +(1000 / sorted[sorted.length - 1]).toFixed(1), drawCalls: i.drawCalls, triangles: i.triangles,
      pixelRatio: r.getPixelRatio(), adapter, errs };
  })()`);
  const row = { tag, at, dist: d, file, bytes: fs.statSync(file).size, perf };
  rows.push(row);
  console.log(`${file} fps=${perf.fps} p95=${perf.p95} draws=${perf.drawCalls} tris=${perf.triangles} px=${perf.pixelRatio} ${perf.errs?.length ? JSON.stringify(perf.errs) : ''}`);
}
fs.appendFileSync(`${OUT}/${tag}-log.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
ws.close();
process.exit(0);
