// THE OPEN, ON THE WORD. A fine sweep across ONE beat with the camera barely
// moving, so what changes between plates is the LID and nothing else. This is
// the shot the whole lane is for, so it is measured, not asserted.
import { connect, boot } from './eyes-cdp.mjs';
const c = await connect();
if (!(await c.ev('return !!cosmosOf();'))) await boot(c);
await c.ev(`
  const m = await import('/plugins/atlas-director.js');
  const D = m.default.director ?? m.default; window.__D = D; D.prepare();
  if (D.audio?.el) D.audio.el.muted = true;
  window.gaia.eyes.field().hero(false);
  return 1;`);
const times = (process.argv[2] ?? '181.20,181.34,181.50,181.70,182.00,182.60').split(',').map(Number);
for (const t of times) {
  await c.ev(`await window.__D.seek(${t}); return 1;`);
  await new Promise((r) => setTimeout(r, 800));
  const s = await c.ev(`
    const f = window.gaia.eyes.field();
    const w = [...f.eyes.entries()].filter(([k]) => k.startsWith('watch:0:'));
    const o = w.map(([, e]) => +f.openOf(f.filmT, e).open.toFixed(2));
    return { n: w.length, open: o, iris: w.map(([, e]) => +f.openOf(f.filmT, e).iris.toFixed(2)), t: f.filmT };
  `);
  const p = await c.shot(`proof/eyes/open-${String(t).replace('.', '_')}.png`);
  console.log(t, 'open:', JSON.stringify(s.open), p.file);
}
c.close();
