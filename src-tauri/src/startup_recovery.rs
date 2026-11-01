//! Windows startup diagnostics and the ordered startup-compatibility ladder.
//!
//! Some Windows 10 enterprise machines (360 安全卫士 / 奇安信 / 卡巴斯基 and other
//! security products) block WebView2 from creating its browser process. The Tauri
//! event loop then never runs (or starts but the main window stays invisible with
//! `Runtime(FailedToReceiveMessage)` window queries) and the user sees nothing.
//!
//! The previous behaviour was a single retry with one "enterprise compatibility"
//! profile. Norton worked with it; 360 / QiAnXin / Kaspersky still did not. This
//! module now owns a deterministic *ladder* of startup profiles: every profile is
//! a set of WebView2 environment overrides (user data folder, browser arguments,
//! warm-up preflight, scan delay, elevation, relocated executable), and a failed
//! attempt relaunches the executable with the next profile through environment
//! variables (see [`CompatProfile`]). The last successful profile is recorded so
//! a later launch can go straight to it (after asking the user once), and every
//! attempt appends structured evidence to `startup.log` — the file users send to
//! the maintainer.
//!
//! Design constraints:
//! - The standard startup path must stay byte-for-byte equivalent in behaviour:
//!   no environment overrides, no dialogs, no retries unless the main window
//!   never becomes visible.
//! - A profile only changes WebView2 environment variables *before* Tauri builds
//!   the webview, because wry reads them at environment-creation time. The
//!   vendored wry patch makes `WEBVIEW2_USER_DATA_FOLDER` and
//!   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` effective (upstream wry always set
//!   explicit options, which made the variables no-ops).
//! - The chain must be bounded: a hard cap on attempts, and a one-shot guard for
//!   the elevated profile so UAC cannot loop.
//! - Diagnostics in `startup.log` are deliberately path-class only (no usernames,
//!   no full user-profile paths) because users email the file.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const STARTUP_LOG_FILE: &str = "startup.log";
#[cfg(target_os = "windows")]
const RUNTIME_RECOVERY_LOG_FILE: &str = "webview2-recovery.log";
const STARTUP_LOG_DIR_ENV: &str = "DBX_STARTUP_LOG_DIR";
const KEEP_STARTUP_LOG_ENV: &str = "DBX_KEEP_STARTUP_LOG";
const NO_SANDBOX_ENV: &str = "DBX_WEBVIEW2_NO_SANDBOX";
/// Set on every compatibility child: legacy token for "this is a recovery attempt".
// Kept unconditional: the shared browser-argument preparation code (also built
// for host-side unit tests) reads it; it is only meaningful for Win7 targets.
const DISABLE_WIN7_CSS_COLOR4_ENV: &str = "DBX_DISABLE_WIN7_CSS_COLOR4";
const RECOVERY_ATTEMPT_ENV: &str = "DBX_STARTUP_COMPAT_RECOVERY";
/// Parent process id, used to wait for the single-instance mutex handoff.
const RECOVERY_PARENT_PID_ENV: &str = "DBX_STARTUP_COMPAT_PARENT_PID";
/// The profile index executed by this process. `0`/unset = standard startup.
const COMPAT_PROFILE_ENV: &str = "DBX_STARTUP_COMPAT_PROFILE";
/// Comma separated profile indexes already attempted in this chain.
const COMPAT_HISTORY_ENV: &str = "DBX_STARTUP_COMPAT_HISTORY";
/// Set once the elevated profile has been attempted, so UAC cannot loop.
const COMPAT_ELEVATED_ENV: &str = "DBX_STARTUP_COMPAT_ELEVATED";
/// Captured once per chain: the user's original WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
/// Each profile rebuilds the effective argument list from this base instead of
/// accumulating flags from the previous attempt.
const COMPAT_BASE_ARGS_ENV: &str = "DBX_STARTUP_COMPAT_BASE_ARGS";
const DISABLE_ENTERPRISE_COMPAT_ENV: &str = "DBX_DISABLE_ENTERPRISE_COMPAT";
const DISABLE_STARTUP_COMPAT_ENV: &str = "DBX_DISABLE_STARTUP_COMPAT";
/// Optional test hook: overrides the standard-mode watchdog delay in seconds.
const WATCHDOG_SECS_ENV: &str = "DBX_STARTUP_WATCHDOG_SECS";
/// Optional test hook: how long to keep waiting after a failed window probe
/// before escalating (gives a slow WebView2 creation a last chance).
const FAST_FAIL_GRACE_MS_ENV: &str = "DBX_STARTUP_COMPAT_FAST_FAIL_GRACE_MS";

const WINDOWS_APP_DATA_DIR_NAME: &str = "com.dbx.app";
const COMPATIBILITY_MARKER_FILE: &str = "webview2-enterprise-compat.enabled";
const COMPATIBILITY_PROFILE_DIR: &str = "webview2-enterprise-compat";
const COMPATIBILITY_TEMP_PROFILE_DIR: &str = "dbx-webview2-compat";
const STARTUP_LOG_BUFFER_CAPACITY: usize = 512;
/// Standard startup: the app may legitimately take a while on cold/slow disks.
const STARTUP_WATCHDOG_DELAY: Duration = Duration::from_secs(60);
/// Compatibility attempts are experiments: fail fast and move on.
const COMPAT_WATCHDOG_DELAY: Duration = Duration::from_secs(30);
const FAST_FAIL_GRACE: Duration = Duration::from_secs(6);
#[cfg(target_os = "windows")]
const RECOVERY_PARENT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "windows")]
const PREFLIGHT_CHILD_TIMEOUT: Duration = Duration::from_secs(45);

/// One startup-compatibility profile. Every field must be pure data so the
/// ladder is testable without Windows/WebView2 (`cargo test` on any host).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompatUserData {
    /// Keep whatever WebView2/wry would use (standard behaviour).
    Default,
    /// Isolated folder: %LOCALAPPDATA%\com.dbx.app\webview2-enterprise-compat
    Isolated,
    /// Per-user temp folder: %TEMP%\dbx-webview2-compat
    Temp,
}

#[derive(Clone, Copy, Debug)]
struct CompatProfile {
    index: u8,
    /// Stable id used in logs and the persisted marker.
    id: &'static str,
    label_zh: &'static str,
    label_en: &'static str,
    user_data: CompatUserData,
    /// Extra Chromium switches merged into WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
    browser_args: &'static str,
    /// Sleep before Tauri builds the webview (lets a security product finish its
    /// first-run scan of msedgewebview2.exe / dbx.exe).
    start_delay: Duration,
    /// Create and release a WebView2 environment in a throwaway child process
    /// before the real window is created. The scan/trust side effect is the point.
    warmup: bool,
    /// Relaunch through ShellExecuteW "runas" (UAC). Some AV products do not
    /// block browser child processes of elevated applications.
    elevated: bool,
    /// Apply the per-user AppCompat "Windows 8" layer to msedgewebview2.exe
    /// before the webview is created. Field evidence: this workaround unblocks
    /// WebView2 startup when an injected DLL / code-integrity hook kills the
    /// renderer (see `docs/win-av-compat-research.md`, WebView2Feedback #4094).
    /// Reversible; removed again on final failure or when the user declines to
    /// keep the working compatibility mode.
    appcompat_win8: bool,
    /// Copy the executable to %TEMP% and relaunch from there: defeats path-based
    /// AV rules aimed at the install directory.
    temp_copy: bool,
    /// Watchdog budget for this attempt (including start_delay is added on top).
    watchdog: Duration,
}

