use std::path::{Path, PathBuf};

use rusqlite::DatabaseName;

use crate::db::sqlite::{is_memory_database_path, SqliteHandle};
use crate::path_utils::expand_tilde;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteBackupOptions {
    pub source_path: String,
    pub destination_path: String,
}

pub async fn backup_sqlite_database(pool: SqliteHandle, options: SqliteBackupOptions) -> Result<(), String> {
    let destination = prepare_destination_path(&options)?;
    let temp = backup_temp_path(&destination);
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            conn.backup(DatabaseName::Main, &temp, None).map_err(|e| format!("SQLite backup failed: {e}"))
        })?;
        replace_backup_file(&temp, &destination)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn prepare_destination_path(options: &SqliteBackupOptions) -> Result<PathBuf, String> {
    let destination = normalize_user_path(&options.destination_path, "Destination path is empty")?;
    ensure_no_nul(&options.destination_path)?;

    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    if destination.is_dir() {
        return Err("Backup destination must be a file".to_string());
    }

    let source = options.source_path.trim();
    if !is_memory_database_path(source) && !source.is_empty() {
        ensure_no_nul(source)?;
        let source = normalize_user_path(source, "Source path is empty")?;
        if paths_match(&source, &destination)? {
            return Err("Backup destination must be different from the source database file".to_string());
        }
    }

    Ok(destination)
}

fn backup_temp_path(destination: &Path) -> PathBuf {
    let file_name = destination.file_name().and_then(|name| name.to_str()).unwrap_or("backup.db");
    destination.with_file_name(format!("{file_name}.tmp-{}", uuid::Uuid::new_v4()))
}

fn replace_backup_file(temp: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        let backup = existing_backup_path(destination);
        std::fs::rename(destination, &backup)
            .map_err(|e| format!("Failed to back up existing destination file: {e}"))?;
        match std::fs::rename(temp, destination) {
            Ok(()) => {
                std::fs::remove_file(&backup).ok();
                Ok(())
            }
            Err(err) => {
                let _ = std::fs::rename(&backup, destination);
                Err(format!("Failed to replace backup destination: {err}"))
            }
        }
    } else {
        std::fs::rename(temp, destination).map_err(|e| format!("Failed to move backup into place: {e}"))
    }
}

fn existing_backup_path(destination: &Path) -> PathBuf {
    let file_name = destination.file_name().and_then(|name| name.to_str()).unwrap_or("backup.db");
    destination.with_file_name(format!("{file_name}.backup-{}", uuid::Uuid::new_v4()))
}

fn normalize_user_path(path: &str, empty_message: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(empty_message.to_string());
    }
    Ok(PathBuf::from(expand_tilde(trimmed)))
}

fn ensure_no_nul(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        Err("Path contains an invalid NUL byte".to_string())
    } else {
        Ok(())
    }
}

fn paths_match(a: &Path, b: &Path) -> Result<bool, String> {
    Ok(canonicalize_existing_or_parent(a)? == canonicalize_existing_or_parent(b)?)
}

fn canonicalize_existing_or_parent(path: &Path) -> Result<PathBuf, String> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Ok(canonical);
    }
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    Ok(parent.join(path.file_name().ok_or_else(|| "Path is missing a file name".to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite::{connect_path, execute_query};

    #[tokio::test]
    async fn backup_sqlite_database_copies_memory_database() {
        let dir = std::env::temp_dir().join(format!("dbx-sqlite-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let destination = dir.join("backup.db");
        let pool = connect_path(":memory:").await.expect("connect memory sqlite");
        execute_query(&pool, "CREATE TABLE users (name TEXT); INSERT INTO users VALUES ('Ada');")
            .await
            .expect("seed memory database");

        backup_sqlite_database(
            pool,
            SqliteBackupOptions {
                source_path: ":memory:".to_string(),
                destination_path: destination.to_string_lossy().to_string(),
            },
        )
        .await
        .expect("backup memory database");

        let backup = connect_path(destination.to_string_lossy().as_ref()).await.expect("open backup");
        let result = execute_query(&backup, "SELECT name FROM users").await.expect("query backup");
        assert_eq!(result.rows[0][0], serde_json::json!("Ada"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_destination_rejects_same_file() {
        let dir = std::env::temp_dir().join(format!("dbx-sqlite-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let source = dir.join("source.db");
        std::fs::write(&source, "").expect("create source");

        let result = prepare_destination_path(&SqliteBackupOptions {
            source_path: source.to_string_lossy().to_string(),
            destination_path: source.to_string_lossy().to_string(),
        });

        assert!(result.expect_err("same file should be rejected").contains("different"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_destination_creates_missing_parent_dir() {
        let dir = std::env::temp_dir().join(format!("dbx-sqlite-backup-{}", uuid::Uuid::new_v4()));
        let destination = dir.join("nested").join("backup.db");

        let result = prepare_destination_path(&SqliteBackupOptions {
            source_path: ":memory:".to_string(),
            destination_path: destination.to_string_lossy().to_string(),
        })
        .expect("prepare destination");

        assert_eq!(result, destination);
        assert!(destination.parent().expect("parent").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_backup_file_restores_existing_destination_when_replace_fails() {
        let dir = std::env::temp_dir().join(format!("dbx-sqlite-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let destination = dir.join("backup.db");
        let missing_temp = dir.join("missing.db");
        std::fs::write(&destination, "existing").expect("create destination");

        let result = replace_backup_file(&missing_temp, &destination);

        assert!(result.expect_err("replace should fail").contains("replace"));
        assert_eq!(std::fs::read_to_string(&destination).expect("read destination"), "existing");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
