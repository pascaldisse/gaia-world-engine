//! scene.background Texture / CubeTexture (r6-scene). Colour backgrounds stay the clear colour (lib.rs set_background_color).
//! One fullscreen triangle at the start of the forward pass; bind group rebuilt only when the texture changes.
use crate::{DEPTH_FORMAT, INTERNAL_FORMAT};
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BgUniform {
    inv_vp: [[f32; 4]; 4],
    cam: [f32; 4],
    params: [f32; 4],
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BackgroundKind {
    Cube = 1,
    Equirect = 2,
    Screen = 3,
}

pub struct Background {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    uniform: wgpu::Buffer,
    sampler: wgpu::Sampler,
    dummy_cube: wgpu::TextureView,
    dummy_flat: wgpu::TextureView,
    cube: Option<wgpu::TextureView>,
    flat: Option<wgpu::TextureView>,
    bind: Option<wgpu::BindGroup>,
    pub kind: Option<BackgroundKind>,
    pub intensity: f32,
}

impl Background {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let tex_entry = |binding, dim| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: dim, multisampled: false },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gaia-render background"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                tex_entry(1, wgpu::TextureViewDimension::Cube),
                tex_entry(2, wgpu::TextureViewDimension::D2),
                wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("gaia-render background"), source: wgpu::ShaderSource::Wgsl(include_str!("background.wgsl").into()) });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("gaia-render background layout"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("gaia-render background"),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState { format: INTERNAL_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH_FORMAT, depth_write_enabled: Some(false), depth_compare: Some(wgpu::CompareFunction::Always), stencil: Default::default(), bias: Default::default() }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("background uniform"), contents: bytemuck::bytes_of(&<BgUniform as bytemuck::Zeroable>::zeroed()), usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("background sampler"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge, address_mode_w: wgpu::AddressMode::ClampToEdge, mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let dummy_cube = make_texture(device, queue, 1, 1, 6, true, false, &[255u8; 24]);
        let dummy_flat = make_texture(device, queue, 1, 1, 1, false, false, &[255u8; 4]);
        Self { pipeline, layout, uniform, sampler, dummy_cube, dummy_flat, cube: None, flat: None, bind: None, kind: None, intensity: 1.0 }
    }

    pub fn clear(&mut self) {
        self.kind = None;
        self.cube = None;
        self.flat = None;
        self.bind = None;
    }

    /// `faces` = 6 consecutive RGBA8 square images (+X -X +Y -Y +Z -Z, top row first), `size` px each.
    pub fn set_cube(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, size: u32, faces: &[u8], srgb: bool, intensity: f32) -> Result<(), String> {
        if faces.len() != (size * size * 4 * 6) as usize {
            return Err(format!("set_background_cube: {} bytes for 6x{size}x{size} RGBA", faces.len()));
        }
        self.cube = Some(make_texture(device, queue, size, size, 6, true, srgb, faces));
        self.flat = None;
        self.finish(device, BackgroundKind::Cube, intensity);
        Ok(())
    }

    /// `rgba` rows top-first. `equirect` = direction-mapped (three EquirectangularReflectionMapping), else screen-aligned 2D.
    pub fn set_flat(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, rgba: &[u8], srgb: bool, equirect: bool, intensity: f32) -> Result<(), String> {
        if rgba.len() != (w * h * 4) as usize {
            return Err(format!("set_background_texture: {} bytes for {w}x{h} RGBA", rgba.len()));
        }
        self.flat = Some(make_texture(device, queue, w, h, 1, false, srgb, rgba));
        self.cube = None;
        self.finish(device, if equirect { BackgroundKind::Equirect } else { BackgroundKind::Screen }, intensity);
        Ok(())
    }

    fn finish(&mut self, device: &wgpu::Device, kind: BackgroundKind, intensity: f32) {
        self.kind = Some(kind);
        self.intensity = intensity;
        self.bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("background bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(self.cube.as_ref().unwrap_or(&self.dummy_cube)) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(self.flat.as_ref().unwrap_or(&self.dummy_flat)) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        }));
    }

    /// per frame, before the pass: inverse view-projection + camera position + exposure.
    pub fn prepare(&self, queue: &wgpu::Queue, view_proj: glam::Mat4, cam: glam::Vec3, exposure: f32) {
        if self.kind.is_none() {
            return;
        }
        let u = BgUniform { inv_vp: view_proj.inverse().to_cols_array_2d(), cam: cam.extend(1.0).to_array(), params: [self.kind.map_or(0, |k| k as u32) as f32, self.intensity, exposure, 0.0] };
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
    }

    pub fn draw<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if let Some(b) = &self.bind {
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, b, &[]);
            pass.draw(0..3, 0..1);
        }
    }
}

fn make_texture(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, layers: u32, cube: bool, srgb: bool, data: &[u8]) -> wgpu::TextureView {
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: layers };
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("background"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: if srgb { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm },
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        data,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * w), rows_per_image: Some(h) },
        size,
    );
    tex.create_view(&wgpu::TextureViewDescriptor { dimension: Some(if cube { wgpu::TextureViewDimension::Cube } else { wgpu::TextureViewDimension::D2 }), ..Default::default() })
}
