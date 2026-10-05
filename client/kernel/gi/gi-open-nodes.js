// v2 open-world TSL graph (docs/GI-PROBES.md §v2 open-world). Structural mirror of gi-reference.js §v2
// (skyRadiance / marchVoxelWindow / voxelNormal / traceSingleRayOpen / resolveProbePosition /
// adaptiveAlpha / queryCascade / referenceQueryCascades). NEVER RUN ON A GPU YET — see docs UNVERIFIED.
// Separate file so RTS-mode gi-nodes.js stays byte-identical. Hazard rules honoured (docs passes #6–#10):
//  - every Loop() has an explicit UNIQUE name; no Break(); loop-carried/plain-fn vars .toVar() + explicit .assign() reset
//  - loop-index-derived `dir` is .toVar()-materialised; validCount guard wraps each kernel body
//  - storage buffers: irradiance kernel = irradiance + depth + voxels (+touched) = 3..4; depth kernel = depth + voxels = 2 (≤ 8)
import {
  Fn, storage, uniform, vec2, vec3, vec4, float, int, uint, Loop, If, dot, max, min, normalize, mix, clamp, abs, select, floor, length, instanceIndex,
} from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { FIB_PHI, createProbeAtlases } from './gi-nodes.js';
import { CELL_BIAS, SOLID_BIT } from './voxel-window.js';
import { COVERAGE_WEIGHT_EPS, COVERAGE_WEIGHT_FADE } from './gi-reference.js';

export { createProbeAtlases };
export const OPEN_MARCH_STEPS = 96; // PLACEHOLDER: 96 half-cell steps = 48 m at 1 m cells
export const OPEN_STORAGE_BUFFER_LIMIT = 8;
const RECIP_PI = 1 / Math.PI;

/** pure accounting mirrored by test/gi-open-nodes.test.js's source scan */
export function countOpenIrradianceKernelBuffers({ touched = false } = {}) { return 3 + (touched ? 1 : 0); } // irradiance, depth, voxels
export function countOpenDepthKernelBuffers() { return 2; } // depth, voxels

// ------------------------------------------------------------------ voxel storage (S2 GPU side)
export function createVoxelStorage(win) {
  const attr = new StorageInstancedBufferAttribute(win.data, 1); // SHARES the window's Uint32Array: partial writes = CPU data already in place
  const voxels = storage(attr, 'uint', win.data.length);
  const biasBricks = CELL_BIAS / win.bs;
  const vs = { voxels, attr, bs: win.bs, cellSize: win.cellSize, bricks: win.bricks, vpb: win.voxelsPerBrick, biasBricks, baseBrickB: uniform(vec3(0, 0, 0)) };
  setVoxelBase(vs, win);
  return vs;
}
export function setVoxelBase(vs, win) { vs.baseBrickB.value.set(win.baseBrick[0] + vs.biasBricks, win.baseBrick[1] + vs.biasBricks, win.baseBrick[2] + vs.biasBricks); }
/** one partial GPU write per rebuilt brick (three r180 WebGPUAttributeUtils honours attribute.updateRanges) */
export function flushVoxelUploads(vs, rebuilt) {
  if (!rebuilt.length) return 0;
  vs.attr.clearUpdateRanges();
  for (const r of rebuilt) vs.attr.addUpdateRange(r.start, r.count);
  vs.attr.needsUpdate = true;
  return rebuilt.length;
}

