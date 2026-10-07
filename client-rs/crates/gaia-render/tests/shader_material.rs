//! External WGSL material path on a real device (Metal here). The built-in
//! tests/data/external_contract.wgsl (frozen r5 forward.wgsl) is fed in AS an external material = the TSL contract.
use gaia_render::*;

fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}

#[test]
fn external_wgsl_material_renders_and_bad_wgsl_is_err() {
    let (device, queue) = device();
    let mut core = RenderCore::new(&device, &queue, RenderOptions::default());
    let mut ubo = Vec::new();
    // Material = base_color, params, emissive, flags (r4: flags.x unlit; 0 = lit)
    for f in [1.0f32, 0.2, 0.2, 1.0, 0.0, 0.5, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] {
        ubo.extend_from_slice(&f.to_le_bytes());
    }
    let desc = ShaderMaterialDesc {
        wgsl: include_str!("data/external_contract.wgsl").into(),
        vertex_entry: "vs_main".into(),
        fragment_entry: "fs_main".into(),
        bindings: vec![
            MaterialBinding::Uniform { binding: 0, data: ubo, visibility_vertex: false },
            MaterialBinding::Texture { binding: 1, texture: 999 },
            MaterialBinding::Sampler { binding: 2 },
            MaterialBinding::Texture { binding: 3, texture: 999 }, // lightmap (round 2 added it to forward.wgsl; test predates)
        ],
    };
    core.create_shader_material(&device, 7, &desc).expect("valid external material");
    core.create_mesh(&device, 1, &[0., 0., -2., 1., 0., -2., 0., 1., -2.], &[0., 0., 1., 0., 0., 1., 0., 0., 1.], &[0.; 6], &[0, 1, 2]).unwrap();
    let mut id = glam_identity();
    id[0] = 1.0;
    core.create_instance(1, 1, 7, id);
    let out = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = out.create_view(&Default::default());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(&device, &queue, &mut enc, &view, UpscaleSize { width: 64, height: 64 });
    queue.submit(Some(enc.finish()));
    let e = pollster::block_on(scope.pop()); assert!(e.is_none(), "validation error: {e:?}");
    let bad = ShaderMaterialDesc { wgsl: "fn broken( {".into(), ..desc };
    assert!(core.create_shader_material(&device, 8, &bad).is_err());
}

fn glam_identity() -> [f32; 16] {
    [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
}
// r11-depth-2: external-WGSL pipeline follows material flags (same pipeline_state helper): colorWrite:false -> background only; flags set AFTER create rebuild the pipeline.
#[test]
fn external_wgsl_color_write_false_draws_no_colour() {
    let (device, queue) = device();
    let shoot = |after: bool, no_cw: bool| {
        let mut core = RenderCore::new(&device, &queue, RenderOptions::default());
        let mut ubo = Vec::new();
        for f in [1.0f32, 0.2, 0.2, 1.0, 0.0, 0.5, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] { ubo.extend_from_slice(&f.to_le_bytes()); }
        let desc = ShaderMaterialDesc {
            wgsl: include_str!("data/external_contract.wgsl").into(),
            vertex_entry: "vs_main".into(),
            fragment_entry: "fs_main".into(),
            bindings: vec![
                MaterialBinding::Uniform { binding: 0, data: ubo, visibility_vertex: false },
                MaterialBinding::Texture { binding: 1, texture: 999 },
                MaterialBinding::Sampler { binding: 2 },
                MaterialBinding::Texture { binding: 3, texture: 999 },
            ],
        };
        if !after { core.set_material_flags(&device, 7, MaterialFlags::default()); core.set_material_no_color_write(&device, 7, no_cw); }
        core.create_shader_material(&device, 7, &desc).expect("valid external material");
        if after { core.set_material_flags(&device, 7, MaterialFlags::default()); core.set_material_no_color_write(&device, 7, no_cw); }
        core.create_mesh(&device, 1, &[-1., -1., -2., 1., -1., -2., 0., 1., -2.], &[0., 0., 1., 0., 0., 1., 0., 0., 1.], &[0.; 6], &[0, 1, 2]).unwrap();
        core.create_instance(1, 1, 7, glam_identity());
        core.set_background_color([0.3; 3]);
        let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
        let view = out.create_view(&Default::default());
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut enc = device.create_command_encoder(&Default::default());
        core.render(&device, &queue, &mut enc, &view, UpscaleSize { width: 64, height: 64 });
        let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 64 * 64 * 4, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: None } }, out.size());
        queue.submit(Some(enc.finish()));
        let e = pollster::block_on(scope.pop()); assert!(e.is_none(), "validation error: {e:?}");
        rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
        // count pixels that differ from the corner (background) pixel
        let bg = [px[0], px[1], px[2]];
        px.chunks(4).filter(|p| [p[0], p[1], p[2]] != bg).count()
    };
    let control = shoot(true, false);
    assert!(control > 20, "control: external material draws colour ({control} px differ from background)");
    assert_eq!(shoot(false, true), 0, "colorWrite:false before create: nothing reaches the colour target");
    assert_eq!(shoot(true, true), 0, "colorWrite:false after create rebuilds the pipeline");
}
