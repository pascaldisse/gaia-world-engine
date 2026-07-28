// The OPEN, as a strip: one run, one framing, N apertures. The lid is the whole
// point of the watchers scene, so it is judged as a sweep and not from one shot.
import { connect, boot } from './eyes-cdp.mjs';
const c = await connect();
if (!(await c.ev('return !!cosmosOf();'))) await boot(c);
const opens = (process.argv[2] ?? '0.10,0.30,0.48,0.64,0.85').split(',').map(Number);
const dist = Number(process.argv[3] ?? 5.0);
for (const o of opens) {
  await c.ev(`window.gaia.eyes.field().hero(true, { dist: ${dist}, radius: 1.0, open: ${o} }); return 1;`);
  await new Promise((r) => setTimeout(r, 700));
  console.log(await c.shot(`proof/eyes/lid-${String(o).replace('.', '')}.png`));
}
console.log(await c.ev('return window.gaia.eyes.stats();'));
c.close();
