use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

use crate::commands::connection::{ensure_connection_writable, AppState};

pub use dbx_core::mongodb_import_export::{
    MongoExportProgress, MongoExportRequest, MongoExportSummary, MongoImportPreview, MongoImportPreviewRequest,
    MongoImportProgress, MongoImportRequest, MongoImportSummary,
};

static CANCELLED_IMPORTS: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();

fn cancelled_imports() -> &'static RwLock<HashSet<String>> {
    CANCELLED_IMPORTS.get_or_init(|| RwLock::new(HashSet::new()))
}

fn emit_import_progress(app: &AppHandle, progress: MongoImportProgress) {
    let _ = app.emit("mongo-import-progress", progress);
}

fn emit_export_progress(app: &AppHandle, progress: MongoExportProgress) {
    let _ = app.emit("mongo-export-progress", progress);
}

async fn is_cancelled(import_id: &str) -> bool {
    cancelled_imports().read().await.contains(import_id)
}

async fn clear_cancelled(import_id: &str) {
    cancelled_imports().write().await.remove(import_id);
}

#[tauri::command]
pub async fn preview_mongodb_import_file(request: MongoImportPreviewRequest) -> Result<MongoImportPreview, String> {
    dbx_core::mongodb_import_export::preview_mongodb_import_file_core(request).await
}

#[tauri::command]
pub async fn import_mongodb_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: MongoImportRequest,
) -> Result<MongoImportSummary, String> {
    clear_cancelled(&request.import_id).await;
    ensure_connection_writable(&state, &request.connection_id, "Import").await?;
    let result = dbx_core::mongodb_import_export::import_mongodb_file_core(
        &state,
        &request,
        |import_id| {
            let import_id = import_id.to_string();
            Box::pin(async move { is_cancelled(&import_id).await })
        },
        |progress| emit_import_progress(&app, progress),
    )
    .await
    .map_err(|error| error.display_message());
    clear_cancelled(&request.import_id).await;
    result
}

#[tauri::command]
pub async fn cancel_mongodb_import(import_id: String) -> Result<bool, String> {
    cancelled_imports().write().await.insert(import_id);
    Ok(true)
}

#[tauri::command]
pub async fn export_mongodb_query(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: MongoExportRequest,
) -> Result<MongoExportSummary, String> {
    dbx_core::mongodb_import_export::export_mongodb_query_core(
        &state,
        &request,
        |export_id| {
            let export_id = export_id.to_string();
            Box::pin(async move { dbx_core::transfer::is_cancelled(&export_id).await })
        },
        |progress| emit_export_progress(&app, progress),
    )
    .await
}

#[tauri::command]
pub async fn cancel_mongodb_export(export_id: String) -> Result<bool, String> {
    dbx_core::transfer::set_cancelled(&export_id).await;
    Ok(true)
}
