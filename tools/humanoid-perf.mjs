#!/usr/bin/env node
// humanoid-kit perf probe (live, real client over CDP) — does N instances of ONE base with K color variants share GPU resources?
//   HK_PORT=18720 CDP_PORT=9733 GAIA_CLIENT_PORT=15473 node tools/humanoid-perf.mjs [N=200] [mode=humanoid|gltf] [base=assets/ee/ee_clubman.gltf] [slot=ee_clubman] [shot.png]
// mode=humanoid → mesh.humanoid (kit: shared geometry + (material,hex) cache) · mode=gltf → mesh.gltf (contrast: materials cloned per instance)
// prints: unique geometries/materials/textures/skinned meshes in the spawned groups, renderer.info, fps over 5 s.
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const [, , nArg, modeArg, baseArg, slotArg, shotArg] = process.argv;
const N = Number(nArg ?? 200);
const MODE = modeArg ?? 'humanoid';
const BASE = baseArg ?? 'assets/ee/ee_clubman.gltf';
const SLOT = slotArg ?? 'ee_clubman';
const SERVER = `http://localhost:${process.env.HK_PORT ?? 18720}`;
const HEX = ['#d04040', '#4060d0', '#40a050', '#e0c040']; // 4 color variants
const EXTRA = JSON.parse(process.env.HK_SPEC ?? '{}'); // extra mesh.humanoid fields, e.g. {"merge":false} or {"lod":{"distances":[22,30]}}
const PREFIX = `hkperf-${MODE}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const op = (ops) => fetch(`${SERVER}/op`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) }).then((r) => r.json());
const { ws, send } = await connectCdp();
const ev = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400));
  return msg.result?.result?.value;
};

const PROBE = (prefix) => `(async () => {
  const g = gaia, sc = g.view.scene;
  const geos = new Set(), mats = new Set(), texs = new Set(); let skinned = 0, meshes = 0, ready = 0, total = 0, bones = 0; const lodLevels = {};
  for (const [id, grp] of g.view.groups) {
    if (!id.startsWith(${JSON.stringify(prefix)})) continue;
    total++;
const lvl = grp.userData.humanoid?.lod?.cur; if (lvl !== undefined) lodLevels[lvl] = (lodLevels[lvl] ?? 0) + 1;
    if (grp.userData.humanoidStatus === 'ready' || (!grp.userData.humanoidStatus && grp.children.length)) ready++;
    grp.traverse((o) => {
      if (o.isBone) bones++;
      if (!o.isMesh) return;
      meshes++; if (o.isSkinnedMesh) skinned++;
      geos.add(o.geometry);
      for (const m of [].concat(o.material)) { mats.add(m); for (const v of Object.values(m)) if (v && v.isTexture) texs.add(v); }
    });
  }
  let texBytes = 0; const sources = new Set(); const dims = {};
for (const t of texs) { const im = t.image, w = im?.width ?? 0, h = im?.height ?? 0; sources.add(t.source); texBytes += w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1); const k = w + 'x' + h; dims[k] = (dims[k] ?? 0) + 1; }
return { total, ready, meshes, skinned, bones, uniqueGeometries: geos.size, uniqueMaterials: mats.size, lodLevels, uniqueTextures: texs.size, uniqueTextureSources: sources.size, textureDims: dims, textureMBEstimate: +(texBytes / 1048576).toFixed(1) };
})()`;
const FPS = `new Promise((res) => { const t0 = performance.now(); const dts = []; let last = t0; const tick = (t) => { dts.push(t - last); last = t; if (t - t0 < 5000) requestAnimationFrame(tick); else { const d = dts.slice(2); const mean = d.reduce((a, b) => a + b, 0) / d.length; d.sort((a, b) => a - b); res({ frames: d.length, fps: +(1000 / mean).toFixed(1), p50ms: +d[Math.floor(d.length / 2)].toFixed(1), p95ms: +d[Math.floor(d.length * 0.95)].toFixed(1) }); } }; requestAnimationFrame(tick); })`;
const INFO = `JSON.stringify({ render: gaia.view.renderer.info.render, memory: gaia.view.renderer.info.memory })`;

// clean slate: remove any previous probe entities
const existing = JSON.parse(await ev('JSON.stringify([...gaia.view.groups.keys()].filter(k=>k.startsWith("hkperf-")))'));
if (existing.length) { await op(existing.map((id) => ({ op: 'despawn', id }))); await sleep(2500); }
await ev('gaia.player.position.set(0, 16, 26); gaia.player.pitch = -0.5; 1');
await sleep(1500);
const baseline = { info: JSON.parse(await ev(INFO)), fps: await ev(FPS) };

const cols = 20;
const ops = [];
for (let i = 0; i < N; i++) {
  const x = ((i % cols) - (cols - 1) / 2) * 1.3;
  const z = -Math.floor(i / cols) * 1.5 + 4;
  const hex = HEX[i % HEX.length];
  const mesh = MODE === 'gltf'
    ? { gltf: { src: BASE } }
    : { humanoid: { base: BASE, colors: { [SLOT]: hex }, ...EXTRA } };
  ops.push({ op: 'spawn', id: `${PREFIX}-${i}`, components: { transform: { position: [x, 0, z] }, mesh } });
}
const t0 = Date.now();
const applied = await op(ops);
let probe;
for (let k = 0; k < 120; k++) { // up to 60 s
  await sleep(500);
  probe = await ev(PROBE(PREFIX));
  if (probe.total >= N && probe.ready >= N) break;
}
const buildMs = Date.now() - t0;
await sleep(2500); // settle (warm frames, pipeline compile)
probe = await ev(PROBE(PREFIX));
const after = { info: JSON.parse(await ev(INFO)), fps: await ev(FPS) };
if (shotArg) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotArg, Buffer.from(shot.result.data, 'base64'));
}
const out = { mode: MODE, n: N, base: BASE, colorVariants: MODE === 'gltf' ? 0 : HEX.length, buildMs, probe, baseline, after };
console.log(JSON.stringify(out, null, 1));
if (!process.env.HK_KEEP) { await op(Array.from({ length: N }, (_, i) => ({ op: 'despawn', id: `${PREFIX}-${i}` }))); }
ws.close();
process.exit(0);
