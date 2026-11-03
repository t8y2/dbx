use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::Response;
use axum::Json;
use dbx_core::sql::{SqlFileEncoding, SqlFileProgress, SqlFileRequest, SqlFileStatus};
use dbx_core::sql_file_import::{
    execute_sql_file_paths, execute_sql_file_zip_package_paths, export_sql_file_failure_log as derive_failure_log_file,
    prune_sql_file_failure_logs, sql_file_error_progress, sql_file_failure_log_text as derive_failure_log_text,
    sql_file_progress as build_sql_file_progress, start_sql_file_failure_log, SqlFileFailureLogDeriveError,
    SqlFileFailureLogFileInfo, SqlFileFailureLogFormat, SqlFileFailureLogKey, SqlFileFailureLogMeta,
    SqlFileFailureLogRunCounters, SqlFileProgressEmitter, SQL_FILE_FAILURE_LOG_CLIPBOARD_MAX_BYTES,
    SQL_FILE_FAILURE_LOG_DIR,
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
/// Derived exports are streamed to the client and then swept by age: the log
/// itself stays in `sql-file-logs`, so these are disposable.
const SQL_FILE_FAILURE_LOG_EXPORT_DIR: &str = "tmp/sql-file-failure-logs";
const SQL_FILE_FAILURE_LOG_EXPORT_MAX_AGE: Duration = Duration::from_secs(60 * 60);

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
            sweep_failure_log_exports(&state.data_dir.join(SQL_FILE_FAILURE_LOG_EXPORT_DIR));
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
    #[serde(default)]
    pub encoding: SqlFileEncoding,
}

pub async fn inspect_sql_file_tables(
    State(state): State<Arc<WebState>>,
    Json(body): Json<InspectSqlFileTablesRequest>,
) -> Result<Json<Vec<dbx_core::sql_file_import::SqlFileTable>>, AppError> {
    let path = validated_uploaded_sql_path(&state.data_dir, &body.file_path)?;
    Ok(Json(
        dbx_core::sql_file_import::inspect_sql_file_tables_with_encoding(&path, body.encoding)
            .await
            .map_err(AppError::from)?,
    ))
}

#[derive(Deserialize, Default)]
pub struct SqlFilePreviewOptions {
    #[serde(default)]
    pub encoding: SqlFileEncoding,
}

pub async fn refresh_sql_file_preview(
    State(state): State<Arc<WebState>>,
    Json(body): Json<InspectSqlFileTablesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let path = validated_uploaded_sql_path(&state.data_dir, &body.file_path)?;
    let content = dbx_core::sql_file_import::read_sql_file_preview_with_encoding(&path, 1_000_000, body.encoding)
        .await
        .map_err(AppError::from)?;
    let analysis = dbx_core::sql_file_import::mysql_like_sql_file_bootstrap_analysis(&content);
    Ok(Json(serde_json::json!({
        "preview": content.chars().take(20_000).collect::<String>(),
        "canExecuteWithoutSelectedDatabase": analysis.can_execute_without_selected_database,
        "establishesDatabaseContext": analysis.establishes_database_context,
    })))
}

pub async fn preview_sql_file(
    State(state): State<Arc<WebState>>,
    Query(options): Query<SqlFilePreviewOptions>,
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

        return preview_uploaded_sql_file_with_encoding(&file_path, &file_name, data.len() as u64, options.encoding)
            .await
            .map(Json);
    }

    Err(AppError::from("No file uploaded".to_string()))
}

async fn preview_uploaded_sql_file(
    file_path: &Path,
    file_name: &str,
    size_bytes: u64,
) -> Result<serde_json::Value, AppError> {
    preview_uploaded_sql_file_with_encoding(file_path, file_name, size_bytes, SqlFileEncoding::Auto).await
}

