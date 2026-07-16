# Metal 4 neural rendering recon — Apple 2025-26 stack (for NEURAL.md update)

Target: M1 MacBook, 16GB unified, Rust/wgpu engine w/ Metal-native fast paths
behind capability traits. Question: does 2025-26 Apple hardware give us a
per-frame Neural Engine (ANE) path, or is ANE still CoreML-batch-only?
Web recon via brave-search, 2026-07-16. Primary sources = Apple Developer
Documentation (fetched via `developer.apple.com/tutorials/data/.../*.md` —
the JS-rendered doc pages return real markdown at this path) + WWDC25
session transcripts. Secondary = dev blogs/press, marked as such.

## TL;DR (answers to the 6 questions)

1. **MTLTensor + MTL4MachineLearningCommandEncoder are real, shipped APIs**
   (Xcode 26 / macOS 26 Tahoe). Full CoreML networks run ON the GPU
   command-buffer timeline, synchronized with render/compute via barriers.
2. **Chip floor: Apple M1 / A14 Bionic** for Metal 4 core API (confirmed
   multiple sources). macOS requirement: **macOS 26 (Tahoe)** / iOS 26 /
   Xcode 26 minimum (Apple header: `API_AVAILABLE(macos(26.0), ios(26.0))`).
   Hardware ray tracing (and RT-dependent MetalFX denoised upscaler use)
   needs **M3/A17 Pro or later** — separate gate from the ML pass itself.
3. **MetalFX 2025-26 adds Frame Interpolation + a denoised upscaler for RT.**
   Both ship in the same macOS 26.0 header availability window as core
   Metal 4 (no extra chip gate found in headers beyond the M1/A14 floor;
   RT denoising is moot without RT hardware, i.e. practically M3+).
4. **YES — confirmed, official, in Apple's own docs**: `MTL4MachineLearningCommandEncoder`
   dispatches to **either the GPU or the Apple Neural Engine**, chosen
   automatically by the system, per model, ON the GPU command-buffer
   timeline. This is the per-frame ANE path that did not exist before
   Metal 4 / macOS 26. Direct raw ANE programming (no CoreML wrapper) is
   still not a public API — but going through a MTL4-encoded CoreML model
   IS now a legitimate, synchronizable, in-frame path.
5. Cyberpunk 2077 (Mac App Store port, native, ships MetalFX + hardware RT
   on M3+) is the flagship example. An M1 Max data point exists (via
   CrossOver/GPTK, not the native Metal 4 build) hitting ~55-60 FPS with
   MetalFX Performance + frame interpolation.
6. **wgpu/naga: no tensor/ML surface, confirmed.** wgpu's Metal backend is
   only just touching MTL4CommandBuffer semantics (retain-refs behavior,
   late 2025 issue). No MTLTensor, no MTL4MachineLearningCommandEncoder,
   no cooperative_tensor MSL emission anywhere in gfx-rs/wgpu or naga.
   wgpu is a WebGPU-shaped API; it has no tensor resource concept at all.
   → Conclusion holds: any ANE/MTLTensor/MTL4ML path must be a **Metal-native
   package behind a capability trait**, invoked directly via Metal (not
   wgpu), gated at runtime by `MTL4CommandQueue` support + macOS 26+.

---

## 1. Metal 4 machine learning — API shape (WWDC25 "Combine Metal 4 machine
   learning and graphics", session 262, + "Machine learning passes" doc)

Source: https://developer.apple.com/videos/play/wwdc2025/262/ (full
transcript pulled) and https://developer.apple.com/tutorials/data/documentation/metal/machine-learning-passes.md

- **MTLTensor** (new resource type, peer to MTLBuffer/MTLTexture):
  multi-dimensional container, described by rank + per-rank extents;
  `dataType` (e.g. int8, fp16); usage flags `MTLTensorUsageMachineLearning`
  (for the ML encoder) / `MTLTensorUsageCompute` / `MTLTensorUsageRender`
  (combinable, for use inside your own shaders). Created from `MTLDevice`
  (best perf) or from an `MTLBuffer` (view). `protocol MTLTensor : MTLResource`.
