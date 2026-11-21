//! Non-Windows stubs for the AppCompat compatibility-layer helpers.
//!
//! The real implementation lives in `windows_appcompat.rs` and is only compiled
//! on Windows; these no-ops keep the startup-compatibility ladder compiling on
//! other hosts (and in host-side unit tests) without `#[cfg]` noise at call
//! sites.

#![allow(dead_code)]

pub(crate) fn set_win8_compat_layer() -> Result<String, String> {
    Err("appcompat win8 layer unsupported on this platform".to_string())
}

pub(crate) fn remove_win8_compat_layer() -> Result<String, String> {
    Ok("appcompat win8 layer unsupported on this platform".to_string())
}

pub(crate) fn is_process_elevated() -> bool {
    false
}
