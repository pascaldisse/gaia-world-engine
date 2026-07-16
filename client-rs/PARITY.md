# Boomtown parity reconnaissance

§ scope → A=`GAIA-World-Engine-unity`/`unity-import`, read-only; B=`GAIA-World-Engine`/`rust-port`; source delta = A-vs-B paths + A commits `704809a8..3b4c10b0` (`boomtown:`). Boomtown world = `A/tools/unity/out/boomtown-world/`; root `A/world/` is unrelated hub sample (39 entities).

## 1. Feature inventory

| feature | implementation location · A delta | Boomtown usage count | client-rs port note |
|---|---|---:|---|
| asset-backed static models | `A/client/kernel/geometry.js` → `shape:model`, GLTF cache/merge; `view.js` async holders/warm-up; `instanced-models.js` static GPU instancing | 87 traffic meshes; 607 prefab refs; 44 prefab docs | GLTF loader → native asset/cache; instance batches keyed mesh+material; preserve async placeholder/warm policy |
| skinned model + clip animation | `A/client/kernel/geometry.js`, `view.js`; schema `mesh.parts[].{animated,variant,placeholderSize}`, new `animation` | runtime peds/police/gangs; authored direct `animation=0` | glTF skins + per-instance animation player; auto idle/walk/run threshold/crossfade |
| player AVP driving | `A/client/kernel/player.js`, new `avp.js`; Ash `ArcadeVP` constants, fixed-step forces/drag/torque, drive camera pose | 87 stealable cars | deterministic fixed timestep; controller/input ownership; do not substitute generic kinematic motion |
| vehicle enter/exit + data specs | `A/server/carjack.js`; `vehicles.json`; `A/client/kernel/interact.js`, `player.js`, `view.js`, `main.js` | 87 `interact` carjack ops; 9 vehicle entries | server validates range/availability → `vehicle` presence state; client drives; exit placement + re-enabled car interaction |
| vehicle hull collision | `A/server/carjack.js` derives real GLB AABB collider; `A/client/kernel/player.js` blocker push/clip seam | 87 `collider`; 87 real car hulls | broadphase + swept capsule/box resolution; asset AABB import; vehicle/player collision parity |
| collider-surface interaction semantics | new `A/shared/collider.js`; changed `A/client/kernel/interact.js`, `server/triggers.js` | 87 traffic car colliders/interacts | distance to blocker-box surface, zero inside; use body/motion position, not entity pivot; shared client/server math |
| path traffic v1 | new `A/server/traffic.js`; changed `shared/motion.js` arc-length/path timing; 200-ms server tick in `server/index.js` | 87 path `behavior` cars; 22 `trafficLight` | authoritative path arc progress; light lookahead, queue/gap, periodic rebuild; compact transform deltas |
| DOTS-shaped ECS host | new `A/shared/ecs/{world,component,command-buffer,scheduler,gaia-bridge}.js`; `client/main.js`, `server/index.js`; schema `ecs` | 1 authored `ecs` route proof; optional DOTS traffic seeds from data | archetype ECS + command buffer + fixed accumulator; bridge canonical documents ↔ typed storage; structural ops only at seam |
| DOTS City road bake + pools | `A/shared/ecs/dotscity/{road-bake,road-static,node-bake,prefab-seeding,config-seeding,spawn-params,spawn-utils,native-containers,local-to-world,lifecycle}.js`; `server/index.js` env gates | roads: 10 JSON families; ECS `road-authoring.json`, `road-graph.json`, `traffic-config.json`, `traffic-prefabs.json` | offline bake assets; spatial/hash containers; deterministic seeded prefab/car pool; `LocalToWorld` derived transform |
| DOTS City traffic systems | `A/shared/ecs/dotscity/bootstrap.js`, `traffic-components.js`, `change-lane-utils.js`, `obstacle-geometry.js`; all `A/shared/ecs/dotscity/systems/*.js` | optional runtime; authored slice=1, car pool config present | port scheduler order exactly from `compiled-order.snapshot.json`; ECS batches/SoA, no per-car scene ops |
| DOTS system set — graph/maps | `systems/{car-hash-map,node-hash-map,npc-hash-map,path-graph,path-hash-map}.js` | 0 direct scene components | stable ID→entity maps; road/path adjacency preprocessing |
| DOTS system set — spawn/pool | `systems/{traffic-public-init,traffic-public-spawner,traffic-spawner,traffic-spawner-callback,traffic-spawner-node-finder,traffic-spawner-spawn-job,traffic-start-init,traffic-cleaner,traffic-cull-stucked,traffic-cull-wheel,traffic-disable-wheel,traffic-enable-wheel,revert-traffic-culled-physics}.js` | pool config; no direct docs | pooled lifecycle, cull/re-enable; avoid allocation/despawn churn |
| DOTS system set — routing/movement | `systems/{traffic-input,traffic-find-next-traffic-node,traffic-next-path-hash-map,traffic-switch-target-node,traffic-target,traffic-target-achieved,traffic-pathfinding,traffic-process-movement-data,traffic-simple-movement,traffic-speed-limit,traffic-speed-rotation,traffic-alignment-at-node,traffic-approach,traffic-taxi}.js` | pool config | fixed-order route target, steering, speed, taxi behavior |
| DOTS system set — traffic areas/lanes/lights | `systems/{traffic-area-clean,traffic-area-enter-queue,traffic-area-exit-wait,traffic-area-lock,traffic-area-observe,traffic-area-observe-enable,traffic-area-observe-disable,traffic-area-process-node,queue-wait,process-enter-parking-node,enter-parking-car,pedestrian-crosswalk,traffic-change-lane,traffic-change-lane-reach,traffic-wait-for-change-lane-event,traffic-avoidance,traffic-avoid-jam,traffic-obstacle,traffic-node-calculate-overlap,traffic-npc-calculate-obstacle,traffic-light-state,traffic-light-indicator-state,traffic-clean-linked-node}.js` | 22 authored `trafficLight`; pool config | preserve group/order barriers; SAT obstacle geometry + queues/lane state are high-cost parity core |
| traffic ECS component set | `A/shared/ecs/dotscity/traffic-components.js` → 55+ typed DOTS components/tags/buffers; `declarations.js`, `groups.js`, `dots-enum.js` | 1 generic `ecs`; runtime cars generated | typed Rust components/buffers; preserve names/field casing at GAIA bridge boundary |
| weapons client + HUD | new `A/client/kernel/weapons.js`, `hud.js`; changed `main.js`, `player.js`; `client/public/assets/weapons.json` | level grants none; `weapons.json`=data catalog | input mapping + HUD; weapon speed penalty; client only requests authoritative ops |
| weapons/damage/armor | new `A/server/weapons.js`, `damage.js`; schema new `weapon`, `health`, `armor`; `server/index.js` routes `equip/fire/reload/damage` | authored `health=87`; `weapon/armor=0`; weapon catalog=2 top-level keys | authoritative cooldown/ammo/reload; hitscan/cone/melee/projectile area; armor reduction; nonpresence despawn |
| crime/wanted | new `A/server/crime.js`; schema `wanted`, `safezone`; 1-Hz tick in `server/index.js` | `safezone=1`; `wanted=0` authored | server point thresholds/cooldowns/decay + safezone multiplier; persistent player state |
| police | new `A/server/police.js`; 200-ms tick, road-graph routing | 0 authored; spawned from wanted | state machine/pool: pursuit cars, officers, firing/arrest; must share vehicle/hull/path queries |
| pedestrians | new `A/server/peds.js`; changed later for traffic variants/facing/run speed; 200-ms tick | `ped=0` authored; `ped-graph.json` seeds runtime | capped proximity pool, graph walk/flee/death/despawn; animation yaw; car run-over attribution |
| gangs + encounters | new `A/server/gangs.js`, `encounters.js`; routes `encounterJoin`; data `gang-territories.json`, `encounters.json` | no authored scene component; data-driven runtime | group AI, allies/hostiles, combat, event lifecycle; dynamic components (`gang`, `encounter`, `score`) are unschematized GAIA docs |
| scene locomotion + camera/body | changed `A/client/kernel/scenes.js`, `main.js`, `player.js`, `view.js`; schema new `locomotion`; Boomtown `game.json` menu/level | `camera=1`, `environment=1`, `locomotion=1`, `spawn=1`; level ops=2 | scene-local walk/run/back multiplier; camera rig/body-visible vehicle mode; parse title/menu/levels unchanged |
| integration/tick ownership | changed `A/server/index.js`: operation expansion + `TrafficSim`, ECS, carjack, weapons, crime, gangs, encounters, police, peds loops | all systems above | retain operation ordering: use → vehicle/weapons/encounter/damage/crime expansion → world apply → ECS reconcile |

