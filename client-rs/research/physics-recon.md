# Physics recon — PARKED EVIDENCE (terra, 2026-07-16)

Status: evidence only. PHYSICS.md ON HOLD — Pascal's own physics pass first
(HANDOFF.md). Nothing here is adopted; recon informs, Pascal rules.

## 1. Teardown / Gustafsson
- Regular-grid voxel volumes; breaking simpler for physics+graphics vs surface
  assets. https://80.lv/articles/teardown-developer-breaks-down-multiplayer-and-voxel-destruction-tech
- Material = 8-bit palette index/voxel, ≤255 materials/volume (visual+physical).
  https://blog.voxagon.se/2020/12/03/spraycan.html
- Worlds: thousands of volumes, ~0.5B voxels large levels; physics voxel data
  REGENERATED from main voxel data on load. https://blog.voxagon.se/2020/11/18/teardown-quicksave.html
- Original engine NOT deterministic; multiplayer rewrite = fixed-point integer
  destruction, replicating ordered commands (voxel cuts, shape ownership, joint
  reconnects). https://blog.voxagon.se/2026/03/13/teardown-multiplayer.html
- NOT disclosed: contact solver identity, body/frame budgets, connectivity algo.
- Separate 2025 prototype (not Teardown): parallel temporal-Gauss-Seidel/substep
  solver, ~5ms on i9+4080Ti, 32 threads. https://80.lv/articles/see-what-s-new-in-teardown-creator-s-custom-voxel-physics-engine
- Smoke: collides with surroundings, escapes through new holes; no method/grid
  numbers published. Meqon→AGEIA 2005→left 2007 pre-NVIDIA.

## 2. XPBD / unified particle
- XPBD: compliance → stiffness independent of dt/iterations; elastic+dissipative
  potentials; constraint-FORCE estimates available. https://matthias-research.github.io/pages/publications/XPBD.pdf
- Small Steps (Macklin 2019): n substeps × 1 iter beats 1 step × n iters.
  Cloth 150k particles/896k springs: 30×1 = 13.5ms vs 1×30 = 12.4ms, less
  stretch. Chain mass-ratio 1:100k: 100 substeps err 3.2m vs 100 iters 322m.
  FEM 12.8k tets E=1e7: substeps 6ms vs BE/PCG 12ms. https://mmacklin.com/smallsteps.pdf
- Flex: ONE particle+constraint representation → rigids (shape matching), cloth,
  ropes, granular, liquid, gas in shared collision. GTX680: 50k particles ~10ms;
  300k ~150ms. CAVEAT: shape-matching convergence degrades with particles/shape
  → suits small debris, NOT large rigids. Smoke = particle carrier + visual
  markers. https://mmacklin.com/uppfrta_preprint.pdf
- XPBI: topology change (split/merge) still complicates meshes → remeshing.
  https://arxiv.org/html/2405.11694v2

## 3. Structural destruction
- Geo-Mod 1 = runtime CSG; Geo-Mod 2.0 (Guerrilla) = pre-broken meshes + stress/
  impact response. NO published load-graph representation. redfactionwiki.com
- Frostbite: SDF destruction masks, rendering-oriented; no structural graph.
  https://advances.realtimerendering.com/s2010/Kihl-Destruction%20in%20Frostbite(SIGGRAPH%202010%20Advanced%20RealTime%20Rendering%20Course).pdf
- Just Cause 4: wind constrained to small volumes — active-body collision cost
  scales with moving-body count. https://www.gamedeveloper.com/programming/aerodynamics-of-just-cause-4
- Control: material metadata + procedural rules; 3 layers (rigid chunks / mesh
  particles+decals / particles); no support propagation. gamedeveloper.com
- ⇒ NOBODY publishes a structural load/support graph. Our stress-from-solver
  design (constraint-force readout) has no public prior to copy — open ground.

## 4. Rust baseline (make-or-buy)
- Rapier: rigid+joints+queries, optional cross-platform determinism
  (enhanced-determinism, IEEE-754 targets). NO soft/fracture/gas/smoke. rapier.rs
- Salva: SPH fluids (DFSPH/IISPH), two-way Rapier coupling. github.com/dimforge/salva
- Jolt: rigid multicore + soft bodies (edge/bend/Cosserat rod/tet volume/
  pressure); Rust bindings WIP, not native. bevy_xpbd → deprecated → Avian
  (rigid XPBD-ish, no soft/fracture/gas). ⇒ NO Rust-native unified solver
  exists — building ours duplicates nothing.

## 5. Eulerian smoke + dynamic geometry
- Stam stable fluids on GPU grid (GPU Gems 1 ch38); 2004: 128² cloud >80 it/s
  on FX5950.
- Hellgate:London (GPU Gems 3 ch30): dynamic obstacles = inside/outside
  voxelization + obstacle velocity in boundary cells, 2 3D textures updated on
  move/deform; free-slip boundary; simplified proxy meshes → per-frame
  voxelization cheap; 41 B/cell sim + 20 B/px render; 16-bit storage ≈ 2×
  faster than 32-bit (arith stays 32); raymarch 2 samples/voxel, low-res bulk +
  full-res at discontinuities. ⇒ our occupancy-coupled grid frame matches the
  published pattern; numbers = budget anchors.

## Read-through (nyari, non-binding)
- Small-Steps substepping = the solver's engine room; constraint-force readout
  (XPBD native) = the stress signal our destruction design assumes. Validated.
- Flex proves one-representation unification works AND warns: shape-matched
  rigids don't scale to buildings → rigids as bodies+constraints, particles for
  granular/fluid, one solver loop. (Matches standing frame.)
- Teardown fixed-point rewrite = determinism costs a representation decision;
  GAIA multiplayer someday → decide early, not retrofit.
- Buy-nothing confirmed: no Rust-native unified solver exists to buy.
