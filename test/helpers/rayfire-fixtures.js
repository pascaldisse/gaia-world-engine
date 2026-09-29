// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Test fixtures: plain-vec triangle soups (no THREE). Winding CCW seen from OUTSIDE.
export const V = (x, y, z) => ({ x, y, z });

// Axis-aligned box, each face subdivided k x k quads (2 tris each). Closed, outward-wound.
export function boxTriangles(min = V(0, 0, 0), max = V(1, 1, 1), k = 1) {
  const tris = [];
  const lo = [min.x, min.y, min.z], hi = [max.x, max.y, max.z];
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    for (const s of [1, -1]) {
      const at = s > 0 ? hi[a] : lo[a];
      const pt = (i, j) => {
        const p = [0, 0, 0];
        p[a] = at;
        p[u] = lo[u] + (hi[u] - lo[u]) * (i / k);
        p[v] = lo[v] + (hi[v] - lo[v]) * (j / k);
        return V(p[0], p[1], p[2]);
      };
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
        const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
        if (s < 0) q.reverse();
        tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
      }
    }
  }
  return tris;
}

// Box with the whole bottom (y=min) removed -> open shell with one 4-edge boundary loop.
export function openBottomBox(min, max, k = 1) {
  return boxTriangles(min, max, k).filter(t => !t.every(p => p.y === min.y));
}

// L-shaped prism (concave), extruded along y from 0..h. Footprint (x,z) L polygon CCW seen from +y.
export function lPrism(h = 1) {
  const foot = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]; // CCW in (x,z) plane viewed from +y? checked by volume sign in tests
  const n = foot.length, tris = [];
  const P = (i, y) => V(foot[i][0], y, foot[i][1]);
  // side walls
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([P(i, 0), P(j, 0), P(j, h)], [P(i, 0), P(j, h), P(i, h)]);
  }
  // caps by fan (footprint is star-shaped from (0.5,0.5))
  const c0 = V(0.5, 0, 0.5), c1 = V(0.5, h, 0.5);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([c0, P(j, 0), P(i, 0)], [c1, P(i, h), P(j, h)]);
  }
  return flipAll(tris); // footprint above is CW seen from +y -> flip to outward
}

export function flipAll(tris) { return tris.map(([a, b, c]) => [a, c, b]); }

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}

export const roundDeep = (x, q = 1e9) => JSON.stringify(x, (_, v) => (typeof v === 'number' ? Math.round(v * q) / q : v));
