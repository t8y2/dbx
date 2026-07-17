use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

use dbx_core::query_cancel::RunningTaskMetadata;
pub use dbx_core::query_result_export::QueryResultExportRequest;
use dbx_core::table_export::ExportStatus;
pub use dbx_core::table_export::TableExportProgress;

fn emit_progress(app: &AppHandle, progress: TableExportProgress) {
    let _ = app.emit("query-result-export-progress", progress);
}

#[tauri::command]
pub async fn start_query_result_export(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: QueryResultExportRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let export_id = request.export_id.clone();
    let file_path = request.file_path.clone();

    tokio::spawn(async move {
        let execution_id = request.execution_id.clone().filter(|id| !id.trim().is_empty());
        let registered_query = execution_id.as_ref().map(|id| {
            state.running_queries.register_task(
                id.clone(),
                RunningTaskMetadata::query(
                    request.connection_id.clone(),
                    request.database.clone(),
                    request.client_session_id.clone(),
                ),
            )
        });
        let cancel_token = registered_query.as_ref().map(|query| query.token());
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_progress = cancelled.clone();
        let result =
            dbx_core::query_result_export::export_query_result_core(&state, &request, cancel_token, |progress| {
                if matches!(progress.status, ExportStatus::Cancelled) {
                    cancelled_progress.store(true, Ordering::SeqCst);
                }
                emit_progress(&app, progress);
            })
            .await;
        drop(registered_query);

        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&file_path).await;
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
        } else if cancelled.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&file_path).await;
        }

        dbx_core::database_export::clear_export_cancelled(&export_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_query_result_export(
    state: State<'_, Arc<AppState>>,
    export_id: String,
    execution_id: Option<String>,
) -> Result<(), String> {
    dbx_core::database_export::set_export_cancelled(&export_id).await;
    if let Some(execution_id) = execution_id.filter(|id| !id.trim().is_empty()) {
        state.running_queries.cancel(&execution_id);
    }
    Ok(())
}
