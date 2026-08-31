use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

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

fn validate_sql_file_name(file_name: &str) -> Result<&str, String> {
    let file_name = file_name.trim();
    if file_name.is_empty() || file_name == "." || file_name == ".." || file_name.contains(['/', '\\']) {
        return Err("SQL file name must not contain a path".to_string());
    }
    if !file_name.to_ascii_lowercase().ends_with(".sql") || file_name.len() <= 4 {
        return Err("Only .sql files can be managed here".to_string());
    }
    Ok(file_name)
}

fn renamed_sql_file_display_path(file_path: &str, file_name: &str) -> Result<String, String> {
    #[cfg(windows)]
    let parent_end = file_path.rfind(['/', '\\']).map(|index| index + 1);
    #[cfg(not(windows))]
    let parent_end = file_path.rfind('/').map(|index| index + 1);

    Ok(parent_end.map_or_else(|| file_name.to_owned(), |index| format!("{}{}", &file_path[..index], file_name)))
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(path).map_err(|error| format!("Failed to resolve {label}: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(path)
}

fn managed_directory(root_path: &str, directory_path: &str) -> Result<PathBuf, String> {
    let root = canonical_directory(Path::new(root_path), "SQL root folder")?;
    let directory = canonical_directory(Path::new(directory_path), "SQL folder")?;
    if !directory.starts_with(&root) {
        return Err("SQL folder is outside the opened root folder".to_string());
    }
    Ok(directory)
}

fn managed_sql_file(root_path: &str, file_path: &str) -> Result<PathBuf, String> {
    let root = canonical_directory(Path::new(root_path), "SQL root folder")?;
    let file = std::fs::canonicalize(file_path).map_err(|error| format!("Failed to resolve SQL file: {error}"))?;
    if !file.starts_with(&root) {
        return Err("SQL file is outside the opened root folder".to_string());
    }
    if !file.is_file()
        || !file
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("sql"))
    {
        return Err("Only .sql files can be managed here".to_string());
    }
    Ok(file)
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
    let characters: Vec<char> = file_filter.chars().collect();
    if !characters.contains(&'*') && !characters.contains(&'?') {
        return false;
    }
    for (index, character) in characters.iter().enumerate() {
        if matches!(character, '\\' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '+') {
            return false;
        }
        // A wildcard directly after `.` is a regex quantifier (`.*`, `.?`),
        // not a glob wildcard: `.*sql` must stay a regex while `*.sql` is a glob.
        if matches!(character, '*' | '?') && index > 0 && characters[index - 1] == '.' {
            return false;
        }
    }
    true
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

#[tauri::command]
pub async fn create_sql_file_in_folder(
    root_path: String,
    directory_path: String,
    file_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_name = validate_sql_file_name(&file_name)?.to_owned();
        let directory = managed_directory(&root_path, &directory_path)?;
        let path = directory.join(&file_name);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Failed to create SQL file: {error}"))?;
        // Keep the path form used by the file tree. `canonicalize` returns a
        // Windows extended-length path, which is a different frontend identity.
        Ok(Path::new(&directory_path).join(file_name).to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Failed to create SQL file: {error}"))?
}

#[tauri::command]
pub async fn rename_sql_file_in_folder(
    root_path: String,
    file_path: String,
    file_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_name = validate_sql_file_name(&file_name)?.to_owned();
        let display_path = renamed_sql_file_display_path(&file_path, &file_name)?;
        let file = managed_sql_file(&root_path, &file_path)?;
        let target =
            file.parent().ok_or_else(|| "Failed to resolve SQL file parent folder".to_string())?.join(&file_name);
        if target.exists() {
            let existing = std::fs::canonicalize(&target)
                .map_err(|error| format!("Failed to resolve SQL file target: {error}"))?;
            if existing != file {
                return Err("A SQL file with this name already exists".to_string());
            }
        }
        std::fs::rename(&file, &target).map_err(|error| format!("Failed to rename SQL file: {error}"))?;
        Ok(display_path)
    })
    .await
    .map_err(|error| format!("Failed to rename SQL file: {error}"))?
}

#[tauri::command]
pub async fn delete_sql_file_in_folder(root_path: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = managed_sql_file(&root_path, &file_path)?;
        std::fs::remove_file(file).map_err(|error| format!("Failed to delete SQL file: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to delete SQL file: {error}"))?
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

    #[test]
    fn compile_file_filter_keeps_dot_prefixed_wildcards_as_regex() {
        // `.*sql` is a regex ("anything ending in sql"), not a glob that would
        // match only literal dots before "sql".
        let filter = compile_file_filter(".*sql").unwrap();

        assert!(filter.is_match("notes.sql"));
        assert!(filter.is_match("mysql-dump.txt"));
        assert!(!filter.is_match("readme.txt"));
    }

    #[test]
    fn compile_file_filter_accepts_question_mark_globs() {
        let filter = compile_file_filter("file?.sql").unwrap();

        assert!(filter.is_match("file1.sql"));
        assert!(!filter.is_match("file12.sql"));
    }

    #[test]
    fn validates_single_sql_file_names() {
        assert_eq!(validate_sql_file_name("query.sql").unwrap(), "query.sql");
        assert!(validate_sql_file_name("query.txt").is_err());
        assert!(validate_sql_file_name("nested/query.sql").is_err());
        assert!(validate_sql_file_name("nested\\query.sql").is_err());
        assert_eq!(renamed_sql_file_display_path("draft.sql", "report.sql").unwrap(), "report.sql");
    }

    #[tokio::test]
    async fn manages_sql_files_within_the_opened_root() {
        let root = std::env::temp_dir().join(format!("dbx-sql-file-manage-{}", uuid::Uuid::new_v4()));
        let nested = root.join("queries");
        std::fs::create_dir_all(&nested).unwrap();

        let created = create_sql_file_in_folder(
            root.to_string_lossy().into_owned(),
            nested.to_string_lossy().into_owned(),
            "draft.sql".to_string(),
        )
        .await
        .unwrap();
        assert!(Path::new(&created).is_file());

        let renamed = rename_sql_file_in_folder(root.to_string_lossy().into_owned(), created, "report.sql".to_string())
            .await
            .unwrap();
        assert!(Path::new(&renamed).is_file());

        delete_sql_file_in_folder(root.to_string_lossy().into_owned(), renamed.clone()).await.unwrap();
        assert!(!Path::new(&renamed).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn keeps_the_file_tree_path_representation_for_managed_files() {
        let root = std::env::temp_dir().join(format!("dbx-sql-file-path-{}", uuid::Uuid::new_v4()));
        let nested = root.join("queries");
        let displayed_root = root.join(".");
        let displayed_directory = nested.join(".");
        std::fs::create_dir_all(&nested).unwrap();

        let created = create_sql_file_in_folder(
            displayed_root.to_string_lossy().into_owned(),
            displayed_directory.to_string_lossy().into_owned(),
            "draft.sql".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(created, displayed_directory.join("draft.sql").to_string_lossy());

        let renamed =
            rename_sql_file_in_folder(displayed_root.to_string_lossy().into_owned(), created, "report.sql".to_string())
                .await
                .unwrap();
        assert_eq!(renamed, displayed_directory.join("report.sql").to_string_lossy());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn renames_files_when_only_the_case_changes() {
        let root = std::env::temp_dir().join(format!("dbx-sql-file-case-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("draft.sql");
        std::fs::write(&source, "SELECT 1;").unwrap();

        let renamed = rename_sql_file_in_folder(
            root.to_string_lossy().into_owned(),
            source.to_string_lossy().into_owned(),
            "DRAFT.sql".to_string(),
        )
        .await
        .unwrap();

        assert!(Path::new(&renamed).is_file());
        assert_eq!(Path::new(&renamed).file_name().unwrap(), "DRAFT.sql");
        std::fs::remove_dir_all(root).unwrap();
    }
}