/// Ordered ladder. The first profile is the old enterprise compatibility mode;
/// later profiles add progressively more aggressive workarounds. Profiles are
/// only ever spawned after a detected startup failure, so their risk is bounded
/// to machines where the app cannot start at all.
///
/// Ordering rationale (from `docs/win-av-compat-research.md`):
/// - Cheapest/most likely AV-interference fixes first (sandbox/GPU/process flags).
/// - `RendererCodeIntegrity` can only be disabled on WebView2 < 118; on newer
///   runtimes the flag is a no-op, so it is bundled into later flag profiles
///   instead of a dedicated attempt.
/// - `--no-zygote`, `--disable-dev-shm-usage` and `--user-data-dir` are Linux /
///   non-WebView2 mechanisms and are deliberately absent.
/// - `--disable-breakpad` / `--disable-crash-reporter` are harmful on WebView2
///   (Microsoft requires Crashpad for content to load) and are absent.
/// - Each profile gets its own WebView2 user data directory: reusing one folder
///   with different environment options can fail with ERROR_INVALID_STATE.
const COMPAT_PROFILES: &[CompatProfile] = &[
    CompatProfile {
        index: 1,
        id: "isolated-no-sandbox",
        label_zh: "隔离数据目录 + 关闭沙箱和 GPU 加速",
        label_en: "isolated user data + sandbox/GPU off",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: COMPAT_WATCHDOG_DELAY,
    },
    CompatProfile {
        index: 2,
        id: "renderer-code-integrity-off",
        label_zh: "关闭 WebView2 渲染器代码完整性校验（仅旧版运行时有效）",
        label_en: "WebView2 RendererCodeIntegrity off (old runtimes only)",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: COMPAT_WATCHDOG_DELAY,
    },
    CompatProfile {
        index: 3,
        id: "subprocess-sandbox-off",
        label_zh: "关闭 GPU 沙箱与首次运行/后台网络",
        label_en: "GPU/utility sandbox off, first-run and background network off",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu --disable-gpu-sandbox --no-first-run \
            --disable-component-update --disable-background-networking \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: COMPAT_WATCHDOG_DELAY,
    },
    CompatProfile {
        index: 4,
        id: "in-process-gpu",
        label_zh: "GPU 进程内联（规避 GPU 子进程被拦截）",
        label_en: "in-process GPU (avoid a blocked GPU child process)",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu-sandbox --in-process-gpu \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: COMPAT_WATCHDOG_DELAY,
    },
    CompatProfile {
        index: 5,
        id: "temp-user-data",
        label_zh: "临时目录 WebView2 数据 + 关闭沙箱",
        label_en: "temp WebView2 user data + sandbox off",
        user_data: CompatUserData::Temp,
        browser_args: "--no-sandbox --disable-gpu --disable-gpu-sandbox --no-first-run \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: COMPAT_WATCHDOG_DELAY,
    },
    CompatProfile {
        index: 6,
        id: "av-scan-delay",
        label_zh: "等待杀软首次扫描完成（20 秒）后启动",
        label_en: "wait 20s for AV first-run scan",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::from_secs(20),
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: Duration::from_secs(45),
    },
    CompatProfile {
        index: 7,
        id: "warmup-preflight",
        label_zh: "先预热启动 WebView2 再拉起主窗口",
        label_en: "warm up WebView2 in a helper process first",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu --disable-gpu-sandbox --no-first-run \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: true,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: Duration::from_secs(40),
    },
    CompatProfile {
        index: 8,
        id: "appcompat-win8",
        label_zh: "给 WebView2 子进程设置 Windows 8 兼容模式",
        label_en: "AppCompat Windows 8 layer for msedgewebview2.exe",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu --disable-gpu-sandbox --no-first-run \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: true,
        temp_copy: false,
        watchdog: Duration::from_secs(40),
    },
    CompatProfile {
        index: 9,
        id: "elevated-relaunch",
        label_zh: "以管理员权限重新启动（会弹 UAC）",
        label_en: "relaunch elevated (UAC prompt)",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu --disable-gpu-sandbox --no-first-run \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: true,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: Duration::from_secs(45),
    },
    CompatProfile {
        index: 10,
        id: "temp-relocated",
        label_zh: "从临时目录副本启动（规避安装目录规则）",
        label_en: "launch a copy from %TEMP%",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu --disable-gpu-sandbox --no-first-run \
            --disable-features=RendererCodeIntegrity,msSmartScreenProtection",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: true,
        watchdog: Duration::from_secs(45),
    },
    CompatProfile {
        index: 11,
        id: "single-process-experimental",
        label_zh: "单进程渲染模式（实验性，WebView2 可能不支持）",
        label_en: "single-process renderer (experimental, may be unsupported)",
        user_data: CompatUserData::Isolated,
        browser_args: "--no-sandbox --disable-gpu --single-process",
        start_delay: Duration::ZERO,
        warmup: false,
        elevated: false,
        appcompat_win8: false,
        temp_copy: false,
        watchdog: COMPAT_WATCHDOG_DELAY,
    },
];

#[derive(Default)]
struct StartupProbeState {
    persistent: bool,
    lines: VecDeque<String>,
}

static STARTUP_PROBE_STATE: LazyLock<Mutex<StartupProbeState>> =
    LazyLock::new(|| Mutex::new(StartupProbeState::default()));
static STARTUP_PROBE_ACTIVE: AtomicBool = AtomicBool::new(false);
static COMPAT_DISABLED: AtomicBool = AtomicBool::new(false);
static MARKER_MODE: AtomicBool = AtomicBool::new(false);
static CURRENT_PROFILE: AtomicU8 = AtomicU8::new(0);
static WINDOW_PROBE_FAILED: AtomicBool = AtomicBool::new(false);
static RUN_EVENT_COUNT: AtomicUsize = AtomicUsize::new(0);
static FRONTEND_READY_SIGNAL: LazyLock<(Mutex<bool>, Condvar)> = LazyLock::new(|| (Mutex::new(false), Condvar::new()));

