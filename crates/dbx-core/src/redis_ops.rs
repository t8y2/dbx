use crate::connection::{AppState, PoolKind};
use crate::db::redis_driver::{
    self, RedisCommandResult, RedisConnection, RedisDatabaseInfo, RedisKeyInfo, RedisScanResult, RedisValue,
};

async fn ensure_redis_pool(state: &AppState, connection_id: &str) -> Result<(), String> {
    state.get_or_create_pool(connection_id, None).await.map(|_| ())
}

pub async fn redis_list_databases_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<RedisDatabaseInfo>, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::list_databases(&mut *con).await
            }
            RedisConnection::Cluster(cluster) => redis_driver::list_cluster_databases(cluster).await,
        },
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
    redis_scan_keys_batch_core(state, connection_id, db, cursor, pattern, count, 1).await
}

/// Batch-scan keys with server-side multi-SCAN support.
///
/// Performs up to `max_iterations` SCAN→TYPE cycles server-side in a single
/// API call, dramatically reducing frontend↔backend roundtrips when fetching
/// many keys (e.g. "fetch all" in the key browser).
pub async fn redis_scan_keys_batch_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
) -> Result<RedisScanResult, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::select_db(&mut *con, db).await?;
                redis_driver::scan_keys_batch(&mut *con, cursor, pattern, count, max_iterations).await
            }
            RedisConnection::Cluster(cluster) => {
                redis_driver::ensure_cluster_db(db)?;
                // Cluster scan already iterates across nodes; for batch mode we
                // loop the cluster-level scan to accumulate keys server-side.
                if max_iterations <= 1 {
                    return redis_driver::scan_cluster_keys_page(cluster, cursor, pattern, count).await;
                }
                let mut all_keys: Vec<RedisKeyInfo> = Vec::new();
                let mut current_cursor = cursor;
                let mut total_keys: u64 = 0;
                for i in 0..max_iterations {
                    let page = redis_driver::scan_cluster_keys_page(cluster, current_cursor, pattern, count).await?;
                    if i == 0 {
                        total_keys = page.total_keys;
                    }
                    all_keys.extend(page.keys);
                    if page.cursor == 0 {
                        return Ok(RedisScanResult { cursor: 0, keys: all_keys, total_keys });
                    }
                    current_cursor = page.cursor;
                }
                Ok(RedisScanResult { cursor: current_cursor, keys: all_keys, total_keys })
            }
        },
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_scan_values_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    cursor: u64,
    pattern: &str,
    query: &str,
    include_key_matches: bool,
    count: usize,
) -> Result<RedisScanResult, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::select_db(&mut *con, db).await?;
                redis_driver::scan_values_page(&mut *con, cursor, pattern, query, include_key_matches, count).await
            }
            RedisConnection::Cluster(cluster) => {
                redis_driver::ensure_cluster_db(db)?;
                redis_driver::scan_cluster_values_page(cluster, cursor, pattern, query, include_key_matches, count)
                    .await
            }
        },
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
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::get_value(&mut *con, &key).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::get_value(&mut *con, &key).await
                }
            }
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
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::set_string(&mut *con, &key, value, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::set_string(&mut *con, &key, value, ttl).await
                }
            }
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
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::delete_key(&mut *con, &key).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::delete_key(&mut *con, &key).await
                }
            }
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
    ttl: Option<i64>,
) -> Result<(), String> {
    redis_hash_set_in_db_core(state, connection_id, 0, key, field, value, ttl).await
}

pub async fn redis_hash_set_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    field: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::hash_set(&mut *con, &key, field, value, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::hash_set(&mut *con, &key, field, value, ttl).await
                }
            }
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
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::hash_del(&mut *con, &key, field).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::hash_del(&mut *con, &key, field).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_list_push_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    redis_list_push_in_db_core(state, connection_id, 0, key, value, ttl).await
}

pub async fn redis_list_push_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::list_push(&mut *con, &key, value, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::list_push(&mut *con, &key, value, ttl).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_list_set_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    index: i64,
    value: &str,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::list_set(&mut *con, &key, index, value).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::list_set(&mut *con, &key, index, value).await
                }
            }
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
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::list_remove(&mut *con, &key, index).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::list_remove(&mut *con, &key, index).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_set_add_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    member: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    redis_set_add_in_db_core(state, connection_id, 0, key, member, ttl).await
}

