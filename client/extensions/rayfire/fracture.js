// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §3 fracture: mesh -> Voronoi cells. Per-cell sequential half-space clipping of the closed source proxy
// against every pairwise perpendicular-bisector plane (a Voronoi cell IS that intersection of half-spaces;
// Aurenhammer 1991 https://doi.org/10.1145/116873.116880, Rycroft/Voro++ 2009 https://doi.org/10.1063/1.3215722),
// polygon-vs-plane clipping = Sutherland–Hodgman 1974 https://doi.org/10.1145/360767.360802, with cut-face capping.
// Exactness: intersection points are computed canonically from the (coordinate-ordered) edge endpoints, so the
// two faces sharing an edge get bit-identical cut points and the cut edges chain into loops exactly.
import { boundsOfFaces, diagonalOf, facesVolume, isWatertight, v3 } from './geometry.js';
import { createRng, mixSeed } from './prng.js';
import { chainLoops, capPolygons, closeBoundaries, closeOpenShell } from './closure.js';
import { hullFaces } from './hull.js';

const SALT_SEEDS = 0x5eed0001, SALT_COUNT = 0x5eed0002;
export const VOLUME_EPS_REL = 1e-9; // × diag³: below this a cell is a flat sliver / float-noise volume (§3.6)

function normalizeOpts(o = {}) {
  return {
    amount: Math.max(1, Math.floor(o.amount ?? o.am ?? 15) || 1),
    seed: (o.seed ?? o.sd ?? 1) >>> 0,
    variation: Math.max(0, Number(o.variation ?? o.var ?? 0) || 0),
    bias: Math.min(1, Math.max(0, Number(o.bias ?? 0) || 0)),
    biasPoint: o.biasPoint ?? null,
    interiorMaterial: o.interiorMaterial ?? 1,
    exteriorMaterial: o.exteriorMaterial ?? 0,
  };
}

// §3.2 seed placement (+ contact bias, amount variation).
export function placeSeeds(aabb, { amount, seed, variation, bias, biasPoint }) {
  let n = amount;
  if (variation > 0) {
    const r = createRng(mixSeed(seed, SALT_COUNT))();
    n = Math.max(1, Math.round(amount * (1 + (variation / 100) * (2 * r - 1))));
  }
  const rng = createRng(mixSeed(seed, SALT_SEEDS));
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const p = v3(
      aabb.min.x + rng() * (aabb.max.x - aabb.min.x),
      aabb.min.y + rng() * (aabb.max.y - aabb.min.y),
      aabb.min.z + rng() * (aabb.max.z - aabb.min.z));
    if (bias > 0 && biasPoint) { // linear pull toward the contact point (U3)
      p.x += (biasPoint.x - p.x) * bias; p.y += (biasPoint.y - p.y) * bias; p.z += (biasPoint.z - p.z) * bias;
    }
    seeds.push(p);
  }
  return seeds;
}

const lexLess = (a, b) => a.x < b.x || (a.x === b.x && (a.y < b.y || (a.y === b.y && a.z < b.z)));

// Canonical plane/edge intersection: same bits regardless of which face (edge direction) asks.
function cutPoint(a, b, da, db) {
  let P = a, Q = b, dP = da, dQ = db;
  if (lexLess(b, a)) { P = b; Q = a; dP = db; dQ = da; }
  if (dP === 0) return { x: P.x, y: P.y, z: P.z };
  if (dQ === 0) return { x: Q.x, y: Q.y, z: Q.z };
  const t = dP / (dP - dQ);
  return { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t, z: P.z + (Q.z - P.z) * t };
}
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const pkey = p => `${p.x},${p.y},${p.z}`;

// Clip one face set to the half-space n·p - d <= 0 and cap the cut. Returns { faces, uncapped }.
function clipHalfSpace(faces, n, d, interiorMaterial) {
  const out = [], cut = [];
  for (const f of faces) {
    const v = f.verts, m = v.length;
    const ds = new Array(m); let neg = 0, pos = 0;
    for (let i = 0; i < m; i++) { const dd = n.x * v[i].x + n.y * v[i].y + n.z * v[i].z - d; ds[i] = dd; if (dd > 0) pos++; else neg++; }
    if (pos === 0) { out.push(f); continue; }
    if (neg === 0) continue;
    const poly = [], kind = []; // kind: 0 plain vertex, 1 exit crossing, 2 entry crossing
    for (let i = 0; i < m; i++) {
      const a = v[i], b = v[(i + 1) % m], ia = ds[i] <= 0, ib = ds[(i + 1) % m] <= 0;
      if (ia) { poly.push(a); kind.push(0); }
      if (ia !== ib) { poly.push(cutPoint(a, b, ds[i], ds[(i + 1) % m])); kind.push(ia ? 1 : 2); }
    }
    // dedupe consecutive identical points (carrying the crossing kind of the survivor)
    const clean = [], ck = [];
    for (let i = 0; i < poly.length; i++) {
      const last = clean.length - 1;
      if (last >= 0 && same(clean[last], poly[i])) { if (kind[i]) ck[last] = kind[i]; continue; }
      clean.push(poly[i]); ck.push(kind[i]);
    }
    while (clean.length > 1 && same(clean[0], clean[clean.length - 1])) { if (ck[clean.length - 1] && !ck[0]) ck[0] = ck[clean.length - 1]; clean.pop(); ck.pop(); }
    if (clean.length < 3) continue;
    // plane edges of the clipped polygon: exit crossing followed (cyclically) by entry crossing
    for (let i = 0; i < clean.length; i++) { const j = (i + 1) % clean.length; if (ck[i] === 1 && ck[j] === 2) cut.push({ a: clean[i], b: clean[j] }); }
    out.push({ verts: clean, interior: f.interior, materialId: f.materialId });
  }
  // cut edges X1->X2 need the cap to supply X2->X1; opposite pairs already satisfy each other
  const cnt = new Map();
  for (const e of cut) { const k = pkey(e.a) + '>' + pkey(e.b); cnt.set(k, (cnt.get(k) ?? 0) + 1); }
  const need = [];
  for (const e of cut) {
    const k = pkey(e.a) + '>' + pkey(e.b), r = pkey(e.b) + '>' + pkey(e.a);
    if ((cnt.get(r) ?? 0) > 0 && cnt.get(k) > 0) { cnt.set(r, cnt.get(r) - 1); cnt.set(k, cnt.get(k) - 1); continue; }
    if (cnt.get(k) > 0) { cnt.set(k, cnt.get(k) - 1); need.push({ a: e.b, b: e.a }); }
  }
  let uncapped = false;
  if (need.length) {
    const { loops, dangling } = chainLoops(need, 0);
    if (dangling) uncapped = true;
    for (const loop of loops) for (const poly of capPolygons(loop)) out.push({ verts: poly, interior: true, materialId: interiorMaterial });
  }
  return { faces: out, uncapped };
}

