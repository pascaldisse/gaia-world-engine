//! gaia-render — renderer core. wgpu only (no windowing/Tauri): the host hands in a
//! Device/Queue + an output view; this crate renders a glTF scene at an internal
//! resolution (`render_height`) and scales to the output through an `Upscaler`.
//! Same code path for aarch64-apple-darwin (Metal) and wasm32 (WebGPU).
pub mod scene;
pub mod shadow;
mod three_material;
mod timing_async;
pub use three_material::ThreeFrame;
pub mod skin;
mod gi;
pub use gi::{GI_MAX_CASCADES, GI_PARAM_CASCADE, GI_PARAM_HEADER, GI_TEX_WIDTH};

use glam::{Mat4, Vec3};
use std::collections::HashMap;
pub use scene::{CameraData, SceneData};
pub use shadow::{ShadowOptions, ShadowStats};
use wgpu::util::DeviceExt;

pub const MAX_POINT_LIGHTS: usize = 64;
pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// Internal color target: sRGB-encoded LDR after tonemap (filterable everywhere).
pub const INTERNAL_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// Storage format of the internal color texture: UNORM with an sRGB VIEW (`INTERNAL_FORMAT`)
/// → passes write sRGB-encoded bytes; Queue upscalers (MetalFX: no sRGB formats at all,
/// measured 10-06 "mixed sRGB inputs and outputs is not supported") read the raw texture.
pub const INTERNAL_STORAGE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const FORWARD_WGSL: &str = include_str!("forward.wgsl");
const BLIT_WGSL: &str = include_str!("blit.wgsl");

/// Every tunable is a parameter with a default (no hardcoded per-scene values).
#[derive(Clone, Debug)]
pub struct RenderOptions {
    /// Internal render height in pixels; width follows output aspect.
    pub render_height: u32,
    pub output_format: wgpu::TextureFormat,
    pub exposure: f32,
    /// Sky (up-facing) ambient; also the flat ambient when `ambient_ground` is None.
    pub ambient: [f32; 3],
    /// Ground (down-facing) ambient; None = flat (= `ambient`). A glb `scene.extras.gaia.ambient` overrides both at load.
    pub ambient_ground: Option<[f32; 3]>,
    /// Used only when the glb carries no directional light.
    pub default_sun_direction: [f32; 3],
    pub default_sun_color: [f32; 3],
    pub default_sun_intensity: f32,
    /// Used only when the glb carries no camera node.
    pub default_fov_y_degrees: f32,
    pub clear_color: [f64; 4],
    /// Scale applied to KHR_lights_punctual intensities (lux / candela → shader units).
    pub light_intensity_scale: f32,
    /// Material sampler anisotropy (1 = off, max 16).
    pub anisotropy: u16,
    /// Camera fit when the glb has no camera: fraction of half-extent behind center,
    /// and fraction of half-height below center.
    pub fit_eye_back: f32,
    pub fit_height_bias: f32,
    /// Sun cascaded shadow maps (see `shadow.rs`). Point-light shadows: not implemented.
    pub shadows: ShadowOptions,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            render_height: 720,
            output_format: wgpu::TextureFormat::Bgra8UnormSrgb,
            exposure: 1.0,
            ambient: [0.08, 0.09, 0.11],
            ambient_ground: None,
            default_sun_direction: [-0.3, -1.0, -0.2],
            default_sun_color: [1.0, 0.95, 0.85],
            default_sun_intensity: 3.0,
            default_fov_y_degrees: 60.0,
            clear_color: [0.45, 0.55, 0.7, 1.0],
            light_intensity_scale: 1.0,
            anisotropy: 8,
            fit_eye_back: 0.6,
            fit_height_bias: 0.5,
            shadows: ShadowOptions::default(),
        }
    }
}

