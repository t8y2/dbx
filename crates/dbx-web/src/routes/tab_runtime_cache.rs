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
}

pub async fn save_tab_runtime_cache(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SaveTabRuntimeCacheRequest>,
) -> Result<Json<()>, AppError> {
    let payload = BASE64.decode(req.payload_base64).map_err(|e| AppError::bad_request(e.to_string()))?;
    state
        .app
        .storage
        .save_tab_runtime_cache(&req.key, payload, req.row_count, req.column_count)
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
    })))
}

pub async fn delete_tab_runtime_cache(
    State(state): State<Arc<WebState>>,
    Query(query): Query<TabRuntimeCacheKeyQuery>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_tab_runtime_cache(&query.key).await.map_err(AppError::internal)?;
    Ok(Json(()))
}
