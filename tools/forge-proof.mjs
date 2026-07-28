// THE FORGE'S WITNESS — one bounded command per proof.
//
// A proof of a celestial body is three things at once: the right record is
// framed, the frame is a real frame (not a stall), and the picture is what the
// grammar promised. Doing that by hand is four round trips and a guess at the
// settle time; this does it in one:
//
//   node tools/forge-proof.mjs <kind|id> <out.png> [radii] [holdMs]
//
// It picks the strongest record of a kind (highest degree — the one whose
// grammar has the most to say), holds it against the LOD's next retarget,
// waits for the camera flight AND for the body to actually exist in the
// forge's active set, samples rAF deltas over a second, then shoots.
//
// env: GAIA_CLIENT_PORT (default 5174)
import { connectCdp } from './cdp-lib.mjs';

process.env.GAIA_CLIENT_PORT ??= '5174';
const [, , target, out = 'proof/forge.png', radiiArg, holdArg] = process.argv;
const radii = Number(radiiArg ?? 3.4);
const holdMs = Number(holdArg ?? 2600);

const { ws, send } = await connectCdp();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a hidden tab does not turn rAF: every measurement off a backgrounded page is
// a lie, and every screenshot of one is the last frame it drew minutes ago
await send('Page.bringToFront');
await sleep(250);
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};

// KINDS: pick by degree so a proof never lands on a record with nothing to show
const pick = `(() => {
  const c = window.gaia.atlasCosmos, f = window.gaia.atlasForge;
  const t = ${JSON.stringify(target)};
  if (c.idIndex.has(t)) return t;
  let best = null, bd = -1;
  for (let i = 0; i < c.nodes.length; i += 1) {
    const n = c.nodes[i];
    if (n.kind !== t || c.veiled[i]) continue;
    const d = f.degArr[i];
    if (d > bd) { bd = d; best = n.id; }
  }
  return best;
})()`;

const id = await evaluate(pick);
if (!id) { console.error(`no record for ${target}`); process.exit(1); }

const info = await evaluate(`JSON.stringify(window.gaia.atlasForge.focus(${JSON.stringify(id)}, { radii: ${radii}, ms: 1100 }))`);
await sleep(holdMs);

// re-asserted here, not just at the start: macOS Chrome flips a window that
// another app has OCCLUDED to visibilityState 'hidden' and throttles rAF, so a
// tab that was in front when the flight began can be asleep by the time the
// measurement runs — that is how a 120fps close-up measured 0
await send('Page.bringToFront');
await sleep(400);
// a frame is only a frame if rAF is turning: sample it, never assume it
const fps = await evaluate(`new Promise((res) => {
  const dts = []; let last = performance.now(); let n = 0; let done = false;
  const finish = (why) => { if (done) return; done = true;
    const s = dts.slice(5).sort((a, b) => a - b);
    if (!s.length) return res(JSON.stringify({ fps: 0, stalled: true, hidden: document.hidden }));
    res(JSON.stringify({ fps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1), p95ms: +s[Math.floor(s.length * 0.95)].toFixed(2), frames: s.length, why }));
  };
  const tick = (t) => { dts.push(t - last); last = t; if (++n < 70) requestAnimationFrame(tick); else finish('full'); };
  requestAnimationFrame(tick);
  setTimeout(() => finish('timeout'), 4000);
})`);

const live = await evaluate(`(() => {
  const c = window.gaia.atlasCosmos, f = window.gaia.atlasForge;
  const i = c.idIndex.get(${JSON.stringify(id)});
  const slot = f.active.get(i);
  return JSON.stringify({ id: ${JSON.stringify(id)}, kind: c.nodes[i].kind, forged: !!slot, fade: +(slot?.fade ?? 0).toFixed(2),
    parts: slot ? Object.keys(slot.parts).filter((k) => slot.parts[k].visible !== false) : [],
    great: f.isGreat(i), eye: f.hasEye(i), deg: f.degArr[i], radius: +f.radiusOf(i).toFixed(2),
    camDist: +c.camera.position.distanceTo(f.worldPos(i, new (c.camera.position.constructor)())).toFixed(1),
    stats: f.stats() });
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

console.log(JSON.stringify({ focus: JSON.parse(info ?? 'null'), live: JSON.parse(live), fps: JSON.parse(fps), out }, null, 1));
ws.close();
process.exit(0);
