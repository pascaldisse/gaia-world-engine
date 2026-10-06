// v2 open-world CPU reference (gi-reference.js §v2): sky occlusion, albedo bleed, multi-bounce query,
// occupancy-gradient normals, probe states, adaptive hysteresis. Each key rule has a source-mutant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../client/kernel/gi/gi-reference.js';
import { VoxelWindow, unpackAlbedo, isSolid } from '../client/kernel/gi/voxel-window.js';
import * as C from '../client/kernel/gi/cascade.js';
import { encodeOct } from '../client/kernel/gi/octahedral.js';
import { loadMutant } from './helpers/mutant.js';

const box = (x0, y0, z0, x1, y1, z1) => {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const q = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  const t = []; for (const [a, b, c, d] of q) t.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  return t;
};
const fill = () => { const t = []; for (let y = 0.5; y < 16; y += 1) t.push(0, y, 0, 32, y, 0, 32, y, 32, 0, y, 0, 32, y, 32, 0, y, 32); return t; };
const mkWin = (meshes) => { const w = new VoxelWindow({ bricks: { x: 4, y: 2, z: 4 } }); w.setCenter([16, 8, 16]); for (const [id, m] of Object.entries(meshes)) w.addMesh(id, m); w.update(1000); return w; };
const BLACK = { zenith: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0] };
const RES = 8;
const texel = (dir) => { const [u, v] = encodeOct(dir); const c = (x) => Math.min(RES - 1, Math.max(0, Math.floor(((x + 1) / 2) * RES))); return c(u) + RES * c(v); };
const isSolidAt = (w, p) => isSolid(w.getVoxelAtWorld(p));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------- sky
test('skyRadiance: zenith up, ground down, horizon at y=0', () => {
  const sky = { zenith: [1, 0, 0], horizon: [0, 1, 0], ground: [0, 0, 1] };
  assert.deepEqual(R.skyRadiance([0, 1, 0], sky), [1, 0, 0]);
  assert.deepEqual(R.skyRadiance([0, -1, 0], sky), [0, 0, 1]);
  assert.deepEqual(R.skyRadiance([1, 0, 0], sky), [0, 1, 0]);
});
// ---------------------------------------------------------------- tunnel vs open sky
const probeUp = (win, pos, sky) => {
  const r = R.openUpdateProbe({ probePos: pos, vox: win, maxDist: 40, raysPerProbe: 96, sun: null, sky, irradianceRes: RES, depthRes: 8 });
  return r.irradianceTexels[texel([0, 1, 0])];
};
const SKY = { zenith: [0.3, 0.5, 1], horizon: [0.6, 0.7, 0.9], ground: [0.1, 0.1, 0.1] };
const ground = { triangles: box(0, 0, 0, 32, 1, 32), color: [0.3, 0.3, 0.3] };
test('sky occlusion: tunnel probe (roof+walls) is much darker than an open-sky probe', () => {
  const open = mkWin({ ground });
  const tunnel = mkWin({ ground, roof: { triangles: box(0, 6, 0, 32, 7, 32), color: [0.3, 0.3, 0.3] }, wA: { triangles: box(0, 1, 0, 32, 6, 1), color: [0.3, 0.3, 0.3] }, wB: { triangles: box(0, 1, 11, 32, 6, 12), color: [0.3, 0.3, 0.3] } });
  const a = lum(probeUp(open, [16, 3, 6], SKY)), b = lum(probeUp(tunnel, [16, 3, 6], SKY));
  assert.ok(a > 1.5, `open ${a}`);
  assert.ok(b < a * 0.4, `tunnel ${b} vs open ${a}`);
});
test('mutant: occupancy march never hits -> tunnel == open (test bites)', async () => {
  const M = await loadMutant('client/kernel/gi/gi-reference.js', 'if (isSolid(vox.getVoxelAtWorld(p))) return t;', 'if (false) return t;');
  const tunnel = mkWin({ roof: { triangles: box(0, 6, 0, 32, 7, 32) } });
  const r = M.openUpdateProbe({ probePos: [16, 3, 6], vox: tunnel, maxDist: 40, raysPerProbe: 96, sky: SKY, irradianceRes: RES, depthRes: 8 });
  const open = M.openUpdateProbe({ probePos: [16, 3, 6], vox: mkWin({}), maxDist: 40, raysPerProbe: 96, sky: SKY, irradianceRes: RES, depthRes: 8 });
  assert.ok(Math.abs(lum(r.irradianceTexels[texel([0, 1, 0])]) - lum(open.irradianceTexels[texel([0, 1, 0])])) < 1e-9);
});
// ---------------------------------------------------------------- albedo bleed
const redWall = { triangles: box(8, 0, 0, 9, 10, 20), color: [0.9, 0.05, 0.05] };
test('albedo bleed: sun-lit red wall -> hit radiance red; probe irradiance toward wall is red (sky black)', () => {
  const win = mkWin({ redWall });
  const sun = { direction: [1, -0.3, 0], color: [1, 1, 1], intensity: 3 };
  const ray = R.traceSingleRayOpen({ probePos: [4, 3, 10], dir: [1, 0, 0], vox: win, maxDist: 30, sun, sky: BLACK });
  assert.ok(ray.hit); assert.deepEqual(ray.N.map(Math.round), [-1, 0, 0]);
  assert.ok(ray.radiance[0] > 8 * ray.radiance[1] && ray.radiance[0] > 0.1, JSON.stringify(ray.radiance));
  const r = R.openUpdateProbe({ probePos: [4, 3, 10], vox: win, maxDist: 30, raysPerProbe: 96, sun, sky: BLACK, irradianceRes: RES, depthRes: 8 });
  const e = r.irradianceTexels[texel([1, 0, 0])];
  assert.ok(e[0] > 5 * e[1] && e[0] > 0.05, JSON.stringify(e));
});
test('mutant: flat grey albedo (RTS-style) -> bleed disappears', async () => {
  const M = await loadMutant('client/kernel/gi/gi-reference.js', 'const albedo = unpackAlbedo(vox.getVoxelAtWorld(hitPos));', 'const albedo = [0.5, 0.5, 0.5];');
  const ray = M.traceSingleRayOpen({ probePos: [4, 3, 10], dir: [1, 0, 0], vox: mkWin({ redWall }), maxDist: 30, sun: { direction: [1, -0.3, 0], color: [1, 1, 1], intensity: 3 }, sky: BLACK });
  assert.ok(Math.abs(ray.radiance[0] - ray.radiance[1]) < 1e-12);
});
test('sun shadow: occluder between sun and wall zeroes the direct term', () => {
  const win = mkWin({ redWall, occ: { triangles: box(5.5, 0, 8, 6.5, 10, 12) } });
  const sun = { direction: [1, 0, 0], color: [1, 1, 1], intensity: 3 };
  const ray = R.traceSingleRayOpen({ probePos: [4, 3, 10], dir: [1, 0, 0], vox: win, maxDist: 30, sun, sky: BLACK });
  assert.ok(ray.hitT < 3, 'hits the occluder first');
  const lit = R.traceSingleRayOpen({ probePos: [7.5, 3, 10], dir: [1, 0, 0], vox: win, maxDist: 30, sun, sky: BLACK });
  assert.ok(lit.shadowT !== null, 'sun ray toward -x from wall face is blocked by occluder');
  assert.equal(lit.radiance[0], 0);
});
// ---------------------------------------------------------------- multi-bounce
test('multi-bounce: hit radiance gains albedo/π × E_bounce from the previous-atlas callback', () => {
  const win = mkWin({ w: { triangles: box(8, 0, 0, 9, 10, 20), color: [0.5, 0.5, 0.5] } });
  const base = R.traceSingleRayOpen({ probePos: [4, 3, 10], dir: [1, 0, 0], vox: win, maxDist: 30, sky: BLACK });
  const withB = R.traceSingleRayOpen({ probePos: [4, 3, 10], dir: [1, 0, 0], vox: win, maxDist: 30, sky: BLACK, sampleAtlasIrradiance: () => [Math.PI, Math.PI, Math.PI] });
  assert.equal(base.radiance[0], 0);
  const a = unpackAlbedo(win.getVoxelAtWorld([8.5, 3, 10]))[0];
  assert.ok(Math.abs(withB.radiance[0] - a) < 1e-9, `${withB.radiance[0]} vs ${a}`);
});
// trilinear cascade query
const cs = C.buildCascades({ count: 2, spacings: [2, 6], dims: [{ x: 8, y: 8, z: 8 }, { x: 8, y: 8, z: 8 }] });
const RES_D = 4;
function atlas(valueOf, disabled = () => false) {
  const total = C.totalProbes(cs); const irr = new Array(total * RES * RES), dep = new Array(total * RES_D * RES_D);
  const bases = cs.map((c) => C.cascadeBaseCell(c, [0, 0, 0]));
  for (const c of cs) for (let s = 0; s < c.count; s++) {
    const cell = C.cellOfSlot(c, s, bases[c.index]);
    for (let t = 0; t < RES * RES; t++) irr[(c.baseIndex + s) * RES * RES + t] = valueOf(c.index, cell);
    for (let t = 0; t < RES_D * RES_D; t++) dep[(c.baseIndex + s) * RES_D * RES_D + t] = disabled(c.index, cell) ? [-1, -1] : [100, 100 * 100 + 1];
  }
  return { irr, dep, bases };
}
const q = (A, p) => R.referenceQueryCascades({ worldPos: p, normal: [0, 1, 0], cascades: cs, baseCells: A.bases, irradianceAtlas: A.irr, depthAtlas: A.dep, irradianceRes: RES, depthRes: RES_D });
test('cascade query is TRILINEAR (linear ramp in x reproduced between probes), not nearest', () => {
  const A = atlas((k, cell) => [k === 0 ? cell[0] : 1000, 0, 0]);
  const b = A.bases[0]; // probes at x=(b0+i)*2
  const x0 = (b[0] + 3) * 2;
  const v = q(A, [x0 + 0.5, (b[1] + 3) * 2 + 0.3, (b[2] + 3) * 2 + 0.3])[0];
  assert.ok(v - (b[0] + 3) > 0.15 && v - (b[0] + 3) < 0.4, `${v - (b[0] + 3)}`); // 25% toward next probe (backface weights skew it a little)
  A.__v = v; // 25% of the way to the next probe
});
test('mutant: nearest-probe (uniform corner weights) loses the ramp', async () => {
  const M = await loadMutant('client/kernel/gi/gi-reference.js', 'const trilW = trilinearWeight(f, ox, oy, oz); if (trilW <= 0) continue;\n    const cx = baseCell', 'const trilW = 0.125;\n    const cx = baseCell');
  const A = atlas((k, cell) => [k === 0 ? cell[0] : 1000, 0, 0]); const b = A.bases[0];
  const v = M.referenceQueryCascades({ worldPos: [(b[0] + 3) * 2 + 0.5, (b[1] + 3) * 2 + 0.3, (b[2] + 3) * 2 + 0.3], normal: [0, 1, 0], cascades: cs, baseCells: A.bases, irradianceAtlas: A.irr, depthAtlas: A.dep, irradianceRes: RES, depthRes: RES_D })[0];
  assert.ok(v - (b[0] + 3) > 0.4 || v - (b[0] + 3) < 0.15, `mutant ${v - (b[0] + 3)}`);
});
test('cascade border blend: value moves continuously fine→coarse (no pop)', () => {
  const A = atlas((k) => [k === 0 ? 1 : 5, 0, 0]); const b = A.bases[0];
  const maxX = (b[0] + 7) * 2; // last fine probe
  const y = (b[1] + 3) * 2, z = (b[2] + 3) * 2;
  const vals = [maxX - 4, maxX - 2.5, maxX - 1.5, maxX - 0.75, maxX - 0.2].map((x) => q(A, [x, y, z])[0]);
  assert.ok(vals[0] === 1); for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1] - 1e-12, `${vals}`);
  assert.ok(vals[vals.length - 1] > 1.5 && vals[vals.length - 1] <= 5);
});
test('disabled probe (depth sentinel) is excluded from the query (no dark leak)', () => {
  const b0 = C.cascadeBaseCell(cs[0], [0, 0, 0]);
  const A = atlas((k, cell) => [10, 0, 0], (k, cell) => k === 0 && cell[0] === b0[0] + 3 && cell[1] === b0[1] + 3 && cell[2] === b0[2] + 3);
  A.irr.fill([10, 0, 0]); // all enabled probes read 10
  const v = q(A, [(b0[0] + 3) * 2 + 0.2, (b0[1] + 3) * 2 + 0.2, (b0[2] + 3) * 2 + 0.2]);
  assert.ok(Math.abs(v[0] - 10) < 1e-9);
});
// ---------------------------------------------------------------- normals
test('hit normal from occupancy gradient: thick slab seen from above → +Y; thin wall → -ray dir', () => {
  const win = mkWin({ slab: { triangles: box(0, 0, 0, 32, 3, 32) } });
  const r = R.traceSingleRayOpen({ probePos: [10, 8, 10], dir: [0, -1, 0], vox: win, maxDist: 20, sky: BLACK });
  assert.deepEqual(r.N.map((n) => Math.round(n * 100) / 100 + 0), [0, 1, 0]);
  const g = R.voxelNormal(win, [10, 2.5, 10], [0.6, -0.8, 0]); assert.ok(g[1] > 0.9);
  const win2 = mkWin({ plane: { triangles: [0, 3.5, 0, 30, 3.5, 0, 30, 3.5, 30, 0, 3.5, 0, 30, 3.5, 30, 0, 3.5, 30] } });
  const t = R.traceSingleRayOpen({ probePos: [10, 8, 10], dir: [0, -1, 0], vox: win2, maxDist: 20, sky: BLACK });
  assert.deepEqual(t.N.map((n) => Math.round(n) + 0), [0, 1, 0]);
});
test('mutant: normal always -dir ignores slab orientation on a glancing hit', async () => {
  const M = await loadMutant('client/kernel/gi/gi-reference.js', 'if (g[0] === 0 && g[1] === 0 && g[2] === 0) return scale3(dir, -1);', 'return scale3(dir, -1);');
  const win = mkWin({ slab: { triangles: box(0, 0, 0, 32, 3, 32) } });
  const n = M.voxelNormal(win, [10, 2.5, 10], normalizeV([0.9, -0.3, 0]));
  assert.ok(n[1] < 0.5);
  assert.ok(R.voxelNormal(win, [10, 2.5, 10], normalizeV([0.9, -0.3, 0]))[1] > 0.9);
});
const normalizeV = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
// ---------------------------------------------------------------- probe states
test('probe inside solid: relocated to nearest empty voxel if close, else disabled (zero irradiance, depth sentinel)', () => {
  const thin = mkWin({ slab: { triangles: box(0, 4, 0, 32, 5.2, 32) } });
  const rel = R.resolveProbePosition(thin, [10, 4.5, 10], 2);
  assert.equal(rel.state, 'relocated'); assert.ok(rel.pos[1] < 4 && !isSolidAt(thin, rel.pos));
  const solid = mkWin({ blob: { triangles: fill() } });
  assert.equal(R.resolveProbePosition(solid, [10, 8, 10], 2).state, 'disabled');
  const d = R.openUpdateProbe({ probePos: [10, 8, 10], vox: solid, maxDist: 20, raysPerProbe: 16, sky: SKY, irradianceRes: RES, depthRes: 4, relocateMax: 2 });
  assert.equal(d.state, 'disabled'); assert.deepEqual(d.depthTexels[0], [-1, -1]); assert.deepEqual(d.irradianceTexels[0], [0, 0, 0]);
  assert.equal(R.resolveProbePosition(mkWin({}), [10, 8, 10], 2).state, 'active');
});
test('mutant: no solid check -> embedded probe stays "active" (would bake garbage)', async () => {
  const M = await loadMutant('client/kernel/gi/gi-reference.js', 'if (!isSolid(vox.getVoxelAtWorld(pos))) return { state: \'active\', pos };', 'return { state: \'active\', pos };');
  assert.equal(M.resolveProbePosition(mkWin({ blob: { triangles: fill() } }), [10, 8, 10], 2).state, 'active');
});
test('adaptive hysteresis: big luminance jump → faster (lower) alpha; steady → base alpha', () => {
  const slow = R.adaptiveAlpha([1, 1, 1], [1.01, 1.01, 1.01], 0.97);
  const fast = R.adaptiveAlpha([0.1, 0.1, 0.1], [5, 5, 5], 0.97);
  assert.ok(Math.abs(slow - 0.97) < 0.02, `${slow}`); assert.ok(fast < 0.6 && fast >= 0.5 - 1e-9, `${fast}`);
});
test('mutant: constant alpha -> no adaptation', async () => {
  const M = await loadMutant('client/kernel/gi/gi-reference.js', 'return alpha + (fast - alpha) * t;', 'return alpha;');
  assert.equal(M.adaptiveAlpha([0.1, 0.1, 0.1], [5, 5, 5], 0.97), 0.97);
});
