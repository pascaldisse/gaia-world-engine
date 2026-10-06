//! Sun cascaded shadow maps (CSM). Depth-only caster pass per cascade, per-cascade
//! instance culling, STATIC/DYNAMIC caster split from the start:
//!   static casters  → rendered into a per-cascade CACHE layer, re-rendered only when that
//!                     cascade's light view-proj changes (sun moved / texel-snapped bounds
//!                     moved) or the static set changed (`static_gen`);
//!   dynamic casters → every frame, on top of a COPY of the cache layer (LIVE array).
//! No dynamic casters in a frame → the receiver samples the cache directly (no copy).
//! Receiver side = group(2) of the built-in forward pipeline (forward.wgsl).
//! Point-light shadows: OFF / not implemented (NOTES: next).
use super::{GpuMaterial, GpuMesh};
use glam::{Mat3, Mat4, Vec3};
use std::collections::{HashMap, HashSet};

pub const MAX_CASCADES: usize = 4;
const SHADOW_DEPTH_WGSL: &str = include_str!("shadow_depth.wgsl");
pub const SHADOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// Every tunable = option with a default (§IRON). Lives in `RenderOptions::shadows`.
#[derive(Clone, Debug)]
pub struct ShadowOptions {
    /// Sun shadows on. Off = a 1-texel dummy map is bound and no passes are encoded.
    pub enabled: bool,
    /// 1..=4.
    pub cascades: u32,
    /// Shadow-map resolution per cascade (square).
    pub resolution: u32,
    /// Far edge of the last cascade, metres from the camera (clamped to camera zfar).
    pub max_distance: f32,
    /// Practical-split blend: 0 = uniform, 1 = logarithmic. Ignored if `splits` is set.
    pub split_lambda: f32,
    /// Explicit cascade far distances (len == cascades, ascending). Empty = auto from lambda.
    pub splits: Vec<f32>,
    /// Receiver normal-offset, in shadow texels (world size of a texel of that cascade).
    pub normal_bias: f32,
    /// Receiver constant depth bias, in shadow texels (converted via the cascade depth range).
    pub depth_bias: f32,
    /// Rasterizer slope-scaled bias in the caster pass (pipeline state).
    pub slope_bias: f32,
    /// Rasterizer constant bias in the caster pass (pipeline state, depth units).
    pub constant_bias: i32,
    /// PCF half-width in taps: kernel = (2r+1)². 0 = single hardware-compared tap.
    pub pcf_radius: u32,
    /// Fraction of each cascade (from its far edge) over which it blends into the next.
    pub blend: f32,
    /// Cache static casters per cascade (false = redraw them every frame → measuring).
    pub cache: bool,
    /// Light-space distance toward the sun the ortho box reaches beyond the static-caster
    /// bounds, so dynamic casters above the static scene are not clipped.
    pub caster_margin: f32,
    /// Alpha-tested (glTF MASK) materials cast through their alpha. BLEND never casts.
    pub alpha_test_casters: bool,
    /// glTF import path only (`load_scene_into`): draws whose object-space AABB diagonal exceeds
    /// this never cast (sky domes / backdrops). 0 = off. Asylum: 15 sky/backdrop prims > 400 m.
    pub import_max_caster_diagonal: f32,
}
impl Default for ShadowOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            cascades: 4,
            resolution: 2048,
            max_distance: 120.0,
            split_lambda: 0.75,
            splits: Vec::new(),
            normal_bias: 1.5,
            depth_bias: 1.0,
            slope_bias: 1.5,
            constant_bias: 2,
            pcf_radius: 1,
            blend: 0.1,
            cache: true,
            caster_margin: 50.0,
            alpha_test_casters: true,
            import_max_caster_diagonal: 400.0,
        }
    }
}

