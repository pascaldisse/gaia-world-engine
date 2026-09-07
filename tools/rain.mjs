// rain — read the world the machine-native way (see client/kernel/rain.js).
//
// usage:
//   node tools/rain.mjs proprio|motion|pose <entityId> [--ticks N] [--hz N] [--forwardAxis -z]
//   node tools/rain.mjs fov <entityId> [--fov DEG] [--range M]
//   node tools/rain.mjs colliders <entityId> [--space planar|full]
//   node tools/rain.mjs frame [--cols N] [--rows N] [--crop x,y,width,height] (top-left pixel crop; needs readPixels wiring)
//
// Requires the client running in a CDP browser (--remote-debugging-port=9222;
// override with CDP_PORT).
import { connectCdp } from './cdp-lib.mjs';

const MODES = ['proprio', 'fov', 'motion', 'pose', 'colliders', 'frame'];
const [, , mode, ...argv] = process.argv;
const needsId = mode !== 'frame';
const id = needsId ? argv.shift() : null;
if (!MODES.includes(mode) || (needsId && (!id || id.startsWith('--')))) {
  console.log('usage: rain.mjs proprio|motion|pose <id> [--ticks N] [--hz N] [--forwardAxis -z] | fov <id> [--fov DEG] [--range M] | colliders <id> [--space planar|full] | frame [--cols N] [--rows N]');
  process.exit(1);
}
const opts = {};
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i]?.replace(/^--/, '');
  if (!k) continue;
  const v = argv[i + 1];
  if (k === 'crop') {
    const parts = String(v).split(','), a = parts.map(Number);
    if (parts.some(s => s.trim() === '') || a.length !== 4 || !a.every(Number.isInteger)) { console.error('crop requires x,y,width,height integers'); process.exit(2); }
    opts.crop = { x: a[0], y: a[1], width: a[2], height: a[3] }; continue;
  }
  opts[k] = v === undefined || Number.isNaN(Number(v)) ? v : Number(v);
}

const { ws, send } = await connectCdp();
const args = needsId ? `${JSON.stringify(id)}, ${JSON.stringify(opts)}` : JSON.stringify(opts);
const expr = `window.gaia.rain.${mode}(${args})`;
const msg = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
ws.close();
if (msg.error || msg.result?.exceptionDetails) {
  console.error(JSON.stringify(msg.error ?? msg.result.exceptionDetails));
  process.exit(2);
}
const text = msg.result?.result?.value;
if (typeof text !== 'string' || !text.startsWith('#rain ')) {
  console.error(JSON.stringify(msg.result)); process.exit(2);
}
console.log(text);
process.exit(/!READ_FAILED|!BAD_BUFFER|!BAD_DIMENSIONS|!BAD_ORIGIN|!BAD_CROP/.test(text) ? 2 : 0);
