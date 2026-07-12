use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::table_export::{ExportStatus, TableExportProgress, TableExportRequest};

fn emit_progress(app: &AppHandle, progress: TableExportProgress) {
    let _ = app.emit("table-export-progress", progress);
}

#[tauri::command]
pub async fn start_table_export(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TableExportRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let export_id = request.export_id.clone();

    tokio::spawn(async move {
        let result =
            dbx_core::table_export::export_table_data_core(&state, &request, |progress| emit_progress(&app, progress))
                .await;

        let client_session_id = dbx_core::table_export::table_export_client_session_id(&export_id);
        let _ =
            state.close_client_session_pool(&request.connection_id, Some(&request.database), &client_session_id).await;

        if let Err(e) = result {
            emit_progress(
                &app,
                TableExportProgress {
                    export_id: export_id.clone(),
                    table_name: String::new(),
                    rows_exported: 0,
                    total_rows: None,
                    status: ExportStatus::Error,
                    error_message: Some(e),
                },
            );
        }

        dbx_core::database_export::clear_export_cancelled(&export_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_table_export(export_id: String) -> Result<(), String> {
    dbx_core::database_export::set_export_cancelled(&export_id).await;
    Ok(())
}
