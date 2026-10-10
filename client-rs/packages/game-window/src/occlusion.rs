//! Window-occlusion detection in WKWebView. MEASURED 10-10 (DS1 page, game-window launched behind other windows):
//!   document.visibilityState = 'hidden' -> requestAnimationFrame stops after ~14 frames -> the presenter never syncs,
//!   the scene never reaches the host. WebKit derives page visibility from NSWindow occlusion state.
//! FIX: private WKWebView SPI `_setWindowOcclusionDetectionEnabled:` (WKWebViewPrivate.h, macOS >= 10.13) set to NO ->
//!   the page stays 'visible' while covered. Opt back in with --occlusion-detection on (stock WebKit behaviour).
#![cfg(target_os = "macos")]

use objc2::{msg_send, runtime::{AnyObject, Bool}, sel};

pub fn disable(webview: &tauri::Webview) -> Result<(), String> {
    webview
        .with_webview(|pw| {
            let wv: *mut AnyObject = pw.inner().cast();
            let msg = if wv.is_null() {
                "FAILED: null WKWebView".to_string()
            } else {
                let ok: Bool = unsafe { msg_send![wv, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)] };
                if ok.as_bool() {
                    let _: () = unsafe { msg_send![wv, _setWindowOcclusionDetectionEnabled: Bool::NO] };
                    "detection OFF (page stays visible when covered)".to_string()
                } else {
                    "FAILED: WKWebView lacks _setWindowOcclusionDetectionEnabled:".to_string()
                }
            };
            eprintln!("[occlusion] {msg}");
        })
        .map_err(|e| format!("with_webview: {e}"))
}
