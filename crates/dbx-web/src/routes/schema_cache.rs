use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
pub struct SchemaCacheKeyQuery {
    pub cache_key: String,
}

#[derive(Deserialize)]
pub struct SchemaCachePrefixQuery {
    pub prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSchemaCacheRequest {
    pub cache_key: String,
    pub payload: serde_json::Value,
}

pub async fn save_schema_cache(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveSchemaCacheRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_schema_cache(&body.cache_key, &body.payload).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_schema_cache(
    State(state): State<Arc<WebState>>,
    Query(query): Query<SchemaCacheKeyQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let payload = state.app.storage.load_schema_cache(&query.cache_key).await.map_err(AppError)?;
    Ok(Json(payload.unwrap_or(serde_json::json!(null))))
}

pub async fn delete_schema_cache_prefix(
    State(state): State<Arc<WebState>>,
    Query(query): Query<SchemaCachePrefixQuery>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_schema_cache_prefix(&query.prefix).await.map_err(AppError)?;
    Ok(Json(()))
}
