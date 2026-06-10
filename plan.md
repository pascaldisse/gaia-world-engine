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
- [x] `scatter`/`particles` components → InstancedMesh (candle-lake class scenes)
- [x] Shader preset library as data (water, flame, glow, hologram; TSL, safe fallback)
- [x] `environment` entity: fog, sky, exposure, bloom post chain (grade later)
- [x] `weather` component: server-side lightning events + rain cycles

### M5 — Sound (procedural + samples)
- [x] Declarative synth-patch format (layers: noise/osc → filters → LFO → sends)
- [x] World audio buses (master, compressor, generated reverb) on environment.audio
- [x] Sample support: `{kind:"sample", url}` + static `world/assets/` serving
- [x] SFX patches triggered by events (`sfx` component + built-in thunder/flash)

### M6 — Observability polish
- [x] Screenshot endpoint (client-rendered via ws relay; needs a visible tab)
- [x] World clock + shared motion math (sense sees orbit/bob live)
- [x] Player presence entity (published ~3Hz, despawned on disconnect)
- [x] Semantic lint expansion (light coverage, walkability)

### M7 — Zones & streaming (forced by: any second level)

One coherent world-space, Dark Souls style: levels stream in and out, but
every vista is the real level (or its backdrop impostor) at its true world
position. Driven by `../Tomb-of-the-Gods-GAIA/plan.md`.

- [ ] `world/manifest.json` — zones: `{name, origin, yaw, neighbors, visible, always}`;
      no manifest = one implicit zone (current worlds keep working)
- [ ] Per-zone `zones/<name>/seed.json` + per-zone runtime state file; server
      loads all zones, stamps each entity's zone, routes ops by entity id
- [ ] Client zone subscription: current + neighbors + always-zones; build/unbuild
      groups on set change; portal/bounds crossing switches the current zone
- [ ] Backdrop zones: always-loaded low-detail far scenery (the unreachable mountains)
- [ ] Multi-terrain: terrain registry with world-space bounds; `heightAt` routes by
      containment; zones may have no terrain at all (interiors)
- [ ] Per-zone `environment` + ambience, crossfaded on zone switch
- [ ] Senses zone-scoped by avatar position — agents stream the same way players do

### M8 — Bodies in space (forced by: the boat crossing, the tunnels)

- [ ] Blocking colliders: collider boxes with `blocker: true` push the player out
      horizontally — cave walls, railings, the original's deep-water lockout
- [ ] Water volumes: surface swim mode (buoyancy at waterY, slow strokes)
- [ ] Ride platforms: standing on a moving entity's collider carries you with its
      frame delta (the skiff, the gondolas)
- [ ] Interior safety: no-terrain zones get a void floor / respawn-at-last-ground

### M9 — World logic (forced by: doors, shortcuts, story beats)

- [ ] `trigger` component: server-evaluated volumes vs presences →
      `{on: enter|exit, emit/merge ...}` events
- [ ] `state` convention: world flags entity + helpers (shortcut doors, lit lanterns)
- [ ] `persist` component + `reset` op: re-seed a zone except persist-tagged
      entities (the Braid rule as an engine primitive)

## Later

- Sandboxed `script` component (QuickJS/worker, error containment, self-healing)
- Full TSL `shader.source` authoring
- Multiplayer presence/avatars, op attribution UI
- Embodied agent characters driving the same sense/act API
- Native client speaking the same protocol if we outgrow the browser

## Known gaps (accepted for now)

- Carried grounded entities appear ground-snapped to other clients mid-carry.
- Screenshots require a visible (non-backgrounded) browser tab — browsers
  pause the render loop in background tabs.
- World clock resets on server restart (orbit phases shift); persist later.
- Scatter doesn't support billboard sprites; use crossed planes with the
  flame/glow presets instead.

## Run

`npm run dev` → world server :8420, client :5173 (or next free port).
World persists in `world/world.json`; delete to re-seed from `world/seed.json`.
