use std::path::{Path as StdPath, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::body::Bytes;
use axum::extract::{Multipart, Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::table_import::{
    self, TableImportParseOptions, TableImportPreviewRequest, TableImportRequest, TableImportSourceFormat,
};
use dbx_core::transfer;
use futures::stream::Stream;
use futures::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::error::AppError;
use crate::state::WebState;

const MAX_IMPORT_UPLOAD_BYTES: usize = 100 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteImportWrapper {
    pub request: TableImportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelImportRequest {
    pub import_id: String,
}

pub async fn preview_import(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = import_upload_dir(&state.data_dir);
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError(e.to_string()))?;
    cleanup_expired_import_uploads(&tmp_dir, Duration::from_secs(24 * 60 * 60));

    let mut uploaded_file: Option<(String, PathBuf)> = None;
    let mut source_format: Option<TableImportSourceFormat> = None;
    let mut parse_options = TableImportParseOptions::default();
    let mut preview_limit: Option<usize> = None;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => {
                cleanup_pending_upload(&uploaded_file).await;
                return Err(AppError(error.to_string()));
            }
        };
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            if uploaded_file.is_some() {
                cleanup_pending_upload(&uploaded_file).await;
                return Err(AppError("Only one import file may be uploaded".to_string()));
            }
            let file_name = field.file_name().unwrap_or("upload.csv").to_string();
            let source_ref = uuid::Uuid::new_v4().to_string();
            let file_path = safe_uploaded_import_path(&tmp_dir, &file_name, &source_ref)?;
            if let Err(error) = write_import_upload(field, &file_path).await {
                cleanup_uploaded_import_path(&file_path).await;
                return Err(error);
            }
            uploaded_file = Some((source_ref, file_path));
        } else {
            let value = match field.text().await {
                Ok(value) => value,
                Err(error) => {
                    cleanup_pending_upload(&uploaded_file).await;
                    return Err(AppError(error.to_string()));
                }
            };
            match name.as_str() {
                "sourceFormat" => {
                    source_format = match serde_json::from_value(serde_json::Value::String(value)) {
                        Ok(source_format) => Some(source_format),
                        Err(error) => {
                            cleanup_pending_upload(&uploaded_file).await;
                            return Err(AppError(error.to_string()));
                        }
                    };
                }
                "parseOptions" => {
                    parse_options = match serde_json::from_str(&value) {
                        Ok(parse_options) => parse_options,
                        Err(error) => {
                            cleanup_pending_upload(&uploaded_file).await;
                            return Err(AppError(error.to_string()));
                        }
                    };
                }
                "previewLimit" => {
                    preview_limit = value.parse::<usize>().ok();
                }
                _ => {}
            }
        }
    }

    if let Some((source_ref, file_path)) = uploaded_file {
        let file_path_str = file_path.to_string_lossy().to_string();
        let preview = table_import::preview_table_import_file_with_request(TableImportPreviewRequest {
            file_path: file_path_str,
            source_ref: Some(source_ref),
            source_format,
            parse_options,
            preview_limit,
        })
        .await;
        let preview = match preview {
            Ok(preview) => preview,
            Err(error) => {
                cleanup_uploaded_import_path(&file_path).await;
                return Err(AppError(error));
            }
        };
        let preview = match serde_json::to_value(preview) {
            Ok(preview) => preview,
            Err(error) => {
                cleanup_uploaded_import_path(&file_path).await;
                return Err(AppError(error.to_string()));
            }
        };
        return Ok(Json(preview));
    }

    Err(AppError("No file uploaded".to_string()))
}

async fn write_import_upload(field: axum::extract::multipart::Field<'_>, file_path: &StdPath) -> Result<(), AppError> {
    write_import_upload_stream(field, file_path, MAX_IMPORT_UPLOAD_BYTES).await
}

async fn write_import_upload_stream<S, E>(
    mut chunks: S,
    file_path: &StdPath,
    max_upload_bytes: usize,
) -> Result<(), AppError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut upload = tokio::fs::File::create(file_path).await.map_err(|error| AppError(error.to_string()))?;
    let mut uploaded_bytes = 0usize;

    // Stream uploads to disk so valid large CSV files don't require a second full-size in-memory copy.
    let result = async {
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|error| AppError(error.to_string()))?;
            uploaded_bytes = uploaded_bytes.saturating_add(chunk.len());
            if uploaded_bytes > max_upload_bytes {
                return Err(AppError(format!(
                    "File too large: {uploaded_bytes} bytes received (max {max_upload_bytes} bytes)"
                )));
            }
            upload.write_all(&chunk).await.map_err(|error| AppError(error.to_string()))?;
        }
        upload.flush().await.map_err(|error| AppError(error.to_string()))
    }
    .await;
    drop(upload);

    if result.is_err() {
        cleanup_uploaded_import_path(file_path).await;
    }
    result
}

