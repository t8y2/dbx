use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

const MAX_SCAN_DEPTH: usize = 10;
const DEFAULT_FILE_FILTER: &str = "*.sql";

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

fn glob_to_regex(glob: &str) -> String {
    let mut pattern = String::from("(?i)^");
    for character in glob.chars() {
        match character {
            '*' => pattern.push_str(".*"),
            '?' => pattern.push('.'),
            _ => pattern.push_str(&regex::escape(&character.to_string())),
        }
    }
    pattern.push('$');
    pattern
}

fn is_glob_filter(file_filter: &str) -> bool {
    file_filter.contains('*')
        && !file_filter
            .chars()
            .any(|character| matches!(character, '\\' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '+'))
}

fn compile_file_filter(file_filter: &str) -> Result<Regex, String> {
    let file_filter = file_filter.trim();
    let pattern = if file_filter.is_empty() {
        glob_to_regex(DEFAULT_FILE_FILTER)
    } else if is_glob_filter(file_filter) {
        glob_to_regex(file_filter)
    } else {
        file_filter.to_string()
    };
    Regex::new(&pattern).map_err(|error| format!("Invalid file filter regular expression: {error}"))
}

fn scan_sql_files(dir: &Path, depth: usize, visited: &mut HashSet<String>, file_filter: &Regex) -> Vec<SqlFileEntry> {
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
            let children = scan_sql_files(&path, depth + 1, visited, file_filter);
            if !children.is_empty() {
                entries.push(SqlFileEntry { name, path: path.to_string_lossy().to_string(), is_dir: true, children });
            }
        } else if file_type.is_file() && file_filter.is_match(&name) {
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
pub async fn list_sql_files_in_folder(
    folder_path: String,
    file_filter: Option<String>,
) -> Result<Vec<SqlFileEntry>, String> {
    let path = Path::new(&folder_path).to_path_buf();
    let file_filter = compile_file_filter(file_filter.as_deref().unwrap_or(DEFAULT_FILE_FILTER))?;
    // Filesystem scanning is blocking work; run it on a thread pool so the
    // Tauri main thread (and thus the webview) does not freeze while large
    // folders are being walked.
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_dir() {
            return Err(format!("Path is not a directory: {}", folder_path));
        }
        let mut visited = HashSet::new();
        Ok(scan_sql_files(&path, 0, &mut visited, &file_filter))
    })
    .await
    .map_err(|e| format!("Failed to scan folder: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_file_names(entries: &[SqlFileEntry], names: &mut Vec<String>) {
        for entry in entries {
            if entry.is_dir {
                collect_file_names(&entry.children, names);
            } else {
                names.push(entry.name.clone());
            }
        }
    }

    #[test]
    fn scan_sql_files_skips_pruned_metadata_directories() {
        let root = std::env::temp_dir().join(format!("dbx-sql-folder-scan-{}", uuid::Uuid::new_v4()));
        let idea = root.join(".idea");
        let nested = root.join("queries");
        std::fs::create_dir_all(&idea).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("root.sql"), "SELECT 1;").unwrap();
        std::fs::write(nested.join("nested.SQL"), "SELECT 2;").unwrap();
        std::fs::write(nested.join("notes.txt"), "ignored").unwrap();
        std::fs::write(idea.join("workspace.sql"), "SELECT 3;").unwrap();

        let mut visited = HashSet::new();
        let filter = compile_file_filter(DEFAULT_FILE_FILTER).unwrap();
        let entries = scan_sql_files(&root, 0, &mut visited, &filter);
        let mut names = Vec::new();
        collect_file_names(&entries, &mut names);
        names.sort();

        assert_eq!(names, vec!["nested.SQL", "root.sql"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_sql_files_accepts_user_regular_expressions() {
        let root = std::env::temp_dir().join(format!("dbx-file-folder-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("query.sql"), "SELECT 1;").unwrap();
        std::fs::write(root.join("script.sh"), "echo hello").unwrap();
        std::fs::write(root.join("tool.py"), "print('hello')").unwrap();

        let mut visited = HashSet::new();
        let filter = compile_file_filter(r"\.(sql|sh|py)$").unwrap();
        let entries = scan_sql_files(&root, 0, &mut visited, &filter);
        let mut names = Vec::new();
        collect_file_names(&entries, &mut names);
        names.sort();

        assert_eq!(names, vec!["query.sql", "script.sh", "tool.py"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compile_file_filter_accepts_glob_patterns() {
        let filter = compile_file_filter("*.sh").unwrap();

        assert!(filter.is_match("script.sh"));
        assert!(filter.is_match("SCRIPT.SH"));
        assert!(!filter.is_match("script.py"));
    }
}
