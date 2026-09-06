import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { PARSER_VERSION } from '../tools/unity/parse.mjs';

// END-TO-END through the REAL CLIs (parse.mjs -> emit.mjs) on a tiny synthetic
// Unity project: a prefab whose ROOT has a non-identity pose and a non-uniform
// scale, holding a Unity BUILT-IN cube (so no model conversion, no assets, no
// clones), instanced twice in a scene -- once with a full position+rotation
// override and once with a partial one.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-emit-roots-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOT_POS = { x: 44.351006, y: 0, z: -20.299002 };
const ROOT_SCALE = { x: 1, y: 1.5, z: 1 };
const CHILD_LOCAL = { x: 0, y: 4, z: 0 };
const PREFAB_GUID = 'aaaa1111bbbb2222cccc3333dddd4444';
const MATERIAL_GUID = 'bbbb1111cccc2222dddd3333eeee4444';
const yaml = (lines) => ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...lines, ''].join('\n');

function writeProject() {
  const assets = path.join(tmp, 'project', 'Assets');
  fs.mkdirSync(assets, { recursive: true });
  // prefab: Root (non-identity, non-uniform scale) -> Cube (builtin mesh)
  const prefab = yaml([
    '--- !u!1 &100', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 101}', '  m_Name: ProbeRoot', '  m_IsActive: 1',
    '--- !u!4 &101', 'Transform:', '  m_GameObject: {fileID: 100}',
    '  m_LocalRotation: {x: 0, y: -1, z: 0, w: 0}',
    `  m_LocalPosition: {x: ${ROOT_POS.x}, y: ${ROOT_POS.y}, z: ${ROOT_POS.z}}`,
    `  m_LocalScale: {x: ${ROOT_SCALE.x}, y: ${ROOT_SCALE.y}, z: ${ROOT_SCALE.z}}`,
    '  m_Children:', '  - {fileID: 201}', '  m_Father: {fileID: 0}',
    '--- !u!1 &200', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 201}', '  - component: {fileID: 202}', '  - component: {fileID: 203}',
    '  m_Name: ProbeCube', '  m_IsActive: 1',
    '--- !u!4 &201', 'Transform:', '  m_GameObject: {fileID: 200}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    `  m_LocalPosition: {x: ${CHILD_LOCAL.x}, y: ${CHILD_LOCAL.y}, z: ${CHILD_LOCAL.z}}`,
    '  m_LocalScale: {x: 1, y: 1, z: 1}', '  m_Children: []', '  m_Father: {fileID: 101}',
    '--- !u!33 &202', 'MeshFilter:', '  m_GameObject: {fileID: 200}',
    '  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}',
    '--- !u!23 &203', 'MeshRenderer:', '  m_GameObject: {fileID: 200}', '  m_Enabled: 1', '  m_CastShadows: 1',
    `  m_Materials:`, `  - {fileID: 2100000, guid: ${MATERIAL_GUID}, type: 2}`,
  ]);
  fs.writeFileSync(path.join(assets, 'Probe.prefab'), prefab);
  fs.writeFileSync(path.join(assets, 'Probe.mat'), yaml([
    '--- !u!21 &2100000', 'Material:', '  serializedVersion: 8', '  m_Name: ProbeMat',
    '  m_SavedProperties:', '    serializedVersion: 3', '    m_TexEnvs: []', '    m_Floats: []', '    m_Colors: []',
  ]));

  const instance = (fileID, mods) => [
    `--- !u!1001 &${fileID}`, 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    ...mods.flatMap(([prop, value]) => [
      `    - target: {fileID: 101, guid: ${PREFAB_GUID}, type: 3}`,
      `      propertyPath: ${prop}`,
      `      value: ${value}`,
      '      objectReference: {fileID: 0}',
    ]),
    '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${PREFAB_GUID}, type: 3}`,
    `--- !u!4 &${fileID}1 stripped`, 'Transform:',
    `  m_CorrespondingSourceObject: {fileID: 101, guid: ${PREFAB_GUID}, type: 3}`,
    `  m_PrefabInstance: {fileID: ${fileID}}`, '  m_PrefabAsset: {fileID: 0}',
  ];
  const scene = yaml([
    // full override, like the real 95 building instances (no scale override)
    ...instance(900, [['m_LocalPosition.x', 0], ['m_LocalPosition.y', 0], ['m_LocalPosition.z', 200],
      ['m_LocalRotation.x', 0], ['m_LocalRotation.y', 1], ['m_LocalRotation.z', 0], ['m_LocalRotation.w', 0]]),
    // partial override: only x -- y/z/rotation/scale must come from the authored root
    ...instance(901, [['m_LocalPosition.x', 5]]),
  ]);
  fs.writeFileSync(path.join(assets, 'Probe.unity'), scene);

  const guids = {
    unityProjectRoot: path.join(tmp, 'project'),
    guids: {
      [PREFAB_GUID]: { path: 'Assets/Probe.prefab', kind: 'prefab' },
      [MATERIAL_GUID]: { path: 'Assets/Probe.mat', kind: 'material' },
    },
  };
  const guidPath = path.join(tmp, 'guids.json');
  fs.writeFileSync(guidPath, JSON.stringify(guids, null, 2));
  return { assets, guidPath, scenePath: path.join(assets, 'Probe.unity') };
}