fn env_flag(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

fn env_duration_ms(name: &str, default: Duration) -> Duration {
    std::env::var(name).ok().and_then(|value| value.parse::<u64>().ok()).map(Duration::from_millis).unwrap_or(default)
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

#[cfg_attr(not(test), allow(dead_code))]
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

/// Returns the folder a profile wants for WebView2 user data plus a
/// log-safe source class (never the actual user path).
#[cfg_attr(not(test), allow(dead_code))]
fn compat_profile_user_data_path(
    profile: Option<&CompatProfile>,
    local_appdata: Option<OsString>,
    windows_appdata: Option<OsString>,
    temp_dir: Option<OsString>,
) -> (Option<PathBuf>, &'static str, bool) {
    match profile.map(|profile| profile.user_data).unwrap_or(CompatUserData::Default) {
        CompatUserData::Default => (None, "default", false),
        CompatUserData::Isolated => {
            let (path, source) = compatibility_profile_path_from_inputs(local_appdata, windows_appdata);
            (path.map(|path| path.join(profile_user_data_suffix(profile))), source, true)
        }
        CompatUserData::Temp => {
            let path = temp_dir.filter(|value| !value.is_empty()).map(PathBuf::from);
            (
                path.map(|dir| dir.join(COMPATIBILITY_TEMP_PROFILE_DIR).join(profile_user_data_suffix(profile))),
                "temp",
                true,
            )
        }
    }
}

/// Every profile uses its own WebView2 user data directory: reusing one folder
/// with different environment options can fail with ERROR_INVALID_STATE, and a
/// stale profile from a crashed attempt must not poison the next one.
fn profile_user_data_suffix(profile: Option<&CompatProfile>) -> String {
    match profile {
        Some(profile) => format!("profile-{}", profile.index),
        None => "profile-standard".to_string(),
    }
}

#[cfg(target_os = "windows")]
fn compat_profile_user_data() -> (Option<PathBuf>, &'static str, bool) {
    compat_profile_user_data_path(
        current_profile(),
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("APPDATA"),
        std::env::var_os("TEMP"),
    )
}

fn compat_profile(index: u8) -> Option<&'static CompatProfile> {
    COMPAT_PROFILES.iter().find(|profile| profile.index == index)
}

fn current_profile() -> Option<&'static CompatProfile> {
    compat_profile(CURRENT_PROFILE.load(Ordering::Acquire))
}

fn current_profile_index() -> u8 {
    CURRENT_PROFILE.load(Ordering::Acquire)
}

fn max_compat_profile_index() -> u8 {
    COMPAT_PROFILES.last().map(|profile| profile.index).unwrap_or(0)
}

fn parse_profile_index(value: Option<&str>) -> Option<u8> {
    value.and_then(|value| value.trim().parse::<u8>().ok()).filter(|index| *index > 0)
}

fn parse_history(history: &str) -> Vec<u8> {
    history
        .split(',')
        .filter_map(|entry| entry.trim().parse::<u8>().ok())
        .filter(|index| *index > 0 && compat_profile(*index).is_some())
        .collect()
}

fn format_history(history: &str) -> String {
    let indexes = parse_history(history);
    if indexes.is_empty() {
        return "none".to_string();
    }
    indexes
        .iter()
        .map(|index| {
            let id = compat_profile(*index).map(|profile| profile.id).unwrap_or("unknown");
            format!("{index}:{id}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn appended_history(history: &str, index: u8) -> String {
    let mut indexes = parse_history(history);
    if index > 0 && !indexes.contains(&index) {
        indexes.push(index);
    }
    indexes.iter().map(u8::to_string).collect::<Vec<_>>().join(",")
}

fn compatibility_marker_contents(version: &str, profile: &CompatProfile) -> String {
    format!("version={version}\nmode=startup-compat-profile\nprofile={}\nprofile_id={}\n", profile.index, profile.id)
}

fn parse_compatibility_marker(contents: &str, version: &str) -> Option<u8> {
    let mut marker_version = None;
    let mut mode = None;
    let mut profile = None;
    for line in contents.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "version" => marker_version = Some(value.trim()),
            "mode" => mode = Some(value.trim()),
            "profile" => profile = value.trim().parse::<u8>().ok(),
            _ => {}
        }
    }
    if marker_version != Some(version) {
        return None;
    }
    match mode {
        Some("startup-compat-profile") => profile.filter(|index| compat_profile(*index).is_some()),
        // Migration: the pre-ladder marker only meant "the old enterprise
        // compatibility mode worked", which is profile 1 of the ladder.
        Some("isolated-profile-no-sandbox-disable-gpu") => Some(1),
        _ => None,
    }
}

#[cfg(test)]
#[cfg_attr(not(test), allow(dead_code))]
fn compatibility_marker_contains_profile_mismatch(contents: &str, version: &str, profile: u8) -> bool {
    match parse_compatibility_marker(contents, version) {
        Some(marker_profile) => marker_profile != profile,
        None => true,
    }
}

#[cfg(test)]
#[cfg_attr(not(test), allow(dead_code))]
fn expected_marker_mismatch(contents: &str, version: &str, profile: u8) -> bool {
    compatibility_marker_contains_profile_mismatch(contents, version, profile)
}

fn read_compatibility_marker(version: &str) -> Option<u8> {
    let path = compatibility_marker_path()?;
    let contents = std::fs::read_to_string(path).ok()?;
    parse_compatibility_marker(&contents, version)
}

fn write_compatibility_marker(profile: &CompatProfile) -> Result<(), String> {
    let path = compatibility_marker_path().ok_or_else(|| "APPDATA is unavailable".to_string())?;
    if !ensure_parent_dir(&path) {
        return Err("failed to create compatibility marker directory".to_string());
    }
    std::fs::write(&path, compatibility_marker_contents(env!("CARGO_PKG_VERSION"), profile))
        .map_err(|error| error.to_string())
}

fn compatibility_profile_ready_record(profile: Option<&CompatProfile>, source: &str) -> String {
    let id = profile.map(|profile| profile.id).unwrap_or("standard");
    format!("compat profile user data ready source={source} profile={id}")
}

#[cfg(test)]
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
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid) };
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

