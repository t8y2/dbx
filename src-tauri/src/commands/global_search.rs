use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use grep::matcher::Matcher;
use grep::regex::{RegexMatcher, RegexMatcherBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

/// Directories that are never interesting for content search but huge enough to
/// make a recursive walk slow. Skipped outright, mirroring `list_sql_files`.
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

/// Skip files larger than this to keep search responsive and avoid decoding
/// huge binaries. Mirrors the external SQL editor file-size guard.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

const DEFAULT_LIMIT: usize = 500;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchRequest {
    pub roots: Vec<String>,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub extensions: Option<Vec<String>>,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub use_regex: Option<bool>,
    #[serde(default)]
    pub whole_word: Option<bool>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchMatch {
    pub path: String,
    pub file_name: String,
    /// 1-based line number.
    pub line: u64,
    /// 1-based column within the line, counted in `char`s (for CodeMirror).
    pub column: u64,
    /// The matched slice of the line.
    pub match_text: String,
    /// The full matching line, used for snippet highlighting.
    pub line_text: String,
}

fn build_matcher(request: &GlobalSearchRequest) -> Result<RegexMatcher, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("Query must not be empty".to_string());
    }
    let base = if request.use_regex == Some(true) { query.to_owned() } else { regex::escape(query) };
    let pattern = if request.whole_word == Some(true) { format!(r"\b(?:{base})\b") } else { base };
    RegexMatcherBuilder::new()
        .case_insensitive(request.case_sensitive != Some(true))
        .build(&pattern)
        .map_err(|error| format!("Invalid search pattern: {error}"))
}

/// Search `text` line-by-line with `matcher`, appending hits (1-based line and
/// `char`-counted column) and stopping once the global `limit` is reached.
fn matches_in_text(
    text: &str,
    matcher: &RegexMatcher,
    path: &str,
    file_name: &str,
    count: &AtomicUsize,
    limit: usize,
) -> Vec<GlobalSearchMatch> {
    let mut results = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if count.load(Ordering::Relaxed) >= limit {
            break;
        }
        let line_bytes = line.as_bytes();
        let mut search_from = 0;
        while let Ok(Some(found)) = matcher.find_at(line_bytes, search_from) {
            let (start, end) = (found.start(), found.end());
            if start >= line_bytes.len() {
                break;
            }
            let column = line[..start].chars().count() as u64 + 1;
            results.push(GlobalSearchMatch {
                path: path.to_owned(),
                file_name: file_name.to_owned(),
                line: (index + 1) as u64,
                column,
                match_text: String::from_utf8_lossy(&line_bytes[start..end.min(line_bytes.len())]).into_owned(),
                line_text: line.to_owned(),
            });
            let reached = count.fetch_add(1, Ordering::Relaxed) + 1;
            if reached >= limit {
                return results;
            }
            // Advance past this match, guarding against zero-width matches.
            search_from = if end > start { end } else { (start + 1).min(line_bytes.len()) };
        }
    }
    results
}

fn extension_matches(extensions: &HashSet<String>, path: &Path) -> bool {
    if extensions.is_empty() {
        return true;
    }
    path.extension().and_then(|ext| ext.to_str()).map(|ext| extensions.contains(&ext.to_lowercase())).unwrap_or(false)
}

fn is_pruned_dir(name: &str) -> bool {
    PRUNED_DIRS.iter().any(|dir| name.eq_ignore_ascii_case(dir))
}

