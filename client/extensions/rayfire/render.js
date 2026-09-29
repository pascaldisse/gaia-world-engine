// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §4-5 render conversion + THREE scene glue. With hull.js, the ONLY files that import THREE.
import * as THREE from 'three';
import { fractureCells } from './fracture.js';
import { boundsOfFaces } from './geometry.js';

// Face set -> one non-indexed triangle-soup BufferGeometry: position + FLAT per-triangle normals,
// group 0 = exterior faces (material slot 0), group 1 = interior/cut faces (material slot 1).
export function facesToBufferGeometry(faces) {
  const outer = [], inner = [];
  for (const f of faces) (f.interior ? inner : outer).push(f);
  const ordered = [...outer, ...inner];
  let tri = 0;
  for (const f of ordered) tri += Math.max(0, f.verts.length - 2);
  const pos = new Float32Array(tri * 9), nor = new Float32Array(tri * 9);
  let o = 0, outerVerts = 0;
  for (let fi = 0; fi < ordered.length; fi++) {
    const v = ordered[fi].verts;
    // whole-face normal is the fallback for a zero-area triangle of a fan
    let fx = 0, fy = 0, fz = 0;
    for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length]; fx += (a.y - b.y) * (a.z + b.z); fy += (a.z - b.z) * (a.x + b.x); fz += (a.x - b.x) * (a.y + b.y); }
    const fl = Math.hypot(fx, fy, fz) || 1;
    for (let i = 1; i < v.length - 1; i++) {
      const a = v[0], b = v[i], c = v[i + 1];
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-30) { nx /= l; ny /= l; nz /= l; } else { nx = fx / fl; ny = fy / fl; nz = fz / fl; }
      for (const p of [a, b, c]) { pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z; nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz; o += 3; }
    }
    if (fi === outer.length - 1) outerVerts = o / 3;
  }
  if (!outer.length) outerVerts = 0;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const total = o / 3;
  if (outerVerts > 0) g.addGroup(0, outerVerts, 0);
  if (total - outerVerts > 0) g.addGroup(outerVerts, total - outerVerts, 1);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// THREE BufferGeometry (indexed or not) -> plain-vec triangle soup.
export function geometryToTriangles(geometry) {
  const p = geometry?.attributes?.position;
  if (!p) return [];
  const V = i => ({ x: p.getX(i), y: p.getY(i), z: p.getZ(i) });
  const tris = [], idx = geometry.index;
  if (idx) for (let i = 0; i + 2 < idx.count; i += 3) tris.push([V(idx.getX(i)), V(idx.getX(i + 1)), V(idx.getX(i + 2))]);
  else for (let i = 0; i + 2 < p.count; i += 3) tris.push([V(i), V(i + 1), V(i + 2)]);
  return tris;
}

export function defaultMaterials() {
  return [new THREE.MeshStandardMaterial({ color: 0x999999 }), new THREE.MeshStandardMaterial({ color: 0x8a6d4b })];
}

function centroidOf(faces) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const f of faces) for (const p of f.verts) { x += p.x; y += p.y; z += p.z; n++; }
  return n ? { x: x / n, y: y / n, z: z / n } : { x: 0, y: 0, z: 0 };
}

// Object3D-with-geometry | BufferGeometry -> THREE.Mesh[] (one per fragment cell).
export function fracture(input, opts = {}) {
  let geometry, source = null;
  if (input && input.isBufferGeometry) geometry = input;
  else if (input && input.isObject3D && input.geometry && input.geometry.isBufferGeometry) { geometry = input.geometry; source = input; }
  else throw new Error('fracture: input must be a THREE.Object3D with a .geometry, or a THREE.BufferGeometry');
  if (source) source.updateWorldMatrix(true, false);
  const cells = fractureCells(geometryToTriangles(geometry), opts);
  const mats = opts.materials ? [opts.materials.outer, opts.materials.inner] : defaultMaterials();
  return cells.map(cell => {
    const mesh = new THREE.Mesh(facesToBufferGeometry(cell.faces), mats);
    if (source) { mesh.matrixAutoUpdate = false; mesh.matrix.copy(source.matrixWorld); mesh.matrixWorldNeedsUpdate = true; }
    mesh.userData.rayfire = { index: cell.index, centroidLocal: centroidOf(cell.faces), aabbLocal: boundsOfFaces(cell.faces) };
    return mesh;
  });
}
