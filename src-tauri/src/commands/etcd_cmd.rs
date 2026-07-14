use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_write_allowed, AppState};
use dbx_core::agent_kv::{KvDeleteResponse, KvGetResponse, KvListPrefixResponse, KvPutResponse, KvValue};

#[tauri::command]
pub async fn etcd_list_prefix(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
    limit: usize,
    continuation: Option<String>,
) -> Result<KvListPrefixResponse, String> {
    dbx_core::agent_kv::kv_list_prefix_core(&state, &connection_id, &prefix, limit, continuation.as_deref()).await
}

#[tauri::command]
pub async fn etcd_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<KvGetResponse, String> {
    dbx_core::agent_kv::kv_get_core(&state, &connection_id, &key).await
}

#[tauri::command]
pub async fn etcd_put(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    value: KvValue,
    lease: Option<i64>,
    production_write_authorization: Option<dbx_core::production_safety::ProductionWriteAuthorization>,
) -> Result<KvPutResponse, String> {
    ensure_connection_write_allowed(
        &state,
        &connection_id,
        None,
        "etcdPut",
        "Put",
        production_write_authorization.as_ref(),
    )
    .await?;
    dbx_core::agent_kv::kv_put_core(&state, &connection_id, &key, value, lease).await
}

#[tauri::command]
pub async fn etcd_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    production_write_authorization: Option<dbx_core::production_safety::ProductionWriteAuthorization>,
) -> Result<KvDeleteResponse, String> {
    ensure_connection_write_allowed(
        &state,
        &connection_id,
        None,
        "etcdDelete",
        "Delete",
        production_write_authorization.as_ref(),
    )
    .await?;
    dbx_core::agent_kv::kv_delete_core(&state, &connection_id, &key).await
}
