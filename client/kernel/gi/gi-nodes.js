// TSL/WebGPU graph construction for probe GI (§GI-PROBES.md). Structurally
// mirrors gi-reference.js (the CPU ground truth) op-by-op: occupancy storage
// + fixed-step DDA march, spherical-Fibonacci ray gen + per-frame rotation,
// sun N.L + shadow march + point lights + single-nearest-probe bounce +
// albedo tint on hit / sky color on miss, hysteresis-blended atlas write,
// and a real trilinear + Chebyshev + octahedral-texel probe query.
//
// node --test builds this graph with no GPU device present (three r180,
// real objects) — proves the graph is well-formed and structurally mirrors
// the reference (test/gi-nodes-parity.test.js walks it), NOT that it
// executes correctly on a real frame (see docs UNVERIFIED). Only ever
// called when gi.enabled === true (gi-controller.js gate).

import {
  Fn, storage, instancedArray, uniform, vec2, vec3, vec4, float, int, uint,
  Loop, If, dot, max, normalize, mix, clamp, abs, select,
  floor, length, instanceIndex,
} from 'three/tsl';
import { IrradianceNode, StorageInstancedBufferAttribute } from 'three/webgpu';

// ---- shared constants, mirrored 1:1 from irradiance.js / voxelize.js ----
// exported so test/gi-nodes-parity.test.js can assert numeric parity
// against irradiance.js's own fibonacciSphereDirs formula without a GPU
export const FIB_PHI = Math.PI * (3 - Math.sqrt(5)); // golden angle, irradiance.js fibonacciSphereDirs
export const MAX_MARCH_STEPS = 64; // PLACEHOLDER bound for the fixed-step DDA Loop (needs a compile-time count)

/**
 * Upload a CPU-voxelized occupancy grid (voxelize.js output) as a real GPU
 * storage buffer, packaged with the grid metadata every march/query call
 * needs (dims stay plain JS numbers — static, baked into the kernel at
 * construction; voxelOrigin is wrapped as a uniform so the grid can
 * recenter without a kernel rebuild).
 */
export function createOccupancyStorage(occupancyUint8Array, dims, voxelOrigin, cellSize) {
  const count = dims.x * dims.y * dims.z;
  const arr = new Uint32Array(count);
  for (let i = 0; i < count; i++) arr[i] = occupancyUint8Array[i] ? 1 : 0;
  const attr = new StorageInstancedBufferAttribute(arr, 1);
  const occupancy = storage(attr, 'uint', count);
  return { occupancy, dims, voxelOrigin: uniform(vec3(...voxelOrigin)), cellSize, count };
}

/** Per-probe "was this slot actually written by a real dispatch" flag —
 *  parity-harness diagnostic (parent review 09-29), see createGIUpdateKernel. */
export function createTouchedBuffer(probeCount) {
  return instancedArray(probeCount, 'uint');
}

// ---------------------------------------------------------- storage-buffer budget
// WebGPU compute-stage storage-buffer bind count is limited per-device
// (parent live report 09-29, 8th pass: the observed device gave 8, despite
// the adapter advertising a max of 10 -- three requests DEFAULT limits, not
// maxed). Exceeding it fails BindGroupLayout validation and the WHOLE
// pipeline becomes invalid -- every dispatch is then a silently-dropped
// no-op (no thrown JS error, only visible via the browser's Log domain).
// These pure JS accounting functions mirror EXACTLY which storage buffers
// each kernel constructor references (cross-checked against the real
// source by test/gi-storage-buffer-budget.test.js's structural scan), so
// the budget can be verified with node --test, no device needed.
export const STORAGE_BUFFER_LIMIT = 8; // PLACEHOLDER: the observed device limit; the WebGPU spec minimum is 8, some devices/adapters allow more (this one's adapter advertised 10 but the device only granted 8 -- always budget for the worst case unless the app explicitly requests higher limits)

export function countUpdateKernelStorageBuffers({ touched = null, skyHits = null, lights = null, bounceAtlas = null } = {}) {
  let count = 2; // irradiance atlas + occupancy
  if (touched) count += 1;
  if (skyHits) count += 1;
  if (lights) count += 3; // positions, colors, intensities
  if (bounceAtlas) count += 1;
  count += 1; // the single PACKED debug buffer (always allocated, see computeDebugLayout)
  return count;
}

export function countDepthKernelStorageBuffers({ lights = null } = {}) {
  let count = 2; // depth atlas + occupancy
  if (lights) count += 3;
  return count;
}

export function countDebugKernelStorageBuffers() {
  return 5; // occupancy + debugBuffer(dir+dist) + posDebugBuffer + radianceBuffer + normalBuffer (createRayDebugKernel never references lights: it always passes lights:null to traceAndShadeRayTSL)
}

/**
 * Fixed-stride float layout for the update kernel's PACKED debug buffer
 * (parent review 09-29, 8th pass: 5 separate storage buffers exceeded the
 * device's compute-stage storage-buffer limit and silently invalidated the
 * whole pipeline -- see createGIUpdateKernel's own comment). Exported as
 * the single source of truth: gi-nodes.js writes at these offsets, and
 * tools/gi-parity.mjs reads back at the SAME offsets, both importing this
 * function so the layout can never drift between writer and reader.
 *
 * Layout: [probe map region][ray region][final region]
 *   probe map region: probeCount x 4 floats (probePos.xyz, probeIdx)
 *   ray region:        raysPerProbe x 12 floats (dir.xyz+dist, radiance.xyz+weight, runningSum.xyz+rayIndex)
 *   final region:       4 floats (newEstimate.xyz, writtenFlag)
 */
export function computeDebugLayout({ probeCount, raysPerProbe }) {
  const PROBE_MAP_STRIDE = 4;
  const RAY_STRIDE = 12;
  const FINAL_STRIDE = 4;
  const probeMapBase = 0;
  const rayRegionBase = probeCount * PROBE_MAP_STRIDE;
  const finalBase = rayRegionBase + raysPerProbe * RAY_STRIDE;
  const totalFloats = finalBase + FINAL_STRIDE;
  return { PROBE_MAP_STRIDE, RAY_STRIDE, FINAL_STRIDE, probeMapBase, rayRegionBase, finalBase, totalFloats };
}

