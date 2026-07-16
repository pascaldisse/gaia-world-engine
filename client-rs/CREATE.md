# CREATE — DreamForge in-engine creation suite (DRAFT for Pascal's ruling, 2026-07-16)

Laws served: pillar 9 (never leave the engine) · forbidden vocab (no bake/
manual UV/manual rig) · never-optimize · Dreams audio = SOLE copy license ·
pillar 13 (every section below = a PACKAGE on the Terry core).
Evidence: research/{dreams,dreams-music-phenomenology,create,vr-tools,
gaia-plugin}-recon.md.

## 1 · Mesh creation — four doors, one data truth
All modes edit DATA (ops, undoable, remixable); contouring kernel renders
all of it through the sole cluster pipeline. Nothing bakes, ever.
- **A · SDF fields (Dreams door)**: sculpt = EDIT LIST of primitives
  {shape, add/sub, blend k, color} — live re-eval on every edit (Dreams:
  1-100k edits/model; evaluator speed = the whole game). Booleans, smears,
  smooth blends. Remix-friendly by construction: a shared sculpt arrives
  still editable.
- **B · Organic sculpt (ZBrush door)**: brush strokes stamp SDF edits by
  default (doors A+B are ONE data model); adaptive resolution invisible
  (Tessimation-class under the hood; Nomad Sculpt = 5M-poly M1 proof by
  one dev). The artist never sees topology.
- **C · Vertex/poly mode (technical door)**: classic verts/edges/faces on
  polygon entities for hard-surface precision; edits = ops; tube/carve/
  edit-lens behavior parity from FEATURES.md lives here.
- **D · Procedural (node door)**: the ONE PROCEDURAL SYSTEM — see §5.

## 2 · Texturing — paint on the mesh, like a man
- DEFAULT verb: paint directly on the surface (projection → texel-space
  storage, seam dilation handled invisibly). Layers + smart materials
  WITHOUT the bake-gate: Substance needs baked curvature/AO maps to drive
  its generators — our tracer computes curvature/AO LIVE. Smart materials
  minus the bake step = the "simpler and better."
- Auto-UV = invisible machinery (Ministry-of-Flat-class zero-input quality
  bar; xatlas = proven open baseline; runs at import/edit, user never
  sees it). Ptex (no UVs at all) = flagged R&D branch, zero realtime
  precedent — revisit when texel-shading milestone exists.
- 20K inputs welcome (VT law); painting writes into virtual-texture pages.

