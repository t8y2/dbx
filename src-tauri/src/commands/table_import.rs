use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

use crate::commands::connection::{ensure_connection_writable, AppState};
use crate::commands::transfer::get_db_type;

// Re-export types for backward compatibility
pub use dbx_core::table_import::{
    TableImportPreview, TableImportPreviewRequest, TableImportProgress, TableImportRequest, TableImportSummary,
};

static CANCELLED_IMPORTS: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();

fn cancelled_imports() -> &'static RwLock<HashSet<String>> {
    CANCELLED_IMPORTS.get_or_init(|| RwLock::new(HashSet::new()))
}

fn emit_progress(app: &AppHandle, progress: TableImportProgress) {
    let _ = app.emit("table-import-progress", progress);
}

fn split_command_progress(
    mut progress: TableImportProgress,
) -> (Option<TableImportProgress>, Option<TableImportProgress>) {
    // Core import completion precedes session-pool cleanup. Publish a synthetic finalizing
    // state first so the UI cannot show 100% until command-level cleanup has finished.
    match progress.status {
        dbx_core::table_import::TableImportStatus::Running => (Some(progress), None),
        dbx_core::table_import::TableImportStatus::Done => {
            let terminal = progress.clone();
            progress.status = dbx_core::table_import::TableImportStatus::Running;
            progress.phase = dbx_core::table_import::TableImportPhase::Finalizing;
            (Some(progress), Some(terminal))
        }
        dbx_core::table_import::TableImportStatus::Error | dbx_core::table_import::TableImportStatus::Cancelled => {
            (None, Some(progress))
        }
    }
}

async fn is_cancelled(import_id: &str) -> bool {
    cancelled_imports().read().await.contains(import_id)
}

async fn clear_cancelled(import_id: &str) {
    cancelled_imports().write().await.remove(import_id);
}

#[tauri::command]
pub async fn preview_table_import_file(request: TableImportPreviewRequest) -> Result<TableImportPreview, String> {
    dbx_core::table_import::preview_table_import_file_with_request(request).await
}

#[tauri::command]
pub async fn import_table_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TableImportRequest,
) -> Result<TableImportSummary, String> {
    let command_started_at = Instant::now();
    clear_cancelled(&request.import_id).await;
    // Reject import early if the connection is read-only — importing is inherently a write operation
    ensure_connection_writable(&state, &request.connection_id, "Import").await?;
    let db_type = get_db_type(&state, &request.connection_id).await?;
    let database = (!request.database.trim().is_empty()).then_some(request.database.as_str());
    let client_session_id = dbx_core::table_import::table_import_client_session_id(&request.import_id);
    let pool_key =
        state.get_or_create_pool_for_session(&request.connection_id, database, Some(&client_session_id)).await?;

    let core_started_at = Instant::now();
    let mut deferred_terminal = None;
    let mut result = dbx_core::table_import::import_table_file_core(
        &state,
        &request,
        &db_type,
        &pool_key,
        |import_id| Box::pin(is_cancelled(import_id)),
        |progress| {
            let (immediate, terminal) = split_command_progress(progress);
            if let Some(progress) = immediate {
                emit_progress(&app, progress);
            }
            if terminal.is_some() {
                deferred_terminal = terminal;
            }
        },
    )
    .await;
    let core_ms = core_started_at.elapsed().as_millis();

    let cleanup_started_at = Instant::now();
    let detached = state.detach_client_session_pool(&request.connection_id, database, &client_session_id).await;
    let cleanup_detach_ms = cleanup_started_at.elapsed().as_millis();
    log::info!(
        "[table-import:cleanup] import_id={} cleanup_detach_ms={} pool_detached={}",
        request.import_id,
        cleanup_detach_ms,
        detached.unwrap_or(false)
    );

    let command_ms = command_started_at.elapsed().as_millis();
    if let Some(mut terminal) = deferred_terminal {
        terminal.elapsed_ms = terminal.elapsed_ms.max(command_ms);
        emit_progress(&app, terminal);
    }
    if let Ok(summary) = &mut result {
        summary.elapsed_ms = summary.elapsed_ms.max(command_ms);
    }
    clear_cancelled(&request.import_id).await;
    log::info!(
        "[table-import:command] import_id={} core_ms={} command_ms={} cleanup_detach_ms={} cleanup_scheduled=true",
        request.import_id,
        core_ms,
        command_ms,
        cleanup_detach_ms
    );
    result
}

#[tauri::command]
pub async fn cancel_table_import(import_id: String) -> Result<bool, String> {
    cancelled_imports().write().await.insert(import_id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::table_import::{TableImportPhase, TableImportStatus};

    fn progress(status: TableImportStatus) -> TableImportProgress {
        TableImportProgress {
            import_id: "import-1".to_string(),
            status,
            phase: TableImportPhase::Done,
            rows_imported: 10,
            total_rows: 10,
            total_rows_exact: true,
            bytes_read: 100,
            total_bytes: 100,
            elapsed_ms: 25,
            error: None,
        }
    }

    #[test]
    fn successful_core_terminal_is_finalizing_until_command_cleanup_finishes() {
        let (immediate, terminal) = split_command_progress(progress(TableImportStatus::Done));

        let immediate = immediate.expect("finalizing progress");
        assert_eq!(immediate.status, TableImportStatus::Running);
        assert_eq!(immediate.phase, TableImportPhase::Finalizing);
        assert_eq!(terminal.expect("deferred terminal").status, TableImportStatus::Done);
    }

    #[test]
    fn error_and_cancelled_terminals_are_deferred_without_fake_running_events() {
        for status in [TableImportStatus::Error, TableImportStatus::Cancelled] {
            let (immediate, terminal) = split_command_progress(progress(status));
            assert!(immediate.is_none());
            assert_eq!(terminal.expect("deferred terminal").status, status);
        }
    }
}
