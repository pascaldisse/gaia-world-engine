//! Non-blocking GPU timestamp readback (works on wasm32, where `read_timings_blocking` cannot exist).
//! Flow per sample: `render` → `encode_timing_readback` (before submit) → submit → `request_timings_async(cb)`.
//! While mapped, `encode_timing_readback` skips (returns false) → at most one sample in flight, never a mapped-buffer copy.
//! Queue-mode upscalers (MetalFX) time the upscale outside our query set → `upscale_ms` = NaN here; use the blocking path natively.
use crate::{GpuTimings, RenderCore, UpscaleSubmit};
use std::sync::atomic::Ordering;

impl RenderCore {
    /// Map the readback written by the last `encode_timing_readback`; `done` gets the timings once the GPU has
    /// finished (browser: event loop; native: next `device.poll`). false = no TIMESTAMP_QUERY or a sample already in flight.
    pub fn request_timings_async(&self, done: impl FnOnce(Option<GpuTimings>) + wgpu::WasmNotSend + 'static) -> bool {
        let Some(tm) = &self.timing else { return false };
        if tm.pending.swap(true, Ordering::AcqRel) { return false; }
        let (buf, pending, period) = (tm.readback.clone(), tm.pending.clone(), tm.period_ns as f64);
        let queue_mode = self.upscaler.submit_mode() == UpscaleSubmit::Queue;
        let b2 = buf.clone();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let out = r.ok().and_then(|_| {
                let ts: [u64; 4] = *bytemuck::from_bytes(&b2.slice(..).get_mapped_range().ok()?[..32]);
                let ms = |a: u64, b: u64| b.saturating_sub(a) as f64 * period / 1e6;
                Some(if queue_mode {
                    GpuTimings { scene_ms: ms(ts[0], ts[1]), upscale_ms: f64::NAN, total_ms: f64::NAN }
                } else {
                    GpuTimings { scene_ms: ms(ts[0], ts[1]), upscale_ms: ms(ts[2], ts[3]), total_ms: ms(ts[0], ts[3]) }
                })
            });
            b2.unmap();
            pending.store(false, Ordering::Release);
            done(out);
        });
        true
    }
}