function maxRadius(faces, s) {
  let r2 = 0;
  for (const f of faces) for (const p of f.verts) { const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z, q = dx * dx + dy * dy + dz * dz; if (q > r2) r2 = q; }
  return Math.sqrt(r2);
}

function buildCell(proxyFaces, seeds, i, o, minDist) {
  const si = seeds[i];
  const others = [];
  for (let j = 0; j < seeds.length; j++) if (j !== i) { const s = seeds[j]; others.push({ j, d: Math.hypot(s.x - si.x, s.y - si.y, s.z - si.z) }); }
  others.sort((a, b) => a.d - b.d || a.j - b.j);
  let faces = proxyFaces, uncapped = false, R = maxRadius(faces, si);
  for (const { j, d } of others) {
    if (d * 0.5 > R) break; // this and every farther bisector misses the current cell (radius bound)
    if (d <= minDist) continue; // coincident seeds: no plane
    const sj = seeds[j];
    const n = { x: (sj.x - si.x) / d, y: (sj.y - si.y) / d, z: (sj.z - si.z) / d };
    const off = n.x * (si.x + sj.x) * 0.5 + n.y * (si.y + sj.y) * 0.5 + n.z * (si.z + sj.z) * 0.5;
    const r = clipHalfSpace(faces, n, off, o.interiorMaterial);
    faces = r.faces; if (r.uncapped) uncapped = true;
    if (!faces.length) return null;
    R = maxRadius(faces, si);
  }
  return { faces, uncapped };
}

function flipFaces(faces) { return faces.map(f => ({ ...f, verts: f.verts.slice().reverse() })); }

// §3.6 cell finishing: closure guarantee ladder + degenerate drop.
function finishCell(cell, o, volEps) {
  let { faces, uncapped } = cell, hull = false;
  if (!isWatertight(faces)) {
    const c = closeBoundaries(faces, { interiorMaterial: o.interiorMaterial, quantum: 0 });
    if (c.uncapped) uncapped = true;
    faces = c.faces;
  }
  if (!isWatertight(faces)) {
    const q = closeBoundaries(faces, { interiorMaterial: o.interiorMaterial, quantum: 1e-9 * Math.max(diagonalOf(boundsOfFaces(faces)), 1e-12) });
    faces = q.faces;
  }
  if (!isWatertight(faces)) {
    const ab = boundsOfFaces(cell.faces), dg = diagonalOf(ab);
    const dims = [ab.max.x - ab.min.x, ab.max.y - ab.min.y, ab.max.z - ab.min.z].sort((p, q) => p - q);
    if (!(dims[0] > dg * 1e-9)) return null; // flat sheet: no volume to keep, and a hull of it would invent one
    const pts = [];
    for (const f of cell.faces) for (const p of f.verts) pts.push({ x: p.x, y: p.y, z: p.z, exterior: !f.interior });
    faces = hullFaces(pts, o).faces; hull = true;
  }
  let vol = facesVolume(faces);
  if (vol < 0) { faces = flipFaces(faces); vol = facesVolume(faces); }
  if (!(vol > volEps)) return null;
  return { faces, uncappedLoops: uncapped, hullFallback: hull, volume: vol };
}

// Public: triangle soup -> cell[] (≤ requested seeds, each watertight with strictly positive volume).
export function fractureCells(triangles, opts) {
  const o = normalizeOpts(opts);
  const proxy = closeOpenShell(triangles, o);
  if (!proxy.faces.length) return [];
  const aabb = proxy.aabb, diag = diagonalOf(aabb);
  const volEps = VOLUME_EPS_REL * diag * diag * diag;
  const seeds = placeSeeds(aabb, o);
  const cells = [];
  for (let i = 0; i < seeds.length; i++) {
    const raw = seeds.length === 1 ? { faces: proxy.faces, uncapped: proxy.uncappedLoops } : buildCell(proxy.faces, seeds, i, o, diag * 1e-12);
    if (!raw) continue;
    const fin = finishCell(raw, o, volEps);
    if (!fin) continue;
    cells.push({ index: cells.length, seedPoint: seeds[i], faces: fin.faces, uncappedLoops: fin.uncappedLoops || (seeds.length === 1 ? proxy.uncappedLoops : false), hullFallback: fin.hullFallback });
  }
  return cells;
}
export const _internals = { buildCell, finishCell, clipHalfSpace };
