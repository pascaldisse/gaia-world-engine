import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(7000);
await page.evaluate(()=>{const e=[...document.querySelectorAll('button')].filter(x=>x.offsetParent&&/enter the dream/i.test(x.textContent||''));e[0]&&e[0].click();});
await wait(6000);
console.log(JSON.stringify(await page.evaluate(()=>{
  const s=window.gaia?.atlasStrategy; const g=s?.graph;
  const nodes=g?.nodes??[]; const links=g?.links??g?.edges??[];
  const kinds={}; for(const n of nodes) kinds[n.kind??n.type??'?']=(kinds[n.kind??n.type??'?']??0)+1;
  const sample=nodes.slice(0,4).map(n=>({id:n.id,name:n.name??n.label,kind:n.kind??n.type,fields:Object.keys(n.data??n.fields??n).length}));
  return { nodes: nodes.length, links: links.length, kinds, sample, cosmosReady: !!s?.cosmos?.ready };
}),null,1));
await b.close();
