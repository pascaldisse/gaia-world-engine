import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { parseFile } from '../tools/unity/parse.mjs';
import { loadGuidDb } from '../tools/unity/unity-yaml.mjs';
import { m4FromTRS, m4Mul, m4Invert } from '../tools/unity/prefab-roots.mjs';

// REAL Unity source + the game's existing guid db. Read-only; nothing is written
// into either project.
const UNITY = process.env.BOOMTOWN_UNITY_PROJECT ?? '/Users/pascaldisse/projects/boomtown-rampage';
const GUIDS = process.env.BOOMTOWN_GUID_DB ?? '/Users/pascaldisse/projects/boomtown-rampage-gwe/tools/unity/out/guids.json';
const BUILDING = path.join(UNITY, 'Assets/Modular Buildings/Building_ApartmentSmall_Red fragments rayfire v3.prefab');
const SCENE = path.join(UNITY, 'Assets/Scenes/boomtown.unity');
const have = fs.existsSync(BUILDING) && fs.existsSync(SCENE) && fs.existsSync(GUIDS);
if (!have) throw new Error(`real Unity source + guid db required (${UNITY}, ${GUIDS})`);

const guidDb = await loadGuidDb(GUIDS);
const prefabIR = await parseFile(BUILDING, guidDb);
const sceneIR = await parseFile(SCENE, guidDb);

const threeMatrix = (t) => new THREE.Matrix4().compose(
  new THREE.Vector3(t.position.x, t.position.y, t.position.z),
  new THREE.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w),
  new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z),
);
const close = (actual, expected, what, eps = 1e-4) => actual.forEach((value, i) => assert.ok(
  Math.abs(value - expected[i]) < eps, `${what}[${i}]: ${value} != ${expected[i]}`));

const ROOT_FILE_ID = '6129902004204677189';
const BUILDING_GUID = 'f104c085e5f279c43b84490e7bb89cdf';

test('the prefab root is read from the file, with its authored non-uniform scale', () => {
  const root = prefabIR.entities.find((e) => e.transform?.fileID === ROOT_FILE_ID);
  assert.ok(root, 'root transform present');
  assert.deepEqual(root.transform.local.position, { x: 44.351006, y: 0, z: -20.299002 });
  assert.deepEqual(root.transform.local.rotation, { x: 0, y: -1, z: 0, w: 0 });
  assert.deepEqual(root.transform.local.scale, { x: 1, y: 1.5, z: 1 });
  // the root itself is root-relative IDENTITY: its pose belongs to whoever
  // instantiates the prefab, never to its own contents
  close(root.transform.rootRelative, [...new THREE.Matrix4().elements], 'root rootRelative');
  assert.equal(root.transform.rootTransformFileID, ROOT_FILE_ID);
});

test('every descendant is root-relative and EXACT (three.js chain oracle, raw locals)', () => {
  const rootLocal = prefabIR.entities.find((e) => e.transform?.fileID === ROOT_FILE_ID).transform.local;
  const rootMatrix = threeMatrix(rootLocal);
  const byTransform = new Map(prefabIR.entities.filter((e) => e.transform).map((e) => [e.transform.fileID, e]));
  let checked = 0;
  for (const entity of prefabIR.entities) {
    if (!entity.transform || entity.transform.fileID === ROOT_FILE_ID) continue;
    assert.equal(entity.transform.rootTransformFileID, ROOT_FILE_ID, `${entity.name} belongs to the root`);
    // independent chain: multiply the RAW locals from the root down
    const chain = [];
    let cursor = entity;
    while (cursor && cursor.transform.fileID !== ROOT_FILE_ID) {
      chain.unshift(cursor.transform.local);
      cursor = byTransform.get(cursor.transform.parentTransformFileID);
    }
    assert.ok(cursor, `${entity.name} reaches the root`);
    const oracle = chain.reduce((m, local) => m.multiply(threeMatrix(local)), new THREE.Matrix4());
    close(entity.transform.rootRelative, [...oracle.elements], `${entity.name} rootRelative`);
    // and, for this prefab (no shear on these children), it equals root^-1 * world
    const viaInverse = rootMatrix.clone().invert().multiply(threeMatrix(entity.transform.world));
    close(entity.transform.rootRelative, [...viaInverse.elements], `${entity.name} vs root^-1*world`, 1e-3);
    // the authored root offset is GONE from the child
    checked++;
  }
  assert.ok(checked > 400, `expected the whole fragment set, checked ${checked}`);
});

