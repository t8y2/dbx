use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use axum::extract::{Multipart, Path as AxumPath, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::sql::{self, SqlFileProgress, SqlFileRequest, SqlFileStatus};
use dbx_core::sql_file_import::{
    execute_sql_file_paths, sql_file_error_progress, sql_file_progress as build_sql_file_progress,
    SqlFileProgressEmitter,
};
use futures::stream::Stream;
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::WebState;

const PENDING_SQL_FILE_PROGRESS_CHANNEL_TTL: Duration = Duration::from_secs(30);
const SQL_FILE_UPLOAD_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
pub const SQL_FILE_UPLOAD_MAX_BYTES: usize = 200 * 1024 * 1024;
const SQL_FILE_UPLOAD_MIN_BYTES: usize = 1024 * 1024;
const SQL_FILE_UPLOAD_MAX_BYTES_LIMIT: usize = 4096 * 1024 * 1024;

struct ManagedPreview {
    created: Instant,
    directory: Weak<tempfile::TempDir>,
    pending: Option<Arc<tempfile::TempDir>>,
}

#[derive(Default)]
pub struct ManagedSqlPreviews(Mutex<HashMap<String, ManagedPreview>>);

impl ManagedSqlPreviews {
    fn insert(&self, directory: tempfile::TempDir) -> String {
        let directory = Arc::new(directory);
        let token = directory.path().file_name().unwrap().to_string_lossy().into_owned();
        self.0.lock().unwrap().insert(
            token.clone(),
            ManagedPreview { created: Instant::now(), directory: Arc::downgrade(&directory), pending: Some(directory) },
        );
        token
    }

    fn release(&self, token: &str) {
        let mut entries = self.0.lock().unwrap();
        if entries.get(token).is_some_and(|entry| entry.pending.is_some()) {
            entries.remove(token);
        }
    }

    fn claim(&self, paths: &[PathBuf]) -> Result<Vec<Arc<tempfile::TempDir>>, AppError> {
        let mut entries = self.0.lock().unwrap();
        let mut tokens = HashSet::new();
        for path in paths {
            let Some(parent) = path.parent() else { continue };
            let Some(token) = parent.file_name().and_then(|name| name.to_str()) else { continue };
            if !token.starts_with("restore-") {
                continue;
            }
            let valid = entries
                .get(token)
                .and_then(|entry| entry.pending.as_ref())
                .is_some_and(|directory| directory.path().canonicalize().is_ok_and(|directory| directory == parent));
            if !valid {
                return Err(AppError::from("Backup preview expired or already consumed".to_string()));
            }
            tokens.insert(token.to_owned());
        }
        Ok(tokens.into_iter().map(|token| entries.get_mut(&token).unwrap().pending.take().unwrap()).collect())
    }

    fn cleanup(&self, tmp_dir: &Path, max_age: Duration, managed_only: bool) {
        let mut entries = self.0.lock().unwrap();
        for entry in entries.values_mut() {
            if entry.created.elapsed() >= max_age {
                entry.pending = None;
            }
        }
        entries.retain(|_, entry| entry.directory.strong_count() > 0);
        cleanup_sql_file_uploads_except(tmp_dir, max_age, &entries.keys().cloned().collect(), managed_only);
    }
}

pub fn start_sql_file_cleanup(state: &Arc<WebState>) {
    let state = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            let Some(state) = state.upgrade() else { break };
            state.managed_sql_previews.cleanup(&state.data_dir.join("tmp/sql_file"), SQL_FILE_UPLOAD_MAX_AGE, true);
            drop(state);
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSqlFilePreviewRequest {
    pub cleanup_token: String,
}

pub async fn release_sql_file_preview(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ReleaseSqlFilePreviewRequest>,
) -> Json<()> {
    state.managed_sql_previews.release(&body.cleanup_token);
    Json(())
}

pub(super) async fn prepare_backup_preview(state: &WebState, source: PathBuf) -> Result<serde_json::Value, AppError> {
    let tmp_dir = state.data_dir.join("tmp/sql_file");
    std::fs::create_dir_all(&tmp_dir).map_err(|error| AppError::from(error.to_string()))?;
    state.managed_sql_previews.cleanup(&tmp_dir, SQL_FILE_UPLOAD_MAX_AGE, true);
    let limit = sql_file_upload_limit(state).await as u64;
    let (directory, file_path, size) = tokio::task::spawn_blocking(move || {
        let directory = tempfile::Builder::new().prefix(&format!("restore-{}-", Uuid::new_v4())).tempdir_in(tmp_dir)?;
        let file_path =
            directory.path().join(source.file_name().ok_or_else(|| std::io::Error::other("Invalid backup name"))?);
        if std::fs::metadata(&source)?.len() > limit {
            return Err(std::io::Error::other("Backup exceeds the SQL file upload limit"));
        }
        let size = std::fs::copy(source, &file_path)?;
        if size > limit {
            return Err(std::io::Error::other("Backup exceeds the SQL file upload limit"));
        }
        Ok((directory, file_path, size))
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
    .map_err(|error: std::io::Error| AppError::from(error.to_string()))?;
    let file_name = file_path.file_name().unwrap().to_string_lossy();
    let mut preview = preview_uploaded_sql_file(&file_path, &file_name, size).await?;
    preview["cleanupToken"] = state.managed_sql_previews.insert(directory).into();
    Ok(preview)
}

pub fn sql_file_upload_max_bytes_from_value(value: Option<&str>) -> usize {
    let mb = value
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|mb| *mb > 0)
        .map(|mb| mb.saturating_mul(1024 * 1024))
        .unwrap_or(SQL_FILE_UPLOAD_MAX_BYTES);
    mb.clamp(SQL_FILE_UPLOAD_MIN_BYTES, SQL_FILE_UPLOAD_MAX_BYTES_LIMIT)
}

pub fn sql_file_upload_hard_cap_bytes() -> usize {
    SQL_FILE_UPLOAD_MAX_BYTES_LIMIT.saturating_add(1024 * 1024)
}

async fn sql_file_upload_limit(state: &WebState) -> usize {
    let max_mb = state
        .app
        .storage
        .load_sql_file_upload_max_mb()
        .await
        .unwrap_or(dbx_core::sql_file_import::DEFAULT_SQL_FILE_UPLOAD_MAX_MB);
    sql_file_upload_max_bytes_from_value(Some(&max_mb.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileExecuteWrapper {
    pub request: SqlFileRequest,
    #[serde(default)]
    pub file_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSqlFileRequest {
    pub execution_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectSqlFileTablesRequest {
    pub file_path: String,
}

pub async fn inspect_sql_file_tables(
    State(state): State<Arc<WebState>>,
    Json(body): Json<InspectSqlFileTablesRequest>,
) -> Result<Json<Vec<dbx_core::sql_file_import::SqlFileTable>>, AppError> {
    let path = validated_uploaded_sql_path(&state.data_dir, &body.file_path)?;
    Ok(Json(dbx_core::sql_file_import::inspect_sql_file_tables(&path).await.map_err(AppError::from)?))
}

pub async fn preview_sql_file(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = state.data_dir.join("tmp").join("sql_file");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError::from(e.to_string()))?;
    state.managed_sql_previews.cleanup(&tmp_dir, SQL_FILE_UPLOAD_MAX_AGE, false);

    if let Some(field) = multipart.next_field().await.map_err(|e| AppError::from(e.to_string()))? {
        let file_name = field.file_name().unwrap_or("upload.sql").to_string();
        let data = field.bytes().await.map_err(|e| AppError::from(e.to_string()))?;
        let upload_limit = sql_file_upload_limit(&state).await;
        if data.len() > upload_limit {
            return Err(AppError::from(format!("File too large: {} bytes (max {} bytes)", data.len(), upload_limit)));
        }

        let file_path = safe_uploaded_sql_path(&tmp_dir, &file_name)?;
        std::fs::write(&file_path, &data).map_err(|e| AppError::from(e.to_string()))?;

        return preview_uploaded_sql_file(&file_path, &file_name, data.len() as u64).await.map(Json);
    }

    Err(AppError::from("No file uploaded".to_string()))
}

async fn preview_uploaded_sql_file(
    file_path: &Path,
    file_name: &str,
    size_bytes: u64,
) -> Result<serde_json::Value, AppError> {
    let tmp_dir = file_path.parent().ok_or_else(|| AppError::from("Invalid SQL file path".to_string()))?;

    if file_name.to_ascii_lowercase().ends_with(".zip") {
        let extraction_dir = tmp_dir.join(format!("package-{}", Uuid::new_v4()));
        let package = dbx_core::sql_file_zip_package::extract_sql_file_zip_package(file_path, &extraction_dir)
            .map_err(AppError::from)?;
        let paths = dbx_core::sql_file_zip_package::extracted_sql_zip_paths(&extraction_dir, &package)
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let content = sql::decode_sql_file_bytes(&std::fs::read(&paths[0]).map_err(|e| AppError::from(e.to_string()))?)
            .map_err(AppError::from)?;
        let preview: String = content.chars().take(20_000).collect();
        let bootstrap_analysis = dbx_core::sql_file_import::mysql_like_sql_file_bootstrap_analysis(&content);
        return Ok(serde_json::json!({
            "fileName": file_name,
            "filePath": file_path.to_string_lossy(),
            "sizeBytes": size_bytes,
            "preview": preview,
            "canExecuteWithoutSelectedDatabase": bootstrap_analysis.can_execute_without_selected_database,
            "establishesDatabaseContext": bootstrap_analysis.establishes_database_context,
            "packageFilePaths": paths,
            "packagePartCount": package.part_names.len(),
        }));
    }

    let content =
        dbx_core::sql_file_import::read_sql_file_preview(file_path, 1_000_000).await.map_err(AppError::from)?;
    let preview: String = content.chars().take(20_000).collect();
    let bootstrap_analysis = dbx_core::sql_file_import::mysql_like_sql_file_bootstrap_analysis(&content);

    Ok(serde_json::json!({
        "fileName": file_name,
        "filePath": file_path.to_string_lossy(),
        "sizeBytes": size_bytes,
        "preview": preview,
        "canExecuteWithoutSelectedDatabase": bootstrap_analysis.can_execute_without_selected_database,
        "establishesDatabaseContext": bootstrap_analysis.establishes_database_context,
    }))
}

pub async fn execute_sql_file(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SqlFileExecuteWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;

    let requested_paths = if body.file_paths.is_empty() { vec![req.file_path.clone()] } else { body.file_paths };
    let file_paths = requested_paths
        .iter()
        .map(|file_path| validated_uploaded_sql_path(&state.data_dir, file_path))
        .collect::<Result<Vec<_>, _>>()?;
    let managed_previews = state.managed_sql_previews.claim(&file_paths)?;

    // Fast-fail: reject early if the connection is read-only (individual statements are also checked in do_execute)
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. SQL file execution blocked.",
            name
        )));
    }

    let execution_id = req.execution_id.clone();
    if requested_paths.is_empty() {
        return Err(AppError::from("No SQL files selected".to_string()));
    }
    let token = CancellationToken::new();

    {
        let mut executions = state.sql_file_executions.write().await;
        if executions.contains_key(&execution_id) {
            return Err(AppError::from(format!("SQL file execution '{execution_id}' already exists")));
        }
        executions.insert(execution_id.clone(), token.clone());
    }
    let tx = {
        let mut channels = state.sse_channels.write().await;
        channels.entry(execution_id.clone()).or_insert_with(|| tokio::sync::broadcast::channel::<String>(256).0).clone()
    };

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let _managed_previews = managed_previews;
        let started_at = std::time::Instant::now();
        let mut progress_emitter = SqlFileProgressEmitter::new(|progress| {
            send_sql_file_progress(&tx, progress);
        });
        progress_emitter.emit(build_sql_file_progress(
            &req.execution_id,
            SqlFileStatus::Started,
            0,
            0,
            0,
            0,
            started_at,
            "",
            None,
        ));
        for file_path in &file_paths {
            let upload_limit = sql_file_upload_limit(&state_clone).await;
            match std::fs::metadata(file_path) {
                Ok(meta) if meta.len() > upload_limit as u64 => {
                    progress_emitter.emit(sql_file_error_progress(
                        &req.execution_id,
                        started_at,
                        format!("File too large: {} bytes (max {} bytes)", meta.len(), upload_limit),
                    ));
                    cleanup_sql_file_execution(&state_clone, &req.execution_id).await;
                    return;
                }
                Err(e) => {
                    progress_emitter.emit(sql_file_error_progress(&req.execution_id, started_at, e.to_string()));
                    cleanup_sql_file_execution(&state_clone, &req.execution_id).await;
                    return;
                }
                _ => {}
            }
        }

        let file_path_refs: Vec<&Path> = file_paths.iter().map(PathBuf::as_path).collect();
        // The core executor emits exactly one terminal Error with the latest
        // cumulative counters before returning Err.
        let _ = execute_sql_file_paths(&app, &req, &file_path_refs, token, started_at, |progress| {
            progress_emitter.emit(progress);
        })
        .await;

        cleanup_sql_file_package_paths(&file_paths);
        cleanup_sql_file_execution(&state_clone, &req.execution_id).await;
    });

    Ok(Json(serde_json::json!({ "executionId": execution_id })))
}

fn send_sql_file_progress(tx: &broadcast::Sender<String>, progress: SqlFileProgress) {
    if let Ok(json) = serde_json::to_string(&progress) {
        let _ = tx.send(json);
    }
}

fn cleanup_sql_file_package_paths(file_paths: &[PathBuf]) {
    let mut directories = std::collections::HashSet::new();
    for path in file_paths {
        let Some(parent) = path.parent() else {
            continue;
        };
        if parent.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("package-")) {
            directories.insert(parent.to_path_buf());
        }
    }
    for directory in directories {
        let _ = std::fs::remove_dir_all(directory);
    }
}

