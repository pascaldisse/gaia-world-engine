# CREATE.md recon — in-engine creation suite (ghoul-sonnet, 2026-07-16)

Status: evidence for CREATE.md (sculpt/paint/auto-UV/auto-rig/node-proc).
Recon informs, Pascal rules. Web recon only — no code run.

## 1. SCULPT

### ZBrush DynaMesh / Sculptris Pro — "Tessimation"
- Sculptris Pro = tessellation + real-time decimation fused ("Tessimation").
  Density driven by brush Draw Size: small brush → dense triangles under
  stroke; large brush → coarse. `Adaptive` ties density to local curvature/
  brush shape, not just size.
- No vertices pre-exist where you sculpt — SP creates them on demand at the
  stroke, unlike classic mode which only moves existing verts (so classic
  sculpt is resolution-capped by base mesh, SP is not).
- Refine modes: Subdivide Edges (fine detail/creases) / Collapse Edges
  (relax + delete long thin tris) / Subdivide+Collapse (default, balanced).
- Incompatible w/ subdivision levels or existing UVs — enabling nukes both
  (work on a duplicate). UVs/bake happen AFTER retopo (ZRemesher + Project
  All), never during. Sculpt-then-retopo-then-UV is the fixed pipeline —
  topology is NOT stable during sculpting, only after a deliberate step.
- DynaMesh = different mechanism: full mesh rebuild to UNIFORM resolution on
  demand (ctrl+drag), vs SP's local/on-stroke density. DynaMesh is the
  "reset to sane topology" hammer; SP is the "add detail here" scalpel.

### Nomad Sculpt — 1 dev (Stéphane Ginier), iPad/Android/desktop-beta, M1-class proof
- Dynamic topology: refines locally under brush (like SP), keeps LAYERS in
  sync automatically as topology changes underneath them.
- Voxel Remesher: full uniform rebuild (= DynaMesh equivalent), quick-sketch
  use case at start of a piece.
- Auto UV unwrap (face-group-driven), baking both directions (vertex data
  ↔ texture), Quad Remesher IAP (density painting + guides + face groups).
- Numbers: 2023 iPad Pro sculpts ~5M polys, final render ~5s (Nomad FAQ via
  illustrarch review, 2026). One-person project since 2020, proves this
  CLASS of tool (dynamic topo + voxel remesh + PBR paint + layers + auto-UV
  + baking, all touch-first) is buildable by a small team on tablet-tier
  silicon — direct proof-of-concept for an M1 in-engine sculpt mode.

### Blender Dyntopo — the cautionary tale
- Three detail modes: Relative (screen-px, default) / Constant (world-unit
  %, has an eyedropper to sample existing edge length) / Brush (tied to
  brush radius).
- KNOWN FAILURE MODE: Grab-brush + Dyntopo enabled = severe slowdown WITHOUT
  creating new topology (open bug #62718, Blender dev tracker) — dyntopo
  cost is being paid for brushes that get zero benefit from it. Lesson:
  dynamic retessellation must be gated per-brush-type, not global-toggle,
  or you pay tessellation cost on strokes that don't need it.
- Community-documented failure pattern: "excessive tessellation → perf
  drop" is the #1 reported mistake — i.e. Blender exposes the dial but not
  the guardrail; users blow their own budget.

### Dreams (Media Molecule) — SDF, no-topology alternative
- 100% compute, zero rasterizer for the base representation. Scene = an
  "Operationally Transformed CSG tree" of primitive EDITS (spheres, etc,
  1–100,000 per model), evaluated on the fly into a high-res SDF, then
  converted to a dense multi-resolution POINT CLOUD for rendering (splats),
  not triangles. (Alex Evans, SIGGRAPH 2015, "Learning from Failure" talk —
  advances.realtimerendering.com/s2015/mmalex_siggraph2015_hires_final.pdf)
- Consequence: literally no topology to manage, no UV to break, no
  retopo step — the entire ZBrush pipeline problem (sculpt→retopo→UV→bake)
  is INAPPLICABLE by construction. Paint is vertex/point-color on the same
  representation, not a separate UV-mapped pass.
- Underlying rep converts to a mesh trivially for asset interchange (many
  simplification tools already go mesh→SDF internally for LOD, so the
  inverse direction is a known, well-trodden op) — SDF-primary does not
  block "produce a triangle mesh for export/render" as a downstream step.
- This is the direct precedent for DreamForge's ratified SDF-field-boolean
  sculpt mode (replace map: carve CSG → SDF field sculpt) — Dreams proves
  the full pipeline (author → point-render → ship a game) at AAA polish on
  2013 console hardware with zero rasterizer.

### Sucks verdicts — sculpt
- ZBrush SP: best-in-class density control, but bakes in a HARD PHASE BREAK
  (sculpt topology is throwaway, must retopo before UV/rig) — violates
  DreamForge's "no bake-mesh concept" law as-is.
- Blender Dyntopo: correct idea, no per-brush cost gating → predictable
  self-inflicted perf cliffs; the guardrail Blender is missing is exactly
  what our "never optimize, budget adapts" doctrine must supply by design
  (auto-throttle density per brush class, not user-tuned sliders).
- Dreams SDF: closest philosophical match to "it just works, no bake-mesh
  concept" — but Dreams targets POINT rendering, not our virtualized-mesh
  pipeline; the win to steal is the EDIT-TREE representation (CSG ops as
  data, re-evaluatable), not the point-splat renderer. DreamForge already
  ratified SDF-field sculpt feeding the cluster/contouring pipeline
  (GEOMETRY.md) — contouring kernel emits clusters directly, sidestepping
  Dreams' point-cloud detour entirely.

### M1/Rust feasibility — sculpt
- Nomad Sculpt is the load-bearing existence proof: dynamic-topo sculpt +
  voxel remesh + layers + PBR paint + auto-UV + baking, real-time, on
  iPad/M-series-class silicon, built by ONE person. DreamForge sculpt (SDF
  field ops → contouring kernel → cluster output, no discrete "mesh" the
  user edits) is a SIMPLER data model than Nomad's (Nomad still round-trips
  through a live polygon mesh) — the contouring-to-clusters path GEOMETRY.md
  already specifies is the right target, not a Dyntopo/ZBrush port.
