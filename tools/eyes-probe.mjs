import { connect, boot } from './eyes-cdp.mjs';
const c = await connect();
const r = await c.ev(`
  const D = window.__D ?? (await import('/plugins/atlas-director.js')).default.director;
  window.__D = D; D.prepare();
  await D.seek(187.9);
  await new Promise(r=>setTimeout(r,600));
  const f = window.gaia.eyes.field();
  const cos = cosmosOf();
  const cam = cos.camera;
  const H = window.innerHeight, fov = cam.fov * Math.PI/180;
  const rows = [];
  for (const [k,e] of f.eyes) {
    const d = e.pos.distanceTo(cam.position);
    const px = (2*e.radius / (2*Math.tan(fov/2)*d)) * H;
    // is it on screen? project
    const p = e.pos.clone().project(cam);
    rows.push({ k, r: +e.radius.toFixed(2), d: Math.round(d), px: +px.toFixed(1),
      onScreen: Math.abs(p.x)<1 && Math.abs(p.y)<1 && p.z<1, open: +(e.open??0).toFixed(2), openFrom: e.openFrom });
  }
  const w = rows.filter(x=>x.k.startsWith('watch'));
  return { t: D.t, total: rows.length, watchers: w.length,
    onScreen: w.filter(x=>x.onScreen).length,
    sample: w.slice(0,6), pxRange: [Math.min(...w.map(x=>x.px)).toFixed(1), Math.max(...w.map(x=>x.px)).toFixed(1)],
    ruleRadius: (() => { const ids=window.__D.ruleIds(); return ids.slice(0,4).map(id=>{ const i=cos.idIndex.get(id); return +(cos.forge?.radiusOf(i) ?? -1).toFixed(1); }); })(),
    forgeEyes: rows.filter(x=>x.k.startsWith('forge')).slice(0,4),
  };
`);
console.log(JSON.stringify(r, null, 1));
c.close();
