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
position. Streaming is invisible — neighbors are resident before they can be
seen or reached; no gates, no loading, ever. Driven by
`../Tomb-of-the-Gods-GAIA/plan.md`.

- [x] `world/manifest.json` — zones: `{name, origin, yaw, neighbors, bounds, always}`;
      no manifest = one implicit zone (current worlds keep working)
- [x] Per-zone `zones/<name>/seed.json`, authored zone-local; the server places
      each zone (origin + yaw via `shared/zones.js placeEntity`) and stamps a
      `zone` component; runtime spawns are stamped by position. Runtime state
      stays one `world.json` until the M9 `reset` op wants per-zone files.
- [x] Client zone subscription: current + neighbors + always-zones; entities
      outside the set stay data-only; bounds crossing switches the current zone
- [x] Time-sliced build/unbuild: a few entities per frame so a zone coming in
      never drops a frame
- [x] Backdrop zones (`always: true`): far scenery at true world positions
- [x] Multi-terrain: registry routes `heightAt` by containment, nearest terrain
      extrapolates outside all bounds (single-terrain worlds unchanged); true
      no-ground interiors are M8 (void floor + blockers)
- [x] Crossfade environment/ambience on zone switch (mood lerps over ~3s,
      ambient sounds fade with the current zone)
- [x] Senses zone-scoped by observer position — agents stream like players do

### M8 — Bodies in space (forced by: the opening, the boat crossing, the tunnels)

- [x] Blocking colliders: collider boxes with `blocker: true` push the player out
      horizontally — cave walls, railings
- [x] Water volumes: surface swim mode (buoyancy, slow strokes), and peril as
      data — `{drownAfter: seconds}` exhausts the swimmer: sink, `drown` event,
      respawn at the spawn point. Plus real gravity: airborne bodies fall.
- [x] Ride platforms: standing on a moving entity's collider carries you with
      its frame delta (the ferry barge today, the gondolas later); a swimmer
      can haul onto a low deck (boarding reach)
- [x] `path` behavior: waypoint-following motion on the world clock,
      deterministic like orbit — ferry routes, patrols; triggers stamp `$now`
      as the start time
- [x] Interior safety: falling past `voidY` (manifest default −120, per-zone
      override) returns the body to its last safe static ground (or the spawn
      point), with a `void` event and a screen dip

### M9 — World logic (forced by: doors, shortcuts, story beats)

- [x] `trigger` component: server-evaluated areas vs presences, enter AND exit
      edges, cooldown, `when` conditions against world state, fires ops with
      `$now`/`$id` substitution and/or events
- [x] `state` convention: `merge` materializes missing entities, so world
      flags appear on first write (`patch.mjs state gate open` →
      `world-state`); triggers condition on them via `when`
- [x] `persist` component + `reset` op: re-seed a zone (or the world) from its
      seed files — persist-tagged entities, presences, and unzoned entities
      (world state) keep their current truth (the Braid rule as a primitive)

### M10 — See the invisible (forced by: guessing at triggers, routes, volumes)

- [x] Outliner: every entity listed in creator mode, grouped by zone (current
      zone marked, unzoned "world" section, presences last), searchable by id
      or component name, dimmed when out of the streamed zone set. Click
      selects — including bodiless entities (triggers, water, environment,
      world-state); double-click flies to where the data says it is.
- [x] Gizmo layer: x-ray overlays for the data the renderer doesn't show —
      collider boxes (green walkable / red blocker), trigger volumes (yellow,
      with y-band), water areas at their level (blue), light ranges, sound
      refDistance rings, path waypoints + direction cones + orbit rings
      (orange), scatter/particle footprints draped on the terrain, zone bounds
      + spawn markers. Selected entity always draws its own; outliner chips
      toggle whole categories.
- [x] Dev deep-links: `?create=1&select=<id>&gizmos=a,b,c&pos=x,y,z&yaw=&pitch=`
      opens creator mode without keyboard input — agents can screenshot the
      editor; people can bookmark a debugging vantage.

### M11 — Understand at a glance (forced by: tuning values means knowing what they mean)

- [x] Component schema as data (`shared/schema.js`): docs, per-field ranges,
      enums, defaults for every component. The inspector reads it (doc lines,
      tooltips, correct sliders, complete add-component menu); the server
      serves it (`GET /schema`) so agents stop guessing.
- [x] Inspector runtime strip: zone, built / building / data-only, live
      kernel position — what the renderer knows vs what the data says.
- [x] World log (`L`, or `?log=1`): the op stream live — triggers firing,
      weather writing, agents editing — with text filter, events-only and
      presence-noise toggles.
- [x] Audio mute: `M` (persists per browser), `?mute=1` for agent work tabs.

### M12 — Deliberate hands & deep worlds (forced by: Tomb G2 — the lantern ritual, the climb, the ferry, the vista)

