use std::sync::Arc;
use tauri::State;

use dbx_core::connection::AppState;

#[tauri::command]
pub async fn save_schema_cache(
    state: State<'_, Arc<AppState>>,
    cache_key: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    state.storage.save_schema_cache(&cache_key, &payload).await
}

#[tauri::command]
pub async fn load_schema_cache(
    state: State<'_, Arc<AppState>>,
    cache_key: String,
) -> Result<Option<serde_json::Value>, String> {
    state.storage.load_schema_cache(&cache_key).await
}

#[tauri::command]
pub async fn delete_schema_cache_prefix(state: State<'_, Arc<AppState>>, prefix: String) -> Result<(), String> {
    state.storage.delete_schema_cache_prefix(&prefix).await
}
