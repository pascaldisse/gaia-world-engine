# render-wasm — NOTES (lane lampas/render-wasm, 2026-10-06)
gaia-render → wasm32 + WebGPU canvas. wasm-bindgen `GaiaRender` (src/lib.rs) = data-only API; JS adapter = client/kernel/render-api/wgpu-backend.js (implements interface.js, copied unchanged from lampas/render-api).

## build
`tools/render-wasm/build.sh` → `cargo build --profile wasm-release -p render-wasm --target wasm32-unknown-unknown` + `wasm-bindgen --target web` → .scratch/pkg/render_wasm{.js,_bg.wasm}. wasm-bindgen-cli 0.2.126 (=Cargo.lock) installed into .scratch/tools (no wasm-opt run yet).
`[profile.wasm-release]` (opt-level s, lto, panic=abort) added to client-rs/Cargo.toml; crate is empty on native targets.
proof: `bun tools/render-wasm/run.mjs` (own server :5391 + own headless Brave, profile .scratch/brave-profile, CDP :9391) → .scratch/render-wasm.{png,json}.

## surface
Canvas formats on web = non-sRGB bgra8/rgba8 → surface configured w/ `view_formats=[srgb]`, frame view created as the sRGB variant; RenderOptions.output_format = that. `render()` reconfigures when canvas.width/height changed (= resize of output; `setRenderHeight` = interface resize(renderHeight)).
Device limits: max_buffer_size/max_storage_buffer_binding_size lifted to adapter limits (80 MB scene).
IDs: wasm mints mesh/texture/material/instance ids (u32 > 0); JS mints NodeId/LightId, resolves node hierarchy (parent × local) + visibility, pushes flat world mat4 instances.

## MISSING in crates/gaia-render (not edited — other lane)
1. **Async GPU-timestamp readback.** `timing` + `readback` buffer are private; only `read_timings_blocking` (cfg !wasm32) exists. Browser needs `read_timings_async()` (map_async + callback/Promise) or a `pub fn timing_readback_buffer()` + `period_ns()`. Until then `renderTimed()` = wall clock submit → `queue.on_submitted_work_done` (GPU + queue latency, NOT pure GPU ms). hasTimestamps() reports the feature only.
2. `Upscaler`/`set_upscaler` not exposed to JS (no WebGPU FSR-style plug yet; BilinearBlit default).
3. glTF `SceneData::from_slice` is NOT used by render-wasm (would drag image/png/jpeg decoders in; JS decodes textures with createImageBitmap instead). Test loader = tools/render-wasm/glb-loader.js.
4. Material params the interface carries but the core ignores: opacity (BLEND drawn opaque), doubleSide/flatShading/fog, normal/roughness/metalness/emissive/ao maps, `preset` (degrades to pbr), shadows (castShadow/receiveShadow accepted, no-op). Textures always upload as Rgba8UnormSrgb (`srgb:false` ignored).
5. `set_point_lights` ignores `decay` (core model fixed) — adapter passes distance as range.
6. External WGSL (`createShaderMaterial`) exported but NOT exercised in-browser yet.
7. Interface setCamera(view, proj) → adapter decomposes proj (depth convention option 'gl' default / 'zo'); aspect comes from the canvas, so proj aspect is ignored. Only perspective.

## measured (headless Brave, Metal, Asylum.glb, 1280x800 canvas, internal 1152x720)
see HANDOFF/return message; raw: .scratch/render-wasm.json. Core renders 487 draws for 763 instances (mesh sharing batches) — answers the native NOTES' 730,897-vs-620,554 tri gap: native counts shared meshes per instance; unique-mesh tris = 620,554 = exporter.

## Round 4 — browser runtime of shadows + skinning + scene-adapter (lane lampas/r4-browser, 2026-10-06)
First time shadows / skinning / scene-adapter→wgpu-backend ran in a browser. Page `tools/render-wasm/r4.html` (`?mode=gaia|three &frames= &char=<regex skinned name> &dist= &shadows=0|1`), driver `run.mjs --page r4.html --frames 300 --q 'mode=gaia&char=c2500_0009&dist=6'` (own server/Brave/profile, `GLB=` env = read-only .lanes/r3-skin/.scratch/asylum-skinned.glb), compare `tools/render-wasm/r4-compare.py gaia.png three.png out-prefix`.
- Scene = game-style: GLTFLoader.parseAsync + AnimationMixer (1 merged clip, `t = frame/30` for BOTH sides) + own DirectionalLight (sun 3.0, toward-light .4,.8,.3, castShadow) ; glb lights hidden (sun points up, uncalibrated). Casters = meshes with bbox diag < 400 m (sky/backdrops don't). Ambient = core default ×π on the three side (core adds ambient*albedo, three divides by π); three = Reinhard exposure 1 (= core tonemap), no AA, 4096² single ortho shadow map ±45 m.
- New wasm exports: `setInstanceStatic` `setInstanceCastShadow` `setShadowOptions(obj)` `shadowStats()` + create-time `options.shadows` (camelCase ShadowOptions keys). Skin exports (`createSkin/setSkinPose/createSkinnedMesh/destroy*`) already existed → verified live.
- wgpu-backend (additive): `createWgpuBackend({staticInstances:'none'|'non-skinned'})`, `flags.castShadow/static` + `updateNode({castShadow,static})` → core per-instance flags (castShadow undefined = core default), `backend.shadowStats()`, `setShadowOptions()`, capability `sun-shadows`. receiveShadow = still a no-op (core: every opaque receives).
- **BUG FOUND+FIXED in gaia-render** (`shadow.rs`): `std::time::Instant::now()` panics on wasm32-unknown-unknown (first browser frame died: `RuntimeError: unreachable` in `encode_forward`). Now cfg-gated: wasm reports `cpu_cull_ms = 0`.
- Findings (adapter, NOT fixed — other lane's code): (1) `ensureMaterial` runs `materialToParams` for EVERY mesh EVERY frame; a canvas-backed texture makes it `getImageData` the whole canvas each time → sync 800+ ms/frame. GLTFLoader gives `ImageBitmap` (material-map `textureData` → undefined → untextured), so the page reads each `map` ONCE into `{width,height,data}` (same Texture objects) — a real game needs that decode in the backend/adapter (wgpu-backend.texturePixels already does ImageBitmap/OffscreenCanvas for TSL, material-map doesn't). (2) adapter `sync` = 6.5 ms median here: 447 SkinnedMeshes × palette recompute + compare in JS + 1210-node walk (mixer = 0.8–1.3 ms is separate, same on both sides).
- Skin uploads: ~72 `updateSkin`/frame (only changed palettes). Shadow stats last frame: 1 pass, 4 cache→live copies, 447 dynamic caster draws only in cascade 3, static cascades cache-hit (0 re-render).
- wasm-opt: NOT installed (no binaryen) → not run. wasm-release size 1,663,283 B (r3-contract build before shadow/skin exports = 1,585,144 B).
Measured numbers + images: see HANDOFF return of lane / `.scratch/r4/{gaia,three}.{png,json}`, `cmp-sidebyside.png`, `cmp-diff.json`, `cmp-shadow-onoff-*`.
