import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(6500);
await page.evaluate(()=>{const e=[...document.querySelectorAll('button,div')].filter(x=>x.offsetParent&&/witness/i.test(x.textContent||''));e[0]&&e[0].click();});
await wait(2000); await page.mouse.click(640,400); await wait(1500);
let last=-2;
for(;;){
  const st=await page.evaluate(()=>window.gaia?.director?.status?.()??null);
  if(!st){console.log('no status');break;}
  if(st.state==='done'||st.state==='stopped'||st.t>=293){console.log('end',JSON.stringify(st));break;}
  if(st.t-last>=2){last=st.t;await page.screenshot({path:`proof/intro-film/f${String(Math.round(st.t)).padStart(3,'0')}.jpg`,quality:55,type:'jpeg'});}
  await wait(400);
}
await b.close();
