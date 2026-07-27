use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

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
