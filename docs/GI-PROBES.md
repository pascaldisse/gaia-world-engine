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

## Live-GPU root-cause pass #4 (09-29, parent rerun after CPU-oracle fix + pass #3)
Parent found+fixed their OWN harness bug (commit fc1fffa): `extractCpuReferenceInputs`
passed the tiny PROBE-grid dims (e.g. scene(i) 3x1x3) as the VOXEL occupancy
grid's dims into `referenceUpdateProbe`/`marchOccupancy` -- silently making
the CPU oracle see almost no geometry (everything past a 3x1x3 cube read as
"outside the grid" per the bounds-check fix from pass #2), so its own
"expected 77-80 inside the closed box" numbers were themselves wrong. Fixed
by threading `voxelDims` separately from the probe-grid `dims`.

After that fix + this file's pass-#3 workgroup-guard fix: **rayDebug shows
6/6 probes, 16/16 rays GPU==CPU for direction, hitT, hit/miss classification,
AND world position** -- hit/miss parity is proven. Remaining: RADIANCE at
hit points (CPU returns sun-lit albedo+bounce, GPU reads ~0), plus a small
0.1% residual on miss-only (pure sky) probes (80.552 vs 80.629).

**Extended the debug tooling exactly as requested**: `traceAndShadeRayTSL`
(gi-nodes.js) now also returns `shadowT` (sentinel -2 = "no sun configured",
otherwise the raw shadow march result: -1=unshadowed, >=0=shadow hit
distance) and `N` (the hit normal) alongside `radiance`/`dist`/`hit` -- no
logic change, just exposing values that were already computed internally.
`createRayDebugKernel` now reuses `traceAndShadeRayTSL` directly (previously
it only ran the primary march) and writes two more vec4 buffers per ray:
`radianceBuffer` (radiance.xyz + shadowT) and `normalBuffer` (N.xyz + hit
flag). CPU side: `gi-reference.js`'s `traceProbeRays` was refactored into a
thin wrapper over a new exported `traceSingleRay()` (single source of
truth, behaviorally identical -- all 160+ existing tests still pass
unchanged) that returns the same rich per-ray shape. `tools/gi-parity.mjs`
gained `compareRayShading()` (radiance/shadowT/N diff, tolerant on radiance
magnitude, exact on hit/miss classification) wired into `runScene()`
alongside the existing direction/hitT comparison.

**Own-oracle sanity check while building this** (parent: "check the oracle
too, don't trust either side"): the debug tool's default `raysToCapture`
was a fixed 16 out of `raysPerProbe` (24-32) -- but `fibonacciSphereDirs`
is y-DESCENDING (top pole to bottom pole first), so the first 16 of 24 rays
are systematically biased toward UPWARD-pointing directions. Under
scene(i)'s straight-down sun, an upward ray's hit normal (N=-dir) points
DOWN (away from the sun) almost every time -- so a naive 16-ray debug
sample of scene(i) shows "all hit rays have zero radiance" for a
perfectly legitimate reason (N.L<0, no bug) while the OTHER 8
(uncaptured) rays are the ones actually receiving sun and driving the
probe's real ~70-80 aggregate value. Fixed: `raysToCapture` now defaults to
the scene's full `raysPerProbe`, not a fixed prefix, so the next live run's
ray-level diff is unbiased and won't manufacture a false "radiance always
0" signal from sampling alone.

**Regression test added** (parent: "pin cfg.voxelDims!=probe dims,
removal mutant"): `test/gi-parity.test.js` now asserts probe-grid dims and
voxel-grid dims are never numerically interchangeable for either scene, and
that swapping them changes `referenceUpdateProbe`'s result materially (not
a silent no-op) -- pins the exact bug class the parent's fc1fffa fixed.

**Still UNVERIFIED**: whether GPU radiance now actually matches CPU at hit
points -- the extended per-ray radiance/shadowT/N trace is built and
CPU-tested, but only a real GPU run can show whether the divergence was in
the shadow march bias, N sign, or the bounce-probe lookup (the parent's own
listed suspects); this pass adds the INSTRUMENT, not (yet) a confirmed fix,
since no CPU-side formula divergence was found -- `traceAndShadeRayTSL` and
`traceSingleRay` are structurally identical formulas (confirmed by direct
source comparison), so if GPU still diverges after this, the cause is
likely GPU-execution-side (float32 precision, a WGSL-specific quirk in
`select()`/`If()` short-circuiting, or the bounce-atlas read racing an
unconverged neighbor) rather than a formula-level bug this repo's own
node --test can catch without a device.

## Live-GPU root-cause pass #5 (09-29, parent rerun after pass #4)
Per-ray shading parity now FULLY proven live: radiance GPU==CPU on every ray
for all 6 debug probes (0 diffs, full ray sets), N equal, only a cosmetic
shadowT encoding difference (GPU 0 vs CPU null when N.L<=0 -- both mean
"never entered the shadow branch", just encoded differently; harmless).

Remaining: the FULL BAKED ATLAS still diverges (scene(i) all-0 actual vs a
varied CPU expectation). Parent's new hypothesis: "the CPU oracle's
integration path doesn't equal a sum of its own traceSingleRay outputs" for
scene(i) probe 4 (their read: probe 4 is dead-center inside a sealed box,
every ray should hit with radiance 0, so the atlas should read 0 -- but the
CPU oracle says 53.58).

**Investigated directly** (this repo, real scene data, `test/gi-integration-mirror.test.js`):
1. `referenceUpdateProbe`'s texels are EXACTLY `integrateProbeIrradiance(texelDir, traceProbeRays(...))` for every one of the 16 texels -- verified by direct equality, not approximation. There is no hidden extra step or different ray set between the per-ray debug path and the atlas path; they trace identical rays through identical functions (`traceSingleRay` is the single source of truth for both, since the pass-#4 refactor).
2. The apparent "doesn't equal a sum of the rays" observation is comparing two DIFFERENT, both-correct aggregations: a texel value is a *cosine-weighted Monte-Carlo integral along one specific direction*, not a raw sum of all 24 rays' radiance -- these are never expected to be numerically equal, even with zero bugs anywhere (documented + pinned with a mutant test).
3. **Scene(i) probe 4 is NOT physically sealed.** `heightRange` (e.g. `[3,9]` for `half=6`) is narrower than the box mesh's own full height (`[0, 2*half]` = `[0,12]`) -- the box's floor and ceiling triangles fall ENTIRELY outside the voxel grid's Y window and get skip-checked away by voxelize.js's own "fully outside" rule (the exact rule this project's own bugfix history added). Only the 4 side walls survive, clipped to a 6-unit-tall slice. A ray fired straight up or down from the center travels only 3 units before exiting the GRID (not the mesh) and correctly reads sky per the pass-#2 bounds-check-and-skip fix. Directly confirmed: 8 of 24 rays from probe 4 miss (sky) in this repo's own re-derivation. **The CPU oracle's nonzero value is physically correct for this scene's geometry/grid config, not a bug.**

Given the integration math is proven internally consistent and the ray-level
shading is proven GPU==CPU, the gap must be specific to the FULL ATLAS
KERNEL's accumulation across its `Loop(raysPerProbe,...)` + hysteresis path
-- something the simpler ray-debug kernel (which just records raw per-ray
values, no accumulation) doesn't exercise.

**New diagnostic added** (parent's exact request): `runSingleUpdateCheck()`
(tools/gi-parity.mjs) isolates the kernel's RAW per-dispatch integration
from hysteresis convergence and round-robin batching: forces
`irradianceAlpha:0` (so `mix(new,old,0)=new` exactly -- no blend-in of the
fresh-zero initial atlas) and `updateFraction:1` (one `update()` call
covers the whole grid, no probeOffset/round-robin complexity), runs
EXACTLY one `gi.update()`, and diffs the GPU atlas readback directly
against `referenceUpdateProbe`'s raw CPU result (which has no hysteresis
concept at all -- every CPU call already IS the fresh single-pass integral,
so no special-casing needed on that side). `runAll()` now returns
`{ scenes: [...], singleUpdate: [...] }` (was a flat array -- `tools/gi-parity.html`'s
render() updated to match). **If this single-update check still diverges,
the bug is in the kernel's raw Loop+weighted-sum+MC-normalize accumulation
itself; if it matches, the bug is specific to the multi-iteration
hysteresis/round-robin path** (e.g. the validCount guard added in pass #3,
or a probeOffset/atlasIndex interaction across many calls).

## Live-GPU root-cause pass #6 (09-29, parent rerun after pass #5) — LIKELY ROOT CAUSE FOUND + FIXED
Parent's `runSingleUpdateCheck()` result was decisive: with hysteresis fully
disabled (alpha=0, one update), the atlas STILL diverges from CPU exactly
where per-ray shading was ALREADY proven identical (dir/hitT/hit/N/radiance
all matching, live-verified). The 80.552-vs-80.629 residual disappeared
entirely at alpha=0, confirming it really was pure hysteresis-convergence
rounding (not a bug). Pattern: probes where every ray misses (pure sky) read
correctly; probes where ANY ray hits something read wrong (0, a truncated
partial value, or the hit's contribution silently missing). Scene(i), walls
everywhere so nearly every probe has an early hit → reads all 0.

**Arg-by-arg diff of the two `traceAndShadeRayTSL` call sites** (parent's
explicit request), gi-nodes.js:
```
update kernel (createGIUpdateKernel, inside Loop(raysPerProbe,...)):
  traceAndShadeRayTSL({ occ, rayOrigin: probePos, rayDir: dir, maxDist,
                         sun, lights, albedo, skyColor: skyColorU, bounceAtlas, bounceGrid })

debug kernel (createRayDebugKernel, ONE ray per thread, no outer loop):
  traceAndShadeRayTSL({ occ, rayOrigin: probePos, rayDir: dir, maxDist,
                         sun, lights: null, albedo, skyColor: skyColorU, bounceAtlas: null, bounceGrid: null })
```
`occ` / `rayOrigin` / `rayDir` / `maxDist` / `sun` / `albedo` / `skyColor`
are IDENTICAL (same values, and `occ`/`sun` are the literal SAME object
references from `gi.resources`, pinned by `test/gi-kernel-shared-uniforms.test.js`).
The ONLY difference: `lights`/`bounceAtlas`/`bounceGrid` (update kernel
passes the real ones; debug kernel always passes `null`) — both are no-ops
in these scenes (no point lights registered, no bounce atlas wired), BUT
this difference is exactly what made the debug kernel accidentally immune
to the real bug.

**Root cause**: `marchOccupancyTSL` used `Break()` to early-exit its own
step `Loop` once a hit was found. Safe when called with NO outer loop
(the debug kernel: one ray per thread). But `createGIUpdateKernel`/
`createGIDepthUpdateKernel` call it (via `traceAndShadeRayTSL`, up to 3x
per ray: primary march + sun shadow + per-point-light shadow) from WITHIN
their OWN outer `Loop(raysPerProbe,...)`. A `Break()` inside an inner Loop
that's only reached by a function call made from within an outer Loop is
exactly the kind of construct that breaks the WRONG (outer) loop in
graph-based shader builders, whose `Break()` targets "the nearest
enclosing Loop node as seen by the graph builder at the call site" — not
necessarily the lexically-nearest one a human reader expects across a
function-call boundary. This explains the symptom exactly: a probe whose
rays never hit anything never calls `Break()`, so the outer ray-
accumulation loop runs to completion normally (correct ~80.629); a probe
where ANY ray hits something triggers `Break()`, which (per this
hypothesis) silently terminates the OUTER per-thread ray loop too —
leaving `sampleEstimate` with only whatever partial sum had accumulated
before that ray, not all `raysPerProbe` rays. Scene(i)'s walls-everywhere
geometry means nearly every probe's very first few rays already hit
something → near-immediate truncation → atlas reads ~0 almost everywhere,
matching the reported "scene i ALL 0" exactly.

The SAME risky pattern existed in `traceAndShadeRayTSL`'s point-light loop
(`Loop(lights.maxLights,...)` with an `If(...).../Break()` early-exit for
`i>=lights.count`) — also nested inside the update kernel's outer ray loop,
also never exercised by the debug kernel (which passes `lights: null`).

**Fixed**: removed `Break()` from BOTH loops, replacing the early-exit
pattern with an If-guarded body (skip the remaining work, don't break the
loop) in both cases:
- `marchOccupancyTSL`: `Loop(MAX_MARCH_STEPS,...)` now always runs its full
  iteration count; each step's body executes only `If(stillSearching, ...)`
  where `stillSearching = t < maxDist AND hitT < 0`.
- point-light loop: `Loop(lights.maxLights,...)` always runs to completion;
  each iteration's body executes only `If(i < lights.count, ...)`.

Both are a real, accepted perf cost (no more early exit) for eliminating
the nested-loop-break risk everywhere `marchOccupancyTSL`/the point-light
loop are used — correctness first; revisit for perf once verified live.

**Still UNVERIFIED**: whether TSL's `Break()` genuinely mis-targets the
outer loop in this exact nested-function-call configuration is a
HYPOTHESIS matching every observed symptom precisely, not something
node --test can execute/confirm without a real GPU device (TSL Fn bodies
don't expand into a walkable/runnable graph without a builder, as
established in earlier passes). The fix is safe regardless of whether this
exact mechanism is right, since it removes ALL Break() usage from any code
path reachable from inside the update kernels' outer loop.

## Live-GPU root-cause pass #7 (09-29, parent rerun after pass #6: Break() fix REFUTED)
Parent's live rerun (CDP cache disabled, fresh tab, confirmed served tree)
showed the Break()-removal fix changed NOTHING — atlas + singleUpdate results
identical to pass #5's to 3 decimals. The nested-loop-Break() hypothesis is
REFUTED as the (or at least THE ONLY) cause. Parent's instruction: stop
inferring from the debug/reference kernels entirely, instrument the REAL
update kernel directly.

**(B) grep, as requested**: exactly ONE definition each of
`marchOccupancyTSL`/`traceAndShadeRayTSL` in gi-nodes.js (confirmed,
`test/gi-instrumented-kernel.test.js`) — no inlined/older copy exists for
the update kernel to be accidentally using instead of the patched one.
Ray rotation: `GIController` never passes a `rotation` option into
`createGIUpdateKernel`, so both the GPU update kernel and the CPU
single-update trace use the default `rotation=null` identically (confirmed
by source inspection, not just assumption).

**Instrumented the REAL update kernel** (parent's exact spec, part A+C):
`createGIUpdateKernel` now always allocates (cheap, tiny) and conditionally
writes five debug outputs, ALL no-ops by default (gated by a
`debugProbeUniform` sentinel `0xffffffff` that no real wrapped probeIdx can
ever equal):
- `probeMapBuffer` (C): one `vec4` per probe (probePos.xyz + probeIdx),
  written by EVERY probe's own texel-0 thread every dispatch (always on,
  cheap) — the ground truth for "which probe does this GPU thread think it
  is", independent of any shading question.
- `debugDirHit`/`debugRadianceWeight`/`debugRunningSum` (A): per-ray
  `{dir.xyz+dist, radiance.xyz+weight, runningSum.xyz+rayIndex}` for ONE
  selected probe's texel 0 only, written INSIDE the real
  `Loop(raysPerProbe,...)` as it executes — not a parallel/simplified
  re-derivation.
- `debugFinal`: the post-MC-normalization, PRE-hysteresis `newEstimate` for
  that probe's texel 0.

`tools/gi-parity.mjs` gained the CPU-side half
(`cpuStepByStepTrace`/`compareStepByStepTrace`, both pure/node-tested) and
wired GPU readback into `runSingleUpdateCheck(..., { debugProbeIndices })`:
re-runs the (idempotent at alpha=0) single update once per requested probe
with `debugProbeUniform` set, reads all five buffers back, and diffs
ray-by-ray against the CPU trace, reporting the FIRST diverging ray and
WHICH field (dir/dist/radiance/weight/runningSum) diverged — not just a
final pass/fail. `runAll()` requests exactly the parent's named probes:
scene(i) probe 4, scene(ii) probes 13 AND 14.

**CPU-side reference values generated locally** (no GPU needed for this
half) for the parent to diff their next GPU readback against — texel 0
only, NOT the full-atlas sum reported in earlier passes:
```
scene(i) probe 4 (probePos [0,3,0], texelDir [-0.408,-0.408,-0.816]):
  final estimate = [0.941, 1.176, 1.647]
  ray0  dir=[0,1,0]        dist=24.00 radiance=[.4,.5,.7] w=0.000 runSum=[0,0,0]
  ray2  dir=[.05,.83,-.56] dist=24.00 radiance=[.4,.5,.7] w=0.101 runSum=[.040,.051,.071]
  ray4  dir=[-.75,.65,-.13] dist=5.50  radiance=[0,0,0]   w=0.146 runSum=[.040,.051,.071] (HIT, no light)
  ray23 dir=[0,-1,0]       dist=24.00 radiance=[.4,.5,.7] w=0.408 runSum=[1.797,2.246,3.145]

scene(ii) probe 13 (probePos [5,0.5,0], texelDir [-0.408,-0.408,-0.816]):
  final estimate = [1.232, 1.539, 2.155]
  ray31 dir=[0,-1,0] dist=30.00 radiance=[.4,.5,.7] w=0.408 runSum=[3.136,3.920,5.488]

scene(ii) probe 14 (probePos [10,0.5,0], texelDir [-0.408,-0.408,-0.816]):
  final estimate = [1.039, 1.264, 1.715]
  ray4  dir=[-.66,.74,-.12] dist=2.00 radiance=[.33,.33,.33] w=0.062 runSum=[.031,.034,.039] (HIT the wall, lit)
  ray31 dir=[0,-1,0]        dist=30.00 radiance=[.4,.5,.7]  w=0.408 runSum=[2.645,3.219,4.367]
```
(full per-ray tables reproducible via `cpuStepByStepTrace(probeIdx, cfg)`;
probePos/texelDir/dist/radiance/weight/runningSum fields all match 1:1 with
what the GPU debug buffers now record for the SAME probe.)

**Still UNVERIFIED**: the actual GPU-side first-diverging-ray — this pass
built the discriminator, did not run it. No further fix proposed until the
live readback identifies exactly which field, on which ray, first departs
from these numbers (per the parent's explicit "no more fixes without a
live-readable discriminator").

## Live-GPU root-cause pass #8 (09-29, parent rerun after pass #7 instrumentation)
The pass-#7 instrumented kernel NEVER RAN. The parent's CDP driver had not
been capturing the browser's Log domain until this round; once enabled it
showed: `"The number of storage buffers (12) in the Compute stage exceeds
the maximum per-stage limit (8)"` -> BindGroupLayout invalid -> pipeline
invalid -> every dispatch silently dropped (NO thrown JS error). The
instrumented readback (all zeros, `gpuProbePos [0,0,0]`) was uninitialized
memory, not real data. A "control" run on the pre-instrumentation commit
(0 validation errors, same old divergence pattern) confirmed the ORIGINAL
bug is real and independent of this new self-inflicted one. Observed
limits: adapter advertises max 10 storage buffers (Apple), the actual
device only granted the WebGPU spec's default of 8 -- three.js requests
default limits, not maxed.

**Root cause of the 12**: pass #7's five separate debug storage buffers
(`probeMapBuffer`, `debugDirHit`, `debugRadianceWeight`, `debugRunningSum`,
`debugFinal`) on top of the update kernel's existing 7
(`irradiance`, `occ.occupancy`, `touched`, `skyHits`,
`lights.positions/colors/intensities`) = 12.

**Fixed**: packed all five debug outputs into ONE flat `float` storage
buffer (`computeDebugLayout()`, gi-nodes.js) with a fixed-stride layout:
```
[ probe map region: probeCount x 4 floats (probePos.xyz, probeIdx) ]
[ ray region:        raysPerProbe x 12 floats (dir.xyz+dist, radiance.xyz+weight, runningSum.xyz+rayIndex) ]
[ final region:       4 floats (newEstimate.xyz, writtenFlag) ]
```
`computeDebugLayout()` is exported and imported by BOTH gi-nodes.js (the
writer, inside the kernel) and tools/gi-parity.mjs (the reader, in
`runSingleUpdateCheck`), so the offset math can never drift between the
two sides. Kernel storage-buffer count: 12 -> 8 (7 + 1 packed debug
buffer), exactly at the observed limit, not over.

**(1)(2) storage-buffer budget, verified without a device**:
`countUpdateKernelStorageBuffers()`/`countDepthKernelStorageBuffers()`/
`countDebugKernelStorageBuffers()` (gi-nodes.js, pure JS accounting,
`STORAGE_BUFFER_LIMIT = 8`) mirror exactly which storage buffers each
kernel constructor references. `test/gi-storage-buffer-budget.test.js`
asserts the REAL usage (as GIController.configure() actually builds it)
sits exactly at 8 (zero headroom), a removal mutant reproduces the exact
"12" from the live error, an addition mutant proves adding ANY further
optional buffer (e.g. wiring `bounceAtlas`, still unused in v0) would
overflow, and a structural scan of the real kernel source cross-checks the
accounting isn't just an assertion divorced from the code.

**(3) GPU errors are never silent again**: `withGpuValidation()`
(tools/gi-parity.mjs) wraps `runScene()`/`runSingleUpdateCheck()`'s entire
body in a `device.pushErrorScope('validation')`/`popErrorScope()` pair
PLUS a persistent `'uncapturederror'` listener on the renderer's real
`GPUDevice` (`renderer.backend.device`) for the duration. Any validation
error, uncaptured device error, or thrown JS error is collected into
`result.gpuErrors` and forces `result.pass = false`, overriding whatever
the (now known to be untrustworthy without this check) readback comparison
said. Gracefully no-ops when no real device is reachable (so it's safe to
call with any future test-only fake renderer). 9 tests
(`test/gi-gpu-error-capture.test.js`) cover validation errors, uncaptured
errors, both together, thrown errors, the no-device graceful path, and a
mutant proving a harness that skips this check would report pass-#7's
exact silent-zero failure as a legitimate result.

**Still UNVERIFIED**: the actual GPU-side per-ray trace from the packed
buffer, and whether the ORIGINAL bug (scene(i) all-0, scene(ii)'s wall-hit
probes wrong) is still exactly the same now that the instrumentation can
actually run without tripping the storage-buffer limit. This pass fixed
the instrumentation's own self-inflicted breakage; the parent's next live
run is the first one where the pass-#7 discriminator will actually produce
data.

## Live-GPU root-cause pass #9 (09-29, parent rerun after pass #8 fixed the instrumentation itself) — ACTUAL ROOT CAUSE FOUND + FIXED
With the storage-buffer overflow fixed (pass #8), the instrumented kernel
finally ran and produced real data: 0 GPU errors, probeIdx+position match
exactly. **First divergence, found directly from the raw readback**: march
`dist` is CONSTANT per probe across EVERY ray, established by ray 0 and
never changing regardless of `dir` (scene(i) probe4: dist=4.5 for all 24
rays vs CPU's varying 24/5.5/7.5/6/5/4.5/...; scene(ii) probe13: dist=4 for
all 32 vs CPU mostly-30/miss; probe14: dist=2 for all 32). `dir` and
`weight` matched exactly -- only the march RESULT was wrong, and wrong the
SAME way for every ray after the first.

**Root cause**: `marchOccupancyTSL`/`traceAndShadeRayTSL` are PLAIN JS
functions (never wrapped in TSL's own `Fn()`), called once per ray from
WITHIN the update kernels' outer `Loop(raysPerProbe,...)`. Their
`.toVar()` locals (`t`,`hitT` in marchOccupancyTSL; `shadowTOut`,`direct`
in traceAndShadeRayTSL) do not reliably get their DECLARATION-TIME initial
value re-applied each time the outer loop reaches that code across a
plain-function-call boundary -- so once ray 0 sets `hitT>=0`, the guard
`stillSearching = t<maxDist AND hitT<0` is false from t=0 for every later
ray too, and the loop body (including the occupancy read) never executes
again: every subsequent ray silently returns whatever `hitT` ray 0 left
behind. This is DIFFERENT from (and the real cause underlying) the pass-#6
Break()-scoping hypothesis -- Break() removal changed nothing live because
the loop body was already being skipped via the `stillSearching` guard
being permanently false, not because of a Break() mis-targeting an outer
loop. The ray-debug kernel (createRayDebugKernel) never showed any of this
because it has NO outer loop at all -- one ray per GPU thread, so "once
per shader invocation" initialization was already correct there purely by
construction, which is exactly why per-ray debug parity was proven correct
in earlier passes while the real update kernel stayed broken.

**Fixed**: explicit `.assign()` resets immediately after every affected
`.toVar()` declaration, BEFORE any conditional logic that reads or mutates
that variable -- `t.assign(0); hitT.assign(-1);` in marchOccupancyTSL,
`shadowTOut.assign(-2);` and `direct.assign(vec3(0,0,0));` in
traceAndShadeRayTSL. `.assign()` produces a MUTATION node, not a
declaration -- it gets placed at the actual control-flow point it's
written, regardless of where the underlying variable's own declaration
ended up, forcing a genuine per-ray reset. Confirmed NOT to touch the
variables that are SUPPOSED to accumulate across the ray loop
(`sampleEstimate` in createGIUpdateKernel; `wSum`/`dSum`/`d2Sum` in
createGIDepthUpdateKernel are declared OUTSIDE the loop and correctly left
alone -- resetting THOSE would be the opposite bug).

`test/gi-loop-carried-state-mirror.test.js` pins the fix structurally
(reset calls exist, in the right order, right before any conditional use)
since this specific hoisting/scoping behavior cannot be executed or
observed without a real WebGPU device+builder (established in earlier
passes: TSL Fn bodies don't expand into a walkable/runnable graph without
one) -- includes a mutant reproducing the exact pre-fix source pattern and
a mutant demonstrating what an unreset `direct` accumulator would do
(ever-growing wrong sum across rays, not just a stuck value).

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
