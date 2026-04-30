use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{AppState, PoolKind};
use crate::db::redis_driver::{self, RedisScanResult, RedisValue};

#[tauri::command]
pub async fn redis_list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<u32>, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(&connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::list_databases(&mut con).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
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
    let connections = state.connections.lock().await;
    let pool = connections.get(&connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::scan_keys_page(&mut con, cursor, &pattern, count).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_get_value(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<RedisValue, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(&connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::get_value(&mut con, &key).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_set_string(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
    value: String,
    ttl: Option<i64>,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(&connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::set_string(&mut con, &key, &value, ttl).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_delete_key(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    key: String,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(&connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::delete_key(&mut con, &key).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_hash_set(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, field: String, value: String,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(&connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => redis_driver::hash_set(&mut *con.lock().await, &key, &field, &value).await,
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_hash_del(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, field: String,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(&connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => redis_driver::hash_del(&mut *con.lock().await, &key, &field).await,
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_list_push(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, value: String,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(&connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => redis_driver::list_push(&mut *con.lock().await, &key, &value).await,
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_list_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, index: i64,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(&connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => redis_driver::list_remove(&mut *con.lock().await, &key, index).await,
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_set_add(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, member: String,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(&connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => redis_driver::set_add(&mut *con.lock().await, &key, &member).await,
        _ => Err("Not a Redis connection".to_string()),
    }
}

#[tauri::command]
pub async fn redis_set_remove(
    state: State<'_, Arc<AppState>>,
    connection_id: String, key: String, member: String,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(&connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => redis_driver::set_remove(&mut *con.lock().await, &key, &member).await,
        _ => Err("Not a Redis connection".to_string()),
    }
}
