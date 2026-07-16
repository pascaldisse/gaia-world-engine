# GI / lighting recon — PARKED EVIDENCE (sonnet, 2026-07-16)

Status: evidence for RENDER.md. Recon informs, Pascal rules. NOTE: gathered
before the path-tracing escalation — candidates reframed in read-through.

## Lumen internals (the reference implementation of "trace SDFs, cache radiance")
- Pipeline: screen traces → SDF software trace (mesh DFs near + global DF
  clipmap far) OR HW BVH → surface-cache lookup at hit → world-space
  radiance-cache probes for distant gather. Reflections = separate budget.
- Surface cache = offline "cards" (12/mesh default) capturing material,
  lighting amortized over frames. Skeletal = 6 low-quality cards. Pink =
  uncovered = no bounce.
- Budgets (Epic): 4ms @1080p internal for GI+reflections+fog (60fps
  console); 8ms Epic 30fps; cost ~halves per scalability step. Final gather
  (DiffuseIndirectAndAO) = biggest line. SW Lumen ≈1.2ms CHEAPER than HW on
  7900XTX@4K, minor quality delta (AMD).

## Lumen SUCKS-LIST (→ DreamForge anti-goals)
- GLOBAL light changes take SECONDS to propagate (Epic docs, explicit).
- Small/bright emissives → noise "much more difficult than placed lights."
- Walls <~10cm leak (SDF thinness); overlapping meshes → pink zones/black
  reflections; foliage/thin geometry vanishes from surface cache.
- Screen-trace flicker on camera motion (off-screen content pops).
- Cost floor: "most expensive subsystem in default UE5"; still flicker
  reports in 5.7 (2026).
- Below GTX1080: degrades to probe gather → SSR → OFF. A second-path ladder
  — exactly what DreamForge forbids.

## Alternatives table (cost · dynamism · HW-RT?)
- DDGI/RTXGI: ~1ms diffuse @2080Ti; low-freq diffuse only; temporal lag;
  dynamic path REQUIRES DXR/VulkanRT.
- Godot SDFGI: 60fps on GTX1060; no bake, no HW-RT; specular supported;
  BUT dynamic occluders/emitters NOT (static-marked meshes only).
- VCT (VXGI/SEGI): no HW-RT, Maxwell-era; leaks, GGX cone mismatch, popping;
  ★ Metal compute port EXISTS: kakashidinho/VoxelConeTracingMetal (works
  around no-geometry-shader + no 3D-texture atomics on Metal).
- ReSTIR GI: 9.3–166× MSE win over raw 1spp PT; ReSTIR PT Enhanced 2026 =
  2–3× more; sharp specular breaks reuse (dirac BRDF).
- Radiance Cascades (Sannikov/PoE2): 0.3ms GTX970, noiseless, ZERO bake,
  cost independent of scene/light count — but 2D ONLY proven; radiance.wiki:
  "extending RC to 3D remains an OPEN PROBLEM" (memory + base-cascade cost).
- LPV (legacy): 2–5ms, coarse SH 1-bounce, superseded everywhere.
- Gap flagged honestly: no direct M1 benchmarks of DDGI/SDFGI/RC found.

## Read-through under the PATH-TRACING LAW (nyari, non-binding)
- Question changed post-recon: not "which GI system" but "which INTERSECTOR
  + VARIANCE REDUCTION for the one path integrator."
- Lumen's SW path proves the intersector: SDF near-field + global-DF
  far-field tracing hits 4ms budgets on console-class GPUs — our
  SDF/occupancy-mip assets are exactly this. Lumen's ARCHITECTURE (caches
  as truth, screen traces first, separate reflection system) is what the
  law forbids — its sucks-list reads as symptoms of cache-as-truth:
  seconds-long propagation = surface-cache latency; emissive noise =
  sampling without ReSTIR; leaks = SDF thinness (ours: geometry IS fields).
- ReSTIR "requires HW-RT" = wrong framing: ReSTIR is a SAMPLING algorithm
  over any ray source — it rides our compute intersector. It is the
  published answer to "never tell me too many lights."
- Radiance cascades 3D = R&D bet only (open problem upstream) — candidate
  for the diffuse cache layer LATER, never the foundation.
- Candidate frame for RENDER.md: one path integrator · intersector = SDF/
  occupancy mips (HW rays later, same transport) · ReSTIR direct+GI
  sampling · radiance cache as VARIANCE REDUCTION (converges to truth, not
  authority) · denoise+upscale presentation. Anti-goals = Lumen sucks-list.
