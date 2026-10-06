//! r10 post-chain GPU bench (headless, Metal/native). Prints median/min GPU ms of the post chain (high pass + 5-mip blur + resolve) via its own timestamp pair,
//! plus scene/total ms with the HDR path on vs the legacy per-fragment path. env: GAIA_HEIGHT (720), GAIA_FRAMES (120), GAIA_TONE (4 = ACES).
use gaia_render::*;

fn env<T: std::str::FromStr>(k: &str, d: T) -> T {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn med(v: &mut Vec<f64>) -> f64 { v.sort_by(|a, b| a.total_cmp(b)); v[v.len() / 2] }

fn run(device: &wgpu::Device, queue: &wgpu::Queue, hdr: bool, bloom: bool, h: u32, frames: usize, tone: u32) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let w = h * 16 / 9;
    let mut o = RenderOptions::default();
    o.render_height = h; o.hdr_scene = hdr; o.tone_mapping = tone;
    let mut core = RenderCore::new(device, queue, o);
    if hdr { core.set_bloom(bloom.then(|| BloomParams::new(0.35, 0.4, 0.85))).unwrap(); }
    // a few lit quads so the forward pass has work
    core.create_material(device, 1, MaterialDesc { base_color: [0.6, 0.5, 0.4, 1.0], metallic: 0.0, roughness: 0.8, base_color_texture: None, alpha_cutoff: None, emissive: [2.0, 1.5, 1.0], emissive_from_base: false });
    let s = 4.0;
    core.create_mesh(device, 1, &[-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s], &[0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.], &[0.0; 8], &[0, 2, 1, 0, 3, 2]).unwrap();
    core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
    core.set_camera(glam::Mat4::look_at_rh(glam::Vec3::new(0.0, 6.0, 0.01), glam::Vec3::ZERO, glam::Vec3::Z).inverse().to_cols_array(), 50f32.to_radians(), 0.1, Some(100.0));
    let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let view = out.create_view(&Default::default());
    let (mut post, mut scene, mut total) = (vec![], vec![], vec![]);
    for i in 0..frames + 10 {
        let mut enc = device.create_command_encoder(&Default::default());
        core.render(device, queue, &mut enc, &view, UpscaleSize { width: w, height: h });
        core.encode_timing_readback(&mut enc);
        core.encode_post_timing_readback(&mut enc);
        queue.submit(Some(enc.finish()));
        let t = core.read_timings_blocking(device);
        let p = if hdr { core.read_post_ms_blocking(device) } else { None };
        if i >= 10 {
            if let Some(t) = t { scene.push(t.scene_ms); total.push(t.total_ms); }
            if let Some(p) = p { post.push(p); }
        }
    }
    (post, scene, total)
}

fn main() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    let feats = adapter.features() & RenderCore::OPTIONAL_FEATURES;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: feats, ..Default::default() })).expect("device");
    let h: u32 = env("GAIA_HEIGHT", 720);
    let frames: usize = env("GAIA_FRAMES", 120);
    let tone: u32 = env("GAIA_TONE", 4);
    eprintln!("adapter {:?}  internal {}x{}  frames {frames}  tone {tone}", adapter.get_info().name, h * 16 / 9, h);
    println!("| path | post ms med | post ms min | scene ms med | total ms med |");
    println!("|---|---|---|---|---|");
    for (name, hdr, bloom) in [("legacy per-fragment Reinhard (no post)", false, false), ("HDR + tone map only", true, false), ("HDR + bloom(5 mips) + tone map", true, true)] {
        let (mut p, mut s, mut t) = run(&device, &queue, hdr, bloom, h, frames, tone);
        let pm = if p.is_empty() { (f64::NAN, f64::NAN) } else { (med(&mut p), p[0]) };
        println!("| {name} | {:.3} | {:.3} | {:.3} | {:.3} |", pm.0, pm.1, med(&mut s), med(&mut t));
    }
}