/// Hook for the final scale-to-window pass. Default = `BilinearBlit`;
/// `gaia-metalfx` implements this to plug MetalFX in.
/// `WasmNotSend`: Send on native (render thread), no bound on wasm32.
///
/// Two submission models, one trait (`submit_mode` picks):
/// - `Encoder` (default, e.g. `BilinearBlit`): `encode` records into the frame's
///   open encoder. Works with `render` and `render_frame`.
/// - `Queue` (e.g. MetalFX): the scaler commits its OWN command buffer on the queue,
///   so the input must already be SUBMITTED → only `render_frame` drives it; it calls
///   `upscale` after submitting the forward pass. Errors are returned, never swallowed.
pub trait Upscaler: wgpu::WasmNotSend {
    /// Called whenever internal or output size changes.
    fn resize(&mut self, device: &wgpu::Device, input: UpscaleSize, output: UpscaleSize);
    /// Encode input (internal color, depth) → output view. Required for `Encoder` mode.
    fn encode(
        &mut self,
        _device: &wgpu::Device,
        _encoder: &mut wgpu::CommandEncoder,
        _input: UpscaleInput<'_>,
        _output: &wgpu::TextureView,
        _timestamps: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) {
        panic!("Upscaler '{}' is queue-submitted: drive it with RenderCore::render_frame", self.name());
    }
    fn name(&self) -> &str {
        "upscaler"
    }
    fn submit_mode(&self) -> UpscaleSubmit {
        UpscaleSubmit::Encoder
    }
    /// Extra usages the OUTPUT texture must carry (MetalFX: TEXTURE_BINDING).
    fn output_usage(&self) -> wgpu::TextureUsages {
        wgpu::TextureUsages::RENDER_ATTACHMENT
    }
    /// `Queue` mode: input is submitted; commit the upscale on `queue` → `output`.
    fn upscale(
        &mut self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _input: UpscaleInput<'_>,
        _output: &wgpu::Texture,
    ) -> Result<(), UpscaleError> {
        Err(UpscaleError(format!("Upscaler '{}' has no queue path", self.name())))
    }
    /// `Queue` mode GPU time of the last `upscale` (blocks until it completes).
    fn last_gpu_ms_blocking(&self) -> Option<f64> {
        None
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpscaleSubmit {
    Encoder,
    Queue,
}
#[derive(Debug, Clone)]
pub struct UpscaleError(pub String);
impl std::fmt::Display for UpscaleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UpscaleError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpscaleSize {
    pub width: u32,
    pub height: u32,
}

pub struct UpscaleInput<'a> {
    pub color: &'a wgpu::Texture,
    pub color_view: &'a wgpu::TextureView,
    pub depth: &'a wgpu::Texture,
    pub size: UpscaleSize,
}

pub struct BilinearBlit {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

impl BilinearBlit {
    pub fn new(device: &wgpu::Device, output_format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gaia-render blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blit layout"),
            entries: &[
                texture_entry(0),
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
            label: Some("bilinear blit"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("blit_vs"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("blit_fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: output_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
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
        Self {
            pipeline,
            layout,
            sampler,
        }
    }
}

impl BilinearBlit {
    /// Blit `src` view → `dst` view (also used for GPU mip generation).
    fn encode_view(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
    ) {
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blit bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("mip blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
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
impl Upscaler for BilinearBlit {
    fn name(&self) -> &str {
        "bilinear"
    }
    fn resize(&mut self, _: &wgpu::Device, _: UpscaleSize, _: UpscaleSize) {}
    fn encode(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        input: UpscaleInput<'_>,
        output: &wgpu::TextureView,
        timestamps: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) {
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blit bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(input.color_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("upscale blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: timestamps,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
}

fn texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuPointLight {
    position_range: [f32; 4],
    color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct FrameUniform {
    view_proj: [[f32; 4]; 4],
    camera_pos: [f32; 4],
    sun_dir: [f32; 4],
    sun_color: [f32; 4],
    ambient: [f32; 4],
    counts: [u32; 4],
    points: [GpuPointLight; MAX_POINT_LIGHTS],
    /// hemisphere ambient ground colour (rgb); `ambient` = sky. Appended LAST: earlier offsets unchanged for external WGSL.
    ambient_ground: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MaterialUniform {
    base_color: [f32; 4],
    params: [f32; 4],
    emissive: [f32; 4],
    flags: [f32; 4],
}

/// Blend equation of a built-in material (glTF has only alpha; scene-export `materialFlags` writes the others).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlendKind {
    /// src*a + dst*(1-a)
    Alpha,
    /// src*a + dst (glow cards, light shafts: black = no contribution)
    Additive,
    /// dst - src*a
    Subtractive,
}

/// Per-material render flags (data from `material.extras.gaia`; no game names in the engine).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MaterialFlags {
    /// None = from glTF alphaMode (BLEND → Alpha).
    pub blend: Option<BlendKind>,
    /// Base colour only: no lights, shadows, exposure (sky domes, backdrops).
    pub unlit: bool,
    /// With `unlit`: still apply exposure + Reinhard (three `toneMapped: true` on a MeshBasicMaterial). false = authored colour as-is (three `toneMapped: false`).
    pub unlit_tone_mapped: bool,
    /// true = the sun shadow map is NOT sampled for this material (three `receiveShadow: false`). Per MATERIAL (the instance buffer has no spare lane); default false = receives.
    pub no_receive_shadow: bool,
    /// None = default (opaque writes, blended does not).
    pub depth_write: Option<bool>,
    /// Lower draws first (sky = negative → everything else over it). Blended sort far→near inside a group.
    pub render_order: i32,
    /// None = default (opaque/MASK cast, blended never).
    pub cast_shadow: Option<bool>,
}

/// Free camera state; initialised from the glb camera node (or a bounds fit).
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub world: Mat4,
    pub yfov: f32,
    pub znear: f32,
    pub zfar: Option<f32>,
}

impl Camera {
    pub fn from_scene(scene: &SceneData, opts: &RenderOptions) -> Self {
        if let Some(c) = scene.camera {
            return Self {
                world: c.world,
                yfov: c.yfov,
                znear: c.znear,
                zfar: c.zfar,
            };
        }
        let center = (scene.bounds_min + scene.bounds_max) * 0.5;
        let radius = ((scene.bounds_max - scene.bounds_min).length() * 0.5).max(1e-3);
        let yfov = opts.default_fov_y_degrees.to_radians();
        // Fit: stand inside the bounds on the longest horizontal axis, look along it.
        let half = (scene.bounds_max - scene.bounds_min) * 0.5;
        let axis = if half.x >= half.z { Vec3::X } else { Vec3::Z };
        let reach = axis * half.dot(axis);
        let low = Vec3::Y * (-half.y * opts.fit_height_bias);
        let eye = center - reach * opts.fit_eye_back + low;
        let target = center + reach + low;
        Self {
            world: Mat4::look_at_rh(eye, target, Vec3::Y).inverse(),
            yfov,
            znear: radius * 0.002,
            zfar: Some(radius * 4.0),
        }
    }
    fn view_proj(&self, aspect: f32) -> Mat4 {
        let proj = match self.zfar {
            Some(f) => Mat4::perspective_rh(self.yfov, aspect, self.znear, f),
            None => Mat4::perspective_infinite_rh(self.yfov, aspect, self.znear),
        };
        proj * self.world.inverse()
    }
}

struct Targets {
    color: wgpu::Texture,
    color_view: wgpu::TextureView,
    depth: wgpu::Texture,
    depth_view: wgpu::TextureView,
    internal: UpscaleSize,
    output: UpscaleSize,
}

/// GPU timestamp pair per pass, read back on demand.
struct Timing {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    period_ns: f32,
    /// readback mapped by `request_timings_async` and not yet unmapped (timing_async.rs).
    pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Copy, Debug)]
pub struct GpuTimings {
    pub scene_ms: f64,
    pub upscale_ms: f64,
    /// scene-begin → upscale-end span (passes may overlap on tile GPUs).
    pub total_ms: f64,
    /// Shadow passes begin→end (0 when shadows off / nothing re-encoded). Included in `total_ms`.
    pub shadow_ms: f64,
    /// earliest begin → latest end over ALL timed passes (wall span on the GPU timeline; includes idle gaps). total_ms is a SUM of pass durations.
    pub span_ms: f64,
}

/// Data-only resource API (mirrors the JS render-api lane: meshes/materials/
/// instances/camera/lights as plain arrays). Ids are caller-owned u32s.
#[derive(Clone, Debug)]
pub struct MaterialDesc {
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub base_color_texture: Option<u32>,
    /// Some(c) = alpha MASK with cutoff c; None = opaque.
    pub alpha_cutoff: Option<f32>,
    pub emissive: [f32; 3],
    /// three `emissiveMap === map`: emissive x base_color_texture sample (three r180 MeshStandardNodeMaterial: emissive x emissiveMap.rgb; no vertex colour, no base_color factor). Ignored without a base texture.
    pub emissive_from_base: bool,
}

struct GpuMesh {
    /// Object-space AABB center (transparent sort key).
    center: [f32; 3],
    /// Object-space AABB (shadow caster culling).
    lo: [f32; 3],
    hi: [f32; 3],
    vertices: wgpu::Buffer,
    /// TEXCOORD_1 (vertex slot 2, @location(7)); zeros until `set_mesh_uv1`.
    uv1: wgpu::Buffer,
    vertex_count: u32,
    indices: wgpu::Buffer,
    index_count: u32,
}

struct GpuMaterial {
    /// None = external shader material (no built-in desc to rebuild from).
    desc: Option<MaterialDesc>,
    bind: wgpu::BindGroup,
    /// Some = external WGSL pipeline; None = built-in PBR pipeline.
    pipeline: Option<wgpu::RenderPipeline>,
}

/// External material (three TSL node builder output): WGSL module + group(1)
/// layout + data. Contract the WGSL must honour (same as built-in forward.wgsl):
/// group(0) binding(0) = gaia Frame uniform; vertex @location 0 pos, 1 normal,
/// 2 uv, 3..6 instance model matrix columns; one color target (Rgba8UnormSrgb).
/// group(1) = exactly `bindings`.
#[derive(Clone, Debug)]
pub struct ShaderMaterialDesc {
    pub wgsl: String,
    pub vertex_entry: String,
    pub fragment_entry: String,
    pub bindings: Vec<MaterialBinding>,
}

#[derive(Clone, Debug)]
pub enum MaterialBinding {
    /// std140-ish bytes exactly as the WGSL struct lays out (caller packs).
    Uniform { binding: u32, data: Vec<u8>, visibility_vertex: bool },
    /// Texture id from `create_texture`; missing id binds 1x1 white.
    Texture { binding: u32, texture: u32 },
    Sampler { binding: u32 },
}

#[derive(Clone, Copy)]
struct Instance {
    mesh: u32,
    material: u32,
    transform: [f32; 16],
    /// Static casters are cached per shadow cascade (see `set_instance_static`).
    is_static: bool,
    /// false = never rendered into shadow maps (sky domes, huge backdrops).
    cast_shadow: bool,
}

pub struct RenderCore {
    opts: RenderOptions,
    pub camera: Camera,
    pipeline: wgpu::RenderPipeline,
    material_layout: wgpu::BindGroupLayout,
    frame_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    white: wgpu::TextureView,
    /// COLOR_0 vertex-colour slot (vertex slot 3, @location(8)): per-mesh buffers; meshes without one bind `white_colors` (grown on demand, all 1.0).
    mesh_colors: HashMap<u32, wgpu::Buffer>,
    white_colors: wgpu::Buffer,
    frame_buffer: wgpu::Buffer,
    frame_bind: wgpu::BindGroup,
    /// r6 probe-GI atlases + params (group 0 bindings 1..3); count 0 = off.
    gi: gi::GiProbes,
    meshes: HashMap<u32, GpuMesh>,
    textures: HashMap<u32, wgpu::TextureView>,
    materials: HashMap<u32, GpuMaterial>,
    instances: HashMap<u32, Instance>,
    /// Rebuilt when instances change: sorted (mesh, material) batches.
    instance_buffer: Option<wgpu::Buffer>,
    /// CPU copy of the sorted instance transforms (transparent sort).
    instance_transforms: Vec<[f32; 16]>,
    batches: Vec<(u32, u32, std::ops::Range<u32>)>,
    instances_dirty: bool,
    /// material id -> (lightmap texture id, overlay fac)
    material_lightmaps: HashMap<u32, (u32, f32)>,
    /// draw_indexed calls issued by the last `render` (one per mesh+material batch).
    pub last_draw_calls: u32,
    frame: FrameUniform,
    targets: Option<Targets>,
    upscaler: Box<dyn Upscaler>,
    timing: Option<Timing>,
    /// glTF BLEND: alpha-blended, depth-write off, drawn after opaque, sorted far→near.
    blend_pipeline: wgpu::RenderPipeline,
    /// (blend kind or None, depth write) → built-in pipeline variant (flags path).
    variant_pipelines: HashMap<(Option<BlendKind>, bool), wgpu::RenderPipeline>,
    material_flags: HashMap<u32, MaterialFlags>,
    blend_materials: std::collections::HashSet<u32>,
    /// Downsample blit (sRGB-correct: sRGB views decode/encode) for GPU mip generation.
    mipgen: BilinearBlit,
    shadow: shadow::ShadowSystem,
    shadow_receiver_layout: wgpu::BindGroupLayout,
    /// World-space shadow casters, rebuilt with the instance batches.
    casters: Vec<shadow::Caster>,
    /// Bumped on any change that invalidates cached static shadow maps.
    static_gen: u64,
    /// Last frame had a timed shadow span (timestamp slots 4,5).
    shadow_timed: bool,
    /// three.js TSL packages run as-is (three_material.rs).
    three: three_material::ThreeMaterials,
    /// value fed to TSL `time` (seconds); host-advanced via `set_three_time`.
    three_time: f32,
    /// GPU skinning (src/skin.rs): skinned meshes + joint palettes, one compute pass/frame.
    skin: skin::SkinSystem,
}

impl RenderCore {
    /// Features to request on the device for GPU timings (intersect with adapter).
    pub const OPTIONAL_FEATURES: wgpu::Features = wgpu::Features::TIMESTAMP_QUERY;

    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, opts: RenderOptions) -> Self {
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gaia-render frame"),
            entries: &[uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT), gi::layout_entries()[0], gi::layout_entries()[1], gi::layout_entries()[2]],
        });
        let gi_probes = gi::GiProbes::new(device);
        let material_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gaia-render material"),
            entries: &[
                uniform_entry(0, wgpu::ShaderStages::FRAGMENT),
                texture_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                texture_entry(3),
            ],
        });
        let shadow_receiver_layout = shadow::receiver_layout(device);
        let shadow = shadow::ShadowSystem::new(device, opts.shadows.clone(), &shadow_receiver_layout, &material_layout);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gaia-render forward"),
            source: wgpu::ShaderSource::Wgsl(FORWARD_WGSL.into()),
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gaia-render forward layout"),
            bind_group_layouts: &[Some(&frame_layout), Some(&material_layout), Some(&shadow_receiver_layout)],
            immediate_size: 0,
        });
        let pipeline = forward_pipeline(device, &pl, &module, "vs_main", "fs_main", false);
        let blend_pipeline = forward_pipeline(device, &pl, &module, "vs_main", "fs_main", true);
        let mut variant_pipelines = HashMap::new();
        for kind in [None, Some(BlendKind::Alpha), Some(BlendKind::Additive), Some(BlendKind::Subtractive)] {
            for dw in [false, true] {
                variant_pipelines.insert((kind, dw), forward_pipeline_variant(device, &pl, &module, "vs_main", "fs_main", kind, dw));
            }
        }
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("base color sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: opts.anisotropy.clamp(1, 16),
            ..Default::default()
        });
        let mipgen = BilinearBlit::new(device, wgpu::TextureFormat::Rgba8UnormSrgb);
        let white = upload_rgba8(device, queue, None, 1, 1, &[255; 4]);
        let mut frame: FrameUniform = bytemuck::Zeroable::zeroed();
        frame.ambient = [opts.ambient[0], opts.ambient[1], opts.ambient[2], opts.exposure];
        let ground = opts.ambient_ground.unwrap_or(opts.ambient);
        frame.ambient_ground = [ground[0], ground[1], ground[2], 0.0];
        frame.sun_dir = Vec3::from_array(opts.default_sun_direction)
            .normalize()
            .extend(0.0)
            .to_array();
        frame.sun_color = (Vec3::from_array(opts.default_sun_color) * opts.default_sun_intensity)
            .extend(1.0)
            .to_array();
        let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("frame uniform"),
            contents: bytemuck::bytes_of(&frame),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let frame_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame bind"),
            layout: &frame_layout,
            entries: &frame_entries(&frame_buffer, &gi_probes),
        });
        let timing = device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY)
            .then(|| Timing {
                set: device.create_query_set(&wgpu::QuerySetDescriptor {
                    label: Some("gaia-render timestamps"),
                    ty: wgpu::QueryType::Timestamp,
                    count: 6,
                }),
                resolve: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("timestamp resolve"),
                    size: 272, // slots 0..4 at 0, shadow slots 4..6 at 256 (resolve alignment)
                    usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                readback: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("timestamp readback"),
                    size: 48,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                period_ns: queue.get_timestamp_period(),
                pending: Default::default(),
            });
        Self {
            camera: Camera {
                world: Mat4::IDENTITY,
                yfov: opts.default_fov_y_degrees.to_radians(),
                znear: 0.1,
                zfar: None,
            },
            upscaler: Box::new(BilinearBlit::new(device, opts.output_format)),
            mipgen,
            shadow,
            shadow_receiver_layout,
            casters: Vec::new(),
            static_gen: 0,
            shadow_timed: false,
            skin: Default::default(),
            blend_pipeline,
            variant_pipelines,
            material_flags: HashMap::new(),
            blend_materials: Default::default(),
            opts,
            pipeline,
            material_layout,
            frame_layout,
            sampler,
            white,
            mesh_colors: HashMap::new(),
            white_colors: device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("white vertex colours"), contents: &[0u8; 16], usage: wgpu::BufferUsages::VERTEX }),
            frame_buffer,
            frame_bind,
            gi: gi_probes,
            meshes: HashMap::new(),
            material_lightmaps: HashMap::new(),
            instance_transforms: Vec::new(),
            textures: HashMap::new(),
            materials: HashMap::new(),
            instances: HashMap::new(),
            instance_buffer: None,
            batches: Vec::new(),
            instances_dirty: true,
            last_draw_calls: 0,
            frame,
            targets: None,
            timing,
            three: Default::default(),
            three_time: 0.0,
        }
    }

    // ---- meshes: flat typed arrays (positions xyz, normals xyz, uvs uv, u32 indices) ----
    pub fn create_mesh(
        &mut self,
        device: &wgpu::Device,
        id: u32,
        positions: &[f32],
        normals: &[f32],
        uvs: &[f32],
        indices: &[u32],
    ) -> Result<(), String> {
        let n = positions.len() / 3;
        if positions.len() % 3 != 0 || normals.len() != n * 3 || uvs.len() != n * 2 {
            return Err(format!(
                "mesh {id}: positions {} / normals {} / uvs {} disagree",
                positions.len(),
                normals.len(),
                uvs.len()
            ));
        }
        if let Some(bad) = indices.iter().find(|&&i| i as usize >= n) {
            return Err(format!("mesh {id}: index {bad} >= vertex count {n}"));
        }
        let verts: Vec<scene::Vertex> = (0..n)
            .map(|i| scene::Vertex {
                position: [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
                normal: [normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]],
                uv: [uvs[2 * i], uvs[2 * i + 1]],
            })
            .collect();
        self.create_mesh_interleaved(device, id, &verts, indices);
        Ok(())
    }

    pub fn create_mesh_interleaved(
        &mut self,
        device: &wgpu::Device,
        id: u32,
        vertices: &[scene::Vertex],
        indices: &[u32],
    ) {
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for v in vertices {
            lo = lo.min(Vec3::from_array(v.position));
            hi = hi.max(Vec3::from_array(v.position));
        }
        let mesh = GpuMesh {
            center: if vertices.is_empty() { [0.0; 3] } else { ((lo + hi) * 0.5).to_array() },
            lo: if vertices.is_empty() { [0.0; 3] } else { lo.to_array() },
            hi: if vertices.is_empty() { [0.0; 3] } else { hi.to_array() },
            vertices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh vertices"),
                contents: nonempty(bytemuck::cast_slice(vertices)),
                usage: wgpu::BufferUsages::VERTEX,
            }),
            indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh indices"),
                contents: nonempty(bytemuck::cast_slice(indices)),
                usage: wgpu::BufferUsages::INDEX,
            }),
            index_count: indices.len() as u32,
            uv1: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh uv1 (zero)"),
                contents: nonempty(&vec![0u8; vertices.len() * 8]),
                usage: wgpu::BufferUsages::VERTEX,
            }),
            vertex_count: vertices.len() as u32,
        };
        self.static_gen += 1;
        self.meshes.insert(id, mesh);
    }

    /// glTF alphaMode BLEND for a material: drawn in the sorted transparent pass.
    pub fn set_material_blend(&mut self, id: u32, blend: bool) {
        if blend {
            self.blend_materials.insert(id);
        } else {
            self.blend_materials.remove(&id);
        }
        self.instances_dirty = true;
        self.static_gen += 1;
    }

    /// Second UV set (TEXCOORD_1, lightmap UVs): flat u,v pairs, one per vertex.
    pub fn set_mesh_uv1(&mut self, device: &wgpu::Device, id: u32, uv1: &[f32]) -> Result<(), String> {
        let m = self.meshes.get_mut(&id).ok_or_else(|| format!("set_mesh_uv1: no mesh {id}"))?;
        if uv1.len() != m.vertex_count as usize * 2 {
            return Err(format!("mesh {id}: uv1 {} floats != 2 x {} vertices", uv1.len(), m.vertex_count));
        }
        m.uv1 = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("mesh uv1"),
            contents: nonempty(bytemuck::cast_slice(uv1)),
            usage: wgpu::BufferUsages::VERTEX,
        });
        Ok(())
    }

    /// COLOR_0 per vertex (rgba f32 x4, linear): multiplies base colour rgb AND alpha in the built-in shader (glTF semantics).
    /// Meshes never given one draw with 1.0. Same vertex count as the mesh; Err otherwise.
    pub fn set_mesh_colors(&mut self, device: &wgpu::Device, id: u32, rgba: &[f32]) -> Result<(), String> {
        let m = self.meshes.get(&id).ok_or_else(|| format!("set_mesh_colors: no mesh {id}"))?;
        if rgba.len() != m.vertex_count as usize * 4 {
            return Err(format!("mesh {id}: colours {} floats != 4 x {} vertices", rgba.len(), m.vertex_count));
        }
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("mesh colours"), contents: nonempty(bytemuck::cast_slice(rgba)), usage: wgpu::BufferUsages::VERTEX });
        self.mesh_colors.insert(id, buf);
        Ok(())
    }

    /// Baked lightmap for a built-in material: texture sampled at TEXCOORD_1, combined
    /// as Blender OVERLAY(albedo, lightmap, fac) before lighting (DS client rule,
    /// nari-world-companion ds-world/lightmap.mjs). Rebinds the material if it exists.
    pub fn set_material_lightmap(&mut self, device: &wgpu::Device, id: u32, texture: u32, fac: f32) {
        self.material_lightmaps.insert(id, (texture, fac));
        if let Some(desc) = self.materials.get(&id).and_then(|m| m.desc.clone()) {
            self.create_material(device, id, desc);
        }
    }

    /// Render flags for a built-in material (blend equation, unlit, depth write, order, shadow).
    /// Rebinds the material if it exists; blended kinds join the sorted transparent pass.
    pub fn set_material_flags(&mut self, device: &wgpu::Device, id: u32, flags: MaterialFlags) {
        self.material_flags.insert(id, flags);
        if flags.blend.is_some() {
            self.set_material_blend(id, true);
        }
        if let Some(desc) = self.materials.get(&id).and_then(|m| m.desc.clone()) {
            self.create_material(device, id, desc);
        }
        self.static_gen += 1;
    }

    /// `unlit` materials only: also apply exposure + Reinhard (three `toneMapped: true`). Call AFTER `set_material_flags` (which resets it).
    pub fn set_material_unlit_tone_mapped(&mut self, device: &wgpu::Device, id: u32, on: bool) {
        let mut f = self.material_flags.get(&id).copied().unwrap_or_default();
        if f.unlit_tone_mapped == on {
            return;
        }
        f.unlit_tone_mapped = on;
        self.material_flags.insert(id, f);
        if let Some(desc) = self.materials.get(&id).and_then(|m| m.desc.clone()) {
            self.create_material(device, id, desc);
        }
    }

    /// three `receiveShadow: false` for every user of this material. Call AFTER `set_material_flags` (which resets it). Works for built-in materials only (shader materials sample no sun shadow here).
    pub fn set_material_no_receive_shadow(&mut self, device: &wgpu::Device, id: u32, on: bool) {
        let mut f = self.material_flags.get(&id).copied().unwrap_or_default();
        if f.no_receive_shadow == on {
            return;
        }
        f.no_receive_shadow = on;
        self.material_flags.insert(id, f);
        if let Some(desc) = self.materials.get(&id).and_then(|m| m.desc.clone()) {
            self.create_material(device, id, desc);
        }
    }

    pub fn material_flags(&self, id: u32) -> MaterialFlags {
        self.material_flags.get(&id).copied().unwrap_or_default()
    }

    pub fn remove_mesh(&mut self, id: u32) {
        self.meshes.remove(&id);
        self.mesh_colors.remove(&id);
    }

    // ---- textures (RGBA8 sRGB) ----
    pub fn create_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        id: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), String> {
        if rgba.len() != (width * height * 4) as usize {
            return Err(format!("texture {id}: {} bytes != {width}x{height}x4", rgba.len()));
        }
        self.textures
            .insert(id, upload_rgba8(device, queue, Some(&self.mipgen), width, height, rgba));
        // materials referencing it must rebind
        let ids: Vec<u32> = self
            .materials
            .iter()
            .filter(|(k, m)| {
                m.desc.as_ref().is_some_and(|d| d.base_color_texture == Some(id))
                    || self.material_lightmaps.get(k).is_some_and(|l| l.0 == id)
            })
            .map(|(k, _)| *k)
            .collect();
        for mid in ids {
            if let Some(desc) = self.materials[&mid].desc.clone() {
                self.create_material(device, mid, desc);
            }
        }
        Ok(())
    }

    /// RGBA8 sampled as-is (no sRGB decode): three textures with colorSpace != srgb (r4, three_material::upload_linear).
    pub fn create_texture_linear(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, id: u32, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
        if rgba.len() != (width * height * 4) as usize { return Err(format!("texture {id}: {} bytes != {width}x{height}x4", rgba.len())); }
        self.textures.insert(id, three_material::upload_linear(device, queue, width, height, rgba));
        Ok(())
    }
    pub fn remove_texture(&mut self, id: u32) {
        self.textures.remove(&id);
    }

    // ---- materials (create == update) ----
    pub fn create_material(&mut self, device: &wgpu::Device, id: u32, desc: MaterialDesc) {
        let (view, has_tex) = match desc.base_color_texture.and_then(|t| self.textures.get(&t)) {
            Some(v) => (v, 1.0),
            None => (&self.white, 0.0),
        };
        // emissive.w > 0 = lightmap present (overlay fac); white + 0 otherwise.
        let (lm_view, lm_fac) = match self
            .material_lightmaps
            .get(&id)
            .and_then(|(t, f)| self.textures.get(t).map(|v| (v, *f)))
        {
            Some((v, f)) => (v, f.max(1e-6)),
            None => (&self.white, 0.0),
        };
        let u = MaterialUniform {
            base_color: desc.base_color,
            params: [
                desc.metallic,
                desc.roughness,
                desc.alpha_cutoff.unwrap_or(-1.0),
                has_tex,
            ],
            emissive: [desc.emissive[0], desc.emissive[1], desc.emissive[2], lm_fac],
            flags: [if self.material_flags.get(&id).is_some_and(|f| f.unlit) { 1.0 } else { 0.0 }, if desc.emissive_from_base && has_tex > 0.5 { 1.0 } else { 0.0 }, if self.material_flags.get(&id).is_some_and(|f| f.unlit && f.unlit_tone_mapped) { 1.0 } else { 0.0 }, if self.material_flags.get(&id).is_some_and(|f| f.no_receive_shadow) { 1.0 } else { 0.0 }],
        };
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("material uniform"),
            contents: bytemuck::bytes_of(&u),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("material bind"),
            layout: &self.material_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(lm_view),
                },
            ],
        });
        self.static_gen += 1;
        self.materials.insert(
            id,
            GpuMaterial {
                desc: Some(desc),
                bind,
                pipeline: None,
            },
        );
    }

    /// Primary material path: external WGSL + layout. Validated with naga BEFORE
    /// wgpu sees it (error = Err, never a device-lost panic). wgpu then lowers it
    /// (naga → MSL on Metal; WGSL passthrough on WebGPU).
    pub fn create_shader_material(
        &mut self,
        device: &wgpu::Device,
        id: u32,
        desc: &ShaderMaterialDesc,
    ) -> Result<(), String> {
        let module = naga::front::wgsl::parse_str(&desc.wgsl)
            .map_err(|e| format!("material {id} WGSL parse: {}", e.emit_to_string(&desc.wgsl)))?;
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .map_err(|e| format!("material {id} WGSL validate: {e:?}"))?;
        let entries: Vec<wgpu::BindGroupLayoutEntry> = desc
            .bindings
            .iter()
            .map(|b| match b {
                MaterialBinding::Uniform {
                    binding,
                    visibility_vertex,
                    ..
                } => uniform_entry(
                    *binding,
                    if *visibility_vertex {
                        wgpu::ShaderStages::VERTEX_FRAGMENT
                    } else {
                        wgpu::ShaderStages::FRAGMENT
                    },
                ),
                MaterialBinding::Texture { binding, .. } => texture_entry(*binding),
                MaterialBinding::Sampler { binding } => wgpu::BindGroupLayoutEntry {
                    binding: *binding,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            })
            .collect();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shader material layout"),
            entries: &entries,
        });
        let buffers: Vec<Option<wgpu::Buffer>> = desc
            .bindings
            .iter()
            .map(|b| match b {
                MaterialBinding::Uniform { data, .. } => {
                    Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("shader material uniform"),
                        contents: nonempty(data),
                        usage: wgpu::BufferUsages::UNIFORM,
                    }))
                }
                _ => None,
            })
            .collect();
        let bind_entries: Vec<wgpu::BindGroupEntry> = desc
            .bindings
            .iter()
            .zip(&buffers)
            .map(|(b, buf)| match b {
                MaterialBinding::Uniform { binding, .. } => wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: buf.as_ref().expect("uniform buffer").as_entire_binding(),
                },
                MaterialBinding::Texture { binding, texture } => wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: wgpu::BindingResource::TextureView(
                        self.textures.get(texture).unwrap_or(&self.white),
                    ),
                },
                MaterialBinding::Sampler { binding } => wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            })
            .collect();
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shader material bind"),
            layout: &layout,
            entries: &bind_entries,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("external material"),
            source: wgpu::ShaderSource::Wgsl(desc.wgsl.clone().into()),
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("external material pipeline layout"),
            // group(2) = shadow receiver (optional for external WGSL: declare it to sample the sun CSM)
            bind_group_layouts: &[Some(&self.frame_layout), Some(&layout), Some(&self.shadow_receiver_layout)],
            immediate_size: 0,
        });
        let pipeline = forward_pipeline(
            device,
            &pl,
            &shader,
            &desc.vertex_entry,
            &desc.fragment_entry,
            false,
        );
        self.materials.insert(
            id,
            GpuMaterial {
                desc: None,
                bind,
                pipeline: Some(pipeline),
            },
        );
        Ok(())
    }

    /// three.js TSL material package (tsl-export.js JSON) run as-is: separate vertex + fragment WGSL,
    /// naga-reflected bindings, three's camera/object uniforms filled from gaia frame data,
    /// attributes by name. `textures`: binding var name (e.g. `nodeUniform4`) -> texture id.
    pub fn create_three_material(
        &mut self,
        device: &wgpu::Device,
        id: u32,
        package_json: &str,
        textures: HashMap<String, u32>,
    ) -> Result<(), String> {
        let m = three_material::build(device, package_json, textures, INTERNAL_FORMAT, DEPTH_FORMAT)?;
        self.materials.remove(&id);
        self.three.remove(id);
        self.three.mats.insert(id, m);
        Ok(())
    }
    /// Live three uniform values (tsl-export `pkg.live.update()` → `[{key,value}]`, changed only) → material's reflected
    /// uniform members; packed into every instance buffer at the next render (r4, three_material.rs).
    pub fn set_three_uniforms(&mut self, material: u32, json: &str) -> Result<usize, String> {
        self.three.mats.get_mut(&material).ok_or_else(|| format!("set_three_uniforms: {material} is not a three material"))?.set_uniforms(json)
    }
    pub fn set_three_time(&mut self, seconds: f32) {
        self.three_time = seconds;
    }
    pub fn remove_material(&mut self, id: u32) {
        self.three.remove(id);
        self.materials.remove(&id);
    }

    // ---- instances: column-major 4x4 world transform ----
    pub fn create_instance(&mut self, id: u32, mesh: u32, material: u32, transform: [f32; 16]) {
        self.instances.insert(
            id,
            Instance {
                mesh,
                material,
                transform,
                is_static: false,
                cast_shadow: true,
            },
        );
        self.instances_dirty = true;
    }

    /// Mark an instance as a STATIC shadow caster (cached per cascade, re-rendered only
    /// when the sun/cascade bounds move or a static instance changes) or DYNAMIC (default:
    /// redrawn every frame). Moving a static instance invalidates the static cache.
    pub fn set_instance_static(&mut self, id: u32, is_static: bool) {
        if let Some(inst) = self.instances.get_mut(&id) {
            inst.is_static = is_static;
            self.instances_dirty = true;
            self.static_gen += 1;
        }
    }

    /// Per-instance shadow-caster opt-out (default true). Sky domes / backdrops must be
    /// false: they would otherwise shadow the whole scene and blow up the cascade depth range.
    pub fn set_instance_cast_shadow(&mut self, id: u32, cast: bool) {
        if let Some(inst) = self.instances.get_mut(&id) {
            inst.cast_shadow = cast;
            self.instances_dirty = true;
            self.static_gen += 1;
        }
    }

    pub fn shadow_stats(&self) -> &ShadowStats {
        &self.shadow.stats
    }

    pub fn shadow_options(&self) -> &ShadowOptions {
        &self.shadow.opts
    }

    /// Rebuild the shadow system with new options (drops the cache; reallocates maps).
    pub fn set_shadow_options(&mut self, device: &wgpu::Device, opts: ShadowOptions) {
        self.opts.shadows = opts.clone();
        self.shadow = shadow::ShadowSystem::new(device, opts, &self.shadow_receiver_layout, &self.material_layout);
    }

    pub fn update_instance(&mut self, id: u32, transform: [f32; 16]) {
        if let Some(inst) = self.instances.get_mut(&id) {
            inst.transform = transform;
            self.instances_dirty = true;
            if inst.is_static {
                self.static_gen += 1;
            }
        }
    }

    pub fn remove_instance(&mut self, id: u32) {
        if self.instances.remove(&id).is_some_and(|i| i.is_static) {
            self.static_gen += 1;
        }
        self.instances_dirty = true;
    }

    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    // ---- camera + lights ----
    /// `world` = camera-to-world (column-major); looks down local -Z. zfar None = infinite.
    pub fn set_camera(&mut self, world: [f32; 16], yfov: f32, znear: f32, zfar: Option<f32>) {
        self.camera = Camera {
            world: Mat4::from_cols_array(&world),
            yfov,
            znear,
            zfar,
        };
    }

    /// direction = where light travels; color pre-multiplied by intensity by the caller? No:
    /// color * intensity * light_intensity_scale is applied here.
    pub fn set_sun(&mut self, direction: [f32; 3], color: [f32; 3], intensity: f32) {
        let s = self.opts.light_intensity_scale;
        self.frame.sun_dir = Vec3::from_array(direction)
            .normalize_or_zero()
            .extend(0.0)
            .to_array();
        self.frame.sun_color = (Vec3::from_array(color) * intensity * s).extend(1.0).to_array();
    }

    /// Hemisphere ambient: irradiance = lerp(ground, sky, 0.5 n.y + 0.5), times albedo. Linear colours, shader units.
    pub fn set_hemisphere_ambient(&mut self, sky: [f32; 3], ground: [f32; 3]) {
        let e = self.frame.ambient[3];
        self.frame.ambient = [sky[0], sky[1], sky[2], e];
        self.frame.ambient_ground = [ground[0], ground[1], ground[2], 0.0];
    }

    /// Hemisphere + ambient light in THREE r180 units: `sky`/`ground` = irradiance E (light colour x intensity, linear; an AmbientLight
    /// is folded in by the caller: sky += a, ground += a). three: HemisphereLightNode.setup mixes E by 0.5*n.y+0.5 into context.irradiance,
    /// PhysicalLightingModel.indirect (:665) adds `E * BRDF_Lambert(diffuseColor)` = E * albedo / PI. forward.wgsl stores that /PI here.
    pub fn set_hemisphere_irradiance(&mut self, sky: [f32; 3], ground: [f32; 3]) {
        let k = std::f32::consts::FRAC_1_PI;
        self.set_hemisphere_ambient([sky[0] * k, sky[1] * k, sky[2] * k], [ground[0] * k, ground[1] * k, ground[2] * k]);
    }

    /// r6 probe GI: hand over the host-side readback of the three GI atlases (see gi.rs for layout). Re-binds only when texture sizes change.
    pub fn set_gi_probes(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, irradiance: &[f32], depth: &[f32], params: &[f32]) -> Result<(), String> {
        if self.gi.upload(device, queue, irradiance, depth, params)? {
            self.frame_bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("frame bind"), layout: &self.frame_layout, entries: &frame_entries(&self.frame_buffer, &self.gi) });
        }
        Ok(())
    }
    /// GI off (cascade count 0): shader falls back to the plain hemisphere term.
    pub fn clear_gi_probes(&mut self, queue: &wgpu::Queue) {
        self.gi.clear(queue);
    }

    /// three `scene.background` Color. MEASURED (r6 S4, r180 WebGPURenderer + ReinhardToneMapping): three TONE-MAPS the background colour like any
    /// fragment, so the clear value = Reinhard(c * exposure) (same operator as forward.wgsl); the *Srgb target then encodes it.
    pub fn set_background_color(&mut self, rgb: [f32; 3]) {
    let e = self.frame.ambient[3];
    let t = |c: f32| { let x = c * e; (x / (1.0 + x)) as f64 };
    self.opts.clear_color = [t(rgb[0]), t(rgb[1]), t(rgb[2]), 1.0];
    }
    
    /// Raw frame clear colour (linear, NOT tone-mapped; the *Srgb target encodes it). Prefer `set_background_color` for three parity.
    pub fn set_clear_color(&mut self, rgba: [f64; 4]) {
        self.opts.clear_color = rgba;
    }

    /// Packed 8 floats/light: x y z range r g b intensity. Extra lights beyond
    /// MAX_POINT_LIGHTS are dropped and the count returned is what is drawn.
    pub fn set_point_lights(&mut self, packed: &[f32]) -> usize {
        let s = self.opts.light_intensity_scale;
        let n = (packed.len() / 8).min(MAX_POINT_LIGHTS);
        for i in 0..n {
            let l = &packed[i * 8..i * 8 + 8];
            self.frame.points[i] = GpuPointLight {
                position_range: [l[0], l[1], l[2], l[3]],
                color: [l[4] * l[7] * s, l[5] * l[7] * s, l[6] * l[7] * s, 1.0],
            };
        }
        self.frame.counts[0] = n as u32;
        n
    }

    pub fn set_upscaler(&mut self, upscaler: Box<dyn Upscaler>) {
        self.upscaler = upscaler;
        self.targets = None; // force resize notification
    }

    /// resize(renderHeight): internal height; width follows output aspect.
    pub fn set_render_height(&mut self, height: u32) {
        self.opts.render_height = height.max(1);
        self.targets = None;
    }

    pub fn internal_size(&self) -> Option<UpscaleSize> {
        self.targets.as_ref().map(|t| t.internal)
    }

    fn rebuild_instances(&mut self, device: &wgpu::Device) {
        let mut list: Vec<&Instance> = self.instances.values().collect();
        list.sort_by_key(|i| (i.mesh, i.material));
        let mut data: Vec<[f32; 16]> = Vec::with_capacity(list.len());
        self.batches.clear();
        for (n, inst) in list.iter().enumerate() {
            data.push(inst.transform);
            let n = n as u32;
            match self.batches.last_mut() {
                Some((m, mat, r)) if *m == inst.mesh && *mat == inst.material => r.end = n + 1,
                _ => self.batches.push((inst.mesh, inst.material, n..n + 1)),
            }
        }
        self.instance_transforms = data.clone();
        // world-space AABBs for shadow caster culling (same order as `data`)
        let casters: Vec<shadow::Caster> = list
            .iter()
            .filter(|inst| inst.cast_shadow)
            .map(|inst| {
                let (lo, hi) = self
                    .meshes
                    .get(&inst.mesh)
                    .map(|m| (Vec3::from_array(m.lo), Vec3::from_array(m.hi)))
                    .unwrap_or((Vec3::ZERO, Vec3::ZERO));
                let t = Mat4::from_cols_array(&inst.transform);
                let (mut wlo, mut whi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
                for i in 0..8 {
                    let c = Vec3::new(
                        if i & 1 == 0 { lo.x } else { hi.x },
                        if i & 2 == 0 { lo.y } else { hi.y },
                        if i & 4 == 0 { lo.z } else { hi.z },
                    );
                    let w = t.transform_point3(c);
                    wlo = wlo.min(w);
                    whi = whi.max(w);
                }
                shadow::Caster {
                    mesh: inst.mesh,
                    material: inst.material,
                    transform: inst.transform,
                    is_static: inst.is_static,
                    lo: wlo,
                    hi: whi,
                }
            })
            .collect();
        self.casters = casters;
        self.instance_buffer = Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("instance transforms"),
            contents: nonempty(bytemuck::cast_slice(&data)),
            usage: wgpu::BufferUsages::VERTEX,
        }));
        self.instances_dirty = false;
    }

    fn ensure_targets(&mut self, device: &wgpu::Device, output: UpscaleSize) {
        if self.targets.as_ref().is_some_and(|t| t.output == output) {
            return;
        }
        let h = self.opts.render_height.max(1);
        let w = ((h as f64) * output.width as f64 / output.height.max(1) as f64)
            .round()
            .max(1.0) as u32;
        let internal = UpscaleSize { width: w, height: h };
        let size = wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        };
        let color = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("internal color"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: INTERNAL_STORAGE_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[INTERNAL_FORMAT],
        });
        let depth = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("internal depth"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        self.upscaler.resize(device, internal, output);
        self.targets = Some(Targets {
            color_view: color.create_view(&wgpu::TextureViewDescriptor {
                format: Some(INTERNAL_FORMAT),
                ..Default::default()
            }),
            depth_view: depth.create_view(&Default::default()),
            color,
            depth,
            internal,
            output,
        });
    }

    fn encode_forward(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        output_size: UpscaleSize,
    ) {
        self.ensure_targets(device, output_size);
        self.encode_skinning(device, queue, encoder);
        // white COLOR_0 fallback must cover the largest vertex buffer in use (skinned meshes share one big dst buffer)
        let need = self.meshes.values().map(|m| m.vertices.size() / std::mem::size_of::<scene::Vertex>() as u64).max().unwrap_or(1).max(1) * 16;
        if self.white_colors.size() < need {
            let ones: Vec<f32> = vec![1.0; (need / 4) as usize];
            self.white_colors = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("white vertex colours"), contents: bytemuck::cast_slice(&ones), usage: wgpu::BufferUsages::VERTEX });
        }
        if self.instances_dirty {
            self.rebuild_instances(device);
        }
        self.refresh_skinned_casters();
        let t = self.targets.as_ref().expect("targets");
        let aspect = t.internal.width as f32 / t.internal.height as f32;
        self.frame.view_proj = self.camera.view_proj(aspect).to_cols_array_2d();
        let eye = self.camera.world.transform_point3(Vec3::ZERO);
        self.frame.camera_pos = eye.extend(1.0).to_array();
        queue.write_buffer(&self.frame_buffer, 0, bytemuck::bytes_of(&self.frame));
        // sun shadow cascades first (own passes, before the forward pass samples them)
        self.shadow_timed = self.shadow.encode(
            device,
            queue,
            encoder,
            self.camera.world,
            self.camera.yfov,
            aspect,
            self.camera.znear,
            self.camera.zfar,
            Vec3::new(self.frame.sun_dir[0], self.frame.sun_dir[1], self.frame.sun_dir[2]),
            &self.casters,
            self.static_gen,
            &self.meshes,
            &self.materials,
            &self.blend_materials,
            self.timing.as_ref().map(|tm| (&tm.set, 4, 5)),
        );
        let three_list: Vec<(u32, u32, [f32; 16])> = if self.three.mats.is_empty() {
            Vec::new()
        } else {
            let mut v: Vec<_> = self.instances.iter().filter(|(_, i)| self.three.is_three(i.material)).map(|(k, i)| (*k, i.material, i.transform)).collect();
            v.sort_by_key(|x| x.0);
            v
        };
        if !three_list.is_empty() {
            let far = self.camera.zfar.unwrap_or(f32::INFINITY);
            let proj = match self.camera.zfar {
                Some(f) => Mat4::perspective_rh(self.camera.yfov, aspect, self.camera.znear, f),
                None => Mat4::perspective_infinite_rh(self.camera.yfov, aspect, self.camera.znear),
            };
            let frame = ThreeFrame { view: self.camera.world.inverse(), proj, camera_world: self.camera.world, near: self.camera.znear, far, time: self.three_time };
            self.three.prepare(device, queue, &three_list, &frame, &self.textures, &self.white, &self.sampler);
        }
        let t = self.targets.as_ref().expect("targets");
        let c = self.opts.clear_color;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("gaia-render forward"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &t.color_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: c[0],
                            g: c[1],
                            b: c[2],
                            a: c[3],
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &t.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: self.timing.as_ref().map(|tm| wgpu::RenderPassTimestampWrites {
                    query_set: &tm.set,
                    beginning_of_pass_write_index: Some(0),
                    end_of_pass_write_index: Some(1),
                }),
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.frame_bind, &[]);
            pass.set_bind_group(2, self.shadow.receiver_bind(), &[]);
            let mut draws = 0u32;
            if let Some(ib) = &self.instance_buffer {
                pass.set_vertex_buffer(1, ib.slice(..));
                // opaque + MASK (alpha test in shader) first; BLEND batches after, far→near.
                let eye3 = eye;
                let mut order: Vec<usize> = (0..self.batches.len())
                    .filter(|&b| !self.blend_materials.contains(&self.batches[b].1))
                    .collect();
                let mut blended: Vec<(f32, usize)> = (0..self.batches.len())
                    .filter(|&b| self.blend_materials.contains(&self.batches[b].1))
                    .map(|b| {
                        let (mesh, _, range) = &self.batches[b];
                        let c = self.meshes.get(mesh).map(|m| Vec3::from_array(m.center)).unwrap_or(Vec3::ZERO);
                        let t = Mat4::from_cols_array(&self.instance_transforms[range.start as usize]);
                        (t.transform_point3(c).distance_squared(eye3), b)
                    })
                    .collect();
                blended.sort_by(|a, b| b.0.total_cmp(&a.0));
                let opaque_count = order.len();
                order.extend(blended.into_iter().map(|(_, b)| b));
                // render_order groups (stable: keeps opaque-before-blend + far→near inside a group)
                let mut order: Vec<(usize, usize)> = order.into_iter().enumerate().map(|(k, b)| (k, b)).collect();
                let ro = |b: usize| self.material_flags.get(&self.batches[b].1).map_or(0, |f| f.render_order);
                order.sort_by_key(|&(_, b)| ro(b));
                for &(k, b) in order.iter() {
                    let (mesh, material, range) = &self.batches[b];
                    let (Some(m), Some(mat)) = (self.meshes.get(mesh), self.materials.get(material)) else {
                        continue; // dangling ids: counted by caller via instance_count vs drawn
                    };
                    let builtin = match self.material_flags.get(material) {
                        Some(f) if f.blend.is_some() || f.depth_write.is_some() => {
                            let kind = if k >= opaque_count { Some(f.blend.unwrap_or(BlendKind::Alpha)) } else { None };
                            &self.variant_pipelines[&(kind, f.depth_write.unwrap_or(kind.is_none()))]
                        }
                        _ => if k >= opaque_count { &self.blend_pipeline } else { &self.pipeline },
                    };
                    pass.set_pipeline(mat.pipeline.as_ref().unwrap_or(builtin));
                    pass.set_bind_group(1, &mat.bind, &[]);
                    pass.set_vertex_buffer(0, m.vertices.slice(..));
                pass.set_vertex_buffer(2, m.uv1.slice(..));
                pass.set_vertex_buffer(3, self.mesh_colors.get(&mesh).unwrap_or(&self.white_colors).slice(..));
                    pass.set_index_buffer(m.indices.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..m.index_count, 0, range.clone());
                    draws += 1;
                }
            }
            if !three_list.is_empty() {
                let inst_mesh: HashMap<u32, u32> = three_list.iter().filter_map(|(k, _, _)| self.instances.get(k).map(|i| (*k, i.mesh))).collect();
                let meshes = &self.meshes;
                let mesh_of = |m: u32| meshes.get(&m).map(|g| (g.vertices.slice(..), g.indices.slice(..), g.index_count));
                draws += self.three.draw(&mut pass, &three_list, &mesh_of, &inst_mesh);
            }
            self.last_draw_calls = draws;
        }
    }

    /// Encode one frame into `output` (sized `output_size`). Caller submits.
    /// `Encoder`-mode upscalers only (panics loudly for `Queue` mode → use `render_frame`).
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        output: &wgpu::TextureView,
        output_size: UpscaleSize,
    ) {
        self.encode_forward(device, queue, encoder, output_size);
        let t = self.targets.as_ref().expect("targets");
        self.upscaler.encode(
            device,
            encoder,
            UpscaleInput {
                color: &t.color,
                color_view: &t.color_view,
                depth: &t.depth,
                size: t.internal,
            },
            output,
            self.timing.as_ref().map(|tm| wgpu::RenderPassTimestampWrites {
                query_set: &tm.set,
                beginning_of_pass_write_index: Some(2),
                end_of_pass_write_index: Some(3),
            }),
        );
        if let Some(tm) = &self.timing {
            encoder.resolve_query_set(&tm.set, 0..4, &tm.resolve, 0);
            if self.shadow_timed {
                encoder.resolve_query_set(&tm.set, 4..6, &tm.resolve, 256);
            }
        }
    }

    /// Render + upscale one frame into `output` texture and SUBMIT it. Works with both
    /// upscaler modes (the only way to drive `Queue` mode, e.g. MetalFX). Anything
    /// the caller encodes afterwards (copy to surface, readback) runs after the upscale
    /// (same-queue order).
    pub fn render_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        output: &wgpu::Texture,
        output_size: UpscaleSize,
    ) -> Result<(), UpscaleError> {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gaia-render frame"),
        });
        match self.upscaler.submit_mode() {
            UpscaleSubmit::Encoder => {
                // View in `output_format` (output may be UNORM storage w/ an sRGB view format).
                let view = output.create_view(&wgpu::TextureViewDescriptor {
                    format: Some(self.opts.output_format),
                    ..Default::default()
                });
                self.render(device, queue, &mut encoder, &view, output_size);
                queue.submit(Some(encoder.finish()));
            }
            UpscaleSubmit::Queue => {
                self.encode_forward(device, queue, &mut encoder, output_size);
                if let Some(tm) = &self.timing {
                    encoder.resolve_query_set(&tm.set, 0..2, &tm.resolve, 0);
                    if self.shadow_timed {
                        encoder.resolve_query_set(&tm.set, 4..6, &tm.resolve, 256);
                    }
                }
                queue.submit(Some(encoder.finish()));
                let t = self.targets.as_ref().expect("targets");
                self.upscaler.upscale(
                    device,
                    queue,
                    UpscaleInput {
                        color: &t.color,
                        color_view: &t.color_view,
                        depth: &t.depth,
                        size: t.internal,
                    },
                    output,
                )?;
            }
        }
        Ok(())
    }

    pub fn upscaler_name(&self) -> &str {
        self.upscaler.name()
    }

    /// Encode a copy of this frame's timestamps; call after `render`, before submit.
    pub fn encode_timing_readback(&self, encoder: &mut wgpu::CommandEncoder) -> bool {
        match &self.timing {
            // async readback still mapped → copying into it would be a validation error; skip this frame's sample.
            Some(tm) if tm.pending.load(std::sync::atomic::Ordering::Acquire) => false,
            Some(tm) => {
                encoder.copy_buffer_to_buffer(&tm.resolve, 0, &tm.readback, 0, 32);
                if self.shadow_timed {
                    encoder.copy_buffer_to_buffer(&tm.resolve, 256, &tm.readback, 32, 16);
                }
                true
            }
            None => false,
        }
    }

    /// Blocking read of the last `encode_timing_readback` (native measurement only).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_timings_blocking(&self, device: &wgpu::Device) -> Option<GpuTimings> {
        let tm = self.timing.as_ref()?;
        let slice = tm.readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r.is_ok());
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        if !rx.recv().ok()? {
            return None;
        }
        let ts: [u64; 6] = {
            let data = slice.get_mapped_range().ok()?;
            *bytemuck::from_bytes(&data[..48])
        };
        tm.readback.unmap();
        let ms = |a: u64, b: u64| b.saturating_sub(a) as f64 * tm.period_ns as f64 / 1e6;
        let shadow_ms = if self.shadow_timed { ms(ts[4], ts[5]) } else { 0.0 };
        if self.upscaler.submit_mode() == UpscaleSubmit::Queue {
            // Upscale ran in the scaler's own command buffer: its GPU time comes from
            // the backend; total = scene + upscale (sum, not one clock span).
            let scene_ms = ms(ts[0], ts[1]);
            let upscale_ms = self.upscaler.last_gpu_ms_blocking().unwrap_or(f64::NAN);
            return Some(GpuTimings { scene_ms, upscale_ms, total_ms: scene_ms + upscale_ms + shadow_ms, shadow_ms, span_ms: f64::NAN });
        }
        Some(GpuTimings {
            scene_ms: ms(ts[0], ts[1]),
            upscale_ms: ms(ts[2], ts[3]),
            total_ms: ms(if self.shadow_timed { ts[4] } else { ts[0] }, ts[3]),
            shadow_ms,
            span_ms: {
                let b = if self.shadow_timed { ts[0].min(ts[2]).min(ts[4]) } else { ts[0].min(ts[2]) };
                let e = if self.shadow_timed { ts[1].max(ts[3]).max(ts[5]) } else { ts[1].max(ts[3]) };
                e.saturating_sub(b) as f64 * tm.period_ns as f64 / 1e6
            },
        })
    }
}

