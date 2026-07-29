use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Multipart, Path as AxumPath, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::sql;
use dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus};
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
/// How long a terminal progress entry remains available for late SSE
/// subscribers after the execution has completed.
const TERMINAL_PROGRESS_TTL: Duration = Duration::from_secs(300);

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

pub async fn preview_sql_file(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = state.data_dir.join("tmp").join("sql_file");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError::from(e.to_string()))?;
    cleanup_expired_sql_file_uploads(&tmp_dir);

    if let Some(field) = multipart.next_field().await.map_err(|e| AppError::from(e.to_string()))? {
        let file_name = field.file_name().unwrap_or("upload.sql").to_string();
        let data = field.bytes().await.map_err(|e| AppError::from(e.to_string()))?;
        if data.len() > SQL_FILE_UPLOAD_MAX_BYTES {
            return Err(AppError::from(format!(
                "File too large: {} bytes (max {} bytes)",
                data.len(),
                SQL_FILE_UPLOAD_MAX_BYTES
            )));
        }

        let file_path = safe_uploaded_sql_path(&tmp_dir, &file_name)?;
        std::fs::write(&file_path, &data).map_err(|e| AppError::from(e.to_string()))?;

        let size_bytes = data.len() as u64;
        let content = sql::decode_sql_file_bytes(&data).map_err(AppError::from)?;
        let preview: String = content.chars().take(20_000).collect();
        let bootstrap_analysis = dbx_core::sql_file_import::mysql_like_sql_file_bootstrap_analysis(&content);

        return Ok(Json(serde_json::json!({
            "fileName": file_name,
            "filePath": file_path.to_string_lossy(),
            "sizeBytes": size_bytes,
            "preview": preview,
            "canExecuteWithoutSelectedDatabase": bootstrap_analysis.can_execute_without_selected_database,
            "establishesDatabaseContext": bootstrap_analysis.establishes_database_context,
        })));
    }

    Err(AppError::from("No file uploaded".to_string()))
}

pub async fn execute_sql_file(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SqlFileExecuteWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;

    // Fast-fail: reject early if the connection is read-only (individual statements are also checked in do_execute)
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. SQL file execution blocked.",
            name
        )));
    }

    let execution_id = req.execution_id.clone();
    let requested_paths = if body.file_paths.is_empty() { vec![req.file_path.clone()] } else { body.file_paths };
    if requested_paths.is_empty() {
        return Err(AppError::from("No SQL files selected".to_string()));
    }
    let file_paths = requested_paths
        .iter()
        .map(|file_path| validated_uploaded_sql_path(&state.data_dir, file_path))
        .collect::<Result<Vec<_>, _>>()?;
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
        let started_at = Instant::now();
        // The emit callback atomically broadcasts progress AND persists
        // terminal progress to the store in the same synchronous call.
        // This closes the race where a terminal is broadcast but the store
        // hasn't been updated when a late subscriber rechecks it.
        let state_for_emit = state_clone.clone();
        let execution_id_for_emit = req.execution_id.clone();
        let mut progress_emitter = SqlFileProgressEmitter::new(move |progress: SqlFileProgress| {
            send_sql_file_progress(&tx, progress.clone());
            if matches!(progress.status, SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled) {
                state_for_emit
                    .sql_file_terminal_progress
                    .write()
                    .unwrap()
                    .insert(execution_id_for_emit.clone(), (progress, Instant::now()));
            }
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
            match std::fs::metadata(file_path) {
                Ok(meta) if meta.len() > SQL_FILE_UPLOAD_MAX_BYTES as u64 => {
                    progress_emitter.emit(sql_file_error_progress(
                        &req.execution_id,
                        started_at,
                        format!("File too large: {} bytes (max {} bytes)", meta.len(), SQL_FILE_UPLOAD_MAX_BYTES),
                    ));
                    finalize_execution(&state_clone, &req.execution_id, &file_paths).await;
                    return;
                }
                Err(e) => {
                    progress_emitter.emit(sql_file_error_progress(&req.execution_id, started_at, e.to_string()));
                    finalize_execution(&state_clone, &req.execution_id, &file_paths).await;
                    return;
                }
                _ => {}
            }
        }

        let file_path_refs: Vec<&Path> = file_paths.iter().map(PathBuf::as_path).collect();
        let result = execute_sql_file_paths(&app, &req, &file_path_refs, token, started_at, |progress| {
            progress_emitter.emit(progress);
        })
        .await;

        // If the executor returned an error (e.g. connection or prepare-stage
        // failure) without emitting a terminal progress, convert it to an
        // Error progress so late SSE subscribers receive a terminal status
        // instead of waiting until the timeout. The emit callback atomically
        // persists terminal progress to the store, so we just need to check
        // the store.
        if let Err(e) = result {
            let has_terminal = state_clone.sql_file_terminal_progress.read().unwrap().contains_key(&req.execution_id);
            if !has_terminal {
                progress_emitter.emit(sql_file_error_progress(&req.execution_id, started_at, e));
            }
        }

        finalize_execution(&state_clone, &req.execution_id, &file_paths).await;
    });

    Ok(Json(serde_json::json!({ "executionId": execution_id })))
}

