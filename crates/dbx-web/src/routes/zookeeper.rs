use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

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
pub struct ZooKeeperListPrefixRequest {
    pub connection_id: String,
    pub prefix: String,
    pub limit: usize,
    pub continuation: Option<String>,
    pub recursive: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZooKeeperKeyRequest {
    pub connection_id: String,
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZooKeeperPutRequest {
    pub connection_id: String,
    pub key: String,
    pub value: dbx_core::agent_kv::KvValue,
    pub options: Option<dbx_core::agent_kv::KvPutOptions>,
}

pub async fn list_prefix(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ZooKeeperListPrefixRequest>,
) -> Result<Json<dbx_core::agent_kv::KvListPrefixResponse>, AppError> {
    let result = dbx_core::agent_kv::kv_list_prefix_core_with_options(
        &state.app,
        &req.connection_id,
        &req.prefix,
        req.limit,
        req.continuation.as_deref(),
        req.recursive,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ZooKeeperKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvGetResponse>, AppError> {
    let result =
        dbx_core::agent_kv::kv_get_core(&state.app, &req.connection_id, &req.key).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn put(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ZooKeeperPutRequest>,
) -> Result<Json<dbx_core::agent_kv::KvPutResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Put").await?;
    let result = dbx_core::agent_kv::kv_put_core_with_options(
        &state.app,
        &req.connection_id,
        &req.key,
        req.value,
        req.options.unwrap_or_default(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ZooKeeperKeyRequest>,
) -> Result<Json<dbx_core::agent_kv::KvDeleteResponse>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result =
        dbx_core::agent_kv::kv_delete_core(&state.app, &req.connection_id, &req.key).await.map_err(AppError::from)?;
    Ok(Json(result))
}
