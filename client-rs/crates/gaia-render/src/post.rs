//! r10 post: three r180 PostProcessing parity in the core. Active only when `RenderOptions.hdr_scene` (scene pass renders LINEAR HDR into Rgba16Float,
//! forward.wgsl/background.wgsl skip exposure+tone map). Chain (three order): HDR scene -> BloomNode (high pass -> 5-mip separable gaussian, half-res chain)
//! -> scene + bloom -> exposure + tone map (three constants) -> internal sRGB view -> upscaler. All values come from the host (adapter reads three's
//! renderer.toneMapping / toneMappingExposure / the game's BloomNode uniforms); nothing here is game specific.
use wgpu::util::DeviceExt;
pub const BLOOM_MIPS: usize = 5;
/// BloomNode `kernelSizeArray` (three r180, PR 31528 coefficients).
pub const BLOOM_KERNELS: [f32; BLOOM_MIPS] = [6.0, 10.0, 14.0, 18.0, 22.0];
pub const BLOOM_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const POST_WGSL: &str = include_str!("post.wgsl");
const GTAO_WGSL: &str = include_str!("gtao.wgsl");
pub const GTAO_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm; // three RenderTarget default (UnsignedByte RGBA)
/// r12: three `GTAONode` uniforms (radius/thickness/samples/distanceExponent/distanceFallOff/scale + resolutionScale) + the engine rig composite (lighting/post.js: intensity + distance fade in metres).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GtaoParams {
pub radius: f32,
pub thickness: f32,
pub samples: f32,
pub distance_exponent: f32,
pub distance_fall_off: f32,
pub scale: f32,
pub resolution_scale: f32,
pub intensity: f32,
pub fade_start: f32,
pub fade_end: f32,
}
impl GtaoParams {
/// GTAONode ctor defaults (radius .25, thickness 1, samples 16, exponent/falloff/scale 1, resolutionScale 1) + rig composite with fade effectively off (intensity 1).
pub fn three_defaults() -> Self {
Self { radius: 0.25, thickness: 1.0, samples: 16.0, distance_exponent: 1.0, distance_fall_off: 1.0, scale: 1.0, resolution_scale: 1.0, intensity: 1.0, fade_start: 1.0e9, fade_end: 2.0e9 }
}
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct AoUniform {
proj: [[f32; 4]; 4],
proj_inv: [[f32; 4]; 4],
p0: [f32; 4],
p1: [f32; 4],
res: [f32; 4],
}
/// GTAONode generateMagicSquareNoise(5) + generateMagicSquare (GTAONode.js bottom): 25 RGBA8 texels.
fn magic_square_noise() -> Vec<u8> {
let n: i32 = 5;
let nn = (n * n) as usize;
let mut sq = vec![0i32; nn];
let (mut i, mut j) = (n / 2, n - 1);
let mut num = 1;
while num <= n * n {
if i == -1 && j == n { j = n - 2; i = 0; } else { if j == n { j = 0; } if i < 0 { i = n - 1; } }
if sq[(i * n + j) as usize] != 0 { j -= 2; i += 1; continue; } else { sq[(i * n + j) as usize] = num; num += 1; }
j += 1; i -= 1;
}
let mut data = vec![0u8; nn * 4];
for k in 0..nn {
let ang = 2.0 * std::f64::consts::PI * sq[k] as f64 / nn as f64;
data[k * 4] = ((ang.cos() * 0.5 + 0.5) * 255.0) as u8;
data[k * 4 + 1] = ((ang.sin() * 0.5 + 0.5) * 255.0) as u8;
data[k * 4 + 2] = 127;
data[k * 4 + 3] = 255;
}
data
}
/// three `BloomNode(strength, radius, threshold)` + `smoothWidth` uniform (default 0.01).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BloomParams {
    pub strength: f32,
    pub radius: f32,
    pub threshold: f32,
    pub smooth_width: f32,
}
impl BloomParams {
    pub fn new(strength: f32, radius: f32, threshold: f32) -> Self {
        Self { strength, radius, threshold, smooth_width: 0.01 }
    }
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PostUniform {
    tone: [f32; 4],
    bloom: [f32; 4],
    blur: [f32; 4],
/// x = GTAO composite on (0/1), y = intensity
ao: [f32; 4],
}
struct Sized {
    size: (u32, u32),
    /// highpass, blur x5 H, blur x5 V, resolve
    bind_high: wgpu::BindGroup,
    bind_h: Vec<wgpu::BindGroup>,
    bind_v: Vec<wgpu::BindGroup>,
    bind_resolve: wgpu::BindGroup,
    bright: wgpu::TextureView,
    hs: Vec<wgpu::TextureView>,
    vs: Vec<wgpu::TextureView>,
    blur_u: Vec<wgpu::Buffer>,
/// GTAO target (round(size*resolutionScale)) + its bind group
ao_target: Option<wgpu::TextureView>,
ao_bind: Option<wgpu::BindGroup>,
ao_scale: f32,
ao_buf: wgpu::Buffer,
ao_dims: (u32, u32),
}
struct PostTiming {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
    period_ns: f32,
}
/// r10 eye adaptation: GPU meter (8x8 grid of mean log2 luminance of the HDR scene, pre-exposure) + async readback. The host runs the adaptation
/// (autoexposure.js state machine) and hands back one linear multiplier (`ae_mul`) that scales the HDR scene BEFORE bloom + tone map, like three's `expMul`.
pub const METER_GRID: u32 = 8;
struct Meter {
    pipe: wgpu::RenderPipeline,
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    buf: wgpu::Buffer,
    armed: bool,
    pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
    grid: std::sync::Arc<std::sync::Mutex<Option<Vec<f32>>>>,
}
pub struct Post {
layout: wgpu::BindGroupLayout,
ao_layout: wgpu::BindGroupLayout,
p_ao: wgpu::RenderPipeline,
noise: wgpu::TextureView,
scene_view: Option<wgpu::TextureView>,
depth_view: Option<wgpu::TextureView>,
/// camera projection (WebGPU 0..1 depth) + inverse, pushed per frame by the core
pub proj: [[f32; 4]; 4],
pub proj_inv: [[f32; 4]; 4],
/// r12 GTAO (None = off)
pub gtao: Option<GtaoParams>,
    meter: Meter,
    /// host-driven: run the meter pass (off = zero cost)
    pub meter_on: bool,
    /// linear multiplier on the HDR scene before bloom + tone map (1 = off)
    pub ae_mul: f32,
    p_high: wgpu::RenderPipeline,
    p_blur: wgpu::RenderPipeline,
    p_resolve: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    dummy: wgpu::TextureView,
    uniform: wgpu::Buffer,
    sized: Option<Sized>,
    /// three tone-mapping constant (NoToneMapping 0, Linear 1, Reinhard 2, Cineon 3, ACESFilmic 4, AgX 6, Neutral 7).
    pub tone_mapping: u32,
    pub bloom: Option<BloomParams>,
    timing: Option<PostTiming>,
    timed: bool,
}
fn tex_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
        count: None,
    }
}
impl Post {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, out_format: wgpu::TextureFormat, tone_mapping: u32) -> Self {
        let mut entries = vec![wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        }];
        for b in 1..=6 { entries.push(tex_entry(b)); }
