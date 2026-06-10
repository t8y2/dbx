use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::transfer::{self, TransferRequest, TransferStatus};
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTransferRequest {
    pub request: TransferRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTransferRequest {
    pub transfer_id: String,
}

pub async fn start_transfer(
    State(state): State<Arc<WebState>>,
    Json(body): Json<StartTransferRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;

    // Reject transfer early if the target connection is read-only
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.target_connection_id).await {
        return Err(AppError(format!(
            "Read-only mode: target connection '{}' has read-only protection enabled. Transfer blocked.",
            name
        )));
    }

    let transfer_id = req.transfer_id.clone();

    // Create a broadcast channel for progress
    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state.sse_channels.write().await.insert(transfer_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let source_db_type = match transfer::get_db_type(&app, &req.source_connection_id).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(serde_json::json!({"error": e}).to_string());
                return;
            }
        };
        let target_db_type = match transfer::get_db_type(&app, &req.target_connection_id).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(serde_json::json!({"error": e}).to_string());
                return;
            }
        };

        let source_pool_key = match app.get_or_create_pool(&req.source_connection_id, Some(&req.source_database)).await
        {
            Ok(k) => k,
            Err(e) => {
                let _ = tx.send(serde_json::json!({"error": e}).to_string());
                return;
            }
        };
        let target_pool_key = match app.get_or_create_pool(&req.target_connection_id, Some(&req.target_database)).await
        {
            Ok(k) => k,
            Err(e) => {
                let _ = tx.send(serde_json::json!({"error": e}).to_string());
                return;
            }
        };

        let tables = req.tables.clone();
        for (i, table) in tables.iter().enumerate() {
            if transfer::is_cancelled(&req.transfer_id).await {
                let progress = transfer::TransferProgress {
                    transfer_id: req.transfer_id.clone(),
                    table: table.clone(),
                    table_index: i,
                    total_tables: tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: None,
                };
                if let Ok(json) = serde_json::to_string(&progress) {
                    let _ = tx.send(json);
                }
                transfer::clear_cancelled(&req.transfer_id).await;
                state_clone.remove_sse_channel(&req.transfer_id).await;
                return;
            }

            let tx_clone = tx.clone();
            let mut last_rows_transferred = 0_u64;
            let mut last_total_rows = None;
            let result = transfer::transfer_table(
                &app,
                &req,
                table,
                i,
                &source_db_type,
                &target_db_type,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx_clone.send(json);
                    }
                },
            )
            .await;

            match result {
                Ok(_) => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows.or(Some(last_rows_transferred)),
                        status: TransferStatus::TableDone,
                        error: None,
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                }
                Err(e) => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Error,
                        error: Some(e),
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                }
            }
        }

        // Send done
        let done = transfer::TransferProgress {
            transfer_id: req.transfer_id.clone(),
            table: String::new(),
            table_index: tables.len(),
            total_tables: tables.len(),
            rows_transferred: 0,
            total_rows: None,
            status: TransferStatus::Done,
            error: None,
        };
        if let Ok(json) = serde_json::to_string(&done) {
            let _ = tx.send(json);
        }

        transfer::clear_cancelled(&req.transfer_id).await;
        state_clone.remove_sse_channel(&req.transfer_id).await;
    });

    Ok(Json(serde_json::json!({ "transferId": transfer_id })))
}

pub async fn transfer_progress(
    State(state): State<Arc<WebState>>,
    Path(transfer_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels.get(&transfer_id).ok_or_else(|| AppError("Transfer not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_transfer(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelTransferRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.transfer_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}
