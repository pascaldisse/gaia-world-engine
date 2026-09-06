import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  m4FromTRS, m4Mul, m4Invert, m4Decompose, m4IsDecomposable,
  normalizeByRoot, rootInverseMatrix, instanceRootLocal, trs, M4_IDENTITY,
} from '../tools/unity/prefab-roots.mjs';

// three.js is the INDEPENDENT oracle for every matrix claim here: a different
// implementation of the same algebra, not a second copy of ours.
const threeMatrix = ({ position, rotation, scale }) => new THREE.Matrix4().compose(
  new THREE.Vector3(position.x, position.y, position.z),
  new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
  new THREE.Vector3(scale.x, scale.y, scale.z),
);
const close = (actual, expected, what, eps = 1e-9) => {
  assert.equal(actual.length, expected.length, what);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < eps, `${what}[${i}]: ${value} != ${expected[i]}`));
};

// The real source values behind the live bug (raw Unity, re-typed here so the
// test states the case it protects):
//   prefab root  Building_ApartmentSmall_Red fragments rayfire v3 #6129902004204677189
const AUTHORED_ROOT = {
  position: { x: 44.351006, y: 0, z: -20.299002 },
  rotation: { x: 0, y: -1, z: 0, w: 0 },
  scale: { x: 1, y: 1.5, z: 1 },
};
//   scene PrefabInstance boomtown.unity #1776860175 -- position + rotation only
const SCENE_MODS = [
  { propertyPath: 'm_LocalPosition.x', value: 0 },
  { propertyPath: 'm_LocalPosition.y', value: 0 },
  { propertyPath: 'm_LocalPosition.z', value: 200 },
  { propertyPath: 'm_LocalRotation.w', value: 0 },
  { propertyPath: 'm_LocalRotation.x', value: -0 },
  { propertyPath: 'm_LocalRotation.y', value: 1 },
  { propertyPath: 'm_LocalRotation.z', value: -0 },
  { propertyPath: 'm_LocalEulerAnglesHint.x', value: 0 },
];

test('matrix helpers agree with three.js on compose, multiply, invert and decompose', () => {
  // normalized quaternion: an unnormalized one is not a rotation, and decompose
  // would legitimately not round-trip
  const q = new THREE.Quaternion(0.2, 0.3, -0.1, 0.927).normalize();
  const a = { position: { x: 3, y: -2, z: 7 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: { x: 2, y: 2, z: 2 } };
  const b = { position: { x: -1, y: 0.5, z: 4 }, rotation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 }, scale: { x: 1, y: 3, z: 1 } };
  close(m4FromTRS(a), [...threeMatrix(a).elements], 'compose', 1e-6);
  close(m4Mul(m4FromTRS(a), m4FromTRS(b)), [...threeMatrix(a).multiply(threeMatrix(b)).elements], 'multiply', 1e-6);
  close(m4Invert(m4FromTRS(a)), [...threeMatrix(a).invert().elements], 'invert', 1e-6);
  const decomposed = m4Decompose(m4FromTRS(a));
  close(m4FromTRS(decomposed), [...threeMatrix(a).elements], 'decompose round-trip', 1e-6);
  assert.equal(m4IsDecomposable(m4FromTRS(a)), true);
  assert.throws(() => m4Invert(m4FromTRS({ ...a, scale: { x: 0, y: 1, z: 1 } })), /singular/);
});

test('RULE 1: a descendant is expressed relative to the ROOT (the authored root cancels)', () => {
  // a child authored directly above the root origin, inside the prefab file
  const child = {
    position: { x: 44.351006, y: 38.080136, z: -20.299002 },
    rotation: AUTHORED_ROOT.rotation,
    scale: { x: 10, y: 15, z: 10 },
  };
  const normalized = normalizeByRoot(AUTHORED_ROOT, child);
  // three.js oracle: root^-1 * child
  const expected = threeMatrix(AUTHORED_ROOT).invert().multiply(threeMatrix(child));
  close(normalized.matrix, [...expected.elements], 'root-relative matrix', 1e-6);
  // the root offset is GONE -- this is the 44.35 / 20.30 leak that pushed the
  // building on top of the pickup
  assert.ok(Math.abs(normalized.position.x) < 1e-6, `x ${normalized.position.x}`);
  assert.ok(Math.abs(normalized.position.z) < 1e-6, `z ${normalized.position.z}`);
  assert.ok(Math.abs(normalized.position.y - 38.080136 / 1.5) < 1e-6, 'the root scale divides out too');
  close(rootInverseMatrix(AUTHORED_ROOT), [...threeMatrix(AUTHORED_ROOT).invert().elements], 'root inverse', 1e-6);
});

