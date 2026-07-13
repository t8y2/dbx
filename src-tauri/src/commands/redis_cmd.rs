use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_write_allowed, AppState};
use dbx_core::db::redis_driver::{
    RedisCollectionPage, RedisCommandResult, RedisDatabaseInfo, RedisScanResult, RedisValue,
};
use dbx_core::production_safety::ProductionWriteAuthorization;

async fn ensure_redis_write(
    state: &Arc<AppState>,
    connection_id: &str,
    db: u32,
    operation: &str,
    action: &str,
    authorization: Option<&ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_connection_write_allowed(state, connection_id, Some(&db.to_string()), operation, action, authorization).await
}

#[tauri::command]
pub async fn redis_list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<RedisDatabaseInfo>, String> {
    dbx_core::redis_ops::redis_list_databases_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn redis_scan_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    cursor: u64,
    pattern: String,
    count: usize,
) -> Result<RedisScanResult, String> {
    dbx_core::redis_ops::redis_scan_keys_core(&state, &connection_id, db, cursor, &pattern, count).await
}

#[tauri::command]
pub async fn redis_scan_keys_batch(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    cursor: u64,
    pattern: String,
    count: usize,
    max_iterations: usize,
    include_types: Option<bool>,
) -> Result<RedisScanResult, String> {
    dbx_core::redis_ops::redis_scan_keys_batch_core(
        &state,
        &connection_id,
        db,
        cursor,
        &pattern,
        count,
        max_iterations,
        include_types.unwrap_or(true),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn redis_scan_values(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    cursor: u64,
    pattern: String,
    query: String,
    include_key_matches: Option<bool>,
    count: usize,
) -> Result<RedisScanResult, String> {
    dbx_core::redis_ops::redis_scan_values_core(
        &state,
        &connection_id,
        db,
        cursor,
        &pattern,
        &query,
        include_key_matches.unwrap_or(false),
        count,
    )
    .await
}

#[tauri::command]
pub async fn redis_get_value(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
) -> Result<RedisValue, String> {
    dbx_core::redis_ops::redis_get_value_in_db_core(&state, &connection_id, db, &key_raw).await
}

#[tauri::command]
pub async fn redis_set_string(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    value: String,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisSetString", "SET", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_set_string_in_db_core(&state, &connection_id, db, &key_raw, &value, ttl).await
}

#[tauri::command]
pub async fn redis_delete_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(
        &state,
        &connection_id,
        db,
        "redisDeleteKey",
        "Delete key",
        production_write_authorization.as_ref(),
    )
    .await?;
    dbx_core::redis_ops::redis_delete_key_in_db_core(&state, &connection_id, db, &key_raw).await
}

#[tauri::command]
pub async fn redis_hash_set(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    field: String,
    value: String,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisHashSet", "HSET", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_hash_set_in_db_core(&state, &connection_id, db, &key_raw, &field, &value, ttl).await
}

#[tauri::command]
pub async fn redis_hash_del(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    field: String,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisHashDel", "HDEL", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_hash_del_in_db_core(&state, &connection_id, db, &key_raw, &field).await
}

#[tauri::command]
pub async fn redis_list_push(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    value: String,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisListPush", "LPUSH", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_list_push_in_db_core(&state, &connection_id, db, &key_raw, &value, ttl).await
}

#[tauri::command]
pub async fn redis_list_set(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    index: i64,
    value: String,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisListSet", "LSET", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_list_set_in_db_core(&state, &connection_id, db, &key_raw, index, &value).await
}

#[tauri::command]
pub async fn redis_list_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    index: i64,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisListRemove", "LREM", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_list_remove_in_db_core(&state, &connection_id, db, &key_raw, index).await
}

#[tauri::command]
pub async fn redis_set_add(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisSetAdd", "SADD", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_set_add_in_db_core(&state, &connection_id, db, &key_raw, &member, ttl).await
}

#[tauri::command]
pub async fn redis_set_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisSetRemove", "SREM", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_set_remove_in_db_core(&state, &connection_id, db, &key_raw, &member).await
}

