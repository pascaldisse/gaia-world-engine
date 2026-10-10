//! `stub-host` feature: LOCAL stand-in for `gaia_render_host::Host` (lane nt-ipc) so the window/webview/
//! frame-loop/MetalFX path can be built and checked before the real Host exists.
//! It draws NOTHING of the game: it clears the internal target to a colour that moves with the frame
//! counter (so a stuck loop is visible) and counts the command bytes it was fed. Banner is printed loudly.
//! Same four-method surface as host_ipc.rs — that file is the only thing swapped at integration.

pub struct HostAdapter {
    bytes: u64,
    messages: u64,
    frames: u64,
    size: (u32, u32),
}

impl HostAdapter {
    pub const NAME: &'static str = "stub";

    pub fn new(_device: &wgpu::Device, _queue: &wgpu::Queue, _format: wgpu::TextureFormat, render_size: (u32, u32)) -> Result<Self, String> {
        eprintln!("[host] ########## STUB HOST (feature stub-host): command bytes are counted, NOTHING is drawn. Build --no-default-features --features host-ipc for the real gaia_render_host::Host ##########");
        Ok(Self { bytes: 0, messages: 0, frames: 0, size: render_size })
    }

    pub fn apply(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.bytes += bytes.len() as u64;
        self.messages += 1;
        Ok(())
    }

    /// The real Host must also support a changing internal size (window aspect change) — requested of nt-ipc.
    pub fn resize(&mut self, render_size: (u32, u32)) -> Result<(), String> {
        self.size = render_size;
        Ok(())
    }

    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) -> Result<(), String> {
        self.frames += 1;
        let t = (self.frames % 240) as f64 / 240.0;
        let level = 0.10 + 0.10 * (t * std::f64::consts::TAU).sin().abs();
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("stub host clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: level * 0.5, g: level, b: level * 1.6, a: 1.0 }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        }));
        Ok(())
    }
}