async fn preview_uploaded_sql_file_with_encoding(
    file_path: &Path,
    file_name: &str,
    size_bytes: u64,
    encoding: SqlFileEncoding,
) -> Result<serde_json::Value, AppError> {
    let tmp_dir = file_path.parent().ok_or_else(|| AppError::from("Invalid SQL file path".to_string()))?;

    if file_name.to_ascii_lowercase().ends_with(".zip") {
        let extraction_dir = tmp_dir.join(format!(
            "{}{}",
            dbx_core::sql_file_zip_package::SQL_FILE_ZIP_EXTRACTION_DIR_PREFIX_WEB,
            Uuid::new_v4()
        ));
        let package = dbx_core::sql_file_zip_package::extract_sql_file_zip_package(file_path, &extraction_dir)
            .map_err(AppError::from)?;
        let paths = dbx_core::sql_file_zip_package::extracted_sql_zip_paths(&extraction_dir, &package)
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let content =
            dbx_core::sql_file_import::read_sql_file_preview_with_encoding(Path::new(&paths[0]), 1_000_000, encoding)
                .await
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

    let content = dbx_core::sql_file_import::read_sql_file_preview_with_encoding(file_path, 1_000_000, encoding)
        .await
        .map_err(AppError::from)?;
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
    headers: HeaderMap,
    Json(body): Json<SqlFileExecuteWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;
    if req.resolve_includes {
        return Err(AppError::from("Local SQL includes are only available in the desktop application".to_string()));
    }
    // The failure log of this run belongs to the session that started it: the
    // export/copy routes look it up by this owner, never by path (dbx#11619).
    let log_owner = crate::auth::session_token_from_headers(&headers)
        .ok_or_else(|| AppError::from("Not authenticated".to_string()))?;

    let requested_paths = if body.file_paths.is_empty() { vec![req.file_path.clone()] } else { body.file_paths };
    let file_paths = requested_paths
        .iter()
        .map(|file_path| validated_uploaded_sql_path(&state.data_dir, file_path))
        .collect::<Result<Vec<_>, _>>()?;
    let is_zip_package = execution_targets_zip_package(&file_paths);
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
        let mut failure_log = start_web_failure_log(&state_clone, &req, &file_paths).await;
        state_clone.sql_file_failure_logs.register(
            &log_owner,
            &req.execution_id,
            failure_log.path().map(Path::to_path_buf),
            failure_log.status_probe(),
        );
        let mut counters = SqlFileFailureLogRunCounters::default();
        let mut progress_emitter = SqlFileProgressEmitter::new(|progress| {
            // The sink only queues; the writer task owns the disk, so a failing
            // log can never break the import.
            counters.observe(&progress);
            failure_log.record(&progress);
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
        let _ = if is_zip_package {
            execute_sql_file_zip_package_paths(&app, &req, &file_path_refs, token, started_at, |progress| {
                progress_emitter.emit(progress);
            })
            .await
        } else {
            execute_sql_file_paths(&app, &req, &file_path_refs, token, started_at, |progress| {
                progress_emitter.emit(progress);
            })
            .await
        };

        failure_log.finish(counters.summary(started_at.elapsed().as_millis() as u64)).await;
        // Keep the log exportable, but let retention reclaim it once nothing writes.
        state_clone.sql_file_failure_logs.mark_finished(&log_owner, &req.execution_id);
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
        if dbx_core::sql_file_zip_package::is_extracted_sql_zip_package_path(
            path,
            dbx_core::sql_file_zip_package::SQL_FILE_ZIP_EXTRACTION_DIR_PREFIX_WEB,
        ) {
            directories.insert(path.parent().expect("checked by is_extracted_sql_zip_package_path").to_path_buf());
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

/// Owner-scoped lookup used by both failure-log routes. Kept as its own function
/// (rather than inlined) so the cross-session rejection is directly testable.
fn failure_log_path_for(
    registry: &dbx_core::sql_file_import::SqlFileFailureLogRegistry,
    owner: &str,
    execution_id: &str,
) -> Result<PathBuf, AppError> {
    if let Some(path) = registry.path(owner, execution_id) {
        return Ok(path);
    }
    // Say why: a log can be missing because it never existed, or because
    // retention (or the user) removed the file after the run finished.
    let reason = registry.info(owner, execution_id).and_then(|info| info.reason);
    Err(AppError::from(match reason {
        Some(reason) => format!("No failure log to export for this execution: {reason}"),
        None => "No failure log to export for this execution".to_string(),
    }))
}

/// Creates the failure log of one Web execution. Retention runs first, with every
/// registered log protected so a parallel import cannot delete an in-progress one.
async fn start_web_failure_log(
    state: &WebState,
    request: &SqlFileRequest,
    file_paths: &[PathBuf],
) -> dbx_core::sql_file_import::SqlFileFailureLogHandle {
    if !request.failure_log_enabled {
        return dbx_core::sql_file_import::SqlFileFailureLogHandle::unavailable(
            "Failure log disabled for this execution".to_string(),
        );
    }
    let log_dir = state.data_dir.join(SQL_FILE_FAILURE_LOG_DIR);
    let protected = state.sql_file_failure_logs.active_paths();
    if let Err(error) = prune_sql_file_failure_logs(&log_dir, &protected) {
        log::warn!("Failed to prune SQL file failure logs: {error}");
    }
    let connection_name = state.app.configs.read().await.get(&request.connection_id).map(|config| config.name.clone());
    let mut files = Vec::with_capacity(file_paths.len());
    for (index, file_path) in file_paths.iter().enumerate() {
        let size_bytes = tokio::fs::metadata(file_path).await.ok().map(|metadata| metadata.len());
        let name = file_path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        files.push(SqlFileFailureLogFileInfo {
            index,
            name,
            path: file_path.to_string_lossy().to_string(),
            size_bytes,
        });
    }
    let meta = SqlFileFailureLogMeta {
        execution_id: request.execution_id.clone(),
        connection_id: request.connection_id.clone(),
        connection_name,
        database: request.database.clone(),
        schema: request.schema.clone(),
        files,
        limits: Default::default(),
    };
    start_sql_file_failure_log(&log_dir, meta).await
}

/// Derived TXT/CSV files are served once and re-creatable, so they are swept by
/// age instead of tracked.
fn sweep_failure_log_exports(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let expired = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= SQL_FILE_FAILURE_LOG_EXPORT_MAX_AGE);
        if expired {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Status of one execution's failure log, so the Web UI can show the same
/// `degraded`/`unavailable` states as the desktop. The server-side path is
/// deliberately omitted here: a browser has no use for it and it would leak the
/// server's filesystem layout.
pub async fn sql_file_failure_log_info(
    State(state): State<Arc<WebState>>,
    AxumPath(execution_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<Option<serde_json::Value>>, AppError> {
    let owner = crate::auth::session_token_from_headers(&headers)
        .ok_or_else(|| AppError::from("Not authenticated".to_string()))?;
    let info = state.sql_file_failure_logs.info(&owner, &execution_id);
    Ok(Json(info.map(|info| {
        serde_json::json!({
            "status": info.status.as_str(),
            "reason": info.reason,
        })
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogDownloadQuery {
    #[serde(default)]
    pub format: Option<String>,
}

/// Streams the full failure log as an attachment. Owner-scoped: the execution id
/// alone never grants access, and no path is accepted from the client.
pub async fn sql_file_failure_log_download(
    State(state): State<Arc<WebState>>,
    AxumPath(execution_id): AxumPath<String>,
    Query(query): Query<SqlFileFailureLogDownloadQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let owner = crate::auth::session_token_from_headers(&headers)
        .ok_or_else(|| AppError::from("Not authenticated".to_string()))?;
    let format = match query.format.as_deref() {
        Some(value) => SqlFileFailureLogFormat::parse(value)
            .ok_or_else(|| AppError::from(format!("Unsupported log format: {value}")))?,
        None => SqlFileFailureLogFormat::Txt,
    };
    let log_path = failure_log_path_for(&state.sql_file_failure_logs, &owner, &execution_id)?;

    let export_dir = state.data_dir.join(SQL_FILE_FAILURE_LOG_EXPORT_DIR);
    tokio::fs::create_dir_all(&export_dir).await.map_err(|error| AppError::from(error.to_string()))?;
    let export_path = export_dir.join(format!("{}.{}", Uuid::new_v4(), format.extension()));
    let destination = export_path.clone();
    tokio::task::spawn_blocking(move || derive_failure_log_file(&log_path, &destination, format, None))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
        .map_err(|error| AppError::from(error.to_string()))?;

    let file = tokio::fs::File::open(&export_path).await.map_err(|error| AppError::from(error.to_string()))?;
    let content_type = match format {
        SqlFileFailureLogFormat::Txt => "text/plain; charset=utf-8",
        SqlFileFailureLogFormat::Csv => "text/csv; charset=utf-8",
    };
    let file_name = format!("sql-file-failures.{}", format.extension());
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, super::export_download::attachment_content_disposition(&file_name))
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))
        .map_err(|error| AppError::from(error.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogTextRequest {
    pub execution_id: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub keys: Option<Vec<SqlFileFailureLogKey>>,
}

/// Derived text for the clipboard, capped like the desktop command. Being over
/// the cap is a normal outcome (the UI suggests the file export), not an error.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogTextResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub too_large: bool,
    pub limit_bytes: u64,
}

pub async fn sql_file_failure_log_text(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<SqlFileFailureLogTextRequest>,
) -> Result<Json<SqlFileFailureLogTextResponse>, AppError> {
    let owner = crate::auth::session_token_from_headers(&headers)
        .ok_or_else(|| AppError::from("Not authenticated".to_string()))?;
    let format = match body.format.as_deref() {
        Some(value) => SqlFileFailureLogFormat::parse(value)
            .ok_or_else(|| AppError::from(format!("Unsupported log format: {value}")))?,
        None => SqlFileFailureLogFormat::Txt,
    };
    let log_path = failure_log_path_for(&state.sql_file_failure_logs, &owner, &body.execution_id)?;
    let selection = body.keys.filter(|keys| !keys.is_empty()).map(|keys| keys.into_iter().collect());
    let limit = SQL_FILE_FAILURE_LOG_CLIPBOARD_MAX_BYTES;
    let derived =
        tokio::task::spawn_blocking(move || derive_failure_log_text(&log_path, format, selection.as_ref(), limit))
            .await
            .map_err(|error| AppError::from(error.to_string()))?;
    match derived {
        Ok(text) => Ok(Json(SqlFileFailureLogTextResponse { text: Some(text), too_large: false, limit_bytes: limit })),
        Err(SqlFileFailureLogDeriveError::TooLarge { limit }) => {
            Ok(Json(SqlFileFailureLogTextResponse { text: None, too_large: true, limit_bytes: limit }))
        }
        Err(error) => Err(AppError::from(error.to_string())),
    }
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

/// The frontend always sends the extracted `.sql` part paths as the execution
/// paths for a ZIP upload, never the original `.zip` path (that stays only in
/// `SqlFileRequest::file_path`), so routing to the ZIP-package incremental
/// -flush importer must be derived from those actual execution paths, not
/// from `req.file_path`'s extension. Web only ever extracts under the
/// `package-` prefix, and every path reaching here has already passed
/// `validated_uploaded_sql_path`, which confines it to the managed upload
/// tmp dir.
fn execution_targets_zip_package(file_paths: &[PathBuf]) -> bool {
    file_paths.iter().any(|path| {
        dbx_core::sql_file_zip_package::is_extracted_sql_zip_package_path(
            path,
            dbx_core::sql_file_zip_package::SQL_FILE_ZIP_EXTRACTION_DIR_PREFIX_WEB,
        )
    })
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

    /// The execution route now takes the session that owns the failure log, so
    /// these tests authenticate the same way the Web client does: a session that
    /// exists in `WebState::sessions` plus its `dbx_session` cookie.
    async fn authenticated_state(state: &WebState, token: &str) -> HeaderMap {
        state.sessions.write().await.insert(token.to_string());
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("dbx_session={token}").parse().unwrap());
        headers
    }

    async fn restore_state(directory: &Path) -> WebState {
        let storage = dbx_core::persistence::test_storage::open(&directory.join("dbx.db")).await.unwrap();
        WebState::for_tests(Arc::new(dbx_core::connection::AppState::new(storage)), directory.to_path_buf())
    }

    #[tokio::test]
    async fn web_execution_rejects_local_includes_before_reading_any_path() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(restore_state(directory.path()).await);
        let request = serde_json::from_value(serde_json::json!({
            "executionId": "includes", "connectionId": "missing", "database": "app",
            "filePath": "/not-an-upload/main.sql", "continueOnError": false, "resolveIncludes": true
        }))
        .unwrap();
        let error = execute_sql_file(
            State(state.clone()),
            HeaderMap::new(),
            Json(SqlFileExecuteWrapper { request, file_paths: vec![] }),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains("only available in the desktop"));
        assert!(state.sql_file_executions.read().await.is_empty());
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
        let headers = authenticated_state(&state, "session-restore").await;
        let response = execute_sql_file(
            State(state.clone()),
            headers,
            Json(SqlFileExecuteWrapper { request, file_paths: vec![] }),
        )
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
        let headers = authenticated_state(&state, "session-existing").await;
        assert!(execute_sql_file(
            State(state.clone()),
            headers,
            Json(SqlFileExecuteWrapper { request, file_paths: vec![] })
        )
        .await
        .is_err());
        assert!(!copy.exists());
        assert!(source.exists());
        assert!(!token.is_cancelled());
        assert!(state.sql_file_executions.read().await.contains_key("existing-job"));
    }

    #[test]
    fn zip_package_routing_is_selected_from_extracted_part_paths_not_the_original_zip_name() {
        // Regression for PR #10632 review: the frontend sends the extracted
        // `.sql` part paths as execution paths, never the original `.zip`
        // upload path, so routing must key off the actual paths, not
        // `req.file_path`'s extension.
        let zip_upload_part_paths = vec![
            PathBuf::from("/data/tmp/sql_file/package-11111111-1111-1111-1111-111111111111/00001-dump.sql"),
            PathBuf::from("/data/tmp/sql_file/package-11111111-1111-1111-1111-111111111111/00002-dump.sql"),
        ];
        assert!(execution_targets_zip_package(&zip_upload_part_paths));

        let ordinary_upload_paths = vec![PathBuf::from("/data/tmp/sql_file/upload-22222222.sql")];
        assert!(!execution_targets_zip_package(&ordinary_upload_paths));

        // A single-file (non-multi-file) request always executes exactly the
        // `req.file_path` value as its only path, so this also exercises the
        // no-`file_paths`-supplied call shape from `execute_sql_file`.
        let single_zip_part_as_sole_path = vec![PathBuf::from("/data/tmp/sql_file/package-33333333/00001-dump.sql")];
        assert!(execution_targets_zip_package(&single_zip_part_as_sole_path));

        // Desktop extraction dirs (`dbx-sql-package-`, under the OS temp dir)
        // are not this site's to match: web only ever extracts `package-*`
        // dirs, and the generic name must not pull user directories into the
        // ZIP importer or its cleanup.
        let desktop_style_paths = vec![PathBuf::from("/tmp/dbx-sql-package-44444444/00001-dump.sql")];
        assert!(!execution_targets_zip_package(&desktop_style_paths));
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

#[cfg(test)]
mod failure_log_route_tests {
    use super::*;
    use dbx_core::sql_file_import::{SqlFileFailureLogHandle, SqlFileFailureLogRegistry};
    use std::path::PathBuf;

    /// The registry reports a log whose file is gone as unavailable, so these
    /// fixtures must point at a file that really exists.
    fn registry_with_log(dir: &Path, owner: &str, execution_id: &str) -> (SqlFileFailureLogRegistry, PathBuf) {
        let path = dir.join(format!("{execution_id}.jsonl"));
        std::fs::write(
            &path, b"{}
",
        )
        .unwrap();
        let registry = SqlFileFailureLogRegistry::new();
        let handle = SqlFileFailureLogHandle::unavailable("test".to_string());
        registry.register(owner, execution_id, Some(path.clone()), handle.status_probe());
        (registry, path)
    }

    #[test]
    fn failure_log_lookup_serves_the_owning_session_only() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, path) = registry_with_log(dir.path(), "session-a", "exec-1");

        assert_eq!(failure_log_path_for(&registry, "session-a", "exec-1").unwrap(), path);
        // A session that guesses another session's execution id gets nothing.
        assert!(failure_log_path_for(&registry, "session-b", "exec-1").is_err());
        // So does an unknown execution id for the owning session.
        assert!(failure_log_path_for(&registry, "session-a", "exec-2").is_err());
    }

    #[test]
    fn failure_log_lookup_explains_a_log_whose_file_disappeared() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exec.jsonl");
        std::fs::write(
            &path, b"{}
",
        )
        .unwrap();
        let registry = SqlFileFailureLogRegistry::new();
        let handle = SqlFileFailureLogHandle::unavailable("test".to_string());
        registry.register("session-a", "exec-1", Some(path.clone()), handle.status_probe());
        assert!(failure_log_path_for(&registry, "session-a", "exec-1").is_ok());

        // Retention prunes a finished log: the route must say so instead of
        // streaming a path that no longer resolves.
        std::fs::remove_file(&path).unwrap();
        let error = failure_log_path_for(&registry, "session-a", "exec-1").unwrap_err();
        assert!(error.message.contains("no longer exists"), "got: {}", error.message);
    }

    #[test]
    fn failure_log_lookup_rejects_a_log_without_a_file() {
        let registry = SqlFileFailureLogRegistry::new();
        let handle = SqlFileFailureLogHandle::unavailable("no file".to_string());
        registry.register("session-a", "exec-1", None, handle.status_probe());

        // An unavailable log has no path to export; the route must fail rather
        // than stream something that does not exist.
        assert!(failure_log_path_for(&registry, "session-a", "exec-1").is_err());
    }
}
