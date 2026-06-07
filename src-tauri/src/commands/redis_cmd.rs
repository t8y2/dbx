use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db::redis_driver::{RedisCommandResult, RedisDatabaseInfo, RedisScanResult, RedisValue};

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
pub async fn redis_scan_values(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    cursor: u64,
    pattern: String,
    query: String,
    count: usize,
) -> Result<RedisScanResult, String> {
    dbx_core::redis_ops::redis_scan_values_core(&state, &connection_id, db, cursor, &pattern, &query, count).await
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
    dbx_core::redis_ops::redis_set_string_in_db_core(&state, &connection_id, db, &key_raw, &value, ttl).await
}

#[tauri::command]
pub async fn redis_delete_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
) -> Result<(), String> {
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
) -> Result<(), String> {
    dbx_core::redis_ops::redis_hash_set_in_db_core(&state, &connection_id, db, &key_raw, &field, &value).await
}

#[tauri::command]
pub async fn redis_hash_del(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    field: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_hash_del_in_db_core(&state, &connection_id, db, &key_raw, &field).await
}

#[tauri::command]
pub async fn redis_list_push(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    value: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_list_push_in_db_core(&state, &connection_id, db, &key_raw, &value).await
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
    dbx_core::redis_ops::redis_list_remove_in_db_core(&state, &connection_id, db, &key_raw, index).await
}

#[tauri::command]
pub async fn redis_set_add(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_set_add_in_db_core(&state, &connection_id, db, &key_raw, &member).await
}

#[tauri::command]
pub async fn redis_set_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
) -> Result<(), String> {
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
) -> Result<(), String> {
    dbx_core::redis_ops::redis_zadd_in_db_core(&state, &connection_id, db, &key_raw, &member, score).await
}

#[tauri::command]
pub async fn redis_zrem(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    member: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_zrem_in_db_core(&state, &connection_id, db, &key_raw, &member).await
}

#[tauri::command]
pub async fn redis_set_ttl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raw: String,
    ttl: i64,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_set_ttl_in_db_core(&state, &connection_id, db, &key_raw, ttl).await
}

#[tauri::command]
pub async fn redis_delete_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    key_raws: Vec<String>,
) -> Result<u64, String> {
    dbx_core::redis_ops::redis_delete_keys_in_db_core(&state, &connection_id, db, &key_raws).await
}

#[tauri::command]
pub async fn redis_flush_db(state: State<'_, Arc<AppState>>, connection_id: String, db: u32) -> Result<(), String> {
    dbx_core::redis_ops::redis_flush_db_core(&state, &connection_id, db).await
}

#[tauri::command]
pub async fn redis_execute_command(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    db: u32,
    command: String,
) -> Result<RedisCommandResult, String> {
    dbx_core::redis_ops::redis_execute_command_core(&state, &connection_id, db, &command).await
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
) -> Result<RedisValue, String> {
    dbx_core::redis_ops::redis_load_more_in_db_core(&state, &connection_id, db, &key_raw, &key_type, cursor, count)
        .await
}
