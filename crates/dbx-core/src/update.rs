use serde::{Deserialize, Serialize};

const LATEST_JSON_GITHUB_PATH: &str = "https://github.com/t8y2/dbx/releases/latest/download/latest.json";
const LATEST_JSON_R2_PATH: &str = "releases/latest/latest.json";
const LATEST_JSON_CNB_PATH: &str = "https://cnb.cool/dbxio.com/dbx/-/releases/latest/download/latest.json";
const LATEST_EN_NOTES_R2_PATH: &str = "changelog/latest-en.json";
const GITHUB_RELEASE_API_PREFIX: &str = "https://api.github.com/repos/t8y2/dbx/releases/tags/v";
const RELEASE_URL_PREFIX: &str = "https://github.com/t8y2/dbx/releases/tag/v";

#[derive(Debug, Deserialize)]
pub struct TauriRelease {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub jdbc_plugin: Option<JdbcPluginLatest>,
    #[serde(skip)]
    pub github: Option<GithubReleaseMetadata>,
    // 英文 release notes，由 R2 latest-en.json 填充（latest.json 不含此字段）。
    // 仅当用户界面非中文时拉取，build_update_info 优先用它作为 release_notes。
    #[serde(skip)]
    pub notes_en: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JdbcPluginLatest {
    pub version: String,
    pub protocol_version: u32,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct GithubReleaseMetadata {
    pub name: Option<String>,
    pub html_url: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub portable_mode: bool,
    pub release_name: String,
    pub release_url: String,
    pub release_notes: String,
}

pub async fn fetch_latest_release(locale: &str, source: crate::DownloadSource) -> Result<TauriRelease, String> {
    let client = build_update_http_client()?;

    let candidates = update_check_candidates(source);
    let resp = fetch_first_available(&client, &candidates).await?;

    let mut release = resp.json::<TauriRelease>().await.map_err(|e| format!("Failed to parse update response: {e}"))?;
    if let Ok(github) = fetch_github_release_metadata(&client, &release.version).await {
        release.github = Some(github);
    }
    // 非中文界面用户额外拉取英文 release notes；失败/版本不匹配则保持 None，上层回退中文。
    if !is_chinese_locale(locale) {
        if let Ok(notes_en) = fetch_latest_release_notes_en(&client, &release.version).await {
            release.notes_en = Some(notes_en);
        }
    }
    Ok(release)
}

async fn fetch_first_available(client: &reqwest::Client, candidates: &[String]) -> Result<reqwest::Response, String> {
    let mut errors = Vec::with_capacity(candidates.len());
    for url in candidates {
        match client
            .get(url)
            .header(reqwest::header::USER_AGENT, "dbx-update-checker")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .and_then(|response| response.error_for_status())
        {
            Ok(response) => return Ok(response),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!("Failed to check updates: {}", errors.join("; ")))
}

fn update_check_candidates(source: crate::DownloadSource) -> Vec<String> {
    match source {
        crate::DownloadSource::Official => {
            vec![format!("{}{LATEST_JSON_R2_PATH}", crate::R2_CDN_BASE), LATEST_JSON_GITHUB_PATH.to_string()]
        }
        // CNB exposes a moving latest release, so checking CNB does not need an official-source version first.
        crate::DownloadSource::Cnb => vec![
            LATEST_JSON_CNB_PATH.to_string(),
            format!("{}{LATEST_JSON_R2_PATH}", crate::R2_CDN_BASE),
            LATEST_JSON_GITHUB_PATH.to_string(),
        ],
    }
}

// 拉取 R2 上的英文 release notes（仅最新版本）。version 必须与 latest.json 的 version 一致才采用，
// 防止 sync-changelog 尚未更新时拿到旧版本英文 notes。
async fn fetch_latest_release_notes_en(client: &reqwest::Client, expected_version: &str) -> Result<String, String> {
    let url = format!("{}{LATEST_EN_NOTES_R2_PATH}", crate::R2_CDN_BASE);
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, "dbx-update-checker")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch English release notes: {e}"))?;
    let data: LatestEnNotes = resp.json().await.map_err(|e| format!("Failed to parse English release notes: {e}"))?;
    if normalize_version(&data.version) == normalize_version(expected_version) {
        Ok(data.notes)
    } else {
        Err(format!("English release notes version {} mismatch expected {}", data.version, expected_version))
    }
}

fn is_chinese_locale(locale: &str) -> bool {
    locale == "zh-CN" || locale == "zh-TW"
}

#[derive(Debug, Deserialize)]
struct LatestEnNotes {
    version: String,
    notes: String,
}

fn build_update_http_client() -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).user_agent("dbx-update-checker");