- [x] `interact` component: press-E world logic. A presence in range uses an
      entity ON PURPOSE; the client sends `{op:'use', id, by}` and the server
      decides (trigger rules: `when` gates, cooldown, `$now`/`$id` ops; range
      check with presence-lag slack). Prompt hint in play AND game mode; one-
      shots remove their own interact in their ops. Outliner icon ✧, dashed
      use-range ring in the triggers gizmo category, schema'd. NOTE: a `use`
      op expands against pre-batch state — send it alone, after the ops that
      position the user.
- [x] Path dwell: a waypoint's 4th number parks the follower there for that
      many seconds (ferry stops). Path eval became time-parameterized
      (`phase` is seconds now); loop pauses at the end too.
- [x] Stacked floors: `walkableAt(x, z, maxTop)` is feet-aware — a switchback
      above you is no longer your ground (it used to return the highest top,
      which made floors under floors fall through).
- [x] Zone reset, visibly: respawn-while-shrinking race fixed (the despawn
      animation's callback no longer deletes the freshly rebuilt group).
- [x] Mesh `fog: false` (plain parts AND presets): backdrop silhouettes whose
      colors already are the atmosphere — zone fog stops erasing them.
- [x] Camera far plane 4000 (was 1000): the world axis runs ~2.5km; the tree,
      the bridge and the void glow must survive projection, not just fog.

### M13 — Invisible streaming & the light pool (forced by: Tomb G2 in play — lantern hitches, zone-seam freezes)

The bar was Dark Souls / INSIDE: no loading you can feel, ever. Baseline
measured over CDP: a 2,097ms frame entering the cavern (zone stream-in),
700ms+ both other seams, ~30fps steady. After: every seam ≤ 13ms (zero
frames over 50ms in any direction), steady 120fps, lighting a lantern ≤ 11ms.

- [x] Light pool: scene lights are part of every material's shader cache key
      (LightsNode hashes `light.id` + castShadow), so adding/removing ONE
      light recompiled every pipeline in the scene — that was the lantern
      hitch AND most of the seam freeze. Runtime point lights now live in a
      fixed pool of 16 permanent PointLights (position/color/intensity are
      not in the key); the nearest specs hold slots, so the forward-lighting
      budget is constant no matter how many lanterns burn. Spot/directional/
      castShadow lights bypass the pool — build-time only.
- [x] Shared geometry/material caches keyed by recipe values (mesh parts,
      scatter instances, terrain heightfields). World content repeats; GPU
      objects now do too. Shared resources carry `userData.shared` and are
      never disposed by users (terrain cache evicts oldest past 8, untagging
      so normal disposal reclaims them).
- [x] Fog mutates in place: replacing `scene.fog` re-keyed every pipeline —
      each zone crossfade was a full-scene recompile. Same-family fog
      (exp↔exp, linear↔linear) now updates values only; only a family swap
      pays (the kernel default is linear, worlds with exp fog pay once at
      boot, behind the overlay).
- [x] The world stays resident: everything builds at load and renders ONCE —
      all of it visible, frustum culling off — for three warm frames behind
      the entry overlay, so every pipeline compiles and every render object
      exists before play. Streamed-out zones HIDE (sounds and light slots
      release); streamed-in zones SHOW. Nothing is built, compiled or torn
      down mid-play. Probe meshes warm material variants that exist only in
      interact/trigger ops (a lantern's unlit flame), instanced and particle
      variants probed faithfully (different shader builds).
- [x] Positional audio flood fix: three re-schedules six panner ramps per
      frame per PositionalAudio (and the listener), moving or not — ~10k
      WebAudio automation events/second for a dozen static drips. Panners
      (and the listener) now re-ramp only when they actually move.
- [x] `tools/profile-seam.mjs`: CPU-profile the page across a transition over
      CDP, print hottest functions — how every one of these was found.

### M14 — The carried light (forced by: Tomb — the flame of the first shore)

A `light` component ON a presence entity is a light the player carries.
Three primitives make it real:

- [x] The OWN presence's pooled light rides the camera at frame rate (not
      the 300ms presence trickle), with its offset in the camera's FLAT
      frame: z < 0 carries it ahead of you, lighting where you're going —
      yaw-only, so looking down never buries it in the floor. No geometry,
      so nothing ever blocks the view.
- [x] Presences re-stamp their zone server-side as their transform crosses
      zone bounds — senses scope correctly and a client never streams out
      its own body (or the light it carries). Closes the M9 known gap.
- [x] Client identity is per-tab persistent (sessionStorage): a reload
      reconnects to the same presence entity. What a session was granted —
      a carried light, later an inventory — needs game-side re-grant logic
      only across full disconnects (the server reaps dead presences).
- [x] Look-dev knobs (~): a `flame` slider tunes the reach of the light
      your presence carries, and the whole menu drives with arrow keys —
      ↑/↓ select a knob, ←/→ nudge it. The slider scales intensity with
      the square of the reach — a point light's `distance` is only a
      cutoff, and inverse-square decay has faded long before it.

## M15 — the body and the debug kit (DONE)

What playtesting asked for next, in one round:

- [x] Jump (Space) and crouch (hold ctrl or C), Half-Life flavored: jump
      is a vy impulse off the grounded branch (which now requires vy ≤ 0,
      so the first airborne frame survives the ground-snap band); the
      ridden platform is kept while airborne — jumping on the moving ferry
      lands you on deck, not in its wake. Crouch sinks the eye toward 1.0:
      grounded, the camera follows; mid-air the FEET rise instead, which
      is what makes the crouch-jump clear higher ledges for free.
- [x] Debug snapshots ('+'): the client captures the canvas right after
      render (WebGPU readback only works in the drawing task) and POSTs it
      with the player pose to /snapshot; the server writes debug/<stamp>.png
      + .json — wall + world time, the presence's components, every `state`
      component (quest flags), nearby ids (sense.query), and the agent-sense
      look() of that pose. debug/ sits next to the world dir, gitignored.
- [x] The light budget lesson, learned both ways: a pool SMALLER than a
      zone's live spec set starves lights (a burning candle casting
      nothing — the sea ran 18 specs against 16 slots), but growing the
      pool to 24 measurably hurt frame rate (every pooled light is in
      every lit fragment's loop, used or not). Resolution: pool stays 16,
      and worlds keep UNDER it by faking small sources Cyberpunk-style —
      emissive glow cards (a lit pool on the water doubles as the
      reflection) with `flicker` in the glow preset, dephased by world
      position so a candle field never pulses in lockstep. Real lights
      are for the carried flame and hero fixtures.
- [x] Beams fade with camera height (`fadeAbove`, default 25m, gone by
      ~2.4×): from altitude their walls fill the frame from ANY view
      angle — isolated as the sole cause of the mid-fall grey wash — so
      no sight-line trick survives a level camera. The fall stays dark
      all the way down; the shafts fade back in by the water.

## M16 — the sky as geometry (DONE)

The bright outside, for worlds whose interiors stay dark. scene.background
is ONE color per zone — so a sunny world seen from inside a cave must
physically exist. Everything here is data; no texture assets anywhere.

- [x] Preset `sky`: vertical gradient wall (horizon glow → zenith) with
      drifting fbm banding. Preset `overcast`: a cloud roof crawling
      overhead, the hidden sun burning through at `sunPos` (world xz) —
      bright enough that a dark zone's bloom blows out at any opening.
      Preset `clouds`: torn sheets, fbm alpha dissolved at the quad's own
      uv edges, NORMAL blending (clouds occlude what's beneath them).
- [x] Preset `abyss`: an obsidian ocean. Vertex-displaced swell (planes
      take `segments`), normals rebuilt FLAT per facet from
      `cross(dFdx(positionView), dFdy(positionView))` (normalNode is
      view-space), fresnel sheen + crest tint, and EMISSIVE aerial haze —
      albedo haze multiplies to black under a dark env; painted light
      survives any zone.
- [x] Preset `stone`: masonry without textures — world-space ashlar
      courses with a running bond, per-block value shifts (perlin at
      non-integer multiples of block indices; integer lattices are zero),
      fbm grain on color and roughness. Tops use (x,z), faces (x+z,y),
      blended by the normal. One long box shows no repetition.
- [x] Cylinders take `thetaStart`/`thetaLength`/`radialSegments`: partial
      arcs — carved openings without CSG. Stacked bands only meet
      crack-free on ONE angular lattice: same thetaStart, segment counts
      chosen so every band's step is equal (full ring 64, arc 63 over
      2π − one step).
- [x] `doubleSide` part field — a shell seen from both worlds (a crater:
      pale rock outside, near-black inside) is painted by ZONE LIGHTING,
      not by the part. Culling can't fake an opening on a DoubleSide
      shell; carve a real one.
- [x] `environment.lightScale`: pooled point-light intensities × the
      zone's scale, crossfaded at seams like everything else. A flame
      authored for the dark (intensity 48) washes out under a daylight
      env instead of painting it orange. Flicker behaviors compose (the
      per-frame scale writes baseIntensity too).
- [x] Field-name footgun fixed by rename: preset noise scale is
      `noiseScale` — `scale` was already the mesh-part TRANSFORM scale,
      and a 5200m sky quad authored with `scale: 0.0012` quietly became
      six meters wide.

## Later

- Sandboxed `script` component (QuickJS/worker, error containment, self-healing)
- Full TSL `shader.source` authoring
- Multiplayer presence/avatars, op attribution UI
- Embodied agent characters driving the same sense/act API (a creation-time
  tool — shipped games run fully offline with scripted NPCs)
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
