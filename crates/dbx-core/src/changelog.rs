use serde::{Deserialize, Serialize};

const CHANGELOG_R2_PREFIX: &str = "changelog/releases-";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogItem {
    pub title: String,
    #[serde(default)]
    pub desc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangelogSection {
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub items: Vec<ChangelogItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangelogRelease {
    pub tag: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub sections: Vec<ChangelogSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogData {
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub releases: Vec<ChangelogRelease>,
}

/// Normalize UI locale / short lang into `cn` or `en` (matches R2 file naming).
pub fn normalize_changelog_lang(lang: &str) -> &'static str {
    let trimmed = lang.trim();
    if trimmed.eq_ignore_ascii_case("cn")
        || trimmed.eq_ignore_ascii_case("zh")
        || trimmed.eq_ignore_ascii_case("zh-CN")
        || trimmed.eq_ignore_ascii_case("zh-TW")
    {
        "cn"
    } else {
        "en"
    }
}

fn is_app_release_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let mut parts = version.splitn(3, '.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch_and_suffix) = parts.next() else {
        return false;
    };
    if major.is_empty()
        || minor.is_empty()
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || !minor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }

    let patch_len = patch_and_suffix.bytes().take_while(u8::is_ascii_digit).count();
    if patch_len == 0 {
        return false;
    }
    let suffix = &patch_and_suffix[patch_len..];
    suffix.is_empty()
        || ((suffix.starts_with('.') || suffix.starts_with('-'))
            && suffix.len() > 1
            && suffix[1..].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-'))
}

pub async fn fetch_changelog(lang: &str) -> Result<ChangelogData, String> {
    let lang = normalize_changelog_lang(lang);
    let client = build_changelog_http_client()?;
    let url = format!("{}{CHANGELOG_R2_PREFIX}{lang}.json", crate::R2_CDN_BASE);

    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, "dbx-changelog")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch changelog: {e}"))?;

    let mut data: ChangelogData = resp.json().await.map_err(|e| format!("Failed to parse changelog: {e}"))?;
    // Treat R2 as untrusted cached data so auxiliary release streams never leak into the app UI.
    data.releases.retain(|release| is_app_release_tag(release.tag.trim()));
    Ok(data)
}

fn build_changelog_http_client() -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).user_agent("dbx-changelog");

    if let Some(proxy_url) = crate::update::system_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Invalid system proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|e| format!("Failed to create HTTP client: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{is_app_release_tag, normalize_changelog_lang};

    #[test]
    fn normalizes_changelog_lang() {
        assert_eq!(normalize_changelog_lang("cn"), "cn");
        assert_eq!(normalize_changelog_lang("zh-CN"), "cn");
        assert_eq!(normalize_changelog_lang("zh-TW"), "cn");
        assert_eq!(normalize_changelog_lang("en"), "en");
        assert_eq!(normalize_changelog_lang("ja"), "en");
    }

    #[test]
    fn recognizes_only_app_release_tags() {
        assert!(is_app_release_tag("v0.5.66"));
        assert!(is_app_release_tag("v1.2.3-hotfix.1"));
        assert!(!is_app_release_tag("packages-v0.4.42"));
        assert!(!is_app_release_tag("agents-v0.2.64"));
        assert!(!is_app_release_tag("v0.5"));
        assert!(!is_app_release_tag("v0.5.x"));
    }
}
