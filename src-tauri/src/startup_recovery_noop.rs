pub(crate) fn initialize() {}

pub(crate) fn record(_message: impl AsRef<str>) {}

pub(crate) fn mark_frontend_ready() {}

pub(crate) fn record_run_event() {}

pub(crate) fn start_watchdog<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}
