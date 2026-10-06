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
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(device, queue, opts);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 0.0); // sun off: ambient only
    core.create_material(device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3] });
    let s = 4.0;
    let pos = [-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s];
    let n = [0., normal_y, 0., 0., normal_y, 0., 0., normal_y, 0., 0., normal_y, 0.];
    let idx: [u32; 6] = if normal_y > 0.0 { [0, 2, 1, 0, 3, 2] } else { [0, 1, 2, 0, 2, 3] };
    core.create_mesh(device, 1, &pos, &n, &[0.0; 8], &idx).unwrap();
    core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
    core.set_camera(glam::Mat4::look_at_rh(eye, glam::Vec3::ZERO, glam::Vec3::Z).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core
}

#[test]
fn hemisphere_irradiance_matches_three_lambert() {
    let (device, queue) = device();
    let pi = std::f32::consts::PI;
    // up-facing plane seen from above: n.y = 1 -> weight 1 -> sky. E_sky = (2pi, pi, 0.5pi)  => shader term (E/pi * albedo 0.5) = (1, .5, .25)
    let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_hemisphere_irradiance([2.0 * pi, pi, 0.5 * pi], [0.1, 0.1, 0.1]);
    let up = centre(&shoot(&device, &queue, &mut core));
    let want = expect_rgb([1.0, 0.5, 0.25]);
    assert!(close(up, want, 2), "up-facing sky: got {up:?} want {want:?}");
    // ground: same quad flipped (normal -Y), seen from below: weight 0 -> ground colour E=(pi, pi, pi) -> (.5,.5,.5)... x albedo .5/1 = .25? E/pi*alb = 0.5
    let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, -6.0, 0.01), -1.0);
    core.set_hemisphere_irradiance([2.0 * pi, pi, 0.5 * pi], [pi, pi, pi]);
    let down = centre(&shoot(&device, &queue, &mut core));
    let want = expect_rgb([0.5, 0.5, 0.5]);
    assert!(close(down, want, 2), "down-facing ground: got {down:?} want {want:?}");
    // flat ambient (AmbientLight folded by the adapter: sky == ground)
    let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_hemisphere_irradiance([pi, pi, pi], [pi, pi, pi]);
    assert!(close(centre(&shoot(&device, &queue, &mut core)), expect_rgb([0.5; 3]), 2));
    // metallic = 1: three diffuseColor = albedo * (1 - metalness) = 0 -> no ambient diffuse (no env map)
    let mut core = plane_scene(&device, &queue, 1.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_hemisphere_irradiance([2.0 * pi; 3], [2.0 * pi; 3]);
    let m = centre(&shoot(&device, &queue, &mut core));
    assert!(m == [0, 0, 0], "metal ambient must be 0, got {m:?}");
}

#[test]
fn clear_colour_is_scene_background() {
    let (device, queue) = device();
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(&device, &queue, opts);
    core.set_camera(glam::Mat4::IDENTITY.to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core.set_clear_color([0.2, 0.4, 0.6, 1.0]);
    let px = centre(&shoot(&device, &queue, &mut core));
    let want = [(srgb(0.2) * 255.0).round() as u8, (srgb(0.4) * 255.0).round() as u8, (srgb(0.6) * 255.0).round() as u8];
    assert!(close(px, want, 1), "clear: got {px:?} want {want:?}");
}
