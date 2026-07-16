# Node-beam soft-body (RoR mined / BeamNG public) — PARKED EVIDENCE (sonnet, 07-16)

Source: ~/projects/rigs-of-rods @ fef9f25c (GPLv3, BeamNG's open ancestor,
file:line cited in room log) + BeamNG public docs. Feeds PHYSICS.md (on
hold — Pascal's magic first).

## Solver model (code-verified)
- node_t = mass point (pos/vel/forces/mass + contact state); beam_t =
  MASSLESS spring-damper {k spring, d damp, L rest (mutates on deform),
  strength/deform thresholds, plastic_coef} — pure axial; torsion/bending
  emergent from bracing geometry only.
- Integrator: semi-implicit Euler @ PHYSICS_DT=0.0005s = 2000Hz fixed, with
  frame accumulator (~33 substeps @60fps). BeamNG CONFIRMED same 2000Hz
  publicly — the rate carried over from RoR unchanged.
- Defaults: k=9e6, d=12e3, break=1e6, deform=4e5. Deform = permanent L
  offset + strength decay (weaker after bending); break = constraint
  removal w/ triangle-integrity guard; detacher groups cascade (bumpers,
  wheels).
- Special beams multiplexed on one struct: SHOCK1/2/3 (progressive),
  SUPPORTBEAM (one-sided, compression-free), ROPE (tension-only), HYDRO
  (rest-length DRIVEN by input per substep = steering/ailerons), TRIGGER
  (scripted events on length threshold).
- Wheels: rings of ≤50 nodes + rim nodes on axis pair; drivetrain torque →
  per-node tangential forces; NO tire curve — slip/traction EMERGES from
  node contact + ground Coulomb-Stribeck params (per-terrain-material, not
  per-tire). Tire feel = geometry + mass, zero authoring.
- Contact: penalty normal + Baumgarte-ish positional term; static/kinetic
  Stribeck friction, power-law mud/fluid.
- Threading: 1 actor = 1 task (BeamNG public: "1 vehicle = 1 thread");
  inter-actor beams serial; optional physics/render overlap.
- JBeam (public docs): same model verbatim — nodes dimensionless, beams
  massless, deform/strength semantics identical. ~400 nodes/4000 beams per
  vehicle (marketing figure, UNVERIFIED; real counts minable from shipped
  .jbeam data files).

## Sucks-list
- Stiffness binds the GLOBAL timestep (explicit integrator): 2000Hz exists
  BECAUSE chassis k≈9-14e6 demands it; all content pays the stiffest
  beam's tax. Rigid stacking/pileups degrade badly.
- One dense object = one thread = bottleneck (train/building can't
  parallelize internally).
- Rigid environment vs soft actor = two glued systems at the collision
  layer; no fracture of non-beam geometry; no volumetric soft materials
  (foam/cloth need hand-approximation from the same beam primitive).

## XPBD mapping (1:1, no new theory)
- beam{k,d,L} → compliant distance constraint{α,damp,rest}; SHOCK/SUPPORT/
  ROPE → known unilateral/limit constraint variants; HYDRO → driven
  rest-length constraint; deform/break → compliance update + removal (same
  as our destruction frame).
- Position-based solve = unconditionally stable at any stiffness →
  iteration count replaces the 2000Hz tax; stiff stacks don't shrink dt.
- Wheel-as-node-ring + Coulomb cone contact survives as a PATTERN in the
  unified solver; volume/area/bend constraints add true soft materials the
  beam primitive can't express. One constraint graph — no rigid/soft
  boundary. Islands parallelize INSIDE big objects (fixes their thread
  bottleneck).
⇒ Node-beam validates the unified-constraint thesis completely; nothing to
copy, everything subsumed.

## BeamNG.tech (Pascal correction 07-16 — verified)
- .tech = academia/industry fork, BINARY + tech.key; core C++ CLOSED even
  in .tech; Lua vehicle logic + HTML UI open/modifiable. Academic license
  FREE, renewable (register.beamng.tech, academic/professional email);
  industrial = negotiated.
- BeamNGpy = MIT (client over TCP): scenario spawn · step()/pause/
  deterministic mode + set_steps_per_second · MESH INFO SENSOR = per-node
  mass/force/velocity/stress/position @ up to 1/2000s · camera/LiDAR/IMU.
  ⇒ complete external experiment instrument for measuring their solver
  vs ours — doc-confirmed, execution UNVERIFIED (no install here).
- JBeam full section docs public (nodes/beams incl. ANISOTROPIC/BOUNDED/
  LBEAM/PRESSURED types, triangles aero+collision, refnodes frame).
- BeamNG technical whitepaper PDF exists (Maul/Mueller/Enkler, 2021) —
  text extraction failed, content UNVERIFIED → next-pass direct fetch/OCR.
- Threading: staff confirm game engine single-thread bottleneck;
  per-vehicle-thread = community folklore, not staff-confirmed.
