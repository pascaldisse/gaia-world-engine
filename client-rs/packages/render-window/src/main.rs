use std::{
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    num::NonZeroU64,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use gaia_core::{Core, GaiaPackage};
use render_window::RenderWindowPackage;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

const DEFAULT_NATIVE_PORT: u16 = 8430;
const BYTES_PER_PIXEL: u32 = 4;
const CAPTURE_SLOT_COUNT: usize = 3;

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
struct RenderWindowConfig {
    window_width: f64,
    window_height: f64,
    panel_width: f64,
    panel_height: f64,
    panel_margin: f64,
    fps: f64,
    native_port: u16,
    title: String,
    auto_test_ipc: bool,
}

impl RenderWindowConfig {
    fn from_env() -> Result<Self, String> {
        let number = |name: &str, default: f64| -> Result<f64, String> {
            match std::env::var(name) {
                Ok(value) => value
                    .parse::<f64>()
                    .map_err(|_| format!("{name} must be a number, got {value:?}")),
                Err(_) => Ok(default),
            }
        };
        let native_port = match std::env::var("GAIA_NATIVE_PORT") {
            Ok(value) => value
                .parse::<u16>()
                .map_err(|_| format!("GAIA_NATIVE_PORT must be a port, got {value:?}"))?,
            Err(_) => DEFAULT_NATIVE_PORT,
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
            native_port,
            title: std::env::var("SPIKE_WINDOW_TITLE")
                .unwrap_or_else(|_| "GAIA — render-window".into()),
            auto_test_ipc,
        };
        if config.window_width <= 0.0
            || config.window_height <= 0.0
            || config.panel_width <= 0.0
            || config.panel_height <= 0.0
            || config.panel_margin < 0.0
            || config.fps <= 0.0
            || config.native_port == 0
        {
            return Err(
                "window dimensions, FPS, and GAIA_NATIVE_PORT must be positive (margin may be zero)"
                    .into(),
            );
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
        let panel = PhysicalSize::new(
            self.panel_width.round() as u32,
            self.panel_height.round() as u32,
        );
        (position, panel)
    }

    fn is_panel_point(&self, x: f64, y: f64, size: PhysicalSize<u32>) -> bool {
        let width = f64::from(size.width);
        let height = f64::from(size.height);
        let left = width - self.panel_width - self.panel_margin;
        let bottom = height - self.panel_height - self.panel_margin;
        x >= left
            && x <= width - self.panel_margin
            && y >= bottom
            && y <= height - self.panel_margin
    }
}

#[derive(Clone, Copy)]
enum PixelOrder {
    Rgba,
    Bgra,
}

struct CapturedFrame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

type LatestFrame = Arc<RwLock<Option<Arc<CapturedFrame>>>>;

struct CaptureReady {
    result: Result<(), String>,
    buffer: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
    pixel_order: PixelOrder,
    busy: Arc<AtomicBool>,
}

fn spawn_capture_worker(latest: LatestFrame) -> mpsc::Sender<CaptureReady> {
    let (sender, receiver) = mpsc::channel::<CaptureReady>();
    thread::Builder::new()
        .name("gaia-frame-capture".into())
        .spawn(move || {
            while let Ok(capture) = receiver.recv() {
                if let Err(error) = &capture.result {
                    eprintln!("[screenshot] framebuffer map failed: {error}");
                    capture.busy.store(false, Ordering::Release);
                    continue;
                }
                let row_bytes = (capture.width * BYTES_PER_PIXEL) as usize;
                let mapped = match capture.buffer.get_mapped_range(..) {
                    Ok(mapped) => mapped,
                    Err(error) => {
                        eprintln!("[screenshot] mapped framebuffer unavailable: {error}");
                        capture.buffer.unmap();
                        capture.busy.store(false, Ordering::Release);
                        continue;
                    }
                };
                let mut rgba = Vec::with_capacity(row_bytes * capture.height as usize);
                for row in mapped
                    .chunks(capture.padded_bytes_per_row as usize)
                    .take(capture.height as usize)
                {
                    rgba.extend_from_slice(&row[..row_bytes]);
                }
                if matches!(capture.pixel_order, PixelOrder::Bgra) {
                    for pixel in rgba.chunks_exact_mut(BYTES_PER_PIXEL as usize) {
                        pixel.swap(0, 2);
                    }
                }
                drop(mapped);
                capture.buffer.unmap();
                if let Ok(mut frame) = latest.write() {
                    *frame = Some(Arc::new(CapturedFrame {
                        width: capture.width,
                        height: capture.height,
                        rgba,
                    }));
                }
                capture.busy.store(false, Ordering::Release);
            }
        })
        .expect("spawn framebuffer capture worker");
    sender
}

fn encode_png(frame: &CapturedFrame) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, frame.width, frame.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&frame.rgba)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &str,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra_headers}\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

