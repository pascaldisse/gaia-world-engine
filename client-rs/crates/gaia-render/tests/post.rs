//! r10 post chain on a real device (Metal): three r180 tone-map operators + exposure + BloomNode math.
//! Operator expectations = PIXELS THREE ITSELF PRODUCED (tools/render-wasm/r10-post.html, three r180 WebGPURenderer, scene.background = linear HDR colour,
//! renderer.toneMapping/Exposure per row) -> known input -> three output (+-1 for rounding). Bloom expectation = BloomNode formula evaluated on a constant field.
use gaia_render::*;

fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}
const S: u32 = 64;
fn shoot(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore) -> Vec<u8> {
    let out = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: S, height: S, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
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
    px
}
fn px(p: &[u8], x: u32, y: u32) -> [u8; 3] {
    let i = ((y * S + x) * 4) as usize;
    [p[i + 2], p[i + 1], p[i]] // BGRA -> RGB
}
fn hdr_core(device: &wgpu::Device, queue: &wgpu::Queue, tone: u32, exposure: f32) -> RenderCore {
    let mut o = RenderOptions::default();
    o.render_height = S;
    o.hdr_scene = true;
    o.tone_mapping = tone;
    o.exposure = exposure;
    RenderCore::new(device, queue, o)
}
fn close(a: [u8; 3], b: [u8; 3], tol: i32) -> bool { (0..3).all(|i| (a[i] as i32 - b[i] as i32).abs() <= tol) }
fn srgb(l: f32) -> f32 { let l = l.clamp(0.0, 1.0); if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 } }

/// (three constant, exposure, linear input, pixel three r180 rendered) — captured from r10-post.html (`.scratch/r10/post.json` rows A).
const THREE: &[(u32, f32, [f32; 3], [u8; 3])] = &[
    (2, 1.0, [0.18, 0.18, 0.18], [109, 109, 109]),
    (2, 1.0, [4.0, 2.0, 0.5], [231, 213, 156]),
    (2, 0.6, [0.02, 0.05, 0.4], [28, 48, 122]),
    (3, 1.0, [0.18, 0.18, 0.18], [131, 131, 131]),
    (3, 1.0, [4.0, 2.0, 0.5], [244, 233, 188]),
    (3, 0.6, [0.02, 0.05, 0.4], [7, 36, 148]),
    (4, 1.0, [0.18, 0.18, 0.18], [128, 128, 128]),
    (4, 1.0, [4.0, 2.0, 0.5], [252, 243, 217]),
    (4, 1.0, [0.02, 0.05, 0.4], [0, 51, 179]),
    (4, 0.6, [0.18, 0.18, 0.18], [92, 92, 92]),
    (4, 0.6, [4.0, 2.0, 0.5], [248, 233, 192]),
    (6, 1.0, [0.18, 0.18, 0.18], [128, 128, 128]),
    (6, 1.0, [4.0, 2.0, 0.5], [242, 223, 195]),
    (6, 1.0, [0.02, 0.05, 0.4], [48, 93, 175]),
    (6, 0.6, [4.0, 2.0, 0.5], [232, 208, 173]),
    (7, 1.0, [0.18, 0.18, 0.18], [105, 105, 105]),
    (7, 1.0, [4.0, 2.0, 0.5], [253, 209, 166]),
    (7, 1.0, [0.02, 0.05, 0.4], [8, 50, 166]),
    (7, 0.6, [4.0, 2.0, 0.5], [251, 197, 138]),
];

#[test]
fn tone_map_operators_match_three_pixels() {
    let (device, queue) = device();
    for &(mode, ex, c, want) in THREE {
        let mut core = hdr_core(&device, &queue, 2, 1.0);
        core.set_tone_mapping(mode).unwrap();
        core.set_exposure(ex);
        core.set_background_color(c); // HDR mode: raw linear clear -> post resolve tone-maps (three tone-maps its background)
        let got = px(&shoot(&device, &queue, &mut core), 32, 32);
        assert!(close(got, want, 1), "mode {mode} exposure {ex} input {c:?}: got {got:?} three {want:?}");
    }
}

