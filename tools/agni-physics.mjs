// agni-physics.mjs — is the liquid still a liquid? Reads the position buffer
// back off the GPU and reports the shape of the body of fluid: depth, spread,
// and how many particles sit outside the authored wall.
//   CDP_PORT=9351 GAIA_CLIENT_PORT=5231 node tools/agni-physics.mjs
import { connectCdp } from './cdp-lib.mjs';

const { ws, send } = await connectCdp();
const msg = await send('Runtime.evaluate', {
  expression: `(async () => {
    const g = window.gaia; const sim = g.fluid.sim; const r = g.view.renderer;
    const P = sim.params.physics, C = P.container;
    const buf = await r.getArrayBufferAsync(sim.buffers.position.value);
    const a = new Float32Array(buf);
    let ys = 0, ymax = -1e9, rmax = 0, outside = 0;
    const top = C.radiusTop ?? C.radius, base = C.center[1], hgt = C.height ?? 1;
    for (let i = 0; i < sim.count; i += 1) {
      const x = a[i * 4], y = a[i * 4 + 1], z = a[i * 4 + 2];
      ys += y; if (y > ymax) ymax = y;
      const rr = Math.hypot(x - C.center[0], z - C.center[2]);
      if (rr > rmax) rmax = rr;
      if (C.type === 'cylinder' || C.type === 'cone') {
        const t = Math.min(1, Math.max(0, (y - base) / hgt));
        const limit = C.radius + (top - C.radius) * (C.type === 'cone' ? t : 0);
        if (rr > limit + 1e-3) outside += 1;
      }
    }
    return JSON.stringify({ count: sim.count, container: C.type,
      ymean: +(ys / sim.count).toFixed(3), ymax: +ymax.toFixed(3),
      rmax: +rmax.toFixed(3), outsideR: outside });
  })()`,
  returnByValue: true, awaitPromise: true,
});
if (msg.result?.exceptionDetails) console.error(JSON.stringify(msg.result.exceptionDetails));
console.log(msg.result?.result?.value);
ws.close();
process.exit(0);
