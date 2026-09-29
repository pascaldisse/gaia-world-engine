// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §3.4 step 3: guaranteed last resort = convex hull of the fragment's own vertices (QuickHull, Barber et al. 1996,
// https://doi.org/10.1145/235815.235821; the ONE place the fracture layer touches THREE: its ConvexHull add-on).
// Sliver hardening: weld near-duplicate points along an escalating epsilon ladder, drop zero-area triangles,
// keep the first result the watertight oracle accepts; absolute final fallback = padded AABB box.
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { Vector3 } from 'three';
import { boundsOf, diagonalOf, isWatertight, cross, sub, len } from './geometry.js';

export const HULL_WELD_LADDER = Object.freeze([1e-5, 1e-4, 3e-4, 1e-3, 1e-2, 1e-1]);

// points: [{x,y,z,exterior:boolean}] -> face[] (triangles). Never throws.
export function hullFaces(points, { exteriorMaterial = 0, interiorMaterial = 1 } = {}) {
  const box = () => boxFaces(points, exteriorMaterial, interiorMaterial);
  if (points.length < 4) return { faces: box(), boxed: true };
  const diag = diagonalOf(boundsOf(points)) || 1;
  for (const rel of HULL_WELD_LADDER) {
    try {
      const eps = diag * rel;
      const cl = new Map();
      for (const p of points) {
        const k = `${Math.round(p.x / eps)},${Math.round(p.y / eps)},${Math.round(p.z / eps)}`;
        const c = cl.get(k);
        if (c) c.exterior = c.exterior && !!p.exterior; else cl.set(k, { x: p.x, y: p.y, z: p.z, exterior: !!p.exterior });
      }
      const welded = [...cl.values()];
      if (welded.length < 4) continue;
      const vs = welded.map(p => { const v = new Vector3(p.x, p.y, p.z); v.rfXExterior = p.exterior; return v; });
      const hull = new ConvexHull().setFromPoints(vs);
      const faces = [];
      for (const f of hull.faces) {
        const pts = []; let e = f.edge;
        do { pts.push(e.head().point); e = e.next; } while (e !== f.edge);
        for (let i = 1; i < pts.length - 1; i++) {
          const tri = [pts[0], pts[i], pts[i + 1]];
          const a = { x: tri[0].x, y: tri[0].y, z: tri[0].z }, b = { x: tri[1].x, y: tri[1].y, z: tri[1].z }, c = { x: tri[2].x, y: tri[2].y, z: tri[2].z };
          if (len(cross(sub(b, a), sub(c, a))) <= eps * eps * 1e-3) continue; // zero-area sliver
          const ext = tri.every(t => t.rfXExterior === true);
          faces.push({ verts: [a, b, c], interior: !ext, materialId: ext ? exteriorMaterial : interiorMaterial });
        }
      }
      if (faces.length >= 4 && isWatertight(faces)) return { faces, boxed: false };
    } catch { /* escalate the ladder */ }
  }
  return { faces: box(), boxed: true };
}

// Padded AABB box of the point set: trivially watertight, outward-wound.
function boxFaces(points, ext, int) {
  const b = boundsOf(points.length ? points : [{ x: 0, y: 0, z: 0 }]);
  const pad = Math.max(diagonalOf(b) * 1e-3, 1e-6);
  const lo = [b.min.x - pad, b.min.y - pad, b.min.z - pad], hi = [b.max.x + pad, b.max.y + pad, b.max.z + pad];
  const faces = [];
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    for (const s of [1, -1]) {
      const at = s > 0 ? hi[a] : lo[a];
      const P = (i, j) => { const p = [0, 0, 0]; p[a] = at; p[u] = i ? hi[u] : lo[u]; p[v] = j ? hi[v] : lo[v]; return { x: p[0], y: p[1], z: p[2] }; };
      const q = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)]; if (s < 0) q.reverse();
      faces.push({ verts: q, interior: true, materialId: int });
    }
  }
  void ext;
  return faces;
}

export const _boxFacesForTest = boxFaces;