entries.push(tex_entry(8)); // r12: GTAO term (R raw AO, G fade weight)
        entries.push(wgpu::BindGroupLayoutEntry { binding: 7, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("gaia-render post"), entries: &entries });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("gaia-render post"), source: wgpu::ShaderSource::Wgsl(POST_WGSL.into()) });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("gaia-render post layout"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let mk = |fs: &str, fmt: wgpu::TextureFormat| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(fs),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), targets: &[Some(wgpu::ColorTargetState { format: fmt, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let p_high = mk("fs_highpass", BLOOM_FORMAT);
        let p_blur = mk("fs_blur", BLOOM_FORMAT);
        let p_resolve = mk("fs_resolve", out_format);
let ao_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("gaia-render gtao"), entries: &[
wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
] });
let ao_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("gaia-render gtao"), source: wgpu::ShaderSource::Wgsl(GTAO_WGSL.into()) });
let ao_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("gaia-render gtao layout"), bind_group_layouts: &[Some(&ao_layout)], immediate_size: 0 });
let p_ao = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
label: Some("gtao"), layout: Some(&ao_pl),
vertex: wgpu::VertexState { module: &ao_module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
fragment: Some(wgpu::FragmentState { module: &ao_module, entry_point: Some("fs_gtao"), targets: &[Some(wgpu::ColorTargetState { format: GTAO_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
});
let noise = device.create_texture_with_data(queue, &wgpu::TextureDescriptor { label: Some("gtao noise"), size: wgpu::Extent3d { width: 5, height: 5, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }, wgpu::util::TextureDataOrder::LayerMajor, &magic_square_noise()).create_view(&Default::default());
let mtex = device.create_texture(&wgpu::TextureDescriptor { label: Some("ae meter"), size: wgpu::Extent3d { width: METER_GRID, height: METER_GRID, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R32Float, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
let meter = Meter { pipe: mk("fs_meter", wgpu::TextureFormat::R32Float), view: mtex.create_view(&Default::default()), tex: mtex, buf: device.create_buffer(&wgpu::BufferDescriptor { label: Some("ae meter readback"), size: 256 * METER_GRID as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }), armed: false, pending: Default::default(), grid: Default::default() };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("post sampler"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge, mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let dummy_tex = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor { label: Some("post dummy"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: BLOOM_FORMAT, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[0u8; 8],
        );
        let dummy = dummy_tex.create_view(&Default::default());
        let uniform = device.create_buffer(&wgpu::BufferDescriptor { label: Some("post uniform"), size: std::mem::size_of::<PostUniform>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let timing = device.features().contains(wgpu::Features::TIMESTAMP_QUERY).then(|| PostTiming {
            set: device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("post timestamps"), ty: wgpu::QueryType::Timestamp, count: 2 }),
            resolve: device.create_buffer(&wgpu::BufferDescriptor { label: Some("post ts resolve"), size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }),
            readback: device.create_buffer(&wgpu::BufferDescriptor { label: Some("post ts readback"), size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            period_ns: queue.get_timestamp_period(),
        });
        Self { layout, ao_layout, p_ao, noise, scene_view: None, depth_view: None, proj: [[0.0; 4]; 4], proj_inv: [[0.0; 4]; 4], gtao: None, meter, meter_on: false, ae_mul: 1.0, p_high, p_blur, p_resolve, sampler, dummy, uniform, sized: None, tone_mapping, bloom: None, timing, timed: false }
    }
    fn mk_target(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor { label: Some(label), size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: BLOOM_FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] })
            .create_view(&Default::default())
    }
    /// (Re)build size-dependent targets + bind groups. BloomNode.setSize: bright/mip0 = round(size/2), mip i+1 = round(mip i / 2).
    pub fn resize(&mut self, device: &wgpu::Device, scene: &wgpu::TextureView, depth: &wgpu::TextureView, w: u32, h: u32) {
self.scene_view = Some(scene.clone());
self.depth_view = Some(depth.clone());
        let mut sizes = Vec::new();
        let (mut rx, mut ry) = (((w as f64) / 2.0).round() as u32, ((h as f64) / 2.0).round() as u32);
        for _ in 0..BLOOM_MIPS {
            sizes.push((rx.max(1), ry.max(1)));
            rx = ((rx as f64) / 2.0).round() as u32;
            ry = ((ry as f64) / 2.0).round() as u32;
        }
        let bright = Self::mk_target(device, sizes[0].0, sizes[0].1, "bloom bright");
        let hs: Vec<_> = sizes.iter().map(|s| Self::mk_target(device, s.0, s.1, "bloom h")).collect();
        let vs: Vec<_> = sizes.iter().map(|s| Self::mk_target(device, s.0, s.1, "bloom v")).collect();
        let mut blur_u = Vec::new();
        let mk_u = |dev: &wgpu::Device, dir: [f32; 2], inv: [f32; 2], k: f32| {
            let u = PostUniform { tone: [0.0; 4], bloom: [0.0; 4], blur: [dir[0] * inv[0], dir[1] * inv[1], k, 0.0], ao: [0.0; 4] };
            dev.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("blur uniform"), contents: bytemuck::bytes_of(&u), usage: wgpu::BufferUsages::UNIFORM })
        };
        for i in 0..BLOOM_MIPS {
            let inv = [1.0 / sizes[i].0 as f32, 1.0 / sizes[i].1 as f32];
            blur_u.push(mk_u(device, [1.0, 0.0], inv, BLOOM_KERNELS[i]));
            blur_u.push(mk_u(device, [0.0, 1.0], inv, BLOOM_KERNELS[i]));
        }
        let ao_scale = self.gtao.map_or(0.0, |g| g.resolution_scale);
let ao_dims = ((((w as f64) * ao_scale as f64).round() as u32).max(1), (((h as f64) * ao_scale as f64).round() as u32).max(1)); // GTAONode.setSize
let ao_target = (ao_scale > 0.0).then(|| device.create_texture(&wgpu::TextureDescriptor { label: Some("gtao"), size: wgpu::Extent3d { width: ao_dims.0, height: ao_dims.1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: GTAO_FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }).create_view(&Default::default()));
let ao_buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("gtao uniform"), size: std::mem::size_of::<AoUniform>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
let ao_bind = ao_target.as_ref().map(|_| device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("gtao bind"), layout: &self.ao_layout, entries: &[
wgpu::BindGroupEntry { binding: 0, resource: ao_buf.as_entire_binding() },
wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(depth) },
wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.noise) },
] }));
let ao_view = ao_target.as_ref().unwrap_or(&self.dummy);
let bg = |buf: &wgpu::Buffer, texs: [&wgpu::TextureView; 6]| {
            let mut e = vec![wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() }];
            for (i, t) in texs.iter().enumerate() { e.push(wgpu::BindGroupEntry { binding: 1 + i as u32, resource: wgpu::BindingResource::TextureView(t) }); }
            e.push(wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&self.sampler) });
e.push(wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(ao_view) });
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("post bind"), layout: &self.layout, entries: &e })
        };
        let d = &self.dummy;
        let bind_high = bg(&self.uniform, [scene, d, d, d, d, d]);
        let mut bind_h = Vec::new();
        let mut bind_v = Vec::new();
        for i in 0..BLOOM_MIPS {
            let src = if i == 0 { &bright } else { &vs[i - 1] };
            bind_h.push(bg(&blur_u[2 * i], [src, d, d, d, d, d]));
            bind_v.push(bg(&blur_u[2 * i + 1], [&hs[i], d, d, d, d, d]));
        }
        let bind_resolve = bg(&self.uniform, [scene, &vs[0], &vs[1], &vs[2], &vs[3], &vs[4]]);
        self.sized = Some(Sized { size: (w, h), bind_high, bind_h, bind_v, bind_resolve, bright, hs, vs, blur_u, ao_target, ao_bind, ao_scale, ao_buf, ao_dims });
    }
    /// Rebuild the size-dependent targets when GTAO was switched on/off or its resolutionScale changed (call before `encode`; cheap no-op otherwise).
