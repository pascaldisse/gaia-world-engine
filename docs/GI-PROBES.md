# GI-PROBES — probe-based dynamic diffuse GI (DDGI-class, software RT)

§引 Pascal 09-29: GTA VI-class lighting. DF analysis (https://www.digitalfoundry.net/features/gta-6-an-extended-look-analysis-perhaps-the-most-impressive-showcase-weve-ever-seen-in-real-time-rendering) = HW RT diffuse GI + RT reflections + refined sun shadow maps. Ask = "raytraced GI using light probes to reduce perf cost" = DDGI class. Stack here = three r180 WebGPU+TSL, NO hardware RT accel struct → rays traced in compute (software), against a voxel occupancy grid built from scene meshes.

## Technique — sources
- Majercik, Marrs, Spjut, McGuire, "Scaling Probe-Based Real-Time Dynamic Global Illumination for Production" (NVIDIA RTXGI, arXiv:2009.10796) — probe grid, octahedral irradiance+depth atlas, hysteresis update eq(1), Chebyshev/self-shadow visibility. https://arxiv.org/html/2009.10796v3
- Cigolle et al. 2014 "A Survey of Efficient Representations for Independent Unit Vectors" — signed-octahedron encode/decode used for the irradiance/depth atlas parameterization. Summaries: https://knarkowicz.wordpress.com/2014/04/16/octahedron-normal-vector-encoding/ , https://brashandplucky.com/2022/07/07/octahedron-unitvector-encoding.html
- Donnelly & Lauritzen 2006 "Variance Shadow Maps" — Chebyshev's-inequality one-sided visibility bound, reused by RTXGI for probe self-shadow/occlusion instead of hard depth compare (avoids binary light-leak/dark-leak artifacts).

## Probe layout
- World-space 3D grid, spacing `S` (world units), `origin` = grid-cell-snapped world point (never continuous — see cascade below).
- Top-down RTS camera ⇒ vertical extent is small and known: **camera-relative cascade only in X/Z**, Y is a FIXED small stack of `layersY` probe planes (default 3: ground, mid, roof-line) spanning `heightRange` around the terrain/camera focus height. This avoids RTXGI's full 3D scrolling-volume cost — an RTS camera never looks steeply up/down at probes far above/below play height.
- Recenter rule (`probe-grid.js: recenterGrid`): new origin = `floor(cameraXZ / S) * S − halfExtentXZ`. Origin only moves in whole multiples of `S` ⇒ probes that stay inside the window keep their world position and their atlas data (classic DDGI "infinite scrolling volume" — no full-grid re-light on every camera pan, only the newly-entered rows/columns need a fresh update cycle).
- `dims = probe-grid.js: gridDims(halfExtent, spacing)` — probe counts per axis; `index = probe-grid.js: probeIndex(ix,iy,iz,dims)` — flat storage-buffer index.

## Ray budget / frame
- `raysPerProbe` (default PLACEHOLDER=64, reason: RTXGI ships 144–288/probe on HW RT cores; this engine has none, so budget is compute-shader-bound — 64 keeps `activeProbes × 64` marchable within a frame on a mid GPU per informal three.js WebGPU compute benchmarks, needs a real-GPU frame to confirm, see UNVERIFIED).
- Only a **rotating subset** of probes update per frame (`updateFraction`, PLACEHOLDER=1/8 of active probes/frame ⇒ full volume relights over 8 frames), not the whole volume — standard RTXGI "probe state machine" cost amortization (§2.1/§6 of the paper), simplified here to a flat round-robin instead of Awake/Sleeping/Vigilant classification (no probe motion/relocation in this engine yet).
- Ray directions: fixed spherical-Fibonacci pattern, randomly rotated per probe per update (paper §2.3) — kills banding without needing per-ray RNG divergence in the compute kernel.

## Representation for software ray tracing
- No hardware BVH/RT cores available in three WebGPU/TSL here ⇒ rays are marched against a **conservative voxel occupancy grid** built once per static-geometry rebuild (world edit / build event), not per frame.
- Build (CPU, pure JS, `voxelize.js`): for every scene triangle, mark every voxel whose AABB overlaps the triangle's AABB as occupied. This is a deliberate simplification of the exact triangle/box SAT test (Akenine-Möller) — **conservative superset** (never under-marks, may over-mark a few cells near a triangle's diagonal), traded for far less code/CPU; the only failure mode is a probe ray self-occluding slightly early near a thin diagonal wall, not a light leak. PLACEHOLDER, revisit if visible over-occlusion shows up on a real frame.
- GPU side (`gi-nodes.js`): occupancy grid uploaded as a 3D storage texture; probe-update compute kernel ray-marches (fixed-step DDA) against it per ray, first hit → treated as a diffuse bounce sample (dir-to-hit surface normal is NOT tracked in v0 — hit distance + a flat ambient/sun-tinted radiance estimate stand in for the true one-bounce shade; a second full material sample per hit is future work, out of v0 scope, see UNVERIFIED/fallbacks).

