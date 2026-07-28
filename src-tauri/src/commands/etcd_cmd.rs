use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::agent_kv::{
    KvDeleteOptions, KvDeleteResponse, KvGetOptions, KvGetResponse, KvHistoryRequest, KvHistoryResponse, KvInt64,
    KvListPrefixResponse, KvPutOptions, KvPutResponse, KvRangeOptions, KvRenameRequest, KvRenameResponse,
    KvStatusResponse, KvValue,
};

#[tauri::command]
pub async fn etcd_list_prefix(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
    limit: usize,
    continuation: Option<String>,
    revision: Option<KvInt64>,
    include_values: Option<bool>,
) -> Result<KvListPrefixResponse, String> {
    dbx_core::agent_kv::kv_list_prefix_core_with_range_options(
        &state,
        &connection_id,
        &prefix,
        limit,
        continuation.as_deref(),
        KvRangeOptions { revision, include_values },
    )
    .await
}

#[tauri::command]
pub async fn etcd_supports_ttl(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<bool, String> {
    dbx_core::agent_kv::kv_supports_ttl_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn etcd_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    key_bytes: Option<KvValue>,
    revision: Option<KvInt64>,
    metadata_only: Option<bool>,
) -> Result<KvGetResponse, String> {
    dbx_core::agent_kv::kv_get_core_with_options(
        &state,
        &connection_id,
        &key,
        KvGetOptions { key_bytes, revision, metadata_only },
    )
    .await
}

#[tauri::command]
pub async fn etcd_put(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    value: KvValue,
    lease: Option<KvInt64>,
    ttl: Option<i64>,
    preserve_lease: Option<bool>,
    key_bytes: Option<KvValue>,
    expected_mod_revision: Option<KvInt64>,
    expected_create_revision: Option<KvInt64>,
) -> Result<KvPutResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Put").await?;
    dbx_core::agent_kv::kv_put_core_with_options(
        &state,
        &connection_id,
        &key,
        value,
        KvPutOptions {
            lease,
            ttl,
            preserve_lease,
            key_bytes,
            expected_mod_revision,
            expected_create_revision,
            ..KvPutOptions::default()
        },
    )
    .await
}

#[tauri::command]
pub async fn etcd_delete(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    key_bytes: Option<KvValue>,
    expected_mod_revision: Option<KvInt64>,
) -> Result<KvDeleteResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Delete").await?;
    dbx_core::agent_kv::kv_delete_core_with_options(
        &state,
        &connection_id,
        &key,
        KvDeleteOptions { key_bytes, expected_mod_revision },
    )
    .await
}

#[tauri::command]
pub async fn etcd_rename(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: KvRenameRequest,
) -> Result<KvRenameResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Rename").await?;
    dbx_core::agent_kv::kv_rename_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn etcd_history(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: KvHistoryRequest,
) -> Result<KvHistoryResponse, String> {
    dbx_core::agent_kv::kv_history_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn etcd_status(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<KvStatusResponse, String> {
    dbx_core::agent_kv::kv_status_core(&state, &connection_id).await
}
