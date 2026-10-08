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
5. `set_point_lights` packs 9 f32/light incl. `decay` (r17-tone; three getDistanceAttenuation).
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
## Round 5 — scene adapter: textures, sync cost, GPU timing (lane lampas/r5-adapter, 2026-10-06)
Proof = `r4.html` unchanged flow, up-front pixel-read workaround REMOVED. Driver: `GLB=<asylum-skinned.glb> bun tools/render-wasm/run.mjs --port 5491 --cdp 9491 --page r4.html --frames 300 --q 'mode=gaia|three&char=c2500_0009&dist=6'`; raw .scratch/r5/*.json.
- **Textures**: material-map `textureData` → lazy descriptor `{width,height,srgb,key=uuid:version, get data}`; ImageBitmap/HTMLImageElement/VideoFrame/OffscreenCanvas/canvas/ImageData read via ONE drawImage+getImageData (image-level WeakMap: clones sharing a bitmap read once; canvas re-read only on texture.version bump). `data` only touched on a backend cache MISS. wgpu-backend: `texByKey` refcounted GPU textures (111 uploads / 282 hits for 393 material→map refs), `updateMaterial` in place (gpu.updateMaterial), `textureStats()`. NOT done: zero-readback `copyExternalImageToTexture` (needs a core `adopt texture` + mip-gen hook in gaia-render create_texture; first-load cost = 111 reads ≈ 380–840 ms total, once, load-dependent).
- **ensureMaterial**: once per material per frame (epoch) → cheap `materialSig(m)` string → only on change `materialToParams`. Idle frame: 0 reads, 0 uploads, 0 material calls (r4.html `texture_work_per_frame`: 0 of 300 frames with texture work; test/render-api-textures.test.js). Also fixed: swap-handle path crashed on SkinnedMesh users (`u.parts` undefined).
- **CPU sync** (1210 meshes, 447 skinned, 300 frames, median): 6.5 → 2.3–4.1 ms (load-dependent). Phases (adapter.stats.phase): matrixWorld 0.7–0.8 (three's own updateMatrixWorld; three side 0.8) · visit 1.6–4.4 · sweep 0.1 · camera 0 · backend skin upload 0.1 (batching not needed: 18 calls/frame median, p95 241, 0.1 ms). Changes: geometry sig numeric compare (no string/array alloc per mesh per frame), flag bits (no string), per-SKELETON bone-matrix change detection (shared by all SkinnedMeshes on a skeleton) → palette recompute + updateSkin only when skeleton/mesh matrix/bind moved.
- **GPU timing**: browser async path `total` = SUM of per-pass durations (shadow+scene+upscale), NOT a span → no idle gaps in it; but passes overlap on Apple tile GPUs so the sum OVERSTATES. New per-pass fields from `renderFrameGpuTimed()`: `scene, upscale, shadow, skin` (compute pass, own query pair; new gaia-render `read_skin_ms_async` + wasm `skinGpuMs`), `span` (earliest begin→latest end of timed passes; new `GpuTimings.span_ms`), `total`, `totalAll`=total+skin. three's `info.render.timestamp` is also a sum of its passes → like-for-like = gaia `totalAll` vs three total.
- Measurement caveat: host load avg 35–52 (other lanes) → identical code swings 2× (three 6.85 ↔ 16.3 ms in back-to-back runs). Table below = last interleaved pair, load 35–40.
| median ms (300 f) | gaia | three |
|---|---|---|
| CPU sync (matrixWorld+diff) | 4.1 (p95 9.1; r4 6.5) | 0.8 (matrixWorld only) |
| CPU submit | 2.6 | 36.5 |
| GPU scene / upscale / shadow / skin | 6.0 / 4.1 / 2.0 / 0.65 | — |
| GPU sum (totalAll) / span | 14.2 / 7.1 | 6.9 (sum) |
