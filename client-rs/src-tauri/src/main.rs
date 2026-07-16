use std::{
    num::NonZeroU64,
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

const SHADER: &str = r#"
struct Clock { time: f32, };
@group(0) @binding(0) var<uniform> clock: Clock;

struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) tint: vec3<f32>, };

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  var points = array<vec2<f32>, 3>(vec2(-0.62, -0.46), vec2(0.62, -0.46), vec2(0.0, 0.66));
  let a = clock.time * 0.85;
  let c = cos(a);
  let s = sin(a);
  let p = points[index];
  var out: VertexOut;
  out.position = vec4(c * p.x - s * p.y, s * p.x + c * p.y, 0.0, 1.0);
  out.tint = vec3(0.22 + 0.20 * sin(a), 0.72, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return vec4(in.tint, 1.0);
}
"#;

#[derive(Clone)]
struct SpikeConfig {
    window_width: f64,
    window_height: f64,
    panel_width: f64,
    panel_height: f64,
    panel_margin: f64,
    fps: f64,
    title: String,
    auto_test_ipc: bool,
}

impl SpikeConfig {
    fn from_env() -> Result<Self, String> {
        let number = |name: &str, default: f64| -> Result<f64, String> {
            match std::env::var(name) {
                Ok(value) => value
                    .parse::<f64>()
                    .map_err(|_| format!("{name} must be a number, got {value:?}")),
                Err(_) => Ok(default),
            }
        };
        let auto_test_ipc = match std::env::var("SPIKE_AUTOTEST_IPC") {
            Ok(value) => value
                .parse::<bool>()
                .map_err(|_| format!("SPIKE_AUTOTEST_IPC must be true or false, got {value:?}"))?,
            Err(_) => false,
        };
        let config = Self {
            window_width: number("SPIKE_WINDOW_WIDTH", 960.0)?,
            window_height: number("SPIKE_WINDOW_HEIGHT", 640.0)?,
            panel_width: number("SPIKE_PANEL_WIDTH", 300.0)?,
            panel_height: number("SPIKE_PANEL_HEIGHT", 154.0)?,
            panel_margin: number("SPIKE_PANEL_MARGIN", 24.0)?,
            fps: number("SPIKE_RENDER_FPS", 60.0)?,
            title: std::env::var("SPIKE_WINDOW_TITLE")
                .unwrap_or_else(|_| "GAIA — Tauri / wgpu raw-handle spike".into()),
            auto_test_ipc,
        };
        if config.window_width <= 0.0
            || config.window_height <= 0.0
            || config.panel_width <= 0.0
            || config.panel_height <= 0.0
            || config.panel_margin < 0.0
            || config.fps <= 0.0
        {
            return Err("SPIKE dimensions and FPS must be positive (margin may be zero)".into());
        }
        if config.panel_width + config.panel_margin > config.window_width
            || config.panel_height + config.panel_margin > config.window_height
        {
            return Err("overlay panel plus SPIKE_PANEL_MARGIN must fit in the window".into());
        }
        Ok(config)
    }

    fn frame_interval(&self) -> Duration {
        Duration::from_secs_f64(1.0 / self.fps)
    }

    fn panel_layout(&self, size: PhysicalSize<u32>) -> (PhysicalPosition<f64>, PhysicalSize<u32>) {
        let width = f64::from(size.width);
        let position = PhysicalPosition::new(
            (width - self.panel_width - self.panel_margin).max(0.0),
            self.panel_margin,
        );
        let panel = PhysicalSize::new(self.panel_width.round() as u32, self.panel_height.round() as u32);
        (position, panel)
    }

    fn is_panel_point(&self, x: f64, y: f64, size: PhysicalSize<u32>) -> bool {
        let width = f64::from(size.width);
        let height = f64::from(size.height);
        let left = width - self.panel_width - self.panel_margin;
        let bottom = height - self.panel_height - self.panel_margin;
        x >= left && x <= width - self.panel_margin && y >= bottom && y <= height - self.panel_margin
    }
}

struct Renderer {
    // Safety: created from the native Tauri Window's raw handles; the app owns that Window
    // until shutdown, and Renderer is dropped before the Tauri App returns from run().
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    clock_buffer: wgpu::Buffer,
    clock_bind_group: wgpu::BindGroup,
    started: Instant,
}

