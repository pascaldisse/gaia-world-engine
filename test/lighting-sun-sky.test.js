// S2 — pure sun maths + sky radiance + controller wiring (no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec3, uniform } from 'three/tsl';
import { sunPosition, sunFromDirection, sunLight, daylight } from '../client/kernel/lighting/sun.js';
import { skyRadiance, skyRadianceTSL, skySummary, SKY_DEFAULTS } from '../client/kernel/lighting/sky.js';
import { LightingController } from '../client/kernel/lighting/index.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (eps ${eps})`);
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('sun direction: equinox noon at the equator is straight up', () => {
  const s = sunPosition({ timeOfDay: 12, latitude: 0, dayOfYear: 80 }); // ~Mar 21
  assert.ok(s.elevation > 88, `elevation ${s.elevation}`);
  near(Math.hypot(...s.dir), 1, 1e-9, 'unit');
});

test('sun direction: June solstice noon @40°N → elevation ≈ 73.4°, due south (+Z)', () => {
  const s = sunPosition({ timeOfDay: 12, latitude: 40, dayOfYear: 172 });
  near(s.elevation, 90 - 40 + 23.44, 0.4, 'el');
  near(s.azimuth, 180, 0.5, 'az');
  assert.ok(s.dir[2] > 0.2, 'south = +Z');
  near(s.dir[0], 0, 1e-6, 'x');
});

test('sun direction: morning is east (+X), evening is west (−X), 6h symmetric', () => {
  const am = sunPosition({ timeOfDay: 8, latitude: 40, dayOfYear: 172 });
  const pm = sunPosition({ timeOfDay: 16, latitude: 40, dayOfYear: 172 });
  assert.ok(am.dir[0] > 0.3 && pm.dir[0] < -0.3);
  near(am.elevation, pm.elevation, 1e-6, 'symmetric elevation');
  near(am.dir[0], -pm.dir[0], 1e-9, 'mirror x');
});

test('sun direction: midnight is below the horizon; winter noon lower than summer noon', () => {
  assert.ok(sunPosition({ timeOfDay: 0, latitude: 40, dayOfYear: 172 }).elevation < 0);
  const w = sunPosition({ timeOfDay: 12, latitude: 40, dayOfYear: 355 }).elevation;
  const s = sunPosition({ timeOfDay: 12, latitude: 40, dayOfYear: 172 }).elevation;
  near(w, 90 - 40 - 23.44, 0.6, 'winter');
  assert.ok(w < s - 40);
});

test('sunFromDirection normalises and round-trips elevation/azimuth', () => {
  const s = sunPosition({ timeOfDay: 9, latitude: 51, dayOfYear: 100 });
  const r = sunFromDirection(s.dir.map((v) => v * 7));
  near(r.elevation, s.elevation, 1e-6);
  near(r.azimuth, s.azimuth, 1e-6);
  near(Math.hypot(...r.dir), 1, 1e-12);
});

test('sun colour ramp: warmth (b/r) rises monotonically with elevation 0→90°; intensity non-decreasing', () => {
  let prevWarm = -1;
  let prevI = -1;
  for (let el = 1; el <= 90; el += 2) {
    const d = [Math.cos(el * Math.PI / 180), Math.sin(el * Math.PI / 180), 0];
    const L = sunLight(d);
    const cool = L.color[2] / L.color[0];
    assert.ok(cool >= prevWarm - 1e-9, `b/r dropped at ${el}°`);
    assert.ok(L.intensity >= prevI - 1e-9, `intensity dropped at ${el}°`);
    prevWarm = cool; prevI = L.intensity;
  }
  const low = sunLight([1, Math.sin(3 * Math.PI / 180), 0]);
  assert.ok(low.color[0] > low.color[1] && low.color[1] > low.color[2], 'sunset is warm: r>g>b');
});

test('below the horizon → dim cool moon, light comes from above (antipode, y>0)', () => {
  const noon = sunLight([0, 1, 0]);
  const night = sunLight([0.3, -0.6, 0.7]);
  assert.equal(night.isMoon, true);
  assert.equal(noon.isMoon, false);
  assert.ok(night.intensity < noon.intensity * 0.1);
  assert.ok(night.color[2] > night.color[0], 'moon is blue-ish');
  assert.ok(night.direction[1] > 0, 'never lights from below');
  assert.ok(daylight([0, 1, 0]) > 0.99 && daylight([0, -1, 0]) < 0.01);
});

test('skyRadiance: noon sky is blue (zenith b/r > horizon b/r) and far brighter than night', () => {
  const noon = sunPosition({ timeOfDay: 12, latitude: 40, dayOfYear: 172 }).dir;
  const night = sunPosition({ timeOfDay: 0, latitude: 40, dayOfYear: 172 }).dir;
  const z = skyRadiance([0, 1, 0], noon);
  const h = skyRadiance([1, 0.07, 0], noon);
  assert.ok(z[2] / z[0] > h[2] / h[0], 'zenith bluer than horizon');
  assert.ok(z[2] > z[0], 'zenith b>r');
  // SPEC DEVIATION (documented): Preetham's horizon is not dimmer than the zenith
  // — longer optical path scatters more. B channel zenith>horizon, R/G horizon>=zenith.
  assert.ok(z[2] > h[2], 'zenith blue channel brighter than horizon blue channel');
  assert.ok(h[0] > z[0], 'horizon red channel brighter (haze/white-out)');
  assert.ok(lum(z) > 10 * lum(skyRadiance([0, 1, 0], night)), 'noon ≫ night');
});

