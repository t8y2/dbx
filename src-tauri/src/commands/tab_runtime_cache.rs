use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_core::connection::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTabRuntimeCacheResponse {
    pub key: String,
    pub payload_base64: String,
    pub row_count: i64,
    pub column_count: i64,
    pub byte_size: i64,
    pub updated_at: String,
}

#[tauri::command]
pub async fn save_tab_runtime_cache(
    state: State<'_, Arc<AppState>>,
    key: String,
    payload_base64: String,
    row_count: i64,
    column_count: i64,
) -> Result<(), String> {
    let payload = BASE64.decode(payload_base64).map_err(|e| e.to_string())?;
    state.storage.save_tab_runtime_cache(&key, payload, row_count, column_count).await
}

#[tauri::command]
pub async fn load_tab_runtime_cache(
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Option<LoadTabRuntimeCacheResponse>, String> {
    let entry = state.storage.load_tab_runtime_cache(&key).await?;
    Ok(entry.map(|entry| LoadTabRuntimeCacheResponse {
        key: entry.key,
        payload_base64: BASE64.encode(entry.payload),
        row_count: entry.row_count,
        column_count: entry.column_count,
        byte_size: entry.byte_size,
        updated_at: entry.updated_at,
    }))
}

#[tauri::command]
pub async fn delete_tab_runtime_cache(state: State<'_, Arc<AppState>>, key: String) -> Result<(), String> {
    state.storage.delete_tab_runtime_cache(&key).await
}
