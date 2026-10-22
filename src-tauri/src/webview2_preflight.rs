//! Windows WebView2 startup preflight and diagnostics.
//!
//! WHY THIS MODULE EXISTS
//!
//! On some Windows 10 machines (notably those running 360 安全卫士 / 奇安信天擎 /
//! Kaspersky), `CreateCoreWebView2EnvironmentWithOptions` stalls for ~35 s and the
//! Tauri main window never becomes visible. The leading theory is that the
//! security product intercepts (scans, sandboxes or blocks) the
//! `msedgewebview2.exe` child processes that WebView2 spawns on environment
//! creation, so the ready callback never arrives or arrives far too late. DBX
//! therefore needs two independent capabilities:
//!
//! 1. **Diagnostics** ([`collect_diagnostics`] / [`format_diagnostics`]): capture
//!    the facts that distinguish the failure modes (installed WebView2 runtime and
//!    how it is located, user-data-folder class, additional browser arguments,
//!    live `msedgewebview2.exe` process count, installed security products, Mark
//!    of the Web (Zone.Identifier), process integrity level and Windows build) and
//!    emit them as privacy-safe log lines that a client can email to us.
//!
//! 2. **Environment probe** ([`probe_environment`]): re-run exactly the WebView2
//!    environment creation that wry performs, but on a throwaway STA thread with a
//!    hard deadline. This turns "the window never appears" into a structured
//!    result (success / HRESULT / elapsed ms / timeout) without blocking or
//!    crashing the app.
//!
//! 3. **Child-process warm-up** ([`spawn_preflight_child`] /
//!    [`run_child_if_requested`]): spawn a copy of the DBX executable in a
//!    diagnostics-only mode *before* the real Tauri window exists. On affected
//!    machines the first WebView2 start is the slow one; letting a disposable child
//!    absorb that cost makes the AV/EDR product scan and trust `msedgewebview2.exe`
//!    while the user is still looking at the splash, so the real window creation
//!    afterwards can succeed quickly. This is a known workaround for 360-style
//!    startup blockers.
//!
//! PRIVACY CONTRACT
//!
//! `startup.log` is emailed to the maintainer, so it must never contain a user
//! name or a full user-profile path. [`format_diagnostics`] therefore only emits
//! path *classes* ("local_appdata", "appdata", "temp", "custom"), counts, version
//! numbers and product display names. Free-form values that may embed a profile
//! path (additional browser arguments) are scrubbed through [`sanitize_for_log`].
//!
//! PLATFORM SCOPE
//!
//! This module is declared only under `#[cfg(target_os = "windows")]`; the body
//! below is Windows-only on purpose. The pure helpers at the bottom (path
//! classification, product matching, integrity mapping and result-file parsing)
//! are kept free of Win32 calls so they can be unit-tested on Windows CI.
//!
//! This file is the whole surface of the module: it does not call back into the
//! rest of the crate, which keeps it usable from both `run()` (child mode) and the
//! startup-recovery ladder.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, GetAvailableCoreWebView2BrowserVersionString, ICoreWebView2Environment,
    ICoreWebView2EnvironmentOptions,
};
use webview2_com::{CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler};
use windows::core::{Error as WinError, HRESULT, HSTRING, PCWSTR, PWSTR};
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY,
};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
    KEY_WOW64_64KEY, REG_DWORD, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE};

// ---------------------------------------------------------------------------
// Environment contract shared with lib.rs / startup_recovery.rs
// ---------------------------------------------------------------------------

/// Set to `1` in the spawned diagnostics child; makes `run()` perform the
/// WebView2 probe and exit before any Tauri/window code runs.
pub(crate) const PREFLIGHT_CHILD_ENV: &str = "DBX_WEBVIEW2_PREFLIGHT_CHILD";

/// Path of the ASCII `key=value` result file the child writes.
pub(crate) const PREFLIGHT_OUT_ENV: &str = "DBX_WEBVIEW2_PREFLIGHT_OUT";

/// Child-side probe timeout in milliseconds (default 60000). The parent passes its
/// own timeout down so the child never outlives the parent's wait window.
pub(crate) const PREFLIGHT_TIMEOUT_MS_ENV: &str = "DBX_WEBVIEW2_PREFLIGHT_TIMEOUT_MS";

/// WebView2 loader reads this to override the browser arguments passed to the
/// browser process; wry applies the same value, so the probe mirrors it.
const ADDITIONAL_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
/// WebView2 user data folder override; also honored by WebView2 itself when wry
/// passes an empty folder string.
const USER_DATA_FOLDER_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";
/// Fixed/frozen WebView2 runtime folder override (`evergreen` is used otherwise).
const BROWSER_EXE_FOLDER_ENV: &str = "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER";
/// Directory the startup ladder appends `startup.log` to. The preflight child
/// result is written next to it so the client can send both files together.
const STARTUP_LOG_DIR_ENV: &str = "DBX_STARTUP_LOG_DIR";

const DEFAULT_CHILD_TIMEOUT_MS: u64 = 60_000;
const CHILD_WAIT_GRACE: Duration = Duration::from_secs(5);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(50);
const PROBE_PUMP_INTERVAL: Duration = Duration::from_millis(25);
const MAX_SECURITY_PRODUCTS: usize = 8;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// WebView2 runtime discovery. The EdgeUpdate client GUID is the stable identity of
// the Evergreen WebView2 Runtime; its `pv` value is the version we report.
const EDGE_UPDATE_CLIENT_KEY: &str = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const EDGE_UPDATE_CLIENT_KEY_WOW: &str =
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WINDOWS_CURRENT_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
const UNINSTALL_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_KEY_WOW: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

/// Uninstall `DisplayName` fragments of products known to interfere with WebView2
/// startup. Matching is a case-insensitive substring test on purpose: vendors
/// append edition suffixes ("Kaspersky Total Security", "360安全卫士 13.0").
const SECURITY_PRODUCT_KEYWORDS: &[&str] = &[
    "360",
    "奇安信",
    "qianxin",
    "天擎",
    "kaspersky",
    "卡巴斯基",
    "火绒",
    "huorong",
    "腾讯电脑管家",
    "qqpcmgr",
    "金山",
    "kingsoft",
    "norton",
    "symantec",
    "mcafee",
    "eset",
    "trend micro",
    "avast",
    "bitdefender",
    "windows defender",
];

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Snapshot of everything we want to know about the Windows/WebView2/AV
/// environment at startup. Built best-effort: every field independently degrades
/// to a neutral value (`"unknown"`, `None`, `0`, empty) instead of failing.
#[derive(Debug, Clone, Default)]
pub(crate) struct Diagnostics {
    /// Runtime version, e.g. `"128.0.2739.42"` or a fixed-runtime version.
    pub runtime_version: Option<String>,
    /// Where [`Diagnostics::runtime_version`] came from: `registry_hklm`,
    /// `registry_hkcu`, `api` or `missing`.
    pub runtime_version_source: &'static str,
    /// `evergreen`, `fixed_runtime` or `missing`.
    pub runtime_install_kind: &'static str,
    /// Class of the configured WebView2 user data folder (never the path itself).
    pub user_data_folder_class: &'static str,
    /// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` if set.
    pub additional_browser_arguments: Option<String>,
    /// Whether `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` points at a fixed runtime.
    pub browser_executable_folder_set: bool,
    /// Number of live `msedgewebview2.exe` processes at the time of collection.
    pub webview2_process_count: u32,
    /// Display names of installed products known to interfere with WebView2.
    pub security_products: Vec<String>,
    /// Whether the running executable carries a Mark of the Web.
    pub exe_has_zone_identifier: bool,
    /// `low`, `medium`, `high`, `system` or `unknown`.
    pub integrity_level: &'static str,
    /// e.g. `"19045.3803 (22H2)"`.
    pub windows_build: Option<String>,
}

