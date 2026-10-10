# gaia-render-host

Native end of the `GaiaRenderNative` JS proxy (lane nt-ipc). JS (Tauri webview) encodes every
`GaiaRender` call (same ~80-method surface as `render-wasm`) into a binary command stream;
this crate decodes it into the same `gaia-render` `RenderCore` calls `render-wasm` makes.

## API contract (nt-host codes against this — STABLE)

```rust
use gaia_render_host::Host;

// device/queue: wgpu 30. Request the device with `gaia_render_host::device_descriptor(&adapter)`
// (adds RenderCore::OPTIONAL_FEATURES the adapter has + the adapter's real buffer limits).
// surface_format: the format of the view you pass to render() (use the *sRGB view* format,
//   same as render-wasm's `view_format`).
// render_size: pixel size of that target view (output size; the core's internal resolution is
//   the JS `renderHeight` option, upscaled to render_size).
let mut host = Host::new(device.clone(), queue.clone(), surface_format, (w, h));

// Per IPC message (any thread, any chunking: the stream is incremental; partial commands buffer):
let report: Vec<u8> = host.apply(&bytes);   // UTF-8 JSON report -> return to JS as the IPC response

// Frame loop (yours: vsync / MetalFX / window). Cheap no-op `false` until JS sent hello:
if host.frame_pending() {                    // JS committed >=1 frame (render()) since last render
    let mut enc = device.create_command_encoder(&Default::default());
    host.render(&mut enc, &target_view);     // -> bool (false = nothing to draw yet)
    queue.submit([enc.finish()]);
}
host.resize(w, h);                           // output size changed (cheap)
```

- `Host: Send` (wrap in `Mutex<Host>`; `apply` does GPU uploads on the caller's thread).
- `apply` never panics on a bad stream: malformed/failed commands are skipped and listed in
  the report `errors` (JS: `gpu.errors`, console). Handles are JS-allocated (no round trip).
- Message ORDER matters: JS keeps exactly one IPC message in flight (serial chain), so
  handle `gaia_render_apply` as a plain sequential command; do not reorder.
- Report JSON: `{"errors":[{"op":"createMesh","id":7,"msg":"..."}],"q":{...queries...}}` (`q` only on a
  frame commit). Return it verbatim as raw bytes.

### Tauri 2 glue (nt-host owns the app; ~8 lines)

```rust
#[tauri::command]
fn gaia_render_apply(host: tauri::State<'_, Mutex<Host>>, request: tauri::ipc::Request<'_>)
    -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("raw body expected".into()) };
    Ok(tauri::ipc::Response::new(host.lock().unwrap().apply(bytes)))
}
// register: .invoke_handler(tauri::generate_handler![gaia_render_apply])  (+ capability allowing the command)
```

JS side: `client/kernel/render-api/native/` (generated `gaia-render-native.gen.js` + runtime);
select with `?renderBackend=native`.
