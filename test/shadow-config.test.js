import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { SHADOW_DEFAULTS, shadowSpec, applyShadow } from '../client/kernel/shadow-config.js';
import { Environment } from '../client/kernel/environment.js';

// --- defaults: bias is the intended fix, shadows stay ON --------------------

test('engine shadow defaults keep shadows enabled and carry an anti-acne bias', () => {
  // enabled true => this is NOT the "turn shadows off" fix; directional cast
  // shadows still render. bias<0 + normalBias>0 are the acne cure.
  expect(SHADOW_DEFAULTS.enabled).toBe(true);
  expect(SHADOW_DEFAULTS.bias).toBeLessThan(0);
  expect(SHADOW_DEFAULTS.normalBias).toBeGreaterThan(0);
  expect(Object.isFrozen(SHADOW_DEFAULTS)).toBe(true);
});

// --- pure resolver ----------------------------------------------------------

test('shadowSpec: null/garbage -> engine defaults', () => {
  expect(shadowSpec()).toEqual({ ...SHADOW_DEFAULTS });
  expect(shadowSpec(null)).toEqual({ ...SHADOW_DEFAULTS });
  expect(shadowSpec(42)).toEqual({ ...SHADOW_DEFAULTS });
  // invalid per-field values fall back individually
  expect(shadowSpec({ mapSize: -5, radius: 0, far: 'x', normalBias: -1 })).toEqual({ ...SHADOW_DEFAULTS });
});

test('shadowSpec: partial override merges, keeps other fields at default', () => {
  const s = shadowSpec({ bias: -0.001, normalBias: 0 });
  expect(s.bias).toBe(-0.001);
  expect(s.normalBias).toBe(0); // 0 is valid (tighter contacts, more acne risk)
  expect(s.mapSize).toBe(SHADOW_DEFAULTS.mapSize);
  expect(s.radius).toBe(SHADOW_DEFAULTS.radius);
  expect(s.enabled).toBe(true);
});

test('shadowSpec: enabled:false authors a shadowless sun', () => {
  expect(shadowSpec({ enabled: false }).enabled).toBe(false);
});

test('shadowSpec: a positive sub-1 mapSize clamps to >=1, never rounds to 0', () => {
  expect(shadowSpec({ mapSize: 0.1 }).mapSize).toBe(1);
  expect(shadowSpec({ mapSize: 0.9 }).mapSize).toBe(1);
  expect(shadowSpec({ mapSize: 1.4 }).mapSize).toBe(1);
  expect(shadowSpec({ mapSize: 1023.6 }).mapSize).toBe(1024);
  // non-positive still falls back to the default
  expect(shadowSpec({ mapSize: 0 }).mapSize).toBe(SHADOW_DEFAULTS.mapSize);
  expect(shadowSpec({ mapSize: -8 }).mapSize).toBe(SHADOW_DEFAULTS.mapSize);
});

test('shadowSpec: far must stay strictly past near (no degenerate frustum)', () => {
  // far<=near supplied -> default far (which is > near)
  expect(shadowSpec({ near: 10, far: 5 }).far).toBe(SHADOW_DEFAULTS.far);
  expect(shadowSpec({ near: 10, far: 10 }).far).toBe(SHADOW_DEFAULTS.far);
  // near larger than the default far -> push just past near
  const s = shadowSpec({ near: 900, far: 100 });
  expect(s.near).toBe(900);
  expect(s.far).toBeGreaterThan(s.near);
  // a valid far is kept
  expect(shadowSpec({ near: 1, far: 250 }).far).toBe(250);
});

// --- applyShadow mutates a real light --------------------------------------

test('applyShadow writes the resolved spec onto a DirectionalLight shadow', () => {
  const light = new THREE.DirectionalLight('#fff', 1);
  const s = applyShadow(light, { mapSize: 1024, radius: 80, far: 300, bias: -0.001, normalBias: 0.2 });
  expect(light.castShadow).toBe(true);
  expect(light.shadow.mapSize.x).toBe(1024);
  expect(light.shadow.mapSize.y).toBe(1024);
  expect(light.shadow.camera.left).toBe(-80);
  expect(light.shadow.camera.right).toBe(80);
  expect(light.shadow.camera.top).toBe(80);
  expect(light.shadow.camera.bottom).toBe(-80);
  expect(light.shadow.camera.far).toBe(300);
  expect(light.shadow.bias).toBe(-0.001);
  expect(light.shadow.normalBias).toBe(0.2);
  expect(s.normalBias).toBe(0.2);
});

test('applyShadow default configures the anti-acne bias with shadows on', () => {
  const light = new THREE.DirectionalLight('#fff', 1);
  applyShadow(light);
  expect(light.castShadow).toBe(true);
  expect(light.shadow.bias).toBe(SHADOW_DEFAULTS.bias);
  expect(light.shadow.normalBias).toBe(SHADOW_DEFAULTS.normalBias);
});

test('applyShadow enabled:false disables the caster (no shadow map render)', () => {
  const light = new THREE.DirectionalLight('#fff', 1);
  applyShadow(light);
  expect(light.castShadow).toBe(true);
  applyShadow(light, { enabled: false });
  expect(light.castShadow).toBe(false);
});

// --- Environment routes an authored env override onto the sun ---------------

function makeEnv() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101c30');
  scene.fog = new THREE.Fog('#101c30', 60, 280);
  const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
  const sun = new THREE.DirectionalLight('#ffe2b0', 1.2);
  sun.position.set(60, 90, 30);
  applyShadow(sun); // renderer.js does this
  const renderer = { toneMappingExposure: 1 };
  const post = { setBloom() {} };
  return { env: new Environment({ renderer, scene, hemi, sun, post }), sun };
}

test('unconfigured world keeps the engine shadow defaults on the sun', () => {
  const { env, sun } = makeEnv();
  env.apply(null);
  expect(sun.castShadow).toBe(true);
  expect(sun.shadow.bias).toBe(SHADOW_DEFAULTS.bias);
  expect(sun.shadow.normalBias).toBe(SHADOW_DEFAULTS.normalBias);
});

test('authored env sun.shadow override reaches the live sun light', () => {
  const { env, sun } = makeEnv();
  env.apply({ sun: { intensity: 2.1, shadow: { bias: -0.001, normalBias: 0.1, mapSize: 4096 } } });
  expect(sun.intensity).toBe(2.1);
  expect(sun.shadow.bias).toBe(-0.001);
  expect(sun.shadow.normalBias).toBe(0.1);
  expect(sun.shadow.mapSize.x).toBe(4096);
});

test('env sun override without a shadow block leaves engine shadow defaults intact', () => {
  const { env, sun } = makeEnv();
  env.apply({ sun: { intensity: 2.1 } });
  expect(sun.shadow.bias).toBe(SHADOW_DEFAULTS.bias);
  expect(sun.shadow.normalBias).toBe(SHADOW_DEFAULTS.normalBias);
});

test('a world may author a shadowless sun through the environment', () => {
  const { env, sun } = makeEnv();
  env.apply({ sun: { shadow: { enabled: false } } });
  expect(sun.castShadow).toBe(false);
});