- wgpu/Metal compute is sufficient for SDF evaluation + point/marching
  work at Dreams-2013-PS4-GPU-tier budgets; M1's GPU compute throughput
  exceeds PS4's for this workload class (established in prior metal-recon,
  gi-recon evidence).

## 2. PAINT-ON-MESH TEXTURING

### Substance Painter — architecture
- Pipeline is fixed and BAKE-GATED: high-poly model → low-poly UV-unwrapped
  mesh IMPORT → bake mesh maps (normal, AO, curvature, position, ID, thick-
  ness) from high→low → THEN paint. Painting itself operates on the BAKED
  maps as inputs to masks/generators — smart materials and generators (edge
  wear, dirt, curvature-driven grime) all read the baked curvature/AO/
  position maps, so skipping bake = losing most of Painter's automation.
- Layer stack: non-destructive, PBR fill layers (base/metal/rough/normal/
  height) + masks + procedural generators + filters, all under an 8-channel
  (configurable) material model, stacked and merged in TEXEL SPACE (painting
  writes into the UV-space texture buffer directly, not a 3D projection
  buffer that's resolved later — projection brush is the INPUT method, texel
  space is the STORAGE/compositing model).
- Smart Materials = saved layer-stack folders (procedural, mesh-adaptive via
  the baked maps) — reusable across any mesh BECAUSE the maps they read
  (curvature/AO/position) are baked per-mesh, so the material logic
  transfers even though the geometry doesn't.
- What baking buys: mesh-aware procedural effects (dirt collects in
  curvature concavities, edge wear on convex curvature, AO-driven grime)
  WITHOUT per-pixel ray queries at paint time — it's precomputed once, then
  every subsequent paint/generator operation is a cheap texture lookup.
- What it costs: bake is a discrete, blocking step; low-poly must be UV-
  unwrapped FIRST (chicken/egg with "auto-UV is invisible machinery"); if
  the mesh topology changes, maps must be re-baked or masks desync.

### ArmorPaint — open implementation
- Repo: armory3d-org/armorpaint region — languages per opensourcealternative
  listing: C, TypeScript, Objective-C, JavaScript (built on the Kha/Armory
  toolkit, Haxe-derived cross-compile framework, NOT a Rust codebase).
  ~3,852 GitHub stars, 419 forks, 104 open issues (snapshot 2026-07).
- Fully GPU: node-based procedural materials (paint WITH nodes, not just
  flat layers), ray-traced baking + viewport (D3D12/Vulkan/Metal), claims
  4K smooth on mid GPU / 16K on high-end. Live-link plugins for Blender/
  Unreal/Unity (external DCC round-trip, not native import replacement).
  Uses xatlas for its UV work (see §3 below — confirmed via xatlas README
  "Used by" list).
- Community verdict (HN thread, 2023, mixed): praised as the only serious
  FOSS competitor in concept, but reported rough edges — camera controls
  awkward at non-Unity/Unreal unit scales, blocking file loads on large
  textures, "layer system truly baffling," feels pre-alpha/hackathon-tier
  in UX polish despite feature completeness on paper. One direct quote:
  "irritating camera controls... good luck importing 8192×8192 textures."
- Verdict: proves procedural node-based PBR paint + GPU ray-traced baking
  is buildable outside Adobe's budget, but the reference implementation's
  UX is NOT the bar to copy — architecture yes, execution no.

