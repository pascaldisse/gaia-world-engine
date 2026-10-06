# gaia-metalfx — NOTES (lampas/metalfx, 2026-10-06)

MetalFX upscale for wgpu (Pascal: render 720p → MetalFX on M1 Pro). macOS only; other targets = empty crate (wasm32 `cargo check` passes).

## Interop
- bindings: `objc2-metal-fx 0.3.2` (crates.io) + `objc2-metal 0.3.2` = same version wgpu-hal 30 uses → no msg_send shims.
- `wgpu::{Device,Queue,Texture}::as_hal::<Metal>()` → raw MTLDevice / MTLCommandQueue / MTLTexture.
- MetalFX encodes into its OWN MTLCommandBuffer on wgpu's queue; same-queue commit order = execution order → submit wgpu work writing `input` BEFORE `upscale()`.
- §TRAP: wgpu lazily zero-inits textures it never saw written → first wgpu read of output CLEARS the MetalFX result (1st run: all-black PNG). → `mark_output_initialized()` once per output texture.
- texture usage demanded (M1 Pro, measured): color = ShaderRead (wgpu TEXTURE_BINDING) · output = ShaderRead|RenderTarget (TEXTURE_BINDING|RENDER_ATTACHMENT). Checked per call → loud `Err::BadUsage`.
- support: `supportsDevice` checked in `new()` → `Err::Unsupported`, no fallback.

## Upscaler trait
`gaia-render` lane not merged → LOCAL `Upscaler { fn upscale(&mut self, queue, input, output) -> Result }` (queue variant, not encoder: MetalFX can't share wgpu's open encoder safely). Swap to `gaia_render::Upscaler` once merged; if theirs takes `&mut CommandEncoder`, impl must still submit separately (or use `as_hal_mut` encoder → raw_command_buffer — UNTESTED, wgpu may hold an open pass encoder).

## Measured (M1 Pro, debug build, GPUStartTime/GPUEndTime, own cb per call, 50 iters, 1108x720→3024x1964 RGBA8)
- spatial: median 1.58 ms (min 1.20, max 2.92) · load avg ~18-23 (machine busy with other lanes)
- earlier run at load ~27: median 1.95 / 6.48 (noisy) → numbers are load-sensitive
- temporal (Depth32Float + Rg16Float motion, zero motion, 4-tap jitter): median 3.11 ms
- Metal API validation (`MTL_DEBUG_LAYER=1`): no errors, both scalers.
- PNGs: `.scratch/metalfx_{input,spatial_output,temporal_output}.png` (worktree root, gitignored). Visually checked: pattern intact, sharp edges.

## UNVERIFIED
- temporal QUALITY: input never actually jittered/moving → only proves API path + timing, not reconstruction.
- motion-vector sign/units convention vs gaia-render's MV pass; depth reversed flag.
- release-build / idle-machine timing; sRGB formats (Linear mode chosen for *Srgb) untested.
- integration into a real frame loop / swapchain output.

## Run
`CARGO_TARGET_DIR=../.scratch/target cargo run -p gaia-metalfx --example spatial_bench -- ../.scratch 50` (from client-rs/)
env: `GAIA_MFX_IN=1108x720 GAIA_MFX_OUT=3024x1964`.