pub async fn redis_set_add_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    member: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::set_add(&mut *con, &key, member, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::set_add(&mut *con, &key, member, ttl).await
                }
            }
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
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::set_remove(&mut *con, &key, member).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::set_remove(&mut *con, &key, member).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_zadd_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    member: &str,
    score: f64,
    ttl: Option<i64>,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::zadd(&mut *con, &key, member, score, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::zadd(&mut *con, &key, member, score, ttl).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_zrem_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    member: &str,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::zrem(&mut *con, &key, member).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::zrem(&mut *con, &key, member).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_stream_add_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    entry_id: &str,
    fields: Vec<(String, String)>,
    ttl: Option<i64>,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::stream_add(&mut *con, &key, entry_id, &fields, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::stream_add(&mut *con, &key, entry_id, &fields, ttl).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_json_set_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::json_set(&mut *con, &key, value, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::json_set(&mut *con, &key, value, ttl).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_check_json_module_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
) -> Result<bool, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::select_db(&mut *con, db).await?;
                redis_driver::check_json_module(&mut *con).await
            }
            RedisConnection::Cluster(cluster) => {
                redis_driver::ensure_cluster_db(db)?;
                let mut con = cluster.connection.lock().await;
                redis_driver::check_json_module(&mut *con).await
            }
        },
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_set_ttl_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    ttl: i64,
) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::set_ttl(&mut *con, &key, ttl).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::set_ttl(&mut *con, &key, ttl).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_delete_keys_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raws: &[String],
) -> Result<u64, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let keys: Result<Vec<Vec<u8>>, String> =
                key_raws.iter().map(|k| redis_driver::redis_key_raw_to_bytes(k)).collect();
            let keys = keys?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::delete_keys(&mut *con, &keys).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    let mut deleted = 0;
                    for key in &keys {
                        deleted += redis_driver::delete_keys(&mut *con, std::slice::from_ref(key)).await?;
                    }
                    Ok(deleted)
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_flush_db_core(state: &AppState, connection_id: &str, db: u32) -> Result<(), String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::select_db(&mut *con, db).await?;
                redis_driver::flush_db(&mut *con).await
            }
            RedisConnection::Cluster(cluster) => {
                redis_driver::ensure_cluster_db(db)?;
                redis_driver::flush_cluster(cluster).await
            }
        },
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_execute_command_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    command: &str,
    skip_safety_check: bool,
) -> Result<RedisCommandResult, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::select_db(&mut *con, db).await?;
                redis_driver::execute_command(&mut *con, command, skip_safety_check).await
            }
            RedisConnection::Cluster(cluster) => {
                redis_driver::ensure_cluster_db(db)?;
                if let Ok(argv) = redis_driver::parse_command_argv(command) {
                    if argv.first().is_some_and(|name| name.eq_ignore_ascii_case("SELECT")) {
                        return Err("Redis Cluster only supports db0; SELECT is not available".to_string());
                    }
                }
                let mut con = cluster.connection.lock().await;
                redis_driver::execute_command(&mut *con, command, skip_safety_check).await
            }
        },
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_load_more_in_db_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    key_raw: &str,
    key_type: &str,
    cursor: u64,
    count: usize,
) -> Result<redis_driver::RedisValue, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => {
            let key = redis_driver::redis_key_raw_to_bytes(key_raw)?;
            match redis {
                RedisConnection::Direct(con) => {
                    let mut con = con.lock().await;
                    redis_driver::select_db(&mut *con, db).await?;
                    redis_driver::load_more_collection(&mut *con, &key, key_type, cursor, count).await
                }
                RedisConnection::Cluster(cluster) => {
                    redis_driver::ensure_cluster_db(db)?;
                    let mut con = cluster.connection.lock().await;
                    redis_driver::load_more_collection(&mut *con, &key, key_type, cursor, count).await
                }
            }
        }
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_publish_core(
    state: &AppState,
    connection_id: &str,
    db: u32,
    channel: &str,
    message: &str,
) -> Result<u64, String> {
    ensure_redis_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Redis(redis) => match redis {
            RedisConnection::Direct(con) => {
                let mut con = con.lock().await;
                redis_driver::select_db(&mut *con, db).await?;
                redis_driver::publish_message(&mut *con, channel, message).await
            }
            RedisConnection::Cluster(cluster) => {
                redis_driver::ensure_cluster_db(db)?;
                let mut con = cluster.connection.lock().await;
                redis_driver::publish_message(&mut *con, channel, message).await
            }
        },
        _ => Err("Not a Redis connection".to_string()),
    }
}

pub async fn redis_create_pubsub_core(state: &AppState, connection_id: &str) -> Result<redis::aio::PubSub, String> {
    let configs = state.configs.read().await;
    let config = configs.get(connection_id).ok_or("Connection config not found")?.clone();
    drop(configs);

    if config.db_type != crate::models::connection::DatabaseType::Redis {
        return Err("Not a Redis connection".to_string());
    }

    let (host, port) = state.connection_host_port(connection_id, &config).await?;
    let timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());
    redis_driver::connect_pubsub(&config, &host, port, timeout).await
}
