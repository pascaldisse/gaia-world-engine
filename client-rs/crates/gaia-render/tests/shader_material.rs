//! External WGSL material path on a real device (Metal here). The built-in
//! forward.wgsl is fed back in AS an external material = the TSL contract.
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
    for f in [1.0f32, 0.2, 0.2, 1.0, 0.0, 0.5, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0] {
        ubo.extend_from_slice(&f.to_le_bytes());
    }
    let desc = ShaderMaterialDesc {
        wgsl: include_str!("../src/forward.wgsl").into(),
        vertex_entry: "vs_main".into(),
        fragment_entry: "fs_main".into(),
        bindings: vec![
            MaterialBinding::Uniform { binding: 0, data: ubo, visibility_vertex: false },
            MaterialBinding::Texture { binding: 1, texture: 999 },
            MaterialBinding::Sampler { binding: 2 },
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
    assert!(pollster::block_on(scope.pop()).is_none(), "validation error");
    let bad = ShaderMaterialDesc { wgsl: "fn broken( {".into(), ..desc };
    assert!(core.create_shader_material(&device, 8, &bad).is_err());
}

fn glam_identity() -> [f32; 16] {
    [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
}
