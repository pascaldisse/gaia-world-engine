import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(7000);
await page.mouse.click(640,400);await wait(4000);           // title → Witness III default
await page.keyboard.press('KeyT');await wait(800);
console.log(await page.evaluate(()=>({
  t: window.gaia?.director?.status?.().t,
  scrubberOpen: !!document.querySelector('#atlas-scrubber, .scrubber, [id*=scrub]'),
  scrubEls: [...document.querySelectorAll('[id*=scrub],[class*=scrub]')].map(e=>e.id||e.className).slice(0,4),
})));
await page.screenshot({path:'proof/intro-film/timeline-T.png'});
await b.close();