    if let Some(proxy_url) = system_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Invalid system proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|e| format!("Failed to create HTTP client: {e}"))
}

pub fn system_proxy_url() -> Option<String> {
    system_proxy_url_from_platform()
}

#[cfg(target_os = "macos")]
fn system_proxy_url_from_platform() -> Option<String> {
    let output = crate::process::new_std_command("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    system_proxy_url_from_scutil_output(&stdout)
}

#[cfg(target_os = "windows")]
fn system_proxy_url_from_platform() -> Option<String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let proxy_enable =
        crate::process::new_std_command("reg").args(["query", key, "/v", "ProxyEnable"]).output().ok()?;
    let proxy_server =
        crate::process::new_std_command("reg").args(["query", key, "/v", "ProxyServer"]).output().ok()?;
    if !proxy_enable.status.success() || !proxy_server.status.success() {
        return None;
    }
    let proxy_enable = String::from_utf8(proxy_enable.stdout).ok()?;
    let proxy_server = String::from_utf8(proxy_server.stdout).ok()?;
    system_proxy_url_from_windows_registry_output(&proxy_enable, &proxy_server)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_proxy_url_from_platform() -> Option<String> {
    None
}

#[cfg_attr(not(test), allow(dead_code))]
fn system_proxy_url_from_scutil_output(output: &str) -> Option<String> {
    let value = |key: &str| {
        output.lines().find_map(|line| {
            let (line_key, line_value) = line.split_once(':')?;
            (line_key.trim() == key).then(|| line_value.trim())
        })
    };

    if value("HTTPSEnable") == Some("1") {
        if let Some(url) = proxy_url(value("HTTPSProxy")?, value("HTTPSPort")?) {
            return Some(url);
        }
    }

    if value("HTTPEnable") == Some("1") {
        if let Some(url) = proxy_url(value("HTTPProxy")?, value("HTTPPort")?) {
            return Some(url);
        }
    }

    None
}

#[cfg_attr(not(test), allow(dead_code))]
fn system_proxy_url_from_windows_registry_output(proxy_enable: &str, proxy_server: &str) -> Option<String> {
    let enabled = proxy_enable
        .lines()
        .find(|line| line.contains("ProxyEnable"))?
        .split_whitespace()
        .last()
        .is_some_and(|value| value == "0x1" || value == "1");
    if !enabled {
        return None;
    }

    let server = proxy_server.lines().find(|line| line.contains("ProxyServer"))?.split_whitespace().last()?;

    proxy_url_from_windows_proxy_server(server)
}

fn proxy_url_from_windows_proxy_server(server: &str) -> Option<String> {
    let entries = server.split(';').map(str::trim).filter(|entry| !entry.is_empty()).collect::<Vec<_>>();

    for key in ["https=", "http="] {
        if let Some(entry) = entries.iter().find_map(|entry| entry.strip_prefix(key)) {
            if let Some(url) = proxy_url_from_host_port(entry) {
                return Some(url);
            }
        }
    }

    entries.iter().find(|entry| !entry.contains('=')).and_then(|entry| proxy_url_from_host_port(entry))
}

fn proxy_url_from_host_port(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(value.to_string());
    }
    if value.starts_with("socks://") || value.starts_with("socks5://") || value.starts_with("socks5h://") {
        return None;
    }

    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        let port = rest.strip_prefix(':')?;
        (host, port)
    } else {
        value.rsplit_once(':')?
    };
    proxy_url(host, port)
}

