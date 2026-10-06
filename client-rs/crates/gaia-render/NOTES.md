# gaia-render — NOTES (lane lampas/render-core, 2026-10-06)
Renderer core = BACKEND behind render-api's data-only interface; engine config selects it.
Games never touch it → boomtown/eden/burnout/EE switch renderer by engine update only.
No Tauri dep. Same code → aarch64-apple-darwin (Metal) + wasm32 (WebGPU).

## API (what the JS adapter drives: wasm-bindgen in browser, IPC/shared buffer in Tauri)
- `RenderCore::new(device, queue, RenderOptions)` — every tunable = option w/ default
- mesh: `create_mesh(id, positions f32x3, normals f32x3, uvs f32x2, indices u32)` (typed arrays, validated → Err) · `remove_mesh`
- texture: `create_texture(id, w, h, rgba8)` (rebinds dependent materials) · `remove_texture`
- material, PRIMARY = external: `create_shader_material(id, ShaderMaterialDesc{wgsl, vertex_entry, fragment_entry, bindings: [Uniform{binding,data}|Texture{binding,texture_id}|Sampler{binding}]})`
  → three TSL node-builder WGSL in, no game-shader rewrite. naga parse+validate first (Err, never device panic) → wgpu lowers (naga→MSL native, WGSL passthrough browser).
  Contract for that WGSL: group(0)b(0) = gaia Frame uniform (see forward.wgsl) · vertex @loc 0 pos,1 normal,2 uv,3..6 instance model cols · 1 target Rgba8UnormSrgb · group(1) = `bindings`.
  → OPEN: TSL emits its OWN uniform/attribute naming + group layout; adapter must remap to this contract OR core must accept a vertex/frame mapping table. Not tested with real TSL output.
- material, default = built-in PBR: `create_material(id, MaterialDesc{base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive})`
- instance: `create_instance(id, mesh, material, mat4 col-major)` · `update_instance(id, mat4)` · `remove_instance`
  → sorted (mesh,material) batches, instanced draw per batch, instance buffer rebuilt when dirty
- `set_camera(world mat4, yfov, znear, zfar?)` · `set_sun(dir, color, intensity)` · `set_point_lights(packed 8 f32/light: xyz range rgb intensity)` (max 64, uniform-only → WebGPU-safe)
- `render(device, queue, encoder, output_view, output_size)` = renderFrame · `set_render_height(h)` = resize(renderHeight); width follows aspect
- `Upscaler` trait (resize + encode(input color/depth tex, output view, timestamps)) · default `BilinearBlit` · `set_upscaler(Box<dyn Upscaler>)` → gaia-metalfx plugs here
- glTF import = `SceneData::from_path|from_slice` + `load_scene_into(core,…)` = a CLIENT of the API above (test/import path only)
- metrics: `encode_timing_readback` + `read_timings_blocking` (TIMESTAMP_QUERY), `last_draw_calls`

## render-window wiring
`render-window <file.glb|gltf>` or `GAIA_GLB=` · `GAIA_RENDER_HEIGHT` (720) · `GAIA_TIMING_EVERY` (120, 0=off) → `[gpu-ms]` log lines.

## Measured (M1 Pro, window 1280x800 pt = 2560x1600 px, Fifo 60, release)
Asylum glb (scene-export lane): 763 draws (=primitives; no batching wins, all instances unique) · 730,897 tris after baking node transforms
- 720p internal (1152x720→2560x1600): GPU total 1.74–1.84 ms · load avg 11.56
- native (2560x1600): GPU total 6.28–6.64 ms (one 14.4 outlier) · load avg 9.49
- cpu_encode 0.05–0.25 ms = wgpu pass RECORDING only; excludes encoder.finish()+submit (where wgpu-core does the work) → NOT comparable to three.js submit cost yet
Sponza (Khronos, .scratch/sponza): 720p total 0.84–1.45 ms (load 18.75) · native 1.88–5.35 ms (load 14.54)

## Caveats / unverified
- per-pass split unreliable on Metal: scene≈upscale every frame (tile GPU overlaps passes / stage-boundary sampling) → only `total` is trusted
- render-window renders the core TWICE per frame (offscreen for HTTP /screenshot + surface); timestamps = surface render only, but the GPU is shared → numbers pessimistic
- tri count 730,897 vs exporter's 620,554 → UNRESOLVED (mesh reuse across nodes counted per node here? or exporter counts differently)
- light units uncalibrated (KHR lux/candela used raw, `light_intensity_scale`=1) → Asylum cell renders very dark
- BLEND drawn opaque (170 prims in Asylum) · no mipmaps (aliasing) · no shadows · TEXCOORD_1/lightmap ignored · normal = model 3x3 (uniform-scale only)
- wasm32: compiles (cargo build --release) — never RUN in a browser; no wasm-bindgen surface yet
- external WGSL path proven only with forward.wgsl fed back as external (tests/shader_material.rs, Metal, 0 validation errors) — not with real TSL output
Screenshots: .scratch/asy-window-{720,1600}.png (native window, screencapture -l) + asy-fb-*.png (framebuffer readback); Sponza: window-*.png
