// tools/live-click-probe.mjs — reproduce Pascal's click on the LIVE app (:5174).
// Read-only usage of the live client; own fresh profile; headless+muted.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const CLIENT = process.env.CLIENT ?? 'http://localhost:5174';   // §IRON: live default, env-overridable
const OUT = 'proof/live-click';
mkdirSync(OUT, { recursive: true });
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait = ms => new Promise(r=>setTimeout(r,ms));
const b = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN, args:['--mute-audio','--headless=new'] });
const page = await (await b.newContext({ viewport:{width:1280,height:800} })).newPage();
const errs = []; page.on('console', m => m.type()==='error' && errs.push(m.text().slice(0,200)));
await page.goto(CLIENT, { waitUntil:'domcontentloaded', timeout:45000 }); await wait(4000);
await page.screenshot({ path:`${OUT}/01-open.png` });
// gate
const typed = await page.evaluate((pw)=>{ const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent); if(!i) return false; i.focus(); i.value=pw; i.dispatchEvent(new Event('input',{bubbles:true})); return true; }, PW);
if (typed) { await page.keyboard.press('Enter'); await wait(3500); }
await page.screenshot({ path:`${OUT}/02-after-gate.png` });
// find the Witness button (first visit or return) and click it
const clicked = await page.evaluate(()=>{ const els=[...document.querySelectorAll('button,div,span,a')].filter(e=>e.offsetParent&&/witness the beginning/i.test(e.textContent||'')); if(!els.length) return null; els[0].click(); return els[0].textContent.trim().slice(0,60); });
console.log('clicked:', clicked);
await wait(2500); await page.screenshot({ path:`${OUT}/03-plus2.5s.png` });
await wait(5000); await page.screenshot({ path:`${OUT}/04-plus7.5s.png` });
// what does the app think is happening?
const state = await page.evaluate(()=>{ const g=window.gaia||{}; const d=g.atlasDirector||g.director||null;
  const vis=[...document.querySelectorAll('body > *')].filter(e=>e.offsetParent&&e.tagName!=='CANVAS'&&e.tagName!=='SCRIPT').map(e=>({id:e.id||e.className&&String(e.className).slice(0,30),r:e.getBoundingClientRect().width}));
  let dt=null; try{ dt = d && (d.filmTime?.() ?? d.t ?? (d.status&&JSON.stringify(d.status()).slice(0,300))); }catch(e){ dt='err:'+e.message; }
  const a=[...document.querySelectorAll('audio')].map(x=>({t:x.currentTime,paused:x.paused}));
  return { directors:Object.keys(g).filter(k=>/direct|film|intro/i.test(k)), dt, audio:a, visibleLayers:vis.slice(0,12) };
});
console.log(JSON.stringify(state,null,1)); console.log('console errors:', errs.length, errs.slice(0,5));
await b.close();
