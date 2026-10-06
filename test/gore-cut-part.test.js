// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import { Scene, Mesh, BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { GoreCut } from '../client/extensions/gore/cut.js';

// §5.10 fixture: a non-skinned "box-man" -- a single tall box stands in for
// a humanoid silhouette (own design; part bands are bbox fractions so the
// exact limb shape doesn't matter for this test, only its bounding box).
function boxManMesh() {
  const geo = new BoxGeometry(1, 2, 0.6); // width, height, depth
  const mat = new MeshStandardNodeMaterial({ color: 0xdca27a });
  const mesh = new Mesh(geo, mat);
  mesh.updateMatrixWorld(true);
  return mesh;
}

test("§5.10 cut part 'head' -> piece bbox sits above the neck band", () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = boxManMesh();
  const bodyBox = new three.Box3().setFromObject(mesh);
  const neckY = bodyBox.min.y + 0.85 * (bodyBox.max.y - bodyBox.min.y);
  const { piece } = gore.cut(mesh, { part: 'head' });
  assert.ok(piece, 'head cut must succeed on a plain box fixture');
  piece.geometry.computeBoundingBox();
  const pieceBox = piece.geometry.boundingBox;
  const pieceWorldMinY = piece.position.y + pieceBox.min.y;
  assert.ok(pieceWorldMinY >= neckY - 1e-6, `head piece bbox.min.y=${pieceWorldMinY} must be >= neck band ${neckY}`);
});

test('§5.10 every part produces a distinct piece', () => {
  const parts = ['head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
  const results = parts.map((part) => {
    const scene = new Scene();
    const gore = new GoreCut({ three }, scene);
    const mesh = boxManMesh();
    const r = gore.cut(mesh, { part });
    assert.ok(r, `${part} cut must succeed`);
    r.piece.geometry.computeBoundingBox();
    return { part, box: r.piece.geometry.boundingBox.clone(), positions: Array.from(r.piece.geometry.attributes.position.array) };
  });
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i].box, b = results[j].box;
      const sameBox = a.min.equals(b.min) && a.max.equals(b.max);
      const sameVerts = a === b || (results[i].positions.length === results[j].positions.length && results[i].positions.every((v, k) => v === results[j].positions[k]));
      assert.ok(!(sameBox && sameVerts), `${results[i].part} and ${results[j].part} produced identical pieces`);
    }
  }
});

test('unknown part -> null', () => {
  const scene = new Scene();
  const gore = new GoreCut({ three }, scene);
  const mesh = boxManMesh();
  assert.equal(gore.cut(mesh, { part: 'tail' }), null);
});
