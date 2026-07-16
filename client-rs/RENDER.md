# RENDER — DreamForge rendering spec (DRAFT for Pascal's ruling, 2026-07-16)

Status: DRAFT. Evidence: research/{nanite,gi,vt,neural}-recon.md. Laws it
implements: DREAMFORGE.md (never optimize · forbidden vocabulary · sole
cluster pipeline · infinite lights · REAL path tracing · hardware-agnostic,
M1 current target).

## The frame (one path, no alternatives)
```
sim/ECS → cluster cull (GPU-driven, two-pass HZB) → visibility buffer
→ material resolve (G-buffer) → PATH-TRACED lighting (one integrator:
  direct+GI+reflections+emission) → denoise → temporal upscale → overlay
```
No forward path. No raster lighting. No probe/reflection-map pass exists.

## 1 · Virtualized geometry — the sole pipeline
- **Build (offline/import, automatic, invisible)**: triangles → ≤128-tri
  clusters (meshopt) → adjacency groups (METIS-class min-edge-cut) → merge →
  simplify 50% → repartition → repeat to root. DAG, group-identical LOD
  decisions = crack-free. BUY: meshoptimizer (Apache) + METIS for baker
  primitives. BUILD: DAG grouping, paging, culling, raster, resolve (the
  parts meshopt does NOT supply — confirmed by recon).
- **Runtime**: BVH-over-clusters cull, persistent-thread queues, two-pass
  HZB occlusion; view-dependent error metric selects cut
  (`parentError > τ ≥ clusterError`); streaming in fixed pages (128KB-class,
  group-granular activation, root resident, GPU-emitted page requests).
- **Rasterizer backends (capability trait — data path identical)**:
  - `hw-vis`: HW raster → visibility buffer via primitive ID + barycentrics
    + normal depth test (no atomics needed). M1 PRIMARY (M1 lacks 64-bit
    atomics — Apple9+ only; UE refuses M1 for exactly this).
  - `sw-vis`: compute raster, 64-bit InterlockedMax packed word — fast path
    where hardware allows (Apple9+, desktop). 3× HW on micro-triangles (UE
    published).
  - 32-bit packed experiment (Scthe precedent) = research option, precision
    artifacts documented.
