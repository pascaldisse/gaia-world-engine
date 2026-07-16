# Client feature inventory — rust-port

Scope → every text source under `client/`; binary VRM/VRMA payloads listed as assets. Port note: `native Rust` → Bevy/wgpu/Tauri-side capability; `DOM overlay` → retained/rebuilt webview UI; `dies` → browser-only behavior with no native equivalent required.

| Feature | Source file(s) | What it does | client-rs port note |
|---|---|---|---|
| WebGPU renderer/bootstrap | `client/kernel/renderer.js` | Creates WebGPU renderer, scene, perspective camera, resize path, ACES tone mapping, shadowed sun/hemi lights, TSL bloom fallback. | native Rust |
| Render/post chain | `client/kernel/renderer.js`, `client/kernel/environment.js` | TSL scene-pass bloom; environment can set bloom strength/radius/threshold. | native Rust |
| Geometry recipe cache | `client/kernel/geometry.js` | Recipe-keyed shared geometry/material caches; shared resources never disposed by consumers. | native Rust |
| Primitive mesh recipes | `client/kernel/geometry.js` | Builds box, sphere, cylinder/partial arc, cone, torus, octahedron, icosahedron, plane and tube parts. | native Rust |
| Tube/cave geometry | `client/kernel/geometry.js` | Catmull-Rom tube with arc-length rings, parallel-transport frame, eased per-point radii, inside winding, deterministic wobble. | native Rust |
| Carve CSG | `client/kernel/geometry.js` | Recipe-time `carve` subtraction; hollow subtraction for tube shells; inward tube winding repair. | native Rust |
| Named materials | `client/kernel/geometry.js`, `client/main.js` | Resolves `materials.json` names plus local overrides; merges live `material` ops and rebuilds references. | native Rust |
| Standard material recipes | `client/kernel/geometry.js` | Standard PBR color/roughness/metalness/emissive/transparency/fog/double-side material construction. | native Rust |
| Shader material presets | `client/kernel/presets.js`, `client/kernel/geometry.js` | TSL presets: glow, flame, beam, sky, overcast, clouds, abyss, stone, water, hologram; failed presets fall back to PBR. | native Rust |
| Sky/weather sheets | `client/kernel/presets.js`, `client/kernel/environment.js`, `client/main.js` | Geometry sky/overcast/clouds sheets, environment sky/fog/sun/exposure, weather rain count and lightning response. | native Rust |
| Terrain rendering | `client/kernel/terrain.js` | Cached deterministic heightfield meshes; multi-terrain registry routes local/world height lookup. | native Rust |
| Scatter instancing | `client/kernel/scatter.js`, `client/kernel/view.js` | Deterministic terrain-following clustered scatter rendered as per-part `InstancedMesh` batches. | native Rust |
| Particle instancing | `client/kernel/particles.js`, `client/kernel/view.js` | Up-to-5000 deterministic motes/rain; rain streak orientation, terrain-ground cache, weather/debug count controls. | native Rust |
| Light pool | `client/kernel/view.js`, `client/kernel/environment.js` | Fixed 16-point-light pool assigns nearest light specs, preventing runtime shader-key churn; supports carried local light. | native Rust |
| Direct lights | `client/kernel/view.js` | Build-time spot/directional/shadow point lights attach directly; runtime direct-light changes intentionally costly. | native Rust |
| Fog families/crossfade | `client/kernel/environment.js`, `client/kernel/viewfx.js` | Applies linear or exp² fog, mutates same fog object where possible, crossfades atmosphere; editor can gate either family. | native Rust |
| Environment mood | `client/kernel/environment.js` | Applies background, fog, exposure, hemi/sun/ambient, light scale, bloom and audio buses; lightning flash and dark dip. | native Rust |
| Warm-up | `client/kernel/view.js` | Builds all entities; probes every mesh/scatter/interact/trigger material and particles through real render path; unculls three frames. | native Rust |
| Scene graph reconciliation | `client/kernel/view.js` | Converts entity components into groups, mesh/terrain/scatter/particle/light/sound children; disposes own GPU objects safely. | native Rust |
| Transform smoothing | `client/kernel/view.js` | Interpolates remote transforms/rotation; grounded positions resolve height; suppresses local-edit echo. | native Rust |
| Render draw modes | `client/kernel/shading.js`, `client/main.js` | Lit preserves authored materials; unlit/wire derive cached basic materials with readable color and neutral exposure. | native Rust |
| View FX gates | `client/kernel/viewfx.js`, `client/main.js` | Per-mode and per-toggle skybox, fog, particles, post, lights and audio gates; reasserted on streamed builds. | native Rust |
| Effects tweens | `client/kernel/effects.js` | Spawn wisps, scale-in/out materialization and generic tween lifecycle. | native Rust |
| Player input/look | `client/kernel/player.js` | Pointer-lock yaw/pitch, keyboard state, overlay locking, first-person free look. | native Rust |
| Player locomotion | `client/kernel/player.js` | WASD/sprint acceleration, editor flight/noclip, gravity, terrain/mesh/collider ground resolution and blockers. | native Rust |
| Player crouch/jump | `client/kernel/player.js` | Smooth crouch eye height, crouch-jump clearance, jump lock and gravity arc. | native Rust |
| Water/swim/drown | `client/kernel/player.js`, `client/kernel/view.js`, `client/main.js` | Water area lookup, buoyancy, swim slowdown, sinking/drown/respawn plus splash and world events. | native Rust |
| Moving platforms/safe ground | `client/kernel/player.js`, `client/kernel/view.js` | Analytic walkable boxes, platform positional/yaw carry, mesh-surface fallback, static last-safe pose. | native Rust |
| Void handling | `client/kernel/player.js`, `client/kernel/scenes.js`, `client/main.js` | Scene-specific `voidY`; fall returns safe pose or spawn; scene update follows player each frame. | native Rust |
| Warp component | `client/main.js`, `client/kernel/player.js`, `client/kernel/scenes.js` | Presence `warp` atomically moves body, streaming/void/safe ground, optional fade, publishes arrival and clears edge trigger. | native Rust |
| Camera rigs/side mode | `client/kernel/scenes.js`, `client/kernel/player.js`, `client/main.js` | Scene camera component selects fixed side rig, damped follow/look-ahead, fixed controls, own body visibility and crosshair removal. | native Rust |
| Body facing | `client/kernel/player.js`, `client/kernel/view.js`, `client/main.js` | `bodyYaw` follows look in FPS or velocity under rig; local body and presence publication use it. | native Rust |
| Carried light | `client/kernel/view.js`, `client/main.js` | Own presence light rides flat camera frame or side-mode body frame, takes a pooled-light slot. | native Rust |
| Interaction/use | `client/kernel/interact.js`, `client/main.js` | FPS ray pick or side-rig body-radius pick; condition check, prompt, server `use` operation. | native Rust |
| Grab/carry | `client/kernel/interact.js` | Non-game-mode grab, scroll distance, interpolated carry merge stream, dev-persisted drop and undo. | native Rust |
| Scene composition/streaming | `client/kernel/scenes.js`, `client/kernel/view.js` | Normalizes world scenes; chooses current bounds scene, neighbors/always/load-volume active set; resident scenes hide/show and time-slice builds. | native Rust |
| Scene environment/camera seams | `client/kernel/scenes.js`, `client/kernel/environment.js`, `client/kernel/view.js` | Current scene controls environment crossfade, camera rig and ambient audio fade. | native Rust |
| Scene-op editing | `client/kernel/scenes.js`, `client/main.js`, `client/kernel/panel.js` | Live `scene` ops merge world composition then re-evaluate streaming; inspector persists bounds/load/neighbors JSON. | native Rust |
| World store | `client/kernel/world.js` | Canonical-server mirror with snapshot/spawn/set/despawn/clear application and change listeners. | native Rust |
| WebSocket network | `client/kernel/net.js`, `client/main.js` | Per-tab client ID, reconnect/backoff, hello presence, snapshot/ops/screenshot dispatch, plain vs `dev:true` op send. | native Rust |
| Snapshot/material application | `client/main.js`, `client/kernel/world.js`, `client/kernel/geometry.js` | Sets synced clock/material library/world scene index before snapshot build; applies ops and live material updates. | native Rust |
| Presence replication | `client/main.js`, `client/kernel/view.js` | On-demand player presence spawn; throttled transform/bodyYaw publication; hides own FPS head and smooths others. | native Rust |
| Behavior animation | `client/kernel/behaviors.js` | Shared-clock orbit/bob/path motion plus spin, pulse and light flicker; paths face movement. | native Rust |
| Shared visual motion | `client/kernel/behaviors.js`, `client/kernel/view.js` | Uses shared motion math and terrain height so client display agrees with server/world senses. | native Rust |
| Audio graph | `client/kernel/audio.js` | WebAudio listener, master/compressor/mute, generated convolver/noise and environment bus controls. | native Rust |
| Audio content | `client/kernel/audio.js`, `client/kernel/view.js` | Cached samples plus positional/ambient synth hum/chime/patch, LFO/filter/reverb, one-shots/splash/thunder, scene ambience fades. | native Rust |
| Audio performance | `client/kernel/audio.js` | Positional panner ramps only when transform/listener direction changes. | native Rust |
| Rain perception | `client/kernel/rain.js`, `client/main.js` | Exposes `gaia.rain`: VRM skeleton proprioception token grid and geometry-only FOV entities grid. | native Rust |
| Creator mode | `client/kernel/editor.js`, `client/main.js` | Tab toggles create/play; transform controls, flight/orbit/dolly, game-mode lockout, selection and framing. | native Rust |
| Transform editor | `client/kernel/editor.js`, `client/kernel/history.js` | W/E/R/Q transforms, live throttled ops, grounded offset handling, duplicate/delete and inverse-op undo/redo. | native Rust |
| Mesh edit lens | `client/kernel/editor.js`, `client/kernel/geometry.js` | Inspector edit mode exposes tube spline points/radius rings and `carve` cutter ghosts; release commits one undoable mesh op. | native Rust |
| Mesh hole operations | `client/kernel/editor.js`, `client/kernel/outliner.js`, `client/kernel/panel.js` | N/add creates camera/surface-positioned box cutter; delete removes it; outliner children select/frame it; raw carve fields hidden. | native Rust |
| Gizmo overlays | `client/kernel/gizmos.js`, `client/kernel/outliner.js` | X-ray categories: colliders, triggers/use ranges, water, light/sound ranges, behavior/tube paths, areas, spawns, scene bounds/load cages. | native Rust |
| Outliner | `client/kernel/outliner.js` | Searchable world/scene/presence groups, streaming dim state, selectable bodyless entities, scene settings gear and gizmo chips. | DOM overlay |
| Inspector fields | `client/kernel/panel.js` | Schema-driven component fields, ranges/enums/colors, add-component list, duplicate/delete, selected component Cmd/Ctrl-Backspace removal. | DOM overlay |
| Inspector JSON | `client/kernel/panel.js` | Entity full JSON tab and scene composition JSON editor; diff ops with undo and error feedback. | DOM overlay |
| Prefab palette | `client/kernel/palette.js` | Fetches prefab library, creates terrain-raycast ghost, stamps prefab instance plus position and undo entry. | DOM overlay |
| Editor history | `client/kernel/history.js` | Local 100-entry undo/redo, coalescing rapid edits by key. | native Rust |
| Event console | `client/kernel/console.js` | L-toggle live op/event log with filters, event-only/presence switches, capped scroll list. | DOM overlay |
| DOM utility layer | `client/kernel/dom.js` | DOM construction helpers, typing guard and pointer-to-NDC conversion. | DOM overlay |
| Editor viewbar | `client/main.js`, `client/index.html`, `client/kernel/shading.js`, `client/kernel/viewfx.js` | Create-only lit/unlit/wire controls, View FX dropdown and stop/resume simulation toggle; play restores defaults. | DOM overlay |
| Debug look panel | `client/main.js`, `client/index.html` | Backquote brightness/skylight/fog/storm/flame/rain tuning, keyboard navigation and dev-save bake to world data. | DOM overlay |
| Deep-link startup | `client/main.js` | Supports `create`, `select`, `gizmos`, `pos`, `yaw`, `pitch`, `level`, `mute`, `log`; create path positions editor camera. | native Rust |
| HUD/overlay | `client/index.html`, `client/main.js` | Connection/entity/mute HUD, overlay/pointer-lock prompt, crosshair, contextual hint, title event toast and chat input. | DOM overlay |
| Title screen/game levels | `client/main.js`, `client/index.html` | `game.json` title/subtitle/menu camera/NEW GAME/level select; frozen menu has no presence until level ops/reset/spawn. | DOM overlay |
| Chat | `client/main.js` | T opens transient input; Enter POSTs real `say` act as local presence. | DOM overlay |
| Mute | `client/main.js`, `client/kernel/audio.js` | M and `?mute` gate audio with localStorage persistence; combines user, stop and view-audio gates. | native Rust |
| Screenshot service | `client/main.js`, `client/kernel/net.js` | Handles addressed socket screenshot request; captures rendered WebGPU canvas PNG and returns base64. | native Rust |
| Debug snapshot (+) | `client/main.js` | `+` captures post-render canvas plus player pose/scene to server `/snapshot`. | native Rust |
| Character creator | `client/plugins/character-creator.js` | C in create mode opens clean-room primitive avatar builder; presets/randomization/spawn-update persist `characterCreator` data. | DOM overlay |
| VRM loading | `client/kernel/vrm.js`, `client/kernel/view.js` | Fetch-byte cache, GLTF/VRM WebGPU MToon load, VRM0 rotation, skeleton optimization and entity mounting. | native Rust |
| VRM data edits | `client/kernel/vrm.js`, `client/plugins/vrm-editor.js` | Semantic material-slot colors, expressions, humanoid/nonhumanoid bone scales, live entity/probe preview. | native Rust |
| VRM animation | `client/kernel/vrm.js`, `client/kernel/view.js`, `client/main.js` | Live registry ticks springs; procedural idle/blink/walk/dance and retargeted VRMA clip playback with priority. | native Rust |
| VRM export | `client/kernel/vrm.js`, `client/plugins/vrm-editor.js` | Patches original GLB JSON MToon/PBR colors, bones and meta while retaining BIN; downloadable `.vrm`. | native Rust |
| VRoid source editor | `client/plugins/vrm-editor.js` | Reads/writes `.vroid` zip `data.bin` parameter tree; slider grouping and source re-download, no engine mesh bake. | DOM overlay |
| VRM editor UI | `client/plugins/vrm-editor.js` | V in creator mode selects templates, enumerates loaded slots/expressions, edits/spawns/updates/exports/reset avatars. | DOM overlay |
| VRM/VRMA assets | `client/assets/vrm/*.vrm`, `client/assets/vrma/*.vrma` | Four shipped VRoid-derived avatar templates and Goodbye/Jump/LookAround/Relax/Surprised/Thinking/test animation clips. | native Rust assets |
| HTML/CSS chrome | `client/index.html` | Defines all HUD, overlay, menu, viewbar, debug, outliner, inspector, console and palette DOM styling/anchors. | DOM overlay |

## Kernel-module gate

Required modules: `audio.js`, `behaviors.js`, `console.js`, `dom.js`, `editor.js`, `effects.js`, `environment.js`, `geometry.js`, `gizmos.js`, `history.js`, `interact.js`, `net.js`, `outliner.js`, `palette.js`, `panel.js`, `particles.js`, `player.js`, `presets.js`, `rain.js`, `renderer.js`, `scatter.js`, `scenes.js`, `shading.js`, `terrain.js`, `view.js`, `viewfx.js`, `vrm.js`, `world.js`.

All 28 names occur in table source-file cells; check command/proof recorded with this inventory task.
