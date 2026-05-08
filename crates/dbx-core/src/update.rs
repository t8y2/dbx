use serde::{Deserialize, Serialize};

const LATEST_JSON_URLS: &[&str] = &[
    "https://update.hwdns.net/https://github.com/t8y2/dbx/releases/latest/download/latest.json",
    "https://gh-proxy.org/https://github.com/t8y2/dbx/releases/latest/download/latest.json",
    "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
];
const RELEASE_URL_PREFIX: &str = "https://github.com/t8y2/dbx/releases/tag/v";

#[derive(Debug, Deserialize)]
pub struct TauriRelease {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_url: String,
    pub release_notes: String,
}

pub async fn fetch_latest_release() -> Result<TauriRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let mut last_err = String::new();
    for url in LATEST_JSON_URLS {
        match client
            .get(*url)
            .header(reqwest::header::USER_AGENT, "dbx-update-checker")
            .send()
            .await
            .and_then(|r| r.error_for_status())
        {
            Ok(resp) => {
                return resp.json::<TauriRelease>().await.map_err(|e| format!("Failed to parse update response: {e}"));
            }
            Err(e) => {
                last_err = format!("{e}");
            }
        }
    }
    Err(format!("Failed to check updates: {last_err}"))
}

pub fn build_update_info(release: TauriRelease, current_version: &str) -> UpdateInfo {
    let latest_version = normalize_version(&release.version);

    UpdateInfo {
        update_available: is_newer_version(&latest_version, current_version),
        current_version: current_version.to_string(),
        release_name: format!("DBX v{latest_version}"),
        release_url: format!("{RELEASE_URL_PREFIX}{latest_version}"),
        release_notes: release.notes.unwrap_or_default(),
        latest_version,
    }
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
    use super::{is_newer_version, normalize_version};

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
}
