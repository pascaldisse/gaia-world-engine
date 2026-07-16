# Server · shared · protocol inventory

Scope → every file under `server/`, `shared/`; source behavior as of `rust-port`. Rewrite key → **Bun** = retain authoritative Bun server; **client-rs** = Rust client/protocol counterpart; **bit-identical** = port exact arithmetic/data semantics.

## HTTP · WebSocket · journal

| Feature | Source file(s) | Behavior | Rewrite note |
|---|---|---|---|
| HTTP/CORS/error envelope | `server/index.js` | `*` origin; `content-type`; `OPTIONS`→204; thrown request errors→JSON 400 `{ok:false,error}`. | Bun |
| `GET /world` | `server/index.js`, `server/world.js` | Returns runtime `{counter,entities}` plus authored `world` superscene and `materials`. | client-rs |
| `GET /events` | `server/index.js` | Returns journal records newer than `since`; default limit 200, hard cap 500; `{latest,events}`. | client-rs |
| Op journal | `server/index.js` | Every applied op gets monotonic `seq`, wall-ms `t`, `from`; retains newest 2,000 records. | client-rs |
| `GET /schema` | `server/index.js`, `shared/schema.js` | Serves the complete component vocabulary verbatim. | client-rs |
| `GET /prefabs` | `server/index.js` | Returns loaded legacy/file-per-prefab library. | client-rs |
| `POST /prefabs` | `server/index.js` | Requires `name` + `components`; upserts `world/prefabs/<name>.json`; emits `prefabs-changed`. | client-rs |
| `GET /assets/*` | `server/index.js` | Serves in-world asset files after normalized traversal check; known audio MIME types. | Bun |
| `POST /op` | `server/index.js`, `server/world.js` | Accepts one op, array, or `{ops,from,dev}`; applies/broadcasts/journals; response contains `applied`. | client-rs |
| `POST /act` | `server/index.js`, `server/intents.js` | Runs agent intent; returns intent result + `sense.look` frame. | Bun |
| WebSocket initial snapshot | `server/index.js`, `server/world.js` | Every connection receives `{type:'snapshot',time,world,game,materials,counter,entities}`. | client-rs |
| WebSocket op ingress/egress | `server/index.js` | Inbound `{type:'ops',ops,from?,dev?}`; outbound `{type:'ops',ops,from}` after authority applies them. | client-rs |
| WebSocket hello | `server/index.js` | `{type:'hello',presence}` binds a socket to its presence for later disconnect reap. | client-rs |
| Presence disconnect reap | `server/index.js`, `server/world.js` | Socket close despawns its registered presence, then broadcasts/journals it. | Bun |
| Screenshot relay | `server/index.js` | `GET /screenshot?from=<presence>` asks WS clients; selected/first responder returns base64 PNG; no-client 503, 8s timeout 504. | client-rs |
| Snapshot artifact | `server/index.js`, `server/sense.js` | `POST /snapshot` writes `../debug/<ISO>.json`, optional PNG; JSON captures player, carried entity, all `state`, nearby query, look, wall/world time. | Bun |

## Authority ops · persistence · authored world

