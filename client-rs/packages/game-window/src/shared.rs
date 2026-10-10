//! State shared between Tauri's IPC worker threads (page -> bytes) and the render thread (drains + draws).
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

/// What `gaia_native_info` returns to the page (also the only reverse channel besides eval).
#[derive(Serialize, Clone, Default)]
pub struct Info {
    pub host: &'static str,
    pub adapter: String,
    pub stage: String,
    pub upscaler: String,
    pub render_height: u32,
    pub output: [u32; 2],
    pub internal: [u32; 2],
    pub scale_factor: f64,
    pub frame: u64,
    pub fps: f64,
    pub cpu_ms: f64,
    pub applied_messages: u64,
    pub applied_bytes: u64,
    pub apply_errors: u64,
    pub last_error: Option<String>,
    pub queued_bytes: usize,
    pub pointer_lock: String,
    pub page_gpu: &'static str,
}

pub struct Shared {
    queue: Mutex<VecDeque<Vec<u8>>>,
    queued_bytes: AtomicUsize,
    max_backlog: usize,
    pub running: AtomicBool,
    pub info: Mutex<Info>,
}

impl Shared {
    pub fn new(max_backlog: usize, info: Info) -> Self {
        Self { queue: Mutex::default(), queued_bytes: AtomicUsize::new(0), max_backlog, running: AtomicBool::new(true), info: Mutex::new(info) }
    }

    /// Page -> render thread. Loud Err when the render thread is further behind than the backlog cap:
    /// the page must back off, commands are NEVER silently dropped (they are not idempotent).
    pub fn push(&self, bytes: Vec<u8>) -> Result<(), String> {
        let queued = self.queued_bytes.load(Ordering::Acquire);
        if queued + bytes.len() > self.max_backlog {
            return Err(format!(
                "gaia_native_apply: backlog {queued} + {} bytes exceeds GAIA_MAX_BACKLOG_BYTES={} (render thread behind) — message REJECTED, retry later",
                bytes.len(),
                self.max_backlog
            ));
        }
        self.queued_bytes.fetch_add(bytes.len(), Ordering::AcqRel);
        self.queue.lock().unwrap().push_back(bytes);
        Ok(())
    }

    /// Render thread: take everything queued, in arrival order.
    pub fn drain(&self) -> VecDeque<Vec<u8>> {
        let taken = std::mem::take(&mut *self.queue.lock().unwrap());
        let n: usize = taken.iter().map(Vec::len).sum();
        self.queued_bytes.fetch_sub(n, Ordering::AcqRel);
        taken
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::Acquire)
    }
}
