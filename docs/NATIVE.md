# NATIVE — the native app's page holds NO GPU state

Goal (Pascal 10-10): in the native app (Tauri/wgpu, Metal) every draw + every GPU compute runs in `gaia-render`; the JS page keeps the scene graph, TSL *node graphs*, CPU bookkeeping — and **no GPU device, buffer, texture or pipeline**.
Measured 10-10 (browser, `renderBackend=wgpu`): three's `WebGPURenderer` device in the GPU process grew ~20 MB/s and duplicated every resource the wgpu core also held.

## §three-gpu — inventory of three's GPU use in `renderBackend=wgpu` (lane nt-gi, base 34ff6fd7)

Flag: `?threeGpu=0` (needs `?renderBackend=wgpu`) **or** `window.__GAIA_NATIVE__ === true` injected by the host before the page script. Code: `client/kernel/render-api/native-mode.js`.
Effect: `createRenderer({gpu:false})` (kernel/renderer.js) constructs the `WebGPURenderer` but **never `init()`s it** (three r180: `WebGPUBackend.init` is the only adapter/device request; the constructor, `setSize`, `toneMapping`, `shadowMap` setters are device-free) and `lockThreeGpu()` turns every entry point that would lazily `init()` or run GPU work into a counted no-op (`renderer.userData.threeGpuBlocked = {method: calls}`, one console warning per method). `main.js` drives frames with rAF (three's `setAnimationLoop` would `init()`).
Default (no flag) = unchanged browser behaviour.

| # | where | what / bytes (default GI: 3 cascades × 16×8×16 = 6144 probes, irr 8², depth 16², 64 rays, window 16×8×16 bricks of 8³) | native status |
|---|---|---|---|
| 1 | `kernel/renderer.js:81-82` `new WebGPURenderer` + `await renderer.init()` | adapter + device #1 (the duplicate device) | **GONE** with flag: constructed, never init'd |
| 2 | `main.js` `renderer.setAnimationLoop` | lazily `init()` | **GONE**: rAF when flag |
| 3 | `gi/gi-open-controller.js:175-176` `renderer.compute(trace / irr / dep)` per `update()` | trace 896 probes×64 rays = 57 344 threads; irr blend 57 344; depth blend 229 376. three-side buffers: irradiance atlas 6 291 456 B, depth atlas 12 582 912 B, voxel window 4 194 304 B (1 048 576 u32), ray buffer 6 291 456 B (all probes) = **29.4 MB GPU** | **MOVED** to `gaia-render` `gi_compute.rs` + `gi_compute.wgsl` (literal TSL→WGSL translation; ray buffer sized to the batch only: 917 504 B) |
| 4 | `render-api/gi-bridge.js:40` `getArrayBufferAsync(irr, depth)` every 30 frames | **18 874 368 B** readback + `mirrorAtlas` CPU copy (18.9 MB) + `setGiProbes` wasm copy + texture upload + a TSL-storage copy of the atlas in the core (18.9 MB) | **GONE** in native (bridge not created); kept for browser wgpu mode (`wgpuGiNative=0`/default there) |
| 5 | `gi/gi-open-controller.js` `flushVoxelUploads` / `_markFresh` (three `StorageInstancedBufferAttribute` partial writes) | 2 KB per rebuilt brick (≤16/frame) + depth sentinel ranges | **MOVED**: `giComputeVoxels` (u32 range) + `fresh` probe list in `giComputeStep` |
| 6 | `render-api/gpu-mirror.js:9-14` wraps three's `device.queue.writeTexture` | CPU shadow of every rgba8 2-D-array write (w×h×4×layers B per texture) | **OFF** with flag (`installGpuMirror` skipped; no device to wrap). See *page-atlas contract* below |
| 7 | `render-api/tsl-export.js:204` `headlessRenderer` | never-init'd `WebGPURenderer` on a stub canvas → `createNodeBuilder` → WGSL builder; **no device by construction** (header comment :199-203) | **works unchanged**; no minimal fix needed (verified by reading: it only uses `backend.createNodeBuilder`, stubbed `hasFeature`/`utils`). UNVERIFIED in a real WKWebView (no `navigator.gpu`) — the class constructor path does not read it |
| 8 | `lighting/autoexposure.js:105` `buildMeter` (rtt 128²→32²→8²→1×1 HalfFloat ≈ 140 KB) + `:205` `readRenderTargetPixelsAsync` | only runs inside the `post.render()` wrapper (`lighting/post.js:188`), which the wgpu presenter never calls | **already native**: core meters the HDR scene (`post-bridge.js` `tickAE`, 8×8 grid = 256 B async readback inside the core); the 64-cell trimmed-mean + adaptation stays **CPU** (64 floats, `autoexposure.js trimmedMean/adaptEV`) — no GPU reason to move it |
| 9 | `renderer.js:123` `PostProcessing`, `lighting/post.js:68 buildChain` (GTAO/bloom/TRAA pass graphs) | JS objects + RenderTargets only until rendered; never rendered | no GPU touched; core does bloom/GTAO/tone-map via `post-bridge.js` |
| 10 | `lighting/shadows.js`, `renderer.js:103-104` three sun shadow map (2048² depth ≈ 16 MB in browser) | allocated only when three renders a frame | never allocated (core has its own cascades) |
| 11 | `render-api/three-backend.js:219` `renderer.render` (backend #1) | n/a in wgpu mode | counted no-op if called |
| 12 | `kernel/fluid.js` PBF compute (`:174-188` buffers, `:484` `renderer.compute(chain)`), `kernel/fluid-thickness.js:62-71` RenderTargets + `:192-207` renders | opt-in (`?fluid=1` / `__GAIA_FLUID__` / world component). per particle 584 B (4 vec3 + lambda + neighbour count + 128-entry list) + cell buckets; 3 compute kernels with atomics + 4 screen-space RTs | **NOT ported** (separate PBF solver + screen-space surface). With the flag `fluid.js:555` refuses cleanly (warn, sim off). Needs its own lane |
| 13 | `gi/gi-controller.js:232-233` RTS-mode GI (`mode:'rts'`, `gi-nodes.js`, default `enabled:false`) | `renderer.compute` + occupancy/atlas storage | **never had a wgpu path** (gi-bridge/forward.wgsl read open-mode cascades only). With the flag its compute is a counted no-op → no RTS GI. Not ported |
| 14 | any `THREE.Texture` / `CanvasTexture` (`skyenv.js:66`, glTF/VRM maps) | GPU upload only when a three render/compute touches the texture | none; the wgpu path reads CPU pixels (`material-map.js`) |

### What still runs on three's GPU in native mode
**Nothing** — by construction: no device exists. Features without a native path are *off* and counted in `renderer.userData.threeGpuBlocked`: fluid (#12), RTS-mode GI (#13), any game code calling `renderer.render/compute/readRenderTargetPixelsAsync` (e.g. `fluid-thickness`).

### Page-atlas contract (external extension, not in this repo)
`gpu-mirror.js` exists because an extension (the Paleblood atlas) writes streamed pages straight into three's `GPUTexture` through `renderer.backend.device.queue.writeTexture`. With no three device that path cannot exist. Minimal fix (extension side): keep such `DataArrayTexture`s CPU-backed — `texture.image.data` populated and updates flagged with `texture.addLayerUpdate(i)`/`needsUpdate`; `material-map.js arrayTextureData` (:85-99, non-mirror branch) already ships exactly that to the core (`updateTextureLayer`). UNVERIFIED against the extension.

## Native probe GI (what moved, how it is wired)
```
page (CPU only)                                   gaia-render (Metal)
GIOpen._updateNative  ─ giComputeInit(cfg JSON) ─► GiCompute::new  (voxel/ray/irr/depth buffers, 3 pipelines; depth := -1)
 voxel window bricks  ─ giComputeVoxels(start,u32[]) ► queue.write_buffer (voxels)
 cascade scroll/batch ─ giComputeStep(frame f32[44], fresh u32[]) ► depth sentinel writes + pending frame
                                                  render_frame → encode_forward → encode_gi_compute:
                                                    pass{ trace → irr_blend → depth_blend }, copy atlas buffers → 4096-wide textures
                                                    forward uniform written ONLY after the first batch is computed (no black-GI frames)
TSL materials: atlas attr tagged userData.nativeStorage → bindThreeStorage(reserved ids u32::MAX-1 / u32::MAX = the same atlas buffers)
```
* Algorithm = translation, not rewrite: `gi_compute.wgsl` mirrors `gi-open-raypar.js` (trace/irr/depth) and `gi-open-nodes.js` (`readVoxelTSL`, `marchVoxelsTSL`, `voxelNormalTSL`, `resolveProbeTSL`, `probeWorldPos`, `batchProbeIndex`, `queryCascadesTSL`, sky/fibonacci/octahedral). Deviations (all result-neutral): `break` instead of the TSL `go` guard in the march; the candidate-relocation reverse loop is a forward loop taking the first free; the bounce query reuses forward.wgsl's `gi_query` math (exact `pos_mod` instead of `CELL_BIAS`).
* Every tunable is config (`GIOpen.nativeConfig()` → JSON; Rust has no defaults, a missing key is a loud error): cascades, resolutions, rays, voxel window dims/cell/bias, march + relocate steps, maxDist, relocateMax, blendCells, hysteresis alphas, adaptive fast/threshold, golden angle. Frame array layout = `gi-native.js GI_FRAME` ↔ `gi_compute.rs GF_*`.
* Only the ray-parallel path exists natively (`rayParallel:false` legacy kernels throw loudly in native mode).
* Browser wgpu mode: unchanged (`gi-bridge.js` readback). `&wgpuGiNative=1` runs the native compute in a browser for A/B (three then still owns a device, GI-wise idle).
* Follow-ups (not done): forward.wgsl could sample the atlas *buffers* directly and drop the 18.9 MB texture copy + per-frame buffer→texture copy (needs a fragment-stage storage-buffer budget check); batch the fresh-probe sentinel writes (a 30 m move = 2688 small `write_buffer`s).

## Verification state (this lane)
* `cargo check -p gaia-render` ✓ · `cargo check -p render-wasm --target wasm32-unknown-unknown` ✓ · `cargo run -p gaia-render --example gi_compute_validate` ✓ (naga parse + full validation of `gi_compute.wgsl`, 3 compute entry points, Params span 368 B = `GcUniform`).
* JS: real `GIOpen` driven headlessly against a recording sink (no GPU): config JSON, 1 048 576-word voxel window upload, per-frame `f32[44]`, fresh probe indices (2688 on a 30 m move = 15×128 + 5×128 + 1×128 slots), sentinel/`attachNative`/destroy flow.
* **UNVERIFIED** (not run — no app/browser launches allowed): the WGSL on a real Metal device, pixel parity of native atlases vs three's (`tools/gi-parity.mjs`-style readback compare is the proof to run), memory numbers above for the native path, WKWebView behaviour with an un-init'd `WebGPURenderer`.
