# Apple Metal perf recommendations — PARKED EVIDENCE (sonnet, 2026-07-16)

Status: evidence; distilled appendix lives in RENDER.md §8. Cross-platform
law stands: portable wisdom vs trait-gated fast paths.

## Apple's doctrine (TBDR)
- Headline win: single-pass deferred — G-buffer lives in TILE MEMORY,
  lighting reads it in-pass (imageblocks/raster order groups/programmable
  blending). Fragment-stage memory barriers = "very expensive... flush tile
  memory" (WWDC20 10632). Shipped example: Afterpulse (WWDC19 606).
- Memoryless storage for transient targets + MSAA (no resolve traffic);
  load=clear/dontCare, store=dontCare for anything not read later.
- Never sample current depth/stencil in-pass on Apple silicon (WWDC20 10631).
- Storage modes: Shared (CPU↔GPU, UMA zero-copy) vs Private (GPU-only,
  compression paths); Managed = legacy non-UMA concept, avoid.

## Shader/compute doctrine
- fp16 AGGRESSIVELY: dedicated fp16 ALU subunit (own limiter in M3 profiler);
  0.84-cycle dependency penalty for 32-bit regs (metal-benchmarks); Apple
  explicitly recommends FP16 math.
- SIMD width 32 on M1 (threadExecutionWidth) → threadgroups in multiples
  of 32. Threadgroup memory trades against occupancy (tech talk 10580).
- AVOID device atomics (WWDC20 10603: "avoid device atomics and register
  spills"); Apple GPUs = 32-BIT ATOMICS ONLY, no 64-bit, no texture atomics
  (the Nanite-on-Mac wall, again).
- Function constants for pipeline variants over dynamic branches.
- Buffer-limiter remediation: smaller types, vectorized load/store, some
  data in textures (separate ALU/TPU caches).

## Profiling (the verification organ)
- Limiter model: read the LIMITER (ALU/Buffer-RW/Texture), not utilization %
  (tech talk 10580). Xcode GPU capture + counters + occupancy tooling.
- ★ Xcode GPU Frame Capture / Instruments attach TRANSPARENTLY to any
  Metal-backed process — including our Tauri/wgpu binary. No API needed.

## wgpu reachability (the ruling table)
| Apple rec | wgpu |
|---|---|
| on-tile single-pass deferred (imageblocks/ROG) | ✗ not exposed (Dawn-only pixel_local experiment) |
| memoryless/transient targets | ◐ TextureUsages::TRANSIENT (PR #8247, ~09-2025 — verify version pin) |
| load/store actions | ✓ LoadOp/StoreOp (use Discard religiously) |
| storage-mode picking | ✗ backend heuristics decide |
| fp16 | ✓ Features::SHADER_F16 (WGSL f16) |
| subgroup ops | ✓ Features::SUBGROUP (→ Metal simd_*) |
| workgroup memory | ✓ var<workgroup> + Limits |
| specialization | ◐ WGSL override → Metal function constants |
| draw/dispatch_indirect (single) | ✓ |
| multi-draw-indirect / native ICB | ✗ on Metal backend (issue #2148) |
| 32-bit atomics | ✓ (= the HW ceiling anyway) |
| Xcode capture/counters | ✓ external attach, zero code |

## Consequences for DreamForge (folded into RENDER.md §8)
- Our vis-buffer + compute-PT design is inherently LESS G-buffer-bandwidth-
  bound than classic multi-pass deferred — the unreachable on-tile fusion
  hurts us less than it would hurt a raster-lighting engine. Mitigate:
  fewest passes possible, TRANSIENT + Discard on everything transient.
- GPU-driven culling: single dispatch_indirect + persistent-thread queue w/
  32-bit atomic job counters (Nanite's own shape) — fits wgpu's Metal
  surface exactly; multi-draw-indirect absence is a non-event for a
  visibility-buffer design (we don't issue many draws).
- fp16-first shader authoring standard, subgroup ops in cull/denoise,
  threadgroups ×32.
- "Avoid device atomics" = third independent vindication of hw-vis-first.
- Profiling law: every milestone gate includes an Xcode capture read by
  LIMITER on the MacBook.