| Feature | Source file(s) | Behavior | Rewrite note |
|---|---|---|---|
| `spawn` op | `server/world.js`, `server/index.js` | Inserts cloned `components`; omitted id becomes `e<counter>`; runtime spawns without scene receive `sceneAt(transform.position)` stamp. | client-rs |
| `set` op | `server/world.js` | Replaces one component; `null`/`undefined` removes it; missing entity refuses. | client-rs |
| `merge` op | `server/world.js`, `server/index.js` | Shallow-merges one component; missing entity materializes and broadcasts as `spawn`; presence transform moves can append a scene-stamp merge. | client-rs |
| `despawn` op | `server/world.js`, `server/index.js` | Deletes existing entity; unknown id refuses; dev write-back removes authored entry. | client-rs |
| `clear` op | `server/world.js` | Clears all runtime entities; marks save dirty. | client-rs |
| `event` op | `server/world.js`, `server/index.js` | Transient `{name,data}` only: broadcast+journal, never entity/save state. | client-rs |
| `scene` op | `server/index.js`, `shared/ops.js`, `shared/scenes.js` | Updates a known `world.json` scene entry, re-normalizes streaming index, persists/broadcasts; keys merge, null keys delete; top-level null becomes empty merge here. | client-rs |
| `material` op | `server/index.js`, `shared/ops.js` | Merges named `materials.json` entry; null entry deletes it, null member deletes member; persists/broadcasts. | client-rs |
| `reset` op | `server/index.js` | Expands before application: emits reset event, reloads `world.json`, reloads selected/all scene files, broadcasts scene metadata, despawns non-persist/non-presence scene residents, re-seeds authored entities; save/player layer survives. | client-rs |
| `use` op | `server/index.js`, `server/triggers.js` | Authority-expands `{op:'use',id,by}` to interact event/ops only when target, user, distance, gate, cooldown pass. | client-rs |
| Dev batch | `server/index.js` | `{dev:true,ops}` / WS equivalent applies normally, then writes only authored scene entity mutations after 400ms; player-layer changes never write scenes. | Bun |
| Op batch ordering | `server/index.js`, `server/world.js` | Reset/scene/material/use expansion happens before one sequential `applyOps`; `use` evaluates pre-batch state. | client-rs |
| Named-library merge | `shared/ops.js` | `mergeIntoLibrary`: null entry delete; otherwise shallow merge; `name` ignored; null fields delete. | bit-identical |
| `$` substitution | `shared/ops.js`, `server/triggers.js` | Deep-recursive authored values replace exact `$id` and `$now`; clone before mutation. | bit-identical |
| `when` gate | `shared/ops.js`, `server/triggers.js` | Every `entity.component.path` must strictly equal expected value. | bit-identical |
| Runtime world store | `server/world.js` | Map-backed entities + counter; snapshots serialize objects; unsupported ops refuse silently. | Bun |
| Save layer | `server/index.js`, `server/world.js` | `GAIA_SAVE` file stores only presence, `persist`, and unclaimed/no-`scene` entities; trailing 1s save throttle; scene entities re-seed fresh at boot. | Bun |
| Scene write-back | `server/index.js`, `shared/schema.js` | Dev spawn/set/despawn writes `world/scenes/<name>.json`; strips scene stamp and runtime `weather.rain`; prefab instances write only deltas. | Bun |
| Superscene | `server/index.js`, `shared/scenes.js` | `world/world.json` owns composition/default voidY and per-scene bounds/neighbors/load metadata; all scene files receive metadata entry. | client-rs |
| Scene documents | `server/index.js` | `world/scenes/<name>.json` maps id→component docs in world space; missing directory/content creates implicit `main` on first write. | client-rs |
| Prefab expansion | `server/index.js` | Legacy `prefabs.json` plus `prefabs/*.json`; instance `prefab` base components deep-merge beneath document deltas and retain runtime prefab stamp. | client-rs |
| Deep merge | `server/index.js` | Object-only recursive clone/merge for prefab base+deltas; arrays/scalars replace. | bit-identical |
| Scene reload semantics | `server/index.js` | Reset cancels queued scene write then reloads disk truth; world metadata reload failure preserves current in-memory metadata. | Bun |
| Presence scene stamps | `server/index.js`, `shared/scenes.js` | Spawned bodies infer scene by x/z; presence transform set/merge across scene bounds appends `merge scene.name`, keeping perception/streaming scoped. | client-rs |

## Senses · intents · triggers · weather

| Feature | Source file(s) | Behavior | Rewrite note |
|---|---|---|---|
| `GET /sense/look` | `server/index.js`, `server/sense.js` | Text FOV frame: pose/ground/slope, ≤12 salient visible entities, audible sounds; accepts pose/yaw/fov/range or `as`; `as` ensures agent avatar. | client-rs |
| `GET /sense/map` | `server/index.js`, `server/sense.js` | ASCII terrain-height grid + entity legend; accepts x/z/radius/cells. | client-rs |
| `GET /sense/describe` | `server/index.js`, `server/sense.js` | Text component/mesh/light/sound/behavior summary and animated position; missing id→404. | client-rs |
| `GET /sense/query` | `server/index.js`, `server/sense.js` | JSON entities filterable by `has`, id substring `name`, nearX/nearZ/radius; positions rounded 0.1 and distance-sorted. | client-rs |
| `GET /sense/check` | `server/index.js`, `server/sense.js` | Text lint: float/bury, overlap, unlit lights, terrain steepness; maximum 20 findings. | client-rs |
| Sense scene scope | `server/sense.js`, `shared/scenes.js` | Look/map exclude entities outside observer active scenes; y-aware look honors load-volume y, top-down map uses neighbor fallback. | client-rs |
| Sense motion/ground | `server/sense.js`, `shared/motion.js`, `shared/terrainmap.js` | Senses use world-clock animated positions and routed deterministic terrain height, not authored static transforms. | bit-identical |
| Agent avatar | `server/intents.js` | Missing acting id spawns luminous bobbing agent presence at `[2,0,16]`. | Bun |
| Agent intents | `server/intents.js` | `move_to`, `walk`, `face`, `grab`, `drop`, `say`; finite-speed 100ms movement, 90s move deadline, supersession, intent/grab/drop/say events. | Bun |
| Agent grab range | `server/intents.js` | Grab requires planar distance ≤4m; held target follows 1.6m ahead each tick. | Bun |
| Trigger volumes | `server/triggers.js`, `shared/scenes.js`, `shared/ops.js` | 250ms scans all presences; circle/rectangle area, optional y limits, `on:'enter'` default or `exit`, `when`, per-trigger cooldown, event + expanded ops. | Bun |
| Trigger area center | `server/triggers.js` | Missing `trigger.area.center` derives x/z from owner transform. | client-rs |
| Trigger expansion | `server/triggers.js`, `shared/ops.js` | Each firing substitutes `$id`→entering presence and `$now`→rounded world seconds; event data adds `trigger`,`by`. | client-rs |
| Interact/use range | `server/triggers.js` | Target must have interact and live user; 3D distance ≤`(radius || 4)+2m` publication slack; then `when` and cooldown; emits configured/default `use` event plus substituted ops. | client-rs |
| Trigger cleanup | `server/triggers.js` | Removes inside-map pairs after trigger/presence despawn. | Bun |
| World clock | `server/index.js` | Seconds since boot; shared source for triggers and deterministic motion senses. | client-rs |
| Weather | `server/index.js`, `shared/schema.js`, `shared/num.js` | 1s server sim: each weather entity schedules randomized lightning, optional double strike, and sinusoidal rain cycle; emits lightning events/merges rounded rain. | Bun |

