# NEURAL — DreamForge neural performance ledger (DRAFT, 2026-07-16)

Target it serves (Pascal, restated 07-16): 60 FPS · M1 · 16 GB unified ·
the ONE traced lighting system always on — "no such thing as ray tracing
on or off"; neural = INTERNAL detail levels (denoiser/upscaler/cache
quality), never a toggle of the transport. Evidence: research/neural-recon
.md (+ gi/metal recons). Build order: LATER (Pascal) — this doc = the
write-down of what it buys, so budgets assume it correctly.

## Law
- The path integrator is truth. Neural components are VARIANCE REDUCTION
  and RECONSTRUCTION — they converge to (or reconstruct toward) the traced
  result, never replace the transport model.
- Physics: near-field / gameplay-critical = EXACT solver, always. Neural
  surrogates serve far-field, decorative, and fluid-detail tiers — every
  surrogate hot-swappable for the exact path (truth-checkable, testable).
  "Hallucination that looks like simulation" (Pascal) is admitted exactly
  where a wrong guess cannot change an outcome that matters.
- Neural execution, REVISED 07-16 (Pascal: "we find a way" — he was right;
  evidence: research/metal4-neural-recon.md): METAL 4 (macOS 26, M1+ floor
  confirmed via SDK headers) ships MTLTensor + MTL4MachineLearningCommandEncoder
  — runs networks IN the GPU command timeline, auto-dispatching GPU-or-ANE
  per model with machineLearning-stage barriers. A real per-frame ANE path.
  Placement: portable baseline = wgpu compute MLPs (fp16, subgroups — wgpu
  has NO tensor surface, confirmed); Metal-native fast path = ML-encoder
  package behind a capability trait (pillar 7 shape), models eligible for
  ANE offload = denoiser/upscaler/radiance-cache/surrogates — freeing GPU
  ALU for path tracing. MetalFX frame interpolation + RT-denoised upscaler
  = same macOS 26 floor (RT-denoised needs M3+ — triangle-RT gate, not
  ours). Requirement: Pascal's Mac on macOS 26 Tahoe for the fast path.
  UNCONFIRMED (flagged): M1 ANE per-frame latency under the encoder —
  first Metal-native spike measures it before anything depends on it.

## Render ledger (published numbers → our expected gains)
| Component | Evidence | Gain |
|---|---|---|
| Internal-res dial + temporal upscale | MetalFX: ~40-50% quality mode, >2× performance mode; wgpu interop exists (texture_from_raw) | THE biggest multiplier: path tracing at ~¼–½ native pixels ⇒ 2–4× ray budget back |
| Learned/temporal denoiser | SVGF ≈10ms baseline (too fat — ours must beat); DLSS-RR = proprietary proof learned>hand-tuned | 1–2 spp presents like ~10× spp; makes low-spp PT shippable |
| Neural radiance cache (NRC-class) | Müller 2021: ~2.6ms @1080p update+query, 6×64 fp16 fused MLP; ★ reimplemented in RUST compute shaders on mobile GPUs (Breda, SIGGRAPH Asia 2025), query 2–25× cheaper than tracing the paths | Long-bounce GI nearly free after 1st bounce; kills fireflies; the "remembers light" network |
| ReSTIR (not neural, same slot) | 9.3–166× MSE win at 1 spp | Infinite lights at fixed budget |
Combined M1@60 equation: ~1080p internal · 1-2 spp · ReSTIR · cache ·
denoise · upscale to native — every stage individually published-proven;
the composition is ours to prove per milestone (Xcode limiter captures).

## Physics ledger
| Component | Evidence | Gain | Tier |
|---|---|---|---|
| Subspace neural dynamics (Holden 2019) | 300–5,000× vs full sim; 2700 FPS vs 0.5 FPS cloth | Pascal's "1000%" is conservative | cloth/soft decorative + far-field |
| Graph-network simulators (GNS 2020→geoelements 2023) | >165× vs parallel-CPU MPM granular; generalizes ~10× particle counts | many-object far-field, debris fields | far-field |
| Coarse-sim + neural detail (fluids) | tempoGAN = offline super-res; NeuralVDB inference too slow realtime (decode-first) | fluid DETAIL layer = research milestone, coarse SPH/grid stays primary | detail tier |
| Neural collision | MLP-SDF wins only <~10k queries GPU | niche; not load-bearing | targeted |
Honesty line (unchanged): ZERO shipped-game precedent for learned sim in
the loop — we would be first. Staged experiments BEHIND the exact solver,
never a dependency; promotion requires side-by-side truth comparison.

## Memory note (16 GB unified)
MLPs are tiny (6×64 fp16 ≈ KBs); training buffers ≈ MBs. Neural layer is
compute-bound, not memory-bound — memory budget stays owned by VT pages +
geometry pages + voxel volumes (unified memory = zero-copy between sim and
render, the M1's actual gift).

## Staging (build later — order fixed now)
NR1 temporal upscaler (own, cross-platform) + MetalFX trait on Metal
NR2 denoiser: temporal+spatial compute → learned variant when NR1 stable
NR3 radiance-cache MLP (Breda-pattern fused fp16 compute; NRC numbers)
NR4 physics surrogates: cloth/debris far-field A/B vs exact solver;
    fluid neural-detail research spike
Each gated: same scene, neural on/off, frame-time + image/physics-error
metrics on the MacBook. No gate, no promotion.