/** packed voxel at absolute integer cell (int nodes). Bounds-checked WITHOUT a branch/var: select(inWin, read(safeIdx), 0). */
export function readVoxelTSL(vs, cx, cy, cz) {
  const bs = int(vs.bs);
  const cb = [cx, cy, cz].map((c) => c.add(int(CELL_BIAS)));
  const bB = cb.map((c) => c.div(bs));
  const l = cb.map((c) => c.mod(bs));
  const base = [vs.baseBrickB.x, vs.baseBrickB.y, vs.baseBrickB.z];
  const dimsB = [vs.bricks.x, vs.bricks.y, vs.bricks.z];
  let inWin = null;
  for (let a = 0; a < 3; a++) {
    const rel = bB[a].sub(int(base[a]));
    const ok = rel.greaterThanEqual(0).and(rel.lessThan(int(dimsB[a])));
    inWin = inWin ? inWin.and(ok) : ok;
  }
  const slot = bB[0].mod(int(dimsB[0])).add(int(dimsB[0]).mul(bB[1].mod(int(dimsB[1])).add(int(dimsB[1]).mul(bB[2].mod(int(dimsB[2]))))));
  const idx = slot.mul(int(vs.vpb)).add(l[0]).add(bs.mul(l[1].add(bs.mul(l[2]))));
  const val = vs.voxels.element(select(inWin, idx, int(0)));
  return select(inWin, val, uint(0));
}
export const isSolidTSL = (packed) => packed.greaterThanEqual(uint(SOLID_BIT));
const cellOf = (vs, p) => { const f = floor(p.div(vs.cellSize)); return [int(f.x), int(f.y), int(f.z)]; };
export const readVoxelAtWorldTSL = (vs, p) => readVoxelTSL(vs, ...cellOf(vs, p));
export function unpackAlbedoTSL(packed) {
  const ch = (sh) => float(packed.shiftRight(uint(sh)).bitAnd(uint(255))).div(255);
  return vec3(ch(16), ch(8), ch(0));
}

// ------------------------------------------------------------------ small mirrors of octahedral / fibonacci
const signNotZero = (v) => select(v.lessThan(0), float(-1), float(1));
function encodeOctTSL(dir) {
  const l1 = abs(dir.x).add(abs(dir.y)).add(abs(dir.z)); const inv = float(1).div(max(l1, 1e-8));
  const u0 = dir.x.mul(inv), v0 = dir.y.mul(inv); const folded = dir.z.lessThan(0);
  return vec2(select(folded, float(1).sub(abs(v0)).mul(signNotZero(u0)), u0), select(folded, float(1).sub(abs(u0)).mul(signNotZero(v0)), v0));
}
export function decodeOctTSL(uv) {
  const z0 = float(1).sub(abs(uv.x)).sub(abs(uv.y)); const folded = z0.lessThan(0);
  const ox = float(1).sub(abs(uv.y)).mul(signNotZero(uv.x)), oy = float(1).sub(abs(uv.x)).mul(signNotZero(uv.y));
  return normalize(vec3(select(folded, ox, uv.x), select(folded, oy, uv.y), z0));
}
function octTexel(uv, res) {
  const t = (c) => clamp(int(floor(c.add(1).div(2).mul(res))), int(0), int(res - 1));
  return t(uv.x).add(int(res).mul(t(uv.y)));
}
export function fibonacciDirTSL(i, rayCount) {
  const fi = float(i); const y = float(1).sub(fi.div(max(float(rayCount - 1), 1)).mul(2));
  const rad = clamp(float(1).sub(y.mul(y)), 0, 1).sqrt(); const th = fi.mul(FIB_PHI);
  return vec3(th.cos().mul(rad), y, th.sin().mul(rad));
}

// ------------------------------------------------------------------ S3: sky / march / normal
export function skyRadianceTSL(dir, sky) {
  const t = clamp(abs(dir.y), 0, 1); const s = t.mul(t).mul(float(3).sub(t.mul(2)));
  return mix(sky.horizon, select(dir.y.greaterThanEqual(0), sky.zenith, sky.ground), s);
}
/** fixed-step march over the voxel window. `enable` (bool node) lets callers no-op it for rays that already missed. @returns float Var hitT (-1 = miss) */
export function marchVoxelsTSL(vs, rayOrigin, rayDir, maxDist, name, enable = null) {
  const step = float(vs.cellSize * 0.5);
  const t = float(0).toVar(); const hitT = float(-1).toVar();
  t.assign(0); hitT.assign(-1); // explicit per-call reset (pass #9: toVar in a plain fn called inside an outer Loop is hoisted)
  Loop({ start: 0, end: OPEN_MARCH_STEPS, type: 'int', name }, () => {
    let go = t.lessThan(maxDist).and(hitT.lessThan(0)); if (enable) go = go.and(enable);
    If(go, () => {
      const p = rayOrigin.add(rayDir.mul(t));
      If(isSolidTSL(readVoxelAtWorldTSL(vs, p)), () => { hitT.assign(t); });
      t.addAssign(step);
    });
  });
  return hitT;
}
/** occupancy-gradient normal (6-neighbour), faces the ray; zero gradient (thin wall) → -dir */
export function voxelNormalTSL(vs, hitPos, dir) {
  const [cx, cy, cz] = cellOf(vs, hitPos);
  const o = (dx, dy, dz) => select(isSolidTSL(readVoxelTSL(vs, cx.add(dx), cy.add(dy), cz.add(dz))), float(1), float(0));
  const g = vec3(o(-1, 0, 0).sub(o(1, 0, 0)), o(0, -1, 0).sub(o(0, 1, 0)), o(0, 0, -1).sub(o(0, 0, 1)));
  const len = length(g); const gN = g.div(max(len, 1e-4));
  const faced = select(dot(gN, dir).greaterThan(0), gN.negate(), gN);
  return select(len.lessThan(1e-4), dir.negate(), faced);
}

