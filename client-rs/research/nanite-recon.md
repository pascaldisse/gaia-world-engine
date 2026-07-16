# Virtualized geometry recon — PARKED EVIDENCE (terra, 2026-07-16)

Status: evidence for RENDER.md. Recon informs, Pascal rules.

## Nanite internals (Karis SIGGRAPH 2021 + UE docs)
- Clusters ≤128 tris; build: cluster → group adjacent → merge → simplify 50%
  → repartition → repeat to root. DAG (multi-parent), METIS min-edge-cut
  grouping; groups make identical LOD decisions → crack-free.
- LOD select: `ParentError > τ && ClusterError ≤ τ` (local test, parallel).
- Cull: BVH8 over cluster metadata; persistent-thread MPMC queues (single
  dispatch, ~25% saving); TWO-PASS HZB (prev-frame HZB → raster → retest).
- Raster: HW for big tris; SW compute raster for pixel-sized (1 thread/tri,
  64-bit InterlockedMax word = 30b depth + 27b cluster + 7b tri; 3× faster
  than best HW path). Vis buffer → material resolve pass (~2ms).
- Streaming: 128KB pages, cluster GROUPS = stream unit, ~2KB/cluster, root
  page resident; GPU emits prioritized page requests. Disk transcode ~50GB/s
  PS5. Density: 5.6 B/Nanite tri; 433M-tri demo = 4.61 GB disk.
- Frame: cull+raster ~2.5ms @ 2496×1404 (upsampled 4K).

## Nanite sucks-list (= DreamForge requirements list)
- STILL no translucency, no mesh decals, no morph targets; masked = overdraw
  tax; WPO limited w/ global culling cost + wrong culling under extreme
  deformation; skeletal only recently.
- Aggregates (grass/leaves/hair) fundamentally poor — porous volumes defeat
  occlusion-based culling.
- Prev-frame occlusion dependence = "one of Nanite's biggest deficiencies"
  (disocclusion spikes).
- Source topology demands: no non-manifold/holes/internal faces ("works with
  any geometry" = OUR requirement, their gap).
- Excluded: forward, MSAA, VR stereo; native RT experimental.
- ⚠ APPLE: UE 5.5 report — M1 WILL NOT be supported (needs 64-bit image
  atomics; Apple9+ only). M2 experimental.

## M1 / Metal / wgpu hard facts
- M1 = Apple7: mesh shaders YES (1,024 threadgroup grid cap — small),
  primitive ID + barycentrics YES, 32-bit texture atomics YES, sparse
  textures YES. 64-BIT ATOMICS NO (Apple9+; Apple8 partial min/max).
- wgpu: EXPERIMENTAL_MESH_SHADER exists (Vulkan/DX12/Metal, gated Apple7+);
  TEXTURE_INT64_ATOMIC gated Apple9 + MSL3.1 → M1 excluded.
- Bevy meshlet REQUIRES TEXTURE_INT64_ATOMIC → cannot run on M1 unchanged.
- 32-bit workarounds recorded: Scthe/nanite-webgpu (u16 depth pack, precision
  artifacts), philipturner/ue5-nanite-macos (~15 FPS historical port).
- One M1 mesh-shader forum report: 2× REGRESSION vs draw calls (thread
  722047) — mesh shaders on M1 not automatically a win.

## Open implementations — sucks verdicts
- Unity "Nanite" plugins (Pascal's 2-3): ZEngineStudios = most complete
  (meshopt+METIS, vis buffer, occlusion) BUT core shipped as DLLs/
  AssetBundles, no SW raster/streaming/compression, license w/ credit
  strings. Rest (Bananite, natane010, siyeong0, ZishenLu, HuaQiu, jsong480):
  demos/no docs/no feature matrices. VERDICT: all toys or locked — nothing
  to adopt, confirms build-own.
- bevy meshlet: the only serious wgpu-native impl (128-tri meshlets, 50%
  DAG, two-pass HZB, HW+SW raster) — dies on M1 (64-bit atomics), opaque-
  only, Apache-2.0 = legitimate REFERENCE CODE.
- Scthe/nanite-webgpu: proves 1.7B source tris in a BROWSER; 32-bit pack
  precedent. nanite-at-home (Rust/Vulkan, mesh shaders, zstd pages),
  pettett/multires (200B tris on GTX1660, GPL). meshoptimizer: gives
  meshlets/simplify/encode (decode 7-10 GB/s CPU) — does NOT give DAG
  grouping, crack-free activation, paging/IO, GPU cull queues, HZB, raster.
- ⇒ Make-or-buy: BUY meshopt(+METIS) for the offline baker primitives;
  BUILD everything runtime (DAG, streaming, cull, raster, resolve) — which
  is the part that defines us anyway.
