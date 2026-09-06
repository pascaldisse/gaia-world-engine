import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepOnlyModelMeshFileID, unityMeshFileID } from '../tools/unity/convert-model.mjs';

// `--mesh-fileid` exists so a caller can pull ONE sub-mesh out of a converted
// model. It had two silent fallbacks that both keep the WHOLE model when the
// requested mesh cannot be proven present: a <=1-mesh early return that never
// checks whether that one mesh is the requested one, and an unmatched-fileID
// warning. A caller that depends on the narrowing then receives an entire
// authoring scene -- including that scene's layout offsets in the node matrices --
// and nothing fails. `strict` turns both into refusals.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-strict-mesh-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a real GLB container (JSON chunk + empty BIN), written the way the tool reads it
function writeGlb(file, json) {
  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonText.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonText, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  fs.writeFileSync(file, Buffer.concat([header, chunkHeader, jsonChunk]));
  return file;
}
const readGlbJson = (file) => {
  const data = fs.readFileSync(file);
  const len = data.readUInt32LE(12);
  return JSON.parse(data.subarray(20, 20 + len).toString('utf8'));
};

// A car-shaped model: an authoring-scene root whose body node carries the scene
// layout offset, plus wheels -- exactly the case that displaced the traffic cars.
// the fileID is the hash of the mesh NAME, so derive it the way Unity does
// rather than pasting a number that would not match anything
const BODY_NAME = 'Car3_black';
const WHEEL_NAME = 'WheelFL.004';
const BODY_FID = unityMeshFileID(BODY_NAME);
const WHEEL_FID = unityMeshFileID(WHEEL_NAME);
const multiMesh = () => ({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'RootNode', children: [1] },
    { name: BODY_NAME, mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -6.3296, 0.2444, 36.4685, 1], children: [2] },
    { name: WHEEL_NAME, mesh: 1, translation: [0.7657, 0.0371, 1.2528] },
  ],
  meshes: [{ name: BODY_NAME }, { name: WHEEL_NAME }],
});

test('strict REFUSES an unmatched fileID instead of keeping the whole model', () => {
  const file = writeGlb(path.join(tmp, 'multi.glb'), multiMesh());
  // old behaviour, still the default: warn and keep everything
  assert.equal(keepOnlyModelMeshFileID(file, '999999'), false);
  assert.equal(readGlbJson(file).nodes.length, 3, 'the whole model survived the silent fallback');
  // strict: an error naming what was actually in the file
  assert.throws(() => keepOnlyModelMeshFileID(file, '999999', null, { strict: true }),
    /did not match any GLB node\/mesh name[\s\S]*Car3_black/);
});

test('strict REFUSES a single-mesh model that is not the requested mesh', () => {
  const single = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'OnlyThing', mesh: 0 }],
    meshes: [{ name: 'OnlyThing' }],
  };
  const file = writeGlb(path.join(tmp, 'single.glb'), single);
  // the <=1-mesh early return never checked the id at all
  assert.equal(keepOnlyModelMeshFileID(file, BODY_FID), false);
  assert.throws(() => keepOnlyModelMeshFileID(file, BODY_FID, null, { strict: true }),
    /is not the single mesh/);
});

test('a real narrowing still succeeds under strict, and drops the layout offset', () => {
  const file = writeGlb(path.join(tmp, 'narrow.glb'), multiMesh());
  assert.equal(keepOnlyModelMeshFileID(file, BODY_FID, null, { strict: true }), true);
  const json = readGlbJson(file);
  const withMesh = json.nodes.filter((n) => n.mesh != null);
  assert.equal(withMesh.length, 1, 'only the requested sub-mesh is left');
  assert.equal(withMesh[0].mesh, 0);
  // the authoring-scene placement is NOT carried into the narrowed model: the
  // caller supplies the pose from the prefab instead
  for (const node of json.nodes) {
    assert.equal(node.translation, undefined, `${node.name ?? '<unnamed>'} keeps no translation`);
    assert.equal(node.matrix, undefined, `${node.name ?? '<unnamed>'} keeps no matrix`);
    assert.equal(node.rotation, undefined, `${node.name ?? '<unnamed>'} keeps no rotation`);
  }
});

test('the prefab-asset handle 100100000 still means "the whole model"', () => {
  const file = writeGlb(path.join(tmp, 'whole.glb'), multiMesh());
  assert.equal(keepOnlyModelMeshFileID(file, '100100000', null, { strict: true }), false);
  assert.equal(readGlbJson(file).nodes.length, 3);
});

test('the CLI exposes --strict-mesh', () => {
  const source = fs.readFileSync(path.join(repo, 'tools/unity/convert-model.mjs'), 'utf8');
  assert.match(source, /--strict-mesh/);
  assert.match(source, /strict: strictMesh/);
});