### Direct-feel painting: projection vs texel-space
- Two paint models exist and are NOT the same thing: (1) PROJECTION
  painting — brush strokes are cast from the viewport camera through the
  mesh onto whichever UV island(s) are hit, good for "paint across a seam
  in one stroke" and multi-texture-at-once edits (Photoshop 3D's own docs
  frame Projection Painting as specifically for seam-crossing multi-texture
  work). (2) TEXEL-SPACE painting — the stroke is rasterized directly into
  the UV-space texture buffer per visible texel, what Substance Painter's
  storage model actually is; feels "locked to the mesh" and is what powers
  live-updating baked-map-driven generators.
- Substance Painter in practice: viewport interaction FEELS like projection
  (you paint what you see in 3D) but the write target IS texel space —
  the projection is just the INPUT raycast, not the storage; this is why
  seams need explicit handling (padding/dilation) rather than being free.
- Seam/dilation handling (ZBrush + general-industry consensus, novedge
  2026-07 tip + generalistprogrammer 2026 guide): pad exported textures 3-4
  px minimum (16-32 px recommended for mip/LOD-safe game engine use) beyond
  each UV island edge so bilinear/mip sampling never bleeds background
  pixels at runtime; separately, PAINT-TIME seam artifacts (visible color
  discontinuity at the seam itself, not a sampling artifact) require either
  triplanar/projection blending across the seam or manual touch-up — padding
  fixes sampling bleed, it does NOT fix a mismatched paint stroke either
  side of a seam. These are two different bugs with two different fixes.
- What makes painting feel "direct": (a) real-time viewport PBR feedback
  under real/matcap lighting as you stroke (all of ArmorPaint/Painter/Mari/
  3D-Coat share this — the table-stakes bar), (b) triplanar/seamless
  procedural materials so the artist rarely THINKS about UV islands at all,
  (c) texel-space storage so strokes don't warp/stretch under camera moves
  mid-stroke (a pure-projection-only system without texel storage would
  re-project and distort already-painted strokes as the camera orbits).

### Sucks verdicts — paint
- Substance Painter: excellent generators, but the bake-dependency is a
  hard architectural wall — DreamForge's "no bake-mesh concept" law is
  directly incompatible with Painter's model as-is; must replace
  precomputed curvature/AO/position maps with LIVE queries (compute-shader
  curvature/AO from the virtualized geometry each frame or on paint-stroke,
  not a one-time bake) if procedural generators are wanted without a bake
  step — feasible on M1 compute given the geometry is already virtualized/
  resident, unproven at scale, flagged for RENDER.md-adjacent recon.
- ArmorPaint: right architecture (procedural nodes + GPU + xatlas), wrong
  execution (UX complaints); mine the node-material + ray-baking design,
  discard nothing structural but don't copy its interaction model.

### M1/Rust feasibility — paint
- ArmorPaint already proves Metal-backed GPU paint pipeline runs on Apple
  silicon (its Metal backend is listed alongside D3D12/Vulkan). A Rust/
  wgpu equivalent inherits the same GPU primitives (compute-shader curvature/
  AO instead of baked textures, texel-space stroke rasterization via
  compute or fragment write into a storage texture) — no exotic tech
  required, this is a compute + storage-texture problem, well within wgpu's
  feature set on Metal/Apple7 (M1).

## 3. AUTO-UV

### xatlas — C++11, no deps, fork of thekla_atlas (used by The Witness)
- Two-stage API: ComputeCharts (segment mesh into charts + parameterize,
  LSCM-family conformal maps) → PackCharts (pack into atlas, configurable
  brute-force vs fast packing, texel-density scale). Simple API wraps both
  into one `Generate` call.
- Production adoption is the real signal: Godot Engine (built-in lightmap
  UV), Filament (Google), ArmorPaint, Bakery GPU Lightmapper (Unity asset
  store), Skylicht Engine, multiple DXR/path-tracer lightmap-baking demos.
  This is the de facto standard open auto-UV lib for realtime engines.
- Active development as of 2026: PR #125 (Korinin38) adds parallelized
  brute-force packing with coarse-to-fine scheme, better overlap-checking
  (image-compression + 2D segment-tree strategies), quality/speed tradeoff
  now tunable via PackOptions "rate" parameter — i.e. still being improved,
  not abandoned tech.
- No independent benchmark numbers surfaced in this recon pass (xatlas repo
  itself does not publish quality/speed tables) — FLAG for a follow-up pass
  specifically measuring seconds/million-tris and packing efficiency % if
  hard numbers are needed before committing.

