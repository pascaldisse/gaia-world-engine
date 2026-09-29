# Clean-room destruction behaviour spec — GAIA World Engine `rayfire` extension

Status: authoritative behavioural contract for a **from-scratch** implementation of the engine's
runtime destruction extension (published as `window.gaia.rayfire`, engine extension entry
`register(ctx) -> { name, api }`). This document describes only OBSERVABLE behaviour, inputs,
outputs, invariants, bounds, and determinism. It contains NO code, NO pseudocode, and NO
algorithm-as-written. Standard published algorithms are NAMED with public citations only; the
implementer designs their own realisation.

The exact exported names / signatures / return shapes the game consumers depend on live in the
companion file `destruction-api.md` (the PUBLIC API CONTRACT — the rewrite must be drop-in so the
Empire Earth consumers run unchanged). Read that file together with this one.

Numeric defaults below are OUR chosen tunables, each with a rationale. They are the reference
defaults, not a re-statement of any third-party tool's constants; the implementer may keep or
re-tune any tunable marked *(tunable)* provided the acceptance criteria (§16) still pass.

---

## 0. Scope & the one hard guarantee

The extension turns a solid mesh into a set of physically-independent fragments and simulates them
falling, colliding with a ground plane, settling, and fading out — a runtime procedural
destruction pipeline usable by any game that mounts the engine.

The SINGLE non-negotiable output guarantee: **every fragment mesh produced by the fracture path is
watertight and has strictly positive volume**, for the entire real asset census (see §15 perf), with
zero thrown exceptions. Everything else is quality/perf; this is correctness. An implementation that
emits a hollow, holed, or zero-volume fragment for any census input is WRONG regardless of speed.

The pipeline is split into four cooperating concerns; each is independently testable:

1. **Fracture** — mesh → fragment cells (pure geometry, no rendering, no physics).
2. **Render conversion** — fragment cells → renderable GPU geometry, and THREE scene-node glue.
3. **Rigid simulation** — a lightweight own rigid-body world (gravity, ground, sleep, impulses,
   raycast) behind a swappable backend interface.
4. **Structural logic** — anchors, adjacency joints, support propagation, stress erosion, staged
   collapse, per-fragment activation, and fade lifecycle.

---

## 1. Shared data model (plain objects, engine-agnostic)

All geometry/physics math operates on **plain `{x, y, z}` number objects**, NOT on any engine
vector class. Only the render-conversion / scene-glue layer (§4–5) touches THREE. This separation
is a hard architectural requirement: concerns 1, 3, and the non-hull parts of 4 must be unit-
testable with zero rendering/engine dependency.

- **vec** — `{ x:number, y:number, z:number }`.
- **aabb** — `{ min: vec, max: vec }` (axis-aligned bounding box).
- **triangle** — `[vec, vec, vec]`, wound counter-clockwise as seen from OUTSIDE the surface
  (outward-facing normal by the right-hand rule).
- **triangle soup** — `triangle[]`; the canonical mesh-input form.
- **face** — a convex planar polygon: `{ verts: vec[]  (>=3, CCW, outward normal),
  interior: boolean, materialId: number }`. `interior === true` marks a cut/cap face created by
  fracturing (the freshly-exposed inner surface); `false` marks original outer-surface geometry.
- **cell** (fracture output) — `{ index:number, seedPoint:vec, faces: face[],
  uncappedLoops:boolean, hullFallback:boolean }`. See §3 for the two boolean quality flags.
- **fragment** (demolition output) — `{ index, faces, volume:number (>=0), centroid:vec,
  aabb, depth:number, demolition:{...} }`. See §7.
- **joint** — `{ i:number, j:number, broken:boolean, ... }` where `i`,`j` index into a fragment
  array. Optional per-joint fields (`strength`, `area`, `stress`) are read where the operation
  needs them and default sensibly when absent (see each operation).
- **body** (rigid sim) — see §6.

---

## 2. Determinism law

Every randomised behaviour MUST be **fully deterministic given its seed**: same inputs + same seed
⇒ byte-identical output, forever, on any platform, single- or multi-run. This is a hard invariant
(replay-safety and shared-cache correctness depend on it).

- The implementer chooses any well-known deterministic 32-bit PRNG (e.g. a small public-domain
  counter-based generator). There is NO requirement to reproduce any particular external RNG
  stream — only per-seed reproducibility within this implementation.