/// Health of the WebView2 runtime as seen by this process.
///
/// Distinguishing these three states is what keeps DBX from blaming security
/// software for a broken runtime installation:
/// - [`Available`](WebView2RuntimeHealth::Available): Tauri can create a window.
/// - [`Missing`](WebView2RuntimeHealth::Missing): nothing registered; Tauri would
///   show its generic English dialog and fail. Show install guidance.
/// - [`RegisteredButDamaged`](WebView2RuntimeHealth::RegisteredButDamaged): a
///   version is registered (so Tauri's own version check passes!) but the runtime
///   files are gone/corrupted. This is the state that produced the misleading
///   "enterprise compatibility mode" dialog on one affected client: the window
///   creation failed for minutes while DBX blamed AV blocking. Tell the user to
///   repair WebView2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WebView2RuntimeHealth {
    Available,
    Missing,
    RegisteredButDamaged,
}

impl WebView2RuntimeHealth {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Missing => "missing",
            Self::RegisteredButDamaged => "registered_but_damaged",
        }
    }
}

/// Directory names that may host the Evergreen runtime: per-machine 32/64-bit and
/// per-user installations.
fn evergreen_application_roots() -> Vec<(std::path::PathBuf, &'static str)> {
    let mut roots = Vec::new();
    if let Some(program_files_x86) = env_non_empty_os("ProgramFiles(x86)") {
        roots.push((
            std::path::PathBuf::from(program_files_x86).join("Microsoft\\EdgeWebView\\Application"),
            "program_files_x86",
        ));
    }
    if let Some(program_files) = env_non_empty_os("ProgramFiles") {
        roots.push((
            std::path::PathBuf::from(program_files).join("Microsoft\\EdgeWebView\\Application"),
            "program_files",
        ));
    }
    if let Some(local_appdata) = env_non_empty_os("LOCALAPPDATA") {
        roots.push((
            std::path::PathBuf::from(local_appdata).join("Microsoft\\EdgeWebView\\Application"),
            "local_appdata",
        ));
    }
    roots
}

/// Fixed runtime folder: `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`, or the folder
/// Tauri's `fixedRuntime` bundling puts next to the executable.
fn fixed_runtime_folder() -> Option<std::path::PathBuf> {
    let from_env = env_non_empty_os(BROWSER_EXE_FOLDER_ENV).map(std::path::PathBuf::from);
    from_env.or_else(|| {
        let executable = std::env::current_exe().ok()?;
        let folder = executable.parent()?.join("webview2-fixed-runtime");
        folder.join("msedgewebview2.exe").is_file().then_some(folder)
    })
}

fn has_fixed_runtime_files(folder: &std::path::Path) -> bool {
    folder.join("msedgewebview2.exe").is_file()
}

/// Classify the WebView2 runtime state before Tauri is built.
///
/// `RegisteredButDamaged` requires both (a) a registry/loader-reported version and
/// (b) no `msedgewebview2.exe` under any known `EdgeWebView\Application` root — a
/// strong, false-positive-safe signal. A version directory mismatch alone counts
/// as available (WebView2 updater keeps the previous version around).
pub(crate) fn runtime_health() -> WebView2RuntimeHealth {
    // Escape hatch: if the detection ever produces a false positive on a machine
    // where DBX still works (unusual WebView2 deployment), this flag bypasses it.
    if std::env::var_os("DBX_SKIP_WEBVIEW2_RUNTIME_CHECK").is_some_and(|value| value == "1") {
        return WebView2RuntimeHealth::Available;
    }
    if let Some(folder) = fixed_runtime_folder() {
        return if has_fixed_runtime_files(&folder) {
            WebView2RuntimeHealth::Available
        } else {
            WebView2RuntimeHealth::RegisteredButDamaged
        };
    }
    let registered_version =
        registry_webview2_version().map(|(version, _source)| version).or_else(|| api_webview2_version(None));
    let Some(registered_version) = registered_version else {
        return WebView2RuntimeHealth::Missing;
    };
    let mut runtime_files_found = false;
    for (root, _source) in evergreen_application_roots() {
        if root.join(&registered_version).join("msedgewebview2.exe").is_file() {
            return WebView2RuntimeHealth::Available;
        }
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let candidate = entry.path().join("msedgewebview2.exe");
            if candidate.is_file() {
                runtime_files_found = true;
            }
        }
    }
    if runtime_files_found {
        WebView2RuntimeHealth::Available
    } else {
        WebView2RuntimeHealth::RegisteredButDamaged
    }
}

/// Collect the startup diagnostics snapshot. Best-effort: this never panics and
/// never propagates an OS error; a failed probe just leaves a field neutral.
pub(crate) fn collect_diagnostics() -> Diagnostics {
    let browser_executable_folder = env_non_empty(BROWSER_EXE_FOLDER_ENV);
    let (runtime_version, runtime_version_source, runtime_install_kind) =
        detect_runtime_version(browser_executable_folder.as_deref());
    Diagnostics {
        runtime_version,
        runtime_version_source,
        runtime_install_kind,
        user_data_folder_class: classify_user_data_folder(),
        additional_browser_arguments: env_non_empty(ADDITIONAL_ARGS_ENV),
        browser_executable_folder_set: browser_executable_folder.is_some(),
        webview2_process_count: webview2_process_count(),
        security_products: detect_security_products(),
        exe_has_zone_identifier: exe_has_zone_identifier(),
        integrity_level: process_integrity_level(),
        windows_build: windows_build_string(),
    }
}

