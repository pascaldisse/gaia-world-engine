// FOLD FRAME-CHECK #3 · shared timeout-wrapped CDP helper.
//
// Adapted from tools/cdp-lib.mjs (connection) + the timeout-race pattern in
// tools/eyes-cdp.mjs's ev(). LAW (this lane, Pascal 07-28): every manual
// CDP/network await gets an explicit timeout (10s default) — a probe that
// hangs must throw, never wait silently, so the caller can kill chrome,
// relaunch, and continue instead of stalling the whole lane.
import fs from 'node:fs';
import path from 'node:path';
import { connectCdp } from './cdp-lib.mjs';

export async function connectTimed() {
  const { ws, send } = await connectCdp();

  async function sendT(method, params = {}, ms = 10000) {
    const r = await Promise.race([
      send(method, params),
      new Promise((res) => setTimeout(() => res({ __timedOut: true }), ms)),
    ]);
    if (r.__timedOut) throw new Error(`CDP ${method} timed out after ${ms}ms`);
    return r;
  }

  async function evaluate(expression, { ms = 10000, awaitPromise = true } = {}) {
    // scripts write `return x;` bodies — wrap in an IIFE (bare return is illegal at top level)
    const wrapped = /\breturn\b/.test(expression) ? `(()=>{ ${expression} })()` : expression;
    const msg = await sendT('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise }, ms);
    if (msg.result?.exceptionDetails) {
      throw new Error(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text ?? 'eval failed');
    }
    return msg.result?.result?.value;
  }

  async function shot(file, ms = 10000) {
    const msg = await sendT('Page.captureScreenshot', { format: 'png' }, ms);
    if (!msg.result?.data) throw new Error('captureScreenshot returned nothing');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
    return fs.statSync(file).size;
  }

  async function waitFor(expression, { timeoutMs = 30000, intervalMs = 500, ms = 10000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(expression, { ms }).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${expression}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  return { ws, send: sendT, evaluate, shot, waitFor, close: () => ws.close() };
}