## Irradiance / depth atlas + update
- Per probe: octahedral irradiance atlas (`octahedral.js: encodeOct/decodeOct`, signed encoding, small resolution e.g. 8×8 per RTXGI's own choice) + a depth atlas storing (mean distance, mean distance²) at a larger resolution (e.g. 16×16, sampling the depth is higher-frequency than irradiance — same asymmetry as the paper's Table 2).
- Update = paper eq(1): `E' = α·E + (1-α)·Σ_rays max(0, n̂·ω̂)·L(ω̂)`, Monte-Carlo-normalized here (`irradiance.js: integrateProbeIrradiance`) as `(4π/N)·Σ max(0,n̂·ω̂)·L(ω̂)` for N *uniform-sphere* ray samples (standard MC estimator of the cosine-hemisphere integral, since pdf=1/4π; unit-tested to converge to the Lambertian identity ∫cosθ dω=π for a constant-radiance probe surround).
- `irradiance.js: blendHysteresis(old,new,alpha)` = the same α-blend; α is a flat constant PLACEHOLDER=0.97 here (paper's adaptive per-texel convergence heuristic, §4.3, is not implemented — no fast-moving-light detection yet).
- Depth atlas blended the same way, separate α (paper recommends a lower α i.e. faster convergence for depth than for irradiance — depth changes should snap to new occluders quickly; irradiance should stay smooth). PLACEHOLDER depthAlpha=0.90 < irradianceAlpha=0.97.

## Visibility weight (probe query)
- `chebyshev.js: chebyshevWeight(mean, mean2, testDist)`: `testDist<=mean → 1`; else Chebyshev one-sided bound `variance/(variance+(testDist-mean)²)`, `variance=max(mean2-mean²,ε)`. This is the paper's self-shadow term minus its extra bias tuning knob (single-parameter version, §4.1's "self-shadow bias" reduced here to the epsilon floor only) — PLACEHOLDER, add an explicit bias constant if light/dark leaks show up on a real frame.

## Material sampling (query at a shaded point)
- `gi-nodes.js` builds a TSL node graph sampling **the 8 probes of the enclosing grid cell**: trilinear position weight × backface weight (`max(0, dot(probe→point, -normal))`-style, paper §2.2) × `chebyshevWeight` visibility, normalized, feeding an octahedral irradiance lookup per probe in the *shading normal's* direction, weighted-summed.
- Hooked into the material via three's own `IrradianceNode` (`three/webgpu` → `nodes/lighting/IrradianceNode.js`) — the SAME mechanism three uses for baked light maps: `builder.context.irradiance.addAssign(node)` inside `PhysicalLightingModel.indirectDiffuse()`, so the GI term participates in the existing Lambertian indirect-diffuse term (`irradiance.mul(BRDF_Lambert)`) for free, no shader duplication. `gi-material.js: attachGI(material, giNode)` wraps `material.setupLights` to push `new IrradianceNode(giNode)` alongside the material's existing light-map/AO nodes — additive, only when GI is enabled for that material.