async fn cleanup_sql_file_execution(state: &WebState, execution_id: &str) {
    state.remove_sse_channel(execution_id).await;
    state.sql_file_executions.write().await.remove(execution_id);
}

fn safe_uploaded_sql_path(tmp_dir: &Path, file_name: &str) -> Result<PathBuf, AppError> {
    let base_name = file_name.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or("upload.sql").trim();
    if base_name.is_empty() || base_name == "." || base_name == ".." {
        return Err(AppError::from("Invalid SQL file name".to_string()));
    }
    let file_name = Path::new(base_name);
    let stem = file_name.file_stem().and_then(|stem| stem.to_str()).filter(|stem| !stem.is_empty()).unwrap_or("upload");
    let extension =
        file_name.extension().and_then(|extension| extension.to_str()).filter(|extension| !extension.is_empty());
    let unique_name = match extension {
        Some(extension) if extension.eq_ignore_ascii_case("gz") && stem.to_ascii_lowercase().ends_with(".sql") => {
            format!("{}-{}.sql.gz", &stem[..stem.len() - 4], Uuid::new_v4())
        }
        Some(extension) => format!("{stem}-{}.{}", Uuid::new_v4(), extension),
        None => format!("{stem}-{}", Uuid::new_v4()),
    };
    Ok(tmp_dir.join(unique_name))
}

