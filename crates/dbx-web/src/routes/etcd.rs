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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdKeyRequest {
    pub connection_id: String,
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtcdPutRequest {
    pub connection_id: String,
    pub key: String,
    pub value: dbx_core::agent_kv::KvValue,
    pub lease: Option<i64>,
}

pub async fn list_prefix(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdListPrefixRequest>,
) -> Result<Json<dbx_core::agent_kv::KvListPrefixResponse>, AppError> {
    let result = dbx_core::agent_kv::kv_list_prefix_core(
        &state.app,
        &req.connection_id,
        &req.prefix,
        req.limit,
        req.continuation.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvGetResponse>, AppError> {
    let result =
        dbx_core::agent_kv::kv_get_core(&state.app, &req.connection_id, &req.key).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn put(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdPutRequest>,
) -> Result<Json<dbx_core::agent_kv::KvPutResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Put").await?;
    let result = dbx_core::agent_kv::kv_put_core(&state.app, &req.connection_id, &req.key, req.value, req.lease)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<EtcdKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvDeleteResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result =
        dbx_core::agent_kv::kv_delete_core(&state.app, &req.connection_id, &req.key).await.map_err(AppError::from)?;
    Ok(Json(result))
}