test('skyRadiance: sunset horizon toward the sun is warmer (r/b) than away; sun disc is opt-in', () => {
  const s = sunPosition({ timeOfDay: 18.9, latitude: 40, dayOfYear: 172 });
  const toward = skyRadiance(s.dir.map((v, i) => (i === 1 ? 0.06 : v)), s.dir);
  const away = skyRadiance(s.dir.map((v, i) => (i === 1 ? 0.06 : -v)), s.dir);
  assert.ok(toward[0] / toward[2] > away[0] / away[2], 'sunset side redder');
  const noDisc = skyRadiance(s.dir, s.dir);
  const disc = skyRadiance(s.dir, s.dir, {}, { disc: true });
  assert.ok(disc[0] > noDisc[0] * 5, 'disc adds a spike');
});

test('skyRadiance: finite, non-negative, below-horizon dir clamps to horizon, unit-invariant', () => {
  const sd = sunPosition({ timeOfDay: 15, latitude: 40, dayOfYear: 172 }).dir;
  for (const d of [[0, 1, 0], [1, 0, 0], [0, -1, 0], [0.3, -0.2, 0.9], [0, 0.001, 1]]) {
    const c = skyRadiance(d, sd);
    assert.ok(c.every((v) => Number.isFinite(v) && v >= 0), JSON.stringify(c));
  }
  // sun on the horizon along +Z so dir·sun (phase) is 0 for both: only the clamp differs
  const a = skyRadiance([1, -0.5, 0], [0, 0, 1]);
  const b = skyRadiance([1, 0, 0], [0, 0, 1]);
  a.forEach((v, i) => near(v, b[i], 1e-9));
  const u = skyRadiance([0.2, 0.5, 0.3], sd);
  const k = skyRadiance([2, 5, 3], sd);
  u.forEach((v, i) => near(v, k[i], 1e-9));
});

test('skySummary: {zenith,horizon,ground} — ground = horizon×albedo, day ≫ night', () => {
  const noon = sunPosition({ timeOfDay: 12, latitude: 40, dayOfYear: 172 }).dir;
  const night = sunPosition({ timeOfDay: 0, latitude: 40, dayOfYear: 172 }).dir;
  const s = skySummary(noon);
  assert.deepEqual(Object.keys(s).sort(), ['ground', 'horizon', 'zenith']);
  s.ground.forEach((v, i) => near(v, s.horizon[i] * SKY_DEFAULTS.groundAlbedo, 1e-12));
  assert.ok(lum(s.horizon) > 10 * lum(skySummary(night).horizon));
});

test('skyRadianceTSL builds a vec3 node graph with uniforms and plain numbers', () => {
  const sunU = uniform(new THREE.Vector3(0, 0.8, 0.6));
  const n = skyRadianceTSL(vec3(0, 1, 0), sunU, { turbidity: uniform(5) });
  assert.equal(n.isNode, true);
  assert.equal(n.getNodeType ? true : false, true);
  const nd = skyRadianceTSL(vec3(0.3, 0.4, 0.5), sunU, {}, { disc: true });
  assert.equal(nd.isNode, true);
});

test('controller: default OFF touches nothing; enabling owns sun/hemi/fog/background, exposes skySummary; disable restores', () => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101c30');
  scene.fog = new THREE.Fog('#101c30', 60, 280);
  const sun = new THREE.DirectionalLight('#ffe2b0', 1.2); sun.position.set(60, 90, 30);
  const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
  scene.add(sun, hemi);
  const lc = new LightingController({ renderer: {}, scene, sun, hemi });
  lc.configure({});
  assert.equal(lc.skySummary, null);
  assert.equal(scene.children.length, 2);
  assert.equal(sun.intensity, 1.2);
  let calls = 0;
  lc.onSkyChange(() => calls++);
  lc.configure({ enabled: true, time: { timeOfDay: 12, latitude: 40, dayOfYear: 172 }, shadows: { enabled: false } });
  assert.ok(lc.skySummary && lc.skySummary.zenith.length === 3);
  assert.equal(calls, 1);
  assert.ok(sun.intensity > 2.5);
  assert.ok(sun.position.y > sun.position.length() * 0.9, 'noon sun high');
  assert.ok(scene.children.some((o) => o.isSky), 'sky dome added');
  assert.ok(scene.background.r > 0.5, 'clear colour follows horizon');
  assert.equal(scene.fog.far, 900);
  lc.update(0.1); assert.equal(calls, 1, 'no recompute when nothing moved');
  lc.setTimeOfDay(19); lc.update(0.1);
  assert.equal(calls, 2);
  assert.ok(sun.color.r > sun.color.b, 'sunset warm');
  lc.configure({ enabled: false });
  assert.equal(lc.skySummary, null);
  assert.equal(sun.intensity, 1.2);
  assert.equal(scene.children.length, 2);
  assert.equal(hemi.intensity, 0.6);
});

test('controller: explicit direction overrides time; speed advances the clock', () => {
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog('#000', 1, 2); scene.background = new THREE.Color();
  const sun = new THREE.DirectionalLight(); const hemi = new THREE.HemisphereLight();
  const lc = new LightingController({ renderer: {}, scene, sun, hemi });
  lc.configure({ enabled: true, shadows: { enabled: false }, sky: { visible: false }, time: { direction: [0, 1, 0] } });
  near(lc.sunState.elevation, 90, 1e-6);
  assert.equal(scene.children.some((o) => o.isSky), false);
  lc.configure({ enabled: true, shadows: { enabled: false }, time: { timeOfDay: 6, speed: 2 } });
  lc.update(1);
  near(lc.timeOfDay, 8, 1e-9);
});