const project = writeProject();
const irPath = path.join(tmp, 'probe.ir.json');
const worldDir = path.join(tmp, 'world');
const cacheDir = path.join(tmp, 'cache');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: repo });
  if (result.status !== 0) throw new Error(`${path.basename(args[0])} failed: ${result.stderr || result.stdout}`);
  return result;
}
const parse = (out = irPath, source = project.scenePath) =>
  run(NODE, [path.join(repo, 'tools/unity/parse.mjs'), source, '--guids', project.guidPath, '--out', out]);
const emit = (extra = []) => run(NODE, [path.join(repo, 'tools/unity/emit.mjs'), irPath, worldDir,
  '--guids', project.guidPath, '--cache-dir', cacheDir, '--reuse-models', ...extra]);

test('emit places prefab contents ROOT-RELATIVE: no authored-root offset survives', () => {
  parse();
  emit();
  const prefabFiles = fs.readdirSync(path.join(worldDir, 'prefabs'));
  assert.equal(prefabFiles.length, 1, `one prefab emitted, got ${prefabFiles.join(', ')}`);
  const emitted = JSON.parse(fs.readFileSync(path.join(worldDir, 'prefabs', prefabFiles[0]), 'utf8'));
  const parts = emitted.components.mesh.parts;
  assert.equal(parts.length, 1);
  // the child is authored 4 m above the ROOT -- and that is all the part may carry.
  // Before the fix the part also carried the root's own 44.351 / 20.299 offset.
  assert.deepEqual(parts[0].position, [0, 4, 0]);
  assert.ok(!parts[0].position.some((v) => Math.abs(v) > 40), 'no authored-root offset leaked in');
  assert.equal(emitted.components.transform.position.every((v) => v === 0), true, 'the prefab origin IS its root');
});

test('emit gives each instance the merged root pose, INCLUDING the inherited scale', () => {
  const scene = JSON.parse(fs.readFileSync(path.join(worldDir, 'scenes', 'Probe.json'), 'utf8'));
  const entities = scene.entities ?? scene;
  const full = entities['unity-900'];
  const partial = entities['unity-901'];
  assert.ok(full && partial, `both instances emitted (${Object.keys(entities).join(', ')})`);
  // full override: position (0,0,200) Unity -> (0,0,-200) GAIA, authored scale kept
  assert.deepEqual(full.transform.position, [0, 0, -200]);
  assert.deepEqual(full.transform.scale, [1, 1.5, 1], 'the un-overridden authored scale must survive');
  // partial override: only x was named; y/z and the scale come from the authored root
  assert.deepEqual(partial.transform.position, [5, ROOT_POS.y, -ROOT_POS.z]);
  assert.deepEqual(partial.transform.scale, [1, 1.5, 1]);

  // the cube's FINAL world position, checked with three.js against the source
  // definition: instanceRoot * childLocal (the authored root never appears twice)
  const oracle = new THREE.Matrix4()
    .compose(new THREE.Vector3(0, 0, 200), new THREE.Quaternion(0, 1, 0, 0), new THREE.Vector3(1, 1.5, 1))
    .multiply(new THREE.Matrix4().setPosition(CHILD_LOCAL.x, CHILD_LOCAL.y, CHILD_LOCAL.z));
  const unityWorld = new THREE.Vector3().setFromMatrixPosition(oracle);
  const emittedPrefab = JSON.parse(fs.readFileSync(path.join(worldDir, 'prefabs', fs.readdirSync(path.join(worldDir, 'prefabs'))[0]), 'utf8'));
  const part = emittedPrefab.components.mesh.parts[0];
  // GAIA world = entity transform applied to the part (z mirrored once)
  const entityMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...full.transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(full.transform.rotation ?? [0, 0, 0]), 'XYZ')),
    new THREE.Vector3(...(full.transform.scale ?? [1, 1, 1])),
  );
  const gaiaWorld = new THREE.Vector3(...part.position).applyMatrix4(entityMatrix);
  assert.ok(Math.abs(gaiaWorld.x - unityWorld.x) < 1e-3, `x ${gaiaWorld.x} vs ${unityWorld.x}`);
  assert.ok(Math.abs(gaiaWorld.y - unityWorld.y) < 1e-3, `y ${gaiaWorld.y} vs ${unityWorld.y}`);
  assert.ok(Math.abs(gaiaWorld.z - (-unityWorld.z)) < 1e-3, `z ${gaiaWorld.z} vs ${-unityWorld.z}`);
});

