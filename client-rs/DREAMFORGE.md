# DREAMFORGE — engine charter (Pascal, 2026-07-16)

"An engine where I want to shape dreams. I never ever want to optimize."

## Doctrine: NEVER OPTIMIZE
Engineering translation: **frame cost ∝ pixels on screen, never ∝ content.**
Every subsystem must hold this invariant:
- geometry: billion over-detailed polygons dropped in → renders at
  pixel-density cost. Virtualized clusters are THE ONLY geometry pipeline —
  no legacy path, no fallback mesh renderer. ALL geometry rides it: static,
  skinned, deforming, procedural, SDF/voxel contouring output (contouring
  kernel emits clusters directly). Nanite analyzed → beaten: its exclusion
  list (skinned/WPO/foliage/translucent) exists BECAUSE UE keeps a legacy
  fallback — we have none, so our system carries everything. Nanite's
  limitations = our requirements list. Cluster hierarchy is built
  automatically, on the fly, at import/creation — invisible machinery.
  Budget adapts to the hardware it finds. "Nanite on steroids, the entire
  engine built around it, no alternative" (Pascal, verbatim law)
- textures: 20K textures on everything → resident memory = what the screen
  samples (virtual texturing; page cache, not asset size)
- light: NO BAKE BUTTON EXISTS. Place a light → scene is lit, immediately,
  always. Realtime GI only, Lumen-class target; cheap tricks under the hood
  fully allowed — the contract is the experience, not the math.
  **Supported light sources: INFINITE** (Pascal, verbatim law) — no pool, no
  cap, no per-scene budget; light cost ≠ light count, cost ∝ lit pixels
  (clustered deferred culling + GI where every emissive surface IS a light).
  **ONE lighting engine, all of it traced** — no raster-only mode, no RT
  toggle, no alternative system; "whatever is the cheapest way to achieve
  ray tracing" is the implementation license, the traced result is the law
- physics: perfect physics; solver islands budget-scheduled (active = exact,
  far = coarse/sleeping) so content scale never forces authoring compromises
- authoring: no import knobs, no LOD authoring, no lightmap UVs, no
  "optimize scene" pass. Drop it in. It works.

## Pillars (all ratified 07-16, Pascal)
1. ONE CLIENT — Tauri + wgpu native; web client dies at parity (whip 161)
2. 100% feature contract (FEATURES.md) — every old-engine feature present
   OR replaced by a declared-better system (replace map below). Never
   silently dropped
3. Perfect physics — own unified solver (PHYSICS.md ON HOLD: Pascal's own
   pass first; evidence parked in research/)
4. Hybrid geometry — polygons default · voxels opt-in · SDF fields
   (GEOMETRY.md)
5. Virtualized geometry + textures — the never-optimize machinery; geometry
   virtualization is the SOLE pipeline, not a feature (RENDER spec, recon in
   flight)
6. ONE LIGHTING SYSTEM — always-on, fully traced (Pascal escalation 07-16:
   "ray tracing is not an option... there is no alternative"). Everything
   rides one unified tracing engine: SDF/occupancy-mip traces + screen rays
   + radiance caches on M1; hardware rays = same system, faster intersector,
   on RT silicon. Unlimited dynamic lights, unlimited reflections. Quality =
   INTERNAL detail levels (ray counts, cascade res, bounce depth) that adapt
   to the machine — never a second lighting path, never a toggle
7. Hardware-agnostic core — wgpu; platform fast paths (MetalFX, sparse
   textures, HW RT) behind capability traits with software fallbacks.
   Current optimization target: Pascal's MacBook (M1) — target moves,
   architecture doesn't
8. Editor = the forge — live everything, spec'd against the old engine's
   full tool surface (mesh tools, gizmos, outliner, undo, scene write-back)

## Replace map (old feature → better system; contract-preserving)
| Old engine | DreamForge | Status |
|---|---|---|
| carve mesh-CSG booleans (three-bvh-csg) | SDF field sculpting (Dreams-style; add/subtract/blend primitives) — RATIFIED 07-16: "we have a better system." carve data auto-converts (subtract, k=0) — old scenes load unchanged | GEOMETRY.md amended |
| point-light pool (16 nearest, forward) | clustered deferred + realtime GI — INFINITE lights; count leaves the schema, emissives are lights | RENDER spec pending |
| per-scene fog family constraints (pipeline re-key) | pipelines never keyed by light/fog set (Fyrox-steal, deferred day one) | ruled |
| manual LOD-free small-scene assumption | virtualized geometry — scale ceiling removed | recon in flight |
| baked nothing (old engine never baked) | stays: nothing ever bakes | doctrine |

Rule for future rows: replacement must cover 100% of the old feature's
observable behavior + declare what's better. No row, no replacement.

## Spec tree (spec-first phase — docs before code, rewrites expected)
| doc | scope | status |
|---|---|---|
| DREAMFORGE.md | charter, doctrine, pillars, replace map | this doc |
| FEATURES.md + features/ | 100% contract inventory | ✅ committed |
| GEOMETRY.md | polygon/voxel/SDF hybrid, contouring kernel | ✅ committed; SDF-replaces-carve ratified |
| PHYSICS.md | unified solver, destruction, gas | ⚠ ON HOLD — Pascal's magic first; evidence: research/physics-recon.md |
| RENDER.md | deferred, virtualized geometry, virtual texturing, ONE traced lighting system, MetalFX/upscale | recon wave out (Nanite · GI field · VT) |
| STREAMING.md | scenes, asset pages, residency | after RENDER |
| EDITOR.md | forge surface: tools, gizmos, overlay, undo | after RENDER |
| research/ | parked recon evidence (informs, Pascal rules) | physics + neural in |

## Forbidden vocabulary (Pascal, 07-16 — hard law)
These concepts DO NOT EXIST in engine schema, API, editor, or docs — not
disabled, ABSENT:
- **bake** (light or anything else) · **lightmap** · **authored LOD** ·
  **optimize/import-quality knobs** · **"generate LODs" button**
Everything is dynamic, on the fly, self-adapting to the machine it runs on.
If a design draft needs one of these words, the design is wrong — redesign.

## Standing process rules
- Spec-first: no subsystem implementation before its ruling doc is written
  and Pascal has ruled. Recon informs, Pascal rules, nothing adopted by
  default
- "Analyze then beat": for each named prior (Nanite, Lumen, Dreams, RayFire,
  Teardown) — mine what's published, write the sucks-list, design ours
  against the weaknesses. Assume everything sucks
- Test law + play-it law apply to every milestone; each stage playable
