use serde::{Deserialize, Serialize};

pub const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/t8y2/dbx/releases/latest";

#[derive(Debug, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub html_url: String,
    pub body: Option<String>,
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

pub async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = reqwest::Client::new();
    client
        .get(LATEST_RELEASE_URL)
        .header(reqwest::header::USER_AGENT, "dbx-update-checker")
        .send()
        .await
        .map_err(|e| format!("Failed to check updates: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to check updates: {e}"))?
        .json::<GithubRelease>()
        .await
        .map_err(|e| format!("Failed to parse update response: {e}"))
}

pub fn build_update_info(release: GithubRelease, current_version: &str) -> UpdateInfo {
    let latest_version = normalize_version(&release.tag_name);

    UpdateInfo {
        update_available: is_newer_version(&latest_version, current_version),
        current_version: current_version.to_string(),
        latest_version,
        release_name: release.name.unwrap_or_else(|| release.tag_name.clone()),
        release_url: release.html_url,
        release_notes: release.body.unwrap_or_default(),
    }
}

pub fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

pub fn parse_version(version: &str) -> Vec<u64> {
    normalize_version(version)
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
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
