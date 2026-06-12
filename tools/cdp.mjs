// Talk to a Chromium tab over the DevTools protocol — the way to verify the
// editor's DOM (outliner, inspector), which canvas screenshots can't see.
// The browser must run with --remote-debugging-port=9222, e.g.:
//   "Brave Browser" --user-data-dir=/tmp/gaia-profile --remote-debugging-port=9222 <url>
//
// usage:
//   node tools/cdp.mjs eval '<js expression>'   evaluate in the page, print result
//   node tools/cdp.mjs shot out.png             full-page screenshot (DOM + canvas)
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const [, , cmd, arg] = process.argv;
const { ws, send } = await connectCdp();

if (cmd === 'eval') {
  const msg = await send('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
  const r = msg.result?.result;
  console.log(r?.value ?? JSON.stringify(msg.result));
} else if (cmd === 'shot') {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  const file = arg ?? 'cdp-shot.png';
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  console.log(`${file} (${fs.statSync(file).size} bytes)`);
} else {
  console.log('usage: cdp.mjs eval <expression> | shot [file.png]');
}
ws.close();
process.exit(0);
