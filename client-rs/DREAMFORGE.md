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
6. ONE LIGHTING SYSTEM = REAL PATH TRACING (Pascal escalations 07-16: "ray
   tracing is not an option... there is no alternative" → "real fucking
   light that works like real fucking light"). Ground truth = Monte Carlo
   path transport, one integrator: every light IS an emissive surface, the
   sky is an emitter, reflections are just paths — nothing to configure,
   nothing that can "not work". GRANTED: noisy + low internal res is fine
   ("we're building an AI tool") — few paths/pixel, denoise, upscale;
   presentation layer cleans what physics leaves rough. Tricks admitted
   ONLY as variance reduction converging to the traced truth (ReSTIR
   many-light sampling, radiance caches, screen reuse) — bias budget, never
   an alternative model. Intersectors are swappable (SDF/occupancy mips on
   M1, HW rays on RT silicon) — the transport is not.
   FORBIDDEN FOREVER: reflection maps/probes · env-map lighting authority ·
   light-count ceilings · "too many lights" as an error class
7. METAL/macOS = PRIMARY TARGET (Pascal 07-16, "old-school Unity way"):
   optimize for Metal first, always — that's where it runs. Portability =
   preserved OPTION (wgpu core, capability traits, no Metal-only
   load-bearing pieces); other-platform systems added later when needed.
   Nobody else ships an engine like this in 16GB RAM on an ARM chip — we do
8. Editor = the forge — live everything, spec'd against the old engine's
   full tool surface (mesh tools, gizmos, outliner, undo, scene write-back)
9. CREATION SUITE IN-ENGINE (Pascal 07-16: "we never leave the engine") —
   no Blender, no ZBrush, no Substance, no Houdini, no DAW. → CREATE.md:
   - mesh modes, pick by taste/need: SDF field booleans (Dreams) · ZBrush-
     class organic sculpt (auto-resolution under the hood, no bake-mesh
     concept — "it just works and you don't even notice") · traditional
     vertex/poly editing for technical models · node-based procedural
     (mini-Houdini)
   - texturing: DEFAULT = paint directly on the mesh (Substance-class,
     simpler + better). Manual UV mapping DOES NOT EXIST (auto-UV is
     invisible machinery)
   - rigging: automatic always, editable after. Never rig by hand.
     Animation equally easy
   - MUSIC + SOUND DESIGN à la Dreams — Pascal: "this one you can fucking
     copy" — THE sole copy license in the project
   - ANIMATION = PUPPETEERING (Pascal 07-16): hand-keyframing is never the
     required flow. Record limb-by-limb in LAYERS (Dreams model), merge to
     one clip; keyframes remain visible, real, editable animation data. In
     VR: controller+head puppeteering = personal mocap (Tvori model).
     CAMERA: hold it, move it, record the take — that's cutscene authoring.
     The pipeline must be FUN or it's wrong
11. VR HYBRID (Pascal 07-16: "that was the point from the very beginning").
    Endgame: EVERYTHING editable through VR — the interface built for 3D
    world creation. Topology: Mac runs sim+render (perf home), headset =
    editing interface over the same world data (a headset is just another
    client — falls out of pillar 10); native Quest = open option later.
    NOW: not the full VR system — a VR editor mock-up is in scope. Target:
    Vision Pro / whatever affordable headset comes next. Reference bar:
    Dreams VR + Tvori (VR content-creation engine: puppeteer mocap,
    held-camera recording). Anti-reference: Unity EditorXR (scrapped).
    XR laws parked in research/visionflow-recon.md apply (gaze-dive,
    voice+hands, rope before descent)
10. NODES = SURFACE, DATA = TRUTH (Pascal 07-16): AI agents are the
    engine's PRIMARY users — they interact with pure data (components/ops/
    schema, as today). Node graphs are the HUMAN view of that same data —
    the primary scripting surface, better than Blueprints, and 3D (spatial
    node graphs — Pascal's VisionFlow concept = the reference spec; mine
    ALL his docs). Users never write code; they see what the logic does
    and manipulate it. One representation underneath, two faces on top

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
- **bake** (light, mesh, or anything else) · **lightmap** · **authored LOD**
  · **optimize/import-quality knobs** · **"generate LODs" button** ·
  **manual UV mapping** · **manual rigging as a required step**
Everything is dynamic, on the fly, self-adapting to the machine it runs on.
If a design draft needs one of these words, the design is wrong — redesign.

## Standing process rules
- Spec-first: no subsystem implementation before its ruling doc is written
  and Pascal has ruled. Recon informs, Pascal rules, nothing adopted by
  default
- WHATEVER WORKS, PERFORMANCE FIRST (Pascal 07-16): between correct designs,
  the faster one wins; implementation pride never outranks frame time
- ASSUME THE ENTIRE WORLD IS INCOMPETENT (Pascal 07-16, doctrine): every
  published system — engine, paper, plugin — is presumed broken until its
  numbers survive our recon; only we can build a real game engine. Mine
  their evidence, inherit none of their excuses
- "Analyze then beat": for each named prior (Nanite, Lumen, Dreams, RayFire,
  Teardown) — mine what's published, write the sucks-list, design ours
  against the weaknesses. Assume everything sucks
- Test law + play-it law apply to every milestone; each stage playable