## Shared deterministic substrate

| Feature | Source file(s) | Behavior | Rewrite note |
|---|---|---|
| Numeric wire precision | `shared/num.js` | `r2` rounds x100; `r1` rounds x10. | bit-identical |
| Behavior normalization | `shared/motion.js` | `behavior` accepts object or array; canonical list. | bit-identical |
| Animated position | `shared/motion.js` | Ordered orbit, path, bob evaluation from world seconds; ground offsets/rides terrain; path uses speed, phase/start, dwell fourth waypoint, loop/park. | bit-identical |
| Path leg cache | `shared/motion.js` | WeakMap caches leg timing by behavior object, point array, speed. | bit-identical |
| Motion detection | `shared/motion.js` | `hasMotion` recognizes orbit/bob/path. | bit-identical |
| Noise primitives | `shared/noise.js` | `hash2`, smooth value noise, FBM, Mulberry32 seeded PRNG. | bit-identical |
| Terrain height | `shared/noise.js` | FBM height from seed/amplitude/frequency defaults. | bit-identical |
| Terrain routing | `shared/terrainmap.js`, `shared/noise.js` | Height selects containing terrain square, otherwise nearest; terrain entries derive from entity map transforms. | bit-identical |
| Scene normalization | `shared/scenes.js` | Normalizes voidY, scene bounds/neighbors/always/load; empty scene list→null. | bit-identical |
| Area containment | `shared/scenes.js` | Shared circle-or-rectangle `inArea`; radius wins; default size `[10,10]`. | bit-identical |
| Scene claim | `shared/scenes.js` | Single scene claims all; otherwise smallest containing bounds disc wins. | bit-identical |
| Active-scene streaming | `shared/scenes.js` | Resident set = current + always + neighbors, except explicit load-volume scenes load only when inside; previous residents get 2m unload padding. | bit-identical |
| Rain sense vocabulary | `shared/schema.js` | `SENSES.rain` declares integer proprio/fov channels and BACK/SKEW/FLOAT/SINK/STIFF convictions. | client-rs |
| Schema helpers | `shared/schema.js` | `componentDefaults()` returns authorable defaults; `fieldInfo(component,key)` returns field metadata/null; runtime write-back fields = `weather.rain`. | client-rs |
| VRoid protobuf model | `shared/vroid.js` | Lossless shallow wire parser/serializer (`Msg`), slider catalog/value reader and float32 setter for VRoid Studio data.bin. | client-rs |
| ZIP CRC-32 | `shared/zip.js` | Lazy-table CRC-32 over Uint8Array-compatible input. | bit-identical |
| ZIP reader | `shared/zip.js` | Reads ZIP32 stored/deflate-raw entries, validates headers/sizes/CRC; rejects ZIP64/multi-disk/unsupported methods. | client-rs |
| ZIP writer | `shared/zip.js` | Writes UTF-8 stored ZIP32 entries with CRC and central directory; validates size/count limits. | client-rs |

## Component vocabulary — `GET /schema`

