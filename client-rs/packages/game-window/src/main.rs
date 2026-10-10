//! game-window — native host for the JS game.
//!   window (opaque, wgpu/Metal CAMetalLayer) ← drawn by the Rust renderer at internal height → MetalFX → surface
//!   child webview (transparent, FULL window, above the surface) ← the game page: HUD/menus, ALL input (keys, mouse, pointer lock)
//!   page → Rust: `__GAIA_NATIVE__.send(bytes)` → Tauri raw-body invoke `gaia_native_apply` → queue → render thread → Host::apply
//! Never launched by the lane that wrote it (UNVERIFIED at runtime) — see NOTES.md.
mod apply;
mod config;
mod gpu;
mod ipc_ws;
mod page;
#[cfg(target_os = "macos")]
mod pointer;
mod shared;

use config::GameConfig;
use gaia_render_host::Host;
use gpu::{FrameOutcome, Presenter};
use shared::{Info, Shared};
use std::{
    sync::{Arc, Mutex, atomic::Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, PhysicalPosition, WebviewUrl};

/// == build.rs app manifest == capabilities/local.json. Remote capability below is generated from this list.
const COMMANDS: &[&str] = &["gaia_render_apply", "gaia_native_info", "gaia_page_log"];
const WINDOW_LABEL: &str = "game-window";
const WEBVIEW_LABEL: &str = "game";

/// Page -> native: one raw-body message of the GaiaRenderNative command stream; the response is the Host's JSON report
/// (verbatim bytes). `async` ON PURPOSE: sync commands run on the MAIN thread, and `apply` does GPU uploads (an 80 MB
/// scene) — async commands run on Tauri's worker pool. Order is kept by the JS side (exactly one message in flight).
#[tauri::command]
async fn gaia_render_apply(
    app: tauri::AppHandle,
    shared: tauri::State<'_, Arc<Shared>>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    // managed at the end of setup(), after the page may already be loading: a too-early message is an Err, not a panic
    let host = app.try_state::<Arc<Mutex<Host>>>().ok_or("gaia_render_apply: host not ready yet (setup still running)")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("gaia_render_apply: raw body expected (Uint8Array), got JSON".into());
    };
    let report = apply::apply_logged(&host, &shared, bytes, "invoke", Duration::ZERO)?;
Ok(tauri::ipc::Response::new(report))
}

/// Page console -> host stderr (WKWebView has no CDP; without this a page that dies during load is silent).
/// Forwarded by page.rs init script: console.error/warn/info/log + window error + unhandledrejection, `level` + text.
#[tauri::command]
fn gaia_page_log(level: String, text: String) {
    eprintln!("[page:{level}] {text}");
}

#[tauri::command]
fn gaia_native_info(shared: tauri::State<'_, Arc<Shared>>) -> Info {
    let mut info = shared.info.lock().unwrap().clone();
    info.apply_messages = shared.apply_messages.load(Ordering::Relaxed);
    info.apply_bytes = shared.apply_bytes.load(Ordering::Relaxed);
    info.gpu_errors = shared.gpu_errors.load(Ordering::Relaxed);
    info
}

/// Presenter holds Metal objects (MTLFXSpatialScaler etc.) that are not `Send` in objc2 but are thread-safe to hand
/// over (same argument as gaia-metalfx's `unsafe impl Send for MetalFxSpatial`): created on the main thread (the
/// CAMetalLayer must be), then used by exactly ONE thread (gaia-render) for the rest of the process.
struct RenderThreadOwned(Presenter);
unsafe impl Send for RenderThreadOwned {}

fn main() {
    let cfg = GameConfig::load().unwrap_or_else(|e| {
        eprintln!("game-window: {e}");
        std::process::exit(2);
    });
    if cfg.dry_run {
        println!("url={}\n{cfg:#?}", cfg.url);
        return;
    }
    let shared = Arc::new(Shared::new(Info {
        upscaler: cfg.upscaler.name().into(),
        render_height: cfg.render_height,
        pointer_lock: if cfg.pointer_lock_spi { "pending".into() } else { "off (stock wry: WebKit denies requestPointerLock)".into() },
        page_gpu: page::page_gpu_name(cfg.page_gpu),
        ..Default::default()
    }));
    let run_shared = shared.clone();
    let setup_cfg = cfg.clone();
    tauri::Builder::default()
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![gaia_render_apply, gaia_native_info, gaia_page_log])
        .setup(move |app| {
            let cfg = setup_cfg;
            // Remote page (vite on http://127.0.0.1:port) may only call OUR commands, only from its own origin.
            let origin = cfg.url.origin().ascii_serialization();
            let permissions: Vec<String> = COMMANDS.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
            app.add_capability(
                serde_json::json!({
                    "identifier": "game-remote",
                    "windows": [WINDOW_LABEL],
                    "webviews": [WEBVIEW_LABEL],
                    "remote": { "urls": [format!("{origin}/*")] },
                    "permissions": permissions,
                })
                .to_string(),
            )?;

            // port + token must exist before the webview (they go into its init script); accepting starts once the Host is managed
let ipc = if cfg.ipc_ws { Some(ipc_ws::IpcWs::bind(&cfg)?) } else { None };
let window = tauri::window::WindowBuilder::new(app, WINDOW_LABEL)
                .title(cfg.title.clone())
                .inner_size(cfg.window_size.0, cfg.window_size.1)
                .resizable(true)
                .fullscreen(cfg.fullscreen)
                .build()?;
            let size = window.inner_size()?;
            let builder = tauri::webview::WebviewBuilder::new(WEBVIEW_LABEL, WebviewUrl::External(cfg.url.clone()))
                .transparent(true) // macOS: needs macos-private-api (enabled) — WKWebView drawsBackground=NO
                .accept_first_mouse(true)
                .devtools(cfg.devtools)
                .initialization_script(page::init_script(&cfg, ipc.as_ref().map(|i| (i.port, i.token.as_str()))));
            let webview = window.add_child(builder, PhysicalPosition::new(0.0, 0.0), size)?;
            let resize_target = webview.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    let _ = resize_target.set_size(*size);
                    let _ = resize_target.set_position(PhysicalPosition::new(0.0, 0.0));
                }
            });
            #[cfg(target_os = "macos")]
            if cfg.pointer_lock_spi {
                pointer::install(&webview, shared.clone()).map_err(std::io::Error::other)?;
            }
            let _ = webview.set_focus(); // keyboard goes to the page from the first frame

            let presenter = RenderThreadOwned(Presenter::new(&window, &cfg, &shared).map_err(std::io::Error::other)?);
            shared.info.lock().unwrap().adapter = presenter.0.adapter_name.clone();
            let host = presenter.0.host();
