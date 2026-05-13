use base64::Engine;
use redis::{FromRedisValue, Value as RedisRawValue};
use serde::{Deserialize, Serialize};

const STREAM_ENTRY_LIMIT: usize = 100;
const COLLECTION_PAGE_SIZE: usize = 200;
const DEFAULT_REDIS_DATABASES: u32 = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisKeyInfo {
    pub key_display: String,
    pub key_raw: String,
    pub key_type: String,
    pub ttl: i64,
    pub size: u64,
    pub value_preview: String,
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
    pub total: Option<u64>,
    pub scan_cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedisCommandSafety {
    Allowed,
    Confirm,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisCommandResult {
    pub command: String,
    pub safety: RedisCommandSafety,
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

pub fn parse_command_argv(command_text: &str) -> Result<Vec<String>, String> {
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut chars = command_text.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaping = false;

    while let Some(ch) = chars.next() {
        if escaping {
            current.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaping = false;
            continue;
        }

        if ch == '\\' {
            escaping = true;
            continue;
        }

        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !current.is_empty() {
                argv.push(std::mem::take(&mut current));
            }
            while matches!(chars.peek(), Some(next) if next.is_whitespace()) {
                chars.next();
            }
            continue;
        }

        current.push(ch);
    }

    if escaping {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("Redis command has an unterminated quote".to_string());
    }
    if !current.is_empty() {
        argv.push(current);
    }
    if argv.is_empty() {
        return Err("Redis command is empty".to_string());
    }
    Ok(argv)
}

pub fn classify_command(command: &str) -> RedisCommandSafety {
    match command.to_ascii_uppercase().as_str() {
        "KEYS" | "FLUSHALL" | "SHUTDOWN" | "CONFIG" | "SAVE" | "BGSAVE" | "SLAVEOF" | "REPLICAOF" | "MIGRATE"
        | "MODULE" | "SCRIPT" | "EVAL" | "EVALSHA" => RedisCommandSafety::Blocked,
        "DEL" | "UNLINK" | "EXPIRE" | "EXPIREAT" | "PEXPIRE" | "PEXPIREAT" | "PERSIST" | "RENAME" | "RENAMENX"
        | "SET" | "SETEX" | "PSETEX" | "SETNX" | "MSET" | "MSETNX" | "HSET" | "HDEL" | "LPUSH" | "RPUSH" | "LPOP"
        | "RPOP" | "LSET" | "LREM" | "SADD" | "SREM" | "ZADD" | "ZREM" | "XADD" | "XDEL" | "FLUSHDB" => {
            RedisCommandSafety::Confirm
        }
        _ => RedisCommandSafety::Allowed,
    }
}

pub fn redis_command_raw_to_json(value: RedisRawValue) -> serde_json::Value {
    match value {
        RedisRawValue::Nil => serde_json::Value::Null,
        RedisRawValue::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(redis_command_raw_to_json).collect())
        }
        RedisRawValue::Map(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(|(key, value)| {
                    serde_json::json!({
                        "key": redis_command_raw_to_json(key),
                        "value": redis_command_raw_to_json(value),
                    })
                })
                .collect(),
        ),
        RedisRawValue::Set(values) => {
            serde_json::Value::Array(values.into_iter().map(redis_command_raw_to_json).collect())
        }
        RedisRawValue::Attribute { data, attributes } => serde_json::json!({
            "data": redis_command_raw_to_json(*data),
            "attributes": redis_command_raw_to_json(RedisRawValue::Map(attributes)),
        }),
        RedisRawValue::Push { kind, data } => serde_json::json!({
            "kind": format!("{kind:?}"),
            "data": redis_command_raw_to_json(RedisRawValue::Array(data)),
        }),
        RedisRawValue::BulkString(bytes) => serde_json::Value::String(redis_bytes_to_display(&bytes)),
        RedisRawValue::SimpleString(value) => serde_json::Value::String(value),
        RedisRawValue::Okay => serde_json::Value::String("OK".to_string()),
        RedisRawValue::Int(value) => serde_json::Value::Number(value.into()),
        RedisRawValue::Double(value) => {
            serde_json::Number::from_f64(value).map_or(serde_json::Value::Null, serde_json::Value::Number)
        }
        RedisRawValue::Boolean(value) => serde_json::Value::Bool(value),
        RedisRawValue::VerbatimString { text, .. } => {
            serde_json::Value::String(redis_bytes_to_display(text.as_bytes()))
        }
        RedisRawValue::BigNumber(value) => serde_json::Value::String(value.to_string()),
        RedisRawValue::ServerError(error) => serde_json::Value::String(format!("{error:?}")),
    }
}