| Feature | Source file(s) | Behavior | Rewrite note |
|---|---|---|
| `transform` | `shared/schema.js` | World position, Euler rotation, uniform/vector scale. | client-rs |
| `ground` | `shared/schema.js` | Terrain y snap with meter offset. | client-rs |
| `mesh` | `shared/schema.js` | Visible multipart primitives/tubes, CSG carve, named materials/presets, shading/collision flags, VRM avatar data. | client-rs |
| `characterCreator` | `shared/schema.js` | Clean-room humanoid slider/color recipe. | client-rs |
| `light` | `shared/schema.js` | Point/spot/directional illumination; presence light is carried. | client-rs |
| `sound` | `shared/schema.js` | Positional/ambient synth patch, chime, hum, or sample audio. | client-rs |
| `sfx` | `shared/schema.js` | Event-driven one-shot positional synth. | client-rs |
| `behavior` | `shared/schema.js` | Deterministic spin/bob/orbit/path/pulse/flicker motion data. | client-rs |
| `terrain` | `shared/schema.js` | Seeded procedural terrain and its mesh parameters. | client-rs |
| `collider` | `shared/schema.js` | Analytic local boxes: walkable tops or blockers. | client-rs |
| `water` | `shared/schema.js` | Swimmable area at level; optional drown timeout. | client-rs |
| `trigger` | `shared/schema.js` | Server-side presence volume with edge/gate/cooldown/event/ops. | client-rs |
| `interact` | `shared/schema.js` | Explicit in-range E/use prompt with gate/cooldown/event/ops. | client-rs |
| `persist` | `shared/schema.js` | Protects entity truth across reset and puts it in save layer. | client-rs |
| `spawn` | `shared/schema.js` | Player entry/void-return pose and optional edit lock. | client-rs |
| `scatter` | `shared/schema.js` | Seeded instanced placement recipe with area/height/randomization controls. | client-rs |
| `particles` | `shared/schema.js` | Seeded animated drift/rain mote recipe. | client-rs |
| `environment` | `shared/schema.js` | Scene mood: background/fog/light/bloom/master audio. | client-rs |
| `camera` | `shared/schema.js` | Environment-scoped first-person or fixed side 2.5D rig. | client-rs |
| `warp` | `shared/schema.js` | One-shot server-directed owning-player eye-pose relocation. | client-rs |
| `weather` | `shared/schema.js` | Server lightning/rain-cycle controls. | client-rs |
| `scene` | `shared/schema.js` | Server stamp naming owning scene file. | client-rs |
| `prefab` | `shared/schema.js` | Instance link to named prefab with authored deltas. | client-rs |
| `presence` | `shared/schema.js` | Connected player/agent marker; published, not authored. | client-rs |

## Environment/config inventory

| Feature | Source file(s) | Behavior | Rewrite note |
|---|---|---|
| `GAIA_PORT` | `server/index.js`, `vite.config.js` | World HTTP/WS port; default `8420`; Vite injects it as `__GAIA_PORT__`. | Bun |
| `GAIA_WORLD` | `server/index.js` | Absolute world directory; default engine `world/`. | Bun |
| `GAIA_SAVE` | `server/index.js` | Save name; default `default`; path `world/saves/player_<name>_state.json`. | Bun |
| `GAIA_CLIENT_PORT` | `vite.config.js`, `tools/cdp-lib.mjs` | Vite port/default `5173`; CDP URL matcher uses same default. No server/shared reader. | client-rs |
| `GAIA_URL` | `tools/agent.mjs`, `tools/patch.mjs`, `tools/nari-soma.mjs` | External tool base URL; default localhost:8420 (nari-soma derives GAIA_PORT). | Bun/tooling |
| `GAIA_AGENT` | `tools/agent.mjs`, `tools/nari-soma.mjs` | External agent body id; defaults `agent-claude` / `agent-nyari`. | Bun/tooling |
| `NARI_SOMA_BODY_ID` | `tools/nari-soma.mjs` | External Nyari avatar id; default `nyari-avatar`. | Bun/tooling |
| `CDP_HOST`, `CDP_PORT` | `tools/cdp-lib.mjs` | External browser DevTools host/default `127.0.0.1`, port/default `9222`. | Bun/tooling |
| `GAIA_BOOMTOWN_WORLD` | `client-rs/crates/gaia-protocol/src/lib.rs` | Rust protocol fixture/world-root override. | client-rs |
| `GAIA_DOTSCITY` | `client-rs/PARITY.md` | Documented optional ECS-traffic compatibility switch; no reader found in server/shared. | client-rs/documentation |

## Gate — schema cross-check

```text
$ bun -e "import {SCHEMA} from './shared/schema.js'; console.log(Object.keys(SCHEMA).length)"
24

schema keys = 24
component rows above = 24
missing = 0
```
