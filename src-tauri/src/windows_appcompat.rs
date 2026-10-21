//! Windows AppCompat "Windows 8" layer helper for the WebView2 browser process.
//!
//! WHY: field evidence in `docs/win-av-compat-research.md` (P4, WebView2Feedback #4094):
//! Windows 8 compatibility mode for `msedgewebview2.exe` unblocks WebView2 environment
//! creation where 360 安全卫士 / 奇安信天擎 / Kaspersky intercept the browser process,
//! because the shim engine pushes WebView2 onto legacy API branches that AV hooks only
//! attach to on "modern Windows" code paths.
//!
//! The layer is the per-user value
//! `HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers` =
//! full path to `msedgewebview2.exe` -> `~ WIN8RTM`: no admin rights, applied at the next
//! process creation, reversible. Evergreen updates change the version directory, so the
//! ladder rewrites it on every startup ([`set_win8_compat_layer`] resolves the newest
//! runtime). Log-safe strings only carry a source class + version (`startup.log` is emailed
//! to the maintainer). Windows-only module; the pure helpers are Win32-free and testable.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS,
};
use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegEnumValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Per-user AppCompat layer store; the shim engine reads it when a process with a
/// matching full path starts.
const LAYERS_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";
/// "Windows 8" mode token; `~` marks the data as a compatibility-layer token list.
const WIN8_LAYER_DATA: &str = "~ WIN8RTM";
/// `KEY_QUERY_VALUE` keeps `RegCreateKeyExW` working on an already existing key;
/// `KEY_SET_VALUE` is needed to write/delete the layer value.
const LAYERS_KEY_ACCESS: u32 = KEY_QUERY_VALUE | KEY_SET_VALUE;

/// Evergreen runtime locations and their log-safe source classes, in search order:
/// per-machine 32-bit install, per-machine 64-bit install, then per-user install.
const RUNTIME_LOCATIONS: [(&str, &str); 3] =
    [("ProgramFiles(x86)", "program_files_x86"), ("ProgramFiles", "program_files"), ("LOCALAPPDATA", "local_appdata")];

/// Enumeration buffer bounds: real layer values are tiny, but a corrupt/foreign value
/// must not be allowed to allocate without limit.
const MAX_VALUE_NAME_CHARS: usize = 16_384;
const MAX_VALUE_DATA_BYTES: usize = 1 << 20;
const INITIAL_VALUE_NAME_CHARS: usize = 256;
const INITIAL_VALUE_DATA_BYTES: usize = 2_048;

/// Newest installed Evergreen `msedgewebview2.exe` for the current user: the AppCompat
/// layer value name must be the exact path Windows launches, and Evergreen installs one
/// version directory per update. Search order: %ProgramFiles(x86)%, %ProgramFiles%,
/// %LOCALAPPDATA%; highest numeric version wins inside a location; None if absent.
pub(crate) fn find_runtime_browser_executable() -> Option<PathBuf> {
    for (environment_variable, _) in RUNTIME_LOCATIONS {
        let Some(base) = std::env::var_os(environment_variable).filter(|value| !value.is_empty()) else {
            continue;
        };
        if let Some(executable) = newest_browser_executable_in(&webview_application_directory(&PathBuf::from(base))) {
            return Some(executable);
        }
    }
    None
}

