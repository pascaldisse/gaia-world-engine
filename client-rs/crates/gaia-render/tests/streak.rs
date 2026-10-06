//! r9 streak: a long tall wall lit by a LOW sun, camera looking along the wall. The wall is one uniform Lambert surface and the
//! only caster is itself, so the expected lit value is uniform along/up the wall (three: same). Any step = shadow artefact
//! (cascade split / shadow-camera coverage / bias). Prints per-column min/mean/max of the wall pixels.
use gaia_render::*;
use glam::{Mat4, Vec3};
const W: u32 = 320;
const H: u32 = 160;
fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}
/// RGBA-ish luminance (0..255) per pixel, row-major W*H
fn shoot(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore) -> Vec<u8> {
    let out = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = out.create_view(&Default::default());
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(device, queue, &mut enc, &view, UpscaleSize { width: W, height: H });
    let bpr = W * 4; // 1280 = multiple of 256
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (bpr * H) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
    px.chunks(4).map(|p| ((p[0] as u32 + p[1] as u32 + p[2] as u32) / 3) as u8).collect()
}
const I: [f32; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
/// wall x=0, z in [-zlen, 8], y in [0, hgt], normal +x. Camera at x=cam_x looking along -z.
fn wall_scene(device: &wgpu::Device, queue: &wgpu::Queue, sun: [f32; 3], zlen: f32, hgt: f32, shadows: Option<ShadowOptions>) -> RenderCore {
    let mut opts = RenderOptions::default();
    opts.render_height = H;
    let mut core = RenderCore::new(device, queue, opts);
    if let Some(s) = shadows { core.set_shadow_options(device, s); }
    core.set_hemisphere_irradiance([0.0; 3], [0.0; 3]);
    core.set_sun(sun, [1.0, 1.0, 1.0], 3.0);
    core.create_material(device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    // wall, 2 tris, facing +x
    let pos = [0., 0., 8., 0., 0., -zlen, 0., hgt, -zlen, 0., hgt, 8.];
    let n = [1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0.];
    core.create_mesh(device, 1, &pos, &n, &[0.0; 8], &[0, 1, 2, 0, 2, 3]).unwrap();
    core.create_instance(1, 1, 1, I);
    // camera x=6,y=1.7 looking along -z, pitched up slightly; yfov 50deg
    let cam = Mat4::look_at_rh(Vec3::new(6.0, 1.7, 0.0), Vec3::new(4.0, 3.0, -30.0), Vec3::Y).inverse();
    core.set_camera(cam.to_cols_array(), 50f32.to_radians(), 0.1, Some(2000.0));
    core
}
/// per-column (min, max) over the wall pixels (those brighter than the black clear) in rows [y0,y1)
fn columns(px: &[u8], y0: u32, y1: u32) -> Vec<(u8, u8)> {
    (0..W).map(|x| {
        let v: Vec<u8> = (y0..y1).map(|y| px[(y * W + x) as usize]).filter(|&v| v > 4).collect();
        (v.iter().copied().min().unwrap_or(0), v.iter().copied().max().unwrap_or(0))
    }).collect()
}
fn report(label: &str, px: &[u8]) -> (u8, u8, u32) {
    let mut lo = 255u8; let mut hi = 0u8; let mut steps = 0u32;
    let mut last: Option<u8> = None;
    let cols = columns(px, H / 3, H * 2 / 3);
    let mut line = String::new();
    for (x, &(a, b)) in cols.iter().enumerate() {
        if b == 0 { continue; }
        lo = lo.min(a); hi = hi.max(b);
        if let Some(l) = last { if (b as i32 - l as i32).abs() > 6 { steps += 1; } }
        last = Some(b);
        if x % 16 == 0 { line += &format!("x{x}:{a}-{b} "); }
    }
    eprintln!("{label}: min {lo} max {hi} column-steps>6 {steps} | {line}");
    (lo, hi, steps)
}
/// worst per-pixel |ON - OFF| and the number of pixels differing by > 3
fn diff(a: &[u8], b: &[u8]) -> (i32, u32, (u32, u32)) {
    let mut worst = 0; let mut n = 0; let mut at = (0, 0);
    for (i, (&p, &q)) in a.iter().zip(b).enumerate() {
        let d = (p as i32 - q as i32).abs();
        if d > 3 { n += 1; }
        if d > worst { worst = d; at = (i as u32 % W, i as u32 / W); }
    }
    (worst, n, at)
}
#[test]
fn wall_lit_uniform_with_shadows_on() {
    // expected (three, no foreign casters) = shadows-OFF image: a single uniform Lambert wall. ON must match it per pixel.
    let (device, queue) = device();
    let mut bad = vec![];
    for (name, sun) in [
        ("low14 behind-cam", Vec3::new(-0.9, -0.25, -0.35)),
        ("low5 grazing", Vec3::new(-0.3, -0.03, -0.95)),
        ("low20 head-on", Vec3::new(-0.8, -0.35, 0.3)),
        ("low10 along", Vec3::new(-0.45, -0.08, -0.9)),
    ] {
        let s = sun.normalize().to_array();
        let mut on = wall_scene(&device, &queue, s, 600.0, 40.0, None);
        let a = shoot(&device, &queue, &mut on);
        let mut off = wall_scene(&device, &queue, s, 600.0, 40.0, Some(ShadowOptions { enabled: false, ..Default::default() }));
        let b = shoot(&device, &queue, &mut off);
        report(&format!("{name} ON "), &a);
        report(&format!("{name} OFF"), &b);
        let (worst, n, at) = diff(&a, &b);
        eprintln!("{name}: worst |ON-OFF| {worst} at {at:?}, pixels>3: {n}/{}", W * H);
        if n > 0 { bad.push(format!("{name}: worst {worst} at {at:?} n={n}")); }
    }
    assert!(bad.is_empty(), "shadow artefacts on a uniform wall: {bad:?}");
}

/// r9 S2 (CAUSE): three r180 WebGPU renders `shadowSide ?? side` into the shadow map (Renderer.js:2902) = FrontSide for a default material, so a single-sided
/// surface whose FRONT faces away from the sun casts NOTHING in three; the core caster pass is double-sided (cull None) and shadows anyway.
/// receiver y=0 facing up, caster quad y=2 straight above, sun straight down; centre pixel of the receiver.
fn caster_centre(device: &wgpu::Device, queue: &wgpu::Queue, caster_faces_sun: bool, cull_back: bool) -> u8 {
    let mut opts = RenderOptions::default();
    opts.render_height = H;
    let mut core = RenderCore::new(device, queue, opts);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 3.0);
    core.set_hemisphere_irradiance([0.0; 3], [0.0; 3]);
    for id in [1, 2] {
        core.create_material(device, id, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    }
    let s = 4.0;
    core.create_mesh(device, 1, &[-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s], &[0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.], &[0.0; 8], &[0, 2, 1, 0, 3, 2]).unwrap();
    core.create_instance(1, 1, 1, I);
    core.set_instance_cast_shadow(1, false);
    let c = 1.0;
    let (n, idx): (f32, [u32; 6]) = if caster_faces_sun { (1.0, [0, 2, 1, 0, 3, 2]) } else { (-1.0, [0, 1, 2, 0, 2, 3]) };
    core.create_mesh(device, 2, &[-c, 2., -c, c, 2., -c, c, 2., c, -c, 2., c], &[0., n, 0., 0., n, 0., 0., n, 0., 0., n, 0.], &[0.0; 8], &idx).unwrap();
    core.create_instance(2, 2, 2, I);
    core.set_instance_cast_shadow(2, true);
    if cull_back { core.set_material_shadow_cull_back(2, true); }
    core.set_camera(Mat4::look_at_rh(Vec3::new(5.0, 1.0, 0.0), Vec3::ZERO, Vec3::Y).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    let px = shoot(device, queue, &mut core);
    px[((H / 2) * W + W / 2) as usize]
}
#[test]
fn single_sided_caster_facing_away_from_sun_casts_nothing_like_three() {
    let (device, queue) = device();
    let facing_away_double = caster_centre(&device, &queue, false, false);
    let facing_away_front_only = caster_centre(&device, &queue, false, true);
    let facing_sun_front_only = caster_centre(&device, &queue, true, true);
    eprintln!("away/double-sided {facing_away_double} | away/FrontSide(cull back) {facing_away_front_only} | facing-sun/FrontSide {facing_sun_front_only}");
    assert!(facing_away_double < 40, "double-sided caster must still shadow ({facing_away_double})");
    assert!(facing_sun_front_only < 40, "sun-facing FrontSide caster must shadow ({facing_sun_front_only})");
    assert!(facing_away_front_only > 100, "FrontSide caster facing away from the sun must NOT shadow (three): got {facing_away_front_only}");
}
