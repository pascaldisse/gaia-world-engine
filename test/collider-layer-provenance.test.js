import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A collider answers a physics query only if its GameObject's LAYER is in the
// query mask, so the layer has to survive the import or every mask on the engine
// side is a guess. It is the layer of the GameObject that OWNS the collider --
// which is routinely NOT the prefab root's: the real case that started this was a
// building whose root sits on Environment(22) while its parts sit elsewhere, so
// a root-derived layer would have been wrong in both directions.
//
// END-TO-END through the REAL CLIs (parse.mjs -> emit.mjs) on a tiny synthetic
// Unity project using only BUILT-IN meshes: no assets, no clones, no conversion.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-collider-layers-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PREFAB_GUID = 'ccccdddd1111222233334444aaaabbbb';
const ROOT_LAYER = 22;      // like Environment: NOT a bullet layer
const CHILD_LAYER = 26;     // like BuildingPart: a hittable part under an unhittable root
const GRANDCHILD_LAYER = 0; // the default layer must be EMITTED, not omitted
const SPHERE_LAYER = 15;
const BOX_SIZE = { x: 11.631958, y: 11.954611, z: 11.819447 };
const BOX_CENTER = { x: 0, y: 5.977305, z: 0 };
const yaml = (lines) => ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...lines, ''].join('\n');

function writeProject() {
  const assets = path.join(tmp, 'project', 'Assets');
  fs.mkdirSync(assets, { recursive: true });
  const prefab = yaml([
    // ROOT (layer 22) with the building-sized BoxCollider
    '--- !u!1 &100', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 101}', '  - component: {fileID: 102}',
    `  m_Layer: ${ROOT_LAYER}`, '  m_Name: ProbeRoot', '  m_IsActive: 1',
    '--- !u!4 &101', 'Transform:', '  m_GameObject: {fileID: 100}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: 0, y: 0, z: 0}', '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_Children:', '  - {fileID: 201}', '  m_Father: {fileID: 0}',
    '--- !u!65 &102', 'BoxCollider:', '  m_GameObject: {fileID: 100}', '  m_Enabled: 1', '  m_IsTrigger: 0',
    `  m_Size: {x: ${BOX_SIZE.x}, y: ${BOX_SIZE.y}, z: ${BOX_SIZE.z}}`,
    `  m_Center: {x: ${BOX_CENTER.x}, y: ${BOX_CENTER.y}, z: ${BOX_CENTER.z}}`,
    // CHILD (layer 26): its own BoxCollider, offset from the root
    '--- !u!1 &200', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 201}', '  - component: {fileID: 202}',
    `  m_Layer: ${CHILD_LAYER}`, '  m_Name: ProbePillar', '  m_IsActive: 1',
    '--- !u!4 &201', 'Transform:', '  m_GameObject: {fileID: 200}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: 2, y: 1, z: 3}', '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_Children:', '  - {fileID: 301}', '  m_Father: {fileID: 101}',
    '--- !u!65 &202', 'BoxCollider:', '  m_GameObject: {fileID: 200}', '  m_Enabled: 1', '  m_IsTrigger: 0',
    '  m_Size: {x: 2, y: 4, z: 2}', '  m_Center: {x: 0, y: 2, z: 0}',
    // GRANDCHILD (layer 0, the default) with a SphereCollider sibling GO below it
    '--- !u!1 &300', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 301}', '  - component: {fileID: 302}',
    `  m_Layer: ${GRANDCHILD_LAYER}`, '  m_Name: ProbeGrandchild', '  m_IsActive: 1',
    '--- !u!4 &301', 'Transform:', '  m_GameObject: {fileID: 300}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: 0, y: 6, z: 0}', '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_Children:', '  - {fileID: 401}', '  m_Father: {fileID: 201}',
    '--- !u!65 &302', 'BoxCollider:', '  m_GameObject: {fileID: 300}', '  m_Enabled: 1', '  m_IsTrigger: 0',
    '  m_Size: {x: 1, y: 1, z: 1}', '  m_Center: {x: 0, y: 0, z: 0}',
    '--- !u!1 &400', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 401}', '  - component: {fileID: 402}',
    `  m_Layer: ${SPHERE_LAYER}`, '  m_Name: ProbeSphere', '  m_IsActive: 1',
    '--- !u!4 &401', 'Transform:', '  m_GameObject: {fileID: 400}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: 1, y: 0, z: 0}', '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_Children: []', '  m_Father: {fileID: 301}',
    '--- !u!135 &402', 'SphereCollider:', '  m_GameObject: {fileID: 400}', '  m_Enabled: 1', '  m_IsTrigger: 0',
    '  m_Radius: 0.5', '  m_Center: {x: 0, y: 0, z: 0}',
  ]);
  fs.writeFileSync(path.join(assets, 'Probe.prefab'), prefab);

  // one instance, scaled 2.5 like the real building
  const scene = yaml([
    '--- !u!1001 &900', 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    ...[['m_LocalPosition.x', 5], ['m_LocalPosition.y', 0], ['m_LocalPosition.z', 5],
      ['m_LocalScale.x', 2.5], ['m_LocalScale.y', 2.5], ['m_LocalScale.z', 2.5]].flatMap(([prop, value]) => [
      `    - target: {fileID: 101, guid: ${PREFAB_GUID}, type: 3}`,
      `      propertyPath: ${prop}`, `      value: ${value}`, '      objectReference: {fileID: 0}',
    ]),
    '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${PREFAB_GUID}, type: 3}`,
    '--- !u!4 &9001 stripped', 'Transform:',
    `  m_CorrespondingSourceObject: {fileID: 101, guid: ${PREFAB_GUID}, type: 3}`,
    '  m_PrefabInstance: {fileID: 900}', '  m_PrefabAsset: {fileID: 0}',
  ]);
  fs.writeFileSync(path.join(assets, 'Probe.unity'), scene);

  const guidPath = path.join(tmp, 'guids.json');
  fs.writeFileSync(guidPath, JSON.stringify({
    unityProjectRoot: path.join(tmp, 'project'),
    guids: { [PREFAB_GUID]: { path: 'Assets/Probe.prefab', kind: 'prefab' } },
  }, null, 2));
  return { assets, guidPath, scenePath: path.join(assets, 'Probe.unity'), prefabPath: path.join(assets, 'Probe.prefab') };
}

