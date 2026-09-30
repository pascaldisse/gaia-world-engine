// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §3 cut: triangle-plane slicing (Sutherland-Hodgman per triangle; a fan/
// ear-clip cap over the resulting cross-section loop), kept pure-JS (plain
// [x,y,z] arrays, no `three` dependency) so the manifold-correctness math is
// unit-testable on its own, separately from GPU geometry construction.

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.sqrt(dot(a, a));
export const normalize = (a) => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function signedDistance(point, planePoint, planeNormal) {
  return dot(sub(point, planePoint), planeNormal);
}

/**
 * A single mesh vertex, world-space, plain data (no three.js types) so the
 * slicer has zero GPU-library dependency.
 * @typedef {{ pos:number[], normal:number[], uv:number[] }} SliceVertex
 */

function interpVertex(vA, vB, dA, dB) {
  const t = dA / (dA - dB);
  return { pos: lerp3(vA.pos, vB.pos, t), normal: normalize(lerp3(vA.normal, vB.normal, t)), uv: lerp2(vA.uv, vB.uv, t) };
}

/**
 * Slice a triangle soup by a world-space plane. Pure function: input
 * `{ verts, tris }` (verts = SliceVertex[] indexed by original vertex id,
 * tris = [i,j,k][]), plane = { point, normal }.
 *
 * Returns null if the plane never straddles any triangle (mesh entirely on
 * one side — §1 "null when plane misses mesh").
 *
 * @returns {{
 *   positive: { body: SliceVertex[3][], cap: SliceVertex[3][] },
 *   negative: { body: SliceVertex[3][], cap: SliceVertex[3][] },
 * } | null}
 */
export function sliceTriangleSoup({ verts, tris }, plane, eps = 1e-9) {
  const { point, normal } = plane;
  const positiveBody = [], negativeBody = [];
  const edgeCache = new Map(); // "minIdx_maxIdx" -> SliceVertex, first line of reuse (same original edge)
  // SECOND line of reuse, required in addition to edgeCache: primitive geometries
  // (three.js BoxGeometry included) duplicate vertices per FACE -- two different
  // faces meeting at the same physical cube edge reference it via two DIFFERENT
  // vertex-index pairs, so edgeCache alone hands back two numerically-equal but
  // object-DIFFERENT intersection points there, and identity-keyed loop chaining
  // (chainLoops) then fails to connect across that face boundary. Canonicalise
  // every intersection point by its rounded world position so every consumer
  // (body triangles, loopEdges, the eventual cap) shares one object per spot.
  const posCanon = new Map();
  const roundedKey = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
  const canon = (v) => {
    const key = roundedKey(v.pos);
    const existing = posCanon.get(key);
    if (existing) return existing;
    posCanon.set(key, v);
    return v;
  };
  const loopEdges = []; // [fromVertex, toVertex] on the piece (positive) side, oriented CCW as viewed from +normal
  let straddled = false;

  const dist = (idx) => signedDistance(verts[idx].pos, point, normal);
  const edgeKey = (i, j) => (i < j ? `${i}_${j}` : `${j}_${i}`);
  const intersectCached = (ia, ib, da, db) => {
    const key = edgeKey(ia, ib);
    let v = edgeCache.get(key);
    if (!v) { v = canon(interpVertex(verts[ia], verts[ib], da, db)); edgeCache.set(key, v); }
    return v;
  };

  for (const [a, b, c] of tris) {
    const da = dist(a), db = dist(b), dc = dist(c);
    const sa = da >= 0 ? 1 : 0, sb = db >= 0 ? 1 : 0, sc = dc >= 0 ? 1 : 0;
    const sum = sa + sb + sc;
    const tri = [a, b, c], d = [da, db, dc], s = [sa, sb, sc];

    if (sum === 3) { positiveBody.push([verts[a], verts[b], verts[c]]); continue; }
    if (sum === 0) { negativeBody.push([verts[a], verts[b], verts[c]]); continue; }

    straddled = true;
    // rotate so the MINORITY vertex (the lone one) is at position 0
    const minorityValue = sum === 1 ? 1 : 0;
    const k = s.indexOf(minorityValue);
    const i0 = tri[k], i1 = tri[(k + 1) % 3], i2 = tri[(k + 2) % 3];
    const d0 = d[k], d1 = d[(k + 1) % 3], d2 = d[(k + 2) % 3];
    const v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
    const Xout = intersectCached(i0, i1, d0, d1); // edge v0->v1
    const Xin = intersectCached(i2, i0, d2, d0);  // edge v2->v0

    if (sum === 1) {
      // v0 is the lone POSITIVE vertex -> corner triangle is the piece side
      positiveBody.push([v0, Xout, Xin]);
      negativeBody.push([Xout, v1, v2]);
      negativeBody.push([Xout, v2, Xin]);
      loopEdges.push([Xout, Xin]); // piece boundary, already correctly oriented
    } else {
      // sum === 2: v0 is the lone NEGATIVE vertex -> corner triangle is the stump side
      negativeBody.push([v0, Xout, Xin]);
      positiveBody.push([Xout, v1, v2]);
      positiveBody.push([Xout, v2, Xin]);
      loopEdges.push([Xin, Xout]); // reversed vs the sum===1 case to keep piece-loop winding consistent
    }
  }

  if (!straddled) return null;

  const loops = chainLoops(loopEdges);
  const positiveCap = [], negativeCap = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    for (let i = 1; i < loop.length - 1; i++) {
      positiveCap.push([loop[0], loop[i], loop[i + 1]]);   // faces +normal
      negativeCap.push([loop[0], loop[i + 1], loop[i]]);   // reversed -> faces -normal
    }
  }
  if (positiveBody.length + positiveCap.length === 0 || negativeBody.length + negativeCap.length === 0) return null;

  return {
    positive: { body: positiveBody, cap: positiveCap },
    negative: { body: negativeBody, cap: negativeCap },
  };
}