## Fallbacks / default
- `environment` component gains `gi: { enabled=false, spacing, raysPerProbe, updateFraction, layersY, heightRange, irradianceAlpha, depthAlpha }`. **Default `enabled:false`** — zero probe grid, zero storage buffers, zero compute dispatch, zero `IrradianceNode` attached to any material (`test/gi-controller.test.js` proves the off path touches nothing).
- If a scene has no static geometry to voxelize (empty occupancy grid) probes fall back to ambient/hemisphere-only irradiance (rays never hit ⇒ radiance = sky/ambient term, still correct, just flat GI = no bounce contribution).
- Sun + pooled point lights (explosion flashes) both feed the compute pass's ray-hit shading term (their existing `environment.lightScale`-scaled intensities), so probes react to combat lighting, not just the static sun.

## GPU path status (09-29 follow-up, parent review @838d000 addressed)
The kernel/query skeleton from the first pass was flagged as non-functional
(`vec3(0)` ray accumulation, `cornerIdx=i` fake query, no occupancy upload,
no confirmed per-frame dispatch) — all four fixed:
- **Ray-march kernel** (`gi-nodes.js: createGIUpdateKernel` /
  `createGIDepthUpdateKernel`, shared `traceAndShadeRayTSL`): real occupancy
  storage upload (`createOccupancyStorage`), real spherical-Fibonacci ray
  gen + rotation, sun N·L + a SECOND occupancy march toward the sun/point
  light for shadowing, pooled point lights, a single nearest-probe-nearest-
  texel bounce read (infinite-bounce, PLACEHOLDER: the CPU reference's
  richer trilinear bounce query was too costly to repeat per-ray on GPU in
  v0), flat PLACEHOLDER albedo (no per-voxel color storage on the GPU side
  — the CPU reference's optional per-voxel color is proven correct in
  `gi-reference.test.js` scene(ii-b) but not ported to GPU yet), sky color
  on miss, hysteresis-blended atlas write.
- **Self-shadow bias bug**: found via the CPU reference's scene(i) closed-
  box test (every hit was self-shadowing because a fixed-step DDA's
  reported hit position can land up to one step *inside* the voxel it
  detected, not on its surface) — fixed by advancing the shadow ray's
  origin one march-step along the shadow ray's OWN direction (not the
  approximate hit normal) before marching; mirrored identically on the GPU
  side (`gi-nodes-parity.test.js` asserts the source literally biases along
  `L`/`Ldir`, not `N`).
- **Query** (`gi-nodes.js: createGIQueryNode`): real 8 enclosing corners
  (base cell = floor((p-origin)/spacing), nested 2×2×2 loop), true
  trilinear weights, `probeDir = normalize(probePos - p)`, octahedral-
  encoded normal picks the irradiance texel, octahedral-encoded
  probe→point direction picks the depth texel, Chebyshev visibility per
  corner. Structurally mirrors `gi-reference.js: referenceQueryIrradiance`
  op-by-op (proven by `gi-nodes-parity.test.js`, see below).
- **Controller** (`gi-controller.js`): voxelizes the scene on `configure()`
  when enabling, `setSceneTriangles()` is the scene-change signal (mutates
  the EXISTING GPU storage buffer's data in place — the compute graph is
  built once, not rebuilt, since it closed over the buffer object at
  construction), `update(dt, cameraPos)` actually calls
  `renderer.compute(kernel)` for both the irradiance and depth kernels
  every call, advances a round-robin `probeOffset` so the whole grid cycles
  over `1/updateFraction` frames, and recenters the probe grid origin
  toward the camera (X/Z only, per the RTS cascade design above). Still
  never touches any of this when `enabled:false`.