/** Per-probe count of rays that reported a MISS (sky) this update —
 *  parity-harness diagnostic (parent review 09-29, 2nd pass): distinguishes
 *  a probe that's legitimately enclosed (0 sky hits, matches CPU) from one
 *  falsely reading "always occupied" due to an occupancy march bug (also 0
 *  sky hits, but for the WRONG reason) — cross-referenced against the
 *  occupancy-buffer readback comparison in tools/gi-parity.mjs. Approximate
 *  (non-atomic increment across up to irradianceRes^2 threads per probe,
 *  each re-tracing the full ray set — see createGIUpdateKernel's own
 *  texel-parallel-recompute note) — good enough to tell "zero" from
 *  "nonzero", not an exact count. */
export function createSkyHitsBuffer(probeCount) {
  return instancedArray(probeCount, 'uint');
}

export function createProbeAtlases({ probeCount, irradianceRes = 8, depthRes = 16 }) {
  const irradianceTexelsPerProbe = irradianceRes * irradianceRes;
  const depthTexelsPerProbe = depthRes * depthRes;
  const irradiance = instancedArray(probeCount * irradianceTexelsPerProbe, 'vec3');
  const depth = instancedArray(probeCount * depthTexelsPerProbe, 'vec2'); // (mean, mean2)
  return { irradiance, depth, irradianceRes, depthRes, probeCount };
}

/** Fixed-size point-light pool (§GI-PROBES.md Fallbacks: sun + pooled point lights feed probes). */
export function createPointLightPool(maxLights = 16) {
  const positions = instancedArray(maxLights, 'vec3');
  const colors = instancedArray(maxLights, 'vec3');
  const intensities = instancedArray(maxLights, 'float');
  const count = uniform(0, 'uint');
  const lightScale = uniform(1);
  return { positions, colors, intensities, count, lightScale, maxLights };
}

// ---- TSL helpers mirroring octahedral.js / gi-reference.js exactly ----

function signNotZeroTSL(v) {
  return select(v.lessThan(0), float(-1), float(1));
}

/** encodeOct: unit dir -> [-1,1]^2 (octahedral.js, signed-octahedron). */
function encodeOctTSL(dir) {
  const l1 = abs(dir.x).add(abs(dir.y)).add(abs(dir.z));
  const inv = float(1).div(max(l1, 1e-8));
  const u0 = dir.x.mul(inv);
  const v0 = dir.y.mul(inv);
  const folded = dir.z.lessThan(0);
  const ou = float(1).sub(abs(v0)).mul(signNotZeroTSL(u0));
  const ov = float(1).sub(abs(u0)).mul(signNotZeroTSL(v0));
  return vec2(select(folded, ou, u0), select(folded, ov, v0));
}

/** octUvToTexelIndex: [-1,1]^2 -> nearest flat texel index (gi-reference.js). */
function octUvToTexelIndexTSL(uv, res) {
  const tu = clamp(int(floor(uv.x.add(1).div(2).mul(res))), int(0), int(res - 1));
  const tv = clamp(int(floor(uv.y.add(1).div(2).mul(res))), int(0), int(res - 1));
  return tu.add(int(res).mul(tv));
}

/**
 * Fixed-step DDA march against the occupancy storage buffer — the exact
 * mirror of voxelize.js's marchOccupancy (step=cellSize*0.5, bounded loop,
 * SAME x-fastest flat layout). Pushes Loop/If onto whichever Fn body is
 * currently building (not wrapped in its own Fn(), so it composes inline
 * in either kernel below, AND inline inside the update kernels' own OUTER
 * `Loop(raysPerProbe,...)` via traceAndShadeRayTSL — see the BUGFIX note).
 *
 * BUGFIX (parent live-GPU report 09-29, 2nd pass): a prior version CLAMPED
 * the world->voxel index into [0,dims) and unconditionally READ that
 * clamped cell every step — so a ray that exits the grid keeps re-sampling
 * the SAME boundary cell for every remaining step, and if that boundary
 * cell happens to be occupied (e.g. the last cell of a wall's own AABB,
 * clamped there at WRITE time too), every ray that leaves the grid on that
 * side falsely reports a permanent hit. voxelize.js's OWN marchOccupancy
 * does the opposite: bounds-check FIRST, and treat out-of-range as "no
 * geometry there" (skip the occupancy read for that step, keep marching)
 * — never clamp-and-read. This mirrors that exactly.
 *
 * BUGFIX (parent live-GPU report 09-29, 6th pass — THE root cause of the
 * atlas-vs-per-ray-debug divergence): this function used `Break()` to
 * early-exit its own step Loop once a hit was found or maxDist was
 * reached. That is safe when called from `createRayDebugKernel` (ONE ray
 * per thread, no outer loop at all) — which is exactly why the per-ray
 * debug trace proved correct radiance/hit/shadowT/N for every ray
 * (parent's pass-#4/#5 live runs) and could never have caught this. But
 * `createGIUpdateKernel`/`createGIDepthUpdateKernel` call this function
 * (via `traceAndShadeRayTSL`, up to 3x per ray: primary march + sun
 * shadow + per-point-light shadow) from WITHIN their OWN OUTER
 * `Loop(raysPerProbe,...)`. A `Break()` inside an INNER Loop that is only
 * reached by calling into a NESTED HELPER FUNCTION from within an OUTER
 * Loop is exactly the kind of construct that breaks the WRONG (outer)
 * loop in graph-based shader builders whose Break() targets "the nearest
 * enclosing Loop node" as seen by the BUILDER at the call site, not
 * necessarily the one a human reader would expect. This matches the
 * reported symptom exactly: probes whose rays never hit anything (pure
 * sky, no Break() ever triggered since the loop just runs its natural
 * course) read correctly (~80.629); probes where ANY ray hits something
 * (Break() fires) show corrupted/truncated atlas values, because the
 * OUTER ray-accumulation loop for that thread silently stopped partway
 * through, well before all `raysPerProbe` rays were summed into
 * `sampleEstimate`. Fixed the same way as the point-light loop above:
 * removed Break() entirely, replaced with an If-guarded body that just
 * skips the remaining work once done — the Loop always runs its full
 * MAX_MARCH_STEPS, but each iteration's body only executes while still
 * actively searching. Real, accepted perf cost (no more early exit on a
 * hit) for eliminating the nested-loop-break risk everywhere this
 * function is used.
 * @returns a float Var: hit distance, or -1 if nothing was hit
 */
function marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist) {
  const { occupancy, dims, voxelOrigin, cellSize } = occ;
  const step = float(cellSize * 0.5);
  const t = float(0).toVar();
  const hitT = float(-1).toVar();
  // BUGFIX (parent live-GPU report 09-29, 9th pass -- THE actual root
  // cause of the atlas-vs-ray-debug divergence, found via the instrumented
  // kernel's own raw readback: march `dist` was CONSTANT across every ray
  // of a probe, established by ray 0 and never changing). This function is
  // a PLAIN JS function (not TSL's own `Fn()`), called once per ray from
  // WITHIN the update kernels' outer `Loop(raysPerProbe,...)` (via
  // `traceAndShadeRayTSL`) -- crossing that plain-function-call boundary,
  // `.toVar()`'s declaration+initial-value apparently does NOT get scoped
  // to "inside the ray loop" the way a directly-inlined `var` would; it
  // gets hoisted to a one-time declaration+init, so after the FIRST ray
  // sets `hitT>=0`, `stillSearching` is false forever and every later ray
  // silently returns the SAME already-set `hitT`/`t`. The ray-debug kernel
  // (createRayDebugKernel) never showed this because it has no outer loop
  // at all -- one ray per GPU thread, so "once-per-shader-invocation"
  // initialization was already correct there by construction. Explicit
  // `.assign()` calls right after `.toVar()` are MUTATION nodes (not
  // declarations) and get placed at the exact control-flow point they're
  // written, regardless of where the underlying variable's declaration
  // itself ended up -- forcing a real reset every time this function's
  // code is reached, which is exactly once per ray.
  t.assign(0);
  hitT.assign(-1);
  // BUGFIX (parent live-GPU report 09-29, 10th pass -- THE actual root
  // cause, read directly from the captured WGSL, pass #9's own new tool):
  // TSL's Loop() names its loop counter 'i' by DEFAULT (LoopNode.getVarName),
  // independently per Loop() call -- so this march-step loop and the
  // update kernel's OUTER ray loop both generate `for (var i: i32 = 0; ...)`.
  // WGSL lexical scoping means the INNER (this) loop's `i` SHADOWS the
  // outer ray loop's `i` inside these braces. TSL evaluates node
  // expressions LAZILY at their point of use -- `fibonacciDirTSL(i,...)`'s
  // `i` reference (the OUTER ray loop's index) gets emitted as the bare
  // identifier "i" wherever `dir` is actually USED, and since `dir` is
  // used INSIDE this march loop's body (`rayOrigin.add(rayDir.mul(t))`),
  // the generated WGSL identifier "i" there resolves to the WRONG (inner,
  // march-step) variable -- dir ends up depending on the MARCH STEP index,
  // not the ray index, so it's identical for every ray of a probe (only
  // depends on how far into ITS OWN march it got), matching the exact
  // reported symptom (march dist constant per probe across every ray).
  // Explicit `name` here (even though this loop doesn't reference its own
  // index) prevents ANY future/other outer loop nesting this function from
  // colliding on 'i' again.
  Loop({ start: 0, end: MAX_MARCH_STEPS, type: 'int', name: 'stepI' }, () => {
    const stillSearching = t.lessThan(maxDist).and(hitT.lessThan(0));
    If(stillSearching, () => {
      const p = rayOrigin.add(rayDir.mul(t));
      const rel = p.sub(voxelOrigin).div(cellSize);
      const ix = int(floor(rel.x));
      const iy = int(floor(rel.y));
      const iz = int(floor(rel.z));
      const inBounds = ix.greaterThanEqual(0).and(ix.lessThan(int(dims.x)))
        .and(iy.greaterThanEqual(0)).and(iy.lessThan(int(dims.y)))
        .and(iz.greaterThanEqual(0)).and(iz.lessThan(int(dims.z)));
      If(inBounds, () => {
        const idx = ix.add(int(dims.x).mul(iy.add(int(dims.y).mul(iz))));
        const occVal = occupancy.element(idx);
        If(occVal.greaterThan(uint(0)), () => {
          hitT.assign(t);
        });
      });
      t.addAssign(step);
    });
  });
  return hitT;
}

/** spherical-Fibonacci ray direction #i of N, rotated (irradiance.js: fibonacciSphereDirs). */
function fibonacciDirTSL(i, rayCount, rotation) {
  const fi = float(i);
  const y = float(1).sub(fi.div(max(float(rayCount - 1), 1)).mul(2));
  const rad = clamp(float(1).sub(y.mul(y)), 0, 1).sqrt();
  const theta = fi.mul(FIB_PHI);
  const x = theta.cos().mul(rad);
  const z = theta.sin().mul(rad);
  const dir = vec3(x, y, z);
  return rotation ? rotation.mul(dir) : dir;
}

/**
 * Trace one ray from `origin` and shade its hit (§GI-PROBES.md
 * Representation + gi-reference.js traceProbeRays, mirrored op-by-op):
 * sun N.L + shadow march (biased one march-step along L, same fix as the
 * CPU reference's self-shadow bug), pooled point lights, single
 * nearest-probe-nearest-texel bounce read (PLACEHOLDER simplification of
 * the CPU reference's full trilinear bounce query — cost, see docs), flat
 * PLACEHOLDER albedo tint (no per-voxel color storage on the GPU side in
 * v0, unlike the CPU reference's optional surfaceAlbedoColor — documented
 * scope cut, see docs UNVERIFIED), miss = sky color.
 * @returns {radiance: vec3 node, dist: float node}
 */