test('RULE 1: a sheared result is reported, never silently flattened to TRS', () => {
  // A child rotated OFF the root's scaling axis. The root scales Y only, and a
  // rotation ABOUT Y commutes with that scale (no shear) -- so the case that
  // actually breaks TRS is a rotation about X or Z.
  const rotatedChild = {
    position: { x: 44, y: 5, z: -20 },
    rotation: { x: 0.3826834, y: 0, z: 0, w: 0.9238795 }, // 45 deg about X
    scale: { x: 1, y: 1, z: 1 },
  };
  const sheared = normalizeByRoot(AUTHORED_ROOT, rotatedChild);
  const oracle = threeMatrix(AUTHORED_ROOT).invert().multiply(threeMatrix(rotatedChild));
  close(sheared.matrix, [...oracle.elements], 'sheared matrix', 1e-6);
  assert.equal(sheared.decomposable, false, 'TRS cannot represent this -- the caller must refuse');
  // an aligned child under the same root is representable
  const aligned = normalizeByRoot(AUTHORED_ROOT, { ...rotatedChild, rotation: AUTHORED_ROOT.rotation });
  assert.equal(aligned.decomposable, true);
  // and so is a child rotated about the scaling axis itself (Y): that commutes
  const aboutY = normalizeByRoot(AUTHORED_ROOT, { ...rotatedChild, rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 } });
  assert.equal(aboutY.decomposable, true, 'rotation about the scaled axis does not shear');
  // a uniform root never shears
  const uniform = { ...AUTHORED_ROOT, scale: { x: 2, y: 2, z: 2 } };
  assert.equal(normalizeByRoot(uniform, rotatedChild).decomposable, true);
});

test('RULE 2: instance overrides REPLACE the authored root per axis, absent axes INHERIT it', () => {
  const { local, overridden } = instanceRootLocal(AUTHORED_ROOT, SCENE_MODS);
  assert.deepEqual(local.position, { x: 0, y: 0, z: 200 }, 'position fully overridden');
  assert.deepEqual(local.rotation, { x: -0, y: 1, z: -0, w: 0 }, 'rotation fully overridden');
  // THE LIVE DEFECT: no m_LocalScale override -> the authored (1, 1.5, 1) must
  // survive. The old importer assumed identity and emitted no scale at all.
  assert.deepEqual(local.scale, { x: 1, y: 1.5, z: 1 }, 'scale inherited from the authored root');
  assert.deepEqual(overridden, { position: true, rotation: true, scale: false });

  // partial position override: only x is named
  const partial = instanceRootLocal(AUTHORED_ROOT, [{ propertyPath: 'm_LocalPosition.x', value: 5 }]);
  assert.deepEqual(partial.local.position, { x: 5, y: 0, z: -20.299002 });
  assert.deepEqual(partial.local.rotation, AUTHORED_ROOT.rotation);
  assert.deepEqual(partial.local.scale, AUTHORED_ROOT.scale);

  // no overrides at all: the instance IS the authored root
  const none = instanceRootLocal(AUTHORED_ROOT, []);
  assert.deepEqual(none.local, trs(AUTHORED_ROOT));
  assert.deepEqual(none.overridden, { position: false, rotation: false, scale: false });

  // an unparsable override is a data defect, not a silent 0
  assert.throws(() => instanceRootLocal(AUTHORED_ROOT, [{ propertyPath: 'm_LocalScale.y', value: 'big' }]),
    /m_LocalScale\.y is not a finite number/);
  // unrelated property paths are ignored
  const hinted = instanceRootLocal(AUTHORED_ROOT, [{ propertyPath: 'm_Name', value: 'x' }]);
  assert.deepEqual(hinted.local, trs(AUTHORED_ROOT));
});

test('the two rules together reproduce the scene pose (three.js chain oracle)', () => {
  // A descendant's FINAL world = instanceRoot * (root^-1 * childWorldInPrefab).
  const child = {
    position: { x: 44.494279, y: 28.283986, z: -20.442275 },
    rotation: { x: 0, y: -0.9238795, z: 0, w: 0.3826834 },
    scale: { x: 10, y: 15, z: 10 },
  };
  const { local: instanceRoot } = instanceRootLocal(AUTHORED_ROOT, SCENE_MODS);
  const normalized = normalizeByRoot(AUTHORED_ROOT, child);
  const final = m4Mul(m4FromTRS(instanceRoot), normalized.matrix);
  // oracle: instanceRoot * root^-1 * child, all through three.js
  const oracle = threeMatrix(instanceRoot).multiply(threeMatrix(AUTHORED_ROOT).invert()).multiply(threeMatrix(child));
  close(final, [...oracle.elements], 'final world', 1e-6);

  // and the OLD behaviour (bake the authored root, then apply the instance root)
  // lands somewhere else entirely -- that gap is the live bug
  const old = m4Mul(m4FromTRS(instanceRoot), m4FromTRS(child));
  const gap = Math.hypot(final[12] - old[12], final[13] - old[13], final[14] - old[14]);
  assert.ok(gap > 40, `the double-root gap should be tens of metres, got ${gap}`);

  // sanity: identity root changes nothing
  const identityRoot = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } };
  close(normalizeByRoot(identityRoot, child).matrix, [...threeMatrix(child).elements], 'identity root', 1e-9);
  close(m4Mul(M4_IDENTITY, m4FromTRS(child)), [...threeMatrix(child).elements], 'identity multiply', 1e-9);
});
