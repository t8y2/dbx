pub fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

pub fn parse_version(version: &str) -> Vec<u64> {
    normalize_version(version).split(['.', '-', '+']).map(|part| part.parse::<u64>().unwrap_or(0)).collect()
}

pub fn base_version(version: &str) -> String {
    normalize_version(version).split(['-', '+']).next().unwrap_or_default().to_string()
}

pub fn is_version_compatible(min_version: &str, current_version: &str) -> bool {
    !is_newer_version(&base_version(min_version), &base_version(current_version))
}

/// Base version to display for a build that was promoted to stable without
/// being rebuilt.
///
/// A promoted beta keeps its `X.Y.Z-beta.YYYYMMDD.N` version inside the binary
/// while the release is now the stable `X.Y.Z`. Returns `Some("X.Y.Z")` only
/// when `promoted_from` names this exact build and it carries a prerelease
/// suffix; every other combination — a real beta, a plain stable build, or a
/// promotion of a different build — returns `None` so callers keep the raw
/// version.
pub fn promoted_base_version(build: &str, promoted_from: Option<&str>) -> Option<String> {
    let promoted_from = promoted_from?.trim();
    if promoted_from.is_empty() {
        return None;
    }
    let build = normalize_version(build);
    if build.is_empty() || build != normalize_version(promoted_from) {
        return None;
    }
    let base = base_version(&build);
    (!base.is_empty() && base != build).then_some(base)
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    if let (Ok(latest), Ok(current)) =
        (semver::Version::parse(&normalize_version(latest)), semver::Version::parse(&normalize_version(current)))
    {
        return latest > current;
    }
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
    use super::*;

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
        assert!(is_newer_version("0.6.60-beta.20261028.1", "0.6.59"));
        assert!(is_newer_version("0.6.60-beta.20261029.1", "0.6.60-beta.20261028.1"));
        assert!(is_newer_version("0.6.60", "0.6.60-beta.20261028.1"));
        assert!(!is_newer_version("0.6.59", "0.6.60-beta.20261028.1"));
    }

    #[test]
    fn compares_application_compatibility_by_base_version() {
        assert_eq!(base_version("v0.6.60-beta.20261029.1"), "0.6.60");
        assert_eq!(base_version("0.6.60+build.1"), "0.6.60");
        assert!(is_version_compatible("0.6.60", "0.6.60-beta.20261029.1"));
        assert!(is_version_compatible("0.6.59", "0.6.60-beta.20261029.1"));
        assert!(!is_version_compatible("0.6.61", "0.6.60-beta.20261029.1"));
    }

    #[test]
    fn resolves_the_stable_version_of_a_promoted_build() {
        const BUILD: &str = "0.6.67-beta.20261105.1";
        assert_eq!(promoted_base_version(BUILD, Some(BUILD)).as_deref(), Some("0.6.67"));
        assert_eq!(promoted_base_version(BUILD, Some("v0.6.67-beta.20261105.1")).as_deref(), Some("0.6.67"));
        assert_eq!(promoted_base_version(&format!(" {BUILD} "), Some(BUILD)).as_deref(), Some("0.6.67"));
    }

    #[test]
    fn keeps_the_build_version_when_the_promotion_does_not_name_it() {
        const BUILD: &str = "0.6.67-beta.20261105.1";
        let other = "0.6.67-beta.20261105.2";
        assert_eq!(promoted_base_version(BUILD, Some(other)), None);
        assert_eq!(promoted_base_version(other, Some(BUILD)), None);
        assert_eq!(promoted_base_version(BUILD, None), None);
        assert_eq!(promoted_base_version(BUILD, Some("")), None);
        assert_eq!(promoted_base_version(BUILD, Some("   ")), None);
        // A plain stable build was never a promoted prerelease.
        assert_eq!(promoted_base_version("0.6.67", Some("0.6.67")), None);
        assert_eq!(promoted_base_version("", Some(BUILD)), None);
    }
}
