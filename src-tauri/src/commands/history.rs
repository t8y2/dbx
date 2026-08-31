use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::connection::AppState;
pub use dbx_core::history::{HistoryConnectionOption, HistoryEntry, HistorySearchRequest, HistorySearchResult};

pub const HISTORY_CHANGED_EVENT: &str = "dbx:history-changed";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryChangedEvent {
    operation: &'static str,
}

fn emit_history_changed(app: &AppHandle, operation: &'static str) {
    // History persistence is authoritative. A missed UI event only leaves a
    // view stale until it opens or refreshes its panel, so never roll back a
    // completed storage mutation because one WebView closed mid-broadcast.
    let _ = app.emit(HISTORY_CHANGED_EVENT, HistoryChangedEvent { operation });
}

#[tauri::command]
pub async fn save_history(app: AppHandle, state: State<'_, Arc<AppState>>, entry: HistoryEntry) -> Result<(), String> {
    state.storage.save_history_entry(&entry).await?;
    emit_history_changed(&app, "saved");
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
    emit_history_changed(&app, "cleared");
    Ok(())
}

#[tauri::command]
pub async fn delete_history_entry(app: AppHandle, state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_history_entry(&id).await?;
    emit_history_changed(&app, "deleted");
    Ok(())
}
