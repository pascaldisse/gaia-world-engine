//! Process memory footprints for the `[page:mem]` line (docs/NATIVE.md §page-mem-log).
//! gw = this process (game-window): `proc_pid_rusage(getpid, RUSAGE_INFO_V0)` -> ri_phys_footprint (== Activity Monitor "Memory") + ri_resident_size.
//! wc = the WKWebView's WebContent process. NOT a child of game-window (WebKit XPC service, parent = launchd) -> `proc_listchildpids` finds nothing.
//!     pid via private `-[WKWebView _webProcessIdentifier]` (WKWebViewPrivate.h), read on the main thread by a sampler thread every --page-mem-ms,
//!     then `proc_pid_rusage(pid)` (same-uid processes are readable without privileges). Unavailable SPI/pid/rusage -> `wc_MB=n/a(<why>)`.
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;
/// sampler bounds (ms): the pid refresh runs at the page-mem interval, never faster than this
const MIN_SAMPLE_MS: u64 = 250;
/// 0 = unknown, -1 = SPI missing
static WC_PID: AtomicI32 = AtomicI32::new(0);
#[cfg(target_os = "macos")]
mod sys {
    unsafe extern "C" {
        pub fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut std::ffi::c_void) -> i32;
    }
    pub const RUSAGE_INFO_V0: i32 = 0;
}
/// (phys_footprint, resident) bytes of `pid`, or Err(errno / reason).
#[cfg(target_os = "macos")]
fn rusage(pid: i32) -> Result<(u64, u64), String> {
    // struct rusage_info_v0 { u8 uuid[16]; u64 user, system, pkg_idle_wkups, interrupt_wkups, pageins, wired, resident, phys_footprint, ... } -> oversized buffer, index by u64
    let mut buf = [0u64; 64];
    let rc = unsafe { sys::proc_pid_rusage(pid, sys::RUSAGE_INFO_V0, buf.as_mut_ptr().cast()) };
    if rc != 0 {
        return Err(format!("rusage rc={rc} errno={}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
    }
    const RESIDENT: usize = 2 + 6; // uuid(2 u64) + user,system,pkg,intr,pageins,wired
    Ok((buf[RESIDENT + 1], buf[RESIDENT]))
}
#[cfg(not(target_os = "macos"))]
fn rusage(_pid: i32) -> Result<(u64, u64), String> {
    Err("non-macos".into())
}
fn mb(b: u64) -> String {
    format!("{:.1}", b as f64 / 1048576.0)
}
fn one(label: &str, pid: i32) -> String {
    match rusage(pid) {
        Ok((foot, rss)) => format!("{label}_MB={} {label}_rss_MB={} {label}_pid={pid}", mb(foot), mb(rss)),
        Err(e) => format!("{label}_MB=n/a({e}) {label}_pid={pid}"),
    }
}
/// Suffix appended by gaia_page_log to every `[page:mem]` line.
pub fn host_suffix() -> String {
    let gw = one("gw", std::process::id() as i32);
    let wc = match WC_PID.load(Ordering::Relaxed) {
        0 => "wc_MB=n/a(pid not sampled yet)".to_string(),
        -1 => "wc_MB=n/a(WKWebView._webProcessIdentifier SPI missing)".to_string(),
        pid => one("wc", pid),
    };
    format!("|host {gw} {wc}")
}
/// Keeps WC_PID fresh (WebContent can be respawned by WebKit). Thread ends when the webview is gone.
#[cfg(target_os = "macos")]
pub fn start_sampler(webview: tauri::Webview, every_ms: u32) {
    use objc2::{msg_send, runtime::{AnyObject, Bool}, sel};
    std::thread::Builder::new()
        .name("gaia-memfoot".into())
        .spawn(move || {
            let every = Duration::from_millis((every_ms as u64).max(MIN_SAMPLE_MS));
            loop {
                let r = webview.with_webview(|pw| {
                    let wv: *mut AnyObject = pw.inner().cast();
                    if wv.is_null() {
                        return;
                    }
                    let ok: Bool = unsafe { msg_send![wv, respondsToSelector: sel!(_webProcessIdentifier)] };
                    if ok.as_bool() {
                        let pid: i32 = unsafe { msg_send![wv, _webProcessIdentifier] };
                        WC_PID.store(pid, Ordering::Relaxed);
                    } else {
                        WC_PID.store(-1, Ordering::Relaxed);
                    }
                });
                if r.is_err() {
                    break;
                }
                std::thread::sleep(every);
            }
        })
        .expect("spawn gaia-memfoot");
}
#[cfg(not(target_os = "macos"))]
pub fn start_sampler(_webview: tauri::Webview, _every_ms: u32) {}
