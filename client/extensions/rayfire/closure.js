// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §3.3-3.4 boundary detection + loop capping (used to pre-close the source AND post-close each cell)
// and source preparation (weld / clean / consistent orientation / positive volume).
// Boundary test = the standard half-edge one: a directed edge without a reverse twin is open.
// Loop capping = chain the missing reverse edges into loops, triangulate each loop (convex -> one
// polygon; concave -> ear clipping, Meisters 1975, https://en.wikipedia.org/wiki/Polygon_triangulation#Ear_clipping_method;
// last resort centroid fan). Every path is edge-exact, so capping always closes what it chains.
import { sub, cross, dot, len, boundsOf, diagonalOf } from './geometry.js';

export const WELD_REL = 1e-7;
export const FLAT_COMPONENT_REL = 1e-7; // |volume| ≤ this × diag³ ⇒ component is a flat sheet

const keyOf = (p, q) => (q > 0 ? `${Math.round(p.x / q)},${Math.round(p.y / q)},${Math.round(p.z / q)}` : `${p.x},${p.y},${p.z}`);

// Newell normal (area-weighted, unnormalised) of a closed polygon.
function newell(pts) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a.y - b.y) * (a.z + b.z); y += (a.z - b.z) * (a.x + b.x); z += (a.x - b.x) * (a.y + b.y);
  }
  return { x, y, z };
}

function centroidFan(pts) {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of pts) { c.x += p.x; c.y += p.y; c.z += p.z; }
  c.x /= pts.length; c.y /= pts.length; c.z /= pts.length;
  const out = [];
  for (let i = 0; i < pts.length; i++) out.push([c, pts[i], pts[(i + 1) % pts.length]]);
  return out;
}

// Loop (CCW about its own Newell normal) -> convex polygons whose perimeter edges are exactly the loop edges
// (plus internal diagonals that cancel pairwise). Returns vec[][] polygons.
export function capPolygons(loop, conflict = null) {
  const pts = [];
  for (const p of loop) { const l = pts[pts.length - 1]; if (!l || l.x !== p.x || l.y !== p.y || l.z !== p.z) pts.push(p); }
  while (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y && pts[0].z === pts[pts.length - 1].z) pts.pop();
  if (pts.length < 3) return [];
  const n = newell(pts);
  const nl = len(n);
  let ext = 0; for (const p of pts) ext = Math.max(ext, Math.abs(p.x - pts[0].x) + Math.abs(p.y - pts[0].y) + Math.abs(p.z - pts[0].z));
  if (!(nl > ext * ext * 1e-9)) return centroidFan(pts); // ~zero area / collinear: fan keeps the edges exact
  const un = { x: n.x / nl, y: n.y / nl, z: n.z / nl };
  // planarity + convexity
  let planar = true, convex = true;
  const tol = ext * 1e-6;
  for (const p of pts) if (Math.abs(dot(sub(p, pts[0]), un)) > tol) { planar = false; break; }
  if (!planar) return centroidFan(pts);
  for (let i = 0; i < pts.length && convex; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    if (dot(cross(sub(b, a), sub(c, b)), un) < -ext * ext * 1e-9) convex = false;
  }
  if (convex) return [pts];
  const ears = earClip(pts, un);
  if (!ears) return centroidFan(pts);
  if (conflict) { // an ear-clip diagonal that coincides with an existing mesh edge would repeat a directed edge
    const dir = new Map(); const K = p => `${p.x},${p.y},${p.z}`;
    for (const t of ears) for (let i = 0; i < 3; i++) dir.set(K(t[i]) + '>' + K(t[(i + 1) % 3]), [t[i], t[(i + 1) % 3]]);
    for (const [k, [a, b]] of dir) if (dir.has(K(b) + '>' + K(a)) && (conflict(a, b) || conflict(b, a))) return centroidFan(pts);
  }
  return ears;
}

function earClip(pts, un) {
  // project along dominant axis of the normal, keep orientation sign
  const ax = Math.abs(un.x), ay = Math.abs(un.y), az = Math.abs(un.z);
  let U, V, sgn;
  if (ax >= ay && ax >= az) { U = 'y'; V = 'z'; sgn = Math.sign(un.x); }
  else if (ay >= az) { U = 'z'; V = 'x'; sgn = Math.sign(un.y); }
  else { U = 'x'; V = 'y'; sgn = Math.sign(un.z); }
  const c2 = (a, b, c) => sgn * ((b[U] - a[U]) * (c[V] - a[V]) - (b[V] - a[V]) * (c[U] - a[U]));
  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = pts.length * pts.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let best = -1, bestCross = Infinity, found = false;
    for (let k = 0; k < idx.length; k++) {
      const a = pts[idx[(k + idx.length - 1) % idx.length]], b = pts[idx[k]], c = pts[idx[(k + 1) % idx.length]];
      const cr = c2(a, b, c);
      if (Math.abs(cr) < bestCross) { bestCross = Math.abs(cr); best = k; }
      if (!(cr > 0)) continue;
      let ok = true;
      for (let m = 0; m < idx.length && ok; m++) {
        const p = pts[idx[m]];
        if (p === a || p === b || p === c) continue;
        if ((p[U] === a[U] && p[V] === a[V]) || (p[U] === b[U] && p[V] === b[V]) || (p[U] === c[U] && p[V] === c[V])) continue;
        if (c2(a, b, p) >= 0 && c2(b, c, p) >= 0 && c2(c, a, p) >= 0) ok = false; // boundary points block the ear too
      }
      if (ok) { tris.push([a, b, c]); idx.splice(k, 1); found = true; break; }
    }
    if (!found) { // no strict ear: clip the flattest vertex as a (near) zero-area triangle; edge-exact, always terminates
      const k = best;
      tris.push([pts[idx[(k + idx.length - 1) % idx.length]], pts[idx[k]], pts[idx[(k + 1) % idx.length]]]);
      idx.splice(k, 1);
    }
  }
  if (idx.length !== 3) return null;
  tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  return tris;
}