/// Appends a runtime (post-startup) recovery event to a dedicated log file
/// (`webview2-recovery.log` next to `startup.log`).
///
/// Unlike the `log` facade, this is **not** gated by the desktop
/// `debug_logging_enabled` setting (`apply_debug_log_level` sets the global
/// `log::set_max_level` to `Off` in packaged builds by default), so packaged
/// Windows builds always record WebView2 process-failure recovery decisions
/// on affected devices. The `log`/`eprintln` channels are still used on top
/// of this in debug builds.
#[cfg(target_os = "windows")]
pub(crate) fn record_runtime_recovery_event(message: impl AsRef<str>) {
    let Some(dir) = startup_log_dir() else { return };
    write_line(&dir.join(RUNTIME_RECOVERY_LOG_FILE), &format_probe_line(message.as_ref()));
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
    let enterprise_compat_disabled = env_flag(DISABLE_ENTERPRISE_COMPAT_ENV) || env_flag(DISABLE_STARTUP_COMPAT_ENV);
    COMPAT_DISABLED.store(enterprise_compat_disabled, Ordering::Release);

    let recovery_requested = env_flag(RECOVERY_ATTEMPT_ENV);
    let env_profile = parse_profile_index(std::env::var(COMPAT_PROFILE_ENV).ok().as_deref());
    let marker_profile =
        if enterprise_compat_disabled { None } else { read_compatibility_marker(env!("CARGO_PKG_VERSION")) };
    let (profile_index, marker_mode) = if enterprise_compat_disabled {
        (0, false)
    } else if let Some(index) = env_profile {
        (index, false)
    } else if recovery_requested {
        // Legacy recovery token (no profile index): the old enterprise mode was
        // profile 1 of the new ladder.
        (1, false)
    } else if let Some(index) = marker_profile {
        (index, true)
    } else {
        (0, false)
    };
    let profile_index = if compat_profile(profile_index).is_some() { profile_index } else { 0 };
    let marker_mode = marker_mode && compat_profile(profile_index).is_some();
    let history = std::env::var(COMPAT_HISTORY_ENV).unwrap_or_default();

    // The parent owns tauri-plugin-single-instance's mutex. Wait for process exit
    // before building Tauri so the recovery child can acquire the same mutex.
    let parent_handoff = (recovery_requested && !enterprise_compat_disabled).then(wait_for_recovery_parent_exit);

    if !recovery_requested {
        if let Some(path) = startup_log_path() {
            let _ = std::fs::remove_file(path);
        }
    }
    if !enterprise_compat_disabled {
        if let Some(path) = compatibility_marker_path().filter(|path| path.is_file()) {
            let has_valid_marker = marker_profile.is_some() || marker_mode;
            if !has_valid_marker {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    {
        let mut state = STARTUP_PROBE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *state = StartupProbeState {
            persistent: recovery_requested,
            lines: VecDeque::with_capacity(STARTUP_LOG_BUFFER_CAPACITY),
        };
    }
    STARTUP_PROBE_ACTIVE.store(true, Ordering::Release);
    CURRENT_PROFILE.store(profile_index, Ordering::Release);
    MARKER_MODE.store(marker_mode, Ordering::Release);
    WINDOW_PROBE_FAILED.store(false, Ordering::Release);
    RUN_EVENT_COUNT.store(0, Ordering::Release);
    *FRONTEND_READY_SIGNAL.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = false;

    install_panic_hook();
    let profile = current_profile();
    record(format!(
        "process start version={} os={} arch={} recovery_attempt={} compat_profile={} profile_id={} marker_mode={} enterprise_compat_disabled={} history={}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        recovery_requested,
        profile_index,
        profile.map(|profile| profile.id).unwrap_or("standard"),
        marker_mode,
        enterprise_compat_disabled,
        format_history(&history)
    ));
    if marker_mode {
        record(format!(
            "startup compatibility marker says profile {} worked last time; starting directly with it",
            profile_index
        ));
    }
    if let Some(parent_handoff) = parent_handoff {
        record(format!("single-instance recovery handoff status={parent_handoff}"));
    }
    for line in prepare_browser_environment(profile) {
        record(line);
    }
    if let Some(profile) = profile {
        record(format!(
            "compat profile settings index={} id={} label_zh={} label_en={} user_data={:?} watchdog_secs={} start_delay_ms={} warmup={} elevated={} temp_copy={}",
            profile.index,
            profile.id,
            profile.label_zh,
            profile.label_en,
            profile.user_data,
            profile.watchdog.as_secs(),
            profile.start_delay.as_millis(),
            profile.warmup,
            profile.elevated,
            profile.temp_copy
        ));
    }
}

fn append_webview2_argument_to_value(mut args: String, argument: &str) -> String {
    if args.split_whitespace().any(|value| value == argument) {
        return args;
    }
    if !args.is_empty() {
        args.push(' ');
    }
    args.push_str(argument);
    args
}

fn webview2_compatibility_arguments(mut args: String, enterprise_compat: bool, manual_no_sandbox: bool) -> String {
    if enterprise_compat || manual_no_sandbox {
        args = append_webview2_argument_to_value(args, "--no-sandbox");
    }
    if enterprise_compat {
        args = append_webview2_argument_to_value(args, "--disable-gpu");
    }
    args
}

/// Captures the user's original browser arguments once, then merges the manual
/// `DBX_WEBVIEW2_NO_SANDBOX` flag and the current profile's switches on top of
/// that base. Returns log lines (never containing user paths).
fn prepare_browser_environment(profile: Option<&CompatProfile>) -> Vec<String> {
    let mut lines = Vec::new();
    if std::env::var_os(COMPAT_BASE_ARGS_ENV).is_none() {
        let base = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        std::env::set_var(COMPAT_BASE_ARGS_ENV, &base);
    }
    let base = std::env::var(COMPAT_BASE_ARGS_ENV).unwrap_or_default();
    let manual_no_sandbox = env_flag(NO_SANDBOX_ENV);
    // Preserve upstream's Win7 CSSColor4 handling: it edits the same argument
    // list the compatibility profiles extend, so it has to run on the base args
    // before the profile switches are appended.
    let win7_css_disabled = env_flag(DISABLE_WIN7_CSS_COLOR4_ENV);
    let base = crate::webview2_legacy_css::configure(&base, cfg!(target_vendor = "win7"), win7_css_disabled);
    let mut args = webview2_compatibility_arguments(base.clone(), profile.is_some(), manual_no_sandbox);
    let profile_args = profile.map(|profile| profile.browser_args).unwrap_or_default();
    for argument in profile_args.split_whitespace() {
        args = append_webview2_argument_to_value(args, argument);
    }
    if cfg!(target_vendor = "win7") {
        lines.push(format!(
            "Win7 WebView2 CSSColor4 requested={} opt_out={win7_css_disabled}",
            crate::webview2_legacy_css::requested(&args)
        ));
    }
    if !args.trim().is_empty() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args.trim());
    }

    match profile.map(|profile| profile.user_data).unwrap_or(CompatUserData::Default) {
        CompatUserData::Default => {
            // Standard startup: do not touch the user data folder. Profiles that
            // explicitly ask for Default remove a value inherited from an
            // earlier attempt in the same chain.
            if profile.is_some() {
                std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
            }
        }
        CompatUserData::Isolated | CompatUserData::Temp => {
            #[cfg(target_os = "windows")]
            let (path, source) = {
                let (path, source, _) = compat_profile_user_data();
                (path, source)
            };
            #[cfg(not(target_os = "windows"))]
            let (path, source) = (None::<PathBuf>, "unsupported_platform");
            match path {
                Some(path) => match std::fs::create_dir_all(&path) {
                    Ok(()) => {
                        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &path);
                        lines.push(compatibility_profile_ready_record(profile, source));
                    }
                    Err(_error) => lines.push(format!(
                        "compat profile user data folder unavailable source={source} error_class=create_failed"
                    )),
                },
                None => lines.push(format!(
                    "compat profile user data folder unavailable source={source} error_class=missing_env"
                )),
            }
        }
    }

    if profile.is_some() || manual_no_sandbox || !base.is_empty() {
        lines.push(format!(
            "compat browser args prepared manual_no_sandbox={manual_no_sandbox} profile_args_present={} effective={}",
            !profile_args.is_empty(),
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default()
        ));
    }
    lines
}