- **MTL4MachineLearningCommandEncoder**: a new encoder type alongside
  render/compute, created from an `MTL4CommandBuffer`. Workflow: convert a
  Core ML model into a **Metal ML package** at build time with
  `metal-package-builder` (bundled in Xcode 26+) → Xcode compiles it into a
  Metal library → app creates an `MTL4MachineLearningPipelineState` from
  that library → encoder binds an `MTLHeap` (intermediates/scratch memory,
  reused across dispatches instead of alloc/free per call) + input/output
  `MTLTensor`s → `dispatchNetworkWithIntermediatesHeap`. Whole network runs
  as ONE dispatch call on the GPU timeline, interleaved with render/compute
  in the SAME command buffer, no CPU round-trip.
  - Note (Apple docs): ML encoders **run** existing Core ML models; they
    can't build new networks or edit layers at runtime — model authoring
    stays at build time via coremltools/metal-package-builder.
- **Synchronization**: standard Metal 4 barriers/`MTLFences`; new
  `MTLStageMachineLearning` (barrier scope tag) / `MTLStages.machineLearning`
  identifies ML work so you can barrier render↔ML dependencies explicitly
  (e.g. render pass writes depth+normals → barrier → ML pass reads them →
  barrier → render pass consumes ML output).
- **Shader ML** (MSL-level, separate from the encoder path): embed small
  ML ops **inside your own shaders** — matmul, convolution, reduction —
  via new MSL 4 tensor types:
  - `tensor_handle` — CPU-created MTLTensor handle
  - `tensor_inline` — GPU-side view into a tensor or buffer, defined in-shader
  - `cooperative_tensor` — a tensor whose elements are distributed across
    the threads that operate on it (thread-private/threadgroup-private
    memory, not device memory) — this IS Apple's version of "cooperative
    matrix/tensor" extensions (cf. Vulkan `VK_KHR_cooperative_matrix`).
  - `tensor_offset` tag lets you slice a tensor on the GPU without a new
    descriptor.
  - Works in ANY GPU stage (vertex/fragment/compute/ML), not just compute.
- **Worked example from the session**: neural ambient occlusion — depth +
  view-space normals populated by a render pass, `MTL4MachineLearningCommandEncoder`
  dispatches a small **fully convolutional network** to predict per-pixel
  occlusion while other render work proceeds in parallel on the GPU
  timeline, barrier-gated before compositing.
- **Neural material compression** (motivating example, cited number):
  "compresses material sets to **50% of the block-compressed footprint**"
  vs. e.g. BC/ASTC — decompressed in-shader via Shader ML instead of a
  traditional texture sample, so the disk/VRAM saving lands without a
  separate decompress-to-buffer pass.
- **Debugging**: Xcode 26 Metal Debugger can inspect MTLTensor contents
  directly and step through MTL4MachineLearningCommandEncoder dispatches
  like any other GPU call (per session 262's second half, Scott Moyers).

## 2. Chip / OS support matrix

- **Metal 4 core API floor**: Apple **M1** (Mac) and **A14 Bionic**
  (iPhone/iPad) or later — repeated consistently across dev.to WWDC recap,
  9to5Mac, and lowendmac.com's Metal-history piece, all citing the "Discover
  Metal 4" WWDC25 session (205) transcript language: *"Metal 4 is... supported
  by devices equipped with the Apple M1 and later, as well as the A14 Bionic
  and later."* — https://developer.apple.com/videos/play/wwdc2025/205/
- **OS floor**: **macOS 26 (Tahoe)**, iOS/iPadOS 26, Xcode 26. Confirmed
  directly from Apple SDK header diffs (Xcode 26.0 beta vs 16.4):
  `API_AVAILABLE(macos(26.0), ios(26.0))` on `MTL4FXFrameInterpolator`,
  `MTL4FXSpatialScaler`, `MTL4FXTemporalDenoisedScaler` — via
  https://github.com/dotnet/macios/wiki/MetalFX-iOS-xcode26.0-b1 (raw
  Apple header diff, high-confidence primary artifact).
