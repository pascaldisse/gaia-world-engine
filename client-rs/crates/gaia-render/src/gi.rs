//! r6: engine probe-GI (client/kernel/gi, GI-PROBES.md v2 open mode) sampled by forward.wgsl.
//! The three side owns the probe update (compute); the host reads its irradiance/depth atlases back (async, periodic) and hands
//! the raw f32 arrays here. Atlases are flat probe-major arrays: texel index = probeIdx * res^2 + octTexel. They are uploaded as
//! 2D textures W=GI_TEX_WIDTH wide (index -> (i % W, i / W)); forward.wgsl reads them with textureLoad (no filtering = exact texels).
//!   irradiance: three `instancedArray(n,'vec3')` = WGSL array<vec3<f32>> = 16 B stride  -> Rgba32Float, 4 f32 / texel
//!   depth     : `instancedArray(n,'vec2')` (mean, mean^2)                              ->  Rg32Float,   2 f32 / texel
use bytemuck::{Pod, Zeroable};

pub const GI_TEX_WIDTH: u32 = 4096;
pub const GI_MAX_CASCADES: usize = 4;

/// params floats: [cascadeCount, blendCells, irradianceRes, depthRes, mode(0 add / 1 replace), 0,0,0] ++ per cascade 8 f32:
/// [baseCell.xyz, spacing, dims.xyz, baseIndex]  (cascade.js buildCascades / GIOpen.baseCells snapshot taken WITH the readback)
pub const GI_PARAM_HEADER: usize = 8;
pub const GI_PARAM_CASCADE: usize = 8;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(crate) struct GiUniform {
    /// x cascade count (0 = GI off), y blendCells, z irradianceRes, w depthRes
    info: [f32; 4],
    /// x irradiance tex width, y depth tex width, z mode (0 add, 1 replace), w unused
    tex: [u32; 4],
    /// per cascade: [baseCell.xyz, spacing], [dims.xyz, baseIndex]
    cas: [[f32; 8]; GI_MAX_CASCADES],
}

pub(crate) struct GiProbes {
    pub(crate) uniform: wgpu::Buffer,
    pub(crate) irr_view: wgpu::TextureView,
    pub(crate) depth_view: wgpu::TextureView,
    irr: wgpu::Texture,
    depth: wgpu::Texture,
    irr_rows: u32,
    depth_rows: u32,
    pub(crate) uploads: u32,
}

fn tex(device: &wgpu::Device, label: &str, format: wgpu::TextureFormat, rows: u32, width: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width, height: rows, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

pub(crate) fn layout_entries() -> [wgpu::BindGroupLayoutEntry; 3] {
    let t = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
        count: None,
    };
    [
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        },
        t(2),
        t(3),
    ]
}

impl GiProbes {
    /// GI off: 1x1 dummy textures, count 0.
    pub(crate) fn new(device: &wgpu::Device) -> Self {
        let u: GiUniform = Zeroable::zeroed();
        let uniform = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor { label: Some("gi uniform"), contents: bytemuck::bytes_of(&u), usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST });
        let irr = tex(device, "gi irradiance (dummy)", wgpu::TextureFormat::Rgba32Float, 1, 1);
        let depth = tex(device, "gi depth (dummy)", wgpu::TextureFormat::Rg32Float, 1, 1);
        Self { uniform, irr_view: irr.create_view(&Default::default()), depth_view: depth.create_view(&Default::default()), irr, depth, irr_rows: 0, depth_rows: 0, uploads: 0 }
    }

    pub(crate) fn clear(&mut self, queue: &wgpu::Queue) {
        let u: GiUniform = Zeroable::zeroed();
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
    }

    /// Returns true when the textures were (re)created (caller must rebuild the frame bind group).
    pub(crate) fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, irr: &[f32], depth: &[f32], params: &[f32]) -> Result<bool, String> {
        if params.len() < GI_PARAM_HEADER { return Err("setGiProbes: params header needs 8 floats".into()); }
        let n = params[0] as usize;
        if n == 0 || n > GI_MAX_CASCADES || params.len() < GI_PARAM_HEADER + n * GI_PARAM_CASCADE { return Err(format!("setGiProbes: bad cascade count {n} / params {}", params.len())); }
        let (irr_res, dep_res) = (params[2] as usize, params[3] as usize);
        if irr_res == 0 || dep_res == 0 || irr.len() % 4 != 0 || depth.len() % 2 != 0 { return Err("setGiProbes: bad atlas layout (irradiance = 4 f32/texel, depth = 2 f32/texel)".into()); }
        let total: usize = (0..n).map(|k| { let c = &params[GI_PARAM_HEADER + k * GI_PARAM_CASCADE..]; (c[4] * c[5] * c[6]) as usize }).sum();
        if irr.len() / 4 < total * irr_res * irr_res || depth.len() / 2 < total * dep_res * dep_res {
            return Err(format!("setGiProbes: atlas smaller than {total} probes x res"));
        }
        let rows = |texels: usize| ((texels as u32).div_ceil(GI_TEX_WIDTH)).max(1);
        let (ir, dr) = (rows(irr.len() / 4), rows(depth.len() / 2));
        let mut recreated = false;
        if ir != self.irr_rows || dr != self.depth_rows {
            self.irr = tex(device, "gi irradiance", wgpu::TextureFormat::Rgba32Float, ir, GI_TEX_WIDTH);
            self.depth = tex(device, "gi depth", wgpu::TextureFormat::Rg32Float, dr, GI_TEX_WIDTH);
            self.irr_view = self.irr.create_view(&Default::default());
            self.depth_view = self.depth.create_view(&Default::default());
            self.irr_rows = ir;
            self.depth_rows = dr;
            recreated = true;
        }
        write_padded(queue, &self.irr, irr, 4, ir);
        write_padded(queue, &self.depth, depth, 2, dr);
        let mut u: GiUniform = Zeroable::zeroed();
        u.info = [n as f32, params[1], params[2], params[3]];
        u.tex = [GI_TEX_WIDTH, GI_TEX_WIDTH, params[4] as u32, 0];
        for k in 0..n { u.cas[k].copy_from_slice(&params[GI_PARAM_HEADER + k * GI_PARAM_CASCADE..GI_PARAM_HEADER + (k + 1) * GI_PARAM_CASCADE]); }
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
        self.uploads += 1;
        Ok(recreated)
    }
}

fn write_padded(queue: &wgpu::Queue, t: &wgpu::Texture, data: &[f32], comps: usize, rows: u32) {
    let row_f32 = GI_TEX_WIDTH as usize * comps;
    let full = rows as usize * row_f32;
    let padded;
    let src: &[f32] = if data.len() >= full { &data[..full] } else { let mut v = vec![0.0f32; full]; v[..data.len()].copy_from_slice(data); padded = v; &padded };
    queue.write_texture(
        t.as_image_copy(),
        bytemuck::cast_slice(src),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some((row_f32 * 4) as u32), rows_per_image: None },
        wgpu::Extent3d { width: GI_TEX_WIDTH, height: rows, depth_or_array_layers: 1 },
    );
}
