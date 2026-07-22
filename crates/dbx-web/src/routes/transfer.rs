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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTransferOwnershipRequest {
    pub request: TransferRequest,
}

pub async fn start_transfer(
    State(state): State<Arc<WebState>>,
    Json(body): Json<StartTransferRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;
    transfer::validate_transfer_target_table_names(&req).map_err(AppError::from)?;

    // Reject transfer early if the target connection is read-only
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.target_connection_id).await {
        return Err(AppError::from(format!(
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
        // Sort by FK dependency so referenced tables are transferred first.
        let tables = transfer::sort_tables_by_fk_dependency(
            &app,
            &req.source_connection_id,
            &req.source_database,
            &req.source_schema,
            &tables,
            true,
        )
        .await
        .unwrap_or_else(|e| {
            log::warn!("[transfer] failed to sort tables by FK dependency, using original order: {e}");
            tables
        });
        let mut failed_tables: Vec<String> = Vec::new();

        if matches!(source_db_type, dbx_core::models::connection::DatabaseType::Postgres)
            && matches!(target_db_type, dbx_core::models::connection::DatabaseType::Postgres)
        {
            let tx_clone = tx.clone();
            match transfer::transfer_postgres_schema_dependencies(
                &app,
                &req,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx_clone.send(json);
                    }
                },
            )
            .await
            {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: "schema dependencies".to_string(),
                        table_index: 0,
                        total_tables: tables.len(),
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                    transfer::clear_cancelled(&req.transfer_id).await;
                    state_clone.remove_sse_channel(&req.transfer_id).await;
                    return;
                }
                Err(e) => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: "schema dependencies".to_string(),
                        table_index: 0,
                        total_tables: tables.len(),
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: true,
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                    transfer::clear_cancelled(&req.transfer_id).await;
                    state_clone.remove_sse_channel(&req.transfer_id).await;
                    return;
                }
            }
        }

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
                    terminal: true,
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
                Ok(rows) => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: rows,
                        total_rows: last_total_rows.or(Some(rows)),
                        status: TransferStatus::TableDone,
                        error: None,
                        terminal: false,
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                }
                Err(e) => {
                    if e == "Cancelled" {
                        let progress = transfer::TransferProgress {
                            transfer_id: req.transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables: tables.len(),
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                        };
                        if let Ok(json) = serde_json::to_string(&progress) {
                            let _ = tx.send(json);
                        }
                        transfer::clear_cancelled(&req.transfer_id).await;
                        state_clone.remove_sse_channel(&req.transfer_id).await;
                        return;
                    }
                    failed_tables.push(table.clone());
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                }
            }
        }

        if matches!(source_db_type, dbx_core::models::connection::DatabaseType::Postgres)
            && matches!(target_db_type, dbx_core::models::connection::DatabaseType::Postgres)
        {
            let tx_clone = tx.clone();
            match transfer::transfer_postgres_schema_objects(
                &app,
                &req,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx_clone.send(json);
                    }
                },
            )
            .await
            {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: tables.len(),
                        total_tables: tables.len(),
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    };
                    if let Ok(json) = serde_json::to_string(&progress) {
                        let _ = tx.send(json);
                    }
                    transfer::clear_cancelled(&req.transfer_id).await;
                    state_clone.remove_sse_channel(&req.transfer_id).await;
                    return;
                }
                Err(e) => {
                    failed_tables.push("schema objects".to_string());
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: tables.len(),
                        total_tables: tables.len(),
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
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
            status: if failed_tables.is_empty() { TransferStatus::Done } else { TransferStatus::Error },
            error: if failed_tables.is_empty() {
                None
            } else {
                Some(format!(
                    "{} table(s) failed: {}",
                    failed_tables.len(),
                    failed_tables.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
                ))
            },
            terminal: true,
        };
        if let Ok(json) = serde_json::to_string(&done) {
            let _ = tx.send(json);
        }

        transfer::clear_cancelled(&req.transfer_id).await;
        state_clone.remove_sse_channel(&req.transfer_id).await;
    });

    Ok(Json(serde_json::json!({ "transferId": transfer_id })))
}

pub async fn preview_transfer_ownership(
    State(state): State<Arc<WebState>>,
    Json(body): Json<PreviewTransferOwnershipRequest>,
) -> Result<Json<dbx_core::transfer::TransferOwnershipPreview>, AppError> {
    let req = body.request;
    transfer::validate_transfer_target_table_names(&req).map_err(AppError::from)?;
    let source_db_type = transfer::get_db_type(&state.app, &req.source_connection_id).await.map_err(AppError::from)?;
    let target_db_type = transfer::get_db_type(&state.app, &req.target_connection_id).await.map_err(AppError::from)?;
    let source_pool_key = state
        .app
        .get_or_create_pool(&req.source_connection_id, Some(&req.source_database))
        .await
        .map_err(AppError::from)?;
    let target_pool_key = state
        .app
        .get_or_create_pool(&req.target_connection_id, Some(&req.target_database))
        .await
        .map_err(AppError::from)?;
    let preview = transfer::preview_transfer_ownership(
        &state.app,
        &req,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(preview))
}

pub async fn transfer_progress(
    State(state): State<Arc<WebState>>,
    Path(transfer_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels.get(&transfer_id).ok_or_else(|| AppError::from("Transfer not found".to_string()))?;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortTablesByFkRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub tables: Vec<String>,
    pub parents_first: bool,
}

pub async fn sort_tables_by_fk_dependency(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SortTablesByFkRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    transfer::sort_tables_by_fk_dependency(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.schema,
        &req.tables,
        req.parents_first,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}
