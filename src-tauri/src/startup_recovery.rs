use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::Duration;
use tauri::Manager;

const STARTUP_LOG_FILE: &str = "startup.log";
const STARTUP_LOG_DIR_ENV: &str = "DBX_STARTUP_LOG_DIR";
const KEEP_STARTUP_LOG_ENV: &str = "DBX_KEEP_STARTUP_LOG";
#[cfg(target_os = "windows")]
const NO_SANDBOX_ENV: &str = "DBX_WEBVIEW2_NO_SANDBOX";
const RECOVERY_ATTEMPT_ENV: &str = "DBX_STARTUP_COMPAT_RECOVERY";
const RECOVERY_PARENT_PID_ENV: &str = "DBX_STARTUP_COMPAT_PARENT_PID";
const DISABLE_ENTERPRISE_COMPAT_ENV: &str = "DBX_DISABLE_ENTERPRISE_COMPAT";
const WINDOWS_APP_DATA_DIR_NAME: &str = "com.dbx.app";
const COMPATIBILITY_MARKER_FILE: &str = "webview2-enterprise-compat.enabled";
const COMPATIBILITY_PROFILE_DIR: &str = "webview2-enterprise-compat";
const STARTUP_LOG_BUFFER_CAPACITY: usize = 256;
const STARTUP_WATCHDOG_DELAY: Duration = Duration::from_secs(15);
#[cfg(target_os = "windows")]
const RECOVERY_PARENT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct StartupProbeState {
    persistent: bool,
    lines: VecDeque<String>,
}

static STARTUP_PROBE_STATE: LazyLock<Mutex<StartupProbeState>> =
    LazyLock::new(|| Mutex::new(StartupProbeState::default()));
static STARTUP_PROBE_ACTIVE: AtomicBool = AtomicBool::new(false);
static RECOVERY_ATTEMPT: AtomicBool = AtomicBool::new(false);
static ENTERPRISE_COMPAT: AtomicBool = AtomicBool::new(false);
static ENTERPRISE_COMPAT_DISABLED: AtomicBool = AtomicBool::new(false);
static RUN_EVENT_COUNT: AtomicUsize = AtomicUsize::new(0);
static FRONTEND_READY_SIGNAL: LazyLock<(Mutex<bool>, Condvar)> = LazyLock::new(|| (Mutex::new(false), Condvar::new()));

fn env_flag(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

fn startup_log_dir_from_inputs(
    target_os: &str,
    explicit_dir: Option<OsString>,
    windows_appdata: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(dir) = explicit_dir.filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    (target_os == "windows")
        .then(|| windows_appdata.filter(|value| !value.is_empty()))
        .flatten()
        .map(PathBuf::from)
        .map(|dir| dir.join(WINDOWS_APP_DATA_DIR_NAME))
}

fn startup_log_dir() -> Option<PathBuf> {
    startup_log_dir_from_inputs(
        std::env::consts::OS,
        std::env::var_os(STARTUP_LOG_DIR_ENV),
        std::env::var_os("APPDATA"),
    )
}

fn startup_log_path() -> Option<PathBuf> {
    startup_log_dir().map(|dir| dir.join(STARTUP_LOG_FILE))
}

fn compatibility_marker_path_from_appdata(windows_appdata: Option<OsString>) -> Option<PathBuf> {
    windows_appdata
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|dir| dir.join(WINDOWS_APP_DATA_DIR_NAME).join(COMPATIBILITY_MARKER_FILE))
}

fn compatibility_marker_path() -> Option<PathBuf> {
    compatibility_marker_path_from_appdata(std::env::var_os("APPDATA"))
}

fn compatibility_marker_contents(version: &str) -> String {
    format!("version={version}\nmode=isolated-profile-no-sandbox\n")
}

fn compatibility_marker_matches_version(path: &Path, version: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|contents| contents == compatibility_marker_contents(version))
}

