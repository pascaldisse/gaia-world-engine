// GI perf bench (lane solas/gi-perf). usage: bun bench.mjs <cdpPort> <urlFile> <spec.json> <outDir> [cdp.mjs path]
// spec = {reps, ms, dpr:2, vw:1512, vh:982, loads:{name:{q:'&query', res:[heights], walk:[heights]}}}
// Order: rep > load (interleaved A/B in ONE run). Per load: nav -> ready -> GI warm (bricksPending 0) -> for each render height: stand sample (+walk sample).
// Per sample: wall fps (rAF), GPU render ms + GPU compute ms per frame (trackTimestamp, resolved every 250 ms, divided by frames), CPU: GI update ms, voxel win.update ms, renderer.compute encode ms,
// whole-frame main-thread TaskDuration/ScriptDuration per frame (CDP Performance), loadavg. Needs ?gpuTs=1 in the URL file + brave --enable-unsafe-webgpu --enable-webgpu-developer-features.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'; import { execSync } from 'node:child_process';
const [port, urlFile, specFile, outDir, cdpPath = './tools/ds-world/gi-smoke/cdp.mjs'] = process.argv.slice(2);
const { connect } = await import(cdpPath.startsWith('.') || cdpPath.startsWith('/') ? new URL(cdpPath, 'file://' + process.cwd() + '/').href : cdpPath);
const base = readFileSync(urlFile, 'utf8').trim(); const spec = JSON.parse(readFileSync(specFile, 'utf8')); mkdirSync(outDir, { recursive: true });
const c = await connect(port); await c.send('Performance.enable');
const INSTALL = `(()=>{ if(window.__pb) return 'already'; const g=gaia.environment.gi, o=g._open, r=gaia.environment.renderer, B=window.__pb={giMs:0,giN:0,winMs:0,compMs:0,compN:0,rGpu:0,cGpu:0,gN:0,frames:0,frameDt:[]};
 const wrap=(obj,k,f)=>{const orig=obj[k].bind(obj);obj[k]=(...a)=>{const t=performance.now();const v=orig(...a);f(performance.now()-t);return v}};
 if(o){wrap(o,'update',d=>{B.giMs+=d;B.giN++});wrap(o.win,'update',d=>{B.winMs+=d});}
 wrap(r,'compute',d=>{B.compMs+=d;B.compN++}); return 'ok'})()`;
const RUN = (ms, walk) => `(async()=>{const B=window.__pb;for(const k of Object.keys(B))B[k]=Array.isArray(B[k])?[]:0; const p=gaia.player; const f0=gaia.dsWorld.feet.slice(); if(${walk}){p.keys.add('KeyW');p.keys.add('ShiftLeft');p.locked=true}
 const r=gaia.environment.renderer; await r.resolveTimestampsAsync('render'); await r.resolveTimestampsAsync('compute'); let last=performance.now(),lf=0; const t0=last; let frames=0; let stop=false;
 const raf=()=>{frames++;B.frameDt.push(performance.now()-last);last=performance.now(); if(!stop)requestAnimationFrame(raf)}; requestAnimationFrame(raf);
 let lastFrames=0; while(performance.now()-t0<${ms}){await new Promise(x=>setTimeout(x,250)); const n=frames-lastFrames; lastFrames=frames; const a=await r.resolveTimestampsAsync('render'), b=await r.resolveTimestampsAsync('compute'); if(n>0){B.rGpu+=a;B.cGpu+=b;B.gN+=n}}
 stop=true; p.keys.delete('KeyW');p.keys.delete('ShiftLeft'); const dt=(performance.now()-t0)/1000; const f1=gaia.dsWorld.feet.slice();
 const s=B.frameDt.slice().sort((x,y)=>x-y); return {fps:+(frames/dt).toFixed(2), p50:+s[s.length>>1]?.toFixed(1), p95:+s[Math.floor(s.length*0.95)]?.toFixed(1), frames, gpuRenderMs:+(B.rGpu/B.gN).toFixed(3), gpuComputeMs:+(B.cGpu/B.gN).toFixed(3), giUpdateMs:+(B.giMs/Math.max(1,B.giN)).toFixed(3), voxWinMs:+(B.winMs/Math.max(1,B.giN)).toFixed(3), computeEncodeMsPerFrame:+(B.compMs/frames).toFixed(3), moved:+Math.hypot(f1[0]-f0[0],f1[2]-f0[2]).toFixed(2), bricksPending:gaia.dsWorld.gi?.last?.bricksPending??null, canvas:[r.domElement.width,r.domElement.height]}})()`;
const metrics = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
for (let rep = 1; rep <= spec.reps; rep++) for (const [name, L] of Object.entries(spec.loads)) {
  c.log.length = 0; const t0 = Date.now();
  await c.send('Emulation.setDeviceMetricsOverride', { width: spec.vw ?? 1512, height: spec.vh ?? 982, deviceScaleFactor: spec.dpr ?? 2, mobile: false });
  await c.send('Page.navigate', { url: 'about:blank' }); await c.sleep(400);
  await c.send('Page.navigate', { url: base + (L.q ?? '') + `&renderHeight=${L.res[0]}` });
  let st; while (Date.now() - t0 < 150000) { st = await c.evalJs('(location.search.includes("dsWorld") && window.gaia?.dsWorld?.status) || null').catch(() => null); if (st === 'ready' || st === 'error') break; await c.sleep(500); }
  const giOn = !(L.q ?? '').includes('dsGi=off');
  for (let i = 0; i < 160; i++) { await c.sleep(500); const g = await c.evalJs('window.gaia.dsWorld.gi').catch(() => null); const pend = g?.last?.bricksPending ?? null; if (!giOn ? i >= 6 : (pend === 0 && i >= 6)) break; }
  if (L.q?.includes('dsGi=off') === false) await c.evalJs(INSTALL); else await c.evalJs(`(()=>{const r=gaia.environment.renderer;window.__pb={giMs:0,giN:0,winMs:0,compMs:0,compN:0,rGpu:0,cGpu:0,gN:0,frames:0,frameDt:[]};const o=r.compute.bind(r);r.compute=(...a)=>{const t=performance.now();const v=o(...a);__pb.compMs+=performance.now()-t;return v};return 'ok'})()`);
  for (const h of L.res) for (const walk of (L.walk?.includes(h) ? [false, true] : [false])) {
    await c.evalJs(`gaia.pixels.setTargetHeight(${h})`); await c.sleep(1500);
    const m0 = await metrics(); const res = await c.evalJs(RUN(spec.ms ?? 6000, walk)); const m1 = await metrics(); const load = +execSync('uptime').toString().match(/load averages?: ([\d.]+)/)?.[1];
    const row = { rep, load: name, h, walk, ...res, taskMsPerFrame: +((m1.TaskDuration - m0.TaskDuration) * 1000 / res.frames).toFixed(2), scriptMsPerFrame: +((m1.ScriptDuration - m0.ScriptDuration) * 1000 / res.frames).toFixed(2), loadavg: load, st, err: c.log.filter(l => !/ERR_CONNECTION_REFUSED|ladder7010/.test(l)).slice(0, 2) };
    appendFileSync(`${outDir}/rows.jsonl`, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
  }
}
c.ws.close();
