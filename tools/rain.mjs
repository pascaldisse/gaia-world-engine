// rain — read the world the machine-native way (see client/kernel/rain.js).
//
// usage:
//   node tools/rain.mjs proprio <entityId> [--ticks N] [--hz N]
//   node tools/rain.mjs fov <entityId> [--fov DEG] [--range M]
//
// Requires the client running in a CDP browser (--remote-debugging-port=9222).
import { connectCdp } from './cdp-lib.mjs';

const [, , mode, id, ...rest] = process.argv;
if (!mode || !id || !['proprio', 'fov'].includes(mode)) {
  console.log('usage: rain.mjs proprio <id> [--ticks N] [--hz N] | fov <id> [--fov DEG] [--range M]');
  process.exit(1);
}
const opts = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i]?.replace(/^--/, '');
  if (k) opts[k] = Number(rest[i + 1]);
}

const { ws, send } = await connectCdp();
const expr = `window.gaia.rain.${mode}(${JSON.stringify(id)}, ${JSON.stringify(opts)})`;
const msg = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(msg.result?.result?.value ?? JSON.stringify(msg.result));
ws.close();
process.exit(0);