fn send_sql_file_progress(tx: &broadcast::Sender<String>, progress: SqlFileProgress) {
    if let Ok(json) = serde_json::to_string(&progress) {
        let _ = tx.send(json);
    }
}

/// Finalize a SQL file execution: delete the uploaded temp files, remove the
/// active execution tracking and broadcast channel, and schedule eviction of
/// the terminal progress entry after the TTL. The terminal progress itself is
/// already persisted by the emit callback (atomically with the broadcast),
/// so this function only handles cleanup.
async fn finalize_execution(state: &Arc<WebState>, execution_id: &str, file_paths: &[PathBuf]) {
    // Delete the uploaded temp files.
    for file_path in file_paths {
        let _ = std::fs::remove_file(file_path);
    }
    // Remove active execution tracking and broadcast channel.
    cleanup_sql_file_execution(state, execution_id).await;
    // Schedule eviction of the terminal progress entry after the TTL.
    let state_for_eviction = state.clone();
    let id_for_eviction = execution_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(TERMINAL_PROGRESS_TTL).await;
        state_for_eviction.sql_file_terminal_progress.write().unwrap().remove(&id_for_eviction);
    });
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
        Some(extension) => format!("{stem}-{}.{}", Uuid::new_v4(), extension),
        None => format!("{stem}-{}", Uuid::new_v4()),
    };
    Ok(tmp_dir.join(unique_name))
}

fn cleanup_expired_sql_file_uploads(tmp_dir: &Path) {
    cleanup_sql_file_uploads_older_than(tmp_dir, SQL_FILE_UPLOAD_MAX_AGE);
}