### Ministry of Flat (Eskil Steenberg) — the "no seams to hide" bar
- Fully automatic, ZERO user input by design philosophy: "no need to set
  seams, tweak settings, or even inspect the model" — explicitly targets
  removing UV mapping as a workflow step entirely (quelsolaar.com/
  ministry_of_flat), which is a near-verbatim match for DreamForge's
  "manual UV mapping DOES NOT EXIST" law.
- Detects 20+ topology types, applies a different unwrap strategy per type
  (hard-surface vs organic vs mixed handled distinctly) — an "understand
  the geometry, then choose an algorithm" design vs a single universal
  heuristic. Explicitly optimizes for artist-perceived quality, not just
  mathematical distortion minimization: deliberately ROTATES islands to
  align straight edges to texel grid (jagged diagonal lines cost more
  texture resolution to look clean than axis-aligned ones), and will
  intentionally ADD stretch where it improves texture usage/topology-
  following over pure conformality.
- Licensed into Cinema 4D S22 (2020) as its one-click Automatic UV
  Unwrapping tool. Tested on 300MB files per the FAQ. Available standalone
  (UI + CLI for pipeline integration) under a free-for-most-uses license;
  commercial/source licensing available separately (relevant if DreamForge
  ever wants to license rather than reimplement).
- No independent quality benchmark numbers found in this pass either (all
  claims are vendor-stated) — same flag as xatlas.

### UVAtlas / OptCuts — not independently re-verified this pass
- Not searched to convergence in this recon (time-boxed); known from prior
  general knowledge: UVAtlas (Microsoft, isochart-based, DirectXMesh/D3D
  toolchain) and OptCuts (academic, joint cut+parameterization distortion
  optimization, SIGGRAPH Asia 2018) are the other two commonly-cited auto-
  UV references. FLAG: re-run targeted recon on these two specifically if
  CREATE.md needs their numbers cited directly.

### Ptex — per-face texture, NO UV AT ALL (Disney, open source, Apache-ish)
- Core claim, stated identically across disneyanimation.com, wdas/ptex
  GitHub, and ptex.us: "No UV assignment is required! Ptex applies a
  separate texture to each face of a subdivision or polygon mesh." One
  file format efficiently stores hundreds of thousands of per-face texture
  images; API provides cached I/O + high-quality filtering across face
  boundaries (the actual hard problem UV avoids by construction: adjacent-
  face filtering/mipmapping without a shared UV chart).
- Timeline: developed at WDAS, first used in Glago's Guest (2008) and Bolt
  (Nov 2008, first FEATURE film), released open source Jan 2010. Adopted by
  RenderMan (2009), Houdini 11 (2010), 3D-Coat 3.3 (2010), Mudbox 2011,
  V-Ray 2.0 (2011), Mari 1.3 (2011), Air 11, 3Delight 10. Wide production
  tooling support, all OFFLINE/film-render-oriented.
- No intrinsic per-face resolution ceiling — Brent Burley (WDAS Principal
  SWE, via fxguide 2020): tool-chain may cap at 4K/8K per face but total
  Ptex-file texel count runs into gigatexels routinely at WDAS; "having
  many gigatexels in a Ptex file is routine for us."
- Realtime feasibility: NVIDIA demoed "Real-time Ptex" at SIGGRAPH 2011 —
  proof of concept exists, but every production adopter listed above is an
  OFFLINE renderer/DCC, not a game engine; no realtime GAME engine adoption
  surfaced in this recon (14+ years since the NVIDIA demo with none
  materializing is itself signal: the offline-render filtering cost model
  — per-face adjacency lookups every sample — has not been solved cheaply
  enough for realtime raster/RT budgets at production quality, or it would
  have shipped in a shipping game engine by now).
- Could it "kill UV entirely" for DreamForge: philosophically YES (matches
  "manual UV mapping does not exist" harder than even auto-UV does — there
  IS no UV concept, full stop), but the virtualized-cluster geometry
  pipeline (128-tri-class clusters, arbitrary non-manifold-clean topology
  required, streamed at 2KB/cluster granularity per nanite-recon.md) has NO
  established Ptex-filtering-at-cluster-granularity precedent anywhere in
  the industry to steal from — this would be genuinely novel R&D, not an
  adopt-an-existing-system decision like xatlas/MoF are.

### Sucks verdicts — auto-UV
- xatlas: proven, embeddable, actively maintained, zero licensing friction
  (permissive per its GitHub) — the safe BUY for a first cut.
  Weakness: chart-based LSCM parameterization, i.e. still classic
  cut-and-unfold under the hood — will still produce seams and imperfect
  packing on adversarial topology; no "understands artist intent" layer.
- Ministry of Flat: philosophically the exact match for "no seams to
  manage, ever" but closed-source (licensable, not forkable) — evaluate
  licensing cost vs building an xatlas-based equivalent with MoF's
  per-topology-type dispatch IDEA (20+ detected cases, texel-grid-aligned
  rotation, deliberate distortion-for-usage tradeoffs) reimplemented atop
  xatlas's primitives.