// ------------------------------------------------------------------ cascade tables (probe id → cascade fields, JS-unrolled selects)
export function createCascadeUniforms(cascades) { return cascades.map(() => uniform(vec3(0, 0, 0))); } // window base CELL per cascade (float-held ints)
export function setCascadeBases(baseCellU, bases) { bases.forEach((b, k) => baseCellU[k].value.set(b[0], b[1], b[2])); }
function cascadeFields(cascades, baseCellU, probeIdx) {
  let spacing = float(cascades[0].spacing), dx = int(cascades[0].dims.x), dy = int(cascades[0].dims.y), baseIndex = int(cascades[0].baseIndex), baseCell = baseCellU[0];
  for (let k = 1; k < cascades.length; k++) {
    const c = cascades[k]; const is = probeIdx.greaterThanEqual(int(c.baseIndex));
    spacing = select(is, float(c.spacing), spacing); dx = select(is, int(c.dims.x), dx); dy = select(is, int(c.dims.y), dy);
    baseIndex = select(is, int(c.baseIndex), baseIndex); baseCell = select(is, baseCellU[k], baseCell);
  }
  return { spacing, dx, dy, baseIndex, baseCell };
}
/** world position of a global probe (toroidal slot → absolute cell → *spacing) */
export function probeWorldPos(cascades, baseCellU, probeIdx) {
  const f = cascadeFields(cascades, baseCellU, probeIdx);
  let dz = int(cascades[0].dims.z);
  for (let k = 1; k < cascades.length; k++) dz = select(probeIdx.greaterThanEqual(int(cascades[k].baseIndex)), int(cascades[k].dims.z), dz);
  const slot = probeIdx.sub(f.baseIndex);
  const s = [slot.mod(f.dx), slot.div(f.dx).mod(f.dy), slot.div(f.dx.mul(f.dy))];
  const dd = [f.dx, f.dy, dz];
  const base = [int(f.baseCell.x), int(f.baseCell.y), int(f.baseCell.z)];
  const cell = [0, 1, 2].map((a) => base[a].add(s[a].sub(base[a]).mod(dd[a]).add(dd[a]).mod(dd[a]))); // positive mod (WGSL % keeps dividend sign)
  return vec3(float(cell[0]), float(cell[1]), float(cell[2])).mul(f.spacing);
}

// ------------------------------------------------------------------ S4: probe state
/** probe in a solid voxel → first empty axis neighbour within `relocateMax` (priority k, then ±x,±y,±z) else disabled */
export function resolveProbeTSL(vs, probePos, relocateMax, steps = 3) {
  const solidHere = isSolidTSL(readVoxelAtWorldTSL(vs, probePos));
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const cands = [];
  for (let k = 1; k <= steps; k++) { if (k * vs.cellSize > relocateMax) break; for (const d of dirs) cands.push([k, d]); }
  let reloc = probePos, found = float(0);
  for (let i = cands.length - 1; i >= 0; i--) { // reverse: highest priority assigned last wins
    const [k, d] = cands[i]; const q = probePos.add(vec3(d[0], d[1], d[2]).mul(k * vs.cellSize));
    const free = isSolidTSL(readVoxelAtWorldTSL(vs, q)).not();
    reloc = select(free, q, reloc); found = select(free, float(1), found);
  }
  return { pos: select(solidHere, reloc, probePos), disabled: solidHere.and(found.lessThan(0.5)) };
}