// Chain directed edges {a,b} (vec endpoints, key-matched) into loops. Returns { loops: vec[][], dangling:number }.
// A walk that revisits a vertex cuts the sub-loop out (figure-eights / non-manifold junctions split cleanly).
export function chainLoops(edges, quantum = 0) {
  const out = new Map();
  edges.forEach((e, i) => { e.ka = keyOf(e.a, quantum); e.kb = keyOf(e.b, quantum); const l = out.get(e.ka); if (l) l.push(i); else out.set(e.ka, [i]); });
  const used = new Uint8Array(edges.length);
  const loops = [];
  let dangling = 0;
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    const path = [], keys = [], pos = new Map();
    let e = s;
    while (e !== undefined) {
      used[e] = 1;
      const ed = edges[e];
      pos.set(ed.ka, path.length); path.push(ed.a); keys.push(ed.ka);
      if (pos.has(ed.kb)) {
        const from = pos.get(ed.kb);
        loops.push(path.splice(from));
        for (const k of keys.splice(from)) pos.delete(k);
        if (!path.length) break;
      }
      e = (out.get(ed.kb) ?? []).find(i => !used[i]);
    }
    dangling += path.length;
  }
  return { loops, dangling };
}

// Cap every open boundary loop of a polygon set. Returns { faces (input + caps), capped, uncapped }.
export function closeBoundaries(faces, { interiorMaterial = 1, quantum = 0 } = {}) {
  const ids = new Map(), pts = [];
  const idOf = p => { const k = keyOf(p, quantum); let id = ids.get(k); if (id === undefined) { id = pts.length; ids.set(k, id); pts.push(p); } return id; };
  const SH = 67108864, cnt = new Map();
  for (const f of faces) {
    const v = f.verts, n = v.length; let prev = idOf(v[n - 1]);
    for (let i = 0; i < n; i++) { const cur = idOf(v[i]); if (prev !== cur) { const k = prev * SH + cur; cnt.set(k, (cnt.get(k) ?? 0) + 1); } prev = cur; }
  }
  const need = [];
  for (const [k, c] of cnt) {
    const a = Math.floor(k / SH), b = k - a * SH;
    const excess = c - (cnt.get(b * SH + a) ?? 0);
    for (let i = 0; i < excess; i++) need.push({ a: pts[b], b: pts[a] }); // the cap must supply b->a
  }
  if (!need.length) return { faces, capped: 0, uncapped: false };
  const { loops, dangling } = chainLoops(need, quantum);
  const out = faces.slice(); let capped = 0;
  const conflict = (a, b) => cnt.has(idOf(a) * SH + idOf(b));
  for (const loop of loops) for (const poly of capPolygons(loop, conflict)) { out.push({ verts: poly, interior: true, materialId: interiorMaterial }); capped++; }
  return { faces: out, capped, uncapped: dangling > 0 };
}

// Source preparation: triangle soup -> closed proxy face list (§3.4 step 1).
export function closeOpenShell(triangles, { exteriorMaterial = 0, interiorMaterial = 1, orient = true } = {}) {
  const all = []; for (const t of triangles) for (const p of t) all.push(p);
  if (!all.length) return { faces: [], uncappedLoops: false, capped: 0, aabb: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } };
  const aabb = boundsOf(all), diag = diagonalOf(aabb);
  const wq = Math.max(diag * WELD_REL, 1e-12);
  // weld
  const wmap = new Map(), verts = [];
  const wid = p => {
    const k = keyOf(p, wq); let i = wmap.get(k);
    if (i === undefined) { i = verts.length; wmap.set(k, i); verts.push({ x: p.x, y: p.y, z: p.z }); }
    return i;
  };
  let tris = [], seenTri = new Set();
  for (const t of triangles) {
    const a = wid(t[0]), b = wid(t[1]), c = wid(t[2]);
    if (a === b || b === c || a === c) continue; // degenerate
    // canonical cyclic rotation: identical-orientation duplicates collapse to one
    const m = Math.min(a, b, c);
    const key = m === a ? `${a},${b},${c}` : m === b ? `${b},${c},${a}` : `${c},${a},${b}`;
    if (seenTri.has(key)) continue;
    seenTri.add(key); tris.push([a, b, c]);
  }
  if (orient) orientConsistently(tris);
  tris = dropRepeatedEdges(tris);
  let faces = tris.map(([a, b, c]) => ({ verts: [verts[a], verts[b], verts[c]], interior: false, materialId: exteriorMaterial }));
  const closed = closeBoundaries(faces, { interiorMaterial, quantum: 0 });
  faces = closed.faces;
  if (orient) faces = fixComponentSigns(faces);
  return { faces, uncappedLoops: closed.uncapped, capped: closed.capped, aabb };
}

