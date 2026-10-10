//! lane nt-gi: NATIVE probe-GI update. The page used to run this as three TSL compute on THREE's own GPU device (client/kernel/gi/gi-open-raypar.js)
//! and read the atlases back (gi-bridge.js, ~19 MB / 30 frames) — a second device + a readback. Here the SAME algorithm (gi_compute.wgsl is a literal
//! translation) runs on gaia-render's device; the page only does CPU bookkeeping (voxel window bricks, cascade scroll, batch plan, uniforms).
//!
//! Data flow:  JS GIOpen.update -> [gi_compute_voxels (dirty brick ranges)] + [gi_compute_step (frame params + fresh probes)]
//!             -> encode (inside render_frame, before the forward pass): trace -> irr_blend -> depth_blend -> copy atlases to the sampled textures.
//! Atlas buffers use the layout of three's instancedArray atlases (irradiance = vec3 stride 16 = array<vec4>, depth = vec2) so they double as the storage
//! binding of exported TSL materials (reserved storage ids, see RenderCore::gi_storage_ids) and as the source of the 4096-wide textures forward.wgsl samples.
use crate::gi::{GI_MAX_CASCADES, GI_PARAM_CASCADE, GI_PARAM_HEADER, GI_TEX_WIDTH};
use bytemuck::{Pod, Zeroable};

const WGSL: &str = include_str!("gi_compute.wgsl");
/// compute workgroup size (gi_compute.wgsl `@workgroup_size`)
const WORKGROUP: u32 = 64;

/// `gi_compute_step` frame array layout (f32). Mirrored by client/kernel/render-api/gi-native.js GI_FRAME.
pub const GI_FRAME_LEN: usize = 44;
pub const GF_BASE_BRICK: usize = 0; // xyz: voxel window base brick (absolute, unbiased)
pub const GF_BOUNCE: usize = 3; // bounceScale
pub const GF_SUN_DIR: usize = 4; // xyz
pub const GF_SUN_INTENSITY: usize = 7;
pub const GF_SUN_COLOR: usize = 8; // xyz
pub const GF_AMBIENT_REPLACE: usize = 11; // 0 add . 1 replace (forward.wgsl mode)
pub const GF_ZENITH: usize = 12; // xyz (already x skyScale)
pub const GF_HORIZON: usize = 16;
pub const GF_GROUND: usize = 20;
pub const GF_STARTS: usize = 24; // 4 per-cascade round-robin cursor
pub const GF_COUNTS: usize = 28; // 4 per-cascade batch sizes (probes)
pub const GF_BASE_CELLS: usize = 32; // 3 per cascade, 4 cascades: window base cell

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GcUniform {
    cas: [[f32; 8]; GI_MAX_CASCADES], // per cascade: [baseCell.xyz, spacing], [dims.xyz, baseIndex]
    start: [u32; 4],
    cum: [u32; 4],
    sun_dir: [f32; 4],
    sun_col: [f32; 4],
    zenith: [f32; 4],
    horizon: [f32; 4],
    ground: [f32; 4],
    vbase: [i32; 4],
    vdim: [i32; 4],
    vcell: [f32; 4],
    vint: [i32; 4],
    res: [u32; 4],
    cnt: [u32; 4],
    hy: [f32; 4],
    misc: [f32; 4],
}

/// wgsl `Params` span (printed by `cargo run -p gaia-render --example gi_compute_validate`): 4 cascades x 32 B + 15 vec4.
const _: () = assert!(std::mem::size_of::<GcUniform>() == GI_MAX_CASCADES * 32 + 15 * 16);