fn compatibility_profile_path_from_inputs(
    local_appdata: Option<OsString>,
    windows_appdata: Option<OsString>,
) -> (Option<PathBuf>, &'static str) {
    if let Some(dir) = local_appdata.filter(|value| !value.is_empty()).map(PathBuf::from) {
        return (Some(dir.join(WINDOWS_APP_DATA_DIR_NAME).join(COMPATIBILITY_PROFILE_DIR)), "local_appdata");
    }
    if let Some(dir) = windows_appdata.filter(|value| !value.is_empty()).map(PathBuf::from) {
        return (Some(dir.join(WINDOWS_APP_DATA_DIR_NAME).join(COMPATIBILITY_PROFILE_DIR)), "appdata_fallback");
    }
    (None, "unavailable")
}

#[cfg(target_os = "windows")]
fn compatibility_profile_path() -> (Option<PathBuf>, &'static str) {
    compatibility_profile_path_from_inputs(std::env::var_os("LOCALAPPDATA"), std::env::var_os("APPDATA"))
}

fn resolve_compatibility_mode(recovery_requested: bool, marker_enabled: bool, disabled: bool) -> (bool, bool) {
    if disabled {
        (false, false)
    } else {
        (recovery_requested, recovery_requested || marker_enabled)
    }
}

fn compatibility_profile_ready_record(profile_source: &str) -> String {
    format!("enterprise compatibility profile ready source={profile_source}")
}

fn configure_recovery_child(command: &mut std::process::Command, parent_pid: u32) {
    command.env(RECOVERY_ATTEMPT_ENV, "1").env(RECOVERY_PARENT_PID_ENV, parent_pid.to_string());
}

#[cfg(target_os = "windows")]
fn wait_for_recovery_parent_exit() -> &'static str {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    let parent_pid = std::env::var(RECOVERY_PARENT_PID_ENV).ok().and_then(|value| value.parse::<u32>().ok());
    std::env::remove_var(RECOVERY_PARENT_PID_ENV);
    let Some(parent_pid) = parent_pid.filter(|pid| *pid != 0) else {
        return "parent_pid_unavailable";
    };
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false.into(), parent_pid) };
    if handle.is_null() {
        return "parent_already_exited";
    }
    let wait_result = unsafe { WaitForSingleObject(handle, RECOVERY_PARENT_WAIT_TIMEOUT.as_millis() as u32) };
    unsafe {
        CloseHandle(handle);
    }
    match wait_result {
        WAIT_OBJECT_0 => "parent_exit_observed",
        WAIT_TIMEOUT => "parent_exit_timeout",
        _ => "parent_wait_failed",
    }
}

#[cfg(not(target_os = "windows"))]
fn wait_for_recovery_parent_exit() -> &'static str {
    "unsupported_platform"
}

fn ensure_parent_dir(path: &Path) -> bool {
    path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
}