- **Requirements FROM Nanite's sucks-list (their gap = our contract)**:
  - ANY topology: non-manifold/holes/internal faces must not break the
    baker (Pascal law: "works with any geometry")
  - skinned/deforming: cluster skinning in compute pre-cull; bounds track
    deformation (no UE "WPO culling wrong under extreme deformation")
  - procedural: contouring kernel (SDF/voxel) emits clusters directly —
    same pipeline, no second path
  - translucency: primary visibility rasters opaque; transparent surfaces
    resolve IN THE INTEGRATOR (traced transport handles them — Nanite can't
    because its materials are raster; ours aren't)
  - aggregates (foliage/hair): porous volumes defeat occlusion culling —
    answer = volumetric representation (voxel/SDF density) at distance,
    clusters near; one entity, representation blends. Design detail in
    GEOMETRY.md amendment
  - disocclusion spikes (prev-frame HZB dependence): budget-capped pass-2;
    upscaler absorbs the miss frame
- Instance transforms virtualized too (10M×float4x3 = 457MB lesson):
  transform pages stream like geometry pages.

## 2 · Lighting — one integrator (the law)
- Ground truth: Monte Carlo path transport. Lights, sky, emissive materials
  = one thing: emitters. Reflections/GI/shadows/AO = not features, just
  paths. Granted: noisy + low internal res (Pascal).
- **Intersector trait** (transport never changes): M1 = SDF fields
  (near-field precise) + voxel occupancy mips (far/coarse) — Lumen's SW
  path proves 4ms-class budgets on this exact scheme; cluster BVH / HW rays
  = same trait, faster, later silicon.
- **Sampling**: ReSTIR (direct many-lights + GI reuse) — the published
  answer to infinite lights at 1spp-class budgets (9-166× MSE win). Rides
  ANY intersector (it's a sampling algorithm, not an RT-hardware feature).
- **Variance reduction only** (must converge to traced truth): screen-space
  reuse, world radiance cache (NRC-class GPU MLP proven in Rust/compute —
  Breda precedent), temporal accumulation. NEVER authority: no surface-cache
  -as-truth (Lumen's seconds-long light lag = cache authority; our budget:
  light changes visibly propagate within ~100ms, fully converge in ~1s).
- **Anti-goals (Lumen sucks-list encoded)**: no seconds-lag on global light
  changes · small emissives = first-class emitters (ReSTIR samples them) ·
  no thin-wall leaking class (geometry IS the field on the SDF path) · no
  quality ladder to a second system — dials: paths/pixel, bounces, internal
  res, cache freshness.

## 3 · Textures — virtual, software-indirected
- wgpu has NO sparse textures (gpuweb#455) ⇒ software indirection = the
  pipeline: physical tile pools (per-format LRU) + page-table texture +
  shader UV remap. idTech/UE/Granite all ship this — hardware sparse never
  required. Metal sparse (M1 has it) = optional fast path behind trait.
- Pages 128²-class; feedback from the visibility/material pass drives
  residency; oversubscription → mip-bias softening, NEVER a render failure.
- Format: KTX2/UASTC intermediate (bit-repack to BC7 AND ASTC ≈ free);
  ASTC-8×8 for distant/rough (0.25 B/texel). 20K input textures welcome:
  resident set = sampled tiles (few MB), disk = compressed pages.
- IO trait: MTLIOCommandQueue on macOS 13+ (disk→GPU, tile-granular,
  DirectStorage-analog), std async IO fallback.
- Megatexture lesson: arbitrary INPUT size always; uniqueness ≠ virtue;
  transcode must be bit-repack cheap (never JPEG-family).

## 4 · Presentation
- Internal resolution = a dial (path tracer feeds it); temporal upscale to
  native: MetalFX via texture_from_raw interop on Metal; own temporal
  upscaler as the hardware-agnostic fallback. Denoiser: temporal + spatial
  compute (SVGF-class start, learned GPU-MLP later — ANE ruled out).

## 5 · Capability traits (hardware-agnostic law)
| trait | M1 (current target) | later silicon |
|---|---|---|
| raster backend | hw-vis (primitive ID) | sw-vis (64-bit atomics) |
| intersector | SDF + occupancy mips | + cluster BVH / HW rays |
| sparse residency | software indirection | + Metal sparse fast path |
| streaming IO | MTLIOCommandQueue | DirectStorage / io_uring |
| upscaler | MetalFX interop | DLSS/FSR slots, own fallback |
Quality adapts by CONTINUOUS dials, never by switching systems.

## 6 · M1 frame budget (16.6ms, internal ~1080-1440p)
geometry cull+raster+resolve ~4.5ms · path tracing + ReSTIR ~6ms · denoise
~2ms · upscale ~1.5ms (MetalFX published 8-15ms is 720p→4K spatial worst
case; temporal at our ratios budgeted lower — VERIFY on device) · sim/rest
~2.5ms. All numbers = starting budgets, verified per milestone on the
MacBook, never assumed.

## 7 · Milestones (each playable, screenshot-verified)
R1 clusters: boomtown through baker → cluster cull+HZB+hw-vis buffer →
   flat-shaded G-buffer. Gate: 5,261 entities, stable 60 @ internal res.
R2 materials+VT: resolve pass + software VT + KTX2 pipeline. Gate: 20K
   texture dropped in, just works, resident MB counter proves it.
R3 light v1: integrator w/ SDF/occupancy intersector, direct only + ReSTIR.
   Gate: 1,000 dynamic lights in a scene, one dial, no error class.
R4 GI: bounces + temporal accumulation + denoiser. Gate: place light →
   lit scene immediately; global change converges <1s.
R5 upscale: MetalFX interop + own temporal fallback. Gate: 60fps native-
   window on the MacBook.
R6 scale: billion-triangle content test (Scthe proved 1.7B in a BROWSER —
   native must beat it), streaming pages under flight.

## 8 · Apple-Silicon perf appendix (evidence: research/metal-recon.md)
Portable wisdom (all backends): fewest passes · LoadOp::Clear +
StoreOp::Discard on every transient target · fp16-first shaders
(SHADER_F16) · subgroup ops (SUBGROUP, width 32 on M1, threadgroups ×32) ·
minimize device atomics (Apple: 32-bit only — third vindication of
hw-vis-first) · WGSL override for variants · single dispatch_indirect +
persistent-queue culling (multi-draw-indirect absent on wgpu-Metal —
non-event for a vis-buffer design).
Trait-gated: TextureUsages::TRANSIENT → Metal memoryless (verify wgpu ≥
PR#8247) · MetalFX · MTLIOCommandQueue.
Unreachable via wgpu (accepted): on-tile single-pass deferred (imageblocks/
ROG) — hurts classic deferred far more than our vis-buffer+compute-PT
frame; revisit only if Buffer-RW limiter proves otherwise.
Profiling law: every R-milestone gate includes Xcode GPU capture on the
MacBook, read by LIMITER (ALU/Buffer/Texture), not utilization %. Xcode
attaches transparently to the Tauri/wgpu binary.

## Rulings (Pascal 07-16: "you do whatever works, performance first")
1. ✅ hw-vis-first on M1; sw-vis capability-gated. RULED.
2. ✅ foliage/aggregates → density field at distance, clusters near, blend
   automatic — GEOMETRY.md amendment queued. RULED.
3. OPEN: physics interleave point (after R2 or R4) — waits on Pascal's own
   physics pass (PHYSICS.md hold).
