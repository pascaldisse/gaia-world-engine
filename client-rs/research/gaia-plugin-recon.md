# Recon: Procedural Worlds "Gaia / Gaia Pro" (Unity) — architecture mining for DreamForge

Context: DreamForge = ONE node-DAG procgen system (models+sound+worlds, agent-controllable,
Houdini-style lazy attrs-as-data already ruled). This mines Gaia's ARCHITECTURE for
transferable concepts. Not copying Gaia; Gaia is editor-only heightmap terrain tooling,
DreamForge is a runtime attr-graph. Sources: canopy.procedural-worlds.com (via
web.archive.org — live site 403s bots), procedural-worlds.com, Unity Asset Store reviews,
Reddit, itch.io.

---

## 1. Core architecture

### 1.1 Stamping (heightmap terrain ops)
- Stamper = a positionable/scalable tool that applies an **Operation Type** to the terrain
  heightmap, previewed live before commit ("stamp" = commit click).
- Operation types include Raise Height, Lower Height, Set Height, Smooth, Erosion FX,
  Mix Height, plus special-effect ops. Each op has its own parameter set.
- Composition model: **Max/Add (Set) semantics** — an op either takes the max of new-vs-
  existing height ("Set"/non-destructive raise: only raises where stamp is higher) or adds
  the stamp delta to existing height. `Subtract` flips add into carve-out. `Blend Amount`
  (0–1) controls how much underlying terrain detail bleeds through under the new stamp
  (0 = fully override, 1 = fully preserve underneath).
- **Stamps ARE masks**: a stamp image is technically just a mask applied to the raise/lower
  operation — "the core operation of the stamper is masked down by the stamp image" — i.e.
  stamping and masking are the SAME primitive (grayscale image → weighted op application),
  reused everywhere (spawners use it too). This is the key unifying idea in Gaia.
  Src: canopy stamper-introduction-r46, introduction-to-masks-r50.
- Mask stacking: masks compose in an ordered **list with per-entry Blend Mode**
  (default = Multiply = "AND-like narrowing"; also Greater-Than and others), each mask
  reduces/reshapes the strength field of the op before it's applied. This is literally a
  small compositing DAG living inside one tool.
- Stamp library: a directory of heightmap PNGs (community packs exist — "StampIT!",
  Ultimate StampIT Bundle, 160+ stamps across categories like canyons/craters/dunes/
  islands/volcanos — sold as plain grayscale textures, engine-agnostic, also used by rival
  tools MicroVerse/Map Magic 2/Vista). Confirms stamps are just portable heightmap assets,
  not proprietary format.
- Limits: stamper has an upper size/scale limit before the preview stops scaling and perf
  degrades; beyond that you either stamp multiple times or use the World Designer to push
  one stamp across multiple target terrains at once.

### 1.2 Spawners (rule-based placement)
- A **Spawner** = one rule set that places ONE class of content (texture layer, grass/
  detail, tree prefab, arbitrary GameObject/POI) governed by a **mask stack** (same masking
  primitive as stamping) that produces a per-cell "fitness" field.
- Standard masks: Height, Slope, Distance (radial falloff via curve), Noise, Image, plus
  proximity-style masks; each contributes a 0–1 strength, combined via the mask stack's
  blend modes into one fitness value per point.
- Placement algorithm for large/object spawns (POIs): grid-walk from lower-left corner
  with a **Location Increment** (step size) that shrinks in high-fitness areas and grows in
  low-fitness areas, **Jitter %** to break up grid regularity, **Min Fitness Required**
  (average fitness over a **Bounds Radius** footprint, so a whole multi-object POI is
  rejected if it straddles a slope even if its center point tests fine).
- POIs are just spawners fed a group of prefabs with preserved relative offsets (drag many
  objects onto the spawner from a scene arranged around world-origin) — one rule spawns a
  whole "farm" as a unit, sub-objects still individually height-conformed.
- Blend Modes on the mask stack are the composition algebra for combining independent
  spawn criteria (height AND slope AND noise, etc.) without writing conditional code.

### 1.3 Biomes
- A **Biome Controller** = a named bundle of Spawners + settings, NOT a new primitive —
  pure grouping/orchestration. Toggle individual spawners on/off inside a biome.
