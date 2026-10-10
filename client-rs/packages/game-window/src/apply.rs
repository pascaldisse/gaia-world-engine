//! The ONE place a page message reaches `Host::apply` — shared by the Tauri invoke command and the localhost WebSocket server
//! (ipc_ws.rs), so ordering semantics (shared `Mutex<Host>`), counters and the `[apply]` log are identical on both transports.
use crate::shared::Shared;
use gaia_render_host::Host;
use std::{
    sync::{Mutex, atomic::Ordering},
    time::{Duration, Instant},
};
/// `[apply]` is logged for the first `LOG_FIRST` messages and for any slow lock-wait / apply (thresholds in ms).
const LOG_FIRST: u64 = 8;
const SLOW_LOCK_MS: u128 = 50;
const SLOW_TOTAL_MS: u128 = 100;
/// `via` = transport tag in the log (`invoke` | `ws#<conn>`); `queued` = time the message waited in the transport before apply (zero for invoke).
pub fn apply_logged(host: &Mutex<Host>, shared: &Shared, bytes: &[u8], via: &str, queued: Duration) -> Result<Vec<u8>, String> {
    let t0 = Instant::now();
    let mut guard = host.lock().map_err(|_| "Host mutex poisoned".to_string())?;
    let waited = t0.elapsed();
    let report = guard.apply(bytes);
    drop(guard);
    let n = shared.apply_messages.load(Ordering::Relaxed);
    if n < LOG_FIRST || waited.as_millis() > SLOW_LOCK_MS || t0.elapsed().as_millis() > SLOW_TOTAL_MS {
        eprintln!(
            "[apply] #{n} via={via} {} B lock_wait={waited:?} total={:?} queued={queued:?} report={}",
            bytes.len(),
            t0.elapsed(),
            String::from_utf8_lossy(&report[..report.len().min(300)])
        );
    }
    shared.apply_messages.fetch_add(1, Ordering::Relaxed);
    shared.apply_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    Ok(report)
}