fn write_line(path: &Path, line: &str) {
    if !ensure_parent_dir(path) {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

fn format_probe_line(message: &str) -> String {
    format!("[{}][pid={}] {message}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), std::process::id())
}

fn append_persisted_record(message: impl AsRef<str>) {
    if let Some(path) = startup_log_path() {
        write_line(&path, &format_probe_line(message.as_ref()));
    }
}

pub(crate) fn initialize() {
    let enterprise_compat_disabled = env_flag(DISABLE_ENTERPRISE_COMPAT_ENV);
    let recovery_requested = env_flag(RECOVERY_ATTEMPT_ENV);
    // The parent owns tauri-plugin-single-instance's mutex. Wait for process exit
    // before building Tauri so the recovery child can acquire the same mutex.
    let parent_handoff = (recovery_requested && !enterprise_compat_disabled).then(wait_for_recovery_parent_exit);
    let marker_path = compatibility_marker_path();
    let marker_enabled = !enterprise_compat_disabled
        && marker_path
            .as_deref()
            .is_some_and(|path| compatibility_marker_matches_version(path, env!("CARGO_PKG_VERSION")));
    let (recovery_attempt, enterprise_compat) =
        resolve_compatibility_mode(recovery_requested, marker_enabled, enterprise_compat_disabled);

    if !marker_enabled && !enterprise_compat_disabled {
        if let Some(path) = marker_path.filter(|path| path.is_file()) {
            let _ = std::fs::remove_file(path);
        }
    }

    if !recovery_attempt {
        if let Some(path) = startup_log_path() {
            let _ = std::fs::remove_file(path);
        }
    }

    {
        let mut state = STARTUP_PROBE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *state = StartupProbeState {
            persistent: recovery_attempt,
            lines: VecDeque::with_capacity(STARTUP_LOG_BUFFER_CAPACITY),
        };
    }
    STARTUP_PROBE_ACTIVE.store(true, Ordering::Release);
    RECOVERY_ATTEMPT.store(recovery_attempt, Ordering::Release);
    ENTERPRISE_COMPAT.store(enterprise_compat, Ordering::Release);
    ENTERPRISE_COMPAT_DISABLED.store(enterprise_compat_disabled, Ordering::Release);
    RUN_EVENT_COUNT.store(0, Ordering::Release);
    *FRONTEND_READY_SIGNAL.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = false;

    install_panic_hook();
    record(format!(
        "process start version={} os={} arch={} recovery_attempt={} compatibility_marker={} enterprise_compat={} enterprise_compat_disabled={}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        recovery_attempt,
        marker_enabled,
        enterprise_compat,
        enterprise_compat_disabled
    ));
    if let Some(parent_handoff) = parent_handoff {
        record(format!("single-instance recovery handoff status={parent_handoff}"));
    }
    configure_webview2_compatibility(enterprise_compat);
}

pub(crate) fn record(message: impl AsRef<str>) {
    if !STARTUP_PROBE_ACTIVE.load(Ordering::Acquire) {
        return;
    }
    let line = format_probe_line(message.as_ref());
    let persistent = {
        let mut state = STARTUP_PROBE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !STARTUP_PROBE_ACTIVE.load(Ordering::Acquire) {
            return;
        }
        if state.lines.len() == STARTUP_LOG_BUFFER_CAPACITY {
            state.lines.pop_front();
        }
        state.lines.push_back(line.clone());
        state.persistent
    };
    if persistent {
        if let Some(path) = startup_log_path() {
            write_line(&path, &line);
        }
    }
}

fn persist_buffer() {
    let lines = {
        let mut state = STARTUP_PROBE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.persistent {
            return;
        }
        state.persistent = true;
        state.lines.iter().cloned().collect::<Vec<_>>()
    };
    let Some(path) = startup_log_path() else {
        return;
    };
    if !ensure_parent_dir(&path) {
        return;
    }
    let Ok(mut file) = std::fs::File::create(path) else {
        return;
    };
    for line in lines {
        let _ = writeln!(file, "{line}");
    }
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| format!(" line={} column={}", location.line(), location.column()))
            .unwrap_or_default();
        record(format!("panic before frontend ready{location}"));
        persist_buffer();
        default_hook(info);
    }));
}