// ------------------------------------------------------------------ S3: trilinear cascade query (shared by materials AND the bounce read)
export const luma = (c) => c.x.mul(0.2126).add(c.y.mul(0.7152)).add(c.z.mul(0.0722));
/** one cascade, 8 corners, Chebyshev + backface + disabled-sentinel skip. @returns vec4(value.xyz, weightSum) */
function queryCascadeTSL({ atlases, cascade, baseCell, worldPos, normal, tag }) {
  const { irradiance, depth, irradianceRes, depthRes } = atlases; const sp = cascade.spacing;
  const rel = worldPos.div(sp).sub(baseCell); const base = floor(rel); const frac = rel.sub(base);
  const total = vec3(0, 0, 0).toVar(); const wSum = float(0).toVar();
  total.assign(vec3(0, 0, 0)); wSum.assign(0); // reset: this fn is called from inside the update kernel's ray Loop
  Loop({ start: 0, end: 2, type: 'int', name: `qx${tag}` }, ({ [`qx${tag}`]: ox }) => {
    Loop({ start: 0, end: 2, type: 'int', name: `qy${tag}` }, ({ [`qy${tag}`]: oy }) => {
      Loop({ start: 0, end: 2, type: 'int', name: `qz${tag}` }, ({ [`qz${tag}`]: oz }) => {
        const cellAbs = baseCell.add(base).add(vec3(float(ox), float(oy), float(oz)));
        const wx = select(float(ox).greaterThan(0.5), frac.x, float(1).sub(frac.x));
        const wy = select(float(oy).greaterThan(0.5), frac.y, float(1).sub(frac.y));
        const wz = select(float(oz).greaterThan(0.5), frac.z, float(1).sub(frac.z));
        const trilW = wx.mul(wy).mul(wz);
        const cornerWorld = cellAbs.mul(sp);
        const toProbe = cornerWorld.sub(worldPos); const testDist = length(toProbe);
        const nearZero = testDist.lessThan(1e-6);
        const backface = select(nearZero, float(1), max(0, dot(normal, normalize(toProbe))));
        const dx = int(cascade.dims.x), dy = int(cascade.dims.y), dz = int(cascade.dims.z);
        const ci = [int(cellAbs.x), int(cellAbs.y), int(cellAbs.z)].map((c, a) => c.add(int(CELL_BIAS)).mod([dx, dy, dz][a])); // CELL_BIAS ≡ 0 mod pow2 dims
        const slot = ci[0].add(dx.mul(ci[1].add(dy.mul(ci[2]))));
        const pIdx = slot.add(int(cascade.baseIndex));
        const irr = irradiance.element(pIdx.mul(int(irradianceRes * irradianceRes)).add(octTexel(encodeOctTSL(normal), irradianceRes)));
        const dDir = select(nearZero, normal, normalize(worldPos.sub(cornerWorld)));
        const md = depth.element(pIdx.mul(int(depthRes * depthRes)).add(octTexel(encodeOctTSL(dDir), depthRes)));
        const variance = max(md.y.sub(md.x.mul(md.x)), 1e-4); const d = testDist.sub(md.x);
        const cheb = select(testDist.lessThanEqual(md.x), float(1), clamp(variance.div(variance.add(d.mul(d))), 0, 1));
        const usable = md.x.greaterThanEqual(0); // depth sentinel -1 = disabled probe
        const w = select(usable, trilW.mul(backface).mul(cheb), float(0));
        total.assign(total.add(irr.mul(w))); wSum.assign(wSum.add(w));
      });
    });
  });
  return { value: total.div(max(wSum, 1e-6)), weight: wSum };
}
const smooth01 = (t) => { const c = clamp(t, 0, 1); return c.mul(c).mul(float(3).sub(c.mul(2))); };
function containsAndBorder(cascade, baseCell, p) {
  const rel = p.div(cascade.spacing).sub(baseCell);
  const ext = [cascade.dims.x - 1, cascade.dims.y - 1, cascade.dims.z - 1];
  const r = [rel.x, rel.y, rel.z];
  let inside = null; let m = null;
  for (let a = 0; a < 3; a++) {
    const ok = r[a].greaterThanEqual(0).and(r[a].lessThanEqual(ext[a])); inside = inside ? inside.and(ok) : ok;
    const d = min(r[a], float(ext[a]).sub(r[a])); m = m ? min(m, d) : d;
  }
  return { inside, border: max(float(0), m) };
}
/** coverage gates: usable if weightSum > EPS; ramps in smoothly over [EPS .. FADE] (constants live in gi-reference.js = CPU mirror) */
export { COVERAGE_WEIGHT_EPS, COVERAGE_WEIGHT_FADE };
/** finest-containing cascade + border blend + fall-through, mirrors referenceQueryCascades.
* @returns {{value: vec3 irradiance E, coverage: float c in [0,1]}} coverage = 1 inside the coarsest cascade, smooth fade to 0 over its outer `blendCells`, 0 outside / no usable probe weight */
export function queryCascadesCoverageTSL({ atlases, cascades, baseCellU, worldPos, normal, blendCells = 1.5, tag = 'm' }) {
const n = cascades.length;
const q = cascades.map((c, k) => queryCascadeTSL({ atlases, cascade: c, baseCell: baseCellU[k], worldPos, normal, tag: `${tag}${k}` }));
const cb = cascades.map((c, k) => containsAndBorder(c, baseCellU[k], worldPos));
const usable = (k) => cb[k].inside.and(q[k].weight.greaterThan(COVERAGE_WEIGHT_EPS));
let result = select(usable(n - 1), q[n - 1].value, vec3(0, 0, 0));
for (let k = n - 2; k >= 0; k--) {
const wFine = select(usable(k + 1), smooth01(cb[k].border.div(blendCells)), float(1));
result = select(usable(k), mix(result, q[k].value, wFine), result);
}
const cover = (k) => select(usable(k), smooth01(q[k].weight.div(COVERAGE_WEIGHT_FADE)).mul(k === n - 1 ? smooth01(cb[k].border.div(blendCells)) : float(1)), float(0));
let coverage = cover(n - 1);
for (let k = n - 2; k >= 0; k--) coverage = max(coverage, cover(k));
return { value: result, coverage };
}
/** finest-containing cascade + border blend + fall-through, mirrors referenceQueryCascades. @returns vec3 irradiance E */
export function queryCascadesTSL(args) { return queryCascadesCoverageTSL(args).value; }
/** AMBIENT-REPLACE uniforms: the scene HemisphereLight's irradiance premultiplied by intensity (what three's HemisphereLightNode adds to context.irradiance) */
export function createAmbientUniforms(a = {}) { return { sky: uniform(vec3(...(a.sky ?? [0, 0, 0]))), ground: uniform(vec3(...(a.ground ?? [0, 0, 0]))) }; }
/** hemi irradiance for normal n: mix(ground, sky, 0.5*n.y+0.5) - mirror of three r180 HemisphereLightNode.setup (light direction = +Y) */
export const hemiIrradianceTSL = (n, amb) => mix(amb.ground, amb.sky, n.y.mul(0.5).add(0.5));
/** 'replace' mode term: c*(gi - hemi(n)). Added next to the hemi light's own contribution -> net irradiance = mix(hemi, gi, c) */
export const ambientReplaceTSL = (gi, coverage, n, amb) => coverage.mul(gi.sub(hemiIrradianceTSL(n, amb)));
/** material-side query node (probe GI -> three IrradianceNode). ambient 'add' (default) = raw GI; 'replace' = c*(gi - hemi(n)) so GI substitutes the hemi sky ambient where it has coverage */
export function createOpenQueryNode({ atlases, cascades, baseCellU, worldPositionNode, normalNode, blendCells, ambient = 'add', ambientU = null }) {
if (ambient === 'replace') {
if (!ambientU) throw new Error("createOpenQueryNode: ambient 'replace' needs ambientU (createAmbientUniforms)");
return Fn(() => { const q = queryCascadesCoverageTSL({ atlases, cascades, baseCellU, worldPos: worldPositionNode, normal: normalNode, blendCells, tag: 'mat' }); return ambientReplaceTSL(q.value, q.coverage, normalNode, ambientU); })();
}
return Fn(() => queryCascadesTSL({ atlases, cascades, baseCellU, worldPos: worldPositionNode, normal: normalNode, blendCells, tag: 'mat' }))();
}