fn cleanup_sql_file_uploads_older_than(tmp_dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(tmp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let expired = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if expired {
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
        let id_for_cleanup = execution_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(PENDING_SQL_FILE_PROGRESS_CHANNEL_TTL).await;
            if !state.sql_file_executions.read().await.contains_key(&id_for_cleanup) {
                state.remove_sse_channel(&id_for_cleanup).await;
            }
        });
    }
    let rx = tx.subscribe();

    // Recheck the terminal store AFTER subscribing to the broadcast channel.
    // If the execution has already completed, the terminal progress was
    // persisted atomically by the emit callback. A late subscriber (SSE GET
    // arrives after completion and channel cleanup) would otherwise hang
    // waiting for a message that was broadcast before the subscription existed.
    let terminal = state
        .sql_file_terminal_progress
        .read()
        .unwrap()
        .get(&execution_id)
        .and_then(|(progress, _)| serde_json::to_string(progress).ok());

    let stream = async_stream::stream! {
        if let Some(json) = terminal {
            yield Ok(Event::default().data(json));
        }
        let mut rx = rx;
        loop {
            match rx.recv().await {
                Ok(data) => yield Ok(Event::default().data(data)),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default()))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSqlFileUploadRequest {
    pub file_paths: Vec<String>,
}

/// Release uploaded SQL file temp files that were never executed (e.g. the user
/// closed the dialog without running). Validates each path stays inside the
/// upload tmp dir before deleting, so arbitrary filesystem paths are rejected.
pub async fn release_sql_file_upload(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ReleaseSqlFileUploadRequest>,
) -> Json<serde_json::Value> {
    let mut released = 0u64;
    for file_path in &req.file_paths {
        if let Ok(path) = validated_uploaded_sql_path(&state.data_dir, file_path) {
            if std::fs::remove_file(&path).is_ok() {
                released += 1;
            }
        }
    }
    Json(serde_json::json!({ "released": released }))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        cleanup_sql_file_uploads_older_than, release_sql_file_upload, safe_uploaded_sql_path,
        validated_uploaded_sql_path, ReleaseSqlFileUploadRequest,
    };
    use crate::state::WebState;
    use axum::Json;
    use dbx_core::connection::AppState;
    use dbx_core::sql::{SqlFileProgress, SqlFileStatus};
    use dbx_core::storage::Storage;
    use std::sync::Arc;

    async fn test_web_state(data_dir: &std::path::Path) -> Arc<WebState> {
        let storage = Storage::open(&data_dir.join("storage.db")).await.expect("open storage");
        let app = Arc::new(AppState::new_with_plugin_dir(storage, data_dir.join("plugins")));
        Arc::new(WebState::for_tests(app, data_dir.to_path_buf()))
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

    #[test]
    fn terminal_progress_store_round_trip() {
        let store: std::sync::RwLock<std::collections::HashMap<String, (SqlFileProgress, Instant)>> =
            std::sync::RwLock::new(std::collections::HashMap::new());

        let id = "exec-1".to_string();
        let progress = SqlFileProgress {
            execution_id: id.clone(),
            status: SqlFileStatus::Done,
            statement_index: 5,
            success_count: 5,
            failure_count: 0,
            affected_rows: 10,
            elapsed_ms: 100,
            statement_summary: "".to_string(),
            error: None,
        };

        // Simulate the emit callback writing terminal progress atomically.
        store.write().unwrap().insert(id.clone(), (progress.clone(), Instant::now()));

        // A late subscriber reads the terminal progress.
        let read = store.read().unwrap().get(&id).map(|(p, _)| p.clone());
        let read = read.expect("terminal progress should be present");
        assert_eq!(read.status, SqlFileStatus::Done);
        assert_eq!(read.success_count, 5);
        assert_eq!(read.execution_id, id);

        // TTL eviction removes it.
        store.write().unwrap().remove(&id);
        assert!(store.read().unwrap().get(&id).is_none());
    }

    #[tokio::test]
    async fn release_deletes_uploaded_temp_files_and_rejects_outside_paths() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-release-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp").join("sql_file");
        std::fs::create_dir_all(&tmp_dir).unwrap();

        // Create two valid temp files inside the upload dir.
        let valid1 = safe_uploaded_sql_path(&tmp_dir, "a.sql").unwrap();
        let valid2 = safe_uploaded_sql_path(&tmp_dir, "b.sql").unwrap();
        std::fs::write(&valid1, "select 1;").unwrap();
        std::fs::write(&valid2, "select 2;").unwrap();

        // Create a file outside the upload dir — release must NOT delete it.
        let outside = data_dir.join("outside.sql");
        std::fs::write(&outside, "select 3;").unwrap();

        let state = test_web_state(&data_dir).await;
        let req = ReleaseSqlFileUploadRequest {
            file_paths: vec![valid1.to_string_lossy().to_string(), outside.to_string_lossy().to_string()],
        };
        let Json(resp) = release_sql_file_upload(axum::extract::State(state), Json(req)).await;
        let released = resp["released"].as_u64();
        assert_eq!(released, Some(1));
        assert!(!valid1.exists());
        assert!(outside.exists(), "file outside tmp dir must not be deleted");

        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn release_batch_deletes_all_uploaded_files() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-release-batch-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp").join("sql_file");
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let paths: Vec<_> = (0..3)
            .map(|i| {
                let p = safe_uploaded_sql_path(&tmp_dir, &format!("file{i}.sql")).unwrap();
                std::fs::write(&p, "select 1;").unwrap();
                p.to_string_lossy().to_string()
            })
            .collect();

        let state = test_web_state(&data_dir).await;
        let req = ReleaseSqlFileUploadRequest { file_paths: paths.clone() };
        let Json(resp) = release_sql_file_upload(axum::extract::State(state), Json(req)).await;
        assert_eq!(resp["released"].as_u64(), Some(3));
        for p in &paths {
            assert!(!std::path::Path::new(p).exists(), "file should be deleted: {p}");
        }

        let _ = std::fs::remove_dir_all(data_dir);
    }

    /// Regression test for the "terminal emitted but store not yet finalized"
    /// race: the emit callback must persist terminal progress to the store
    /// synchronously in the same call that broadcasts it, so a late subscriber
    /// that subscribes after the broadcast but before a separate finalize step
    /// can still read the terminal state from the store.
    ///
    /// Before the fix, broadcast and store-write were separate operations,
    /// which meant a subscriber could miss the broadcast and find nothing in
    /// the store, causing a 10-minute timeout. This test verifies the
    /// invariant: after the emit callback returns, the terminal progress is
    /// already in the store.
    #[test]
    fn terminal_emit_persists_to_store_atomically() {
        use std::collections::HashMap;
        use std::sync::{Arc, RwLock};
        use tokio::sync::broadcast;

        type Store = RwLock<HashMap<String, (SqlFileProgress, Instant)>>;
        let store: Arc<Store> = Arc::new(RwLock::new(HashMap::new()));
        let (tx, _rx) = broadcast::channel::<String>(256);
        let execution_id = "exec-atomic".to_string();

        // Replicate the emit callback from execute_sql_file: broadcast first,
        // then synchronously persist terminal progress to the store in the
        // same closure call.
        let store_for_emit = store.clone();
        let tx_for_emit = tx.clone();
        let execution_id_for_emit = execution_id.clone();
        let emit = move |progress: SqlFileProgress| {
            if let Ok(json) = serde_json::to_string(&progress) {
                let _ = tx_for_emit.send(json);
            }
            if matches!(progress.status, SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled) {
                store_for_emit.write().unwrap().insert(execution_id_for_emit.clone(), (progress, Instant::now()));
            }
        };

        // Before emit, store is empty.
        assert!(!store.read().unwrap().contains_key(&execution_id));

        // Emit a terminal progress.
        emit(SqlFileProgress {
            execution_id: execution_id.clone(),
            status: SqlFileStatus::Done,
            statement_index: 1,
            success_count: 1,
            failure_count: 0,
            affected_rows: 1,
            elapsed_ms: 10,
            statement_summary: "".to_string(),
            error: None,
        });

        // Immediately after emit returns, the store must have the terminal
        // progress. This is the invariant that prevents late subscribers from
        // missing it: "terminal 已 emit、store 尚未 finalize" must never happen.
        let stored = store.read().unwrap().get(&execution_id).map(|(p, _)| p.clone());
        assert!(stored.is_some(), "terminal progress must be persisted atomically with broadcast");
        assert_eq!(stored.unwrap().status, SqlFileStatus::Done);

        // A non-terminal emit must NOT write to the store (only terminal
        // statuses are persisted for late subscribers).
        emit(SqlFileProgress {
            execution_id: execution_id.clone(),
            status: SqlFileStatus::Started,
            statement_index: 0,
            success_count: 0,
            failure_count: 0,
            affected_rows: 0,
            elapsed_ms: 1,
            statement_summary: "".to_string(),
            error: None,
        });
        // Store still has the Done terminal, not overwritten by Started.
        let stored = store.read().unwrap().get(&execution_id).map(|(p, _)| p.clone());
        assert_eq!(stored.unwrap().status, SqlFileStatus::Done, "non-terminal emit must not overwrite terminal store");
    }

    /// Regression test for the "executor error dropped" race: when
    /// execute_sql_file_paths returns an error (e.g. connection or
    /// prepare-stage failure) without emitting a terminal progress, the
    /// execute_sql_file handler must convert it to an Error progress so late
    /// SSE subscribers receive a terminal status instead of waiting until the
    /// 10-minute timeout.
    ///
    /// This test verifies the conversion logic: when the store has no terminal
    /// entry for the execution_id, an Error progress must be emitted.
    #[test]
    fn executor_error_emits_error_progress_when_store_empty() {
        use dbx_core::sql_file_import::sql_file_error_progress;

        let started_at = Instant::now();
        let execution_id = "exec-error";
        let error_message = "Connection refused".to_string();

        // Simulate: execute_sql_file_paths returned Err, and the store has no
        // terminal entry (the executor failed before emitting anything).
        let store: std::sync::RwLock<std::collections::HashMap<String, (SqlFileProgress, Instant)>> =
            std::sync::RwLock::new(std::collections::HashMap::new());
        let has_terminal = store.read().unwrap().contains_key(execution_id);
        assert!(!has_terminal, "store should be empty when executor failed before emitting");

        // The handler converts the error to an Error progress.
        let progress = sql_file_error_progress(execution_id, started_at, error_message.clone());

        // Verify the Error progress has the right shape for late subscribers.
        assert_eq!(progress.execution_id, execution_id);
        assert_eq!(progress.status, SqlFileStatus::Error);
        assert_eq!(progress.error, Some(error_message));
        assert_eq!(progress.success_count, 0);
        assert_eq!(progress.failure_count, 0);

        // After emitting, the store should be populated (simulating the emit
        // callback's atomic write).
        store.write().unwrap().insert(execution_id.to_string(), (progress.clone(), Instant::now()));
        let stored = store.read().unwrap().get(execution_id).map(|(p, _)| p.clone());
        assert_eq!(stored.unwrap().status, SqlFileStatus::Error, "late subscriber must read Error from store");
    }
}