fn search_root(request: &GlobalSearchRequest, root: &str) -> Vec<GlobalSearchMatch> {
    let extensions: HashSet<String> = request
        .extensions
        .as_ref()
        .map(|exts| {
            exts.iter()
                .map(|ext| ext.trim().trim_start_matches('.').to_lowercase())
                .filter(|ext| !ext.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let count = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT);
    let matcher = match build_matcher(request) {
        Ok(matcher) => matcher,
        Err(_) => return Vec::new(),
    };

    let mut results = Vec::new();
    let mut builder = WalkBuilder::new(root);
    builder.hidden(true).git_ignore(true).git_global(true).git_exclude(true).follow_links(false);
    builder.filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy();
            return !is_pruned_dir(&name);
        }
        true
    });

    for result in builder.build() {
        if stopped.load(Ordering::Relaxed) {
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        if !extension_matches(&extensions, entry.path()) {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
        }

        let file_name = match entry.file_name().to_str() {
            Some(name) => name.to_owned(),
            None => continue,
        };
        let path = match entry.path().to_str() {
            Some(path) => path.to_owned(),
            None => continue,
        };
        let contents = match std::fs::read(entry.path()) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => continue,
        };

        let file_results = matches_in_text(&contents, &matcher, &path, &file_name, &count, limit);
        // If the file body produced no hits but the file name matches the query,
        // surface the file anyway as a filename match (line 0 is the filename sentinel).
        if file_results.is_empty() && count.load(Ordering::Relaxed) < limit {
            if let Ok(Some(found)) = matcher.find_at(file_name.as_bytes(), 0) {
                let (start, end) = (found.start(), found.end());
                let column = file_name[..start].chars().count() as u64 + 1;
                let reached = count.fetch_add(1, Ordering::Relaxed) + 1;
                results.push(GlobalSearchMatch {
                    path: path.clone(),
                    file_name: file_name.clone(),
                    line: 0,
                    column,
                    match_text: file_name[start..end.min(file_name.len())].to_owned(),
                    line_text: file_name.clone(),
                });
                if reached >= limit {
                    stopped.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
        results.extend(file_results);
        if count.load(Ordering::Relaxed) >= limit {
            stopped.store(true, Ordering::Relaxed);
            break;
        }
    }

    results
}

#[tauri::command]
pub async fn global_search(request: GlobalSearchRequest) -> Result<Vec<GlobalSearchMatch>, String> {
    if request.roots.is_empty() {
        return Ok(Vec::new());
    }
    let request = Arc::new(request);
    // Filesystem walking + regex searching is blocking work; run it on a thread
    // pool so the Tauri main thread (and thus the webview) does not freeze.
    let roots = request.roots.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        for root in roots {
            let matches = search_root(&request, &root);
            results.extend(matches);
            if results.len() >= request.limit.unwrap_or(DEFAULT_LIMIT) {
                break;
            }
        }
        results.truncate(request.limit.unwrap_or(DEFAULT_LIMIT));
        Ok(results)
    })
    .await
    .map_err(|error| format!("Failed to run global search: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn req(roots: &[&str], query: &str) -> GlobalSearchRequest {
        GlobalSearchRequest {
            roots: roots.iter().map(|s| s.to_string()).collect(),
            query: query.to_string(),
            extensions: None,
            case_sensitive: None,
            use_regex: None,
            whole_word: None,
            limit: None,
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-global-search-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn searches_substring_with_line_and_column() {
        let root = temp_dir("substr");
        let file = root.join("data.sql");
        std::fs::write(&file, "SELECT id\nFROM users\nWHERE name = 'alice';\n").unwrap();
        let r = req(&[root.to_str().unwrap()], "users");
        let results = global_search(r).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line, 2);
        assert_eq!(results[0].match_text, "users");
        assert!(results[0].line_text.contains("FROM users"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn whole_word_does_not_match_substring() {
        let root = temp_dir("wholeword");
        std::fs::write(root.join("a.sql"), "SELECT user, users FROM t;\n").unwrap();
        let mut r = req(&[root.to_str().unwrap()], "user");
        r.whole_word = Some(true);
        let results = global_search(r).await.unwrap();
        // "user" as a whole word appears once (in "user"), "users" is not a whole-word match.
        assert!(!results.is_empty());
        assert!(results.iter().any(|m| m.match_text == "user"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn case_sensitive_flag_is_respected() {
        let root = temp_dir("case");
        std::fs::write(root.join("a.sql"), "SELECT USERS FROM t;\n").unwrap();
        let mut r = req(&[root.to_str().unwrap()], "users");
        r.case_sensitive = Some(true);
        let results = global_search(r).await.unwrap();
        assert!(results.is_empty());

        let mut r2 = req(&[root.to_str().unwrap()], "USERS");
        r2.case_sensitive = Some(true);
        let results2 = global_search(r2).await.unwrap();
        assert!(!results2.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn extension_filter_is_applied() {
        let root = temp_dir("ext");
        std::fs::write(root.join("a.sql"), "SELECT needle;\n").unwrap();
        std::fs::write(root.join("b.txt"), "needle here\n").unwrap();
        let mut r = req(&[root.to_str().unwrap()], "needle");
        r.extensions = Some(vec!["sql".to_string()]);
        let results = global_search(r).await.unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("a.sql"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn limit_truncates_results() {
        let root = temp_dir("limit");
        std::fs::write(root.join("a.sql"), "SELECT needle;\nSELECT needle;\nSELECT needle;\n").unwrap();
        let mut r = req(&[root.to_str().unwrap()], "needle");
        r.limit = Some(2);
        let results = global_search(r).await.unwrap();
        assert_eq!(results.len(), 2);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn matches_file_name_when_body_has_no_hits() {
        let root = temp_dir("fname");
        // "users_tbl.sql" matches by name only; body has no "users".
        std::fs::write(root.join("users_tbl.sql"), "SELECT 1;\n").unwrap();
        // "other.sql" has "users" in its body.
        std::fs::write(root.join("other.sql"), "SELECT users;\n").unwrap();
        let r = req(&[root.to_str().unwrap()], "users");
        let results = global_search(r).await.unwrap();
        assert!(
            results.iter().any(|m| m.file_name == "users_tbl.sql" && m.line == 0),
            "expected a filename-only match for users_tbl.sql with line 0"
        );
        assert!(results.iter().any(|m| m.file_name == "other.sql" && m.line == 1));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn skips_pruned_directories() {
        let root = temp_dir("pruned");
        let nested = root.join("node_modules");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("dep.sql"), "SELECT needle;\n").unwrap();
        std::fs::write(root.join("main.sql"), "SELECT needle;\n").unwrap();
        let r = req(&[root.to_str().unwrap()], "needle");
        let results = global_search(r).await.unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("main.sql"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