/// Per-frame record of what the shadow system did (draw calls per cascade etc.).
#[derive(Clone, Debug, Default)]
pub struct ShadowStats {
    pub enabled: bool,
    pub cascades: usize,
    pub split_distances: [f32; MAX_CASCADES],
    /// Static casters re-rendered into the cache this frame (false = cache hit).
    pub static_rerendered: [bool; MAX_CASCADES],
    pub static_draws: [u32; MAX_CASCADES],
    pub dynamic_draws: [u32; MAX_CASCADES],
    pub static_instances: [u32; MAX_CASCADES],
    pub dynamic_instances: [u32; MAX_CASCADES],
    /// Cache→live copies encoded this frame (only when dynamic casters exist).
    pub copies: u32,
    pub passes: u32,
    /// Total caster draw calls actually encoded this frame (all cascades).
    pub total_draws: u32,
    pub cpu_cull_ms: f64,
}

/// World-space caster (sorted by (mesh, material) so batches are contiguous).
#[derive(Clone, Copy)]
pub(crate) struct Caster {
    pub mesh: u32,
    pub material: u32,
    pub transform: [f32; 16],
    pub is_static: bool,
    pub lo: Vec3,
    pub hi: Vec3,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ShadowUniform {
    vp: [[[f32; 4]; 4]; MAX_CASCADES],
    splits: [f32; 4],
    texel: [f32; 4],
    range: [f32; 4],
    cam_fwd: [f32; 4],
    /// x cascade count (0 = off), y normal_bias, z depth_bias, w pcf radius
    params: [f32; 4],
    /// x 1/resolution, y blend fraction
    info: [f32; 4],
}

struct CascadeFrame {
    vp: Mat4,
    cx: f32,
    cy: f32,
    r: f32,
    near: f32,
    far: f32,
}

struct CascadeGpu {
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
    layer_cache: wgpu::TextureView,
    layer_live: wgpu::TextureView,
    static_buf: wgpu::Buffer,
    dyn_buf: wgpu::Buffer,
    cap_static: usize,
    cap_dyn: usize,
    /// vp bits + static_gen of the last cache render; None = invalid.
    cache_key: Option<([f32; 16], u64)>,
}

pub(crate) struct ShadowSystem {
    pub opts: ShadowOptions,
    cascades: Vec<CascadeGpu>,
    cache_tex: Option<wgpu::Texture>,
    live_tex: Option<wgpu::Texture>,
    uniform: wgpu::Buffer,
    bind_cache: wgpu::BindGroup,
    bind_live: wgpu::BindGroup,
    use_live: bool,
    pipe_opaque: wgpu::RenderPipeline,
    pipe_alpha: wgpu::RenderPipeline,
    pub stats: ShadowStats,
}

pub(crate) fn receiver_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("gaia-render shadow receiver"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                count: None,
            },
        ],
    })
}

fn depth_tex(device: &wgpu::Device, res: u32, layers: u32, usage: wgpu::TextureUsages, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: res, height: res, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: SHADOW_FORMAT,
        usage,
        view_formats: &[],
    })
}

fn array_view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    })
}

fn layer_view(t: &wgpu::Texture, layer: u32) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2),
        base_array_layer: layer,
        array_layer_count: Some(1),
        ..Default::default()
    })
}

