import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(6500);
// menu path: register an account so ALL witness buttons exist, then click BTN
const u='striprobe'+Date.now();
await page.evaluate(async(u)=>{await fetch('http://localhost:4610/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({name:u,username:u,password:'ProbePass1234'})});},u);
await page.reload({waitUntil:'domcontentloaded'});await wait(5000);
const tgt=await page.evaluate((btn)=>{const e=[...document.querySelectorAll('button')].filter(x=>x.offsetParent&&new RegExp(btn,'i').test(x.textContent||''));if(!e.length)return null;const r=e[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,text:e[0].textContent.trim()};},process.env.BTN||'witness');
console.log('clicked:',tgt&&tgt.text); if(tgt) await page.mouse.click(tgt.x,tgt.y);
await wait(1500);
let last=-2;
for(;;){
  const st=await page.evaluate(()=>window.gaia?.director?.status?.()??null);
  if(!st){console.log('no status');break;}
  if(st.state==='done'||st.state==='stopped'||st.t>=293){console.log('end',JSON.stringify(st));break;}
  if(st.t-last>=2){last=st.t;await page.screenshot({path:`proof/intro-film/f${String(Math.round(st.t)).padStart(3,'0')}.jpg`,quality:55,type:'jpeg'});}
  await wait(400);
}
await b.close();