/// Render the snapshot as one `key=value` line per fact, suitable for appending to
/// `startup.log`. Values are scrubbed of user-profile paths (see
/// [`sanitize_for_log`]); product names are the only free-form text.
///
/// Exact line format (the prefix is stable so support scripts can grep it):
/// ```text
/// webview2_preflight runtime_version=128.0.2739.42
/// webview2_preflight runtime_version_source=registry_hklm
/// webview2_preflight runtime_install_kind=evergreen
/// webview2_preflight user_data_folder_class=local_appdata
/// webview2_preflight additional_browser_arguments=<none>
/// webview2_preflight browser_executable_folder_set=false
/// webview2_preflight webview2_process_count=0
/// webview2_preflight security_products=360安全卫士; 奇安信天擎
/// webview2_preflight exe_has_zone_identifier=false
/// webview2_preflight integrity_level=medium
/// webview2_preflight windows_build=19045.3803 (22H2)
/// ```
pub(crate) fn format_diagnostics(d: &Diagnostics) -> Vec<String> {
    let additional_arguments = match d.additional_browser_arguments.as_deref() {
        Some(arguments) if !arguments.trim().is_empty() => sanitize_for_log(arguments.trim()),
        _ => "<none>".to_string(),
    };
    let security_products = if d.security_products.is_empty() {
        "<none>".to_string()
    } else {
        sanitize_for_log(&d.security_products.join("; "))
    };
    vec![
        format!("webview2_preflight runtime_version={}", d.runtime_version.as_deref().unwrap_or("<none>")),
        format!("webview2_preflight runtime_version_source={}", d.runtime_version_source),
        format!("webview2_preflight runtime_install_kind={}", d.runtime_install_kind),
        format!("webview2_preflight user_data_folder_class={}", d.user_data_folder_class),
        format!("webview2_preflight additional_browser_arguments={additional_arguments}"),
        format!("webview2_preflight browser_executable_folder_set={}", d.browser_executable_folder_set),
        format!("webview2_preflight webview2_process_count={}", d.webview2_process_count),
        format!("webview2_preflight security_products={security_products}"),
        format!("webview2_preflight exe_has_zone_identifier={}", d.exe_has_zone_identifier),
        format!("webview2_preflight integrity_level={}", d.integrity_level),
        format!("webview2_preflight windows_build={}", d.windows_build.as_deref().unwrap_or("<unknown>")),
    ]
}

/// Resolve the WebView2 runtime version. Registry is preferred because it is pure
/// read (no COM/loader startup that AV may also stall); the loader API is the
/// fallback and is the only way to see a fixed-runtime folder's version.
fn detect_runtime_version(fixed_runtime_folder: Option<&str>) -> (Option<String>, &'static str, &'static str) {
    if let Some(folder) = fixed_runtime_folder {
        // A fixed runtime is located by folder, so only the loader can report it.
        return match api_webview2_version(Some(folder)) {
            Some(version) => (Some(version), "api", "fixed_runtime"),
            None => (None, "missing", "fixed_runtime"),
        };
    }
    if let Some((version, source)) = registry_webview2_version() {
        return (Some(version), source, "evergreen");
    }
    match api_webview2_version(None) {
        Some(version) => (Some(version), "api", "evergreen"),
        None => (None, "missing", "missing"),
    }
}

/// Read the Evergreen runtime version from EdgeUpdate's per-machine (64-bit and
/// WOW6432Node) and per-user registry hives.
fn registry_webview2_version() -> Option<(String, &'static str)> {
    let locations: [(HKEY, &str, u32, &'static str); 3] = [
        (HKEY_LOCAL_MACHINE, EDGE_UPDATE_CLIENT_KEY, KEY_READ | KEY_WOW64_64KEY, "registry_hklm"),
        (HKEY_LOCAL_MACHINE, EDGE_UPDATE_CLIENT_KEY_WOW, KEY_READ, "registry_hklm"),
        (HKEY_CURRENT_USER, EDGE_UPDATE_CLIENT_KEY, KEY_READ, "registry_hkcu"),
    ];
    for (root, path, access, source) in locations {
        if let Some(version) = reg_read_string_value(root, path, "pv", access) {
            return Some((version, source));
        }
    }
    None
}

/// Ask the WebView2 loader for the browser version. Passing `None` queries the
/// Evergreen runtime; a folder queries that fixed runtime.
fn api_webview2_version(browser_executable_folder: Option<&str>) -> Option<String> {
    let fixed_folder = browser_executable_folder.map(HSTRING::from);
    let folder_ptr = fixed_folder.as_ref().map(|folder| PCWSTR(folder.as_ptr())).unwrap_or_else(PCWSTR::null);
    let mut version = PWSTR::null();
    // SAFETY: the loader writes a CoTaskMem-allocated string into `version` on
    // success; `take_pwstr` frees it. On failure `version` stays null.
    match unsafe { GetAvailableCoreWebView2BrowserVersionString(folder_ptr, &mut version) } {
        Ok(()) => {
            let text = webview2_com::take_pwstr(version);
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Err(_) => None,
    }
}

/// Classify `WEBVIEW2_USER_DATA_FOLDER` into a path class. "default" means the
/// variable is absent (WebView2/wry picks its own folder); "missing" means it is
/// present but blank, which is a broken profile worth flagging.
fn classify_user_data_folder() -> &'static str {
    match std::env::var_os(USER_DATA_FOLDER_ENV) {
        None => "default",
        Some(value) => {
            let value = value.to_string_lossy();
            if value.trim().is_empty() {
                return "missing";
            }
            let local_appdata = env_non_empty("LOCALAPPDATA");
            let appdata = env_non_empty("APPDATA");
            let temp = env_non_empty("TEMP");
            classify_path_with_roots(&value, local_appdata.as_deref(), appdata.as_deref(), temp.as_deref())
        }
    }
}

/// Pure path classification, parameterised so it can be unit-tested without a
/// Windows environment. "temp" wins over "local_appdata" because a temp folder is
/// normally inside `%LOCALAPPDATA%\Temp` and the temp location is the more
/// actionable fact when AV redirects writes.
fn classify_path_with_roots(
    path: &str,
    local_appdata: Option<&str>,
    appdata: Option<&str>,
    temp: Option<&str>,
) -> &'static str {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    let contains_root = |root: Option<&str>| {
        root.map(str::trim)
            .filter(|root| !root.is_empty())
            .map(|root| root.replace('/', "\\").to_ascii_lowercase())
            .is_some_and(|root| normalized.contains(&root))
    };
    if contains_root(temp) {
        "temp"
    } else if contains_root(local_appdata) {
        "local_appdata"
    } else if contains_root(appdata) {
        "appdata"
    } else if normalized.is_empty() {
        "missing"
    } else {
        "custom"
    }
}

