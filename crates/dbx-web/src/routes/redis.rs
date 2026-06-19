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
        return Err(AppError(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

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
pub struct RedisScanBatchRequest {
    pub connection_id: String,
    pub db: u32,
    pub cursor: u64,
    pub pattern: String,
    pub count: usize,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
}

fn default_max_iterations() -> usize {
    1
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValueScanRequest {
    pub connection_id: String,
    pub db: u32,
    pub cursor: u64,
    pub pattern: String,
    pub query: String,
    pub include_key_matches: Option<bool>,
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
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisZaddRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub member: String,
    pub score: f64,
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisListRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub value: Option<String>,
    pub index: Option<i64>,
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSetRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub member: String,
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamAddRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub entry_id: String,
    pub fields: Vec<(String, String)>,
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisJsonSetRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raw: String,
    pub value: String,
    pub ttl: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeysRequest {
    pub connection_id: String,
    pub db: u32,
    pub key_raws: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDbRequest {
    pub connection_id: String,
    pub db: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisCommandRequest {
    pub connection_id: String,
    pub db: u32,
    pub command: String,
    pub skip_safety_check: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisPubSubPublishRequest {
    pub connection_id: String,
    pub db: u32,
    pub channel: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowlogGetRequest {
    pub connection_id: String,
    pub count: usize,
    pub node_host: Option<String>,
    pub node_port: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterNodesRequest {
    pub connection_id: String,
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

pub async fn scan_keys_batch(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisScanBatchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::redis_ops::redis_scan_keys_batch_core(
        &state.app,
        &req.connection_id,
        req.db,
        req.cursor,
        &req.pattern,
        req.count,
        req.max_iterations,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn scan_values(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisValueScanRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::redis_ops::redis_scan_values_core(
        &state.app,
        &req.connection_id,
        req.db,
        req.cursor,
        &req.pattern,
        &req.query,
        req.include_key_matches.unwrap_or(false),
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
    ensure_writable(&state.app, &req.connection_id, "SET").await?;
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
    ensure_writable(&state.app, &req.connection_id, "Delete key").await?;
    dbx_core::redis_ops::redis_delete_key_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn hash_set(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisHashRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "HSET").await?;
    let value = req.value.as_deref().unwrap_or("");
    dbx_core::redis_ops::redis_hash_set_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        &req.field,
        value,
        req.ttl,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn hash_del(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisHashRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "HDEL").await?;
    dbx_core::redis_ops::redis_hash_del_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, &req.field)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_push(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisListRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "LPUSH").await?;
    let value = req.value.as_deref().unwrap_or("");
    dbx_core::redis_ops::redis_list_push_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        value,
        req.ttl,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_set(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisListRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "LSET").await?;
    let index = req.index.unwrap_or(0);
    let value = req.value.as_deref().unwrap_or("");
    dbx_core::redis_ops::redis_list_set_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, index, value)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_remove(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisListRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "LREM").await?;
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
    ensure_writable(&state.app, &req.connection_id, "SADD").await?;
    dbx_core::redis_ops::redis_set_add_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        &req.member,
        req.ttl,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_remove(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisSetRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "SREM").await?;
    dbx_core::redis_ops::redis_set_remove_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raw, &req.member)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn zadd(State(state): State<Arc<WebState>>, Json(req): Json<RedisZaddRequest>) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_zadd_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        &req.member,
        req.score,
        req.ttl,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn stream_add(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisStreamAddRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_stream_add_in_db_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.key_raw,
        &req.entry_id,
        req.fields,
        req.ttl,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn json_set(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisJsonSetRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::redis_ops::redis_json_set_in_db_core(
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

pub async fn check_json_module(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisDbRequest>,
) -> Result<Json<bool>, AppError> {
    let result = dbx_core::redis_ops::redis_check_json_module_in_db_core(&state.app, &req.connection_id, req.db)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn delete_keys(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisKeysRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete keys").await?;
    let result =
        dbx_core::redis_ops::redis_delete_keys_in_db_core(&state.app, &req.connection_id, req.db, &req.key_raws)
            .await
            .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn flush_db(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisDbRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "FLUSHDB").await?;
    dbx_core::redis_ops::redis_flush_db_core(&state.app, &req.connection_id, req.db).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn execute_command(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisCommandRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // In read-only mode, only allow safe read commands
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.connection_id).await {
        let cmd_name = req.command.split_whitespace().next().unwrap_or("");
        if dbx_core::db::redis_driver::classify_command(cmd_name)
            != dbx_core::db::redis_driver::RedisCommandSafety::Allowed
        {
            return Err(AppError(format!(
                "Read-only mode: connection '{}' has read-only protection enabled. Command '{}' blocked.",
                name, cmd_name
            )));
        }
    }
    let result = dbx_core::redis_ops::redis_execute_command_core(
        &state.app,
        &req.connection_id,
        req.db,
        &req.command,
        req.skip_safety_check.unwrap_or(false),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn publish_message(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RedisPubSubPublishRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "PUBLISH").await?;
    let count =
        dbx_core::redis_ops::redis_publish_core(&state.app, &req.connection_id, req.db, &req.channel, &req.message)
            .await
            .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "subscribers": count })))
}

pub async fn slowlog_get(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SlowlogGetRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::redis_ops::redis_slowlog_get_core(
        &state.app,
        &req.connection_id,
        req.count,
        req.node_host,
        req.node_port,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn cluster_master_nodes(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ClusterNodesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::redis_ops::redis_cluster_master_nodes_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}
