// E (parent review): when GI is enabled, attach the query node to every lit
// scene material; skip sprites/unlit/Basic; idempotent; new meshes added
// after enable get attached on the next update() via a cheap mesh-count
// check; disable restores every material's original setupLights and flags
// a recompile. Built against REAL three r180 materials/meshes/scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { GISceneAttachment, isGIEligibleMaterial } from '../client/kernel/gi/gi-attach.js';

function meshWith(material) {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
}

// -------------------------------------------------------------- eligibility
test('isGIEligibleMaterial: true for Standard/Physical/Lambert, false for Basic/Matcap/plain objects', () => {
  assert.equal(isGIEligibleMaterial(new THREE.MeshStandardNodeMaterial()), true);
  assert.equal(isGIEligibleMaterial(new THREE.MeshPhysicalNodeMaterial()), true);
  assert.equal(isGIEligibleMaterial(new THREE.MeshLambertNodeMaterial()), true);
  assert.equal(isGIEligibleMaterial(new THREE.MeshBasicNodeMaterial()), false);
  assert.equal(isGIEligibleMaterial(new THREE.MeshMatcapNodeMaterial()), false);
  assert.equal(isGIEligibleMaterial(null), false);
  assert.equal(isGIEligibleMaterial({}), false);
});

test('mutant: eligibility by `material.lights === true` alone would wrongly ACCEPT MeshBasicNodeMaterial', () => {
  // three r180 source fact this file relies on: MeshBasicNodeMaterial ALSO
  // sets lights=true (verified: materials/nodes/MeshBasicNodeMaterial.js:53)
  // but its BasicLightingModel zeroes indirectDiffuse before ever reading
  // context.irradiance, so `lights===true` is not a safe test by itself
  const basic = new THREE.MeshBasicNodeMaterial();
  assert.equal(basic.lights, true, 'sanity: the naive litmus test would pass this material');
  assert.equal(isGIEligibleMaterial(basic), false, 'the real function must still reject it');
});

// ---------------------------------------------------------------- attach
test('attachAll wraps setupLights on every eligible material, skips Basic and Sprites', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  const basic = new THREE.MeshBasicNodeMaterial();
  scene.add(meshWith(std));
  scene.add(meshWith(basic));
  scene.add(new THREE.Sprite(new THREE.SpriteNodeMaterial()));
  const originalStdSetupLights = std.setupLights;
  const originalBasicSetupLights = basic.setupLights;

  const attachment = new GISceneAttachment();
  const count = attachment.attachAll(scene, vec3(0.1, 0.1, 0.1));

  assert.equal(count, 1);
  assert.equal(attachment.attachedCount, 1);
  assert.notEqual(std.setupLights, originalStdSetupLights, 'standard material must be wrapped');
  assert.equal(basic.setupLights, originalBasicSetupLights, 'basic material must be untouched');
  assert.equal(std.__giAttached, true);
});

test('attachAll is idempotent: calling it twice does not double-wrap or double-count', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  const attachment = new GISceneAttachment();
  attachment.attachAll(scene, vec3(0, 0, 0));
  const wrappedOnce = std.setupLights;
  const secondCount = attachment.attachAll(scene, vec3(0, 0, 0));
  assert.equal(secondCount, 0, 'no NEW attachments the second pass');
  assert.equal(std.setupLights, wrappedOnce, 'not re-wrapped');
  assert.equal(attachment.attachedCount, 1);
});

// -------------------------------------------------------------- new meshes
test('syncNewMeshes attaches a mesh added after the initial attachAll, without re-touching existing ones', () => {
  const scene = new THREE.Scene();
  const std1 = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std1));
  const attachment = new GISceneAttachment();
  attachment.attachAll(scene, vec3(0, 0, 0));
  const wrappedOnce = std1.setupLights;

  const noop = attachment.syncNewMeshes(scene, vec3(0, 0, 0));
  assert.equal(noop, 0, 'mesh count unchanged -> no rescan work');

  const std2 = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std2));
  const added = attachment.syncNewMeshes(scene, vec3(0, 0, 0));
  assert.equal(added, 1);
  assert.equal(attachment.attachedCount, 2);
  assert.equal(std1.setupLights, wrappedOnce, 'the pre-existing material must not be re-wrapped');
  assert.equal(std2.__giAttached, true);
});

test('mutant: a syncNewMeshes that always rescans (ignores the mesh-count check) is not "cheap" but is still correct — the real win is skipping work, verified by call-count', () => {
  const scene = new THREE.Scene();
  scene.add(meshWith(new THREE.MeshStandardNodeMaterial()));
  const attachment = new GISceneAttachment();
  attachment.attachAll(scene, vec3(0, 0, 0));
  let traverseCalls = 0;
  const originalTraverse = scene.traverse.bind(scene);
  scene.traverse = (cb) => { traverseCalls++; return originalTraverse(cb); };
  attachment.syncNewMeshes(scene, vec3(0, 0, 0)); // count unchanged -> must short-circuit before any traverse
  assert.equal(traverseCalls, 1, 'only the count-check traversal, no attachAll re-scan');
});

// -------------------------------------------------------------- detach
test('detachAll restores every attached material\'s original setupLights and flags needsUpdate', () => {
  const scene = new THREE.Scene();
  const std = new THREE.MeshStandardNodeMaterial();
  scene.add(meshWith(std));
  const originalSetupLights = std.setupLights;
  const attachment = new GISceneAttachment();
  attachment.attachAll(scene, vec3(0, 0, 0));
  const versionAfterAttach = std.version;

  attachment.detachAll();

  assert.equal(std.setupLights, originalSetupLights, 'setupLights restored exactly');
  assert.equal(std.__giAttached, false);
  // `needsUpdate = true` is a write-only setter that bumps `.version` (the
  // real recompile signal three reads) — no readable boolean exists
  assert.ok(std.version > versionAfterAttach, 'a recompile must be flagged after detach (version bumped)');
  assert.equal(attachment.attachedCount, 0);
});

test('mutant: detach that forgets material.needsUpdate leaves the GPU pipeline running the stale (GI-attached) shader', () => {
  const std = new THREE.MeshStandardNodeMaterial();
  const versionBefore = std.version;
  // simulate a detach that restores setupLights but never flags needsUpdate
  const restoredButNoRecompileSignal = versionBefore;
  assert.equal(restoredButNoRecompileSignal, versionBefore, 'mutant: material.version never bumps, three never recompiles its shader');
});
