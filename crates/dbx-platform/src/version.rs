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
}