#[cfg(test)]
fn cleanup_sql_file_uploads_older_than(tmp_dir: &Path, max_age: Duration) {
    cleanup_sql_file_uploads_except(tmp_dir, max_age, &HashSet::new(), false);
}

fn cleanup_sql_file_uploads_except(tmp_dir: &Path, max_age: Duration, active: &HashSet<String>, managed_only: bool) {
    let Ok(entries) = std::fs::read_dir(tmp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if managed_only && !entry.file_name().to_string_lossy().starts_with("restore-") {
            continue;
        }
        if active.contains(&entry.file_name().to_string_lossy().into_owned()) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        // Extracted `package-*` directories count too: a preview that never reaches execution
        // leaves them behind, and they must expire with the uploaded files.
        let expired =
            metadata.modified().ok().and_then(|modified| modified.elapsed().ok()).is_some_and(|age| age >= max_age);
        if !expired {
            continue;
        }
        if metadata.is_dir() {
            let _ = std::fs::remove_dir_all(path);
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn validated_uploaded_sql_path(data_dir: &Path, file_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err(AppError::from("File path must be absolute".to_string()));
    }

    let tmp_dir = data_dir.join("tmp").canonicalize().map_err(|e| AppError::from(e.to_string()))?;
    let canonical_path = path.canonicalize().map_err(|e| AppError::from(e.to_string()))?;
    if !canonical_path.starts_with(&tmp_dir) {
        return Err(AppError::from("File path must be inside the uploaded SQL directory".to_string()));
    }
    Ok(canonical_path)
}

pub async fn sql_file_progress(
    State(state): State<Arc<WebState>>,
    AxumPath(execution_id): AxumPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    // The client subscribes before it sends the execution request. Creating the
    // channel on demand prevents that SSE connection from racing the POST and
    // guarantees it is subscribed before the background task emits `Started`.
    let (tx, created) = {
        let mut channels = state.sse_channels.write().await;
        let created = !channels.contains_key(&execution_id);
        let tx = channels
            .entry(execution_id.clone())
            .or_insert_with(|| tokio::sync::broadcast::channel::<String>(256).0)
            .clone();
        (tx, created)
    };
    if created {
        let state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(PENDING_SQL_FILE_PROGRESS_CHANNEL_TTL).await;
            if !state.sql_file_executions.read().await.contains_key(&execution_id) {
                state.remove_sse_channel(&execution_id).await;
            }
        });
    }
    let rx = tx.subscribe();
    Ok(crate::sse::sse_from_lossy_channel(rx))
}

