use std::path::{Component, Path, PathBuf};

use dbx_core::db::sqlite::path_has_sqlite_header;
use dbx_core::path_utils::expand_tilde;

/// Reveal a file in the platform's file manager.
///
/// - macOS: `open -R <path>` highlights the file in Finder.
/// - Windows: selects the file in Explorer via the opener plugin (COM
///   `SHOpenFolderAndSelectItems`, the same approach Electron uses).
/// - Linux: opens the parent directory with `xdg-open`. (DBus
///   `org.freedesktop.FileManager1.ShowItems` would be a higher-fidelity
///   alternative; deferred to a follow-up to avoid a new dependency.)
///
/// The caller MUST pass an absolute path that already exists. Path expansion
/// (`~`) and existence checks happen one layer up in the Tauri command.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        dbx_core::process::new_std_command("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to launch Finder: {e}"))
    }

    #[cfg(target_os = "windows")]
    {
        // Explorer does not parse its command line with the usual MSVC rules:
        // passing `explorer /select,<path>` through `Command::arg` wraps the
        // whole argument in quotes as soon as the path contains a space, and
        // Explorer then silently falls back to opening the default shell
        // folder (Documents). The opener plugin selects the item via COM
        // instead, which has no command-line parsing involved.
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| format!("failed to reveal in Explorer: {e}"))
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let target: PathBuf = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.to_path_buf());
        dbx_core::process::new_std_command("xdg-open")
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
        return Err(format!("file does not exist: {expanded}"));
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

fn validate_database_backup_root(raw: &str) -> Result<PathBuf, String> {
    let expanded = expand_tilde(raw.trim());
    let root = PathBuf::from(&expanded);
    if !root.is_absolute() || root.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(format!("backup root is not an absolute normalized path: {expanded}"));
    }
    std::fs::canonicalize(&root).map_err(|error| format!("failed to resolve backup root {}: {error}", root.display()))
}

fn validate_database_backup_file(raw: &str, allowed_roots: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("backup file path is empty".to_string());
    }

    let expanded = expand_tilde(trimmed);
    let path = PathBuf::from(&expanded);
    if !path.is_absolute() {
        return Err(format!("backup file path is not absolute: {expanded}"));
    }
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(format!("backup file path is not normalized: {expanded}"));
    }
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let lower_file_name = file_name.to_ascii_lowercase();
    if !(lower_file_name.ends_with(".sql") || lower_file_name.ends_with(".sql.gz")) {
        return Err(format!("backup file must use the .sql or .sql.gz extension: {expanded}"));
    }
    if file_name.chars().any(char::is_control) {
        return Err(format!("backup file name contains control characters: {expanded}"));
    }
    if !file_name.starts_with("dbx-backup__") {
        let resolved = match std::fs::canonicalize(&path) {
            Ok(resolved) => resolved,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // 文件已不存在（例如目标目录已断开）：能确认在受管根目录内的仍返回以便删除，
                // 无法确认归属的直接跳过（Ok(None)），避免让同批其他运行记录的清理整体失败。
                if allowed_roots.iter().any(|root| path.starts_with(root) && path != *root) {
                    return Ok(Some(path));
                }
                return Ok(None);
            }
            Err(error) => return Err(format!("failed to resolve custom backup file {}: {error}", path.display())),
        };
        if !allowed_roots.iter().any(|root| resolved.starts_with(root) && resolved != *root) {
            return Err(format!("custom backup file is outside the managed backup directories: {expanded}"));
        }
    }
    Ok(Some(path))
}