// ------------------------------------------------------------------ per-cascade round-robin batch → global probe id (ONE dispatch for all cascades)
// startU/cumU = uniform(vec4): per-cascade cursor start / cumulative batch sizes (float-held ints, ≤4 cascades)
export function createBatchUniforms() { return { startU: uniform(vec4(0, 0, 0, 0)), cumU: uniform(vec4(0, 0, 0, 0)) }; }
export function setBatch(b, starts, counts) {
  let acc = 0; const cum = [0, 0, 0, 0]; const st = [0, 0, 0, 0];
  counts.forEach((c, k) => { acc += c; cum[k] = acc; st[k] = starts[k]; });
  for (let k = counts.length; k < 4; k++) cum[k] = acc;
  b.startU.value.set(st[0], st[1], st[2], st[3]); b.cumU.value.set(cum[0], cum[1], cum[2], cum[3]);
  return acc; // total probes this dispatch
}
export function batchProbeIndex(cascades, b, ordinal) {
  const st = [b.startU.x, b.startU.y, b.startU.z, b.startU.w]; const cum = [b.cumU.x, b.cumU.y, b.cumU.z, b.cumU.w];
  let within = ordinal, start = int(st[0]), count = int(cascades[0].count), baseIndex = int(cascades[0].baseIndex);
  for (let k = 1; k < cascades.length; k++) {
    const is = ordinal.greaterThanEqual(int(cum[k - 1]));
    within = select(is, ordinal.sub(int(cum[k - 1])), within); start = select(is, int(st[k]), start);
    count = select(is, int(cascades[k].count), count); baseIndex = select(is, int(cascades[k].baseIndex), baseIndex);
  }
  return baseIndex.add(start.add(within).mod(count)); // toroidal round-robin: no wrap split
}