### Parity proof without a GPU
A WebGPU `NodeBuilder` needs a browser `document`/device context this repo
can't construct in `node --test` (confirmed: `new THREE.WebGPURenderer()`
throws `document is not defined` here). A TSL `Fn(() => {...})` body is
also NOT expanded into a walkable node graph until `builder.build()` runs
— confirmed empirically: the callback sits unexecuted at
`shaderCallNode.shaderNode.jsFunc`. So neither "walk the built graph" nor
"real WGSL codegen" is available here. The substitute used
(`gi-nodes-parity.test.js`): `jsFunc.toString()` returns the exact JS
source text of the (still-unexecuted) closure — static proof that specific
ops (`traceAndShadeRayTSL`, the sun/point-light shadow bias, the trilinear
`Loop(2,...)` nesting, `chebyshev`, `octUvToTexelIndexTSL`, the hysteresis
`mix(...)`) are really wired into the code that WILL run, cross-checked
against literal regressions of the exact bugs the parent's review
described (`vec3(0, 0, 0)` accumulation, `cornerIdx = i`,
`trilinearWeight = float(1)`, N-biased shadow rays). Numeric constants
(golden angle `FIB_PHI`) are cross-checked bit-exact against
`irradiance.js`'s own formula.

## GPU parity harness (09-29, parent review stage F)
`tools/gi-parity.mjs` + `tools/gi-parity.html` — for Pascal to run live (this
agent has no browser). Drives a REAL `GIController` against a REAL
`THREE.WebGPURenderer`, runs enough `update()` calls for the round-robin
probe rotation to fully cycle AND each touched probe's hysteresis to
converge (`computeUpdateCount()`), reads the irradiance atlas back via
`renderer.getArrayBufferAsync()`, and compares it texel-for-texel to
`gi-reference.js` run on the identical occupancy/probe-positions/sun
(`compareAtlas()`, float32 + fixed-step-march tolerance documented in the
file). Two scenes: (i) closed double-shell box, sun outside (expect ~0
everywhere); (ii) open plane + wall pillar, sun with a horizontal component
(a purely vertical sun cannot light a vertical face at all — the harness
asserts this as a discriminator on itself). Results print to
`window.__giParity` and `document.body` as JSON.

**Serve** (node_modules here is a symlink OUTSIDE this worktree —
`readlink node_modules` — which breaks Vite's default `server.fs.allow`
sandbox; plain `http.server` has no such sandbox):
```
cd /Users/pascaldisse/projects/GAIA-World-Engine-wt/lampas-gi
python3 -m http.server 8420
```
**Open**: `http://localhost:8420/tools/gi-parity.html` in a WebGPU-capable
browser (Chrome/Edge 113+).

Discovered while building this: `gi-controller.js`'s `sun` param was
hard-coded (straight down, white) until this stage — fixed (now reads
`params.sun`), otherwise scene (ii)'s wall face could never receive direct
light (`ndotl` always 0 for a vertical face under a vertical sun) and the
harness would have nothing meaningful to compare on that scene.

## Live-GPU root-cause pass (09-29, parent's own real run)
Parent ran the harness live (headless Brave, real WebGPU) after fixing a
readback bug of their own (WGSL pads a stored `vec3` to 4 floats/texel --
`unpadVec3()`, their commit). Result: where a probe's atlas slot WAS
written, the value matched the CPU reference within ~0.1% (shading itself
is correct) -- but MOST probes were never written at all (still exactly
0), in a scattered/non-contiguous pattern, plus one probe partially
written (its per-probe sum ≈ 1/16th of the expected value, i.e. ~1 of its
16 texels landed).

