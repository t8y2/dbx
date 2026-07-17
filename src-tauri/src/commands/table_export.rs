use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::table_export::{ExportStatus, TableExportProgress, TableExportRequest};

fn emit_progress(app: &AppHandle, progress: TableExportProgress) {
    let _ = app.emit("table-export-progress", progress);
}

async fn remove_incomplete_export(file_path: &str, failed: bool, cancelled: bool) {
    // A cancelled core export returns Ok, so cleanup must also follow the emitted terminal status.
    if failed || cancelled {
        let _ = tokio::fs::remove_file(file_path).await;
    }
}

#[tauri::command]
pub async fn start_table_export(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TableExportRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let export_id = request.export_id.clone();
    let file_path = request.file_path.clone();

    tokio::spawn(async move {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_progress = cancelled.clone();
        let result = dbx_core::table_export::export_table_data_core(&state, &request, |progress| {
            if matches!(progress.status, ExportStatus::Cancelled) {
                cancelled_progress.store(true, Ordering::SeqCst);
            }
            emit_progress(&app, progress);
        })
        .await;

        let client_session_id = dbx_core::table_export::table_export_client_session_id(&export_id);
        let _ =
            state.close_client_session_pool(&request.connection_id, Some(&request.database), &client_session_id).await;

        let failed = result.is_err();
        let was_cancelled = cancelled.load(Ordering::SeqCst);
        remove_incomplete_export(&file_path, failed, was_cancelled).await;

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

#[cfg(test)]
mod tests {
    use super::remove_incomplete_export;

    async fn create_export_file(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("dbx-table-export-{name}-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"partial export").await.unwrap();
        path
    }

    #[tokio::test]
    async fn removes_export_file_after_cancellation() {
        let path = create_export_file("cancelled").await;

        remove_incomplete_export(path.to_str().unwrap(), false, true).await;

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn removes_export_file_after_error() {
        let path = create_export_file("failed").await;

        remove_incomplete_export(path.to_str().unwrap(), true, false).await;

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn preserves_successful_export_file() {
        let path = create_export_file("completed").await;

        remove_incomplete_export(path.to_str().unwrap(), false, false).await;

        assert!(path.exists());
        tokio::fs::remove_file(path).await.unwrap();
    }
}