// ------------------------------------------------------------------ kernels
export function createSkyUniforms(sky) { return { zenith: uniform(vec3(...sky.zenith)), horizon: uniform(vec3(...sky.horizon)), ground: uniform(vec3(...sky.ground)) }; }

export function createOpenIrradianceKernel({ atlases, vs, cascades, baseCellU, batch, sun, sky, raysPerProbe, maxDist, hysteresis, relocateMax, adaptive, blendCells, touched = null }) {
  const { irradiance, depth, irradianceRes } = atlases;
  const alpha = uniform(hysteresis?.irradianceAlpha ?? 0.97);
  const totalDefault = atlases.probeCount * irradianceRes * irradianceRes; const validCount = uniform(totalDefault, 'uint');
  const fastAlpha = float(adaptive.fast), thr = float(adaptive.threshold);
  const bounceScale = uniform(1); // multi-bounce strength (0 = single-bounce; parity harness uses 0 for a race-free GPU==CPU check)
  const fn = Fn(() => {
    const texelIndex = instanceIndex;
    If(uint(texelIndex).lessThan(validCount), () => {
      const tpp = int(irradianceRes * irradianceRes);
      const probeLocal = int(texelIndex).div(tpp); const localTexel = int(texelIndex).mod(tpp);
      const probeIdx = batchProbeIndex(cascades, batch, probeLocal).toVar();
      const atlasIndex = probeIdx.mul(tpp).add(localTexel);
      const octu = float(localTexel.mod(int(irradianceRes))).add(0.5).div(irradianceRes).mul(2).sub(1);
      const octv = float(localTexel.div(int(irradianceRes))).add(0.5).div(irradianceRes).mul(2).sub(1);
      const texelDir = decodeOctTSL(vec2(octu, octv));
      const probePos0 = probeWorldPos(cascades, baseCellU, probeIdx).toVar();
      const st = resolveProbeTSL(vs, probePos0, relocateMax);
      const probePos = st.pos.toVar(); const disabled = st.disabled.toVar();
      const sampleEstimate = vec3(0, 0, 0).toVar();
      Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }, ({ rayI }) => {
        const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();
        const hitT = marchVoxelsTSL(vs, probePos, dir, maxDist, 'stepI');
        const hit = hitT.greaterThanEqual(0).toVar();
        const hitPos = probePos.add(dir.mul(max(hitT, 0))).toVar();
        const N = voxelNormalTSL(vs, hitPos, dir).toVar();
        const albedo = unpackAlbedoTSL(readVoxelAtWorldTSL(vs, hitPos));
        const outPos = hitPos.add(N.mul(vs.cellSize * 1.01)).toVar();
        const L = normalize(sun.direction.negate()); const ndotl = max(0, dot(N, L));
        const sunT = marchVoxelsTSL(vs, outPos, L, maxDist, 'shadowStepI', hit.and(ndotl.greaterThan(0)));
        const sunE = select(hit.and(ndotl.greaterThan(0)).and(sunT.lessThan(0)), sun.color.mul(ndotl).mul(sun.intensity), vec3(0, 0, 0));
        const bounce = vec3(0, 0, 0).toVar(); bounce.assign(vec3(0, 0, 0));
        If(hit, () => { bounce.assign(queryCascadesTSL({ atlases, cascades, baseCellU, worldPos: outPos, normal: N, blendCells, tag: 'b' }).mul(bounceScale)); });
        const radiance = select(hit, albedo.mul(sunE.add(bounce)).mul(RECIP_PI), skyRadianceTSL(dir, sky));
        sampleEstimate.assign(sampleEstimate.add(radiance.mul(max(0, dot(texelDir, dir)))));
      });
      const newEstimate = sampleEstimate.mul(float((4 * Math.PI) / raysPerProbe));
      const old = irradiance.element(atlasIndex);
      const rel = abs(luma(newEstimate).sub(luma(old))).div(max(luma(newEstimate), luma(old)).add(1e-3));
      const freshProbe = depth.element(probeIdx.mul(int(atlases.depthRes * atlases.depthRes))).x.lessThan(0); // depth sentinel (-1): probe just entered the window / was disabled → no blend with stale data
      const aEff = select(freshProbe, float(0), mix(alpha, fastAlpha, clamp(rel.div(thr), 0, 1))); // adaptive hysteresis (adaptiveAlpha mirror)
      irradiance.element(atlasIndex).assign(select(disabled, vec3(0, 0, 0), mix(newEstimate, old, aEff)));
      if (touched) touched.element(probeIdx).assign(uint(1));
    });
  });
  return { kernel: fn().compute(totalDefault, [64]), alpha, bounceScale, validCount, totalTexels: totalDefault };
}