fn handle_http(mut stream: TcpStream, latest: &LatestFrame) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = [0_u8; 4096];
    let Ok(read) = stream.read(&mut request) else {
        return;
    };
    let first_line = String::from_utf8_lossy(&request[..read])
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    if first_line.starts_with("GET /screenshot ") {
        let frame = latest.read().ok().and_then(|frame| frame.clone());
        match frame {
            Some(frame) => match encode_png(&frame) {
                Ok(png) => {
                    let dimensions =
                        format!("X-GAIA-Framebuffer: {}x{}\r\n", frame.width, frame.height);
                    let _ = write_response(&mut stream, "200 OK", "image/png", &png, &dimensions);
                }
                Err(error) => {
                    let _ = write_response(
                        &mut stream,
                        "500 Internal Server Error",
                        "text/plain; charset=utf-8",
                        error.as_bytes(),
                        "",
                    );
                }
            },
            None => {
                let _ = write_response(
                    &mut stream,
                    "503 Service Unavailable",
                    "text/plain; charset=utf-8",
                    b"framebuffer not ready\n",
                    "Retry-After: 1\r\n",
                );
            }
        }
    } else if first_line.starts_with("GET ") {
        let _ = write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"not found\n",
            "",
        );
    } else {
        let _ = write_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"method not allowed\n",
            "Allow: GET\r\n",
        );
    }
}

fn start_screenshot_server(port: u16, latest: LatestFrame) -> Result<(), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .map_err(|error| format!("bind GAIA_NATIVE_PORT {port}: {error}"))?;
    thread::Builder::new()
        .name("gaia-native-http".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => handle_http(stream, &latest),
                    Err(error) => eprintln!("[screenshot] HTTP accept failed: {error}"),
                }
            }
        })
        .map_err(|error| format!("spawn screenshot HTTP server: {error}"))?;
    eprintln!("[screenshot] GET http://127.0.0.1:{port}/screenshot");
    Ok(())
}

struct CaptureSlot {
    buffer: wgpu::Buffer,
    busy: Arc<AtomicBool>,
}

struct OffscreenTarget {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    slots: Vec<CaptureSlot>,
    next_slot: usize,
    padded_bytes_per_row: u32,
    width: u32,
    height: u32,
}

impl OffscreenTarget {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat, width: u32, height: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("screenshot framebuffer"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let unpadded = width * BYTES_PER_PIXEL;
        let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = unpadded.div_ceil(alignment) * alignment;
        let buffer_size = u64::from(padded_bytes_per_row) * u64::from(height);
        let slots = (0..CAPTURE_SLOT_COUNT)
            .map(|index| CaptureSlot {
                buffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(match index {
                        0 => "frame readback 0",
                        1 => "frame readback 1",
                        _ => "frame readback 2",
                    }),
                    size: buffer_size,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
                busy: Arc::new(AtomicBool::new(false)),
            })
            .collect();
        Self {
            texture,
            view,
            slots,
            next_slot: 0,
            padded_bytes_per_row,
            width,
            height,
        }
    }

    fn claim_slot(&mut self) -> Option<usize> {
        for offset in 0..self.slots.len() {
            let index = (self.next_slot + offset) % self.slots.len();
            if self.slots[index]
                .busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                self.next_slot = (index + 1) % self.slots.len();
                return Some(index);
            }
        }
        None
    }
}

