// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three/webgpu';
import { sliceTriangleSoup, trisoupVolume, manifoldEdgeReport } from '../client/extensions/gore/geometry-utils.js';

function cubeSoup(size = 1) {
  const geo = new BoxGeometry(size, size, size).toNonIndexed();
  const pos = geo.attributes.position.array, nrm = geo.attributes.normal.array, uv = geo.attributes.uv.array;
  const verts = []; const tris = [];
  for (let i = 0; i < pos.length / 3; i++) {
    verts.push({ pos: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], normal: [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]], uv: [uv[i * 2], uv[i * 2 + 1]] });
  }
  for (let i = 0; i < verts.length; i += 3) tris.push([i, i + 1, i + 2]);
  return { verts, tris };
}

function flatten(side) {
  const tris = [...side.body, ...side.cap];
  const out = new Float32Array(tris.length * 9);
  let o = 0;
  for (const [a, b, c] of tris) for (const v of [a, b, c]) { out[o++] = v.pos[0]; out[o++] = v.pos[1]; out[o++] = v.pos[2]; }
  return out;
}

test('sanity: BoxGeometry(1,1,1) soup volume is 1', () => {
  const soup = cubeSoup(1);
  const flat = new Float32Array(soup.tris.length * 9);
  let o = 0;
  for (const [a, b, c] of soup.tris) for (const idx of [a, b, c]) { flat[o++] = soup.verts[idx].pos[0]; flat[o++] = soup.verts[idx].pos[1]; flat[o++] = soup.verts[idx].pos[2]; }
  assert.ok(Math.abs(trisoupVolume(flat) - 1) < 1e-6, `volume=${trisoupVolume(flat)}`);
});

test('§5.8 cut plane on unit cube -> stump+piece closed manifolds, volumes sum ≈ 1', () => {
  const soup = cubeSoup(1);
  const result = sliceTriangleSoup(soup, { point: [0, 0.1, 0], normal: [0, 1, 0] });
  assert.ok(result, 'plane must straddle the cube');
  const posFlat = flatten(result.positive), negFlat = flatten(result.negative);
  const posReport = manifoldEdgeReport(posFlat), negReport = manifoldEdgeReport(negFlat);
  assert.ok(posReport.ok, `positive side not closed: ${posReport.bad.join(', ')}`);
  assert.ok(negReport.ok, `negative side not closed: ${negReport.bad.join(', ')}`);
  const vPos = trisoupVolume(posFlat), vNeg = trisoupVolume(negFlat);
  assert.ok(Math.abs(vPos + vNeg - 1) < 1e-3, `vPos=${vPos} vNeg=${vNeg} sum=${vPos + vNeg}`);
  assert.ok(vPos > 0 && vNeg > 0, 'both halves must have positive volume (correct winding)');
});

test('§5.9 plane missing the mesh entirely -> null', () => {
  const soup = cubeSoup(1);
  const result = sliceTriangleSoup(soup, { point: [0, 100, 0], normal: [0, 1, 0] });
  assert.equal(result, null);
});

test('slicing at an off-center offset still balances volumes (0.3 above center)', () => {
  const soup = cubeSoup(1);
  const result = sliceTriangleSoup(soup, { point: [0, 0.3, 0], normal: [0, 1, 0] });
  const vPos = trisoupVolume(flatten(result.positive)), vNeg = trisoupVolume(flatten(result.negative));
  assert.ok(Math.abs(vPos + vNeg - 1) < 1e-3);
  assert.ok(vPos < vNeg, 'a plane above center leaves less volume above it');
});

test('mutant: skipping the cap (body triangles only) leaves an open manifold -> RED', () => {
  const soup = cubeSoup(1);
  const result = sliceTriangleSoup(soup, { point: [0, 0.1, 0], normal: [0, 1, 0] });
  const bodyOnlyFlat = flatten({ body: result.positive.body, cap: [] }); // MUTANT view: drop the cap
  const report = manifoldEdgeReport(bodyOnlyFlat);
  assert.equal(report.ok, false, 'an uncapped cross-section must fail the manifold check');
});
