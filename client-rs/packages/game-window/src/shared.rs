//! State shared between Tauri's IPC threads, the render thread and wgpu's error callback.
use serde::Serialize;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64},
};

/// What `gaia_native_info` returns to the page (the host's stats; the render-command reports go back via gaia_render_apply).
#[derive(Serialize, Clone, Default)]
pub struct Info {
    pub adapter: String,
    pub stage: String,
    pub upscaler: String,
    pub render_height: u32,
    pub output: [u32; 2],
    pub internal: Option<[u32; 2]>,
    pub scale_factor: f64,
    pub session: bool,
    pub frames_presented: u64,
    pub fps: f64,
    pub cpu_ms: f64,
    pub apply_messages: u64,
    pub apply_bytes: u64,
    pub gpu_errors: u64,
    pub last_gpu_error: Option<String>,
    pub pointer_lock: String,
    pub page_gpu: &'static str,
}

pub struct Shared {
    pub running: AtomicBool,
    pub info: Mutex<Info>,
    pub apply_messages: AtomicU64,
    pub apply_bytes: AtomicU64,
    pub gpu_errors: AtomicU64,
    /// --apply-op-top: kinds named in a logged [apply] line (0 = per-op timing off)
    pub apply_op_top: usize,
}

impl Shared {
    pub fn new(info: Info, apply_op_top: usize) -> Self {
        Self {
            running: AtomicBool::new(true),
            info: Mutex::new(info),
            apply_messages: AtomicU64::new(0),
            apply_bytes: AtomicU64::new(0),
            gpu_errors: AtomicU64::new(0),
            apply_op_top,
        }
    }
}