test('the scene instance root REPLACES position+rotation and INHERITS the authored scale', () => {
  const instance = sceneIR.prefabInstances.find((pi) => pi.fileID === '1776860175');
  assert.ok(instance, 'PrefabInstance 1776860175 present');
  assert.deepEqual(instance.transform.local.position, { x: 0, y: 0, z: 200 });
  assert.deepEqual(instance.transform.local.rotation, { x: -0, y: 1, z: -0, w: 0 });
  // THE LIVE DEFECT: no m_LocalScale override in the scene -> inherit (1, 1.5, 1)
  assert.deepEqual(instance.transform.local.scale, { x: 1, y: 1.5, z: 1 });
  assert.deepEqual(instance.authoredRoot.scale, { x: 1, y: 1.5, z: 1 });
});

test('ALL instances of that prefab inherit the authored scale (Nyari 028cd13: 95, zero scale overrides)', () => {
  const instances = sceneIR.prefabInstances.filter((pi) => pi.source?.guid === BUILDING_GUID);
  assert.ok(instances.length >= 95, `expected at least 95 instances, found ${instances.length}`);
  for (const instance of instances) {
    assert.deepEqual(instance.transform.local.scale, { x: 1, y: 1.5, z: 1 }, `${instance.fileID} scale`);
    assert.deepEqual(instance.authoredRoot.position, { x: 44.351006, y: 0, z: -20.299002 });
    // position/rotation ARE overridden per instance, so they differ from the authored root
    assert.ok(instance.transform.local.position.x !== 44.351006 || instance.transform.local.position.z !== -20.299002,
      `${instance.fileID} keeps the authored position`);
  }
});

test('other prefab families keep their own authored roots (roads and the rest of the scene)', () => {
  const withAuthored = sceneIR.prefabInstances.filter((pi) => pi.authoredRoot);
  assert.ok(withAuthored.length > 100, `authored roots resolved for ${withAuthored.length} instances`);
  // a road/static family: whatever its authored root is, an instance that does
  // not override an axis must equal the authored value on that axis
  let inheritedAxes = 0;
  for (const instance of withAuthored) {
    const authored = instance.authoredRoot;
    const local = instance.transform.local;
    for (const axis of ['x', 'y', 'z']) {
      if (local.scale[axis] === authored.scale[axis]) inheritedAxes++;
      assert.ok(Number.isFinite(local.position[axis]) && Number.isFinite(local.scale[axis]));
    }
  }
  assert.ok(inheritedAxes > 0, 'at least some axes are inherited rather than reset to 1');
  // no instance may silently carry a zero scale (the old identity default could)
  for (const instance of withAuthored) {
    const s = instance.transform.local.scale;
    assert.ok(s.x !== 0 && s.y !== 0 && s.z !== 0, `${instance.fileID} has a zero scale axis`);
  }
});

// ---- synthetic root fixtures ------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-roots-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
async function parseYaml(name, lines) {
  const file = path.join(tmp, `${++seq}-${name}`);
  await fsp.writeFile(file, ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...lines, ''].join('\n'));
  return { file, ir: await parseFile(file, guidDb) };
}
const go = (id, name, componentIds) => [
  `--- !u!1 &${id}`, 'GameObject:', '  serializedVersion: 6', '  m_Component:',
  ...componentIds.map((c) => `  - component: {fileID: ${c}}`),
  `  m_Name: ${name}`, '  m_IsActive: 1',
];
const tr = (id, goId, { pos = '{x: 0, y: 0, z: 0}', rot = '{x: 0, y: 0, z: 0, w: 1}', scale = '{x: 1, y: 1, z: 1}', father = 0, children = [] } = {}) => [
  `--- !u!4 &${id}`, 'Transform:', `  m_GameObject: {fileID: ${goId}}`,
  `  m_LocalRotation: ${rot}`, `  m_LocalPosition: ${pos}`, `  m_LocalScale: ${scale}`,
  '  m_Children:', ...children.map((c) => `  - {fileID: ${c}}`), `  m_Father: {fileID: ${father}}`,
];

