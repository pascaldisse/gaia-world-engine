// End-to-end wiring test through the REAL environment.js component (not just
// GIController in isolation): proves the `environment` component's default
// (no gi param, or gi.enabled:false) leaves environment.gi.resources null
// — zero probe grid / storage / compute — and that passing gi:{enabled:true}
// through Environment.apply() (the exact path view.js's 'environment' case
// uses) builds real resources. No renderer.init() / GPU device needed since
// Environment only reads/writes plain properties on the renderer stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Environment } from '../client/kernel/environment.js';

function makeSceneAndRenderer() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101c30');
  scene.fog = new THREE.Fog('#101c30', 60, 280);
  const renderer = { toneMappingExposure: 1 }; // Environment only touches this field
  const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
  const sun = new THREE.DirectionalLight('#ffe2b0', 1.2);
  sun.position.set(60, 90, 30);
  return { scene, renderer, hemi, sun };
}

test('a freshly constructed Environment has GI off with nothing allocated', () => {
  const { scene, renderer, hemi, sun } = makeSceneAndRenderer();
  const env = new Environment({ renderer, scene, hemi, sun, post: null, audio: null });
  assert.equal(env.gi.enabled, false);
  assert.equal(env.gi.resources, null);
});

test('apply({}) (no gi key at all, the common case) keeps GI off', () => {
  const { scene, renderer, hemi, sun } = makeSceneAndRenderer();
  const env = new Environment({ renderer, scene, hemi, sun, post: null, audio: null });
  env.apply({});
  assert.equal(env.gi.enabled, false);
  assert.equal(env.gi.resources, null);
});

test('apply({gi:{enabled:false}}) stays off', () => {
  const { scene, renderer, hemi, sun } = makeSceneAndRenderer();
  const env = new Environment({ renderer, scene, hemi, sun, post: null, audio: null });
  env.apply({ gi: { enabled: false, raysPerProbe: 999 } });
  assert.equal(env.gi.resources, null);
});

test('apply({gi:{enabled:true, ...}}) builds real resources through the component boundary', () => {
  const { scene, renderer, hemi, sun } = makeSceneAndRenderer();
  const env = new Environment({ renderer, scene, hemi, sun, post: null, audio: null });
  env.apply({ gi: { enabled: true, spacing: 8, halfExtentXZ: 16, layersY: 2, heightRange: [0, 4], raysPerProbe: 8 } });
  assert.equal(env.gi.enabled, true);
  assert.ok(env.gi.resources);
  assert.equal(env.gi.resources.kernel.isComputeNode, true);
});

test('switching a scene\'s environment params (no gi key) after GI was enabled does not silently keep it enabled (apply always re-derives from defaults+params)', () => {
  const { scene, renderer, hemi, sun } = makeSceneAndRenderer();
  const env = new Environment({ renderer, scene, hemi, sun, post: null, audio: null });
  env.apply({ gi: { enabled: true, spacing: 8, halfExtentXZ: 16 } });
  assert.ok(env.gi.resources);
  env.apply({}); // a later scene switch that says nothing about gi
  assert.equal(env.gi.resources, null, 'apply() must fall back to GI_DEFAULTS.enabled=false, not remember the old state');
});
