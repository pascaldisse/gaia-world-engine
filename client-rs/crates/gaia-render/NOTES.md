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

## Round 2 (lampas, 2026-10-06 18:06–18:30)
API additions (no removals): `Upscaler::{name, submit_mode, output_usage, upscale, last_gpu_ms_blocking}` (all defaulted; `encode` now defaulted → panics loudly for Queue mode) · `UpscaleSubmit{Encoder,Queue}` · `UpscaleError` · `RenderCore::render_frame(device, queue, &Texture, size) -> Result` (submits; only driver for Queue mode) · `upscaler_name` · `set_mesh_uv1` · `set_material_lightmap(id, tex, fac)` · `set_material_blend` · `RenderOptions.anisotropy` (8) · `INTERNAL_STORAGE_FORMAT` · `SceneData.uv1` · `scene::{Material.lightmap, Lightmap}`.
- internal color = Rgba8Unorm storage + Rgba8UnormSrgb view: MetalFX spatial rejects EVERY sRGB format (gaia-metalfx format_probe: "mixed sRGB inputs and outputs is not supported", sRGB→sRGB also nil). Bytes identical to before.
- render-window: ONE render per frame → offscreen (UNORM + sRGB view) → copy to surface (surface usage +COPY_DST); /screenshot reads the same frame. GAIA_UPSCALER=metalfx-spatial (default macOS)|bilinear; metalfx-temporal = loud Err (not wired).
- mipmaps: full chain GPU-generated at `create_texture` (sRGB-view blit per level), trilinear + anisotropy. Visual: floor speckle gone (.scratch/r2/cmp-mip.png).
- MASK = alpha test (already: params.z cutoff → discard). BLEND = sorted transparent pass (alpha blend, depth-write off, far→near by AABB center). Asylum player_start view: blend-vs-before diff 0.01 → no BLEND prim in view → UNVERIFIED visually.
- lightmap: TEXCOORD_1 + extras.lightmap {texture,texCoord,fac} → albedo := Blender OVERLAY(albedo, lm, fac) (linear, both sRGB-decoded), THEN scene lights (= DS client default path, nari-world-companion client/ds-world/lightmap.mjs overlayNode + extension.js:197; NOT its dsLighting/MTD variants). 293/329 materials carry it. Frame mean 25.2→17.9 (darker: overlay with l<0.5 darkens).
- tris RESOLVED: 620,554 = unique meshes (487 meshes, sum indices/3) = exporter; 730,897 = per node instance (58 meshes reused by 276 extra nodes). Both right; GPU draws 730,897.
### Measured (release, window 1280x800pt = 2560x1600, Fifo, GPU shared w/ other lanes; total = scene + upscale)
| path | GPU total ms (8 samples) | load avg |
| metalfx-spatial 1152x720→2560x1600 (run 1) | 3.97–4.40 (outliers 6.3–10.6) | 24–56 |
| metalfx-spatial (after lightmap/mips/blend) | 5.3–10.8 | 5–7 |
| bilinear 720 | 1.80–5.8 (outlier 12.9) | 12–14 |
| native 2560x1600 (bilinear 1:1) | 5.9–14.0 | 5–20 |
- MetalFX `upscale` = its MTLCommandBuffer GPUEnd−GPUStart: 2.3–6.4 ms in-loop vs 1.58 ms standalone bench, and it tracks scene ms → SUSPECT (interval may include queue waiting on the forward pass / contention). Not a clean number. Need idle machine + Instruments/Metal System Trace.
Screenshots (.scratch/r2/, framebuffer = final frame): mfx720-fb vs native1600-fb vs bil720-fb (cmp-full.png, cmp-detail.png: MetalFX crack detail sharper than bilinear, slightly softer than native) · cmp-lightmap.png · cmp-mip.png. Camera = player_start, faces a dark wall; scene still very dark (light units uncalibrated).
### UNVERIFIED
- MetalFX ms (above) · BLEND visuals · lightmap vs the DS client side-by-side (no pixel comparison done) · temporal (no jitter/MV) · wasm runtime (cargo check wasm32 passes).
## Round 3 — SUN SHADOWS (lampas/r3-shadow, 2026-10-06)
Code: `src/shadow.rs` (+ `shadow_depth.wgsl`; receiver = group(2) in forward.wgsl). Public API additive: `RenderOptions.shadows: ShadowOptions` · `set_instance_static(id,bool)` · `set_instance_cast_shadow(id,bool)` · `shadow_stats()` · `shadow_options()` · `set_shadow_options(device,opts)` · `GpuTimings.shadow_ms` (included in total_ms). Bench/proof: `examples/shadow_bench.rs` (headless; env GAIA_GLB/CAMERA/SUN/SHADOWS/SHADOW_CACHE/SHADOW_DYNAMIC_PCT/SUN_SWEEP/GAIA_OUT=ppm).
- `ShadowOptions` (all defaulted): enabled(true) cascades(4, ≤4) resolution(2048) max_distance(120) split_lambda(.75) splits(explicit) normal_bias(1.5 texel) depth_bias(1 texel) slope_bias(1.5) constant_bias(2) pcf_radius(1 → 3×3) blend(.1) cache(true) caster_margin(50) alpha_test_casters(true) import_max_caster_diagonal(400).
- Cascades: practical splits over [znear, min(zfar,max_distance)]; bounding SPHERE per slice (rotation-stable) + light-space TEXEL SNAP → map content only changes when the snapped centre moves a texel. Ortho z-range = static-caster bounds along sun + caster_margin (dynamic casters above the static scene stay unclipped up to the margin).
- Per-cascade CPU culling (caster world AABB vs light box, xy + depth) → compacted instance buffers → one `draw_indexed` per (mesh,material) batch with visible instances. Depth-only pipeline (no fragment) for opaque + external; alpha-test pipeline for MASK materials; BLEND never casts. No cull (double-sided) like forward.
- Static/dynamic: instances default DYNAMIC; `load_scene_into` marks glb draws static. Static → CACHE layer per cascade, re-rendered only if that cascade's vp or `static_gen` changed (static instance create/move/remove/flag, mesh/material rewrite, set_material_blend). Dynamic → every frame onto LIVE layer = copy of cache layer (`copy_texture_to_texture`). No dynamic casters visible anywhere → receiver samples the CACHE directly (zero copies, zero passes).
- Receiver: 4-cascade select by view depth, normal-offset + depth bias in texels, PCF via comparison sampler (`textureSampleCompareLevel`, non-uniform-flow safe), cross-cascade blend band, lit beyond last split. Sun term only. External WGSL materials: pipeline layout now has group(2) = the same receiver bind group (declare it to sample; ignoring is fine).
- render-window: `GAIA_SHADOWS=0|1` (default 1) · `GAIA_CAMERA=x,y,z,yaw°,pitch°` override (glb camera = dark wall). Point-light shadows: NOT implemented, OFF (next: cube/atlas per-light, culled by range, ≤N shadowed lights, same static cache idea).
- Asylum FINDINGS: (1) glb sun node points UP (direction = +0.16,+0.98,+0.06 via -Z of node) → default sun lights only undersides; proofs use GAIA_SUN=-0.4,-0.8,-0.3,6 (exporter/scene issue, not touched). (2) 15 sky/backdrop prims span ±2900 m → they would shadow everything + blow cascade z-range → excluded by import_max_caster_diagonal.
### Measured (M1 Pro, release, headless 1280×720 internal 720p, bilinear, GPU shared: load avg 16–22 → noisy; median of 90–120 frames; camera -13,215,80 yaw0 pitch-25, sun override above)
| config | total GPU ms | shadow-pass span ms | shadow draw calls (c0,c1,c2,c3 = 31,46,436,584 casters; main = 763) |
| shadows off | 6.3–6.5 | – | 0 |
| on, cache ON (steady state, static only) | 6.4–6.9 | 0 (0 passes, 0 draws) | 0 |
| on, cache OFF (static redrawn every frame) | 6.5–8.4 | 1.11–1.29 | 1097 (4 passes) |
| on, cache ON, sun moving 0.5°/frame (cache invalid each frame) | 6.7 | 1.15 | 1116 |
| on, cache ON, 5 % instances dynamic (steady) | 8.1 | 0.58 (4 copies + 2 dyn passes) | 4 (dyn only: c2=2,c3=2) |
| on, cache OFF, 5 % dynamic | 7.9 | 1.72 | 1097 + 4 |
| cpu cull+list build (all 4 cascades) | 0.08–0.16 ms | | |
- cached vs uncached = shadow-pass span 0 vs ~1.1 ms and 0 vs 1097 draws. total_ms deltas are within machine noise (Metal overlaps passes; per-pass numbers unreliable, see caveats) → only the span/draw numbers are trustworthy; PCF 3×3 forward cost not isolated.
- Screenshots (.scratch/, framebuffer readback → png): `d_13_215_80_0__25_0.png` (off) vs `d_13_215_80_0__25_1.png` (on); also `d_13_230_120_0__40_{0,1}.png`. Saw: cliff/tower/gravestone shadows crisp and attached at contact (no peter-panning), no acne on lit grass/stone, no visible cascade seam bands (blend 0.1), PCF edge soft. Fine detail on stone walls under 4-cascade 120 m is soft at far cascades.
### UNVERIFIED
- Moving-camera cache hit-rate (texel snap should keep far cascades cached; only static camera + sun sweep measured). · Real skinned/dynamic characters (only 5 % of static prims forced dynamic). · Alpha-test caster visuals (pipeline validated by test run only, no MASK prim in the proof view). · wasm32 runtime (cargo check passes, never run). · MetalFX path with shadows (render-window run used bilinear). · render-window frames with shadows seen only as logs ([gpu-ms] ok, screenshot saved .scratch/rw1.png not inspected). · Shadow quality in the glb's own (upward) sun.
