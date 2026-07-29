import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const CLIENT = process.env.CLIENT ?? 'http://localhost:5174';
const QUEST = process.env.QUEST ?? 'http://localhost:4610';
const OUT='proof/live-click'; mkdirSync(OUT,{recursive:true});
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
const errs=[];page.on('console',m=>errs.push(m.type()+': '+m.text().slice(0,200)));
await page.goto(CLIENT,{waitUntil:'domcontentloaded',timeout:45000});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(6000);
const u='pascalrepro'+Date.now();
const reg=await page.evaluate(async({q,u})=>{try{const r=await fetch(q+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({name:u,username:u,password:'ProbePass1234'})});const t=await r.text();return r.status+':'+t.slice(0,80);}catch(e){return 'ERR '+e.message;}},{q:QUEST,u});
console.log('register:',reg);
await page.reload({waitUntil:'domcontentloaded'});await wait(4500);
await page.screenshot({path:`${OUT}/P1-start-screen.png`});
const tgt=await page.evaluate(()=>{const e=[...document.querySelectorAll('button')].filter(x=>x.offsetParent&&new RegExp(process.env.BTN||'witness','i').test(x.textContent||''));if(!e.length)return null;const r=e[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,text:e[0].textContent.trim().slice(0,40)};});
console.log('clicked:',tgt&&tgt.text);
if(tgt) await page.mouse.click(tgt.x,tgt.y);
await wait(2500); await page.mouse.click(640,477); await page.keyboard.press('Enter'); // begin gesture if asked
for (const [n,ms] of [['P2+4s',4000],['P3+9s',5000]]) {
  await wait(ms); await page.screenshot({path:`${OUT}/${n}.png`});
  const st=await page.evaluate(()=>{const d=window.gaia?.director;let s=null;try{s=d&&d.status&&d.status();}catch(e){}return s&&{t:+s.t.toFixed(2),playing:s.playing,state:s.state,err:s.error,why:s.stateWhy,intro:window.gaia?.atlasIntro?.status?.()};});
  console.log(n,JSON.stringify(st));
}
console.log('errors:',errs.length,errs.slice(0,3)); await b.close();
