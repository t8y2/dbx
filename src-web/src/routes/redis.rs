use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConnectionRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanRequest {
    pub connection_id: String,
    pub db: u32,
    pub cursor: u64,
    pub pattern: String,
    pub count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSetStringRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub value: String,
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisHashRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub field: String,
    pub value: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisListRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub value: Option<String>,
    pub index: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSetRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub member: String,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisConnectionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::redis_ops::redis_list_databases_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn scan_keys(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisScanRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::redis_ops::redis_scan_keys_core(
        &state.app,
        &req.connection_id,
        req.db,
        req.cursor,
        &req.pattern,
        req.count,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn get_value(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisKeyRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::redis_ops::redis_get_value_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn set_string(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisSetStringRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_set_string_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        &req.value,
        req.ttl,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn delete_key(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisKeyRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_delete_key_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn hash_set(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisHashRequest>,
) -> Result<Json<()>, AppError> {
    let value = req.value.as_deref().unwrap_or("");
    dbx_core::redis_ops::redis_hash_set_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        &req.field,
        value,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn hash_del(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisHashRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_hash_del_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, &req.field)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_push(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisListRequest>,
) -> Result<Json<()>, AppError> {
    let value = req.value.as_deref().unwrap_or("");
    dbx_core::redis_ops::redis_list_push_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, value)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_remove(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisListRequest>,
) -> Result<Json<()>, AppError> {
    let index = req.index.unwrap_or(0);
    dbx_core::redis_ops::redis_list_remove_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, index)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_add(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisSetRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_set_add_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, &req.member)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_remove(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisSetRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_set_remove_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, &req.member)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}
