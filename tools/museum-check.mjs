import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
const errs=[]; page.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,200))});
page.on('pageerror',e=>errs.push('PAGEERROR '+String(e).slice(0,300)));
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(7000);
const u='museumprobe'+Date.now();
const reg=await page.evaluate(async(u)=>{try{const r=await fetch('http://localhost:4610/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({name:u,username:u,password:'ProbePass1234'})});return r.status+':'+(await r.text()).slice(0,60);}catch(e){return 'ERR '+e.message;}},u);
console.log('register:',reg);
await page.reload({waitUntil:'domcontentloaded'});await wait(5000);
console.log(await page.evaluate(()=>({
  intro: window.gaia?.atlasIntro?.status?.() ?? null,
  buttons: [...document.querySelectorAll('button')].filter(x=>x.offsetParent).map(x=>x.textContent.trim()),
  sub: document.querySelector('.in-sub')?.textContent ?? null,
  subHidden: document.querySelector('.in-sub')?.hidden ?? null,
})));
console.log('errors:',errs.slice(0,8));
await page.screenshot({path:'proof/intro-film/museum-door.png'});
await b.close();