Investigation (CPU-mirroring the kernel's thread -> atlas-index math,
`test/gi-kernel-index-mirror.test.js`) found and fixed two REAL,
independently-provable bugs:
1. Both update kernels wrote/read the atlas via the raw thread-local
   `texelIndex` instead of the offset-wrapped GLOBAL `probeIdx` --
   `probeIdx*texelsPerProbe+localTexel`, wrapped `% probeCount`. This is
   only numerically correct when `probeOffset==0`, which both live-tested
   scenes' `updateFraction:1` config keeps permanently true -- so this bug
   provably does NOT explain the observed failure, but it is a real
   corruption for any `updateFraction<1` config, fixed regardless.
2. `renderer.compute(kernel)` always dispatched the kernel's baked-in
   FULL-ATLAS `totalTexels` thread count, regardless of `updateFraction` --
   the round-robin batching design never actually reduced per-dispatch
   GPU work. Fixed: `update()` now passes an explicit
   `probesPerBatch*texelsPerProbe` count to `renderer.compute()` each call.

**Neither bug reproduces the specific observed failure** (both are no-ops
at `probeOffset==0` with a full-grid dispatch). The failure's own shape
-- scattered completion, correct-where-touched, one PARTIALLY-completed
probe -- is the classic signature of a GPU command being cut off mid-
execution (a per-dispatch driver/browser watchdog / TDR), not a logic bug:
some workgroups finished before a cutoff, some never started, one was
mid-flight. `raysPerProbe` (24-128) x nested primary+shadow marches
(`MAX_MARCH_STEPS=64` each) x 448 GPU threads x dozens of `update()` calls
is a large amount of compute-shader work, and a HEADLESS browser commonly
falls back to a software/CPU WebGPU implementation (no real GPU available)
-- orders of magnitude slower than a discrete GPU, making a per-dispatch
timeout far more plausible there than on hardware.

**Mitigation applied** (unverified until the next live run): both harness
scenes cut `raysPerProbe` (96->24, 128->32) and `updateFraction` (1->1/3,
1->1/5) so bug-fix #2 above now actually shrinks each individual
`renderer.compute()` dispatch instead of always submitting the full grid --
reducing any single dispatch's chance of tripping a per-call watchdog (does
NOT reduce total GPU work across the whole run, which stays roughly
constant -- full-grid-coverage x convergence-iterations is invariant to
how it's chunked; only per-dispatch size changes).

**New diagnostic**: `createTouchedBuffer()` (gi-nodes.js) allocates a
per-probe `uint` "was this slot written by a real dispatch" flag, wired
through `GIController.resources.touched` and both kernels
(`createGIUpdateKernel`'s `touched` param). The harness now reads it back
and reports `written: boolean[]` + `writtenCount` per scene -- this is
what will directly confirm or refute the TDR/timeout hypothesis on the
next live run: if `writtenCount < probes` even with the smaller
raysPerProbe/updateFraction, the cutoff is real and needs a harder fix
(fewer probes per scene, or splitting each `update()` into more/smaller
dispatches); if `writtenCount === probes` and results now match, the
mitigation was sufficient.

## Live-GPU root-cause pass #2 (09-29, parent rerun after pass #1)
Pass #1's fixes worked (`writtenCount` 9/9 and 25/25 -- every probe's atlas
slot really was written by a real dispatch, refuting the timeout/TDR
hypothesis), and where a probe WAS nonzero its value was EXACT vs the CPU
reference (shading itself confirmed correct). But a SPATIAL (not random)
subset of probes still read exactly 0 -- clustered near scene(ii)'s wall,
not scattered.

Root cause (`test/gi-occupancy-bounds-mirror.test.js` CPU-mirrors both
strategies and proves the divergence): `marchOccupancyTSL` CLAMPED an
out-of-grid world position into `[0,dims)` and read that clamped cell
UNCONDITIONALLY every march step -- so once a ray's march position left
the grid, every remaining step kept re-sampling the SAME boundary cell. If
that boundary cell happened to be occupied (exactly the case for a wall
whose own AABB gets clamped to the grid edge at WRITE time too --
voxelize.js does this intentionally, see its own docs), every ray that
exited the grid on that side falsely registered a PERMANENT hit at the
first step (t=0), zeroing the whole probe (every one of its rays "hits",
none reach sky). voxelize.js's own `marchOccupancy` (the CPU reference)
does the opposite: bounds-check FIRST, treat out-of-range as "no geometry
there" and skip the read, never clamp-and-read. The bug is silent whenever
the boundary cell happens to be empty (most of a scene) -- explaining why
it only showed up spatially near actual occluding geometry near the grid
edge, not everywhere.