#[tauri::command]
pub async fn delete_database_backup_files(paths: Vec<String>, allowed_roots: Vec<String>) -> Result<usize, String> {
    // A disconnected destination must not prevent cleanup of files from the
    // other selected runs. Invalid or unavailable roots simply grant no
    // authority for custom-named files.
    let roots = allowed_roots.iter().filter_map(|root| validate_database_backup_root(root).ok()).collect::<Vec<_>>();
    let resolved =
        paths.iter().map(|path| validate_database_backup_file(path, &roots)).collect::<Result<Vec<_>, _>>()?;
    let mut deleted = 0;
    for path in resolved.into_iter().flatten() {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => deleted += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to delete backup file {}: {error}", path.display())),
        }
    }
    Ok(deleted)
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
        assert!(err.contains("file does not exist"));
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
    fn database_backup_file_requires_absolute_sql_path() {
        assert!(validate_database_backup_file("relative/backup.sql", &[]).is_err());
        let invalid_extension = if cfg!(windows) { "C:/tmp/backup.txt" } else { "/tmp/backup.txt" };
        assert!(validate_database_backup_file(invalid_extension, &[]).is_err());
        // 不存在的自定义命名备份：归属无法确认时按跳过处理（Ok(None)）而不是报错。
        let missing = format!("before-migration__{}.sql", uuid::Uuid::new_v4().simple(),);
        let custom_missing = if cfg!(windows) { format!("C:/tmp/{missing}") } else { format!("/tmp/{missing}") };
        assert_eq!(validate_database_backup_file(&custom_missing, &[]), Ok(None));
        let control_character =
            if cfg!(windows) { "C:/tmp/before\n-migration.sql" } else { "/tmp/before\n-migration.sql" };
        assert!(validate_database_backup_file(control_character, &[]).is_err());
        let valid = if cfg!(windows) { "C:/tmp/dbx-backup__nightly.SQL" } else { "/tmp/dbx-backup__nightly.SQL" };
        assert!(validate_database_backup_file(valid, &[]).is_ok());
        let valid_gzip =
            if cfg!(windows) { "C:/tmp/dbx-backup__nightly.SQL.GZ" } else { "/tmp/dbx-backup__nightly.SQL.GZ" };
        assert!(validate_database_backup_file(valid_gzip, &[]).is_ok());
    }

    #[tokio::test]
    async fn disconnected_root_does_not_abort_batch_cleanup() {
        let scratch = std::env::temp_dir().join(format!("dbx-backup-mixed-{}", uuid::Uuid::new_v4()));
        let connected = scratch.join("connected");
        let disconnected = scratch.join("disconnected");
        std::fs::create_dir_all(&connected).unwrap();
        std::fs::create_dir_all(&disconnected).unwrap();
        let kept = connected.join("before-migration__kept.sql");
        std::fs::write(&kept, b"kept placeholder").unwrap();
        let gone = disconnected.join("before-migration__gone.sql");
        std::fs::write(&gone, b"gone placeholder").unwrap();
        // 目标目录断开：整个目录被移除，文件路径随之失效。
        std::fs::remove_dir_all(&disconnected).unwrap();

        let deleted = delete_database_backup_files(
            vec![kept.to_string_lossy().to_string(), gone.to_string_lossy().to_string()],
            vec![connected.to_string_lossy().to_string(), disconnected.to_string_lossy().to_string()],
        )
        .await
        .unwrap();

        assert_eq!(deleted, 1);
        assert!(!kept.exists());
        let _ = std::fs::remove_dir_all(scratch);
    }

    #[tokio::test]
    async fn custom_gzip_backup_file_can_be_deleted() {
        let path = std::env::temp_dir().join(format!("before-migration__app-{}.sql.gz", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"gzip placeholder").unwrap();

        let deleted = delete_database_backup_files(
            vec![path.to_string_lossy().to_string()],
            vec![std::env::temp_dir().to_string_lossy().to_string()],
        )
        .await
        .unwrap();

        assert_eq!(deleted, 1);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn custom_backup_outside_allowed_root_is_rejected() {
        let scratch = std::env::temp_dir().join(format!("dbx-backup-root-test-{}", uuid::Uuid::new_v4()));
        let allowed = scratch.join("allowed");
        let outside = scratch.join("outside");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let path = outside.join("before-migration__app.sql");
        std::fs::write(&path, b"do not delete").unwrap();

        let result = delete_database_backup_files(
            vec![path.to_string_lossy().to_string()],
            vec![allowed.to_string_lossy().to_string()],
        )
        .await;

        assert!(result.is_err());
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(scratch);
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
