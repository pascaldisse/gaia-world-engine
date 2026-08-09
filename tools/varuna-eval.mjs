// varuna-eval.mjs — evaluate an expression in the lane's GAIA tab and print the
// value. Ports are parameters (CDP_PORT / GAIA_CLIENT_PORT), never hard-coded.
//   CDP_PORT=9347 GAIA_CLIENT_PORT=5191 node tools/varuna-eval.mjs "expr" [timeoutMs]
import { connectCdp } from './cdp-lib.mjs';

const expr = process.argv[2];
const timeout = Number(process.argv[3] ?? 30000);
const { ws, send } = await connectCdp();
const t = setTimeout(() => { console.error('timeout'); process.exit(1); }, timeout);
const r = await send('Runtime.evaluate', {
  expression: expr, returnByValue: true, awaitPromise: true,
});
clearTimeout(t);
const res = r.result?.result;
if (r.result?.exceptionDetails) console.error(JSON.stringify(r.result.exceptionDetails, null, 2));
console.log(typeof res?.value === 'string' ? res.value : JSON.stringify(res?.value, null, 2));
ws.close();
process.exit(0);
