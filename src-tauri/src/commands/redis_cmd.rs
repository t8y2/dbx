use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db::redis_driver::{RedisScanResult, RedisValue};

#[tauri::command]
pub async fn redis_list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<u32>, String> {
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
pub async fn redis_get_value(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<RedisValue, String> {
    dbx_core::redis_ops::redis_get_value_core(&state, &connection_id, &key).await
}

#[tauri::command]
pub async fn redis_set_string(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    value: String,
    ttl: Option<i64>,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_set_string_core(&state, &connection_id, &key, &value, ttl).await
}

#[tauri::command]
pub async fn redis_delete_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_delete_key_core(&state, &connection_id, &key).await
}

#[tauri::command]
pub async fn redis_hash_set(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, field: String, value: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_hash_set_core(&state, &connection_id, &key, &field, &value).await
}

#[tauri::command]
pub async fn redis_hash_del(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, field: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_hash_del_core(&state, &connection_id, &key, &field).await
}

#[tauri::command]
pub async fn redis_list_push(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, value: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_list_push_core(&state, &connection_id, &key, &value).await
}

#[tauri::command]
pub async fn redis_list_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, index: i64,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_list_remove_core(&state, &connection_id, &key, index).await
}

#[tauri::command]
pub async fn redis_set_add(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, member: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_set_add_core(&state, &connection_id, &key, &member).await
}

#[tauri::command]
pub async fn redis_set_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, member: String,
) -> Result<(), String> {
    dbx_core::redis_ops::redis_set_remove_core(&state, &connection_id, &key, &member).await
}
