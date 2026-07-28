// FOLD FRAME-CHECK #3 · BATCH 1 — the film plates.
//
// Adapted from tools/film-b-plates.mjs (film lane B's proven flight-path
// plate pipeline): same seek-then-photograph mechanics, same two-settled-
// frames wait, same chrome-hiding list. PARAMETERS ONLY changed: an explicit
// list of timestamps (this lane's frame-check spec) instead of a fixed step,
// output dir, and every CDP/network await now goes through the timeout-
// wrapped helper (tools/fold-framecheck3-lib.mjs) per this lane's law.
//
//   CDP_PORT=9261 GAIA_CLIENT_PORT=5221 node tools/fold-framecheck3-plates.mjs
import fs from 'node:fs';
import { connectTimed } from './fold-framecheck3-lib.mjs';

const OUT = process.env.OUT ?? 'proof/fold-framecheck';
const CLIENT_PORT = process.env.GAIA_CLIENT_PORT ?? '5221';
const BASE = `http://localhost:${CLIENT_PORT}`;
const TIMES = (process.env.TIMES ?? '10,55,79.7,108.9,135.8,180.8,236.3,258,270,285')
  .split(',').map(Number);
fs.mkdirSync(OUT, { recursive: true });

const c = await connectTimed();
const rows = [];
try {
  // navigate to the plates entry point (?intro=off: no title/gate overlay,
  // &mute=1: audio element muted at the source) — atlas-director.js is still
  // imported unconditionally by atlas-intro.js's boot chain even with
  // intro=off (only boot() itself early-returns on the param), so it still
  // races main.js's late fresh `window.gaia = {...}` and gets wiped the same
  // way documented in fold-framecheck3-surfaces.mjs. Re-import it ourselves
  // (cache-busted, merge-style self-registration) once the kernel is up, and
  // expose window.D / window.__filmB the way the older film-b-plates.mjs
  // driver expected them (D = the raw Director instance; __filmB = the
  // module namespace, for its named export sampleCamera()).
  await c.send('Page.navigate', { url: `${BASE}/?intro=off&mute=1` }, 15000);
  await c.waitFor(`return !!(window.gaia?.atlasStrategy?.active);`, { timeoutMs: 60000 });
  await c.evaluate(`(async () => {
    const mod = await import('/plugins/atlas-director.js?fc=' + Date.now());
    window.gaia.director = mod.default;
    window.__filmB = mod;
    window.D = mod.default.director;
  })()`, { ms: 20000 });
  await c.waitFor(`return !!(window.D && window.__filmB && window.gaia?.atlasStrategy?.cosmos?.ready);`, { timeoutMs: 30000 });

  for (const t of TIMES) {
    const info = await c.evaluate(`(async () => {
      const D = window.D;
      D.opts = Object.assign({}, D.opts, { subtitles: true, mode: 'film' });
      if (D.audio?.el) D.audio.el.muted = true;
      const r = await D.seek(${t});
      for (const id of ['atlas-strategy-ui', 'atlas-cosmos-ui', 'overlay', 'hud', 'crosshair', 'panel', 'outliner', 'console', 'palette', 'debug']) {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      }
      const cam = window.__filmB.sampleCamera(D.keys, ${t});
      const s = D.s;
      return {
        t: ${t}, scene: r.scene, rite: D.cos.rite,
        tgt: cam.tgt.map((v) => Math.round(v)),
        dist: Math.round(cam.dist), yaw: +cam.yaw.toFixed(2), pitch: +cam.pitch.toFixed(3),
        eye: [Math.round(s.camera.position.x), Math.round(s.camera.position.y), Math.round(s.camera.position.z)],
        forged: D.cos.forge?.active.size ?? 0, reveal: +(D.stage?.frac ?? 0).toFixed(3),
        subtitleText: document.querySelector('.director-subtitle, .film-subtitle, [data-subtitle]')?.textContent ?? null,
      };
    })()`, { ms: 15000 });
    // two settled frames: the strategy camera lerps target/distance toward the
    // goal, and a plate caught mid-lerp is not the shot the film holds
    await new Promise((r) => setTimeout(r, 900));
    const file = `${OUT}/${String(Math.round(t * 10)).padStart(4, '0')}-${String(t).replace('.', '_')}s.png`;
    const bytes = await c.shot(file, 15000);
    rows.push({ ...info, file, bytes });
    process.stdout.write(`${file}  scene=${info.scene} rite=${info.rite} dist=${info.dist} tgt=[${info.tgt}] reveal=${info.reveal} (${bytes}b)\n`);
  }
  fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(rows, null, 2));
  console.log(`\n${rows.length} plates -> ${OUT}/*.png`);
} finally {
  c.close();
}
process.exit(0);
