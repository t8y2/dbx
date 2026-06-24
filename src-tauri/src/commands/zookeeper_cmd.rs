use std::sync::Arc;

use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::agent_kv::{KvDeleteResponse, KvGetResponse, KvListPrefixResponse, KvPutOptions, KvPutResponse, KvValue};

#[tauri::command]
pub async fn zookeeper_list_prefix(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
    limit: usize,
    continuation: Option<String>,
) -> Result<KvListPrefixResponse, String> {
    dbx_core::agent_kv::kv_list_prefix_core(&state, &connection_id, &prefix, limit, continuation.as_deref()).await
}

#[tauri::command]
pub async fn zookeeper_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<KvGetResponse, String> {
    dbx_core::agent_kv::kv_get_core(&state, &connection_id, &key).await
}

#[tauri::command]
pub async fn zookeeper_put(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    value: KvValue,
    options: Option<KvPutOptions>,
) -> Result<KvPutResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Put").await?;
    dbx_core::agent_kv::kv_put_core_with_options(&state, &connection_id, &key, value, options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn zookeeper_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<KvDeleteResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Delete").await?;
    dbx_core::agent_kv::kv_delete_core(&state, &connection_id, &key).await
}
