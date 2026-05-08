fn main() {
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
        let has_dylibs = std::path::Path::new(&manifest_dir).join("libodbc.2.dylib").exists();
        if !has_dylibs && std::env::var("TAURI_CONFIG").is_err() {
            std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"macOS":{"frameworks":[]}}}"#);
        }
    }
    tauri_build::build()
}
