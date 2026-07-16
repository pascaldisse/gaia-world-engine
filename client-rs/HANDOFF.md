# HANDOFF — rust-port · 2026-07-16 (anchor doc, read first after context compact)

## What this is
GAIA engine rewrite: native Rust client (`client-rs/`), ONE client replacing
the web client entirely (incl. editor). Branch `rust-port` (off vrm-avatars).
Bun server + JSON scenes + ops protocol = untouched no-rebuild layer.
Memory: nyari topic file `rust-port.md` = ruling digest. This doc = repo anchor.

## Commits on rust-port (all client-rs/, base tree untouched)
| commit | content |
|---|---|
| `88183bbb` | foundation: Tauri+wgpu spike (src-tauri/) · gaia-protocol crate · gaia-ecs crate · PARITY.md |
| `4bd6f74c` | FEATURES.md 100% contract + features/{CLIENT,SERVER,TOOLS}.md inventories (zero-missing gates) |
| `1651f7b4` | GEOMETRY.md hybrid polygon/voxel/SDF ruling doc |

## Proven (gates green, `cd client-rs && cargo test --workspace`)
- **gaia-protocol**: serde types, tolerant unknown-capture; parses all base
  world files + all 73 boomtown files / 5,261 entities, zero errors.
- **gaia-ecs**: runtime JSON-schema components (per-FIELD SoA), string-id↔
  entity generational map, command buffer w/ apply points, deterministic
  scheduler (before/after + orderFirst/Last + sequence tie-break + FIXED
  accumulator) — **compiled-order.snapshot.json conformance EXACT** (fixture
  byte-identical to unity fork's).
- **spike** (`target/debug/gaia-tauri-wgpu-spike`): wgpu into Tauri window via
  raw-window-handle + transparent webview overlay + input passthrough + IPC —
  logs proven. **PIXELS UNVERIFIED** (TCC blocks screencapture).

## Ruling docs (law, evidence-cited)
- `FEATURES.md` — 100% feature-complete contract; no row no feature, no ✅ no
  web-client death. Sections: features/CLIENT.md (79 rows), SERVER.md (24
  schema components), TOOLS.md (9 tools). Cross-branch spread table inside.
- `GEOMETRY.md` — hybrid: polygons DEFAULT · voxels per-entity (Teardown
  pattern: OBB proxy → fragment raytrace bricks → same G-buffer; 8³ bricks,
  palette→materials) · SDF sculpts (`sdf` primitive list, smin blend; carve =
  subtract k=0 special case, data model kept, three-bvh-csg evaluator retires)
  · ONE shared contouring kernel · acceptance = all three in one frame, one
  light pass, screenshot-verified.
- `PARITY.md` — boomtown/unity-import delta: server systems merge & stay Bun;
  client Rust port list (ArcadeVP constants verbatim, collider-surface metric
  bit-identical client/server); top-10 risks.

## Standing orders (Pascal, all 07-16 — full text in rust-port.md memory)
1. ONE client (whip 161). 2. NOT Bevy — own engine, wgpu; bevy_ecs/Fyrox =
   reference only (clones: ~/projects/bevy, ~/projects/fyrox). 3. Tauri
   chassis: wgpu owns pixels, webview = transparent DOM editor overlay
   (macOSPrivateApi accepted, no app store). 4. Archetype ECS, DOTS-shaped —
   "ECS is the way". 5. Unity compat = `gaia convert` import tiers T1-T4.
   6. Engine GENERIC — typed structs only for client-interpreted components;
   gameplay components ride runtime-schema path; new components NEVER require
   Rust changes. Boomtown = acceptance test, not design center. 7. 100%
   feature complete vs existing engine. 8. Mesh tools first-class (tube/carve/
   edit lens → geometry kernel). 9. Rain = port requirement (semantic fov/
   proprio native off ECS; /screenshot framebuffer = pixel-truth organ).
   10. PHYSICS: own UNIFIED engine, core feature — rigid+soft+bending+
   destruction+gas, one XPBD-family solver, with/without voxels, "crysis+
   teardown+mercenaries+just cause+hl2 BUT BETTER". Destruction dissolves
   INTO solver (glue = constraints w/ strength budgets; stress = constraint-
   force readout; activation = island sleeping). RayFire/Teardown/everything
   = inspiration only — "assume everything sucks, build your own".
   11. Neural (Kyouma): M1 @ 60fps — MetalFX upscale + compute-RT on
   occupancy mips + neural denoise/radiance-cache + AI physics surrogates
   (far-field/fluids). 12. STANDING: recon informs, Pascal rules, nothing
   adopted by default.

## In flight (results post to room chat-mrndarsy-myce when done)
- terra `ghoul-terra-mrngo2wrr62ksq`: physics field lit (Gustafsson/Teardown
  disclosures, XPBD/Macklin-Müller, GeoMod/Frostbite destruction, Rapier
  baseline, smoke grids) → feeds PHYSICS.md.
- sonnet `ghoul-sonnet-mrngsqq55d2wuz`: neural render on Apple Silicon
  (MetalFX, compute-RT budgets, NRC, denoisers, ANE/CoreML per-frame) + AI
  physics (GNS, Holden subspace, neural fluids, hybrid LOD) → feeds PHYSICS.md.

## Open calls (Pascal, parked)
1. **Spike pixels**: run `./client-rs/target/debug/gaia-tauri-wgpu-spike` and
   look (triangle under transparent panel = pass) OR grant Screen Recording to
   gaia-daemon.app (durable agent-verification win).
2. **Merge mode** unity-import→rust-port: worktree merge vs 2-min stack stop
   (live server+vite run from this tree — whip 154, never kill his app).

## Next waves (specs ready, launch order)
1. **PHYSICS.md — ON HOLD (Pascal 07-16: "let me do some magic myself first")**:
   when the 2 recons land, PARK results in room, do NOT write/commit the
   ruling doc until Pascal has done his own physics pass and gives the go.
2. **Renderer MVP** — deferred G-buffer (Fyrox steal: pipelines never keyed by
   light set) + polygon pass; reads boomtown world via gaia-protocol+gaia-ecs;
   first pixels in Tauri window. Screenshot-verified.
3. **CSG/contouring make-or-buy recon** — Rust crates vs porting
   ~/projects/johnlin-BinaryMeshFitting (gates geometry kernel).
4. **Protocol cleanup** — demote gameplay typed structs to generic path
   (order #6).
5. **unity-import merge** — after Pascal picks mode.

## Research clones on disk
~/projects/: fyrox · bevy · johnlin-{BinaryMeshFitting,isosurface,
PushingVoxelsForward,ProjectIW,ClosestPointContouringTable} ·
johnlin-research/posts/ (3 blog posts + press). boomtown-rampage = Pascal's
Unity source, READ-ONLY. GAIA-World-Engine-unity@unity-import = compat fork.
Known gaps: reddit JL thread bodies 403-blocked; past JL discussions not
found via recall (3 probes).