/// Count live `msedgewebview2.exe` processes. A non-zero count before DBX creates
/// its window means a previous/other WebView2 host is resident (which both changes
/// the blocking behavior and proves the runtime itself can start).
fn webview2_process_count() -> u32 {
    // SAFETY: standard Toolhelp sequence; the snapshot handle is closed before
    // returning and `entry` is fully initialized by the first Process32 call.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return 0;
        }
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut count = 0;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if exe_name_matches(&entry.szExeFile) {
                    count += 1;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        count
    }
}

/// Scan the three Uninstall registry views for products known to hook WebView2
/// startup. Failures (permission, missing key, corrupt value) are ignored by
/// design: diagnostics must never break startup.
fn detect_security_products() -> Vec<String> {
    let mut found = BTreeSet::new();
    let locations: [(HKEY, &str, u32); 3] = [
        (HKEY_LOCAL_MACHINE, UNINSTALL_KEY, KEY_READ | KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, UNINSTALL_KEY_WOW, KEY_READ),
        (HKEY_CURRENT_USER, UNINSTALL_KEY, KEY_READ),
    ];
    for (root, path, access) in locations {
        if found.len() >= MAX_SECURITY_PRODUCTS {
            break;
        }
        if let Some(base) = reg_open(root, path, access) {
            scan_uninstall_key(base, &mut found);
            // SAFETY: `base` was opened by us and is not used afterwards.
            unsafe { RegCloseKey(base) };
        }
    }
    found.into_iter().take(MAX_SECURITY_PRODUCTS).collect()
}

/// Enumerate one `...\Uninstall` key and collect matching `DisplayName` values.
fn scan_uninstall_key(base: HKEY, found: &mut BTreeSet<String>) {
    let mut index = 0u32;
    loop {
        if found.len() >= MAX_SECURITY_PRODUCTS || index > 4096 {
            return;
        }
        let mut name = [0u16; 256];
        let mut name_len = name.len() as u32;
        // SAFETY: `name` has room for 256 UTF-16 code units (max key name is 255).
        let status = unsafe {
            RegEnumKeyExW(
                base,
                index,
                name.as_mut_ptr(),
                &mut name_len,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            return;
        }
        if status != ERROR_SUCCESS {
            return;
        }
        index = index.saturating_add(1);
        let subkey = String::from_utf16_lossy(&name[..name_len as usize]);
        let Some(key) = reg_open(base, &subkey, KEY_READ) else { continue };
        let display_name = reg_value_string(key, "DisplayName");
        // SAFETY: `key` was opened by us and is not used afterwards.
        unsafe { RegCloseKey(key) };
        if let Some(display_name) = display_name {
            if is_security_product(&display_name) {
                found.insert(display_name);
            }
        }
    }
}

/// Whether a Mark of the Web (`Zone.Identifier` alternate data stream) is attached
/// to the running executable. A downloaded-and-extracted DBX carries MOTW, which
/// makes SmartScreen/AV treat the whole process tree (including the WebView2
/// children) as untrusted — a common reason environment creation is stalled.
fn exe_has_zone_identifier() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let stream_path = format!("{}:Zone.Identifier", exe.display());
    match std::fs::read(&stream_path) {
        Ok(bytes) => bytes.windows(7).any(|window| window.eq_ignore_ascii_case(b"ZoneId=")),
        Err(_) => false,
    }
}

/// Read the process integrity level from the token. Low/medium integrity programs
/// are often blocked from spawning the AppContainer-related WebView2 processes on
/// hardened machines.
fn process_integrity_level() -> &'static str {
    // SAFETY: token and buffer lifetimes are confined to this function; every
    // pointer is null-checked before dereferencing.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 || token.is_null() {
            return "unknown";
        }
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return "unknown";
        }
        // `usize` backing keeps TOKEN_MANDATORY_LABEL naturally aligned.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        let read = GetTokenInformation(token, TokenIntegrityLevel, buffer.as_mut_ptr().cast(), needed, &mut needed);
        CloseHandle(token);
        if read == 0 {
            return "unknown";
        }
        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        if sid.is_null() {
            return "unknown";
        }
        let count = GetSidSubAuthorityCount(sid);
        if count.is_null() {
            return "unknown";
        }
        let sub_authority_count = *count as u32;
        if sub_authority_count == 0 {
            return "unknown";
        }
        let rid = GetSidSubAuthority(sid, sub_authority_count - 1);
        if rid.is_null() {
            return "unknown";
        }
        integrity_level_from_rid(*rid)
    }
}

/// Map an integrity SID RID to its name. Values outside the standard four levels
/// (e.g. protected process 0x5000) are reported as unknown rather than guessed.
fn integrity_level_from_rid(rid: u32) -> &'static str {
    match rid {
        0x1000 => "low",
        0x2000 => "medium",
        0x3000 => "high",
        0x4000 => "system",
        _ => "unknown",
    }
}

/// Compose the Windows build string from `CurrentBuildNumber`/`CurrentBuild`,
/// `UBR` and `DisplayVersion` (e.g. `"19045.3803 (22H2)"`). `DisplayVersion`
/// identifies feature updates on Windows 10 builds that share a build number.
fn windows_build_string() -> Option<String> {
    let key = reg_open(HKEY_LOCAL_MACHINE, WINDOWS_CURRENT_VERSION_KEY, KEY_READ | KEY_WOW64_64KEY)?;
    let build = reg_value_string(key, "CurrentBuildNumber").or_else(|| reg_value_string(key, "CurrentBuild"));
    let display_version = reg_value_string(key, "DisplayVersion");
    let ubr = reg_value_dword(key, "UBR");
    // SAFETY: `key` was opened by us and is not used afterwards.
    unsafe { RegCloseKey(key) };
    let mut build = build?;
    if let Some(ubr) = ubr {
        build.push('.');
        let _ = write!(build, "{ubr}");
    }
    match display_version.filter(|version| !version.is_empty()) {
        Some(display_version) => Some(format!("{build} ({display_version})")),
        None => Some(build),
    }
}

// ---------------------------------------------------------------------------
// Environment probe (STA thread with hard deadline)
// ---------------------------------------------------------------------------

/// Outcome of creating and releasing a WebView2 environment.
#[derive(Debug, Clone)]
pub(crate) struct EnvironmentProbe {
    /// Environment creation completed successfully.
    pub ok: bool,
    /// `"0x80070005"`-style HRESULT when failed.
    pub hresult: Option<String>,
    /// Windows system error description when available.
    pub message: Option<String>,
    /// Wall-clock time from probe start to result/timeout.
    pub elapsed_ms: u64,
    /// True when the deadline expired and the probe thread was abandoned.
    pub timed_out: bool,
}