## 3 · Rig + animation — perform, don't author
- AUTO-RIG always (UniRig-class ML skeleton+skinning — 2× prior SOTA at
  SIGGRAPH'25; heat/voxel weights fallback), editable after, never
  required by hand.
- Procedural locomotion DEFAULT on characters (Dreams puppet: rig-free
  walk w/ tweak channels arm-vigour/flail/springiness) — a fresh character
  WALKS before anyone animates.
- PUPPETEERING = the authoring verb: possess → perform → captured as real
  keyframe data; record limb-by-limb LAYERS, merge to one clip; procedural
  + keyframe + performed COMPOSE per-channel (keyframing a limb overrides
  just that channel — Dreams shipped this composition).
- Cleanup: Cascadeur-style unbake/physics-aware smoothing on captured
  takes (raw performance → clean editable curves).
- CAMERA: hold it, move it, record the take — camera = puppeteerable
  entity; cutscenes = performed takes on the timeline. VR: controller+head
  puppeteering = personal mocap (Tvori model); desktop: mouse/gamepad
  drive the same capture path.

## 4 · Music + sound (THE COPY LICENSE — Dreams, faithfully)
- Granular core: all voices are grains; sampler×synth hybrid; per-NOTE DSP
  chain instancing (articulation morphing).
- ONE TIMELINE for music+SFX+light+animation+gameplay events; playhead
  scrubbable, reversible, drivable by any signal (game state ↔ music,
  both directions — node system is the wiring).
- Performance-first ("you move the air"): canvas as playable surface,
  buttons = scale degrees, tilt = octave, drawing = playing; PERFORMANCE
  FIELDS = spatial effect-pedals you glide through (any DSP param bundle);
  capture lands as piano roll + automation curves, edit after. Arpeggiator.
  Mic → instrument (beatbox→drums, voice→choir). 3D-placed sound objects.
- Stealth-create ladder preserved: stamp a track → arrange stems → perform
  → build instruments → procedural/hardware. Publish at ANY granularity;
  everything arrives live (nothing bakes = remix economy).
- DreamForge twist: AI generators = PERFORMERS writing the same live data —
  generated music arrives editable, never a frozen wav.

## 5 · ONE procedural system (models · sound · WORLDS)
- One node DAG (NODES.md is the surface): lazy evaluation, attributes-as-
  data (Houdini's two real inventions), field-valued sockets everywhere —
  the Gaia-plugin lesson generalized: stamps/masks/spawn-rules/biome-blends
  are ALL one weighted-field primitive.
- Scales: a chair (mesh out) · a track (timeline out) · a planet (world
  out) · a universe (seed fn — NMS proof: 18 quintillion = a 64-bit seed
  space, the universe is a function).
- RUNTIME BY DEFAULT (the gap every Unity tool concedes: "editor-time
  only" — ours generates live, universe law demands it). Replayable by
  construction: generation = graph + seed + params = data (Gaia sessions
  done right, without the 3× recording tax — the graph IS the recording).
- Agent-drivable by construction: graphs are data; agents generate worlds
  through the same surface humans do.
- World output composes with edit deltas: procedural base + ops overlay
  (NMS pattern, minus their capped FIFO — our deltas are scene data;
  base-protection idea kept).

## 6 · Package mapping (pillar 13)
create-sdf · create-sculpt · create-poly · create-paint · create-rig ·
create-anim · create-audio · create-procedural — each a package over the
core; none load-bearing for runtime-only worlds.

## 7 · Milestones (each playable)
C1 SDF sculpt loop: stamp/blend/subtract live at 60fps, undo, remix a
   shared sculpt. Gate: 10k-edit model sculpts fluidly on the MacBook.
C2 paint: draw on a mesh, layers, live curvature-driven smart material.
   Gate: 20K texture painted, resident MB stays tile-bound.
C3 auto-rig+puppeteer: import/sculpt a biped → walks (procedural) →
   possess, record 3 limb layers, merge, edit curves. Gate: zero manual
   rig/keyframe steps to a playable animation.
C4 audio: canvas performance → piano roll; one timeline drives light+
   sound+animation; mic→instrument. Gate: a track made start-to-finish
   in-engine, published, remixed live.
C5 procedural: node graph generates a terrain biome w/ spawned content at
   RUNTIME; same graph type emits a mesh and a beat. Gate: one DAG, three
   output domains, agent generates a variant via ops.

## Rulings (Pascal 07-16)
1. ✅ NO CONVERT PROCESS, EVER ("you just sculpt and it sculpts, just like
   in Dreams"): the sculpt verb works on whatever is touched — SDF, poly,
   procedural output — representation handling is invisible engine
   machinery. "convert" joins the forbidden vocabulary.
2. ✅ audio = CPU realtime track (default accepted).
3. ✅ milestone interleave = default (C-milestones follow R/P as scheduled).

## Character editor package (ordered 07-16 — → NARUKO.md W5)
- Package `char-editor`: parametric body/face/hair/outfit; any creature
  (humanoid → quadruped); style-agnostic (anime → realistic); SIMPLE
  surface, Baldur's Gate-class depth.
- Real textures via the paint-on-mesh pipeline (no manual UV, no bake
  gate); auto-rig on finish (editable); output = pure entity data any
  world can use.
- Old engine's VRoid-ish implementation = reference for scope only,
  nothing inherited.
- First deliverables: nari avatar (canon palette in NARUKO.md, exact
  match to reference image) + naruko pink cat (red eyes, heart collar).
