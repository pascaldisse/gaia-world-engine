//! MetalFX upscaling for the wgpu renderer.
//!
//! macOS only. On every other target this crate compiles to an empty stub so
//! wasm / other native builds are unaffected.
//!
//! Interop: wgpu `as_hal::<Metal>()` → raw `MTLDevice` / `MTLCommandQueue` /
//! `MTLTexture`; MetalFX work is encoded into its OWN `MTLCommandBuffer` on
//! wgpu's queue. Metal executes command buffers of one queue in commit order,
//! so: submit the wgpu work that writes `input` → `upscale()` → later wgpu
//! submits that read `output` are ordered correctly.
//!
//! No fallback: unsupported device / wrong texture usage / wrong format =
//! loud `Err`, never a silent bilinear blit.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;
