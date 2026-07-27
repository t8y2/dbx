use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

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
            match std::fs::metadata(file_path) {
                Ok(meta) if meta.len() > SQL_FILE_UPLOAD_MAX_BYTES as u64 => {
                    progress_emitter.emit(sql_file_error_progress(
                        &req.execution_id,
                        started_at,
                        format!("File too large: {} bytes (max {} bytes)", meta.len(), SQL_FILE_UPLOAD_MAX_BYTES),
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

        cleanup_sql_file_execution(&state_clone, &req.execution_id).await;
    });

    Ok(Json(serde_json::json!({ "executionId": execution_id })))
}

fn send_sql_file_progress(tx: &broadcast::Sender<String>, progress: SqlFileProgress) {
    if let Ok(json) = serde_json::to_string(&progress) {
        let _ = tx.send(json);
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

    use super::{cleanup_sql_file_uploads_older_than, safe_uploaded_sql_path, validated_uploaded_sql_path};

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
}