/// Create (then release) a WebView2 environment on a dedicated STA thread with
/// message pumping, bounded by `timeout`.
///
/// This mirrors what wry does during window creation so the result is
/// representative, but it is isolated from the app: on deadline expiry the helper
/// thread is abandoned (and dies with the process) instead of blocking startup.
/// It never panics.
///
/// `additional_args` / `user_data_folder` override the process environment; when
/// `None` the current `WEBVIEW2_*` values are used, matching wry's behavior. The
/// fixed-runtime folder is always taken from the environment, as wry does.
pub(crate) fn probe_environment(
    additional_args: Option<&str>,
    user_data_folder: Option<&Path>,
    timeout: std::time::Duration,
) -> EnvironmentProbe {
    let started = Instant::now();
    let additional_args = additional_args.map(str::to_string).or_else(|| env_non_empty(ADDITIONAL_ARGS_ENV));
    let user_data_folder =
        user_data_folder.map(Path::to_path_buf).or_else(|| env_non_empty(USER_DATA_FOLDER_ENV).map(PathBuf::from));
    let browser_executable_folder = env_non_empty(BROWSER_EXE_FOLDER_ENV);

    let (tx, rx) = mpsc::channel::<ProbeOutcome>();
    let spawned = std::thread::Builder::new().name("dbx-webview2-preflight".to_string()).spawn(move || {
        let outcome = probe_environment_on_sta_thread(
            additional_args.as_deref(),
            user_data_folder.as_deref(),
            browser_executable_folder.as_deref(),
            started,
            timeout,
        );
        let _ = tx.send(outcome);
    });
    if spawned.is_err() {
        return EnvironmentProbe {
            ok: false,
            hresult: None,
            message: Some("failed to spawn the WebView2 preflight thread".to_string()),
            elapsed_ms: elapsed_ms(started),
            timed_out: false,
        };
    }

    // `rx` is held by the caller thread; the timeout is the hard upper bound on
    // how long startup waits for the probe, no matter what the AV product does.
    match rx.recv_timeout(timeout) {
        Ok(outcome) => EnvironmentProbe {
            ok: outcome.ok,
            hresult: outcome.hresult,
            message: outcome.message,
            elapsed_ms: outcome.elapsed_ms,
            timed_out: outcome.timed_out,
        },
        Err(mpsc::RecvTimeoutError::Timeout) => EnvironmentProbe {
            ok: false,
            hresult: None,
            message: Some(format!("WebView2 environment creation did not complete within {} ms", timeout.as_millis())),
            elapsed_ms: elapsed_ms(started),
            timed_out: true,
        },
        Err(mpsc::RecvTimeoutError::Disconnected) => EnvironmentProbe {
            ok: false,
            hresult: None,
            message: Some("the WebView2 preflight thread ended without a result".to_string()),
            elapsed_ms: elapsed_ms(started),
            timed_out: false,
        },
    }
}

/// Internal representation sent from the probe thread back to the caller. It
/// deliberately contains no COM interface so it is `Send`.
struct ProbeOutcome {
    ok: bool,
    hresult: Option<String>,
    message: Option<String>,
    elapsed_ms: u64,
    timed_out: bool,
}

/// Data sent by the WebView2 completed handler.
struct ProbeCallbackOutcome {
    ok: bool,
    hresult: Option<String>,
    message: Option<String>,
}

/// Runs on the dedicated thread: initialize STA COM, attempt environment
/// creation, pump messages until the callback or the deadline.
fn probe_environment_on_sta_thread(
    additional_args: Option<&str>,
    user_data_folder: Option<&Path>,
    browser_executable_folder: Option<&str>,
    started: Instant,
    timeout: Duration,
) -> ProbeOutcome {
    // SAFETY: this thread is fresh, so it owns its COM apartment; it is
    // uninitialized again before the thread returns.
    let init_result = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
    if init_result < 0 {
        return ProbeOutcome {
            ok: false,
            hresult: Some(hresult_hex(init_result)),
            message: Some(format!("CoInitializeEx failed: {}", WinError::from(HRESULT(init_result)).message())),
            elapsed_ms: elapsed_ms(started),
            timed_out: false,
        };
    }
    let outcome =
        create_environment_and_wait(additional_args, user_data_folder, browser_executable_folder, started, timeout);
    // SAFETY: balances the successful CoInitializeEx above; the thread issues no
    // further COM calls afterwards.
    unsafe { CoUninitialize() };
    outcome
}

/// Build the options/handler (same shape as wry's `create_environment`) and pump
/// the thread's message queue until the completion callback arrives.
fn create_environment_and_wait(
    additional_args: Option<&str>,
    user_data_folder: Option<&Path>,
    browser_executable_folder: Option<&str>,
    started: Instant,
    timeout: Duration,
) -> ProbeOutcome {
    let (tx, rx) = mpsc::channel::<ProbeCallbackOutcome>();

    let options = CoreWebView2EnvironmentOptions::default();
    if let Some(additional_args) = additional_args {
        // SAFETY: `options` is a local object used only on this thread; the setter
        // writes the same cell the COM putter would write.
        unsafe { options.set_additional_browser_arguments(additional_args.to_string()) };
    }
    let options: ICoreWebView2EnvironmentOptions = options.into();

    let user_data_folder =
        HSTRING::from(user_data_folder.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default());
    let fixed_runtime_folder = browser_executable_folder.map(HSTRING::from);
    let fixed_runtime_folder_ptr =
        fixed_runtime_folder.as_ref().map(|folder| PCWSTR(folder.as_ptr())).unwrap_or_else(PCWSTR::null);

    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |error_code: windows::core::Result<()>,
              environment: Option<ICoreWebView2Environment>|
              -> windows::core::Result<()> {
            let outcome = match (error_code, environment) {
                // Releasing the environment here is intentional: the probe only
                // needs to prove creation works, and holding it would keep a
                // browser process alive for the lifetime of the app.
                (Ok(()), Some(_environment)) => ProbeCallbackOutcome { ok: true, hresult: None, message: None },
                (Ok(()), None) => ProbeCallbackOutcome {
                    ok: false,
                    hresult: None,
                    message: Some("WebView2 reported success without returning an environment".to_string()),
                },
                (Err(error), _) => ProbeCallbackOutcome {
                    ok: false,
                    hresult: Some(hresult_hex(error.code().0)),
                    message: Some(error.message()),
                },
            };
            let _ = tx.send(outcome);
            Ok(())
        },
    ));

    // SAFETY: called on the STA thread initialized above; every argument lives
    // until the call returns. The completion handler is AddRef'd by WebView2, so
    // it stays valid while we pump messages below.
    let call = unsafe {
        CreateCoreWebView2EnvironmentWithOptions(fixed_runtime_folder_ptr, &user_data_folder, &options, &handler)
    };
    if let Err(error) = call {
        return ProbeOutcome {
            ok: false,
            hresult: Some(hresult_hex(error.code().0)),
            message: Some(error.message()),
            elapsed_ms: elapsed_ms(started),
            timed_out: false,
        };
    }
    pump_until_result(&rx, started, timeout)
}

