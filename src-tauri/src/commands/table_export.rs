use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::table_export::{ExportStatus, TableExportProgress, TableExportRequest};

fn emit_progress(app: &AppHandle, progress: TableExportProgress) {
    let _ = app.emit("table-export-progress", progress);
}

fn route_core_progress(
    progress: TableExportProgress,
    terminal: &Mutex<Option<TableExportProgress>>,
    emit: impl FnOnce(TableExportProgress),
) {
    if matches!(progress.status, ExportStatus::Done | ExportStatus::Error | ExportStatus::Cancelled) {
        *terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(progress);
    } else {
        emit(progress);
    }
}

async fn remove_incomplete_export(file_path: &str, failed: bool, cancelled: bool) -> Result<(), String> {
    // A cancelled core export returns Ok, so cleanup must also follow the emitted terminal status.
    if failed || cancelled {
        match tokio::fs::remove_file(file_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

async fn finalize_export(
    export_id: &str,
    file_path: &str,
    result: Result<(), String>,
    terminal: Option<TableExportProgress>,
    close_session: impl std::future::Future<Output = Result<(), String>>,
    emit: impl FnOnce(TableExportProgress),
) -> Result<(), String> {
    let close_result = close_session.await;
    let was_cancelled = terminal.as_ref().is_some_and(|progress| matches!(progress.status, ExportStatus::Cancelled));
    let remove_result = remove_incomplete_export(file_path, result.is_err(), was_cancelled).await;
    close_result?;
    remove_result?;
    dbx_core::database_export::clear_export_cancelled(export_id).await;
    if let Err(error) = result {
        emit(TableExportProgress {
            export_id: export_id.to_string(),
            table_name: String::new(),
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Error,
            error_message: Some(error),
        });
    } else if let Some(progress) = terminal {
        emit(progress);
    }
    Ok(())
}

#[tauri::command]
pub async fn start_table_export(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TableExportRequest,
) -> Result<(), String> {
    dbx_core::query::mysql_data_charset_policy::check_export(&state, &request.connection_id, &request.format).await?;
    let state = state.inner().clone();
    let export_id = request.export_id.clone();
    let file_path = request.file_path.clone();

    // Exports interleave async fetches with synchronous row formatting and
    // buffered disk writes; run them off the async workers (see spawn_export_task).
    dbx_core::export_runtime::spawn_export_task(async move {
        let terminal = Mutex::new(None);
        let completion = dbx_core::table_export::export_table_data_core_with_completion(&state, &request, |progress| {
            route_core_progress(progress, &terminal, |progress| emit_progress(&app, progress));
        })
        .await;

        let terminal = terminal.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
        let completion = finalize_export(
            &export_id,
            &file_path,
            completion.result,
            terminal,
            async { completion.cleanup },
            |progress| emit_progress(&app, progress),
        )
        .await;
        if let Err(error) = completion {
            let _ = app.emit(
                "table-export-progress",
                serde_json::json!({
                    "exportId": export_id, "tableName": request.table_name,
                    "rowsExported": 0, "totalRows": null, "status": "Unknown", "errorMessage": error,
                }),
            );
        }
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
    use super::*;

    fn progress(status: ExportStatus) -> TableExportProgress {
        TableExportProgress {
            export_id: "queued-export".to_string(),
            table_name: "source".to_string(),
            rows_exported: 1,
            total_rows: Some(1),
            status,
            error_message: None,
        }
    }

    #[test]
    fn forwards_nonterminal_progress_without_releasing_completion() {
        let terminal = Mutex::new(None);
        let mut emitted = Vec::new();
        route_core_progress(progress(ExportStatus::Running), &terminal, |progress| emitted.push(progress));
        assert_eq!(emitted.len(), 1);
        assert!(terminal.into_inner().unwrap().is_none());
    }

    #[tokio::test]
    async fn holds_cancelled_progress_while_removing_partial_file() {
        let path = create_export_file("deferred-terminal").await;
        let terminal = Mutex::new(None);
        route_core_progress(progress(ExportStatus::Cancelled), &terminal, |_| {
            panic!("completion must not be emitted before cleanup");
        });

        assert!(path.exists());
        remove_incomplete_export(path.to_str().unwrap(), false, true).await.unwrap();
        assert!(!path.exists());
        assert!(matches!(terminal.into_inner().unwrap().unwrap().status, ExportStatus::Cancelled));
    }

    #[tokio::test]
    async fn completes_cleanup_before_starting_the_next_export_at_the_same_path() {
        let path = create_export_file("same-path").await;
        let (allow_close, closing) = tokio::sync::oneshot::channel();
        let emitted = std::cell::Cell::new(false);
        let next_path = path.clone();
        let terminal = Mutex::new(None);
        route_core_progress(progress(ExportStatus::Cancelled), &terminal, |_| panic!("early terminal"));
        let completion = finalize_export(
            "queued-export",
            path.to_str().unwrap(),
            Ok(()),
            terminal.into_inner().unwrap(),
            async {
                closing.await.unwrap();
                Ok(())
            },
            |_| {
                assert!(!next_path.exists());
                std::fs::write(&next_path, b"next export").unwrap();
                emitted.set(true);
            },
        );
        tokio::pin!(completion);
        tokio::select! {
            _ = &mut completion => panic!("completion must wait for session cleanup"),
            _ = tokio::task::yield_now() => {},
        }
        assert!(!emitted.get());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"partial export");
        allow_close.send(()).unwrap();
        completion.await.unwrap();
        assert!(emitted.get());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"next export");
        tokio::fs::remove_file(&path).await.unwrap();
    }

    #[test]
    fn holds_success_and_error_progress_until_finalization() {
        for status in [ExportStatus::Done, ExportStatus::Error] {
            let terminal = Mutex::new(None);
            route_core_progress(progress(status), &terminal, |_| {
                panic!("completion must not be emitted before cleanup");
            });
            assert!(terminal.into_inner().unwrap().is_some());
        }
    }

    async fn create_export_file(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("dbx-table-export-{name}-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"partial export").await.unwrap();
        path
    }

    #[tokio::test]
    async fn removes_export_file_after_cancellation() {
        let path = create_export_file("cancelled").await;

        remove_incomplete_export(path.to_str().unwrap(), false, true).await.unwrap();

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn removes_export_file_after_error() {
        let path = create_export_file("failed").await;

        remove_incomplete_export(path.to_str().unwrap(), true, false).await.unwrap();

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn preserves_successful_export_file() {
        let path = create_export_file("completed").await;

        remove_incomplete_export(path.to_str().unwrap(), false, false).await.unwrap();

        assert!(path.exists());
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_failure_never_emits_a_releasable_terminal() {
        let emitted = std::cell::Cell::new(false);
        let path = create_export_file("close-failed").await;
        let result = finalize_export(
            "queued-export",
            path.to_str().unwrap(),
            Ok(()),
            Some(progress(ExportStatus::Cancelled)),
            async { Err("session close unknown".to_string()) },
            |_| emitted.set(true),
        )
        .await;
        assert_eq!(result.unwrap_err(), "session close unknown");
        assert!(!emitted.get());
        assert!(!path.exists());

        let directory = std::env::temp_dir().join(format!("dbx-delete-failure-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&directory).await.unwrap();
        let result = finalize_export(
            "queued-export",
            directory.to_str().unwrap(),
            Err("write failed".to_string()),
            None,
            async { Ok(()) },
            |_| emitted.set(true),
        )
        .await;
        assert!(result.is_err());
        assert!(!emitted.get());
        tokio::fs::remove_dir(directory).await.unwrap();
    }
}