struct Renderer {
    // Safety: created from the native Tauri Window's raw handles; the app owns that Window
    // until shutdown, and the render worker stops before process exit.
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    clock_buffer: wgpu::Buffer,
    clock_bind_group: wgpu::BindGroup,
    offscreen: OffscreenTarget,
    pixel_order: PixelOrder,
    capture_sender: mpsc::Sender<CaptureReady>,
    started: Instant,
}

impl Renderer {
    fn new(
        window: &tauri::Window,
        capture_sender: mpsc::Sender<CaptureReady>,
    ) -> Result<Self, String> {
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
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|error| format!("wgpu device: {error}"))?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let capabilities = surface.get_capabilities(&adapter);
        let format = [
            wgpu::TextureFormat::Bgra8UnormSrgb,
            wgpu::TextureFormat::Rgba8UnormSrgb,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|candidate| capabilities.formats.contains(candidate))
        .ok_or_else(|| {
            "surface has no 8-bit RGBA/BGRA format for framebuffer capture".to_string()
        })?;
        let pixel_order = match format {
            wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
                PixelOrder::Bgra
            }
            _ => PixelOrder::Rgba,
        };
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
            size: NonZeroU64::new(std::mem::size_of::<f32>() as u64)
                .unwrap()
                .get(),
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
        let offscreen = OffscreenTarget::new(&device, format, config.width, config.height);
        eprintln!(
            "[wgpu] raw-window-handle surface + offscreen framebuffer: {format:?} {}x{}",
            config.width, config.height
        );
        Ok(Self {
            surface,
            device,
            queue,
            config,
            pipeline,
            clock_buffer,
            clock_bind_group,
            offscreen,
            pixel_order,
            capture_sender,
            started: Instant::now(),
        })
    }

    fn resize(&mut self, size: PhysicalSize<u32>) {
        if size.width > 0
            && size.height > 0
            && (size.width != self.config.width || size.height != self.config.height)
        {
            self.config.width = size.width;
            self.config.height = size.height;
            self.surface.configure(&self.device, &self.config);
            self.offscreen = OffscreenTarget::new(
                &self.device,
                self.config.format,
                self.config.width,
                self.config.height,
            );
        }
    }

    fn encode_triangle_pass(
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        pipeline: &wgpu::RenderPipeline,
        clock_bind_group: &wgpu::BindGroup,
        clear: wgpu::Color,
        label: &'static str,
    ) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, clock_bind_group, &[]);
        pass.draw(0..3, 0..1);
    }

    fn render(&mut self, size: PhysicalSize<u32>) {
        let _ = self.device.poll(wgpu::PollType::Poll);
        self.resize(size);
        let seconds = self.started.elapsed().as_secs_f32();
        self.queue
            .write_buffer(&self.clock_buffer, 0, &seconds.to_ne_bytes());
        let surface_frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => Some(frame),
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                None
            }
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Validation => None,
        };
        let pulse = 0.5 + 0.5 * (seconds * 0.7).sin();
        let clear = wgpu::Color {
            r: 0.025 + f64::from(pulse) * 0.04,
            g: 0.05 + f64::from(pulse) * 0.07,
            b: 0.12 + f64::from(pulse) * 0.13,
            a: 1.0,
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("render + framebuffer capture"),
            });
        Self::encode_triangle_pass(
            &mut encoder,
            &self.offscreen.view,
            &self.pipeline,
            &self.clock_bind_group,
            clear,
            "offscreen triangle pass",
        );
        if let Some(frame) = &surface_frame {
            let view = frame
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            Self::encode_triangle_pass(
                &mut encoder,
                &view,
                &self.pipeline,
                &self.clock_bind_group,
                clear,
                "surface triangle pass",
            );
        }

        if let Some(index) = self.offscreen.claim_slot() {
            let slot = &self.offscreen.slots[index];
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.offscreen.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &slot.buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(self.offscreen.padded_bytes_per_row),
                        rows_per_image: Some(self.offscreen.height),
                    },
                },
                wgpu::Extent3d {
                    width: self.offscreen.width,
                    height: self.offscreen.height,
                    depth_or_array_layers: 1,
                },
            );
            let sender = self.capture_sender.clone();
            let buffer = slot.buffer.clone();
            let callback_buffer = buffer.clone();
            let busy = slot.busy.clone();
            let callback_busy = busy.clone();
            let width = self.offscreen.width;
            let height = self.offscreen.height;
            let padded_bytes_per_row = self.offscreen.padded_bytes_per_row;
            let pixel_order = self.pixel_order;
            encoder.map_buffer_on_submit(&buffer, wgpu::MapMode::Read, .., move |result| {
                let capture = CaptureReady {
                    result: result.map_err(|error| error.to_string()),
                    buffer: callback_buffer,
                    width,
                    height,
                    padded_bytes_per_row,
                    pixel_order,
                    busy: callback_busy,
                };
                if let Err(error) = sender.send(capture) {
                    let capture = error.0;
                    if capture.result.is_ok() {
                        capture.buffer.unmap();
                    }
                    capture.busy.store(false, Ordering::Release);
                }
            });
        }
        self.queue.submit(Some(encoder.finish()));
        if let Some(frame) = surface_frame {
            self.queue.present(frame);
        }
    }
}