export function createOpenDepthKernel({ atlases, vs, cascades, baseCellU, batch, raysPerProbe, maxDist, hysteresis, relocateMax }) {
  const { depth, depthRes } = atlases;
  const alpha = uniform(hysteresis?.depthAlpha ?? 0.9);
  const totalDefault = atlases.probeCount * depthRes * depthRes; const validCount = uniform(totalDefault, 'uint');
  const fn = Fn(() => {
    const texelIndex = instanceIndex;
    If(uint(texelIndex).lessThan(validCount), () => {
      const tpp = int(depthRes * depthRes);
      const probeLocal = int(texelIndex).div(tpp); const localTexel = int(texelIndex).mod(tpp);
      const probeIdx = batchProbeIndex(cascades, batch, probeLocal).toVar();
      const atlasIndex = probeIdx.mul(tpp).add(localTexel);
      const octu = float(localTexel.mod(int(depthRes))).add(0.5).div(depthRes).mul(2).sub(1);
      const octv = float(localTexel.div(int(depthRes))).add(0.5).div(depthRes).mul(2).sub(1);
      const texelDir = decodeOctTSL(vec2(octu, octv));
      const probePos0 = probeWorldPos(cascades, baseCellU, probeIdx).toVar();
      const st = resolveProbeTSL(vs, probePos0, relocateMax);
      const probePos = st.pos.toVar(); const disabled = st.disabled.toVar();
      const wSum = float(0).toVar(), dSum = float(0).toVar(), d2Sum = float(0).toVar();
      Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }, ({ rayI }) => {
        const dir = fibonacciDirTSL(rayI, raysPerProbe).toVar();
        const hitT = marchVoxelsTSL(vs, probePos, dir, maxDist, 'stepI');
        const dist = select(hitT.greaterThanEqual(0), hitT, float(maxDist));
        const w = max(0, dot(texelDir, dir));
        wSum.assign(wSum.add(w)); dSum.assign(dSum.add(w.mul(dist))); d2Sum.assign(d2Sum.add(w.mul(dist).mul(dist)));
      });
      const sw = max(wSum, 1e-5); const fresh = vec2(dSum.div(sw), d2Sum.div(sw));
      const old = depth.element(atlasIndex);
      const blended = select(old.x.lessThan(0), fresh, mix(fresh, old, alpha)); // old sentinel (-1) → take new directly
      depth.element(atlasIndex).assign(select(disabled, vec2(-1, -1), blended));
    });
  });
  return { kernel: fn().compute(totalDefault, [64]), alpha, validCount, totalTexels: totalDefault };
}
