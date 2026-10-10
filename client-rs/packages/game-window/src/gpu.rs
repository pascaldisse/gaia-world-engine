//! wgpu surface + frame loop pieces. Runs on the render thread; the SAME `Host` is shared (Mutex) with the Tauri
//! IPC threads that call `host.apply` (page -> command bytes -> JSON report).
//!
//!   Host (gaia-render-host) = JS command stream -> RenderCore session. Its core renders at the JS/--render-height
//!   internal resolution (width follows the OUTPUT aspect) and upscales to the output size.
//!   upscaler=bilinear      : host.render(enc, surface_view)   (core default Encoder-mode blit) -> submit -> present.
//!                            Only when a frame was committed (host.frame_pending) or the surface needs a repaint.
//!   upscaler=metalfx-spatial: core is switched to MetalFxSpatial (Queue mode: it commits its OWN command buffer, so
//!                            `Host::render` -- Encoder-mode only, would panic) -> core.render_frame(output_tex) -> copy
//!                            output_tex -> surface -> present, EVERY vsync (Host exposes no "frame consumed" reset for
//!                            this path; same cadence as render-window). A Host::render_queue() would let it idle (ask nt-ipc).
//!   Present on a Fifo surface = display vsync = the frame pacing.
use crate::{config::{GameConfig, UpscalerKind}, shared::Shared};
use gaia_render_host::Host;
use std::sync::{Arc, Mutex, MutexGuard};

pub enum FrameOutcome {
    Presented,
    /// nothing to draw / no drawable: caller sleeps `--idle-sleep-ms`
    Idle(&'static str),
}

pub struct Presenter {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    host: Arc<Mutex<Host>>,
    kind: UpscalerKind,
    render_height: u32,
    /// Spatial only: UNORM storage texture MetalFX writes (sRGB view format allowed), sized like the surface.
    output: Option<wgpu::Texture>,
    /// the current Host session was configured (upscaler + render height); reset when the page frees/never created it
    session_ready: bool,
    /// surface needs a repaint although no new frame was committed (resize, lost drawable)
    dirty: bool,
    pub adapter_name: String,
}

/// wgpu's default uncaptured-error handler PANICS (kills the render thread mid-frame). Log loudly + count instead.
fn install_error_handler(device: &wgpu::Device, shared: &Arc<Shared>) {
    let shared = shared.clone();
    device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
        let n = shared.gpu_errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let text = error.to_string();
        if n <= 100 {
            eprintln!("[wgpu] UNCAPTURED ERROR #{n}: {text}");
        } else if n == 101 {
            eprintln!("[wgpu] further uncaptured errors are counted, not printed (info().gpu_errors)");
        }
        shared.info.lock().unwrap().last_gpu_error = Some(text);
    }));
}