- macOS 26 Tahoe itself installs on every Apple Silicon Mac from the
  **M1 (2020)** onward, plus a handful of late Intel Macs (2019-2020) that
  do NOT get Metal 4 (Metal 4 = Apple Silicon only per Apple's Platform
  State of the Union, cited by lowendmac.com). Apple's official compat
  list: https://support.apple.com/en-us/122867
  — so **your M1 MacBook target is inside both the OS and the Metal 4
  hardware floor.**
- **Hardware ray tracing** (separate gate, NOT required for MTL4ML/MTLTensor):
  needs **A17 Pro / M3 or later** (dedicated RT hardware, announced with
  A17 Pro Sept 2023 — https://appleinsider.com/articles/23/11/10/what-apples-three-gpu-enhancements-in-a17-pro-and-m3-actually-do
  covers Dynamic Caching + HW ray tracing + HW mesh shading as the M3/A17
  Pro trio). Cyberpunk 2077's Mac benchmarks confirm this at the app level:
  **"only Macs with M3 or newer chips support the game's ray tracing
  features"** — Tom's Guide, M1-M4 Mac benchmark article (2025-07-20),
  https://www.tomsguide.com/gaming/we-benchmarked-cyberpunk-2077-on-mac-heres-how-well-it-runs-on-m1-m4-macs-vs-windows
  — so **MetalFX's *denoised upscaler for ray tracing* is only meaningful
  on M3+**; the MTLTensor/ML-encoder path itself has no such restriction.
- MTLTensor/MTL4MachineLearningCommandEncoder carry **no chip gate beyond
  the Metal 4 floor (M1/A14)** in anything found — Apple's docs and the
  WWDC session frame it as a Metal 4 core-API feature, not an RT-tier
  feature. UNCONFIRMED whether the automatic GPU/ANE scheduling picks ANE
  equally well on M1's 1st-gen-Apple-Silicon 16-core ANE (11 TOPS-class,
  2020) vs. later chips — Apple's docs don't publish a per-chip ANE
  eligibility table for this API; treat scheduling-to-ANE as "available,
  perf/eligibility unverified on M1" until measured.

## 3. MetalFX 2025-26 additions