// ---- cache / schema gate ----------------------------------------------------

test('a STALE prefab IR cache is re-parsed automatically (mtime alone never notices a parser fix)', () => {
  // --cache-dir IS the prefab-ir cache directory (emit.mjs: prefabCacheDir)
  const cacheFiles = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.ir.json'));
  assert.equal(cacheFiles.length, 1, `prefab IR cached (${fs.readdirSync(cacheDir).join(', ')})`);
  const cacheFile = path.join(cacheDir, cacheFiles[0]);
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cached.version, PARSER_VERSION);

  // downgrade the cache the way an old checkout would have left it: v1 shape,
  // no rootRelative, and NEWER than the source so mtime says "fresh"
  const stale = JSON.parse(JSON.stringify(cached));
  stale.version = 1;
  for (const entity of stale.entities) if (entity.transform) { delete entity.transform.rootRelative; delete entity.transform.rootTransformFileID; }
  fs.writeFileSync(cacheFile, JSON.stringify(stale));
  const now = new Date();
  fs.utimesSync(cacheFile, now, now);

  emit(); // must NOT throw, and must NOT emit from the stale meaning
  const reparsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(reparsed.version, PARSER_VERSION, 'the cache was re-parsed on schema mismatch');
  const prefabFile = path.join(worldDir, 'prefabs', fs.readdirSync(path.join(worldDir, 'prefabs'))[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(prefabFile, 'utf8')).components.mesh.parts[0].position, [0, 4, 0]);
});

test('an OLD-SCHEMA scene IR is REFUSED with the exact command that fixes it', () => {
  const old = JSON.parse(fs.readFileSync(irPath, 'utf8'));
  old.version = 1;
  const oldPath = path.join(tmp, 'old.ir.json');
  fs.writeFileSync(oldPath, JSON.stringify(old));
  const result = spawnSync(NODE, [path.join(repo, 'tools/unity/emit.mjs'), oldPath, path.join(tmp, 'world-old'),
    '--guids', project.guidPath, '--cache-dir', cacheDir, '--reuse-models'], { encoding: 'utf8', cwd: repo });
  assert.notEqual(result.status, 0, 'emit must fail, not silently use the old meaning');
  const message = `${result.stderr}${result.stdout}`;
  assert.match(message, /IR schema v1 .* is older than v2/);
  assert.match(message, /Re-run: node tools\/unity\/parse\.mjs/);
  assert.equal(fs.existsSync(path.join(tmp, 'world-old', 'scenes')), false, 'nothing was written');
});

test('editing a DEPENDENCY prefab invalidates the cache too (not just the main file mtime)', () => {
  const cacheFile = path.join(cacheDir, fs.readdirSync(cacheDir).filter((n) => n.endsWith('.ir.json'))[0]);
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  // this prefab IR recorded no dependency of its own (it has no nested source),
  // so inject one the way a variant/nested prefab would, pointing at a real file
  const dependency = path.join(project.assets, 'Probe.mat');
  cached.sourceDependencies = [{ path: dependency, mtimeMs: fs.statSync(dependency).mtimeMs }];
  fs.writeFileSync(cacheFile, JSON.stringify(cached));
  const fresh = new Date();
  fs.utimesSync(cacheFile, fresh, fresh);

  // touch the DEPENDENCY (the prefab file itself is untouched)
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(dependency, later, later);
  emit();
  const reparsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(reparsed.sourceDependencies, [], 're-parsed: the injected stamp is gone');
  assert.equal(reparsed.version, PARSER_VERSION);

  // a dependency that disappeared also forces a re-parse rather than a stale read
  const missing = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  missing.sourceDependencies = [{ path: path.join(project.assets, 'Gone.prefab'), mtimeMs: 1 }];
  missing.marker = 'stale';
  fs.writeFileSync(cacheFile, JSON.stringify(missing));
  emit();
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).marker, undefined, 'missing dependency -> re-parsed');
});

