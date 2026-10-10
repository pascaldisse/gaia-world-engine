//! game-window — native host for the JS game.
//!   window (opaque, wgpu/Metal CAMetalLayer) ← drawn by the Rust renderer at internal height → MetalFX → surface
//!   child webview (transparent, FULL window, above the surface) ← the game page: HUD/menus, ALL input (keys, mouse, pointer lock)
//!   page → Rust: `__GAIA_NATIVE__.send(bytes)` → Tauri raw-body invoke `gaia_native_apply` → queue → render thread → Host::apply
//! Never launched by the lane that wrote it (UNVERIFIED at runtime) — see NOTES.md.
mod config;
mod gpu;
mod host;
#[cfg(feature = "stub-host")]
mod host_stub;
#[cfg(feature = "host-ipc")]
mod host_ipc;
mod page;
#[cfg(target_os = "macos")]
mod pointer;
mod shared;

use config::GameConfig;
use gpu::{FrameOutcome, Presenter};
use shared::{Info, Shared};
use std::{
    sync::{Arc, atomic::Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, PhysicalPosition, WebviewUrl};

/// == build.rs app manifest == capabilities/local.json. Remote capability below is generated from this list.
const COMMANDS: &[&str] = &["gaia_native_apply", "gaia_native_info"];
const WINDOW_LABEL: &str = "game-window";
const WEBVIEW_LABEL: &str = "game";
/// Sleep when the surface gives no drawable (occluded / minimised / reconfigure): never spin.
const IDLE_SLEEP: Duration = Duration::from_millis(16);

/// Raw-body invoke: `invoke('gaia_native_apply', Uint8Array)`.
#[tauri::command]
fn gaia_native_apply(request: tauri::ipc::Request<'_>, shared: tauri::State<'_, Arc<Shared>>) -> Result<(), String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => shared.push(bytes.clone()),
        tauri::ipc::InvokeBody::Json(_) => Err("gaia_native_apply: body must be raw bytes (Uint8Array/ArrayBuffer), got JSON".into()),
    }
}

#[tauri::command]
fn gaia_native_info(shared: tauri::State<'_, Arc<Shared>>) -> Info {
    let mut info = shared.info.lock().unwrap().clone();
    info.queued_bytes = shared.queued_bytes();
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
    let shared = Arc::new(Shared::new(
        cfg.max_backlog_bytes,
        Info {
            host: host::HostAdapter::NAME,
            upscaler: cfg.upscaler.name().into(),
            render_height: cfg.render_height,
            pointer_lock: if cfg.pointer_lock_spi { "pending".into() } else { "off (stock wry: WebKit denies requestPointerLock)".into() },
            page_gpu: page::page_gpu_name(cfg.page_gpu),
            ..Default::default()
        },
    ));
    let run_shared = shared.clone();
    let setup_cfg = cfg.clone();
    tauri::Builder::default()
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![gaia_native_apply, gaia_native_info])
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
                .initialization_script(page::init_script(&cfg));
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

            let presenter = RenderThreadOwned(Presenter::new(&window, &cfg).map_err(std::io::Error::other)?);
            {
                let mut info = shared.info.lock().unwrap();
                info.adapter = presenter.0.adapter_name.clone();
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
    let (mut frames, mut apply_errors, mut applied_msgs, mut applied_bytes) = (0u64, 0u64, 0u64, 0u64);
    let mut last_error: Option<String> = None;
    let (mut window_start, mut window_frames, mut window_cpu, mut since_print) = (Instant::now(), 0u64, 0.0f64, 0u64);
    while shared.running.load(Ordering::Acquire) {
        let t0 = Instant::now();
        // 1. drain command bytes from the webview, in arrival order
        for bytes in shared.drain() {
            match presenter.host.apply(&bytes) {
                Ok(()) => {
                    applied_msgs += 1;
                    applied_bytes += bytes.len() as u64;
                }
                Err(e) => {
                    apply_errors += 1;
                    if apply_errors <= 50 {
                        eprintln!("[host] apply error #{apply_errors} ({} bytes): {e}", bytes.len());
                    }
                    last_error = Some(e);
                }
            }
        }
        // 2. draw + present (resize handled inside; Fifo present blocks = vsync pacing)
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let outcome = presenter.frame((size.width, size.height))?;
        let cpu_ms = t0.elapsed().as_secs_f64() * 1e3;
        match outcome {
            FrameOutcome::Presented => {
                frames += 1;
                window_frames += 1;
                window_cpu += cpu_ms;
            }
            FrameOutcome::Skipped(why) => {
                if frames == 0 || frames % 600 == 0 {
                    eprintln!("[gpu] frame skipped: {why}");
                }
                thread::sleep(IDLE_SLEEP);
            }
        }
        // 3. stats
        let elapsed = window_start.elapsed().as_secs_f64();
        if elapsed >= 1.0 {
            let fps = window_frames as f64 / elapsed;
            let mean_cpu = if window_frames > 0 { window_cpu / window_frames as f64 } else { 0.0 };
            {
                let mut info = shared.info.lock().unwrap();
                info.stage = format!("{:?}", presenter.stage());
                info.output = [presenter.output_size().0, presenter.output_size().1];
                info.internal = [presenter.internal_size().0, presenter.internal_size().1];
                info.scale_factor = window.scale_factor().unwrap_or(1.0);
                info.frame = frames;
                info.fps = fps;
                info.cpu_ms = mean_cpu;
                info.applied_messages = applied_msgs;
                info.applied_bytes = applied_bytes;
                info.apply_errors = apply_errors;
                info.last_error = last_error.clone();
            }
            since_print += window_frames;
            if cfg.stats_every > 0 && since_print >= cfg.stats_every {
                since_print = 0;
                eprintln!("[stats] frame={frames} fps={fps:.1} cpu_ms={mean_cpu:.2} internal={:?} output={:?} stage={:?} msgs={applied_msgs} bytes={applied_bytes} apply_errors={apply_errors}", presenter.internal_size(), presenter.output_size(), presenter.stage());
            }
            (window_start, window_frames, window_cpu) = (Instant::now(), 0, 0.0);
        }
        // 4. optional extra cap on top of vsync
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