test('identity, minimal and variant-style roots all normalize correctly', async () => {
  // identity root, one child at (1,2,3)
  const identity = await parseYaml('identity.prefab', [
    ...go(1, 'Root', [2]), ...tr(2, 1, { children: [4] }),
    ...go(3, 'Child', [4]), ...tr(4, 3, { pos: '{x: 1, y: 2, z: 3}', father: 2 }),
  ]);
  const child = identity.ir.entities.find((e) => e.name === 'Child');
  close(child.transform.rootRelative, [...new THREE.Matrix4().setPosition(1, 2, 3).elements], 'identity root child');

  // minimal root: only a position, no rotation/scale keys at all
  const minimal = await parseYaml('minimal.prefab', [
    ...go(1, 'Root', [2]),
    '--- !u!4 &2', 'Transform:', '  m_GameObject: {fileID: 1}', '  m_LocalPosition: {x: 7, y: 0, z: 0}',
    '  m_Children:', '  - {fileID: 4}', '  m_Father: {fileID: 0}',
    ...go(3, 'Child', [4]), ...tr(4, 3, { pos: '{x: 0, y: 5, z: 0}', father: 2 }),
  ]);
  const minimalChild = minimal.ir.entities.find((e) => e.name === 'Child');
  close(minimalChild.transform.rootRelative, [...new THREE.Matrix4().setPosition(0, 5, 0).elements], 'minimal root child');
  assert.deepEqual(minimal.ir.entities.find((e) => e.name === 'Root').transform.local.scale, { x: 1, y: 1, z: 1 });

  // variant-style: a rotated + non-uniformly scaled root with a nested chain
  const variant = await parseYaml('variant.prefab', [
    ...go(1, 'Root', [2]), ...tr(2, 1, { pos: '{x: 44.351006, y: 0, z: -20.299002}', rot: '{x: 0, y: -1, z: 0, w: 0}', scale: '{x: 1, y: 1.5, z: 1}', children: [4] }),
    ...go(3, 'Mid', [4]), ...tr(4, 3, { pos: '{x: 2, y: 0, z: 0}', scale: '{x: 2, y: 2, z: 2}', father: 2, children: [6] }),
    ...go(5, 'Leaf', [6]), ...tr(6, 5, { pos: '{x: 0, y: 3, z: 0}', father: 4 }),
  ]);
  const leaf = variant.ir.entities.find((e) => e.name === 'Leaf');
  const oracle = new THREE.Matrix4()
    .multiply(new THREE.Matrix4().compose(new THREE.Vector3(2, 0, 0), new THREE.Quaternion(), new THREE.Vector3(2, 2, 2)))
    .multiply(new THREE.Matrix4().setPosition(0, 3, 0));
  close(leaf.transform.rootRelative, [...oracle.elements], 'variant leaf');
  // the root's own 44.35 / 1.5 never appears in the child chain
  assert.ok(Math.abs(leaf.transform.rootRelative[12] - 2) < 1e-6);
  assert.ok(Math.abs(leaf.transform.rootRelative[13] - 6) < 1e-6, 'root scale is NOT applied to descendants');
});

test('root-target-only overrides: a child override never becomes the instance pose', () => {
  // Real scene case: instances carry m_Name/m_IsActive and child overrides too.
  // The instance pose must come ONLY from the stripped root target.
  const instance = sceneIR.prefabInstances.find((pi) => pi.fileID === '1776860175');
  const rootTargets = instance.prefab.modifications.filter((m) => m.target?.fileID === ROOT_FILE_ID);
  assert.ok(rootTargets.length >= 1, 'the root target carries the transform overrides');
  const otherTargets = instance.prefab.modifications.filter((m) => m.target?.fileID !== ROOT_FILE_ID);
  assert.ok(otherTargets.length >= 1, 'and there ARE other targets (m_Name on the GameObject)');
  // none of those other targets leaked into the pose
  assert.deepEqual(instance.transform.local.position, { x: 0, y: 0, z: 200 });
});
