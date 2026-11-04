use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::database_export::{DatabaseBackupSnapshot, DatabaseExportRequest, ExportProgress, ExportStatus};

fn emit_progress(app: &AppHandle, progress: ExportProgress) {
    let _ = app.emit("database-export-progress", progress);
}

fn route_core_progress(
    progress: ExportProgress,
    terminal: &Mutex<Option<ExportProgress>>,
    emit: impl FnOnce(ExportProgress),
) {
    if matches!(progress.status, ExportStatus::Done | ExportStatus::Error | ExportStatus::Cancelled) {
        *terminal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(progress);
    } else {
        emit(progress);
    }
}

async fn finalize_export(
    export_id: &str,
    result: Result<(), String>,
    terminal: Option<ExportProgress>,
    close_session: impl std::future::Future<Output = Result<(), String>>,
    emit: impl FnOnce(ExportProgress),
) -> Result<(), String> {
    close_session.await?;
    dbx_core::database_export::clear_export_cancelled(export_id).await;
    if let Err(error) = result {
        emit(ExportProgress {
            export_id: export_id.to_string(),
            current_object: String::new(),
            object_index: 0,
            total_objects: 0,
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Error,
            error: Some(error),
            preparing: false,
            error_count: 0,
            error_summary: None,
        });
    } else if let Some(progress) = terminal {
        emit(progress);
    }
    Ok(())
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
    dbx_core::query::mysql_data_charset_policy::reject_operation(
        &state,
        &request.connection_id,
        dbx_core::query::mysql_data_charset_policy::EXPORT_UNSUPPORTED,
    )
    .await?;
    let state = state.inner().clone();
    let export_id = request.export_id.clone();

    // Exports interleave async fetches with synchronous row formatting and
    // buffered disk writes; run them off the async workers (see spawn_export_task).
    dbx_core::export_runtime::spawn_export_task(async move {
        let terminal = Mutex::new(None);
        let result = dbx_core::database_export::export_database_sql_core(&state, &request, |progress| {
            route_core_progress(progress, &terminal, |progress| emit_progress(&app, progress));
        })
        .await;

        let client_session_id = dbx_core::database_export::database_export_client_session_id(&export_id);
        let terminal = terminal.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
        let completion = finalize_export(
            &export_id,
            result,
            terminal,
            async {
                state
                    .close_client_session_pool_with_completion(
                        &request.connection_id,
                        Some(&request.database),
                        &client_session_id,
                    )
                    .await
                    .map(|_| ())
            },
            |progress| emit_progress(&app, progress),
        )
        .await;
        if let Err(error) = completion {
            let _ = app.emit(
                "database-export-progress",
                serde_json::json!({
                    "exportId": export_id, "currentObject": "", "objectIndex": 0, "totalObjects": 0,
                    "rowsExported": 0, "totalRows": null, "status": "Unknown", "error": error,
                }),
            );
        }
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

/// Returns whether a scheduled backup destination must be explicitly selected
/// again before DBX can replace a legacy macOS filesystem identity.
#[tauri::command]
pub async fn database_export_destination_needs_confirmation(
    state: State<'_, Arc<AppState>>,
    directory: String,
) -> Result<bool, String> {
    dbx_core::database_export::export_destination_identity_needs_confirmation(&state, std::path::Path::new(&directory))
        .await
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

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(status: ExportStatus) -> ExportProgress {
        ExportProgress {
            export_id: "queued-database".to_string(),
            current_object: "source".to_string(),
            object_index: 1,
            total_objects: 1,
            rows_exported: 1,
            total_rows: Some(1),
            status,
            error: None,
            preparing: false,
            error_count: 0,
            error_summary: None,
        }
    }

    #[test]
    fn forwards_running_progress() {
        let terminal = Mutex::new(None);
        let mut emitted = Vec::new();
        route_core_progress(progress(ExportStatus::Running), &terminal, |progress| emitted.push(progress));
        assert_eq!(emitted.len(), 1);
        assert!(terminal.into_inner().unwrap().is_none());
    }

    #[test]
    fn holds_terminal_progress_until_session_cleanup() {
        for status in [ExportStatus::Done, ExportStatus::Error, ExportStatus::Cancelled] {
            let terminal = Mutex::new(None);
            route_core_progress(progress(status), &terminal, |_| {
                panic!("completion must not be emitted before session cleanup");
            });
            assert!(terminal.into_inner().unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn finalization_waits_for_the_database_session_to_close() {
        let (allow_close, closing) = tokio::sync::oneshot::channel();
        let emitted = std::cell::Cell::new(false);
        let completion = finalize_export(
            "queued-database",
            Ok(()),
            Some(progress(ExportStatus::Done)),
            async {
                closing.await.unwrap();
                Ok(())
            },
            |_| {
                emitted.set(true);
            },
        );
        tokio::pin!(completion);
        tokio::select! {
            _ = &mut completion => panic!("completion must wait for database session cleanup"),
            _ = tokio::task::yield_now() => {},
        }
        assert!(!emitted.get());
        allow_close.send(()).unwrap();
        completion.await.unwrap();
        assert!(emitted.get());
    }

    #[tokio::test]
    async fn close_failure_never_emits_a_releasable_terminal() {
        let emitted = std::cell::Cell::new(false);
        let result = finalize_export(
            "queued-database",
            Ok(()),
            Some(progress(ExportStatus::Done)),
            async { Err("session close unknown".to_string()) },
            |_| emitted.set(true),
        )
        .await;
        assert_eq!(result.unwrap_err(), "session close unknown");
        assert!(!emitted.get());
    }
}
