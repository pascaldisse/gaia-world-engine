// BEAUTY LANE · plates + measurements.
//
// A plate is taken with CDP Page.captureScreenshot and NOTHING ELSE: an
// in-page readback of a WebGPU canvas returns an empty buffer (a WebGPU
// canvas only reads back in the same task that drew it — 79 plates once came
// out as 5999-byte black frames this way).
//
// Two gates decide whether a plate shows the film or the gate card: the
// localStorage keys `atlas_gate` + `atlas_seen_intro`, and `?intro=off`. They
// are set here before the reload so a fresh profile is never photographed
// showing "We are born of the blood".
//
//   CDP_PORT=9241 GAIA_CLIENT_PORT=5191 node tools/beauty-plate.mjs \
//     --tag=before --t=236 --t=258 --t=270 [--fps] [--out=proof/beauty]
//
// --fps holds the film at each t and measures rAF deltas over 150 frames plus
// renderer.info.render.{drawCalls,triangles}: the perf gate of this pass.
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const tag = flag('tag', 'plate');
const OUT = flag('out', 'proof/beauty');
const FPS_FRAMES = Number(flag('frames', 150)); // 150 frames ≈ 2.5 s at 60: long
// enough that one hitch cannot own the mean, short enough to sample 6 moments.
const wantFps = args.includes('--fps');
const times = args.filter((a) => a.startsWith('--t=')).map((a) => Number(a.slice(4)));
if (!times.length) times.push(270);
fs.mkdirSync(OUT, { recursive: true });

const { ws, send } = await connectCdp();
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};
const shot = async (file) => {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  return fs.statSync(file).size;
};

// ── the gates, then a reload so the app boots past them ───────────────────
await evaluate(`(() => { localStorage.setItem('atlas_gate', '1'); localStorage.setItem('atlas_seen_intro', '1'); return 1; })()`);
await send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 2500));

// ── who is actually drawing this? A fps number from SwiftShader is a lie ──
const rig = await evaluate(`(async () => {
  const out = { ua: navigator.userAgent };
  try {
    const a = await navigator.gpu.requestAdapter();
    out.adapter = a ? (a.info ? { vendor: a.info.vendor, arch: a.info.architecture, desc: a.info.description } : 'no-info') : 'none';
    out.limits = a ? a.limits.maxTextureDimension2D : null;
  } catch (e) { out.adapter = 'error: ' + e.message; }
  return out;
})()`);

// ── boot the film into the tab (same handles the film lanes use) ──────────
const stamp = Date.now();
const boot = await evaluate(`(async () => {
  try {
    for (let i = 0; i < 240; i += 1) {
      if (window.gaia?.atlasCosmos?.ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!window.gaia?.atlasCosmos?.ready) return { ok: false, why: 'cosmos never became ready' };
    const m = await import('/plugins/atlas-director.js?b=${stamp}');
    window.__beauty = m;
    window.D = m.default.director;
    window.D.prepare();
    if (window.D.audio?.el) window.D.audio.el.muted = true;
    window.D.opts = Object.assign({}, window.D.opts, { subtitles: false, mode: 'film' });
    return { ok: true, keys: window.D.keys.length, nodes: window.gaia.atlasCosmos.nodes.length };
  } catch (e) { return { ok: false, why: String(e && e.message), stack: String(e && e.stack).split('\\n').slice(1, 4).join(' | ') }; }
})()`);
console.log(JSON.stringify({ rig, boot }, null, 2));
if (!boot?.ok) { ws.close(); process.exit(1); }

const rows = [];
for (const t of times) {
  const info = await evaluate(`(async () => {
    const D = window.D;
    if (D.audio?.el) D.audio.el.muted = true;
    const r = await D.seek(${t});
    for (const id of ['atlas-strategy-ui', 'atlas-cosmos-ui', 'overlay', 'hud', 'crosshair', 'panel', 'outliner', 'console', 'palette', 'debug']) {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    }
    return { t: ${t}, scene: r?.scene ?? null, rite: D.cos?.rite ?? null };
  })()`);
  // the strategy camera lerps toward its goal; a plate caught mid-lerp is not
  // the frame the film holds
  await new Promise((r) => setTimeout(r, 1200));
  const file = `${OUT}/${tag}-t${String(Math.round(t)).padStart(3, '0')}.png`;
  const bytes = await shot(file);
  const row = { ...info, file, bytes };
  if (wantFps) {
    row.perf = await evaluate(`(async () => {
      const s = window.gaia?.state ?? window.D?.s;
      const r = s?.renderer;
      const dt = [];
      await new Promise((done) => {
        let last = performance.now(), n = 0;
        const tick = (now) => { dt.push(now - last); last = now; if (++n >= ${FPS_FRAMES}) return done(); requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      dt.shift();
      const sorted = [...dt].sort((a, b) => a - b);
      const mean = dt.reduce((a, b) => a + b, 0) / dt.length;
      const info = r?.info?.render ?? {};
      return {
        fps: +(1000 / mean).toFixed(1),
        p5: +(1000 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1),
        worst: +(1000 / sorted[sorted.length - 1]).toFixed(1),
        drawCalls: info.drawCalls ?? null, triangles: info.triangles ?? null,
        pixelRatio: r?.getPixelRatio?.() ?? null,
      };
    })()`);
  }
  rows.push(row);
  process.stdout.write(`${file}  scene=${row.scene} rite=${row.rite} ${row.perf ? `fps=${row.perf.fps} p95=${row.perf.p5} draws=${row.perf.drawCalls} tris=${row.perf.triangles}` : ''} (${bytes}b)\n`);
}

fs.writeFileSync(`${OUT}/${tag}-index.json`, JSON.stringify({ rig, rows }, null, 2));
console.log(`\n${rows.length} plates → ${OUT}/${tag}-*.png`);
ws.close();
process.exit(0);
