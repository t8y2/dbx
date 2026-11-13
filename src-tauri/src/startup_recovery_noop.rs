pub(crate) fn initialize() {}

pub(crate) fn record(_message: impl AsRef<str>) {}

pub(crate) fn mark_frontend_ready(_main_window_visible: bool) {}

pub(crate) fn record_run_event() {}

pub(crate) fn run_profile_pre_tauri_hooks() {}

pub(crate) fn report_window_visibility_probe(_main_window_visible: bool) {}

pub(crate) fn probe_main_window_visible<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> bool {
    false
}

pub(crate) fn start_watchdog<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

#[allow(dead_code)]
pub(crate) fn handle_missing_webview2_runtime() {}

#[allow(dead_code)]
pub(crate) fn handle_damaged_webview2_runtime(_runtime_version: Option<&str>) {}
