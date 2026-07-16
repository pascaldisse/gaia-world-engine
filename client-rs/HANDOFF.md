# HANDOFF — DreamForge / rust-port · 2026-07-16 EOD (anchor — read FIRST after compact)

## What this is
DREAMFORGE: GAIA's engine rebuilt native (Rust, branch `rust-port`,
everything in `client-rs/`). Spec-first day complete; first build wave
running. Memory: `dreamforge.md` (orders/state) + `rust-port.md` (port
state) + `ghoul-routing.md`. ALL LAW lives in the repo docs below.

## Spec tree (all committed)
| doc | state |
|---|---|
| DREAMFORGE.md | CHARTER — 13 pillars, compute-placement + no-main-thread + universe-scale laws, forbidden vocabulary, replace map. The constitution — read whole |
| FEATURES.md + features/ | 100% contract vs old engine (79/24/9 rows) |
| GEOMETRY.md | ruled; amendments queued: foliage-as-density (charter has it) |
| RENDER.md | RULED (hw-vis M1, path integrator + ReSTIR, software VT, §8 Metal appendix, R1-R6) |
| PHYSICS.md | draft, defaults LOCKED (fixed tick + fixed-point destruction, voxel 0.1m param, P1-P6); Pascal's own reference = docs/PHYSICS-ENGINE-REFERENCE.md |
| NEURAL.md | ledger; Metal 4 REVISED: ML encoder = per-frame GPU-or-ANE, M1+, macOS 26 needed (his Mac → Tahoe); wgpu has no tensors → Metal-native package behind trait |
| CREATE.md | draft, rulings absorbed (no-convert-ever; Dreams audio = sole copy license; C1-C5) |
| VISIONFLOW.md | FINAL FORM: ONE THING, no domains — node = data, whatever data says happens; nodes ARE entities; anti-Unity law; N1-N5 |
| RAIN.md | senses: Matrix vision (structured channels, G-buffer = retina, no pixel roundtrip) + foveal pyramid + captions default + LOOKING = VERB (on-demand only, NO streaming ever, navigation needs no vision) + convictions = world-lint events; RN1-6 |
| research/ (17 files) | parked evidence — recon informs, Pascal rules |

## Iron laws digest (verbatim spirit — full text in charter)
never optimize (cost ∝ pixels/observer, never content/world size) · one
client · NOT Bevy · Terry core (core = ECS+schema+ops+scheduler+package
loader ONLY; everything else = packages) · one traced lighting system
(real path tracing, no toggles, infinite lights) · sole cluster pipeline
(no fallback renderer) · forbidden vocab: bake/lightmap/LOD/manual-UV/
manual-rig/convert/loading-screen/level-loading/authored-streaming ·
Metal-first, portability preserved · multiplayer is for MAKING · AI-first
(agents = primary users, data = their interface) · assume the world
incompetent · recon informs, Pascal rules · 60fps M1 16GB.

## Routing (07-16 law)
CODE = sol + opus ONLY · sonnet = online research only · terra unused for
this project. Test law + play-it law + own-eyes verification stand.

## In flight
- **sol wave 1** (`ghoul-sol-mrnleo9e7rcuy1`): Terry-core recast —
  `crates/gaia-core` (ecs+protocol+package registry) + `packages/
  render-window` (Tauri+wgpu spike absorbed) + **GET /screenshot
  framebuffer organ** (GAIA_NATIVE_PORT default 8430). R0 gate =
  pixel-asserted PNG at `client-rs/proof/r0-screenshot.png`. Result posts
  to room chat-mrndarsy-myce; verify with own eyes (curl + read PNG).

## Next after R0 (order)
1. Absorb sol result; run gate myself (curl /screenshot, assert pixels).
2. R1: cluster pipeline — offline baker (BUY meshopt+METIS; BUILD DAG/
   grouping) + GPU cull + hw-vis buffer; boomtown 5,261 entities through
   protocol+ECS; 60fps gate + Xcode limiter capture + core-utilization
   (idle P-cores = bug).
3. RN1-2: senses package (look()/proprio() pull + conviction events).
4. P1: solver core (CPU, substepped XPBD) — can interleave after R1.
5. unity-import → base merge via WORKTREE (my call, never touch live
   stack PIDs 54603/6/7 — whip 154).
6. Editor/STREAMING specs when build reveals their shape.

## Open with Pascal
macOS 26 upgrade timing (Metal-4 neural fast path) · Gaia-plugin package
location if he still has it (web recon sufficed otherwise).

## Next-pass fetch targets (research)
Evans SIGGRAPH 2015 PDF numbers · GDC "Architecture of Dreams" talk ·
BeamNG whitepaper OCR.

## Standing cautions
Live stack runs from this tree — never restart/kill (whip 154) · never
/tmp (ghouls violated twice today — salvage pattern: cp into
client-rs/research/) · never hardcode (params with defaults) · every
varying value = env param · commit only client-rs/ on rust-port.
