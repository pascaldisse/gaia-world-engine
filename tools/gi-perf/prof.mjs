// CPU sampling profile of the live page. usage: bun prof.mjs <cdpPort> <urlFile> <extraQuery> <renderHeight> <ms> [cdp.mjs]  -> top self-time functions
import { readFileSync } from 'node:fs';
const [port, urlFile, q = '', h = '720', ms = '5000', cdpPath = './tools/ds-world/gi-smoke/cdp.mjs'] = process.argv.slice(2);
const { connect } = await import(new URL(cdpPath, 'file://' + process.cwd() + '/').href); const c = await connect(port);
await c.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 982, deviceScaleFactor: 2, mobile: false });
await c.send('Page.navigate', { url: 'about:blank' }); await c.sleep(400); await c.send('Page.navigate', { url: readFileSync(urlFile, 'utf8').trim() + q + `&renderHeight=${h}` });
let st; for (let i = 0; i < 300; i++) { st = await c.evalJs('window.gaia?.dsWorld?.status||null').catch(() => null); if (st === 'ready') break; await c.sleep(500); }
for (let i = 0; i < 160; i++) { await c.sleep(500); const g = await c.evalJs('window.gaia.dsWorld.gi').catch(() => null); if (q.includes('dsGi=off') ? i > 6 : g?.last?.bricksPending === 0 && i > 6) break; }
await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 500 }); await c.send('Profiler.start'); await c.sleep(+ms);
const { profile } = await c.send('Profiler.stop'); const dt = profile.timeDeltas; const self = new Map(); const byId = new Map(profile.nodes.map(n => [n.id, n]));
profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i]); });
const tot = [...self.values()].reduce((a, b) => a + b, 0); console.log('total ms', (tot / 1000).toFixed(0));
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((v / 1000).toFixed(0).padStart(6), (100 * v / tot).toFixed(1).padStart(5) + '%', k);
c.ws.close();