impl ShadowSystem {
    pub(crate) fn new(
        device: &wgpu::Device,
        mut opts: ShadowOptions,
        receiver_layout: &wgpu::BindGroupLayout,
        material_layout: &wgpu::BindGroupLayout,
    ) -> Self {
        opts.cascades = opts.cascades.clamp(1, MAX_CASCADES as u32);
        opts.resolution = opts.resolution.clamp(16, 8192);
        let cascade_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shadow cascade"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gaia-render shadow depth"),
            source: wgpu::ShaderSource::Wgsl(SHADOW_DEPTH_WGSL.into()),
        });
        let pl_opaque = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("shadow opaque layout"),
            bind_group_layouts: &[Some(&cascade_layout)],
            immediate_size: 0,
        });
        let pl_alpha = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("shadow alpha layout"),
            bind_group_layouts: &[Some(&cascade_layout), Some(material_layout)],
            immediate_size: 0,
        });
        let pos_only = [wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 }];
        let pos_uv = [
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
            wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 24, shader_location: 2 },
        ];
        let inst_attrs = wgpu::vertex_attr_array![3 => Float32x4, 4 => Float32x4, 5 => Float32x4, 6 => Float32x4];
        let make = |label: &'static str,
                    layout: &wgpu::PipelineLayout,
                    vs: &str,
                    fs: Option<&str>,
                    attrs: &[wgpu::VertexAttribute]| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some(vs),
                    buffers: &[
                        Some(wgpu::VertexBufferLayout {
                            array_stride: std::mem::size_of::<crate::scene::Vertex>() as u64,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: attrs,
                        }),
                        Some(wgpu::VertexBufferLayout {
                            array_stride: 64,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &inst_attrs,
                        }),
                    ],
                    compilation_options: Default::default(),
                },
                fragment: fs.map(|f| wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(f),
                    targets: &[],
                    compilation_options: Default::default(),
                }),
                // no culling: double-sided casters, same as the forward pass.
                primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: SHADOW_FORMAT,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::Less),
                    stencil: Default::default(),
                    bias: wgpu::DepthBiasState {
                        constant: opts.constant_bias,
                        slope_scale: opts.slope_bias,
                        clamp: 0.0,
                    },
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let pipe_opaque = make("shadow opaque", &pl_opaque, "vs_depth", None, &pos_only);
        let pipe_alpha = make("shadow alpha-test", &pl_alpha, "vs_alpha", Some("fs_alpha"), &pos_uv);

        let n = opts.cascades as usize;
        let (res, layers) = if opts.enabled { (opts.resolution, n as u32) } else { (1, 1) };
        let cache_tex = depth_tex(
            device, res, layers,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            "shadow cache",
        );
        let live_tex = depth_tex(
            device, res, layers,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            "shadow live",
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("shadow compare"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("shadow uniform"),
            size: std::mem::size_of::<ShadowUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mk_bind = |tex: &wgpu::Texture| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("shadow receiver bind"),
                layout: receiver_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&array_view(tex)) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
                ],
            })
        };
        let bind_cache = mk_bind(&cache_tex);
        let bind_live = mk_bind(&live_tex);
        let mut cascades = Vec::new();
        if opts.enabled {
            for c in 0..n {
                let ub = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("shadow cascade vp"),
                    size: 64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("shadow cascade bind"),
                    layout: &cascade_layout,
                    entries: &[wgpu::BindGroupEntry { binding: 0, resource: ub.as_entire_binding() }],
                });
                let mkbuf = |label: &'static str| {
                    device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some(label),
                        size: 64,
                        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    })
                };
                cascades.push(CascadeGpu {
                    uniform: ub,
                    bind,
                    layer_cache: layer_view(&cache_tex, c as u32),
                    layer_live: layer_view(&live_tex, c as u32),
                    static_buf: mkbuf("shadow static instances"),
                    dyn_buf: mkbuf("shadow dynamic instances"),
                    cap_static: 1,
                    cap_dyn: 1,
                    cache_key: None,
                });
            }
        }
        Self {
            opts,
            cascades,
            cache_tex: Some(cache_tex),
            live_tex: Some(live_tex),
            uniform,
            bind_cache,
            bind_live,
            use_live: false,
            pipe_opaque,
            pipe_alpha,
            stats: ShadowStats::default(),
        }
    }

    pub(crate) fn receiver_bind(&self) -> &wgpu::BindGroup {
        if self.use_live { &self.bind_live } else { &self.bind_cache }
    }

    /// Cascade far distances (view-space depth).
    fn splits(&self, znear: f32, zfar_cam: Option<f32>) -> Vec<f32> {
        let n = self.opts.cascades as usize;
        if self.opts.splits.len() == n {
            return self.opts.splits.clone();
        }
        let far = zfar_cam.map_or(self.opts.max_distance, |f| f.min(self.opts.max_distance)).max(znear * 1.01);
        let near = znear.max(1e-3);
        let lam = self.opts.split_lambda.clamp(0.0, 1.0);
        (1..=n)
            .map(|i| {
                let p = i as f32 / n as f32;
                let log = near * (far / near).powf(p);
                let uni = near + (far - near) * p;
                lam * log + (1.0 - lam) * uni
            })
            .collect()
    }

    /// Encode all shadow work for this frame. Returns true if a timed pass span was written
    /// (timestamps at `ts.1` / `ts.2` in `ts.0`).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn encode(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        cam_world: Mat4,
        yfov: f32,
        aspect: f32,
        znear: f32,
        zfar: Option<f32>,
        sun_dir: Vec3,
        casters: &[Caster],
        static_gen: u64,
        meshes: &HashMap<u32, GpuMesh>,
        materials: &HashMap<u32, GpuMaterial>,
        blend: &HashSet<u32>,
        ts: Option<(&wgpu::QuerySet, u32, u32)>,
    ) -> bool {
        let n = self.opts.cascades as usize;
        let mut su: ShadowUniform = bytemuck::Zeroable::zeroed();
        self.stats = ShadowStats { enabled: self.opts.enabled, cascades: n, ..Default::default() };
        self.use_live = false;
        if !self.opts.enabled || sun_dir.length_squared() < 1e-8 {
            queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&su)); // params.x = 0 → shader skips
            return false;
        }
        let t0 = std::time::Instant::now();
        let d = sun_dir.normalize();
        let up = if d.y.abs() > 0.99 { Vec3::X } else { Vec3::Y };
        let view = Mat4::look_at_rh(Vec3::ZERO, d, up);
        let rot = Mat3::from_mat4(view);
        let abs_rot = Mat3::from_cols(rot.x_axis.abs(), rot.y_axis.abs(), rot.z_axis.abs());
        // static-caster bounds along the light axis (fallback: all casters)
        let (mut slo, mut shi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        let any_static = casters.iter().any(|c| c.is_static);
        for c in casters.iter().filter(|c| c.is_static || !any_static) {
            slo = slo.min(c.lo);
            shi = shi.max(c.hi);
        }
        let mut zmax_scene = f32::MIN;
        if slo.x <= shi.x {
            for i in 0..8 {
                let p = Vec3::new(
                    if i & 1 == 0 { slo.x } else { shi.x },
                    if i & 2 == 0 { slo.y } else { shi.y },
                    if i & 4 == 0 { slo.z } else { shi.z },
                );
                zmax_scene = zmax_scene.max((rot * p).z);
            }
        }
        // ---- cascade frames ----
        let eye = cam_world.transform_point3(Vec3::ZERO);
        let fwd = -cam_world.z_axis.truncate().normalize();
        let right = cam_world.x_axis.truncate().normalize();
        let upc = cam_world.y_axis.truncate().normalize();
        let splits = self.splits(znear, zfar);
        let th = (yfov * 0.5).tan();
        let mut frames: Vec<CascadeFrame> = Vec::with_capacity(n);
        let mut prev = znear;
        for (c, &far) in splits.iter().enumerate().take(n) {
            let mut corners = [Vec3::ZERO; 8];
            for (k, &dist) in [prev, far].iter().enumerate() {
                let hh = dist * th;
                let hw = hh * aspect;
                let ctr = eye + fwd * dist;
                for (j, (sx, sy)) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)].iter().enumerate() {
                    corners[k * 4 + j] = ctr + right * (hw * sx) + upc * (hh * sy);
                }
            }
            let centroid = corners.iter().fold(Vec3::ZERO, |a, &p| a + p) / 8.0;
            let mut r = corners.iter().map(|p| p.distance(centroid)).fold(0.0f32, f32::max);
            r = (r * 16.0).ceil() / 16.0; // stable radius: no shimmering from tiny radius drift
            r = r.max(0.5);
            let texel = 2.0 * r / self.opts.resolution as f32;
            let lc = rot * centroid;
            let (cx, cy) = ((lc.x / texel).round() * texel, (lc.y / texel).round() * texel);
            let near_z = -(zmax_scene.max(lc.z + r)) - self.opts.caster_margin; // depth along light
            let far_z = -(lc.z - r) + 1.0;
            let proj = Mat4::orthographic_rh(cx - r, cx + r, cy - r, cy + r, near_z.min(far_z - 0.1), far_z);
            frames.push(CascadeFrame { vp: proj * view, cx, cy, r, near: near_z.min(far_z - 0.1), far: far_z });
            su.vp[c] = frames[c].vp.to_cols_array_2d();
            su.splits[c] = far;
            su.texel[c] = texel;
            su.range[c] = far_z - near_z.min(far_z - 0.1);
            self.stats.split_distances[c] = far;
            prev = far;
        }
        su.cam_fwd = fwd.extend(0.0).to_array();
        su.params = [n as f32, self.opts.normal_bias, self.opts.depth_bias, self.opts.pcf_radius as f32];
        su.info = [1.0 / self.opts.resolution as f32, self.opts.blend.clamp(0.0, 0.5), 0.0, 0.0];
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&su));

        // ---- cull + build draw lists ----
        type Batch = (u32, u32, std::ops::Range<u32>);
        let mut static_lists: Vec<Option<Vec<Batch>>> = Vec::new();
        let mut dyn_lists: Vec<Vec<Batch>> = Vec::new();
        let mut dyn_total = 0usize;
        for c in 0..n {
            let f = &frames[c];
            queue.write_buffer(&self.cascades[c].uniform, 0, bytemuck::bytes_of(&f.vp.to_cols_array_2d()));
            let key = (f.vp.to_cols_array(), static_gen);
            let rerender = !self.opts.cache || self.cascades[c].cache_key != Some(key);
            let cull = |want_static: bool| -> (Vec<Batch>, Vec<[f32; 16]>) {
                let mut batches: Vec<Batch> = Vec::new();
                let mut data: Vec<[f32; 16]> = Vec::new();
                for ca in casters.iter().filter(|ca| ca.is_static == want_static) {
                    let ctr = rot * ((ca.lo + ca.hi) * 0.5);
                    let half = abs_rot * ((ca.hi - ca.lo) * 0.5);
                    if (ctr.x - f.cx).abs() > f.r + half.x || (ctr.y - f.cy).abs() > f.r + half.y {
                        continue;
                    }
                    let (dmin, dmax) = (-(ctr.z + half.z), -(ctr.z - half.z));
                    if dmax < f.near || dmin > f.far {
                        continue;
                    }
                    if blend.contains(&ca.material) || !meshes.contains_key(&ca.mesh) || !materials.contains_key(&ca.material) {
                        continue; // BLEND never casts; dangling ids skipped
                    }
                    let k = data.len() as u32;
                    data.push(ca.transform);
                    match batches.last_mut() {
                        Some((m, mt, r)) if *m == ca.mesh && *mt == ca.material => r.end = k + 1,
                        _ => batches.push((ca.mesh, ca.material, k..k + 1)),
                    }
                }
                (batches, data)
            };
            let g = &mut self.cascades[c];
            if rerender {
                let (b, data) = cull(true);
                if data.len() > g.cap_static {
                    g.cap_static = data.len().next_power_of_two();
                    g.static_buf = device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("shadow static instances"),
                        size: (g.cap_static * 64) as u64,
                        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    });
                }
                if !data.is_empty() {
                    queue.write_buffer(&g.static_buf, 0, bytemuck::cast_slice(&data));
                }
                self.stats.static_instances[c] = data.len() as u32;
                static_lists.push(Some(b));
                g.cache_key = Some(key);
            } else {
                static_lists.push(None);
            }
            let (b, data) = cull(false);
            if data.len() > g.cap_dyn {
                g.cap_dyn = data.len().next_power_of_two();
                g.dyn_buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("shadow dynamic instances"),
                    size: (g.cap_dyn * 64) as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
            }
            if !data.is_empty() {
                queue.write_buffer(&g.dyn_buf, 0, bytemuck::cast_slice(&data));
            }
            self.stats.dynamic_instances[c] = data.len() as u32;
            dyn_total += data.len();
            dyn_lists.push(b);
        }
        // any dynamic caster anywhere in the frame → receiver samples LIVE (cache copy + dyn)
        self.use_live = dyn_total > 0;
        self.stats.cpu_cull_ms = t0.elapsed().as_secs_f64() * 1e3;

        // ---- step plan (for first/last-pass timestamps) ----
        enum Step {
            Static(usize),
            Copy(usize),
            Dyn(usize),
        }
        let mut steps: Vec<Step> = Vec::new();
        for c in 0..n {
            if static_lists[c].is_some() {
                steps.push(Step::Static(c));
            }
        }
        if self.use_live {
            for c in 0..n {
                steps.push(Step::Copy(c));
                if !dyn_lists[c].is_empty() {
                    steps.push(Step::Dyn(c));
                }
            }
        }
        let is_pass = |s: &Step| !matches!(s, Step::Copy(_));
        let first = steps.iter().position(is_pass);
        let last = steps.iter().rposition(is_pass);
        let res = self.opts.resolution;
        let alpha_ok = self.opts.alpha_test_casters;
        for (i, step) in steps.iter().enumerate() {
            match step {
                Step::Copy(c) => {
                    encoder.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: self.cache_tex.as_ref().unwrap(),
                            mip_level: 0,
                            origin: wgpu::Origin3d { x: 0, y: 0, z: *c as u32 },
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::TexelCopyTextureInfo {
                            texture: self.live_tex.as_ref().unwrap(),
                            mip_level: 0,
                            origin: wgpu::Origin3d { x: 0, y: 0, z: *c as u32 },
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::Extent3d { width: res, height: res, depth_or_array_layers: 1 },
                    );
                    self.stats.copies += 1;
                }
                Step::Static(c) | Step::Dyn(c) => {
                    let is_static = matches!(step, Step::Static(_));
                    let g = &self.cascades[*c];
                    let (view, buf, list) = if is_static {
                        (&g.layer_cache, &g.static_buf, static_lists[*c].as_ref().unwrap())
                    } else {
                        (&g.layer_live, &g.dyn_buf, &dyn_lists[*c])
                    };
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some(if is_static { "shadow static" } else { "shadow dynamic" }),
                        color_attachments: &[],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                            view,
                            depth_ops: Some(wgpu::Operations {
                                load: if is_static { wgpu::LoadOp::Clear(1.0) } else { wgpu::LoadOp::Load },
                                store: wgpu::StoreOp::Store,
                            }),
                            stencil_ops: None,
                        }),
                        timestamp_writes: ts.and_then(|(qs, b, e)| {
                            let (bw, ew) = (Some(i) == first, Some(i) == last);
                            (bw || ew).then_some(wgpu::RenderPassTimestampWrites {
                                query_set: qs,
                                beginning_of_pass_write_index: bw.then_some(b),
                                end_of_pass_write_index: ew.then_some(e),
                            })
                        }),
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    pass.set_bind_group(0, &g.bind, &[]);
                    pass.set_vertex_buffer(1, buf.slice(..));
                    let mut draws = 0u32;
                    let mut cur_alpha: Option<bool> = None;
                    for (mesh, mat, range) in list {
                        let (Some(m), Some(gm)) = (meshes.get(mesh), materials.get(mat)) else { continue };
                        let masked = alpha_ok && gm.desc.as_ref().is_some_and(|d| d.alpha_cutoff.is_some());
                        if cur_alpha != Some(masked) {
                            pass.set_pipeline(if masked { &self.pipe_alpha } else { &self.pipe_opaque });
                            cur_alpha = Some(masked);
                        }
                        if masked {
                            pass.set_bind_group(1, &gm.bind, &[]);
                        }
                        pass.set_vertex_buffer(0, m.vertices.slice(..));
                        pass.set_index_buffer(m.indices.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..m.index_count, 0, range.clone());
                        draws += 1;
                    }
                    drop(pass);
                    self.stats.passes += 1;
                    if is_static {
                        self.stats.static_rerendered[*c] = true;
                        self.stats.static_draws[*c] = draws;
                    } else {
                        self.stats.dynamic_draws[*c] = draws;
                    }
                    self.stats.total_draws += draws;
                }
            }
        }
        first.is_some()
    }
}