fn nonempty(bytes: &[u8]) -> &[u8] {
    if bytes.is_empty() { &[0u8; 16] } else { bytes }
}

fn upload_rgba8(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    mipgen: Option<&BilinearBlit>,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> wgpu::TextureView {
    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    // Full chain, generated on the GPU right after upload (None = single level).
    let levels = match mipgen {
        Some(_) => 32 - width.max(height).max(1).leading_zeros(),
        None => 1,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("base color"),
        size,
        mip_level_count: levels,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | if levels > 1 { wgpu::TextureUsages::RENDER_ATTACHMENT } else { wgpu::TextureUsages::empty() },
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4 * width),
            rows_per_image: Some(height),
        },
        size,
    );
    if let Some(blit) = mipgen.filter(|_| levels > 1) {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("mipgen") });
        let level_view = |l: u32| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                base_mip_level: l,
                mip_level_count: Some(1),
                ..Default::default()
            })
        };
        for l in 1..levels {
            let src = level_view(l - 1);
            let dst = level_view(l);
            blit.encode_view(device, &mut encoder, &src, &dst);
        }
        queue.submit(Some(encoder.finish()));
    }
    texture.create_view(&Default::default())
}

fn frame_entries<'a>(frame_buffer: &'a wgpu::Buffer, g: &'a gi::GiProbes) -> [wgpu::BindGroupEntry<'a>; 4] {
    [
        wgpu::BindGroupEntry { binding: 0, resource: frame_buffer.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: g.uniform.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&g.irr_view) },
        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&g.depth_view) },
    ]
}

