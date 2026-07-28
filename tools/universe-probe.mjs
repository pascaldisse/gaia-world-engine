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
const coreR = Number(flag('coreR', 0.26));
const halo = args.includes('--halo');
const deepfield = Number(flag('deepfield', 1500));
const stars = !args.includes('--nostars');
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
// RELOAD FIRST. The page's entity store survives between probe runs, so a
// second run read the ALREADY-shrunk core radius and shrank it again — after a
// few runs the cloud was 20 units across instead of 152 and the galaxy simply
// vanished (probe a2/a3). Every run starts from the pristine snapshot.
await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 3000));
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
  const HALO_KEEP = ${halo};
  const DEEPFIELD = ${deepfield};
  const STARS = ${stars};
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
    // R0 = the ORIGINAL core radius. Read it BEFORE the core is shrunk, or the
    // cloud size is derived from the shrunken core and the whole galaxy comes
    // out 4x too small (probe a2: the nebula vanished entirely).
    const R0 = (parts[0]?.radius) ?? 12;
    const CG = CORE_GAIN;
    if (parts[0]) parts[0] = { ...parts[0], emissiveIntensity: (parts[0].emissiveIntensity ?? 5.8) * CG, radius: (parts[0].radius ?? 12) * CORE_R };
    // THE HALO SPHERE IS THE MOON. preset:'glow' maps uv() on a SPHERE, so its
    // falloff is equirectangular, not radial: it draws a hard-edged pale disc
    // with a terminator across it (probe s4-d150, a1-d150 — read as a moon at
    // every distance). It also ignores opacity/emissiveIntensity, so dimming
    // did nothing. With the cloud carrying a hot core the halo has no job.
    const HALO = HALO_KEEP;
    if (!HALO && parts.length > 1) parts.length = 1;
    const core = parts[0] ?? {};
    const R = R0;
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
      opacity: 0.85, glowStrength: 2.0, coreFall: 0.55, gain: 3.0, facing: 1.2,
      armSharp: 1.4, armFloor: 0.22, freq: 2.2, hot: 0.85,
      // near fade: below 90 units the camera is inside the dust
      near: [70, 240],
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
  // THE DEEP FIELD. A Hubble frame has no empty quadrant; ours had half a
  // frame of pure black (proof/.../before-g0-d520). One huge quad centred on
  // the cluster, arms flattened (armFloor 1) so it is mass and dust rather
  // than a fourth galaxy, replaces the 300 dust:sky: puff systems as the thing
  // that fills the void. Its id is NOT nebula:/dust:sky: on purpose — those
  // patterns are borrowed by the film's rites layer.
  if (!OFF) {
    const DF = DEEPFIELD;
    if (DF > 0) g.net.send([{ op: 'spawn', id: 'skyfield:deep', components: {
      transform: { position: [40, -140, -40] },
      mesh: { parts: [{
        shape: 'plane', size: [DF * 2, DF * 2], preset: 'nebula', mode: 'glow',
        norm: DF, seed: 21.7, color: '#5b6ea8', edge: '#140f26',
        accent: '#7a4f8f', accent2: '#3f6f8f',
        // FINE GRAIN, NOT FOG. At freq 5.2 / opacity 0.5 the backdrop was
        // blue cotton wool that swallowed the galaxies (probe c1-d520) and cost
        // 8 fps. A deep field is a faint mottle you only notice when it is
        // gone: high frequency, low contrast, 2 octaves.
        armFloor: 1, armSharp: 1, arms: 0.6, spin: 1.1, squash: 0.78,
        coreFall: 0.1, freq: 13, floor: 0.5, gain: 1.7, octaves: 2,
        lane: 0.58, laneScale: 9, laneCut: 0.45, hot: 0, laneOctaves: 1,
        facing: 1.05, rimEnd: 0.88, opacity: 0.17, glowStrength: 0.6,
        far: [4000, 9000], near: [0, 0],
        castShadow: false, renderOrder: 0, fog: false, solid: false,
      }] },
    } }]);
  }
  // STAR COLOUR TEMPERATURE: flip the world's own star/dust fields into
  // particles.js space mode and hand each one its galaxy's accents. Same
  // entities, same ids (the film's rites layer borrows them by id), one draw
  // call each — only the population changes.
  const sf = [];
  let gi = 0;
  for (const [id, comps] of g.store.entities) {
    if (!/^(starfield:|nebula:)/.test(id)) continue;
    const pr = comps.particles;
    if (!pr) continue;
    const acc = [['#ff6ad5', '#7fe6d2'], ['#ffb46a', '#c05cff'], ['#6affd5', '#ffd166']][gi % 3];
    gi += 1;
    sf.push({ op: 'set', id, component: 'particles', value: { ...pr, space: true, accents: acc } });
  }
  if (STARS && sf.length) g.net.send(sf);
  g.net.send(out);
  return { galaxies: seen, ops: out.length, starFields: sf.length, off: OFF };
})()`);
console.log(JSON.stringify(inject));

// ── the film's own gate moments (covenants full field, rites peak, altar) ──
// The distances above judge the SCULPTURE; these are the frames the film holds,
// and they are what the 60 fps gate is written against.
const filmTs = args.filter((a) => a.startsWith('--filmT=')).map((a) => Number(a.slice(8)));
if (filmTs.length) {
  const stamp = Date.now();
  const boot = await evaluate(`(async () => {
    try {
      const m = await import('/plugins/atlas-director.js?b=${stamp}');
      window.D = m.default.director;
      window.D.prepare();
      if (window.D.audio?.el) window.D.audio.el.muted = true;
      window.D.opts = Object.assign({}, window.D.opts, { subtitles: false, mode: 'film' });
      return { ok: true, keys: window.D.keys.length };
    } catch (e) { return { ok: false, why: String(e && e.message) }; }
  })()`);
  if (!boot?.ok) { console.error('film boot failed:', boot?.why); ws.close(); process.exit(1); }
  const frows = [];
  for (const t of filmTs) {
    const info = await evaluate(`(async () => {
      const D = window.D;
      if (D.audio?.el) D.audio.el.muted = true;
      const r = await D.seek(${t});
      for (const id of ['atlas-strategy-ui','atlas-cosmos-ui','overlay','hud','crosshair','panel','outliner','console','palette','debug']) {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      }
      return { scene: r?.scene ?? null, rite: D.cos?.rite ?? null };
    })()`);
    await new Promise((r) => setTimeout(r, 1600));
    const file = `${OUT}/${tag}-t${String(Math.round(t)).padStart(3, '0')}.png`;
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
      return { fps: +(1000 / mean).toFixed(1), p95: +(1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1),
        drawCalls: i.drawCalls, triangles: i.triangles, pixelRatio: r.getPixelRatio(), adapter };
    })()`);
    const row = { t, ...info, file, bytes: fs.statSync(file).size, perf };
    frows.push(row);
    console.log(`t=${t} ${file} scene=${row.scene} rite=${row.rite} fps=${perf.fps} p95=${perf.p95} draws=${perf.drawCalls} tris=${perf.triangles} px=${perf.pixelRatio}`);
  }
  fs.appendFileSync(`${OUT}/${tag}-film.jsonl`, frows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  ws.close();
  process.exit(0);
}

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
