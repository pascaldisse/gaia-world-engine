// THE RECORD LAYER'S WITNESS — four framings, one command.
//
// forge-proof.mjs photographs ONE body. This photographs the LANGUAGE: the
// far tier and the forged tier in the same session, at the four distances
// where a costume change would show. A shot is only evidence if rAF was
// turning when it was taken, so every framing samples frames before it
// captures and the run exits nonzero if any of them stalled.
//
//   node tools/cosmos-shots.mjs <outDir> [wide|cluster|close|altar|all]
//
// env: CDP_PORT (9223 here), GAIA_CLIENT_PORT (5176 here)
import { writeFileSync, mkdirSync } from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

// ?intro=off — the intro is a FILM over a black screen, and every shot taken
// through it photographs a subtitle. The pass is about the normal session.
const [, , outDir = 'proof/cosmos', only = 'all'] = process.argv;
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ws, send } = await connectCdp();
await send('Runtime.enable');
await send('Log.enable');
const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/\[cosmos\]|\[forge\]|\[director\]|WebGPU|adapter|Error/i.test(text)) logs.push(`${m.params.type}: ${text}`.slice(0, 300));
  }
  if (m.method === 'Log.entryAdded') {
    const text = m.params.entry.text ?? '';
    if (/cosmos|forge|WebGPU|adapter/i.test(text)) logs.push(`log: ${text}`.slice(0, 300));
  }
});
await send('Page.bringToFront');

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`${expression.slice(0, 60)} → ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
};
const evJson = async (expression) => JSON.parse(await ev(`JSON.stringify(${expression})`) ?? 'null');

// a frame is only a frame if rAF is turning — sample it, never assume it
const FPS = `new Promise((res) => {
  const dts = []; let last = performance.now(); let n = 0; let done = false;
  const finish = (why) => { if (done) return; done = true;
    const s = dts.slice(4).sort((a, b) => a - b);
    if (!s.length) return res(JSON.stringify({ fps: 0, stalled: true }));
    res(JSON.stringify({ fps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1), frames: s.length, why })); };
  const tick = (t) => { dts.push(t - last); last = t; if (++n < 45) requestAnimationFrame(tick); else finish('full'); };
  requestAnimationFrame(tick); setTimeout(() => finish('timeout'), 4000);
})`;

const DIAG = `(() => {
  const c = window.gaia?.atlasCosmos, f = window.gaia?.atlasForge, s = window.gaia?.atlasStrategy;
  const kinds = {}; let coverSum = 0;
  if (f) { for (const [i] of f.active) { const k = c.nodes[i].kind; kinds[k] = (kinds[k] ?? 0) + 1; }
    for (let i = 0; i < f.cover.length; i += 1) coverSum += f.cover[i]; }
  const pinnedForged = f && c ? [...c.flockRing.keys()].filter((i) => f.active.has(i)).length : 0;
  const pinnedWant = f && c ? [...c.flockRing.keys()].filter((i) => f.want.has(i)).length : 0;
  return {
    cosmos: c ? { ready: c.ready, enabled: c.enabled, starsActive: c.starsActive(), rite: c.rite, nodes: c.nodes.length, veiled: c.veiledCount ?? 0, forsaken: c.forsaken.length } : null,
    forge: f ? {
      enabled: f.enabled, visible: f.group.visible, active: f.active.size, kinds,
      coverSum: +coverSum.toFixed(1), pinnedForged, pinnedWant, pending: f.pending.length,
      stats: f.stats?.() ?? null,
    } : null,
    cam: s ? { dist: +s.camera.position.length().toFixed(0), goalDist: +(s.goalDistance ?? 0).toFixed(0) } : null,
  };
})()`;

// ── the four framings ──────────────────────────────────────────────────────
// Each returns a note about WHAT it framed, so a shot can never be mistaken
// for a different shot later.
const SHOTS = {
  // the universe as the LOD actually leaves it: coexistence, or the lack of it
  wide: {
    settle: 2600,
    frame: `(() => { const s = window.gaia.atlasStrategy; window.gaia.atlasForge?.release_hold?.(); s.deselect?.(); s.autoFrame = true; s.flight = null; return { framing: 'universe' }; })()`,
  },
  // mid range: the largest covenant's centroid, framed so the cluster fills
  // the frame — the distance at which motes are the whole picture
  cluster: {
    settle: 2600,
    frame: `(() => {
      const c = window.gaia.atlasCosmos, s = window.gaia.atlasStrategy;
      const counts = new Map();
      for (const [id, com] of c.communities) counts.set(com, (counts.get(com) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const idx = [];
      for (let i = 0; i < c.nodes.length; i += 1) if (c.communities.get(c.nodes[i].id) === top) idx.push(i);
      const V = c.camera.position.constructor;
      const centre = new V(); const p = new V();
      for (const i of idx) { c.forge.worldPos(i, p); centre.add(p); }
      centre.multiplyScalar(1 / Math.max(1, idx.length));
      let r = 0; for (const i of idx) { c.forge.worldPos(i, p); r = Math.max(r, p.distanceTo(centre)); }
      s.deselect?.(); s.autoFrame = false;
      s.frameOn(centre, Math.max(60, r * 0.55), 900);
      return { framing: 'covenant', community: top, members: idx.length, radius: +r.toFixed(0) };
    })()`,
  },
  // the close pass: a forged body AND its neighbourhood's motes in one frame.
  // radii 7 is the distance where a costume change between the tiers is
  // impossible to hide.
  close: {
    settle: 3000,
    frame: `(() => {
      const c = window.gaia.atlasCosmos, f = window.gaia.atlasForge;
      let best = -1, bd = -1;
      for (let i = 0; i < c.nodes.length; i += 1) {
        if (c.nodes[i].kind !== 'customer' || c.veiled[i]) continue;
        if (f.degArr[i] > bd) { bd = f.degArr[i]; best = i; }
      }
      const id = c.ids[best];
      const info = f.focus(id, { radii: 7, ms: 1100, face: 95 });
      return { framing: 'close', id, kind: c.nodes[best].kind, degree: bd, focus: info };
    })()`,
  },
  // the Altar: Ebrietas and her forsaken. The orphan ring is r=95..233 around
  // her, so her own framing radius (300) is exactly the shot that has both.
  // autoFrame is a STANDING ORDER, not a one-off: left on by an earlier wide
  // shot it re-fits the universe every frame and quietly drags the camera back
  // off the altar, so a shot taken 3s later photographs the right subject from
  // the wrong place and every LOD number in it is a lie. It dies here by name.
  altar: {
    settle: 3400,
    frame: `(() => {
      const c = window.gaia.atlasCosmos, s = window.gaia.atlasStrategy;
      s.autoFrame = false;
      c.openFigure('ebrietas');
      return { framing: 'altar', orphans: c.forsaken.length, ring: c.flockRing.size };
    })()`,
    // the shot is only the Altar if the camera is actually AT the Altar
    assert: `(() => {
      const c = window.gaia.atlasCosmos, f = window.gaia.atlasForge;
      const V = c.camera.position.constructor; const p = new V();
      let dmin = Infinity, dmax = 0;
      for (const i of c.flockRing.keys()) { f.worldPos(i, p); const d = c.camera.position.distanceTo(p); dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); }
      return { camToEbrietas: +c.camera.position.distanceTo(new V(0, -1250, 0)).toFixed(0), orphanD: [+dmin.toFixed(0), +dmax.toFixed(0)], autoFrame: c.strategy.autoFrame };
    })()`,
  },
  // THE FAR TIER AS A WHOLE FIELD. In The Dream the instanced layer stands
  // down (the baked world owns the records) and only the pinned flock is
  // drawn — so a rite is the only framing where all 3061 motes are on screen
  // at once, which is where a default-styled mote layer is most visible.
  covenants: {
    settle: 3400,
    frame: `(() => {
      const c = window.gaia.atlasCosmos, s = window.gaia.atlasStrategy;
      c.setRite('covenants', { silent: true });
      s.deselect?.(); s.autoFrame = true; s.flight = null;
      return { framing: 'covenants', starsActive: c.starsActive() };
    })()`,
  },
};

const names = only === 'all' ? Object.keys(SHOTS) : only.split(',');
const report = { at: new Date().toISOString(), outDir, shots: {} };
let stalled = false;

for (const name of names) {
  const shot = SHOTS[name];
  if (!shot) { console.error(`unknown shot ${name}`); process.exit(2); }
  const framed = await evJson(shot.frame);
  await sleep(shot.settle);
  // macOS flips an occluded window to hidden and throttles rAF — re-assert
  await send('Page.bringToFront');
  await sleep(300);
  const fps = JSON.parse(await ev(FPS));
  const diag = await evJson(DIAG);
  if (shot.assert) framed.assert = await evJson(shot.assert);
  const png = `${outDir}/${name}.png`;
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(png, Buffer.from(cap.result.data, 'base64'));
  report.shots[name] = { png, framed, fps, diag };
  if (!fps.fps) stalled = true;
  console.log(`${name} → ${png}  fps=${fps.fps} forged=${diag.forge?.active} pinnedForged=${diag.forge?.pinnedForged} rite=${diag.cosmos?.rite} starsActive=${diag.cosmos?.starsActive}`);
}

report.console = logs;
writeFileSync(`${outDir}/report.json`, `${JSON.stringify(report, null, 1)}\n`);
console.log(`report → ${outDir}/report.json${stalled ? ' (STALLED)' : ''}`);
ws.close();
process.exit(stalled ? 1 : 0);
