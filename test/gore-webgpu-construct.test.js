// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §5 test 14: a real three r180 webgpu+tsl construct test (skip only if the
// module is missing; report skip count). "No browser/no ports" (task law)
// means no WebGPUDevice/adapter is available here, so this proves
// construction of REAL three/webgpu + three/tsl objects (NodeMaterial,
// InstancedMesh, TSL node graphs) -- not mocks/fakes -- rather than an
// actual GPU draw. Every other gore-*.test.js already does this implicitly
// (real `three/webgpu` + `three/tsl` imports throughout); this file is the
// dedicated, explicit §5.14 checkpoint plus the skip-count report.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let skipCount = 0;
let three = null, tsl = null;
try {
  three = await import('three/webgpu');
  tsl = await import('three/tsl');
} catch {
  skipCount++;
}

test('three/webgpu + three/tsl module resolution', { skip: !three || !tsl ? 'three/webgpu or three/tsl not installed' : false }, () => {
  assert.ok(three.WebGPURenderer, 'real WebGPURenderer export must exist');
  assert.ok(three.NodeMaterial, 'real NodeMaterial export must exist');
  assert.ok(tsl.vec3 && tsl.instancedBufferAttribute, 'real TSL node builders must exist');
});

test('construct a real InstancedMesh + SpriteNodeMaterial + TSL colour node graph (no GPU device needed)', { skip: !three || !tsl ? 'three/webgpu or three/tsl not installed' : false }, () => {
  const geo = new three.BoxGeometry(0.03, 0.03, 0.03);
  const material = new three.MeshBasicNodeMaterial({ transparent: true });
  const colorAttr = new three.InstancedBufferAttribute(new Float32Array(4 * 4), 4);
  geo.setAttribute('goreXConstructTest', colorAttr);
  material.colorNode = tsl.instancedBufferAttribute(colorAttr, 'vec4');
  const mesh = new three.InstancedMesh(geo, material, 4);
  assert.ok(mesh.isInstancedMesh);
  assert.ok(material.isNodeMaterial);
  assert.ok(material.colorNode?.isNode, 'colorNode must be a real TSL Node instance');
  mesh.dispose?.();
  geo.dispose();
  material.dispose();
});

test('construct the extension itself against real three/webgpu + three/tsl', { skip: !three || !tsl ? 'three/webgpu or three/tsl not installed' : false }, async () => {
  const { createGore } = await import('../client/extensions/gore/index.js');
  const scene = new three.Scene();
  const gore = createGore({ three, tsl, scene });
  assert.ok(gore.blood.splash([0, 1, 0], [0, 1, 0], 1) > 0);
  gore.dispose();
});

test('report: module-missing skip count', () => {
  // this test itself never skips -- it just surfaces the count for the report
  assert.equal(typeof skipCount, 'number');
  if (skipCount > 0) console.log(`§5.14: three/webgpu or three/tsl missing -- ${skipCount} construct test(s) skipped`);
  else console.log('§5.14: three/webgpu + three/tsl present -- 0 skipped');
});
