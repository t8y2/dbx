use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_core::connection::AppState;
use serde::{Deserialize, Serialize};
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
    pub created_at: i64,
    pub last_accessed_at: i64,
    pub owner_id: Option<String>,
}

#[tauri::command]
pub async fn save_tab_runtime_cache(
    state: State<'_, Arc<AppState>>,
    key: String,
    payload_base64: String,
    row_count: i64,
    column_count: i64,
    owner_id: Option<String>,
) -> Result<(), String> {
    let payload = BASE64.decode(payload_base64).map_err(|e| e.to_string())?;
    state.storage.save_tab_runtime_cache(&key, payload, row_count, column_count, owner_id).await
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
        created_at: entry.created_at,
        last_accessed_at: entry.last_accessed_at,
        owner_id: entry.owner_id,
    }))
}

#[tauri::command]
pub async fn list_tab_runtime_cache_metadata(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<dbx_core::storage::TabRuntimeCacheMetadata>, String> {
    state.storage.list_tab_runtime_cache_metadata().await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneTabRuntimeCacheRequest {
    pub live_keys: Vec<String>,
    pub max_bytes: i64,
    pub orphan_grace_ms: i64,
    pub max_age_ms: Option<i64>,
}

#[tauri::command]
pub async fn prune_tab_runtime_cache(
    state: State<'_, Arc<AppState>>,
    request: PruneTabRuntimeCacheRequest,
) -> Result<dbx_core::storage::TabRuntimeCachePruneResult, String> {
    state
        .storage
        .prune_tab_runtime_cache(request.live_keys, request.max_bytes, request.orphan_grace_ms, request.max_age_ms)
        .await
}

#[tauri::command]
pub async fn delete_tab_runtime_cache_owner(
    state: State<'_, Arc<AppState>>,
    owner_id: String,
) -> Result<usize, String> {
    state.storage.delete_tab_runtime_cache_owner(&owner_id).await
}

#[tauri::command]
pub async fn delete_tab_runtime_cache(state: State<'_, Arc<AppState>>, key: String) -> Result<(), String> {
    state.storage.delete_tab_runtime_cache(&key).await
}