function traceAndShadeRayTSL({ occ, rayOrigin, rayDir, maxDist, sun, lights, albedo, skyColor, bounceAtlas, bounceGrid }) {
  const hitT = marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist);
  const hit = hitT.greaterThanEqual(0);
  const hitPos = rayOrigin.add(rayDir.mul(max(hitT, 0)));
  const N = rayDir.negate();
  const shadowStep = float(occ.cellSize * 0.5);
  // debug-visible: sentinel -2 means "no sun configured / never computed",
  // distinct from a real shadow-march result (-1=miss/unshadowed, >=0=hit).
  // Exposed via createRayDebugKernel's per-ray trace (parent review 09-29,
  // 4th pass: "extend rayDebug with per-ray radiance + shadowT + normal").
  const shadowTOut = float(-2).toVar();
  // BUGFIX (parent live-GPU report 09-29, 9th pass) -- same class of bug
  // as marchOccupancyTSL's t/hitT above: this whole function is a plain JS
  // function called once per ray from inside the update kernels' outer
  // ray Loop, so `.toVar()`'s own initial value alone is not reliably
  // re-applied per ray. Explicit resets force it.
  shadowTOut.assign(-2);

  const direct = vec3(0, 0, 0).toVar();
  direct.assign(vec3(0, 0, 0));
  if (sun) {
    const L = normalize(sun.direction.negate());
    const ndotl = max(0, dot(N, L));
    const shadowOrigin = hitPos.add(L.mul(shadowStep));
    const shadowT = marchOccupancyTSL(occ, shadowOrigin, L, maxDist);
    shadowTOut.assign(shadowT);
    const lit = shadowT.lessThan(0);
    direct.assign(direct.add(select(lit.and(ndotl.greaterThan(0)), sun.color.mul(ndotl).mul(sun.intensity), vec3(0, 0, 0))));
  }
  if (lights) {
    // BUGFIX (parent live-GPU report 09-29, 6th pass): this function is
    // called from WITHIN the update kernel's OUTER `Loop(raysPerProbe,...)`
    // (gi-nodes.js: createGIUpdateKernel/createGIDepthUpdateKernel) -- a
    // Break() inside THIS inner point-light Loop, nested via a function
    // call inside that outer loop, is exactly the kind of construct that
    // is fragile in graph-based shader builders (Break() must target only
    // the nearest enclosing Loop node in the BUILT GRAPH, and this helper
    // is shared with createRayDebugKernel, which calls it with NO outer
    // loop at all -- the debug kernel passes `lights: null` and so never
    // even builds this code path, which is exactly why per-ray debug
    // parity (proven correct) could never have caught a bug here: the
    // update kernel is the ONLY caller that ever exercises this loop, and
    // it's the ONLY one nesting it inside another Loop). Replaced the
    // early-exit Break() with an If-wrapped body (skip the work, don't
    // break the loop) -- still zero real per-thread cost once i>=count
    // (the branch body just never executes), with no loop-nesting risk at
    // all. `lights.maxLights` is currently a fixed PLACEHOLDER pool size
    // (16, see GI_DEFAULTS.maxPointLights) run to completion every ray
    // regardless of `lights.count`, unlike the old early-exit -- a real
    // cost tradeoff for a correctness fix; if this turns out to matter for
    // perf once verified live, revisit with a compacted/sorted light list
    // instead of reintroducing Break().
    // BUGFIX (10th pass, same class as marchOccupancyTSL's rename above):
    // an explicit distinct name avoids colliding with the outer ray loop's
    // (or any other enclosing loop's) index variable.
    Loop({ start: 0, end: lights.maxLights, type: 'int', name: 'lightI' }, ({ lightI }) => {
      If(uint(lightI).lessThan(lights.count), () => {
        const lpos = lights.positions.element(lightI);
        const toLight = lpos.sub(hitPos);
        const dist = length(toLight);
        const Ldir = toLight.div(max(dist, 1e-4));
        const ndotl = max(0, dot(N, Ldir));
        const atten = float(1).div(max(dist.mul(dist), 1e-4));
        const shadowOrigin = hitPos.add(Ldir.mul(shadowStep));
        const shadowT = marchOccupancyTSL(occ, shadowOrigin, Ldir, dist);
        const lit = shadowT.lessThan(0);
        const intensity = lights.intensities.element(lightI).mul(lights.lightScale);
        const contrib = lights.colors.element(lightI).mul(ndotl).mul(atten).mul(intensity);
        direct.assign(direct.add(select(lit, contrib, vec3(0, 0, 0))));
      });
    });
  }

  // single nearest-probe, nearest-texel bounce read (PLACEHOLDER — see docs)
  let bounce = vec3(0, 0, 0);
  if (bounceAtlas && bounceGrid) {
    const rel = hitPos.sub(bounceGrid.origin).div(bounceGrid.spacing);
    const ix = clamp(int(floor(rel.x.add(0.5))), int(0), int(bounceGrid.dims.x - 1));
    const iy = clamp(int(floor(rel.y.add(0.5))), int(0), int(bounceGrid.dims.y - 1));
    const iz = clamp(int(floor(rel.z.add(0.5))), int(0), int(bounceGrid.dims.z - 1));
    const pIdx = ix.add(int(bounceGrid.dims.x).mul(iy.add(int(bounceGrid.dims.y).mul(iz))));
    const uv = encodeOctTSL(N);
    const texel = octUvToTexelIndexTSL(uv, bounceAtlas.irradianceRes);
    bounce = bounceAtlas.irradiance.element(pIdx.mul(bounceAtlas.irradianceRes * bounceAtlas.irradianceRes).add(texel));
  }

  const incident = direct.add(bounce);
  const tint = vec3(albedo, albedo, albedo);
  const radiance = select(hit, tint.mul(incident), skyColor);
  const dist = select(hit, hitT, float(maxDist));
  return { radiance, dist, hit, shadowT: shadowTOut, N };
}

/**
 * Probe-update compute kernel: one GPU thread per (probe, irradiance
 * texel). Each thread regenerates and re-shades its probe's full
 * `raysPerProbe` ray set (PLACEHOLDER — texel-parallel recompute instead of
 * ray-parallel-then-scatter, correctness-first for v0; see docs) and
 * accumulates the cos-weighted Monte-Carlo irradiance estimate
 * (irradiance.js integrateProbeIrradiance, mirrored) before hysteresis
 * blending into the atlas.
 */