#[cfg(target_os = "windows")]
fn append_webview2_argument(argument: &str) {
    let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if args.split_whitespace().any(|value| value == argument) {
        return;
    }
    if !args.is_empty() {
        args.push(' ');
    }
    args.push_str(argument);
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

#[cfg(target_os = "windows")]
fn configure_webview2_compatibility(enterprise_compat: bool) {
    let manual_no_sandbox = env_flag(NO_SANDBOX_ENV);
    if enterprise_compat {
        let (profile_path, profile_source) = compatibility_profile_path();
        match profile_path {
            Some(path) => match std::fs::create_dir_all(&path) {
                Ok(()) => {
                    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &path);
                    record(compatibility_profile_ready_record(profile_source));
                }
                Err(error) => record(format!("failed to create enterprise compatibility profile: {error}")),
            },
            None => record("enterprise compatibility profile unavailable: LOCALAPPDATA and APPDATA are missing"),
        }
    }
    if enterprise_compat || manual_no_sandbox {
        append_webview2_argument("--no-sandbox");
        record(format!("WebView2 no-sandbox enabled enterprise_compat={enterprise_compat} manual={manual_no_sandbox}"));
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_webview2_compatibility(_enterprise_compat: bool) {}

pub(crate) fn record_run_event() {
    if STARTUP_PROBE_ACTIVE.load(Ordering::Acquire) {
        RUN_EVENT_COUNT.fetch_add(1, Ordering::Relaxed);
    }
}

fn probe_snapshot() -> (bool, bool, bool, usize) {
    (
        STARTUP_PROBE_ACTIVE.load(Ordering::Acquire),
        ENTERPRISE_COMPAT.load(Ordering::Acquire),
        ENTERPRISE_COMPAT_DISABLED.load(Ordering::Acquire),
        RUN_EVENT_COUNT.load(Ordering::Acquire),
    )
}

fn should_attempt_enterprise_recovery(
    active: bool,
    enterprise_compat: bool,
    enterprise_compat_disabled: bool,
    run_event_count: usize,
    main_exists: bool,
) -> bool {
    active && !enterprise_compat && !enterprise_compat_disabled && run_event_count == 0 && !main_exists
}

pub(crate) fn start_watchdog<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if std::env::consts::OS != "windows" {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let (signal, wake) = &*FRONTEND_READY_SIGNAL;
        let ready = signal.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (ready, timeout) = wake
            .wait_timeout_while(ready, STARTUP_WATCHDOG_DELAY, |ready| !*ready)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *ready || !timeout.timed_out() {
            return;
        }
        drop(ready);

        let (active, enterprise_compat, enterprise_compat_disabled, run_event_count) = probe_snapshot();
        if !active {
            return;
        }
        let main_exists = app.get_webview_window("main").is_some();
        record(format!(
            "startup watchdog after {}s run_event_count={run_event_count} main_exists={main_exists}",
            STARTUP_WATCHDOG_DELAY.as_secs()
        ));
        if should_attempt_enterprise_recovery(
            active,
            enterprise_compat,
            enterprise_compat_disabled,
            run_event_count,
            main_exists,
        ) {
            persist_buffer();
            record("startup stalled before event loop; restarting once with enterprise compatibility mode");
            let restart_result = std::env::current_exe().and_then(|executable| {
                let mut command = std::process::Command::new(executable);
                command.args(std::env::args_os().skip(1));
                configure_recovery_child(&mut command, std::process::id());
                command.spawn()
            });
            match restart_result {
                Ok(child) => {
                    record(format!("enterprise compatibility process spawned pid={}", child.id()));
                    std::process::exit(0);
                }
                Err(error) => {
                    record(format!("failed to spawn enterprise compatibility process: {error}"));
                    show_recovery_failure_message();
                    return;
                }
            }
        }
        if run_event_count > 0 || main_exists {
            return;
        }

        persist_buffer();
        if enterprise_compat {
            record("enterprise compatibility startup failed; automatic recovery stopped");
            show_recovery_failure_message();
            std::process::exit(1);
        }
    });
}

fn write_compatibility_marker() -> Result<(), String> {
    let path = compatibility_marker_path().ok_or_else(|| "APPDATA is unavailable".to_string())?;
    if !ensure_parent_dir(&path) {
        return Err("failed to create compatibility marker directory".to_string());
    }
    std::fs::write(&path, compatibility_marker_contents(env!("CARGO_PKG_VERSION")))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn deactivate_probe() {
    STARTUP_PROBE_ACTIVE.store(false, Ordering::Release);
    let (signal, wake) = &*FRONTEND_READY_SIGNAL;
    *signal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
    wake.notify_all();
    STARTUP_PROBE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).lines.clear();
}