pub async fn cancel_sql_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CancelSqlFileRequest>,
) -> Json<serde_json::Value> {
    let executions = state.sql_file_executions.read().await;
    if let Some(token) = executions.get(&req.execution_id) {
        token.cancel();
        Json(serde_json::json!({ "cancelled": true }))
    } else {
        Json(serde_json::json!({ "cancelled": false }))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    async fn restore_state(directory: &Path) -> WebState {
        let storage = dbx_core::persistence::test_storage::open(&directory.join("dbx.db")).await.unwrap();
        WebState::for_tests(Arc::new(dbx_core::connection::AppState::new(storage)), directory.to_path_buf())
    }

    #[tokio::test]
    async fn restored_preview_uses_a_managed_copy_and_release_cannot_remove_the_backup() {
        let directory = tempfile::tempdir().unwrap();
        let state = restore_state(directory.path()).await;
        let source = directory.path().join("backup.sql");
        std::fs::write(&source, "SELECT 1;").unwrap();
        let preview = prepare_backup_preview(&state, source.clone()).await.unwrap();
        assert_eq!(preview["fileName"], "backup.sql");
        assert_eq!(preview["preview"], "SELECT 1;");
        let copy = PathBuf::from(preview["filePath"].as_str().unwrap());
        assert!(copy.starts_with(directory.path().join("tmp/sql_file")));
        assert_ne!(copy, source);
        assert!(validated_uploaded_sql_path(directory.path(), copy.to_str().unwrap()).is_ok());
        state.managed_sql_previews.release(source.to_str().unwrap());
        assert!(source.exists());
        assert!(copy.exists());
        state.managed_sql_previews.release(preview["cleanupToken"].as_str().unwrap());
        state.managed_sql_previews.release(preview["cleanupToken"].as_str().unwrap());
        assert!(!copy.exists());
        assert_eq!(std::fs::read_to_string(source).unwrap(), "SELECT 1;");
    }

    #[tokio::test]
    async fn failed_backup_copy_and_gzip_preview_leave_no_managed_files() {
        let directory = tempfile::tempdir().unwrap();
        let state = restore_state(directory.path()).await;
        assert!(prepare_backup_preview(&state, directory.path().join("missing.sql")).await.is_err());
        let source = directory.path().join("invalid.sql.gz");
        std::fs::write(&source, "not gzip").unwrap();
        assert!(prepare_backup_preview(&state, source.clone()).await.is_err());
        let oversized = directory.path().join("oversized.sql");
        std::fs::File::create(&oversized).unwrap().set_len(sql_file_upload_limit(&state).await as u64 + 1).unwrap();
        assert!(prepare_backup_preview(&state, oversized.clone()).await.is_err());
        assert!(oversized.exists());
        assert_eq!(std::fs::read_dir(directory.path().join("tmp/sql_file")).unwrap().count(), 0);
        assert!(source.exists());
    }

    #[tokio::test]
    async fn consumed_preview_survives_release_and_expiry_until_execution_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let state = restore_state(directory.path()).await;
        let source = directory.path().join("backup.sql");
        std::fs::write(&source, "SELECT 1;").unwrap();
        let preview = prepare_backup_preview(&state, source.clone()).await.unwrap();
        let copy = PathBuf::from(preview["filePath"].as_str().unwrap());
        let paths = vec![copy.canonicalize().unwrap()];
        let execution = state.managed_sql_previews.claim(&paths).unwrap();
        assert!(state.managed_sql_previews.claim(&paths).is_err());
        state.managed_sql_previews.release(preview["cleanupToken"].as_str().unwrap());
        state.managed_sql_previews.cleanup(&directory.path().join("tmp/sql_file"), Duration::ZERO, true);
        assert!(copy.exists());
        drop(execution);
        assert!(!copy.exists());
        assert!(source.exists());
    }

    #[tokio::test]
    async fn expired_and_abandoned_previews_are_removed_without_touching_ordinary_uploads() {
        let directory = tempfile::tempdir().unwrap();
        let state = restore_state(directory.path()).await;
        let source = directory.path().join("backup.sql");
        std::fs::write(&source, "SELECT 1;").unwrap();
        let preview = prepare_backup_preview(&state, source.clone()).await.unwrap();
        let tmp = directory.path().join("tmp/sql_file");
        let abandoned = tmp.join("restore-abandoned");
        std::fs::create_dir(&abandoned).unwrap();
        std::fs::write(abandoned.join("backup.sql"), "SELECT 2;").unwrap();
        let upload = tmp.join("upload.sql");
        std::fs::write(&upload, "SELECT 3;").unwrap();
        state.managed_sql_previews.cleanup(&tmp, Duration::ZERO, true);
        assert!(!Path::new(preview["filePath"].as_str().unwrap()).exists());
        assert!(!abandoned.exists());
        assert!(upload.exists());
        assert!(source.exists());
    }

    #[tokio::test]
    async fn execution_failure_releases_the_managed_copy() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(restore_state(directory.path()).await);
        let source = directory.path().join("backup.sql");
        std::fs::write(&source, "SELECT 1;").unwrap();
        let preview = prepare_backup_preview(&state, source.clone()).await.unwrap();
        let copy = PathBuf::from(preview["filePath"].as_str().unwrap());
        let request = serde_json::from_value(serde_json::json!({
            "executionId": "restore-error", "connectionId": "missing", "database": "app",
            "filePath": copy, "continueOnError": false
        }))
        .unwrap();
        let response =
            execute_sql_file(State(state.clone()), Json(SqlFileExecuteWrapper { request, file_paths: vec![] }))
                .await
                .unwrap();
        assert_eq!(response.0["executionId"], "restore-error");
        tokio::time::timeout(Duration::from_secs(5), async {
            while copy.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(source.exists());
        assert!(!state.sql_file_executions.read().await.contains_key("restore-error"));
    }

    #[tokio::test]
    async fn duplicate_execution_releases_the_new_preview_without_cancelling_the_existing_job() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(restore_state(directory.path()).await);
        let source = directory.path().join("backup.sql");
        std::fs::write(&source, "SELECT 1;").unwrap();
        let preview = prepare_backup_preview(&state, source.clone()).await.unwrap();
        let copy = PathBuf::from(preview["filePath"].as_str().unwrap());
        let token = CancellationToken::new();
        state.sql_file_executions.write().await.insert("existing-job".into(), token.clone());
        let request = serde_json::from_value(serde_json::json!({
            "executionId": "existing-job", "connectionId": "missing", "database": "app",
            "filePath": copy, "continueOnError": false
        }))
        .unwrap();
        assert!(execute_sql_file(State(state.clone()), Json(SqlFileExecuteWrapper { request, file_paths: vec![] }))
            .await
            .is_err());
        assert!(!copy.exists());
        assert!(source.exists());
        assert!(!token.is_cancelled());
        assert!(state.sql_file_executions.read().await.contains_key("existing-job"));
    }

    #[test]
    fn sql_file_upload_limit_defaults_and_clamps() {
        assert_eq!(sql_file_upload_max_bytes_from_value(None), SQL_FILE_UPLOAD_MAX_BYTES);
        assert_eq!(sql_file_upload_max_bytes_from_value(Some("")), SQL_FILE_UPLOAD_MAX_BYTES);
        assert_eq!(sql_file_upload_max_bytes_from_value(Some("0")), SQL_FILE_UPLOAD_MAX_BYTES);
        assert_eq!(sql_file_upload_max_bytes_from_value(Some("512")), 512 * 1024 * 1024);
        assert_eq!(sql_file_upload_max_bytes_from_value(Some("1")), 1024 * 1024);
        assert_eq!(sql_file_upload_max_bytes_from_value(Some("99999")), 4096 * 1024 * 1024);
    }

    #[test]
    fn uploaded_sql_paths_are_unique_and_keep_the_extension() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp");

        let first = match safe_uploaded_sql_path(&tmp_dir, "../outside.sql") {
            Ok(path) => path,
            Err(error) => panic!("{}", error.message),
        };
        let second = match safe_uploaded_sql_path(&tmp_dir, "nested/outside.sql") {
            Ok(path) => path,
            Err(error) => panic!("{}", error.message),
        };

        assert!(first.starts_with(&tmp_dir));
        assert!(second.starts_with(&tmp_dir));
        assert_ne!(first, second);
        assert_eq!(first.extension().and_then(|extension| extension.to_str()), Some("sql"));
        let compressed = safe_uploaded_sql_path(&tmp_dir, "backup.sql.gz").unwrap();
        assert!(compressed.file_name().unwrap().to_string_lossy().ends_with(".sql.gz"));
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn execution_path_must_stay_inside_uploaded_tmp_dir() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let outside = data_dir.join("outside.sql");
        std::fs::write(&outside, "select 1;").unwrap();

        let result = validated_uploaded_sql_path(&data_dir, &outside.to_string_lossy());

        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn expired_sql_file_uploads_are_removed() {
        let tmp_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let upload = tmp_dir.join("upload.sql");
        std::fs::write(&upload, "select 1;").unwrap();

        cleanup_sql_file_uploads_older_than(&tmp_dir, Duration::ZERO);

        assert!(!upload.exists());
        let _ = std::fs::remove_dir_all(tmp_dir);
    }
}