export function createGIUpdateKernel({ atlases, occ, probeGrid, raysPerProbe, sun, lights, hysteresis, albedo = 0.5, skyColor = [0.4, 0.5, 0.7], maxDist = 64, rotation = null, bounceAtlas = null, bounceGrid = null, touched = null, skyHits = null }) {
  const { irradiance, irradianceRes, probeCount } = atlases;
  const alpha = uniform(hysteresis?.irradianceAlpha ?? 0.97);
  const probeOffset = uniform(0, 'uint');
  const skyColorU = uniform(vec3(...skyColor));

  // ---- REAL-KERNEL instrumentation (parent review 09-29, 7th->8th pass).
  // BUGFIX (8th pass): the FIVE separate debug storage buffers (7th pass)
  // pushed this kernel's total storage-buffer bind count to 12 -- over the
  // WebGPU compute-stage per-stage limit (8 on the device the live run
  // actually got, despite the adapter advertising 10; three requests
  // default limits, not maxed). BindGroupLayout creation failed validation
  // SILENTLY (no thrown JS error -- only visible via the browser's Log
  // domain, which the parent's driver hadn't been capturing), so the
  // pipeline was invalid and every dispatch was a dropped no-op: the
  // "instrumented" readback was reading UNINITIALIZED/zeroed memory the
  // whole time, not real data (gpuProbePos [0,0,0] was the tell). Fixed by
  // packing ALL debug outputs into ONE flat storage buffer (fixed-stride
  // float layout, computeDebugLayout() below) -- 5 buffers -> 1, kernel
  // total 12 -> 8 (at, not over, the observed limit).
  // `debugProbeUniform` defaults to a sentinel no real probeIdx (a uint
  // wrapped `% probeCount`) can ever equal, so ALL of this instrumentation
  // is a no-op (one extra cheap `If` per texel-0 thread, per-ray writes
  // that never fire) unless the harness explicitly sets it.
  const DEBUG_PROBE_NONE = 0xffffffff;
  const debugProbeUniform = uniform(DEBUG_PROBE_NONE, 'uint');
  const debugLayout = computeDebugLayout({ probeCount, raysPerProbe });
  const debugBuffer = instancedArray(debugLayout.totalFloats, 'float');
  const totalTexelsDefault = atlases.probeCount * irradianceRes * irradianceRes;
  // BUGFIX (parent live-GPU report 09-29, 3rd pass): WORKGROUP ROUNDING.
  // renderer.compute(kernel, count) dispatches ceil(count/workgroupSize)
  // whole workgroups (workgroupSize=64 here) -- for any count that isn't an
  // exact multiple of 64 (e.g. a round-robin batch of 5 probes x 16 texels
  // = 80 threads -> 2 workgroups = 128 threads actually launched), the
  // EXCESS threads (80..127) still decode to VALID (in-range, wrapped)
  // probeIdx values via the existing atlasIndex wrap fix -- so instead of
  // being harmlessly out-of-bounds, they silently RE-SHADE AND OVERWRITE a
  // probe belonging to a DIFFERENT, not-yet-due round-robin batch with
  // stale/premature data, racing that probe's own proper turn. Guarded by
  // an explicit validCount uniform the caller sets to match the EXACT
  // dispatch count it requested (gi-controller.js's update()) -- any
  // thread beyond that does nothing at all, not even a redundant-but-
  // otherwise-correct recompute.
  const validCount = uniform(totalTexelsDefault, 'uint');

  const updateFn = Fn(() => {
    const texelIndex = instanceIndex;
    If(uint(texelIndex).lessThan(validCount), () => {
      const texelsPerProbe = int(irradianceRes * irradianceRes);
      const probeLocal = int(texelIndex).div(texelsPerProbe);
      const localTexel = int(texelIndex).mod(texelsPerProbe);
      // BUGFIX (parent live-GPU report 09-29, test/gi-kernel-index-mirror.test.js):
      // the GLOBAL probe this thread shades is probeOffset+probeLocal, wrapped
      // to the grid size (a round-robin batch can straddle the end of the
      // grid) — both the probe's WORLD POSITION *and* the ATLAS SLOT it
      // writes into must use this wrapped id. Writing via the raw thread-local
      // `texelIndex` instead (the pre-fix bug) only coincidentally matched
      // when probeOffset==0 (every update() call in every scene tested before
      // this fix used updateFraction:1, which keeps offset permanently 0).
      // BUGFIX (10th pass): materialized via .toVar() -- forces a REAL
      // WGSL variable holding a frozen copy of this value, immune to the
      // lazy-inlining-into-a-differently-scoped-loop bug documented below
      // regardless of any naming collision elsewhere.
      const probeIdx = int(probeOffset.add(uint(probeLocal))).mod(int(probeCount)).toVar();
      const atlasIndex = probeIdx.mul(texelsPerProbe).add(localTexel);

      const tu = localTexel.mod(int(irradianceRes));
      const tv = localTexel.div(int(irradianceRes));
      const octu = float(tu).add(0.5).div(irradianceRes).mul(2).sub(1);
      const octv = float(tv).add(0.5).div(irradianceRes).mul(2).sub(1);
      const texelDir = decodeOctTSL(vec2(octu, octv));

      const ix = probeIdx.mod(int(probeGrid.dims.x));
      const iy = probeIdx.div(int(probeGrid.dims.x)).mod(int(probeGrid.dims.y));
      const iz = probeIdx.div(int(probeGrid.dims.x * probeGrid.dims.y));
      const probePos = vec3(
        probeGrid.origin.x.add(float(ix).mul(probeGrid.spacing)),
        probeGrid.origin.y.add(float(iy).mul(probeGrid.spacing)),
        probeGrid.origin.z.add(float(iz).mul(probeGrid.spacing)),
      ).toVar();

      // (C) write the ACTUAL kernel-computed probe->position mapping,
      // once per probe (texel 0 only, cheap, always on), packed into the
      // single debugBuffer's probe-map region
      If(localTexel.equal(0), () => {
        const base = probeIdx.mul(debugLayout.PROBE_MAP_STRIDE).add(debugLayout.probeMapBase);
        debugBuffer.element(base).assign(probePos.x);
        debugBuffer.element(base.add(1)).assign(probePos.y);
        debugBuffer.element(base.add(2)).assign(probePos.z);
        debugBuffer.element(base.add(3)).assign(float(probeIdx));
      });
      const isDebugProbe = uint(probeIdx).equal(debugProbeUniform).and(localTexel.equal(0));

      const sampleEstimate = vec3(0, 0, 0).toVar();
      // BUGFIX (parent live-GPU report 09-29, 10th pass -- THE actual root
      // cause, read directly from the captured WGSL, pass #9's own new
      // tool): TSL's Loop() names its loop counter 'i' by DEFAULT
      // (LoopNode.getVarName), independently per Loop() call -- this ray
      // loop and marchOccupancyTSL's OWN step loop (called from within it,
      // via traceAndShadeRayTSL) both generated `for (var i: i32 = 0; ...)`.
      // WGSL lexical scoping means the INNER (march-step) loop's `i`
      // SHADOWS this OUTER (ray) loop's `i` inside the march's braces. TSL
      // evaluates node expressions LAZILY at their point of use --
      // `fibonacciDirTSL(i,...)`'s `i` reference got emitted as the bare
      // identifier "i" wherever `dir` was actually USED, which is INSIDE
      // the march loop's body (`rayOrigin.add(rayDir.mul(t))`) -- so the
      // generated WGSL there resolved to the WRONG (inner, march-step)
      // variable: dir ended up depending on the MARCH STEP, not the ray,
      // identical for every ray of a probe -- matching the exact reported
      // symptom (march dist constant per probe across every ray). Fixed
      // two ways, both applied: (1) an explicit distinct name here
      // ('rayI') so nothing can collide with it again, and (2) `dir`
      // materialized via `.toVar()` right below so its VALUE is frozen
      // into a real variable at ray-loop scope, immune to being
      // re-evaluated/re-inlined wherever it's later referenced.
      Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }, ({ rayI }) => {
        const dir = fibonacciDirTSL(rayI, raysPerProbe, rotation).toVar();
        const { radiance, hit, dist } = traceAndShadeRayTSL({
          occ, rayOrigin: probePos, rayDir: dir, maxDist,
          sun, lights, albedo, skyColor: skyColorU, bounceAtlas, bounceGrid,
        });
        const w = max(0, dot(texelDir, dir));
        sampleEstimate.assign(sampleEstimate.add(radiance.mul(w)));
        // (A) per-ray instrumentation of the REAL kernel, for one selected
        // probe's texel 0 only (parent review 09-29, 7th/8th pass), packed
        // into the single debugBuffer's ray region. `dist` matches
        // traceSingleRay's own `dist` field exactly (hitT on a hit, maxDist
        // on a miss) -- directly diffable against the CPU trace.
        If(isDebugProbe, () => {
          const rayBase = int(rayI).mul(debugLayout.RAY_STRIDE).add(debugLayout.rayRegionBase);
          debugBuffer.element(rayBase).assign(dir.x);
          debugBuffer.element(rayBase.add(1)).assign(dir.y);
          debugBuffer.element(rayBase.add(2)).assign(dir.z);
          debugBuffer.element(rayBase.add(3)).assign(dist);
          debugBuffer.element(rayBase.add(4)).assign(radiance.x);
          debugBuffer.element(rayBase.add(5)).assign(radiance.y);
          debugBuffer.element(rayBase.add(6)).assign(radiance.z);
          debugBuffer.element(rayBase.add(7)).assign(w);
          debugBuffer.element(rayBase.add(8)).assign(sampleEstimate.x);
          debugBuffer.element(rayBase.add(9)).assign(sampleEstimate.y);
          debugBuffer.element(rayBase.add(10)).assign(sampleEstimate.z);
          debugBuffer.element(rayBase.add(11)).assign(float(rayI));
        });
        // parity-harness diagnostic (parent review 09-29, 2nd pass): count sky
        // (miss) rays per probe, see createSkyHitsBuffer's doc comment
        if (skyHits) {
          If(hit.not(), () => {
            skyHits.element(probeIdx).assign(skyHits.element(probeIdx).add(uint(1)));
          });
        }
      });
      const mcNorm = float((4 * Math.PI) / raysPerProbe);
      const newEstimate = sampleEstimate.mul(mcNorm);
      If(isDebugProbe, () => {
        const base = int(debugLayout.finalBase);
        debugBuffer.element(base).assign(newEstimate.x);
        debugBuffer.element(base.add(1)).assign(newEstimate.y);
        debugBuffer.element(base.add(2)).assign(newEstimate.z);
        debugBuffer.element(base.add(3)).assign(float(1));
      });

      const old = irradiance.element(atlasIndex);
      irradiance.element(atlasIndex).assign(mix(newEstimate, old, alpha));
      // parity-harness diagnostic (§GI-PROBES.md, parent review): mark this
      // probe as actually touched by a real dispatch, so a readback of 0 can
      // be told apart from "never ran" vs "legitimately converged to 0"
      if (touched) touched.element(probeIdx).assign(uint(1));
    });
  });

  const totalTexels = totalTexelsDefault;
  const kernel = updateFn().compute(totalTexels, [64]);
  return {
    kernel, alpha, probeOffset, validCount, totalTexels,
    debugProbeUniform, debugBuffer, debugLayout,
  };
}

