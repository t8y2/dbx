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
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

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

    let mut uploaded_file: Option<(String, Bytes)> = None;
    let mut source_format: Option<TableImportSourceFormat> = None;
    let mut parse_options = TableImportParseOptions::default();
    let mut preview_limit: Option<usize> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| AppError(e.to_string()))? {
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            let file_name = field.file_name().unwrap_or("upload.csv").to_string();
            let data = field.bytes().await.map_err(|e| AppError(e.to_string()))?;
            uploaded_file = Some((file_name, data));
        } else {
            let value = field.text().await.map_err(|e| AppError(e.to_string()))?;
            match name.as_str() {
                "sourceFormat" => {
                    source_format = Some(
                        serde_json::from_value(serde_json::Value::String(value))
                            .map_err(|e| AppError(e.to_string()))?,
                    );
                }
                "parseOptions" => {
                    parse_options = serde_json::from_str(&value).map_err(|e| AppError(e.to_string()))?;
                }
                "previewLimit" => {
                    preview_limit = value.parse::<usize>().ok();
                }
                _ => {}
            }
        }
    }

    if let Some((file_name, data)) = uploaded_file {
        if data.len() > 100 * 1024 * 1024 {
            return Err(AppError(format!("File too large: {} bytes (max {} bytes)", data.len(), 100 * 1024 * 1024)));
        }

        let source_ref = uuid::Uuid::new_v4().to_string();
        let file_path = safe_uploaded_import_path(&tmp_dir, &file_name, &source_ref)?;
        std::fs::write(&file_path, &data).map_err(|e| AppError(e.to_string()))?;

        let file_path_str = file_path.to_string_lossy().to_string();
        let preview = table_import::preview_table_import_file_with_request(TableImportPreviewRequest {
            file_path: file_path_str,
            source_ref: Some(source_ref),
            source_format,
            parse_options,
            preview_limit,
        })
        .await;
        let preview = preview.map_err(AppError)?;
        return Ok(Json(serde_json::to_value(preview).map_err(|e| AppError(e.to_string()))?));
    }

    Err(AppError("No file uploaded".to_string()))
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
