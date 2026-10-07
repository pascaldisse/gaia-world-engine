//! r12-post GTAO on a real device (Metal): src/gtao.wgsl is a line-for-line port of three r180 GTAONode (see header there).
//! Expectation (AO definition, not three pixels): an unoccluded flat plane keeps AO ~= 1 (ratio of frame colour with/without GTAO ~ 1); an inner corner darkens near the crease.
//! Ratio is taken per pixel on the SAME core/frame with `set_gtao(None)` vs `Some(..)` so lighting/tonemap cancel.
use gaia_render::*;
fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}
const S: u32 = 64;
fn shoot(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore) -> Vec<f32> {
    let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: S, height: S, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let view = out.create_view(&Default::default());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(device, queue, &mut enc, &view, UpscaleSize { width: S, height: S });
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (S * S * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(S * 4), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    if let Some(err) = pollster::block_on(scope.pop()) { panic!("validation: {err}") }
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
    px.chunks(4).map(|p| (p[0] as f32 + p[1] as f32 + p[2] as f32) / 3.0).collect()
}
fn scene(device: &wgpu::Device, queue: &wgpu::Queue, wall: bool) -> RenderCore {
    let mut o = RenderOptions::default();
    o.render_height = S;
    o.hdr_scene = true;
    o.tone_mapping = 1; // Linear: ratio of encoded frames ~ ratio of AO terms
    let mut core = RenderCore::new(device, queue, o);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 0.0);
    core.create_material(device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    let s = 100.0;
    core.create_mesh(device, 1, &[-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s], &[0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.], &[0.0; 8], &[0, 2, 1, 0, 3, 2]).unwrap();
    core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
    if wall { // inner corner: wall at z=-2 rising 0..4, facing +Z, meeting the floor at the crease (y=0, z=-2)
        let (x, z) = (6.0, -2.0);
        core.create_mesh(device, 2, &[-x, 0., z, x, 0., z, x, 4., z, -x, 4., z], &[0., 0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1.], &[0.0; 8], &[0, 1, 2, 0, 2, 3]).unwrap();
        core.create_instance(2, 2, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
    }
    core.set_camera(glam::Mat4::look_at_rh(glam::Vec3::new(0.0, 2.0, 3.0), glam::Vec3::new(0.0, 0.5, -2.0), glam::Vec3::Y).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core
}
fn params() -> GtaoParams { GtaoParams { radius: 1.0, ..GtaoParams::three_defaults() } }
fn ratios(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore) -> Vec<f32> {
    core.set_gtao(None).unwrap();
    let off = shoot(device, queue, core);
    core.set_gtao(Some(params())).unwrap();
    let on = shoot(device, queue, core);
    assert_eq!(core.gtao_dims(), Some((S, S)), "AO target built at resolutionScale 1");
    on.iter().zip(&off).map(|(a, b)| if *b > 8.0 { a / b } else { 1.0 }).collect()
}
#[test]
fn flat_plane_has_no_ao() {
    let (device, queue) = device();
    let mut core = scene(&device, &queue, false);
    let r = ratios(&device, &queue, &mut core);
    let mut min = 1.0f32;
    for y in 6..(S - 6) { for x in 6..(S - 6) { min = min.min(r[(y * S + x) as usize]); } }
    eprintln!("flat plane min on/off ratio over interior = {min:.3}");
    assert!(min > 0.93, "flat plane must stay ~unoccluded, min ratio {min}");
}
#[test]
fn inner_corner_darkens_near_crease_only() {
    let (device, queue) = device();
    let mut core = scene(&device, &queue, true);
    let r = ratios(&device, &queue, &mut core);
    let (mut min, mut minxy) = (1.0f32, (0, 0));
    for y in 4..(S - 4) { for x in 16..(S - 16) { let v = r[(y * S + x) as usize]; if v < min { min = v; minxy = (x, y); } } }
    eprintln!("inner corner min ratio {min:.3} at {minxy:?}");
    assert!(min < 0.85, "inner corner must darken, min ratio {min}");
    // far from the crease (top of the wall + near floor) stays ~1
    let top = r[(8 * S + 32) as usize];
    let near = r[((S - 6) * S + 32) as usize];
    eprintln!("top-of-wall ratio {top:.3} near-floor ratio {near:.3}");
    assert!(top > 0.93 && near > 0.93, "AO must be local to the crease");
}
