// BW-SHADOW: shadow filter config (smooth), CSM texel-snap math, stagger guard. docs/LIGHTING-OPENWORLD.md S1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SunShadows, SHADOW_DEFAULTS, SHADOW_FILTERS, FILTER_TYPE, vogelTaps, makeSmoothFilter, sliceOvershoot } from '../client/kernel/lighting/shadows.js';

const sunRig = () => { const scene = new THREE.Scene(); const sun = new THREE.DirectionalLight('#fff', 1); sun.position.set(60, 90, 30); scene.add(sun, sun.target); return { scene, sun }; };

test('defaults: smooth filter, 1.5 texel radius, 12 taps, guard on', () => {
  assert.equal(SHADOW_DEFAULTS.filter, 'smooth');
  assert.equal(SHADOW_DEFAULTS.filterRadius, 1.5);
  assert.equal(SHADOW_DEFAULTS.filterTaps, 12);
  assert.equal(SHADOW_DEFAULTS.guard, true);
  assert.deepEqual(SHADOW_FILTERS, ['basic', 'pcf', 'pcfsoft', 'vsm', 'smooth']);
});

test('filter name -> renderer.shadowMap.type (smooth rides PCF), set before the node exists', () => {
  const want = { basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, pcfsoft: THREE.PCFSoftShadowMap, vsm: THREE.VSMShadowMap, smooth: THREE.PCFShadowMap };
  assert.deepEqual(FILTER_TYPE, want);
  for (const [name, type] of Object.entries(want)) {
    const { sun } = sunRig(); const renderer = { shadowMap: { type: -1 } };
    new SunShadows(sun).enable({ filter: name }, renderer);
    assert.equal(renderer.shadowMap.type, type, name);
  }
  const { sun } = sunRig(); const renderer = { shadowMap: { type: -1 } };
  new SunShadows(sun).enable({ filter: 'nope' }, renderer);
  assert.equal(renderer.shadowMap.type, FILTER_TYPE[SHADOW_DEFAULTS.filter], 'unknown -> default');
  new SunShadows(sunRig().sun).enable({}, null); // no renderer: must not throw
});

test('smooth: every cascade clone gets filterNode + radius after _init; other filters leave filterNode alone', () => {
  const { sun } = sunRig(); const ss = new SunShadows(sun);
  const node = ss.enable({ cascades: 3, filter: 'smooth', filterRadius: 2.25, filterTaps: 8 }, { shadowMap: {} });
  const cam = new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);
  node._init({ camera: cam, renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem } });
  assert.equal(node.lights.length, 3);
  const fns = new Set(node.lights.map((l) => l.shadow.filterNode));
  assert.equal(fns.size, 1); const fn = [...fns][0]; assert.equal(typeof fn, 'function'); assert.equal(fn.taps, 8);
  node.lights.forEach((l) => assert.equal(l.shadow.radius, 2.25));
  // live knob
  ss.enable({ cascades: 3, filter: 'smooth', filterRadius: 3, filterTaps: 8 }, { shadowMap: {} });
  node.lights.forEach((l) => assert.equal(l.shadow.radius, 3));
  // pcf = three's own fn
  const r2 = sunRig(); const n2 = new SunShadows(r2.sun).enable({ cascades: 2, filter: 'pcf' }, { shadowMap: {} });
  n2._init({ camera: cam, renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem } });
  n2.lights.forEach((l) => assert.equal(l.shadow.filterNode ?? null, null));
  // filter change is structural -> new node
  const ss3 = new SunShadows(sunRig().sun); const a = ss3.enable({ filter: 'smooth' }, { shadowMap: {} }); const b = ss3.enable({ filter: 'pcf' }, { shadowMap: {} });
  assert.notEqual(a, b);
});