app.manage(host.clone()); // State<Arc<Mutex<Host>>> for gaia_render_apply
if let Some(ipc) = ipc {
ipc.serve(host, shared.clone())?;
}
            eprintln!("[game-window] {} → {}  (render {}p, upscaler {}, page-gpu {:?})", cfg.title, cfg.url, cfg.render_height, cfg.upscaler.name(), cfg.page_gpu);
            let app_handle = app.handle().clone();
            let render_shared = shared.clone();
            thread::Builder::new()
                .name("gaia-render".into())
                .spawn(move || {
                    let presenter = presenter;
                    if let Err(e) = render_loop(presenter.0, &window, &cfg, &render_shared) {
                        eprintln!("[fatal] render loop: {e}");
                        app_handle.exit(3);
                    }
                })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri app build failed")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                run_shared.running.store(false, Ordering::Release);
            }
        });
}

fn render_loop(mut presenter: Presenter, window: &tauri::Window, cfg: &GameConfig, shared: &Shared) -> Result<(), String> {
    let cap = (cfg.fps_cap > 0.0).then(|| Duration::from_secs_f64(1.0 / cfg.fps_cap));
    let mut deadline = Instant::now();
    let (mut presented, mut since_print) = (0u64, 0u64);
    let (mut window_start, mut window_frames, mut window_cpu) = (Instant::now(), 0u64, 0.0f64);
    let mut last_idle: Option<&'static str> = None;
    while shared.running.load(Ordering::Acquire) {
        let t0 = Instant::now();
        // drain + draw + present: IPC threads apply command bytes into the shared Host; Fifo present blocks = vsync pacing
        let size = window.inner_size().map_err(|e| e.to_string())?;
        match presenter.frame((size.width, size.height))? {
            FrameOutcome::Presented => {
                presented += 1;
                window_frames += 1;
                window_cpu += t0.elapsed().as_secs_f64() * 1e3;
                last_idle = None;
            }
            FrameOutcome::Idle(why) => {
                if last_idle != Some(why) {
                    eprintln!("[gpu] idle: {why}");
                    last_idle = Some(why);
                }
                thread::sleep(cfg.idle_sleep);
            }
        }
        let elapsed = window_start.elapsed().as_secs_f64();
        if elapsed >= 1.0 {
            let fps = window_frames as f64 / elapsed;
            let mean_cpu = if window_frames > 0 { window_cpu / window_frames as f64 } else { 0.0 };
            let internal = presenter.internal_size();
            {
                let mut info = shared.info.lock().unwrap();
                info.stage = presenter.stage().into();
                info.output = [presenter.output_size().0, presenter.output_size().1];
                info.internal = internal.map(|(w, h)| [w, h]);
                info.session = presenter.session_exists();
                info.scale_factor = window.scale_factor().unwrap_or(1.0);
                info.frames_presented = presented;
                info.fps = fps;
                info.cpu_ms = mean_cpu;
            }
            since_print += window_frames;
            if cfg.stats_every > 0 && since_print >= cfg.stats_every {
                since_print = 0;
                eprintln!(
                    "[stats] presented={presented} fps={fps:.1} cpu_ms={mean_cpu:.2} internal={internal:?} output={:?} msgs={} bytes={} gpu_errors={}",
                    presenter.output_size(),
                    shared.apply_messages.load(Ordering::Relaxed),
                    shared.apply_bytes.load(Ordering::Relaxed),
                    shared.gpu_errors.load(Ordering::Relaxed),
                );
            }
            (window_start, window_frames, window_cpu) = (Instant::now(), 0, 0.0);
        }
        // optional extra cap on top of vsync
        if let Some(interval) = cap {
            deadline += interval;
            let now = Instant::now();
            if deadline > now {
                thread::sleep(deadline - now);
            } else {
                deadline = now;
            }
        }
    }
    Ok(())
}
