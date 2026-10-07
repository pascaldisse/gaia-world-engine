//! r11-pipe: two three materials with identical WGSL/layout/state (different uniform VALUES) share ONE pipeline; pixels == unshared; draw order sort keeps pixels.
use gaia_render::*;
use std::collections::HashMap;

fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}
fn pkg(color: [f32; 4], transparent: bool) -> String {
    let vs = "struct U { cameraProjectionMatrix: mat4x4<f32>, cameraViewMatrix: mat4x4<f32>, modelWorldMatrix: mat4x4<f32> };\n@group(0) @binding(0) var<uniform> u: U;\nstruct VO { @builtin(position) pos: vec4<f32> };\n@vertex fn main(@location(0) position: vec3<f32>) -> VO { var o: VO; o.pos = u.cameraProjectionMatrix * u.cameraViewMatrix * u.modelWorldMatrix * vec4<f32>(position, 1.0); return o; }";
    let fs = "struct F { color: vec4<f32> };\n@group(0) @binding(1) var<uniform> f: F;\n@fragment fn main() -> @location(0) vec4<f32> { return f.color; }";
    serde_json::json!({
        "vertex": vs, "fragment": fs, "vertexEntry": "main", "fragmentEntry": "main",
        "bindGroups": [{ "group": 0, "bindings": [
            { "binding": 0, "uniforms": [{ "name": "modelWorldMatrix", "semantic": "modelWorldMatrix" }] },
            { "binding": 1, "uniforms": [{ "name": "color", "value": color }] } ] }],
        "attributes": [{ "name": "position", "location": 0, "type": "vec3" }],
        "material": { "side": 2, "transparent": transparent }
    }).to_string()
}
fn quad() -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<u32>) {
    (vec![-0.5, -0.5, 0., 0.5, -0.5, 0., 0.5, 0.5, 0., -0.5, 0.5, 0.], vec![0., 0., 1.].repeat(4), vec![0.; 8], vec![0, 1, 2, 0, 2, 3])
}
/// (pixels, distinct pipes stat, distinct keys stat, draws)
fn run(share: bool, mats: &[([f32; 4], bool)]) -> (Vec<u8>, u32, u32, u32) {
    let (device, queue) = device();
    let size = 128u32;
    let mut opts = RenderOptions::default();
    opts.render_height = size;
    opts.pipe_share = share;
    let mut core = RenderCore::new(&device, &queue, opts);
    let (p, n, t, i) = quad();
    core.create_mesh(&device, 1, &p, &n, &t, &i).unwrap();
    for (k, (c, tr)) in mats.iter().enumerate() {
        core.create_three_material(&device, 10 + k as u32, &pkg(*c, *tr), HashMap::new()).unwrap();
        let x = -0.6 + 0.6 * k as f32;
        core.create_instance(100 + k as u32, 1, 10 + k as u32, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., x, 0., -0.1 * k as f32, 1.]);
    }
    core.set_camera(glam::Mat4::from_translation(glam::Vec3::new(0., 0., 3.)).to_cols_array(), 50f32.to_radians(), 0.1, Some(100.0));
    let out = device.create_texture(&wgpu::TextureDescriptor {
        label: None, size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
    });
    let view = out.create_view(&Default::default());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(&device, &queue, &mut enc, &view, UpscaleSize { width: size, height: size });
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (size * size * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size * 4), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    if let Some(err) = pollster::block_on(scope.pop()) { panic!("validation: {err}") }
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
    let s = core.last_pass_stats;
    (px, s[7], s[11], s[5])
}
#[test]
fn same_wgsl_two_materials_share_one_pipeline_pixels_equal() {
    let mats = [([1., 0., 0., 1.], false), ([0., 1., 0., 1.], false)];
    let (a, pipes_a, keys_a, draws_a) = run(false, &mats);
    let (b, pipes_b, keys_b, draws_b) = run(true, &mats);
    println!("PIPE-SHARE unshared pipes={pipes_a} keys={keys_a} draws={draws_a} | shared pipes={pipes_b} keys={keys_b} draws={draws_b}");
    assert_eq!((draws_a, draws_b), (2, 2));
    assert_eq!((pipes_a, keys_a), (2, 1), "unshared: one pipeline per material, one content key");
    assert_eq!((pipes_b, keys_b), (1, 1), "shared: 2 materials -> 1 pipeline");
    assert_eq!(a, b, "pixels differ shared vs unshared");
    // both colours present (per-material uniform values stay per material)
    assert!(b.chunks(4).any(|c| c[2] > 200 && c[1] < 50), "red quad missing");
    assert!(b.chunks(4).any(|c| c[1] > 200 && c[2] < 50), "green quad missing");
}
#[test]
fn different_state_does_not_share() {
    let mats = [([1., 0., 0., 1.], false), ([0., 1., 0., 1.], true)];
    let (a, _, _, _) = run(false, &mats);
    let (b, pipes_b, keys_b, _) = run(true, &mats);
    assert_eq!((pipes_b, keys_b), (2, 2), "transparent vs opaque must not share");
    assert_eq!(a, b);
}
