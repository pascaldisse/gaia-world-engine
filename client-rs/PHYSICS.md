# PHYSICS — DreamForge unified physics spec (DRAFT for Pascal's ruling, 2026-07-16)

Status: DRAFT. Primary design input: docs/PHYSICS-ENGINE-REFERENCE.md
(Pascal's reference — "not to copy... make out of it whatever you like").
Evidence: research/{physics,softbody,destruction-survey,neural}-recon.md +
RayFire mining. Laws: own UNIFIED engine, one solver, rigid+soft+bending+
destruction+gas, with AND without voxels, "crysis+teardown+mercenaries+
just cause+hl2 BUT BETTER" — inspiration only, everything built ours.
Never-optimize applies: content scale never forces authoring compromises.

## 0 · Divergences from the reference (named, deliberate)
- Reference offers Rapier/Salva as starting points → OVERRIDDEN: own
  XPBD-family solver (standing order; no Rust unified solver exists; the
  reference's own contact solver recommendation — substepped impulse/XPBD —
  IS our frame).
- Reference is voxel-centric → ours is REPRESENTATION-BLIND: polygon
  entities and voxel shapes feed ONE constraint graph (pillar: works with
  and without voxels).
- Reference's two solvers (rigid TSolver + SPH particles) → ours is ONE
  solver, two granularities: bodies+constraints and particles+constraints,
  same substep loop, same constraint kernels.

## 1 · Solver core — one constraint graph
- XPBD-family, SUBSTEPPED (Small-Steps: n substeps × 1 iteration beats
  1 step × n iterations; 100 substeps: 3.2m vs 322m error at 1:100k mass
  ratio). Substep count + iteration count = the quality dials.
- Constraint kernels (all materials = params from the materials library):
  contacts (Coulomb cone friction + restitution, per-material modes) ·
  distance (compliant; covers beams — RoR/BeamNG {k,d,L} maps 1:1 to
  {α,damp,rest}) · unilateral/limit variants (support/rope/shock patterns)
  · actuated rest-length (steering/hydraulics — the hydro pattern) ·
  joints (hinge/ball/prismatic; rotational strength/motor; breakable;
  optional inter-shape collision, default off) · volume/area/bend (true
  soft bodies — what node-beam can't express) · shape anchoring for rigids
  as BODIES (shape-matched rigids don't scale to buildings — Flex caveat).
- Stability law: stiffness NEVER binds the global timestep (the 2000Hz
  lesson — that rate is the tax explicit integration pays; we don't pay it).
- Islands: sleeping + island-parallel solve; big objects parallelize
  INSIDE (fixes BeamNG's one-vehicle-one-thread ceiling).

## 2 · Bodies — representation-blind
- Mass/CoM/inertia NEVER authored — derived (reference §5):
  mass = Σ density×volume · CoM = mass-weighted centroid · inertia = second
  moments. Recomputed incrementally on any content change (carve/split/
  merge) — toppling and balance correct for free. Authoring knobs: density
  scale per shape, per-material density (materials.json grows density/
  strength/friction/restitution/flammability — palette model).
- VOXEL shapes: 1 byte/voxel palette grid (≤255 materials, 0=empty,
  ~0.1m default edge — PARAM, never hardcoded), chunked; ONE authoritative
  volume per shape — collision, mass, render texture, mips ALL derived,
  incrementally, touched-region-only (one re-bake feeds physics AND render
  — GEOMETRY.md contouring kernel is that re-bake).
- POLYGON entities: collider proxies (existing collider component) +
  optional pre-fracture data (shards + neighbor graph + contact areas +
  anchors — the RayFire problem-list as authored JSON; offline fracture
  tool in tools/).
- Collision filter: 8-bit layer + mask, bidirectional (reference §2.3).
- Compounds merge at load; shape ownership FLUID — shapes transfer to new
  bodies during destruction.

## 3 · Destruction — dissolves into the solver
- VOXEL path (reference §6): force field vs per-voxel material strength →
  clear voxels → flood-fill changed region (6/26-connectivity) → islands
  losing anchor become new dynamic bodies (inherit velocity at location,
  derived mass) → incremental re-bake. MergeShape re-welds; TrimShape
  shrinks bounds; tiny-island culling bounds body count.
- POLYGON path: shard glue = compliant constraints with STRENGTH BUDGETS —
  same constraint type as everything; break = constraint over budget →
  removal → islands separate, already bodies, no seam. (RayFire's parallel
  graph machinery existed only because PhysX was a black box — we own the
  solver.)
- STRESS (the open-ground feature, no published prior): read constraint
  forces the solver already computes per substep → load propagation
  through structures falls out; support = anchor-connectivity + force
  thresholds. RFG's top-down mass-sum scan = prior art proving gameplay
  value on 2009 hardware (Havok said it "would not work" — it shipped);
  ours is solver-native, material-aware (stone crumbles ≠ metal bends:
  per-material strength/plasticity — the thing RFG never had). Audio hook:
  stress signal sonified (creaks before failure — RFG's trick, kept).
- Runtime fracture of unfractured content: force events synthesize local
  fracture (voxel: carve directly · polygon: on-demand shard split via
  contouring kernel) — no pre-authoring required, pre-fracture = quality
  upgrade, never a requirement (never-optimize).

## 4 · Particles — same solver, small granularity
- ONE particle+constraint system serves: ropes/cables/chains (segment
  chains, doubly-linked, distance constraints; tension limit → break =
  chain split) · granular (contact-only particles) · SPH fluid
  (rest-density model, neighbor grid, pressure+viscosity, Verlet/position-
  based — reference §8 record layout adopted: pos/lastPos/vel/avgDensity/
  radius/life/rotation/stretch/color/emissive/mask) · cloth (distance+bend
  over particle grids).
- Buoyancy: displaced volume × water density vs derived body density —
  wooden crate floats, metal block sinks, zero authoring (reference §8.2).
- Fluid↔voxel/collider coupling: particles collide against grids and
  colliders; two-way forces on bodies.

## 5 · Gas, fire, heat
- Heat = field over flammable voxels: AddHeat deposits; ignition threshold
  → burn (consume/char material = destruction coupling) → spread at
  material rate. Fire emits light (emissive = lighting, pillar: emitters)
  + smoke.
- Smoke = buoyant particles colliding with occupancy (escapes through new
  holes — the Teardown demo moment); bulk atmosphere = analytic exp
  height-fog (closed-form ray integral, no marching) — slots into the path
  integrator as participating media, not a separate look.

## 6 · Vehicles
- Wheels = suspension/drive/steer constraints on chassis body; tire
  friction + engine strength + anti-tip CoM bias (reference §10) as the
  arcade tier. Simulation tier: node-ring wheels + Coulomb-cone contact —
  tire feel EMERGES from geometry (BeamNG subsumption, zero tire curves).
  Both tiers = same solver, different constraint sets. Boats: propeller +
  buoyancy. ArcadeVP parity constants preserved for boomtown (PARITY.md).

## 7 · Scheduling — job graph (reference §3 adopted)
- Homogeneous batch passes with explicit hand-off buffers: broad → near →
  contact pack → substepped solve → interpolate; parallel tracks:
  destruction re-bake · particle sim · queries (batched raycasts returning
  shape+material+voxel index). Rayon + gaia-ecs command buffers.
- Fixed physics tick; render interpolates between poses. Budget-scheduled
  islands: active = exact, far = coarse/sleeping (never-optimize: drop a
  city in, the frame holds).

## 8 · Determinism — decided EARLY (reference §6.4)
- Ruling proposal: fixed tick + ordered command replication for
  destruction (voxel cuts, ownership transfers, joint changes) — GAIA's
  protocol IS already an ordered op stream (natural affinity). Fixed-point
  destruction math = milestone P5 gate, not a retrofit.

## 9 · Neural surrogates — staged experiments, never dependency
Far-field physics LOD + fluid detail upsampling per neural-recon
(165-5000× real, zero shipped precedent). Behind the exact solver, always.

## 10 · Milestones (each playable, test-gated, cheapest-agent-verified)
P1 solver core: bodies+contacts+joints, substepped; gate: 1:100k mass-
   ratio chain stable, stack of 100 sleeps, Xcode limiter capture.
P2 voxel shapes: palette grids, derived mass, carve→split→re-bake; gate:
   shoot a wall, islands fall correctly, mass/CoM verified numerically.
P3 stress: constraint-force readout + anchors; gate: remove building's
   support columns one by one → progressive collapse, creak audio hook.
P4 particles: ropes+fluid+buoyancy; gate: rope bridge cut mid-span under
   load; crate floats, anvil sinks.
P5 gas/fire + determinism: heat/ignite/spread, smoke through holes;
   fixed-point destruction replay = identical twice.
P6 vehicles + boomtown: arcade tier drives boomtown traffic at parity;
   sim tier crushes a car against a wall (crumple from constraints).

## Open questions for Pascal
1. Interleave point vs RENDER milestones (physics P1 after R2 or R4?)
2. Voxel default edge 0.1m — confirm as world default param?
3. Determinism ruling (§8 proposal) — commit to fixed-point destruction?