### Schema delta — exact new top-level components

`animation`, `ecs`, `health`, `weapon`, `armor`, `ped`, `wanted`, `safezone`, `locomotion` → `A/shared/schema.js`.

Changed existing schema semantics: `mesh.parts[].shape` adds `model`; mesh adds `src`, `animated`, `variant`, `placeholderSize`. Existing `collider`, `interact`, `behavior`, `camera`, `environment`, `game.json` are consumed differently above; `trafficLight`, `vehicle`, `gang`, `encounter`, `score` remain open/document components, not schema declarations.

### Boomtown world-data inventory

Root → `A/tools/unity/out/boomtown-world/world.json`: scenes `boomtown`, `traffic` streamed within same 402.49m load volume; `ecs-slice` always loaded. `game.json`: title/menu camera, one `rampage` level. No daemon/plugin directory under this world; server modules are engine-side daemons.

| data | evidence | count / role |
|---|---|---:|
| scenes | `scenes/{boomtown,traffic,ecs-slice}.json` | 5,261 entities |
| prefabs | `prefabs/*.json` | 44 docs; 607 scene prefab references |
| materials | `materials.json` | 29 entries |
| models | `assets/models/models.json` | catalog: 4 top-level fields; GLBs under `assets/models/` |
| vehicles | `vehicles.json` | 9 keys incl. fixed timestep + 8 classes |
| weapons | `weapons.json`, `assets/weapons.json` | `source`, `weapons` |
| simulation inputs | `roads/*.json` (10), `ecs/{road-authoring,road-graph,traffic-config,traffic-prefabs}.json`, `ped-graph.json` | road/traffic/ped seeds |
| gameplay inputs | `encounters.json`, `gang-territories.json` | dynamic encounter/gang definitions |

