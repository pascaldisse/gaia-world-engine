//! r12-water: a three-material package sampling a texture_cube returns the face colour for each of the 6 axis directions (+X -X +Y -Y +Z -Z), mips included.
use gaia_render::*;
use std::collections::HashMap;

fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}
const FACES: [[u8; 4]; 6] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255], [255, 0, 255, 255], [0, 255, 255, 255]];
fn pkg(dir: [f32; 3]) -> String {
    let vs = "struct U { cameraProjectionMatrix: mat4x4<f32>, cameraViewMatrix: mat4x4<f32>, modelWorldMatrix: mat4x4<f32> };\n@group(0) @binding(0) var<uniform> u: U;\nstruct VO { @builtin(position) pos: vec4<f32> };\n@vertex fn main(@location(0) position: vec3<f32>) -> VO { var o: VO; o.pos = u.cameraProjectionMatrix * u.cameraViewMatrix * u.modelWorldMatrix * vec4<f32>(position, 1.0); return o; }";
    let fs = "struct F { dir: vec4<f32> };\n@group(0) @binding(1) var<uniform> f: F;\n@group(0) @binding(2) var envTex: texture_cube<f32>;\n@group(0) @binding(3) var envSampler: sampler;\n@fragment fn main() -> @location(0) vec4<f32> { return textureSample(envTex, envSampler, f.dir.xyz); }";
    serde_json::json!({
        "vertex": vs, "fragment": fs, "vertexEntry": "main", "fragmentEntry": "main",
        "bindGroups": [{ "group": 0, "bindings": [
            { "binding": 0, "uniforms": [{ "name": "modelWorldMatrix", "semantic": "modelWorldMatrix" }] },
            { "binding": 1, "uniforms": [{ "name": "dir", "value": [dir[0], dir[1], dir[2], 0.0] }] },
            { "binding": 2, "name": "envTex", "kind": "texture-cube" }, { "binding": 3, "name": "envSampler", "kind": "sampler" } ] }],
        "attributes": [{ "name": "position", "location": 0, "type": "vec3" }],
        "material": { "side": 2 }
    }).to_string()
}
fn render(core: &mut RenderCore, device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32) -> Vec<u8> {
    let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let view = out.create_view(&Default::default());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(device, queue, &mut enc, &view, UpscaleSize { width: w, height: h });
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (w * h * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    if let Some(err) = pollster::block_on(scope.pop()) { panic!("validation: {err}") }
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
    px
}
#[test]
fn cube_sampled_in_six_directions_returns_face_colours() {
    let (device, queue) = device();
    let size = 128u32;
    let mut opts = RenderOptions::default();
    opts.render_height = size;
    let mut core = RenderCore::new(&device, &queue, opts);
    core.create_mesh(&device, 1, &[-1., -1., 0., 1., -1., 0., 1., 1., 0., -1., 1., 0.], &[0., 0., 1.].repeat(4), &[0.; 8], &[0, 1, 2, 0, 2, 3]).unwrap();
    core.set_camera(glam::Mat4::from_translation(glam::Vec3::new(0., 0., 1.5)).to_cols_array(), 90f32.to_radians(), 0.1, Some(100.0));
    // 4x4 faces, face k = solid FACES[k] (mips of a solid face stay solid)
    let n = 4usize;
    let faces: Vec<u8> = FACES.iter().flat_map(|c| c.repeat(n * n)).collect();
    core.create_texture_cube(&device, &queue, 50, n as u32, &faces, false).unwrap();
    let dirs: [[f32; 3]; 6] = [[1., 0., 0.], [-1., 0., 0.], [0., 1., 0.], [0., -1., 0.], [0., 0., 1.], [0., 0., -1.]];
    for (k, d) in dirs.iter().enumerate() {
        let mut names = HashMap::new();
        names.insert("envTex".to_string(), 50u32);
        core.create_three_material(&device, 10, &pkg(*d), names).unwrap();
        core.create_instance(100, 1, 10, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        let px = render(&mut core, &device, &queue, size, size);
        let o = ((size / 2 * size + size / 2) * 4) as usize; let c = [px[o + 2], px[o + 1], px[o]]; let c = &c[..]; // BGRA
        let want = &FACES[k][..3];
        assert!(c.iter().zip(want).all(|(a, b)| (*a as i32 - *b as i32).abs() <= 3), "dir {d:?}: got {c:?} want {want:?}");
    }
    // unbound / missing cube id → white fallback, never a validation error
    let mut names = HashMap::new();
    names.insert("envTex".to_string(), 999u32);
    core.create_three_material(&device, 10, &pkg([1., 0., 0.]), names).unwrap();
    let px = render(&mut core, &device, &queue, size, size);
    assert_eq!(&px[((size / 2 * size + size / 2) * 4) as usize..][..3], &[255u8, 255, 255]);
    // bad upload sizes are loud
    assert!(core.create_texture_cube(&device, &queue, 51, 4, &faces[..10], false).is_err());
}