pub(crate) fn mark_frontend_ready() {
    let recovery_attempt = RECOVERY_ATTEMPT.load(Ordering::Acquire);
    let keep_requested = env_flag(KEEP_STARTUP_LOG_ENV);

    if recovery_attempt {
        record("enterprise compatibility recovery reached frontend ready");
        persist_buffer();
        deactivate_probe();
        let keep_compatibility = confirm_keep_compatibility_mode();
        let result = if keep_compatibility {
            write_compatibility_marker().map(|()| "enterprise compatibility marker saved".to_string())
        } else {
            Ok("enterprise compatibility marker declined by user".to_string())
        };
        append_persisted_record(
            result.unwrap_or_else(|error| format!("enterprise compatibility marker failed: {error}")),
        );
        std::env::remove_var(RECOVERY_ATTEMPT_ENV);
    } else if keep_requested {
        record("frontend ready; startup log retained by DBX_KEEP_STARTUP_LOG=1");
        persist_buffer();
        deactivate_probe();
    } else if let Some(path) = startup_log_path() {
        let _ = std::fs::remove_file(path);
        deactivate_probe();
    } else {
        deactivate_probe();
    }
}

#[cfg(target_os = "windows")]
fn windows_ok_message(title: &str, body: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND};

    let title = title.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let body = body.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONWARNING | MB_SETFOREGROUND);
    }
}

#[cfg(target_os = "windows")]
fn confirm_keep_compatibility_mode() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO,
    };

    let log_path =
        startup_log_path().map(|path| path.display().to_string()).unwrap_or_else(|| "startup.log".to_string());
    let locale = sys_locale::get_locale().unwrap_or_default().to_ascii_lowercase();
    let body = if locale.starts_with("zh") {
        format!(
            "DBX 已通过企业环境兼容模式恢复主界面。\n\n该模式会为 WebView2 使用独立数据目录并关闭沙箱，仅建议在标准模式无法显示窗口时保留。\n\n是否让当前 DBX 版本后续启动直接使用兼容模式？\n选择“否”后，下次启动会重新尝试标准模式。\n\n本次恢复日志：{log_path}"
        )
    } else {
        format!(
            "DBX restored the main window using enterprise environment compatibility mode.\n\nThis mode uses an isolated WebView2 data directory and disables the sandbox. Keep it only when the standard mode cannot display the window.\n\nUse compatibility mode directly for future launches of this DBX version?\nChoose No to retry standard mode on the next launch.\n\nRecovery log: {log_path}"
        )
    };
    let title = "DBX".encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let body = body.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        ) == IDYES
    }
}

#[cfg(not(target_os = "windows"))]
fn confirm_keep_compatibility_mode() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn show_recovery_failure_message() {
    let log_path =
        startup_log_path().map(|path| path.display().to_string()).unwrap_or_else(|| "startup.log".to_string());
    let locale = sys_locale::get_locale().unwrap_or_default().to_ascii_lowercase();
    let body = if locale.starts_with("zh") {
        format!("DBX 已尝试企业环境兼容模式，但主窗口仍未创建。\n\n请将此日志发给维护者：{log_path}")
    } else {
        format!(
            "DBX tried enterprise environment compatibility mode, but the main window was still not created.\n\nPlease send this log to the maintainer: {log_path}"
        )
    };
    windows_ok_message("DBX", &body);
}

#[cfg(not(target_os = "windows"))]
fn show_recovery_failure_message() {}

#[cfg(test)]
mod tests {
    use super::{
        compatibility_marker_contents, compatibility_marker_path_from_appdata, compatibility_profile_path_from_inputs,
        compatibility_profile_ready_record, configure_recovery_child, resolve_compatibility_mode,
        should_attempt_enterprise_recovery, startup_log_dir_from_inputs, RECOVERY_ATTEMPT_ENV, RECOVERY_PARENT_PID_ENV,
    };
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn startup_log_uses_windows_appdata() {
        assert_eq!(
            startup_log_dir_from_inputs("windows", None, Some(OsString::from(r"C:\Users\test\AppData\Roaming")),),
            Some(PathBuf::from(r"C:\Users\test\AppData\Roaming").join("com.dbx.app"))
        );
    }

