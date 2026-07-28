// A pagerank eye ON A BODY: the forge's attachment point, photographed. The
// forge has its own close-up facility (it aims the lens off the planet->star
// axis so the terminator runs down the body), so this uses it rather than
// inventing a framing.
import { connect, boot } from './eyes-cdp.mjs';
const c = await connect();
if (!(await c.ev('return !!cosmosOf();'))) await boot(c);
const r = await c.ev(`
  const cos = cosmosOf(); const forge = cos.forge;
  // the record with the highest pagerank that HAS an eye — the Great One the
  // grammar itself picked, not one chosen by hand
  // NOT a sun: a store/tenant/consultant close-up is filmed from inside its own
  // corona (the forge's own warning), which photographs as a white wall with a
  // speck in it — proof/eyes/14 is exactly that plate.
  const SUN = new Set(['store', 'tenant', 'consultant']);
  let best = -1, bi = -1;
  for (let i = 0; i < cos.nodes.length; i += 1) {
    if (!forge.hasEye(i) || SUN.has(cos.nodes[i].kind)) continue;
    if (forge.prArr[i] > best) { best = forge.prArr[i]; bi = i; }
  }
  const id = cos.ids[bi];
  window.gaia.eyes.field().hero(false);
  const out = { id, kind: cos.nodes[bi].kind, pr: +best.toExponential(3), radius: +forge.radiusOf(bi).toFixed(2) };
  // the forge's OWN close-up: it aims the view axis off the body->star axis so
  // the terminator runs down the body (see forge.focus / aim)
  out.focus = forge.focus(id, { radii: 3.0, face: 55 });
  return out;
`);
console.log(r, Object.keys(r));
await new Promise((res) => setTimeout(res, 4000));
console.log(await c.shot('proof/eyes/15-forge-pagerank-eye.png'));
console.log(await c.ev(`
  const f = window.gaia.eyes.field();
  const e = [...f.eyes.entries()].filter(([k]) => k.startsWith('forge:')).map(([k, x]) => [k, +x.radius.toFixed(2), +(x.open ?? 0).toFixed(2)]);
  return { forgeEyes: e.slice(0, 6), count: f.count };
`));
c.close();
