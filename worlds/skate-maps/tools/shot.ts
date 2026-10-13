// CDP screenshot of a running Brave (--remote-debugging-port=9361): bun shot.ts <url> <out.png> [waitSec]; hides editor chrome (panels/hud) first
const [url, out, wait] = Bun.argv.slice(2);
const tabs = await (await fetch('http://localhost:9361/json')).json();
const tab = tabs.find((t: any) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r as any));
let id = 0; const pend = new Map<number, any>(); ws.onmessage = (m) => { const d = JSON.parse(m.data as string); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(wait || 30) * 1000));
await send('Runtime.evaluate', { expression: `(()=>{const s=document.createElement('style');s.textContent='#hud,#title,#debug,#crosshair,#hint,#mode,#viewbar,#outliner,#panel,#overlay,#menu{display:none!important}';document.head.appendChild(s)})()` });
await new Promise((r) => setTimeout(r, 1500));
const r = await send('Page.captureScreenshot', { format: 'png' }); await Bun.write(out, Buffer.from(r.result.data, 'base64')); console.log('saved', out, r.result.data.length); process.exit(0);
