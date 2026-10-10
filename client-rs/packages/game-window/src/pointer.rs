//! Pointer lock in WKWebView (FINDING, read from WebKit main, UNVERIFIED at runtime — app not launched per lane law):
//!   WebKit ships the Pointer Lock API on macOS (Safari >= 10.1; PointerLockEnabled default true), BUT the UIProcess
//!   asks the embedder: `UIDelegate::UIClient::requestPointerLock` DENIES unless the WKUIDelegate implements the
//!   private `_webViewDidRequestPointerLock:completionHandler:` (Source/WebKit/UIProcess/Cocoa/UIDelegate.mm).
//!   wry's WryWebViewUIDelegate (wry 0.55, used by Tauri 2.11) does not → stock Tauri: `requestPointerLock()` is
//!   always denied. WebKit also requires the view visible + focused + a mouse device, and a user gesture in the page.
//!   Once ALLOWED, WebKit locks natively (`WebPageProxy::platformLockPointer`: cursor hidden/frozen, movementX/Y).
//! FIX here: add that private selector to wry's delegate class at runtime (answers YES), then re-set the delegate
//!   because WebKit caches `respondsToSelector:` in `UIDelegate::setDelegate`. Private SPI (stable since macOS 10.14.4) →
//!   opt-out with --pointer-lock off. Result is published in `gaia_native_info().pointer_lock`.
#![cfg(target_os = "macos")]

use crate::shared::Shared;
use objc2::{
    ffi,
    msg_send,
    runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
    sel,
};
use std::sync::Arc;

type HandlerBlock = block2::Block<dyn Fn(Bool)>;

unsafe extern "C" fn allow_pointer_lock(_this: *mut AnyObject, _cmd: Sel, _webview: *mut AnyObject, handler: *mut HandlerBlock) {
    // Tauri's single game webview is the only thing that can ask; the page needs a user gesture anyway.
    unsafe { &*handler }.call((Bool::YES,));
}

/// Runs the hook on the main thread (with_webview) and records the outcome in `shared.info.pointer_lock`.
pub fn install(webview: &tauri::Webview, shared: Arc<Shared>) -> Result<(), String> {
    webview
        .with_webview(move |pw| {
            let outcome = unsafe { add_hook(pw.inner().cast()) };
            let msg = match &outcome {
                Ok(m) => format!("spi: {m}"),
                Err(e) => format!("spi FAILED: {e}"),
            };
            eprintln!("[pointer] {msg}");
            shared.info.lock().unwrap().pointer_lock = msg;
        })
        .map_err(|e| format!("with_webview: {e}"))
}

unsafe fn add_hook(wv: *mut AnyObject) -> Result<&'static str, String> {
    if wv.is_null() {
        return Err("null WKWebView".into());
    }
    let delegate: *mut AnyObject = unsafe { msg_send![wv, UIDelegate] };
    if delegate.is_null() {
        return Err("WKWebView has no UIDelegate to extend".into());
    }
    let class: &AnyClass = unsafe { &*delegate }.class();
    let selector = sel!(_webViewDidRequestPointerLock:completionHandler:);
    let already = class.instance_method(selector).is_some();
    if !already {
        // v@:@@? = void, self, _cmd, WKWebView*, block(BOOL)
        let imp: Imp = unsafe { std::mem::transmute(allow_pointer_lock as unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut HandlerBlock)) };
        let added = unsafe { ffi::class_addMethod(class as *const AnyClass as *mut AnyClass, selector, imp, c"v@:@@?".as_ptr()) };
        if !added.as_bool() {
            return Err(format!("class_addMethod failed on {}", class.name().to_string_lossy()));
        }
    }
    // WebKit snapshots respondsToSelector: when the delegate is SET → set it again.
    let _: () = unsafe { msg_send![wv, setUIDelegate: std::ptr::null_mut::<AnyObject>()] };
    let _: () = unsafe { msg_send![wv, setUIDelegate: delegate] };
    Ok(if already { "selector already present, delegate re-set" } else { "added _webViewDidRequestPointerLock:completionHandler: to the wry delegate, delegate re-set" })
}