- Ptex: the cleanest philosophical fit, zero production-game precedent —
  high-risk/high-reward, park as a research spike, do not put on the
  critical path for CREATE.md v1.

### M1/Rust feasibility — auto-UV
- xatlas is pure C++11 no-deps — trivial to FFI-bind into a Rust build
  (bindgen + cc, or use existing community bindings) or transliterate; runs
  CPU-side, no GPU/Metal dependency at all, so M1 is a non-issue — any
  laptop-class CPU clears it. This is the near-zero-risk pick for shipping
  auto-UV in CREATE.md v1.
- Ptex-at-cluster-granularity, if pursued, is pure R&D risk, not a
  portability question — the open question is algorithmic (per-face
  filtering cost inside a 128-tri cluster streaming pipeline), not
  platform (wgpu/Metal compute can express arbitrary per-face texture
  fetch+filter, the question is whether the memory/bandwidth math works
  at DreamForge's "20K textures, page cache not asset size" virtual-
  texturing target).

## 4. AUTO-RIG

### RigNet (SIGGRAPH 2020) — first general neural rig predictor
- End-to-end: mesh → predicted skeleton (joint positions + hierarchy/
  topology, not fit to a template) → predicted skin weights, via a GNN-
  based architecture operating directly on mesh graph structure, no
  shape-class assumption (unlike SMPL-template methods).
- Trained/eval on ModelsResource-RigNetv1: 2,703 rigged models (2,163
  train / 270 val / 270 test), preprocessed to 1K-5K verts per mesh via
  quadratic edge collapse (MeshLab) — i.e. designed for GAME-ASSET-SCALE
  meshes, not film-density.
- GPLv3 or commercial license (UMass tech transfer office). Community
  Blender add-ons exist (brignet by pKrime 2020, another by L-Medici 2021)
  — i.e. already has a Blender integration precedent to study for UX.
- Superseded-by-comparison: UniRig 2025 paper reports RigNet as the
  template-free baseline it beats; separate "Puppeteer" paper (2025,
  arXiv) benchmarks against BBW/GeoVoxel/RigNet as its three baselines —
  RigNet is now the standard ACADEMIC comparison point, not the SOTA.

### UniRig (SIGGRAPH 2025, Tsinghua + Tripo) — current SOTA, actively developed
- "One Model to Rig Them All" — unified autoregressive (GPT-like
  transformer) framework: Skeleton Tree Tokenization predicts a
  topologically-valid skeleton hierarchy as a token sequence; Bone-Point
  Cross-Attention then predicts per-vertex skin weights + bone attributes
  (e.g. physics stiffness) conditioned on the predicted skeleton.
- Numbers (arXiv 2504.12451 abstract): 215% improvement in rigging accuracy,
  194% improvement in motion accuracy vs prior SOTA on "challenging
  datasets." Trained on Rig-XL, a new 14,000+ rigged model dataset the
  paper also released, spanning categories from anime characters to
  "complex organic and inorganic structures."
- Beats named commercial competitors directly in their own qualitative
  figure: Tripo, Meshy, Anything World, Accurig — i.e. this is being
  benchmarked against shipping commercial auto-rig products, not just
  academic baselines. Table 1 in the paper explicitly notes Tripo is
  LIMITED to human+quadruped categories only — UniRig's pitch is category-
  generality.
- Successor already announced: SkinTokens (VAST-AI-Research, post-UniRig)
  unifies skeleton+skinning into ONE autoregressive sequence via learned
  discrete skin tokens, adds RL training + an "Efficient Skinning
  Compression Module" — claims 98-133% skinning-accuracy improvement and
  17-22% bone-prediction improvement OVER UniRig itself. Progressive open-
  source release (skeleton+skinning code/model out; some checkpoints
  pending as of this recon pass).
- Practical note: Python 3.11 + PyTorch + spconv + torch_scatter/cluster
  (CUDA-oriented dependency stack) — this is a TRAINING/research repo, not
  a lightweight runtime inference package; would need a separate,
  much-lighter inference-only path (likely ONNX/CoreML export) to embed in
  an M1-native Rust engine rather than shipping the training toolchain.

### Mixamo, Blender Rigify, Cascadeur — established non-ML baselines
- Not deep-dived this pass (time-boxed), carried from general knowledge:
  Mixamo = Adobe's free web auto-rigger, template-fit (human biped only),
  huge adoption because it's free+instant, but category-locked exactly
  like Tripo above. Rigify = Blender's rig-GENERATION system (metarigs →
  full FK/IK control rig), not a mesh→skeleton PREDICTOR — assumes you
  already placed/fit a metarig; different problem (rig authoring, not
  skeleton discovery). Cascadeur = ML-ASSISTED pose/animation tool (physics-
  aware autopose/interpolation), not a rigging tool per se — adjacent
  category, worth a separate recon pass if animation-assist tooling is in
  scope for CREATE.md's "puppeteering" pillar.