### Component histogram — direct scene documents only

| component | total | boomtown | traffic | ecs-slice |
|---|---:|---:|---:|---:|
| transform | 5,259 | 5,149 | 109 | 1 |
| prefab | 607 | 607 | 0 | 0 |
| name | 109 | 0 | 109 | 0 |
| mesh | 108 | 20 | 87 | 1 |
| collider | 87 | 0 | 87 | 0 |
| interact | 87 | 0 | 87 | 0 |
| health | 87 | 0 | 87 | 0 |
| behavior | 87 | 0 | 87 | 0 |
| trafficLight | 22 | 0 | 22 | 0 |
| camera / environment / locomotion / safezone / spawn / light / ecs | 1 each | 1 each except `ecs` | 0 | `ecs=1` |

## 2. Unity-import → rust-port base: merge-required deltas

1. Schema/doc protocol → `shared/schema.js`: model/animation, ECS, combat, ped/wanted/safezone, locomotion.
2. Shared semantic primitives → `shared/collider.js`; `shared/motion.js` arc-length timing.
3. Renderer/model path → `client/kernel/{geometry,view,instanced-models}.js`; skinned clips + warm-up/placeholder.
4. Player/interact/view integration → `client/kernel/{avp,player,interact,scenes}.js`, `client/main.js`; driving, collision seam, surface-range rules, scene locomotion/body visibility.
5. Gameplay UI/client protocol → `client/kernel/{weapons,hud}.js`, `client/public/assets/weapons.json`.
6. Authoritative gameplay systems → `server/{traffic,carjack,weapons,damage,crime,police,peds,gangs,encounters}.js`; `server/index.js` operation routing/ticks.
7. ECS substrate → entire `shared/ecs/` tree; mandatory order artifact `shared/ecs/dotscity/compiled-order.snapshot.json` + `bootstrap.js`.
8. Imported world contract → `tools/unity/out/boomtown-world/{world,game,materials,vehicles,weapons,scenes/,prefabs/,roads/,ecs/,ped-graph.json,encounters.json,gang-territories.json}`.
9. Extraction provenance/tools → `tools/unity/{extract-vehicles,extract-traffic,extract-roads,extract-dotscity-road,emit,emit-traffic,merge-glb-anims}.mjs`; needed to refresh Unity-origin assets.
10. Preserve compatibility distinction → classic 87-car `server/traffic.js` and optional `GAIA_DOTSCITY=1` ECS traffic coexist; do not silently replace either during Rust migration.