fn uniform_entry(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// glTF import path = a CLIENT of the data-only API (exactly what the JS adapter
/// does): one mesh + one identity instance per primitive (transforms are baked),
/// textures/materials by glTF index, camera + lights from the file or fitted.
pub fn load_scene_into(
    core: &mut RenderCore,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &SceneData,
) -> Result<(), String> {
    for (i, img) in scene.images.iter().enumerate() {
        core.create_texture(device, queue, i as u32, img.width, img.height, &img.pixels)?;
    }
    for (i, m) in scene.materials.iter().enumerate() {
        core.create_material(
            device,
            i as u32,
            MaterialDesc {
                base_color: m.base_color_factor,
                metallic: m.metallic,
                roughness: m.roughness,
                base_color_texture: m.base_color_texture.map(|t| t as u32),
                alpha_cutoff: match m.alpha {
                    scene::AlphaMode::Mask(c) => Some(c),
                    _ => None,
                },
                emissive: m.emissive,
                emissive_from_base: false,
            },
        );
        if matches!(m.alpha, scene::AlphaMode::Blend) {
            core.set_material_blend(i as u32, true);
        }
        if let Some(lm) = m.lightmap {
            core.set_material_lightmap(device, i as u32, lm.image as u32, lm.fac);
        }
        if m.flags != MaterialFlags::default() {
            core.set_material_flags(device, i as u32, m.flags);
        }
    }
    let identity = Mat4::IDENTITY.to_cols_array();
    for (i, d) in scene.draws.iter().enumerate() {
        let v = &scene.vertices[d.first_vertex as usize..(d.first_vertex + d.vertex_count) as usize];
        let idx: Vec<u32> = scene.indices
            [d.first_index as usize..(d.first_index + d.index_count) as usize]
            .iter()
            .map(|&x| x - d.first_vertex)
            .collect();
        core.create_mesh_interleaved(device, i as u32, v, &idx);
        if let Some(uv1) = scene.uv1.get(d.first_vertex as usize..(d.first_vertex + d.vertex_count) as usize) {
            core.set_mesh_uv1(device, i as u32, bytemuck::cast_slice(uv1))?;
        }
        if let Some(c) = scene.colors.get(d.first_vertex as usize..(d.first_vertex + d.vertex_count) as usize) {
            if c.iter().any(|x| *x != [1.0; 4]) {
                core.set_mesh_colors(device, i as u32, bytemuck::cast_slice(c))?;
            }
        }
        core.create_instance(i as u32, i as u32, d.material as u32, identity);
        core.set_instance_static(i as u32, true); // glb nodes are baked: never move
        let diag = v.iter().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(lo, hi), x| {
            (lo.min(Vec3::from_array(x.position)), hi.max(Vec3::from_array(x.position)))
        });
        let max_diag = core.opts.shadows.import_max_caster_diagonal;
        if scene.materials.get(d.material).and_then(|m| m.flags.cast_shadow) == Some(false) {
            core.set_instance_cast_shadow(i as u32, false);
        }
        if max_diag > 0.0 && !v.is_empty() && (diag.1 - diag.0).length() > max_diag {
            core.set_instance_cast_shadow(i as u32, false);
        }
    }
    let cam = Camera::from_scene(scene, &core.opts);
    core.camera = cam;
    if let Some(sun) = scene.sun {
        core.set_sun(sun.direction.to_array(), sun.color.to_array(), sun.intensity);
    }
    let packed: Vec<f32> = scene
        .points
        .iter()
        .flat_map(|p| {
            [
                p.position.x, p.position.y, p.position.z, p.range, p.color.x, p.color.y,
                p.color.z, p.intensity,
            ]
        })
        .collect();
    core.set_point_lights(&packed);
    if let Some(h) = scene.ambient {
        core.set_hemisphere_ambient(h.sky.to_array(), h.ground.to_array());
    }
    if let Some(sk) = &scene.skins {
        sk.load_into(core)?;
    }
    Ok(())
}

