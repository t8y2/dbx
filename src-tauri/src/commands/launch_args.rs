//! Helpers for interpreting the arguments DBX is launched with.
//!
//! The Linux desktop entry uses the `%U` field code so one `Exec=` line can serve
//! both the `dbx://` scheme and the file associations. With `%U` a file manager may
//! hand over `file://` URLs rather than plain paths, so launch arguments are
//! normalized before anything treats them as filesystem paths.

use percent_encoding::percent_decode_str;

/// Normalizes a launch argument into a filesystem path.
///
/// `file://` URLs, optionally with a `localhost` authority, are percent-decoded into
/// local paths. Any other argument is returned unchanged. Returns `None` for a
/// `file://` URL that points at another host, since that is not a local path.
pub fn normalize_launch_path_arg(arg: &str) -> Option<String> {
    let Some(rest) = arg.strip_prefix("file://") else {
        return Some(arg.to_string());
    };

    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }

    Some(percent_decode_str(rest).decode_utf8().ok()?.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_plain_paths_through_unchanged() {
        assert_eq!(normalize_launch_path_arg("/tmp/query.sql").as_deref(), Some("/tmp/query.sql"));
        assert_eq!(normalize_launch_path_arg("query.sql").as_deref(), Some("query.sql"));
        assert_eq!(normalize_launch_path_arg("dbx://open").as_deref(), Some("dbx://open"));
    }

    #[test]
    fn decodes_local_file_urls() {
        assert_eq!(normalize_launch_path_arg("file:///tmp/query.sql").as_deref(), Some("/tmp/query.sql"));
        assert_eq!(normalize_launch_path_arg("file://localhost/tmp/query.sql").as_deref(), Some("/tmp/query.sql"));
    }

    #[test]
    fn percent_decodes_file_urls() {
        assert_eq!(normalize_launch_path_arg("file:///tmp/my%20query.sql").as_deref(), Some("/tmp/my query.sql"));
        assert_eq!(normalize_launch_path_arg("file:///tmp/%E6%9F%A5%E8%AF%A2.sql").as_deref(), Some("/tmp/查询.sql"));
    }

    /// The desktop entry is a shipped artifact whose `Exec=` field code is what puts
    /// `dbx://` links and associated files into `std::env::args()` on Linux. Without a
    /// URL field code both arrive empty, so the contract is pinned here.
    #[test]
    fn linux_desktop_entry_forwards_urls_and_files() {
        let template = include_str!("../../linux/DBX.desktop");

        let exec =
            template.lines().find_map(|line| line.strip_prefix("Exec=")).expect("desktop entry must declare Exec=");
        assert!(
            exec.ends_with(" %U") || exec.ends_with(" %u"),
            "Exec= needs a URL field code or launch arguments are dropped, got {exec:?}"
        );

        let wm_class = template.lines().find_map(|line| line.strip_prefix("StartupWMClass="));
        assert_eq!(
            wm_class,
            Some("{{exec}}"),
            "StartupWMClass must stay the bare executable so window grouping keeps working"
        );
    }

    /// Guards the wiring: the template above only ships if the bundler is pointed at it.
    #[test]
    fn bundle_config_uses_the_linux_desktop_entry() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json must be valid JSON");

        for target in ["deb", "rpm"] {
            assert_eq!(
                config["bundle"]["linux"][target]["desktopTemplate"].as_str(),
                Some("linux/DBX.desktop"),
                "{target} bundle must use the custom desktop entry"
            );
        }

        assert!(
            !config["plugins"]["deep-link"]["desktop"]["schemes"]
                .as_array()
                .map(|schemes| schemes.is_empty())
                .unwrap_or(true),
            "a deep-link scheme is what makes the Exec field code load-bearing"
        );
    }

    #[test]
    fn rejects_file_urls_on_another_host() {
        assert_eq!(normalize_launch_path_arg("file://example.com/tmp/query.sql"), None);
    }
}
