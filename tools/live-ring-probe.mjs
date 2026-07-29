import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt','utf8').replace(/\n$/,'');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--mute-audio','--headless=new']});
const page=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage();
await page.goto('http://localhost:5174',{waitUntil:'domcontentloaded'});await wait(4000);
await page.evaluate(pw=>{const i=[...document.querySelectorAll('input')].find(x=>x.offsetParent);if(i){i.focus();i.value=pw;i.dispatchEvent(new Event('input',{bubbles:true}));}},PW);
await page.keyboard.press('Enter');await wait(6500);
await page.evaluate(()=>{const e=[...document.querySelectorAll('button,div')].filter(x=>x.offsetParent&&/witness the beginning/i.test(x.textContent||''));e[0]&&e[0].click();});
await wait(2500); await page.mouse.click(800,500); await wait(5000);
const out=await page.evaluate(()=>{
  const g=window.gaia||{}; let scene=g.atlasCosmos?.group; while(scene?.parent) scene=scene.parent;
  if(!scene) return {err:'no scene handle', keys:Object.keys(g)};
  const cam=g.camera||g.director?.camera||scene.userData?.camera;
  const hits=[];
  scene.traverse(o=>{
    if(!o.visible) return;
    let p=o; while(p){ if(p.visible===false) return; p=p.parent; }
    const gt=o.geometry?.type||'';
    if(/Torus|Ring/i.test(gt)||/ring/i.test(o.name||'')){
      const v=o.getWorldPosition(new (o.position.constructor)());
      hits.push({name:o.name||o.parent?.name||'?',geo:gt,pos:[+v.x.toFixed(0),+v.y.toFixed(0),+v.z.toFixed(0)],parentChain:(()=>{let c=[],q=o.parent;while(q&&c.length<5){c.push(q.name||q.type);q=q.parent;}return c;})()});
    }
  });
  return {hits:hits.slice(0,12)};
});
console.log(JSON.stringify(out,null,1));
await b.close();
