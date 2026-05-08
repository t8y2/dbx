use base64::Engine;
use redis::{FromRedisValue, Value as RedisRawValue};
use serde::{Deserialize, Serialize};

const STREAM_ENTRY_LIMIT: usize = 100;
const DEFAULT_REDIS_DATABASES: u32 = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisKeyInfo {
    pub key_display: String,
    pub key_raw: String,
    pub key_type: String,
    pub ttl: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisScanResult {
    pub cursor: u64,
    pub keys: Vec<RedisKeyInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisValue {
    pub key_display: String,
    pub key_raw: String,
    pub key_type: String,
    pub ttl: i64,
    pub value_is_binary: bool,
    pub value: serde_json::Value,
}

pub async fn connect(url: &str) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(url).map_err(|e| format!("Redis connection failed: {e}"))?;
    let mut con = tokio::time::timeout(super::connection_timeout(), client.get_multiplexed_async_connection())
        .await
        .map_err(|_| format!("Redis connection timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
        .map_err(|e| format!("Redis connection failed: {e}"))?;

    tokio::time::timeout(super::connection_timeout(), redis::cmd("PING").query_async::<String>(&mut con))
        .await
        .map_err(|_| format!("Redis ping timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
        .map_err(|e| format!("Redis authentication failed or command rejected: {e}"))?;

    Ok(con)
}

pub async fn list_databases(con: &mut redis::aio::MultiplexedConnection) -> Result<Vec<u32>, String> {
    let configured_count =
        redis::cmd("CONFIG").arg("GET").arg("databases").query_async(con).await.ok().and_then(parse_database_count);

    let keyspace_dbs = list_keyspace_databases(con).await.unwrap_or_default();
    let database_count = configured_count.unwrap_or(DEFAULT_REDIS_DATABASES);
    let max_db = keyspace_dbs.iter().copied().max().map(|db| db + 1).unwrap_or(0);
    let visible_count = database_count.max(max_db).max(1);

    Ok((0..visible_count).collect())
}

fn parse_database_count(value: redis::Value) -> Option<u32> {
    let values = match value {
        redis::Value::Array(values) => values,
        _ => return None,
    };

    values.windows(2).find_map(|pair| {
        let key = String::from_redis_value(&pair[0]).ok()?;
        if key.eq_ignore_ascii_case("databases") {
            String::from_redis_value(&pair[1]).ok()?.parse().ok()
        } else {
            None
        }
    })
}

async fn list_keyspace_databases(con: &mut redis::aio::MultiplexedConnection) -> Result<Vec<u32>, String> {
    let info: String = redis::cmd("INFO").arg("keyspace").query_async(con).await.map_err(|e| e.to_string())?;

    let mut dbs = Vec::new();
    for line in info.lines() {
        if line.starts_with("db") {
            if let Some(num) = line.strip_prefix("db").and_then(|s| s.split(':').next()) {
                if let Ok(n) = num.parse::<u32>() {
                    dbs.push(n);
                }
            }
        }
    }
    Ok(dbs)
}

pub async fn select_db(con: &mut redis::aio::MultiplexedConnection, db: u32) -> Result<(), String> {
    redis::cmd("SELECT").arg(db).query_async(con).await.map_err(|e| e.to_string())
}

pub async fn scan_keys_page(
    con: &mut redis::aio::MultiplexedConnection,
    cursor: u64,
    pattern: &str,
    count: usize,
) -> Result<RedisScanResult, String> {
    let raw: RedisRawValue = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(pattern)
        .arg("COUNT")
        .arg(count)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    let (next_cursor, keys) = parse_scan_keys(raw)?;

    let mut result = Vec::new();
    for key in &keys {
        let key_type: String =
            redis::cmd("TYPE").arg(key).query_async(con).await.unwrap_or_else(|_| "unknown".to_string());

        let ttl: i64 = redis::cmd("TTL").arg(key).query_async(con).await.unwrap_or(-1);

        result.push(RedisKeyInfo {
            key_display: redis_key_bytes_to_display(key),
            key_raw: redis_key_bytes_to_raw(key),
            key_type,
            ttl,
        });
    }
    Ok(RedisScanResult { cursor: next_cursor, keys: result })
}

pub async fn get_value(con: &mut redis::aio::MultiplexedConnection, key: &[u8]) -> Result<RedisValue, String> {
    let key_type: String = redis::cmd("TYPE").arg(key).query_async(con).await.map_err(|e| e.to_string())?;

    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(con).await.unwrap_or(-1);

    let (value, value_is_binary) = match key_type.as_str() {
        "string" => {
            let v: RedisRawValue = redis::cmd("GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            let value_is_binary = redis_value_contains_binary(&v);
            (redis_raw_to_json(v), value_is_binary)
        }
        "list" => {
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(con).await.map_err(|e| e.to_string())?;
            (redis_array_to_json(v), false)
        }
        "set" => {
            let v: RedisRawValue = redis::cmd("SMEMBERS").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            (redis_array_to_json(v), false)
        }
        "zset" => {
            let v: RedisRawValue = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(-1)
                .arg("WITHSCORES")
                .query_async(con)
                .await
                .map_err(|e| e.to_string())?;
            (parse_zset_entries(v), false)
        }
        "hash" => {
            let v: RedisRawValue = redis::cmd("HGETALL").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            (parse_hash_entries(v), false)
        }
        "stream" => (get_stream_entries(con, key).await?, false),
        _ => (serde_json::Value::Null, false),
    };

    Ok(RedisValue {
        key_display: redis_key_bytes_to_display(key),
        key_raw: redis_key_bytes_to_raw(key),
        key_type,
        ttl,
        value_is_binary,
        value,
    })
}

async fn get_stream_entries(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
) -> Result<serde_json::Value, String> {
    let raw: RedisRawValue = redis::cmd("XRANGE")
        .arg(key)
        .arg("-")
        .arg("+")
        .arg("COUNT")
        .arg(STREAM_ENTRY_LIMIT)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    Ok(parse_stream_entries(raw))
}

fn parse_scan_keys(raw: RedisRawValue) -> Result<(u64, Vec<Vec<u8>>), String> {
    let RedisRawValue::Array(parts) = raw else {
        return Err("Invalid Redis SCAN response".to_string());
    };
    if parts.len() != 2 {
        return Err("Invalid Redis SCAN response".to_string());
    }

    let cursor = redis_value_to_string(parts[0].clone())
        .ok_or_else(|| "Invalid Redis SCAN cursor".to_string())?
        .parse::<u64>()
        .map_err(|_| "Invalid Redis SCAN cursor".to_string())?;

    let RedisRawValue::Array(keys) = &parts[1] else {
        return Err("Invalid Redis SCAN keys payload".to_string());
    };

    let mut parsed = Vec::with_capacity(keys.len());
    for key in keys {
        parsed.push(redis_value_to_bytes(key.clone()).ok_or_else(|| "Invalid Redis key payload".to_string())?);
    }

    Ok((cursor, parsed))
}

fn parse_hash_entries(raw: RedisRawValue) -> serde_json::Value {
    let RedisRawValue::Array(entries) = raw else {
        return serde_json::Value::Null;
    };

    let mut map = serde_json::Map::new();
    let mut iter = entries.into_iter();
    while let Some(field) = iter.next() {
        let Some(value) = iter.next() else {
            break;
        };
        let field = redis_value_to_string(field).unwrap_or_default();
        map.insert(field, redis_raw_to_json(value));
    }

    serde_json::Value::Object(map)
}

fn parse_zset_entries(raw: RedisRawValue) -> serde_json::Value {
    let RedisRawValue::Array(entries) = raw else {
        return serde_json::Value::Null;
    };

    let mut rows = Vec::new();
    let mut iter = entries.into_iter();
    while let Some(member) = iter.next() {
        let Some(score) = iter.next() else {
            break;
        };
        rows.push(serde_json::json!({
            "member": redis_value_to_string(member).unwrap_or_default(),
            "score": redis_value_to_string(score).unwrap_or_default(),
        }));
    }

    serde_json::Value::Array(rows)
}

fn parse_stream_entries(raw: RedisRawValue) -> serde_json::Value {
    match raw {
        RedisRawValue::Array(entries) => {
            serde_json::Value::Array(entries.into_iter().filter_map(parse_stream_entry).collect())
        }
        _ => serde_json::Value::Null,
    }
}

fn parse_stream_entry(entry: RedisRawValue) -> Option<serde_json::Value> {
    let mut parts = match entry {
        RedisRawValue::Array(parts) if parts.len() == 2 => parts.into_iter(),
        _ => return None,
    };

    let id = redis_value_to_string(parts.next()?)?;
    let fields = match parts.next()? {
        RedisRawValue::Array(fields) => fields,
        _ => return None,
    };

    let mut field_map = serde_json::Map::new();
    let mut fields = fields.into_iter();
    while let Some(field) = fields.next() {
        let Some(value) = fields.next() else {
            break;
        };
        if let Some(field_name) = redis_value_to_string(field) {
            let value = redis_value_to_string(value).unwrap_or_default();
            field_map.insert(field_name, serde_json::Value::String(value));
        }
    }

    Some(serde_json::json!({
        "id": id,
        "fields": field_map,
    }))
}

fn redis_value_to_string(value: RedisRawValue) -> Option<String> {
    match value {
        RedisRawValue::BulkString(bytes) => Some(redis_bytes_to_display(&bytes)),
        RedisRawValue::SimpleString(value) => Some(value),
        RedisRawValue::Int(value) => Some(value.to_string()),
        RedisRawValue::Double(value) => Some(value.to_string()),
        RedisRawValue::Boolean(value) => Some(value.to_string()),
        RedisRawValue::VerbatimString { text, .. } => Some(redis_bytes_to_display(text.as_bytes())),
        RedisRawValue::Okay => Some("OK".to_string()),
        _ => None,
    }
}

fn redis_value_contains_binary(value: &RedisRawValue) -> bool {
    match value {
        RedisRawValue::BulkString(bytes) => std::str::from_utf8(bytes).is_err(),
        RedisRawValue::VerbatimString { text, .. } => std::str::from_utf8(text.as_bytes()).is_err(),
        _ => false,
    }
}

fn redis_value_to_bytes(value: RedisRawValue) -> Option<Vec<u8>> {
    match value {
        RedisRawValue::BulkString(bytes) => Some(bytes),
        RedisRawValue::SimpleString(value) => Some(value.into_bytes()),
        RedisRawValue::Int(value) => Some(value.to_string().into_bytes()),
        RedisRawValue::Double(value) => Some(value.to_string().into_bytes()),
        RedisRawValue::Boolean(value) => Some(value.to_string().into_bytes()),
        RedisRawValue::VerbatimString { text, .. } => Some(text.into_bytes()),
        RedisRawValue::Okay => Some(b"OK".to_vec()),
        _ => None,
    }
}

fn redis_array_to_json(value: RedisRawValue) -> serde_json::Value {
    match value {
        RedisRawValue::Array(values) => serde_json::Value::Array(values.into_iter().map(redis_raw_to_json).collect()),
        other => redis_raw_to_json(other),
    }
}

fn redis_raw_to_json(value: RedisRawValue) -> serde_json::Value {
    match value {
        RedisRawValue::Nil => serde_json::Value::Null,
        RedisRawValue::Array(values) => serde_json::Value::Array(values.into_iter().map(redis_raw_to_json).collect()),
        other => serde_json::Value::String(redis_value_to_string(other).unwrap_or_default()),
    }
}

fn redis_bytes_to_display(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.replace('\\', "\\\\");
    }

    let mut output = String::new();
    for &byte in bytes {
        match byte {
            b'\\' => output.push_str("\\\\"),
            0x20..=0x7e => output.push(byte as char),
            _ => output.push_str(&format!("\\x{:02x}", byte)),
        }
    }
    output
}

pub fn redis_key_bytes_to_display(bytes: &[u8]) -> String {
    redis_bytes_to_display(bytes)
}

pub fn redis_key_bytes_to_raw(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn redis_key_raw_to_bytes(value: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(value).map_err(|e| format!("Invalid Redis key encoding: {e}"))
}

pub async fn set_string(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    value: &str,
    ttl: Option<i64>,
) -> Result<(), String> {
    redis::cmd("SET").arg(key).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    if let Some(t) = ttl {
        if t > 0 {
            redis::cmd("EXPIRE").arg(key).arg(t).query_async::<()>(con).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn delete_key(con: &mut redis::aio::MultiplexedConnection, key: &[u8]) -> Result<(), String> {
    redis::cmd("DEL").arg(key).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn hash_set(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    field: &str,
    value: &str,
) -> Result<(), String> {
    redis::cmd("HSET").arg(key).arg(field).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn hash_del(con: &mut redis::aio::MultiplexedConnection, key: &[u8], field: &str) -> Result<(), String> {
    redis::cmd("HDEL").arg(key).arg(field).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn list_push(con: &mut redis::aio::MultiplexedConnection, key: &[u8], value: &str) -> Result<(), String> {
    redis::cmd("RPUSH").arg(key).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn list_remove(con: &mut redis::aio::MultiplexedConnection, key: &[u8], index: i64) -> Result<(), String> {
    let placeholder = "__DELETED_PLACEHOLDER__";
    redis::cmd("LSET").arg(key).arg(index).arg(placeholder).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    redis::cmd("LREM").arg(key).arg(1).arg(placeholder).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn set_add(con: &mut redis::aio::MultiplexedConnection, key: &[u8], member: &str) -> Result<(), String> {
    redis::cmd("SADD").arg(key).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn set_remove(con: &mut redis::aio::MultiplexedConnection, key: &[u8], member: &str) -> Result<(), String> {
    redis::cmd("SREM").arg(key).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_database_count, parse_scan_keys, parse_stream_entries, redis_key_bytes_to_display,
        redis_key_bytes_to_raw, redis_key_raw_to_bytes, redis_raw_to_json, redis_value_contains_binary, RedisRawValue,
    };

    fn bulk(value: &str) -> RedisRawValue {
        RedisRawValue::BulkString(value.as_bytes().to_vec())
    }

    #[test]
    fn parses_stream_entries() {
        let raw = RedisRawValue::Array(vec![RedisRawValue::Array(vec![
            bulk("1714470000000-0"),
            RedisRawValue::Array(vec![bulk("event"), bulk("login"), bulk("user_id"), bulk("42")]),
        ])]);

        let parsed = parse_stream_entries(raw);

        assert_eq!(
            parsed,
            serde_json::json!([
                {
                    "id": "1714470000000-0",
                    "fields": {
                        "event": "login",
                        "user_id": "42"
                    }
                }
            ])
        );
    }

    #[test]
    fn skips_malformed_stream_entries() {
        let raw = RedisRawValue::Array(vec![
            RedisRawValue::Array(vec![bulk("1714470000000-0")]),
            RedisRawValue::Array(vec![
                bulk("1714470000001-0"),
                RedisRawValue::Array(vec![bulk("event"), bulk("logout")]),
            ]),
        ]);

        let parsed = parse_stream_entries(raw);

        assert_eq!(
            parsed,
            serde_json::json!([
                {
                    "id": "1714470000001-0",
                    "fields": {
                        "event": "logout"
                    }
                }
            ])
        );
    }

    #[test]
    fn parses_configured_database_count() {
        let value = RedisRawValue::Array(vec![
            RedisRawValue::BulkString(b"databases".to_vec()),
            RedisRawValue::BulkString(b"32".to_vec()),
        ]);

        assert_eq!(parse_database_count(value), Some(32));
    }

    #[test]
    fn formats_binary_keys_like_rdm() {
        let bytes = [0xAC, 0xED, 0x00, 0x05, b't', 0x00, b'A', b'\\'];

        assert_eq!(redis_key_bytes_to_display(&bytes), "\\xac\\xed\\x00\\x05t\\x00A\\\\");
    }

    #[test]
    fn preserves_utf8_keys_as_readable_text() {
        let bytes = "用户:配置".as_bytes();

        assert_eq!(redis_key_bytes_to_display(bytes), "用户:配置");
    }

    #[test]
    fn round_trips_raw_key_transport() {
        let bytes = b"\xAC\xED\x00\x05t\x00token";
        let encoded = redis_key_bytes_to_raw(bytes);

        assert_eq!(redis_key_raw_to_bytes(&encoded).unwrap(), bytes);
    }

    #[test]
    fn parses_scan_response_with_binary_keys() {
        let raw = RedisRawValue::Array(vec![
            RedisRawValue::BulkString(b"17".to_vec()),
            RedisRawValue::Array(vec![
                RedisRawValue::BulkString(vec![0xAC, 0xED, 0x00, 0x05, b't']),
                RedisRawValue::BulkString(b"plain:key".to_vec()),
            ]),
        ]);

        let (cursor, keys) = parse_scan_keys(raw).unwrap();

        assert_eq!(cursor, 17);
        assert_eq!(keys, vec![vec![0xAC, 0xED, 0x00, 0x05, b't'], b"plain:key".to_vec()]);
    }

    #[test]
    fn formats_binary_string_values_like_rdm() {
        let raw = RedisRawValue::BulkString(vec![0xAC, 0xED, 0x00, 0x05, b's', b'r']);

        let value = redis_raw_to_json(raw);

        assert_eq!(value, serde_json::Value::String("\\xac\\xed\\x00\\x05sr".to_string()));
    }

    #[test]
    fn does_not_treat_utf8_with_backslashes_as_binary() {
        let raw = RedisRawValue::BulkString(br#"C:\Users\path"#.to_vec());

        assert!(!redis_value_contains_binary(&raw));
    }
}
