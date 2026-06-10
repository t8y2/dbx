use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

use crate::commands::connection::{ensure_connection_writable, AppState};
use crate::commands::transfer::get_db_type;

// Re-export types for backward compatibility
pub use dbx_core::table_import::{TableImportPreview, TableImportProgress, TableImportRequest, TableImportSummary};

static CANCELLED_IMPORTS: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();

fn cancelled_imports() -> &'static RwLock<HashSet<String>> {
    CANCELLED_IMPORTS.get_or_init(|| RwLock::new(HashSet::new()))
}

fn emit_progress(app: &AppHandle, progress: TableImportProgress) {
    let _ = app.emit("table-import-progress", progress);
}

async fn is_cancelled(import_id: &str) -> bool {
    cancelled_imports().read().await.contains(import_id)
}

async fn clear_cancelled(import_id: &str) {
    cancelled_imports().write().await.remove(import_id);
}

#[tauri::command]
pub async fn preview_table_import_file(file_path: String) -> Result<TableImportPreview, String> {
    dbx_core::table_import::preview_table_import_file_core(&file_path).await
}

#[tauri::command]
pub async fn import_table_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TableImportRequest,
) -> Result<TableImportSummary, String> {
    clear_cancelled(&request.import_id).await;
    // Reject import early if the connection is read-only — importing is inherently a write operation
    ensure_connection_writable(&state, &request.connection_id, "Import").await?;
    let db_type = get_db_type(&state, &request.connection_id).await?;
    let pool_key = if request.database.is_empty() {
        request.connection_id.clone()
    } else {
        state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?
    };

    let result = dbx_core::table_import::import_table_file_core(
        &state,
        &request,
        &db_type,
        &pool_key,
        |import_id| Box::pin(is_cancelled(import_id)),
        |progress| emit_progress(&app, progress),
    )
    .await;

    clear_cancelled(&request.import_id).await;
    result
}

#[tauri::command]
pub async fn cancel_table_import(import_id: String) -> Result<bool, String> {
    cancelled_imports().write().await.insert(import_id);
    Ok(true)
}
