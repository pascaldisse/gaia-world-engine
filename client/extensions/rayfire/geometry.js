// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §1 plain-vec math, §3.5 watertight oracle, §3.6 volume. No engine/THREE dependency.
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const len = a => Math.hypot(a.x, a.y, a.z);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export function normalize(a) { const l = len(a); return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 }; }

export const isFace = f => f && Array.isArray(f.verts);

// Faces -> triangles by fan (v0, vi, vi+1); triangles pass through.
export function toTriangles(input) {
  const out = [];
  for (const f of input) {
    if (isFace(f)) { for (let i = 1; i < f.verts.length - 1; i++) out.push([f.verts[0], f.verts[i], f.verts[i + 1]]); }
    else out.push(f);
  }
  return out;
}

// Signed volume, divergence theorem over signed tetrahedra to a reference vertex (kept near the mesh for precision).
export function meshVolume(triangles) {
  if (!triangles.length) return 0;
  const o = triangles[0][0];
  let s = 0;
  for (const [a, b, c] of triangles) {
    const ax = a.x - o.x, ay = a.y - o.y, az = a.z - o.z;
    const bx = b.x - o.x, by = b.y - o.y, bz = b.z - o.z;
    const cx = c.x - o.x, cy = c.y - o.y, cz = c.z - o.z;
    s += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return s / 6;
}
export const facesVolume = faces => meshVolume(toTriangles(faces));

export function boundsOf(points) {
  const min = v3(Infinity, Infinity, Infinity), max = v3(-Infinity, -Infinity, -Infinity);
  for (const p of points) {
    if (p.x < min.x) min.x = p.x; if (p.y < min.y) min.y = p.y; if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x; if (p.y > max.y) max.y = p.y; if (p.z > max.z) max.z = p.z;
  }
  return { min, max };
}
export function boundsOfFaces(faces) {
  const min = v3(Infinity, Infinity, Infinity), max = v3(-Infinity, -Infinity, -Infinity);
  for (const f of faces) for (const p of (isFace(f) ? f.verts : f)) {
    if (p.x < min.x) min.x = p.x; if (p.y < min.y) min.y = p.y; if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x; if (p.y > max.y) max.y = p.y; if (p.z > max.z) max.z = p.z;
  }
  return { min, max };
}
export const diagonalOf = b => Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);

// Fixed-precision coordinate key (§3.5, U5). Quantum is scale-relative so producer (weld/close) and
// checker agree for any model size: quantum = diag * QUANTUM_REL (floor 1e-12).
export const QUANTUM_REL = 1e-9;
export function quantumFor(polys) {
  const d = diagonalOf(boundsOfFaces(polys));
  return Math.max(d * QUANTUM_REL, 1e-12);
}

// Directed-edge oracle: every directed edge has exactly one reverse twin and no directed edge repeats.
// Keys: exact coordinates first (what the producers guarantee — cut points are computed canonically), else fixed-
// precision keys (scale-relative quantum) so float-noisy inputs still count as closed. Either passing = watertight.
export function isWatertight(input, quantum) {
  const polys = input.map(f => (isFace(f) ? f.verts : f));
  if (!polys.length) return false;
  if (checkClosed(polys, 0)) return true;
  return checkClosed(polys, quantum ?? quantumFor(polys));
}

function checkClosed(polys, q) {
  const ids = new Map();
  const idOf = q > 0
    ? p => { const k = `${Math.round(p.x / q)},${Math.round(p.y / q)},${Math.round(p.z / q)}`; let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); } return id; }
    : p => { const k = `${p.x},${p.y},${p.z}`; let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); } return id; };
  const SH = 67108864; // 2^26 ids per axis: key stays an exact double
  const dir = new Set();
  let edges = 0;
  for (const verts of polys) {
    const n = verts.length;
    let prev = idOf(verts[n - 1]);
    for (let i = 0; i < n; i++) {
      const cur = idOf(verts[i]);
      if (prev !== cur) {
        const k = prev * SH + cur;
        if (dir.has(k)) return false;
        dir.add(k); edges++;
      }
      prev = cur;
    }
  }
  if (!edges) return false;
  for (const k of dir) {
    const a = Math.floor(k / SH), b = k - a * SH;
    if (!dir.has(b * SH + a)) return false;
  }
  return true;
}