struct RuntimeState {
    running: Arc<AtomicBool>,
}

#[tauri::command]
fn panel_pressed() {
    eprintln!("[ipc] transparent overlay button -> Rust command");
}

#[cfg(target_os = "macos")]
fn install_passthrough_monitor(
    window: tauri::Window,
    config: RenderWindowConfig,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};

    let click_window = window.clone();
    let block = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { event.as_ref() };
        let point = event.locationInWindow();
        if let Ok(size) = click_window.inner_size()
            && !config.is_panel_point(point.x, point.y, size)
        {
            eprintln!(
                "[wgpu-input] passthrough click x={:.1} y={:.1}",
                point.x, point.y
            );
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
fn install_passthrough_monitor(
    _window: tauri::Window,
    _config: RenderWindowConfig,
) -> Result<(), String> {
    Err("this package's physical native click monitor is macOS-only".into())
}

fn main() {
    let config = RenderWindowConfig::from_env()
        .unwrap_or_else(|error| panic!("invalid render-window config: {error}"));
    let render_interval = config.frame_interval();
    let native_port = config.native_port;
    let mut core = Core::default();
    RenderWindowPackage.register(&mut core);
    eprintln!(
        "[package] {} v{} registered",
        core.package("render-window").unwrap().name,
        core.package("render-window").unwrap().version
    );

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
            let overlay = tauri::webview::WebviewBuilder::new(
                "overlay-panel",
                WebviewUrl::App("index.html".into()),
            )
            .transparent(true)
            .on_page_load(move |webview, payload| {
                if auto_test_ipc
                    && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                {
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
            install_passthrough_monitor(window.clone(), config.clone())
                .map_err(std::io::Error::other)?;

            let latest = Arc::new(RwLock::new(None));
            let capture_sender = spawn_capture_worker(latest.clone());
            let renderer = Renderer::new(&window, capture_sender).map_err(std::io::Error::other)?;
            start_screenshot_server(native_port, latest).map_err(std::io::Error::other)?;
            let running = Arc::new(AtomicBool::new(true));
            app.manage(RuntimeState {
                running: running.clone(),
            });
            thread::Builder::new()
                .name("gaia-render".into())
                .spawn(move || {
                    let mut renderer = renderer;
                    let mut deadline = Instant::now();
                    while running.load(Ordering::Acquire) {
                        if let Ok(size) = window.inner_size() {
                            renderer.render(size);
                        }
                        deadline += render_interval;
                        let now = Instant::now();
                        if deadline > now {
                            thread::sleep(deadline - now);
                        } else {
                            deadline = now;
                        }
                    }
                })
                .map_err(std::io::Error::other)?;
            eprintln!(
                "[render-window] child webview overlay created; render, capture, PNG, and HTTP run off the main thread"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri app build failed")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<RuntimeState>()
                    .running
                    .store(false, Ordering::Release);
            }
        });
}