/// Runs the pre-Tauri part of the active compatibility profile: scan delay and
/// WebView2 warm-up preflight. Called from `run()` before the Tauri builder
/// creates the webview; a no-op in standard mode and on non-Windows hosts.
pub(crate) fn run_profile_pre_tauri_hooks() {
    #[cfg(target_os = "windows")]
    {
        let Some(profile) = current_profile() else { return };
        if profile.index == 0 {
            return;
        }
        if !profile.start_delay.is_zero() {
            record(format!("compat profile waiting {}ms before tauri build", profile.start_delay.as_millis()));
            std::thread::sleep(profile.start_delay);
            record("compat profile scan delay finished");
        }
        if profile.appcompat_win8 {
            record("compat profile applying AppCompat Windows 8 layer to msedgewebview2.exe");
            match crate::windows_appcompat::set_win8_compat_layer() {
                Ok(summary) => record(summary),
                Err(error) => record(format!("appcompat win8 profile could not apply layer: {error}")),
            }
        }
        if profile.warmup {
            record(
                "compat profile warm-up preflight starting (child process creates and releases a WebView2 environment)",
            );
            let outcome = crate::webview2_preflight::spawn_preflight_child(PREFLIGHT_CHILD_TIMEOUT);
            record(format!(
                "compat warm-up preflight finished spawned={} ok={} hresult={} elapsed_ms={} timed_out={} exit_code={:?}",
                outcome.spawned,
                outcome.ok,
                outcome.hresult.as_deref().unwrap_or("-"),
                outcome.elapsed_ms,
                outcome.timed_out,
                outcome.exit_code
            ));
        }
    }
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

pub(crate) fn record_run_event() {
    if STARTUP_PROBE_ACTIVE.load(Ordering::Acquire) {
        RUN_EVENT_COUNT.fetch_add(1, Ordering::Relaxed);
    }
}

/// Called by `lib.rs` after each attempt to show the main window. A failing
/// visibility query means the WebView2 window never became usable; arming the
/// fast-fail signal lets the watchdog escalate after a short grace period instead
/// of waiting the full watchdog budget.
pub(crate) fn report_window_visibility_probe(main_window_visible: bool) {
    if main_window_visible || !STARTUP_PROBE_ACTIVE.load(Ordering::Acquire) {
        return;
    }
    if !WINDOW_PROBE_FAILED.swap(true, Ordering::AcqRel) {
        record("main window visibility probe failed; arming fast startup recovery");
    } else {
        record("main window visibility probe still failing");
    }
    let (_, wake) = &*FRONTEND_READY_SIGNAL;
    wake.notify_all();
}

/// Cheap probe used by `lib.rs` around `show_main_window` calls.
pub(crate) fn probe_main_window_visible<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.get_webview_window("main").and_then(|window| window.is_visible().ok()).unwrap_or(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupWaitOutcome {
    Ready,
    TimedOut,
    FastFail,
}

fn wait_for_ready_or_failure(timeout: Duration, fast_fail_grace: Duration) -> StartupWaitOutcome {
    let (signal, wake) = &*FRONTEND_READY_SIGNAL;
    let mut ready = signal.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let deadline = Instant::now() + timeout;
    let mut fast_fail_deadline: Option<Instant> = None;
    loop {
        if *ready {
            return StartupWaitOutcome::Ready;
        }
        let now = Instant::now();
        if now >= deadline {
            return StartupWaitOutcome::TimedOut;
        }
        if fast_fail_deadline.is_none() && WINDOW_PROBE_FAILED.load(Ordering::Acquire) {
            fast_fail_deadline = Some((now + fast_fail_grace).min(deadline));
        }
        if let Some(fast_fail_deadline) = fast_fail_deadline {
            if now >= fast_fail_deadline {
                return StartupWaitOutcome::FastFail;
            }
        }
        let wake_at = fast_fail_deadline.unwrap_or(deadline);
        let (next_ready, wait_result) = wake
            .wait_timeout(ready, wake_at.saturating_duration_since(now))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ready = next_ready;
        if *ready {
            return StartupWaitOutcome::Ready;
        }
        if !wait_result.timed_out() {
            // Spurious/other notification: re-check state immediately.
            continue;
        }
    }
}

fn should_escalate_startup(compat_disabled: bool, outcome: StartupWaitOutcome) -> bool {
    if compat_disabled {
        return false;
    }
    matches!(outcome, StartupWaitOutcome::TimedOut | StartupWaitOutcome::FastFail)
}

fn main_window_snapshot<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> (bool, bool) {
    let window = app.get_webview_window("main");
    let exists = window.is_some();
    let visible = window.as_ref().and_then(|window| window.is_visible().ok()).unwrap_or(false);
    (exists, visible)
}

fn watchdog_delay_override() -> Option<Duration> {
    std::env::var(WATCHDOG_SECS_ENV).ok().and_then(|value| value.parse::<u64>().ok()).map(Duration::from_secs)
}

pub(crate) fn start_watchdog<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if std::env::consts::OS != "windows" {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let profile = current_profile();
        let base_timeout = profile.map(|profile| profile.watchdog).unwrap_or(STARTUP_WATCHDOG_DELAY);
        let timeout = watchdog_delay_override().unwrap_or(base_timeout);
        let fast_fail_grace = env_duration_ms(FAST_FAIL_GRACE_MS_ENV, FAST_FAIL_GRACE);
        record(format!(
            "startup watchdog armed timeout_secs={} fast_fail_grace_ms={} profile={} marker_mode={}",
            timeout.as_secs(),
            fast_fail_grace.as_millis(),
            current_profile_index(),
            MARKER_MODE.load(Ordering::Acquire)
        ));
        let outcome = wait_for_ready_or_failure(timeout, fast_fail_grace);
        if outcome == StartupWaitOutcome::Ready {
            record("startup watchdog: main window became visible before the deadline");
            return;
        }
        let run_event_count = RUN_EVENT_COUNT.load(Ordering::Acquire);
        let (main_exists, main_visible) = main_window_snapshot(&app);
        if main_visible {
            record("startup watchdog: main window is visible but frontend never reported ready; not escalating");
            return;
        }
        record(format!(
            "startup watchdog after {}s outcome={outcome:?} run_event_count={run_event_count} main_exists={main_exists} main_visible={main_visible} profile={} history={}",
            timeout.as_secs(),
            current_profile_index(),
            format_history(&std::env::var(COMPAT_HISTORY_ENV).unwrap_or_default())
        ));
        let compat_disabled = COMPAT_DISABLED.load(Ordering::Acquire);
        if !should_escalate_startup(compat_disabled, outcome) {
            persist_buffer();
            if compat_disabled {
                append_persisted_record("startup compatibility disabled by environment; not retrying");
            }
            show_recovery_failure_message();
            std::process::exit(1);
        }
        escalate_to_next_profile(outcome);
    });
}

