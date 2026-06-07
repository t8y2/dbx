use std::path::{Path, PathBuf};
use std::sync::Mutex;

const DB_EXTENSIONS: &[&str] = &["db", "sqlite", "sqlite3", "duckdb"];

#[derive(Default)]
pub struct ExternalDbOpenState {
    pending: Mutex<Vec<String>>,
}

impl ExternalDbOpenState {
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

#[tauri::command]
pub fn pending_open_db_files(state: tauri::State<'_, ExternalDbOpenState>) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut paths = db_file_paths_from_args(std::env::args().skip(1), &cwd);
    paths.extend(state.drain());
    dedupe_paths(paths)
}

pub fn db_file_paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().filter_map(|arg| db_file_path_from_arg(arg.as_ref(), cwd)).collect()
}

fn db_file_path_from_arg(arg: &str, cwd: &Path) -> Option<String> {
    if arg.starts_with('-') {
        return None;
    }

    let path = PathBuf::from(arg);
    if !is_db_file_path(&path) {
        return None;
    }

    let resolved = if path.is_absolute() { path } else { cwd.join(path) };
    Some(resolved.to_string_lossy().to_string())
}

pub fn is_db_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| DB_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)))
        .unwrap_or(false)
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
    fn filters_db_file_args_case_insensitively() {
        let paths = db_file_paths_from_args(
            ["/tmp/a.db", "--flag", "/tmp/b.SQLITE", "/tmp/c.sqlite3", "/tmp/d.duckdb", "/tmp/e.txt"],
            Path::new("/work"),
        );

        assert_eq!(paths, vec!["/tmp/a.db", "/tmp/b.SQLITE", "/tmp/c.sqlite3", "/tmp/d.duckdb"]);
    }

    #[test]
    fn resolves_relative_db_file_args_against_cwd() {
        let paths = db_file_paths_from_args(["data/mydb.db"], Path::new("/work"));

        assert_eq!(paths, vec!["/work/data/mydb.db"]);
    }

    #[test]
    fn drains_pending_db_file_paths_once() {
        let state = ExternalDbOpenState::default();
        state.push(vec!["/tmp/a.db".to_string()]);

        assert_eq!(state.drain(), vec!["/tmp/a.db"]);
        assert!(state.drain().is_empty());
    }

    #[test]
    fn is_db_file_path_recognizes_extensions() {
        assert!(is_db_file_path(Path::new("test.db")));
        assert!(is_db_file_path(Path::new("test.sqlite")));
        assert!(is_db_file_path(Path::new("test.sqlite3")));
        assert!(is_db_file_path(Path::new("test.duckdb")));
        assert!(is_db_file_path(Path::new("test.DB")));
        assert!(!is_db_file_path(Path::new("test.sql")));
        assert!(!is_db_file_path(Path::new("test.txt")));
    }
}
