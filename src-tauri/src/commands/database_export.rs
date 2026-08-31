use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::database_export::{DatabaseBackupSnapshot, DatabaseExportRequest, ExportProgress, ExportStatus};

fn emit_progress(app: &AppHandle, progress: ExportProgress) {
    let _ = app.emit("database-export-progress", progress);
}

#[tauri::command]
pub async fn begin_database_backup_snapshot(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    export_id: Option<String>,
) -> Result<DatabaseBackupSnapshot, String> {
    dbx_core::database_export::begin_database_backup_snapshot_core_for_export(
        &state,
        &connection_id,
        &database,
        export_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn export_database_sql(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: DatabaseExportRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let export_id = request.export_id.clone();

    // Exports interleave async fetches with synchronous row formatting and
    // buffered disk writes; run them off the async workers (see spawn_export_task).
    dbx_core::export_runtime::spawn_export_task(async move {
        let result = dbx_core::database_export::export_database_sql_core(&state, &request, |progress| {
            emit_progress(&app, progress)
        })
        .await;

        let client_session_id = dbx_core::database_export::database_export_client_session_id(&export_id);
        let _ =
            state.close_client_session_pool(&request.connection_id, Some(&request.database), &client_session_id).await;

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
                    preparing: false,
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

#[tauri::command]
pub async fn clear_database_export_cancellation(export_id: String) -> Result<(), String> {
    dbx_core::database_export::clear_export_cancelled(&export_id).await;
    Ok(())
}

/// Records a scheduled backup destination's filesystem identity as soon as
/// the schedule is saved, not just after its first successful export. See
/// `record_export_destination_identity` for why this eager recording is
/// needed. Called from the schedule editor when a schedule is created or
/// edited (`apps/desktop/src/components/backup/ScheduledDatabaseBackupSettings.vue`).
#[tauri::command]
pub async fn record_database_export_destination(
    state: State<'_, Arc<AppState>>,
    directory: String,
) -> Result<(), String> {
    dbx_core::database_export::record_export_destination_identity(&state, std::path::Path::new(&directory)).await
}