// ---- externally owned prefabs (policy.externalPrefabGuids) ------------------
// A container prefab holding TWO instances of the same visual prefab, one of
// which the GAME owns and emits itself. The importer must drop exactly that one
// and keep the other -- otherwise the game's dynamic body and the importer's
// static twin sit in the same place, and consuming the dynamic one leaves a grey
// box behind (the live TempObjects case: 4 game pickups + 1 message box).
const NL2 = String.fromCharCode(10);
function writeContainerProject() {
  const root = path.join(tmp, 'external');
  const assets = path.join(root, 'Assets');
  fs.mkdirSync(assets, { recursive: true });
  const OWNED = 'dddd1111dddd1111dddd1111dddd1111';
  const KEPT = 'eeee2222eeee2222eeee2222eeee2222';
  const CONTAINER = 'ffff3333ffff3333ffff3333ffff3333';
  const leaf = (name) => [
    '--- !u!1 &100', 'GameObject:', '  serializedVersion: 6',
    '  m_Component:', '  - component: {fileID: 101}', '  - component: {fileID: 102}', '  - component: {fileID: 103}',
    `  m_Name: ${name}`, '  m_IsActive: 1',
    '--- !u!4 &101', 'Transform:', '  m_GameObject: {fileID: 100}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}', '  m_LocalPosition: {x: 0, y: 0, z: 0}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}', '  m_Children: []', '  m_Father: {fileID: 0}',
    '--- !u!33 &102', 'MeshFilter:', '  m_GameObject: {fileID: 100}',
    '  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}',
    '--- !u!23 &103', 'MeshRenderer:', '  m_GameObject: {fileID: 100}', '  m_Enabled: 1', '  m_CastShadows: 1',
    '  m_Materials:', `  - {fileID: 2100000, guid: ${MATERIAL_GUID}, type: 2}`,
  ];
  const write = (name, lines) => fs.writeFileSync(path.join(assets, name), ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', ...lines, ''].join(NL2));
  write('Owned.prefab', leaf('OwnedBox'));
  write('Kept.prefab', leaf('KeptBox'));
  write('Probe.mat', ['--- !u!21 &2100000', 'Material:', '  serializedVersion: 8', '  m_Name: ProbeMat',
    '  m_SavedProperties:', '    serializedVersion: 3', '    m_TexEnvs: []', '    m_Floats: []', '    m_Colors: []']);
  const nested = (fileID, guid, x) => [
    `--- !u!1001 &${fileID}`, 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 501}',
    '    m_Modifications:',
    `    - target: {fileID: 101, guid: ${guid}, type: 3}`, '      propertyPath: m_LocalPosition.x', `      value: ${x}`,
    '      objectReference: {fileID: 0}',
    '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}`,
  ];
  write('Container.prefab', [
    '--- !u!1 &500', 'GameObject:', '  serializedVersion: 6', '  m_Component:', '  - component: {fileID: 501}',
    '  m_Name: Container', '  m_IsActive: 1',
    '--- !u!4 &501', 'Transform:', '  m_GameObject: {fileID: 500}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}', '  m_LocalPosition: {x: 0, y: 0, z: 0}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}', '  m_Children: []', '  m_Father: {fileID: 0}',
    ...nested(600, OWNED, 3),
    ...nested(601, KEPT, 9),
  ]);
  write('Scene.unity', [
    '--- !u!1001 &700', 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    `    - target: {fileID: 501, guid: ${CONTAINER}, type: 3}`, '      propertyPath: m_LocalPosition.z', '      value: 0',
    '      objectReference: {fileID: 0}',
    '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${CONTAINER}, type: 3}`,
  ]);
  const guidPath = path.join(root, 'guids.json');
  fs.writeFileSync(guidPath, JSON.stringify({
    unityProjectRoot: root,
    guids: {
      [OWNED]: { path: 'Assets/Owned.prefab', kind: 'prefab' },
      [KEPT]: { path: 'Assets/Kept.prefab', kind: 'prefab' },
      [CONTAINER]: { path: 'Assets/Container.prefab', kind: 'prefab' },
      [MATERIAL_GUID]: { path: 'Assets/Probe.mat', kind: 'material' },
    },
  }, null, 2));
  return { root, assets, guidPath, scene: path.join(assets, 'Scene.unity'), OWNED, KEPT };
}