/** decodeOct: [-1,1]^2 -> unit dir (octahedral.js, mirrored). */
function decodeOctTSL(uv) {
  const x0 = uv.x;
  const y0 = uv.y;
  const z0 = float(1).sub(abs(uv.x)).sub(abs(uv.y));
  const folded = z0.lessThan(0);
  const ox = float(1).sub(abs(y0)).mul(signNotZeroTSL(x0));
  const oy = float(1).sub(abs(x0)).mul(signNotZeroTSL(y0));
  const x = select(folded, ox, x0);
  const y = select(folded, oy, y0);
  return normalize(vec3(x, y, z0));
}

/**
 * Probe-depth-atlas update kernel — same ray trace+shade as the irradiance
 * kernel (shares traceAndShadeRayTSL), one thread per depth texel,
 * accumulating the weighted-average distance + distance^2 moments
 * (gi-reference.js's depth-texel loop, mirrored).
 */
export function createGIDepthUpdateKernel({ atlases, occ, probeGrid, raysPerProbe, sun, lights, hysteresis, albedo = 0.5, skyColor = [0.4, 0.5, 0.7], maxDist = 64, rotation = null }) {
  const { depth, depthRes, probeCount } = atlases;
  const alpha = uniform(hysteresis?.depthAlpha ?? 0.9);
  const probeOffset = uniform(0, 'uint');
  const skyColorU = uniform(vec3(...skyColor));
  const totalTexelsDefault = atlases.probeCount * depthRes * depthRes;
  // BUGFIX — same workgroup-rounding class of bug as createGIUpdateKernel, see its comment.
  const validCount = uniform(totalTexelsDefault, 'uint');

  const updateFn = Fn(() => {
    const texelIndex = instanceIndex;
    If(uint(texelIndex).lessThan(validCount), () => {
      const texelsPerProbe = int(depthRes * depthRes);
      const probeLocal = int(texelIndex).div(texelsPerProbe);
      const localTexel = int(texelIndex).mod(texelsPerProbe);
      // BUGFIX — same class of bug as createGIUpdateKernel above, see its comment.
      const probeIdx = int(probeOffset.add(uint(probeLocal))).mod(int(probeCount)).toVar();
      const atlasIndex = probeIdx.mul(texelsPerProbe).add(localTexel);

      const tu = localTexel.mod(int(depthRes));
      const tv = localTexel.div(int(depthRes));
      const octu = float(tu).add(0.5).div(depthRes).mul(2).sub(1);
      const octv = float(tv).add(0.5).div(depthRes).mul(2).sub(1);
      const texelDir = decodeOctTSL(vec2(octu, octv));

      const ix = probeIdx.mod(int(probeGrid.dims.x));
      const iy = probeIdx.div(int(probeGrid.dims.x)).mod(int(probeGrid.dims.y));
      const iz = probeIdx.div(int(probeGrid.dims.x * probeGrid.dims.y));
      const probePos = vec3(
        probeGrid.origin.x.add(float(ix).mul(probeGrid.spacing)),
        probeGrid.origin.y.add(float(iy).mul(probeGrid.spacing)),
        probeGrid.origin.z.add(float(iz).mul(probeGrid.spacing)),
      ).toVar();

      const wSum = float(0).toVar();
      const dSum = float(0).toVar();
      const d2Sum = float(0).toVar();
      // BUGFIX (10th pass) — same class of bug + same fix as the irradiance
      // update kernel above: distinct loop name + materialized `dir`.
      Loop({ start: 0, end: raysPerProbe, type: 'int', name: 'rayI' }, ({ rayI }) => {
        const dir = fibonacciDirTSL(rayI, raysPerProbe, rotation).toVar();
        const { dist } = traceAndShadeRayTSL({
          occ, rayOrigin: probePos, rayDir: dir, maxDist,
          sun, lights, albedo, skyColor: skyColorU,
        });
        const w = max(0, dot(texelDir, dir));
        wSum.assign(wSum.add(w));
        dSum.assign(dSum.add(w.mul(dist)));
        d2Sum.assign(d2Sum.add(w.mul(dist).mul(dist)));
      });
      const safeW = max(wSum, 1e-5);
      const newMean = dSum.div(safeW);
      const newMean2 = d2Sum.div(safeW);

      const old = depth.element(atlasIndex);
      depth.element(atlasIndex).assign(mix(vec2(newMean, newMean2), old, alpha));
    });
  });

  const totalTexels = totalTexelsDefault;
  const kernel = updateFn().compute(totalTexels, [64]);
  return { kernel, alpha, probeOffset, validCount, totalTexels };
}

