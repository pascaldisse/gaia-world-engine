//! gaia-render-host — decodes the `GaiaRenderNative` binary command stream (JS, Tauri webview) into `gaia-render` calls.
//! Contract with the windowing host (lane nt-host): README.md. Wire format: `wire.rs`. Per-op decode + the
//! `Commands` trait are GENERATED from render-wasm's exports (`bun tools/gen-render-native.mjs`).
pub mod session;
pub mod wire;
#[path = "commands.gen.rs"]
pub mod commands;

pub use commands::{API_HASH, CmdResult, Commands};
pub use session::{Session, device_descriptor, render_options_from_json, shadow_options_from_json};

use serde_json::{Value, json};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Duration;
use wire::{Framer, OP_CORRUPT, OP_FREE, OP_HELLO, Reader, StreamError};

// native wgpu is Send; the web backend is not (wasm32 is single-threaded, nothing to assert there).
#[cfg(not(target_arch = "wasm32"))]
const _: fn() = || {
    fn is_send<T: Send>() {}
    is_send::<Host>(); // Host lives in a Mutex shared by the IPC thread and the frame loop
};

/// Wall time spent in one op kind during the LAST `Host::apply` (see `Host::time_ops`).
#[derive(Clone, Debug)]
pub struct OpTiming {
    pub kind: &'static str,
    pub count: u32,
    pub total: Duration,
    /// slowest single command of this kind
    pub max: Duration,
}
/// wasm32 has no `Instant::now` (panics): per-op timing is native-only, never on there.
#[cfg(not(target_arch = "wasm32"))]
fn now() -> Option<std::time::Instant> {
    Some(std::time::Instant::now())
}
#[cfg(target_arch = "wasm32")]
fn now() -> Option<std::time::Instant> {
    None
}
fn kind_name(op: u16) -> &'static str {
    match op {
        OP_HELLO => "hello",
        OP_FREE => "free",
        OP_CORRUPT => "corrupt",
        _ => commands::op_name(op),
    }
}
pub struct Host {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface_format: wgpu::TextureFormat,
    output: (u32, u32),
    session: Option<Session>,
    framer: Framer,
    committed: u64,
    rendered: u64,
    /// log failed commands to stderr as they happen (they are always also returned in the report).
    pub log_errors: bool,
    /// time every command inside `apply` per op kind (off by default; native hosts only). Read back with `last_apply_ops`.
    pub time_ops: bool,
    op_times: HashMap<u16, (u32, Duration, Duration)>,
}

impl Host {
    /// `surface_format`: format of the view passed to `render` (sRGB view format). `render_size`: that view's size in px.
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, surface_format: wgpu::TextureFormat, render_size: (u32, u32)) -> Self {
        Self { device, queue, surface_format, output: render_size, session: None, framer: Framer::default(), committed: 0, rendered: 0, log_errors: true, time_ops: false, op_times: HashMap::new() }
    }

    /// Output (target view) size changed.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.output = (width.max(1), height.max(1));
    }

    /// JS sent `hello` (renderer created) and has not been freed.
    pub fn is_created(&self) -> bool {
        self.session.is_some()
    }

    /// A frame was committed (JS `render()`) since the last `render()` call.
    pub fn frame_pending(&self) -> bool {
        self.session.is_some() && self.committed > self.rendered
    }

    /// Direct access for hosts that need the core (diagnostics); None before hello.
    pub fn session_mut(&mut self) -> Option<&mut Session> {
        self.session.as_mut()
    }

    /// Encode the latest committed scene into `encoder`, targeting `target` (format = `surface_format`).
    /// false = nothing created yet (nothing encoded).
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) -> bool {
        let Some(s) = self.session.as_mut() else { return false };
        s.output = self.output;
        s.render(encoder, target);
        self.rendered = self.committed;
        true
    }

    /// Queue-mode counterpart of `render` (MetalFX etc.: the scaler commits its OWN command buffer, so `render`, Encoder-mode only, would panic):
