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

## UNVERIFIED (need a real GPU frame)
- Actual fps cost of `raysPerProbe × activeProbes` compute dispatch — no WebGPU device in node tests, only node-graph *construction* is verified here.
- Voxelization over-occlusion visibility on real geometry (thin diagonal walls).
- Whether flat-radiance ray hits (no second bounce/material sample) look acceptable vs needing a real one-bounce shade.
- `raysPerProbe`, `updateFraction`, both hysteresis alphas, Chebyshev epsilon — all PLACEHOLDER, tuned on a real frame later.
