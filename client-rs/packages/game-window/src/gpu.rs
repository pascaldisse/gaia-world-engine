//! wgpu surface + the internal-height -> upscale -> present pipeline. Runs on the render thread only.
//!
//!   host.render(enc, internal_view)      internal size = render_height x (window aspect)
//!     |- Spatial   : submit; MetalFX SpatialUpscaler (own cmd buffer, same queue) -> output tex; copy -> surface
//!     |- Bilinear  : blit pass internal -> surface view
//!     `- Passthrough (internal == window size, nothing to upscale): copy internal -> surface
//!   present on a Fifo surface = display vsync = the frame pacing (optional extra fps cap in main.rs).
use crate::config::{GameConfig, UpscalerKind};
use crate::host::HostAdapter;

#[cfg(target_os = "macos")]
type Scaler = gaia_metalfx::SpatialUpscaler;
#[cfg(not(target_os = "macos"))]
type Scaler = std::convert::Infallible;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageKind {
    Passthrough,
    Bilinear,
    Spatial,
}

pub enum FrameOutcome {
    Presented,
    Skipped(&'static str),
}

struct Target {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
}

struct Blit {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

impl Blit {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("game-window blit"),
            source: wgpu::ShaderSource::Wgsl(include_str!("blit.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blit layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("blit pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("game-window blit"),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("blit bilinear"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self { pipeline, layout, sampler }
    }

    fn encode(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, dst: &wgpu::TextureView) {
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blit bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("internal -> surface blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
}

pub struct Presenter {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    /// What the Host draws with + what the surface presents (may be sRGB).
    view_format: wgpu::TextureFormat,
    /// Same bytes as UNORM storage (MetalFX accepts no sRGB format; sRGB is a view over it).
    storage_format: wgpu::TextureFormat,
    pub host: HostAdapter,
    internal: Target,
    kind: UpscalerKind,
    render_height: u32,
    stage: StageKind,
    scaler: Option<Scaler>,
    output: Option<wgpu::Texture>,
    blit: Option<Blit>,
    pub adapter_name: String,
}

/// Internal size: height = min(render_height, window height), width follows the window aspect (even, >= 2).
pub fn internal_size(window: (u32, u32), render_height: u32) -> (u32, u32) {
    let h = render_height.min(window.1).max(1);
    if h == window.1 {
        return window;
    }
    let w = ((u64::from(h) * u64::from(window.0) + u64::from(window.1) / 2) / u64::from(window.1)) as u32;
    ((w.max(2) + 1) & !1, h)
}

fn make_target(device: &wgpu::Device, label: &'static str, storage: wgpu::TextureFormat, view_format: wgpu::TextureFormat, size: (u32, u32), usage: wgpu::TextureUsages) -> Target {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: storage,
        usage,
        view_formats: &[view_format],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor { format: Some(view_format), ..Default::default() });
    Target { tex, view, size }
}

impl Presenter {
    pub fn new(window: &tauri::Window, cfg: &GameConfig) -> Result<Self, String> {
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
        // Limits lifted to the adapter (large scene buffers, same as the browser path); features = what gaia-render can use.
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_features: adapter.features() & gaia_render::RenderCore::OPTIONAL_FEATURES,
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .map_err(|e| format!("wgpu device: {e}"))?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&adapter);
        let view_format = [
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
            format: view_format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        let storage_format = view_format.remove_srgb_suffix();
        let win = (config.width, config.height);
        let isize = internal_size(win, cfg.render_height);
        let internal = make_target(&device, "internal color", storage_format, view_format, isize, internal_usage());
        let host = HostAdapter::new(&device, &queue, view_format, isize)?;
        let info = adapter.get_info();
        let mut p = Self {
            surface,
            device,
            queue,
            config,
            view_format,
            storage_format,
            host,
            internal,
            kind: cfg.upscaler,
            render_height: cfg.render_height,
            stage: StageKind::Passthrough,
            scaler: None,
            output: None,
            blit: None,
            adapter_name: format!("{} ({:?})", info.name, info.backend),
        };
        p.build_stage()?;
        eprintln!(
            "[gpu] {} surface {:?} {}x{} internal {}x{} stage={:?} host={}",
            p.adapter_name, view_format, win.0, win.1, isize.0, isize.1, p.stage, HostAdapter::NAME
        );
        Ok(p)
    }

    pub fn output_size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }
    pub fn internal_size(&self) -> (u32, u32) {
        self.internal.size
    }
    pub fn stage(&self) -> StageKind {
        self.stage
    }

    /// (Re)build everything that depends on output/internal size. Loud Err, no fallback to another stage.
    fn build_stage(&mut self) -> Result<(), String> {
        let out = self.output_size();
        self.scaler = None;
        self.output = None;
        if self.internal.size == out {
            self.stage = StageKind::Passthrough;
            return Ok(());
        }
        match self.kind {
            UpscalerKind::Bilinear => {
                self.stage = StageKind::Bilinear;
                if self.blit.is_none() {
                    self.blit = Some(Blit::new(&self.device, self.view_format));
                }
            }
            UpscalerKind::MetalFxSpatial => {
                #[cfg(target_os = "macos")]
                {
                    let scaler = gaia_metalfx::SpatialUpscaler::new(
                        &self.device,
                        &self.queue,
                        gaia_metalfx::ScalerConfig {
                            input_size: self.internal.size,
                            output_size: out,
                            color_format: self.storage_format,
                            output_format: self.storage_format,
                        },
                    )
                    .map_err(|e| format!("metalfx-spatial {}x{} -> {}x{}: {e}", self.internal.size.0, self.internal.size.1, out.0, out.1))?;
                    let output = make_target(&self.device, "metalfx output", self.storage_format, self.view_format, out, output_usage()).tex;
                    // §TRAP (gaia-metalfx NOTES): wgpu zero-inits a never-wgpu-written texture on first read, wiping MetalFX's result.
                    gaia_metalfx::mark_output_initialized(&self.device, &self.queue, &output);
                    self.scaler = Some(scaler);
                    self.output = Some(output);
                    self.stage = StageKind::Spatial;
                }
                #[cfg(not(target_os = "macos"))]
                return Err("metalfx-spatial is macOS-only".into());
            }
        }
        Ok(())
    }

    fn resize(&mut self, win: (u32, u32)) -> Result<(), String> {
        self.config.width = win.0;
        self.config.height = win.1;
        self.surface.configure(&self.device, &self.config);
        let isize = internal_size(win, self.render_height);
        if isize != self.internal.size {
            self.internal = make_target(&self.device, "internal color", self.storage_format, self.view_format, isize, internal_usage());
            self.host.resize(isize)?;
        }
        self.build_stage()?;
        eprintln!("[gpu] resize -> surface {}x{} internal {}x{} stage={:?}", win.0, win.1, isize.0, isize.1, self.stage);
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

    /// One frame. `win` = window inner size in physical px. Errors are fatal to the caller (loud).
    pub fn frame(&mut self, win: (u32, u32)) -> Result<FrameOutcome, String> {
        let _ = self.device.poll(wgpu::PollType::Poll);
        if win.0 == 0 || win.1 == 0 {
            return Ok(FrameOutcome::Skipped("zero-size window"));
        }
        if win != self.output_size() {
            self.resize(win)?;
        }
        let new_encoder = |d: &wgpu::Device, label| d.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(label) });
        let mut enc = new_encoder(&self.device, "game frame");
        self.host.render(&mut enc, &self.internal.view)?;
        if self.stage == StageKind::Spatial {
            // MetalFX commits its OWN command buffer: its input must already be submitted (same-queue order).
            self.queue.submit(Some(enc.finish()));
            #[cfg(target_os = "macos")]
            {
                let (scaler, output) = (self.scaler.as_mut().expect("spatial scaler"), self.output.as_ref().expect("spatial output"));
                scaler.upscale(&self.internal.tex, output).map_err(|e| format!("metalfx upscale: {e}"))?;
            }
            enc = new_encoder(&self.device, "game present");
        }
        let Some(frame) = self.acquire()? else {
            self.queue.submit(Some(enc.finish()));
            return Ok(FrameOutcome::Skipped("no drawable (occluded/timeout/reconfigure)"));
        };
        let extent = wgpu::Extent3d { width: self.config.width, height: self.config.height, depth_or_array_layers: 1 };
        match self.stage {
            StageKind::Passthrough => enc.copy_texture_to_texture(self.internal.tex.as_image_copy(), frame.texture.as_image_copy(), extent),
            StageKind::Spatial => enc.copy_texture_to_texture(self.output.as_ref().expect("spatial output").as_image_copy(), frame.texture.as_image_copy(), extent),
            StageKind::Bilinear => {
                let dst = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
                self.blit.as_ref().expect("blit").encode(&self.device, &mut enc, &self.internal.view, &dst);
            }
        }
        self.queue.submit(Some(enc.finish()));
        self.queue.present(frame);
        Ok(FrameOutcome::Presented)
    }
}

// MetalFX demands ShaderRead on its color input and ShaderRead|RenderTarget on its output (gaia-metalfx NOTES).
fn internal_usage() -> wgpu::TextureUsages {
    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC
}
fn output_usage() -> wgpu::TextureUsages {
    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC
}
