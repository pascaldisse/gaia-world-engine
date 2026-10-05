// lane ds-sky — per-concern ownership: lighting.owns:{fog,background,hemi,sky}. Default (all true) = historic
// behaviour bit-identical; false = the game keeps that concern while sun/CSM/AO/tonemap/GI-feed still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Environment } from '../client/kernel/environment.js';
import { LIGHTING_DEFAULTS } from '../client/kernel/lighting/index.js';

function make() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101c30');
  scene.fog = new THREE.Fog('#101c30', 60, 280);
  const renderer = { toneMappingExposure: 1, toneMapping: THREE.ACESFilmicToneMapping };
  const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
  const sun = new THREE.DirectionalLight('#ffe2b0', 1.2);
  sun.position.set(60, 90, 30);
  scene.add(hemi, sun);
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);
  return { scene, renderer, hemi, sun, camera };
}
const snap = (r) => JSON.stringify({
  bg: r.scene.background.getHex(), fog: [r.scene.fog.color.getHex(), r.scene.fog.near, r.scene.fog.far],
  sun: [r.sun.color.getHex(), r.sun.intensity, r.sun.position.toArray()],
  hemi: [r.hemi.color.getHex(), r.hemi.groundColor.getHex(), r.hemi.intensity],
  tm: r.renderer.toneMapping, n: r.scene.children.length, sky: r.scene.children.some((o) => o.isSky || o.isSkyMesh),
});
const LIT = { enabled: true, time: { timeOfDay: 12, latitude: 40, dayOfYear: 172 }, shadows: { enabled: false }, post: { tonemap: 'agx', exposure: 0.55 } };
const boot = (lighting) => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  env.apply({ lighting });
  env.update(0.016);
  return { r, env };
};

test('default owns = all true; omitted owns / explicit all-true / partial merge are bit-identical to the historic rig', () => {
  assert.deepEqual(LIGHTING_DEFAULTS.owns, { fog: true, background: true, hemi: true, sky: true });
  const a = boot(LIT), b = boot({ ...LIT, owns: { fog: true, background: true, hemi: true, sky: true } }), c = boot({ ...LIT, owns: {} });
  assert.equal(snap(a.r), snap(b.r));
  assert.equal(snap(a.r), snap(c.r));
  assert.equal(a.r.scene.fog.far, 900, 'historic fog far still applied');
  assert.ok(a.r.scene.children.some((o) => o.isSky || o.isSkyMesh || o.sunPosition), 'dome present by default');
  assert.notEqual(a.r.scene.background.getHex(), 0x101c30, 'background follows horizon by default');
});

test('owns.fog:false keeps fog colour/near/far; the rest is still lighting-owned', () => {
  const base = boot(LIT), x = boot({ ...LIT, owns: { fog: false } });
  assert.equal(x.r.scene.fog.getHex?.() ?? x.r.scene.fog.color.getHex(), 0x101c30);
  assert.equal(x.r.scene.fog.near, 60); assert.equal(x.r.scene.fog.far, 280);
  assert.equal(x.r.scene.background.getHex(), base.r.scene.background.getHex(), 'background still owned');
  assert.equal(x.r.sun.intensity, base.r.sun.intensity, 'sun still owned');
  assert.equal(x.r.hemi.intensity, base.r.hemi.intensity, 'hemi still owned');
});

test('owns.background:false keeps scene.background; fog still follows', () => {
  const base = boot(LIT), x = boot({ ...LIT, owns: { background: false } });
  assert.equal(x.r.scene.background.getHex(), 0x101c30);
  assert.equal(x.r.scene.fog.color.getHex(), base.r.scene.fog.color.getHex());
  assert.equal(x.r.scene.fog.far, 900);
});

test('owns.hemi:false keeps the hemisphere light; sun + tonemap + exposure still owned', () => {
  const base = boot(LIT), x = boot({ ...LIT, owns: { hemi: false } });
  assert.equal(x.r.hemi.intensity, 0.6); assert.equal(x.r.hemi.color.getHex(), new THREE.Color('#8fb3ff').getHex());
  assert.equal(x.r.sun.intensity, base.r.sun.intensity);
  assert.equal(x.env.exposure, 0.55);
  assert.equal(x.r.renderer.toneMapping, THREE.AgXToneMapping);
});

test('owns.sky:false → no dome mesh; owns all false = sun/exposure/tonemap only, scene otherwise untouched', () => {
  const x = boot({ ...LIT, owns: { fog: false, background: false, hemi: false, sky: false } });
  assert.equal(x.env.lighting.skyMesh, null);
  assert.equal(x.r.scene.children.some((o) => o.sunPosition), false, 'no sky dome added');
  assert.equal(x.r.scene.background.getHex(), 0x101c30);
  assert.equal([x.r.scene.fog.near, x.r.scene.fog.far].join(), '60,280');
  assert.equal(x.r.hemi.intensity, 0.6);
  assert.ok(x.r.sun.intensity > 2.5, 'sun still driven');
  assert.ok(x.env.lighting.skySummary.horizon.length === 3, 'a summary is still published (Preetham fallback)');
});

test('setSkySummary: external summary replaces Preetham + reaches onSkyChange only while owns.sky:false; null clears', () => {
  const ext = { zenith: [0.1, 0.2, 0.3], horizon: [0.7, 0.6, 0.5], ground: [0.05, 0.04, 0.03] };
  const x = boot({ ...LIT, owns: { sky: false } });
  const seen = []; x.env.lighting.onSkyChange((s) => seen.push(s));
  x.env.lighting.setSkySummary(ext);
  assert.deepEqual(x.env.lighting.skySummary, ext);
  assert.deepEqual(seen.at(-1), ext, 'GI feed listener got the external summary');
  x.env.lighting.setSkySummary(null);
  assert.notDeepEqual(x.env.lighting.skySummary, ext, 'cleared -> Preetham back');
  // owns.sky true: external ignored
  const y = boot(LIT);
  const before = JSON.stringify(y.env.lighting.skySummary);
  y.env.lighting.setSkySummary(ext); y.env.update(0.016);
  assert.equal(JSON.stringify(y.env.lighting.skySummary), before, 'ignored while the analytic dome owns the sky');
});

test('hemi/fog tint follow the external summary when still owned and owns.sky:false', () => {
  const ext = { zenith: [0.1, 0.2, 0.4], horizon: [0.8, 0.4, 0.2], ground: [0.05, 0.04, 0.03] };
  const x = boot({ ...LIT, owns: { sky: false } });
  x.env.lighting.setSkySummary(ext);
  const f = x.r.scene.fog.color;
  assert.ok(Math.abs(f.r - 0.8) < 1e-5 && Math.abs(f.g - 0.4) < 1e-5 && Math.abs(f.b - 0.2) < 1e-5, 'fog colour = external horizon');
});