#[derive(Clone, Debug)]
pub(crate) struct GcCascade {
    pub spacing: f32,
    pub dims: [u32; 3],
    pub base_index: u32,
}
/// Everything static about the GI volume (JSON from gi-native.js `config()`); nothing here has a hidden default — a missing key is a loud error.
#[derive(Clone, Debug)]
pub(crate) struct GcConfig {
    pub cascades: Vec<GcCascade>,
    pub irr_res: u32,
    pub depth_res: u32,
    pub rays: u32,
    pub probe_count: u32,
    pub max_batch: u32,
    pub bricks: [i32; 3],
    pub brick_size: i32,
    pub cell_size: f32,
    pub cell_bias: i32,
    pub march_steps: i32,
    pub relocate_steps: i32,
    pub max_dist: f32,
    pub relocate_max: f32,
    pub blend_cells: f32,
    pub irr_alpha: f32,
    pub depth_alpha: f32,
    pub fast_alpha: f32,
    pub adapt_threshold: f32,
    pub fib_phi: f32,
}
impl GcConfig {
    pub(crate) fn from_json(json: &str) -> Result<Self, String> {
        let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("giComputeInit: bad json: {e}"))?;
        let num = |o: &serde_json::Value, k: &str| -> Result<f64, String> { o.get(k).and_then(|x| x.as_f64()).ok_or_else(|| format!("giComputeInit: missing number '{k}'")) };
        let arr3 = |o: &serde_json::Value, k: &str| -> Result<[f64; 3], String> {
            let a = o.get(k).and_then(|x| x.as_array()).ok_or_else(|| format!("giComputeInit: missing array '{k}'"))?;
            if a.len() != 3 { return Err(format!("giComputeInit: '{k}' needs 3 numbers")); }
            let g = |i: usize| a[i].as_f64().ok_or_else(|| format!("giComputeInit: '{k}'[{i}] not a number"));
            Ok([g(0)?, g(1)?, g(2)?])
        };
        let cs = v.get("cascades").and_then(|x| x.as_array()).ok_or("giComputeInit: missing 'cascades'")?;
        if cs.is_empty() || cs.len() > GI_MAX_CASCADES { return Err(format!("giComputeInit: cascade count {} not in 1..={GI_MAX_CASCADES}", cs.len())); }
        let mut cascades = Vec::new();
        for c in cs {
            let d = arr3(c, "dims")?;
            cascades.push(GcCascade { spacing: num(c, "spacing")? as f32, dims: [d[0] as u32, d[1] as u32, d[2] as u32], base_index: num(c, "baseIndex")? as u32 });
        }
        let vox = v.get("voxel").ok_or("giComputeInit: missing 'voxel'")?;
        let b = arr3(vox, "bricks")?;
        let cfg = GcConfig {
            probe_count: cascades.iter().map(|c| c.dims[0] * c.dims[1] * c.dims[2]).sum(),
            cascades,
            irr_res: num(&v, "irradianceRes")? as u32,
            depth_res: num(&v, "depthRes")? as u32,
            rays: num(&v, "raysPerProbe")? as u32,
            max_batch: num(&v, "maxBatchProbes")? as u32,
            bricks: [b[0] as i32, b[1] as i32, b[2] as i32],
            brick_size: num(vox, "brickSize")? as i32,
            cell_size: num(vox, "cellSize")? as f32,
            cell_bias: num(vox, "cellBias")? as i32,
            march_steps: num(&v, "marchSteps")? as i32,
            relocate_steps: num(&v, "relocateSteps")? as i32,
            max_dist: num(&v, "maxDist")? as f32,
            relocate_max: num(&v, "relocateMax")? as f32,
            blend_cells: num(&v, "blendCells")? as f32,
            irr_alpha: num(&v, "irradianceAlpha")? as f32,
            depth_alpha: num(&v, "depthAlpha")? as f32,
            fast_alpha: num(&v, "fastAlpha")? as f32,
            adapt_threshold: num(&v, "adaptThreshold")? as f32,
            fib_phi: num(&v, "fibPhi")? as f32,
        };
        if cfg.irr_res == 0 || cfg.depth_res == 0 || cfg.rays == 0 || cfg.brick_size <= 0 || cfg.bricks.iter().any(|&x| x <= 0) { return Err("giComputeInit: zero resolution / rays / brick dims".into()); }
        if cfg.max_batch == 0 || cfg.max_batch > cfg.probe_count { return Err(format!("giComputeInit: maxBatchProbes {} not in 1..={}", cfg.max_batch, cfg.probe_count)); }
        if cfg.cell_bias % cfg.brick_size != 0 { return Err("giComputeInit: cellBias must be a multiple of brickSize".into()); }
        Ok(cfg)
    }
    pub(crate) fn voxel_words(&self) -> u64 { (self.bricks[0] as u64) * (self.bricks[1] as u64) * (self.bricks[2] as u64) * (self.brick_size as u64).pow(3) }
    pub(crate) fn irr_texels(&self) -> u64 { self.probe_count as u64 * (self.irr_res as u64).pow(2) }
    pub(crate) fn depth_texels(&self) -> u64 { self.probe_count as u64 * (self.depth_res as u64).pow(2) }
}

