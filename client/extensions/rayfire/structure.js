// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §8 anchors, §9 connectivity, §10 support propagation + stress erosion. Pure plain-vec math, no THREE.
import { rand01 } from './prng.js';

// ---- §8 anchors ---------------------------------------------------------------------------
export function pointInBox(p, { center, size }) {
  return Math.abs(p.x - center.x) <= size.x / 2 && Math.abs(p.y - center.y) <= size.y / 2 && Math.abs(p.z - center.z) <= size.z / 2;
}
export function markUnyielding(fragments, box) {
  let n = 0;
  for (const f of fragments) if (pointInBox(f.centroid, box)) { f.unyielding = true; n++; }
  return n;
}

// ---- §9 connectivity ----------------------------------------------------------------------
// Bounding-box adjacency: every pair whose AABBs (each grown by `expand` on all sides) overlap (touching counts).
export function buildAdjacency(fragments, { expand = 0 } = {}) {
  const edges = [], n = fragments.length;
  // sweep on x keeps this near-linear for tiled cell sets
  const order = fragments.map((_, i) => i).sort((a, b) => fragments[a].aabb.min.x - fragments[b].aabb.min.x || a - b);
  const found = [];
  for (let oi = 0; oi < n; oi++) {
    const a = fragments[order[oi]].aabb;
    for (let oj = oi + 1; oj < n; oj++) {
      const b = fragments[order[oj]].aabb;
      if (b.min.x - expand > a.max.x + expand) break;
      if (b.min.y - expand > a.max.y + expand || b.max.y + expand < a.min.y - expand) continue;
      if (b.min.z - expand > a.max.z + expand || b.max.z + expand < a.min.z - expand) continue;
      const i = order[oi], j = order[oj];
      found.push(i < j ? [i, j] : [j, i]);
    }
  }
  found.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const e of found) edges.push(e);
  return edges;
}

export function assignJointStrength(edges, fragments, { breakForce = 100, breakForceVar = 10, forceByMass = false, seed = 1 } = {}) {
  return edges.map(([i, j]) => {
    const lo = Math.min(i, j), hi = Math.max(i, j);
    let s = breakForce + (2 * rand01(seed, lo, hi) - 1) * breakForceVar;
    if (forceByMass) s *= (fragments[i]?.volume ?? 1) + (fragments[j]?.volume ?? 1);
    return { i, j, broken: false, strength: Math.max(0, s) };
  });
}

export function breakJoints(joints, forceAt) {
  let n = 0;
  for (const j of joints) {
    if (j.broken) continue;
    if (Math.max(forceAt(j.i), forceAt(j.j)) > j.strength) { j.broken = true; n++; }
  }
  return n;
}

export function connectedComponents(fragmentCount, joints) {
  const par = Array.from({ length: fragmentCount }, (_, i) => i);
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (const j of joints) {
    if (j.broken) continue;
    const a = find(j.i), b = find(j.j);
    if (a !== b) par[Math.max(a, b)] = Math.min(a, b); // root = smallest index
  }
  const groups = new Map();
  for (let i = 0; i < fragmentCount; i++) { const r = find(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
  return [...groups.values()];
}

export function partitionByUnyielding(components, fragments) {
  const held = [], released = [];
  for (const c of components) (c.some(i => fragments[i]?.unyielding) ? held : released).push(c);
  return { held, released };
}

// ---- §10 support + erosion ---------------------------------------------------------------
const DEFAULT_GRAVITY = Object.freeze({ x: 0, y: -1, z: 0 });
function upOf(gravity) {
  const l = Math.hypot(gravity.x, gravity.y, gravity.z) || 1;
  return { x: -gravity.x / l, y: -gravity.y / l, z: -gravity.z / l };
}
// angle (deg) between `up` and the direction a -> b
function angleFromUp(a, b, up) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l = Math.hypot(dx, dy, dz);
  if (!(l > 0)) return 0;
  const c = Math.min(1, Math.max(-1, (dx * up.x + dy * up.y + dz * up.z) / l));
  return Math.acos(c) * 180 / Math.PI;
}

function adjacencyOf(n, joints) {
  const adj = Array.from({ length: n }, () => []);
  for (const j of joints) if (!j.broken) { adj[j.i].push(j.j); adj[j.j].push(j.i); }
  return adj;
}

// Breadth-first from every unyielding fragment; a neighbour is supported iff its direction from the supporter is within
// `support` degrees of straight up. Unyielding fragments are the ONLY source.
export function computeSupport(fragments, joints, { support = 45, gravity = DEFAULT_GRAVITY } = {}) {
  const n = fragments.length, up = upOf(gravity), adj = adjacencyOf(n, joints);
  const sup = new Array(n).fill(false), queue = [];
  for (let i = 0; i < n; i++) if (fragments[i].unyielding) { sup[i] = true; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const a = queue[q];
    for (const b of adj[a]) {
      if (sup[b]) continue;
      if (angleFromUp(fragments[a].centroid, fragments[b].centroid, up) <= support) { sup[b] = true; queue.push(b); }
    }
  }
  return sup;
}

// One erosion tick. Joints touching an unsupported fragment accumulate stress angleRatio*sizeRatio*erosion; both
// endpoints supported => never. The joint is undirected, so the ordering used is the one that points most DOWN (the hanging
// side): angleRatio = angle(up, upper->lower)/180, sizeRatio = volume(lower)/volume(upper).
export function tickErosion(joints, fragments, supported, { erosion = 1, threshold = 100, gravity = DEFAULT_GRAVITY } = {}) {
  const up = upOf(gravity);
  let broke = 0;
  for (const j of joints) {
    if (j.broken) continue;
    if (supported[j.i] && supported[j.j]) continue;
    const fi = fragments[j.i], fj = fragments[j.j];
    const aij = angleFromUp(fi.centroid, fj.centroid, up), aji = angleFromUp(fj.centroid, fi.centroid, up);
    const [upper, lower, ang] = aij >= aji ? [fi, fj, aij] : [fj, fi, aji];
    const sizeRatio = (lower.volume > 0 ? lower.volume : 1) / (upper.volume > 0 ? upper.volume : 1);
    j.stress = (j.stress ?? 0) + (ang / 180) * sizeRatio * erosion;
    if (j.stress > threshold) { j.broken = true; broke++; }
  }
  return broke;
}
