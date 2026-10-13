// CDP multi-shot on ONE page load (Brave --remote-debugging-port=9361): bun shotkit.ts <url> <waitSec> [--eval JS] [name=out.png@x,y,z,yaw,pitch ...]
// loads url once, waits, hides editor chrome, then per shot sets gaia.player pose and captures. --eval prints JSON of JS (debug)
const args = Bun.argv.slice(2); const url = args[0], wait = Number(args[1] || 40);
const tabs = await (await fetch('http://localhost:9361/json')).json();
const tab = tabs.find((t: any) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r as any));
let id = 0; const pend = new Map<number, any>(); ws.onmessage = (m) => { const d = JSON.parse(m.data as string); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled' && process.env.CONSOLE) console.log('[console]', d.params.args.map((a: any) => a.value ?? a.description).join(' ').slice(0, 200)); };
const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression: string) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result?.result?.value ?? r.result; };
await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, wait * 1000));
await ev(`(()=>{const s=document.createElement('style');s.textContent='#hud,#title,#debug,#crosshair,#hint,#mode,#viewbar,#outliner,#panel,#overlay,#menu{display:none!important}';document.head.appendChild(s)})()`);
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--eval') { console.log(JSON.stringify(await ev(args[++i]), null, 1)); continue; }
  const m = args[i].match(/^(.+?)=(.+?)@(.+)$/); if (!m) continue; const [, , out, pose] = m; const [x, y, z, yaw, pitch] = pose.split(',').map(Number);
  await ev(`(()=>{const p=window.gaia.player;p.position.set(${x},${y},${z});p.yaw=${yaw};p.pitch=${pitch};})()`);
  await new Promise((r) => setTimeout(r, 4000));
  const r = await send('Page.captureScreenshot', { format: 'png' }); await Bun.write(out, Buffer.from(r.result.data, 'base64')); console.log('saved', out, r.result.data.length);
}
process.exit(0);
