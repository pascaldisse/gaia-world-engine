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
/// Logged line ends with ` ops=<kind> <dur> x<count> max=<slowest single cmd>, ... (cmds=N ops_sum=<dur> other=<apply wall - ops_sum>)` when --apply-op-top > 0.
pub fn apply_logged(host: &Mutex<Host>, shared: &Shared, bytes: &[u8], via: &str, queued: Duration) -> Result<Vec<u8>, String> {
    let t0 = Instant::now();
    let mut guard = host.lock().map_err(|_| "Host mutex poisoned".to_string())?;
    let waited = t0.elapsed();
    let report = guard.apply(bytes);
    let n = shared.apply_messages.load(Ordering::Relaxed);
    let log = n < LOG_FIRST || waited.as_millis() > SLOW_LOCK_MS || t0.elapsed().as_millis() > SLOW_TOTAL_MS;
    let ops = (log && shared.apply_op_top > 0).then(|| guard.last_apply_ops(shared.apply_op_top));
    drop(guard);
    if log {
        let ops_txt = ops
            .map(|(top, cmds, sum)| {
                let kinds: Vec<String> = top.iter().map(|k| format!("{} {:?} x{} max={:?}", k.kind, k.total, k.count, k.max)).collect();
                let other = t0.elapsed().saturating_sub(waited).saturating_sub(sum);
                format!(" ops={} (cmds={cmds} ops_sum={sum:?} other={other:?})", kinds.join(", "))
            })
            .unwrap_or_default();
        eprintln!(
            "[apply] #{n} via={via} {} B lock_wait={waited:?} total={:?} queued={queued:?} report={}{ops_txt}",
            bytes.len(),
            t0.elapsed(),
            String::from_utf8_lossy(&report[..report.len().min(300)])
        );
    }
    shared.apply_messages.fetch_add(1, Ordering::Relaxed);
    shared.apply_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    Ok(report)
}
