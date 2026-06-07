use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::database_export::{DatabaseExportRequest, ExportProgress, ExportStatus};

fn emit_progress(app: &AppHandle, progress: ExportProgress) {
    let _ = app.emit("database-export-progress", progress);
}

#[tauri::command]
pub async fn export_database_sql(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: DatabaseExportRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let export_id = request.export_id.clone();

    tokio::spawn(async move {
        let result = dbx_core::database_export::export_database_sql_core(&state, &request, |progress| {
            emit_progress(&app, progress)
        })
        .await;

        if let Err(e) = result {
            emit_progress(
                &app,
                ExportProgress {
                    export_id: export_id.clone(),
                    current_object: String::new(),
                    object_index: 0,
                    total_objects: 0,
                    rows_exported: 0,
                    total_rows: None,
                    status: ExportStatus::Error,
                    error: Some(e),
                },
            );
        }

        dbx_core::database_export::clear_export_cancelled(&export_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_database_export(export_id: String) -> Result<(), String> {
    dbx_core::database_export::set_export_cancelled(&export_id).await;
    Ok(())
}