fn escalate_to_next_profile(outcome: StartupWaitOutcome) {
    let current = current_profile_index();
    let history = std::env::var(COMPAT_HISTORY_ENV).unwrap_or_default();
    let history = appended_history(&history, current);
    let stage = match outcome {
        StartupWaitOutcome::TimedOut => "watchdog_timeout",
        StartupWaitOutcome::FastFail => "window_probe_failed",
        StartupWaitOutcome::Ready => "ready",
    };
    record(format!("compat attempt failed profile={current} stage={stage} attempted={}", format_history(&history)));
    persist_buffer();
    let mut next_index = current.saturating_add(1).max(1);
    while next_index <= max_compat_profile_index() {
        let Some(profile) = compat_profile(next_index) else { break };
        if profile.elevated {
            let already_attempted = env_flag(COMPAT_ELEVATED_ENV);
            let already_elevated = crate::windows_appcompat::is_process_elevated();
            if already_attempted || already_elevated {
                record(format!(
                    "compat profile {} skipped: already_elevated={already_elevated} elevated_attempted={already_attempted}",
                    profile.index
                ));
                next_index += 1;
                continue;
            }
        }
        match launch_compat_profile(profile, &history) {
            Ok(launch) => {
                record(format!(
                    "compat profile spawned profile={} id={} launch={} child_pid={:?}",
                    profile.index, profile.id, launch.kind, launch.pid
                ));
                std::process::exit(0);
            }
            Err(error) => {
                record(format!("failed to launch compat profile {}: {error}", profile.index));
                next_index += 1;
            }
        }
    }
    record(format!("all startup compatibility profiles failed support_code={SUPPORT_CODE_COMPAT_EXHAUSTED}"));
    append_persisted_record(format!(
        "all startup compatibility profiles failed support_code={SUPPORT_CODE_COMPAT_EXHAUSTED}"
    ));
    match crate::windows_appcompat::remove_win8_compat_layer() {
        Ok(summary) => append_persisted_record(format!("compat cleanup: {summary}")),
        Err(error) => append_persisted_record(format!("compat cleanup failed: {error}")),
    }
    show_compatibility_failure_message(&history);
    std::process::exit(1);
}

struct CompatLaunch {
    kind: &'static str,
    pid: Option<u32>,
}

/// Starts the next executable in the chain. Normal launches pass the profile
/// through environment variables (the child applies it before Tauri builds).
/// The elevated profile additionally sets the variables in this process because
/// ShellExecuteW inherits the caller's environment.
fn launch_compat_profile(profile: &CompatProfile, history: &str) -> Result<CompatLaunch, String> {
    let child_history = appended_history(history, profile.index);
    let chain_env = [
        (COMPAT_PROFILE_ENV.to_string(), profile.index.to_string()),
        (RECOVERY_ATTEMPT_ENV.to_string(), "1".to_string()),
        (RECOVERY_PARENT_PID_ENV.to_string(), std::process::id().to_string()),
        (COMPAT_HISTORY_ENV.to_string(), child_history.clone()),
    ];
    if profile.elevated {
        return launch_elevated(profile, &chain_env);
    }
    let executable = if profile.temp_copy {
        copy_executable_to_temp()?
    } else {
        std::env::current_exe().map_err(|error| error.to_string())?
    };
    let mut command = std::process::Command::new(&executable);
    command.args(std::env::args_os().skip(1));
    for (key, value) in &chain_env {
        command.env(key, value);
    }
    let child = command.spawn().map_err(|error| error.to_string())?;
    Ok(CompatLaunch { kind: if profile.temp_copy { "temp_copy" } else { "spawn" }, pid: Some(child.id()) })
}

fn copy_executable_to_temp() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let temp_dir = std::env::temp_dir().join("dbx-startup-compat");
    std::fs::create_dir_all(&temp_dir).map_err(|error| format!("create temp dir failed: {error}"))?;
    let target = temp_dir.join(executable.file_name().unwrap_or_else(|| std::ffi::OsStr::new("DBX.exe")));
    std::fs::copy(&executable, &target).map_err(|error| format!("copy executable failed: {error}"))?;
    Ok(target)
}

#[cfg(target_os = "windows")]
fn launch_elevated(profile: &CompatProfile, chain_env: &[(String, String)]) -> Result<CompatLaunch, String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    for (key, value) in chain_env {
        std::env::set_var(key, value);
    }
    std::env::set_var(COMPAT_ELEVATED_ENV, "1");
    let arguments = std::env::args_os()
        .skip(1)
        .map(|argument| {
            let argument = argument.to_string_lossy().to_string();
            if argument.contains(' ') {
                format!("\"{argument}\"")
            } else {
                argument
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = executable.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let parameters: Vec<u16> = arguments.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    let result_code = result as isize;
    if result_code > 32 {
        record(format!("compat profile {} relaunched with elevated privileges (UAC accepted)", profile.index));
        Ok(CompatLaunch { kind: "elevated", pid: None })
    } else {
        Err(format!("ShellExecuteW(runas) failed code={result_code}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn launch_elevated(profile: &CompatProfile, _chain_env: &[(String, String)]) -> Result<CompatLaunch, String> {
    Err(format!("elevated relaunch unsupported on this platform (profile {})", profile.index))
}

fn deactivate_probe() {
    STARTUP_PROBE_ACTIVE.store(false, Ordering::Release);
    let (signal, wake) = &*FRONTEND_READY_SIGNAL;
    *signal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
    wake.notify_all();
    STARTUP_PROBE_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).lines.clear();
}

pub(crate) fn mark_frontend_ready(main_window_visible: bool) {
    if !main_window_visible {
        // Frontend readiness alone is not enough to declare startup healthy:
        // the WebView can load while the native window remains hidden.
        record("frontend ready but main window is not visible; keeping startup watchdog active");
        persist_buffer();
        return;
    }

    let profile = current_profile();
    let profile_index = current_profile_index();
    let keep_requested = env_flag(KEEP_STARTUP_LOG_ENV);
    record(format!(
        "frontend ready with visible main window profile={profile_index} marker_mode={} recovery_attempt={} history={}",
        MARKER_MODE.load(Ordering::Acquire),
        profile_index > 0,
        format_history(&std::env::var(COMPAT_HISTORY_ENV).unwrap_or_default())
    ));
    persist_buffer();
    deactivate_probe();

    if let Some(profile) = profile {
        // No success popup: the app is already usable and a dialog would only
        // interrupt the user. Remember the working method silently so the next
        // launch is fast; if it fails again the remaining profiles are still
        // tried automatically.
        let profile = *profile;
        let result = write_compatibility_marker(&profile)
            .map(|()| "startup compatibility marker saved (remembered automatically)".to_string())
            .unwrap_or_else(|error| format!("startup compatibility marker failed: {error}"));
        append_persisted_record(format!(
            "compat profile succeeded profile={} id={}; {result}",
            profile.index, profile.id
        ));
    } else if keep_requested {
        record("frontend ready; startup log retained by DBX_KEEP_STARTUP_LOG=1");
    } else if let Some(path) = startup_log_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(target_os = "windows")]
fn windows_message_box(title: &str, body: &str, flags: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_SETFOREGROUND};

    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let body: Vec<u16> = body.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), flags | MB_SETFOREGROUND) }
}

/// Stable support codes (startup.log only — the dialog copy already explains the
/// problem, so users do not need to see them).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const SUPPORT_CODE_MISSING_RUNTIME: &str = "DBX-STARTUP-001";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const SUPPORT_CODE_DAMAGED_RUNTIME: &str = "DBX-STARTUP-002";
const SUPPORT_CODE_COMPAT_EXHAUSTED: &str = "DBX-STARTUP-003";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn startup_log_display_path() -> String {
    startup_log_path().map(|path| path.display().to_string()).unwrap_or_else(|| "startup.log".to_string())
}

