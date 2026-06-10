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
- `sound` — `{kind: hum|chime, freq|notes, interval, level, refDistance}` (synthesized, positional)
- `terrain` — `{seed, size, segments, amplitude, frequency, color}` (one per world)
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

## Architecture

- `server/` — canonical world store + WebSocket/HTTP patch hub, persists to `world/world.json`
- `client/kernel/` — renderer, store mirror, view reconciler, terrain, player, audio, behaviors
- `tools/patch.mjs` — the agent interface; the seed of the patch protocol
- Environment lighting is kernel-owned for now; it moves into world data later.
- Deferred: sandboxed script behaviors, observability API (screenshots/queries),
  in-world inspector panels, auto-batching/instancing, multiplayer presence.
