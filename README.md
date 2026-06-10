# GAIA World Engine

Half game, half engine. The world is a live database of entity documents; every
viewer, tool, and agent is a client that patches it over a shared protocol. The
3D client (three.js, WebGPU with WebGL fallback) renders whatever the world
server says exists — changes appear in real time while you walk around. 3D only.

## Run

```sh
npm install
npm run dev       # world server on :8420 + vite client on :5173
```

Open http://localhost:5173, click to enter. WASD move, mouse look, shift run,
esc to release the pointer. **E** grabs the entity under the crosshair (scroll
to push/pull, E again to drop) — carries stream live to every client. World
state persists in `world/world.json` (delete it to re-seed from
`world/seed.json`).

**Tab** toggles creator mode (Unity-style controls): click anything to select
it (the terrain too). **Q/W/E/R** = view/move/rotate/scale tools, **F** frames
the selection, hold **RMB** to fly (WASD + Q/E down/up, view-relative, no
ground clamp), scroll dollies. Lifting a grounded entity with the Y arrow
edits its `ground.offset`, so it hovers relative to the terrain. The inspector
panel auto-generates sliders/pickers from the entity's JSON (raw JSON tab
included), **⌘D** duplicates, **⌫** deletes, **⌘Z/⌘⇧Z** undo/redo (your own
edits, as inverse ops). The bottom palette stamps prefabs with a ghost
preview — click to place, right-click/esc to stop. Prefabs live on the server
(`GET/POST /prefabs`, or `node tools/patch.mjs prefab <name> '<components>'`)
so agents can hand you new brushes at runtime.

## Patch the world while it runs

```sh
node tools/patch.mjs spawn '{"transform":{"position":[5,0,5]},"ground":{},"mesh":{"parts":[{"shape":"box","color":"#c0392b"}]}}' my-box
node tools/patch.mjs merge my-box transform '{"scale":2}'
node tools/patch.mjs set my-box behavior '{"type":"spin","speed":2}'
node tools/patch.mjs despawn my-box
node tools/patch.mjs snapshot
node tools/patch.mjs load path/to/ops.json
```

Or POST raw ops to `http://localhost:8420/op`:
`{"ops":[{"op":"spawn","id":"x","components":{...}}]}`. Ops: `spawn`, `set`
(component value, `null` removes), `merge` (shallow-merge into a component),
`despawn`, `clear`. All connected clients receive every applied op live.

## Components

- `transform` — `{position:[x,y,z], rotation:[rx,ry,rz], scale: n|[x,y,z]}`
- `ground` — `{offset: n}` snap y to terrain height (re-snaps when terrain changes)
- `mesh` — `{parts:[{shape, color, emissive, emissiveIntensity, roughness, metalness, opacity, flatShading, position, rotation, scale, castShadow, ...shape params}]}`
  - shapes: `box(size)`, `sphere(radius)`, `cylinder(radiusTop,radiusBottom,height)`,
    `cone(radius,height)`, `torus(radius,tube)`, `octahedron(radius)`,
    `icosahedron(radius)`, `plane(size)`
- `light` — `{type: point|spot|directional, color, intensity, distance, offset, castShadow}`
- `sound` — `{kind: hum|chime|patch|sample, ambient?, level, refDistance}` (positional, or `ambient:true` for world-wide)
  - `patch`: `{layers:[{source: noise|sine|square|sawtooth|triangle, freq, detune, filter:{type,freq,Q}, gain, lfo:{target: gain|freq|filter, rate, depth}, reverb}]}` — Tomb-class layered ambience as data
  - `sample`: `{url: "assets/file.ogg", loop, rate}` — files served from `world/assets/`, drop them in
- `sfx` — `{on: lightning|grab|drop|say|intent, wave, freq, freqEnd, attack, decay, level, lowpass, sweep, reverb}` — one-shot synth triggered by events, positional at its entity
- `weather` — `{lightning, minGap, maxGap, rainCycle, rainAmount}` (server-simulated: emits `lightning` events → all clients flash + thunder; cycles `rain` 0..1, which scales any rain-type particles)
- `terrain` — `{seed, size, segments, amplitude, frequency, color}` (one per world)
- `scatter` — `{seed, count, area:{shape:circle|rect, center, radius|size}, instance:{parts:[...]}, scale:[min,max], tilt, rotateY, offsetY, density:{noise, bias}}` — hundreds of instanced copies in a few draw calls, terrain-following, fbm-clustered
- `particles` — `{seed, count, size, color, area, motion:{type:drift|rain, speed, radius, height, bob}}` — animated instanced motes (fireflies, souls, rain)
- `environment` — `{background, fog:{color, near, far | density}, exposure, hemisphere:{sky, ground, intensity}, sun:{color, intensity, position}, bloom:{strength, radius, threshold}, audio:{level, reverb, compressor}}` — world mood as one patchable entity
- mesh parts accept `preset: glow|flame|water|hologram` — TSL shader materials as data (a failing preset falls back to a standard material); flame/glow look best on crossed planes
- `behavior` — one or array of:
  - `{type:"spin", speed}`
  - `{type:"bob", amplitude, speed, phase}`
  - `{type:"orbit", center, radius, speed, height, phase, ground}` (`ground:true` follows terrain)
  - `{type:"pulse", speed, amount}`
  - `{type:"flicker", amount}` (needs a `light`)

## Agents sense & act (no eyes needed)

```sh
node tools/agent.mjs look            # text viewport from the avatar's pose
node tools/agent.mjs map 0 0 25      # ASCII terrain + entity map
node tools/agent.mjs describe crystal
node tools/agent.mjs query --has sound
node tools/agent.mjs check           # semantic lint: floaters, overlaps
node tools/agent.mjs events 0        # op journal tail
node tools/agent.mjs move 0 6        # avatar walks there; returns look frame
node tools/agent.mjs walk 1 0 3 | face crystal | grab firefly-1 | drop | say "hi"
```

The first act/look spawns a visible glowing avatar (`agent-claude`) that
travels at finite speed over the terrain — watch it from the client. HTTP:
`GET /sense/{look,map,describe,query,check}`, `GET /events?since=`,
`POST /act {intent, as, ...}`.

`node tools/agent.mjs shot out.png` captures a real screenshot through a
connected browser tab (the slow path, for judging beauty; the tab must be
visible). Senses run on the world clock, so orbiting/bobbing entities are
sensed at their live positions, and each player publishes a presence entity
agents can see and walk to.

## Architecture

- `server/` — canonical world store + WebSocket/HTTP patch hub, persists to `world/world.json`
- `client/kernel/` — renderer, store mirror, view reconciler, terrain, player, audio, behaviors
- `tools/patch.mjs` — the agent interface; the seed of the patch protocol
- Environment lighting is kernel-owned for now; it moves into world data later.
- Deferred: sandboxed script behaviors, observability API (screenshots/queries),
  in-world inspector panels, auto-batching/instancing, multiplayer presence.