    #[test]
    fn startup_log_prefers_explicit_directory() {
        assert_eq!(
            startup_log_dir_from_inputs(
                "windows",
                Some(OsString::from(r"D:\DBXDiagnostics")),
                Some(OsString::from(r"C:\Users\test\AppData\Roaming")),
            ),
            Some(PathBuf::from(r"D:\DBXDiagnostics"))
        );
    }

    #[test]
    fn enterprise_compatibility_paths_are_isolated() {
        assert_eq!(
            compatibility_marker_path_from_appdata(Some(OsString::from(r"C:\Users\test\AppData\Roaming"))),
            Some(
                PathBuf::from(r"C:\Users\test\AppData\Roaming")
                    .join("com.dbx.app")
                    .join("webview2-enterprise-compat.enabled")
            )
        );
        assert_eq!(
            compatibility_profile_path_from_inputs(
                Some(OsString::from(r"C:\Users\test\AppData\Local")),
                Some(OsString::from(r"C:\Users\test\AppData\Roaming")),
            ),
            (
                Some(
                    PathBuf::from(r"C:\Users\test\AppData\Local")
                        .join("com.dbx.app")
                        .join("webview2-enterprise-compat")
                ),
                "local_appdata",
            )
        );
    }

    #[test]
    fn recovery_only_triggers_for_the_observed_hard_startup_stall() {
        assert!(should_attempt_enterprise_recovery(true, false, false, 0, false));
        assert!(!should_attempt_enterprise_recovery(false, false, false, 0, false));
        assert!(!should_attempt_enterprise_recovery(true, true, false, 0, false));
        assert!(!should_attempt_enterprise_recovery(true, false, false, 1, false));
        assert!(!should_attempt_enterprise_recovery(true, false, false, 0, true));
    }

    #[test]
    fn disable_enterprise_compat_prevents_recovery_during_a_hard_stall() {
        assert!(!should_attempt_enterprise_recovery(true, false, true, 0, false));
    }

    #[test]
    fn disable_enterprise_compat_overrides_recovery_and_marker_modes() {
        assert_eq!(resolve_compatibility_mode(true, false, true), (false, false));
        assert_eq!(resolve_compatibility_mode(false, true, true), (false, false));
        assert_eq!(resolve_compatibility_mode(true, false, false), (true, true));
        assert_eq!(resolve_compatibility_mode(false, true, false), (false, true));
    }

    #[test]
    fn compatibility_profile_logs_only_its_source_category() {
        let (profile, source) = compatibility_profile_path_from_inputs(
            None,
            Some(OsString::from(r"C:\Users\private-user\AppData\Roaming")),
        );
        assert!(profile.is_some());
        assert_eq!(source, "appdata_fallback");
        let record = compatibility_profile_ready_record(source);
        assert_eq!(record, "enterprise compatibility profile ready source=appdata_fallback");
        assert!(!record.contains("private-user"));
        assert!(!record.contains(r"C:\Users"));
    }

    #[test]
    fn recovery_child_receives_parent_handoff_without_disabling_single_instance() {
        let mut command = std::process::Command::new("dbx-test");
        configure_recovery_child(&mut command, 4242);
        let envs = command.get_envs().collect::<Vec<_>>();
        assert!(envs
            .iter()
            .any(|(key, value)| { *key == RECOVERY_ATTEMPT_ENV && value.is_some_and(|value| value == "1") }));
        assert!(envs
            .iter()
            .any(|(key, value)| { *key == RECOVERY_PARENT_PID_ENV && value.is_some_and(|value| value == "4242") }));
    }

    #[test]
    fn compatibility_marker_is_scoped_to_the_current_version() {
        assert_eq!(compatibility_marker_contents("0.5.72"), "version=0.5.72\nmode=isolated-profile-no-sandbox\n");
    }
}
