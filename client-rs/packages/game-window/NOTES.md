# game-window — NOTES (lane nt-host, 2026-10-10)
Native macOS host for the DS1/JS game. EVERYTHING below is UNVERIFIED AT RUNTIME: lane law = never launch the app (16 GB Mac). Verified = `cargo check`/`cargo build` (debug, CARGO_TARGET_DIR=.lanes/target-native) green + config-refusal paths of the binary + launcher refusal paths.
## shape
- window `game-window` (opaque; wgpu Metal surface = its content-view CAMetalLayer) + child webview `game` (transparent, full window, ABOVE the surface; follows Resized) = the vite page. HUD/menus/input stay HTML.
- render thread `gaia-render`: drain queue → `Host.apply` each msg → `Host.render(enc, internal_view)` → [spatial: submit, MetalFX `SpatialUpscaler` → output tex → copy] | [bilinear blit] | [passthrough copy when internal==window] → `present` (Fifo = vsync = pacing; `--fps-cap` extra).
- internal size = `min(render-height, window h)` × window aspect (even). Resize → surface reconfigure + internal/output rebuild + `Host.resize` + new scaler (MetalFX sizes are fixed at creation).
- files: config.rs (flag>env>default table) · page.rs (init script) · shared.rs (queue/backlog/info) · gpu.rs (Presenter) · host.rs (feature select) · host_stub.rs / host_ipc.rs (the ONLY nt-ipc seam) · pointer.rs (macOS SPI) · main.rs.
## page ↔ host contract (init script `window.__GAIA_NATIVE__`, frozen)
`send(Uint8Array)→Promise` (strictly ordered, one invoke in flight; rejects when queued bytes > `--max-backlog-bytes`; NEVER silently dropped) · `info()→Promise<Info>` (frame/fps/cpu_ms/output/internal/stage/applied_*/apply_errors/last_error/queued_bytes/pointer_lock/page_gpu/host/adapter) · `pending` · `renderHeight/upscaler/pageGpu/version`.
Transport = Tauri raw-body `invoke('gaia_native_apply', u8)` (`ipc://` custom protocol; remote http origin allowed by a RUNTIME capability `game-remote` for the URL origin only, perms `allow-gaia-native-{apply,info}` from the build.rs app manifest). Large first uploads (80 MB scene) over this path = UNMEASURED.
`native-play.sh` rewrites `?renderBackend=wgpu` → `?renderBackend=${NATIVE_RENDER_BACKEND:-native}`: page-side name is a CONTRACT with nt-ipc's JS (assumption).
## FINDING: pointer lock in WKWebView (source-read from WebKit main, not run)
WebKit macOS HAS the Pointer Lock API (Safari ≥ 10.1, `PointerLockEnabled` default true) but `UIDelegate::UIClient::requestPointerLock` DENIES unless the WKUIDelegate implements private `_webViewDidRequestPointerLock:completionHandler:`. wry 0.55's `WryWebViewUIDelegate` doesn't → stock Tauri = `requestPointerLock()` always denied. Also needs view visible+focused, a mouse device, a user gesture. Once allowed WebKit locks natively (`platformLockPointer`).
Fix (default `--pointer-lock spi`): `pointer.rs` adds that selector to wry's delegate class at runtime (answers YES) and re-sets the delegate (WebKit caches `respondsToSelector:` at `setDelegate`). Private SPI (stable since 10.14.4); runtime outcome shown in `info().pointer_lock` + stderr `[pointer]`. If it does not take: mouse-look needs a native NSEvent-delta channel (not built).
## what the page needs from `navigator.gpu` TODAY (grep client/)
1. `kernel/renderer.js:70-71` `new THREE.WebGPURenderer(); await renderer.init()` → requestAdapter+requestDevice. three 0.180 `WebGPURenderer.Nodes.js` + `Renderer.init` catch: no/failed WebGPU → `getFallback()` = WebGL2 backend (so `--page-gpu hidden`, the default, boots; the page prints "WebGPU is not available, running under WebGL2"). UNVERIFIED in WKWebView.
2. `render-api/gpu-mirror.js:11` shadows `renderer.backend.device.queue.writeTexture` (array pages the game writes into three's device) → no-op without a WebGPU device (`installGpuMirror` returns false): array-texture pixels then never reach the core → nt-gi/nt-ipc must feed them another way.
3. `render-api/gi-bridge.js` ← `renderer.getArrayBufferAsync(atlas)` of three's GI compute (`kernel/gi/gi-controller.js` `renderer.compute`, StorageInstancedBufferAttribute) → needs a WebGPU device. `kernel/fluid.js:555` already checks `backend.isWebGPUBackend` (fluid stays OFF on WebGL2). tsl-export reads three's node graph (no device).
4. `render-api/wgpu-backend.js:130` throws if `!navigator.gpu` + wasm `GaiaRender.create(canvas)` (WebGPU canvas surface) → this is the in-browser path the native Host replaces.
⇒ `--page-gpu visible` = transitional switch (WebGPU left to the page, for three's GI compute until lane nt-gi moves it); `hidden` = no WebGPU device in WKWebView at all. Note WKWebView on macOS 26 exposes WebGPU by default, so "hidden" is an explicit mask (`delete Navigator.prototype.gpu` + `getContext('webgpu')→null`), not an accident.
## stubbed / not done
- `stub-host` (default feature): counts bytes, clears the target to a moving colour, loud banner. `host-ipc` = `host_ipc.rs`, written blind vs `Host::new(device,queue,surface_format,render_size)/apply/render` + assumptions A1–A3 in that file (internal-size semantics of `render_size`; `Host::resize` must exist). Needs the `gaia-render-host` dep line uncommented in Cargo.toml.
- metalfx-temporal REFUSED at config load (needs depth/motion/jitter the Host API does not expose).
- no GPU timing (Host owns its passes); only CPU ms + fps in `info()`/`[stats]`.
- audio / gamepad / file access: whatever WKWebView gives; untouched.
## risks
- Transparent webview over CAMetalLayer = same mechanism as render-window (its overlay panel), never exercised fullscreen-size. Page background forced transparent by an injected `!important` style.
- Opaque-over-Metal: any element with a background paints over the game (expected for HUD; a full-screen element hides the scene).
- `Presenter` is `unsafe impl Send` (Metal objects) — created on the main thread, used by one thread.
- Surface/webview ATS: URL must be http(s) on 127.0.0.1/localhost (IP literals are ATS-exempt; not tested).
- App commands + remote origin: ACL path read from tauri-2.11.5 source (`webview/mod.rs` on_message), not exercised.
