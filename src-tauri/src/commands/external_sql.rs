use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use dbx_core::sql::decode_sql_file_bytes;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

const MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn exceeds_external_sql_editor_limit(size_bytes: u64) -> bool {
    size_bytes > MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExternalSqlFileReadResult {
    Content { content: String, version: ExternalSqlFileVersion },
    TooLarge { size_bytes: u64, max_size_bytes: u64 },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSqlFileVersion {
    pub size_bytes: u64,
    pub modified_ns: String,
    pub content_hash: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExternalSqlFileStatus {
    Present { size_bytes: u64, modified_ns: String },
    Missing,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExternalSqlFileWriteResult {
    Written { version: ExternalSqlFileVersion },
    Conflict { current_version: ExternalSqlFileVersion },
    Missing,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSqlFileSaveResult {
    pub path: String,
    pub version: ExternalSqlFileVersion,
}
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn pending_open_sql_files(state: tauri::State<'_, ExternalSqlOpenState>) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut paths = sql_file_paths_from_args(std::env::args().skip(1), &cwd);
    paths.extend(state.drain());
    dedupe_paths(paths)
}

#[tauri::command]
pub async fn read_external_sql_file(path: String) -> Result<ExternalSqlFileReadResult, String> {
    read_external_sql_file_content_async(PathBuf::from(path)).await
}

#[tauri::command]
pub async fn inspect_external_sql_file(path: String) -> Result<ExternalSqlFileStatus, String> {
    inspect_external_sql_file_async(PathBuf::from(path)).await
}

#[tauri::command]
pub async fn write_external_sql_file(
    path: String,
    content: String,
    expected_content_hash: Option<String>,
    expected_missing: bool,
) -> Result<ExternalSqlFileWriteResult, String> {
    write_external_sql_file_checked_async(PathBuf::from(path), content, expected_content_hash, expected_missing, false)
        .await
}

#[tauri::command]
pub async fn save_external_sql_file(
    window: tauri::Window,
    default_file_name: String,
    content: String,
) -> Result<Option<ExternalSqlFileSaveResult>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.dialog().file().set_file_name(default_file_name).add_filter("SQL", &["sql"]).save_file(move |file_path| {
        let _ = sender.send(file_path);
    });
    let path = receiver
        .await
        .map_err(|_| "SQL save dialog closed unexpectedly".to_string())?
        .map(|file_path| file_path.into_path().map_err(|error| format!("Failed to resolve SQL file path: {error}")))
        .transpose()?;

    // Keep the native dialog result as a PathBuf until after the write so
    // Windows Unicode paths do not cross an extra frontend IPC boundary.
    save_external_sql_file_content_async(path, content).await
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

fn modified_ns(metadata: &std::fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
        .to_string()
}

fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn external_sql_file_version(metadata: &std::fs::Metadata, bytes: &[u8]) -> ExternalSqlFileVersion {
    ExternalSqlFileVersion {
        size_bytes: metadata.len(),
        modified_ns: modified_ns(metadata),
        content_hash: content_hash(bytes),
    }
}

#[cfg(test)]
fn read_external_sql_file_content(path: &Path) -> Result<ExternalSqlFileReadResult, String> {
    if !is_sql_file_path(path) {
        return Err("Only .sql files can be opened this way".to_string());
    }
    let metadata = std::fs::metadata(path).map_err(|e| format!("Failed to inspect SQL file: {e}"))?;
    if exceeds_external_sql_editor_limit(metadata.len()) {
        return Ok(ExternalSqlFileReadResult::TooLarge {
            size_bytes: metadata.len(),
            max_size_bytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
        });
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read SQL file: {e}"))?;
    let version = external_sql_file_version(&metadata, &bytes);
    decode_sql_file_bytes(&bytes).map(|content| ExternalSqlFileReadResult::Content { content, version })
}

async fn read_external_sql_file_content_async(path: PathBuf) -> Result<ExternalSqlFileReadResult, String> {
    if !is_sql_file_path(&path) {
        return Err("Only .sql files can be opened this way".to_string());
    }
    let file = tokio::fs::File::open(&path).await.map_err(|e| format!("Failed to read SQL file: {e}"))?;
    let metadata = file.metadata().await.map_err(|e| format!("Failed to inspect SQL file: {e}"))?;
    if exceeds_external_sql_editor_limit(metadata.len()) {
        return Ok(ExternalSqlFileReadResult::TooLarge {
            size_bytes: metadata.len(),
            max_size_bytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
        });
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("Failed to read SQL file: {e}"))?;
    if exceeds_external_sql_editor_limit(bytes.len() as u64) {
        return Ok(ExternalSqlFileReadResult::TooLarge {
            size_bytes: bytes.len() as u64,
            max_size_bytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
        });
    }
    let version = external_sql_file_version(&metadata, &bytes);
    decode_sql_file_bytes(&bytes).map(|content| ExternalSqlFileReadResult::Content { content, version })
}

async fn inspect_external_sql_file_async(path: PathBuf) -> Result<ExternalSqlFileStatus, String> {
    if !is_sql_file_path(&path) {
        return Err("Only .sql files can be inspected this way".to_string());
    }
    match tokio::fs::metadata(&path).await {
        Ok(metadata) => {
            Ok(ExternalSqlFileStatus::Present { size_bytes: metadata.len(), modified_ns: modified_ns(&metadata) })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ExternalSqlFileStatus::Missing),
        Err(error) => Err(format!("Failed to inspect SQL file: {error}")),
    }
}

#[cfg(test)]
fn write_external_sql_file_content(path: &Path, content: &str) -> Result<(), String> {
    if !is_sql_file_path(path) {
        return Err("Only .sql files can be saved this way".to_string());
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to save SQL file: {e}"))
}

async fn external_sql_file_version_async(path: &Path) -> Result<Option<ExternalSqlFileVersion>, String> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read SQL file before saving: {error}")),
    };
    let metadata =
        file.metadata().await.map_err(|error| format!("Failed to inspect SQL file before saving: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read =
            file.read(&mut buffer).await.map_err(|error| format!("Failed to read SQL file before saving: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(Some(ExternalSqlFileVersion {
        size_bytes: metadata.len(),
        modified_ns: modified_ns(&metadata),
        content_hash: format!("{:x}", digest.finalize()),
    }))
}

async fn write_external_sql_file_checked_async(
    path: PathBuf,
    content: String,
    expected_content_hash: Option<String>,
    expected_missing: bool,
    force: bool,
) -> Result<ExternalSqlFileWriteResult, String> {
    if !is_sql_file_path(&path) {
        return Err("Only .sql files can be saved this way".to_string());
    }

    if !force {
        match external_sql_file_version_async(&path).await? {
            Some(current_version) => {
                if expected_missing
                    || expected_content_hash.as_deref().is_some_and(|expected| expected != current_version.content_hash)
                {
                    return Ok(ExternalSqlFileWriteResult::Conflict { current_version });
                }
            }
            None if expected_content_hash.is_some() => return Ok(ExternalSqlFileWriteResult::Missing),
            None => {}
        }
    }

    let hash = content_hash(content.as_bytes());
    tokio::fs::write(&path, content).await.map_err(|error| format!("Failed to save SQL file: {error}"))?;
    let metadata =
        tokio::fs::metadata(&path).await.map_err(|error| format!("Failed to inspect saved SQL file: {error}"))?;
    Ok(ExternalSqlFileWriteResult::Written {
        version: ExternalSqlFileVersion {
            size_bytes: metadata.len(),
            modified_ns: modified_ns(&metadata),
            content_hash: hash,
        },
    })
}

async fn save_external_sql_file_content_async(
    path: Option<PathBuf>,
    content: String,
) -> Result<Option<ExternalSqlFileSaveResult>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let result = write_external_sql_file_checked_async(path.clone(), content, None, false, true).await?;
    let ExternalSqlFileWriteResult::Written { version } = result else {
        return Err("Failed to save SQL file".to_string());
    };
    Ok(Some(ExternalSqlFileSaveResult { path: path.to_string_lossy().into_owned(), version }))
}

#[cfg(test)]
fn save_external_sql_file_content(
    path: Option<&Path>,
    content: &str,
) -> Result<Option<ExternalSqlFileSaveResult>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    write_external_sql_file_content(path, content)?;
    let bytes = std::fs::read(path).map_err(|error| format!("Failed to read saved SQL file: {error}"))?;
    let metadata = std::fs::metadata(path).map_err(|error| format!("Failed to inspect saved SQL file: {error}"))?;
    Ok(Some(ExternalSqlFileSaveResult {
        path: path.to_string_lossy().into_owned(),
        version: external_sql_file_version(&metadata, &bytes),
    }))
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
        let ExternalSqlFileReadResult::Content { content, version } = result.unwrap() else {
            panic!("expected SQL file content");
        };
        assert_eq!(content, "select 1;");
        assert_eq!(version.size_bytes, 9);
        assert_eq!(version.content_hash, content_hash(b"select 1;"));
    }

    #[test]
    fn reads_gbk_external_sql_file_content() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"select '\xD6\xD0\xCE\xC4';").unwrap();

        let result = read_external_sql_file_content(&path);

        let _ = std::fs::remove_file(&path);
        let ExternalSqlFileReadResult::Content { content, version } = result.unwrap() else {
            panic!("expected SQL file content");
        };
        assert_eq!(content, "select '中文';");
        assert_eq!(version.content_hash, content_hash(b"select '\xD6\xD0\xCE\xC4';"));
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
    fn external_sql_editor_limit_is_inclusive() {
        assert!(!exceeds_external_sql_editor_limit(MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES));
        assert!(exceeds_external_sql_editor_limit(MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES + 1));
    }

    #[test]
    fn rejects_oversized_external_sql_before_reading_content() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        let file_size = MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES + 1;
        file.set_len(file_size).unwrap();

        let result = read_external_sql_file_content(&path);

        let _ = std::fs::remove_file(&path);
        assert_eq!(
            result.unwrap(),
            ExternalSqlFileReadResult::TooLarge {
                size_bytes: file_size,
                max_size_bytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
            }
        );
    }

    #[tokio::test]
    async fn rejects_oversized_external_sql_in_async_command_path() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        let file_size = MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES + 1;
        file.set_len(file_size).unwrap();

        let result = read_external_sql_file_content_async(path.clone()).await;

        let _ = std::fs::remove_file(&path);
        assert_eq!(
            result.unwrap(),
            ExternalSqlFileReadResult::TooLarge {
                size_bytes: file_size,
                max_size_bytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
            }
        );
    }

    #[test]
    fn serializes_external_sql_file_limit_for_frontend() {
        let result = ExternalSqlFileReadResult::TooLarge { size_bytes: 100, max_size_bytes: 64 };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "kind": "tooLarge", "sizeBytes": 100, "maxSizeBytes": 64 })
        );
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

    #[tokio::test]
    async fn inspects_present_and_missing_external_sql_files() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&path, "select 1;").unwrap();

        let present = inspect_external_sql_file_async(path.clone()).await.unwrap();
        assert!(matches!(present, ExternalSqlFileStatus::Present { size_bytes: 9, .. }));

        std::fs::remove_file(&path).unwrap();
        assert_eq!(inspect_external_sql_file_async(path).await.unwrap(), ExternalSqlFileStatus::Missing);
    }

    #[tokio::test]
    async fn checked_write_rejects_external_content_conflicts() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&path, "select 2;").unwrap();

        let result = write_external_sql_file_checked_async(
            path.clone(),
            "select 3;".to_string(),
            Some(content_hash(b"select 1;")),
            false,
            false,
        )
        .await
        .unwrap();

        assert!(matches!(result, ExternalSqlFileWriteResult::Conflict { .. }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "select 2;");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn checked_write_reports_missing_and_can_recreate_file() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));

        let missing = write_external_sql_file_checked_async(
            path.clone(),
            "select 2;".to_string(),
            Some(content_hash(b"select 1;")),
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(missing, ExternalSqlFileWriteResult::Missing);

        let recreated = write_external_sql_file_checked_async(path.clone(), "select 2;".to_string(), None, true, false)
            .await
            .unwrap();
        assert!(matches!(recreated, ExternalSqlFileWriteResult::Written { .. }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "select 2;");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn checked_write_does_not_overwrite_a_file_recreated_after_confirmation() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&path, "select external;").unwrap();

        let result =
            write_external_sql_file_checked_async(path.clone(), "select editor;".to_string(), None, true, false)
                .await
                .unwrap();

        assert!(matches!(result, ExternalSqlFileWriteResult::Conflict { .. }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "select external;");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn saves_external_sql_file_with_unicode_name() {
        let path = std::env::temp_dir().join(format!("查询-{}.sql", uuid::Uuid::new_v4()));

        let result = save_external_sql_file_content(Some(&path), "select 3;");

        let content = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(result.unwrap().unwrap().path, path.to_string_lossy());
        assert_eq!(content, "select 3;");
    }

    #[test]
    fn saves_external_sql_file_with_ascii_name() {
        let path = std::env::temp_dir().join(format!("query-{}.sql", uuid::Uuid::new_v4()));

        let result = save_external_sql_file_content(Some(&path), "select 4;");

        let _ = std::fs::remove_file(&path);
        assert_eq!(result.unwrap().unwrap().path, path.to_string_lossy());
    }

    #[test]
    fn cancelling_external_sql_file_save_does_not_write() {
        let result = save_external_sql_file_content(None, "select 5;");

        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn reports_external_sql_file_write_failure() {
        let directory = std::env::temp_dir().join(format!("dbx-missing-parent-{}", uuid::Uuid::new_v4()));
        let path = directory.join("query.sql");

        let result = save_external_sql_file_content(Some(&path), "select 6;");

        assert!(result.unwrap_err().contains("Failed to save SQL file"));
    }

    #[test]
    fn rejects_external_non_sql_file_save() {
        let path = std::env::temp_dir().join(format!("dbx-test-{}.txt", uuid::Uuid::new_v4()));

        let result = write_external_sql_file_content(&path, "select 2;");

        assert!(result.unwrap_err().contains(".sql"));
        assert!(!path.exists());
    }
}