/// Writes the per-user AppCompat "Windows 8" layer for `msedgewebview2.exe`. Idempotent:
/// Evergreen updates move the version directory, so the ladder re-runs this each startup.
/// Returns a log-safe summary (source class + version, never the path) or an error string
/// carrying the Win32 error code.
pub(crate) fn set_win8_compat_layer() -> Result<String, String> {
    let Some(executable) = find_runtime_browser_executable() else {
        return Err("appcompat win8 layer not set: no WebView2 runtime msedgewebview2.exe found".to_string());
    };
    let key = open_layers_key(true).map_err(|code| {
        format!("appcompat win8 layer not set: failed to open AppCompatFlags\\Layers (Win32 error {code})")
    })?;
    let value_name = wide(&executable.to_string_lossy());
    let value_data = wide(WIN8_LAYER_DATA);
    // SAFETY: `key` is a valid HKCU handle opened above; both buffers are NUL-terminated
    // UTF-16 and outlive the call. REG_SZ data length is expressed in bytes.
    let status = unsafe {
        RegSetValueExW(
            key,
            value_name.as_ptr(),
            0,
            REG_SZ,
            value_data.as_ptr().cast(),
            (value_data.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    // SAFETY: `key` was opened by us and is not used afterwards.
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
        return Err(format!("appcompat win8 layer not set: failed to write layer value (Win32 error {status})"));
    }
    let version = version_from_executable(&executable).unwrap_or_else(|| "unknown".to_string());
    Ok(format!("appcompat win8 layer set runtime_source={} version={version}", runtime_source_class(&executable)))
}

/// Removes every layer value whose name points at `msedgewebview2.exe` and whose data
/// selects Windows 8 mode (same-executable layers with other data are left alone; an
/// absent key counts as "not present"). Returns a log-safe summary.
pub(crate) fn remove_win8_compat_layer() -> Result<String, String> {
    let key = match open_layers_key(false) {
        Ok(key) => key,
        Err(ERROR_FILE_NOT_FOUND) => return Ok("appcompat win8 layer not present".to_string()),
        Err(code) => {
            return Err(format!(
                "appcompat win8 layer not removed: failed to open AppCompatFlags\\Layers (Win32 error {code})"
            ));
        }
    };
    let removed = remove_win8_values(key);
    // SAFETY: `key` was opened by us and is not used afterwards.
    unsafe { RegCloseKey(key) };
    match removed {
        Ok(0) => Ok("appcompat win8 layer not present".to_string()),
        Ok(count) => Ok(format!("appcompat win8 layer removed count={count}")),
        Err(code) => Err(format!(
            "appcompat win8 layer not removed: failed to enumerate/delete layer values (Win32 error {code})"
        )),
    }
}

/// True when the process token is elevated (UAC High or SYSTEM). WHY: the elevated-relaunch
/// profile must not ask for elevation again (pointless UAC prompt / silent failure); any API
/// error reports `false`, so the caller follows the normal path.
pub(crate) fn is_process_elevated() -> bool {
    // SAFETY: token/buffer lifetimes are confined to this function; every pointer is
    // null-checked before use and the token handle is closed.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 || token.is_null() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned_length = 0u32;
        let status = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned_length,
        );
        CloseHandle(token);
        status != 0 && elevation.TokenIsElevated != 0
    }
}

// ---------------------------------------------------------------------------
// Runtime discovery (std::fs only)
// ---------------------------------------------------------------------------

fn webview_application_directory(base: &Path) -> PathBuf {
    base.join("Microsoft").join("EdgeWebView").join("Application")
}

/// Highest-version subdirectory of one `Application` directory that actually contains
/// `msedgewebview2.exe`. Non-version entries (e.g. `SetupMetrics`) are ignored and
/// unreadable directories simply yield `None`.
fn newest_browser_executable_in(application_directory: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(application_directory).ok()?;
    let mut newest: Option<(String, PathBuf)> = None;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().map(|file_type| file_type.is_dir()).unwrap_or(false) {
            continue;
        }
        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if parse_version(&directory_name).is_none() {
            continue;
        }
        let executable = entry.path().join("msedgewebview2.exe");
        if !executable.is_file() {
            continue;
        }
        let is_newest = match &newest {
            None => true,
            // Both names parsed as versions above, so this comparison is always Some.
            Some((newest_version, _)) => compare_versions(&directory_name, newest_version) == Some(Ordering::Greater),
        };
        if is_newest {
            newest = Some((directory_name, executable));
        }
    }
    newest.map(|(_, executable)| executable)
}

/// Parse a dotted, purely numeric directory name such as `133.0.3065.92`.
fn parse_version(name: &str) -> Option<Vec<u64>> {
    let mut components = Vec::new();
    for component in name.split('.') {
        if component.is_empty() {
            return None;
        }
        components.push(component.parse::<u64>().ok()?);
    }
    (!components.is_empty()).then_some(components)
}

/// Numeric component-wise version order; missing trailing components count as 0
/// (`1.2` == `1.2.0`, `1.2.10` > `1.2.9`). `None` when either side is not numeric.
fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;
    for index in 0..left.len().max(right.len()) {
        match left.get(index).copied().unwrap_or(0).cmp(&right.get(index).copied().unwrap_or(0)) {
            Ordering::Equal => continue,
            ordering => return Some(ordering),
        }
    }
    Some(Ordering::Equal)
}

/// Version string for the log line: the version directory's name when it parses.
fn version_from_executable(executable: &Path) -> Option<String> {
    let directory_name = executable.parent()?.file_name()?.to_string_lossy().into_owned();
    parse_version(&directory_name).map(|_| directory_name)
}