pub async fn flush_db(con: &mut redis::aio::MultiplexedConnection) -> Result<(), String> {
    redis::cmd("FLUSHDB").query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn execute_command(
    con: &mut redis::aio::MultiplexedConnection,
    command_text: &str,
) -> Result<RedisCommandResult, String> {
    let argv = parse_command_argv(command_text)?;
    let command = argv[0].to_ascii_uppercase();
    let safety = classify_command(&command);
    if safety == RedisCommandSafety::Blocked {
        return Err(format!("Redis command is blocked for safety: {command}"));
    }

    let mut cmd = redis::cmd(&argv[0]);
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }
    let raw: RedisRawValue = cmd.query_async(con).await.map_err(|e| e.to_string())?;

    Ok(RedisCommandResult { command, safety, value: redis_command_raw_to_json(raw) })
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
    if keys.is_empty() {
        return Ok(RedisScanResult { cursor: next_cursor, keys: Vec::new() });
    }

    let mut pipe = redis::pipe();
    for key in &keys {
        pipe.cmd("TYPE").arg(key);
    }
    let key_types: Vec<String> = pipe.query_async(con).await.unwrap_or_default();

    let mut result = Vec::with_capacity(keys.len());
    for (index, key) in keys.iter().enumerate() {
        result.push(RedisKeyInfo {
            key_display: redis_key_bytes_to_display(key),
            key_raw: redis_key_bytes_to_raw(key),
            key_type: key_types.get(index).cloned().unwrap_or_else(|| "unknown".to_string()),
            ttl: -2,
            size: 0,
            value_preview: String::new(),
        });
    }
    Ok(RedisScanResult { cursor: next_cursor, keys: result })
}

