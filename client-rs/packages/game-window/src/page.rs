//! Script injected into the game page BEFORE any page script (every navigation, top frame).
//! 1. page-gpu=hidden: the page cannot see WebGPU → WKWebView never creates a WebGPU device for drawing
//!    (three/webgpu falls back to its WebGL2 backend for scene-graph use; the native Host draws).
//! 2. html/body background transparent so the Metal surface shows through; HUD/menus stay HTML.
//! 3. `window.__GAIA_NATIVE__` (frozen): host stats only — `.info()` -> Promise<Info>, `.renderHeight/.upscaler/.pageGpu`.
//!    The render command stream is NOT here: lane nt-ipc's GaiaRenderNative calls `invoke('gaia_render_apply', bytes)` itself.
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
  if (cfg.pageLog !== 'off') { // page console -> host stderr (gaia_page_log); cfg.pageLog = off|error|warn|all
    const rank = { error: 0, warn: 1, info: 2, log: 2 }, max = rank[cfg.pageLog === 'all' ? 'log' : cfg.pageLog] ?? 1;
    const fmt = (a) => a.map((x) => { try { return x instanceof Error ? (x.stack || String(x)) : typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } }).join(' ').slice(0, cfg.pageLogMax);
    const send = (level, text) => { try { window.__TAURI_INTERNALS__.invoke('gaia_page_log', { level, text }).catch(() => {}); } catch (e) {} };
    for (const level of ['error', 'warn', 'info', 'log']) { if (rank[level] > max) continue; const orig = console[level].bind(console); console[level] = (...a) => { orig(...a); send(level, fmt(a)); }; }
    addEventListener('error', (e) => send('uncaught', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno} ${e.error?.stack ?? ''}`.slice(0, cfg.pageLogMax)));
    addEventListener('unhandledrejection', (e) => send('rejection', fmt([e.reason])));
  }
  const api = {
    version: 2,
    renderHeight: cfg.renderHeight, upscaler: cfg.upscaler, pageGpu: cfg.pageGpu,
    info() { return invoke('gaia_native_info'); },
  };
  Object.defineProperty(window, '__GAIA_NATIVE__', { value: Object.freeze(api) });
})();"#;

pub fn init_script(cfg: &GameConfig) -> String {
    let json = serde_json::json!({
        "renderHeight": cfg.render_height,
        "upscaler": cfg.upscaler.name(),
        "pageGpu": page_gpu_name(cfg.page_gpu),
        "pageLog": cfg.page_log,
        "pageLogMax": cfg.page_log_max,
    });
    TEMPLATE.replace("__CFG__", &json.to_string())
}

pub fn page_gpu_name(p: PageGpu) -> &'static str {
    match p {
        PageGpu::Hidden => "hidden",
        PageGpu::Visible => "visible",
    }
}
