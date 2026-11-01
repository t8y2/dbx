use dbx_core::sql::decode_sql_file_bytes;
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_SCAN_DEPTH: usize = 10;
const DEFAULT_FILE_FILTER: &str = r"(?i)\.(sql|ddl)$";
const MAX_SEARCH_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SEARCH_FILE_MATCHES: usize = 100;
const MAX_SEARCH_MATCHES: usize = 1000;
const MAX_SEARCH_LINE_CHARS: usize = 200;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSearchSegment {
    text: String,
    matched: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSearchContext {
    line_number: usize,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSearchMatch {
    line_number: usize,
    column: usize,
    line_text: String,
    segments: Vec<SqlFileSearchSegment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_before: Option<SqlFileSearchContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_after: Option<SqlFileSearchContext>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSearchFile {
    path: String,
    matches: Vec<SqlFileSearchMatch>,
    total_matches: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSqlSearchFile {
    path: String,
    reason: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileSearchResult {
    files: Vec<SqlFileSearchFile>,
    skipped_files: Vec<SkippedSqlSearchFile>,
    truncated: bool,
}

fn validate_file_name(file_name: &str) -> Result<&str, String> {
    let file_name = file_name.trim();
    if file_name.is_empty() || file_name == "." || file_name == ".." || file_name.contains(['/', '\\']) {
        return Err("File name must not contain a path".to_string());
    }
    Ok(file_name)
}

fn validate_directory_name(directory_name: &str) -> Result<&str, String> {
    let directory_name = directory_name.trim();
    if directory_name.is_empty()
        || directory_name == "."
        || directory_name == ".."
        || directory_name.contains(['/', '\\', '\0'])
    {
        return Err("Folder name must not contain a path".to_string());
    }
    let mut components = Path::new(directory_name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_))) || components.next().is_some() {
        return Err("Folder name must not contain a path".to_string());
    }
    if is_pruned_dir(directory_name) {
        return Err("This folder name is excluded from the SQL file browser".to_string());
    }
    Ok(directory_name)
}

// A directory entry itself must not be a symlink: canonicalizing one would
// rename/delete its target instead of the entry the user selected.
fn managed_child_directory(root_path: &str, folder_path: &str) -> Result<PathBuf, String> {
    let metadata =
        std::fs::symlink_metadata(folder_path).map_err(|error| format!("Failed to inspect SQL folder: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Only directories can be managed here".to_string());
    }
    let root = canonical_directory(Path::new(root_path), "SQL root folder")?;
    let folder = managed_directory(root_path, folder_path)?;
    if folder == root {
        return Err("The opened root folder cannot be renamed or deleted".to_string());
    }
    Ok(folder)
}

fn validate_sql_file_name(file_name: &str) -> Result<&str, String> {
    let file_name = validate_file_name(file_name)?;
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

fn managed_file(root_path: &str, file_path: &str) -> Result<PathBuf, String> {
    let root = canonical_directory(Path::new(root_path), "SQL root folder")?;
    let file = std::fs::canonicalize(file_path).map_err(|error| format!("Failed to resolve file: {error}"))?;
    if !file.starts_with(&root) {
        return Err("File is outside the opened root folder".to_string());
    }
    if !file.is_file() {
        return Err("Only files can be managed here".to_string());
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
    let file_filter = if file_filter.is_empty() { DEFAULT_FILE_FILTER } else { file_filter };
    let pattern = if is_glob_filter(file_filter) { glob_to_regex(file_filter) } else { file_filter.to_string() };
    Regex::new(&pattern).map_err(|error| format!("Invalid file filter regular expression: {error}"))
}

fn scan_sql_files(dir: &Path, depth: usize, visited: &mut HashSet<String>, file_filter: &Regex) -> Vec<SqlFileEntry> {
    scan_sql_files_with_directories(dir, depth, visited, file_filter, false)
}

fn scan_sql_files_with_directories(
    dir: &Path,
    depth: usize,
    visited: &mut HashSet<String>,
    file_filter: &Regex,
    include_empty_directories: bool,
) -> Vec<SqlFileEntry> {
    scan_sql_files_with_diagnostics(dir, depth, visited, file_filter, include_empty_directories, None)
}

fn scan_sql_files_with_diagnostics(
    dir: &Path,
    depth: usize,
    visited: &mut HashSet<String>,
    file_filter: &Regex,
    include_empty_directories: bool,
    mut skipped_files: Option<&mut Vec<SkippedSqlSearchFile>>,
) -> Vec<SqlFileEntry> {
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
        Err(_) => {
            if let Some(skipped) = skipped_files.as_deref_mut() {
                skipped.push(SkippedSqlSearchFile {
                    path: dir.to_string_lossy().into_owned(),
                    reason: "unreadable".to_string(),
                });
            }
            return entries;
        }
    };

    for entry in dir_entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                if let Some(skipped) = skipped_files.as_deref_mut() {
                    skipped.push(SkippedSqlSearchFile {
                        path: dir.to_string_lossy().into_owned(),
                        reason: "unreadable".to_string(),
                    });
                }
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => {
                if let Some(skipped) = skipped_files.as_deref_mut() {
                    skipped.push(SkippedSqlSearchFile {
                        path: entry.path().to_string_lossy().into_owned(),
                        reason: "unreadable".to_string(),
                    });
                }
                continue;
            }
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
            let children = scan_sql_files_with_diagnostics(
                &path,
                depth + 1,
                visited,
                file_filter,
                include_empty_directories,
                skipped_files.as_deref_mut(),
            );
            if include_empty_directories || !children.is_empty() {
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
    include_empty_directories: Option<bool>,
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
        Ok(if include_empty_directories.unwrap_or(false) {
            scan_sql_files_with_directories(&path, 0, &mut visited, &file_filter, true)
        } else {
            scan_sql_files(&path, 0, &mut visited, &file_filter)
        })
    })
    .await
    .map_err(|e| format!("Failed to scan folder: {e}"))?
}

// Lowercasing can expand a character (for example, İ). Translate matching
// offsets back to the original text before computing editor positions.
fn original_search_range(text: &str, lower_start: usize, lower_end: usize) -> (usize, usize) {
    let mut lower_offset = 0;
    let mut original_start = None;
    for (offset, character) in text.char_indices() {
        let next_lower_offset = lower_offset + character.to_lowercase().map(char::len_utf8).sum::<usize>();
        if original_start.is_none() && next_lower_offset > lower_start {
            original_start = Some(offset);
        }
        if next_lower_offset >= lower_end {
            return (original_start.unwrap_or(offset), offset + character.len_utf8());
        }
        lower_offset = next_lower_offset;
    }
    (original_start.unwrap_or(text.len()), text.len())
}

fn search_context(text: &str, line_number: usize) -> Option<SqlFileSearchContext> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let end = text.char_indices().nth(MAX_SEARCH_LINE_CHARS).map_or(text.len(), |(offset, _)| offset);
    Some(SqlFileSearchContext {
        line_number,
        text: format!("{}{}", &text[..end], if end < text.len() { "..." } else { "" }),
    })
}

fn search_snippet(
    line: &str,
    query: &str,
    first_match: usize,
    first_match_end: usize,
) -> (String, Vec<SqlFileSearchSegment>) {
    let first_match_char = line[..first_match].chars().count();
    let start_char = first_match_char.saturating_sub(20);
    let start = line.char_indices().nth(start_char).map_or(line.len(), |(offset, _)| offset);
    let end = line[start..].char_indices().nth(MAX_SEARCH_LINE_CHARS).map_or(line.len(), |(offset, _)| start + offset);
    let snippet = &line[start..end];
    let lower = snippet.to_lowercase();
    let mut segments = Vec::new();
    if start > 0 {
        segments.push(SqlFileSearchSegment { text: "...".to_string(), matched: false });
    }
    let mut cursor = 0;
    let mut lower_cursor = 0;
    // A query itself can exceed the preview budget. Highlight the visible part
    // of its first match even though the clipped preview lacks the full query.
    if first_match_end > end {
        let match_start = first_match - start;
        if match_start > 0 {
            segments.push(SqlFileSearchSegment { text: snippet[..match_start].to_string(), matched: false });
        }
        segments.push(SqlFileSearchSegment { text: snippet[match_start..].to_string(), matched: true });
        cursor = snippet.len();
        lower_cursor = lower.len();
    }
    while let Some(relative_start) = lower[lower_cursor..].find(query) {
        let lower_start = lower_cursor + relative_start;
        let lower_end = lower_start + query.len();
        let (match_start, match_end) = original_search_range(snippet, lower_start, lower_end);
        if match_start > cursor {
            segments.push(SqlFileSearchSegment { text: snippet[cursor..match_start].to_string(), matched: false });
        }
        if match_end > cursor {
            segments.push(SqlFileSearchSegment {
                text: snippet[match_start.max(cursor)..match_end].to_string(),
                matched: true,
            });
            cursor = match_end;
        }
        lower_cursor = lower_end;
    }
    if cursor < snippet.len() {
        segments.push(SqlFileSearchSegment { text: snippet[cursor..].to_string(), matched: false });
    }
    if end < line.len() {
        segments.push(SqlFileSearchSegment { text: "...".to_string(), matched: false });
    }
    let line_text = segments.iter().map(|segment| segment.text.as_str()).collect::<String>();
    (line_text, segments)
}

fn search_sql_text(path: String, text: &str, query: &str, remaining_matches: &mut usize) -> SqlFileSearchFile {
    let mut result = SqlFileSearchFile { path, matches: Vec::new(), total_matches: 0 };
    let mut previous_line = None;
    let mut lines = text.split('\n').enumerate().peekable();
    while let Some((index, raw_line)) = lines.next() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(lower_start) = line.to_lowercase().find(query) {
            result.total_matches += 1;
            if result.matches.len() < MAX_SEARCH_FILE_MATCHES && *remaining_matches > 0 {
                let (start, end) = original_search_range(line, lower_start, lower_start + query.len());
                let (line_text, segments) = search_snippet(line, query, start, end);
                result.matches.push(SqlFileSearchMatch {
                    line_number: index + 1,
                    // CodeMirror/JavaScript positions count UTF-16 code units.
                    column: line[..start].encode_utf16().count() + 1,
                    line_text,
                    segments,
                    context_before: previous_line.and_then(|text| search_context(text, index)),
                    context_after: lines.peek().and_then(|(_, text)| search_context(text, index + 2)),
                });
                *remaining_matches -= 1;
            }
        }
        previous_line = Some(line);
    }
    result
}

fn read_sql_search_file(root: &Path, path: &Path) -> Result<String, &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "unreadable")?;
    if !metadata.file_type().is_file() {
        return Err("notRegularFile");
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "unreadable")?;
    if !canonical.starts_with(root) {
        return Err("outsideRoot");
    }
    let file = std::fs::File::open(&canonical).map_err(|_| "unreadable")?;
    let metadata = file.metadata().map_err(|_| "unreadable")?;
    if !metadata.is_file() {
        return Err("notRegularFile");
    }
    if metadata.len() > MAX_SEARCH_FILE_BYTES {
        return Err("tooLarge");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SEARCH_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "unreadable")?;
    if bytes.len() as u64 > MAX_SEARCH_FILE_BYTES {
        return Err("tooLarge");
    }
    decode_sql_file_bytes(&bytes).map_err(|_| "invalidEncoding")
}

