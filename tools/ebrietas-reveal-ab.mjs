// BEAUTY LANE · the integration point, photographed.
//
// fx-rites owns the veil-reveal choreography; this sculpt owns the body it
// reveals, and the whole contract between them is ONE call: setReveal(0..1).
// This takes the same framing twice, at t=0 and t=1, so the handoff is a pair
// of plates rather than a promise — and it also prints the world-space anchors
// the film is allowed to aim at.
//
//   CDP_PORT=9241 GAIA_CLIENT_PORT=5191 node tools/ebrietas-reveal-ab.mjs \
//     --dist=110 --yaw=1.57 --tag=s8-reveal
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const dist = Number(flag('dist', 110));
const yaw = Number(flag('yaw', 1.57));
const pitch = Number(flag('pitch', 0.06));
const tag = flag('tag', 'reveal');
const OUT = flag('out', 'proof/beauty/sculpt');
fs.mkdirSync(OUT, { recursive: true });

const { send } = await connectCdp();
const ev = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'eval failed');
  return m.result?.result?.value;
};
const shot = async (file) => {
  const m = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
  return fs.statSync(file).size;
};

// the art-review camera, driven exactly like beauty-look.mjs: cinematic(true)
// (chrome off — take one photographed the whole COMMUNION panel), then BOTH
// target and goal, BOTH distance and goalDistance, and autoFrame off, or the
// rig lerps back to whatever it wanted before the plate lands.
await ev(`(async () => {
  for (let i = 0; i < 240; i += 1) { if (window.gaia?.atlasCosmos?.ready) break; await new Promise((r) => setTimeout(r, 250)); }
  const c = window.gaia.atlasCosmos, s = window.gaia.atlasStrategy;
  c.cinematic(true);
  const p = c.figures.find((f) => f.kind === 'ebrietas').group.position.toArray();
  s.target.set(p[0], p[1], p[2]); s.goal.set(p[0], p[1], p[2]);
  s.distance = ${dist}; s.goalDistance = ${dist};
  s.yaw = ${yaw}; s.pitch = ${pitch}; s.autoFrame = false;
  return 1;
})()`);
await new Promise((r) => setTimeout(r, 2800)); // the rig's settle

const log = [];
for (const t of [0, 1]) {
  await ev(`(() => {
    const eb = window.gaia.atlasCosmos.figures.find(f => f.kind === 'ebrietas');
    eb.setReveal(${t}); return eb.getReveal();
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const file = `${OUT}/${tag}-t${t}.png`;
  log.push({ reveal: t, dist, yaw, file, bytes: await shot(file) });
  console.log(`reveal ${t} → ${file}`);
}
// back to the state the atlas boots in: veils closed, her lamp full
await ev(`window.gaia.atlasCosmos.figures.find(f => f.kind === 'ebrietas').setReveal(1)`);

const anchors = await ev(`(() => {
  const a = window.gaia.atlasCosmos.figures.find(f => f.kind === 'ebrietas').anchors();
  const r = (v) => v.toArray().map((x) => +x.toFixed(1));
  return { crown: r(a.crown), brow: r(a.brow), hem: r(a.hem), head: r(a.head), reach: r(a.reach), eyes: a.eyes.map(r) };
})()`);
console.log('anchors (world):', JSON.stringify(anchors));
fs.appendFileSync(`${OUT}/${tag}-log.jsonl`, `${log.map((l) => JSON.stringify(l)).join('\n')}\n${JSON.stringify({ anchors })}\n`);
process.exit(0);
