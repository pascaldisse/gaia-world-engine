import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';

// A Unity MeshCollider that references the SAME mesh the MeshRenderer draws is a
// walkable surface, not a wall. The importer used to emit `solid: false` plus a
// blocker AABB, which turned every road into a ~0.10 m impassable curb: the
// player was pushed off its edge (live: road unity-1386698518 stopped the
// controller at z = -29.65) because walkableAt skips blocker boxes and surfaceAt
// ignores non-solid model parts.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NL = String.fromCharCode(10);

// ---- runtime: what the engine does with each emitted shape -------------------
function runtimeFixture(part, boxes) {
  const store = { entities: new Map(), get(id) { return this.entities.get(id); }, onChange() {} };
  const scene = new THREE.Scene();
  const view = new View({ scene, store });
  const group = new THREE.Group();
  group.name = 'road';
  // the emitted road: a 20x20 sheet 0.1 m thick, as the converted GLB renders it
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 0.195, 20), new THREE.MeshBasicMaterial());
  mesh.position.y = 0.0026;
  mesh.userData = { kind: 'mesh-part', solid: Boolean(part.solid) };
  group.add(mesh);
  group.position.set(20, 0, -40);
  scene.add(group);
  view.groups.set('road', group);
  store.entities.set('road', { mesh: { parts: [part] }, ...(boxes ? { collider: { boxes } } : {}) });
  view.indexEntity('road', store.get('road'));
  // a ground plane the player starts on, beside the road
  const planeGroup = new THREE.Group();
  const plane = new THREE.Mesh(new THREE.BoxGeometry(400, 0.2, 400), new THREE.MeshBasicMaterial());
  plane.position.y = -0.1;
  plane.userData = { kind: 'mesh-part', solid: true };
  planeGroup.add(plane);
  scene.add(planeGroup);
  view.groups.set('ground', planeGroup);
  store.entities.set('ground', { mesh: { parts: [{ shape: 'box', solid: true }] } });
  view.indexEntity('ground', store.get('ground'));
  return { store, scene, view };
}

describe('MeshCollider surfaces — actual Three raycasts (Player unit needs DOM)', () => {
  test('the OLD emission is an impassable curb: no surface, no walkable box, push-out at the edge', () => {
    const { view } = runtimeFixture(
      { shape: 'model', solid: false },
      [{ position: [0.000005, 0.002602, 0], size: [19.99999, 0.194796, 20], blocker: true }],
    );
    // the road is invisible to both ground queries
    expect(view.surfaceAt(20, -40, 3)).toBeCloseTo(-0.0); // the ground plane, not the road
    expect(view.walkableAt(20, -40, 3)).toBe(null);
    // and its blocker pushes a walking player away from the edge
    // the live stop was z = -29.65: the box edge is at -30 and the body radius 0.35
    const position = new THREE.Vector3(20, 1.7, -29.8);
    view.resolveBlockers(position, 1.7);
    expect(position.z).toBeGreaterThan(-29.8);
  });

  test('the FIXED emission is a real surface: solid mesh + non-blocker box, and the player steps on', () => {
    const { view } = runtimeFixture(
      { shape: 'model', solid: true },
      [{ position: [0.000005, 0.002602, 0], size: [19.99999, 0.194796, 20], blocker: false }],
    );
    const top = 0.0026 + 0.195 / 2;
    expect(view.surfaceAt(20, -40, 3)).toBeCloseTo(top, 3);
    expect(view.walkableAt(20, -40, 3)?.id).toBe('road');
    // nothing pushes at the edge any more
    const position = new THREE.Vector3(20, 1.7, -29.8);
    const before = position.z;
    view.resolveBlockers(position, 1.7);
    expect(position.z).toBe(before);

    // The controller's own ground query is surfaceAt + walkableAt with a 0.65
    // step reach (client/kernel/player.js groundAt). Player itself cannot be
    // instantiated here -- its constructor binds DOM overlay listeners -- so the
    // two inputs it consumes are asserted directly and the LIVE walk is the
    // parent's replay.
    const surface = view.surfaceAt(20, -40, 1.7 + 0.5, { maxTop: 0 + 0.65 });
    expect(surface).toBeCloseTo(top, 3);
    expect(top).toBeLessThan(0.65);
  });
});

// ---- emitter: the real road prefab, through the real CLIs -------------------
// No synthetic GLBs: the actual Assets/Prefabs/Roads/road.prefab, converted
// models reused READ-ONLY from the existing world cache. Nothing is copied.
const UNITY = process.env.BOOMTOWN_UNITY_PROJECT ?? '/Users/pascaldisse/projects/boomtown-rampage';
const GUIDS = process.env.BOOMTOWN_GUID_DB ?? '/Users/pascaldisse/projects/boomtown-rampage-gwe/tools/unity/out/guids.json';
const MODELS = '/Users/pascaldisse/projects/boomtown-rampage-gwe/tools/unity/out/boomtown-world/assets/models';