fn search_sql_entries(
    entries: Vec<SqlFileEntry>,
    root: &Path,
    query: &str,
    visited_files: &mut HashSet<String>,
    remaining_matches: &mut usize,
    result: &mut SqlFileSearchResult,
) {
    for entry in entries {
        if entry.is_dir {
            search_sql_entries(entry.children, root, query, visited_files, remaining_matches, result);
            continue;
        }
        // Preserve the same display-path identities as the tree, including on
        // Windows. Overlapping roots must not consume the snippet budget twice.
        if !visited_files.insert(entry.path.clone()) {
            continue;
        }
        match read_sql_search_file(root, Path::new(&entry.path)) {
            Ok(text) => {
                let file = search_sql_text(entry.path, &text, query, remaining_matches);
                if file.total_matches > 0 {
                    result.truncated |= file.matches.len() < file.total_matches;
                    result.files.push(file);
                }
            }
            Err(reason) => {
                result.skipped_files.push(SkippedSqlSearchFile { path: entry.path, reason: reason.to_string() })
            }
        }
    }
}

#[tauri::command]
pub async fn search_sql_file_contents(
    roots: Vec<String>,
    file_filter: Option<String>,
    query: String,
) -> Result<SqlFileSearchResult, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() || roots.is_empty() {
        return Ok(SqlFileSearchResult::default());
    }
    let file_filter = compile_file_filter(file_filter.as_deref().unwrap_or(DEFAULT_FILE_FILTER))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = SqlFileSearchResult::default();
        let mut visited_files = HashSet::new();
        let mut remaining_matches = MAX_SEARCH_MATCHES;
        for root in roots {
            let canonical = match canonical_directory(Path::new(&root), "SQL root folder") {
                Ok(path) => path,
                _ => {
                    result.skipped_files.push(SkippedSqlSearchFile { path: root, reason: "unreadable".to_string() });
                    continue;
                }
            };
            let entries = scan_sql_files_with_diagnostics(
                Path::new(&root),
                0,
                &mut HashSet::new(),
                &file_filter,
                false,
                Some(&mut result.skipped_files),
            );
            // Even after the preview budget is exhausted, scan every candidate
            // so content-only files remain visible and line counts stay exact.
            search_sql_entries(entries, &canonical, &query, &mut visited_files, &mut remaining_matches, &mut result);
        }
        result
    })
    .await
    .map_err(|error| format!("Failed to search SQL files: {error}"))
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
        let file_name = validate_file_name(&file_name)?.to_owned();
        let display_path = renamed_sql_file_display_path(&file_path, &file_name)?;
        let file = managed_file(&root_path, &file_path)?;
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
        let file = managed_file(&root_path, &file_path)?;
        std::fs::remove_file(file).map_err(|error| format!("Failed to delete SQL file: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to delete SQL file: {error}"))?
}