- **Area mode** per spawner list: `Local` (spawns only within the controller's own
  footprint/range) vs `World` (spawns across every terrain in the scene) — masks still
  apply in both modes. This is the "scope" knob for how far a package's rules reach.
- Biomes are **exportable/reusable assets** ("Save and Load" a biome file) — drop the same
  biome package onto a new terrain and get consistent look+feel instantly. This is biome-
  as-shippable-content-package.
- **Remove-assets-from-other-biomes**: when biome B overlaps biome A's spawn area, B can
  purge A's foreign assets from its own footprint first — an explicit biome-priority /
  overwrite-conflict operation, not implicit blending.
- One-click bulk actions: `Spawn Biome` (run every enabled spawner in the biome), `Clear
  Spawns` (undo/remove by biome or globally, per-terrain or all-terrains), `Create Runtime`
  (materialize lighting/water/wind/etc. runtime setup from Manager config).
- Biomes can also drive the Stamper: "Set Up In Stamper" copies a biome's spawner list into
  the Stamper's "Autospawners", so a single stamp operation both shapes terrain AND fires
  its matching population pass in one step (terrain-shape and content-population coupled
  by data, not code).

### 1.4 Sessions (replayable generation)
- **Session Manager**: every Gaia action ("operation") — stamping, World-Designer terrain
  generation, biome spawning, clearing details — is appended as a recorded step to a
  Session asset (an ordered operation log), auto-created per scene.
- Explicitly EXCLUDES anything done through raw Unity terrain tools outside Gaia — i.e.
  the log only captures ops that went through Gaia's own API surface, not arbitrary edits.
- Non-destructive replay: **"Play Session"** re-executes the recorded op list up to a
  chosen point — you can select an earlier operation in the list and "rewind" the world to
  that state by replaying only the prefix, without manually undoing. This is deterministic
  op-log replay, not snapshot diffing.
- Session metadata: Name, Description, Preview Image (+ auto-generate), Created timestamp,
  Locked flag (freeze from further edits), plus session-level global sliders (Sea Level,
  Global Spawn Density multiplier applied at replay time — i.e. some session params are
  read at REPLAY time, not baked per-op, so you can replay history with different global
  dials).
- Heightmap Backup: an explicit escape-hatch snapshot (not part of the op log) recommended
  before large spawn passes — an acknowledgment that pure replay isn't always trusted for
  expensive/slow-to-regenerate state.
- User complaint on record: recording sessions triples the time cost per operation
  ("Every operation is three time longer") — replayability is not free at authoring time.

### 1.5 World Designer / world map → tiles
- Two-stage generation: (A) **Base Terrain** = large-scale shape from Noise generator, an
  input heightmap image, or an existing terrain, with `Border Style` (force Water/Mountain/
  none at edges — island vs continent framing) and `Height Scale`/`Base Height`. (B) **Stamp
  scattering** = the designer auto-places many stamps FROM THE SAME STAMP LIBRARY as the
  manual Stamper onto the base shape, governed by: `Stamp Density` (count), `Stamp Jitter`
  (grid → randomized), `Stamp Width`, `Stamp Impact` (how strongly each stamp deforms).
