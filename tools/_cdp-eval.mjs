import WebSocket from 'ws';

const targetId = process.argv[2];
const expr = process.argv[3];
const port = process.argv[4] || 9346;
const wsUrl = `ws://localhost:${port}/devtools/page/${targetId}`;
const ws = new WebSocket(wsUrl);
let id = 1;
ws.on('open', () => {
  ws.send(JSON.stringify({ id: id++, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log(JSON.stringify(msg, null, 2));
  ws.close();
  process.exit(0);
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 8000);
