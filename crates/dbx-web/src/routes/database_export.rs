use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::Response;
use axum::Json;
use dbx_core::database_export::{self, DatabaseExportRequest, ExportProgress, ExportStatus};
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartExportRequest {
    pub request: DatabaseExportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelExportRequest {
    pub export_id: String,
}

pub async fn start_database_export(
    State(state): State<Arc<WebState>>,
    Json(body): Json<StartExportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut req = body.request;
    let export_id = req.export_id.clone();

    // Web mode: write to a server-side temp file instead of the client-supplied
    // path (which is a relative placeholder and would land in the server process
    // CWD, unreachable by the browser). The file is served back via the download
    // endpoint after the export completes.
    let tmp_dir = state.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError(e.to_string()))?;
    let tmp_file = tmp_dir.join(format!("database_export_{export_id}.sql"));
    let tmp_file_path = tmp_file.to_string_lossy().to_string();
    req.file_path = tmp_file_path.clone();

    let download_filename = format!("{}.sql", sanitize_export_filename(&req.database));

    // Store export file mapping for download
    state.export_files.write().await.insert(export_id.clone(), (tmp_file_path.clone(), download_filename));

    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state.sse_channels.write().await.insert(export_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_progress = cancelled.clone();

    tokio::spawn(async move {
        let result = database_export::export_database_sql_core(&app, &req, |progress| {
            if matches!(progress.status, ExportStatus::Cancelled) {
                cancelled_progress.store(true, Ordering::SeqCst);
            }
            if let Ok(json) = serde_json::to_string(&progress) {
                let _ = tx.send(json);
            }
        })
        .await;

        // `export_database_sql_core` signals cancellation either by emitting a
        // Cancelled progress and returning Ok(()), or by returning
        // Err("Export cancelled"). Treat both as cancellation.
        let is_cancelled =
            cancelled.load(Ordering::SeqCst) || result.as_ref().err().map(|e| e.contains("cancelled")).unwrap_or(false);

        match (&result, is_cancelled) {
            (_, true) => {
                // Cancelled: drop temp file + mapping, no Error progress.
                let _ = tokio::fs::remove_file(&req.file_path).await;
                state_clone.export_files.write().await.remove(&req.export_id);
            }
            (Err(e), false) => {
                let _ = tokio::fs::remove_file(&req.file_path).await;
                state_clone.export_files.write().await.remove(&req.export_id);
                let progress = ExportProgress {
                    export_id: req.export_id.clone(),
                    current_object: String::new(),
                    object_index: 0,
                    total_objects: 0,
                    rows_exported: 0,
                    total_rows: None,
                    status: ExportStatus::Error,
                    error: Some(e.clone()),
                };
                if let Ok(json) = serde_json::to_string(&progress) {
                    let _ = tx.send(json);
                }
            }
            (Ok(()), false) => {
                // Done: keep temp file + mapping for the download endpoint.
            }
        }

        database_export::clear_export_cancelled(&req.export_id).await;
        state_clone.remove_sse_channel(&req.export_id).await;
    });

    Ok(Json(serde_json::json!({ "exportId": export_id })))
}

/// Sanitize a database name into a safe download filename component, mirroring
/// the client-side `safeName` logic in DatabaseExportDialog.vue.
fn sanitize_export_filename(name: &str) -> String {
    let replaced = name.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let sanitized = replaced.trim();
    if sanitized.is_empty() {
        "database".to_string()
    } else {
        sanitized.to_string()
    }
}

pub async fn database_export_progress(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels.get(&export_id).ok_or_else(|| AppError("Export not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_database_export(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelExportRequest>,
) -> Json<serde_json::Value> {
    database_export::set_export_cancelled(&req.export_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

pub async fn database_export_download(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Response, AppError> {
    let (file_path, download_filename) = state
        .export_files
        .write()
        .await
        .remove(&export_id)
        .ok_or_else(|| AppError("Export file not found".to_string()))?;

    let data = tokio::fs::read(&file_path).await.map_err(|e| AppError(e.to_string()))?;
    // Clean up temp file
    let _ = tokio::fs::remove_file(&file_path).await;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/sql; charset=utf-8")
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{download_filename}\""))
        .body(Body::from(data))
        .map_err(|e| AppError(e.to_string()))
}
