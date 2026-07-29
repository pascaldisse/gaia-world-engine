import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(7000);
await page.evaluate(()=>localStorage.setItem('atlas_seen_intro','1'));
await page.reload({waitUntil:'domcontentloaded'});await wait(5500);
console.log(JSON.stringify(await page.evaluate(()=>({
  phase: window.gaia?.atlasIntro?.status?.()?.phase,
  buttons: [...document.querySelectorAll('button')].filter(x=>x.offsetParent).map(x=>x.textContent.trim()),
  texts: [...document.querySelectorAll('#atlas-intro .in-sub,#atlas-onboarding *')].filter(x=>x.offsetParent&&x.children.length===0).map(x=>x.textContent.trim()).filter(Boolean).slice(0,10),
})),null,1));
await page.screenshot({path:'proof/intro-film/start-noaccount.png'});
await b.close();
