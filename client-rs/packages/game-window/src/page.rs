//! Script injected into the game page BEFORE any page script (every navigation, top frame).
//! 1. page-gpu=hidden: the page cannot see WebGPU → WKWebView never creates a WebGPU device for drawing
//!    (three/webgpu falls back to its WebGL2 backend for scene-graph use; the native Host draws).
//! 2. html/body background transparent so the Metal surface shows through; HUD/menus stay HTML.
//! 3. `window.__GAIA_NATIVE__` — the contract the page-side transport (lane nt-ipc JS) uses:
//!      .send(Uint8Array) -> Promise   one command message, strictly in order, rejects if the host backlog is full
//!      .info()           -> Promise   host stats (frame/fps/sizes/apply_errors/last_error/pointer_lock/...)
//!      .pending          -> number    messages in flight (throttle on it)
//!      .renderHeight/.upscaler/.pageGpu/.version  startup config (host is authoritative for the internal size)
use crate::config::{GameConfig, PageGpu};

const TEMPLATE: &str = r#"(() => {
  if (window.__GAIA_NATIVE__) return;
  const cfg = __CFG__;
  if (cfg.pageGpu === 'hidden') {
    try { delete Navigator.prototype.gpu; } catch (e) {}
    if ('gpu' in navigator) { try { Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get() { return undefined; } }); } catch (e) {} }
    for (const C of [HTMLCanvasElement, typeof OffscreenCanvas === 'undefined' ? null : OffscreenCanvas]) {
      if (!C) continue;
      const orig = C.prototype.getContext;
      C.prototype.getContext = function (type, ...rest) { return type === 'webgpu' ? null : orig.call(this, type, ...rest); };
    }
  }
  const clear = () => { const s = document.createElement('style'); s.textContent = 'html,body{background:transparent!important}'; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', clear); else clear();
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  let tail = Promise.resolve(), pending = 0;
  const api = {
    version: 1,
    renderHeight: cfg.renderHeight, upscaler: cfg.upscaler, pageGpu: cfg.pageGpu,
    get pending() { return pending; },
    send(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
      pending++;
      const p = tail.then(() => invoke('gaia_native_apply', u8)).finally(() => { pending--; });
      tail = p.catch(() => {});
      return p;
    },
    info() { return invoke('gaia_native_info'); },
  };
  Object.defineProperty(window, '__GAIA_NATIVE__', { value: Object.freeze(api) });
})();"#;

pub fn init_script(cfg: &GameConfig) -> String {
    let json = serde_json::json!({
        "renderHeight": cfg.render_height,
        "upscaler": cfg.upscaler.name(),
        "pageGpu": page_gpu_name(cfg.page_gpu),
    });
    TEMPLATE.replace("__CFG__", &json.to_string())
}

pub fn page_gpu_name(p: PageGpu) -> &'static str {
    match p {
        PageGpu::Hidden => "hidden",
        PageGpu::Visible => "visible",
    }
}