test('vogelTaps: N points in the unit disk, weights sum to 1, centre-heavy, deterministic', () => {
  for (const n of [1, 4, 12, 24]) {
    const p = vogelTaps(n); assert.equal(p.length, n);
    assert.ok(p.every((t) => Math.hypot(t.x, t.y) <= 1 + 1e-9));
    assert.ok(Math.abs(p.reduce((s, t) => s + t.w, 0) - 1) < 1e-12);
  }
  const p = vogelTaps(12); assert.ok(p[0].w > p[11].w); assert.deepEqual(vogelTaps(12), p);
  // disk coverage: mean position ~ centre, spread in all quadrants
  assert.ok(p.some((t) => t.x > 0.1) && p.some((t) => t.x < -0.1) && p.some((t) => t.y > 0.1) && p.some((t) => t.y < -0.1));
  assert.ok(Math.abs(p.reduce((s, t) => s + t.x, 0) / 12) < 0.15);
});

test('makeSmoothFilter: switches the depth texture to Linear (hardware 2x2 compare) and returns a node', () => {
  const f = makeSmoothFilter(6); const dt = new THREE.DepthTexture(64, 64); dt.compareFunction = THREE.LessCompare;
  assert.equal(dt.magFilter, THREE.NearestFilter);
  const sh = sunRig().sun.shadow; sh.mapSize.set(64, 64);
  const out = f({ depthTexture: dt, shadowCoord: THREE.TSL.vec3(0.5, 0.5, 0.5), shadow: sh, depthLayer: 0 });
  assert.equal(dt.magFilter, THREE.LinearFilter); assert.equal(dt.minFilter, THREE.LinearFilter);
  assert.ok(out && out.isNode);
});

// ---- CSM texel snapping (three r180 CSMShadowNode.updateBefore) ----
function csm(cascades = 3, size = 2048) {
  const { scene, sun } = sunRig(); sun.shadow.mapSize.set(size, size);
  const node = new CSMShadowNode(sun, { cascades, maxFar: 400 }); node.fade = true;
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 20000); scene.add(cam);
  node._init({ camera: cam, renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem } });
  return { node, cam, sun };
}
const place = (cam, x, y, z, yaw) => { cam.position.set(x, y, z); cam.rotation.set(0, yaw, 0); cam.updateMatrixWorld(true); };
// light-space (x,y) of a cascade light in units of its texel; integers <=> projection snapped to the texel grid
function texelCoords(node, sun) {
  const m = new THREE.Matrix4().lookAt(sun.position, sun.target.position, new THREE.Vector3(0, 1, 0)).invert();
  return node.lights.map((l) => {
    const sc = l.shadow.camera, tw = (sc.right - sc.left) / l.shadow.mapSize.width, th = (sc.top - sc.bottom) / l.shadow.mapSize.height;
    const p = l.position.clone().applyMatrix4(m); return { x: p.x / tw, y: p.y / th };
  });
}
const frac = (v) => Math.abs(v - Math.round(v));

test('snapping: cascade origins sit on integer texels for arbitrary camera positions/yaws', () => {
  const { node, cam, sun } = csm();
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 40; k++) {
    place(cam, rnd() * 4000 - 2000, 1.6 + rnd() * 3, rnd() * 4000 - 2000, rnd() * 6.28);
    node.updateBefore();
    texelCoords(node, sun).forEach((t, i) => { assert.ok(frac(t.x) < 2e-2 && frac(t.y) < 2e-2, `k${k} c${i} ${t.x} ${t.y}`); });
  }
});

test('snapping: sub-texel camera motion never moves a cascade by a fractional texel (no crawl)', () => {
  const { node, cam, sun } = csm();
  place(cam, 1731.31, 1.6, 27.6, 1.5708); node.updateBefore();
  let prev = texelCoords(node, sun);
  const step = 0.013; // m per "frame" << smallest texel (0.096 m)
  for (let f = 1; f <= 400; f++) {
    place(cam, 1731.31 + f * step, 1.6, 27.6 - f * step * 0.37, 1.5708);
    node.updateBefore();
    const cur = texelCoords(node, sun);
    cur.forEach((t, i) => {
      const dx = t.x - prev[i].x, dy = t.y - prev[i].y;
      assert.ok(frac(dx) < 2e-2 && frac(dy) < 2e-2, `f${f} c${i} d=${dx},${dy}`); // whole-texel jumps only
    });
    prev = cur;
  }
});

