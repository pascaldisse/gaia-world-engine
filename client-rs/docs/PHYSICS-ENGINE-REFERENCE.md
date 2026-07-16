# Voxel Physics Engine — Technical Reference

A detailed architectural overview of a Teardown-class voxel-destruction physics
engine: the data model, the multithreaded simulation graph, and the concrete
mechanics behind destruction, rigid bodies, mass, joints/ropes, fluids, smoke and
fire. Written as an implementation reference — everything here is intended as
directly buildable design input for the GAIA Rust engine.

Companion: `research/physics-recon.md` (public literature + Rust make-or-buy).
This document is the concrete engine model that recon informs.

---

## 1. Design philosophy

The whole engine is built on **one uniform primitive: the voxel on a regular
grid.** Every design decision follows from that choice:

- Destruction is trivial to represent — you clear voxels from a grid, you don't
  re-mesh or boolean surface geometry at runtime.
- Physics and graphics share the same volume data, so a hole punched for physics
  is the same hole you render.
- Collision, mass, connectivity and rendering all reduce to grid operations that
  parallelize cleanly.

The cost you accept: large worlds are hundreds of millions of voxels, so the grid
representation must be compact (1 byte/voxel) and the physics collision data is
**regenerated from the master voxel data on load**, never stored in saves.

Design rule for GAIA: **keep one authoritative voxel volume per shape; derive
everything else (collision mesh, mass, render mesh, mip pyramid) from it, and
make every derivation incremental so damage only re-derives the touched region.**

---

## 2. Data model

### 2.1 Voxel
- **1 byte per voxel** = index into a per-shape **material palette** (≤ 255
  materials per volume; 0 = empty). The palette entry carries both **visual** and
  **physical** properties, so material type drives physics directly.
- Voxel edge length ≈ **0.1 m** (10 cm). This is the fundamental spatial quantum.

### 2.2 Material (palette entry)
Each palette slot stores:
- `type` — physical class (wood / plastic / masonry / metal / glass / dirt /
  foliage / …). Governs default **density**, **strength**, and flammability.
- PBR: `reflectivity`, `shininess`, `metalness` (each 0–1), `emissive` (0–32).
- Physics overrides: `density`, `strength`, `friction`, `frictionMode`,
  `restitution`, `restitutionMode`, `emissiveScale`.

### 2.3 Shape (`VoxelObject`)
A voxel grid + a local transform inside a body:
- `size` in voxels (x,y,z), a solid voxel count, and the palette.
- Addressable both by integer grid index `(x,y,z)` and by world position.
- Carries a **collision filter**: an 8-bit **layer** + 8-bit **mask**. Two shapes
  collide iff each one's layer bit is set in the other's mask (bidirectional).
- Large worlds store voxels in **chunks** (mip 0 offset + chunk dims) for
  streaming, culling and partial re-bake.

### 2.4 Body (`Body`)
A rigid transform + linear/angular velocity that **owns one or more shapes**:
- `dynamic` flag (dynamic vs static/kinematic).
- Mass, center of mass, inertia tensor — all **derived** (see §5), not authored.
- **Compounds**: multiple authored shapes merged into a single `VoxelObject` at
  load for performance; only the compound's own properties survive at runtime.

Ownership is fluid: **a shape can be transferred to a new body during
destruction** (§6). "Broken" is a per-shape state, and a shape may move to a new
body yet still not count as broken if all its voxels are intact.

---

## 3. Simulation architecture — a job graph

The engine runs on a **work-stealing job system** (`TJobManager`) that dispatches
`JobGroup<T>` batches across worker threads. Each simulation stage is its own job
group, and the per-frame ordering is the classic rigid-body loop, fanned out:

```
                    ┌─ FrustumCulling (CullShapeJob / CullLightJob)   [render feed]
  BroadPhaseJob ──► NearPhaseCollectJob ──► NearPhaseAddContactJob ──► CollisionDataTask
       │                                                                    │
       │                                                                    ▼
       └───────────────────────────────────────────────────────►  TSolver::TSolverJob
                                                                            │
                                                                            ▼
                                                                 ShapeInterpolationJob
Parallel per-frame tracks (own job groups):
  Bodies/Joints/Voxels async:  AsyncRange<Physics>::RangeTask,
                               AsyncCall<Body|Joint|VoxelObject>::CallTask
  Destruction re-bake:         VoxelObject::PaintSlicesTask
  Joints & ropes:              Joint::FillSegmentDataJob ──► Joint::MeshGenerationJob
  Fluid / smoke (SPH):         PreSimulationJob ──► FluidSetupJob ──► SetupProximityJob
                               ──► PostSimulationJob ──► MeshGenerationTask
  Water / buoyancy:            WaterJobWrapper, BodyWaterTask, ShapeWaterTask
  Fire:                        FireSystem::update ──► FirePositioningJob
  Queries:                     sphereCheckHitsMultiThread ──► RaycastJob (batched)
```

Key structural takeaways for GAIA:
- **Every stage is a batch over homogeneous work items** — ideal for Rayon /
  a `gaia-ecs` command-buffer parallel-for. No per-object virtual dispatch on the
  hot path; the job *is* the loop.