/// Opens a URL in the default browser. Only fixed/derived URLs are passed here
/// (the offline-package download link for this build), never user input.
#[cfg(target_os = "windows")]
fn open_browser_url(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let url: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both strings are NUL-terminated UTF-16 and outlive the call; the
    // caller passes a fixed URL constant/derived release URL.
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn open_browser_url(_url: &str) {}

/// Opens Explorer with the startup log selected (or its folder when the log does
/// not exist), so "send us the log" is one click away.
#[cfg(target_os = "windows")]
fn open_log_folder() {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let log_path = startup_log_path();
    let parameters = match &log_path {
        Some(log) if log.is_file() => format!("/select,\"{}\"", log.display()),
        _ => {
            let folder = log_path
                .as_ref()
                .and_then(|log| log.parent().map(|parent| parent.display().to_string()))
                .unwrap_or_else(|| "%APPDATA%\\com.dbx.app".to_string());
            format!("\"{folder}\"")
        }
    };
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = "explorer.exe\0".encode_utf16().collect();
    let parameters: Vec<u16> = parameters.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: all strings are NUL-terminated UTF-16 and outlive the call; the
    // command is a fixed explorer.exe invocation (no untrusted input).
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn open_log_folder() {}

/// Failure dialog for the WebView2-runtime cases (missing / damaged). The only
/// user action is downloading DBX's Windows 10 offline package, which embeds the
/// WebView2 installer; no Microsoft page, no extra report file, and no security
/// product names.
#[cfg(target_os = "windows")]
fn show_webview2_runtime_dialog(damaged: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_DEFBUTTON1, MB_ICONWARNING, MB_YESNO};

    let messages = crate::startup_messages::current();
    let log_path = startup_log_display_path();
    let offline_url = crate::startup_messages::offline_installer_url();
    let template = if damaged { messages.damaged_runtime } else { messages.missing_runtime };
    let body = messages.render(template, &log_path, &offline_url);
    let open_download = windows_message_box(messages.title, &body, MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON1) == IDYES;
    if open_download {
        open_browser_url(&offline_url);
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn show_webview2_runtime_dialog(_damaged: bool) {}

/// Failure dialog when every startup-compatibility profile failed (real AV
/// blocking or another window-creation failure). No product names, no attempt
/// list (both are in startup.log); one single log file and one action.
#[cfg(target_os = "windows")]
fn show_compatibility_failure_message(_attempted_history: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_DEFBUTTON1, MB_ICONWARNING, MB_YESNO};

    let messages = crate::startup_messages::current();
    let log_path = startup_log_display_path();
    let offline_url = crate::startup_messages::offline_installer_url();
    let body = messages.render(messages.compatibility_failed, &log_path, &offline_url);
    let open_logs = windows_message_box(messages.title, &body, MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON1) == IDYES;
    if open_logs {
        open_log_folder();
    }
}

#[cfg(not(target_os = "windows"))]
fn show_compatibility_failure_message(_attempted_history: &str) {}

/// Failure dialog for the legacy disabled-compatibility path (`DBX_DISABLE_*`).
#[cfg(target_os = "windows")]
fn show_recovery_failure_message() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_DEFBUTTON1, MB_ICONWARNING, MB_YESNO};

    let messages = crate::startup_messages::current();
    let log_path = startup_log_display_path();
    let offline_url = crate::startup_messages::offline_installer_url();
    let body = messages.render(messages.recovery_disabled, &log_path, &offline_url);
    let open_logs = windows_message_box(messages.title, &body, MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON1) == IDYES;
    if open_logs {
        open_log_folder();
    }
}

#[cfg(not(target_os = "windows"))]
fn show_recovery_failure_message() {}

/// A WebView2 version is registered but its files are missing/corrupted.
///
/// Tauri's own version check (`wry::webview_version()`) only reads the registry,
/// so it passes in this state; window creation then fails/hangs and the startup
/// watchdog used to retry with "enterprise compatibility mode" — which cannot fix
/// broken runtime files and made an installation problem look like AV blocking.
/// This state was observed on a real client machine; show repair guidance instead
/// of running the compatibility ladder.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn handle_damaged_webview2_runtime(runtime_version: Option<&str>) {
    record(format!(
        "webview2 runtime is registered but its files are missing or corrupted (version={}) support_code={SUPPORT_CODE_DAMAGED_RUNTIME}; skipping startup compatibility profiles",
        runtime_version.unwrap_or("<unknown>")
    ));
    persist_buffer();
    show_webview2_runtime_dialog(true);
}

/// The machine has no usable WebView2 runtime.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn handle_missing_webview2_runtime() {
    record(format!(
        "webview2 runtime is not installed support_code={SUPPORT_CODE_MISSING_RUNTIME}; skipping startup compatibility profiles"
    ));
    persist_buffer();
    show_webview2_runtime_dialog(false);
}

#[cfg(test)]
mod tests {
    use super::{
        appended_history, compat_profile, compat_profile_user_data_path, compatibility_marker_contents,
        compatibility_marker_path_from_appdata, compatibility_profile_path_from_inputs,
        compatibility_profile_ready_record, expected_marker_mismatch, format_history, max_compat_profile_index,
        parse_compatibility_marker, parse_history, parse_profile_index, prepare_browser_environment,
        should_escalate_startup, startup_log_dir_from_inputs, webview2_compatibility_arguments, CompatProfile,
        CompatUserData, StartupWaitOutcome, COMPAT_PROFILES, STARTUP_WATCHDOG_DELAY,
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
        let (profile_path, source, dedicated) = compat_profile_user_data_path(
            compat_profile(1),
            Some(OsString::from(r"C:\Users\test\AppData\Local")),
            Some(OsString::from(r"C:\Users\test\AppData\Roaming")),
            None,
        );
        assert_eq!(
            profile_path,
            Some(
                PathBuf::from(r"C:\Users\test\AppData\Local")
                    .join("com.dbx.app")
                    .join("webview2-enterprise-compat")
                    .join("profile-1")
            )
        );
        assert_eq!(source, "local_appdata");
        assert!(dedicated);
    }

    #[test]
    fn compatibility_profile_logs_only_its_source_category() {
        let (profile, source) = compatibility_profile_path_from_inputs(
            None,
            Some(OsString::from(r"C:\Users\private-user\AppData\Roaming")),
        );
        assert!(profile.is_some());
        assert_eq!(source, "appdata_fallback");
        let record = compatibility_profile_ready_record(None, source);
        assert_eq!(record, "compat profile user data ready source=appdata_fallback profile=standard");
        assert!(!record.contains("private-user"));
        assert!(!record.contains(r"C:\Users"));
    }