Source: WWDC25 "Discover Metal 4" (205) + "Render complex scenes with
MetalFX" (211) transcripts, https://developer.apple.com/videos/play/wwdc2025/211/,
plus Apple doc fetches for the MetalFX framework overview
(https://developer.apple.com/tutorials/data/documentation/metalfx.md).

- **MetalFX Frame Interpolation** (new): "generate intermediate frames in
  much less time than it would take to render each frame from scratch."
  API: `MTLFXFrameInterpolatorDescriptor` → `MTLFXFrameInterpolator` (older
  `MTLCommandBuffer` path) and the Metal-4-native
  `MTL4FXFrameInterpolator` protocol (`encodeToCommandBuffer:` on an
  `MTL4CommandBuffer`) — both `API_AVAILABLE(macos(26.0), ios(26.0))`.
  Conceptually equivalent to DLSS Frame Generation / FSR3 Frame Gen: reads
  two rendered frames, generates one interpolated frame between them.
- **MetalFX denoised upscaler for ray tracing** (new): "the new MetalFX
  API enhances real-time ray-tracing rendering pipelines by integrating
  denoising directly into the upscaling process" — lets a game cast FEWER
  rays and get a clean image out of the combined denoise+upscale step,
  Apple's answer to DLSS Ray Reconstruction. Header type:
  `MTL4FXTemporalDenoisedScaler` (also macOS 26.0 floor per the same
  header diff). Session 211 frames it explicitly: *"ray tracing
  enhancements, and the new MetalFX denoised upscaler, to easily scale, by
  reducing the required ray count in your game."*
- **Existing MetalFX temporal upscaler improvements** (2025, not new
  feature but new capability): now supports **dynamically-sized inputs
  per frame** (previously fixed-size input required) — lets a game lower
  internal resolution further on complex frames without re-creating the
  scaler; Apple recommends **max 2x scale factor** for best quality; new
  **exposure debugger** tool (`MTLFX_EXPOSURE_TOOL_ENABLED` env var,
  overlays a grey checkerboard to visually verify the `exposure` input
  parameter is tonemapper-matched).
- No published hard numbers (ms/frame, % gain) for frame interpolation or
  denoised-upscaler specifically were found in the WWDC transcripts pulled
  — Apple describes behavior/API shape, not a benchmark table. Real-world
  numbers exist only via 3rd-party game benchmarks (§5). MARK AS
  UNCONFIRMED: any specific "%speedup" claim for MetalFX frame
  interpolation/RT-denoise beyond what's inferred from Cyberpunk 2077
  end-to-end benchmarks.

## 4. ANE access truth, 2026

**Old assumption (per current NEURAL.md draft): "ANE ruled OUT — no
per-frame API; CoreML gives no scheduling control." This is now
OUTDATED as of Metal 4 / macOS 26.** Direct quote, Apple's official docs,
"Machine learning passes" page (fetched verbatim,
https://developer.apple.com/tutorials/data/documentation/metal/machine-learning-passes.md,
retrieved 2026-07-16):

> "The system automatically chooses an inference engine, such as a
> device's GPU or Apple Neural Engine (ANE) for each machine learning
> model. The GPU can run additional, independent render or compute work
> with the GPU when the system chooses to run a model on the ANE."

This is stated as a property of `MTL4MachineLearningCommandEncoder` itself
— i.e. **the automatic GPU/ANE choice happens for a model dispatched IN
THE SAME COMMAND BUFFER as your render/compute work**, with the GPU free
to keep doing independent render/compute work while a model runs on ANE.
That is a genuine per-frame, synchronizable ANE path that did not exist
pre-Metal-4 — previously (confirmed via Stack Overflow +
developer.apple.com/forums, both current in 2026): *"You can only use the
Neural Engine through Core ML... no public framework for programming the
ANE"* and CoreML's engine choice was an opaque, un-synchronized, CPU-side
black box (dispatch a prediction, await a callback, no barrier/fence
integration with your Metal command stream).

**What did NOT change**: there is still no raw/direct ANE ISA access.
Apple has not published `_ANEClient`-equivalent public APIs. The only
sanctioned way to touch ANE remains **via a compiled Core ML model**
— Metal 4 just moved the CoreML-model-as-a-whole into the GPU command
buffer's scheduling domain instead of requiring a separate CPU-driven
CoreML call outside the frame. Confirmed still-true via a **2026 dev
forum thread** (`developer.apple.com/forums/thread/833036`, "Running ML
Models on software and hardware stack layer" — June 2026): a developer
asks *"Are there APIs or plans to provide API and language to access ANE
layer?"* — i.e. even after Metal 4 shipped, direct ANE programming outside
CoreML/MTL4ML is still an open ask, unanswered by Apple as of mid-2026.

**Reverse-engineering evidence (informal, not a public API — cite for
completeness, not as a plan)**: independent research (maderix + Claude
Opus write-up, March 2026, https://maderix.substack.com/p/inside-the-m4-apple-neural-engine
and coverage at https://rits.shanghai.nyu.edu/ai/reverse-engineering-apples-neural-engine-to-train-transformers-on-m4/)
reverse-engineered `AppleNeuralEngine.framework`'s private `_ANEClient` on
an **M4** and got raw compile→load→evaluate access (and even ANE
*training*, 9.3ms/step, 11.2% ANE util, 1.78 TFLOPS sustained) bypassing
CoreML entirely, using IOSurface-based zero-copy I/O shared with the GPU
texture path. This is **private API, unsupported, App-Store-hostile, and
UNCONFIRMED to exist/behave identically on M1** (M1's ANE is a different,
earlier generation — A14-class, 11-16 TOPS vs. M4's 38 TOPS H16G) — listed
here only so the option is documented, not recommended as a build target.

**Verdict for question 4**: YES, there is now a real, official, per-frame
ANE path (`MTL4MachineLearningCommandEncoder`, system-chosen GPU/ANE,
synchronized via `MTLStages.machineLearning` barriers) — Pascal's "we find
a way" instruction is satisfiable via Metal 4, not via a private/hacked
path. Chip-level ANE eligibility/performance for this specific automatic
scheduling on **M1 specifically** is UNCONFIRMED (no Apple-published
per-chip table; would need to be measured on real M1 hardware once
Xcode 26 + a Metal ML package is in hand).

## 5. Games/engines shipping Metal 4 neural features

- **Cyberpunk 2077** (CD Projekt Red) — the flagship, repeatedly cited by
  Apple itself in WWDC25 sessions 205/211 as the proof case for Metal 4 +
  MetalFX. Native Mac App Store release, July 17 2025
  (`https://www.tomsguide.com/gaming/we-benchmarked-cyberpunk-2077-on-mac-heres-how-well-it-runs-on-m1-m4-macs-vs-windows`,
  Digital Foundry review `https://www.digitalfoundry.net/articles/digitalfoundry-2025-cyberpunk-2077-apple-mac-review-an-impressive-thoughtful-port-from-cd-projekt-red`):
  - Requires **M-series + 16GB unified minimum** (no Intel, no 8GB
    configs). MetalFX temporal upscaler available on all supported chips;
    **ray tracing + RT-denoised-upscaler restricted to M3/newer**.
  - Digital Foundry (M4 Max MBP, M4 Mac Mini, M3 Ultra Studio, tested on
    macOS 15.5 + peeked at 26 beta3): MetalFX Quality-preset scaling
    numbers "line up closely with Nvidia's DLSS presets"; MetalFX
    Performance mode ≈ **+130% FPS vs native 4K+TAA**; dynamic-res range at
    1440p floor/ceiling ≈ 720p→1152p internal.
  - **M1-class data point (UNCONFIRMED as the *native* Metal 4 path)**:
    YouTuber "Blendlogic Tech" ran Cyberpunk 2077 on a **MacBook Pro M1
    Max, 32-core GPU, 64GB unified, macOS 26 Tahoe beta**, via **CrossOver**
    (a Windows-compat layer using D3DMetal, NOT the native Mac App Store
    build) and reported **55-60 FPS at MetalFX Performance, ~45 FPS at
    MetalFX Quality**, with frame interpolation enabled — covered by
    Notebookcheck (2025-06-11): https://www.notebookcheck.net/YouTuber-tests-macOS-26-Tahoe-gaming-update-as-Cyberpunk-2077-hits-60-FPS-on-MacBook-Pro-M1-Max-with-MetalFX.1034516.0.html
    — flag this as a real M1-class number for the OVERALL upscale+frame-gen
    stack, but the interpolation call may be routed through D3DMetal's
    DX12→Metal translation rather than a first-party MetalFX Frame
    Interpolator call — attribution to the exact API is UNCONFIRMED.
  - **Community benchmark aggregate** (ComputerBase, via Tom's Hardware,
    2025-08-02): M4 Max 40-core GPU, MetalFX Balanced, 1920x1200 Medium
    preset → **132.35 FPS** average; Ultra preset → **96.69 FPS**. No M1
    rows published in the excerpt pulled — M-series scaling curve exists
    but M1-specific Ultra/RT numbers UNCONFIRMED from this source.
- No other shipping title found (in this recon pass) that specifically
  uses `MTL4MachineLearningCommandEncoder` / neural material compression /
  neural ambient occlusion in production — those are WWDC25 sample-code
  and forum-discussion territory as of mid-2026, not yet a cited shipped
  feature in any reviewed game. UNCONFIRMED / not found: any published
  M1-class benchmark for the ML-encoder-specific features (material
  compression, neural AO) — these remain demo-level per the session 262
  transcript, no shipped-game citation located.

## 6. wgpu/naga reachability

**Confirmed: no path.** Checked gfx-rs/wgpu issues/PRs and crates.io naga
page directly:
- wgpu's Metal backend (`wgpu-hal::metal`) is only beginning to touch
  Metal-4-shaped semantics at the **command-buffer lifecycle** level — e.g.
  issue #8747 (Dec 2025, https://github.com/gfx-rs/wgpu/issues/8747)
  discusses turning off `retain_command_buffer_references` because
  *"`MTL4CommandBuffer` never keeps strong references... and with Metal 4,
  it won't be an option"* — i.e. wgpu is tracking Metal 4's resource-
  retention model as a future constraint, not yet adopting `MTL4CommandQueue`/
  `MTL4CommandBuffer` as its actual submission path.
- No occurrence found of `MTLTensor`, `MTL4MachineLearningCommandEncoder`,
  `cooperative_tensor`, or any ML/tensor concept anywhere in gfx-rs/wgpu or
  naga's tracked issues/releases/crate docs. wgpu (WebGPU) has **no tensor
  resource type in its object model at all** — buffers and textures only —
  so there is no natural home for MTLTensor even at the API-design level;
  it would require a wgpu-side extension/feature that doesn't exist and
  isn't proposed.
- `metal-rs` (the older, now-deprecated Rust Metal binding wgpu historically
  used) and its successor `objc2-metal` are low-level FFI bindings — they
  *could* technically expose MTL4MachineLearningCommandEncoder/MTLTensor
  if someone binds them, but no such binding was found as of this recon
  (checked crates.io naga page + gfx-rs GitHub search results returned).
  UNCONFIRMED/not verified in depth: whether `objc2-metal` (the actively
  maintained binding wgpu is migrating to per PR 5641) has audited
  MTLTensor/MTL4ML bindings today — worth a follow-up `cargo doc` check
  against the actual crate before implementation, but nothing surfaced in
  web recon suggesting it's further along than "not yet."

**Conclusion / recommended shape**: confirmed — build the neural/ANE path
as a **Metal-native package, behind a capability trait**, invoked via
direct Metal (objc2-metal or a small first-party FFI shim), NOT via wgpu.
Runtime-detect Metal 4 support (`MTL4CommandQueue` creation succeeds) the
same way Apple's own sample code does — fall back to the existing GPU
compute-MLP path (already the documented NEURAL.md plan: "fp16, subgroup
ops") on non-Metal backends or pre-Metal-4 systems. The MTL4ML/MTLTensor/
ANE-dispatch path is strictly an ADDITIVE fast path on macOS 26+ /
M1+ Metal, matching the engine's existing "capability traits, no
Metal-only load-bearing pieces" rule (DREAMFORGE.md pillar 7).

---

## Sources (primary, fetched directly)

- WWDC25 "Combine Metal 4 machine learning and graphics" (session 262) —
  full transcript: https://developer.apple.com/videos/play/wwdc2025/262/
- WWDC25 "Discover Metal 4" (session 205) — transcript excerpt:
  https://developer.apple.com/videos/play/wwdc2025/205/
- WWDC25 "Render complex scenes with MetalFX" (session 211) — transcript
  excerpt: https://developer.apple.com/videos/play/wwdc2025/211/
- Apple docs, "Machine learning passes" (full text via the tutorials/data
  markdown endpoint): https://developer.apple.com/tutorials/data/documentation/metal/machine-learning-passes.md
- Apple docs, "Understanding the Metal 4 core API" (full text):
  https://developer.apple.com/tutorials/data/documentation/metal/understanding-the-metal-4-core-api.md
- Apple docs, `MTLTensor`, `MetalFX` overview, `MTLFXFrameInterpolatorDescriptor`
  (full text) via same tutorials/data pattern.
- Apple SDK header diff (Xcode 26.0 beta), MTL4FXFrameInterpolator /
  MTL4FXSpatialScaler / MTL4FXTemporalDenoisedScaler `API_AVAILABLE` tags:
  https://github.com/dotnet/macios/wiki/MetalFX-iOS-xcode26.0-b1
- Apple, macOS Tahoe 26 compatible Macs: https://support.apple.com/en-us/122867
- AppleInsider, A17 Pro/M3 GPU features (HW ray tracing origin):
  https://appleinsider.com/articles/23/11/10/what-apples-three-gpu-enhancements-in-a17-pro-and-m3-actually-do
- Tom's Guide, Cyberpunk 2077 M1-M4 Mac benchmark (RT = M3+ only, 16GB min):
  https://www.tomsguide.com/gaming/we-benchmarked-cyberpunk-2077-on-mac-heres-how-well-it-runs-on-m1-m4-macs-vs-windows
- Digital Foundry, Cyberpunk 2077 Mac review (MetalFX numbers):
  https://www.digitalfoundry.net/articles/digitalfoundry-2025-cyberpunk-2077-apple-mac-review-an-impressive-thoughtful-port-from-cd-projekt-red
- Notebookcheck, Cyberpunk 2077 on M1 Max via CrossOver + MetalFX/macOS 26
  beta: https://www.notebookcheck.net/YouTuber-tests-macOS-26-Tahoe-gaming-update-as-Cyberpunk-2077-hits-60-FPS-on-MacBook-Pro-M1-Max-with-MetalFX.1034516.0.html
- Tom's Hardware, ComputerBase community Cyberpunk 2077 Mac benchmark table:
  https://www.tomshardware.com/video-games/pc-gaming/cyberpunk-2077-mac-benchmarks-show-most-apple-silicon-can-run-the-game-at-over-30-fps-on-medium-settings-results-vary-from-a-smooth-130-fps-to-a-cinematic-24-fps
- Apple Developer Forums, "Running ML Models on software and hardware
  stack layer" (June 2026, confirms no direct ANE API exists post-Metal 4):
  https://developer.apple.com/forums/thread/833036
- Stack Overflow, "How to leverage the Neural Engine... as a developer?"
  (pre-Metal-4 baseline: CoreML-only): https://stackoverflow.com/questions/69983492/how-to-leverage-the-neural-engine-on-apple-silicon-m1-processors-as-a-developer
- maderix (+ Claude Opus 4.6), "Inside the M4 Apple Neural Engine, Part 1:
  Reverse Engineering" (private-API ANE access, M4-specific, informational
  only): https://maderix.substack.com/p/inside-the-m4-apple-neural-engine
- gfx-rs/wgpu issue #8747 (Metal 4 command-buffer retention tracking):
  https://github.com/gfx-rs/wgpu/issues/8747

## Secondary / press sources (context, not primary evidence)

- 9to5Mac, "Metal 4: Two new features that will make a difference for Mac
  gaming": https://9to5mac.com/2025/06/18/metal-4-two-new-features-that-will-make-a-difference-for-mac-gaming/
- blakecrosley.com, "Metal 4 Essentials" (good secondary summary,
  footnotes trace back to the same Apple docs quoted directly above):
  https://blakecrosley.com/blog/metal-4-essentials
- lowendmac.com, "Metal 4: An overview" (chip-floor + Apple-Silicon-only
  framing, citing Apple's Platform State of the Union):
  https://lowendmac.com/2025/metal-4-an-overview/
- dev.to (arshtechpro), WWDC 2025 Discover Metal 4 recap (chip floor
  restated): https://dev.to/arshtechpro/wwdc-2025-discover-metal-4-23f2
