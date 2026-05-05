use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

// Re-export types and functions used by other modules
pub use dbx_core::transfer::{
    get_db_type,
    TransferProgress, TransferRequest, TransferStatus,
};

fn emit_progress(app: &AppHandle, progress: TransferProgress) {
    let _ = app.emit("transfer-progress", progress);
}

#[tauri::command]
pub async fn start_transfer(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TransferRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let transfer_id = request.transfer_id.clone();

    // Validate connections exist
    let source_db_type = get_db_type(&state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(&state, &request.target_connection_id).await?;

    // Ensure pools
    let source_pool_key = state
        .get_or_create_pool(&request.source_connection_id, Some(&request.source_database))
        .await?;
    let target_pool_key = state
        .get_or_create_pool(&request.target_connection_id, Some(&request.target_database))
        .await?;

    tokio::spawn(async move {
        let total_tables = request.tables.len();
        log::info!("[transfer] starting transfer_id={} tables={}", transfer_id, total_tables);

        for (i, table) in request.tables.iter().enumerate() {
            if dbx_core::transfer::is_cancelled(&transfer_id).await {
                emit_progress(&app, TransferProgress {
                    transfer_id: transfer_id.clone(),
                    table: table.clone(),
                    table_index: i,
                    total_tables,
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: None,
                });
                dbx_core::transfer::clear_cancelled(&transfer_id).await;
                return;
            }

            log::info!("[transfer] table {}/{}: {}", i + 1, total_tables, table);

            match dbx_core::transfer::transfer_table(
                &state, &request, table, i,
                &source_db_type, &target_db_type,
                &source_pool_key, &target_pool_key,
                |progress| emit_progress(&app, progress),
            ).await {
                Ok(rows) => {
                    emit_progress(&app, TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables,
                        rows_transferred: rows,
                        total_rows: Some(rows),
                        status: if i == total_tables - 1 { TransferStatus::Done } else { TransferStatus::TableDone },
                        error: None,
                    });
                }
                Err(e) => {
                    if e == "Cancelled" {
                        emit_progress(&app, TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Cancelled,
                            error: None,
                        });
                        dbx_core::transfer::clear_cancelled(&transfer_id).await;
                        return;
                    }
                    emit_progress(&app, TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                    });
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        }

        dbx_core::transfer::clear_cancelled(&transfer_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    dbx_core::transfer::set_cancelled(&transfer_id).await;
    Ok(())
}
