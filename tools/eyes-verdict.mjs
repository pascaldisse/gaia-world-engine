// THE LANE'S VERDICT, in ONE run: seek-reproducibility (law 2), the draw-call
// gate, perf at the watchers peak, and the live world's own eyes.
//
// ORDER MATTERS AND IS PART OF THE MEASUREMENT. Law 2 is checked FIRST, while
// the film clock is still fresh: the 5s fps run is longer than
// IRON.field.filmStaleMs, and a check taken after it is measuring the handover,
// not the film. The draw-call gate is measured while the film ROLLS, because a
// paused page does not necessarily submit a frame per rAF and a per-frame
// average over frames that were never drawn is not a number.
import { connect, boot, fps, draws } from './eyes-cdp.mjs';

const c = await connect();
if (!(await c.ev('return !!cosmosOf();'))) await boot(c);
const R = {};

await c.ev(`
  const m = await import('/plugins/atlas-director.js');
  const D = m.default.director ?? m.default; window.__D = D; D.prepare();
  if (D.audio?.el) D.audio.el.muted = true;   // belt and braces: also --mute-audio
  window.gaia.eyes.field().hero(false);
  return 1;`);

// the eye state this layer is responsible for — NOT pixels: the atlas camera
// lerps toward its goal (atlas-strategy.js target.lerp(goal, damp)), so two
// seeks to one t are photographed from slightly different places whatever this
// file does.
const STATE = `
  const f = window.gaia.eyes.field();
  const w = [...f.eyes.entries()].filter(([k]) => k.startsWith('watch:')).sort();
  return { filmT: f.filmT, eyes: w.length, rows: w.map(([k, e]) => {
    const o = f.openOf(f.filmT, e);
    return [k, +o.open.toFixed(5), +o.iris.toFixed(5), +e.radius.toFixed(3),
      e.pos.toArray().map((n) => +n.toFixed(3))];
  }) };`;

// ── 1 · LAW 2 — seek(t) must put the eyes where playback puts them at t
await c.ev('await window.__D.seek(191.8); return 1;');
await new Promise((r) => setTimeout(r, 900));
const s1 = await c.ev(STATE);
const a = await c.shot('proof/eyes/12-law2-a.png');
await c.ev('await window.__D.seek(120.0); return 1;');
await new Promise((r) => setTimeout(r, 700));
await c.ev('await window.__D.seek(191.8); return 1;');
await new Promise((r) => setTimeout(r, 900));
const s2 = await c.ev(STATE);
const b = await c.shot('proof/eyes/12-law2-b.png');
R.law2 = {
  eyes: s1.eyes,
  filmT: [s1.filmT, s2.filmT],
  identical: JSON.stringify(s1.rows) === JSON.stringify(s2.rows),
  firstDiff: (() => {
    for (let i = 0; i < Math.max(s1.rows.length, s2.rows.length); i += 1) {
      if (JSON.stringify(s1.rows[i]) !== JSON.stringify(s2.rows[i])) return { i, a: s1.rows[i], b: s2.rows[i] };
    }
    return null;
  })(),
  plates: ['proof/eyes/12-law2-a.png', 'proof/eyes/12-law2-b.png'],
};

// ── 2 · THE DRAW-CALL GATE.
// NOT read off renderer.info.render.calls: on this backend that counter sat at
// exactly 15/frame whether the eye group was visible or hidden and whether 0 or
// 43 eyes were drawn, so it cannot answer the question (a check that cannot
// fail is not a check). The gate is answered two ways instead:
//   STRUCTURALLY — walk the scene and count every draw-producing object the
//     layer contributes, and assert nothing anywhere owns a per-eye mesh
//     (the whole defect being fixed was one mesh per eye).
//   IN TIME — fps with the eyes drawn vs hidden, same run, same shot.
R.gate = await c.ev(`
  const f = window.gaia.eyes.field();
  await window.__D.play({ audio: false, from: 189.5, subtitles: false });
  await new Promise(res => setTimeout(res, 2500));
  const scene = window.gaia.view.scene;
  let mine = 0, perEye = 0, all = 0;
  scene.traverseVisible((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return;
    all += 1;
    if (o.name.startsWith('atlas-eyes')) mine += 1;
    if (o.geometry === f.globe.geometry && !o.name.startsWith('atlas-eyes')) perEye += 1;
  });
  const forge = cosmosOf().forge;
  let forgeEyeMeshes = 0;
  for (const pool of forge.slots.values()) for (const s of pool) if (s.parts?.eye) forgeEyeMeshes += 1;
  return { eyeDrawObjects: mine, strayEyeMeshes: perEye, forgeEyeMeshes,
    visibleDrawObjectsInScene: all, eyesDrawn: f.count, instancesPerDraw: f.globe.count,
    trisPerEye: f.stats().tris,
    sharesOneMatrixBuffer: f.cornea.instanceMatrix === f.globe.instanceMatrix,
    sharesOneAttrBuffer: f.cornea.geometry.getAttribute('aEye') === f.globe.geometry.getAttribute('aEye') };
`, { timeout: 180000 });

R.fpsEyesHidden = await c.ev(`window.gaia.eyes.field().group.visible = false; return 1;`).then(() => fps(c, 4));
R.fpsEyesDrawn = await c.ev(`window.gaia.eyes.field().group.visible = true; return 1;`).then(() => fps(c, 4));

// ── 3 · fps AT THE WATCHERS PEAK, in this same run and while rolling
R.fpsRollingWatchers = await fps(c, 5);
R.frame = await draws(c);
R.stats = await c.ev('return window.gaia.eyes.stats();');
const p = await c.shot('proof/eyes/13-rolling-watchers.png');
R.rollingPlate = p.file;

// ── 4 · the live world: the film leaves, the world's own eyes keep living
await c.ev('window.__D.stop?.({ restore: true }); return 1;');
await new Promise((r) => setTimeout(r, 6500));   // past filmStaleMs (5000)
R.live = await c.ev(`
  const f = window.gaia.eyes.field();
  const m0 = Array.from(f.globe.instanceMatrix.array.slice(0, 8));
  await new Promise(res => setTimeout(res, 600));
  const m1 = Array.from(f.globe.instanceMatrix.array.slice(0, 8));
  return { filmT: f.filmT, eyes: f.count,
    filmEyesLeft: [...f.eyes.values()].filter((e) => e.hold).length,
    saccading: m0.some((v, i) => Math.abs(v - m1[i]) > 1e-6) };
`);

console.log(JSON.stringify(R, null, 1));
const bad = c.logs.filter((l) => /\[eyes\]|EXCEPT|Uncaught/i.test(l));
console.log(bad.length ? `PAGE COMPLAINTS:\n${bad.slice(-8).join('\n')}` : 'page clean: no [eyes] warnings, no exceptions');
c.close();