- Seeds are unsigned 32-bit integers. Callers may pass any integer; coerce to uint32.
- Distinct logical random uses that share one caller seed MUST be decorrelated (e.g. by mixing a
  fixed per-use constant into the seed) so that, say, seed placement and fade-lifetime jitter do
  not move in lockstep. The specific mixing constants are UNSPECIFIED (implementer's choice) as
  long as determinism and decorrelation hold.
- Pair/shard-keyed randomness (collapse rules, §11) MUST key the PRNG off the pair/shard identity
  PLUS the seed, so the *same* connections/fragments are always selected first for a given seed,
  independent of iteration order.

---

## 3. Fracture (mesh → cells)

### 3.1 What it computes
Given a closed triangle soup and a fragment count N, produce the **3D Voronoi partition** of the
mesh interior with respect to N seed points: cell *i* is the region of the mesh closer to seed *i*
than to any other seed. Each cell is returned as a closed face set. The union of all cells equals
the original solid; cells do not overlap.

This is a standard, well-defined mathematical object. Acceptable public approaches include: a
Voronoi/power-diagram library (e.g. Voro++, BSD-licensed — a cell is by definition the intersection
of the half-spaces bounded by every pairwise perpendicular-bisector plane), or direct per-cell
sequential half-space clipping of the mesh against those bisector planes with cut-face capping.
The implementer picks the approach; the OUTPUT contract and guarantees below are what is tested,
not the method.

### 3.2 Seed placement
- N seed points are sampled inside the mesh AABB using the seeded PRNG (§2).
- **Contact bias** *(tunable behaviour)*: when a bias strength in `[0,1]` and a bias position are
  given, each seed is pulled toward the bias position so fragments cluster near an impact point.
  Observable effect: with strong bias toward one corner, the far side yields fewer/larger cells and
  the biased side yields more/smaller cells. The exact falloff curve is UNSPECIFIED — a linear
  interpolation of each seed toward the bias position by the bias strength is the reference choice
  and satisfies the documented behaviour; any monotonic pull that produces the observable clustering
  is acceptable.
- **Amount variation** *(tunable)*: an optional variation percentage jitters the actual seed count
  around the requested amount, seeded. Default variation 0 (exact count). Rationale for exposing it:
  visual variety across repeated destructions of the same model.

### 3.3 Cap faces & winding
- Wherever a cell boundary is a freshly-cut plane (or a closed hole cap), the new polygon(s) MUST be
  wound so the solid stays **consistently oriented**: every shared edge is traversed in one
  direction by one face and the opposite direction by its neighbour. This is the condition that
  makes the watertight test (§3.5) pass and makes the cut-face normal point outward from the cell.
- Cut/cap faces are tagged `interior: true` with an interior material id (see §4 material groups).
  Retained original-surface faces keep `interior: false` and their original material id.

### 3.4 Open-shell input (REQUIRED — real assets are open shells)
Real building models in the census are **open shells** (not watertight as authored: missing bottoms,
T-junctions, duplicate/degenerate geometry, non-manifold junctions). The fracture path MUST still
produce watertight fragments from them. Required closure behaviour, applied in this order:

1. **Pre-close the source**: before partitioning, detect open boundary edges of the source mesh (a
   directed edge with no matching reverse-direction twin is a boundary edge — the standard
   half-edge boundary test) and cap each boundary loop with a new face. No-op on an already-closed
   mesh.
2. **Post-close each fragment**: after partitioning, re-run the same boundary detection on each
   fragment as a safety net for residual opens (e.g. a loop a non-manifold junction left un-chained).
3. **Guaranteed last resort**: if a fragment is STILL not watertight after (1)+(2), replace its
   surface with the **convex hull of its own vertex set** (a convex hull is always closed and
   manifold by construction). This trades concavity fidelity for that one fragment only, and is
   reported (see `hullFallback`, §3.6). Convex-hull computation is a standard published algorithm
   (e.g. QuickHull); the engine already depends on a mature hull implementation via THREE's
   add-ons, which the implementer MAY reuse (the hull is the ONE place the fracture layer is
   permitted to touch THREE — see §4).
   - **Sliver hardening**: a hull built from float-noisy near-duplicate points can emit legitimate
     near-zero-area triangles that fail an exact edge-key watertight test. The implementer MUST
     harden against this — e.g. weld hull vertices closer than a scale-relative epsilon into a
     single point and drop the resulting zero-area triangles, escalating the weld epsilon through
     an increasing ladder and keeping the first result that actually checks watertight. Reference
     ladder: `[1e-5, 1e-4, 3e-4, 1e-3, 1e-2, 1e-1]` *(tunable)*, chosen empirically to close the
     entire census. Absolute final fallback (not observed in the census, kept for the "always"
     guarantee): a padded AABB box of the point set, trivially watertight.
   - When the hull tags triangles, a hull triangle is tagged `interior:false` (keeps the exterior
     material) iff ALL three of its vertices came from original exterior (non-cap) faces; otherwise
     `interior:true`. This is a documented heuristic, not an exact reconstruction of the original
     surface triangles.

### 3.5 Watertight test (the acceptance oracle)
A face set is watertight iff, after fan-triangulating every face, **every directed edge has exactly
one matching reverse-directed edge and no directed edge repeats**. An empty set is not watertight.
The implementer's own watertight predicate is the oracle used by §16 acceptance tests and by the
closure fallback decision in §3.4. Edge matching MUST be robust to float representation (e.g.
fixed-precision coordinate keys); the exact precision is UNSPECIFIED but must be consistent between
the producer and the checker.

### 3.6 Cell output & degenerate drop
- Return one cell per seed whose cell has **strictly positive volume**. Drop:
  - empty cells (a seed entirely clipped away by others' bisectors), and
  - **zero-volume slivers** (a thin source, e.g. a millimetre-thick wall, can place two seeds close
    enough that a cell collapses to a flat watertight-but-zero-volume sheet). Zero-volume cells are
    dropped even though they pass the watertight test — matching the general "degenerate fragments
    are skipped" rule. Volume is measured by the standard signed-tetrahedra (divergence-theorem)
    mesh-volume formula; magnitude is compared against a small epsilon (`<= 0` after abs).
- Each returned cell carries two quality flags, surfaced (never silently swallowed):
  - `uncappedLoops:boolean` — some boundary edges could not be chained into a closed loop during
    capping (non-manifold junction / genuinely open rim).
  - `hullFallback:boolean` — this cell was closed by the convex-hull last resort (§3.4 step 3).

### 3.7 Volume conservation invariant
For a **closed convex** source (the common box/building-proxy case) with no bias, the sum of
`|cell volume|` MUST equal the source volume within relative error `< 1e-6` — the partition is
exact by construction, not an approximation. (For open-shell or hull-closed inputs the sum tracks
the *closed* proxy volume, which may differ from the naive open-shell volume; conservation is
asserted against the pre-closed proxy.)

### 3.8 Convexity caveat (documented degradation, not a bug)
Cells stay convex and caps stay single-loop convex polygons only when the SOURCE mesh is convex. A
concave source can yield a concave or multi-loop cross-section per cut plane. Multi-loop capping
MUST be handled (each loop capped separately); per-loop fan triangulation is exact for convex/
star-shaped loops and approximate for deeply concave ones. An ear-clipping (or better) triangulator
for arbitrary concave caps is UNSPECIFIED / out of scope — implementer free to add it.

---

## 4. Render conversion (cells → GPU geometry)

`facesToBufferGeometry(faces)` converts a cell's face set into one renderable indexed-or-soup
buffer geometry with:
- position + normal attributes (non-indexed triangle soup is acceptable; vertex count a multiple of 3).
- **flat per-triangle normals**, recomputed for both exterior and interior faces. Carrying the
  source mesh's authored smooth normals through the cut is UNSPECIFIED / out of scope — flat-shaded
  debris is the intended look.
- **exactly two material groups**: group 0 = all exterior (original-surface) faces with exterior
  material slot 0; group 1 = all interior (cut/cap) faces with interior material slot 1. A cell with
  only exterior faces (e.g. amount=1) has just group 0. Bounding box + bounding sphere are computed.

This layer and §5 are the ONLY places THREE is imported (plus the hull fallback in §3.4). Interior
material id used to tag cut faces defaults to 1 *(tunable)*; the outer/original faces default to 0.

---

## 5. THREE scene glue

`geometryToTriangles(geometry)` reads a THREE BufferGeometry (indexed or not) into a plain triangle
soup (§1) — the bridge from engine geometry into the pure fracture core.

`fracture(input, opts) -> THREE.Mesh[]`:
- `input` is either a THREE Object3D that has a `.geometry`, or a BufferGeometry directly. Any other
  input throws with a clear message.
- Runs the fracture core on the geometry's LOCAL space, builds one Mesh per cell via
  `facesToBufferGeometry`, assigning a two-element material array `[outer, inner]`.
- **World-pose preservation**: when the input is an Object3D, every fragment mesh is frozen
  (`matrixAutoUpdate = false`) with its matrix copied from the source's `matrixWorld`, so the whole
  fragment set reproduces the source's exact world pose (fracture ran in local space).
- Each fragment mesh carries `userData.rayfire = { index, centroidLocal:vec, aabbLocal:aabb }`
  (and, after `demolish`, `bodyId`).

`demolish(target, opts) -> { meshes, world, bodies, closest }`: runs `fracture`, spawns one rigid
body per fragment in a rigid world (created if not supplied), and applies an impulse to the fragment
whose WORLD-space centroid is nearest a given `point` (a hitscan-style point impulse). Returns the
fragment meshes, the world, the per-body handles, and the nearest fragment index. Exact shapes in
`destruction-api.md`.

---

## 6. Rigid simulation (own lightweight world)

The engine has NO third-party physics dependency; the extension ships its own minimal rigid sim
behind a **swappable backend interface** (`step`, `addBody`, `removeBody`, `getBody`, `raycast`,
`applyImpulse`, `applyAngularVelocity`) so a full physics engine can replace it later without
touching fracture/structural code.

### 6.1 World & body
A world owns bodies keyed by an integer id (ids strictly increasing, never reused within a world).
World construction tunables and their rationale:
- `gravity` default `{0,-9.81,0}` — real-world gravity so authored timings read naturally.
- `groundY` default `0` — a single horizontal ground plane at y=0.
- `sleepLinear` default `0.02` m/s, `sleepFrames` default `10` — a body below the speed threshold
  for that many consecutive steps goes to sleep (velocity zeroed, skipped until re-woken). Keeps
  settled debris cheap and lets consumers detect "at rest".
- `restitution` default `0.05` — nearly inelastic ground bounce (debris, not rubber).
- `friction` default `0.6` — tangential + angular damping applied on ground contact.

A body: `{ id, position:vec, rotation:vec (euler, cosmetic), velocity:vec, angularVelocity:vec,
mass, shape, kinematic:boolean, awake:boolean, sleepCounter }`. Shape is either
`{ type:'sphere', radius }` or `{ type:'obb', halfExtents:vec }` (OBB rotation is tracked for pose
output but treated axis-aligned for contact — full OBB-vs-OBB is out of scope this pass).

### 6.2 Step semantics (per body, per `step(dt)`)
Kinematic or sleeping bodies are skipped by integration. For each active dynamic body:
1. Integrate velocity by gravity, position by velocity, rotation by angular velocity (semi-implicit
   Euler is the reference; exact integrator UNSPECIFIED provided stability at the timesteps used).
2. **Ground contact**: the body's lowest point is `position.y - radius` (sphere) or
   `position.y - halfExtents.y` (OBB). On penetration, clamp the body to rest on the plane, reflect
   downward velocity by `restitution`, and damp horizontal + angular velocity by `friction*dt`.
   A body MUST NOT fall through the ground plane.
3. **Sleep**: accumulate a counter while combined linear+angular speed is below `sleepLinear`; at
   `sleepFrames` consecutive sub-threshold steps, sleep the body (`awake=false`, velocities zeroed).
   Any impulse or activation re-wakes it (`awake=true`, counter reset).

### 6.3 Impulses
- `applyImpulse(id, impulse, mode)` with two modes:
  - default (`'impulse'`): `velocity += impulse / mass` (mass-dependent).
  - `'velocityChange'`: `velocity += impulse` (mass-independent).
  Kinematic bodies ignore impulses. Any impulse wakes the body.
- `applyAngularVelocity(id, angVel)` sets angular velocity directly on a dynamic body and wakes it.

### 6.4 Raycast
`raycast(origin, direction, maxDistance) -> { id, point, distance, normal } | null`: nearest body
along the ray within `maxDistance`. Bodies are tested against their bounding sphere (radius = sphere
radius, or the OBB half-extent length for OBBs — conservative). Direction is normalised internally.
Exact OBB-ray is out of scope.

---

## 7. Demolition orchestration (`demolishMesh`, depth fade)

`demolishMesh(triangles, opts)` wraps the fracture core with per-fragment bookkeeping used by the
structural layer:
- Produces `fragment[]` where each fragment has `faces`, `volume` (absolute signed volume, floored
  at a tiny epsilon so it is safe as a mass/size divisor), `centroid` (mean of its own vertices),
  `aabb`, `index`, `depth`, and a `demolition` descriptor for a hypothetical re-demolition of that
  fragment.
- **Depth-fade of fragment count**: each child fragment's re-demolition amount is
  `nextFragmentAmount(am, dpf)` = `trunc(am * dpf)` clamped to a floor of 3. Rationale: a fragment
  re-shattered later should break into fewer pieces than its parent, never fewer than 3. `dpf`
  (depth-per-fracture factor) default `0.5` *(tunable)*; `depth` increments by 1 each generation.
  Multi-generation recursive re-demolition is not wired end-to-end (the `depth`/`demolition` fields
  exist for a future pass); UNSPECIFIED beyond one level.
- Defaults (`DEMOLITION_DEFAULTS`, all *(tunable)*): amount `am:15`, variation `var:0`, depth-fade
  `dpf:0.5`, contact-bias `bias:0`, seed `sd:1`. Rationale: 15 pieces reads as a satisfying shatter
  at typical building scale without exploding the physics body count.

---

## 8. Anchors (`markUnyielding`, `pointInBox`)

An anchor is a box volume `{ center:vec, size:vec }` that marks the fragments inside it as
**unyielding** (anchored / still standing). `pointInBox(point, box)` is an inclusive point-in-AABB
test (half-size on each axis). `markUnyielding(fragments, box)` sets `.unyielding = true` on every
fragment whose CENTROID lies inside the box, returns the count marked. Fragments outside are left
untouched (their `.unyielding` stays undefined/false). Typical use: anchor a building's ground
floor so the structure stands until the foundation is destroyed.

---

## 9. Connectivity (adjacency, joints, components)

- `buildAdjacency(fragments, opts) -> [[i,j], ...]`: an undirected edge for every pair of fragments
  whose AABBs overlap, optionally expanded by `opts.expand` on all sides (default 0). This is the
  bounding-box adjacency type. Distance-based / mesh-contact adjacency types are UNSPECIFIED /
  not required. Rationale for expand: authored slack so touching-but-not-quite-overlapping AABBs
  still count as connected. Reference expand used by the game: ~0.02.
- `assignJointStrength(edges, fragments, opts) -> joint[]`: turns edges into joints with a per-joint
  break `strength`. Strength = `breakForce +/- breakForceVar` (seeded per joint), clamped `>= 0`,
  optionally scaled by the two endpoints' summed mass when `forceByMass`. Defaults *(tunable)*:
  `breakForce:100`, `breakForceVar:10`, `forceByMass:false`, `seed:1`.
- `breakJoints(joints, forceAt) -> count`: marks a joint broken when the max of the caller-supplied
  per-fragment force `forceAt(i)`,`forceAt(j)` exceeds its strength. Already-broken joints skipped.
- `connectedComponents(fragmentCount, joints) -> number[][]`: connected components over the
  surviving (non-broken) joints (union-find is the reference; any correct component algorithm).
- `partitionByUnyielding(components, fragments) -> { held, released }`: a component containing at
  least one unyielding fragment is `held`; a component with NONE is `released` (fully unsupported →
  it will fall). This is the "whole component releases when it loses every anchor" rule.

---

## 10. Support propagation & stress erosion

- `computeSupport(fragments, joints, opts) -> boolean[]`: breadth-first propagation of support from
  every unyielding fragment outward through surviving joints. A neighbour becomes supported iff the
  direction from the current fragment's centroid to the neighbour's centroid is within `support`
  degrees of straight up (against gravity). Fragments never reached are unsupported. **An unyielding
  fragment is the ONLY source of support** — with zero unyielding fragments, every result is
  `false`. Defaults *(tunable)*: `support:45` degrees (a 45° cone reads as "a fragment can hold up
  what sits roughly above it"), `gravity:{0,-1,0}`.
- `tickErosion(joints, fragments, supported, opts) -> newlyBrokenCount`: one erosion tick.
  Only joints touching an unsupported fragment on at least one side accumulate stress; a joint with
  BOTH endpoints supported never erodes. Per tick a stressed joint accumulates
  `angleRatio * sizeRatio * erosion`, where `angleRatio` = (angle between up and the i→j direction)
  / 180, and `sizeRatio` = volume(j)/volume(i). When accumulated `stress` exceeds `threshold`, the
  joint breaks. Defaults *(tunable)*: `erosion:1`, `threshold:100`, `gravity:{0,-1,0}`. This is the
  continuous "unsupported structure gradually tears itself apart" mechanic, distinct from the
  scripted staged collapse in §11.

---

## 11. Staged collapse (scripted progressive removal)

A scripted alternative to §10's continuous erosion: remove joints in staged waves over a ramping
percentage, driven by the caller's clock. Three removal rules, all seeded and
iteration-order-independent, all of which NEVER remove a joint touching an unyielding fragment:

- `removeByArea(joints, fragments, minArea, opts)`: break each joint whose contact `area` (per-joint
  field, default 1) — optionally jittered by `var` percent, seeded per pair — is below `minArea`.
- `removeBySize(joints, fragments, minSize, opts)`: for each fragment whose own volume (optionally
  `var`-jittered, seeded per fragment) is below `minSize`, break ALL of its joints at once.
- `removeRandom(joints, fragments, percent, opts)`: break each joint with probability `percent`%,
  seeded per pair (so the same joints break first for a given seed; `percent:0` breaks none,
  `percent:100` breaks all).
- `collapseStep(joints, fragments, percentage, opts)`: one step at a `[0,100]` percentage; picks a
  rule by `opts.type` and lerps the rule's threshold between caller-supplied `min/max` bounds by
  `percentage/100`.
- `runCollapseSteps(joints, fragments, opts) -> history[]`: samples `steps+1` points ramping
  `start`→`end` percent, calling `collapseStep` at each and returning `{ step, percentage, removed }`
  per sample. Defaults *(tunable)*: `type:byArea`, `start:0`, `end:75`, `steps:10`, `duration:15`,
  `var:0`, seed `0`. (`duration` is advisory metadata for the caller's own scheduling; these are
  pure step functions with no internal timers.)

The seeding rule is normative: keying the PRNG off `(pairOrShardId + seed)` guarantees replayable
collapse order. The removal-rule constants are the caller's to derive from cluster data.

Removal targets one of three published-standard notions (contact area, fragment size, random
probability); the join-protection rule (skip any joint with an unyielding endpoint) is slightly more
conservative than a per-owning-shard skip and is intentional given the undirected joint model.

---

## 12. Activation (kinematic → dynamic handoff)

Fragments start kinematic (held in place) and become dynamic (fall) when a trigger fires.
`createActivationState(opts)` builds a per-fragment state with trigger toggles. Trigger fields
*(defaults 0/false, tunable per use)*: `off` (offset distance), `vel` (velocity magnitude), `dmg`
(accumulated damage), `con` (activate on connectivity loss), plus `uny`/`atb` (an unyielding,
non-"activatable-too" fragment never activates).

`shouldActivate(state, body, opts) -> boolean`: true iff not already activated, activatable (not a
protected unyielding), and any enabled trigger is met:
- velocity trigger: `vel>0` and body speed `> vel`.
- offset trigger: `off>0` and body has moved farther than `off` from its stored original position.
- damage trigger: `dmg>0` and accumulated `opts.damage` reaches `dmg`.
- connectivity trigger: `con===true` and `opts.connectivityLost===true` (wired from §9's
  `partitionByUnyielding`: every fragment in a released component gets `connectivityLost`).

`activate(state, world, bodyId) -> boolean`: flips the body from kinematic to dynamic, wakes it,
and — only if it is currently perfectly still — adds a small **seeded** random spin (reference
magnitude `0.3` rad/s per axis *(tunable)*) so debris tumbles instead of sliding rigidly. Idempotent
(returns false if already activated or not activatable).

---

## 13. Fade lifecycle

A three-phase per-fragment lifecycle: Living → Fading → Faded. `createFadeState(seed)` seeds the
lifetime jitter deterministically. `tickFade(state, dt, opts)` advances it and returns the mutated
state with `.scale` (current visual scale multiplier, 1 = full) and `.removed` (true once the
fragment should be despawned). Behaviour by fade type:
- `NONE`: never fades (no-op).
- `DESTROY`: after the (seeded, jittered) lifetime elapses, mark removed immediately (pop).
- `SCALE_DOWN`: after the lifetime, shrink **linearly** to zero over `fadeTime`, then remove. Scale
  during fading is `1 - clamp(t/fadeTime)`.
Defaults *(tunable)*: `fadeTime:5`s, `lifeTime:7`s, `lifeVariation:3`s. Rationale: debris lingers a
few seconds then dissolves rather than vanishing abruptly.

---

## 14. Bomb & gun impulses

- `explode(world, fragments, position, opts) -> affected[]`: a radial impulse. Fragments within
  `range` of `position` get an outward impulse of magnitude scaling with strength, a seeded
  `strength..strength+variation%` roll, a distance falloff, and a `*10` gain; plus a seeded random
  spin bounded by `chaos/2` per axis. `forceByMass` selects `'impulse'` vs `'velocityChange'` mode.
  The exact falloff curve is UNSPECIFIED — a clamped linear `1 - distance/range` is the reference and
  satisfies the documented "fades with distance" behaviour. Defaults *(tunable)*: `range:5`,
  `strength:1`, `variation:50`, `chaos:30`, `forceByMass:true`, `seed:1`.
- `shoot(world, origin, direction, opts) -> { hit, impulse } | null`: raycast, then apply a
  `strength`-magnitude impulse along the ray direction to the hit body in `'velocityChange'` mode.
  Torque-from-offset is NOT modelled (linear only — documented simplification). Defaults *(tunable)*:
  `strength:10`, `maxDistance:1000`.

---

## 15. Perf budgets & caps

The fracture path is the expensive step and is what the budgets govern. Reference census (the full
real Empire Earth building set — the acceptance bar the current implementation meets):
- **407 building models**, 7430 total fragments, at `{ seed:7, amount:20 }`.
- **100% of fragments watertight (7430/7430)**, **0 thrown exceptions**.
- Fracture time per model: p50 ~31.7 ms, **p95 ~62 ms**, max ~94 ms (single-threaded, cold JIT,
  M-series dev box).
- A ~2k-triangle mesh at 30 fragments fractures in ~73–79 ms with volume conservation rel-err
  `< 1e-6`.

Requirements derived from these budgets:
- The p95 per-model fracture MUST stay in the tens-of-milliseconds range for census-scale meshes
  (roughly ≤1.1k triangles, ≤~24 fragments); a >2× regression on the census p95 is a failure.
- The layer MUST support **caching** cleanly: the fracture output for a given (model, seed) is pure
  and reusable — no hidden global state, no per-call mutation of inputs — so a consumer can
  pre-warm and share fracture results across many destructions. (The cache itself lives consumer-
  side; the contract here is purity + determinism that MAKE caching correct.)
- Fragment-count caps are enforced consumer-side (the game caps live fragments); the extension MUST
  behave correctly for any requested amount ≥1 and never emit more cells than requested seeds.

---

## 16. Acceptance criteria (numbered, given/when/then)

Behavioural tests the implementation MUST pass. Several are **mutation-discriminating**: they fail a
plausible no-op/stub/wrong implementation, not just a broken one.

**Fracture / geometry**
1. GIVEN a unit box triangle soup WHEN volume is measured THEN it equals 1 within 1e-9 (validates
   winding + volume formula).
2. GIVEN a closed box WHEN watertight-checked THEN true; GIVEN a single open triangle THEN false
   (discriminator: the checker actually detects unpaired edges).
3. GIVEN a 2×2×2 box fractured into ~20 fragments WHEN summing `|cell volume|` THEN it equals the
   box volume (8) within rel-err 1e-6 (exact partition, discriminates an approximate/overlapping
   split).
4. GIVEN any box fracture WHEN each cell is watertight-checked THEN ALL cells are watertight.
5. GIVEN the same (mesh, seed) fractured twice THEN the two cell sets are byte-identical after
   rounding (determinism).
6. GIVEN two DIFFERENT seeds THEN the cell sets differ (discriminator against a seed-ignoring stub).
7. GIVEN a fracture WHEN inspecting faces THEN at least one interior (cut) face is tagged with the
   interior material id AND at least one exterior face keeps the exterior material id.
8. GIVEN amount=1 (single seed) THEN exactly one cell is returned, it has NO interior faces, and its
   volume equals the whole source (no spurious cutting).
9. GIVEN strong contact bias toward one corner THEN a dominant large fragment exists on the far side
   (bias observably clusters seeds).
10. GIVEN an OPEN-SHELL source (not watertight as authored) fractured THEN every returned fragment
    is watertight and has positive volume (the core real-asset guarantee; discriminates an
    implementation that skips open-shell closure).
11. GIVEN a paper-thin source that can produce a zero-volume sliver cell THEN that cell is dropped
    (no zero/negative-volume fragment is ever returned).
12. GIVEN a ~2k-tri mesh at amount 30 THEN fracture completes, returns >1 cell, conserves volume
    (rel-err <1e-6), and its timing is reported.

**Render / THREE glue**
13. GIVEN the engine's THREE build WHEN checked THEN it is the exact expected major revision and a
    BoxGeometry round-trips through `geometryToTriangles` to 12 triangles with numeric vertices.
14. GIVEN `fracture(BufferGeometry)` THEN each result is a THREE Mesh with a BufferGeometry, a
    2-element material array, a positive vertex count that is a multiple of 3, and ≥1 material group.
15. GIVEN `fracture(Object3D)` with a non-identity world transform THEN every fragment's matrix
    equals the source `matrixWorld` exactly (world-pose preservation; discriminates a local-space
    stub).
16. GIVEN `fracture(Object3D)` THEN the fragments' reconstructed world-space volume matches the
    source's world-space volume within rel-err 1e-5.
17. GIVEN `demolish(Object3D, {point, impulse})` THEN it spawns one body per fragment, the world
    holds exactly that many bodies, and the impulsed fragment is the one nearest `point`
    (discriminator: not the first fragment, the nearest).

**Rigid sim**
18. GIVEN a sphere dropped above the ground WHEN stepped THEN it settles resting on the plane
    (lowest point at groundY within 0.05) and eventually SLEEPS (never falls through).
19. GIVEN `applyImpulse` THEN `'velocityChange'` is mass-independent and default `'impulse'` scales
    by 1/mass (discriminator on the two modes: a 10-impulse on mass-10 yields Δv=1 in impulse mode,
    Δv=10 in velocityChange mode).
20. GIVEN two spheres along a ray THEN `raycast` returns the NEARER one's id.

**Demolition**
21. GIVEN `nextFragmentAmount` THEN it equals `trunc(am*dpf)` clamped to ≥3, exactly (e.g.
    (15,0.5)→7, (5,0.5)→3, (100,0.1)→10, (1,0.5)→3).
22. GIVEN `demolishMesh` THEN summed fragment volume is conserved (rel-err <1e-6) and every
    fragment's child `demolition.am` equals `nextFragmentAmount(parentAm, dpf)`.

**Anchors / connectivity**
23. GIVEN an anchor box THEN only fragments whose centroid is inside are marked unyielding; the
    marked count is correct; outside fragments stay unmarked (discriminator: centroid test, not
    AABB-overlap).
24. GIVEN a 4-fragment chain THEN `buildAdjacency` connects only touching neighbours (0-1,1-2,2-3).
25. GIVEN the chain with fragment 0 anchored, breaking the MIDDLE joint THEN
    `connectedComponents`+`partitionByUnyielding` yields exactly one held component {0,1} and one
    released component {2,3} (end-to-end split correctness).

**Support / stress**
26. GIVEN a straight vertical stack anchored at the base THEN `computeSupport` returns all-true
    through the 45° cone.
27. GIVEN a fragment offset OUTSIDE the support cone THEN it (and anything only reachable through it)
    is NOT supported (discriminator on the cone angle, not mere adjacency).
28. GIVEN a supported stack WHEN the base's unyielding flag is cleared THEN `computeSupport` returns
    all-false (an anchor is the only support source).
29. GIVEN an unsupported stack WHEN `tickErosion` runs repeatedly THEN some joint breaks within a
    bounded number of ticks; AND a fully supported joint NEVER erodes (two discriminators).

**Collapse**
30. GIVEN `removeByArea` with a threshold between joint areas THEN only sub-threshold joints break.
31. GIVEN a joint touching an unyielding fragment THEN NO removal rule ever breaks it (protection
    invariant, all three rules).
32. GIVEN `removeBySize` on a too-small fragment THEN ALL of that fragment's joints break at once.
33. GIVEN `removeRandom` run twice with the same seed THEN identical break pattern; `percent:0`
    breaks none, `percent:100` breaks all (determinism + bounds).
34. GIVEN `runCollapseSteps` with steps=4, start=0, end=100 THEN it returns 5 samples ramping
    0→100 and by the last step every joint is broken.

**End-to-end crumble (the integration the game drives)**
35. GIVEN a fractured building: anchor the ground band, confirm `computeSupport` has ≥1 supported
    fragment; THEN clear all unyielding and confirm `computeSupport` is now ALL false; THEN activate
    every fragment (connectivity trigger) and step the world to rest — every fragment's Y position
    drops, every body reaches sleep within a bounded step count, and NONE fall through the ground.
36. GIVEN a live crumble handle WHEN `dispose()` is called THEN every fragment mesh is removed from
    its group AND its physics body is removed from the world (no leaked bodies) AND the handle is
    marked done (mutation discriminator: a stub that only hides meshes but leaks bodies FAILS).
37. GIVEN a `SCALE_DOWN` fade run to completion THEN `.scale` reaches 0 and `.removed` becomes true;
    GIVEN `NONE` fade THEN `.scale` stays 1 and `.removed` stays false forever (discriminator on
    fade type).
38. GIVEN the extension entry `register()` called with NO argument THEN it returns
    `{ name:'rayfire', api }` and `api` exposes EVERY name listed in `destruction-api.md` §API
    surface (drop-in guarantee: the consumer calls `register().api` and destructures these).

---

## 17. UNSPECIFIED (implementer free)

Each item below could NOT be pinned to a required behaviour; the implementer chooses, as long as
§16 passes.

- U1. The specific deterministic PRNG algorithm and the per-use decorrelation mixing constants (§2).
- U2. The fracture method itself (library vs. per-cell half-space clipping) — only the OUTPUT
  contract (§3.1) is fixed.
- U3. Contact-bias falloff curve (§3.2) — linear pull is the reference, any monotonic pull allowed.
- U4. Amount-variation distribution shape (§3.2).
- U5. Exact coordinate precision used for watertight edge keys (§3.5) — must be internally
  consistent.
- U6. Weld-epsilon ladder values and the absolute-final box-closure trigger point (§3.4) — reference
  ladder given, tunable.
- U7. The hull-triangle exterior/interior tagging heuristic (§3.4) — reference given, not exact.
- U8. Ear-clipping / concave-cap triangulation (§3.8) — out of scope; convex/star-shaped only.
- U9. Smooth-normal carry-through (§4) — flat normals only this pass.
- U10. Numeric integrator for the rigid step (§6.2) — semi-implicit Euler reference.
- U11. Exact OBB contact and OBB-ray intersection (§6.1, §6.4) — sphere-bound approximation used.
- U12. Multi-generation recursive re-demolition wiring (§7) — single level only; fields reserved.
- U13. Distance-based / mesh-contact adjacency types (§9) — only bounding-box adjacency required.
- U14. Bomb distance-falloff curve (§14) — linear reference.
- U15. Gun torque-from-offset (§14) — linear velocity change only.
- U16. Random-spin magnitudes on activation and bomb chaos (§12, §14) — references given, tunable.
- U17. Any parameter tagged *(tunable)* in this document — value is the implementer's, subject to
  §16 acceptance.

---

## 18. Self-check note

This spec was grepped for third-party C# type/method identifiers before commit (see the commit
message / task return). No third-party class, method, field, or file-layout identifier appears in
this document; the only proprietary-adjacent tokens are the PUBLIC API names this engine already
owns and exports (listed in `destruction-api.md`). Standard algorithms are named with public
citations only. The implementer of this spec must never read the licensed source or any prior port.
