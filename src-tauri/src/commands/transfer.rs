use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};

// Re-export types and functions used by other modules
pub use dbx_core::transfer::{get_db_type, TransferProgress, TransferRequest, TransferStatus};

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

    // Reject transfer early if the target connection is read-only — writing to it is inherently required
    ensure_connection_writable(&state, &request.target_connection_id, "Transfer").await?;

    // Validate connections exist
    let source_db_type = get_db_type(&state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(&state, &request.target_connection_id).await?;

    // Ensure pools
    let source_pool_key =
        state.get_or_create_pool(&request.source_connection_id, Some(&request.source_database)).await?;
    let target_pool_key =
        state.get_or_create_pool(&request.target_connection_id, Some(&request.target_database)).await?;

    tokio::spawn(async move {
        let total_tables = request.tables.len();
        log::info!("[transfer] starting transfer_id={} tables={}", transfer_id, total_tables);

        if matches!(source_db_type, dbx_core::models::connection::DatabaseType::Postgres)
            && matches!(target_db_type, dbx_core::models::connection::DatabaseType::Postgres)
        {
            match dbx_core::transfer::transfer_postgres_schema_dependencies(
                &state,
                &request,
                &source_pool_key,
                &target_pool_key,
                |progress| emit_progress(&app, progress),
            )
            .await
            {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => {
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: "schema dependencies".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Cancelled,
                            error: None,
                        },
                    );
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
                Err(e) => {
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: "schema dependencies".to_string(),
                            table_index: 0,
                            total_tables,
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Error,
                            error: Some(e),
                        },
                    );
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
            }
        }

        for (i, table) in request.tables.iter().enumerate() {
            if dbx_core::transfer::is_cancelled(&transfer_id).await {
                emit_progress(
                    &app,
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: None,
                    },
                );
                dbx_core::transfer::clear_cancelled(&transfer_id).await;
                return;
            }

            log::info!("[transfer] table {}/{}: {}", i + 1, total_tables, table);

            let mut last_rows_transferred = 0_u64;
            let mut last_total_rows = None;

            match dbx_core::transfer::transfer_table(
                &state,
                &request,
                table,
                i,
                &source_db_type,
                &target_db_type,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    emit_progress(&app, progress);
                },
            )
            .await
            {
                Ok(rows) => {
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: rows,
                            total_rows: last_total_rows.or(Some(rows)),
                            status: TransferStatus::TableDone,
                            error: None,
                        },
                    );
                }
                Err(e) => {
                    if e == "Cancelled" {
                        emit_progress(
                            &app,
                            TransferProgress {
                                transfer_id: transfer_id.clone(),
                                table: table.clone(),
                                table_index: i,
                                total_tables,
                                rows_transferred: 0,
                                total_rows: None,
                                status: TransferStatus::Cancelled,
                                error: None,
                            },
                        );
                        dbx_core::transfer::clear_cancelled(&transfer_id).await;
                        return;
                    }
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                        },
                    );
                }
            }
        }

        if matches!(source_db_type, dbx_core::models::connection::DatabaseType::Postgres)
            && matches!(target_db_type, dbx_core::models::connection::DatabaseType::Postgres)
        {
            match dbx_core::transfer::transfer_postgres_schema_objects(
                &state,
                &request,
                &source_pool_key,
                &target_pool_key,
                |progress| emit_progress(&app, progress),
            )
            .await
            {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => {
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: "schema objects".to_string(),
                            table_index: total_tables,
                            total_tables,
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Cancelled,
                            error: None,
                        },
                    );
                    dbx_core::transfer::clear_cancelled(&transfer_id).await;
                    return;
                }
                Err(e) => {
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: "schema objects".to_string(),
                            table_index: total_tables,
                            total_tables,
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Error,
                            error: Some(e),
                        },
                    );
                }
            }
        }

        emit_progress(
            &app,
            TransferProgress {
                transfer_id: transfer_id.clone(),
                table: String::new(),
                table_index: total_tables,
                total_tables,
                rows_transferred: 0,
                total_rows: None,
                status: TransferStatus::Done,
                error: None,
            },
        );
        dbx_core::transfer::clear_cancelled(&transfer_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    dbx_core::transfer::set_cancelled(&transfer_id).await;
    Ok(())
}