/// Shared pipeline shape for built-in PBR AND external (TSL-generated) WGSL materials.
fn forward_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    module: &wgpu::ShaderModule,
    vs: &str,
    fs: &str,
    blend: bool,
) -> wgpu::RenderPipeline {
    forward_pipeline_variant(device, layout, module, vs, fs, blend.then_some(BlendKind::Alpha), !blend)
}

fn forward_pipeline_variant(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    module: &wgpu::ShaderModule,
    vs: &str,
    fs: &str,
    blend: Option<BlendKind>,
    depth_write: bool,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("gaia-render forward PBR"),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some(vs),
                buffers: &[
                    Some(wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<scene::Vertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2],
                    }),
                    Some(wgpu::VertexBufferLayout {
                        array_stride: 64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &wgpu::vertex_attr_array![3 => Float32x4, 4 => Float32x4, 5 => Float32x4, 6 => Float32x4],
                    }),
                    // slot 2 = TEXCOORD_1 (lightmap UV); external WGSL may ignore @location(7).
                    Some(wgpu::VertexBufferLayout {
                        array_stride: 8,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![7 => Float32x2],
                    }),
                    // slot 3 = COLOR_0 (rgba); external WGSL may ignore @location(8).
                    Some(wgpu::VertexBufferLayout {
                        array_stride: 16,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![8 => Float32x4],
                    }),
                ],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fs),
                targets: &[Some(wgpu::ColorTargetState {
                    format: INTERNAL_FORMAT,
                    blend: blend.map(|k| match k {
                    BlendKind::Alpha => wgpu::BlendState::ALPHA_BLENDING,
                    BlendKind::Additive => wgpu::BlendState {
                        color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
                        alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
                    },
                    BlendKind::Subtractive => wgpu::BlendState {
                        color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::ReverseSubtract },
                        alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
                    },
                }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            // cull off: glTF double-sided handled by one pipeline (shader flips back-face normal).
            primitive: wgpu::PrimitiveState {
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                // transparent pass tests depth but does not write it (sorted back-to-front)
                depth_write_enabled: Some(depth_write),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        })
}