test('snapping: cascade texel sizes at BP defaults are what the doc quotes (3 cascades, 400 m)', () => {
  const { node } = csm(3);
  const t = node.lights.map((l) => (l.shadow.camera.right - l.shadow.camera.left) / 2048);
  assert.ok(t[0] > 0.05 && t[0] < 0.15, String(t[0]));
  assert.ok(t[1] > t[0] && t[2] > t[1]);
});

// ---- slice overshoot + guard ----
function slab(z0, z1, hw) { const v = (z, s) => ({ x: s[0] * hw, y: s[1] * hw, z }); const q = (z) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map((s) => v(z, s)); return { vertices: { near: q(z0), far: q(z1) } }; }
// ortho map covering world x,y in [-10,10]: uv = (p + 10)/20
const coverM = () => new THREE.Matrix4().set(0.05, 0, 0, 0.5, 0, 0.05, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 1);

test('sliceOvershoot: 0 when the slice is inside the map, grows with the shift (uv units)', () => {
  const I = new THREE.Matrix4(), f = slab(0, 5, 4);
  assert.equal(sliceOvershoot(f, I, coverM()), 0);
  const sh = new THREE.Matrix4().makeTranslation(8, 0, 0); // slice x in [4,12] -> 2 m out -> 0.1 uv
  assert.ok(Math.abs(sliceOvershoot(f, sh, coverM()) - 0.1) < 1e-9);
  assert.ok(sliceOvershoot(f, new THREE.Matrix4().makeTranslation(0, -30, 0), coverM()) > 1);
});

const guardRig = (guard) => {
  const s = new SunShadows({}); const cam = { matrixWorld: new THREE.Matrix4() };
  const mk = () => ({ shadow: { autoUpdate: true, needsUpdate: false, matrix: coverM() } });
  s.node = { lights: [mk(), mk(), mk()], frustums: [slab(0, 3, 2), slab(3, 6, 4), slab(6, 9, 6)], camera: cam };
  s.config = { stagger: 2, guard };
  return { s, cam };
};
test('guard: nothing forced while every far cascade still covers its slice (no added render cost)', () => {
  const { s } = guardRig(true);
  for (let f = 0; f < 20; f++) { s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; }); s.tick(); assert.equal(s.guardForced, 0); }
  assert.equal(s.guardCount ?? 0, 0);
});
test('guard: a stale far cascade is rendered NOW, worst first, at most one forced per frame', () => {
  const { s, cam } = guardRig(true);
  s.node.frustums[1] = slab(3, 6, 4); s.node.frustums[2] = slab(6, 9, 6);
  cam.matrixWorld.makeTranslation(14, 0, 0); // both far slices now partly outside; cascade 2 (wider) further out
  s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; });
  s.tick(); // fc=1: stagger-2 -> no scheduled far render; guard must force exactly one
  const forced = s.node.lights.slice(1).filter((l) => l.shadow.needsUpdate).length;
  assert.equal(forced, 1); assert.ok(s.guardForced >= 1); assert.equal(s.guardCount, 1);
  assert.equal(s.guardForced, sliceOvershoot(s.node.frustums[1], cam.matrixWorld, s.node.lights[1].shadow.matrix) > sliceOvershoot(s.node.frustums[2], cam.matrixWorld, s.node.lights[2].shadow.matrix) ? 1 : 2);
});
test('guard: off by cfg.guard=false', () => {
  const { s, cam } = guardRig(false); cam.matrixWorld.makeTranslation(14, 0, 0);
  s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; }); s.tick();
  assert.equal(s.node.lights.slice(1).filter((l) => l.shadow.needsUpdate).length, 0);
});
test('guard: matrix never rendered (identity) is treated as stale -> first frame forces a render', () => {
  const { s } = guardRig(true); s.node.lights.forEach((l) => { l.shadow.matrix = new THREE.Matrix4(); l.shadow.needsUpdate = false; });
  s.tick(); assert.ok(s.node.lights.slice(1).some((l) => l.shadow.needsUpdate));
});