struct Pending {
    frame: Vec<f32>,
}
pub(crate) struct GiCompute {
    pub(crate) cfg: GcConfig,
    uniform: wgpu::Buffer,
    voxels: wgpu::Buffer,
    pub(crate) irr: wgpu::Buffer,
    pub(crate) depth: wgpu::Buffer,
    #[allow(dead_code)] // kept alive by `bind`; named for debugging
    ray: wgpu::Buffer,
    bind: wgpu::BindGroup,
    trace: wgpu::ComputePipeline,
    irr_blend: wgpu::ComputePipeline,
    depth_blend: wgpu::ComputePipeline,
    pending: Option<Pending>,
    pub(crate) irr_rows: u32,
    pub(crate) depth_rows: u32,
    pub steps: u32,
    pub dispatched_probes: u64,
    pub voxel_writes: u32,
    pub fresh_probes: u64,
}
fn rows(texels: u64) -> u32 { (texels.div_ceil(GI_TEX_WIDTH as u64)).max(1) as u32 }
fn buf(device: &wgpu::Device, label: &str, size: u64, mapped: bool) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size.max(16).next_multiple_of(16), usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: mapped })
}
impl GiCompute {
    pub(crate) fn new(device: &wgpu::Device, cfg: GcConfig) -> Result<Self, String> {
        let (ir, dr) = (rows(cfg.irr_texels()), rows(cfg.depth_texels()));
        // atlas buffers are padded to whole texture rows so the buffer->texture copy is a single full-width copy (4096 texels * 16 B / * 8 B = 256-aligned)
        let irr_bytes = ir as u64 * GI_TEX_WIDTH as u64 * 16;
        let depth_bytes = dr as u64 * GI_TEX_WIDTH as u64 * 8;
        let ray_bytes = cfg.max_batch as u64 * cfg.rays as u64 * 16;
        let vox_bytes = cfg.voxel_words() * 4;
        let lim = device.limits().max_storage_buffer_binding_size as u64;
        for (n, b) in [("irradiance atlas", irr_bytes), ("depth atlas", depth_bytes), ("ray buffer", ray_bytes), ("voxel window", vox_bytes)] {
            if b > lim { return Err(format!("giComputeInit: {n} needs {b} B > max_storage_buffer_binding_size {lim}")); }
        }
        let uniform = device.create_buffer(&wgpu::BufferDescriptor { label: Some("gi compute uniform"), size: std::mem::size_of::<GcUniform>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let voxels = buf(device, "gi voxels", vox_bytes, false);
        let ray = buf(device, "gi rays", ray_bytes, false);
        let irr = buf(device, "gi irradiance atlas", irr_bytes, false);
        // depth starts at the 'fresh' sentinel -1 everywhere (GIOpen constructor: _depthAttr.array.fill(-1)) — queries skip them, the first blend takes the new value
        let depth = buf(device, "gi depth atlas", depth_bytes, true);
        {
            let neg = vec![-1.0f32; (depth.size() / 4) as usize];
            let mut m = depth.slice(..).get_mapped_range_mut().map_err(|e| format!("giComputeInit: depth atlas map: {e:?}"))?;
            m.copy_from_slice(bytemuck::cast_slice(&neg));
        }
        depth.unmap();
        let sb = |binding: u32, ro: bool| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: ro }, has_dynamic_offset: false, min_binding_size: None }, count: None };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gi compute"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                sb(1, true),
                sb(2, false),
                sb(3, false),
                sb(4, false),
            ],
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gi compute bind"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: voxels.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: ray.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: irr.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: depth.as_entire_binding() },
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("gi_compute.wgsl"), source: wgpu::ShaderSource::Wgsl(WGSL.into()) });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("gi compute"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipe = |entry: &str| device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(entry), layout: Some(&pl), module: &module, entry_point: Some(entry), compilation_options: Default::default(), cache: None });
        Ok(Self { trace: pipe("trace"), irr_blend: pipe("irr_blend"), depth_blend: pipe("depth_blend"), cfg, uniform, voxels, irr, depth, ray, bind, pending: None, irr_rows: ir, depth_rows: dr, steps: 0, dispatched_probes: 0, voxel_writes: 0, fresh_probes: 0 })
    }
    /// One dirty brick range (u32 words) of the CPU voxel window.
    pub(crate) fn write_voxels(&mut self, queue: &wgpu::Queue, start: u32, words: &[u32]) -> Result<(), String> {
        if (start as u64 + words.len() as u64) > self.cfg.voxel_words() { return Err(format!("giComputeVoxels: range {start}+{} beyond window {}", words.len(), self.cfg.voxel_words())); }
        queue.write_buffer(&self.voxels, start as u64 * 4, bytemuck::cast_slice(words));
        self.voxel_writes += 1;
        Ok(())
    }
    /// Record this frame's dispatch (encoded in `encode`) + mark entered probes fresh (depth sentinel -1 over the probe's whole depth tile — GIOpen._markFresh).
    pub(crate) fn step(&mut self, queue: &wgpu::Queue, frame: &[f32], fresh: &[u32]) -> Result<(), String> {
        if frame.len() < GI_FRAME_LEN { return Err(format!("giComputeStep: frame needs {GI_FRAME_LEN} floats, got {}", frame.len())); }
        let tpp = (self.cfg.depth_res * self.cfg.depth_res) as usize;
        if !fresh.is_empty() {
            let neg = vec![-1.0f32; tpp * 2];
            for &p in fresh {
                if p >= self.cfg.probe_count { return Err(format!("giComputeStep: fresh probe {p} >= {}", self.cfg.probe_count)); }
                queue.write_buffer(&self.depth, p as u64 * tpp as u64 * 8, bytemuck::cast_slice(&neg));
            }
            self.fresh_probes += fresh.len() as u64;
        }
        self.pending = Some(Pending { frame: frame[..GI_FRAME_LEN].to_vec() });
        Ok(())
    }
    /// forward.wgsl `Gi` params (gi.rs layout) for the pending frame — written only AFTER the atlases hold a computed batch.
    fn forward_params(&self, f: &[f32]) -> Vec<f32> {
        let c = &self.cfg;
        let mut p = vec![c.cascades.len() as f32, c.blend_cells, c.irr_res as f32, c.depth_res as f32, f[GF_AMBIENT_REPLACE], 0.0, 0.0, 0.0];
        debug_assert_eq!(p.len(), GI_PARAM_HEADER);
        for (k, casc) in c.cascades.iter().enumerate() {
            let b = GF_BASE_CELLS + 3 * k;
            p.extend_from_slice(&[f[b], f[b + 1], f[b + 2], casc.spacing, casc.dims[0] as f32, casc.dims[1] as f32, casc.dims[2] as f32, casc.base_index as f32]);
        }
        debug_assert_eq!(p.len(), GI_PARAM_HEADER + c.cascades.len() * GI_PARAM_CASCADE);
        p
    }
    fn uniform_for(&self, f: &[f32], total: u32, cum: [u32; 4], start: [u32; 4]) -> GcUniform {
        let c = &self.cfg;
        let mut u: GcUniform = Zeroable::zeroed();
        for (k, casc) in c.cascades.iter().enumerate() {
            let b = GF_BASE_CELLS + 3 * k;
            u.cas[k] = [f[b], f[b + 1], f[b + 2], casc.spacing, casc.dims[0] as f32, casc.dims[1] as f32, casc.dims[2] as f32, casc.base_index as f32];
        }
        u.start = start;
        u.cum = cum;
        u.sun_dir = [f[GF_SUN_DIR], f[GF_SUN_DIR + 1], f[GF_SUN_DIR + 2], 0.0];
        u.sun_col = [f[GF_SUN_COLOR], f[GF_SUN_COLOR + 1], f[GF_SUN_COLOR + 2], f[GF_SUN_INTENSITY]];
        u.zenith = [f[GF_ZENITH], f[GF_ZENITH + 1], f[GF_ZENITH + 2], 0.0];
        u.horizon = [f[GF_HORIZON], f[GF_HORIZON + 1], f[GF_HORIZON + 2], 0.0];
        u.ground = [f[GF_GROUND], f[GF_GROUND + 1], f[GF_GROUND + 2], 0.0];
        let bias_bricks = c.cell_bias / c.brick_size;
        u.vbase = [f[GF_BASE_BRICK] as i32 + bias_bricks, f[GF_BASE_BRICK + 1] as i32 + bias_bricks, f[GF_BASE_BRICK + 2] as i32 + bias_bricks, 0];
        u.vdim = [c.bricks[0], c.bricks[1], c.bricks[2], c.brick_size];
        u.vcell = [c.cell_size, c.max_dist, c.relocate_max, f[GF_BOUNCE]];
        u.vint = [c.cell_bias, c.march_steps, c.relocate_steps, c.cascades.len() as i32];
        u.res = [c.irr_res, c.depth_res, c.rays, 0];
        u.cnt = [total * c.rays, total * c.irr_res * c.irr_res, total * c.depth_res * c.depth_res, total];
        u.hy = [c.irr_alpha, c.depth_alpha, c.fast_alpha, c.adapt_threshold];
        u.misc = [c.blend_cells, c.fib_phi, 0.0, 0.0];
        u
    }
    /// Encode the pending update: 3 dispatches in ONE compute pass (trace -> irr -> depth; wgpu inserts the storage barriers), then copy both atlases into the
    /// textures forward.wgsl samples. Returns the forward `Gi` params to write once the copy is recorded (None = nothing pending).
    pub(crate) fn encode(&mut self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, irr_tex: &wgpu::Texture, depth_tex: &wgpu::Texture) -> Result<Option<Vec<f32>>, String> {
        let Some(p) = self.pending.take() else { return Ok(None) };
        let f = &p.frame;
        let n = self.cfg.cascades.len();
        let (mut cum, mut start) = ([0u32; 4], [0u32; 4]);
        let mut acc = 0u32;
        for k in 0..GI_MAX_CASCADES {
            if k < n { acc += f[GF_COUNTS + k].max(0.0) as u32; start[k] = f[GF_STARTS + k].max(0.0) as u32; }
            cum[k] = acc; // beyond the last cascade the cumulative stays at the total (gi-open-nodes setBatch)
        }
        if acc > self.cfg.max_batch { return Err(format!("giComputeStep: batch {acc} probes > maxBatchProbes {}", self.cfg.max_batch)); }
        let u = self.uniform_for(f, acc, cum, start);
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
        if acc > 0 {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("gaia-render gi"), timestamp_writes: None });
            pass.set_bind_group(0, &self.bind, &[]);
            let dispatch = |pass: &mut wgpu::ComputePass<'_>, pipe: &wgpu::ComputePipeline, threads: u32| {
                let g = threads.div_ceil(WORKGROUP);
                pass.set_pipeline(pipe);
                pass.dispatch_workgroups(g.min(65535), g.div_ceil(65535), 1); // wgsl linear_id = x + y * num_workgroups.x * 64
            };
            dispatch(&mut pass, &self.trace, u.cnt[0]);
            dispatch(&mut pass, &self.irr_blend, u.cnt[1]); // irr BEFORE depth (irr reads the depth fresh-sentinel)
            dispatch(&mut pass, &self.depth_blend, u.cnt[2]);
            drop(pass);
        }
        let mut copy = |src: &wgpu::Buffer, dst: &wgpu::Texture, rows: u32, bpt: u32| {
            encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo { buffer: src, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(GI_TEX_WIDTH * bpt), rows_per_image: None } },
                dst.as_image_copy(),
                wgpu::Extent3d { width: GI_TEX_WIDTH, height: rows, depth_or_array_layers: 1 },
            );
        };
        copy(&self.irr, irr_tex, self.irr_rows, 16);
        copy(&self.depth, depth_tex, self.depth_rows, 8);
        self.steps += 1;
        self.dispatched_probes += acc as u64;
        Ok(Some(self.forward_params(f)))
    }
}
