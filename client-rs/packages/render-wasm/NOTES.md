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
