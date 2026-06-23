use std::path::{Path, PathBuf};

use dbx_core::db::sqlite::path_has_sqlite_header;
use dbx_core::path_utils::expand_tilde;

/// Reveal a file in the platform's file manager.
///
/// - macOS: `open -R <path>` highlights the file in Finder.
/// - Windows: `explorer.exe /select,<path>` opens Explorer with the file selected.
/// - Linux: opens the parent directory with `xdg-open`. (DBus
///   `org.freedesktop.FileManager1.ShowItems` would be a higher-fidelity
///   alternative; deferred to a follow-up to avoid a new dependency.)
///
/// The caller MUST pass an absolute path that already exists. Path expansion
/// (`~`) and existence checks happen one layer up in the Tauri command.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch Finder: {e}"))
    }

    #[cfg(target_os = "windows")]
    {
        // `/select,<path>` must be passed as a single argument with no space
        // after the comma. `Command::arg` does not invoke a shell, so the path
        // is forwarded as-is — spaces and non-ASCII characters survive.
        let arg = format!("/select,{}", path.display());
        std::process::Command::new("explorer")
            .arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch Explorer: {e}"))
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let target: PathBuf = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.to_path_buf());
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch xdg-open: {e}"))
    }
}

fn validate_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    if trimmed == ":memory:" {
        return Err("in-memory database has no file to reveal".to_string());
    }

    let expanded = expand_tilde(trimmed);
    let path = PathBuf::from(&expanded);
    if !path.is_absolute() {
        return Err(format!("path is not absolute: {expanded}"));
    }
    if !path.exists() {
        return Err(format!("文件不存在: {expanded}"));
    }
    Ok(path)
}

/// Reveal an absolute file path in the OS file manager. The path may use a
/// leading `~` which is expanded via `dbx_core::path_utils::expand_tilde`.
#[tauri::command]
pub async fn reveal_path_in_file_manager(path: String) -> Result<(), String> {
    let resolved = validate_path(&path)?;
    reveal_in_file_manager(&resolved)
}

#[tauri::command]
pub async fn is_sqlite_database_file(path: String) -> Result<bool, String> {
    let resolved = validate_path(&path)?;
    path_has_sqlite_header(&resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_path_is_rejected() {
        assert!(validate_path("").is_err());
        assert!(validate_path("   ").is_err());
    }

    #[test]
    fn memory_path_is_rejected() {
        let err = validate_path(":memory:").unwrap_err();
        assert!(err.contains("in-memory"));
    }

    #[test]
    fn relative_path_is_rejected() {
        let err = validate_path("relative/path/foo.sqlite").unwrap_err();
        assert!(err.contains("not absolute"));
    }

    #[test]
    fn nonexistent_absolute_path_is_rejected() {
        // /this/path/should/not/exist on Unix; on Windows the same check fires
        // because the literal also won't exist.
        let probe = if cfg!(windows) {
            "C:/__dbx_definitely_missing__/foo.sqlite".to_string()
        } else {
            "/__dbx_definitely_missing__/foo.sqlite".to_string()
        };
        let err = validate_path(&probe).unwrap_err();
        assert!(err.contains("文件不存在"));
    }

    #[test]
    fn existing_absolute_path_is_accepted() {
        // The OS temp dir is always an existing absolute path.
        let dir = std::env::temp_dir();
        assert!(dir.is_absolute());
        let dir_str = dir.to_string_lossy().to_string();
        let resolved = validate_path(&dir_str).expect("temp dir should validate");
        assert_eq!(resolved, dir);
    }

    #[test]
    fn sqlite_header_is_detected() {
        let path = std::env::temp_dir().join(format!("dbx-sqlite-header-{}.conf", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"SQLite format 3\0extra").unwrap();

        assert!(path_has_sqlite_header(&path).unwrap());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn non_sqlite_header_is_rejected() {
        let path = std::env::temp_dir().join(format!("dbx-sqlite-header-{}.conf", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"not sqlite").unwrap();

        assert!(!path_has_sqlite_header(&path).unwrap());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tilde_is_expanded_when_home_set() {
        // Only run when HOME (or USERPROFILE) actually points somewhere we can
        // use to validate. We do not require any specific file under it; we
        // only assert that expansion happens (so the absolute-path check
        // passes).
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
        if let Ok(h) = home {
            let p = std::path::Path::new(&h);
            if p.is_absolute() && p.exists() {
                let resolved = validate_path("~").expect("tilde should expand");
                assert!(resolved.is_absolute());
            }
        }
    }
}