### Skinning weights — geometric (non-ML) methods
- Bounded Biharmonic Weights (BBW, Jacobson et al. SIGGRAPH 2011): solves a
  constrained biharmonic (4th-order) energy minimization over a
  TETRAHEDRALIZED volume bounded by the surface — requires the mesh be
  closed/tetrahedralizable, fails on open surfaces/triangle soups/non-
  watertight scans. Shipped in Adobe Character Animator; Pinocchio (Baran
  & Popović 2007, an earlier/simpler method) shipped in Blender.
- 2024 follow-up (arXiv 2406.00238, "Robust Biharmonic Skinning Using
  Geometric Fields") removes the tetrahedralization requirement entirely —
  mesh-FREE, Lagrangian/neural-field representation optimizing the same
  biharmonic energy via SGD, works on open surfaces, non-watertight scans,
  triangle soups, even a 30%-missing-faces test case ("Scorpion
  Randomized"). This is the CURRENT non-ML SOTA and directly solves BBW's
  worst practical failure mode (real production/scan meshes are rarely
  clean closed manifolds).
- Geodesic Voxel Binding (Dionne & de Lasa 2013, ships in Autodesk Maya):
  voxelize mesh, compute geodesic distance from each surface voxel to each
  bone, weight by distance — smooth weights at INTERACTIVE rates, no
  iteration/optimization at bind OR pose time, decouples weight assignment
  from distance computation so weights are editable live post-bind without
  recompute. This is "voxel heat diffusion"'s closest documented industry
  cousin (heat-diffusion-style geodesic propagation through a voxelized
  volume) — production-proven (Maya), not just a paper.
- Current comparison baselines in 2025 papers (per Puppeteer, arXiv):
  BBW, GeoVoxel (=GVB), and RigNet are the THREE standard baselines every
  new skinning-weight method benchmarks against — i.e. these three define
  the state of the art to beat as of this recon.

### Sucks verdicts — auto-rig
- RigNet: solid, has existing Blender add-on precedent to study, but
  ACADEMICALLY SUPERSEDED (used as the beat-baseline in 2025 papers) and
  GPLv3-encumbered (commercial license negotiation required for a
  closed/differently-licensed engine) — do not build on it directly.
- UniRig/SkinTokens: genuine current SOTA with numbers that beat shipping
  commercial products (Tripo/Meshy/Accurig) in the paper's own figures, but
  ships as a CUDA-training-stack repo, not an embeddable inference engine —
  the GAP to close for DreamForge is export-to-lightweight-inference
  (ONNX/CoreML/Metal Performance Shaders Graph), not the ML itself, which
  is genuinely ahead of hand-tuned geometric methods now.
- BBW/GeoVoxel: mature, well-understood, NO ML DEPENDENCY, and the 2024
  mesh-free biharmonic paper specifically fixes BBW's worst failure mode
  (non-watertight/scan meshes) — this is the pragmatic fallback: ship
  geometric auto-skinning (GeoVoxel-style geodesic-voxel binding, Maya-
  proven, interactive-rate, no training data needed) as v1, treat ML
  (UniRig-class) as a v2 quality upgrade once an inference path exists.

### M1/Rust feasibility — auto-rig
- Geometric methods (GeoVoxel/BBW-2024) are CPU/compute-shader math
  (voxelization + distance fields + sparse linear solve or field
  optimization) — directly portable to Rust/wgpu compute, no ML runtime
  dependency, no M1-specific blocker; this is the SAFE, buildable-now path
  and should be CREATE.md's v1 auto-rig story ("automatic always, editable
  after" doesn't require ML to be true on day one).
  Note: DreamForge already has virtualized/voxel geometry machinery
  (GEOMETRY.md hybrid poly/voxel/SDF) — a voxel-heat-diffusion-style
  skinning solver may be able to REUSE the same voxelization the sculpt/
  SDF pipeline already produces, rather than a separate offline step.
- ML methods (UniRig-class): would need either (a) a Core ML / MPS Graph
  export path (native M1 GPU inference, Apple's own ML stack, well-
  supported) — feasible but requires model conversion work not yet done
  by upstream, or (b) a small local transformer inference runtime in Rust
  (candle, burn) running the released Rig-XL-trained checkpoint — plausible
  given the model is described as compact enough for "inference time
  depends on bone count/complexity" (i.e. sub-second class, not a giant
  LLM) but unverified without hands-on testing of the actual checkpoint
  size/architecture. FLAG for hands-on spike before committing ML auto-rig
  to a release timeline.

## 5. NODE PROCEDURAL

### Houdini SOP — why it's powerful
- Two orthogonal design choices compound: (1) LAZY DAG EVALUATION — nodes
  "cook" (compute) only on demand when their output is actually needed for
  display/export; parameter changes mark downstream nodes dirty, cooking
  is deferred until requested, and only the AFFECTED subgraph re-cooks
  (explicit input/dependency tracking per node, not a full-graph re-eval).
  (2) ATTRIBUTES AS DATA — geometry is a database (GU_Detail: points/
  primitives/vertices/detail, each carrying arbitrary named typed
  attributes: @P, @N, @Cd, @age, @uv, custom user fields), and NODES
  OPERATE ON ATTRIBUTES GENERICALLY rather than on fixed hardcoded
  properties — an attribute wrangle (VEX snippet) can read/write ANY
  attribute by name, so the same generic node vocabulary (transform,
  group-by-attribute, attribute-wrangle, copy-to-points-driven-by-
  attribute) recombines into effectively unlimited specific behaviors
  without needing a bespoke node per use case.
- Practical compounding effect: because attributes flow through the WHOLE
  chain (not just geometry topology), a single generic node set (group/
  wrangle/transfer/blast/copy) becomes a full toolkit — e.g. "@age drives
  particle lifespan" and "@Cd drives a color ramp" are the SAME mechanism
  (a named per-point float feeding downstream logic), not two different
  systems. This data-generality is repeatedly cited (Artivoxa dev-guide
  series, 2026) as THE explanatory mechanism for why Houdini scales to
  arbitrarily complex production networks where node-count-limited systems
  don't.
- Attribute CLASS choice (point/primitive/vertex/detail) is a first-class
  performance decision exposed to the artist: point/primitive scale
  linearly with element count and are cache-friendly; vertex attributes
  (per-polygon-corner) balloon on dense topology (each corner duplicates
  data) and should be avoided unless the semantic genuinely needs per-
  corner distinctness (UV seams, split normals); detail attributes are
  near-free (one value for the whole geometry, e.g. frame number).
- Cooking is threaded/parallel within a node (VEX SIMD-friendly float/vector
  ops) but the DAG's dependency resolution across nodes is what enables
  Houdini's famous "isolate with a Cache SOP, iterate fast" workflow — you
  can freeze/cache any point in the chain and only re-cook downstream of an
  edit, which is the direct practical payoff of lazy DAG eval.

### Blender Geometry Nodes — design + published critique
- Landed originally (Blender 2.9x) as a straight modifier-stack-to-nodes
  port: ONE geometry socket carries the WHOLE mesh through the chain, no
  per-attribute dataflow — i.e. explicitly NOT the Houdini attribute-flow
  model at first. Blender's own dev blog (code.blender.org, Aug 2021,
  "Attributes and Fields") documents the team recognizing this as the
  system's "clear shortcoming": artists needed to operate directly on
  attributes and the initial design didn't allow it well.
