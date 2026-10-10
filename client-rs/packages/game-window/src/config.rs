//! Every tunable: CLI flag > env var > DEFAULT (single table below, §IRON: nothing hardcoded elsewhere).
//! `--url <u>` also accepted as the first positional argument.
use std::collections::HashMap;

/// name (= --flag), env var, default, help
const OPTIONS: &[(&str, &str, &str, &str)] = &[
    ("url", "GAIA_GAME_URL", "", "game page URL (vite) — REQUIRED, no default"),
    ("render-height", "GAIA_RENDER_HEIGHT", "720", "internal render height (px); width follows window aspect"),
    ("upscaler", "GAIA_UPSCALER", "metalfx-spatial", "metalfx-spatial | bilinear"),
    ("fps-cap", "GAIA_FPS_CAP", "0", "extra frame cap (0 = display vsync only)"),
    ("width", "GAIA_WINDOW_WIDTH", "1280", "window logical width"),
    ("height", "GAIA_WINDOW_HEIGHT", "720", "window logical height"),
    ("title", "GAIA_WINDOW_TITLE", "GAIA", "window title"),
    ("fullscreen", "GAIA_FULLSCREEN", "0", "1 = start fullscreen"),
    ("page-gpu", "GAIA_PAGE_GPU", "hidden", "hidden = page sees NO navigator.gpu / webgpu canvas (WKWebView never creates a WebGPU device) | visible = leave WebGPU to the page (transitional: three's own compute until lane nt-gi lands)"),
    ("pointer-lock", "GAIA_POINTER_LOCK", "spi", "spi = enable Element.requestPointerLock() in WKWebView via the private WKUIDelegate hook | off = stock wry (lock is DENIED by WebKit)"),
    ("devtools", "GAIA_DEVTOOLS", "0", "1 = enable the web inspector"),
    ("max-backlog-bytes", "GAIA_MAX_BACKLOG_BYTES", "268435456", "undrained command bytes before gaia_native_apply rejects (page must back off)"),
    ("stats-every", "GAIA_STATS_EVERY", "300", "print fps/cpu line every N frames (0 = off)"),
    ("query", "GAIA_GAME_QUERY", "", "extra raw query appended to the URL (e.g. renderBackend=native)"),
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
    pub devtools: bool,
    pub max_backlog_bytes: usize,
    pub stats_every: u64,
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
        let pointer_lock_spi = match get("pointer-lock").as_str() {
            "spi" => true,
            "off" => false,
            other => return Err(format!("--pointer-lock must be spi|off, got {other:?}")),
        };
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
            devtools: flag("devtools")?,
            max_backlog_bytes: num("max-backlog-bytes")? as usize,
            stats_every: num("stats-every")? as u64,
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
