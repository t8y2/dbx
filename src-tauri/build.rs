fn main() {
    let is_win7_target = std::env::var("CARGO_CFG_TARGET_VENDOR").as_deref() == Ok("win7");
    if is_win7_target && std::env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_none() {
        panic!("Windows 7 release builds must enable the custom-protocol feature");
    }

    // 本 crate 的 __eh_frame 已超过 ld64 的 16MB compact-unwind 编码上限，
    // 显式关闭 compact unwind 表以消除链接警告（异常处理退回 DWARF 展开）。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-no_compact_unwind");
    }

    // Force rebuild to re-embed frontend assets
    tauri_build::build()
}
