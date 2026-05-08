use crate::connection::{AppState, PoolKind};
use crate::db::redis_driver::{self, RedisScanResult, RedisValue};

pub async fn redis_list_databases_core(state: &AppState, connection_id: &str) -> Result<Vec<u32>, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::list_databases(&mut con).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_scan_keys_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    cursor: u64,
    pattern: &str,
    count: usize,
) -> Result<RedisScanResult, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::scan_keys_page(&mut con, cursor, pattern, count).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_get_value_core(state: &AppState, connection_id: &str, key: &str) -> Result<RedisValue, String> {
    redis_get_value_in_db_core(state, connection_id, 0, key).await
}

pub async fn redis_get_value_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
) -> Result<RedisValue, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::get_value(&mut con, &key).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_set_string_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    redis_set_string_in_db_core(state, connection_id, 0, key, value, ttl).await
}

pub async fn redis_set_string_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::set_string(&mut con, &key, value, ttl).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_delete_key_core(state: &AppState, connection_id: &str, key: &str) -> Result<(), String> {
    redis_delete_key_in_db_core(state, connection_id, 0, key).await
}

pub async fn redis_delete_key_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::delete_key(&mut con, &key).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_hash_set_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    redis_hash_set_in_db_core(state, connection_id, 0, key, field, value).await
}

pub async fn redis_hash_set_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::hash_set(&mut con, &key, field, value).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_hash_del_core(state: &AppState, connection_id: &str, key: &str, field: &str) -> Result<(), String> {
    redis_hash_del_in_db_core(state, connection_id, 0, key, field).await
}

pub async fn redis_hash_del_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    field: &str,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::hash_del(&mut con, &key, field).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_list_push_core(state: &AppState, connection_id: &str, key: &str, value: &str) -> Result<(), String> {
    redis_list_push_in_db_core(state, connection_id, 0, key, value).await
}

pub async fn redis_list_push_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    value: &str,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::list_push(&mut con, &key, value).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_list_remove_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    index: i64,
) -> Result<(), String> {
    redis_list_remove_in_db_core(state, connection_id, 0, key, index).await
}

pub async fn redis_list_remove_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    index: i64,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::list_remove(&mut con, &key, index).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_set_add_core(state: &AppState, connection_id: &str, key: &str, member: &str) -> Result<(), String> {
    redis_set_add_in_db_core(state, connection_id, 0, key, member).await
}

pub async fn redis_set_add_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    member: &str,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::set_add(&mut con, &key, member).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_set_remove_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    member: &str,
) -> Result<(), String> {
    redis_set_remove_in_db_core(state, connection_id, 0, key, member).await
}

pub async fn redis_set_remove_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    member: &str,
) -> Result<(), String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(con) => {
            let mut con = con.lock().await;
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            redis_driver::select_db(&mut con, db).await?;
            redis_driver::set_remove(&mut con, &key, member).await
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}
