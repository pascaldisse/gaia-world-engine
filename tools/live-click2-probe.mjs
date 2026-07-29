import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const CLIENT = process.env.CLIENT ?? 'http://localhost:5174';
const OUT='proof/live-click'; mkdirSync(OUT,{recursive:true});
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage();
const errs=[];page.on('console',m=>m.type()==='error'&&errs.push(m.text().slice(0,150)));
await page.goto(CLIENT,{waitUntil:'domcontentloaded',timeout:45000});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(3000);
await page.evaluate(()=>{const e=[...document.querySelectorAll('button,div,span,a')].filter(x=>x.offsetParent&&/witness the beginning/i.test(x.textContent||''));e[0]&&e[0].click();});
await wait(3000);
const probe=await page.evaluate(()=>{
  const under=document.elementFromPoint(640,477);
  const cb=[...document.querySelectorAll('*')].filter(x=>x.offsetParent&&/click to begin/i.test(x.textContent||'')&&x.children.length===0)[0];
  const r=cb&&cb.getBoundingClientRect();
  return { under: under&&(under.id||under.className&&String(under.className).slice(0,40)||under.tagName), cb: cb&&{x:r.x+r.width/2,y:r.y+r.height/2,id:cb.id||cb.parentElement.id} };
});
console.log('probe:',JSON.stringify(probe));
if (probe.cb) await page.mouse.click(probe.cb.x, probe.cb.y); else await page.mouse.click(640,477);
await wait(300); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
for (const [n,ms] of [['05b+3s',3000],['06b+8s',5000]]) {
  await wait(ms); await page.screenshot({path:`${OUT}/${n}.png`});
  const st=await page.evaluate(()=>{const d=window.gaia?.director;let s=null;try{s=d&&d.status&&d.status();}catch(e){}return s&&{t:+s.t.toFixed(2),playing:s.playing,armed:s.armed,warm:Array.isArray(s.warm)?s.warm.length:s.warm,err:s.error};});
  console.log(n, JSON.stringify(st));
}
console.log('errors:',errs.length,errs.slice(0,3)); await b.close();
