use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

use dbx_core::query_cancel::RunningTaskMetadata;
pub use dbx_core::query_result_export::QueryResultExportRequest;
use dbx_core::query_result_export::StagedExportTarget;
use dbx_core::table_export::ExportStatus;
pub use dbx_core::table_export::TableExportProgress;

fn emit_progress(app: &AppHandle, progress: TableExportProgress) {
    let _ = app.emit("query-result-export-progress", progress);
}

#[derive(Default)]
struct RoutedExportProgress {
    terminal: Mutex<Option<TableExportProgress>>,
    rows_exported: AtomicU64,
}

impl RoutedExportProgress {
    fn take_terminal(&self) -> Option<TableExportProgress> {
        self.terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    }

    fn rows_exported(&self) -> u64 {
        self.rows_exported.load(Ordering::SeqCst)
    }
}

fn route_core_progress(
    progress: TableExportProgress,
    routed: &RoutedExportProgress,
    emit: impl FnOnce(TableExportProgress),
) {
    routed.rows_exported.store(progress.rows_exported, Ordering::SeqCst);
    match progress.status {
        ExportStatus::Done => {
            let mut terminal = routed.terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if !terminal.as_ref().is_some_and(|progress| matches!(progress.status, ExportStatus::Cancelled)) {
                *terminal = Some(progress);
            }
        }
        ExportStatus::Cancelled => {
            *routed.terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(progress);
        }
        _ => emit(progress),
    }
}

fn export_error_progress(export_id: &str, rows_exported: u64, error: String) -> TableExportProgress {
    TableExportProgress {
        export_id: export_id.to_string(),
        table_name: String::new(),
        rows_exported,
        total_rows: None,
        status: ExportStatus::Error,
        error_message: Some(error),
    }
}

