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

test('the whole scene population is covered: every family keeps its OWN authored root', () => {
  const byPath = new Map();
  for (const pi of sceneIR.prefabInstances) {
    const key = pi.source?.path ?? '(none)';
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(pi);
  }
  const count = (needle) => [...byPath].filter(([key]) => key.endsWith(needle)).reduce((sum, [, list]) => sum + list.length, 0);
  // MEASURED populations (independent count over the real scene), not assumed:
  assert.equal(sceneIR.prefabInstances.length, 465, 'total PrefabInstances in boomtown.unity');
  assert.equal(count('Building_ApartmentSmall_Red fragments rayfire v3.prefab'), 95, 'RayFire buildings');
  assert.equal(count('Building_ApartmentSmall_Red 1.prefab'), 48, 'the 48 are the PLAIN static buildings');
  // the road family is TWO different prefab files, not one, and not 48
  const roads = [...byPath].filter(([key]) => /\/road\.prefab$/.test(key));
  assert.equal(roads.length, 2, `road.prefab files: ${roads.map(([k]) => k).join(', ')}`);
  assert.deepEqual(roads.map(([, list]) => list.length).sort((a, b) => b - a), [160, 105]);

  // Each family's authored root is DIFFERENT and non-identity -- the double bake
  // displaced all of them, not only the RayFire buildings.
  const rootOf = (needle) => [...byPath].find(([key]) => key.endsWith(needle))[1][0].authoredRoot;
  const plain = rootOf('Building_ApartmentSmall_Red 1.prefab');
  assert.deepEqual(plain.position, { x: 44.351006, y: 0, z: -20.299002 });
  assert.deepEqual(plain.scale, { x: 2.5, y: 2.5, z: 2.5 }, 'the static buildings are authored 2.5x');
  const road = rootOf('/road.prefab');
  assert.deepEqual(road.position, { x: -10.499995, y: 0.10260211, z: 122.5 }, 'roads were displaced ~123 m');
  const office = rootOf('Building_OfficeStepped_Blue.prefab');
  assert.deepEqual(office.scale, { x: 2.5, y: 4.7, z: 2.5 });

  // and every instance of every family inherits any axis it does not override
  for (const [key, list] of byPath) {
    for (const instance of list) {
      if (!instance.authoredRoot) continue;
      for (const axis of ['x', 'y', 'z']) {
        if (!instance.transform.overriddenAxes.scale[axis]) {
          assert.equal(instance.transform.local.scale[axis], instance.authoredRoot.scale[axis],
            `${key} ${instance.fileID} scale.${axis} must be inherited`);
        }
      }
    }
  }
});

// ---- synthetic root fixtures ------------------------------------------------

const NL = String.fromCharCode(10);
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

test('a PrefabInstance with NO stripped transform still gets the real authored root', async () => {
  // Unity only serializes a stripped root Transform when something references it.
  // The root target must come from the SOURCE PREFAB, so this instance resolves
  // exactly like one that does have a stripped doc.
  const projectDir = path.join(tmp, 'nostrip');
  fs.mkdirSync(path.join(projectDir, 'Assets'), { recursive: true });
  const guid = 'ffff0000ffff0000ffff0000ffff0000';
  const write = (name, lines) => {
    const file = path.join(projectDir, 'Assets', name);
    fs.writeFileSync(file, ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...lines, ''].join(NL));
    return file;
  };
  // CHILD SERIALIZED BEFORE THE ROOT: document order must not decide the root
  write('Src.prefab', [
    ...go(3, 'Child', [4]), ...tr(4, 3, { pos: '{x: 0, y: 9, z: 0}', father: 2 }),
    ...go(1, 'SrcRoot', [2]), ...tr(2, 1, { pos: '{x: 8, y: 0, z: -3}', rot: '{x: 0, y: -1, z: 0, w: 0}', scale: '{x: 1, y: 1.5, z: 1}', children: [4] }),
  ]);
  const scene = write('NoStrip.unity', [
    '--- !u!1001 &700', 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    `    - target: {fileID: 2, guid: ${guid}, type: 3}`, '      propertyPath: m_LocalPosition.x', '      value: 25',
    '      objectReference: {fileID: 0}',
    '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}`,
  ]);
  const db = { unityProjectRoot: projectDir, guids: { [guid]: { path: 'Assets/Src.prefab', kind: 'prefab' } } };
  const ir = await parseFile(scene, db);
  const instance = ir.prefabInstances[0];
  assert.equal(instance.rootTargetFileID, '2', 'the root target is the prefab root, not the first stripped/child doc');
  assert.deepEqual(instance.authoredRoot.scale, { x: 1, y: 1.5, z: 1 });
  // x overridden, y/z + rotation + scale inherited from the authored root
  assert.deepEqual(instance.transform.local.position, { x: 25, y: 0, z: -3 });
  assert.deepEqual(instance.transform.local.rotation, { x: 0, y: -1, z: 0, w: 0 });
  assert.deepEqual(instance.transform.local.scale, { x: 1, y: 1.5, z: 1 });
  assert.equal(instance.authoredRootSource.kind, 'prefab');
  // the referenced prefab is recorded as a source dependency (cache invalidation)
  assert.ok(ir.sourceDependencies.some((dep) => dep.path.endsWith('Src.prefab') && Number.isFinite(dep.mtimeMs)));
});

test('an unreadable or ambiguous prefab root is an ERROR, never a silent identity', async () => {
  const projectDir = path.join(tmp, 'broken');
  fs.mkdirSync(path.join(projectDir, 'Assets'), { recursive: true });
  const guid = 'eeee0000eeee0000eeee0000eeee0000';
  const sceneLines = [
    '--- !u!1001 &800', 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:', '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}`,
  ];
  const scene = path.join(projectDir, 'Assets', 'Broken.unity');
  fs.writeFileSync(scene, ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...sceneLines, ''].join(NL));

  // (a) guid not in the db at all
  await assert.rejects(parseFile(scene, { unityProjectRoot: projectDir, guids: {} }),
    /unresolved guid|could not be resolved/);
  // (b) path present but the file is missing
  await assert.rejects(parseFile(scene, { unityProjectRoot: projectDir, guids: { [guid]: { path: 'Assets/Missing.prefab' } } }),
    /cannot read|could not be resolved/);
  // (c) two root transforms: ambiguous
  fs.writeFileSync(path.join(projectDir, 'Assets', 'Two.prefab'), ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:',
    ...go(1, 'A', [2]), ...tr(2, 1), ...go(3, 'B', [4]), ...tr(4, 3), ''].join(NL));
  await assert.rejects(parseFile(scene, { unityProjectRoot: projectDir, guids: { [guid]: { path: 'Assets/Two.prefab' } } }),
    /refuses to guess which one an instance places|could not be resolved/);
  // (d) a MODEL source is a DECLARED identity default, not a failure
  fs.writeFileSync(path.join(projectDir, 'Assets', 'Mesh.fbx'), 'not really an fbx');
  const ir = await parseFile(scene, { unityProjectRoot: projectDir, guids: { [guid]: { path: 'Assets/Mesh.fbx', kind: 'model' } } });
  assert.equal(ir.prefabInstances[0].authoredRootSource.kind, 'model-identity');
  assert.deepEqual(ir.prefabInstances[0].transform.local.scale, { x: 1, y: 1, z: 1 });
});
