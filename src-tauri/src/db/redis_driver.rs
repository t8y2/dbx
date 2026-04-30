use redis::AsyncCommands;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisKeyInfo {
    pub key: String,
    pub key_type: String,
    pub ttl: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisValue {
    pub key: String,
    pub key_type: String,
    pub ttl: i64,
    pub value: serde_json::Value,
}

pub async fn connect(url: &str) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(url).map_err(|e| format!("Redis connection failed: {e}"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.get_multiplexed_async_connection(),
    )
    .await
    .map_err(|_| "Redis connection timed out (10s)".to_string())?
    .map_err(|e| format!("Redis connection failed: {e}"))
}

pub async fn list_databases(con: &mut redis::aio::MultiplexedConnection) -> Result<Vec<u32>, String> {
    let info: String = redis::cmd("INFO")
        .arg("keyspace")
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    let mut dbs: Vec<u32> = Vec::new();
    for line in info.lines() {
        if line.starts_with("db") {
            if let Some(num) = line.strip_prefix("db").and_then(|s| s.split(':').next()) {
                if let Ok(n) = num.parse::<u32>() {
                    dbs.push(n);
                }
            }
        }
    }
    if dbs.is_empty() {
        dbs.push(0);
    }
    Ok(dbs)
}

pub async fn select_db(con: &mut redis::aio::MultiplexedConnection, db: u32) -> Result<(), String> {
    redis::cmd("SELECT")
        .arg(db)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())
}

pub async fn scan_keys(
    con: &mut redis::aio::MultiplexedConnection,
    pattern: &str,
    count: usize,
) -> Result<Vec<RedisKeyInfo>, String> {
    let mut cursor: u64 = 0;
    let mut all_keys: Vec<String> = Vec::new();
    loop {
        let (new_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(100)
            .query_async(con)
            .await
            .map_err(|e| e.to_string())?;
        all_keys.extend(keys);
        cursor = new_cursor;
        if cursor == 0 || all_keys.len() >= count {
            break;
        }
    }
    all_keys.truncate(count);

    let mut result = Vec::new();
    for key in &all_keys {
        let key_type: String = redis::cmd("TYPE")
            .arg(key.as_str())
            .query_async(con)
            .await
            .unwrap_or_else(|_| "unknown".to_string());

        let ttl: i64 = con.ttl(key.as_str()).await.unwrap_or(-1);

        result.push(RedisKeyInfo {
            key: key.clone(),
            key_type,
            ttl,
        });
    }
    Ok(result)
}

pub async fn get_value(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
) -> Result<RedisValue, String> {
    let key_type: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    let ttl: i64 = con.ttl(key).await.unwrap_or(-1);

    let value = match key_type.as_str() {
        "string" => {
            let v: String = con.get(key).await.map_err(|e| e.to_string())?;
            serde_json::Value::String(v)
        }
        "list" => {
            let v: Vec<String> = con.lrange(key, 0, -1).await.map_err(|e| e.to_string())?;
            serde_json::json!(v)
        }
        "set" => {
            let v: Vec<String> = con.smembers(key).await.map_err(|e| e.to_string())?;
            serde_json::json!(v)
        }
        "zset" => {
            let v: Vec<(String, f64)> = con
                .zrange_withscores(key, 0, -1)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::json!(v.iter().map(|(m, s)| serde_json::json!({"member": m, "score": s})).collect::<Vec<_>>())
        }
        "hash" => {
            let v: Vec<(String, String)> = con.hgetall(key).await.map_err(|e| e.to_string())?;
            let map: serde_json::Map<String, serde_json::Value> = v
                .into_iter()
                .map(|(k, v)| (k, serde_json::Value::String(v)))
                .collect();
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::Null,
    };

    Ok(RedisValue {
        key: key.to_string(),
        key_type,
        ttl,
        value,
    })
}

pub async fn set_string(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    con.set::<_, _, ()>(key, value)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(t) = ttl {
        if t > 0 {
            con.expire::<_, ()>(key, t)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn delete_key(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
) -> Result<(), String> {
    con.del::<_, ()>(key).await.map_err(|e| e.to_string())
}

pub async fn hash_set(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    con.hset::<_, _, _, ()>(key, field, value)
        .await
        .map_err(|e| e.to_string())
}

pub async fn hash_del(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    field: &str,
) -> Result<(), String> {
    con.hdel::<_, _, ()>(key, field)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_push(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    value: &str,
) -> Result<(), String> {
    con.rpush::<_, _, ()>(key, value)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_remove(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    index: i64,
) -> Result<(), String> {
    let placeholder = "__DELETED_PLACEHOLDER__";
    redis::cmd("LSET")
        .arg(key)
        .arg(index)
        .arg(placeholder)
        .query_async::<()>(con)
        .await
        .map_err(|e| e.to_string())?;
    con.lrem::<_, _, ()>(key, 1, placeholder)
        .await
        .map_err(|e| e.to_string())
}

pub async fn set_add(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    member: &str,
) -> Result<(), String> {
    con.sadd::<_, _, ()>(key, member)
        .await
        .map_err(|e| e.to_string())
}

pub async fn set_remove(
    con: &mut redis::aio::MultiplexedConnection,
    key: &str,
    member: &str,
) -> Result<(), String> {
    con.srem::<_, _, ()>(key, member)
        .await
        .map_err(|e| e.to_string())
}