- **Broad → near → contacts → solve → interpolate** are separate passes with
  explicit hand-off buffers, not a monolithic step. This is what makes it
  scalable and what makes multithreading safe (each pass reads the previous
  pass's output, writes its own).
- `ShapeInterpolationJob` decouples the fixed-rate physics tick from the render
  frame (render interpolates between last two physics poses).

---

## 4. Rigid-body dynamics

### 4.1 Broadphase → narrowphase
- **Broadphase** (`BroadPhaseJob`) finds potentially-overlapping shape pairs
  (AABB / grid). Collision filter (§2.3) prunes here.
- **Narrowphase** (`NearPhaseCollectJob` → `NearPhaseAddContactJob`) generates a
  **contact manifold** per pair — contact points, normals, penetration depth —
  by testing surface voxels of one shape against the other's grid.
- `CollisionDataTask` packs manifolds into a solver-friendly contact array.

### 4.2 Contact solver
- `TSolver::TSolverJob` is an **iterative constraint solver** over contacts +
  joints. Contacts use a standard **Coulomb friction + restitution** model, both
  configurable **per material** (`friction`/`frictionMode`,
  `restitution`/`restitutionMode`).
- Recommended implementation (matches the architecture and the recon's Small-Steps
  finding): **sub-stepped sequential-impulse / XPBD** — several small substeps
  per frame, ~1 iteration each, rather than one big step with many iterations.
  Substepping is where stability and large-mass-ratio behavior (a heavy body on a
  light one, long chains) actually come from.
- Position drift corrected with Baumgarte/soft-constraint bias or XPBD compliance.

### 4.3 Queries
Raycasts and sphere-casts run as **batched multithreaded jobs** (`RaycastJob`),
returning hit shape, material, and the exact voxel index `(x,y,z)` struck — the
same query destruction and tools use to find impact voxels.

---

## 5. Weights & mass — derived from density × voxels

Mass is **never authored directly.** It is integrated from the voxel grid:

```
body.mass            = Σ_shapes Σ_solid_voxels ( material.density × voxelVolume )
body.centerOfMass    = ( Σ voxel.pos × voxelMass ) / body.mass          // mass-weighted centroid
body.inertiaTensor   = Σ voxelMass × secondMoment(voxel.pos − centerOfMass)
```
- `voxelVolume = (0.1 m)³` per solid voxel.
- Authoring knobs: **density scaling** per shape ("scale default density for all
  materials — make objects lighter or heavier") and per-material density.
- **Critical rule: mass, CoM and inertia are recomputed whenever a shape's voxel
  content changes** (destruction, carving, split). A carved wall's remaining
  fragment gets a correct new mass/CoM/inertia, which is what makes toppling and
  balance look right. Cache per-shape mass aggregates so you re-integrate only
  the changed shape, not the whole body.
- Vehicle stability exposes this directly: an "anti-tip" control that behaves
  "similar to lowering the center of mass" — i.e. the CoM used by the solver is
  the derived one, and gameplay can bias it.

---

## 6. Destruction — carve, then split by connectivity

This is the heart of the engine. Two phases: **material removal**, then
**connectivity resolution.**

### 6.1 Material removal (carving)
- An impact/explosion/tool produces a region of force. Voxels whose material
  **strength** is exceeded by the local force are **cleared** (set to 0).
  `strength` is per-material with a per-shape **strength scale** ("higher value
  makes shape less prone to breakage"); explosions have a global
  `explosion.strength`.
- Removal is a grid write over the affected chunk(s). The touched voxel slices
  are re-baked by `VoxelObject::PaintSlicesTask` (collision + render + mip
  pyramid for just that region).

### 6.2 Connectivity resolution (the "island" pass)
After voxels are removed, the shape may have split into disconnected pieces:
- A **connected-component (flood-fill) pass** over the changed region finds
  separate voxel **islands** (6- or 26-connectivity).
- Each island that is no longer connected to the shape's anchor becomes a **new
  shape on a new dynamic body** (`SplitShape` — "split a shape into multiple
  shapes based on connectivity"). Small residual chunks can be culled to bound
  the new-body count.
- New bodies inherit velocity from the parent at their location and get freshly
  derived mass/CoM/inertia (§5).
- Inverse op: **`MergeShape`** re-welds aligned, touching shapes back into one
  (e.g. debris settling, or re-attachment), and `TrimShape` shrinks a shape's
  grid to its occupied bounds.

### 6.3 Structural / support behavior
Static structures stay put because they are anchored (static bodies / connection
to world). When a support island loses its connection to an anchor, it becomes
dynamic and falls. GAIA's design intent (recon §3) goes one step further —
**derive a stress signal from the solver's constraint forces** to pre-fracture
overloaded structure — which has no published prior and is open ground.

### 6.4 Determinism note
The original engine is **not deterministic**; the multiplayer variant switched
destruction to **fixed-point integer** math and replicates an **ordered command
stream** (voxel cuts, shape-ownership changes, joint reconnects) rather than
state. If GAIA ever wants networked/replayable destruction, choose fixed-point +
command replication **early** — it is a representation decision, not a retrofit.

---

## 7. Joints, ropes & bending

### 7.1 Joints
`Joint` supports hinge / ball / prismatic / (rope) types with:
- Angular limits and a **rotational strength** ("set to zero for a freely
  rotating joint" — i.e. a motor/spring stiffness term).
- Prismatic "disable when sliding apart" (breakable slider).
- Optional **collision between jointed shapes** (default off).
- Joints are extra constraint rows solved by the **same `TSolver`** as contacts.

### 7.2 Ropes & bending (data-level)
Ropes are a **special joint type rendered as a visible wire between two
attachment locations**, implemented as a **chain of segment particles**:
- Each rope segment particle stores a `neighborsMask` of `kPrevRopeSegmentBit` /
  `kNextRopeSegmentBit` — a doubly-linked segment chain.
- `Joint::FillSegmentDataJob` builds the segment list; `Joint::MeshGenerationJob`
  builds the deformable rope mesh each frame.
- "Bending" is emergent: many short **distance/segment constraints** solved by
  the solver make the rope sag under gravity and drape over geometry.
- **Rope strength** limits tension ("negative = infinite"); exceed it and the
  rope breaks (`BreakRope`) — split the segment chain into two.

Design takeaway: model ropes/cables/chains as segment-particle chains in the same
particle+constraint system as fluids (§8), not as a bespoke subsystem.

---

## 8. Fluids & water

Two distinct systems, used together.

### 8.1 Particle fluid (SPH)
Runs as the `ParticleSystem` job chain: `PreSimulationJob → FluidSetupJob →
SetupProximityJob → PostSimulationJob → MeshGenerationTask`.

Confirmed model & data:
- **Smoothed-Particle-Hydrodynamics** around a **rest density**
  `kRestDensity = 5.0`. `FluidSetupJob` computes per-particle `avgDensity`, and
  pressure is derived from the deviation from rest density.
- `SetupProximityJob` = **neighbor search** (spatial grid / hash binning).
- System params: `mubParticleSystemParams = (fluidDynamic, liquid, timeStep)` —
  particles can behave as dynamic fluid or ballistic, with a `liquid` flag.
- **Particle record** (the SoA you should mirror):
  `position, lastPos, vel, avgDensity, radius, life, rotation, stretch,
  color, emissive, mask`.
  `lastPos + vel` ⇒ **Verlet / position-based integration** (stable, cheap).
- Pipeline per frame: bin neighbors → compute density & pressure (vs
  `kRestDensity`) → apply pressure + viscosity + gravity forces → integrate
  (Verlet) → collide against the voxel grid → generate surface mesh
  (`MeshGenerationTask`, billboarded/meshed particles).

### 8.2 Volume water & buoyancy
Bodies overlapping a water volume are handled by `WaterJobWrapper`,
`BodyWaterTask`, `ShapeWaterTask`:
- Per submerged shape/body, compute submerged volume and apply **buoyancy
  (∝ displaced volume) + drag** each frame. Because mass is voxel-derived (§5),
  whether an object floats or sinks falls out naturally from its material density
  vs. water density — a hollow wooden crate floats, a solid metal block sinks.
- Surface presentation: **foam** (composite mode add/mul/off) and **splash
  particles** on entry/impact.

Rust mapping: **Salva** (DFSPH/IISPH) with two-way **Rapier** coupling covers
8.1+8.2 as a starting point; the voxel-collision coupling is the custom part.

---

## 9. Smoke, fire & heat

### 9.1 Fire & heat
- `FireSystem::update(float dt)` advances fire; `FirePositioningJob` places active
  fire instances. Heat is a **field over flammable voxels**: `AddHeat(shape, pos,
  amount)` deposits heat; when a voxel's accumulated heat crosses ignition it
  **ignites, burns (consuming/charring the material), and spreads to neighbors**
  at rate `fire.spread`. `GetFireCount` reads active fires; `SpawnFire(pos)`
  seeds one.
- Fire emits **smoke** and light (emissive), and can burn through material to
  open new holes — coupling back into destruction (§6) and smoke flow.

### 9.2 Smoke
- Smoke is **GPU particles** flagged `kIsParticles (1<<5)` in the g-buffer,
  emitted via the particle system (`FxEmitSmokeCPP`) and advected as buoyant
  particles that collide with surroundings and escape through new holes.
  `smokeintensity` scales emission.

### 9.3 Volumetric rendering (height fog)
Smoke/atmosphere is composited through an **analytic exponential height-fog**
model with a closed-form ray integral (no per-step marching for the bulk):
```
fogParams = ( FogStart, 1/FogDist | FogDensity, FogMax, HeightExponent )
density(X)          = u1 · exp( −u2 · (X.y − heightOffset) )
transmittance(ray)  = closed-form integral of density along the ray:
                      ∝ exp(−w·z_start) · (1 − exp(−falloff)) / falloff
```
Particles fade near the camera and jitter along the view normal to hide voxel
banding. Sun scattering adds `SunFogScale / SunLength / SunSpread` terms.

---

## 10. Vehicles

`Vehicle` + `Wheel` on the rigid-body solver:
- Wheels = suspension + drive + steering **constraints** on the chassis body.
- **Tire friction** per vehicle ("increase slightly for small/sports cars"),
  **engine strength** (accel ∝ strength), and an **anti-tip** term that biases
  the effective CoM to stop rollover without looking weird.
- Boats use a `propeller` engine location; buoyancy (§8.2) floats the hull.

---

## 11. Rendering coupling (why the physics model is render-friendly)

- Shapes render from **3D voxel textures with a mip pyramid**
  (`uVoxelTex`, `VoxelTextureMips`); `objSize × voxelSize` places them in world
  space. Empty-voxel culling reports rendered/total counts.
- The **same `PaintSlicesTask`** that updates collision after damage updates the
  render voxel texture + mips — one re-bake feeds both, only for touched slices.
- Particles (smoke, fluid, debris sparks) render as camera-oriented billboards
  (orientation modes: random / straight / z-up), meshed by `MeshGenerationTask`.
- Lights attached to a shape auto-disable when the shape breaks and scale with
  its emissive scale — destruction and lighting stay consistent for free.

---

## 12. Adapting to GAIA (Rust) — build plan

| Subsystem | Reference model | Rust starting point |
|---|---|---|
| Voxel volume | 1 byte/voxel palette, chunked, 0.1 m | custom crate (`gaia-voxel`), SoA chunks |
| Rigid bodies + contacts + joints | broad→near→contacts→substepped impulse/XPBD | **Rapier** (determinism-capable) or custom XPBD |
| Mass/CoM/inertia | integrate density over voxels, recompute on damage | custom, incremental per shape |
| Destruction | strength-gated voxel clear → connectivity islands → split bodies | custom flood-fill on changed chunks |
| Ropes/cables | segment-particle chains + distance constraints | shared particle+constraint solver |
| Fluid (SPH) | rest-density SPH, Verlet, neighbor grid | **Salva** (DFSPH) + Rapier coupling |
| Buoyancy | displaced-volume force from voxel-derived mass | custom on top of Rapier |
| Smoke/fire | heat field on flammable voxels + buoyant GPU particles + height fog | custom sim + wgpu volumetrics |
| Rendering | 3D voxel textures + mips, incremental re-bake, billboards | wgpu, shared re-bake with collision |

Guiding principles carried over:
1. **One voxel volume is the source of truth**; collision mesh, render mesh, mass
   and mips are all derived and incrementally re-derived on damage.
2. **Simulation is a graph of homogeneous batch jobs**, not per-object stepping —
   fits Rayon + `gaia-ecs` command buffers.
3. **Substep the solver** (Small-Steps): many tiny steps beat few big iterations
   for chains, ropes, stacked mass ratios.
4. **Unify ropes, granular, fluids** into one particle+constraint solver; keep
   large rigids as bodies+constraints (shape-matched rigids don't scale to
   buildings).
5. **Decide determinism early** (fixed-point + command replication) if networked
   or replayable destruction is ever a goal.

---

## Appendix — confirmed constants & parameters

| Name | Value / meaning |
|---|---|
| Voxel edge | ≈ 0.1 m |
| Material index | 1 byte/voxel, ≤255 materials/volume, 0 = empty |
| PBR ranges | reflectivity/shininess/metalness 0–1, emissive 0–32 |
| Collision filter | 8-bit layer + 8-bit mask, bidirectional match |
| SPH rest density | `kRestDensity = 5.0` |
| Particle params | `(fluidDynamic, liquid, timeStep)` |
| Particle record | position, lastPos, vel, avgDensity, radius, life, rotation, stretch, color, emissive, mask |
| Rope segment | doubly-linked via `kPrev/NextRopeSegmentBit`; strength (neg = ∞) |
| Material physics | density, strength, friction(+mode), restitution(+mode) |
| Shape authoring | density scale, strength scale, per-shape collision toggle |
| Vehicle | tire friction, engine strength, anti-tip CoM bias |
| Fire | `fire.spread` rate, `AddHeat(shape,pos,amount)`, ignition per flammable voxel |
| Smoke | GPU particle flag `kIsParticles = 1<<5`, `smokeintensity` |
| Fog | `(FogStart, 1/FogDist|Density, FogMax, HeightExponent)`, exp height falloff, closed-form ray integral |
| Explosion | global `explosion.strength` vs per-material strength |
