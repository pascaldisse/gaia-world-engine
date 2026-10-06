//! r6-scene on a real device: fog (three Fog/FogExp2), scene.environment SH9 diffuse IBL, scene.background Texture/Cube.
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


fn scene(device: &wgpu::Device, queue: &wgpu::Queue, with_plane: bool) -> RenderCore {
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(device, queue, opts);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 0.0);
    core.set_hemisphere_irradiance([0.0; 3], [0.0; 3]);
    if with_plane {
        core.create_material(device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
        let s = 4.0;
        core.create_mesh(device, 1, &[-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s], &[0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.], &[0.0; 8], &[0, 2, 1, 0, 3, 2]).unwrap();
        core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
    }
    // camera 6 m above looking straight down (view depth to the plane = 6)
    core.set_camera(glam::Mat4::look_at_rh(glam::Vec3::new(0.0, 6.0, 0.01), glam::Vec3::ZERO, glam::Vec3::Z).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core
}

#[test]
fn fog_linear_and_exp2_match_three() {
    let (device, queue) = device();
    let pi = std::f32::consts::PI;
    // base: flat E/pi = 1 -> lit colour 0.5 (albedo .5)
    let mut core = scene(&device, &queue, true);
    core.set_hemisphere_irradiance([pi; 3], [pi; 3]);
    let none = centre(&shoot(&device, &queue, &mut core));
    assert!(close(none, expect_rgb([0.5; 3]), 2), "no fog {none:?}");
    // THREE.Fog smoothstep(near, far, depth 6): far <= 6 -> fully fog colour (1,0,0); mix happens BEFORE exposure+Reinhard
    core.set_fog(1, [1.0, 0.0, 0.0], 0.0, 6.0, 0.0);
    let full = centre(&shoot(&device, &queue, &mut core));
    assert!(close(full, expect_rgb([1.0, 0.0, 0.0]), 2), "full fog {full:?}");
    // half: smoothstep(0, 12, 6) = 0.5 -> mix(0.5 grey, red, .5) = (.75,.25,.25)
    core.set_fog(1, [1.0, 0.0, 0.0], 0.0, 12.0, 0.0);
    let half = centre(&shoot(&device, &queue, &mut core));
    assert!(close(half, expect_rgb([0.75, 0.25, 0.25]), 2), "half fog {half:?}");
    // THREE.FogExp2: 1 - exp(-(d*depth)^2); density .1 depth 6 -> 1 - exp(-.36) = .3023
    core.set_fog(2, [0.0, 0.0, 1.0], 0.0, 0.0, 0.1);
    let f = 1.0 - (-0.36f32).exp();
    let e2 = centre(&shoot(&device, &queue, &mut core));
    assert!(close(e2, expect_rgb([0.5 * (1.0 - f), 0.5 * (1.0 - f), 0.5 * (1.0 - f) + f]), 2), "exp2 {e2:?}");
    core.set_fog(0, [0.0; 3], 0.0, 0.0, 0.0);
    assert!(close(centre(&shoot(&device, &queue, &mut core)), none, 1), "fog off restores");
}

#[test]
fn environment_sh_diffuse_matches_lambert() {
    let (device, queue) = device();
    let mut core = scene(&device, &queue, true);
    // band 0 only: E(n)/pi = Y00 * sh0 = 0.282095 * 3.5449 = 1.0 (uniform radiance L=1 convolved) -> 1.0 * albedo .5 * intensity
    let mut sh = [0.0f32; 27];
    sh[0] = 1.0 / 0.282095; sh[1] = 1.0 / 0.282095; sh[2] = 1.0 / 0.282095;
    core.set_environment_sh(&sh, 1.0).unwrap();
    let lit = centre(&shoot(&device, &queue, &mut core));
    assert!(close(lit, expect_rgb([0.5; 3]), 2), "env on {lit:?}");
    core.set_environment_sh(&sh, 0.5).unwrap();
    assert!(close(centre(&shoot(&device, &queue, &mut core)), expect_rgb([0.25; 3]), 2), "intensity .5");
    // directional band: sh[1] = y-term -> up-facing (n.y=1) gets E/pi = 0.488603*sh1.r
    let mut sh = [0.0f32; 27];
    sh[3] = 2.0 / 0.488603; // sh index 1, r
    core.set_environment_sh(&sh, 1.0).unwrap();
    let r = centre(&shoot(&device, &queue, &mut core));
    assert!(close(r, expect_rgb([1.0, 0.0, 0.0]), 2), "y band {r:?} (E/pi 2 * albedo .5 = 1.0 red)");
    core.clear_environment();
    assert!(close(centre(&shoot(&device, &queue, &mut core)), [0, 0, 0], 1), "env off -> black (ambient zero)");
    assert!(core.set_environment_sh(&[0.0; 5], 1.0).is_err());
}

#[test]
fn background_cube_and_texture_tonemapped() {
    let (device, queue) = device();
    let mut core = scene(&device, &queue, false);
    // camera looks straight down (-Y): centre pixel dir = (0,-1,0) = cube face index 3; faces 6 x 2x2 RGBA8
    let mut faces = vec![0u8; 6 * 2 * 2 * 4];
    for f in 0..6 { for p in 0..4 { let i = (f * 4 + p) * 4; let v = if f == 3 { [128, 0, 0, 255] } else { [0, (f * 40) as u8, 255, 255] }; faces[i..i + 4].copy_from_slice(&v); } }
    core.set_background_cube(&device, &queue, 2, &faces, false, 1.0).unwrap();
    let c = centre(&shoot(&device, &queue, &mut core));
    let want = expect_rgb([128.0 / 255.0, 0.0, 0.0]);
    assert!(close(c, want, 2), "cube -Y face {c:?} want {want:?}");
    // screen-aligned 2D texture, sRGB-tagged 200 grey -> linear 0.578 -> Reinhard
    core.set_background_texture(&device, &queue, 2, 2, &[200u8; 16], true, false, 1.0).unwrap();
    let l = ((200.0f32 / 255.0 + 0.055) / 1.055).powf(2.4);
    let t = centre(&shoot(&device, &queue, &mut core));
    assert!(close(t, expect_rgb([l; 3]), 2), "2D {t:?}");
    // equirect straight down -> bottom row; rows top-first: top row red, bottom row green
    let px = [255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255];
    core.set_background_texture(&device, &queue, 2, 2, &px, false, true, 1.0).unwrap();
    let e = centre(&shoot(&device, &queue, &mut core));
    assert!(e[1] > e[0] + 40, "equirect looking down must see the bottom (green) row: {e:?}");
    // colour background replaces the texture
    core.set_background_color([0.2, 0.2, 0.2]);
    assert!(close(centre(&shoot(&device, &queue, &mut core)), expect_rgb([0.2; 3]), 2));
}
