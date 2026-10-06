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
## Round 3 — SKINNING (lampas/r3-skin, 2026-10-06 18:29–18:50)
New `src/skin.rs` + `src/skin.wgsl`; hooks: lib.rs (`pub mod skin`, `RenderCore.skin` field, `encode_skinning` call at top of `encode_forward`, `load_scene_into` → `SkinScene::load_into`), scene.rs (`SceneData.skins`, skinned nodes NOT baked into `draws`). Public API additive only.
- API: `create_skin(id, joint_count, inverse_bind f32[16n])` · `set_skin_pose(id, joint WORLD mats f32[16n])` (palette = pose×IBM on CPU) · `create_skinned_mesh(id, skin, pos, nrm, uv, joints u32x4 (<65536), weights f32x4, idx)` · `remove_skin` / `remove_skinned_mesh` · `skinned_vertex_count` · `skin_joint_count` · `read_skin_ms_blocking`. Draw = `create_instance(id, id, mat, IDENTITY)` (glTF skinned verts are world space).
- **Compute pre-pass, not vertex-shader skinning** — why: skinned verts written ONCE/frame into a plain VERTEX buffer → main + BLEND + shadow (r3-shadow) + external TSL/WGSL pipelines draw them through the UNCHANGED static vertex contract (no pipeline permutations, no re-skin per pass/cascade). Cost = 32 B/vertex dst memory.
- One dispatch for all: ONE src storage buffer (16 f32/vertex: pos n uv, joints packed u16×4 in 2 slots, weights, palette base) · ONE palette `array<mat4x4f>` (all skins concatenated) · ONE dst STORAGE|VERTEX buffer. Each skinned mesh = normal `GpuMesh` with `vertices` = shared dst (wgpu Buffer clone) and indices REBASED by first vertex → draw path / shadow lane untouched (they bind `m.vertices.slice(..)`, which works). uv1 = shared zero buffer. Rebuild on structure change only; palette `write_buffer` only when a pose changed. 2D dispatch past 65535 groups.
- glTF: `skin::SkinScene` (nodes TRS, skins, skinned prims, ALL animation channels = one clip; LINEAR/STEP; CUBICSPLINE → value keys linearized + noted) · `pose_at(core, t)` = CPU clip eval → `set_skin_pose`. render-window: plays clip from wall clock; `GAIA_ANIM_TIME=<s>` freezes it; `GAIA_CAM_LOOK=ex,ey,ez,tx,ty,tz` (core camera override; /screenshot `pos/yaw` does NOT move the core camera — pre-existing gap); `[gpu-ms]` now logs `skin=` + skinned_verts + joints.
- JS: interface optional methods + `createSkin/updateSkin/createSkinnedMesh/destroySkin/destroySkinnedMesh`; scene-adapter mirrors SkinnedMesh (IBM = boneInverse×bindMatrix, pose = matrixWorld×bindMatrixInverse×bone.matrixWorld, updateSkin only when palette changed; idle = 0 calls) — falls back to the old bind-pose path if the backend lacks the methods; wgpu-backend + render-wasm (`createSkin/setSkinPose/createSkinnedMesh/destroy*`). Test `test/render-api-skin.test.js` (real three SkinnedMesh + mock: J×IBM == matrixWorld at bind, idle 0 calls, bone move → updateSkin only, removal).
- Exporter: manifest `skinned: { nodes: regex, clip?: regex, maxCharacters? }` → glTF skins + joint hierarchy (ancestors kept for transforms) + ONE merged animation (first clip per character id `<id>/…` touching its joints). Fixed own bug: self-parent cycle when a skinned node's parent was created during attach (stack overflow in importer) — selfCheck does NOT detect node cycles yet.
### Measured (Asylum gp23-s1, manifest `^skinned:[co]\d{4}_`, release, bilinear, internal 1080x720 → 1920x1280 window, GPU shared w/ other lanes)
- export: 88 skins (82 with a clip), 3302 joints, 9604 channels, 447 skinned prims, 100,718 unique skinned verts → **267,541 skinned verts on GPU** (per skin instance) · 121 MB glb · 8.5 s · selfCheck ok
- **skin pass 0.44–1.07 ms** GPU (one dispatch, all characters) · frame total 2.8–6.6 ms (scene 2.8–6.5) · **draws 1210** (763 static + 447 skinned) · cpu_encode 1.9–5.3 ms (includes per-frame CPU clip eval of 4502 nodes)
- Screenshots `.scratch/r3/`: `skin-t0.png` (t=0) + `skin-t1.2.png` (t=1.2 s): corridor, hollow c2500_0000 standing idle (head-clutch), corpse on floor; `cmp-t0-t1.2.png` crop: head/arm pose differs, diff bbox only on the character (927,413)-(1144,696).
### UNVERIFIED
- clip choice = first per character (a9005 etc. — not checked it's the authored idle) · clips loop on the GLOBAL max duration (51.7 s): shorter clips hold their last key until wrap · o0500 skinned objects not looked at · normals = palette 3×3 (non-uniform scale wrong) · wasm: `cargo check` only, never run in a browser · JS adapter never driven against the real wgpu backend · skin ms on a shared, loaded GPU (Metal per-pass timestamps already flagged unreliable).
- `tests/shader_material.rs` FAILS (group1 binding 3 missing in pipeline layout) — PRE-EXISTING: same failure on base b35ab667 (run from git archive), not from skinning.
