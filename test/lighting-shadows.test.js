// S1 — CSM sun shadows: defaults OFF, node graph construction, markShadows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { LightingController, LIGHTING_DEFAULTS, SHADOW_DEFAULTS, markShadows } from '../client/kernel/lighting/index.js';

function rig() {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight('#ffe2b0', 1.2);
  sun.position.set(60, 90, 30);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
  scene.add(hemi);
  return { scene, sun, hemi, renderer: { toneMappingExposure: 1 } };
}

test('config defaults OFF; shadow defaults match the spec (4 cascades, 600 m, 2048)', () => {
  assert.equal(LIGHTING_DEFAULTS.enabled, false);
  assert.equal(SHADOW_DEFAULTS.cascades, 4);
  assert.equal(SHADOW_DEFAULTS.maxFar, 600);
  assert.equal(SHADOW_DEFAULTS.mapSize, 2048);
  assert.equal(SHADOW_DEFAULTS.fade, true);
});

test('fresh controller and configure({}) leave the sun light untouched', () => {
  const r = rig();
  const before = { cast: r.sun.castShadow, node: r.sun.shadow.shadowNode, w: r.sun.shadow.mapSize.x };
  const lc = new LightingController(r);
  lc.configure({});
  lc.configure({ enabled: false, shadows: { cascades: 8 } });
  assert.equal(lc.enabled, false);
  assert.equal(lc.sunShadows.node, null);
  assert.equal(r.sun.castShadow, before.cast);
  assert.equal(r.sun.shadow.shadowNode, before.node);
  assert.equal(r.sun.shadow.mapSize.x, before.w);
});

test('enabled:true attaches a CSMShadowNode with the configured cascades/maxFar/mapSize', () => {
  const r = rig();
  const lc = new LightingController(r);
  lc.configure({ enabled: true, shadows: { cascades: 3, maxFar: 450, mapSize: 1024, bias: -0.001, normalBias: 0.07 } });
  const n = r.sun.shadow.shadowNode;
  assert.ok(n instanceof CSMShadowNode);
  assert.equal(n.cascades, 3);
  assert.equal(n.maxFar, 450);
  assert.equal(n.fade, true);
  assert.equal(r.sun.castShadow, true);
  assert.equal(r.sun.shadow.mapSize.x, 1024);
  assert.equal(r.sun.shadow.bias, -0.001);
  assert.equal(r.sun.shadow.normalBias, 0.07);
});

test('defaults when enabled with no shadows key: 4 cascades, 600 m, 2048', () => {
  const r = rig();
  const lc = new LightingController(r);
  lc.configure({ enabled: true });
  const n = r.sun.shadow.shadowNode;
  assert.equal(n.cascades, 4);
  assert.equal(n.maxFar, 600);
  assert.equal(r.sun.shadow.mapSize.x, 2048);
});

test('re-configure without structural change keeps the SAME node; structural change rebuilds', () => {
  const r = rig();
  const lc = new LightingController(r);
  lc.configure({ enabled: true });
  const a = r.sun.shadow.shadowNode;
  lc.configure({ enabled: true, shadows: { bias: -0.002 } });
  assert.equal(r.sun.shadow.shadowNode, a);
  assert.equal(r.sun.shadow.bias, -0.002);
  lc.configure({ enabled: true, shadows: { cascades: 2 } });
  assert.notEqual(r.sun.shadow.shadowNode, a);
  assert.equal(r.sun.shadow.shadowNode.cascades, 2);
});

test('disable restores the original light state exactly', () => {
  const r = rig();
  r.sun.castShadow = false;
  const lc = new LightingController(r);
  lc.configure({ enabled: true });
  assert.equal(r.sun.castShadow, true);
  lc.configure({ enabled: false });
  assert.equal(r.sun.castShadow, false);
  assert.equal(r.sun.shadow.shadowNode ?? null, null);
  assert.equal(r.sun.shadow.mapSize.x, 512);
});

test('markShadows sets cast+receive on meshes, honours userData.noShadow, skips non-meshes', () => {
  const root = new THREE.Group();
  const g = new THREE.BoxGeometry();
  const m = new THREE.MeshBasicMaterial();
  const a = new THREE.Mesh(g, m);
  const b = new THREE.Mesh(g, m);
  b.userData.noShadow = true;
  b.castShadow = true;
  const inst = new THREE.InstancedMesh(g, m, 2);
  const nested = new THREE.Group();
  const c = new THREE.Mesh(g, m);
  nested.add(c);
  root.add(a, b, inst, nested, new THREE.Object3D());
  const n = markShadows(root);
  assert.equal(n, 3);
  assert.equal(a.castShadow && a.receiveShadow, true);
  assert.equal(c.castShadow && c.receiveShadow, true);
  assert.equal(inst.castShadow, true);
  assert.equal(b.castShadow, false);
  assert.equal(b.receiveShadow, false);
});

test('syncCamera before first compile is a no-op; after _init it retargets + refreshes frustums', () => {
  const r = rig();
  const lc = new LightingController(r);
  lc.configure({ enabled: true });
  const cam = new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);
  lc.setCamera(cam); // node.camera === null → must not throw
  const n = r.sun.shadow.shadowNode;
  assert.equal(n.camera, null);
  // emulate the builder's _init
  n._init({ camera: cam, renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem } });
  const cam2 = new THREE.PerspectiveCamera(50, 2, 0.5, 2000);
  lc.setCamera(cam2);
  assert.equal(n.camera, cam2);
  assert.equal(n.frustums.length, 4);
});