fn proxy_url(host: &str, port: &str) -> Option<String> {
    if host.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    Some(format!("http://{host}:{port}"))
}

async fn fetch_github_release_metadata(
    client: &reqwest::Client,
    version: &str,
) -> Result<GithubReleaseMetadata, String> {
    let url = format!("{GITHUB_RELEASE_API_PREFIX}{}", normalize_version(version));
    client
        .get(url)
        .header(reqwest::header::USER_AGENT, "dbx-update-checker")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("{e}"))?
        .json::<GithubReleaseMetadata>()
        .await
        .map_err(|e| format!("Failed to parse GitHub release response: {e}"))
}

pub fn build_update_info(release: TauriRelease, current_version: &str) -> UpdateInfo {
    let latest_version = normalize_version(&release.version);
    let github = release.github.as_ref();
    let release_notes = non_empty(release.notes_en.as_deref())
        .map(ToOwned::to_owned)
        .or_else(|| canonical_release_notes(release.notes.as_deref()))
        .or_else(|| github.and_then(|metadata| non_empty(metadata.body.as_deref())).map(ToOwned::to_owned))
        .unwrap_or_default();
    let release_name = github
        .and_then(|metadata| non_empty(metadata.name.as_deref()))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("DBX v{latest_version}"));
    let release_url = github
        .and_then(|metadata| non_empty(metadata.html_url.as_deref()))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{RELEASE_URL_PREFIX}{latest_version}"));

    UpdateInfo {
        update_available: is_newer_version(&latest_version, current_version),
        portable_mode: false,
        current_version: current_version.to_string(),
        release_name,
        release_url,
        release_notes,
        latest_version,
    }
}

