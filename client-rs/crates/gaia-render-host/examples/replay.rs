//! Replay a captured command stream (bun tools/native-stream-dump.mjs) through the REAL decoder + a headless device.
//!   cargo run -p gaia-render-host --example replay -- <stream.bin> [message_bytes=777]
//! Messages are cut at arbitrary byte offsets on purpose (partial-command buffering). Prints each report, then renders one frame offscreen.
use gaia_render_host::{Host, device_descriptor};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: replay <stream.bin> [message_bytes]");
    let step: usize = a.next().map(|s| s.parse().expect("message_bytes")).unwrap_or(777);
    let bytes = std::fs::read(&path).expect("read stream");

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (desc, _) = device_descriptor(&adapter);
    let (device, queue) = pollster::block_on(adapter.request_device(&desc)).expect("device");
    let fmt = wgpu::TextureFormat::Rgba8UnormSrgb;
    let (w, h) = (640u32, 360u32);
    let mut host = Host::new(device.clone(), queue.clone(), fmt, (w, h));

    for (i, chunk) in bytes.chunks(step).enumerate() {
        let rep = host.apply(chunk);
        if rep.len() > 2 {
            println!("msg {i} ({} B) -> {}", chunk.len(), String::from_utf8_lossy(&rep));
        }
    }
    println!("created={} frame_pending={}", host.is_created(), host.frame_pending());
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("replay target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: fmt,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let mut enc = device.create_command_encoder(&Default::default());
    let drew = host.render(&mut enc, &view);
    queue.submit([enc.finish()]);
    println!("render -> {drew}; frame_pending now {}", host.frame_pending());
}
