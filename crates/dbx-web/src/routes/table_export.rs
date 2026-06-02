use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
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
    let req = body.request;
    let export_id = req.export_id.clone();

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
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
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
