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
computed exactly (never guessed), streamed as flags in the same diff.

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

### Seeing MODELS (failure #1, fixed by native client)
- fov tokens grow appearance fields: {kind, model/prefab name, dims,
  dominant materials, animation state} — from ECS, exact.
- ★ Native advantage the browser rain never had: the renderer's
  VISIBILITY BUFFER is ground truth for "what is actually on screen" —
  fov occlusion becomes exact (cluster visible = seen), no raycast
  approximations. Depth from the tracer gives true line-of-sight.
- Pixel keyframe organ stays for material/look verification (≤1Hz).

## Architecture (native)
- rain-sense package: ECS queries + solver contact taps + vis-buffer taps
  → 10Hz push/diff streams (fov · proprio · convictions), noise-floor
  diffing kept verbatim from rain.js design.
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
