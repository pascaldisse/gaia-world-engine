import { connect, boot } from './eyes-cdp.mjs';
const c = await connect();
if (!(await c.ev("return !!cosmosOf();"))) await boot(c);   // never re-navigate a page that is already up
await c.ev(`const f = window.gaia.eyes.field(); f.hero(true, { dist: ${process.argv[2] ?? 6.0}, radius: 1.0, open: ${process.argv[3] ?? 0.95} }); return 1;`);
await new Promise((r) => setTimeout(r, 1200));
console.log(await c.shot(process.argv[4] ?? 'proof/eyes/03-hero.png'));
console.log(await c.ev('return window.gaia.eyes.stats();'));
if (c.logs.length) console.log(c.logs.filter((l) => /eye|EXCEPT|error|warn/i.test(l)).slice(-10).join('\n'));
c.close();
