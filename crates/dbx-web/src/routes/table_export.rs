use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Response, Sse};
use axum::Json;
use dbx_core::table_export::{self, ExportStatus, TableExportProgress, TableExportRequest};
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::routes::export_download::{attachment_content_disposition, export_download_filename};
use crate::state::{WebExportFile, WebState};

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
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError::from(e.to_string()))?;
    let ext = match req.format.as_str() {
        "csv" => "csv",
        "xlsx" => "xlsx",
        "json" => "json",
        "markdown" | "md" => "md",
        "sql" => "sql",
        _ => return Err(AppError::from(format!("Unsupported export format: {}", req.format))),
    };
    let tmp_file = tmp_dir.join(format!("table_export_{export_id}.{ext}"));
    let file_path = tmp_file.to_string_lossy().to_string();
    let download_filename = export_download_filename(&req.file_path, &req.table_name, ext);
    req.file_path = file_path.clone();

    // Store export file mapping for download
    state
        .export_files
        .write()
        .await
        .insert(export_id.clone(), WebExportFile { file_path, download_filename, format: req.format.clone() });

    let tx = {
        let mut channels = state.sse_channels.write().await;
        channels.entry(export_id.clone()).or_insert_with(|| tokio::sync::broadcast::channel::<String>(256).0).clone()
    };

    let app = state.app.clone();
    let state_clone = state.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_progress = cancelled.clone();

    tokio::spawn(async move {
        let result = table_export::export_table_data_core(&app, &req, |progress| {
            if matches!(progress.status, ExportStatus::Cancelled) {
                cancelled_progress.store(true, Ordering::SeqCst);
            }
            if let Ok(json) = serde_json::to_string(&progress) {
                let _ = tx.send(json);
            }
        })
        .await;

        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&req.file_path).await;
            state_clone.export_files.write().await.remove(&req.export_id);
            let progress = TableExportProgress {
                export_id: req.export_id.clone(),
                table_name: req.table_name.clone(),
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Error,
                error_message: Some(e),
            };
            if let Ok(json) = serde_json::to_string(&progress) {
                let _ = tx.send(json);
            }
        } else if cancelled.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&req.file_path).await;
            state_clone.export_files.write().await.remove(&req.export_id);
        }

        dbx_core::database_export::clear_export_cancelled(&req.export_id).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        state_clone.remove_sse_channel(&req.export_id).await;
    });

    Ok(Json(serde_json::json!({ "exportId": export_id })))
}

pub async fn table_export_progress(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>>, AppError> {
    let tx = {
        let mut channels = state.sse_channels.write().await;
        channels.entry(export_id).or_insert_with(|| tokio::sync::broadcast::channel::<String>(256).0).clone()
    };
    let rx = tx.subscribe();
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
    let export_file = state
        .export_files
        .write()
        .await
        .remove(&export_id)
        .ok_or_else(|| AppError::from("Export file not found".to_string()))?;

    let data = tokio::fs::read(&export_file.file_path).await.map_err(|e| AppError::from(e.to_string()))?;
    // Clean up temp file
    let _ = tokio::fs::remove_file(&export_file.file_path).await;

    let content_type = match export_file.format.as_str() {
        "csv" => "text/csv; charset=utf-8",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "json" => "application/json; charset=utf-8",
        "markdown" | "md" => "text/markdown; charset=utf-8",
        "sql" => "application/sql; charset=utf-8",
        format => return Err(AppError::from(format!("Unknown format: {format}"))),
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, attachment_content_disposition(&export_file.download_filename))
        .body(Body::from(data))
        .map_err(|e| AppError::from(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use dbx_core::connection::AppState;
    use dbx_core::storage::Storage;

    use crate::state::WebExportFile;

    #[tokio::test]
    async fn table_export_download_uses_the_requested_web_filename() {
        let dir = std::env::temp_dir().join(format!("dbx-web-table-export-download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState::for_tests(app, dir.clone()));
        let file_path = dir.join("table-export.xlsx");
        tokio::fs::write(&file_path, b"xlsx-data").await.unwrap();
        state.export_files.write().await.insert(
            "table-export-id".to_string(),
            WebExportFile {
                file_path: file_path.to_string_lossy().to_string(),
                download_filename: "智能体列表.xlsx".to_string(),
                format: "xlsx".to_string(),
            },
        );

        let response = table_export_download(State(state.clone()), Path("table-export-id".to_string())).await.unwrap();

        assert_eq!(
            response.headers().get(header::CONTENT_DISPOSITION).unwrap().to_str().unwrap(),
            "attachment; filename=\"_____.xlsx\"; filename*=UTF-8''%E6%99%BA%E8%83%BD%E4%BD%93%E5%88%97%E8%A1%A8.xlsx"
        );
        assert_eq!(to_bytes(response.into_body(), usize::MAX).await.unwrap().as_ref(), b"xlsx-data");
        assert!(!file_path.exists());
        assert!(!state.export_files.read().await.contains_key("table-export-id"));
        std::fs::remove_dir_all(dir).ok();
    }
}
