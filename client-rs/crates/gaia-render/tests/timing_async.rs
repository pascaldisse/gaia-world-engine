//! request_timings_async: one sample in flight, never a copy into a mapped buffer, values arrive after poll.
use gaia_render::*;
use std::sync::{Arc, Mutex};

#[test]
fn async_timestamp_readback() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    let feats = adapter.features() & RenderCore::OPTIONAL_FEATURES;
    if !feats.contains(wgpu::Features::TIMESTAMP_QUERY) { eprintln!("skip: adapter has no TIMESTAMP_QUERY"); return; }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: feats, ..Default::default() })).expect("device");
    let mut opts = RenderOptions::default();
    opts.render_height = 256;
    let mut core = RenderCore::new(&device, &queue, opts);
    core.set_camera(glam::Mat4::IDENTITY.to_cols_array(), 1.0, 0.1, Some(100.0));
    let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: 256, height: 256, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
    let view = out.create_view(&Default::default());
    let got = Arc::new(Mutex::new(Vec::new()));
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let (mut encoded, mut requested) = (0, 0);
    for _ in 0..6 {
        let mut enc = device.create_command_encoder(&Default::default());
        core.render(&device, &queue, &mut enc, &view, UpscaleSize { width: 256, height: 256 });
        let e = core.encode_timing_readback(&mut enc);
        queue.submit(Some(enc.finish()));
        if e { encoded += 1; let g = got.clone(); if core.request_timings_async(move |t| g.lock().unwrap().push(t)) { requested += 1; } }
        // no explicit poll between frames: a still-mapped readback must make encode skip (submit may complete maps itself)
    }
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    assert!(pollster::block_on(scope.pop()).is_none(), "validation error (copy into mapped buffer?)");
    let g = got.lock().unwrap();
    println!("TIMING-ASYNC encoded={encoded} requested={requested} results={:?}", *g);
    assert!(requested >= 1 && requested == encoded && g.len() == requested, "every encoded sample requested + delivered once");
    let t = g[0].expect("timings");
    assert!(t.scene_ms >= 0.0 && t.scene_ms < 1000.0 && t.total_ms >= t.scene_ms);
}
