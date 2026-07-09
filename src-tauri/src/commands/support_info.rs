use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSupportInfo {
    pub app_version: String,
    pub runtime: &'static str,
    pub os_name: String,
    pub os_version: Option<String>,
    pub arch: String,
}

#[tauri::command]
pub async fn get_app_support_info() -> AppSupportInfo {
    current_app_support_info()
}

pub(crate) fn current_app_support_info() -> AppSupportInfo {
    AppSupportInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        runtime: "desktop",
        os_name: os_name(),
        os_version: os_version(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

pub(crate) fn format_support_info_for_native_about() -> String {
    let info = current_app_support_info();
    let operating_system = format_operating_system(&info);

    ["Desktop".to_string(), unknown_if_empty(&operating_system), unknown_if_empty(&info.arch)].join(" • ")
}

pub(crate) fn format_support_info_for_clipboard() -> String {
    let info = current_app_support_info();
    let operating_system = format_operating_system(&info);

    [
        format!("DBX Version: {}", normalize_app_version(&info.app_version)),
        "Runtime: Desktop".to_string(),
        format!("Operating System: {}", unknown_if_empty(&operating_system)),
        format!("Architecture: {}", unknown_if_empty(&info.arch)),
    ]
    .join("\n")
}

fn format_operating_system(info: &AppSupportInfo) -> String {
    let operating_system = [Some(info.os_name.as_str()), info.os_version.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    operating_system
}

fn normalize_app_version(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return "Unknown".to_string();
    }
    if trimmed.starts_with('v') || trimmed.starts_with('V') {
        format!("v{}", &trimmed[1..])
    } else {
        format!("v{trimmed}")
    }
}

fn unknown_if_empty(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn os_name() -> String {
    platform_product_name().unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn os_version() -> Option<String> {
    platform_product_version()
}

#[cfg(target_os = "macos")]
fn platform_product_name() -> Option<String> {
    command_first_line("sw_vers", &["-productName"])
}

#[cfg(target_os = "macos")]
fn platform_product_version() -> Option<String> {
    command_first_line("sw_vers", &["-productVersion"])
}

#[cfg(target_os = "windows")]
fn platform_product_name() -> Option<String> {
    Some("Windows".to_string())
}

#[cfg(target_os = "windows")]
fn platform_product_version() -> Option<String> {
    command_first_line("cmd", &["/C", "ver"])
        .map(|line| line.trim_matches(|ch| ch == '\r' || ch == '\n').trim().to_string())
}

#[cfg(target_os = "linux")]
fn platform_product_name() -> Option<String> {
    linux_os_release_value("/etc/os-release", "PRETTY_NAME")
}

#[cfg(target_os = "linux")]
fn platform_product_version() -> Option<String> {
    linux_os_release_value("/etc/os-release", "VERSION_ID")
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_product_name() -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_product_version() -> Option<String> {
    None
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn command_first_line(command: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).lines().map(str::trim).find(|line| !line.is_empty()).map(ToOwned::to_owned)
}

#[cfg(target_os = "linux")]
fn linux_os_release_value(path: &str, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_os_release_value(&content, key)
}

#[cfg(any(target_os = "linux", test))]
fn parse_os_release_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name != key {
            continue;
        }
        return Some(unquote_os_release_value(value.trim()));
    }
    None
}

#[cfg(any(target_os = "linux", test))]
fn unquote_os_release_value(value: &str) -> String {
    let quoted = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|inner| inner.strip_suffix('\'')));
    let Some(inner) = quoted else {
        return value.to_string();
    };
    inner.replace("\\\"", "\"").replace("\\'", "'").replace("\\\\", "\\")
}

#[cfg(test)]
mod tests {
    use super::{
        format_support_info_for_clipboard, format_support_info_for_native_about, normalize_app_version,
        parse_os_release_value, unknown_if_empty, unquote_os_release_value,
    };

    #[test]
    fn normalizes_app_version_for_support_info() {
        assert_eq!(normalize_app_version("0.5.50"), "v0.5.50");
        assert_eq!(normalize_app_version("v0.5.50"), "v0.5.50");
        assert_eq!(normalize_app_version("V0.5.50"), "v0.5.50");
        assert_eq!(normalize_app_version(""), "Unknown");
    }

    #[test]
    fn formats_unknown_for_empty_support_info_values() {
        assert_eq!(unknown_if_empty(""), "Unknown");
        assert_eq!(unknown_if_empty(" aarch64 "), "aarch64");
    }

    #[test]
    fn formats_native_about_support_info_compactly() {
        let text = format_support_info_for_native_about();
        assert!(text.contains("Desktop"));
        assert!(!text.contains("DBX Version:"));
        assert!(!text.contains('\n'));
    }

    #[test]
    fn formats_clipboard_support_info_with_labels() {
        let text = format_support_info_for_clipboard();
        assert!(text.contains("DBX Version:"));
        assert!(text.contains("Runtime:"));
        assert!(text.contains("Operating System:"));
        assert!(text.contains("Architecture:"));
    }

    #[test]
    fn parses_linux_os_release_values() {
        let content = r#"
NAME="Ubuntu"
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04.1 LTS"
"#;

        assert_eq!(parse_os_release_value(content, "PRETTY_NAME").as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(parse_os_release_value(content, "VERSION_ID").as_deref(), Some("24.04"));
    }

    #[test]
    fn returns_none_for_missing_linux_os_release_value() {
        assert_eq!(parse_os_release_value("NAME=Ubuntu\n", "PRETTY_NAME"), None);
    }

    #[test]
    fn unquotes_linux_os_release_escapes() {
        assert_eq!(unquote_os_release_value(r#""A \"quoted\" value""#), "A \"quoted\" value");
    }
}
