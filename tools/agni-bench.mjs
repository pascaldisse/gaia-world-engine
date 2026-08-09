// agni-bench.mjs — GATE-FPS-1 measurement rig.
//   rAF is BANNED here (vsync ceiling + occlusion throttle pollute the number).
//   The engine's own animation loop is detached, then THIS loop is the only
//   driver: sim.step(1/60) + renderAsync, back to back, timed per stage.
//   CDP_PORT=9351 GAIA_CLIENT_PORT=5231 node tools/agni-bench.mjs [frames]
import { connectCdp } from './cdp-lib.mjs';

const frames = Number(process.argv[2] ?? 900);
const warmup = Number(process.argv[3] ?? 120);
const { ws, send } = await connectCdp();
const evaluate = async (expression, timeoutMs = 300000) => {
  const msg = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    new Promise((_, rj) => setTimeout(() => rj(new Error('eval timeout')), timeoutMs)),
  ]);
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails));
  return msg.result?.result?.value;
};

const out = await evaluate(`(async () => {
  const g = window.gaia;
  const sim = g.fluid?.sim || g.fluid?.start?.();
  if (!sim) return { error: 'no fluid sim' };
  const renderer = g.view?.renderer || g.renderer;
  const scene = g.view?.scene || g.scene;
  const camera = g.view?.camera || g.camera;
  renderer.setAnimationLoop(null);           // engine loop off: we are the clock
  await new Promise((r) => setTimeout(r, 300));
  const stepMs = [], renderMs = [], frameMs = [];
  const N = ${frames}, W = ${warmup};
  for (let i = 0; i < N + W; i += 1) {
    const t0 = performance.now();
    sim.step(1 / 60);
    const t1 = performance.now();
    await renderer.renderAsync(scene, camera);
    const t2 = performance.now();
    if (i >= W) { stepMs.push(t1 - t0); renderMs.push(t2 - t1); frameMs.push(t2 - t0); }
  }
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const r3 = (x) => +x.toFixed(2);
  return {
    particles: sim.count,
    headless: /Headless/i.test(navigator.userAgent) ? 'YES(ILLEGAL)' : 'no',
    userAgent: navigator.userAgent,
    frames: frameMs.length,
    meanMs: r3(mean(frameMs)), fps: r3(1000 / mean(frameMs)),
    p50: r3(q(frameMs, 0.5)), p95: r3(q(frameMs, 0.95)), p99: r3(q(frameMs, 0.99)),
    max: r3(Math.max(...frameMs)),
    framesOver16_7: frameMs.filter((x) => x > 16.7).length,
    stepMean: r3(mean(stepMs)), stepP95: r3(q(stepMs, 0.95)),
    renderMean: r3(mean(renderMs)), renderP95: r3(q(renderMs, 0.95)),
    PASS: q(frameMs, 0.95) <= 16.7,
  };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
