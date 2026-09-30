// attachGI wraps NodeMaterial.setupLights the same way three attaches a
// light map (§GI-PROBES.md Material sampling). Built against real
// three/webgpu NodeMaterial + IrradianceNode — the wrap is exercised with a
// minimal fake builder (no GPU device needed to prove the array wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeMaterial, IrradianceNode } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { attachGI, detachGI } from '../client/kernel/gi/gi-material.js';

function fakeBuilder(material, lights = ['sun', 'hemi']) {
  const calls = [];
  return {
    material,
    lightsNode: { getLights: () => lights },
    renderer: { lighting: { createNode: (arr) => { calls.push(arr); return { isLightsNode: true, arr }; } } },
    _calls: calls,
  };
}

test('attachGI requires a NodeMaterial (setupLights present)', () => {
  assert.throws(() => attachGI({}, vec3(0, 0, 0)), /NodeMaterial/);
});

test('an unattached material never touches renderer.lighting.createNode', () => {
  const material = new NodeMaterial();
  const builder = fakeBuilder(material);
  material.setupLights(builder);
  assert.equal(builder._calls.length, 0);
});

test('attachGI pushes a real IrradianceNode wrapping the GI node alongside the existing lights', () => {
  const material = new NodeMaterial();
  const giNode = vec3(0.2, 0.2, 0.2);
  attachGI(material, giNode);
  const builder = fakeBuilder(material, ['sun', 'hemi']);
  material.setupLights(builder);
  assert.equal(builder._calls.length, 1);
  const combined = builder._calls[0];
  assert.equal(combined.length, 3); // 2 existing lights + 1 GI irradiance node
  assert.equal(combined[0], 'sun');
  assert.equal(combined[1], 'hemi');
  assert.ok(combined[2] instanceof IrradianceNode);
  assert.equal(combined[2].node, giNode);
});

test('attachGI is idempotent (re-attach does not double-push)', () => {
  const material = new NodeMaterial();
  attachGI(material, vec3(0, 0, 0));
  attachGI(material, vec3(1, 1, 1)); // second call must be a no-op
  const builder = fakeBuilder(material, ['sun']);
  material.setupLights(builder);
  assert.equal(builder._calls[0].length, 2); // still exactly +1, not +2
});

test('detachGI restores the original setupLights (no GI node leaks in)', () => {
  const material = new NodeMaterial();
  const original = material.setupLights;
  attachGI(material, vec3(0, 0, 0));
  detachGI(material, original);
  const builder = fakeBuilder(material, ['sun']);
  material.setupLights(builder);
  assert.equal(builder._calls.length, 0); // back to the untouched path
  assert.equal(material.__giAttached, false);
});

// removal-style mutation check: forgetting to spread the existing lights
// (only pushing the GI node) would silently drop the sun/hemi contribution
test('mutant: dropping ...lightsN.getLights() would lose the existing lights', () => {
  const material = new NodeMaterial();
  const giNode = vec3(0, 0, 0);
  const original = material.setupLights.bind(material);
  // mutant version of the wrap, GI-only, no spread of existing lights
  material.setupLights = function (builder) {
    original(builder);
    const giLighting = new IrradianceNode(giNode);
    return builder.renderer.lighting.createNode([giLighting]); // BUG
  };
  const builder = fakeBuilder(material, ['sun', 'hemi']);
  material.setupLights(builder);
  assert.equal(builder._calls[0].length, 1, 'mutant loses the pre-existing lights');
});
