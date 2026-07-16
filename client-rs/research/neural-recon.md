# Neural render + learned physics recon — PARKED EVIDENCE (sonnet, 2026-07-16)

Status: evidence only. PHYSICS.md ON HOLD — Pascal's own physics pass first
(HANDOFF.md). Recon informs, Pascal rules.

## A. Neural rendering on Apple Silicon

### MetalFX
- Spatial + temporal scalers, create-once/encode-per-frame into MTLCommandBuffer.
  developer.apple.com/documentation/metalfx
- Quality mode ~40-50% perf gain @4K target, near-imperceptible loss;
  performance mode >2× but visible. iPhone15Pro spatial 720p→4K ≈ 8-15ms.
- wgpu interop EXISTS: `wgpu::hal::metal::Device::texture_from_raw` wraps raw
  MTLTexture → hand wgpu output to MetalFX (ObjC-only, no wgpu binding).

### Compute RT budgets (the hard numbers)
- M1 Metal inline RT (ChameleonRT, 720p): Sponza 20.1 MRay/s · San Miguel 11.7
  — vs RTX2070 DXR 757/362. willusher.io/graphics/2020/12/20/rt-dive-m1
- M2 frag-RT Sponza 25.2ms · M1 Pro 17.6ms · M3 12.7ms (first HW RT gen; ~2×
  M2→M3). nelari.us/post/metal-raytracing-performance
- wgpu: BLAS/TLAS builds exist on Metal backend; RT PIPELINES not implemented
  any backend (11-2025); Metal = inline ray-query anyway. gfx-rs/wgpu#8560/#9215
- ⇒ triangle-BVH RT on M1 is out by ~40×; occupancy-mip/voxel-proxy tracing
  (Teardown pattern) = the only M1-viable RT form. M3+/HW-RT = later slot.

### NRC / denoisers
- NRC (Müller 2021): update+query ≈ 2.6ms @1080p, fully-fused 6-layer×64 MLP.
  research.nvidia.com/labs/rtr/publication/muller2021nrc
- ★ Non-NVIDIA proof: SIGGRAPH Asia 2025 "NRC on Mobile GPU" — implemented in
  BREDA (Rust cross-platform framework, Traverse Research), fused MLP entirely
  in COMPUTE SHADERS (fp16), query 2-25× cheaper than path-traced equivalent.
  dl.acm.org/doi/10.1145/3757376.3771399 — direct existence proof for our path.
- SVGF ≈ 10ms/frame (heavy). OIDN 2.2+ has Metal backend on Apple GPUs (GPU
  compute, offline-grade). DLSS-RR proprietary, no ms figures.

### ANE / CoreML — NEGATIVE finding
- CoreML gives NO control over ANE scheduling; no per-frame bounded-latency
  API; MLX/llama.cpp skip ANE entirely (GPU/Metal); only private-framework
  reverse engineering reaches it directly. arxiv.org/html/2603.06728v1
- ⇒ KILLS the ANE-denoiser idea (nyari proposal, Kyouma turn): neural passes
  run as GPU compute MLPs in-frame (per Breda precedent), ANE not a render-
  loop organ.

## B. AI / learned physics

- GNS (Sanchez-Gonzalez ICML 2020): trains on thousands of particles,
  generalizes ~10× particles + thousands of steps; successor (geoelements
  2023): >165× vs parallel-CPU MPM for granular. arxiv.org/abs/2002.09405
- Holden subspace neural physics (Ubisoft SCA 2019): 300-5000× vs full sim,
  2700 FPS vs 0.5 FPS cloth example; NO confirmed shipped title.
  cim.mcgill.ca/~derek/files/Deep-Cloth-paper.pdf
- tempoGAN = offline super-res, not realtime. NeuralVDB = compression 10-100×;
  follow-up states online inference random access TOO SLOW for realtime —
  decode-to-VDB-first workflow. arxiv.org/html/2504.04564
- Hybrid neural-operator+FEM domain decomposition exists (≤3% error, offline
  engineering only) — NO real-time game precedent found for far-field
  learned/near-field exact split.
- Neural collision (arXiv 2202.02309): MLP-SDF beats BVH only under ~300 query
  points CPU / ~10k GPU — niche.

## Read-through (nyari, non-binding)
- Render doctrine survives contact with evidence, minus ANE: internal-res +
  MetalFX temporal (interop via texture_from_raw) · RT = compute tracing of
  occupancy mips only · NRC-class GI = proven buildable in Rust+compute
  (Breda) with a 6×64 fp16 fused MLP · denoise = cheap temporal + learned-
  later, all GPU compute.
- Learned physics: strongest published wins = cloth/soft (Holden) + granular
  (GNS) — exactly our far-field/fluid surrogate slots; but zero shipped-game
  precedent → treat as staged experiments behind the exact solver, never a
  dependency. Fluids: coarse grid stays primary; neural detail = research
  milestone, not contract.
