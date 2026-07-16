use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTabRuntimeCacheRequest {
    pub key: String,
    pub payload_base64: String,
    pub row_count: i64,
    pub column_count: i64,
    pub owner_id: Option<String>,
}

#[derive(Deserialize)]
pub struct TabRuntimeCacheKeyQuery {
    pub key: String,
}

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

pub async fn save_tab_runtime_cache(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SaveTabRuntimeCacheRequest>,
) -> Result<Json<()>, AppError> {
    let payload = BASE64.decode(req.payload_base64).map_err(|e| AppError::bad_request(e.to_string()))?;
    state
        .app
        .storage
        .save_tab_runtime_cache(&req.key, payload, req.row_count, req.column_count, req.owner_id)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn load_tab_runtime_cache(
    State(state): State<Arc<WebState>>,
    Query(query): Query<TabRuntimeCacheKeyQuery>,
) -> Result<Json<Option<LoadTabRuntimeCacheResponse>>, AppError> {
    let entry = state.app.storage.load_tab_runtime_cache(&query.key).await.map_err(AppError::internal)?;
    Ok(Json(entry.map(|entry| LoadTabRuntimeCacheResponse {
        key: entry.key,
        payload_base64: BASE64.encode(entry.payload),
        row_count: entry.row_count,
        column_count: entry.column_count,
        byte_size: entry.byte_size,
        updated_at: entry.updated_at,
        created_at: entry.created_at,
        last_accessed_at: entry.last_accessed_at,
        owner_id: entry.owner_id,
    })))
}

pub async fn list_tab_runtime_cache_metadata(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<dbx_core::storage::TabRuntimeCacheMetadata>>, AppError> {
    Ok(Json(state.app.storage.list_tab_runtime_cache_metadata().await.map_err(AppError::internal)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneTabRuntimeCacheRequest {
    pub live_keys: Vec<String>,
    pub max_bytes: i64,
    pub orphan_grace_ms: i64,
    pub max_age_ms: Option<i64>,
}

pub async fn prune_tab_runtime_cache(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PruneTabRuntimeCacheRequest>,
) -> Result<Json<dbx_core::storage::TabRuntimeCachePruneResult>, AppError> {
    Ok(Json(
        state
            .app
            .storage
            .prune_tab_runtime_cache(request.live_keys, request.max_bytes, request.orphan_grace_ms, request.max_age_ms)
            .await
            .map_err(AppError::internal)?,
    ))
}

#[derive(Deserialize)]
pub struct TabRuntimeCacheOwnerQuery {
    pub owner_id: String,
}

pub async fn delete_tab_runtime_cache_owner(
    State(state): State<Arc<WebState>>,
    Query(query): Query<TabRuntimeCacheOwnerQuery>,
) -> Result<Json<usize>, AppError> {
    Ok(Json(state.app.storage.delete_tab_runtime_cache_owner(&query.owner_id).await.map_err(AppError::internal)?))
}

pub async fn delete_tab_runtime_cache(
    State(state): State<Arc<WebState>>,
    Query(query): Query<TabRuntimeCacheKeyQuery>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_tab_runtime_cache(&query.key).await.map_err(AppError::internal)?;
    Ok(Json(()))
}
