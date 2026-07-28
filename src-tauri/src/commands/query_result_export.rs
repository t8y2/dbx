use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
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

fn route_core_progress(
    progress: TableExportProgress,
    deferred_done: &Mutex<Option<TableExportProgress>>,
    cancelled: &AtomicBool,
    emit: impl FnOnce(TableExportProgress),
) {
    match progress.status {
        ExportStatus::Done => {
            *deferred_done.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(progress);
        }
        ExportStatus::Cancelled => {
            cancelled.store(true, Ordering::SeqCst);
            emit(progress);
        }
        _ => emit(progress),
    }
}

/// Build a temp-file path alongside the target path.
/// The temp file has a `.dbx-export-tmp` suffix so it's never confused with the
/// user's chosen file. On success the temp file is renamed atomically onto the
/// target; on error/cancel only the temp file is cleaned up, leaving the user's
/// chosen path untouched.
fn temp_file_path(target: &str) -> (PathBuf, PathBuf) {
    let target_path = PathBuf::from(target);
    let mut temp_path = target_path.clone();
    let mut temp_name =
        target_path.file_name().map(|name| name.to_os_string()).unwrap_or_else(|| std::ffi::OsString::from("export"));
    temp_name.push(".dbx-export-tmp");
    temp_path.set_file_name(temp_name);
    (target_path, temp_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_file_path_adds_suffix_to_simple_filename() {
        let (target, temp) = temp_file_path("C:\\exports\\backup.sql");
        assert_eq!(target, PathBuf::from("C:\\exports\\backup.sql"));
        assert_eq!(temp, PathBuf::from("C:\\exports\\backup.sql.dbx-export-tmp"));
    }

    #[test]
    fn temp_file_path_adds_suffix_to_filename_with_multiple_extensions() {
        let (target, temp) = temp_file_path("/home/user/query-result.xlsx");
        assert_eq!(target, PathBuf::from("/home/user/query-result.xlsx"));
        assert_eq!(temp, PathBuf::from("/home/user/query-result.xlsx.dbx-export-tmp"));
    }

    #[test]
    fn temp_file_path_handles_filename_without_extension() {
        let (target, temp) = temp_file_path("/tmp/export");
        assert_eq!(target, PathBuf::from("/tmp/export"));
        assert_eq!(temp, PathBuf::from("/tmp/export.dbx-export-tmp"));
    }

    #[test]
    fn temp_file_path_uses_export_fallback_for_empty_target() {
        let (target, temp) = temp_file_path("");
        assert_eq!(target, PathBuf::from(""));
        // file_name() on a path without a filename returns None, so we fall
        // back to "export" as the base name.
        assert!(temp.to_string_lossy().ends_with("export.dbx-export-tmp"));
    }

    #[test]
    fn route_core_progress_defers_done_until_finalization() {
        let deferred_done = Mutex::new(None);
        let cancelled = AtomicBool::new(false);
        let emitted = Mutex::new(Vec::new());
        let done = TableExportProgress {
            export_id: "export-1".to_string(),
            table_name: String::new(),
            rows_exported: 42,
            total_rows: Some(42),
            status: ExportStatus::Done,
            error_message: None,
        };

        route_core_progress(done, &deferred_done, &cancelled, |progress| {
            emitted.lock().unwrap().push(progress);
        });

        assert!(emitted.lock().unwrap().is_empty());
        assert_eq!(deferred_done.lock().unwrap().as_ref().map(|progress| progress.rows_exported), Some(42));
        assert!(!cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn route_core_progress_keeps_cancelled_terminal_state() {
        let deferred_done = Mutex::new(None);
        let cancelled = AtomicBool::new(false);
        let emitted = Mutex::new(Vec::new());
        let progress = TableExportProgress {
            export_id: "export-1".to_string(),
            table_name: String::new(),
            rows_exported: 7,
            total_rows: None,
            status: ExportStatus::Cancelled,
            error_message: Some("Export cancelled".to_string()),
        };

        route_core_progress(progress, &deferred_done, &cancelled, |progress| {
            emitted.lock().unwrap().push(progress);
        });

        assert!(deferred_done.lock().unwrap().is_none());
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(matches!(
            emitted.lock().unwrap().as_slice(),
            [TableExportProgress { status: ExportStatus::Cancelled, .. }]
        ));
    }
}

#[tauri::command]
pub async fn start_query_result_export(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mut request: QueryResultExportRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let export_id = request.export_id.clone();

    // Redirect file I/O to a temp file so the user's chosen path is never
    // truncated before the query completes. On success the temp file is
    // renamed onto the target; on error/cancel only the temp file is removed.
    let (target_path, temp_path) = temp_file_path(&request.file_path);
    request.file_path = temp_path.to_string_lossy().to_string();

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
        let deferred_done = Arc::new(Mutex::new(None));
        let deferred_done_progress = deferred_done.clone();
        let result =
            dbx_core::query_result_export::export_query_result_core(&state, &request, cancel_token, |progress| {
                route_core_progress(progress, &deferred_done_progress, &cancelled_progress, |progress| {
                    emit_progress(&app, progress);
                });
            })
            .await;
        drop(registered_query);
        let completed_progress = deferred_done.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();

        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&request.file_path).await;
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
            let _ = tokio::fs::remove_file(&request.file_path).await;
        } else if let Some(progress) = completed_progress {
            // Success: atomically rename temp → target so the user's chosen
            // file is only created/replaced when the export fully completes.
            if let Err(e) = std::fs::rename(&request.file_path, &target_path) {
                let _ = tokio::fs::remove_file(&request.file_path).await;
                emit_progress(
                    &app,
                    TableExportProgress {
                        export_id: export_id.clone(),
                        table_name: String::new(),
                        rows_exported: 0,
                        total_rows: None,
                        status: ExportStatus::Error,
                        error_message: Some(format!("Failed to finalize export file: {e}")),
                    },
                );
            } else {
                emit_progress(&app, progress);
            }
        } else {
            let _ = tokio::fs::remove_file(&request.file_path).await;
            emit_progress(
                &app,
                TableExportProgress {
                    export_id: export_id.clone(),
                    table_name: String::new(),
                    rows_exported: 0,
                    total_rows: None,
                    status: ExportStatus::Error,
                    error_message: Some("Export finished without a completion status".to_string()),
                },
            );
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