/// Log-safe source class for the discovered executable (never the path itself).
fn runtime_source_class(executable: &Path) -> &'static str {
    let candidates: Vec<(&'static str, PathBuf)> = RUNTIME_LOCATIONS
        .iter()
        .filter_map(|(environment_variable, class)| {
            let base = std::env::var_os(environment_variable).filter(|value| !value.is_empty())?;
            Some((*class, webview_application_directory(&PathBuf::from(base))))
        })
        .collect();
    classify_runtime_source(executable, &candidates)
}

/// Pure classification helper: the first candidate root containing the executable wins,
/// otherwise `custom`. Parameterised for unit tests.
fn classify_runtime_source(executable: &Path, candidates: &[(&'static str, PathBuf)]) -> &'static str {
    candidates
        .iter()
        .find(|(_, root)| path_starts_with_ci(executable, root))
        .map(|(class, _)| *class)
        .unwrap_or("custom")
}

/// Windows paths are case-insensitive, so prefix matching normalizes separators and ASCII
/// case. Used only for log classification, never for registry access.
fn path_starts_with_ci(path: &Path, root: &Path) -> bool {
    let normalize =
        |value: &Path| value.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let normalized_path = normalize(path);
    let normalized_root = normalize(root);
    if normalized_root.is_empty() {
        return false;
    }
    normalized_path == normalized_root || normalized_path.starts_with(&format!("{normalized_root}\\"))
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/// Open (optionally creating) the per-user `AppCompatFlags\Layers` key. Errors are
/// returned as raw Win32 codes so callers can special-case "key absent".
fn open_layers_key(create: bool) -> Result<HKEY, u32> {
    let path = wide(LAYERS_KEY);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: `path` is NUL-terminated and outlives the call; optional class/security
    // pointers are null, and `key` is only used when the API reports success.
    let status = unsafe {
        if create {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                LAYERS_KEY_ACCESS,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        } else {
            RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, LAYERS_KEY_ACCESS, &mut key)
        }
    };
    if status != ERROR_SUCCESS {
        return Err(status);
    }
    if key.is_null() {
        return Err(ERROR_INVALID_PARAMETER);
    }
    Ok(key)
}

/// Enumerate and delete matching layer values; returns the number removed or a raw Win32
/// error code.
fn remove_win8_values(key: HKEY) -> Result<u32, u32> {
    let mut index = 0u32;
    let mut removed = 0u32;
    let mut name_capacity = INITIAL_VALUE_NAME_CHARS;
    let mut data_capacity = INITIAL_VALUE_DATA_BYTES;
    loop {
        let mut name = vec![0u16; name_capacity];
        let mut data = vec![0u8; data_capacity];
        let mut name_length = name_capacity as u32;
        let mut data_length = data_capacity as u32;
        let mut value_type: REG_VALUE_TYPE = 0;
        // SAFETY: both buffers are sized by their matching `*_length` variables, so the
        // API only writes within them.
        let status = unsafe {
            RegEnumValueW(
                key,
                index,
                name.as_mut_ptr(),
                &mut name_length,
                std::ptr::null(),
                &mut value_type,
                data.as_mut_ptr(),
                &mut data_length,
            )
        };
        match status {
            ERROR_SUCCESS => {
                // Clamp defensively: never index past the allocations (no panics).
                let name_length = (name_length as usize).min(name.len());
                let data_length = (data_length as usize).min(data.len());
                let value_name = String::from_utf16_lossy(&name[..name_length]);
                let is_string = value_type == REG_SZ || value_type == REG_EXPAND_SZ;
                let value_data = if is_string { registry_string(&data[..data_length]) } else { String::new() };
                if is_msedgewebview2_layer_name(&value_name) && is_win8_layer_data(&value_data) {
                    let value_name = wide(&value_name);
                    // SAFETY: `key` is valid and the name is NUL-terminated.
                    let delete_status = unsafe { RegDeleteValueW(key, value_name.as_ptr()) };
                    if delete_status != ERROR_SUCCESS {
                        return Err(delete_status);
                    }
                    removed += 1;
                    // Deleted values shift down, so re-read the same index.
                    name_capacity = INITIAL_VALUE_NAME_CHARS;
                    data_capacity = INITIAL_VALUE_DATA_BYTES;
                    continue;
                }
                index += 1;
                name_capacity = INITIAL_VALUE_NAME_CHARS;
                data_capacity = INITIAL_VALUE_DATA_BYTES;
            }
            ERROR_MORE_DATA => {
                // `*_length` now holds the required size; grow and retry the same index.
                // Pathological values beyond our caps are skipped, not allocated.
                let required_name = (name_length as usize).max(1);
                let required_data = (data_length as usize).max(1);
                let grow_name = required_name > name_capacity;
                let grow_data = required_data > data_capacity;
                if required_name > MAX_VALUE_NAME_CHARS
                    || required_data > MAX_VALUE_DATA_BYTES
                    || (!grow_name && !grow_data)
                {
                    index += 1;
                    name_capacity = INITIAL_VALUE_NAME_CHARS;
                    data_capacity = INITIAL_VALUE_DATA_BYTES;
                    continue;
                }
                name_capacity = required_name;
                data_capacity = required_data;
            }
            ERROR_NO_MORE_ITEMS => return Ok(removed),
            other => return Err(other),
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Decode a registry string value (UTF-16LE, possibly NUL-terminated; odd-length byte
/// buffers are tolerated) into a `String`.
fn registry_string(bytes: &[u8]) -> String {
    let mut units: Vec<u16> =
        bytes.chunks_exact(std::mem::size_of::<u16>()).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    if let Some(terminator) = units.iter().position(|unit| *unit == 0) {
        units.truncate(terminator);
    }
    String::from_utf16_lossy(&units)
}

/// A layer value belongs to the WebView2 browser process when its name ends with the full
/// path of `msedgewebview2.exe` (the shim matches full paths; both separators and any case
/// are accepted).
fn is_msedgewebview2_layer_name(name: &str) -> bool {
    name.replace('/', "\\").to_ascii_lowercase().ends_with(r"\msedgewebview2.exe")
}

/// Whether the layer data selects Windows 8 mode (`"~ WIN8RTM"`). The token list may
/// contain several modes separated by spaces, so a substring test is correct.
fn is_win8_layer_data(data: &str) -> bool {
    data.to_ascii_uppercase().contains("WIN8RTM")
}

/// NUL-terminated wide string for Win32 registry APIs.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// Tests: pure helpers only (Windows CI runs these; no registry/runtime required).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numeric_version_directories() {
        assert_eq!(compare_versions("133.0.3065.92", "130.0.2849.68"), Some(Ordering::Greater));
        assert_eq!(compare_versions("130.0.2849.68", "133.0.3065.92"), Some(Ordering::Less));
        assert_eq!(compare_versions("133.0.3065.92", "133.0.3065.92"), Some(Ordering::Equal));
        // Numeric, not lexicographic (100 > 92); missing trailing components count as 0.
        assert_eq!(compare_versions("133.0.3065.100", "133.0.3065.92"), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.2", "1.2.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.2.1", "1.2"), Some(Ordering::Greater));
        // Non-numeric names are rejected.
        assert_eq!(compare_versions("EBWebView", "133.0.3065.92"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn matches_layer_names_and_win8_data() {
        assert!(is_msedgewebview2_layer_name(
            r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\133.0.3065.92\msedgewebview2.exe"
        ));
        assert!(is_msedgewebview2_layer_name("C:/app/MSEDGEWEBVIEW2.EXE"));
        // Other executables and lookalikes must not match.
        for name in [
            r"C:\app\msedge.exe",
            r"C:\app\notmsedgewebview2.exe",
            r"C:\app\msedgewebview2.exe.bak",
            "msedgewebview2.exe",
        ] {
            assert!(!is_msedgewebview2_layer_name(name), "unexpected match: {name}");
        }

        assert!(is_win8_layer_data("~ WIN8RTM"));
        assert!(is_win8_layer_data("~ win8rtm"));
        assert!(is_win8_layer_data("~ WIN8RTM WIN7RTM"));
        assert!(!is_win8_layer_data("~ WIN7RTM"));
        assert!(!is_win8_layer_data(""));
    }

    #[test]
    fn classifies_runtime_sources_without_leaking_paths() {
        let candidates = [
            ("program_files_x86", PathBuf::from(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application")),
            ("program_files", PathBuf::from(r"C:\Program Files\Microsoft\EdgeWebView\Application")),
            ("local_appdata", PathBuf::from(r"C:\Users\alice\AppData\Local\Microsoft\EdgeWebView\Application")),
        ];
        let executable = |root: &Path| root.join("133.0.3065.92").join("msedgewebview2.exe");
        assert_eq!(classify_runtime_source(&executable(&candidates[0].1), &candidates), "program_files_x86");
        assert_eq!(classify_runtime_source(&executable(&candidates[1].1), &candidates), "program_files");
        assert_eq!(classify_runtime_source(&executable(&candidates[2].1), &candidates), "local_appdata");
        assert_eq!(classify_runtime_source(Path::new(r"D:\Portable\msedgewebview2.exe"), &candidates), "custom");
    }
}
