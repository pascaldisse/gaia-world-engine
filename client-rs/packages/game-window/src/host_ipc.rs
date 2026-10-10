//! `host-ipc` feature: the REAL `gaia_render_host::Host` (lane nt-ipc). UNVERIFIED — written against the API
//! given in the lane brief, the crate did not exist when this was written:
//!   Host::new(device, queue, surface_format, render_size) / host.apply(bytes) / host.render(&mut encoder, target_view)
//! ASSUMPTIONS (each one is a one-line fix HERE, nowhere else):
//!   A1 `render_size` = INTERNAL render size as `(u32, u32)`; `render()` draws the whole frame into `target_view`
//!      (a `surface_format` view over a TEXTURE_BINDING|RENDER_ATTACHMENT texture of exactly that size);
//!      game-window does the upscale (MetalFX spatial / bilinear) + present itself.
//!   A2 `apply(&[u8])` and `new(..)` return `Result<_, E: Display>`; `render` returns `()` (or a Result — adapt below).
//!   A3 `Host::resize(&mut self, (u32, u32))` EXISTS (window aspect change changes the internal width). Requested of
//!      nt-ipc; if it does not exist this file fails to COMPILE — loud on purpose, no rebuild-the-host-and-lose-the-scene hack.
//! Cargo: uncomment `gaia-render-host` in Cargo.toml, build with `--no-default-features --features host-ipc`.

pub struct HostAdapter {
    host: gaia_render_host::Host,
}

impl HostAdapter {
    pub const NAME: &'static str = "gaia_render_host::Host";

    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat, render_size: (u32, u32)) -> Result<Self, String> {
        let host = gaia_render_host::Host::new(device, queue, format, render_size);
        Ok(Self { host })
    }

    pub fn apply(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.host.apply(bytes).map_err(|e| e.to_string())
    }

    pub fn resize(&mut self, render_size: (u32, u32)) -> Result<(), String> {
        self.host.resize(render_size);
        Ok(())
    }

    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) -> Result<(), String> {
        self.host.render(encoder, target);
        Ok(())
    }
}
