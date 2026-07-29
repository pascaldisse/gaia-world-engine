import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const CLIENT='http://localhost:5174';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext()).newPage();
await page.goto(CLIENT,{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(3000);
console.log('after gate:', await page.evaluate(()=>JSON.stringify({ls:Object.fromEntries(Object.entries(localStorage)),state:window.gaia?.atlasIntro?.status?.()?.state})));
await page.reload({waitUntil:'domcontentloaded'});await wait(4000);
console.log('after reload:', await page.evaluate(async()=>{const g=window.gaia?.atlasGate; let pa=null; try{pa=g&&await g.passedAlready?.();}catch(e){pa='ERR '+e.message}
  return JSON.stringify({ls:Object.fromEntries(Object.entries(localStorage)),passedAlready:pa,state:window.gaia?.atlasIntro?.status?.()?.state});}));
await b.close();
