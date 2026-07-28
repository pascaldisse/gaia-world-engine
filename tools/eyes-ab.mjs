// An A/B of one named option: two plates, ONE run, one framing. Stitching two
// runs is how every wrong verdict in this repo happened.
//   node tools/eyes-ab.mjs cornea.visible proof/eyes/ab-cornea
import { connect, boot } from './eyes-cdp.mjs';
const [what, stem, dist = '5.2', open = '0.64'] = process.argv.slice(2);
const c = await connect();
if (!(await c.ev("return !!cosmosOf();"))) await boot(c);   // never re-navigate a page that is already up
await c.ev(`window.gaia.eyes.field().hero(true, { dist: ${dist}, radius: 1.0, open: ${open} }); return 1;`);
await new Promise((r) => setTimeout(r, 1000));
for (const on of [false, true]) {
  await c.ev(`const f = window.gaia.eyes.field();
    ${what === 'cornea.visible' ? `f.cornea.visible = ${on};` : `f.opts.${what} = ${on ? 'f.opts.' + what : 0}; f.rebuild();`}
    return 1;`);
  await new Promise((r) => setTimeout(r, 700));
  console.log(await c.shot(`${stem}-${on ? 'on' : 'off'}.png`));
}
if (c.logs.length) console.log(c.logs.filter((l) => /eye|EXCEPT/i.test(l)).slice(-6).join('\n'));
c.close();
