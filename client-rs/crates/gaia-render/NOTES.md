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
## Round 3 — three TSL contract (lane lampas/r3-contract, 2026-10-06 18:29–18:56)
API (additive): `RenderCore::create_three_material(device, id, package_json, {binding var name → texture id})` · `set_three_time(s)` · `pub ThreeFrame`. Code = src/three_material.rs; hooks in lib.rs = field + 2 fns + prepare-before-pass + draw-after-batches.
- package = tsl-export.js JSON as-is: vertex + fragment = TWO shader modules (naga parse+validate each, Err never panic); bindings = union over both stages via naga reflection (group/binding/kind, struct member OFFSETS from naga layout — package offsets ignored); pipeline layout = dense groups 0..max as three numbered them.
- host semantics: render-group members by three's own name (cameraViewMatrix/ProjectionMatrix/WorldMatrix/Position/Near/Far/NormalMatrix/ProjectionMatrixInverse) · object-group `nodeUniformN` tagged by tsl-export `semantic` (uuid of three's singletons: modelWorldMatrix/NormalMatrix/WorldMatrixInverse/Position, time…) → filled per instance from gaia instance transform + camera. Others = package `value` (initial only; live game-uniform writes = NEXT). mat3 packed w/ vec4 column stride.
- attributes: by NAME (position/normal/uv) → builder location, onto core interleaved Vertex; other names = loud Err. Per-instance uniform buffers → 1 draw per three instance (no instancing).
- three side/transparent → cull/blend/depthWrite. Depth LessEqual, proj = glam perspective_rh (z 0..1 = WebGPU convention).
Proof (tests/three_material.rs, Metal, packages .scratch/r3/*.json from `R3_DUMP=<dir> node --test test/render-api-tsl.test.js`): 0 validation errors all 3 · cube correct position/projection for powerbox + paintlerp (.scratch/r3/native-strip.png) · powerbox = saturated white (emissive>1 on 200-grey textures, plausible) · paintlerp = black (export has lightsNode=null → plausibly black in three too) · **ee-sprite = 0 px drawn → OPEN** (SpriteNodeMaterial billboard: suspect opacity/size uniform initial value from spawn, not checked).
### NOT DONE (budget) — UNVERIFIED
three.js WebGPU reference render + pixel diff (none) · render-window path (headless test only) · wasm binding + wgpu-backend/scene-adapter sending the package (step 2) · browser run (step 3) · async timestamp readback + asylum browser GPU ms (step 4).

## Round 3b — three ground truth · sprite · browser · GPU ms (lane lampas/r3-contract, 2026-10-06)
Ground truth = three r180 WebGPURenderer, same materials/cube/camera/clear (tools/render-wasm/three-ref.html; shared builders three-materials.js; `bun tools/render-wasm/run.mjs --page three-ref.html --w 1024 --h 256`). Images looked at.
- native (tests/three_material.rs) vs three: powerbox / paintlerp / ee-sprite / ee-sprite-op1 = **0 px differ, maxdiff 0** each (cov 12700/12700/0/7744). White/black/empty are three's own output.
- ee-sprite 0 px = CORRECT: gfx-sprites spawn() sets `material.opacity = 0` (update() fades in) → package `nodeUniform3`=0 → fragment `DiffuseColor.w <= 0 → discard`. Not a vertex/instance-uniform bug. Probe with opacity 1 (ee-sprite-op1, .scratch/r3/dump-op1.mjs) = only non-saturating sample of the set (texture 200 → blended 196,199,204) → exact match ⇒ sampling + sRGB texture + alpha blend agree.
- WEAK: powerbox (saturated >1) + paintlerp (exporter sets lightsNode=null → black in both) prove geometry/coverage, NOT shading values. Lit TSL needs lights in the package = NEXT.
- live uniforms: opacity (and any material prop driven per frame) export as initial `value`, `semantic=null` → no update path yet = NEXT (would make every gfx sprite invisible in-game).
Browser: three scene → scene-adapter(exportNodeMaterial) → wgpu-backend.createShaderMaterial(pkg) → wasm createThreeMaterial (tools/render-wasm/three.html): **4/4 maxdiff 0 vs three**. Fixes: material-map routed SpriteNodeMaterial to PBR (drew a grey cube) → only Mesh*NodeMaterial have a PBR twin now. Texture pixels via tsl-export non-enumerable `textureSources` (uuid→Texture; JSON unchanged); unreadable texture = loud Error. Image-backed textures (flipY) UNVERIFIED — only DataTexture tested.
GPU timing: `RenderCore::request_timings_async(cb)` (src/timing_async.rs; one sample in flight, `encode_timing_readback` skips while mapped — tests/timing_async.rs, 0 validation errors) → wasm `renderGpuTimed()` → backend `renderFrameGpuTimed()`.
- asylum, Brave headless WebGPU, 1280×720 internal = output, 763 inst / 487 draws, 120 frames, 0 null: **GPU total median 4.63 ms** (p95 5.23, min 2.12) · scene 4.58 · submit→done wall 7.40. `upscale` 4.11 ms overlaps scene (tile GPU / Dawn pass-boundary sampling) → per-pass split UNTRUSTED, total = ts0→ts3 span.