## 3. Native Rust reimplementation — top-10 risks

1. DOTS order fidelity → 55+ traffic components/tags + scheduler groups; one ordering change changes lanes/queues/spawns. Evidence: `shared/ecs/dotscity/{bootstrap.js,compiled-order.snapshot.json}`.
2. Traffic scale/perf → path graphs, hash maps, obstacle SAT, culling/pooling; ECS/SoA + fixed budgets required. Evidence: `shared/ecs/dotscity/systems/traffic-*.js`.
3. Dual traffic authority → legacy path cars plus optional ECS cars; duplicate transforms/collisions/IDs risk. Evidence: `server/{traffic,index}.js`.
4. GLTF render parity → static merged instancing vs skinned clone/mixer; material/texture conventions and asset AABBs. Evidence: `client/kernel/{geometry,view,instanced-models}.js`.
5. Vehicle feel → Ash ArcadeVP constants/fixed integration, camera, exit geometry. Evidence: `client/kernel/{player,avp}.js`, `server/carjack.js`.
6. Collision/interact consistency → client predictor and server range must use identical oriented/animated collider-surface metric. Evidence: `shared/collider.js`, `client/kernel/interact.js`, `server/triggers.js`.
7. Network ownership → client-driven player/car pose vs server gameplay/ECS transforms; reconciliation and cheating boundaries. Evidence: `client/main.js`, `server/index.js`, `shared/ecs/gaia-bridge.js`.
8. Dynamic population lifecycle → peds/police/gangs/encounters recursively trigger damage/crime and pooled cleanup. Evidence: `server/{peds,police,gangs,encounters,damage,crime}.js`.
9. Combat semantics → cooldown/ammo/reload timing, hitscan/cone/melee/projectile-area and armor rounding. Evidence: `server/{weapons,damage}.js`, `weapons.json`.
10. World/import reproducibility → generated roads/prefabs/models plus mutable server state; extraction reruns can alter IDs/float geometry. Evidence: `tools/unity/{extract-*.mjs,emit*.mjs}`, `tools/unity/out/boomtown-world/`.

## Evidence commands used

- `git -C A log --oneline --grep='^boomtown:'`; commits: `704809a8`, `b800ff5f`, `bd2e7e2c`, `98b18e6c`, `0de40bb1`, `e9d85036`, `4dea11ab`, `3b4c10b0`.
- `git diff --no-index --stat B/{client,server,shared} A/{client,server,shared}`.
- JSON parse + component count over `A/tools/unity/out/boomtown-world/scenes/*.json` → histogram above.
