# RENDER-API — renderer interface, three.js = one swappable backend

Lane `lampas/render-api` (from main 487bec3e). Goal: native Rust/wgpu renderer later → JS client talks to an
interface, three.js is backend #1. Interface = data-only (typed arrays, numbers, plain objects) → crosses wasm / native process.

## 1. Inventory — client files referencing three (50)
Count: **50** files reference three in any form (`three`, `three/webgpu`, `three/tsl`, `three/addons/*`, `three-bvh-csg`, dynamic `import('three/webgpu')`, or three injected via ctx).
**39** of them import `three`/`three/webgpu` directly (static `from`) — the "38" figure ≈ this. Method: `grep -rlE "from ['\"]three|import\(['\"]three" client`, then role by reading.
Status: **R1** = routed through render-api this round · **next** = candidate for later round · **keep** = stays three-native (renderer-private, e.g. TSL graphs) until backend-specific port.

| # | role | files (client/…) | status |
|---|------|------------------|--------|
| 9 | scene graph / meshes | kernel/view.js (entity→Group reconcile, static parts = R1) · kernel/geometry.js (recipe→BufferGeometry, CSG, caches) · kernel/primitives.js · kernel/terrain.js · kernel/scatter.js (InstancedMesh) · kernel/model.js (OBJ props) · kernel/palette.js (ghost) · extensions/rayfire/render.js · extensions/rayfire/hull.js | view.js static-part path + geometry caches = **R1**; scatter = **next** (createInstance ×N) |
| 4 | materials | kernel/presets.js (TSL procedural looks) · kernel/shading.js (editor draw modes) · kernel/transmission.js · kernel/humanoid-tex.js | presets/transmission = **keep** (named-preset, backend implements by name); material params (pbr) = **R1** |
| 8 | skinned characters / asset loaders | kernel/humanoid.js · humanoid-clip.js · humanoid-team.js · vrm.js · gltf.js · plugins/humanoid-editor.js · extensions/gore/cut.js · extensions/gore/vertex-budget.js | **next** (skeleton/skin/bone-matrix upload API) |
| 4 | lights | kernel/environment.js (owns Lighting+GI controllers) · kernel/skyenv.js · kernel/lighting/sky.js · (light pool in view.js applyLight) | **next** (iface has sun+point stubs, three-backend implements, unrouted) |
| 6 | GI | kernel/gi/gi-controller.js · gi-material.js · gi-nodes.js · gi-open-controller.js · gi-open-nodes.js · gi-open-raypar.js | **keep/next** (compute graphs, TSL-bound) |
| 1 | shadows | kernel/lighting/shadows.js (CSM) | **next** |
| 4 | AO / post / exposure | kernel/lighting/post.js (GTAO/TRAA/bloom) · lighting/autoexposure.js · kernel/renderer.js (renderer/scene/camera/post factory, pixel governor) · kernel/viewfx.js (post toggles) | **next**; `resize(renderHeight)` iface stub wraps renderer.js |
| 3 | camera / player rig | kernel/player.js (camera rig, damping) · main.js (boot, frame loop, TSL) · kernel/interact.js (Raycaster picking) | **next** (`setCamera(view,proj)` iface stub) |
| 7 | fx / fluids / particles | kernel/effects.js · particles.js · rain.js · fluid.js · fluid-surface.js · fluid-thickness.js · extensions/gore/{blood-particles,blood-pools,index}.js | **keep** (TSL/compute) |
| 4 | debug / editor / audio | kernel/editor.js · gizmos.js (TransformControls) · kernel/audio.js (AudioListener, not rendering) · client/main.js debug hooks | **keep** (editor stays on three; picks via native objects) |

Row counts above sum to the 50 (file lists are authoritative; a few files straddle roles → listed under primary role).

## 2. Interface — `client/kernel/render-api/`
(see §3 once written)