- Resolved by adopting FIELDS (Aug 2021 nodes workshop, chosen over a
  competing "Expandable Geometry Socket" proposal after a week-long
  build-off of both prototypes): TWO separate flows coexist in one node
  tree — a DATA flow (geometry, left-to-right, "usually the geometry passed
  through and modified") and a FUNCTION flow (per-attribute expressions,
  evaluated as callbacks/references, closer to how Blender's SHADER node
  trees already worked). This is explicitly acknowledged in the dev blog
  as converging toward Houdini/Nuke's model ("If Houdini and Nuke work this
  way, it's for a reason... one connection per attribute is rather
  powerful") — i.e. Blender's own devs cite Houdini as the design target
  they were catching up to, not surpassing.
- Net critique from this recon: Blender Geometry Nodes is YOUNGER and was
  DESIGNED BACKWARDS from Houdini's (attribute-flow bolted on after an
  initial geometry-only design, rather than being the foundation from day
  one) — the Fields abstraction is real but adds conceptual overhead
  (artists must understand two flow types + when a field is "evaluated")
  that Houdini's from-birth attribute-as-data model doesn't impose. A
  r/Houdini community sentiment thread (Mar 2024) bluntly frames it as
  "not in the same ballpark" toolset-wise, independent of the fields fix.