/// Pump the STA thread's message queue until the WebView2 callback arrives or the
/// deadline expires. `PeekMessage` keeps the queue non-blocking so the deadline is
/// checked regularly; `recv_timeout` avoids a busy loop while no callback is
/// pending.
fn pump_until_result(rx: &mpsc::Receiver<ProbeCallbackOutcome>, started: Instant, timeout: Duration) -> ProbeOutcome {
    let deadline = started + timeout;
    let mut message = MSG::default();
    loop {
        match rx.try_recv() {
            Ok(callback) => {
                return ProbeOutcome {
                    ok: callback.ok,
                    hresult: callback.hresult,
                    message: callback.message,
                    elapsed_ms: elapsed_ms(started),
                    timed_out: false,
                };
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                return ProbeOutcome {
                    ok: false,
                    hresult: None,
                    message: Some("the WebView2 completion callback channel closed unexpectedly".to_string()),
                    elapsed_ms: elapsed_ms(started),
                    timed_out: false,
                };
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            return ProbeOutcome {
                ok: false,
                hresult: None,
                message: Some(format!(
                    "WebView2 environment creation did not complete within {} ms",
                    timeout.as_millis()
                )),
                elapsed_ms: elapsed_ms(started),
                timed_out: true,
            };
        }
        // SAFETY: MSG is stack-local and PeekMessage/DispatchMessage are used from
        // the thread that owns the message queue.
        unsafe {
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        let _ = rx.recv_timeout(PROBE_PUMP_INTERVAL);
    }
}

// ---------------------------------------------------------------------------
// Child-process warm-up
// ---------------------------------------------------------------------------

/// Result of the parent-side warm-up child process.
#[derive(Debug, Clone)]
pub(crate) struct PreflightChildOutcome {
    /// The child process could be spawned at all.
    pub spawned: bool,
    /// The child reported that environment creation succeeded.
    pub ok: bool,
    /// Probe HRESULT reported by the child, when failed.
    pub hresult: Option<String>,
    /// Child-reported probe duration (or parent wait duration when no result).
    pub elapsed_ms: u64,
    /// The parent killed the child after the wait window, or the child timed out.
    pub timed_out: bool,
    /// Child process exit code, when available.
    pub exit_code: Option<i32>,
}

/// Child-process warm-up mode.
///
/// Called at the very top of `run()`: when the preflight child environment flag is
/// set, perform the probe with the inherited `WEBVIEW2_*` overrides, write an
/// ASCII `key=value` result file and exit before Tauri starts. Returns `false`
/// (and does nothing) for a normal DBX launch.
pub(crate) fn run_child_if_requested() -> bool {
    if !env_flag(PREFLIGHT_CHILD_ENV) {
        return false;
    }
    let timeout = child_timeout_from_env();
    let probe = probe_environment(None, None, timeout);
    if let Some(path) = env_non_empty_os(PREFLIGHT_OUT_ENV).map(PathBuf::from) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, format_child_result(&probe));
    }
    // The abandoned probe thread (if any) dies with this process. Exiting directly
    // is important: the child must not initialize Tauri, windows or plugins.
    std::process::exit(0);
}

/// Parent-side warm-up: spawn the current executable in child mode so the
/// AV/EDR product scans and trusts `msedgewebview2.exe` before the real Tauri
/// window is created.
///
/// The child inherits the current `WEBVIEW2_*` process environment (which is what
/// wry will use), writes its probe result next to `startup.log`, and is killed if
/// it outlives `timeout + 5 s`. This function never panics and always returns.
pub(crate) fn spawn_preflight_child(timeout: std::time::Duration) -> PreflightChildOutcome {
    let started = Instant::now();
    let result_path = preflight_result_path();
    if let Some(parent) = result_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Remove a stale result file first: a reused PID from an earlier run must not
    // be mistaken for this run's result if the child dies before writing.
    let _ = std::fs::remove_file(&result_path);

    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => {
            return PreflightChildOutcome {
                spawned: false,
                ok: false,
                hresult: None,
                elapsed_ms: elapsed_ms(started),
                timed_out: false,
                exit_code: None,
            };
        }
    };

    let mut command = std::process::Command::new(exe);
    command
        .env(PREFLIGHT_CHILD_ENV, "1")
        .env(PREFLIGHT_OUT_ENV, &result_path)
        .env(PREFLIGHT_TIMEOUT_MS_ENV, timeout.as_millis().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // The child already inherits the environment, but copying these explicitly
    // documents (and pins) the profile the ladder has applied in the parent.
    for name in [ADDITIONAL_ARGS_ENV, USER_DATA_FOLDER_ENV, BROWSER_EXE_FOLDER_ENV] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // A GUI-subsystem exe must not flash a console window when spawned.
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return PreflightChildOutcome {
                spawned: false,
                ok: false,
                hresult: None,
                elapsed_ms: elapsed_ms(started),
                timed_out: false,
                exit_code: None,
            };
        }
    };

    let wait_deadline = started + timeout + CHILD_WAIT_GRACE;
    let mut timed_out = false;
    let mut exit_code = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {
                if Instant::now() >= wait_deadline {
                    timed_out = true;
                    let _ = child.kill();
                    if let Ok(status) = child.wait() {
                        exit_code = status.code();
                    }
                    break;
                }
                std::thread::sleep(CHILD_POLL_INTERVAL);
            }
            Err(_) => {
                let _ = child.kill();
                break;
            }
        }
    }

    let parsed = std::fs::read_to_string(&result_path).ok().and_then(|text| parse_child_result(&text));
    match parsed {
        Some(parsed) => PreflightChildOutcome {
            spawned: true,
            ok: parsed.ok && !timed_out,
            hresult: parsed.hresult,
            elapsed_ms: parsed.elapsed_ms,
            timed_out: timed_out || parsed.timed_out,
            exit_code,
        },
        None => PreflightChildOutcome {
            spawned: true,
            ok: false,
            hresult: None,
            elapsed_ms: elapsed_ms(started),
            timed_out,
            exit_code,
        },
    }
}

/// Result file path used by the child: next to `startup.log` so a client can send
/// both files together.
fn preflight_result_path() -> PathBuf {
    startup_log_dir().join(format!("webview2-preflight-{}.log", std::process::id()))
}

/// Startup log directory resolution, mirroring `startup_recovery.rs`:
/// explicit override, then `%APPDATA%\com.dbx.app`, then the temp directory.
fn startup_log_dir() -> PathBuf {
    if let Some(dir) = env_non_empty_os(STARTUP_LOG_DIR_ENV) {
        return PathBuf::from(dir);
    }
    if let Some(appdata) = env_non_empty_os("APPDATA") {
        return PathBuf::from(appdata).join("com.dbx.app");
    }
    std::env::temp_dir()
}