fn canonical_release_notes(notes: Option<&str>) -> Option<String> {
    let notes = non_empty(notes)?;
    // Tauri's generated updater notes are a transport fallback, not the curated release notes.
    if notes.starts_with("## What's Changed") || notes == "See the assets below to download and install." {
        return None;
    }
    Some(notes.to_owned())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

pub fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

pub fn parse_version(version: &str) -> Vec<u64> {
    normalize_version(version).split(['.', '-', '+']).map(|part| part.parse::<u64>().unwrap_or(0)).collect()
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);
    let max_len = latest_parts.len().max(current_parts.len());

    for i in 0..max_len {
        let latest_part = *latest_parts.get(i).unwrap_or(&0);
        let current_part = *current_parts.get(i).unwrap_or(&0);
        if latest_part > current_part {
            return true;
        }
        if latest_part < current_part {
            return false;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::{
        build_update_info, is_newer_version, normalize_version, system_proxy_url_from_scutil_output,
        system_proxy_url_from_windows_registry_output, GithubReleaseMetadata, TauriRelease,
    };

    #[test]
    fn normalizes_tag_versions() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version(" 0.2.0 "), "0.2.0");
    }

    #[test]
    fn compares_semver_like_versions() {
        assert!(is_newer_version("0.2.1", "0.2.0"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(!is_newer_version("0.2.0", "0.2.0"));
        assert!(!is_newer_version("0.1.9", "0.2.0"));
    }

    #[test]
    fn parses_macos_https_system_proxy() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}"#;

        assert_eq!(system_proxy_url_from_scutil_output(output), Some("http://127.0.0.1:7891".to_string()));
    }

    #[test]
    fn falls_back_to_macos_http_system_proxy() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
}"#;

        assert_eq!(system_proxy_url_from_scutil_output(output), Some("http://127.0.0.1:7890".to_string()));
    }

    #[test]
    fn ignores_disabled_or_incomplete_macos_system_proxy() {
        assert_eq!(system_proxy_url_from_scutil_output("HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890"), None);
        assert_eq!(system_proxy_url_from_scutil_output("HTTPEnable : 1\nHTTPProxy : 127.0.0.1"), None);
    }

    #[test]
    fn parses_windows_system_proxy() {
        let enabled = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x1
"#;
        let server = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891
"#;

        assert_eq!(
            system_proxy_url_from_windows_registry_output(enabled, server),
            Some("http://127.0.0.1:7891".to_string())
        );
    }

    #[test]
    fn ignores_disabled_windows_system_proxy() {
        let disabled = "ProxyEnable    REG_DWORD    0x0";
        let server = "ProxyServer    REG_SZ    127.0.0.1:7890";

        assert_eq!(system_proxy_url_from_windows_registry_output(disabled, server), None);
    }

    #[test]
    fn parses_jdbc_plugin_metadata_from_latest_json() {
        let release: TauriRelease = serde_json::from_str(
            r#"{
              "version": "0.5.12",
              "jdbc_plugin": {
                "version": "0.1.3",
                "protocol_version": 1,
                "url": "https://github.com/t8y2/dbx/releases/latest/download/dbx-jdbc-plugin-latest.zip"
              },
              "platforms": {}
            }"#,
        )
        .unwrap();

        let jdbc = release.jdbc_plugin.unwrap();

        assert_eq!(jdbc.version, "0.1.3");
        assert_eq!(jdbc.protocol_version, 1);
        assert_eq!(jdbc.url, "https://github.com/t8y2/dbx/releases/latest/download/dbx-jdbc-plugin-latest.zip");
    }

    #[test]
    fn update_info_prefers_github_release_metadata() {
        let release = TauriRelease {
            version: "0.5.3".to_string(),
            notes: Some("See the assets below to download and install.".to_string()),
            jdbc_plugin: None,
            github: Some(GithubReleaseMetadata {
                name: Some("DBX v0.5.3".to_string()),
                html_url: Some("https://github.com/t8y2/dbx/releases/tag/v0.5.3".to_string()),
                body: Some("### 新功能\n\n真实发布说明".to_string()),
            }),
            notes_en: None,
        };

        let info = build_update_info(release, "0.5.2");

        assert_eq!(info.release_name, "DBX v0.5.3");
        assert_eq!(info.release_url, "https://github.com/t8y2/dbx/releases/tag/v0.5.3");
        assert_eq!(info.release_notes, "### 新功能\n\n真实发布说明");
        assert!(!info.portable_mode);
    }

    #[test]
    fn update_info_prefers_english_notes_when_present() {
        // 非中文界面用户：notes_en 命中时优先于 GitHub 中文 body，应用内更新提示展示英文
        let release = TauriRelease {
            version: "0.5.3".to_string(),
            notes: Some("See the assets below to download and install.".to_string()),
            jdbc_plugin: None,
            github: Some(GithubReleaseMetadata {
                name: Some("DBX v0.5.3".to_string()),
                html_url: Some("https://github.com/t8y2/dbx/releases/tag/v0.5.3".to_string()),
                body: Some("### 新功能\n\n真实发布说明".to_string()),
            }),
            notes_en: Some("### New Features\n\nReal release notes".to_string()),
        };

        let info = build_update_info(release, "0.5.2");

        assert_eq!(info.release_notes, "### New Features\n\nReal release notes");
    }

    #[test]
    fn update_info_ignores_generated_notes_when_curated_notes_are_unavailable() {
        let release = TauriRelease {
            version: "0.5.3".to_string(),
            notes: Some("## What's Changed\n* generated item".to_string()),
            jdbc_plugin: None,
            github: None,
            notes_en: None,
        };

        let info = build_update_info(release, "0.5.2");

        assert_eq!(info.release_notes, "");
    }

    #[test]
    fn update_check_candidates_follow_selected_source() {
        assert_eq!(
            super::update_check_candidates(crate::DownloadSource::Official),
            vec![
                "https://dl.dbxio.com/releases/latest/latest.json",
                "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
            ]
        );
        assert_eq!(
            super::update_check_candidates(crate::DownloadSource::Cnb),
            vec![
                "https://cnb.cool/dbxio.com/dbx/-/releases/latest/download/latest.json",
                "https://dl.dbxio.com/releases/latest/latest.json",
                "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
            ]
        );
    }
}