fn finalize_staged_export(
    target: StagedExportTarget,
    export_id: &str,
    result: Result<(), String>,
    terminal: Option<TableExportProgress>,
    cancellation_requested: bool,
    rows_exported: u64,
    emit: impl Fn(TableExportProgress),
) {
    if cancellation_requested
        || terminal.as_ref().is_some_and(|progress| matches!(progress.status, ExportStatus::Cancelled))
    {
        drop(target);
        let cancelled =
            terminal.filter(|progress| matches!(progress.status, ExportStatus::Cancelled)).unwrap_or_else(|| {
                TableExportProgress {
                    export_id: export_id.to_string(),
                    table_name: String::new(),
                    rows_exported,
                    total_rows: None,
                    status: ExportStatus::Cancelled,
                    error_message: Some("Export cancelled".to_string()),
                }
            });
        emit(cancelled);
        return;
    }

    if let Err(error) = result {
        drop(target);
        emit(export_error_progress(export_id, rows_exported, error));
        return;
    }

    let Some(done) = terminal.filter(|progress| matches!(progress.status, ExportStatus::Done)) else {
        drop(target);
        emit(export_error_progress(
            export_id,
            rows_exported,
            "Export finished without a completion status".to_string(),
        ));
        return;
    };

    match target.commit() {
        Ok(()) => emit(done),
        Err(error) => emit(export_error_progress(export_id, rows_exported, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dbx-query-result-export-{}-{}",
                std::process::id(),
                NEXT_TEST_DIR.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&path).expect("create test dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn terminal_progress(status: ExportStatus, rows_exported: u64) -> TableExportProgress {
        TableExportProgress {
            export_id: "export-1".to_string(),
            table_name: String::new(),
            rows_exported,
            total_rows: Some(rows_exported),
            status,
            error_message: None,
        }
    }

    #[test]
    fn route_core_progress_buffers_terminal_status_until_finalization() {
        let routed = RoutedExportProgress::default();
        let emitted = Mutex::new(Vec::new());
        route_core_progress(terminal_progress(ExportStatus::Done, 42), &routed, |progress| {
            emitted.lock().expect("emitted lock").push(progress);
        });

        assert!(emitted.lock().expect("emitted lock").is_empty());
        assert_eq!(routed.rows_exported(), 42);
        assert!(matches!(routed.take_terminal(), Some(TableExportProgress { status: ExportStatus::Done, .. })));
    }

    fn assert_native_stream_cancellation_emits_one_cancelled_terminal() {
        let dir = TestDir::new();
        let destination = dir.path().join("result.csv");
        std::fs::write(&destination, "original").expect("write destination");
        let target = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("target");
        std::fs::write(target.path(), "partial").expect("write partial export");
        let routed = RoutedExportProgress::default();
        let emitted = Mutex::new(Vec::new());
        route_core_progress(terminal_progress(ExportStatus::Cancelled, 7), &routed, |progress| {
            emitted.lock().expect("emitted lock").push(progress);
        });
        route_core_progress(terminal_progress(ExportStatus::Done, 7), &routed, |progress| {
            emitted.lock().expect("emitted lock").push(progress);
        });
        finalize_staged_export(
            target,
            "export-1",
            Err("native stream cancelled".to_string()),
            routed.take_terminal(),
            true,
            routed.rows_exported(),
            |progress| emitted.lock().expect("emitted lock").push(progress),
        );

        assert!(matches!(
            emitted.lock().expect("emitted lock").as_slice(),
            [TableExportProgress { status: ExportStatus::Cancelled, .. }]
        ));
        assert_eq!(std::fs::read_to_string(destination).expect("read destination"), "original");
    }

    #[test]
    fn postgres_native_stream_cancellation_emits_one_cancelled_terminal() {
        assert_native_stream_cancellation_emits_one_cancelled_terminal();
    }

    #[test]
    fn sqlserver_native_stream_cancellation_emits_one_cancelled_terminal() {
        assert_native_stream_cancellation_emits_one_cancelled_terminal();
    }

    #[test]
    fn export_failure_preserves_existing_destination_and_emits_one_error() {
        let dir = TestDir::new();
        let destination = dir.path().join("result.csv");
        std::fs::write(&destination, "original").expect("write destination");
        let target = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("target");
        std::fs::write(target.path(), "partial").expect("write partial export");
        let emitted = Mutex::new(Vec::new());

        finalize_staged_export(target, "export-1", Err("write failed".to_string()), None, false, 3, |progress| {
            emitted.lock().expect("emitted lock").push(progress);
        });

        assert!(matches!(
            emitted.lock().expect("emitted lock").as_slice(),
            [TableExportProgress { status: ExportStatus::Error, .. }]
        ));
        assert_eq!(std::fs::read_to_string(destination).expect("read destination"), "original");
    }

    #[test]
    fn replace_failure_preserves_existing_destination_and_suppresses_done() {
        let dir = TestDir::new();
        let destination = dir.path().join("result.csv");
        std::fs::write(&destination, "original").expect("write destination");
        let target = StagedExportTarget::new(destination.to_str().expect("destination path")).expect("target");
        std::fs::write(target.path(), "replacement").expect("write replacement");
        std::fs::remove_file(target.path()).expect("remove staged path");
        let emitted = Mutex::new(Vec::new());

        finalize_staged_export(
            target,
            "export-1",
            Ok(()),
            Some(terminal_progress(ExportStatus::Done, 4)),
            false,
            4,
            |progress| emitted.lock().expect("emitted lock").push(progress),
        );

        assert!(matches!(
            emitted.lock().expect("emitted lock").as_slice(),
            [TableExportProgress { status: ExportStatus::Error, .. }]
        ));
        assert_eq!(std::fs::read_to_string(destination).expect("read destination"), "original");
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
    let target = StagedExportTarget::new(&request.file_path)?;
    request.file_path = target.path_string()?;

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
        let routed_progress = Arc::new(RoutedExportProgress::default());
        let routed_progress_handler = routed_progress.clone();
        let result = dbx_core::query_result_export::export_query_result_core(
            &state,
            &request,
            cancel_token.clone(),
            |progress| {
                route_core_progress(progress, &routed_progress_handler, |progress| {
                    emit_progress(&app, progress);
                });
            },
        )
        .await;
        drop(registered_query);
        let terminal = routed_progress.take_terminal();
        let cancellation_requested =
            terminal.as_ref().is_some_and(|progress| matches!(progress.status, ExportStatus::Cancelled))
                || cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
                || dbx_core::database_export::is_export_cancelled(&export_id).await;
        finalize_staged_export(
            target,
            &export_id,
            result,
            terminal,
            cancellation_requested,
            routed_progress.rows_exported(),
            |progress| emit_progress(&app, progress),
        );

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