    #[test]
    fn temp_profile_uses_temp_directory() {
        let temp_profile = COMPAT_PROFILES.iter().find(|profile| profile.user_data == CompatUserData::Temp).unwrap();
        let (path, source, dedicated) = compat_profile_user_data_path(
            Some(temp_profile),
            Some(OsString::from(r"C:\Users\test\AppData\Local")),
            Some(OsString::from(r"C:\Users\test\AppData\Roaming")),
            Some(OsString::from(r"C:\Users\test\AppData\Local\Temp")),
        );
        assert_eq!(
            path,
            Some(
                PathBuf::from(r"C:\Users\test\AppData\Local\Temp")
                    .join("dbx-webview2-compat")
                    .join(format!("profile-{}", temp_profile.index))
            )
        );
        assert_eq!(source, "temp");
        assert!(dedicated);
    }

    #[test]
    fn default_profile_does_not_touch_user_data_folder() {
        let (path, source, dedicated) = compat_profile_user_data_path(
            None,
            Some(OsString::from(r"C:\Users\test\AppData\Local")),
            Some(OsString::from(r"C:\Users\test\AppData\Roaming")),
            Some(OsString::from(r"C:\Users\test\AppData\Local\Temp")),
        );
        assert_eq!(path, None);
        assert_eq!(source, "default");
        assert!(!dedicated);
    }

    #[test]
    fn compat_profiles_are_ordered_and_well_formed() {
        assert!(!COMPAT_PROFILES.is_empty());
        for (offset, profile) in COMPAT_PROFILES.iter().enumerate() {
            assert_eq!(profile.index as usize, offset + 1);
            assert!(!profile.id.is_empty());
            assert!(!profile.label_zh.is_empty());
            assert!(!profile.label_en.is_empty());
            assert!(!profile.browser_args.trim().is_empty());
            assert!(!profile.browser_args.starts_with(' '));
            assert!(!profile.browser_args.ends_with(' '));
            assert!(profile.browser_args.contains("--no-sandbox"));
            assert!(profile.start_delay < STARTUP_WATCHDOG_DELAY);
            assert!(profile.watchdog >= std::time::Duration::from_secs(20));
        }
        assert_eq!(max_compat_profile_index() as usize, COMPAT_PROFILES.len());
        let mut ids = COMPAT_PROFILES.iter().map(|profile| profile.id).collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), COMPAT_PROFILES.len());
        assert_eq!(compat_profile(1).unwrap().user_data, CompatUserData::Isolated);
        assert!(COMPAT_PROFILES.iter().any(|profile| profile.warmup));
        assert!(COMPAT_PROFILES.iter().any(|profile| profile.appcompat_win8));
        assert!(COMPAT_PROFILES.iter().any(|profile| profile.start_delay > std::time::Duration::ZERO));
        assert!(COMPAT_PROFILES.iter().any(|profile| profile.elevated));
        assert!(COMPAT_PROFILES.iter().any(|profile| profile.temp_copy));
    }

    #[test]
    fn marker_round_trips_and_is_version_scoped() {
        let version = env!("CARGO_PKG_VERSION");
        let other_version = "0.0.0-other-build";
        let profile = compat_profile(3).unwrap();
        let contents = compatibility_marker_contents(version, profile);
        assert_eq!(parse_compatibility_marker(&contents, version), Some(3));
        assert_eq!(parse_compatibility_marker(&contents, other_version), None);
        assert!(!expected_marker_mismatch(&contents, version, 3));
        assert!(expected_marker_mismatch(&contents, other_version, 3));
        assert!(expected_marker_mismatch(&contents, version, 2));
    }

    #[test]
    fn legacy_marker_maps_to_the_first_profile() {
        let version = env!("CARGO_PKG_VERSION");
        let contents = format!("version={version}\nmode=isolated-profile-no-sandbox-disable-gpu\n");
        assert_eq!(parse_compatibility_marker(&contents, version), Some(1));
    }

    #[test]
    fn profile_index_parsing_rejects_standard_and_garbage() {
        assert_eq!(parse_profile_index(Some("3")), Some(3));
        assert_eq!(parse_profile_index(Some(" 2 ")), Some(2));
        assert_eq!(parse_profile_index(Some("0")), None);
        assert_eq!(parse_profile_index(Some("x")), None);
        assert_eq!(parse_profile_index(None), None);
    }

    #[test]
    fn history_is_appended_without_duplicates() {
        assert_eq!(appended_history("", 1), "1");
        assert_eq!(appended_history("1,2", 3), "1,2,3");
        assert_eq!(appended_history("1,2", 2), "1,2");
        assert_eq!(parse_history("1,garbage,2"), vec![1, 2]);
        assert_eq!(format_history("1,2"), "1:isolated-no-sandbox, 2:renderer-code-integrity-off");
        assert_eq!(format_history(""), "none");
    }

    #[test]
    fn standard_startup_does_not_escalate_when_compat_is_disabled() {
        assert!(!should_escalate_startup(true, StartupWaitOutcome::TimedOut));
        assert!(!should_escalate_startup(true, StartupWaitOutcome::FastFail));
        assert!(!should_escalate_startup(false, StartupWaitOutcome::Ready));
        assert!(should_escalate_startup(false, StartupWaitOutcome::TimedOut));
        assert!(should_escalate_startup(false, StartupWaitOutcome::FastFail));
    }

    #[test]
    fn recovery_child_receives_parent_handoff_without_disabling_single_instance() {
        let mut command = std::process::Command::new("dbx-test");
        super::configure_recovery_child(&mut command, 4242);
        let envs = command.get_envs().collect::<Vec<_>>();
        assert!(envs
            .iter()
            .any(|(key, value)| { *key == super::RECOVERY_ATTEMPT_ENV && value.is_some_and(|value| value == "1") }));
        assert!(envs.iter().any(|(key, value)| {
            *key == super::RECOVERY_PARENT_PID_ENV && value.is_some_and(|value| value == "4242")
        }));
    }

    #[test]
    fn webview2_recovery_arguments_only_disable_gpu_for_enterprise_compatibility() {
        let existing = "--remote-debugging-port=9222".to_string();

        assert_eq!(webview2_compatibility_arguments(existing.clone(), false, false), existing);
        assert_eq!(
            webview2_compatibility_arguments(existing.clone(), false, true),
            "--remote-debugging-port=9222 --no-sandbox"
        );
        assert_eq!(
            webview2_compatibility_arguments(existing, true, false),
            "--remote-debugging-port=9222 --no-sandbox --disable-gpu"
        );
        assert_eq!(
            webview2_compatibility_arguments("--no-sandbox --disable-gpu".to_string(), true, false),
            "--no-sandbox --disable-gpu"
        );
    }

    #[test]
    fn prepare_browser_environment_is_idempotent_and_profile_scoped() {
        std::env::set_var(super::COMPAT_BASE_ARGS_ENV, "");
        let profile: &CompatProfile = &COMPAT_PROFILES[0];
        let first = prepare_browser_environment(Some(profile));
        let second = prepare_browser_environment(Some(profile));
        assert!(first.iter().any(|line| line.contains("compat browser args prepared")));
        assert!(second.iter().any(|line| line.contains("compat browser args prepared")));
        let effective = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap();
        assert_eq!(effective.matches("--no-sandbox").count(), 1);
        assert_eq!(effective.matches("--disable-gpu").count(), 1);
        std::env::remove_var(super::COMPAT_BASE_ARGS_ENV);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
    }
}