/** Chain directed [from,to] edges (object identity) into closed loops. */
export function chainLoops(edges) {
  const next = new Map(); // fromVertex -> toVertex
  for (const [from, to] of edges) next.set(from, to);
  const used = new Set();
  const loops = [];
  for (const [start] of next) {
    if (used.has(start)) continue;
    const loop = [start];
    used.add(start);
    let cur = next.get(start);
    let guard = 0;
    while (cur && cur !== start && guard++ < edges.length + 2) {
      loop.push(cur);
      used.add(cur);
      cur = next.get(cur);
    }
    if (cur === start) loops.push(loop);
  }
  return loops;
}

/**
 * Signed volume of a closed, consistently-wound (outward-normal CCW)
 * non-indexed triangle soup, via the divergence theorem tetrahedron sum:
 * V = (1/6) * sum_over_tris( v0 . (v1 x v2) ).
 * @param {Float32Array|number[]} positions flat xyz, 3 verts per triangle
 */
export function trisoupVolume(positions) {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const v0 = [positions[i], positions[i + 1], positions[i + 2]];
    const v1 = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const v2 = [positions[i + 6], positions[i + 7], positions[i + 8]];
    sum += dot(v0, cross(v1, v2));
  }
  return sum / 6;
}

/**
 * Manifold-edge check (§5 test 8: "every edge shared by 2 tris") on a
 * non-indexed triangle soup: every undirected edge (by exact position, since
 * shared vertices in this pipeline are pushed from the SAME cached float
 * values) must appear in exactly 2 triangles.
 * @returns {{ ok: boolean, bad: string[] }}
 */
export function manifoldEdgeReport(positions) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const counts = new Map();
  for (let i = 0; i < positions.length; i += 9) {
    const p = [0, 1, 2].map((j) => [positions[i + j * 3], positions[i + j * 3 + 1], positions[i + j * 3 + 2]]);
    for (let e = 0; e < 3; e++) {
      const a = p[e], b = p[(e + 1) % 3];
      const k = [key(...a), key(...b)].sort().join('|');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const bad = [...counts.entries()].filter(([, c]) => c !== 2).map(([k]) => k);
  return { ok: bad.length === 0, bad };
}
