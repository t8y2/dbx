use serde::Serialize;
use std::cmp::Ordering;
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

/// DataGrip-style name comparison for the file tree ("Sort by Name"):
/// case-insensitive, with digit runs compared as numbers (natural order), so
/// `proc2.sql` sorts before `proc10.sql` instead of after it.
fn compare_entry_names(a: &str, b: &str) -> Ordering {
    let mut a_tokens = tokenize_name(a).into_iter();
    let mut b_tokens = tokenize_name(b).into_iter();
    loop {
        match (a_tokens.next(), b_tokens.next()) {
            (Some(a_token), Some(b_token)) => {
                let ord = match (&a_token, &b_token) {
                    (NameToken::Num(a_num), NameToken::Num(b_num)) => compare_numeric_runs(a_num, b_num),
                    (NameToken::Text(a_text), NameToken::Text(b_text)) => {
                        a_text.to_lowercase().cmp(&b_text.to_lowercase())
                    }
                    // Digit-vs-non-digit falls back to character comparison
                    // (e.g. '.' sorts before '1', so proc.sql < proc1.sql).
                    (NameToken::Num(a_num), NameToken::Text(b_text)) => compare_mixed_chunk(a_num, b_text),
                    (NameToken::Text(a_text), NameToken::Num(b_num)) => compare_mixed_chunk(b_num, a_text).reverse(),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
    // Deterministic tiebreak for names that differ only by case.
    a.cmp(b)
}

enum NameToken {
    Num(String),
    Text(String),
}

fn tokenize_name(name: &str) -> Vec<NameToken> {
    let mut tokens = Vec::new();
    let mut buf = String::new();
    let mut prev_is_num: Option<bool> = None;
    for c in name.chars() {
        let is_num = c.is_ascii_digit();
        if let Some(prev) = prev_is_num {
            if prev != is_num {
                let chunk = std::mem::take(&mut buf);
                tokens.push(if prev { NameToken::Num(chunk) } else { NameToken::Text(chunk) });
            }
        }
        prev_is_num = Some(is_num);
        buf.push(c);
    }
    if let Some(prev) = prev_is_num {
        tokens.push(if prev { NameToken::Num(buf) } else { NameToken::Text(buf) });
    }
    tokens
}

/// Numeric comparison without overflow risk: strip leading zeros, then the
/// longer run is the larger number; equal-length runs compare digit by digit.
fn compare_numeric_runs(a: &str, b: &str) -> Ordering {
    let a = a.trim_start_matches('0');
    let b = b.trim_start_matches('0');
    match a.len().cmp(&b.len()) {
        Ordering::Equal => a.cmp(b),
        ord => ord,
    }
}

/// When a digit run meets a non-digit chunk at the same position, compare the
/// leading characters instead; a digit can never case-fold to a non-digit, so
/// the result is decisive.
fn compare_mixed_chunk(num_chunk: &str, text_chunk: &str) -> Ordering {
    let num_first = num_chunk.chars().next().map(|c| c.to_lowercase().next().unwrap_or(c));
    let text_first = text_chunk.chars().next().map(|c| c.to_lowercase().next().unwrap_or(c));
    num_first.cmp(&text_first)
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

    entries.sort_by(
        |a, b| {
            if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                compare_entry_names(&a.name, &b.name)
            }
        },
    );

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
        let entries = scan_sql_files(&root, 0, &mut visited);
        let mut names = Vec::new();
        collect_file_names(&entries, &mut names);
        names.sort();

        assert_eq!(names, vec!["nested.SQL", "root.sql"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compare_entry_names_matches_datagrip_rules() {
        use std::cmp::Ordering::{Greater, Less};
        // Natural numeric order: 2 < 10 (not lexicographic "10" < "2").
        assert_eq!(compare_entry_names("proc2.sql", "proc10.sql"), Less);
        assert_eq!(compare_entry_names("proc10.sql", "proc2.sql"), Greater);
        // Case-insensitive alphabetical order.
        assert_eq!(compare_entry_names("Alpha.sql", "beta.sql"), Less);
        assert_eq!(compare_entry_names("BETA.sql", "alpha.sql"), Greater);
        // Digits sort before letters, like platform file browsers.
        assert_eq!(compare_entry_names("1_init.sql", "alpha.sql"), Less);
        // A prefix sorts before its longer variant.
        assert_eq!(compare_entry_names("proc.sql", "proc1.sql"), Less);
        // Leading zeros carry no weight; the exact-name tiebreak decides.
        assert_eq!(compare_entry_names("proc007.sql", "proc7.sql"), Less);
    }

    #[test]
    fn scan_sql_files_orders_folders_first_then_natural_names() {
        let root = std::env::temp_dir().join(format!("dbx-sql-folder-order-{}", uuid::Uuid::new_v4()));
        // Each directory needs a SQL file to survive empty-folder pruning.
        for dir in ["10_reports", "2_reports", "Alpha", "beta"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("x.sql"), "SELECT 1;").unwrap();
        }
        std::fs::write(root.join("proc10.sql"), "SELECT 1;").unwrap();
        std::fs::write(root.join("proc2.sql"), "SELECT 1;").unwrap();
        std::fs::write(root.join("Zeta.sql"), "SELECT 1;").unwrap();
        std::fs::write(root.join("alpha.sql"), "SELECT 1;").unwrap();

        let mut visited = HashSet::new();
        let entries = scan_sql_files(&root, 0, &mut visited);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Folders first; both folders and files follow case-insensitive natural order.
        assert_eq!(
            names,
            vec!["2_reports", "10_reports", "Alpha", "beta", "alpha.sql", "proc2.sql", "proc10.sql", "Zeta.sql"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
