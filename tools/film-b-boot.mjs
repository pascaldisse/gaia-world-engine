// FILM LANE B · put the page in a state the camera can be measured in.
//
// Imports the recorder + director into the live tab, prepares the film (which
// casts it: hero star, walk, bloodline ends — every camera target resolves off
// that cast), and parks the instance on window.D plus the raw module exports
// on window.__filmB so the audit can call sampleCamera(D.keys, t) directly.
//
// AUDIO IS NEVER ARMED HERE. The transport is only ever driven with
// audio:false / seek(), and the browser itself runs --mute-audio.
//
//   CDP_PORT=9226 GAIA_CLIENT_PORT=5178 node tools/film-b-boot.mjs
import { connectCdp } from './cdp-lib.mjs';

const { ws, send } = await connectCdp();
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};

const stamp = Date.now();
const out = await evaluate(`(async () => {
  try {
    for (let i = 0; i < 240; i += 1) {
      if (window.gaia?.atlasCosmos?.ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!window.gaia?.atlasCosmos?.ready) return { ok: false, why: 'cosmos never became ready' };
    await import('/plugins/recorder.js?b=${stamp}');
    const m = await import('/plugins/atlas-director.js?b=${stamp}');
    window.__filmB = m;
    window.D = m.default.director;
    window.D.prepare();
    // mute anything the director may have already built, belt and braces
    if (window.D.audio?.el) window.D.audio.el.muted = true;
    return {
      ok: true,
      keys: window.D.keys.length,
      cast: { hero: window.D.hero, blood: window.D.blood },
      nodes: window.gaia.atlasCosmos.nodes.length,
      rite: window.gaia.atlasCosmos.rite,
    };
  } catch (e) { return { ok: false, why: String(e && e.message), stack: String(e && e.stack).split('\\n').slice(1, 4).join(' | ') }; }
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(out?.ok ? 0 : 1);