/// renders the latest committed scene + upscales into `output` (SUBMITTED on return; encode copies/presents afterwards) and consumes the
/// commit exactly like `render` ("frame consumed": `frame_pending()` clears, so idle frames need not re-render).
/// Ok(false) = nothing created yet (nothing rendered). Err = upscaler/queue failure (loud, never swallowed; the commit stays pending).
pub fn render_queue(&mut self, output: &wgpu::Texture) -> Result<bool, String> {
let Some(s) = self.session.as_mut() else { return Ok(false) };
s.output = self.output;
s.render_queue(output)?;
self.rendered = self.committed;
Ok(true)
}
/// Per-op-kind timings of the last `apply` (needs `time_ops`): slowest `top` kinds first, + (total commands, sum of ALL kinds' time).
/// `apply` wall time minus that sum = framing/copy/report overhead outside any op.
pub fn last_apply_ops(&self, top: usize) -> (Vec<OpTiming>, u32, Duration) {
let mut v: Vec<OpTiming> = self.op_times.iter().map(|(op, (count, total, max))| OpTiming { kind: kind_name(*op), count: *count, total: *total, max: *max }).collect();
let cmds = v.iter().map(|x| x.count).sum();
let sum = v.iter().map(|x| x.total).sum();
v.sort_by(|a, b| b.total.cmp(&a.total));
v.truncate(top);
(v, cmds, sum)
}
/// Feed one IPC message (any slice of the stream). Returns the UTF-8 JSON report for the IPC response:
    /// `{"errors":[{op,id,msg}], "q":{queries}, "frame":n}` (`q`/`frame` only when a frame was committed or hello ran).
    pub fn apply(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut errors: Vec<StreamError> = Vec::new();
        let mut want_q = false;
        let mut framer = std::mem::take(&mut self.framer);
        self.op_times.clear();
framer.feed(bytes, |op, payload| {
let t = if self.time_ops { now() } else { None };
self.on_command(op, payload, &mut errors, &mut want_q);
if let Some(t) = t {
let d = t.elapsed();
let e = self.op_times.entry(op).or_insert((0, Duration::ZERO, Duration::ZERO));
e.0 += 1;
e.1 += d;
e.2 = e.2.max(d);
}
});
        self.framer = framer;
        let mut rep = json!({ "errors": errors.iter().map(|x| json!({ "op": x.op, "id": x.id, "msg": x.msg })).collect::<Vec<_>>() });
        if self.log_errors {
            for x in &errors {
                eprintln!("[gaia-render-host] {} (id {}): {}", x.op, x.id, x.msg);
            }
        }
        if want_q && let Some(s) = self.session.as_mut() {
            rep["q"] = Value::Object(commands::collect_queries(s));
            rep["frame"] = json!(self.committed);
        }
        serde_json::to_vec(&rep).unwrap_or_else(|_| b"{}".to_vec())
    }

    fn on_command(&mut self, op: u16, payload: &[u8], errors: &mut Vec<StreamError>, want_q: &mut bool) {
        match op {
            OP_HELLO => {
                if let Err(msg) = self.hello(payload) {
                    errors.push(StreamError { op: "hello", id: 0, msg });
                } else {
                    *want_q = true;
                }
            }
            OP_FREE => {
                self.session = None;
                self.committed = 0;
                self.rendered = 0;
            }
            OP_CORRUPT => errors.push(StreamError { op: "stream", id: 0, msg: format!("desynced stream (command > {} bytes): buffered bytes dropped", wire::MAX_COMMAND_BYTES) }),
            _ => {
                let Some(s) = self.session.as_mut() else {
                    errors.push(StreamError { op: commands::op_name(op), id: 0, msg: "no hello yet (renderer not created)".into() });
                    return;
                };
                let r = catch_unwind(AssertUnwindSafe(|| commands::dispatch(s, op, &mut Reader::new(payload))));
                match r {
                    Ok(Ok(d)) => match d.result {
                        Ok(()) => {
                            if op == commands::OP_FRAME_COMMIT {
                                self.committed += 1;
                                *want_q = true;
                            }
                        }
                        Err(msg) => errors.push(StreamError { op: commands::op_name(op), id: d.id, msg }),
                    },
                    Ok(Err(e)) => errors.push(StreamError { op: commands::op_name(op), id: 0, msg: format!("decode: {e}") }),
                    Err(p) => {
                        let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                        errors.push(StreamError { op: commands::op_name(op), id: 0, msg: format!("panic: {msg}") });
                    }
                }
            }
        }
    }

    /// HELLO = u32 api_hash | json options (render-wasm `create` options). Builds the RenderCore.
    fn hello(&mut self, payload: &[u8]) -> Result<(), String> {
        let mut r = Reader::new(payload);
        let hash = r.u32().map_err(|e| e.to_string())?;
        if hash != API_HASH {
            return Err(format!("api hash mismatch: js 0x{hash:08x} host 0x{API_HASH:08x} (regenerate: bun tools/gen-render-native.mjs, rebuild both sides)"));
        }
        let o = r.json().map_err(|e| e.to_string())?;
        let opts = render_options_from_json(&o, self.surface_format);
        self.session = Some(Session::new(self.device.clone(), self.queue.clone(), opts, self.output));
        self.committed = 0;
        self.rendered = 0;
        Ok(())
    }
}
