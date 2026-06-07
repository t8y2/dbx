use std::sync::Arc;
use tauri::State;

use super::connection::AppState;
pub use dbx_core::history::HistoryEntry;

#[tauri::command]
pub async fn save_history(state: State<'_, Arc<AppState>>, entry: HistoryEntry) -> Result<(), String> {
    state.storage.save_history_entry(&entry).await
}

#[tauri::command]
pub async fn load_history(
    state: State<'_, Arc<AppState>>,
    limit: usize,
    offset: usize,
) -> Result<Vec<HistoryEntry>, String> {
    state.storage.load_history_entries(limit, offset).await
}

#[tauri::command]
pub async fn clear_history(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.storage.clear_history().await
}

#[tauri::command]
pub async fn delete_history_entry(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_history_entry(&id).await
}
