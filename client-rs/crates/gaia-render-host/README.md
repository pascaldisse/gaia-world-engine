# gaia-render-host

Native end of the `GaiaRenderNative` JS proxy (lane nt-ipc). JS (Tauri webview) encodes every
`GaiaRender` call (same 97-export surface as `render-wasm`) into a binary command stream;
this crate decodes it into the same `gaia-render` `RenderCore` calls `render-wasm` makes.
Target-agnostic crate: `render-wasm` (wasm32) delegates to the same `Session`, so browser and native share one set of semantics.

## API contract (nt-host codes against this — STABLE)

```rust
use gaia_render_host::Host;

// device/queue: wgpu 30. Request the device with `gaia_render_host::device_descriptor(&adapter)`
// -> (DeviceDescriptor, Features): adds RenderCore::OPTIONAL_FEATURES the adapter has + the adapter's real buffer limits.
// surface_format: format of the view you pass to render() (the *sRGB view* format, same as render-wasm's `view_format`).
// render_size: pixel size of that target view (output size; the core's internal resolution is the JS
//   `renderHeight` option, upscaled to render_size).
let mut host = Host::new(device.clone(), queue.clone(), surface_format, (w, h));

// Per IPC message (any thread, any chunking: the stream is incremental; partial commands buffer):
let report: Vec<u8> = host.apply(&bytes);   // UTF-8 JSON report -> return to JS as the IPC response

// Frame loop (yours: vsync / MetalFX / window). `render` is a cheap no-op `false` until JS sent hello:
if host.frame_pending() {                    // JS committed >=1 frame (render()) since last render
    let mut enc = device.create_command_encoder(&Default::default());
    host.render(&mut enc, &target_view);     // -> bool (false = nothing created yet)
    queue.submit([enc.finish()]);
}
host.resize(w, h);                           // output size changed (cheap)
// also: host.is_created(), host.session_mut() (core access for diagnostics), host.log_errors (default true -> stderr)
```

- `Host: Send` (compile-asserted) — wrap in `Mutex<Host>`; `apply` performs GPU uploads on the caller's thread.
- `apply` never panics on a bad stream: malformed / failed / panicking commands are skipped and listed in the report
  `errors`. Install `device.on_uncaptured_error(...)` yourself: wgpu's default handler panics, and a validation error raised at
  `queue.submit` (your frame loop) is outside `apply`'s catch.
- Handles are JS-allocated (no round trip). Message ORDER matters: JS keeps exactly ONE message in flight (serial chain, queued
  messages coalesce) — handle the command as plain sequential, never reorder.
- Report JSON (return verbatim as raw bytes): `{"errors":[{"op":"createMesh","id":7,"msg":"..."}],"q":{...queries...},"frame":n}`;
  `q`/`frame` only when a frame was committed or hello ran.
- HELLO (first command, JS `GaiaRenderNative.create`) carries `api_hash` + the create options (renderHeight, hdrScene, shadows…) and
  builds the `RenderCore`. A JS/host pair generated from different render-wasm exports is refused (`hello` error, `create` rejects).

### Tauri 2 glue (nt-host owns the app; UNVERIFIED — signatures checked against tauri 2.11.5 source, not compiled)

```rust
#[tauri::command]
async fn gaia_render_apply(host: tauri::State<'_, std::sync::Mutex<gaia_render_host::Host>>, request: tauri::ipc::Request<'_>)
    -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("raw body expected".into()) };
    Ok(tauri::ipc::Response::new(host.lock().map_err(|e| e.to_string())?.apply(bytes)))
}
// .manage(Mutex::new(Host::new(..))) · .invoke_handler(tauri::generate_handler![gaia_render_apply]) · capability allowing the command
```
`async` on purpose: sync commands run on the main thread and would block the window loop during texture uploads.

## Transport choice — Tauri 2 raw-body `invoke` (not a hand-rolled scheme)