test('externalPrefabGuids removes ONLY the game-owned prefab; its siblings stay', () => {
  const container = writeContainerProject();
  const ir = path.join(container.root, 'scene.ir.json');
  run(NODE, [path.join(repo, 'tools/unity/parse.mjs'), container.scene, '--guids', container.guidPath, '--out', ir]);

  const emitInto = (worldOut, policyFile) => {
    const args = [path.join(repo, 'tools/unity/emit.mjs'), ir, worldOut, '--guids', container.guidPath,
      '--cache-dir', path.join(container.root, `cache-${path.basename(worldOut)}`), '--reuse-models'];
    if (policyFile) args.push('--policy', policyFile);
    // emit logs progress lines before its JSON summary
    const result = run(NODE, args);
    // emit prints several JSON blocks AND trailing log lines: take the last
    // brace-delimited block that parses
    const NLC = String.fromCharCode(10);
    const lines = result.stdout.split(NLC);
    for (let close = lines.length - 1; close >= 0; close--) {
      if (lines[close] !== '}') continue;
      for (let open = close; open >= 0; open--) {
        if (lines[open] !== '{') continue;
        try { return JSON.parse(lines.slice(open, close + 1).join(NLC)); } catch { /* keep scanning */ }
      }
    }
    throw new Error(`no JSON summary in emit stdout:${NLC}${result.stdout}`);
  };
  const partsOf = (worldOut) => {
    const dir = path.join(worldOut, 'prefabs');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    const file = files.find((n) => n.startsWith('Container'));
    assert.ok(file, `no Container prefab emitted (${files.join(', ')})`);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    return doc.components.mesh?.parts ?? [];
  };

  // BEFORE: the importer emits both boxes -- the duplicate a game body would shadow
  const before = emitInto(path.join(container.root, 'world-plain'));
  assert.equal(partsOf(path.join(container.root, 'world-plain')).length, 2);
  assert.equal(before.externalPrefabSkips, 0);
  assert.deepEqual(before.externalPrefabGuids, []);

  // AFTER: only the game-owned one disappears
  const policyFile = path.join(container.root, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ externalPrefabGuids: [container.OWNED.toUpperCase()] }));
  const after = emitInto(path.join(container.root, 'world-owned'), policyFile);
  const parts = partsOf(path.join(container.root, 'world-owned'));
  assert.equal(parts.length, 1, 'exactly one box survives');
  assert.deepEqual(parts[0].position, [9, 0, 0], 'the SIBLING is the one that stayed');
  assert.ok(after.externalPrefabSkips >= 1, 'the skip is reported, not silent');
  assert.deepEqual(after.externalPrefabGuids, [container.OWNED], 'guid matching is case-insensitive');
  assert.equal(fs.readdirSync(path.join(container.root, 'world-owned', 'prefabs')).some((n) => n.startsWith('Owned')), false);
});

// ---- transformless entities (the live Hub.prefab failure) -------------------
// Hub.prefab carries a STRIPPED GameObject placeholder (#8877336647538198250,
// no components, not renderable, transform null). The emitter used to derive a
// root-relative matrix for every entity BEFORE knowing whether it contributed
// anything, so the real in-place emit died on it. A transformless NON-VISUAL
// object is skipped; a transformless object that DOES contribute geometry or a
// collider is still refused, by name/source/id.
const HUB = '/Users/pascaldisse/projects/boomtown-rampage/Assets/DotsCity/Samples/Demo City/Prefabs/Core/Hub.prefab';
const REAL_GUIDS = process.env.BOOMTOWN_GUID_DB ?? '/Users/pascaldisse/projects/boomtown-rampage-gwe/tools/unity/out/guids.json';
const REAL_MODELS = '/Users/pascaldisse/projects/boomtown-rampage-gwe/tools/unity/out/boomtown-world/assets/models';