pub async fn get_value(con: &mut redis::aio::MultiplexedConnection, key: &[u8]) -> Result<RedisValue, String> {
    let key_type: String = redis::cmd("TYPE").arg(key).query_async(con).await.map_err(|e| e.to_string())?;

    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(con).await.unwrap_or(-1);

    let (value, value_is_binary, total, scan_cursor) = match key_type.as_str() {
        "string" => {
            let v: RedisRawValue = redis::cmd("GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            let value_is_binary = redis_value_contains_binary(&v);
            (redis_raw_to_json(v), value_is_binary, None, None)
        }
        "list" => {
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(con).await.unwrap_or(0);
            let end = (COLLECTION_PAGE_SIZE as i64) - 1;
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(0).arg(end).query_async(con).await.map_err(|e| e.to_string())?;
            let cursor = if len > COLLECTION_PAGE_SIZE as u64 { Some(COLLECTION_PAGE_SIZE as u64) } else { None };
            (redis_array_to_json(v), false, Some(len), cursor)
        }
        "set" => {
            let len: u64 = redis::cmd("SCARD").arg(key).query_async(con).await.unwrap_or(0);
            let (next_cursor, items) = sscan_page_raw(con, key, 0, COLLECTION_PAGE_SIZE).await?;
            let cursor = if next_cursor > 0 { Some(next_cursor) } else { None };
            (serde_json::Value::Array(items), false, Some(len), cursor)
        }
        "zset" => {
            let len: u64 = redis::cmd("ZCARD").arg(key).query_async(con).await.unwrap_or(0);
            let (next_cursor, items) = zscan_page_raw(con, key, 0, COLLECTION_PAGE_SIZE).await?;
            let cursor = if next_cursor > 0 { Some(next_cursor) } else { None };
            (serde_json::Value::Array(items), false, Some(len), cursor)
        }
        "hash" => {
            let len: u64 = redis::cmd("HLEN").arg(key).query_async(con).await.unwrap_or(0);
            let (next_cursor, items) = hscan_page_raw(con, key, 0, COLLECTION_PAGE_SIZE).await?;
            let cursor = if next_cursor > 0 { Some(next_cursor) } else { None };
            (serde_json::Value::Array(items), false, Some(len), cursor)
        }
        "stream" => (get_stream_entries(con, key).await?, false, None, None),
        _ => (serde_json::Value::Null, false, None, None),
    };

    Ok(RedisValue {
        key_display: redis_key_bytes_to_display(key),
        key_raw: redis_key_bytes_to_raw(key),
        key_type,
        ttl,
        value_is_binary,
        value,
        total,
        scan_cursor,
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

pub async fn list_set(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    index: i64,
    value: &str,
) -> Result<(), String> {
    redis::cmd("LSET").arg(key).arg(index).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())
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

pub async fn zadd(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    member: &str,
    score: f64,
) -> Result<(), String> {
    redis::cmd("ZADD").arg(key).arg(score).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn zrem(con: &mut redis::aio::MultiplexedConnection, key: &[u8], member: &str) -> Result<(), String> {
    redis::cmd("ZREM").arg(key).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn set_ttl(con: &mut redis::aio::MultiplexedConnection, key: &[u8], ttl: i64) -> Result<(), String> {
    if ttl > 0 {
        redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<()>(con).await.map_err(|e| e.to_string())
    } else {
        redis::cmd("PERSIST").arg(key).query_async::<()>(con).await.map_err(|e| e.to_string())
    }
}

pub async fn delete_keys(con: &mut redis::aio::MultiplexedConnection, keys: &[Vec<u8>]) -> Result<u64, String> {
    let mut cmd = redis::cmd("DEL");
    for key in keys {
        cmd.arg(key.as_slice());
    }
    cmd.query_async(con).await.map_err(|e| e.to_string())
}

pub async fn load_more_collection(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    key_type: &str,
    cursor: u64,
    count: usize,
) -> Result<RedisValue, String> {
    let (value, next_cursor) = match key_type {
        "list" => {
            let start = cursor as i64;
            let end = start + count as i64 - 1;
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(start).arg(end).query_async(con).await.map_err(|e| e.to_string())?;
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(con).await.unwrap_or(0);
            let next = cursor + count as u64;
            let cursor = if next < len { Some(next) } else { None };
            (redis_array_to_json(v), cursor)
        }
        "set" => {
            let (next, items) = sscan_page_raw(con, key, cursor, count).await?;
            let cursor = if next > 0 { Some(next) } else { None };
            (serde_json::Value::Array(items), cursor)
        }
        "zset" => {
            let (next, items) = zscan_page_raw(con, key, cursor, count).await?;
            let cursor = if next > 0 { Some(next) } else { None };
            (serde_json::Value::Array(items), cursor)
        }
        "hash" => {
            let (next, items) = hscan_page_raw(con, key, cursor, count).await?;
            let cursor = if next > 0 { Some(next) } else { None };
            (serde_json::Value::Array(items), cursor)
        }
        _ => return Err(format!("Pagination not supported for type: {key_type}")),
    };

    Ok(RedisValue {
        key_display: redis_key_bytes_to_display(key),
        key_raw: redis_key_bytes_to_raw(key),
        key_type: key_type.to_string(),
        ttl: -1,
        value_is_binary: false,
        value,
        total: None,
        scan_cursor: next_cursor,
    })
}

async fn hscan_page_raw(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<serde_json::Value>), String> {
    let raw: RedisRawValue = redis::cmd("HSCAN")
        .arg(key)
        .arg(cursor)
        .arg("COUNT")
        .arg(count)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;
    parse_scan_pairs(raw, "hash")
}

async fn sscan_page_raw(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<serde_json::Value>), String> {
    let raw: RedisRawValue = redis::cmd("SSCAN")
        .arg(key)
        .arg(cursor)
        .arg("COUNT")
        .arg(count)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;
    parse_scan_members(raw)
}

async fn zscan_page_raw(
    con: &mut redis::aio::MultiplexedConnection,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<serde_json::Value>), String> {
    let raw: RedisRawValue = redis::cmd("ZSCAN")
        .arg(key)
        .arg(cursor)
        .arg("COUNT")
        .arg(count)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;
    parse_scan_pairs(raw, "zset")
}

fn parse_scan_pairs(raw: RedisRawValue, kind: &str) -> Result<(u64, Vec<serde_json::Value>), String> {
    let RedisRawValue::Array(parts) = raw else {
        return Err("Invalid SCAN response".to_string());
    };
    if parts.len() != 2 {
        return Err("Invalid SCAN response".to_string());
    }

    let cursor = redis_value_to_string(parts[0].clone())
        .ok_or("Invalid cursor")?
        .parse::<u64>()
        .map_err(|_| "Invalid cursor".to_string())?;

    let RedisRawValue::Array(entries) = &parts[1] else {
        return Err("Invalid SCAN entries".to_string());
    };

    let mut items = Vec::new();
    let mut iter = entries.iter();
    while let Some(a) = iter.next() {
        let Some(b) = iter.next() else { break };
        let a_str = redis_value_to_string(a.clone()).unwrap_or_default();
        let b_str = redis_value_to_string(b.clone()).unwrap_or_default();
        if kind == "zset" {
            items.push(serde_json::json!({"member": a_str, "score": b_str}));
        } else {
            items.push(serde_json::json!({"field": a_str, "value": b_str}));
        }
    }

    Ok((cursor, items))
}

fn parse_scan_members(raw: RedisRawValue) -> Result<(u64, Vec<serde_json::Value>), String> {
    let RedisRawValue::Array(parts) = raw else {
        return Err("Invalid SCAN response".to_string());
    };
    if parts.len() != 2 {
        return Err("Invalid SCAN response".to_string());
    }

    let cursor = redis_value_to_string(parts[0].clone())
        .ok_or("Invalid cursor")?
        .parse::<u64>()
        .map_err(|_| "Invalid cursor".to_string())?;

    let RedisRawValue::Array(entries) = &parts[1] else {
        return Err("Invalid SCAN entries".to_string());
    };

    let items =
        entries.iter().filter_map(|v| redis_value_to_string(v.clone())).map(|s| serde_json::Value::String(s)).collect();

    Ok((cursor, items))
}

#[cfg(test)]
mod tests {
    use super::{
        classify_command, parse_command_argv, parse_database_count, parse_scan_keys, parse_stream_entries,
        redis_command_raw_to_json, redis_key_bytes_to_display, redis_key_bytes_to_raw, redis_key_raw_to_bytes,
        redis_raw_to_json, redis_value_contains_binary, RedisCommandSafety, RedisRawValue,
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

    #[test]
    fn parses_command_text_with_quotes_and_escapes() {
        let argv = parse_command_argv(r#"SET "user:1" "Ada \"Lovelace\"""#).unwrap();

        assert_eq!(argv, vec!["SET", "user:1", "Ada \"Lovelace\""]);
    }

    #[test]
    fn rejects_empty_command_text() {
        assert_eq!(parse_command_argv("   ").unwrap_err(), "Redis command is empty");
    }

    #[test]
    fn classifies_safe_confirmed_and_blocked_commands() {
        assert_eq!(classify_command("GET"), RedisCommandSafety::Allowed);
        assert_eq!(classify_command("set"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("flushdb"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("KEYS"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("flushall"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("eval"), RedisCommandSafety::Blocked);
    }

    #[test]
    fn converts_command_results_to_json() {
        let raw = RedisRawValue::Array(vec![
            RedisRawValue::SimpleString("OK".to_string()),
            RedisRawValue::Int(2),
            RedisRawValue::Nil,
        ]);

        assert_eq!(redis_command_raw_to_json(raw), serde_json::json!(["OK", 2, null]));
    }
}
