use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Response, Sse};
use axum::Json;
use dbx_core::table_export::{self, TableExportProgress, TableExportRequest};
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartExportRequest {
    pub request: TableExportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelExportRequest {
    pub export_id: String,
}

pub async fn start_table_export(
    State(state): State<Arc<WebState>>,
    Json(body): Json<StartExportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut req = body.request;
    let export_id = req.export_id.clone();

    // Generate temp file path for web export output
    let tmp_dir = state.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError(e.to_string()))?;
    let ext = match req.format.as_str() {
        "csv" => "csv",
        "xlsx" => "xlsx",
        _ => return Err(AppError(format!("Unsupported export format: {}", req.format))),
    };
    let tmp_file = tmp_dir.join(format!("table_export_{export_id}.{ext}"));
    let file_path = tmp_file.to_string_lossy().to_string();
    req.file_path = file_path.clone();

    // Store export file mapping for download
    state.export_files.write().await.insert(export_id.clone(), (file_path, req.format.clone()));

    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state.sse_channels.write().await.insert(export_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let result = table_export::export_table_data_core(&app, &req, |progress| {
            if let Ok(json) = serde_json::to_string(&progress) {
                let _ = tx.send(json);
            }
        })
        .await;

        if let Err(e) = result {
            // Remove the failed temp file
            state_clone.export_files.write().await.remove(&req.export_id);
            let progress = TableExportProgress {
                export_id: req.export_id.clone(),
                table_name: req.table_name.clone(),
                rows_exported: 0,
                total_rows: None,
                status: dbx_core::table_export::ExportStatus::Error,
                error_message: Some(e),
            };
            if let Ok(json) = serde_json::to_string(&progress) {
                let _ = tx.send(json);
            }
        }

        dbx_core::database_export::clear_export_cancelled(&req.export_id).await;
        state_clone.remove_sse_channel(&req.export_id).await;
    });

    Ok(Json(serde_json::json!({ "exportId": export_id })))
}

pub async fn table_export_progress(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels.get(&export_id).ok_or_else(|| AppError("Export not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_table_export(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelExportRequest>,
) -> Json<serde_json::Value> {
    dbx_core::database_export::set_export_cancelled(&req.export_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

pub async fn table_export_download(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Response, AppError> {
    let (file_path, format) = state
        .export_files
        .write()
        .await
        .remove(&export_id)
        .ok_or_else(|| AppError("Export file not found".to_string()))?;

    let data = tokio::fs::read(&file_path).await.map_err(|e| AppError(e.to_string()))?;
    // Clean up temp file
    let _ = tokio::fs::remove_file(&file_path).await;

    let (content_type, file_ext) = match format.as_str() {
        "csv" => ("text/csv; charset=utf-8", "csv"),
        "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
        _ => return Err(AppError(format!("Unknown format: {format}"))),
    };

    let filename = format!("table_export_{export_id}.{file_ext}");

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\""))
        .body(Body::from(data))
        .map_err(|e| AppError(e.to_string()))?)
}
