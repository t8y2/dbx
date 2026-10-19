use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::connection::AppState;
pub use dbx_core::history::{HistoryConnectionOption, HistoryEntry, HistorySearchRequest, HistorySearchResult};

#[tauri::command]
pub async fn save_history(app: AppHandle, state: State<'_, Arc<AppState>>, entry: HistoryEntry) -> Result<(), String> {
    state.storage.save_history_entry(&entry).await?;
    let _ = app.emit("dbx:history-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn load_history(
    state: State<'_, Arc<AppState>>,
    limit: usize,
    offset: usize,
    activity_kind: Option<String>,
) -> Result<Vec<HistoryEntry>, String> {
    state.storage.load_history_entries(limit, offset, activity_kind).await
}

#[tauri::command]
pub async fn search_history(
    state: State<'_, Arc<AppState>>,
    request: HistorySearchRequest,
) -> Result<HistorySearchResult, String> {
    state.storage.search_history_entries(request).await
}

#[tauri::command]
pub async fn load_history_connection_options(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<HistoryConnectionOption>, String> {
    state.storage.load_history_connection_options().await
}

#[tauri::command]
pub async fn clear_history(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.storage.clear_history().await?;
    let _ = app.emit("dbx:history-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn clear_history_by_source(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    source: String,
) -> Result<(), String> {
    state.storage.clear_history_by_source(&source).await?;
    let _ = app.emit("dbx:history-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn cleanup_mcp_history_retention(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    let removed = state.storage.cleanup_mcp_history_retention().await?;
    if removed > 0 {
        let _ = app.emit("dbx:history-changed", ());
    }
    Ok(removed)
}

#[tauri::command]
pub async fn delete_history_entry(app: AppHandle, state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_history_entry(&id).await?;
    let _ = app.emit("dbx:history-changed", ());
    Ok(())
}