describe('MeshCollider emission — real road prefab, real parse/emit CLIs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-meshcollider-'));
  const db = JSON.parse(fs.readFileSync(GUIDS, 'utf8'));
  const roadGuid = Object.entries(db.guids).find(([, rec]) => rec?.path === 'Assets/Prefabs/Roads/road.prefab')?.[0];

  const sceneFor = (guid, name) => {
    const file = path.join(tmp, `${name}.unity`);
    fs.writeFileSync(file, ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!1001 &900', 'PrefabInstance:', '  m_ObjectHideFlags: 0', '  serializedVersion: 2',
      '  m_Modification:', '    serializedVersion: 3', '    m_TransformParent: {fileID: 0}',
      '    m_Modifications:',
      `    - target: {fileID: 7503253669107911983, guid: ${guid}, type: 3}`,
      '      propertyPath: m_LocalPosition.x', '      value: 20', '      objectReference: {fileID: 0}',
      '    m_RemovedComponents: []',
      `  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}`, ''].join(NL));
    return file;
  };
  const emitRoad = (label, extraArgs = [], guidDbPath = GUIDS, guid = roadGuid) => {
    const ir = path.join(tmp, `${label}.ir.json`);
    const parse = spawnSync(NODE, [path.join(repo, 'tools/unity/parse.mjs'), sceneFor(guid, label), '--guids', guidDbPath, '--out', ir], { encoding: 'utf8' });
    expect(parse.status).toBe(0);
    const world = path.join(tmp, `world-${label}`);
    const emit = spawnSync(NODE, [path.join(repo, 'tools/unity/emit.mjs'), ir, world, '--guids', guidDbPath,
      '--cache-dir', path.join(tmp, `cache-${label}`), '--reuse-models', '--model-cache', MODELS, ...extraArgs], { encoding: 'utf8' });
    expect(emit.status).toBe(0);
    const prefabs = fs.readdirSync(path.join(world, 'prefabs'));
    const doc = JSON.parse(fs.readFileSync(path.join(world, 'prefabs', prefabs[0]), 'utf8'));
    return { emit, components: doc.components, prefabs };
  };

  test('the real road: its MeshCollider IS the rendered mesh -> solid surface, non-blocker support', () => {
    expect(fs.existsSync(path.join(UNITY, 'Assets/Prefabs/Roads/road.prefab'))).toBe(true);
    expect(roadGuid).toBeTruthy();
    // raw source proof: MeshFilter and MeshCollider name the SAME mesh
    const text = fs.readFileSync(path.join(UNITY, 'Assets/Prefabs/Roads/road.prefab'), 'utf8');
    const meshes = [...text.matchAll(/m_Mesh: \{fileID: (\d+), guid: ([0-9a-f]{32})/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(meshes.length).toBe(2);
    expect(meshes[0]).toBe(meshes[1]);

    const { components } = emitRoad('road');
    expect(components.mesh.parts[0].solid).toBe(true);
    const box = components.collider.boxes[0];
    expect(box.blocker).toBe(false);
    // the live curb: ~0.19 m tall, well inside the controller's 0.65 step reach
    expect(box.size[1]).toBeLessThan(0.65);
  });

  test('the height rule is policy, not a hidden constant: a lower threshold keeps the blocker', () => {
    const policyFile = path.join(tmp, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ meshColliderWalkableMaxHeight: 0.01 }));
    const { components } = emitRoad('road-strict', ['--policy', policyFile]);
    // the mesh match still makes the surface standable ...
    expect(components.mesh.parts[0].solid).toBe(true);
    // ... but the AABB is now above the configured walkable height, so it blocks
    expect(components.collider.boxes[0].blocker).toBe(true);
  });

  test('a MeshCollider pointing at a DIFFERENT mesh keeps the AABB blocker and says so', () => {
    // the same real prefab with ONLY the collider mesh guid changed, written to a
    // temp file (the Unity source is never modified)
    const source = fs.readFileSync(path.join(UNITY, 'Assets/Prefabs/Roads/road.prefab'), 'utf8');
    const meshGuid = /m_Mesh: \{fileID: \d+, guid: ([0-9a-f]{32})/.exec(source)[1];
    // pick a DIFFERENT mesh that is already converted, so the AABB still resolves
    // and the only difference under test is the mesh mismatch itself
    const manifest = JSON.parse(fs.readFileSync(path.join(MODELS, 'models.json'), 'utf8'));
    const converted = manifest.models.map((m) => path.relative(UNITY, m.source));
    const otherGuid = Object.entries(db.guids).find(([g, rec]) => g !== meshGuid && converted.includes(rec?.path))?.[0];
    expect(otherGuid).toBeTruthy();
    const parts = source.split('MeshCollider:');
    const patched = parts[0] + 'MeshCollider:' + parts[1].replace(meshGuid, otherGuid);
    const proxyPath = path.join(tmp, 'road-proxy.prefab');
    fs.writeFileSync(proxyPath, patched);
    const proxyGuid = '0123456789abcdef0123456789abcdef';
    const proxyDb = path.join(tmp, 'guids-proxy.json');
    fs.writeFileSync(proxyDb, JSON.stringify({ ...db, guids: { ...db.guids, [proxyGuid]: { path: proxyPath, kind: 'prefab' } } }));
    const { emit, components } = emitRoad('road-proxy', [], proxyDb, proxyGuid);
    expect(components.mesh.parts[0].solid).toBe(false);
    expect(components.collider.boxes[0].blocker).toBe(true);
    expect(emit.stderr).toMatch(/MeshCollider mesh differs from the rendered mesh/);
  });
});