**Fixed**: `marchOccupancyTSL` now bounds-checks per step
(`ix/iy/iz >= 0 and < dims`) and only reads+tests occupancy when in range;
out-of-bounds is unconditionally treated as empty, exactly matching
voxelize.js. The old `worldToVoxelIndexTSL` clamp-and-read helper is gone.

**New diagnostics added** (both requested for the next live run):
- `compareOccupancy()` (tools/gi-parity.mjs): elementwise compares the
  GPU occupancy storage buffer's readback against `voxelizeTriangles()`'s
  CPU output for the identical scene -- reports `mismatches` count +
  `firstMismatchIndex`. Scalar `uint32` storage has no padding quirk (that
  was vec3-specific), so no unpad step is needed here.
- `createSkyHitsBuffer()` (gi-nodes.js): a per-probe counter of rays that
  reported a miss (sky), wired through `GIController.resources.skyHits`
  and read back by the harness as `skyHits: number[]`. Approximate
  (non-atomic across up to irradianceRes^2 threads per probe, each
  re-tracing the same ray set -- see its doc comment) but sufficient to
  tell "legitimately zero misses" from "nonzero" per probe, cross-checked
  against the occupancy comparison above: if a probe reads 0 irradiance
  AND has `skyHits[i]===0` AND `occupancy.mismatches===0`, it's genuinely
  enclosed (correct); if `skyHits[i]===0` but the occupancy comparison
  shows mismatches, the fix above didn't fully land or there's a further
  bug still to find.