impl Renderer {
    fn new(window: &tauri::Window) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let target = unsafe {
            wgpu::SurfaceTargetUnsafe::from_display_and_window(window, window)
                .map_err(|error| format!("raw-window-handle target: {error}"))?
        };
        let surface = unsafe {
            instance
                .create_surface_unsafe(target)
                .map_err(|error| format!("wgpu surface: {error}"))?
        };
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .map_err(|error| format!("wgpu adapter: {error}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .map_err(|error| format!("wgpu device: {error}"))?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let capabilities = surface.get_capabilities(&adapter);
        let format = capabilities
            .formats
            .iter()
            .copied()
            .find(wgpu::TextureFormat::is_srgb)
            .unwrap_or(capabilities.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: capabilities.alpha_modes[0],
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let clock_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("animation clock"),
            size: NonZeroU64::new(std::mem::size_of::<f32>() as u64).unwrap().get(),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("clock layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: NonZeroU64::new(std::mem::size_of::<f32>() as u64),
                },
                count: None,
            }],
        });
        let clock_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("clock bind group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: clock_buffer.as_entire_binding(),
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("triangle layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("animated triangle shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("animated triangle pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        eprintln!("[wgpu] raw-window-handle surface configured: {format:?} {}x{}", config.width, config.height);
        Ok(Self {
            surface,
            device,
            queue,
            config,
            pipeline,
            clock_buffer,
            clock_bind_group,
            started: Instant::now(),
        })
    }

    fn resize(&mut self, size: PhysicalSize<u32>) {
        if size.width > 0 && size.height > 0 && (size.width != self.config.width || size.height != self.config.height) {
            self.config.width = size.width;
            self.config.height = size.height;
            self.surface.configure(&self.device, &self.config);
        }
    }

    fn render(&mut self, size: PhysicalSize<u32>) {
        self.resize(size);
        let seconds = self.started.elapsed().as_secs_f32();
        self.queue.write_buffer(&self.clock_buffer, 0, &seconds.to_ne_bytes());
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Validation => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let pulse = 0.5 + 0.5 * (seconds * 0.7).sin();
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("animated frame"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("triangle pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.025 + f64::from(pulse) * 0.04,
                            g: 0.05 + f64::from(pulse) * 0.07,
                            b: 0.12 + f64::from(pulse) * 0.13,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.clock_bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(encoder.finish()));
        self.queue.present(frame);
    }
}

struct RenderState {
    renderer: Mutex<Renderer>,
    last_frame: Mutex<Instant>,
    frame_interval: Duration,
}

#[tauri::command]
fn panel_pressed() {
    eprintln!("[ipc] transparent overlay button -> Rust command");
}

#[cfg(target_os = "macos")]
fn install_passthrough_monitor(window: tauri::Window, config: SpikeConfig) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};

    let click_window = window.clone();
    let block = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { event.as_ref() };
        let point = event.locationInWindow();
        if let Ok(size) = click_window.inner_size()
            && !config.is_panel_point(point.x, point.y, size)
        {
            eprintln!("[wgpu-input] passthrough click x={:.1} y={:.1}", point.x, point.y);
        }
        event as *const NSEvent as *mut NSEvent
    });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &block)
    }
    .ok_or_else(|| "failed to install macOS local mouse monitor".to_string())?;
    Box::leak(Box::new(monitor));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_passthrough_monitor(_window: tauri::Window, _config: SpikeConfig) -> Result<(), String> {
    Err("this spike's physical native click monitor is macOS-only".into())
}

fn main() {
    let config = SpikeConfig::from_env().unwrap_or_else(|error| panic!("invalid spike config: {error}"));
    let render_interval = config.frame_interval();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![panel_pressed])
        .setup(move |app| {
            let window = tauri::window::WindowBuilder::new(app, "wgpu-surface")
                .title(config.title.clone())
                .inner_size(config.window_width, config.window_height)
                .build()?;
            let size = window.inner_size()?;
            let (position, panel_size) = config.panel_layout(size);
            let auto_test_ipc = config.auto_test_ipc;
            let overlay = tauri::webview::WebviewBuilder::new("overlay-panel", WebviewUrl::App("index.html".into()))
                .transparent(true)
                .on_page_load(move |webview, payload| {
                    if auto_test_ipc && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let _ = webview.eval("document.querySelector('#ipc')?.click()");
                    }
                });
            let overlay = window.add_child(overlay, position, panel_size)?;
            let resize_overlay = overlay.clone();
            let resize_config = config.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    let (position, panel_size) = resize_config.panel_layout(*size);
                    let _ = resize_overlay.set_position(position);
                    let _ = resize_overlay.set_size(panel_size);
                }
            });
            install_passthrough_monitor(window.clone(), config.clone()).map_err(std::io::Error::other)?;
            let renderer = Renderer::new(&window).map_err(std::io::Error::other)?;
            app.manage(RenderState {
                renderer: Mutex::new(renderer),
                last_frame: Mutex::new(Instant::now()),
                frame_interval: render_interval,
            });
            eprintln!("[spike] child webview overlay created; native clicks outside its bounds reach the wgpu host window");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri app build failed")
        .run(|app, event| {
            if let tauri::RunEvent::MainEventsCleared = event {
                let state = app.state::<RenderState>();
                let mut last_frame = state.last_frame.lock().expect("frame timer lock");
                if last_frame.elapsed() >= state.frame_interval {
                    *last_frame = Instant::now();
                    if let Some(window) = app.get_window("wgpu-surface")
                        && let Ok(size) = window.inner_size()
                    {
                        state.renderer.lock().expect("renderer lock").render(size);
                    }
                }
            }
        });
}
