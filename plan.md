# GAIA World Engine — Plan

Half game, half engine. A Dreams-like creation world where the player and AI
agents build together, in-world, while it runs. 3D only.

## Principles

1. **The world is data.** Every entity is a document of components. Code lives
   in the kernel (small, stable) or in sandboxed content (hot-swappable).
2. **Everything is a client.** The player, the editor UI, the AI, future
   embodied agent-characters — all send the same patch ops to the same world
   server. No privileged editor.
3. **No rebuilds, ever.** A change is a patch; a patch applies in milliseconds
   while you walk around inside the result.
4. **Agents sense without eyes.** Perception is queries, text frames, and event
   streams — the same way game NPCs have always perceived. Screenshots stay as
   the slow path for judging beauty, not correctness.
5. **Same hands.** Agents act through the player's interaction layer (intents →
   controller), not by teleporting state.

## Architecture

- `server/` — canonical world store, patch ops (`spawn/set/merge/despawn/clear`,
  transient `event`), WS+HTTP hub, op journal, sense API, intent engine.
- `client/kernel/` — renderer (three.js WebGPU), store mirror, view reconciler,
  terrain, player controller, interaction (grab/gizmos), audio synth, behaviors,
  effects. Vite dev = hot reload; state lives on the server.
- `shared/` — pure functions both sides must agree on (terrain math).
- `tools/` — `patch.mjs` (raw ops), `agent.mjs` (sense + act CLI).
- Reference benchmark: `../Tomb-of-the-Gods/demo` — when M4+M5 land, that demo
  should be ~30 entity documents instead of 2,700 lines of code.

## Milestones

### M1 — Hands (in-world editing core)
- [x] Raycast picking + hover highlight (crosshair, box outline)
- [x] Grab/carry with spring follow, scroll push/pull, E grab/drop
- [x] Live op streaming while carrying (~16Hz), ground snap on release
- [x] View suppression so local hand beats server echo
- [x] Spawn wisp + materialize tween, despawn dissolve, audio blips

### M2 — Sense & Act (agents see without eyes)
- [x] Shared terrain math (`shared/noise.js`) used by client + server
- [x] Op journal + `GET /events?since=` (the world's nervous system)
- [x] `GET /sense/look` — ranked text viewport from any pose/avatar
- [x] `GET /sense/describe|query|map|check` — summaries, search, ASCII map, lint
- [x] Avatar presence entities + intent engine (`move_to/walk/face/grab/drop/say`)
- [x] Act+sense fusion: intent response includes the next look frame
- [x] `tools/agent.mjs` CLI (MCP wrapper later)

### M3 — Inspector (creator mode)
- [x] Tab creator mode: cursor, click-select, TransformControls gizmos
- [x] Auto-generated component panel (sliders/color pickers/dropdowns from JSON)
- [x] Raw JSON tab, duplicate/delete, per-client undo (inverse ops)
- [x] Prefab palette + ghost stamping; AI-addable library

### M4 — Tomb vocabulary (visual power)
- [ ] `scatter`/`particles` components → InstancedMesh (candle-lake class scenes)
- [ ] Shader preset library as data (water, flame, glow, dome, wet-rock; TSL)
- [ ] `environment` entity: fog, sky, exposure, bloom/grade post chain
- [ ] Weather-style behaviors emitting transient events

### M5 — Sound (procedural + samples)
- [ ] Declarative synth-patch format (layers: noise/osc → filters → LFO → sends)
- [ ] World audio buses (master, compressor, generated reverb) on environment
- [ ] Sample support: `{kind:"sample", url}` + static `world/assets/` serving
- [ ] SFX patches triggered by events

### M6 — Observability polish
- [ ] Screenshot endpoint (client-rendered, slow path)
- [ ] World clock + server-evaluated deterministic behaviors (sense sees motion)
- [ ] Player presence entity (agents can sense the player)
- [ ] Semantic lint expansion (reachability, light coverage)

## Later

- Sandboxed `script` component (QuickJS/worker, error containment, self-healing)
- Full TSL `shader.source` authoring
- Multiplayer presence/avatars, op attribution UI
- Embodied agent characters driving the same sense/act API
- Native client speaking the same protocol if we outgrow the browser

## Known gaps (accepted for now)

- Display behaviors (orbit/bob) run client-side; server sense reads documents,
  not animated positions → fixed by world clock in M6.
- Carried grounded entities appear ground-snapped to other clients mid-carry.
- Environment lighting is kernel-owned until M4.

## Run

`npm run dev` → world server :8420, client :5173 (or next free port).
World persists in `world/world.json`; delete to re-seed from `world/seed.json`.
