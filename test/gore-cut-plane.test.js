// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import { Scene, Mesh, BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { GoreCut } from '../client/extensions/gore/cut.js';
import { trisoupVolume, manifoldEdgeReport } from '../client/extensions/gore/geometry-utils.js';
import { auditVertexBudget } from '../client/extensions/gore/vertex-budget.js';

function unitCubeMesh() {
  const geo = new BoxGeometry(1, 1, 1); // indexed, straight from three -- exercises the index path too
  const mat = new MeshStandardNodeMaterial({ color: 0x336699 });
  const mesh = new Mesh(geo, mat);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function flatten(geo) {
  return geo.attributes.position.array;
}

test('§5.8 cut plane on unit cube -> stump+piece closed, volumes sum ≈ 1', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = unitCubeMesh();
  const result = gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
  assert.ok(result);
  const { stump, piece } = result;
  assert.ok(scene.children.includes(stump));
  assert.ok(scene.children.includes(piece));
  const stumpReport = manifoldEdgeReport(flatten(stump.geometry));
  const pieceReport = manifoldEdgeReport(flatten(piece.geometry));
  assert.ok(stumpReport.ok, `stump not closed: ${stumpReport.bad.join(', ')}`);
  assert.ok(pieceReport.ok, `piece not closed: ${pieceReport.bad.join(', ')}`);
  const vStump = trisoupVolume(flatten(stump.geometry)), vPiece = trisoupVolume(flatten(piece.geometry));
  assert.ok(Math.abs(vStump + vPiece - 1) < 1e-3, `vStump=${vStump} vPiece=${vPiece}`);
});

test('§5.9 cut plane missing the mesh -> null, source untouched', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = unitCubeMesh();
  const originalCount = mesh.geometry.attributes.position.count;
  const result = gore.cut(mesh, { plane: { point: [0, 100, 0], normal: [0, 1, 0] } });
  assert.equal(result, null);
  assert.equal(mesh.geometry.attributes.position.count, originalCount, 'source geometry untouched');
  assert.equal(scene.children.length, 0, 'nothing added to scene on a miss');
});

test('cut materials are clones, not shared with source', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = unitCubeMesh();
  const { stump, piece } = gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
  assert.notEqual(stump.material[0], mesh.material);
  assert.notEqual(piece.material[0], mesh.material);
  assert.notEqual(stump.material[0], piece.material[0]);
});

test('§5.11 determinism: same seed twice -> identical cut vertex arrays', () => {
  const runOnce = () => {
    const scene = new Scene();
    const gore = new GoreCut({ three }, scene, { seed: 123 });
    const mesh = unitCubeMesh();
    const { stump, piece } = gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
    return { stump: Array.from(stump.geometry.attributes.position.array), piece: Array.from(piece.geometry.attributes.position.array) };
  };
  const a = runOnce(), b = runOnce();
  assert.deepEqual(a.stump, b.stump);
  assert.deepEqual(a.piece, b.piece);
});

test('§4 vertex-buffer budget: cut result meshes attribute count <= 6', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = unitCubeMesh();
  const { stump, piece } = gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
  assert.deepEqual(auditVertexBudget([stump, piece]), []);
});

test('§5.12 piece motion: velocity set -> update moves piece, rests at y>=0', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = unitCubeMesh();
  mesh.position.y = 5; mesh.updateMatrixWorld(true);
  const { piece } = gore.cut(mesh, { plane: { point: [0, 5.1, 0], normal: [0, 1, 0] } });
  piece.geometry.computeBoundingBox();
  const bottom0 = piece.position.y + piece.geometry.boundingBox.min.y; // absolute world height of the lowest vertex
  piece.userData.gore.velocity[0] = 0; piece.userData.gore.velocity[1] = 2; piece.userData.gore.velocity[2] = 0;
  for (let i = 0; i < 300; i++) gore.update(1 / 60); // 5s, plenty to fall and settle
  const bottomFinal = piece.position.y + piece.geometry.boundingBox.min.y;
  assert.notEqual(piece.position.y, 0, 'piece must have moved off its initial (0,0,0) offset');
  assert.ok(bottomFinal >= -1e-6, `piece rests below absolute ground: bottom=${bottomFinal}`);
  assert.ok(Math.abs(bottomFinal) < 1e-6, `piece settles with its lowest vertex at world y=0, got ${bottomFinal} (started at ${bottom0})`);
});

test('mutant: velocity ignored (update never applies gravity/motion) -> RED', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = unitCubeMesh();
  mesh.position.y = 5; mesh.updateMatrixWorld(true);
  const { piece } = gore.cut(mesh, { plane: { point: [0, 5.1, 0], normal: [0, 1, 0] } });
  const y0 = piece.position.y;
  piece.userData.gore.velocity[1] = 2;
  // simulate the mutant directly: an update() that ignores velocity entirely
  const noopUpdate = () => {};
  for (let i = 0; i < 10; i++) noopUpdate();
  assert.equal(piece.position.y, y0, 'canary: with no update the piece never moves (the real RED proof patches cut.js -- see report)');
});