## Live-GPU root-cause pass #3 (09-29, parent rerun after pass #2)
Occupancy now proven byte-identical GPU==CPU (0/864, 0/800 mismatches) --
the bounds-check fix (pass #2) landed correctly. Remaining symptom: an
EXACT half-value split (skyHits 4224 vs 2112, "not race noise" per parent)
on probe-grid columns 3-4 of scene(ii)'s 5-wide rows, and scene(i) reading
uniformly 0 for EVERY probe (even ones CPU expects ~77-80 for).

**Hypothesis (a) probe-position-formula mismatch: RULED OUT.**
`test/gi-ray-debug.test.js` CPU-mirrors the kernel's OWN ix/iy/iz
decomposition + position formula against `probeIndex()`/`gridToWorld()`
(used by the CPU reference) for every index of a representative grid --
exact match, always. Not the cause.

**Root cause (found): WORKGROUP ROUNDING corrupts cross-batch data.**
`renderer.compute(kernel, count)` dispatches `ceil(count/64)` WHOLE
workgroups (64 threads each) -- for scene(ii)'s actual round-robin config
(`probesPerBatch=5` * `texelsPerProbe=16` = 80 requested threads), that's
128 threads ACTUALLY launched, 48 in excess. Those 48 excess threads don't
fail harmlessly out-of-bounds: they decode `probeLocal=5,6,7` (beyond this
batch's own 0..4 range) which the earlier atlasIndex wrap-fix turns into
VALID probe ids (5,6,7 -- the start of row iz=1, a DIFFERENT, not-yet-due
round-robin batch) and silently RE-SHADE AND OVERWRITE them with
premature/stale data, racing that row's own proper turn later in the
round-robin cycle. `test/gi-workgroup-guard-mirror.test.js` proves this
numerically (probesPerBatch=5 config -> exactly 48 excess threads -> they
decode to probe ids belonging to row iz=1 while row iz=0 is dispatching).
Scene(i)'s probesPerBatch=3 hits the identical class of bug (16 excess
threads out of a 64-thread single workgroup), touching a rotating
different probe every batch -- consistent with (though not fully
re-derived here) a compounding corruption across all 9 probes over many
convergence iterations, since batches cycle with period 3 and each
over-dispatch clobbers the NEXT batch's first probe prematurely.

**Fixed**: both `createGIUpdateKernel` and `createGIDepthUpdateKernel` now
take an explicit `validCount` uniform and wrap their ENTIRE body in
`If(texelIndex < validCount, ...)` -- any thread beyond the caller's exact
requested dispatch count does nothing at all (no decode, no shade, no
write). `GIController.update()` sets `validCount` to the exact
`probesPerBatch*texelsPerProbe` it requests from `renderer.compute()`,
every call, for both kernels.

**New diagnostic**: `createRayDebugKernel()` (gi-nodes.js) + its harness
wiring (`debugProbeRaysCPU`, `compareRayDebug`, `decomposeProbeIndex` in
tools/gi-parity.mjs) -- for explicit probe indices (scene(i): 0,4,8;
scene(ii): 0,3,14, the parent's own choice), dispatches ONE real GPU
compute pass per probe recording each of the first 16 rays' exact
direction + first-hit distance (vec4 per ray, dir.xyz+hitT, no padding
quirk) plus the probe's own GPU-computed world position, diffed against a
pure CPU mirror (`fibonacciSphereDirs`+`marchOccupancy`, the same
functions gi-reference.js itself uses). Wired into `runScene()`'s
`cmp.rayDebug` array automatically whenever `debugProbeIndices` is passed.

Ground-truth CPU dump generated locally for the exact requested probes
(computed via `debugProbeRaysCPU`, no GPU needed) -- see chat reply for the
full per-ray table; summary: scene(i) probe 0 = 16/16 immediate hits
(t=0, self-enclosed, matches CPU's own reported 0); probes 4,8 = 0/16 hits
(pure sky, matches CPU's own reported ~77-80). scene(ii) probes 0, 3, 14 =
all 0/16 hits in their first 16 rays (pure sky expected for all three --
none of them are geometrically near the wall), consistent with the
parent's own "CPU all 80.629" report and giving NO indication of a
directional/positional asymmetry on the CPU side -- reinforcing that the
divergence was GPU-execution-side (workgroup rounding), not a formula bug.

## UNVERIFIED (need a real GPU frame)
- Actual fps cost of `raysPerProbe × activeProbes` compute dispatch — no WebGPU device in node tests, only node-graph *construction* is verified here.
- Whether the kernel/query TSL graphs, once actually built+run on a real
  device, numerically agree with `gi-reference.js`'s CPU output for the
  same scene — structural parity (above) is proven, numeric equality is not
  (and cannot be, without a GPU).
- Voxelization over-occlusion visibility on real geometry (thin diagonal walls); the same fixed-step DDA coarseness that caused the self-shadow bug may still slightly over/under-shoot thin (1-voxel) walls at grazing angles even after the bias fix.
- Per-voxel albedo color is proven correct on the CPU reference (scene ii-b) but NOT ported to the GPU kernel (flat PLACEHOLDER albedo only) — a real per-voxel color texture is future work.
- The GPU bounce term reads a single nearest-probe-nearest-texel value (cost cut vs. the CPU reference's full trilinear bounce query) — correctness on a real multi-bounce scene is unverified.
- `attachGI()` (gi-material.js) is not yet called by the controller against any real material's `positionWorld`/`normalWorld` nodes — the query graph exists and is tested standalone, but per-material wiring (which material(s) get GI, and feeding their real world-position/normal nodes into `createGIQueryNode`) is the next integration step, not done here.
- `raysPerProbe`, `updateFraction`, both hysteresis alphas, Chebyshev epsilon, voxel cell size, max march steps — all PLACEHOLDER, tuned on a real frame later.