// A directed edge may appear at most once (a repeat = non-manifold fin no cap can ever repair): greedily drop the
// triangle that would repeat one. Afterwards boundary in/out degrees balance at every vertex, so capping always closes.
function dropRepeatedEdges(tris) {
  const SH = 67108864, dir = new Set(), kept = [];
  for (const t of tris) {
    const k0 = t[0] * SH + t[1], k1 = t[1] * SH + t[2], k2 = t[2] * SH + t[0];
    if (dir.has(k0) || dir.has(k1) || dir.has(k2)) continue;
    dir.add(k0); dir.add(k1); dir.add(k2); kept.push(t);
  }
  return kept;
}

// Make triangle winding consistent across edge-manifold neighbours (BFS), in place.
function orientConsistently(tris) {
  const N = tris.length, SH = 67108864;
  const edgeTris = new Map();
  tris.forEach((t, i) => { for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; const k = Math.min(a, b) * SH + Math.max(a, b); const l = edgeTris.get(k); if (l) l.push(i); else edgeTris.set(k, [i]); } });
  const seen = new Uint8Array(N);
  const hasDir = (t, a, b) => (t[0] === a && t[1] === b) || (t[1] === a && t[2] === b) || (t[2] === a && t[0] === b);
  for (let s = 0; s < N; s++) {
    if (seen[s]) continue;
    seen[s] = 1; const q = [s];
    while (q.length) {
      const ti = q.pop(), t = tris[ti];
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3];
        const l = edgeTris.get(Math.min(a, b) * SH + Math.max(a, b));
        if (l.length !== 2) continue;
        const u = l[0] === ti ? l[1] : l[0];
        if (seen[u]) continue;
        seen[u] = 1;
        if (hasDir(tris[u], a, b)) { const x = tris[u]; tris[u] = [x[0], x[2], x[1]]; }
        q.push(u);
      }
    }
  }
}

// Flip whole (vertex-connected) components whose signed volume is negative.
function fixComponentSigns(faces) {
  const id = new Map(), par = [], ref = [];
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const idx = p => { let i = id.get(p); if (i === undefined) { i = par.length; id.set(p, i); par.push(i); ref.push(p); } return i; };
  for (const f of faces) { const r = idx(f.verts[0]); for (let i = 1; i < f.verts.length; i++) { const a = find(r), b = find(idx(f.verts[i])); if (a !== b) par[a] = b; } }
  const vol = new Map();
  for (const f of faces) {
    const c = find(idx(f.verts[0])), o = ref[c], v = f.verts;
    let s = 0;
    for (let i = 1; i < v.length - 1; i++) {
      const ax = v[0].x - o.x, ay = v[0].y - o.y, az = v[0].z - o.z, bx = v[i].x - o.x, by = v[i].y - o.y, bz = v[i].z - o.z, cx = v[i + 1].x - o.x, cy = v[i + 1].y - o.y, cz = v[i + 1].z - o.z;
      s += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    vol.set(c, (vol.get(c) ?? 0) + s / 6);
  }
  // per-component extent (flat-sheet test below)
  const lo = new Map(), hi = new Map();
  for (const f of faces) {
    const c = find(idx(f.verts[0]));
    let l = lo.get(c), h = hi.get(c);
    if (!l) { l = [Infinity, Infinity, Infinity]; h = [-Infinity, -Infinity, -Infinity]; lo.set(c, l); hi.set(c, h); }
    for (const p of f.verts) { if (p.x < l[0]) l[0] = p.x; if (p.y < l[1]) l[1] = p.y; if (p.z < l[2]) l[2] = p.z; if (p.x > h[0]) h[0] = p.x; if (p.y > h[1]) h[1] = p.y; if (p.z > h[2]) h[2] = p.z; }
  }
  const flat = c => { const d = Math.hypot(hi.get(c)[0] - lo.get(c)[0], hi.get(c)[1] - lo.get(c)[1], hi.get(c)[2] - lo.get(c)[2]); return Math.abs(vol.get(c)) <= FLAT_COMPONENT_REL * d * d * d; };
  const out = [];
  for (const f of faces) {
    const c = find(idx(f.verts[0]));
    if (flat(c)) continue; // zero-volume sheet (+ its own cap): no fragment can come from it, and its coincident faces would only poison cuts
    out.push(vol.get(c) < 0 ? { ...f, verts: f.verts.slice().reverse() } : f);
  }
  return out;
}
