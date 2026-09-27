pub use dbx_platform::version::{is_newer_version, normalize_version, parse_version};

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
    pub manual_update_only: bool,
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

pub use dbx_platform::proxy::system_proxy_url;

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
        manual_update_only: false,
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

#[cfg(test)]
mod tests {
    use super::{build_update_info, GithubReleaseMetadata, TauriRelease};

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