impl Presenter {
    /// Main thread (the CAMetalLayer must be created there).
    pub fn new(window: &tauri::Window, cfg: &GameConfig, shared: &Arc<Shared>) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        // Safety: raw handles of the Tauri Window, which the app keeps alive until exit; the render thread stops first.
        let target = unsafe { wgpu::SurfaceTargetUnsafe::from_display_and_window(window, window) }
            .map_err(|e| format!("raw-window-handle target: {e}"))?;
        let surface = unsafe { instance.create_surface_unsafe(target) }.map_err(|e| format!("wgpu surface: {e}"))?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .map_err(|e| format!("wgpu adapter: {e}"))?;
        let (desc, features) = gaia_render_host::device_descriptor(&adapter);
        let (device, queue) = pollster::block_on(adapter.request_device(&desc)).map_err(|e| format!("wgpu device: {e}"))?;
        install_error_handler(&device, shared);
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&adapter);
        // sRGB view format first: the core's output_format and the surface agree, no manual gamma anywhere.
        let format = [
            wgpu::TextureFormat::Bgra8UnormSrgb,
            wgpu::TextureFormat::Rgba8UnormSrgb,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .ok_or("surface offers no 8-bit RGBA/BGRA format")?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        let host = Host::new(device.clone(), queue.clone(), format, (config.width, config.height));
        let info = adapter.get_info();
        let adapter_name = format!("{} ({:?})", info.name, info.backend);
        eprintln!("[gpu] {adapter_name} surface {format:?} {}x{} features={features:?} upscaler={}", config.width, config.height, cfg.upscaler.name());
        let mut p = Self {
            surface,
            device,
            queue,
            config,
            host: Arc::new(Mutex::new(host)),
            kind: cfg.upscaler,
            render_height: cfg.render_height,
            output: None,
            session_ready: false,
            dirty: true,
            adapter_name,
        };
        p.rebuild_output()?;
        Ok(p)
    }

    /// For the Tauri `State` (IPC threads call `.lock().apply(bytes)`).
    pub fn host(&self) -> Arc<Mutex<Host>> {
        self.host.clone()
    }
    pub fn output_size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }
    pub fn stage(&self) -> &'static str {
        match self.kind {
            UpscalerKind::Bilinear => "bilinear (Host::render -> surface)",
            UpscalerKind::MetalFxSpatial => "metalfx-spatial (render_frame -> copy -> surface)",
        }
    }

    fn lock_host(&self) -> Result<MutexGuard<'_, Host>, String> {
        self.host.lock().map_err(|_| "Host mutex poisoned (a thread panicked while holding it)".to_string())
    }

    fn rebuild_output(&mut self) -> Result<(), String> {
        self.output = None;
        if self.kind == UpscalerKind::MetalFxSpatial {
            let view_format = self.config.format;
            let storage = view_format.remove_srgb_suffix();
            // MetalFX demands ShaderRead|RenderTarget on its output (gaia-metalfx NOTES); COPY_SRC for the surface copy.
            self.output = Some(self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("metalfx output"),
                size: wgpu::Extent3d { width: self.config.width, height: self.config.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: storage,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[view_format],
            }));
        }
        Ok(())
    }

    fn resize(&mut self, win: (u32, u32)) -> Result<(), String> {
        self.config.width = win.0;
        self.config.height = win.1;
        self.surface.configure(&self.device, &self.config);
        self.lock_host()?.resize(win.0, win.1);
        self.rebuild_output()?;
        self.dirty = true;
        eprintln!("[gpu] resize -> {}x{}", win.0, win.1);
        Ok(())
    }

    fn acquire(&mut self) -> Result<Option<wgpu::SurfaceTexture>, String> {
        Ok(match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => Some(f),
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                None
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => None,
            wgpu::CurrentSurfaceTexture::Validation => return Err("surface acquire: validation error".into()),
        })
    }

    /// Once per Host session (after the page's hello): upscaler + authoritative internal height on the core.
    /// `set_upscaler`/`set_render_height` drop the core's targets, so this must NOT run every frame.
    fn configure_session(&mut self, host: &mut Host) -> Result<(), String> {
        let session = host.session_mut().ok_or("session vanished between is_created and session_mut")?;
        session.core.set_render_height(self.render_height);
        #[cfg(target_os = "macos")]
        if self.kind == UpscalerKind::MetalFxSpatial {
            let up = gaia_metalfx::MetalFxSpatial::new(&self.device, &self.queue, self.config.format)
                .map_err(|e| format!("upscaler metalfx-spatial: {e}"))?;
            session.core.set_upscaler(Box::new(up));
        }
        #[cfg(not(target_os = "macos"))]
        if self.kind == UpscalerKind::MetalFxSpatial {
            return Err("metalfx-spatial is macOS-only".into());
        }
        self.session_ready = true;
        Ok(())
    }

    /// (render thread) stats the page's `info()` reports.
    pub fn internal_size(&self) -> Option<(u32, u32)> {
        let mut host = self.host.lock().ok()?;
        let s = host.session_mut()?;
        s.core.internal_size().map(|u| (u.width, u.height))
    }
    pub fn session_exists(&self) -> bool {
        self.host.lock().map(|h| h.is_created()).unwrap_or(false)
    }

    /// One frame. `win` = window inner size in physical px. Errors are fatal to the caller (loud).
    pub fn frame(&mut self, win: (u32, u32)) -> Result<FrameOutcome, String> {
        let _ = self.device.poll(wgpu::PollType::Poll);
        if win.0 == 0 || win.1 == 0 {
            return Ok(FrameOutcome::Idle("zero-size window"));
        }
        if win != self.output_size() {
            self.resize(win)?;
        }
        let host_arc = self.host.clone();
        let mut host = host_arc.lock().map_err(|_| "Host mutex poisoned".to_string())?;
        if !host.is_created() {
            self.session_ready = false; // page not up yet / freed: nothing to configure, nothing to draw
            return Ok(FrameOutcome::Idle("waiting for the page's hello"));
        }
        if !self.session_ready {
            self.configure_session(&mut host)?;
        }
        match self.kind {
            UpscalerKind::Bilinear => {
                if !(host.frame_pending() || self.dirty) {
                    return Ok(FrameOutcome::Idle("no committed frame"));
                }
                let Some(frame) = self.acquire()? else {
                    self.dirty = true;
                    return Ok(FrameOutcome::Idle("no drawable (occluded/timeout/reconfigure)"));
                };
                let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
                let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("game frame") });
                if !host.render(&mut enc, &view) {
                    return Err("Host::render returned false although the session exists".into());
                }
                self.queue.submit(Some(enc.finish()));
                self.queue.present(frame);
            }
            UpscalerKind::MetalFxSpatial => {
                let output = self.output.clone().ok_or("spatial output texture missing")?; // Arc clone: acquire() needs &mut self
                let size = gaia_render::UpscaleSize { width: self.config.width, height: self.config.height };
                let session = host.session_mut().ok_or("session vanished")?;
                // renders + submits the forward pass, then MetalFX commits its own command buffer into `output`
                session.core.render_frame(&self.device, &self.queue, &output, size).map_err(|e| format!("render_frame: {e}"))?;
                let Some(frame) = self.acquire()? else {
                    self.dirty = true;
                    return Ok(FrameOutcome::Idle("no drawable (occluded/timeout/reconfigure)"));
                };
                let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("game present") });
                enc.copy_texture_to_texture(
                    output.as_image_copy(),
                    frame.texture.as_image_copy(),
                    wgpu::Extent3d { width: self.config.width, height: self.config.height, depth_or_array_layers: 1 },
                );
                self.queue.submit(Some(enc.finish()));
                self.queue.present(frame);
            }
        }
        self.dirty = false;
        Ok(FrameOutcome::Presented)
    }
}
