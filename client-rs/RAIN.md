# RAIN — DreamForge agent senses (DRAFT, 2026-07-16)

Law: AI agents = the engine's primary users (pillar 10) — "the most
important part is that AI can actually see and interact with the world"
(Pascal). Rain = a PACKAGE off the ECS (pillar 13), no browser, no CDP.
Evidence: this morning's field survey (SIMA2/Gemini/TITAN vs our baseline)
+ naruko embodiment spec/WIRING gap ledger + Pascal's failure list.

## Field survey verdicts (07-16, absorbed)
- Semantic-first CONFIRMED ahead of published practice: pixel-primary
  agents (SIMA2 class) run ~1fps at real $ cost BECAUSE they lack
  privileged state — we have ground truth; mimicking them = strictly
  regressive. Keep: 10Hz semantic fov/proprio push+diff.
- `fov --watch` = right design, unfinished WIRING (nothing streams it into
  agent context continuously) — the actual blocker, port priority.
- Pixel keyframes ≤1Hz via /screenshot for what data can't show
  (materials, lighting, "looks wrong") — TITAN hybrid pattern = doctrine.
- SPEAK latency bar: <200-300ms turn-taking (Gemini Live's bar, ours over
  own event bus, no vendor).

## Pascal's failure list → the root cause → the fix
Failures (old rain, live): couldn't see models · didn't notice an object
half-sunk into the ground · didn't notice people walking backwards.
ROOT: rain reports WHAT EXISTS, never WHETHER IT'S RIGHT. Fix = a third
organ beside fov+proprio: **CONVICTIONS** — lints over ground truth,
computed exactly (never guessed), emitted as EVENTS when flags change.

## LOOKING IS A VERB, NOT A STATE (Pascal 07-16: "you obviously don't
## look every fucking frame... never turned on constantly")
- Vision is ON-DEMAND ONLY: `look()` fires when the human asks or the
  agent chooses. NO streaming by default — likely never streamed at all.
  NEVER tied to frame rate.
- Default glance = the cheap entity view (captions + glance grid); deeper
  layers/levels = explicitly triggered (the pyramid below).
- NAVIGATION NEEDS NO VISION (robot precedent, other app): moving runs on
  world data — paths, colliders, positions. Seeing = mostly a DEBUGGING
  organ.
- CONVICTIONS are not vision: cheap engine-side lints running as the
  world's own self-check (world-lint), emitting only on flag CHANGE — an
  agent hears "X is embedded" without ever looking.
- `--watch` demoted: a debug-session mode you switch on, never a default
  loop.

### Conviction set v1 (each = cheap exact math on ECS/solver state)
| flag | computation |
|---|---|
| `embedded` | collider/feet vs terrain height / voxel occupancy overlap (penetration depth) — the half-in-the-ground detector |
| `floating` | ground-contact absent + height above support > ε |
| `backwards` | dot(body forward, velocity) < 0 while locomoting — the walking-backwards detector (Pascal's ORIGINAL first test, 07-09) |
| `sliding` | velocity without locomotion animation phase |
| `clipping` | collider-collider overlap outside contact set |
| `unlit/invisible` | entity present in data but zero visibility to any observer (see below) |
| `missing-model` | mesh/model component absent or asset unresolved while entity expects one |
Native physics makes most of these FREE: the solver already computes
contacts/penetrations per substep — convictions read them, no second sim.

### MATRIX VISION (Pascal correction 07-16: labels ≠ vision — "you see
### the vertices... see by seeing the data")
The agent's retina = a PER-AGENT STRUCTURED RENDER: a low-res buffer from
the agent's eye pose where every texel carries CHANNELS, not colors:
  { entityId, clusterId, depth, normal, worldPos, motionVector,
    materialId, animPhase }
— the same G-buffer/vis-buffer stack the renderer already computes; the
agent sees the world's VECTOR TRUTH projected to its viewpoint. No pixel
roundtrip ever ("render to pixels → VLM → vectors again" = the stupid
path, forbidden). NVIDIA precedent: DLSS/Ray Reconstruction consume
exactly these channels (motion vectors + depth + engine buffers), Isaac-
class embodied models eat depth/segmentation natively — networks reading
engine channels IS the published state of the art; we make it the
agent-facing sense.
- CONTEXT DIET (Pascal 07-16: "all at once will just blow the context") —
  zoom-is-meaning applied to perception, foveal by design:
  · LAYERS individually viewable: each channel = its own requestable
    layer (depth-only, motion-only, ids-only…) — never the full stack
    unless asked
  · RESOLUTION PYRAMID: 8×8 glance → 32² regard → 128² study →
    attention-fetch (real geometry) — cost grows only with curiosity
  · CAPTIONS per layer: one-line computed summary ("motion: 3 movers, max
    2.1m/s NE, 1 opposing facing") — DEFAULT MODE = captions + glance
    grid; full layers pulled on demand
  · DIFF STREAM: changed texels past noise floor only, never full frames
  All resolutions/rates/floors = params w/ defaults (never hardcoded);
  cost ≈ vis-buffer pass without material shading — cheap by construction.
- ATTENTION FETCH (Neo focusing): agent marks a region → engine returns
  the underlying geometry itself — cluster vertices, SDF region, entity
  component data — arbitrary zoom into structure, no screenshot.
- Motion vectors give the agent MOTION PERCEPTION directly (the
  backwards-walker is visible in the velocity channel itself, before the
  conviction lint even fires).
- Entity labels/tokens remain as the cheap SUMMARY layer riding on top
  (fast attention/diffing) — a caption on vision, never the vision.
- Pixel keyframe organ stays for look/material verification only (≤1Hz).

## Architecture (native)
- rain-sense package: ECS queries + solver contact taps + vis-buffer taps
  → PULL-shaped senses (look()/proprio() on demand) + conviction EVENTS on
  flag change; noise-floor diffing kept for the debug --watch mode only.
- Endpoints: /sense/fov /sense/proprio /sense/convictions (+ --watch
  continuous wiring INTO agent context — the unfinished piece, now a
  contract item) + /screenshot (framebuffer PNG — R0 gate organ, sol
  building it now).
- Convictions are for EVERYONE: same lints power the editor (world-lint
  panel), CI world checks, and agents — one organ, three consumers.

## Gates
RN1 fov+proprio native off ECS, parity with rain.js output on same scene.
RN2 convictions v1: place a half-sunk crate + a backwards walker in a test
    scene → flags fire within one tick; remove → flags clear. PLAY-IT law:
    verified through a real agent session reading the stream.
RN3 --watch wiring: agent context receives continuous diffs; agent
    narrates a world change without being asked.
RN4 vis-buffer fov: occluded entity absent from fov until exposed.
RN5 Matrix vision: agent reads structured channels (depth/normal/motion/
    ids) from its eye pose; verifies a backwards walker from the motion
    channel ALONE (no labels); attention-fetch returns real cluster
    vertices for a marked region. PLAY-IT law: through a live agent.
RN6 context diet: a full session at captions+glance default stays under a
    fixed token budget (param) while the agent still detects a spawned
    anomaly by pulling ONE layer at ONE deeper level — measured tokens
    pasted in the gate.
