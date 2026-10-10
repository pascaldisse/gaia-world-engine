// App-command ACL: once an app manifest exists, EVERY app command needs an `allow-*` permission
// (remote pages need a `remote` capability on top: main.rs adds it at runtime for the game URL's origin).
// Keep this list == the #[tauri::command]s in src/main.rs == COMMANDS there.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["gaia_render_apply", "gaia_native_info"])),
    )
    .expect("tauri build");
}
