use crate::models::connection::ConnectionConfig;
use base64::Engine;
use redis::{
    aio::ConnectionLike,
    cluster::ClusterClient,
    cluster_async::ClusterConnection,
    sentinel::{Sentinel, SentinelNodeConnectionInfo},
    ConnectionAddr, ConnectionInfo, FromRedisValue, ProtocolVersion, RedisConnectionInfo, TlsMode,
    Value as RedisRawValue,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const STREAM_ENTRY_LIMIT: usize = 100;
const COLLECTION_PAGE_SIZE: usize = 200;
const DEFAULT_REDIS_DATABASES: u32 = 16;
const CLUSTER_CURSOR_NODE_BITS: u64 = 16;
const CLUSTER_CURSOR_NODE_MASK: u64 = (1 << CLUSTER_CURSOR_NODE_BITS) - 1;
const CLUSTER_CURSOR_SCAN_MASK: u64 = (1 << (64 - CLUSTER_CURSOR_NODE_BITS)) - 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisDatabaseInfo {
    pub db: u32,
    pub keys: u64,
}

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
    pub total_keys: u64,
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

pub enum RedisConnection {
    Direct(Mutex<redis::aio::MultiplexedConnection>),
    Cluster(RedisClusterPool),
}

pub struct RedisClusterPool {
    pub connection: Mutex<ClusterConnection>,
    pub seed_nodes: Vec<RedisNodeEndpoint>,
    pub tls: bool,
    pub tls_insecure: bool,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RedisNodeEndpoint {
    pub host: String,
    pub port: u16,
}

pub async fn connect(url: &str, timeout: std::time::Duration) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(url).map_err(|e| format!("Redis connection failed: {e}"))?;
    let mut con = tokio::time::timeout(timeout, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| format!("Redis connection timed out ({}s)", timeout.as_secs()))?
        .map_err(|e| format!("Redis connection failed: {e}"))?;

    tokio::time::timeout(timeout, redis::cmd("PING").query_async::<String>(&mut con))
        .await
        .map_err(|_| format!("Redis ping timed out ({}s)", timeout.as_secs()))?
        .map_err(|e| format!("Redis authentication failed or command rejected: {e}"))?;

    Ok(con)
}

pub async fn connect_sentinel(config: &ConnectionConfig) -> Result<redis::aio::MultiplexedConnection, String> {
    let service_name = config.redis_sentinel_master.trim();
    if service_name.is_empty() {
        return Err("Redis Sentinel master name is required".to_string());
    }

    let nodes = redis_sentinel_nodes(config)?;
    let mut sentinel = Sentinel::build(nodes).map_err(|e| format!("Redis Sentinel connection failed: {e}"))?;
    let node_connection_info = SentinelNodeConnectionInfo {
        tls_mode: redis_tls_mode(config.ssl, config.redis_tls_insecure()),
        redis_connection_info: Some(redis_connection_info(&config.username, &config.password, 0)),
    };
    let client = tokio::time::timeout(
        super::connection_timeout(),
        sentinel.async_master_for(service_name, Some(&node_connection_info)),
    )
    .await
    .map_err(|_| format!("Redis Sentinel lookup timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
    .map_err(|e| format!("Redis Sentinel master lookup failed: {e}"))?;

    connect_client(client).await
}

pub async fn connect_cluster(config: &ConnectionConfig) -> Result<RedisClusterPool, String> {
    let seed_nodes = redis_cluster_seed_nodes(config)?;
    let cluster_nodes: Vec<ConnectionInfo> = seed_nodes
        .iter()
        .map(|endpoint| {
            connection_info(
                &endpoint.host,
                endpoint.port,
                config.ssl,
                config.redis_tls_insecure(),
                &config.username,
                &config.password,
                0,
            )
        })
        .collect();
    let client = ClusterClient::new(cluster_nodes).map_err(|e| format!("Redis cluster connection failed: {e}"))?;
    let mut con = tokio::time::timeout(super::connection_timeout(), client.get_async_connection())
        .await
        .map_err(|_| format!("Redis cluster connection timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
        .map_err(|e| format!("Redis cluster connection failed: {e}"))?;

    tokio::time::timeout(super::connection_timeout(), redis::cmd("PING").query_async::<String>(&mut con))
        .await
        .map_err(|_| format!("Redis cluster ping timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
        .map_err(|e| format!("Redis cluster authentication failed or command rejected: {e}"))?;

    Ok(RedisClusterPool {
        connection: Mutex::new(con),
        seed_nodes,
        tls: config.ssl,
        tls_insecure: config.redis_tls_insecure(),
        username: config.username.clone(),
        password: config.password.clone(),
    })
}

fn redis_sentinel_nodes(config: &ConnectionConfig) -> Result<Vec<ConnectionInfo>, String> {
    let raw_nodes = config.redis_sentinel_nodes.trim();
    let endpoints: Vec<String> = if raw_nodes.is_empty() {
        vec![format!("{}:{}", config.host.trim(), config.port)]
    } else {
        raw_nodes
            .split([',', ';', '\n', '\r'])
            .map(str::trim)
            .filter(|node| !node.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    };

    if endpoints.is_empty() {
        return Err("At least one Redis Sentinel node is required".to_string());
    }

    endpoints.iter().map(|endpoint| redis_sentinel_node_connection_info(config, endpoint)).collect()
}

fn redis_cluster_seed_nodes(config: &ConnectionConfig) -> Result<Vec<RedisNodeEndpoint>, String> {
    redis_node_endpoints(
        config.redis_cluster_nodes.trim(),
        config.host.trim(),
        config.port,
        "Redis cluster seed node",
        6379,
    )
}

fn redis_sentinel_node_connection_info(config: &ConnectionConfig, endpoint: &str) -> Result<ConnectionInfo, String> {
    let (host, port) = parse_redis_endpoint(endpoint, 26379)?;
    Ok(connection_info(
        &host,
        port,
        config.redis_sentinel_tls,
        config.redis_tls_insecure(),
        &config.redis_sentinel_username,
        &config.redis_sentinel_password,
        0,
    ))
}

fn redis_node_endpoints(
    raw_nodes: &str,
    fallback_host: &str,
    fallback_port: u16,
    label: &str,
    default_port: u16,
) -> Result<Vec<RedisNodeEndpoint>, String> {
    let endpoints: Vec<String> = if raw_nodes.is_empty() {
        vec![format!("{fallback_host}:{}", if fallback_port == 0 { default_port } else { fallback_port })]
    } else {
        raw_nodes
            .split([',', ';', '\n', '\r'])
            .map(str::trim)
            .filter(|node| !node.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    };

    if endpoints.is_empty() {
        return Err(format!("At least one {label} is required"));
    }

    endpoints
        .iter()
        .map(|endpoint| {
            let (host, port) = parse_redis_endpoint(endpoint, default_port)?;
            Ok(RedisNodeEndpoint { host, port })
        })
        .collect()
}

fn connection_info(
    host: &str,
    port: u16,
    tls: bool,
    insecure: bool,
    username: &str,
    password: &str,
    db: i64,
) -> ConnectionInfo {
    let addr = if tls {
        ConnectionAddr::TcpTls { host: host.to_string(), port, insecure, tls_params: None }
    } else {
        ConnectionAddr::Tcp(host.to_string(), port)
    };
    ConnectionInfo { addr, redis: redis_connection_info(username, password, db) }
}

fn redis_tls_mode(tls: bool, insecure: bool) -> Option<TlsMode> {
    if !tls {
        None
    } else if insecure {
        Some(TlsMode::Insecure)
    } else {
        Some(TlsMode::Secure)
    }
}

fn redis_connection_info(username: &str, password: &str, db: i64) -> RedisConnectionInfo {
    RedisConnectionInfo {
        db,
        username: non_empty_string(username),
        password: non_empty_string(password),
        protocol: ProtocolVersion::RESP2,
    }
}

fn non_empty_string(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_redis_endpoint(endpoint: &str, default_port: u16) -> Result<(String, u16), String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err("Redis node cannot be empty".to_string());
    }
    let endpoint = endpoint.strip_prefix("redis://").or_else(|| endpoint.strip_prefix("rediss://")).unwrap_or(endpoint);
    let endpoint = endpoint.rsplit_once('@').map(|(_, tail)| tail).unwrap_or(endpoint);
    let endpoint = endpoint.split(['/', '?', '#']).next().unwrap_or(endpoint);

    if let Some(rest) = endpoint.strip_prefix('[') {
        let Some((host, tail)) = rest.split_once(']') else {
            return Err(format!("Invalid Redis node '{endpoint}'"));
        };
        let port = tail.strip_prefix(':').filter(|value| !value.is_empty()).map(parse_redis_port).transpose()?;
        return Ok((host.to_string(), port.unwrap_or(default_port)));
    }

    if let Some((host, port)) = endpoint.rsplit_once(':') {
        if !host.contains(':') && port.chars().all(|ch| ch.is_ascii_digit()) {
            return Ok((host.to_string(), parse_redis_port(port)?));
        }
    }

    Ok((endpoint.to_string(), default_port))
}

fn parse_redis_port(port: &str) -> Result<u16, String> {
    port.parse::<u16>().map_err(|_| format!("Invalid Redis port '{port}'"))
}

async fn connect_client(client: redis::Client) -> Result<redis::aio::MultiplexedConnection, String> {
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

pub async fn connect_direct_node(
    endpoint: &RedisNodeEndpoint,
    tls: bool,
    insecure: bool,
    username: &str,
    password: &str,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let client =
        redis::Client::open(connection_info(&endpoint.host, endpoint.port, tls, insecure, username, password, 0))
            .map_err(|e| format!("Redis connection failed: {e}"))?;
    connect_client(client).await
}

pub async fn list_databases<C>(con: &mut C) -> Result<Vec<RedisDatabaseInfo>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let configured_count =
        redis::cmd("CONFIG").arg("GET").arg("databases").query_async(con).await.ok().and_then(parse_database_count);

    let keyspace_dbs = list_keyspace_databases(con).await.unwrap_or_default();
    let database_count = configured_count.unwrap_or(DEFAULT_REDIS_DATABASES);
    let max_db = keyspace_dbs.iter().map(|db| db.db).max().map(|db| db + 1).unwrap_or(0);
    let visible_count = database_count.max(max_db).max(1);
    let keyspace_counts =
        keyspace_dbs.into_iter().map(|db| (db.db, db.keys)).collect::<std::collections::HashMap<_, _>>();

    Ok((0..visible_count)
        .map(|db| RedisDatabaseInfo { db, keys: keyspace_counts.get(&db).copied().unwrap_or(0) })
        .collect())
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

async fn list_keyspace_databases<C>(con: &mut C) -> Result<Vec<RedisDatabaseInfo>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let info: String = redis::cmd("INFO").arg("keyspace").query_async(con).await.map_err(|e| e.to_string())?;

    let mut dbs = Vec::new();
    for line in info.lines() {
        if line.starts_with("db") {
            if let Some((db_part, stats_part)) = line.split_once(':') {
                if let Some(num) = db_part.strip_prefix("db") {
                    if let Ok(db) = num.parse::<u32>() {
                        let keys = stats_part
                            .split(',')
                            .find_map(|part| part.strip_prefix("keys=").and_then(|value| value.parse::<u64>().ok()))
                            .unwrap_or(0);
                        dbs.push(RedisDatabaseInfo { db, keys });
                    }
                }
            }
        }
    }
    Ok(dbs)
}

pub async fn select_db<C>(con: &mut C, db: u32) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("SELECT").arg(db).query_async(con).await.map_err(|e| e.to_string())
}

pub fn ensure_cluster_db(db: u32) -> Result<(), String> {
    if db == 0 {
        Ok(())
    } else {
        Err("Redis Cluster only supports db0".to_string())
    }
}

pub fn encode_cluster_cursor(node_index: usize, cursor: u64) -> Result<u64, String> {
    if node_index > CLUSTER_CURSOR_NODE_MASK as usize {
        return Err("Redis cluster cursor exceeded node limit".to_string());
    }
    if cursor > CLUSTER_CURSOR_SCAN_MASK {
        return Err("Redis cluster cursor exceeded scan limit".to_string());
    }
    Ok(((node_index as u64) << (64 - CLUSTER_CURSOR_NODE_BITS)) | (cursor & CLUSTER_CURSOR_SCAN_MASK))
}

pub fn decode_cluster_cursor(cursor: u64) -> (usize, u64) {
    if cursor == 0 {
        return (0, 0);
    }
    let node_index = (cursor >> (64 - CLUSTER_CURSOR_NODE_BITS)) as usize;
    let node_cursor = cursor & CLUSTER_CURSOR_SCAN_MASK;
    (node_index, node_cursor)
}

pub async fn list_cluster_databases(pool: &RedisClusterPool) -> Result<Vec<RedisDatabaseInfo>, String> {
    let master_nodes = cluster_master_nodes(pool).await?;
    let keys = cluster_total_keys(pool, &master_nodes).await;
    Ok(vec![RedisDatabaseInfo { db: 0, keys }])
}

pub async fn scan_cluster_keys_page(
    pool: &RedisClusterPool,
    cursor: u64,
    pattern: &str,
    count: usize,
) -> Result<RedisScanResult, String> {
    let master_nodes = cluster_master_nodes(pool).await?;
    if master_nodes.is_empty() {
        return Ok(RedisScanResult { cursor: 0, keys: Vec::new(), total_keys: 0 });
    }

    let (mut node_index, node_cursor) = decode_cluster_cursor(cursor);
    if node_index >= master_nodes.len() {
        node_index = 0;
    }

    let total_keys = cluster_total_keys(pool, &master_nodes).await;
    for index in node_index..master_nodes.len() {
        let endpoint = &master_nodes[index];
        let mut con =
            connect_direct_node(endpoint, pool.tls, pool.tls_insecure, &pool.username, &pool.password).await?;
        let current_cursor = if index == node_index { node_cursor } else { 0 };
        let result = scan_keys_page(&mut con, current_cursor, pattern, count).await?;
        if !result.keys.is_empty() {
            let next_cursor = if result.cursor != 0 {
                encode_cluster_cursor(index, result.cursor)?
            } else if index + 1 < master_nodes.len() {
                encode_cluster_cursor(index + 1, 0)?
            } else {
                0
            };
            return Ok(RedisScanResult { cursor: next_cursor, keys: result.keys, total_keys });
        }
        if result.cursor != 0 {
            return Ok(RedisScanResult {
                cursor: encode_cluster_cursor(index, result.cursor)?,
                keys: Vec::new(),
                total_keys,
            });
        }
    }

    Ok(RedisScanResult { cursor: 0, keys: Vec::new(), total_keys })
}

pub async fn scan_cluster_values_page(
    pool: &RedisClusterPool,
    cursor: u64,
    pattern: &str,
    query: &str,
    count: usize,
) -> Result<RedisScanResult, String> {
    let master_nodes = cluster_master_nodes(pool).await?;
    if master_nodes.is_empty() {
        return Ok(RedisScanResult { cursor: 0, keys: Vec::new(), total_keys: 0 });
    }

    let (mut node_index, node_cursor) = decode_cluster_cursor(cursor);
    if node_index >= master_nodes.len() {
        node_index = 0;
    }

    let total_keys = cluster_total_keys(pool, &master_nodes).await;
    for index in node_index..master_nodes.len() {
        let endpoint = &master_nodes[index];
        let mut con =
            connect_direct_node(endpoint, pool.tls, pool.tls_insecure, &pool.username, &pool.password).await?;
        let current_cursor = if index == node_index { node_cursor } else { 0 };
        let result = scan_values_page(&mut con, current_cursor, pattern, query, count).await?;
        if !result.keys.is_empty() {
            let next_cursor = if result.cursor != 0 {
                encode_cluster_cursor(index, result.cursor)?
            } else if index + 1 < master_nodes.len() {
                encode_cluster_cursor(index + 1, 0)?
            } else {
                0
            };
            return Ok(RedisScanResult { cursor: next_cursor, keys: result.keys, total_keys });
        }
        if result.cursor != 0 {
            return Ok(RedisScanResult {
                cursor: encode_cluster_cursor(index, result.cursor)?,
                keys: Vec::new(),
                total_keys,
            });
        }
    }

    Ok(RedisScanResult { cursor: 0, keys: Vec::new(), total_keys })
}

pub async fn cluster_master_nodes(pool: &RedisClusterPool) -> Result<Vec<RedisNodeEndpoint>, String> {
    cluster_master_nodes_from_seeds(&pool.seed_nodes, pool.tls, pool.tls_insecure, &pool.username, &pool.password).await
}

pub async fn flush_cluster(pool: &RedisClusterPool) -> Result<(), String> {
    let master_nodes = cluster_master_nodes(pool).await?;
    for endpoint in master_nodes {
        let mut con =
            connect_direct_node(&endpoint, pool.tls, pool.tls_insecure, &pool.username, &pool.password).await?;
        flush_db(&mut con).await?;
    }
    Ok(())
}

async fn cluster_total_keys(pool: &RedisClusterPool, master_nodes: &[RedisNodeEndpoint]) -> u64 {
    let mut total = 0;
    for endpoint in master_nodes {
        let Ok(mut con) =
            connect_direct_node(endpoint, pool.tls, pool.tls_insecure, &pool.username, &pool.password).await
        else {
            continue;
        };
        total += redis::cmd("DBSIZE").query_async::<u64>(&mut con).await.unwrap_or(0);
    }
    total
}

async fn cluster_master_nodes_from_seeds(
    seed_nodes: &[RedisNodeEndpoint],
    tls: bool,
    insecure: bool,
    username: &str,
    password: &str,
) -> Result<Vec<RedisNodeEndpoint>, String> {
    let mut last_error = None;
    for endpoint in seed_nodes {
        let mut con = match connect_direct_node(endpoint, tls, insecure, username, password).await {
            Ok(con) => con,
            Err(err) => {
                last_error = Some(err);
                continue;
            }
        };
        let raw: RedisRawValue = match redis::cmd("CLUSTER").arg("SLOTS").query_async(&mut con).await {
            Ok(raw) => raw,
            Err(err) => {
                last_error = Some(err.to_string());
                continue;
            }
        };
        let nodes = parse_cluster_slots(raw, &endpoint.host)?;
        if !nodes.is_empty() {
            return Ok(nodes);
        }
    }

    Err(last_error.unwrap_or_else(|| "Redis cluster master discovery failed".to_string()))
}

fn parse_cluster_slots(raw: RedisRawValue, fallback_host: &str) -> Result<Vec<RedisNodeEndpoint>, String> {
    let RedisRawValue::Array(slots) = raw else {
        return Err("Invalid Redis CLUSTER SLOTS response".to_string());
    };

    let mut seen = std::collections::HashSet::new();
    let mut nodes = Vec::new();
    for slot in slots {
        let RedisRawValue::Array(parts) = slot else {
            continue;
        };
        if parts.len() < 3 {
            continue;
        }
        let Some(endpoint) = parse_cluster_slot_master(parts[2].clone(), fallback_host)? else {
            continue;
        };
        if seen.insert((endpoint.host.clone(), endpoint.port)) {
            nodes.push(endpoint);
        }
    }
    Ok(nodes)
}

fn parse_cluster_slot_master(value: RedisRawValue, fallback_host: &str) -> Result<Option<RedisNodeEndpoint>, String> {
    let RedisRawValue::Array(parts) = value else {
        return Ok(None);
    };
    if parts.len() < 2 {
        return Ok(None);
    }
    let host = match &parts[0] {
        RedisRawValue::Nil => fallback_host.to_string(),
        other => redis_value_to_string(other.clone()).unwrap_or_else(|| fallback_host.to_string()),
    };
    if host.trim().is_empty() {
        return Ok(None);
    }
    let Some(port_text) = redis_value_to_string(parts[1].clone()) else {
        return Err("Invalid Redis cluster node port".to_string());
    };
    let port = parse_redis_port(&port_text)?;
    Ok(Some(RedisNodeEndpoint { host, port }))
}

pub fn parse_command_argv(command_text: &str) -> Result<Vec<String>, String> {
    // Strip trailing semicolons so commands like "HGETALL aaa;" work naturally
    let command_text = command_text.trim_end().trim_end_matches(';');
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

pub fn is_redis_json_type(key_type: &str) -> bool {
    matches!(key_type.to_ascii_uppercase().as_str(), "REJSON-RL" | "JSON")
}

pub fn redis_json_raw_to_json(value: RedisRawValue) -> Result<serde_json::Value, String> {
    match redis_raw_to_json(value) {
        serde_json::Value::Null => Ok(serde_json::Value::Null),
        serde_json::Value::String(text) => {
            serde_json::from_str(&text).map_err(|e| format!("Invalid RedisJSON value: {e}"))
        }
        other => Ok(other),
    }
}

pub fn redis_json_value_preview(value: &serde_json::Value) -> String {
    const MAX_PREVIEW_LEN: usize = 160;
    let text = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    if text.chars().count() <= MAX_PREVIEW_LEN {
        return text;
    }
    let mut preview = text.chars().take(MAX_PREVIEW_LEN).collect::<String>();
    preview.push('…');
    preview
}

pub fn redis_key_value_preview(key_type: &str) -> String {
    if is_redis_json_type(key_type) {
        "{...}".to_string()
    } else {
        String::new()
    }
}

pub async fn flush_db<C>(con: &mut C) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("FLUSHDB").query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn execute_command<C>(
    con: &mut C,
    command_text: &str,
    skip_safety_check: bool,
) -> Result<RedisCommandResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let argv = parse_command_argv(command_text)?;
    let command = argv[0].to_ascii_uppercase();
    let safety = classify_command(&command);
    if !skip_safety_check && safety == RedisCommandSafety::Blocked {
        return Err(format!("Redis command is blocked for safety: {command}"));
    }

    let mut cmd = redis::cmd(&argv[0]);
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }
    let raw: RedisRawValue = cmd.query_async(con).await.map_err(|e| e.to_string())?;

    Ok(RedisCommandResult { command, safety, value: redis_command_raw_to_json(raw) })
}

pub async fn scan_keys_page<C>(con: &mut C, cursor: u64, pattern: &str, count: usize) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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
    let total_keys: u64 = redis::cmd("DBSIZE").query_async(con).await.unwrap_or(0);
    if keys.is_empty() {
        return Ok(RedisScanResult { cursor: next_cursor, keys: Vec::new(), total_keys });
    }

    let mut pipe = redis::pipe();
    for key in &keys {
        pipe.cmd("TYPE").arg(key);
    }
    let key_types: Vec<String> = pipe.query_async(con).await.unwrap_or_default();

    let mut result = Vec::with_capacity(keys.len());
    for (index, key) in keys.iter().enumerate() {
        let key_type = key_types.get(index).cloned().unwrap_or_else(|| "unknown".to_string());
        result.push(RedisKeyInfo {
            key_display: redis_key_bytes_to_display(key),
            key_raw: redis_key_bytes_to_raw(key),
            key_type,
            ttl: -2,
            size: 0,
            value_preview: redis_key_value_preview(key_types.get(index).map(String::as_str).unwrap_or("unknown")),
        });
    }
    Ok(RedisScanResult { cursor: next_cursor, keys: result, total_keys })
}

pub async fn scan_values_page<C>(
    con: &mut C,
    cursor: u64,
    pattern: &str,
    query: &str,
    count: usize,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let total_keys: u64 = redis::cmd("DBSIZE").query_async(con).await.unwrap_or(0);
    if query.trim().is_empty() {
        return Ok(RedisScanResult { cursor, keys: Vec::new(), total_keys });
    }

    let scan_count = count.max(1);
    let raw: RedisRawValue = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(pattern)
        .arg("COUNT")
        .arg(scan_count)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    let (next_cursor, keys) = parse_scan_keys(raw)?;
    let mut result = Vec::new();
    for key in keys {
        let Ok(value) = get_value(con, &key).await else {
            continue;
        };
        if !redis_value_matches_query(&value.value, query) {
            continue;
        }

        let value_preview = redis_search_value_preview(&value.value);
        result.push(RedisKeyInfo {
            key_display: value.key_display,
            key_raw: value.key_raw,
            key_type: value.key_type,
            ttl: value.ttl,
            size: redis_search_value_size(&value.value, value.total),
            value_preview,
        });
    }

    Ok(RedisScanResult { cursor: next_cursor, keys: result, total_keys })
}

pub async fn get_value<C>(con: &mut C, key: &[u8]) -> Result<RedisValue, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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
        key_type if is_redis_json_type(key_type) => {
            let raw: RedisRawValue =
                redis::cmd("JSON.GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            (redis_json_raw_to_json(raw)?, false, None, None)
        }
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

fn redis_value_matches_query(value: &serde_json::Value, query: &str) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return false;
    }
    redis_search_value_text(value).to_lowercase().contains(&query.to_lowercase())
}

fn redis_search_value_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(arr) => {
            // Hash type: [{field: "f1", value: "v1"}, ...] — extract field names and values
            if let Some(first) = arr.first() {
                if first.get("field").is_some() && first.get("value").is_some() {
                    let parts: Vec<String> = arr
                        .iter()
                        .flat_map(|item| {
                            let f = item.get("field").and_then(|v| v.as_str()).unwrap_or("");
                            let v = item.get("value").and_then(|v| v.as_str()).unwrap_or("");
                            vec![f.to_string(), v.to_string()]
                        })
                        .filter(|s| !s.is_empty())
                        .collect();
                    return parts.join(" ");
                }
            }
            if arr.is_empty() {
                return String::new();
            }
            serde_json::to_string(&arr).unwrap_or_default()
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
    }
}

fn redis_search_value_preview(value: &serde_json::Value) -> String {
    const MAX_PREVIEW_LEN: usize = 160;
    let text = redis_search_value_text(value);
    if text.chars().count() <= MAX_PREVIEW_LEN {
        return text;
    }
    let mut preview = text.chars().take(MAX_PREVIEW_LEN).collect::<String>();
    preview.push('…');
    preview
}

fn redis_search_value_size(value: &serde_json::Value, total: Option<u64>) -> u64 {
    if let Some(total) = total {
        return total;
    }
    match value {
        serde_json::Value::String(text) => text.len() as u64,
        _ => 0,
    }
}

async fn get_stream_entries<C>(con: &mut C, key: &[u8]) -> Result<serde_json::Value, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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

pub async fn set_string<C>(con: &mut C, key: &[u8], value: &str, ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("SET").arg(key).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    if let Some(t) = ttl {
        if t > 0 {
            redis::cmd("EXPIRE").arg(key).arg(t).query_async::<()>(con).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn delete_key<C>(con: &mut C, key: &[u8]) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("DEL").arg(key).query_async::<()>(con).await.map_err(|e| e.to_string())
}

async fn apply_expire_if_needed<C>(con: &mut C, key: &[u8], ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    if let Some(t) = ttl {
        if t > 0 {
            redis::cmd("EXPIRE").arg(key).arg(t).query_async::<()>(con).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn hash_set<C>(con: &mut C, key: &[u8], field: &str, value: &str, ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("HSET").arg(key).arg(field).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn hash_del<C>(con: &mut C, key: &[u8], field: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("HDEL").arg(key).arg(field).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn list_push<C>(con: &mut C, key: &[u8], value: &str, ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("RPUSH").arg(key).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn list_set<C>(con: &mut C, key: &[u8], index: i64, value: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("LSET").arg(key).arg(index).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn list_remove<C>(con: &mut C, key: &[u8], index: i64) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let placeholder = "__DELETED_PLACEHOLDER__";
    redis::cmd("LSET").arg(key).arg(index).arg(placeholder).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    redis::cmd("LREM").arg(key).arg(1).arg(placeholder).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn set_add<C>(con: &mut C, key: &[u8], member: &str, ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("SADD").arg(key).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn set_remove<C>(con: &mut C, key: &[u8], member: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("SREM").arg(key).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn zadd<C>(con: &mut C, key: &[u8], member: &str, score: f64, ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("ZADD").arg(key).arg(score).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn zrem<C>(con: &mut C, key: &[u8], member: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("ZREM").arg(key).arg(member).query_async::<()>(con).await.map_err(|e| e.to_string())
}

pub async fn stream_add<C>(
    con: &mut C,
    key: &[u8],
    entry_id: &str,
    fields: &[(String, String)],
    ttl: Option<i64>,
) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cmd = redis::cmd("XADD");
    cmd.arg(key).arg(entry_id);
    for (field, value) in fields {
        cmd.arg(field.as_str()).arg(value.as_str());
    }
    cmd.query_async::<()>(con).await.map_err(|e| e.to_string())?;
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn json_set<C>(con: &mut C, key: &[u8], value: &str, ttl: Option<i64>) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("JSON.SET").arg(key).arg("$").arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn check_json_module<C>(con: &mut C) -> Result<bool, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let raw: RedisRawValue = redis::cmd("MODULE").arg("LIST").query_async(con).await.map_err(|e| e.to_string())?;
    Ok(match raw {
        RedisRawValue::Array(modules) => modules.iter().any(|module| {
            if let RedisRawValue::Array(kvs) = module {
                kvs.get(1)
                    .is_some_and(|v| matches!(v, RedisRawValue::BulkString(n) if n.eq_ignore_ascii_case(b"ReJSON")))
            } else {
                false
            }
        }),
        _ => false,
    })
}

pub async fn set_ttl<C>(con: &mut C, key: &[u8], ttl: i64) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    if ttl > 0 {
        redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<()>(con).await.map_err(|e| e.to_string())
    } else {
        redis::cmd("PERSIST").arg(key).query_async::<()>(con).await.map_err(|e| e.to_string())
    }
}

pub async fn delete_keys<C>(con: &mut C, keys: &[Vec<u8>]) -> Result<u64, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cmd = redis::cmd("DEL");
    for key in keys {
        cmd.arg(key.as_slice());
    }
    cmd.query_async(con).await.map_err(|e| e.to_string())
}

pub async fn load_more_collection<C>(
    con: &mut C,
    key: &[u8],
    key_type: &str,
    cursor: u64,
    count: usize,
) -> Result<RedisValue, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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

async fn hscan_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<serde_json::Value>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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

async fn sscan_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<serde_json::Value>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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

async fn zscan_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<serde_json::Value>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
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
        entries.iter().filter_map(|v| redis_value_to_string(v.clone())).map(serde_json::Value::String).collect();

    Ok((cursor, items))
}

#[cfg(test)]
mod tests {
    use super::{
        classify_command, connection_info, decode_cluster_cursor, encode_cluster_cursor, is_redis_json_type,
        parse_cluster_slots, parse_command_argv, parse_database_count, parse_redis_endpoint, parse_scan_keys,
        parse_stream_entries, redis_command_raw_to_json, redis_json_raw_to_json, redis_json_value_preview,
        redis_key_bytes_to_display, redis_key_bytes_to_raw, redis_key_raw_to_bytes, redis_key_value_preview,
        redis_raw_to_json, redis_value_contains_binary, redis_value_matches_query, RedisCommandSafety,
        RedisNodeEndpoint, RedisRawValue,
    };
    use redis::ConnectionAddr;

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
    fn matches_redis_values_case_insensitively() {
        assert!(redis_value_matches_query(&serde_json::json!("Hello Redis"), "redis"));
        assert!(redis_value_matches_query(&serde_json::json!({"field": "Ada Lovelace"}), "lovelace"));
        assert!(!redis_value_matches_query(&serde_json::json!("Hello Redis"), ""));
        assert!(!redis_value_matches_query(&serde_json::json!("Hello Redis"), "mysql"));
    }

    #[test]
    fn matches_hash_field_name_in_value_search() {
        let hash_value = serde_json::json!([
            {"field": "name", "value": "Alice"},
            {"field": "email", "value": "alice@example.com"},
        ]);
        assert!(redis_value_matches_query(&hash_value, "name"));
        assert!(redis_value_matches_query(&hash_value, "email"));
    }

    #[test]
    fn matches_hash_field_value_in_value_search() {
        let hash_value = serde_json::json!([
            {"field": "name", "value": "Alice"},
            {"field": "email", "value": "alice@example.com"},
        ]);
        assert!(redis_value_matches_query(&hash_value, "alice"));
        assert!(redis_value_matches_query(&hash_value, "example"));
    }

    #[test]
    fn empty_hash_does_not_match() {
        let empty_hash = serde_json::json!([]);
        assert!(!redis_value_matches_query(&empty_hash, "anything"));
    }

    #[test]
    fn non_hash_array_unaffected() {
        let set_value = serde_json::json!(["member1", "member2", "hello"]);
        assert!(redis_value_matches_query(&set_value, "member1"));
        assert!(redis_value_matches_query(&set_value, "hello"));
        assert!(!redis_value_matches_query(&set_value, "nonexistent"));
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

    #[test]
    fn recognizes_redis_json_module_key_types() {
        assert!(is_redis_json_type("ReJSON-RL"));
        assert!(is_redis_json_type("json"));
        assert!(!is_redis_json_type("string"));
    }

    #[test]
    fn parses_redis_sentinel_endpoints_with_default_ports() {
        assert_eq!(parse_redis_endpoint("sentinel.local:26380", 26379).unwrap(), ("sentinel.local".to_string(), 26380));
        assert_eq!(
            parse_redis_endpoint("redis://user:pass@sentinel.local:26380/0", 26379).unwrap(),
            ("sentinel.local".to_string(), 26380)
        );
        assert_eq!(parse_redis_endpoint("sentinel.local", 26379).unwrap(), ("sentinel.local".to_string(), 26379));
        assert_eq!(parse_redis_endpoint("[::1]:26380", 26379).unwrap(), ("::1".to_string(), 26380));
        assert_eq!(parse_redis_endpoint("::1", 26379).unwrap(), ("::1".to_string(), 26379));
    }

    #[test]
    fn redis_connection_info_marks_tls_as_insecure_when_requested() {
        let info = connection_info("cache.example.com", 6379, true, true, "default", "secret", 0);

        assert!(matches!(info.addr, ConnectionAddr::TcpTls { insecure: true, .. }));
    }

    #[test]
    fn encodes_and_decodes_cluster_scan_cursor() {
        let encoded = encode_cluster_cursor(12, 3456).unwrap();

        assert_eq!(decode_cluster_cursor(encoded), (12, 3456));
        assert_eq!(decode_cluster_cursor(0), (0, 0));
    }

    #[test]
    fn parses_cluster_slots_master_nodes() {
        let raw = RedisRawValue::Array(vec![
            RedisRawValue::Array(vec![
                RedisRawValue::Int(0),
                RedisRawValue::Int(5460),
                RedisRawValue::Array(vec![
                    RedisRawValue::BulkString(b"10.0.0.1".to_vec()),
                    RedisRawValue::Int(7000),
                    RedisRawValue::BulkString(b"node-a".to_vec()),
                ]),
            ]),
            RedisRawValue::Array(vec![
                RedisRawValue::Int(5461),
                RedisRawValue::Int(10922),
                RedisRawValue::Array(vec![
                    RedisRawValue::BulkString(b"10.0.0.2".to_vec()),
                    RedisRawValue::Int(7001),
                    RedisRawValue::BulkString(b"node-b".to_vec()),
                ]),
            ]),
        ]);

        assert_eq!(
            parse_cluster_slots(raw, "127.0.0.1").unwrap(),
            vec![
                RedisNodeEndpoint { host: "10.0.0.1".to_string(), port: 7000 },
                RedisNodeEndpoint { host: "10.0.0.2".to_string(), port: 7001 },
            ]
        );
    }

    #[test]
    fn parses_redis_json_get_bulk_string() {
        let raw = bulk(r#"{"id":1,"embedding":[0.1,0.2],"meta":{"source":"test"}}"#);

        assert_eq!(
            redis_json_raw_to_json(raw).unwrap(),
            serde_json::json!({
                "id": 1,
                "embedding": [0.1, 0.2],
                "meta": { "source": "test" }
            })
        );
    }

    #[test]
    fn builds_compact_redis_json_value_preview() {
        let value = serde_json::json!({ "id": 1, "embedding": [0.1, 0.2] });

        assert_eq!(redis_json_value_preview(&value), r#"{"id":1,"embedding":[0.1,0.2]}"#);
    }

    #[test]
    fn uses_lightweight_redis_json_placeholder_for_key_scan_preview() {
        assert_eq!(redis_key_value_preview("ReJSON-RL"), "{...}");
        assert_eq!(redis_key_value_preview("string"), "");
    }
}