/**
 * Trilinear + Chebyshev + octahedral-texel probe query (§GI-PROBES.md
 * Material sampling, mirrors gi-reference.js's referenceQueryIrradiance
 * exactly): real 8 enclosing corners from worldPos (base cell =
 * floor((p-origin)/spacing), clamped to dims, nested 2x2x2 nested Loop),
 * true trilinear weights, probeDir = normalize(probePos - p), octahedral
 * normal picks the irradiance texel, octahedral probe->point direction
 * picks the depth texel, Chebyshev visibility per corner.
 */
export function createGIQueryNode({ atlases, worldPositionNode, normalNode, probeGrid }) {
  const { irradiance, depth, irradianceRes, depthRes } = atlases;
  const { origin, spacing, dims } = probeGrid;

  return Fn(() => {
    const rel = worldPositionNode.sub(origin).div(spacing);
    const base = vec3(floor(rel.x), floor(rel.y), floor(rel.z));
    const frac = rel.sub(base);

    const total = vec3(0, 0, 0).toVar();
    const weightSum = float(0).toVar();

    // BUGFIX (10th pass, same class as the update/depth kernels' ray loop
    // vs march loop collision): each of these 3 nested loops previously
    // used TSL's DEFAULT loop-variable name 'i' (only the JS-side
    // destructuring alias differed: {i:ox}/{i:oy}/{i:oz}) -- the
    // UNDERLYING generated WGSL variable was 'i' for all three, so the
    // innermost loop's 'i' shadowed the outer two within its own braces,
    // corrupting any lazily-inlined expression referencing `ox`/`oy`
    // wherever it's used inside a more-nested loop's body (exactly like
    // `dir` in the ray/march loops). Explicit distinct names close this.
    Loop({ start: 0, end: 2, type: 'int', name: 'cx' }, ({ cx: ox }) => {
      Loop({ start: 0, end: 2, type: 'int', name: 'cy' }, ({ cy: oy }) => {
        Loop({ start: 0, end: 2, type: 'int', name: 'cz' }, ({ cz: oz }) => {
          const ixf = clamp(base.x.add(float(ox)), 0, dims.x - 1);
          const iyf = clamp(base.y.add(float(oy)), 0, dims.y - 1);
          const izf = clamp(base.z.add(float(oz)), 0, dims.z - 1);
          const cornerWorld = origin.add(vec3(ixf, iyf, izf).mul(spacing));

          const wx = select(float(ox).greaterThan(0.5), frac.x, float(1).sub(frac.x));
          const wy = select(float(oy).greaterThan(0.5), frac.y, float(1).sub(frac.y));
          const wz = select(float(oz).greaterThan(0.5), frac.z, float(1).sub(frac.z));
          const trilW = wx.mul(wy).mul(wz);

          const toProbe = cornerWorld.sub(worldPositionNode);
          const testDist = length(toProbe);
          const nearZero = testDist.lessThan(1e-6);
          const probeDir = select(nearZero, normalNode, normalize(toProbe));
          const backface = select(nearZero, float(1), max(0, dot(normalNode, probeDir)));

          const pIdx = int(ixf).add(int(dims.x).mul(int(iyf).add(int(dims.y).mul(int(izf)))));

          const iuv = encodeOctTSL(normalNode);
          const iTexel = octUvToTexelIndexTSL(iuv, irradianceRes);
          const irr = irradiance.element(pIdx.mul(int(irradianceRes * irradianceRes)).add(iTexel));

          const dDirRaw = select(nearZero, normalNode, normalize(worldPositionNode.sub(cornerWorld)));
          const duv = encodeOctTSL(dDirRaw);
          const dTexel = octUvToTexelIndexTSL(duv, depthRes);
          const meanMean2 = depth.element(pIdx.mul(int(depthRes * depthRes)).add(dTexel));
          const meanD = meanMean2.x;
          const mean2D = meanMean2.y;
          const variance = max(mean2D.sub(meanD.mul(meanD)), 1e-4);
          const d = testDist.sub(meanD);
          const chebyshev = select(testDist.lessThanEqual(meanD), float(1), clamp(variance.div(variance.add(d.mul(d))), 0, 1));

          const w = trilW.mul(backface).mul(chebyshev);
          total.assign(total.add(irr.mul(w)));
          weightSum.assign(weightSum.add(w));
        });
      });
    });

    return total.div(max(weightSum, 1e-6));
  })();
}