- Per-feature-type rules (mountains, valleys, etc., each pulling from a stamp subfolder):
  `Spawn Probability`, **`Height Probability`** (a curve over base-terrain height that
  biases WHERE a feature-type is likely to land — e.g. suppress mountain stamps at sea
  level), `Stamp Height Modifier` (dampen a stamp's imprint based on the underlying terrain
  height so a mountain stamp dropped near a beach doesn't fight the base shape),
  `Invert Chance` (flip mountain↔valley), `Width Range`, `Mix Height Strength/Midpoint`
  (controls whether the stamp blends as elevate-above vs cut-into).
- Controls: `Randomize Stamps` (reroll population, keep base shape), `Randomize All`
  (reroll base shape + population — this is the one-click "give me an island" mode),
  `Clear Stamps`, `Reset to Defaults` (per selected world-size preset), `Generate World`
  (bake preview → real Unity terrain(s), including feeding the selected biome's textures).
- Multi-tile: World Designer natively supports single-terrain OR **multi-terrain output**,
  wired straight into Gaia Pro's Terrain Loading system so a "world map" preview becomes N
  streamed terrain tiles in one Generate step.

---

## 2. Numbers / limits

- **Scale example (official docs)**: a 25 × 25 km world = 625 km² = tiled as **625 × 1 km²
  terrain tiles**. Docs explicitly warn this is a CONTENT-DESIGN problem, not just a tech
  one: "a designer can easily spend an entire work day on 1 km²" → ~625 person-days to
  hand-fill that world.
- **Terrain Loading modes** (design-time & runtime), 4 load states per tool/loader:
  `Disabled`, `Editor Selected`, `Editor Always`, `Runtime Always`.
- **Impostor Terrains**: dual-radius LOD swap for whole terrain tiles — example config:
  full terrain loads at 2000 m, low-poly/simplified impostor mesh loads at 5000 m.
- **Runtime loader tuning**: `Min Refresh MS` / `Max Refresh MS` interpolated by distance,
  explicitly to avoid per-frame terrain-load checks across "100s of terrains."
- **Stamper size cap**: hard upper bound on how far the stamper can scale up before preview
  stops scaling (undocumented exact number, but real and hit in practice; workaround =
  restamp repeatedly or use World Designer's multi-tile stamp export instead).
- **User base**: "used by over 150,000 game developers," continuously developed since
  **2015**. Awards: Best Artistic Tool 2020, Best Development Tool 2024, Unity Verified
  Solution 2025.
- **Bundled asset weight**: ~5 GB of sample art ships with Gaia Pro; import alone can take
  ~10–30 min and is a recurring complaint vector (mistaken for "bugs").
- **Pricing** (asset-store list observed, sale prices fluctuate): Gaia Pro VS ≈ €183 list /
  ~€91–99 on 50%-off sales; older Gaia Pro 2021 review context ≈ €265 at full price;
  historically Gaia Pro + GeNa 2 bundle ≈ $156 direct from publisher.
- **Gaia vs Gaia Pro delta** (from official version-comparison table, Gaia2/Gaia-Pro era):
  - Gaia (base/free-tier "Gaia 2021/2"): Multi-tile support, GPU-accelerated stamping,
    GPU-accelerated spawning, Built-in/URP/HDRP, biome presets, stackable filtering.
  - Gaia Pro adds: Massive World Creation + non-destructive massive-world edit + massive
    streaming/culling support; extra stamping & erosion ops; extra masking ops; mask
    EXPORT system; spawnable VFX/SFX systems+assets; integrated weather (rain/snow);
    time-of-day lighting; photogrammetry biome asset packs; multiple pre-built biomes;
    Streaming Land; Impostor Terrain creation; Low-poly terrain creation.
  - Gaia Pro 2021 further adds over that: **World Designer** (procedural world gen, §1.5),
    Flora Grass/Detail accelerated system, Photo Mode, World-space masks, terrain
    addition/deletion (grow world dynamically), **biome-based stamping**, terrain-stitching
    (seam removal between adjacent terrains), and a **Gaia API** for calling Gaia functions
    from editor scripts.
  - Net: base Gaia = single/few-terrain authoring; Gaia Pro = the whole streaming/session/
    world-designer/API stack for BIG worlds. Current SKU is unified as "Gaia Pro VS."

---

## 3. Ecosystem siblings (same publisher, Procedural Worlds)

**GeNa Pro** — spline/prefab/decorator spawner, the object-placement sibling to Gaia's
terrain focus. Spawn modes: Single, Global, Paint, Spline, Map-based. Builds roads/rivers
along splines with automatic terrain clearing+flattening, spawns whole towns/structures,
has automated prefab optimization + automated light-probe placement. Notably: **"Edit and
Runtime spawning modes… API controllable"** — GeNa explicitly supports RUNTIME spawning
(unlike Gaia's terrain generation, which is editor-only, see §4). Requires compute-shader
support. Ships with dedicated "GeNa Roads" spline extension for road networks specifically.

**SECTR** — also a Procedural Worlds product, the streaming/culling sibling: SECTR CORE
(sector creation kit), SECTR STREAM (seamless scene streaming), SECTR VIS (dynamic
occlusion culling), SECTR AUDIO (spatial audio zones tied to sectors). Full source code
included, works indoor+open-world, has PlayMaker visual-scripting support. 2019-era upgrade
notes call out explicit "seamless Gaia, GeNa 2 & CTS support" — i.e. SECTR was built to plug
directly into Gaia's tiled-terrain output as its streaming backend, rather than compete
with Gaia Pro's own built-in Terrain Loading (the two overlap and users pick one).

**GDB (community, 3rd-party)** — a Synty-Polygon-Nature biome pack for Gaia/Gaia Pro by an
indie author (Timps, itch.io), included here only as evidence the mask-stack idiom is
externally legible: "ground texture spawner uses a combination of slope and height masks
along with large scale noise for variety" — proof 3rd parties compose Gaia's primitives
(not just Procedural Worlds internally) the same documented way.

---

## 4. Sucks-list (published/community criticism)

- **Editor-time ONLY, confirmed by the publisher itself**: official store listing states
  plainly — *"Gaia is not a run-time terrain generation system, and is fully focused on
  terrain creation during edit time."* Forum thread "Would it be possible to use Gaia at
  runtime?" and Reddit "Anyone had success scripting Gaia Pro API to generate procedural
  terrain without clicking through the editor?" both land on: the Gaia API exists but is
  scoped to editor workflows; "uses features of the unity editor that are not available in
  a standalone build" (direct Asset Store review quote from the publisher explaining why).
  **Verdict: hard runtime ceiling** — Gaia authors worlds, it does not GENERATE them live
  in a shipped build. (GeNa Pro, by contrast, explicitly offers a Runtime spawn mode — the
  siblings split the runtime capability Gaia itself lacks.)
- **Version churn / no forward migration path**: publisher's own docs state 2021 and 2023
  editions are "NOT directly compatible" — you cannot install 2023 over an existing 2021
  project; SKUs are versioned by year (Gaia Pro 2021, Gaia Pro 2023/"VS") requiring paid
  upgrade paths. Community pattern-matches this to red-flag naming ("Best Asset Ever Pro 2
  URP") — i.e. Gaia is cited as an EXAMPLE of the year-suffix asset-churn anti-pattern.
- **URP↔HDRP friction**: multiple forum threads ("Upgrading a URP project to HDRP,"
  "Upgraded URP to HDRP but having challenges rendering terrain") — switching pipelines
  post-hoc is a known pain point requiring manual Render Pipeline Wizard passes + Gaia
  Manager re-sync, not a click-through.
- **Reliability/support complaints** (verbatim from Asset Store reviews, publisher replies
  included for balance): "Festival of bugs" (stale hierarchy references/ghost warnings
  after deletes, floating-point-origin fix reported broken, Discord support dismissive);
  "everything is broken… one setup takes two weeks and then breaks" (publisher's rebuttal:
  user was installing a 2021-era package into incompatible Unity 6); large (~5 GB) asset
  import causing perceived freezes/compile stalls mistaken for crashes; texture-reference
  breakage silently disabling spawn masks after project moves/renames (cited independently
  in an unrelated review as a recurring annoyance, "seems there's always an issue with
  texture references causing spawn masks to become disabled").
- **Positive counterweight** (for calibration, not just complaints): consistently praised
  for turning "weeks/months into hours/days," used in shipped titles (Zenith, Last Epoch,
  Crowfall) and defense/sim/education contexts; Reddit consensus is "great for large
  streaming procedural worlds, weak for deliberate hand-authored level design" — i.e. its
  own community scopes it correctly as a BULK-generation tool, not a precision editor.
- **Session-recording tax**: recording every op for replayability was reported to roughly
  **3x the time per operation** — direct evidence that "replayable by default" has a real
  authoring-time cost worth designing around (e.g. opt-in per phase, not always-on).

---

## 5. Transferable ideas — ranked for a node-DAG model+sound+world system

| # | Gaia concept | What it actually is | Transfer to DreamForge (node-DAG) | Fit / rank |
|---|---|---|---|---|
| 1 | **Stamps ARE masks** (§1.1) | One primitive (weighted grayscale field) reused for both "shape the base" and "restrict where an op applies" | Directly IS a DAG idea already: a "stamp" = a generator node output; "masking" = multiplying that output into another node's weight input. Confirms DreamForge should have exactly ONE composable field-op node type (not separate Stamp/Mask node classes) — feed any node's scalar-field output into any other node's strength/mask input, terrain or model or sound alike (e.g. an audio env's reverb-density field masked by the SAME noise node that carved a canyon). **Highest-value idea**, cheapest to adopt, already structurally compatible with lazy attrs-as-data. | ★★★★★ |
| 2 | **Rule-spawners with mask-stack fitness** (§1.2) | Placement = per-point fitness scalar from a composed mask stack, walked with adaptive step+jitter+min-fitness-over-footprint | Generalizes past "trees on terrain" — any DAG node that PLACES instances (props, enemy spawns, sound-emitter placement, even sub-graph instancing for models) can consume the same fitness-field convention. `Bounds Radius` + `Min Fitness over footprint` is the right pattern for placing multi-part instances (POIs) without straddling bad terrain — directly reusable for placing composite prefabs/sound-emitter clusters. | ★★★★★ |
| 3 | **Sessions as replayable op logs** (§1.4) | Ordered, named, resumable generation history, replay-to-point, global params re-read at replay time | Maps cleanly onto a node-DAG's natural determinism: if nodes are already pure functions of attrs, the "session" is just the graph's op/edit HISTORY (param edits, node adds) with a scrub head — nearly free to add since a DAG is already replay-friendly, MODULO the measured 3x perf tax Gaia paid for always-on recording. Recommend: make history recording opt-in per edit session / debounced, not per-micro-op, to avoid Gaia's own regret. | ★★★★☆ |
| 4 | **Biomes-as-packages** (§1.3) | Named bundle of spawner rules + Local/World area scope + save/load as shippable asset + explicit "purge foreign assets in my footprint" conflict op | Maps to DAG sub-graph packaging: a "biome" = a reusable sub-graph (rules + local param overrides) instanceable at different scopes/areas, exportable as a shareable asset. The explicit "remove conflicting foreign content in my area" operator is the one truly novel bit worth stealing — DAG systems often ignore spatial-overlap conflict resolution between two independently-authored sub-graphs; Gaia's answer (explicit last-writer-priority purge, not implicit blend) is a good default. | ★★★★☆ |
| 5 | **World Designer's height-probability curves** (§1.5) | Feature-type placement biased by a curve over an underlying scalar (terrain height) + inherited height-modifier so features fight the base shape less near extremes | This is just mask-stack (idea #1) applied recursively at the "world-shape" scale — not a new primitive, but validates that the SAME node type should compose fractally: base shape → feature scatter → detail scatter, all through the identical field-op node. Worth confirming DreamForge's node-DAG supports arbitrary re-entrant composition depth without special-casing "world scale" vs "detail scale" nodes. | ★★★☆☆ |
| 6 | **Multi-tile / streaming coupling to generation** (§1.5, §2) | World Designer generates directly into N streamed terrain tiles; SECTR is a bolt-on sibling rather than integrated | Lesson is mostly a WARNING: Gaia's own ecosystem has two competing streaming answers (built-in Terrain Loading vs SECTR) that users have to choose between — avoid shipping DreamForge with two half-integrated streaming systems; pick one path from generation output straight into runtime streaming. | ★★☆☆☆ (cautionary, not additive) |
| 7 | **Editor-only generation boundary** (§4) | Gaia deliberately never promises live runtime terrain gen; GeNa Pro instead ships explicit dual edit/runtime spawn modes | Direct requirement check for DreamForge: since DreamForge is explicitly agent-controllable and presumably wants LIVE world/model/sound generation (not just offline authoring), this is the one place Gaia is NOT a model to imitate — copy GeNa Pro's stance instead (design every node to be runnable at both edit-time and runtime, not editor-only by architecture). | ★★★★★ (as an anti-pattern to avoid) |

**Bottom line transfer priority**: (1) unify stamp/mask into one field-op node — already
DAG-native; (2) generalize mask-stack fitness to ANY instancer (props/sound/geometry), not
just terrain flora; (7) explicitly reject Gaia's editor-only ceiling — architect every node
runtime-executable from the start, since that's precisely the gap Gaia leaves open and
GeNa Pro/DreamForge's stated goals both need closed.
