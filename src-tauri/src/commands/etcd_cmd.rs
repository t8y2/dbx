use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::agent_kv::{
    EtcdDefragResponse, EtcdLeaseListResponse, EtcdPreflightRequest, EtcdPreflightResponse, EtcdWatchPollResponse,
    EtcdWatchStartRequest, EtcdWatchStartResponse, KvDeleteOptions, KvDeleteResponse, KvGetOptions, KvGetResponse,
    KvHistoryRequest, KvHistoryResponse, KvInt64, KvListPrefixResponse, KvPutOptions, KvPutResponse, KvRangeOptions,
    KvRenameRequest, KvRenameResponse, KvStatusResponse, KvValue,
};
use dbx_core::db::agent_driver::AgentKvMethod;

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

#[tauri::command]
pub async fn etcd_preflight(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: EtcdPreflightRequest,
) -> Result<EtcdPreflightResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Dangerous etcd operation").await?;
    dbx_core::agent_kv::etcd_preflight_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn etcd_compact(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    revision: KvInt64,
    preflight_token: String,
    confirmation_text: String,
) -> Result<serde_json::Value, String> {
    ensure_connection_writable(&state, &connection_id, "Compact").await?;
    let params = serde_json::json!({ "revision": revision.clone() });
    dbx_core::agent_kv::etcd_consume_preflight_core(
        &state,
        &connection_id,
        "compact",
        &params,
        &preflight_token,
        &confirmation_text,
    )
    .await?;
    dbx_core::agent_kv::etcd_compact_core(&state, &connection_id, revision).await
}

#[tauri::command]
pub async fn etcd_defrag(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    endpoints: Vec<String>,
    preflight_token: String,
    confirmation_text: String,
) -> Result<EtcdDefragResponse, String> {
    ensure_connection_writable(&state, &connection_id, "Defrag").await?;
    let params = serde_json::json!({ "endpoints": endpoints.clone() });
    dbx_core::agent_kv::etcd_consume_preflight_core(
        &state,
        &connection_id,
        "defrag",
        &params,
        &preflight_token,
        &confirmation_text,
    )
    .await?;
    dbx_core::agent_kv::etcd_defrag_core(&state, &connection_id, endpoints).await
}

#[tauri::command]
pub async fn etcd_watch_start(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: EtcdWatchStartRequest,
) -> Result<EtcdWatchStartResponse, String> {
    dbx_core::agent_kv::etcd_watch_start_core(&state, &connection_id, request).await
}

#[tauri::command]
pub async fn etcd_watch_poll(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    watch_id: String,
) -> Result<EtcdWatchPollResponse, String> {
    dbx_core::agent_kv::etcd_watch_poll_core(&state, &connection_id, &watch_id).await
}

#[tauri::command]
pub async fn etcd_watch_stop(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    watch_id: String,
) -> Result<serde_json::Value, String> {
    dbx_core::agent_kv::etcd_watch_stop_core(&state, &connection_id, &watch_id).await
}

#[tauri::command]
pub async fn etcd_lease_list(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    limit: Option<usize>,
    continuation: Option<String>,
) -> Result<EtcdLeaseListResponse, String> {
    dbx_core::agent_kv::etcd_lease_list_core(&state, &connection_id, limit.unwrap_or(100), continuation.as_deref())
        .await
}

#[tauri::command]
pub async fn etcd_lease_call(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    operation: String,
    params: serde_json::Value,
    preflight_token: Option<String>,
    confirmation_text: Option<String>,
) -> Result<serde_json::Value, String> {
    let (method, write) = match operation.as_str() {
        "get" => (AgentKvMethod::LeaseGet, false),
        "grant" => (AgentKvMethod::LeaseGrant, true),
        "keepalive" => (AgentKvMethod::LeaseKeepalive, true),
        "revoke" => (AgentKvMethod::LeaseRevoke, true),
        _ => return Err("Unsupported etcd lease operation".to_string()),
    };
    if write {
        ensure_connection_writable(&state, &connection_id, "Lease operation").await?;
    }
    if operation == "revoke" {
        dbx_core::agent_kv::etcd_consume_preflight_core(
            &state,
            &connection_id,
            "lease_revoke",
            &params,
            preflight_token.as_deref().ok_or("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation")?,
            confirmation_text.as_deref().ok_or("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation")?,
        )
        .await?;
    }
    dbx_core::agent_kv::etcd_lease_call_core(&state, &connection_id, method, params).await
}

#[tauri::command]
pub async fn etcd_auth_call(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    operation: String,
    params: serde_json::Value,
    preflight_token: Option<String>,
    confirmation_text: Option<String>,
) -> Result<serde_json::Value, String> {
    let (method, write) = match operation.as_str() {
        "user_list" => (AgentKvMethod::AuthUserList, false),
        "user_get" => (AgentKvMethod::AuthUserGet, false),
        "user_add" => (AgentKvMethod::AuthUserAdd, true),
        "user_delete" => (AgentKvMethod::AuthUserDelete, true),
        "user_change_password" => (AgentKvMethod::AuthUserChangePassword, true),
        "user_grant_role" => (AgentKvMethod::AuthUserGrantRole, true),
        "user_revoke_role" => (AgentKvMethod::AuthUserRevokeRole, true),
        "role_list" => (AgentKvMethod::AuthRoleList, false),
        "role_get" => (AgentKvMethod::AuthRoleGet, false),
        "role_add" => (AgentKvMethod::AuthRoleAdd, true),
        "role_delete" => (AgentKvMethod::AuthRoleDelete, true),
        "role_grant_permission" => (AgentKvMethod::AuthRoleGrantPermission, true),
        "role_revoke_permission" => (AgentKvMethod::AuthRoleRevokePermission, true),
        _ => return Err("Unsupported etcd Auth operation".to_string()),
    };
    if write {
        ensure_connection_writable(&state, &connection_id, "Auth operation").await?;
    }
    if let Some(action) = auth_preflight_action(&operation) {
        dbx_core::agent_kv::etcd_consume_preflight_core(
            &state,
            &connection_id,
            action,
            &params,
            preflight_token.as_deref().ok_or("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation")?,
            confirmation_text.as_deref().ok_or("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation")?,
        )
        .await?;
    }
    dbx_core::agent_kv::etcd_auth_call_core(&state, &connection_id, method, params).await
}

fn auth_preflight_action(operation: &str) -> Option<&'static str> {
    match operation {
        "user_add" => Some("auth_user_add"),
        "user_delete" => Some("auth_user_delete"),
        "user_change_password" => Some("auth_user_change_password"),
        "user_grant_role" => Some("auth_user_grant_role"),
        "user_revoke_role" => Some("auth_user_revoke_role"),
        "role_add" => Some("auth_role_add"),
        "role_delete" => Some("auth_role_delete"),
        "role_grant_permission" => Some("auth_role_grant_permission"),
        "role_revoke_permission" => Some("auth_role_revoke_permission"),
        _ => None,
    }
}