const project = writeProject();
const irPath = path.join(tmp, 'probe.ir.json');
const worldDir = path.join(tmp, 'world');
const cacheDir = path.join(tmp, 'cache');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: repo });
  if (result.status !== 0) throw new Error(`${path.basename(args[1])} failed: ${result.stderr || result.stdout}`);
  return result;
}
run(NODE, [path.join(repo, 'tools/unity/parse.mjs'), project.scenePath, '--guids', project.guidPath, '--out', irPath]);
run(NODE, [path.join(repo, 'tools/unity/emit.mjs'), irPath, worldDir,
  '--guids', project.guidPath, '--cache-dir', cacheDir, '--reuse-models']);

const prefabFiles = fs.readdirSync(path.join(worldDir, 'prefabs'));
const emitted = JSON.parse(fs.readFileSync(path.join(worldDir, 'prefabs', prefabFiles[0]), 'utf8'));
const boxes = emitted.components.collider.boxes;

test('every emitted collider box carries the layer of the GameObject that owns it', () => {
  assert.equal(boxes.length, 4, `four source colliders -> four boxes (${JSON.stringify(boxes)})`);
  for (const box of boxes) assert.equal(Number.isInteger(box.layer), true, `box has a layer: ${JSON.stringify(box)}`);

  // matched by SIZE, which is unique per source collider here
  const bySize = (x) => boxes.find((b) => Math.abs(b.size[0] - x) < 1e-3);
  assert.equal(bySize(BOX_SIZE.x).layer, ROOT_LAYER, 'the root box keeps the ROOT layer');
  assert.equal(bySize(2).layer, CHILD_LAYER, 'the child pillar keeps ITS layer, not the root 22');
  assert.equal(bySize(1).layer, GRANDCHILD_LAYER, 'layer 0 is emitted, not treated as absent');
  assert.equal(bySize(1).layer, 0);
  const sphere = boxes.find((b) => Math.abs(b.size[0] - 1) < 1e-3 && b.layer === SPHERE_LAYER);
  assert.ok(sphere, 'a SphereCollider box carries its own GO layer too');

  // the emitted set of layers is exactly the set the SOURCE declares -- nothing
  // invented, nothing inherited from the root
  const sourceText = fs.readFileSync(project.prefabPath, 'utf8');
  const declared = new Set([...sourceText.matchAll(/^\s*m_Layer: (\d+)$/gm)].map((m) => Number(m[1])));
  for (const box of boxes) assert.equal(declared.has(box.layer), true, `layer ${box.layer} was read, not guessed`);
  assert.deepEqual([...new Set(boxes.map((b) => b.layer))].sort((a, b) => a - b),
    [...declared].sort((a, b) => a - b), 'every declared collider layer survived');
});

test('placeColliderBoxes preserves the layer through the basis change and the scale', () => {
  const scene = JSON.parse(fs.readFileSync(path.join(worldDir, 'scenes', 'Probe.json'), 'utf8'));
  const entities = scene.entities ?? scene;
  const instance = entities['unity-900'];
  assert.deepEqual(instance.transform.scale, [2.5, 2.5, 2.5], 'the instance really is scaled');

  // the geometry the placement produces is UNCHANGED by carrying a layer:
  // Unity->GAIA mirrors z, and the root box keeps its authored local centre
  const root = boxes.find((b) => Math.abs(b.size[0] - BOX_SIZE.x) < 1e-3);
  assert.deepEqual(root.size, [BOX_SIZE.x, BOX_SIZE.y, BOX_SIZE.z].map((v) => Number(v.toFixed(6))));
  assert.deepEqual(root.position, [0, Number(BOX_CENTER.y.toFixed(6)), 0]);
  assert.equal(root.blocker, true);

  // the child box was placed root-relative AND kept its own layer: placement and
  // provenance travel together (this is the pair that used to be decided by two
  // different objects)
  const child = boxes.find((b) => Math.abs(b.size[0] - 2) < 1e-3);
  assert.deepEqual(child.position, [2, 3, -3], 'child local (2,1,3)+center(0,2,0) mirrored to GAIA');
  assert.equal(child.layer, CHILD_LAYER);

  // and the WORLD box of the root under this instance is the one the runtime
  // query sees: centre 5 + half 11.631958*2.5/2 -> maxX 19.54
  const maxX = instance.transform.position[0] + (root.size[0] * instance.transform.scale[0]) / 2;
  assert.equal(Number(maxX.toFixed(3)), 19.54);
});
