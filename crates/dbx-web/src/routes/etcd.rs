use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;
use dbx_core::db::agent_driver::AgentKvMethod;

/// Check if a connection is read-only and return an error if so.
async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdListPrefixRequest {
    pub connection_id: String,
    pub prefix: String,
    pub limit: usize,
    pub continuation: Option<String>,
    pub revision: Option<dbx_core::agent_kv::KvInt64>,
    pub include_values: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdKeyRequest {
    pub connection_id: String,
    pub key: String,
    pub key_bytes: Option<dbx_core::agent_kv::KvValue>,
    pub revision: Option<dbx_core::agent_kv::KvInt64>,
    pub metadata_only: Option<bool>,
    pub expected_mod_revision: Option<dbx_core::agent_kv::KvInt64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdPutRequest {
    pub connection_id: String,
    pub key: String,
    pub value: dbx_core::agent_kv::KvValue,
    pub lease: Option<dbx_core::agent_kv::KvInt64>,
    pub ttl: Option<i64>,
    pub preserve_lease: Option<bool>,
    pub key_bytes: Option<dbx_core::agent_kv::KvValue>,
    pub expected_mod_revision: Option<dbx_core::agent_kv::KvInt64>,
    pub expected_create_revision: Option<dbx_core::agent_kv::KvInt64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdConnectionRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdLeaseListRequest {
    pub connection_id: String,
    pub limit: Option<usize>,
    pub continuation: Option<String>,
}

pub async fn supports_ttl(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdConnectionRequest>,
) -> Result<Json<bool>, AppError> {
    Ok(Json(dbx_core::agent_kv::kv_supports_ttl_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdRenameRequest {
    pub connection_id: String,
    pub request: dbx_core::agent_kv::KvRenameRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdHistoryRequest {
    pub connection_id: String,
    pub request: dbx_core::agent_kv::KvHistoryRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdStatusRequest {
    pub connection_id: String,
}

pub async fn list_prefix(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdListPrefixRequest>,
) -> Result<Json<dbx_core::agent_kv::KvListPrefixResponse>, AppError> {
    let result = dbx_core::agent_kv::kv_list_prefix_core_with_range_options(
        &state.app,
        &req.connection_id,
        &req.prefix,
        req.limit,
        req.continuation.as_deref(),
        dbx_core::agent_kv::KvRangeOptions { revision: req.revision, include_values: req.include_values },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvGetResponse>, AppError> {
    let result = dbx_core::agent_kv::kv_get_core_with_options(
        &state.app,
        &req.connection_id,
        &req.key,
        dbx_core::agent_kv::KvGetOptions {
            key_bytes: req.key_bytes,
            revision: req.revision,
            metadata_only: req.metadata_only,
        },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn put(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdPutRequest>,
) -> Result<Json<dbx_core::agent_kv::KvPutResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Put").await?;
    let result = dbx_core::agent_kv::kv_put_core_with_options(
        &state.app,
        &req.connection_id,
        &req.key,
        req.value,
        dbx_core::agent_kv::KvPutOptions {
            lease: req.lease,
            ttl: req.ttl,
            preserve_lease: req.preserve_lease,
            key_bytes: req.key_bytes,
            expected_mod_revision: req.expected_mod_revision,
            expected_create_revision: req.expected_create_revision,
            ..dbx_core::agent_kv::KvPutOptions::default()
        },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvDeleteResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::agent_kv::kv_delete_core_with_options(
        &state.app,
        &req.connection_id,
        &req.key,
        dbx_core::agent_kv::KvDeleteOptions {
            key_bytes: req.key_bytes,
            expected_mod_revision: req.expected_mod_revision,
        },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn rename(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdRenameRequest>,
) -> Result<Json<dbx_core::agent_kv::KvRenameResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Rename").await?;
    let result = dbx_core::agent_kv::kv_rename_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn history(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdHistoryRequest>,
) -> Result<Json<dbx_core::agent_kv::KvHistoryResponse>, AppError> {
    let result = dbx_core::agent_kv::kv_history_core(&state.app, &req.connection_id, req.request)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn status(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdStatusRequest>,
) -> Result<Json<dbx_core::agent_kv::KvStatusResponse>, AppError> {
    let result = dbx_core::agent_kv::kv_status_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdCompactRequest {
    pub connection_id: String,
    pub revision: dbx_core::agent_kv::KvInt64,
    pub preflight_token: String,
    pub confirmation_text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdDefragRequest {
    pub connection_id: String,
    pub endpoints: Vec<String>,
    pub preflight_token: String,
    pub confirmation_text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdWatchStartRouteRequest {
    pub connection_id: String,
    pub request: dbx_core::agent_kv::EtcdWatchStartRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdWatchRequest {
    pub connection_id: String,
    pub watch_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdOperationRequest {
    pub connection_id: String,
    pub operation: String,
    pub params: serde_json::Value,
    pub preflight_token: Option<String>,
    pub confirmation_text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdPreflightRouteRequest {
    pub connection_id: String,
    pub request: dbx_core::agent_kv::EtcdPreflightRequest,
}

pub async fn preflight(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdPreflightRouteRequest>,
) -> Result<Json<dbx_core::agent_kv::EtcdPreflightResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Dangerous etcd operation").await?;
    Ok(Json(
        dbx_core::agent_kv::etcd_preflight_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn compact(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdCompactRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Compact").await?;
    let params = serde_json::json!({ "revision": req.revision.clone() });
    dbx_core::agent_kv::etcd_consume_preflight_core(
        &state.app,
        &req.connection_id,
        "compact",
        &params,
        &req.preflight_token,
        &req.confirmation_text,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(
        dbx_core::agent_kv::etcd_compact_core(&state.app, &req.connection_id, req.revision)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn defrag(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdDefragRequest>,
) -> Result<Json<dbx_core::agent_kv::EtcdDefragResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Defrag").await?;
    let params = serde_json::json!({ "endpoints": req.endpoints.clone() });
    dbx_core::agent_kv::etcd_consume_preflight_core(
        &state.app,
        &req.connection_id,
        "defrag",
        &params,
        &req.preflight_token,
        &req.confirmation_text,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(
        dbx_core::agent_kv::etcd_defrag_core(&state.app, &req.connection_id, req.endpoints)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn watch_start(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdWatchStartRouteRequest>,
) -> Result<Json<dbx_core::agent_kv::EtcdWatchStartResponse>, AppError> {
    Ok(Json(
        dbx_core::agent_kv::etcd_watch_start_core(&state.app, &req.connection_id, req.request)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn watch_poll(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdWatchRequest>,
) -> Result<Json<dbx_core::agent_kv::EtcdWatchPollResponse>, AppError> {
    Ok(Json(
        dbx_core::agent_kv::etcd_watch_poll_core(&state.app, &req.connection_id, &req.watch_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn watch_stop(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdWatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        dbx_core::agent_kv::etcd_watch_stop_core(&state.app, &req.connection_id, &req.watch_id)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn lease_list(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdLeaseListRequest>,
) -> Result<Json<dbx_core::agent_kv::EtcdLeaseListResponse>, AppError> {
    Ok(Json(
        dbx_core::agent_kv::etcd_lease_list_core(
            &state.app,
            &req.connection_id,
            req.limit.unwrap_or(100),
            req.continuation.as_deref(),
        )
        .await
        .map_err(AppError::from)?,
    ))
}
pub async fn lease_call(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdOperationRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (method, write) = match req.operation.as_str() {
        "get" => (AgentKvMethod::LeaseGet, false),
        "grant" => (AgentKvMethod::LeaseGrant, true),
        "keepalive" => (AgentKvMethod::LeaseKeepalive, true),
        "revoke" => (AgentKvMethod::LeaseRevoke, true),
        _ => return Err(AppError::from("Unsupported etcd lease operation".to_string())),
    };
    if write {
        ensure_writable(&state.app, &req.connection_id, "Lease operation").await?;
    }
    if req.operation == "revoke" {
        dbx_core::agent_kv::etcd_consume_preflight_core(
            &state.app,
            &req.connection_id,
            "lease_revoke",
            &req.params,
            req.preflight_token
                .as_deref()
                .ok_or_else(|| AppError::from("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation"))?,
            req.confirmation_text
                .as_deref()
                .ok_or_else(|| AppError::from("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation"))?,
        )
        .await
        .map_err(AppError::from)?;
    }
    Ok(Json(
        dbx_core::agent_kv::etcd_lease_call_core(&state.app, &req.connection_id, method, req.params)
            .await
            .map_err(AppError::from)?,
    ))
}
pub async fn auth_call(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdOperationRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (method, write) = match req.operation.as_str() {
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
        _ => return Err(AppError::from("Unsupported etcd Auth operation".to_string())),
    };
    if write {
        ensure_writable(&state.app, &req.connection_id, "Auth operation").await?;
    }
    if let Some(action) = auth_preflight_action(&req.operation) {
        dbx_core::agent_kv::etcd_consume_preflight_core(
            &state.app,
            &req.connection_id,
            action,
            &req.params,
            req.preflight_token
                .as_deref()
                .ok_or_else(|| AppError::from("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation"))?,
            req.confirmation_text
                .as_deref()
                .ok_or_else(|| AppError::from("ETCD_PREFLIGHT_REQUIRED: Request a preflight confirmation"))?,
        )
        .await
        .map_err(AppError::from)?;
    }
    Ok(Json(
        dbx_core::agent_kv::etcd_auth_call_core(&state.app, &req.connection_id, method, req.params)
            .await
            .map_err(AppError::from)?,
    ))
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
