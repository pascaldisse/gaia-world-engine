// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// Follow-up: cut pieces/stumps must be releasable so per-frame cost does not
// grow with death count. gore.release(obj) + opts.cut.lifetime auto-expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import * as tsl from 'three/tsl';
import { Scene, Mesh, BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { createGore } from '../client/extensions/gore/index.js';

const PLANE = { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } };
function cube() { const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial()); m.updateMatrixWorld(true); return m; }
function make(opts = {}) { const scene = new Scene(); return { scene, gore: createGore({ three, tsl, scene }, opts) }; }

test('release(piece) -> stats.pieces back to 0, removed from scene, geometry disposed', () => {
  const { scene, gore } = make();
  const { piece, stump } = gore.cut(cube(), PLANE);
  assert.equal(gore.stats().pieces, 1);
  let disposed = false; const orig = piece.geometry.dispose.bind(piece.geometry);
  piece.geometry.dispose = () => { disposed = true; orig(); };
  assert.equal(gore.release(piece), true);
  assert.equal(gore.stats().pieces, 0);
  assert.ok(!scene.children.includes(piece));
  assert.ok(disposed, 'geometry.dispose() must be called');
  assert.ok(scene.children.includes(stump), 'stump is independent; still present');
});

test('release(stump) removes stump from scene + list + disposes geometry', () => {
  const { scene, gore } = make();
  const { piece, stump } = gore.cut(cube(), PLANE);
  let disposed = false; const orig = stump.geometry.dispose.bind(stump.geometry);
  stump.geometry.dispose = () => { disposed = true; orig(); };
  assert.equal(gore.release(stump), true);
  assert.ok(!scene.children.includes(stump));
  assert.ok(disposed);
  assert.ok(scene.children.includes(piece));
});

test('release is idempotent; unknown object / bad input = no-op false', () => {
  const { scene, gore } = make();
  const { piece } = gore.cut(cube(), PLANE);
  assert.equal(gore.release(piece), true);
  assert.equal(gore.release(piece), false);
  assert.equal(gore.release(new Mesh(new BoxGeometry(1, 1, 1))), false);
  assert.equal(gore.release(null), false);
  assert.equal(gore.release(undefined), false);
  assert.equal(gore.release({}), false);
  assert.equal(gore.stats().pieces, 0);
});

test('many cuts then release all -> internal lists return to 0 (no growth)', () => {
  const { scene, gore } = make();
  const made = [];
  for (let i = 0; i < 25; i++) made.push(gore.cut(cube(), PLANE));
  assert.equal(gore.stats().pieces, 25);
  for (const { piece, stump } of made) { gore.release(piece); gore.release(stump); }
  assert.equal(gore.stats().pieces, 0);
  assert.equal(scene.children.filter((c) => !c.isInstancedMesh).length, 0);
});

test('released piece is no longer simulated by update()', () => {
  const { gore } = make();
  const { piece } = gore.cut(cube(), PLANE);
  piece.userData.gore.velocity[0] = 5;
  gore.release(piece);
  const x = piece.position.x;
  gore.update(1 / 60);
  assert.equal(piece.position.x, x);
});

test('auto-expiry: opts.cut.lifetime seconds -> piece AND stump released after lifetime', () => {
  const { scene, gore } = make({ cut: { lifetime: 2 } });
  const { piece, stump } = gore.cut(cube(), PLANE);
  for (let i = 0; i < 60; i++) gore.update(1 / 60); // 1s: still alive
  assert.equal(gore.stats().pieces, 1);
  assert.ok(scene.children.includes(stump));
  for (let i = 0; i < 90; i++) gore.update(1 / 60); // 2.5s total: expired
  assert.equal(gore.stats().pieces, 0);
  assert.ok(!scene.children.includes(piece));
  assert.ok(!scene.children.includes(stump));
});

test('default (no lifetime option) never auto-expires', () => {
  const { gore } = make();
  gore.cut(cube(), PLANE);
  for (let i = 0; i < 600; i++) gore.update(1 / 60);
  assert.equal(gore.stats().pieces, 1);
});

test('dispose() after partial release does not double-dispose or throw', () => {
  const { scene, gore } = make();
  const { piece } = gore.cut(cube(), PLANE);
  gore.release(piece);
  assert.doesNotThrow(() => gore.dispose());
  assert.equal(scene.children.length, 0);
});

test('GoreCut internal lists (pieces AND stumps) return to length 0 after release', async () => {
  const { GoreCut } = await import('../client/extensions/gore/cut.js');
  const scene = new Scene();
  const gc = new GoreCut({ three }, scene);
  const made = [];
  for (let i = 0; i < 10; i++) made.push(gc.cut(cube(), PLANE));
  assert.equal(gc.pieces.length, 10);
  assert.equal(gc.stumps.length, 10);
  for (const { piece, stump } of made) { gc.release(piece); gc.release(stump); }
  assert.equal(gc.pieces.length, 0);
  assert.equal(gc.stumps.length, 0);
});

test('auto-expiry empties both internal lists', async () => {
  const { GoreCut } = await import('../client/extensions/gore/cut.js');
  const gc = new GoreCut({ three }, new Scene(), { lifetime: 1 });
  for (let i = 0; i < 5; i++) gc.cut(cube(), PLANE);
  for (let i = 0; i < 90; i++) gc.update(1 / 60);
  assert.equal(gc.pieces.length, 0);
  assert.equal(gc.stumps.length, 0);
});
