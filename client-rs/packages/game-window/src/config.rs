//! Every tunable: CLI flag > env var > DEFAULT (single table below, §IRON: nothing hardcoded elsewhere).
//! `--url <u>` also accepted as the first positional argument.
use std::collections::HashMap;

/// name (= --flag), env var, default, help
const OPTIONS: &[(&str, &str, &str, &str)] = &[
    ("url", "GAIA_GAME_URL", "", "game page URL (vite) — REQUIRED, no default"),
    ("render-height", "GAIA_RENDER_HEIGHT", "720", "internal render height (px); width follows window aspect. AUTHORITATIVE: forced into the URL as ?wgpuHeight= and set on the core at session start"),
    ("upscaler", "GAIA_UPSCALER", "metalfx-spatial", "metalfx-spatial (core.render_frame, queue-mode) | bilinear (core default, Host::render straight into the surface)"),
    ("fps-cap", "GAIA_FPS_CAP", "0", "extra frame cap (0 = display vsync only)"),
    ("width", "GAIA_WINDOW_WIDTH", "1280", "window logical width"),
    ("height", "GAIA_WINDOW_HEIGHT", "720", "window logical height"),
    ("title", "GAIA_WINDOW_TITLE", "GAIA", "window title"),
    ("fullscreen", "GAIA_FULLSCREEN", "0", "1 = start fullscreen"),
    ("page-gpu", "GAIA_PAGE_GPU", "hidden", "hidden = page sees NO navigator.gpu / webgpu canvas (WKWebView never creates a WebGPU device) | visible = leave WebGPU to the page (transitional: three's own compute until lane nt-gi lands)"),
    ("occlusion-detection", "GAIA_OCCLUSION_DETECTION", "off", "off = page stays visible (rAF runs) when the window is covered (private WKWebView SPI) | on = stock WebKit: covered window -> visibilityState hidden -> rAF stops"),
    ("pointer-lock", "GAIA_POINTER_LOCK", "spi", "spi = enable Element.requestPointerLock() in WKWebView via the private WKUIDelegate hook | off = stock wry (lock is DENIED by WebKit)"),
    ("devtools", "GAIA_DEVTOOLS", "0", "1 = enable the web inspector"),
    ("idle-sleep-ms", "GAIA_IDLE_SLEEP_MS", "2", "render-thread sleep when there is nothing to draw (no committed frame / no drawable)"),
    ("render-backend", "GAIA_RENDER_BACKEND", "native", "value forced into the page URL's ?renderBackend= (nt-ipc's GaiaRenderNative = native)"),
    ("stats-every", "GAIA_STATS_EVERY", "300", "print fps/cpu line every N frames (0 = off)"),
    ("dry-run", "GAIA_DRY_RUN", "0", "1 = print the resolved config (final URL etc.) and exit; opens no window"),
    ("page-log", "GAIA_PAGE_LOG", "warn", "page console forwarded to stderr as [page:<level>]: off | error | warn (error+warn+uncaught) | all"),
    ("page-log-max", "GAIA_PAGE_LOG_MAX", "2000", "max chars per forwarded page console line"),
    ("page-heartbeat-ms", "GAIA_PAGE_HEARTBEAT_MS", "5000", "page liveness line [page:heartbeat] every N ms (0 = off; needs --page-log != off)"),
    ("page-mem-ms", "GAIA_PAGE_MEM_MS", "2000", "native-mode page memory accounting line [page:mem] every N ms: page-held bytes per category + host footprints (0 = off; needs --page-log != off; docs/NATIVE.md §page-mem-log)"),
    ("ipc-ws", "GAIA_IPC_WS", "1", "1 = run the localhost WebSocket transport (127.0.0.1 only, per-launch token; page: ?nativeTransport=ws, the default) | 0 = Tauri invoke only"),
("ipc-port", "GAIA_IPC_PORT", "0", "WebSocket server port on 127.0.0.1 (0 = OS-assigned ephemeral)"),
("ipc-check-origin", "GAIA_IPC_CHECK_ORIGIN", "1", "1 = handshake must carry Origin == the game page origin | 0 = token only"),
("ipc-max-message-mb", "GAIA_IPC_MAX_MESSAGE_MB", "256", "largest accepted WebSocket message (MiB); must be >= the page's ?nativeChunkMB (16)"),
("ipc-queue", "GAIA_IPC_QUEUE", "4", "messages buffered between the WS receive thread and the apply thread (receive of N+1 overlaps apply of N)"),
("ipc-read-buf-kb", "GAIA_IPC_READ_BUF_KB", "1024", "per-connection socket read buffer (KiB)"),
("ipc-handshake-ms", "GAIA_IPC_HANDSHAKE_MS", "5000", "drop a connection that has not finished the WS handshake in this time"),
("ipc-stats-ms", "GAIA_IPC_STATS_MS", "2000", "WS throughput line to stderr every N ms while traffic flows (0 = off)"),
("query", "GAIA_GAME_QUERY", "", "extra raw query appended to the URL (e.g. nativeFlushMB=8)"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpscalerKind {
    MetalFxSpatial,
    Bilinear,
}
impl UpscalerKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::MetalFxSpatial => "metalfx-spatial",
            Self::Bilinear => "bilinear",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageGpu {
    Hidden,
    Visible,
}

#[derive(Clone, Debug)]
pub struct GameConfig {
    pub url: tauri::Url,
    pub render_height: u32,
    pub upscaler: UpscalerKind,
    pub fps_cap: f64,
    pub window_size: (f64, f64),
    pub title: String,
    pub fullscreen: bool,
    pub page_gpu: PageGpu,
    pub pointer_lock_spi: bool,
    pub occlusion_detection: bool,
    pub page_log: String,
    pub page_log_max: u32,
    pub page_heartbeat_ms: u32,
    pub page_mem_ms: u32,
    pub devtools: bool,
    pub idle_sleep: std::time::Duration,
    pub dry_run: bool,
    pub stats_every: u64,
pub ipc_ws: bool,
pub ipc_port: u16,
pub ipc_check_origin: bool,
pub ipc_max_message: usize,
pub ipc_queue: usize,
pub ipc_read_buf: usize,
pub ipc_handshake: std::time::Duration,
pub ipc_stats_every: std::time::Duration,
}

pub fn usage() -> String {
    let mut s = String::from("game-window [--url <u> | <u>] [--<option> <value> ...]\n");
    for (name, env, default, help) in OPTIONS {
        s.push_str(&format!("  --{name:<18} ${env:<24} default={default:?}  {help}\n"));
    }
    s
}

impl GameConfig {
    pub fn load() -> Result<Self, String> {
        let cli = parse_cli(std::env::args().skip(1).collect())?;
        let get = |name: &str| -> String {
            let (_, env, default, _) = OPTIONS.iter().find(|o| o.0 == name).expect("option table");
            cli.get(name)
                .cloned()
                .or_else(|| std::env::var(env).ok().filter(|v| !v.is_empty()))
                .unwrap_or_else(|| default.to_string())
        };
        let num = |name: &str| -> Result<f64, String> {
            let v = get(name);
            v.parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .ok_or_else(|| format!("--{name}/env must be a number, got {v:?}"))
        };
        let flag = |name: &str| -> Result<bool, String> {
            match get(name).as_str() {
                "1" | "true" | "on" => Ok(true),
                "0" | "false" | "off" => Ok(false),
                v => Err(format!("--{name}/env must be 0|1, got {v:?}")),
            }
        };
        let raw_url = get("url");
        if raw_url.is_empty() {
            return Err(format!("no game URL (--url or GAIA_GAME_URL)\n{}", usage()));
        }
        let mut url: tauri::Url = raw_url.parse().map_err(|e| format!("url {raw_url:?}: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("url scheme must be http|https, got {:?}", url.scheme()));
        }
        let extra = get("query");
        if !extra.is_empty() {
            let joined = match url.query() {
                Some(q) if !q.is_empty() => format!("{q}&{}", extra.trim_start_matches('&')),
                _ => extra.trim_start_matches('&').to_string(),
            };
            url.set_query(Some(&joined));
        }
        // The host owns these two (page reads them in wgpu-present.js): backend = native transport, height = internal resolution.
        let render_height_n = num("render-height")? as u32;
        let backend = get("render-backend");
        url.set_query(Some(&force_params(url.query().unwrap_or(""), &[("renderBackend", &backend), ("wgpuHeight", &render_height_n.to_string())])));
        let upscaler = match get("upscaler").as_str() {
            "metalfx-spatial" => UpscalerKind::MetalFxSpatial,
            "bilinear" => UpscalerKind::Bilinear,
            "metalfx-temporal" => {
                return Err("upscaler metalfx-temporal REFUSED: it needs per-frame depth + motion vectors + jitter, which the Host render(encoder, view) API does not expose (needs a Host extension)".into())
            }
            other => return Err(format!("--upscaler must be metalfx-spatial|bilinear, got {other:?}")),
        };
        let page_gpu = match get("page-gpu").as_str() {
            "hidden" => PageGpu::Hidden,
            "visible" => PageGpu::Visible,
            other => return Err(format!("--page-gpu must be hidden|visible, got {other:?}")),
        };
        let occlusion_detection = match get("occlusion-detection").as_str() { "on" => true, "off" => false, o => return Err(format!("--occlusion-detection must be on|off, got {o:?}")) };
        let pointer_lock_spi = match get("pointer-lock").as_str() {
            "spi" => true,
            "off" => false,
            other => return Err(format!("--pointer-lock must be spi|off, got {other:?}")),
        };
        let page_log = get("page-log");
        if !matches!(page_log.as_str(), "off" | "error" | "warn" | "all") { return Err(format!("--page-log must be off|error|warn|all, got {page_log:?}")); }
        let page_log_max = num("page-log-max")? as u32;
        let page_heartbeat_ms = num("page-heartbeat-ms")? as u32;
        let page_mem_ms = num("page-mem-ms")? as u32;
        let render_height = num("render-height")? as u32;
        let (w, h) = (num("width")?, num("height")?);
        let fps_cap = num("fps-cap")?;
        if render_height == 0 || w <= 0.0 || h <= 0.0 || fps_cap < 0.0 {
            return Err("render-height/width/height must be > 0 and fps-cap >= 0".into());
        }
        Ok(Self {
            url,
            render_height,
            upscaler,
            fps_cap,
            window_size: (w, h),
            title: get("title"),
            fullscreen: flag("fullscreen")?,
            page_gpu,
            pointer_lock_spi,
            occlusion_detection,
            page_log,
            page_log_max,
            page_heartbeat_ms,
            page_mem_ms,
            devtools: flag("devtools")?,
            dry_run: flag("dry-run")?,
            idle_sleep: std::time::Duration::from_secs_f64(num("idle-sleep-ms")?.max(0.0) / 1e3),
            stats_every: num("stats-every")? as u64,
            ipc_ws: flag("ipc-ws")?,
            ipc_port: u16::try_from(num("ipc-port")? as i64).map_err(|_| "--ipc-port must be 0..65535".to_string())?,
            ipc_check_origin: flag("ipc-check-origin")?,
            ipc_max_message: (num("ipc-max-message-mb")?.max(1.0) * 1048576.0) as usize,
            ipc_queue: num("ipc-queue")?.max(1.0) as usize,
            ipc_read_buf: (num("ipc-read-buf-kb")?.max(4.0) * 1024.0) as usize,
            ipc_handshake: std::time::Duration::from_secs_f64(num("ipc-handshake-ms")?.max(1.0) / 1e3),
            ipc_stats_every: std::time::Duration::from_secs_f64(num("ipc-stats-ms")?.max(0.0) / 1e3),
        })
    }
}

/// `--name value` / `--name=value` / first bare arg = url. Unknown flags are errors (no silent typos).
fn parse_cli(args: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let mut it = args.into_iter().peekable();
    while let Some(a) = it.next() {
        if a == "--help" || a == "-h" {
            return Err(usage());
        }
        let Some(rest) = a.strip_prefix("--") else {
            if out.insert("url".to_string(), a.clone()).is_some() {
                return Err(format!("unexpected extra positional argument {a:?}"));
            }
            continue;
        };
        let (name, value) = match rest.split_once('=') {
            Some((n, v)) => (n.to_string(), v.to_string()),
            None => (rest.to_string(), it.next().ok_or_else(|| format!("--{rest} needs a value"))?),
        };
        if !OPTIONS.iter().any(|o| o.0 == name) {
            return Err(format!("unknown option --{name}\n{}", usage()));
        }
        out.insert(name, value);
    }
    Ok(out)
}

/// Replace-or-append `key=value` pairs in a RAW query string (no decode/re-encode of the other pairs).
fn force_params(query: &str, forced: &[(&str, &str)]) -> String {
    let mut parts: Vec<String> = query
        .split('&')
        .filter(|p| !p.is_empty() && !forced.iter().any(|(k, _)| p.split('=').next() == Some(*k)))
        .map(str::to_string)
        .collect();
    parts.extend(forced.iter().map(|(k, v)| format!("{k}={v}")));
    parts.join("&")
}