/// Serialize a probe result as ASCII `key=value` lines. Non-ASCII characters in
/// the Windows error message are escaped (`\u{...}`) so the file stays pure ASCII
/// (the child cannot know the console/file encoding the maintainer uses).
fn format_child_result(probe: &EnvironmentProbe) -> String {
    let mut output = String::new();
    let _ = writeln!(output, "ok={}", u8::from(probe.ok));
    let _ = writeln!(output, "hresult={}", probe.hresult.as_deref().unwrap_or("<none>"));
    let _ = writeln!(output, "elapsed_ms={}", probe.elapsed_ms);
    let _ = writeln!(output, "timed_out={}", u8::from(probe.timed_out));
    let message = probe.message.as_deref().map(ascii_escape_line).unwrap_or_else(|| "<none>".to_string());
    let _ = writeln!(output, "message={message}");
    output
}

/// Parsed subset of the child result file that the parent needs.
struct ParsedChildResult {
    ok: bool,
    hresult: Option<String>,
    elapsed_ms: u64,
    timed_out: bool,
}

/// Parse the ASCII `key=value` child result. Returns `None` when the file is
/// incomplete (`ok`/`elapsed_ms` missing), e.g. because the child was killed
/// mid-write.
fn parse_child_result(text: &str) -> Option<ParsedChildResult> {
    let mut ok = None;
    let mut hresult = None;
    let mut elapsed_ms = None;
    let mut timed_out = false;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "ok" => ok = Some(value == "1" || value.eq_ignore_ascii_case("true")),
            "hresult" => hresult = (!value.is_empty() && value != "<none>").then(|| value.to_string()),
            "elapsed_ms" => elapsed_ms = value.parse::<u64>().ok(),
            "timed_out" => timed_out = value == "1" || value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    Some(ParsedChildResult { ok: ok?, hresult, elapsed_ms: elapsed_ms?, timed_out })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

fn hresult_hex(code: i32) -> String {
    format!("0x{:08X}", code as u32)
}

/// Escape everything outside printable ASCII (and CR/LF) so a result file stays
/// pure ASCII even on a Chinese-locale Windows where error messages are localized.
fn ascii_escape_line(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\r' | '\n' => escaped.push_str("\\n"),
            character if character.is_ascii() => escaped.push(character),
            character => {
                let _ = write!(escaped, "\\u{{{:X}}}", character as u32);
            }
        }
    }
    escaped
}

/// Trimmed, non-empty Unicode environment variable.
fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// Trimmed, non-empty OS-string environment variable (paths).
fn env_non_empty_os(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

/// Interpret the conventional boolean environment forms.
fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(false)
}

fn child_timeout_from_env() -> Duration {
    let millis = env_non_empty(PREFLIGHT_TIMEOUT_MS_ENV)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .unwrap_or(DEFAULT_CHILD_TIMEOUT_MS);
    Duration::from_millis(millis)
}

