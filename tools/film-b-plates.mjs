// FILM LANE B · THE FLIGHT-PATH PLATES
//
// 30 frames, one every 10 seconds of the film, each shot by seeking the whole
// world to that second (so the plate shows what the film shows THERE — the
// forge state, the rite, the reveal mask, not just the camera) and then
// photographing the tab. These are the frames the framing is judged on: at
// every sample the subject has to be centred or deliberately composed.
//
// The world is dressed but the CHROME is not photographed: the strategy and
// cosmos panels are DOM, they are not in the film, and a plate that includes
// them judges a HUD instead of a shot.
//
//   CDP_PORT=9226 GAIA_CLIENT_PORT=5178 node tools/film-b-plates.mjs [tag] [step]
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const tag = process.argv[2] ?? 'flight';
const step = Number(process.argv[3] ?? 10);
const DURATION = 293.44;
const OUT = 'proof/film-b';
fs.mkdirSync(OUT, { recursive: true });

const { ws, send } = await connectCdp();
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval failed');
  return msg.result?.result?.value;
};
const shot = async (file) => {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  return fs.statSync(file).size;
};

const rows = [];
for (let t = 0; t <= DURATION; t += step) {
  const at = Math.min(t, DURATION);
  const info = await evaluate(`(async () => {
    const D = window.D;
    D.opts = Object.assign({}, D.opts, { subtitles: false, mode: 'film' });
    if (D.audio?.el) D.audio.el.muted = true;
    const r = await D.seek(${at});
    for (const id of ['atlas-strategy-ui', 'atlas-cosmos-ui', 'overlay', 'hud', 'crosshair', 'panel', 'outliner', 'console', 'palette', 'debug']) {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    }
    const cam = window.__filmB.sampleCamera(D.keys, ${at});
    const s = D.s;
    return {
      t: ${at}, scene: r.scene, rite: D.cos.rite,
      tgt: cam.tgt.map((v) => Math.round(v)),
      dist: Math.round(cam.dist), yaw: +cam.yaw.toFixed(2), pitch: +cam.pitch.toFixed(3),
      eye: [Math.round(s.camera.position.x), Math.round(s.camera.position.y), Math.round(s.camera.position.z)],
      forged: D.cos.forge?.active.size ?? 0, reveal: +(D.stage?.frac ?? 0).toFixed(3),
    };
  })()`);
  // two settled frames: the strategy camera lerps target/distance toward the
  // goal, and a plate caught mid-lerp is not the shot the film holds
  await new Promise((r) => setTimeout(r, 900));
  const file = `${OUT}/${tag}-${String(Math.round(at)).padStart(3, '0')}s.png`;
  const bytes = await shot(file);
  rows.push({ ...info, file, bytes });
  process.stdout.write(`${file}  scene=${info.scene} rite=${info.rite} dist=${info.dist} tgt=[${info.tgt}] reveal=${info.reveal} (${bytes}b)\n`);
}

fs.writeFileSync(`${OUT}/${tag}-index.json`, JSON.stringify(rows, null, 2));
console.log(`\n${rows.length} plates → ${OUT}/${tag}-*.png`);
ws.close();
process.exit(0);