#[tauri::command]
pub async fn create_sql_folder_in_folder(
    root_path: String,
    directory_path: String,
    folder_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder_name = validate_directory_name(&folder_name)?.to_owned();
        let directory = managed_directory(&root_path, &directory_path)?;
        let root = canonical_directory(Path::new(&root_path), "SQL root folder")?;
        if directory.strip_prefix(&root).map_err(|error| error.to_string())?.components().count() >= MAX_SCAN_DEPTH {
            return Err("The maximum SQL folder depth has been reached".to_string());
        }
        let path = directory.join(&folder_name);
        std::fs::create_dir(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "A file or folder with this name already exists".to_string()
            } else {
                format!("Failed to create SQL folder: {error}")
            }
        })?;
        Ok(Path::new(&directory_path).join(folder_name).to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Failed to create SQL folder: {error}"))?
}

#[tauri::command]
pub async fn rename_sql_folder_in_folder(
    root_path: String,
    folder_path: String,
    folder_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder_name = validate_directory_name(&folder_name)?.to_owned();
        let folder = managed_child_directory(&root_path, &folder_path)?;
        let parent = folder.parent().ok_or_else(|| "Failed to resolve SQL folder parent".to_string())?;
        let target = parent.join(&folder_name);
        // symlink_metadata also detects dangling links; never overwrite those.
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if target == folder {
                    return Ok(folder_path);
                }
                // Permit case-only renames on case-insensitive filesystems,
                // but never replace another directory or a symlink.
                if !metadata.file_type().is_dir() || std::fs::canonicalize(&target).ok().as_ref() != Some(&folder) {
                    return Err("A file or folder with this name already exists".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to inspect SQL folder target: {error}")),
        }
        std::fs::rename(&folder, &target).map_err(|error| format!("Failed to rename SQL folder: {error}"))?;
        let parent_display = Path::new(&folder_path).parent().map(Path::to_path_buf).unwrap_or_default();
        Ok(parent_display.join(folder_name).to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Failed to rename SQL folder: {error}"))?
}

#[tauri::command]
pub async fn delete_sql_folder_in_folder(root_path: String, folder_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = managed_child_directory(&root_path, &folder_path)?;
        std::fs::remove_dir_all(&folder).map_err(|error| format!("Failed to delete SQL folder: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to delete SQL folder: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_search_groups_matching_lines_and_uses_utf16_editor_columns() {
        let mut remaining = MAX_SEARCH_MATCHES;
        let result = search_sql_text(
            "query.sql".into(),
            "-- context\r\n😀İ needle needle\r\nSELECT 1",
            "needle",
            &mut remaining,
        );
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line_number, 2);
        assert_eq!(result.matches[0].column, 5);
        assert_eq!(result.matches[0].segments.iter().filter(|segment| segment.matched).count(), 2);
        assert_eq!(result.matches[0].context_before.as_ref().unwrap().line_number, 1);
        assert_eq!(result.matches[0].context_after.as_ref().unwrap().line_number, 3);

        let expanded_case = search_sql_text("query.sql".into(), "İ needle", "needle", &mut remaining);
        assert_eq!(expanded_case.matches[0].column, 3);
    }

    #[test]
    fn content_search_limits_previews_without_losing_counts_or_later_files() {
        let text = vec!["SELECT needle"; 150].join("\n");
        let mut remaining = MAX_SEARCH_FILE_MATCHES + 1;
        let first = search_sql_text("first.sql".into(), &text, "needle", &mut remaining);
        assert_eq!(first.total_matches, 150);
        assert_eq!(first.matches.len(), MAX_SEARCH_FILE_MATCHES);
        let second = search_sql_text("second.sql".into(), &text, "needle", &mut remaining);
        assert_eq!(second.total_matches, 150);
        assert_eq!(second.matches.len(), 1);
        let third = search_sql_text("third.sql".into(), &text, "needle", &mut remaining);
        assert_eq!(third.total_matches, 150);
        assert!(third.matches.is_empty());
    }

    #[test]
    fn content_search_centers_long_snippets_around_the_original_match() {
        let text = format!("{}needle trailing", "长".repeat(250));
        let mut remaining = MAX_SEARCH_MATCHES;
        let result = search_sql_text("query.sql".into(), &text, "needle", &mut remaining);
        let snippet = &result.matches[0];
        assert_eq!(snippet.column, 251);
        assert!(snippet.line_text.starts_with("..."));
        assert!(snippet.line_text.chars().count() <= MAX_SEARCH_LINE_CHARS + 6);
        assert_eq!(
            snippet
                .segments
                .iter()
                .filter(|segment| segment.matched)
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>(),
            vec!["needle"]
        );
    }

    #[tokio::test]
    async fn content_search_preserves_tree_filters_decoding_and_skipped_reasons() {
        let root = std::env::temp_dir().join(format!("dbx-sql-content-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.sql").unwrap();
        std::fs::write(root.join("README"), "请求方式").unwrap();
        std::fs::write(root.join(".hidden.sql"), "请求方式").unwrap();
        std::fs::write(root.join("ignored.txt"), "请求方式").unwrap();
        std::fs::write(root.join("node_modules/excluded.sql"), "请求方式").unwrap();
        let mut utf16 = vec![0xff, 0xfe];
        for unit in "请求方式".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(root.join("utf16.sql"), utf16).unwrap();
        std::fs::write(root.join("gbk.sql"), [0xc7, 0xeb, 0xc7, 0xf3, 0xb7, 0xbd, 0xca, 0xbd]).unwrap();
        std::fs::File::create(root.join("large.sql")).unwrap().set_len(MAX_SEARCH_FILE_BYTES + 1).unwrap();
        let root_string = root.to_string_lossy().into_owned();
        let result = search_sql_file_contents(
            vec![root_string.clone(), root_string],
            Some(r"(?i)(\.sql$|^README$)".into()),
            "请求方式".into(),
        )
        .await
        .unwrap();
        assert_eq!(result.files.len(), 4);
        assert!(result.files.iter().all(|file| file.total_matches == 1));
        assert_eq!(result.skipped_files.len(), 1);
        assert_eq!(result.skipped_files[0].reason, "tooLarge");
        assert!(!result.truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

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
        assert_eq!(validate_file_name("script.py").unwrap(), "script.py");
        assert_eq!(renamed_sql_file_display_path("draft.sql", "report.sql").unwrap(), "report.sql");
    }

    #[tokio::test]
    async fn renames_and_deletes_filtered_text_files_within_the_opened_root() {
        let root = std::env::temp_dir().join(format!("dbx-text-file-manage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("script.sh");
        std::fs::write(&source, "echo hello").unwrap();

        let renamed = rename_sql_file_in_folder(
            root.to_string_lossy().into_owned(),
            source.to_string_lossy().into_owned(),
            "script.py".to_string(),
        )
        .await
        .unwrap();
        assert!(Path::new(&renamed).is_file());

        delete_sql_file_in_folder(root.to_string_lossy().into_owned(), renamed.clone()).await.unwrap();
        assert!(!Path::new(&renamed).exists());
        std::fs::remove_dir_all(root).unwrap();
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