/// Scrub user-profile roots from free-form text before it reaches `startup.log`.
/// The class names match `user_data_folder_class`, so a path in
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` cannot leak the user name.
fn sanitize_for_log(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let roots = [
        (env_non_empty("USERPROFILE"), "<profile>"),
        (env_non_empty("LOCALAPPDATA"), "local_appdata"),
        (env_non_empty("APPDATA"), "appdata"),
        (env_non_empty("TEMP"), "temp"),
    ];
    let mut sanitized = text.to_string();
    for (root, replacement) in roots {
        if let Some(root) = root {
            sanitized = replace_ci(&sanitized, &root, replacement);
        }
    }
    sanitized
}

/// Case-insensitive literal replacement that preserves the original byte layout of
/// `haystack` (ASCII-only case folding, so multi-byte names stay valid).
fn replace_ci(haystack: &str, needle: &str, replacement: &str) -> String {
    let pattern = needle.to_ascii_lowercase();
    if pattern.is_empty() {
        return haystack.to_string();
    }
    let lowered = haystack.to_ascii_lowercase();
    let mut output = String::with_capacity(haystack.len());
    let mut copied_until = 0;
    let mut search_from = 0;
    while let Some(relative) = lowered[search_from..].find(&pattern) {
        let start = search_from + relative;
        let end = start + pattern.len();
        output.push_str(&haystack[copied_until..start]);
        output.push_str(replacement);
        copied_until = end;
        search_from = end;
    }
    output.push_str(&haystack[copied_until..]);
    output
}

/// Whether an executable name (UTF-16 from Toolhelp) is `msedgewebview2.exe`.
fn exe_name_matches(raw: &[u16]) -> bool {
    let end = raw.iter().position(|unit| *unit == 0).unwrap_or(raw.len());
    let name = String::from_utf16_lossy(&raw[..end]);
    name.trim().eq_ignore_ascii_case("msedgewebview2.exe")
}

/// Whether an Uninstall `DisplayName` matches a known WebView2-hostile product.
fn is_security_product(display_name: &str) -> bool {
    let lowered = display_name.to_lowercase();
    SECURITY_PRODUCT_KEYWORDS.iter().any(|keyword| lowered.contains(keyword))
}

/// Append a NUL terminator for Win32 wide-string APIs.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Open a registry key relative to `root`; returns `None` on any error.
fn reg_open(root: HKEY, path: &str, access: u32) -> Option<HKEY> {
    let path = wide(path);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: `path` is NUL-terminated and outlives the call; `key` is only
    // returned when the API reports success.
    let status = unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, access, &mut key) };
    (status == ERROR_SUCCESS && !key.is_null()).then_some(key)
}

/// Read a REG_SZ / REG_EXPAND_SZ value as a trimmed string.
fn reg_value_string(key: HKEY, name: &str) -> Option<String> {
    let name = wide(name);
    // Registry string values are capped far below this; a too-small buffer simply
    // fails with ERROR_MORE_DATA and the value is skipped.
    let mut buffer = vec![0u16; 512];
    let mut size_bytes = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    let mut value_type: REG_VALUE_TYPE = 0;
    // SAFETY: buffer/size describe the same allocation; the API only writes within it.
    let status = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            buffer.as_mut_ptr().cast(),
            &mut size_bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
        return None;
    }
    let length = (size_bytes as usize / std::mem::size_of::<u16>()).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..length]);
    let trimmed = text.trim_end_matches('\0').trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Read a REG_DWORD value.
fn reg_value_dword(key: HKEY, name: &str) -> Option<u32> {
    let name = wide(name);
    let mut value: u32 = 0;
    let mut size_bytes = std::mem::size_of::<u32>() as u32;
    let mut value_type: REG_VALUE_TYPE = 0;
    // SAFETY: `value` is a stack u32 and `size_bytes` matches its size.
    let status = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            (&mut value as *mut u32).cast(),
            &mut size_bytes,
        )
    };
    if status != ERROR_SUCCESS || value_type != REG_DWORD || size_bytes < std::mem::size_of::<u32>() as u32 {
        return None;
    }
    Some(value)
}

fn reg_read_string_value(root: HKEY, path: &str, value: &str, access: u32) -> Option<String> {
    let key = reg_open(root, path, access)?;
    let read = reg_value_string(key, value);
    // SAFETY: `key` was opened by us and is not used afterwards.
    unsafe { RegCloseKey(key) };
    read
}

// ---------------------------------------------------------------------------
// Tests: pure helpers only (Windows CI runs these; no WebView2 runtime needed).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_user_data_folder_classes() {
        let local = r"C:\Users\alice\AppData\Local";
        let roaming = r"C:\Users\alice\AppData\Roaming";
        let temp = r"C:\Users\alice\AppData\Local\Temp";
        assert_eq!(
            classify_path_with_roots(
                r"C:\Users\alice\AppData\Local\DBX\EBWebView",
                Some(local),
                Some(roaming),
                Some(temp)
            ),
            "local_appdata"
        );
        assert_eq!(
            classify_path_with_roots(r"C:\Users\alice\AppData\Roaming\DBX", Some(local), Some(roaming), Some(temp)),
            "appdata"
        );
        // Temp wins over local_appdata because %TEMP% lives below %LOCALAPPDATA%.
        assert_eq!(
            classify_path_with_roots(r"C:\Users\alice\AppData\Local\Temp\dbx", Some(local), Some(roaming), Some(temp)),
            "temp"
        );
        assert_eq!(classify_path_with_roots(r"D:\Diagnostics\DBX", Some(local), Some(roaming), Some(temp)), "custom");
        // Windows paths are case-insensitive.
        assert_eq!(
            classify_path_with_roots(
                r"c:\users\ALICE\appdata\local\dbx",
                Some(r"C:\USERS\Alice\AppData\Local"),
                Some(roaming),
                Some(temp)
            ),
            "local_appdata"
        );
        // Forward slashes are normalized.
        assert_eq!(
            classify_path_with_roots(r"C:/Users/alice/AppData/Local/x", Some(local), None, None),
            "local_appdata"
        );
        assert_eq!(classify_path_with_roots("", Some(local), None, None), "missing");
    }

    #[test]
    fn matches_known_security_products() {
        assert!(is_security_product("360安全卫士"));
        assert!(is_security_product("奇安信天擎终端安全管理系统"));
        assert!(is_security_product("Kaspersky Total Security"));
        assert!(is_security_product("火绒安全软件"));
        assert!(is_security_product("Windows Defender"));
        assert!(!is_security_product("Notepad++"));
        assert!(!is_security_product("Microsoft Visual C++ 2015 Redistributable"));
        // Keyword matching is case-insensitive.
        assert!(is_security_product("QQPCMgr"));
    }

    #[test]
    fn maps_integrity_level_rids() {
        assert_eq!(integrity_level_from_rid(0x1000), "low");
        assert_eq!(integrity_level_from_rid(0x2000), "medium");
        assert_eq!(integrity_level_from_rid(0x3000), "high");
        assert_eq!(integrity_level_from_rid(0x4000), "system");
        assert_eq!(integrity_level_from_rid(0x5000), "unknown");
        assert_eq!(integrity_level_from_rid(0), "unknown");
    }

    #[test]
    fn formats_hresult_hex() {
        assert_eq!(hresult_hex(-2147024891), "0x80070005");
        assert_eq!(hresult_hex(0), "0x00000000");
    }

    #[test]
    fn matches_webview2_process_name() {
        let mut name = [0u16; 260];
        for (index, unit) in "msedgewebview2.exe".encode_utf16().enumerate() {
            name[index] = unit;
        }
        assert!(exe_name_matches(&name));
        let mut upper = [0u16; 260];
        for (index, unit) in "MSEDGEWEBVIEW2.EXE".encode_utf16().enumerate() {
            upper[index] = unit;
        }
        assert!(exe_name_matches(&upper));
        let mut other = [0u16; 260];
        for (index, unit) in "msedge.exe".encode_utf16().enumerate() {
            other[index] = unit;
        }
        assert!(!exe_name_matches(&other));
    }

    #[test]
    fn child_result_round_trips_success_and_failure() {
        let failed = EnvironmentProbe {
            ok: false,
            hresult: Some("0x80070005".to_string()),
            message: Some("Access is denied.".to_string()),
            elapsed_ms: 1234,
            timed_out: false,
        };
        let parsed = parse_child_result(&format_child_result(&failed)).expect("result must parse");
        assert!(!parsed.ok);
        assert_eq!(parsed.hresult.as_deref(), Some("0x80070005"));
        assert_eq!(parsed.elapsed_ms, 1234);
        assert!(!parsed.timed_out);

        let timed_out = EnvironmentProbe {
            ok: false,
            hresult: None,
            message: Some("did not complete".to_string()),
            elapsed_ms: 60001,
            timed_out: true,
        };
        let parsed = parse_child_result(&format_child_result(&timed_out)).expect("result must parse");
        assert!(!parsed.ok);
        assert_eq!(parsed.hresult, None);
        assert_eq!(parsed.elapsed_ms, 60_001);
        assert!(parsed.timed_out);

        let succeeded = EnvironmentProbe { ok: true, hresult: None, message: None, elapsed_ms: 87, timed_out: false };
        let parsed = parse_child_result(&format_child_result(&succeeded)).expect("result must parse");
        assert!(parsed.ok);
        assert_eq!(parsed.hresult, None);
    }

    #[test]
    fn child_result_file_is_ascii_and_escaped() {
        let probe = EnvironmentProbe {
            ok: false,
            hresult: None,
            message: Some("无法创建 WebView2 环境".to_string()),
            elapsed_ms: 5,
            timed_out: true,
        };
        let text = format_child_result(&probe);
        assert!(text.is_ascii(), "result file must stay ASCII: {text}");
        assert!(text.contains("\\u{"));
        // An incomplete file (missing ok/elapsed_ms) must not parse.
        assert!(parse_child_result("hresult=0x1\n").is_none());
    }

    #[test]
    fn scrubs_profile_roots_case_insensitively() {
        let text = r"--user-data-dir=C:\Users\Alice\AppData\Local\DBX\EBWebView";
        let scrubbed = replace_ci(text, r"C:\USERS\Alice\AppData\Local", "local_appdata");
        assert_eq!(scrubbed, r"--user-data-dir=local_appdata\DBX\EBWebView");
        assert_eq!(replace_ci("abc", "", "x"), "abc");
        assert_eq!(replace_ci("abc ABC", "abc", "z"), "z z");
    }
}
