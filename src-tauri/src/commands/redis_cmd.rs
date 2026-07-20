use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::db::redis_driver::{
    classify_command, parse_command_argv, RedisCollectionPage, RedisCommandResult, RedisCommandSafety,
    RedisDatabaseInfo, RedisScanResult, RedisValue,
};

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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "SET").await?;
    dbx_core::redis_ops::redis_set_string_in_db_core(&state, &connection_id, db, &key_raw, &value, ttl).await
}

#[tauri::command]
pub async fn redis_delete_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete key").await?;
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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "HSET").await?;
    dbx_core::redis_ops::redis_hash_set_in_db_core(&state, &connection_id, db, &key_raw, &field, &value, ttl).await
}

#[tauri::command]
pub async fn redis_hash_del(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    field: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "HDEL").await?;
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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "LPUSH").await?;
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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "LSET").await?;
    dbx_core::redis_ops::redis_list_set_in_db_core(&state, &connection_id, db, &key_raw, index, &value).await
}

#[tauri::command]
pub async fn redis_list_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    index: i64,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "LREM").await?;
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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "SADD").await?;
    dbx_core::redis_ops::redis_set_add_in_db_core(&state, &connection_id, db, &key_raw, &member, ttl).await
}

#[tauri::command]
pub async fn redis_set_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "SREM").await?;
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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "ZADD").await?;
    dbx_core::redis_ops::redis_zadd_in_db_core(&state, &connection_id, db, &key_raw, &member, score, ttl).await
}

#[tauri::command]
pub async fn redis_zrem(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "ZREM").await?;
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
) -> Result<(), String> {
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
) -> Result<(), String> {
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
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "EXPIRE").await?;
    dbx_core::redis_ops::redis_set_ttl_in_db_core(&state, &connection_id, db, &key_raw, ttl).await
}

#[tauri::command]
pub async fn redis_delete_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raws: Vec<String>,
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "Delete keys").await?;
    dbx_core::redis_ops::redis_delete_keys_in_db_core(&state, &connection_id, db, &key_raws).await
}

#[tauri::command]
pub async fn redis_flush_db(state: State<'_, Arc<AppState>>, connection_id: String, db: u32) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "FLUSHDB").await?;
    dbx_core::redis_ops::redis_flush_db_core(&state, &connection_id, db).await
}

#[tauri::command]
pub async fn redis_execute_command(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    command: String,
    skip_safety_check: Option<bool>,
) -> Result<RedisCommandResult, String> {
    let argv = parse_command_argv(&command).map_err(|error| format!("Invalid Redis command: {error}"))?;
    let cmd_name = argv[0].to_ascii_uppercase();
    let safety = classify_command(&cmd_name);
    // In read-only mode, only allow safe read commands through the raw command interface
    if let Some(name) = dbx_core::query::connection_readonly_name(&state, &connection_id).await {
        if safety != RedisCommandSafety::Allowed {
            return Err(format!(
                "Read-only mode: connection '{}' has read-only protection enabled. Command '{}' blocked.",
                name, cmd_name
            ));
        }
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
) -> Result<u64, String> {
    ensure_connection_writable(&state, &connection_id, "PUBLISH").await?;
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