`invoke(cmd, Uint8Array)` is NOT the JSON path: Tauri's `ipc-protocol.js` POSTs a `Uint8Array/ArrayBuffer` payload with
`Content-Type: application/octet-stream` over the `ipc://` **custom URI scheme** (`fetch`), and `ipc/protocol.rs` turns that into
`InvokeBody::Raw(Vec<u8>)` (no JSON encode/decode of the payload; `postMessage` is only the fallback if the webview blocks the scheme). So raw `invoke` already IS a custom-protocol transport, plus Tauri's capability/ACL/error plumbing.
A hand-registered scheme would use the same WKURLSchemeHandler path and only save the per-call command dispatch — not worth the extra
host registration + CSP surface. It is provided as an alternative anyway (`?nativeTransport=protocol`, same bytes; nt-host must register
`register_asynchronous_uri_scheme_protocol("gaiarender", ..)` calling `Host::apply`).

Documented numbers (all other sources are for the JSON/base64 path or the response direction; **no first-party JS→Rust raw-upload
throughput for WKWebView exists — ours is UNVERIFIED until measured on the real app: `gpu.ipcStats()` {bytes, lastMs, maxMs}**):
- tauri `core.ts` / `scripts/ipc-protocol.js` (above): raw payload = octet-stream body, "avoids the cost of base64/array encoding".
- tauri issue #13405: JSON/event path ≈ 200 ms per 3 MB (the cost the raw path avoids).
- mechanicalrock.io IPC benchmark (M2 Max, Tauri 2): custom-protocol/raw transfers hold the JS main thread ~0 ms vs ~890 ms for base64+JS decode.
Design consequences: ONE batch per frame (render() flush), bulk uploads streamed in ≤ `nativeChunkMB` (16) messages as soon as
`nativeFlushMB` (4) accumulates, so a 200 MB texture set never becomes one giant message; the host decoder buffers partial commands.
Big arrays are memcpy'd once into the writer (JS) and once by the platform into the body; the decoder borrows them zero-copy when aligned.

## Wire format (little-endian; `src/wire.rs`)

```
command = u16 op | u16 0 | u32 payload_len | payload     (payload_len % 4 == 0)
u32 i32 f32 bool(u32)        4 B          &[f32] &[u32] &[u8]   u32 byte_len | raw bytes | pad4
str json                     u32 len | utf8 | pad4            strlist   u32 n | str*
bindings  u32 n | (u32 kind 0 uniform|1 texture|2 sampler, u32 binding, u32 vertex, u32 texture, u32 len+bytes+pad)*
op 0 HELLO (u32 api_hash | json options) · op 0xFFFF FREE · ops 1..=80 generated (creates carry the JS-allocated u32 id first)
```

## Keeping JS and Rust in lock-step (generated, not hand-listed)

`bun tools/gen-render-native.mjs` parses `render-wasm/src/lib.rs` (every `pub fn` of the `#[wasm_bindgen] impl GaiaRender`) and writes
`src/commands.gen.rs` (the `Commands` trait — no default methods — opcode table, decoder `dispatch`, `collect_queries`) and
`client/kernel/render-api/native/gaia-render-native.gen.js` (proxy class with identical method names/arg order). Policy (manual /
frame / local-return / drain / query defaults / non-scalar param codecs) in `tools/gen-render-native.config.json`; an export whose
type or return has no rule makes the generator FAIL. `--check` = CI staleness test. Adding an export to render-wasm ⇒ regenerate ⇒
`impl Commands for Session` stops compiling until the new method exists (drift is a build error). `id`-allocating creates are detected by
`self.id("kind")` in the render-wasm body (per-kind counters mirrored in JS).

## Verification status

- `cargo check -p gaia-render-host -p render-wasm` (native + `--target wasm32-unknown-unknown`) green.
- JS: `bun tools/native-stream-dump.mjs` (headless, no browser) drives the real `GaiaRenderNative`, frames-checks the stream against the op table.
- Rust decode + render of that stream: `cargo run -p gaia-render-host --example replay -- .scratch/native-stream.bin` — compile-checked only,
  **never run** (lane law: no GPU runs) → decoder correctness at runtime, Tauri glue, real IPC throughput, render-wasm regression: **UNVERIFIED**.

## Known differences / missing

- Errors are async (report → `gpu.errors` / `gpu.onError`): `createThreeMaterial` can no longer throw into the adapter's PBR-fallback path.
- Queries are last-frame-stale; `renderGpuTimed` / `skinGpuMs` resolve `null` (no GPU timing over IPC); `renderTimed` = IPC round trip.
- Pixel readback / screenshot over IPC not in the surface (render-wasm has none either).
- Host-side input (canvas sizing) is nt-host's: JS never resizes the native surface; `host.resize` does.