#[test]
fn no_tone_mapping_and_unsupported_constants() {
    let (device, queue) = device();
    let mut core = hdr_core(&device, &queue, 2, 1.0);
    assert!(core.set_tone_mapping(5).is_err(), "CustomToneMapping must be refused loudly");
    assert!(core.set_tone_mapping(99).is_err());
    core.set_tone_mapping(0).unwrap(); // three NoToneMapping: raw linear -> sRGB, exposure NOT applied
    core.set_exposure(0.5);
    core.set_background_color([0.2, 0.2, 0.2]);
    let got = px(&shoot(&device, &queue, &mut core), 10, 10);
    let want = (srgb(0.2) * 255.0).round() as u8;
    assert!(got.iter().all(|&g| (g as i32 - want as i32).abs() <= 1), "got {got:?} want {want}");
    // legacy core (no hdr_scene) refuses post setters
    let mut legacy = RenderCore::new(&device, &queue, RenderOptions { render_height: S, ..Default::default() });
    assert!(legacy.set_tone_mapping(4).is_err() && legacy.set_bloom(Some(BloomParams::new(1.0, 0.0, 0.0))).is_err());
}

/// BloomNode on a constant HDR field c (clamp-to-edge => every blur returns c * S_k, S_k = c0 + 2 sum_{i=1}^{k-1} c_i; sigma = k/3, c_i = 0.39894 exp(-.5 i^2/sigma^2)/sigma):
/// bloom = strength * sum_m lerp(f_m, radius) * S_{k_m} * c  (bright pass keeps c when luminance >> threshold), out = Reinhard(c + bloom).
fn blur_sum(k: f32) -> f32 {
    let sigma = k / 3.0;
    let w = |i: f32| 0.39894 * (-0.5 * i * i / (sigma * sigma)).exp() / sigma;
    let mut s = w(0.0);
    let mut i = 1.0;
    while i < k { s += 2.0 * w(i); i += 1.0; }
    s
}
#[test]
fn bloom_matches_three_bloomnode_formula_on_constant_field() {
    let (device, queue) = device();
    let (strength, radius, threshold) = (0.35f32, 0.4f32, 0.85f32);
    let c = 2.0f32;
    let mut core = hdr_core(&device, &queue, 2, 1.0);
    core.set_bloom(Some(BloomParams::new(strength, radius, threshold))).unwrap();
    core.set_background_color([c, c, c]);
    let got = px(&shoot(&device, &queue, &mut core), 32, 32);
    let kernels = [6.0f32, 10.0, 14.0, 18.0, 22.0];
    let factors = [1.0f32, 0.8, 0.6, 0.4, 0.2];
    let bloom: f32 = (0..5).map(|m| (factors[m] + (1.2 - factors[m] - factors[m]) * radius) * blur_sum(kernels[m]) * c).sum::<f32>() * strength;
    let x = c + bloom;
    let want = (srgb(x / (1.0 + x)) * 255.0).round() as u8;
    assert!(got.iter().all(|&g| (g as i32 - want as i32).abs() <= 2), "got {got:?} want {want} (bloom term {bloom})");
    // same field below threshold: high pass = 0 -> no bloom at all
    let mut core = hdr_core(&device, &queue, 2, 1.0);
    core.set_bloom(Some(BloomParams::new(strength, radius, threshold))).unwrap();
    let c2 = 0.5f32;
    core.set_background_color([c2, c2, c2]);
    let low = px(&shoot(&device, &queue, &mut core), 32, 32);
    let want_low = (srgb(c2 / (1.0 + c2)) * 255.0).round() as u8;
    assert!(low.iter().all(|&g| (g as i32 - want_low as i32).abs() <= 1), "below threshold must not bloom: got {low:?} want {want_low}");
    // bloom off (None) == plain tone map
    let mut core = hdr_core(&device, &queue, 2, 1.0);
    core.set_background_color([c, c, c]);
    let off = px(&shoot(&device, &queue, &mut core), 32, 32);
    let want_off = (srgb(c / (1.0 + c)) * 255.0).round() as u8;
    assert!(off.iter().all(|&g| (g as i32 - want_off as i32).abs() <= 1), "bloom off: got {off:?} want {want_off}");
}
