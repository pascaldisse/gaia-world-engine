// THE WATCHERS (180.12–205.48): the Great Ones' eyes OPEN on the word.
// A strip of seek plates across the four beats plus the thesis word, taken in
// ONE run at one resolution — and fps measured at the peak of the same run,
// because a frame rate from a different run is a different film.
import { connect, boot, fps, draws } from './eyes-cdp.mjs';

const c = await connect();
if (!(await c.ev('return !!cosmosOf();'))) await boot(c);
await c.ev(`window.gaia.eyes.field().hero(false); return 1;`);

// the director drives the film; audio:false, so the clock is virtual and the
// browser never makes a sound (it is also launched --mute-audio)
const prep = await c.ev(`
  const m = await import('/plugins/atlas-director.js');
  const D = m.default.director ?? m.default;
  window.__D = D;
  D.prepare();
  if (D.audio?.el) D.audio.el.muted = true;
  return { keys: D.keys?.length ?? 0, rules: D.ruleIds?.().length ?? 0, muted: D.audio?.el ? D.audio.el.muted : 'no-el' };
`);
console.log('prepared', prep);

const times = (process.argv[2] ?? '180.5,181.6,182.2,184.5,187.9,190.2,191.9,193.5,200.0').split(',').map(Number);
const out = [];
for (const t of times) {
  await c.ev(`await window.__D.seek(${t}); return 1;`);
  await new Promise((r) => setTimeout(r, 900));
  const s = await c.ev('return { eyes: window.gaia.eyes.stats(), t: window.__D.t };');
  const p = await c.shot(`proof/eyes/w-${String(t).replace('.', '_')}.png`);
  out.push({ t, eyes: s.eyes.eyes, peak: s.eyes.peak, draws: s.eyes.draws, file: p.file });
  console.log(out[out.length - 1]);
}
// fps at the watchers peak, in the same run
await c.ev(`await window.__D.seek(191.9); return 1;`);
await new Promise((r) => setTimeout(r, 500));
console.log('fps at 191.9 (watchers peak):', await fps(c, 4), await draws(c));
console.log(await c.ev('return window.gaia.eyes.stats();'));
if (c.logs.length) console.log(c.logs.filter((l) => /eye|EXCEPT|error/i.test(l)).slice(-8).join('\n'));
c.close();