#[tauri::command]
pub async fn redis_zadd(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
    score: f64,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisZadd", "ZADD", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_zadd_in_db_core(&state, &connection_id, db, &key_raw, &member, score, ttl).await
}

#[tauri::command]
pub async fn redis_zrem(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisZrem", "ZREM", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_zrem_in_db_core(&state, &connection_id, db, &key_raw, &member).await
}

#[tauri::command]
pub async fn redis_stream_add(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    entry_id: String,
    fields: Vec<(String, String)>,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisStreamAdd", "XADD", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_stream_add_in_db_core(&state, &connection_id, db, &key_raw, &entry_id, fields, ttl).await
}

#[tauri::command]
pub async fn redis_json_set(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    value: String,
    ttl: Option<i64>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisJsonSet", "JSON.SET", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_json_set_in_db_core(&state, &connection_id, db, &key_raw, &value, ttl).await
}

#[tauri::command]
pub async fn redis_check_json_module(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
) -> Result<bool, String> {
    dbx_core::redis_ops::redis_check_json_module_in_db_core(&state, &connection_id, db).await
}

#[tauri::command]
pub async fn redis_set_ttl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    ttl: i64,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisSetTtl", "EXPIRE", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_set_ttl_in_db_core(&state, &connection_id, db, &key_raw, ttl).await
}

#[tauri::command]
pub async fn redis_delete_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raws: Vec<String>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<u64, String> {
    ensure_redis_write(
        &state,
        &connection_id,
        db,
        "redisDeleteKeys",
        "Delete keys",
        production_write_authorization.as_ref(),
    )
    .await?;
    dbx_core::redis_ops::redis_delete_keys_in_db_core(&state, &connection_id, db, &key_raws).await
}

#[tauri::command]
pub async fn redis_flush_db(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<(), String> {
    ensure_redis_write(&state, &connection_id, db, "redisFlushDb", "FLUSHDB", production_write_authorization.as_ref())
        .await?;
    dbx_core::redis_ops::redis_flush_db_core(&state, &connection_id, db).await
}

#[tauri::command]
pub async fn redis_execute_command(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    command: String,
    skip_safety_check: Option<bool>,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<RedisCommandResult, String> {
    let cmd_name = command.split_whitespace().next().unwrap_or("");
    if dbx_core::db::redis_driver::command_is_mutating(&command) {
        dbx_core::production_safety::ensure_redis_command_write_allowed(
            &state,
            &connection_id,
            db,
            &command,
            "redisExecuteCommand",
            &format!("Command '{cmd_name}'"),
            production_write_authorization.as_ref(),
        )
        .await?;
    }
    dbx_core::redis_ops::redis_execute_command_core(
        &state,
        &connection_id,
        db,
        &command,
        skip_safety_check.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn redis_load_more(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    key_type: String,
    cursor: u64,
    count: usize,
    filter: Option<String>,
) -> Result<RedisCollectionPage, String> {
    dbx_core::redis_ops::redis_load_more_in_db_core(
        &state,
        &connection_id,
        db,
        &key_raw,
        &key_type,
        cursor,
        count,
        filter.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn redis_pubsub_publish(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    channel: String,
    message: String,
    production_write_authorization: Option<ProductionWriteAuthorization>,
) -> Result<u64, String> {
    ensure_redis_write(
        &state,
        &connection_id,
        db,
        "redisPubSubPublish",
        "PUBLISH",
        production_write_authorization.as_ref(),
    )
    .await?;
    dbx_core::redis_ops::redis_publish_core(&state, &connection_id, db, &channel, &message).await
}

#[tauri::command]
pub async fn redis_slowlog_get(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    count: usize,
    node_host: Option<String>,
    node_port: Option<u16>,
) -> Result<Vec<dbx_core::db::redis_driver::RedisSlowlogEntry>, String> {
    dbx_core::redis_ops::redis_slowlog_get_core(&state, &connection_id, count, node_host, node_port).await
}

#[tauri::command]
pub async fn redis_cluster_master_nodes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::db::redis_driver::RedisNodeEndpoint>, String> {
    dbx_core::redis_ops::redis_cluster_master_nodes_core(&state, &connection_id).await
}