/** Wrap gi-nodes.js's query node in three's own IrradianceNode so it flows
 *  into PhysicalLightingModel's indirectDiffuse for free (see docs). */
export function wrapAsIrradianceNode(giQueryNode) {
  return new IrradianceNode(giQueryNode);
}

/**
 * Per-ray debug trace (parent review 09-29, 3rd pass): one thread per ray
 * index [0, raysToCapture), for a SINGLE probe (set via the returned
 * `probeIdxUniform.value` before each dispatch — call this kernel once per
 * probe of interest, reusing the same small buffer). Records the exact
 * ray direction + first-hit distance using the SAME probePos formula,
 * SAME fibonacciDirTSL, and SAME marchOccupancyTSL the real update kernel
 * uses — a ground truth to diff against a CPU mirror
 * (fibonacciSphereDirs + marchOccupancy) for the identical probe index.
 * vec4 (not vec3): sidesteps the vec3 storage-padding quirk entirely by
 * just using all 4 components on purpose (dir.xyz, hitT).
 */
export function createRayDebugKernel({ occ, probeGrid, raysPerProbe, raysToCapture, rotation = null, maxDist = 64, sun = null, albedo = 0.5, skyColor = [0.4, 0.5, 0.7] }) {
  const probeIdxUniform = uniform(0, 'uint');
  const debugBuffer = instancedArray(raysToCapture, 'vec4'); // dir.xyz, hitT
  const posDebugBuffer = instancedArray(1, 'vec4'); // probe world pos.xyz, 0
  // parent review 09-29, 4th pass: "extend rayDebug with per-ray radiance +
  // shadowT + normal" -- reuses traceAndShadeRayTSL directly (not a
  // re-derivation) so the debug trace is GUARANTEED to reflect exactly
  // what the real update kernel computes, not a parallel implementation
  // that could silently drift from it.
  const radianceBuffer = instancedArray(raysToCapture, 'vec4'); // radiance.xyz, shadowT (-2=no sun)
  const normalBuffer = instancedArray(raysToCapture, 'vec4'); // N.xyz, hit(0/1)
  const skyColorU = uniform(vec3(...skyColor));

  const debugFn = Fn(() => {
    const rayIdx = instanceIndex;
    const probeIdx = int(probeIdxUniform);
    const ix = probeIdx.mod(int(probeGrid.dims.x));
    const iy = probeIdx.div(int(probeGrid.dims.x)).mod(int(probeGrid.dims.y));
    const iz = probeIdx.div(int(probeGrid.dims.x * probeGrid.dims.y));
    const probePos = vec3(
      probeGrid.origin.x.add(float(ix).mul(probeGrid.spacing)),
      probeGrid.origin.y.add(float(iy).mul(probeGrid.spacing)),
      probeGrid.origin.z.add(float(iz).mul(probeGrid.spacing)),
    );
    If(rayIdx.equal(0), () => {
      posDebugBuffer.element(0).assign(vec4(probePos, 0));
    });
    const dir = fibonacciDirTSL(rayIdx, raysPerProbe, rotation);
    const { radiance, hit, shadowT, N } = traceAndShadeRayTSL({
      occ, rayOrigin: probePos, rayDir: dir, maxDist,
      sun, lights: null, albedo, skyColor: skyColorU, bounceAtlas: null, bounceGrid: null,
    });
    const hitT = marchOccupancyTSL(occ, probePos, dir, maxDist);
    debugBuffer.element(rayIdx).assign(vec4(dir, hitT));
    radianceBuffer.element(rayIdx).assign(vec4(radiance, shadowT));
    normalBuffer.element(rayIdx).assign(vec4(N, select(hit, float(1), float(0))));
  });

  const kernel = debugFn().compute(raysToCapture, [Math.min(64, raysToCapture)]);
  return { kernel, probeIdxUniform, debugBuffer, posDebugBuffer, radianceBuffer, normalBuffer, raysToCapture };
}