### Open Rust node-graph engines — Blackjack is the direct precedent
- Blackjack (setzer22, github.com/setzer22/blackjack): a 3D procedural
  modeling app, 100% Rust, using egui (UI) + rend3/wgpu (render) + Lua
  (specifically Luau, Roblox's statically-typeable Lua dialect) for node
  SCRIPTING — each node's behavior is a Lua function operating on mesh
  data, not a hardcoded Rust match-arm, giving user-extensibility without
  recompiling.
- Mesh representation: HALFEDGE data structure, explicitly built INDEX-
  based rather than pointer-based (a known Rust-friendly pattern avoiding
  borrow-checker fights with graph-of-pointers structures) — direct
  evidence this class of problem (procedural mesh editing, adjacency
  queries) has an established idiomatic Rust solution.
- Subdivision: implemented Catmull-Clark via the halfedge structure,
  described by the author as "state-of-the-art" (referencing onrendering.
  com's halfedge Catmull-Clark paper/talk), CPU-parallelized via rayon,
  full implementation ~600 lines including comments — i.e. NOT a huge,
  scary subsystem; a small team (here: one person) implemented production-
  quality subdivision in a weekend-scale timeframe on top of the halfedge
  base. Author notes GPU acceleration was a known-available next step, not
  a blocker.
- UI layer: egui_node_graph(2) crate — MIT-licensed, semver-stable,
  "completely agnostic to graph semantics" (used for game logic, audio,
  dialog trees, shader graphs per its own docs, not sculpting-specific) —
  this is a directly reusable OFF-THE-SHELF Rust crate for the node-graph
  EDITOR UI half of CREATE.md's node-procedural mode; Blackjack itself is
  the reference for the MESH-PROCESSING half.
- Gap vs Houdini: Blackjack's node graph is a straightforward DAG (per repo
  description, no lazy lower-cook granularity or explicit attribute-class-
  as-performance-lever documented in this recon pass) — it demonstrates the
  RUST FEASIBILITY of node-based procedural meshing, not a full Houdini-
  parity SOP re-implementation. The lazy-DAG-eval + attribute-class-scoped
  performance model from Houdini would need to be DESIGNED IN, not copied
  from Blackjack as-is.

### Sucks verdicts — node procedural
- Houdini SOP: the correct target architecture (lazy DAG + attributes-as-
  data as ONE unified mechanism from the ground up) — no sucks-list item
  surfaced in this recon; the "sucks" is elsewhere (Houdini itself is not
  open, not a code source to lift, only a design to emulate).
- Blender Geometry Nodes: correct DESTINATION (Fields) but wrong ORIGIN
  (bolted onto a geometry-only design after the fact) — the lesson for
  DreamForge is to design attribute/field-flow as a day-one primitive
  (per Pascal's "spec-first" doctrine already in DREAMFORGE.md), not layer
  it in later like Blender had to.
- Blackjack: real, working, small-team Rust proof — but a DAG-only mesh-
  proc tool, not attribute/field-flow-aware; use its halfedge+index-based
  mesh core and egui_node_graph2 UI crate as BUILD BLOCKS, design the
  lazy-eval + attribute-class-scoped dataflow layer on top as DreamForge's
  own contribution (this is exactly the kind of "mini-Houdini" gap
  DREAMFORGE.md's pillar 9 calls for).

### M1/Rust feasibility — node procedural
- Full stack is already proven piecewise on Rust/wgpu/M1-class hardware:
  egui (cross-platform, wgpu-backed, works on Metal) for the graph UI;
  Blackjack's halfedge+rayon mesh core for CPU-side procedural mesh ops;
  Luau (or any embeddable scripting VM — Rhai is the more Rust-native
  alternative, unverified this pass) for user-authorable node logic without
  recompilation. No GPU-specific blocker identified — this domain is the
  LOWEST platform-risk of the five recon'd here; the real work is
  DESIGNING the lazy-eval/attribute-flow semantics (a software-architecture
  problem), not finding platform-capable primitives (already found).

## Cross-domain notes
- Recurring pattern: every domain has a "no-bake / no-manual-step" outlier
  that matches DreamForge doctrine harder than the industry-standard tool
  does — Dreams (sculpt, no retopo/UV break), Ptex (texture, no UV at all),
  Ministry of Flat (UV, zero user input), UniRig (rig, zero manual weight
  painting). None of these outliers are the CURRENT MARKET LEADER in their
  category (ZBrush/Substance/manual-UV/Mixamo-template still dominate
  usage) — the market leaders win on ECOSYSTEM/polish, not on matching the
  "no manual step" law. DreamForge's bet is explicitly that the outlier
  philosophy is correct and worth the extra R&D risk (consistent with
  pillar 9's "no bake-mesh concept... it just works").
- Three domains have zero-risk, buy-don't-build primitives ready NOW:
  auto-UV (xatlas, CPU-only, no-deps), node-graph UI (egui_node_graph2),
  mesh-proc core (Blackjack's halfedge+rayon pattern). Two domains carry
  genuine R&D risk requiring a hands-on spike before scheduling: paint's
  live-curvature-without-bake compute path, and auto-rig's ML-inference-on-
  M1 path (UniRig/SkinTokens checkpoint size + Rust/CoreML inference,
  unverified this pass).
