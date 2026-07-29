import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
const errs=[];page.on('pageerror',e=>errs.push('PAGEERROR '+String(e).slice(0,300)));
page.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,200))});
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(12000);
console.log(JSON.stringify(await page.evaluate(()=>({
  intro: window.gaia?.atlasIntro?.status?.()?.phase,
  gateEl: !!document.querySelector('#atlas-gate'),
  gateVisible: (()=>{const g=document.querySelector('#atlas-gate');return g? getComputedStyle(g).display+'/'+g.style.opacity : null;})(),
  ls: Object.fromEntries(Object.keys(localStorage).map(k=>[k,String(localStorage.getItem(k)).slice(0,40)])),
  inputs: [...document.querySelectorAll('input')].filter(x=>x.offsetParent).length,
})),null,1));
console.log('errors:',errs);
await b.close();
