//! r13-bc: block-compressed (BC1) textures end to end on a real device: known-colour blocks -> rendered pixel, on BOTH paths
//! (device WITH TEXTURE_COMPRESSION_BC = native BC upload; device WITHOUT = CPU decode to RGBA8, counted in bc_stats). Unlit raw so out = texel.
use gaia_render::*;

fn device(bc: bool) -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    let want = if bc { wgpu::Features::TEXTURE_COMPRESSION_BC } else { wgpu::Features::empty() };
    if !adapter.features().contains(want) { return None; }
    Some(pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: want, ..Default::default() })).expect("device"))
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


fn centre(px: &[u8]) -> [u8; 3] { let i = (32 * 64 + 32) * 4; [px[i + 2], px[i + 1], px[i]] }
/// 8x8 BC1 texture = 2x2 solid blocks: TL red, TR green, BL blue, BR white (stored top row first).
fn blocks() -> Vec<u8> {
    let b = |c0: u16| { let mut v = c0.to_le_bytes().to_vec(); v.extend([0u8; 6]); v };
    [b(0xF800), b(0x07E0), b(0x001F), b(0xFFFF)].concat()
}
/// unlit plane spanning uv [0,0.25]^2 (2x2 texels magnified over the screen -> mip 0); the centre pixel samples uv (0.125,0.125) = inside the top-left block.
fn scene(device: &wgpu::Device, queue: &wgpu::Queue, flip_y: bool, gl: u32) -> (RenderCore, Result<(), String>) {
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(device, queue, opts);
    let r = core.create_texture_compressed(device, queue, 77, gl, 8, 8, 1, &blocks(), true, flip_y);
    core.create_material(device, 1, MaterialDesc { base_color: [1.0; 4], metallic: 0.0, roughness: 1.0, base_color_texture: Some(77), alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    core.set_material_flags(device, 1, MaterialFlags { unlit: true, ..Default::default() });
    let s = 4.0;
    core.create_mesh(device, 1, &[-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s], &[0., 1., 0.].repeat(4), &[0.0, 0.0, 0.25, 0.0, 0.25, 0.25, 0.0, 0.25], &[0, 2, 1, 0, 3, 2]).unwrap();
    core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
    core.set_camera(glam::Mat4::look_at_rh(glam::Vec3::new(0.0, 6.0, 0.01), glam::Vec3::ZERO, glam::Vec3::Z).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    (core, r)
}
fn close(a: [u8; 3], b: [u8; 3]) -> bool { (0..3).all(|i| (a[i] as i32 - b[i] as i32).abs() <= 2) }

#[test]
fn bc1_texture_renders_known_colour_on_both_paths() {
    for bc in [false, true] {
        let Some((device, queue)) = device(bc) else { eprintln!("adapter lacks TEXTURE_COMPRESSION_BC: native path SKIPPED"); continue; };
        for (gl, name) in [(33776u32, "DXT1 rgb"), (33777, "DXT1 rgba")] {
            let (mut core, r) = scene(&device, &queue, false, gl);
            r.unwrap();
            let got = centre(&shoot(&device, &queue, &mut core));
            assert!(close(got, [255, 0, 0]), "bc={bc} {name}: TL block red expected, got {got:?}");
            if bc { assert_eq!(core.bc_stats[0], 1, "native upload counted"); } else { assert_eq!(core.bc_stats[1], 1, "CPU decode counted (no BC feature)"); assert_eq!(core.bc_stats[0], 0); }
        }
    }
}

#[test]
fn flip_y_swaps_top_and_bottom_blocks_on_both_paths() {
    for bc in [false, true] {
        let Some((device, queue)) = device(bc) else { continue; };
        let (mut core, r) = scene(&device, &queue, true, 33776);
        r.unwrap();
        let got = centre(&shoot(&device, &queue, &mut core));
        assert!(close(got, [0, 0, 255]), "bc={bc}: flipY puts the BL (blue) block on top, got {got:?}");
    }
}

#[test]
fn unsupported_format_and_bad_sizes_are_loud_errors_and_counted() {
    let Some((device, queue)) = device(false) else { return; };
    let (mut core, r) = scene(&device, &queue, false, 37808); // ASTC
    assert!(r.unwrap_err().contains("not supported"));
    assert!(core.create_texture_compressed(&device, &queue, 78, 33776, 8, 8, 1, &[0u8; 5], true, false).is_err());
    assert!(core.create_texture_compressed(&device, &queue, 79, 36492, 8, 8, 1, &blocks().repeat(2), true, false).is_err(), "BC7 without the feature has no CPU decoder -> refused");
    assert_eq!(core.bc_stats[5], 3);
}
