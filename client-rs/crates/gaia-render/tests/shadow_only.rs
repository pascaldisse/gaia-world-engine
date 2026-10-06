//! r6 lighting on a real device: hemisphere/ambient irradiance (three r180 units) + clear colour = scene.background.
//! Expected values are computed from three's math: out = Reinhard(E/PI * albedo * (1-metal) * exposure) -> sRGB encode (target is *Srgb).
use gaia_render::*;

pub fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}

/// render 64x64, return BGRA8 bytes (sRGB-encoded)
fn shoot(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore) -> Vec<u8> {
    let size = 64u32;
    let out = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = out.create_view(&Default::default());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(device, queue, &mut enc, &view, UpscaleSize { width: size, height: size });
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (size * size * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size * 4), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    if let Some(err) = pollster::block_on(scope.pop()) { panic!("validation: {err}") }
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
    px
}

fn centre(px: &[u8]) -> [u8; 3] {
    let i = (32 * 64 + 32) * 4;
    [px[i + 2], px[i + 1], px[i]] // BGRA -> RGB
}

fn srgb(l: f32) -> f32 {
    let l = l.clamp(0.0, 1.0);
    if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 }
}

fn expect_rgb(linear_e: [f32; 3]) -> [u8; 3] {
    let f = |e: f32| (srgb(e / (1.0 + e)) * 255.0).round() as u8;
    [f(linear_e[0]), f(linear_e[1]), f(linear_e[2])]
}

fn close(a: [u8; 3], b: [u8; 3], tol: i32) -> bool {
    (0..3).all(|i| (a[i] as i32 - b[i] as i32).abs() <= tol)
}

/// quad in the XZ plane at y=0 facing +Y (normal up), camera `eye` looking at origin
fn plane_scene(device: &wgpu::Device, queue: &wgpu::Queue, metallic: f32, eye: glam::Vec3, normal_y: f32) -> RenderCore {
    plane_scene_at(device, queue, metallic, eye, normal_y, glam::Vec3::ZERO)
}

/// same, quad centred at `at` (camera looks at it)
/// same, quad centred at `at` (camera looks at it)
fn plane_scene_at(device: &wgpu::Device, queue: &wgpu::Queue, metallic: f32, eye: glam::Vec3, normal_y: f32, at: glam::Vec3) -> RenderCore {
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(device, queue, opts);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 0.0); // sun off: ambient only
    core.create_material(device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    let s = 4.0;
    let pos = [-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s];
    let n = [0., normal_y, 0., 0., normal_y, 0., 0., normal_y, 0., 0., normal_y, 0.];
    let idx: [u32; 6] = if normal_y > 0.0 { [0, 2, 1, 0, 3, 2] } else { [0, 1, 2, 0, 2, 3] };
    core.create_mesh(device, 1, &pos, &n, &[0.0; 8], &idx).unwrap();
    core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., at.x, at.y, at.z, 1.]);
    core.set_camera(glam::Mat4::look_at_rh(eye, at, glam::Vec3::Z).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core
}


/// r10-shadow: a SHADOW-ONLY caster (depth-only, never in the main passes) must shadow like a normal caster. `tall` adds a second shadow-only static caster with a huge world AABB (a baked proxy cell: spans hundreds of metres) far from the view — it must not break the cascade fit.
fn centre_with(device: &wgpu::Device, queue: &wgpu::Queue, occluder: bool, shadow_only: bool, tall: bool, is_static: bool) -> [u8; 3] {
    let mut core = plane_scene(device, queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 3.0);
    core.set_hemisphere_irradiance([0.0; 3], [0.0; 3]);
    core.set_instance_cast_shadow(1, false);
    core.create_material(device, 2, MaterialDesc { base_color: [0.1, 0.1, 0.1, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    if occluder {
        let s = 1.0;
        let pos = [-s, 2.0, -s, s, 2.0, -s, s, 2.0, s, -s, 2.0, s];
        let n = [0., -1., 0., 0., -1., 0., 0., -1., 0., 0., -1., 0.];
        core.create_mesh(device, 2, &pos, &n, &[0.0; 8], &[0, 1, 2, 0, 2, 3]).unwrap();
        core.create_instance(2, 2, 2, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        core.set_instance_cast_shadow(2, true);
        if is_static { core.set_instance_static(2, true); }
        if shadow_only { core.set_instance_shadow_only(2, true); }
    }
    if tall {
        let pos = [200.0, 0.0, 200.0, 220.0, 0.0, 200.0, 220.0, 280.0, 200.0, 200.0, 280.0, 200.0];
        let n = [0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1.];
        core.create_mesh(device, 3, &pos, &n, &[0.0; 8], &[0, 1, 2, 0, 2, 3]).unwrap();
        core.create_instance(3, 3, 2, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        core.set_instance_cast_shadow(3, true);
        core.set_instance_static(3, true);
        core.set_instance_shadow_only(3, true);
    }
    core.set_material_flags(device, 1, MaterialFlags::default());
    core.set_camera(glam::Mat4::look_at_rh(glam::Vec3::new(5.0, 1.0, 0.0), glam::Vec3::ZERO, glam::Vec3::Y).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    centre(&shoot(device, queue, &mut core))
}

#[test]
fn shadow_only_caster_shadows_like_a_normal_caster() {
    let (device, queue) = device();
    let lit = centre_with(&device, &queue, false, false, false, false);
    for is_static in [false, true] {
        let normal = centre_with(&device, &queue, true, false, false, is_static);
        let only = centre_with(&device, &queue, true, true, false, is_static);
        let only_tall = centre_with(&device, &queue, true, true, true, is_static);
        eprintln!("static={is_static}: lit {lit:?} normal {normal:?} shadow_only {only:?} shadow_only+tall {only_tall:?}");
        assert!(normal[0] < lit[0] / 2, "sanity: normal caster shadows ({normal:?} vs {lit:?})");
        assert!(close(only, normal, 6), "shadow-only caster must shadow like a normal one ({only:?} vs {normal:?})");
        assert!(close(only_tall, normal, 6), "a tall shadow-only AABB must not break the cascade fit ({only_tall:?} vs {normal:?})");
    }
}