test('the REAL Hub.prefab (transformless stripped GameObject) emits instead of crashing', { timeout: 60000 }, () => {
  assert.ok(fs.existsSync(HUB), `real Hub.prefab required at ${HUB}`);
  const db = JSON.parse(fs.readFileSync(REAL_GUIDS, 'utf8'));
  const hubGuid = Object.entries(db.guids).find(([, rec]) => typeof rec?.path === 'string' && rec.path.endsWith('Prefabs/Core/Hub.prefab'))?.[0];
  assert.ok(hubGuid, 'Hub.prefab guid found in the real guid db');

  // parse the real prefab and CONFIRM the transformless entity is still there
  const hubIR = path.join(tmp, 'hub.ir.json');
  run(NODE, [path.join(repo, 'tools/unity/parse.mjs'), HUB, '--guids', REAL_GUIDS, '--out', hubIR]);
  const parsed = JSON.parse(fs.readFileSync(hubIR, 'utf8'));
  const transformless = parsed.entities.filter((e) => !e.transform);
  assert.equal(transformless.length, 1, 'exactly one transformless entity in Hub.prefab');
  assert.equal(transformless[0].id, '8877336647538198250');
  assert.equal(transformless[0].renderable, false);
  assert.deepEqual(Object.keys(transformless[0].components ?? {}), []);

  // a scene that instantiates the REAL Hub, emitted through the real CLI
  const sceneDir = path.join(tmp, 'hub-scene');
  fs.mkdirSync(sceneDir, { recursive: true });
  const scenePath = path.join(sceneDir, 'HubScene.unity');
  fs.writeFileSync(scenePath, ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1001 &900', 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
    '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    `    - target: {fileID: 4229471211397551464, guid: ${hubGuid}, type: 3}`,
    '      propertyPath: m_LocalPosition.x', '      value: 12', '      objectReference: {fileID: 0}',
    '    m_RemovedComponents: []',
    `  m_SourcePrefab: {fileID: 100100000, guid: ${hubGuid}, type: 3}`, ''].join(String.fromCharCode(10)));

  const sceneIR = path.join(tmp, 'hub-scene.ir.json');
  run(NODE, [path.join(repo, 'tools/unity/parse.mjs'), scenePath, '--guids', REAL_GUIDS, '--out', sceneIR]);
  const worldOut = path.join(tmp, 'hub-world');
  const args = [path.join(repo, 'tools/unity/emit.mjs'), sceneIR, worldOut, '--guids', REAL_GUIDS,
    '--cache-dir', path.join(tmp, 'hub-cache'), '--reuse-models'];
  if (fs.existsSync(REAL_MODELS)) args.push('--model-cache', REAL_MODELS); // reuse, never clone
  const result = spawnSync(NODE, args, { encoding: 'utf8', cwd: repo });
  assert.equal(result.status, 0, `emit failed:\n${result.stderr}`);
  assert.equal(/has NO transform/.test(result.stderr), false, 'the transformless placeholder must be skipped, not fatal');
  assert.ok(fs.existsSync(path.join(worldOut, 'scenes', 'HubScene.json')), 'the scene was written');
});

test('a transformless entity that DOES carry geometry is refused, naming it', () => {
  // synthetic: an IR whose renderable entity has no transform at all
  const broken = JSON.parse(fs.readFileSync(irPath, 'utf8'));
  const cache = path.join(tmp, 'broken-cache');
  fs.mkdirSync(cache, { recursive: true });
  const prefabIR = {
    version: broken.version,
    source: path.join(project.assets, 'Probe.prefab'),
    sourceDependencies: [],
    entities: [{
      id: '4242', name: 'GhostMesh', active: true, renderable: true, transform: null,
      components: { meshFilter: { mesh: { fileID: '10202', guid: '0000000000000000e000000000000000' } }, meshRenderer: { enabled: true, materials: [] } },
    }],
    prefabInstances: [],
  };
  // pre-seed the prefab IR cache so emit reads exactly this document
  const cacheName = fs.readdirSync(cacheDir).find((n) => n.endsWith('.ir.json'));
  fs.writeFileSync(path.join(cache, cacheName), JSON.stringify(prefabIR));
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(cache, cacheName), later, later);

  const result = spawnSync(NODE, [path.join(repo, 'tools/unity/emit.mjs'), irPath, path.join(tmp, 'world-ghost'),
    '--guids', project.guidPath, '--cache-dir', cache, '--reuse-models'], { encoding: 'utf8', cwd: repo });
  assert.notEqual(result.status, 0, 'emit must refuse, not place it at identity');
  const message = `${result.stderr}${result.stdout}`;
  assert.match(message, /has NO transform but contributes geometry\/colliders/);
  assert.match(message, /4242/, 'the id is in the message');
  assert.match(message, /GhostMesh/, 'the name is in the message');
  assert.match(message, /Probe\.prefab/, 'the source is in the message');
});
