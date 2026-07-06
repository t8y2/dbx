use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

const MAX_SCAN_DEPTH: usize = 10;

/// Directories that are never interesting for SQL file browsing but are huge
/// (often tens of thousands of entries), which makes a recursive scan take
/// long enough to freeze the UI. Skipped outright.
const PRUNED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".gradle",
    ".m2",
    ".cache",
];

#[derive(Debug, Serialize)]
pub struct SqlFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<SqlFileEntry>,
}

fn is_pruned_dir(name: &str) -> bool {
    PRUNED_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d))
}

fn scan_sql_files(dir: &Path, depth: usize, visited: &mut HashSet<String>) -> Vec<SqlFileEntry> {
    if depth > MAX_SCAN_DEPTH {
        return vec![];
    }

    // Canonicalize only the top-level folder once per scan to guard against
    // symlink loops; doing it for every subdir doubled the stat cost.
    let canonical = std::fs::canonicalize(dir).ok();
    if let Some(ref c) = canonical {
        let c_str = c.to_string_lossy().to_string();
        if !visited.insert(c_str) {
            return vec![];
        }
    }

    let mut entries = Vec::new();
    let dir_entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return entries,
    };

    for entry in dir_entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        if file_type.is_dir() {
            if is_pruned_dir(&name) {
                continue;
            }
            let children = scan_sql_files(&path, depth + 1, visited);
            if !children.is_empty() {
                entries.push(SqlFileEntry { name, path: path.to_string_lossy().to_string(), is_dir: true, children });
            }
        } else if file_type.is_file()
            && path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("sql")).unwrap_or(false)
        {
            entries.push(SqlFileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: vec![],
            });
        }
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    entries
}

#[tauri::command]
pub async fn list_sql_files_in_folder(folder_path: String) -> Result<Vec<SqlFileEntry>, String> {
    let path = Path::new(&folder_path).to_path_buf();
    // Filesystem scanning is blocking work; run it on a thread pool so the
    // Tauri main thread (and thus the webview) does not freeze while large
    // folders are being walked.
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_dir() {
            return Err(format!("Path is not a directory: {}", folder_path));
        }
        let mut visited = HashSet::new();
        Ok(scan_sql_files(&path, 0, &mut visited))
    })
    .await
    .map_err(|e| format!("Failed to scan folder: {e}"))?
}