pub async fn execute_import(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ExecuteImportWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut req = body.request;
    let file_path = validated_uploaded_import_path(&state.data_dir, &req.file_path)?;
    req.file_path = file_path.to_string_lossy().to_string();

    // Reject import early if the connection is read-only
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.connection_id).await {
        cleanup_uploaded_import_source(&req.file_path).await;
        return Err(AppError(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. Import blocked.",
            name
        )));
    }

    let import_id = req.import_id.clone();

    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state.sse_channels.write().await.insert(import_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let db_type = match transfer::get_db_type(&app, &req.connection_id).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(
                    serde_json::json!({
                        "importId": req.import_id.clone(),
                        "status": "error",
                        "rowsImported": 0,
                        "totalRows": 0,
                        "error": e
                    })
                    .to_string(),
                );
                cleanup_uploaded_import_source(&req.file_path).await;
                state_clone.sse_channels.write().await.remove(&req.import_id);
                return;
            }
        };

        let pool_key = match app.get_or_create_pool(&req.connection_id, Some(&req.database)).await {
            Ok(k) => k,
            Err(e) => {
                let _ = tx.send(
                    serde_json::json!({
                        "importId": req.import_id.clone(),
                        "status": "error",
                        "rowsImported": 0,
                        "totalRows": 0,
                        "error": e
                    })
                    .to_string(),
                );
                cleanup_uploaded_import_source(&req.file_path).await;
                state_clone.sse_channels.write().await.remove(&req.import_id);
                return;
            }
        };

        let tx_clone = tx.clone();
        let import_id_for_cancel = req.import_id.clone();
        let result = table_import::import_table_file_core(
            &app,
            &req,
            &db_type,
            &pool_key,
            |id: &str| {
                let id = id.to_string();
                Box::pin(async move { transfer::is_cancelled(&id).await })
            },
            |progress| {
                if let Ok(json) = serde_json::to_string(&progress) {
                    let _ = tx_clone.send(json);
                }
            },
        )
        .await;

        match result {
            Ok(summary) => {
                if let Ok(json) = serde_json::to_string(&summary) {
                    let _ = tx.send(json);
                }
            }
            Err(e) => {
                let _ = tx.send(
                    serde_json::json!({
                        "importId": import_id_for_cancel,
                        "status": "error",
                        "rowsImported": 0,
                        "totalRows": 0,
                        "error": e
                    })
                    .to_string(),
                );
            }
        }

        cleanup_uploaded_import_source(&req.file_path).await;
        state_clone.sse_channels.write().await.remove(&req.import_id);
    });

    Ok(Json(serde_json::json!({ "importId": import_id })))
}

pub async fn import_progress(
    State(state): State<Arc<WebState>>,
    Path(import_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels.get(&import_id).ok_or_else(|| AppError("Import not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_import(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelImportRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.import_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

fn import_upload_dir(data_dir: &StdPath) -> PathBuf {
    data_dir.join("tmp").join("table_import")
}

fn safe_uploaded_import_path(tmp_dir: &StdPath, file_name: &str, source_ref: &str) -> Result<PathBuf, AppError> {
    let base_name = file_name.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or("upload.csv").trim();
    if base_name.is_empty() || base_name == "." || base_name == ".." {
        return Err(AppError("Invalid import file name".to_string()));
    }
    Ok(tmp_dir.join(format!("{source_ref}-{base_name}")))
}

fn validated_uploaded_import_path(data_dir: &StdPath, file_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err(AppError("Import source path must be absolute".to_string()));
    }

    let tmp_dir = import_upload_dir(data_dir).canonicalize().map_err(|e| AppError(e.to_string()))?;
    let canonical_path =
        path.canonicalize().map_err(|e| AppError(format!("Import source is no longer available: {e}")))?;
    if !canonical_path.starts_with(&tmp_dir) {
        return Err(AppError("Import source must be inside the uploaded import directory".to_string()));
    }
    Ok(canonical_path)
}

fn cleanup_expired_import_uploads(tmp_dir: &StdPath, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(tmp_dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now.duration_since(modified).map(|age| age > max_age).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

async fn cleanup_uploaded_import_source(file_path: &str) {
    let _ = tokio::fs::remove_file(file_path).await;
}

async fn cleanup_uploaded_import_path(file_path: &StdPath) {
    let _ = tokio::fs::remove_file(file_path).await;
}

async fn cleanup_pending_upload(uploaded_file: &Option<(String, PathBuf)>) {
    if let Some((_, file_path)) = uploaded_file {
        cleanup_uploaded_import_path(file_path).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    fn test_upload_path() -> PathBuf {
        std::env::temp_dir().join(format!("dbx-table-import-test-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn streams_import_upload_to_disk() {
        let file_path = test_upload_path();
        let chunks = stream::iter([Ok::<_, String>(Bytes::from_static(b"a,b\n")), Ok(Bytes::from_static(b"1,2\n"))]);

        assert!(write_import_upload_stream(chunks, &file_path, 8).await.is_ok());

        assert_eq!(tokio::fs::read(&file_path).await.unwrap(), b"a,b\n1,2\n");
        cleanup_uploaded_import_path(&file_path).await;
    }

    #[tokio::test]
    async fn removes_partial_upload_when_size_limit_is_exceeded() {
        let file_path = test_upload_path();
        let chunks = stream::iter([Ok::<_, String>(Bytes::from_static(b"1234")), Ok(Bytes::from_static(b"5"))]);

        let error = write_import_upload_stream(chunks, &file_path, 4).await.unwrap_err();

        assert!(error.0.contains("File too large"));
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn removes_partial_upload_when_stream_read_fails() {
        let file_path = test_upload_path();
        let chunks = stream::iter([Ok(Bytes::from_static(b"1234")), Err("multipart stream failed")]);

        let error = write_import_upload_stream(chunks, &file_path, 8).await.unwrap_err();

        assert_eq!(error.0, "multipart stream failed");
        assert!(!file_path.exists());
    }
}
