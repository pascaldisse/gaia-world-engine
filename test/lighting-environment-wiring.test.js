// S4 — Environment component wiring (mirrors gi-environment-wiring): default OFF is
// byte-identical, lighting:{enabled:true} owns sun/hemi/background/fog/exposure and
// is NOT overwritten per frame; disabling hands back to the params apply() wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Environment } from '../client/kernel/environment.js';

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
  sun: [r.sun.color.getHex(), r.sun.intensity, r.sun.position.toArray(), r.sun.castShadow, r.sun.shadow.shadowNode ?? null],
  hemi: [r.hemi.color.getHex(), r.hemi.groundColor.getHex(), r.hemi.intensity],
  tm: r.renderer.toneMapping, n: r.scene.children.length,
});

test('default: no lighting key → lighting off, scene identical to a plain apply({})', () => {
  const a = make(); const b = make();
  const ea = new Environment({ ...a, post: null, audio: null, camera: a.camera });
  const eb = new Environment({ ...b, post: null, audio: null, camera: b.camera });
  assert.equal(ea.lighting.enabled, false);
  assert.equal(ea.lighting.skySummary, null);
  ea.apply({});
  eb.apply({ lighting: { enabled: false, shadows: { cascades: 2 }, post: { tonemap: 'agx' } } });
  ea.update(0.016); eb.update(0.016);
  assert.equal(snap(a), snap(b), 'enabled:false ignores the rest of the lighting block');
  assert.equal(a.renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(a.scene.children.some((o) => o.isSky), false);
});

test('lighting:{enabled:true} owns sun/hemi/bg/fog/exposure; per-frame update does not overwrite it', () => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  env.apply({ lighting: { enabled: true, time: { timeOfDay: 12, latitude: 40, dayOfYear: 172 }, shadows: { enabled: false }, post: { tonemap: 'agx', exposure: 0.55 } } });
  assert.equal(env.lighting.enabled, true);
  const lit = snap(r);
  assert.ok(r.sun.intensity > 2.5);
  assert.equal(env.exposure, 0.55);
  for (let i = 0; i < 5; i++) env.update(0.016);
  assert.equal(snap(r), lit, 'update() left lighting-owned values alone');
  assert.equal(r.renderer.toneMappingExposure, 0.55);
  assert.equal(r.renderer.toneMapping, THREE.AgXToneMapping);
  assert.equal(r.scene.fog.far, 900);
  assert.ok(env.lighting.skySummary.horizon.length === 3);
});

test('a crossfade (applyFaded) does not drag lighting-owned values toward stale params', () => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  const cfg = { lighting: { enabled: true, shadows: { enabled: false } } };
  env.apply(cfg);
  const lit = snap(r);
  env.applyFaded({ ...cfg, fog: { color: '#ff0000', near: 1, far: 2 } }, 2);
  for (let i = 0; i < 100; i++) env.update(0.05);
  assert.equal(snap(r), lit);
});

test('time-of-day change flows through update(): sun colour warms at sunset, background follows horizon, current tracks', () => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  env.apply({ lighting: { enabled: true, time: { timeOfDay: 12 }, shadows: { enabled: false } } });
  const noonI = r.sun.intensity;
  env.lighting.setTimeOfDay(18.9);
  env.update(0.016);
  assert.ok(r.sun.intensity < noonI * 0.5);
  assert.ok(r.sun.color.r > r.sun.color.b * 1.5);
  assert.equal(env.current.sunIntensity, r.sun.intensity, 'flash baseline tracks');
});

test('disabling via a later apply() (scene switch) restores kernel values from the params, sky removed', () => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  env.apply({ lighting: { enabled: true, shadows: { enabled: false } } });
  assert.ok(r.scene.children.some((o) => o.isSky));
  env.apply({ sun: { color: '#00ff00', intensity: 0.77, position: [1, 2, 3] }, fog: { color: '#223344', near: 5, far: 50 } });
  assert.equal(env.lighting.enabled, false);
  assert.equal(r.sun.intensity, 0.77, 'params win, not the stale pre-enable snapshot');
  assert.equal(r.scene.fog.far, 50);
  assert.equal(r.scene.children.some((o) => o.isSky), false);
  assert.equal(r.renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(r.sun.castShadow, false);
});

test('shadows via the component: lighting.shadows reaches the sun light as a CSM node', () => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  env.apply({ lighting: { enabled: true, shadows: { cascades: 4, maxFar: 600, mapSize: 2048 } } });
  assert.equal(r.sun.shadow.shadowNode.cascades, 4);
  assert.equal(r.sun.castShadow, true);
  env.apply({});
  assert.equal(r.sun.shadow.shadowNode ?? null, null);
});

test('GI-facing interface: environment.lighting.skySummary + onSkyChange', () => {
  const r = make();
  const env = new Environment({ ...r, post: null, audio: null, camera: r.camera });
  const seen = [];
  env.lighting.onSkyChange((s) => seen.push(s));
  env.apply({ lighting: { enabled: true, shadows: { enabled: false } } });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(env.lighting.skySummary).sort(), ['ground', 'horizon', 'zenith']);
});
