# Virtual texturing + streaming recon — PARKED EVIDENCE (sonnet, 2026-07-16)

Status: evidence for RENDER.md. Recon informs, Pascal rules. Doctrine served:
"20K textures on everything just works" — resident memory = what the screen
samples.

## Core findings
- **20K math (worked)**: one 20480² texture — RGBA8+mips ≈ 2.24 GB · BC7/
  ASTC-4×4 ≈ 0.56 GB · ASTC-8×8 ≈ 0.14 GB. Un-virtualized untenable on M1
  unified pool ⇒ VT is LOAD-BEARING for the doctrine, not an optimization.
  Resident set at any moment = visible-tile subset (a few MB).
- **wgpu has NO sparse textures** (gpuweb#455, open since 2019; Metal sparse
  model incompatible with WebGPU resource model) ⇒ SOFTWARE INDIRECTION is
  the pipeline: physical tile-pool texture + page-table texture (1px = 1
  tile) + shader UV remap. This is what idTech/UE SVT/Granite actually do —
  hardware sparse never required. Hardware-agnostic pillar satisfied by
  construction.
- **M1 HAS Metal sparse textures** (first Mac gen, Apple7/Mac2 family, with
  access counters) ⇒ optional fast path behind capability trait, later.
- **MTLIOCommandQueue = Apple's DirectStorage** (Metal 3, macOS 13+): disk →
  Metal buffer/texture, no CPU staging copy; designed FOR tile-granularity
  VT streaming (feedback → load tiles → blit → draw). The streaming IO organ.
- **Format pipeline**: KTX2/UASTC (8bpp fixed) = common subset of BC7 AND
  ASTC-4×4 → transcode = near-free bit-repack (vs 250-350ms full path);
  ASTC full (LDR+HDR) on M1; ASTC-8×8 = 0.25 B/texel for distant/rough
  content. ETC2 = universal fallback.
- **UE pattern worth keeping**: per-format LRU tile pools + residency
  mip-bias — oversubscription auto-degrades sharpness, NEVER fails to
  render. The never-optimize-compatible failure mode.
- **UE SVT numbers**: 128×128 tiles default, page table 1px/tile, physical
  pools per-format, feedback pass resolution = latency/cost dial. Granite
  (→ acquired by Unity): same architecture as middleware, "arbitrary
  texture count/res @ 90fps" pitch.

## Megatexture (idTech 5) sucks-list → lessons
- RAGE blur: NOT the VT mechanism — the CONTENT decision (unique texels
  everywhere, no tiling reuse) starved per-surface resolution; DOOM 2016
  reverted to reuse and looked sharper.
- JPEG-XR transcode-on-demand = stutter + artifacts ⇒ pick block-compatible
  intermediate (UASTC), never JPEG-family.
- ⇒ DreamForge: VT carries arbitrary INPUT sizes (20K fine); material reuse
  stays a virtue; transcode must be bit-repack-cheap.

## Sources
dev.epicgames.com VT docs (settings/memory-pools/RVT) · graphinesoftware.com
granite SDK5 whitepaper · imec: Unity acquires Graphine · pcgamer RAGE
retro · anandtech forums idtech5 · gpuweb/gpuweb#455 ·
developer.apple.com/documentation/metal sparse + WWDC22 10104/10066 ·
nonstrict.eu/wwdcindex/tech-talks/10859 (M1 sparse) · binomialllc
basis_universal · metalbyexample.com compressed-textures + modern-era ·
computergraphics.stackexchange.com/questions/1768