pub fn ensure_ao(&mut self, device: &wgpu::Device) {
let want = self.gtao.map_or(0.0, |g| g.resolution_scale);
let Some(s) = self.sized.as_ref() else { return };
if (s.ao_scale - want).abs() < 1e-6 { return }
let (w, h) = s.size;
let (Some(sc), Some(d)) = (self.scene_view.clone(), self.depth_view.clone()) else { return };
self.resize(device, &sc, &d, w, h);
}
/// GTAO target size (testing/stats).
pub fn gtao_dims(&self) -> Option<(u32, u32)> { self.sized.as_ref().and_then(|s| s.ao_target.as_ref().map(|_| s.ao_dims)) }
pub fn size(&self) -> Option<(u32, u32)> {
        self.sized.as_ref().map(|s| s.size)
    }
    /// Encode the whole post chain: scene (bound at `resize`) -> `out` (sRGB view of the internal colour). `exposure` = three `toneMappingExposure`.
    pub fn encode(&mut self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, out: &wgpu::TextureView, exposure: f32) {
        let Some(s) = self.sized.as_ref() else { return };
        let b = self.bloom;
        let u = PostUniform {
            tone: [exposure, self.tone_mapping as f32, if b.is_some() { 1.0 } else { 0.0 }, b.map_or(0.0, |b| b.strength)],
            bloom: b.map_or([0.0, 0.0, 0.0, self.ae_mul], |b| [b.radius, b.threshold, b.smooth_width, self.ae_mul]),
            blur: [0.0; 4],
ao: self.gtao.map_or([0.0; 4], |g| [if s.ao_target.is_some() { 1.0 } else { 0.0 }, g.intensity, 0.0, 0.0]),
};
queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
        let mut first = true;
        let timing = &self.timing;
        let mut pass = |encoder: &mut wgpu::CommandEncoder, label: &str, pipe: &wgpu::RenderPipeline, bind: &wgpu::BindGroup, view: &wgpu::TextureView, last: bool| {
            let ts = timing.as_ref().and_then(|t| {
                let (beg, end) = (first, last);
                (beg || end).then(|| wgpu::RenderPassTimestampWrites { query_set: &t.set, beginning_of_pass_write_index: beg.then_some(0), end_of_pass_write_index: end.then_some(1) })
            });
            first = false;
            let mut p = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(label),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: ts,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            p.set_pipeline(pipe);
            p.set_bind_group(0, bind, &[]);
            p.draw(0..3, 0..1);
        };
        if let (Some(g), Some(ab), Some(t)) = (self.gtao, s.ao_bind.as_ref(), s.ao_target.as_ref()) {
let au = AoUniform { proj: self.proj, proj_inv: self.proj_inv, p0: [g.radius, g.thickness, g.samples, g.distance_exponent], p1: [g.distance_fall_off, g.scale, g.fade_start, g.fade_end], res: [s.ao_dims.0 as f32, s.ao_dims.1 as f32, 0.0, 0.0] };
queue.write_buffer(&s.ao_buf, 0, bytemuck::bytes_of(&au));
pass(encoder, "gtao", &self.p_ao, ab, t, false);
}
if b.is_some() {
pass(encoder, "bloom high", &self.p_high, &s.bind_high, &s.bright, false);
            for i in 0..BLOOM_MIPS {
                pass(encoder, "bloom blur h", &self.p_blur, &s.bind_h[i], &s.hs[i], false);
                pass(encoder, "bloom blur v", &self.p_blur, &s.bind_v[i], &s.vs[i], false);
            }
        }
        pass(encoder, "post resolve", &self.p_resolve, &s.bind_resolve, out, true);
if self.meter_on && !self.meter.armed && !self.meter.pending.load(std::sync::atomic::Ordering::Acquire) {
pass(encoder, "ae meter", &self.meter.pipe, &s.bind_high, &self.meter.view, false);
encoder.copy_texture_to_buffer(
wgpu::TexelCopyTextureInfo { texture: &self.meter.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
wgpu::TexelCopyBufferInfo { buffer: &self.meter.buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: Some(METER_GRID) } },
wgpu::Extent3d { width: METER_GRID, height: METER_GRID, depth_or_array_layers: 1 },
);
self.meter.armed = true;
}
        if let Some(t) = &self.timing {
            encoder.resolve_query_set(&t.set, 0..2, &t.resolve, 0);
            self.timed = true;
        }
        let _ = &s.blur_u;
    }
    /// Copy the last post-chain timestamps into the readback buffer (call after `encode`, before submit).
    pub fn encode_timing_readback(&self, encoder: &mut wgpu::CommandEncoder) {
        if let (Some(t), true) = (&self.timing, self.timed) {
            encoder.copy_buffer_to_buffer(&t.resolve, 0, &t.readback, 0, 16);
        }
    }
    /// GPU ms of the whole post chain (first pass begin -> resolve end). Native blocking read.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_ms_blocking(&self, device: &wgpu::Device) -> Option<f64> {
        let t = self.timing.as_ref()?;
        let slice = t.readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r.is_ok()); });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        if !rx.recv().ok()? { return None; }
        let ts: [u64; 2] = *bytemuck::from_bytes(&slice.get_mapped_range().ok()?[..16]);
        t.readback.unmap();
        Some(ts[1].saturating_sub(ts[0]) as f64 * t.period_ns as f64 / 1e6)
    }
/// Map the meter copy written by the last `encode` (call after submit; at most one in flight). Result lands in `take_meter`.
pub fn request_meter_async(&mut self) {
use std::sync::atomic::Ordering;
if !self.meter.armed || self.meter.pending.swap(true, Ordering::AcqRel) { return; }
self.meter.armed = false;
let (buf, pending, grid) = (self.meter.buf.clone(), self.meter.pending.clone(), self.meter.grid.clone());
let b2 = buf.clone();
buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
if r.is_ok() {
if let Ok(m) = b2.slice(..).get_mapped_range() {
let mut v = Vec::with_capacity((METER_GRID * METER_GRID) as usize);
for row in 0..METER_GRID as usize { for col in 0..METER_GRID as usize { let o = row * 256 + col * 4; v.push(f32::from_le_bytes([m[o], m[o + 1], m[o + 2], m[o + 3]])); } }
drop(m);
*grid.lock().unwrap() = Some(v);
}
}
b2.unmap();
pending.store(false, Ordering::Release);
});
}
/// Latest metered 8x8 grid (row-major, mean log2 luminance per cell) once, then None until the next readback.
pub fn take_meter(&self) -> Option<Vec<f32>> { self.meter.grid.lock().unwrap().take() }
}
