use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dbx_core::sql::decode_sql_file_bytes;

#[tauri::command]
pub fn pending_open_sql_files(state: tauri::State<'_, ExternalSqlOpenState>) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut paths = sql_file_paths_from_args(std::env::args().skip(1), &cwd);
    paths.extend(state.drain());
    dedupe_paths(paths)
}

#[tauri::command]
pub async fn read_external_sql_file(path: String) -> Result<String, String> {
    read_external_sql_file_content_async(PathBuf::from(path)).await
}

#[tauri::command]
pub async fn write_external_sql_file(path: String, content: String) -> Result<(), String> {
    write_external_sql_file_content_async(PathBuf::from(path), content).await
}

#[derive(Default)]
pub struct ExternalSqlOpenState {
    pending: Mutex<Vec<String>>,
}

impl ExternalSqlOpenState {
    pub fn push(&self, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.extend(paths);
        }
    }

    fn drain(&self) -> Vec<String> {
        self.pending.lock().map(|mut pending| pending.drain(..).collect()).unwrap_or_default()
    }
}

pub fn sql_file_paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().filter_map(|arg| sql_file_path_from_arg(arg.as_ref(), cwd)).collect()
}

fn sql_file_path_from_arg(arg: &str, cwd: &Path) -> Option<String> {
    if arg.starts_with('-') {
        return None;
    }

    let path = PathBuf::from(arg);
    if !is_sql_file_path(&path) {
        return None;
    }

    let resolved = if path.is_absolute() { path } else { cwd.join(path) };
    Some(resolved.to_string_lossy().to_string())
}

pub fn is_sql_file_path(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("sql")).unwrap_or(false)
}

#[cfg(test)]
fn read_external_sql_file_content(path: &Path) -> Result<String, String> {
    if !is_sql_file_path(path) {
        return Err("Only .sql files can be opened this way".to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read SQL file: {e}"))?;
    decode_sql_file_bytes(&bytes)
}

async fn read_external_sql_file_content_async(path: PathBuf) -> Result<String, String> {
    if !is_sql_file_path(&path) {
        return Err("Only .sql files can be opened this way".to_string());
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("Failed to read SQL file: {e}"))?;
    decode_sql_file_bytes(&bytes)
}

#[cfg(test)]
fn write_external_sql_file_content(path: &Path, content: &str) -> Result<(), String> {
    if !is_sql_file_path(path) {
        return Err("Only .sql files can be saved this way".to_string());
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to save SQL file: {e}"))
}

async fn write_external_sql_file_content_async(path: PathBuf, content: String) -> Result<(), String> {
    if !is_sql_file_path(&path) {
        return Err("Only .sql files can be saved this way".to_string());
    }
    tokio::fs::write(&path, content).await.map_err(|e| format!("Failed to save SQL file: {e}"))
}

fn dedupe_paths(paths: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_sql_file_args_case_insensitively() {
        let paths = sql_file_paths_from_args(["/tmp/a.sql", "--flag", "/tmp/b.SQL", "/tmp/c.txt"], Path::new("/work"));

        assert_eq!(paths, vec!["/tmp/a.sql", "/tmp/b.SQL"]);
    }

    #[test]
    fn resolves_relative_sql_file_args_against_cwd() {
        let paths = sql_file_paths_from_args(["queries/report.sql"], Path::new("/work"));

        assert_eq!(paths, vec!["/work/queries/report.sql"]);
    }

    #[test]
    fn drains_pending_sql_file_paths_once() {
        let state = ExternalSqlOpenState::default();
        state.push(vec!["/tmp/a.sql".to_string()]);

        assert_eq!(state.drain(), vec!["/tmp/a.sql"]);
        assert!(state.drain().is_empty());
    }

    #[test]
    fn reads_external_sql_file_content() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&path, "select 1;").unwrap();

        let result = read_external_sql_file_content(&path);

        let _ = std::fs::remove_file(&path);
        assert_eq!(result.unwrap(), "select 1;");
    }

    #[test]
    fn reads_gbk_external_sql_file_content() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"select '\xD6\xD0\xCE\xC4';").unwrap();

        let result = read_external_sql_file_content(&path);

        let _ = std::fs::remove_file(&path);
        assert_eq!(result.unwrap(), "select '中文';");
    }

    #[test]
    fn rejects_external_non_sql_file_content() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, "select 1;").unwrap();

        let result = read_external_sql_file_content(&path);

        let _ = std::fs::remove_file(&path);
        assert!(result.unwrap_err().contains(".sql"));
    }

    #[test]
    fn writes_external_sql_file_content() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));

        let result = write_external_sql_file_content(&path, "select 2;");

        let content = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok());
        assert_eq!(content, "select 2;");
    }

    #[test]
    fn rejects_external_non_sql_file_save() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.txt", uuid::Uuid::new_v4()));

        let result = write_external_sql_file_content(&path, "select 2;");

        assert!(result.unwrap_err().contains(".sql"));
        assert!(!path.exists());
    }
}
