use crate::models::connection::ConnectionConfig;
use base64::Engine;
use redis::{
    aio::ConnectionLike,
    cluster::ClusterClient,
    cluster_async::ClusterConnection,
    sentinel::{Sentinel, SentinelNodeConnectionInfo},
    Cmd, ConnectionAddr, ConnectionInfo, FromRedisValue, Pipeline, ProtocolVersion, RedisConnectionInfo, RedisFuture,
    TlsMode, Value as RedisRawValue,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, MutexGuard};

use super::json_value_for_js;

const STREAM_ENTRY_LIMIT: usize = 100;
const COLLECTION_PAGE_SIZE: usize = 200;
const HASH_FILTER_SCAN_MAX_ITERATIONS: usize = 10;
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key_type: String,
    #[serde(default = "default_missing_ttl", skip_serializing_if = "is_missing_ttl")]
    pub ttl: i64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub size: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value_preview: String,
}

fn default_missing_ttl() -> i64 {
    -2
}

fn is_missing_ttl(ttl: &i64) -> bool {
    *ttl == -2
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
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
    pub ttl: i64,
    pub redis_type: String,
    pub data: RedisValueData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedisBlobEncoding {
    Utf8,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisBlob {
    pub raw_base64: String,
    pub encoding: RedisBlobEncoding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisListItem {
    pub index: u64,
    pub value: RedisBlob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisSetItem {
    pub member: RedisBlob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisHashItem {
    pub field: RedisBlob,
    pub value: RedisBlob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisZsetItem {
    pub score: String,
    pub member: RedisBlob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamField {
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamEntry {
    pub id: String,
    pub fields: Vec<RedisStreamField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedisValueData {
    String {
        content: RedisBlob,
    },
    Json {
        /// Original JSON.GET payload used throughout the RedisJSON UI.
        value: String,
    },
    List {
        items: Vec<RedisListItem>,
        total: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Set {
        items: Vec<RedisSetItem>,
        total: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Hash {
        items: Vec<RedisHashItem>,
        total: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Zset {
        items: Vec<RedisZsetItem>,
        total: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Stream {
        entries: Vec<RedisStreamEntry>,
    },
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedisCollectionPage {
    List {
        items: Vec<RedisListItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Set {
        items: Vec<RedisSetItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Hash {
        items: Vec<RedisHashItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
    Zset {
        items: Vec<RedisZsetItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scan_cursor: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedisCommandSafety {
    Allowed,
    Write,
    Confirm,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisCommandResult {
    pub command: String,
    pub safety: RedisCommandSafety,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubSubMessage {
    pub channel: String,
    pub pattern: Option<String>,
    pub payload: String,
}

pub enum RedisConnection {
    Direct(Mutex<redis::aio::MultiplexedConnection>),
    Cluster(RedisClusterPool),
}

pub struct RedisClusterPool {
    pub connection: Option<Mutex<ClusterConnection>>,
    pub seed_nodes: Vec<RedisNodeEndpoint>,
    pub seed_routes: Vec<RedisNodeRoute>,
    pub slot_ranges: Vec<RedisClusterSlotRange>,
    pub node_routes: Vec<RedisNodeRoute>,
    pub tls: bool,
    pub tls_insecure: bool,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisClusterAuth {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisSlowlogEntry {
    pub id: u64,
    pub timestamp: i64,
    pub duration_micros: u64,
    pub command: String,
    pub client_addr: Option<String>,
    pub client_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisNodeRoute {
    pub advertised: RedisNodeEndpoint,
    pub connect: RedisNodeEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisClusterSlotRange {
    pub start: u16,
    pub end: u16,
    pub master: RedisNodeEndpoint,
}

pub enum RedisClusterConnectionGuard<'a> {
    Native(MutexGuard<'a, ClusterConnection>),
    Direct(redis::aio::MultiplexedConnection),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RedisAuthCandidate {
    username: String,
    password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RedisNodeEndpoint {
    pub host: String,
    pub port: u16,
}

impl ConnectionLike for RedisClusterConnectionGuard<'_> {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, RedisRawValue> {
        match self {
            RedisClusterConnectionGuard::Native(con) => con.req_packed_command(cmd),
            RedisClusterConnectionGuard::Direct(con) => con.req_packed_command(cmd),
        }
    }

    fn req_packed_commands<'a>(
        &'a mut self,
        cmd: &'a Pipeline,
        offset: usize,
        count: usize,
    ) -> RedisFuture<'a, Vec<RedisRawValue>> {
        match self {
            RedisClusterConnectionGuard::Native(con) => con.req_packed_commands(cmd, offset, count),
            RedisClusterConnectionGuard::Direct(con) => con.req_packed_commands(cmd, offset, count),
        }
    }

    fn get_db(&self) -> i64 {
        match self {
            RedisClusterConnectionGuard::Native(con) => con.get_db(),
            RedisClusterConnectionGuard::Direct(con) => con.get_db(),
        }
    }
}

pub async fn connect(url: &str, timeout: std::time::Duration) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(url).map_err(|e| format!("Redis connection failed: {e}"))?;
    connect_client_with_timeout(client, timeout, "Redis").await
}

pub async fn connect_standalone(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    timeout: std::time::Duration,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let mut last_error = None;
    for auth in redis_auth_candidates(&config.username, &config.password) {
        let client = redis::Client::open(connection_info(
            host,
            port,
            config.ssl,
            config.redis_tls_insecure(),
            &auth.username,
            &auth.password,
            redis_database_index(config),
        ))
        .map_err(|e| format!("Redis connection failed: {e}"))?;
        match connect_client_with_timeout(client, timeout, "Redis").await {
            Ok(con) => return Ok(con),
            Err(err) if last_error.is_none() || is_redis_auth_error(&err) => {
                let should_retry = is_redis_auth_error(&err);
                last_error = Some(err);
                if !should_retry {
                    break;
                }
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "Redis connection failed".to_string()))
}

async fn connect_client_with_timeout(
    client: redis::Client,
    timeout: std::time::Duration,
    label: &str,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let mut con = tokio::time::timeout(timeout, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| format!("{label} connection timed out ({}s)", timeout.as_secs()))?
        .map_err(|e| format!("{label} connection failed: {e}"))?;

    tokio::time::timeout(timeout, redis::cmd("PING").query_async::<String>(&mut con))
        .await
        .map_err(|_| format!("{label} ping timed out ({}s)", timeout.as_secs()))?
        .map_err(|e| format!("{label} authentication failed or command rejected: {e}"))?;

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

pub async fn discover_sentinel_master(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<RedisNodeEndpoint, String> {
    let service_name = config.redis_sentinel_master.trim();
    if service_name.is_empty() {
        return Err("Redis Sentinel master name is required".to_string());
    }

    let client = redis::Client::open(connection_info(
        host,
        port,
        config.redis_sentinel_tls,
        config.redis_tls_insecure(),
        &config.redis_sentinel_username,
        &config.redis_sentinel_password,
        0,
    ))
    .map_err(|e| format!("Redis Sentinel connect failed: {e}"))?;
    let mut con = connect_client_with_timeout(client, super::connection_timeout(), "Redis Sentinel").await?;
    let raw = tokio::time::timeout(
        super::connection_timeout(),
        redis::cmd("SENTINEL").arg("get-master-addr-by-name").arg(service_name).query_async::<RedisRawValue>(&mut con),
    )
    .await
    .map_err(|_| format!("Redis Sentinel master lookup timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
    .map_err(|e| format!("Redis Sentinel master lookup failed: {e}"))?;

    redis_sentinel_master_endpoint(raw)
}

pub async fn connect_cluster(config: &ConnectionConfig) -> Result<RedisClusterPool, String> {
    let seed_nodes = redis_cluster_seed_nodes(config)?;
    let mut last_error = None;
    for auth in redis_auth_candidates(&config.username, &config.password) {
        let cluster_nodes: Vec<ConnectionInfo> = seed_nodes
            .iter()
            .map(|endpoint| {
                connection_info(
                    &endpoint.host,
                    endpoint.port,
                    config.ssl,
                    config.redis_tls_insecure(),
                    &auth.username,
                    &auth.password,
                    0,
                )
            })
            .collect();
        let client = ClusterClient::new(cluster_nodes).map_err(|e| format!("Redis cluster connection failed: {e}"))?;
        let mut con = match tokio::time::timeout(super::connection_timeout(), client.get_async_connection())
            .await
            .map_err(|_| format!("Redis cluster connection timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
            .map_err(|e| format!("Redis cluster connection failed: {e}"))
        {
            Ok(con) => con,
            Err(err) if last_error.is_none() || is_redis_auth_error(&err) => {
                let should_retry = is_redis_auth_error(&err);
                last_error = Some(err);
                if should_retry {
                    continue;
                }
                break;
            }
            Err(err) => return Err(err),
        };

        match tokio::time::timeout(super::connection_timeout(), redis::cmd("PING").query_async::<String>(&mut con))
            .await
            .map_err(|_| format!("Redis cluster ping timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
            .map_err(|e| format!("Redis cluster authentication failed or command rejected: {e}"))
        {
            Ok(_) => {
                let seed_routes = identity_routes(&seed_nodes);
                let slot_ranges = cluster_slot_ranges_from_routes(
                    &seed_routes,
                    config.ssl,
                    config.redis_tls_insecure(),
                    &auth.username,
                    &auth.password,
                )
                .await
                .unwrap_or_default();
                let node_routes = identity_routes(&unique_master_nodes(&slot_ranges));
                return Ok(RedisClusterPool {
                    connection: Some(Mutex::new(con)),
                    seed_nodes,
                    seed_routes,
                    slot_ranges,
                    node_routes,
                    tls: config.ssl,
                    tls_insecure: config.redis_tls_insecure(),
                    username: auth.username,
                    password: auth.password,
                });
            }
            Err(err) if last_error.is_none() || is_redis_auth_error(&err) => {
                let should_retry = is_redis_auth_error(&err);
                last_error = Some(err);
                if !should_retry {
                    break;
                }
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "Redis cluster connection failed".to_string()))
}

pub async fn discover_cluster_slot_ranges_from_routes(
    config: &ConnectionConfig,
    seed_routes: &[RedisNodeRoute],
) -> Result<(RedisClusterAuth, Vec<RedisClusterSlotRange>), String> {
    let mut last_error = None;
    for auth in redis_auth_candidates(&config.username, &config.password) {
        match cluster_slot_ranges_from_routes(
            seed_routes,
            config.ssl,
            config.redis_tls_insecure(),
            &auth.username,
            &auth.password,
        )
        .await
        {
            Ok(slot_ranges) if !slot_ranges.is_empty() => {
                return Ok((RedisClusterAuth { username: auth.username, password: auth.password }, slot_ranges));
            }
            Ok(_) => {
                last_error = Some("Redis cluster master discovery returned no slots".to_string());
            }
            Err(err) if last_error.is_none() || is_redis_auth_error(&err) => {
                let should_retry = is_redis_auth_error(&err);
                last_error = Some(err);
                if !should_retry {
                    break;
                }
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "Redis cluster master discovery failed".to_string()))
}

pub async fn connect_routed_cluster(
    config: &ConnectionConfig,
    seed_routes: Vec<RedisNodeRoute>,
    slot_ranges: Vec<RedisClusterSlotRange>,
    node_routes: Vec<RedisNodeRoute>,
    auth: RedisClusterAuth,
) -> Result<RedisClusterPool, String> {
    let seed_nodes = redis_cluster_seed_nodes(config)?;
    let mut pool = RedisClusterPool {
        connection: None,
        seed_nodes,
        seed_routes,
        slot_ranges,
        node_routes,
        tls: config.ssl,
        tls_insecure: config.redis_tls_insecure(),
        username: auth.username,
        password: auth.password,
    };
    if pool.node_routes.is_empty() {
        pool.node_routes = identity_routes(&unique_master_nodes(&pool.slot_ranges));
    }
    {
        let mut con = cluster_any_connection(&pool).await?;
        redis_ping(&mut con, "Redis cluster").await?;
    }
    Ok(pool)
}

pub async fn test_connection(connection: &RedisConnection) -> Result<(), String> {
    match connection {
        RedisConnection::Direct(con) => {
            let mut con = con.lock().await;
            redis_ping(&mut *con, "Redis").await
        }
        RedisConnection::Cluster(cluster) => {
            let mut con = cluster_any_connection(cluster).await?;
            redis_ping(&mut con, "Redis cluster").await
        }
    }
}

async fn redis_ping<C>(con: &mut C, label: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    tokio::time::timeout(super::connection_timeout(), redis::cmd("PING").query_async::<String>(con))
        .await
        .map_err(|_| format!("{label} ping timed out ({}s)", super::CONNECTION_TIMEOUT_SECS))?
        .map(|_| ())
        .map_err(|e| format!("{label} ping failed: {e}"))
}

fn redis_sentinel_nodes(config: &ConnectionConfig) -> Result<Vec<ConnectionInfo>, String> {
    redis_sentinel_node_endpoints(config)?
        .iter()
        .map(|endpoint| {
            Ok(connection_info(
                &endpoint.host,
                endpoint.port,
                config.redis_sentinel_tls,
                config.redis_tls_insecure(),
                &config.redis_sentinel_username,
                &config.redis_sentinel_password,
                0,
            ))
        })
        .collect()
}

pub fn redis_sentinel_node_endpoints(config: &ConnectionConfig) -> Result<Vec<RedisNodeEndpoint>, String> {
    redis_node_endpoints(
        config.redis_sentinel_nodes.trim(),
        config.host.trim(),
        config.port,
        "Redis Sentinel node",
        26379,
    )
}

pub fn redis_cluster_seed_nodes(config: &ConnectionConfig) -> Result<Vec<RedisNodeEndpoint>, String> {
    redis_node_endpoints(
        config.redis_cluster_nodes.trim(),
        config.host.trim(),
        config.port,
        "Redis cluster seed node",
        6379,
    )
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

fn redis_sentinel_master_endpoint(value: RedisRawValue) -> Result<RedisNodeEndpoint, String> {
    let RedisRawValue::Array(parts) = value else {
        return Err("Redis Sentinel master lookup returned an invalid response".to_string());
    };
    if parts.len() != 2 {
        return Err("Redis Sentinel master lookup returned an invalid endpoint".to_string());
    }
    let Some(host) = redis_value_to_string(parts[0].clone()) else {
        return Err("Redis Sentinel master lookup returned an invalid host".to_string());
    };
    let Some(port_text) = redis_value_to_string(parts[1].clone()) else {
        return Err("Redis Sentinel master lookup returned an invalid port".to_string());
    };
    let port = parse_redis_port(&port_text)?;
    Ok(RedisNodeEndpoint { host, port })
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

fn redis_auth_candidates(username: &str, password: &str) -> Vec<RedisAuthCandidate> {
    let username = username.trim();
    let password = password.trim();
    let mut candidates = vec![RedisAuthCandidate { username: username.to_string(), password: password.to_string() }];
    if !username.is_empty() && !password.is_empty() {
        candidates.push(RedisAuthCandidate { username: String::new(), password: format!("{username}@{password}") });
    }
    candidates
}

fn redis_database_index(config: &ConnectionConfig) -> i64 {
    config.effective_database().and_then(|database| database.parse::<i64>().ok()).unwrap_or(0)
}

fn is_redis_auth_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("auth") || error.contains("wrongpass") || error.contains("invalid username-password")
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

pub async fn connect_pubsub(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    timeout: std::time::Duration,
) -> Result<redis::aio::PubSub, String> {
    let mut last_error = None;
    for auth in redis_auth_candidates(&config.username, &config.password) {
        let client = redis::Client::open(connection_info(
            host,
            port,
            config.ssl,
            config.redis_tls_insecure(),
            &auth.username,
            &auth.password,
            redis_database_index(config),
        ))
        .map_err(|e| format!("Redis connection failed: {e}"))?;
        match tokio::time::timeout(timeout, client.get_async_pubsub()).await {
            Ok(Ok(pubsub)) => return Ok(pubsub),
            Ok(Err(err)) => {
                let err_str = err.to_string();
                if last_error.is_none() || is_redis_auth_error(&err_str) {
                    let should_retry = is_redis_auth_error(&err_str);
                    last_error = Some(err_str);
                    if !should_retry {
                        break;
                    }
                } else {
                    return Err(err_str);
                }
            }
            Err(_) => {
                last_error = Some(format!("Redis PubSub connection timed out ({}s)", timeout.as_secs()));
                break;
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Redis PubSub connection failed".to_string()))
}

pub async fn publish_message<C>(con: &mut C, channel: &str, message: &str) -> Result<u64, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("PUBLISH").arg(channel).arg(message).query_async(con).await.map_err(|e| e.to_string())
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
    scan_cluster_keys_page_with_options(pool, cursor, pattern, count, true).await
}

pub async fn scan_cluster_keys_page_with_options(
    pool: &RedisClusterPool,
    cursor: u64,
    pattern: &str,
    count: usize,
    include_types: bool,
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
        let mut con = connect_cluster_node(pool, endpoint).await?;
        let current_cursor = if index == node_index { node_cursor } else { 0 };
        let result = scan_keys_page_with_options(&mut con, current_cursor, pattern, count, include_types).await?;
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
    include_key_matches: bool,
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
        let mut con = connect_cluster_node(pool, endpoint).await?;
        let current_cursor = if index == node_index { node_cursor } else { 0 };
        let result = scan_values_page(&mut con, current_cursor, pattern, query, include_key_matches, count).await?;
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
    if !pool.seed_routes.is_empty() {
        return cluster_slot_ranges_from_routes(
            &pool.seed_routes,
            pool.tls,
            pool.tls_insecure,
            &pool.username,
            &pool.password,
        )
        .await
        .map(|slot_ranges| unique_master_nodes(&slot_ranges));
    }
    cluster_slot_ranges_from_seeds(&pool.seed_nodes, pool.tls, pool.tls_insecure, &pool.username, &pool.password)
        .await
        .map(|slot_ranges| unique_master_nodes(&slot_ranges))
}

pub async fn flush_cluster(pool: &RedisClusterPool) -> Result<(), String> {
    let master_nodes = cluster_master_nodes(pool).await?;
    for endpoint in master_nodes {
        let mut con = connect_cluster_node(pool, &endpoint).await?;
        flush_db(&mut con).await?;
    }
    Ok(())
}

async fn cluster_total_keys(pool: &RedisClusterPool, master_nodes: &[RedisNodeEndpoint]) -> u64 {
    let mut total = 0;
    for endpoint in master_nodes {
        let Ok(mut con) = connect_cluster_node(pool, endpoint).await else {
            continue;
        };
        total += redis::cmd("DBSIZE").query_async::<u64>(&mut con).await.unwrap_or(0);
    }
    total
}

async fn cluster_slot_ranges_from_seeds(
    seed_nodes: &[RedisNodeEndpoint],
    tls: bool,
    insecure: bool,
    username: &str,
    password: &str,
) -> Result<Vec<RedisClusterSlotRange>, String> {
    let seed_routes = identity_routes(seed_nodes);
    cluster_slot_ranges_from_routes(&seed_routes, tls, insecure, username, password).await
}

async fn cluster_slot_ranges_from_routes(
    seed_routes: &[RedisNodeRoute],
    tls: bool,
    insecure: bool,
    username: &str,
    password: &str,
) -> Result<Vec<RedisClusterSlotRange>, String> {
    let mut last_error = None;
    for route in seed_routes {
        let mut con = match connect_direct_node(&route.connect, tls, insecure, username, password).await {
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
        let slot_ranges = parse_cluster_slots(raw, &route.advertised.host)?;
        if !slot_ranges.is_empty() {
            return Ok(slot_ranges);
        }
    }

    Err(last_error.unwrap_or_else(|| "Redis cluster master discovery failed".to_string()))
}

fn parse_cluster_slots(raw: RedisRawValue, fallback_host: &str) -> Result<Vec<RedisClusterSlotRange>, String> {
    let RedisRawValue::Array(slots) = raw else {
        return Err("Invalid Redis CLUSTER SLOTS response".to_string());
    };

    let mut slot_ranges = Vec::new();
    for slot in slots {
        let RedisRawValue::Array(parts) = slot else {
            continue;
        };
        if parts.len() < 3 {
            continue;
        }
        let Some(start_text) = redis_value_to_string(parts[0].clone()) else {
            return Err("Invalid Redis cluster slot start".to_string());
        };
        let Some(end_text) = redis_value_to_string(parts[1].clone()) else {
            return Err("Invalid Redis cluster slot end".to_string());
        };
        let start = parse_cluster_slot_number(&start_text)?;
        let end = parse_cluster_slot_number(&end_text)?;
        let Some(endpoint) = parse_cluster_slot_master(parts[2].clone(), fallback_host)? else {
            continue;
        };
        slot_ranges.push(RedisClusterSlotRange { start, end, master: endpoint });
    }
    Ok(slot_ranges)
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

fn parse_cluster_slot_number(value: &str) -> Result<u16, String> {
    let slot = value.parse::<u16>().map_err(|_| format!("Invalid Redis cluster slot '{value}'"))?;
    if slot > 16_383 {
        return Err(format!("Invalid Redis cluster slot '{value}'"));
    }
    Ok(slot)
}

fn identity_routes(endpoints: &[RedisNodeEndpoint]) -> Vec<RedisNodeRoute> {
    endpoints
        .iter()
        .cloned()
        .map(|endpoint| RedisNodeRoute { advertised: endpoint.clone(), connect: endpoint })
        .collect()
}

pub fn unique_master_nodes(slot_ranges: &[RedisClusterSlotRange]) -> Vec<RedisNodeEndpoint> {
    let mut seen = std::collections::HashSet::new();
    let mut nodes = Vec::new();
    for slot_range in slot_ranges {
        if seen.insert((slot_range.master.host.clone(), slot_range.master.port)) {
            nodes.push(slot_range.master.clone());
        }
    }
    nodes
}

pub async fn cluster_any_connection(pool: &RedisClusterPool) -> Result<RedisClusterConnectionGuard<'_>, String> {
    if let Some(connection) = &pool.connection {
        return Ok(RedisClusterConnectionGuard::Native(connection.lock().await));
    }
    let endpoint = pool
        .node_routes
        .first()
        .or_else(|| pool.seed_routes.first())
        .map(|route| &route.advertised)
        .ok_or_else(|| "Redis cluster has no routable nodes".to_string())?;
    connect_cluster_node(pool, endpoint).await.map(RedisClusterConnectionGuard::Direct)
}

pub async fn cluster_key_connection<'a>(
    pool: &'a RedisClusterPool,
    key: &[u8],
) -> Result<RedisClusterConnectionGuard<'a>, String> {
    if let Some(connection) = &pool.connection {
        return Ok(RedisClusterConnectionGuard::Native(connection.lock().await));
    }
    let endpoint = cluster_master_for_key(pool, key)?;
    connect_cluster_node(pool, &endpoint).await.map(RedisClusterConnectionGuard::Direct)
}

pub async fn connect_cluster_node(
    pool: &RedisClusterPool,
    advertised_endpoint: &RedisNodeEndpoint,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let connect_endpoint = mapped_cluster_endpoint(pool, advertised_endpoint);
    connect_direct_node(&connect_endpoint, pool.tls, pool.tls_insecure, &pool.username, &pool.password).await
}

fn mapped_cluster_endpoint(pool: &RedisClusterPool, advertised_endpoint: &RedisNodeEndpoint) -> RedisNodeEndpoint {
    pool.node_routes
        .iter()
        .chain(pool.seed_routes.iter())
        .find(|route| route.advertised == *advertised_endpoint)
        .map(|route| route.connect.clone())
        .unwrap_or_else(|| advertised_endpoint.clone())
}

fn cluster_master_for_key(pool: &RedisClusterPool, key: &[u8]) -> Result<RedisNodeEndpoint, String> {
    let slot = redis_cluster_slot(key);
    pool.slot_ranges
        .iter()
        .find(|range| range.start <= slot && slot <= range.end)
        .map(|range| range.master.clone())
        .ok_or_else(|| format!("Redis cluster slot {slot} has no known master"))
}

fn redis_cluster_slot(key: &[u8]) -> u16 {
    let hashtag = key.iter().position(|byte| *byte == b'{').and_then(|start| {
        key[start + 1..].iter().position(|byte| *byte == b'}').and_then(|relative_end| {
            if relative_end == 0 {
                None
            } else {
                Some(&key[start + 1..start + 1 + relative_end])
            }
        })
    });
    crc16_xmodem(hashtag.unwrap_or(key)) % 16_384
}

fn crc16_xmodem(bytes: &[u8]) -> u16 {
    let mut crc = 0_u16;
    for byte in bytes {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
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
    // Read access is an explicit allowlist. Commands added by a newer Redis
    // version, module, or proxy remain high-risk until DBX reviews them.
    match command.to_ascii_uppercase().as_str() {
        "BITCOUNT"
        | "BITFIELD_RO"
        | "BITPOS"
        | "COMMAND"
        | "DBSIZE"
        | "DUMP"
        | "ECHO"
        | "EXISTS"
        | "EXPIRETIME"
        | "GEODIST"
        | "GEOHASH"
        | "GEOPOS"
        | "GEORADIUS_RO"
        | "GEORADIUSBYMEMBER_RO"
        | "GEOSEARCH"
        | "GET"
        | "GETBIT"
        | "GETRANGE"
        | "HEXISTS"
        | "HGET"
        | "HGETALL"
        | "HKEYS"
        | "HLEN"
        | "HMGET"
        | "HRANDFIELD"
        | "HSCAN"
        | "HSTRLEN"
        | "HVALS"
        | "INFO"
        | "LASTSAVE"
        | "LCS"
        | "LINDEX"
        | "LLEN"
        | "LPOS"
        | "LRANGE"
        | "MGET"
        | "OBJECT"
        | "PEXPIRETIME"
        | "PFCOUNT"
        | "PING"
        | "PTTL"
        | "PUBSUB"
        | "RANDOMKEY"
        | "ROLE"
        | "SCAN"
        | "SCARD"
        | "SDIFF"
        | "SINTER"
        | "SINTERCARD"
        | "SISMEMBER"
        | "SMEMBERS"
        | "SMISMEMBER"
        | "SORT_RO"
        | "SRANDMEMBER"
        | "SSCAN"
        | "STRLEN"
        | "SUNION"
        | "TIME"
        | "TTL"
        | "TYPE"
        | "WAIT"
        | "WAITAOF"
        | "XINFO"
        | "XLEN"
        | "XPENDING"
        | "XRANGE"
        | "XREAD"
        | "XREVRANGE"
        | "ZCARD"
        | "ZCOUNT"
        | "ZDIFF"
        | "ZINTER"
        | "ZINTERCARD"
        | "ZLEXCOUNT"
        | "ZMSCORE"
        | "ZRANDMEMBER"
        | "ZRANGE"
        | "ZRANGEBYLEX"
        | "ZRANGEBYSCORE"
        | "ZRANK"
        | "ZREVRANGE"
        | "ZREVRANGEBYLEX"
        | "ZREVRANGEBYSCORE"
        | "ZREVRANK"
        | "ZSCAN"
        | "ZSCORE"
        | "ZUNION"
        | "BF.CARD"
        | "BF.EXISTS"
        | "BF.INFO"
        | "BF.MEXISTS"
        | "CF.COUNT"
        | "CF.EXISTS"
        | "CF.INFO"
        | "CF.MEXISTS"
        | "CMS.INFO"
        | "CMS.QUERY"
        | "FT._LIST"
        | "FT.AGGREGATE"
        | "FT.DICTDUMP"
        | "FT.EXPLAIN"
        | "FT.EXPLAINCLI"
        | "FT.INFO"
        | "FT.PROFILE"
        | "FT.SEARCH"
        | "FT.SPELLCHECK"
        | "FT.SYNDUMP"
        | "FT.TAGVALS"
        | "GRAPH.RO_QUERY"
        | "JSON.ARRINDEX"
        | "JSON.ARRLEN"
        | "JSON.GET"
        | "JSON.MGET"
        | "JSON.OBJKEYS"
        | "JSON.OBJLEN"
        | "JSON.RESP"
        | "JSON.STRLEN"
        | "JSON.TYPE"
        | "TDIGEST.BYRANK"
        | "TDIGEST.BYREVRANK"
        | "TDIGEST.CDF"
        | "TDIGEST.INFO"
        | "TDIGEST.MAX"
        | "TDIGEST.MIN"
        | "TDIGEST.QUANTILE"
        | "TDIGEST.RANK"
        | "TDIGEST.REVRANK"
        | "TDIGEST.TRIMMED_MEAN"
        | "TOPK.INFO"
        | "TOPK.LIST"
        | "TOPK.QUERY"
        | "TS.GET"
        | "TS.INFO"
        | "TS.MGET"
        | "TS.MRANGE"
        | "TS.QUERYINDEX"
        | "TS.RANGE" => RedisCommandSafety::Allowed,
        "DEL" | "UNLINK" | "EXPIRE" | "EXPIREAT" | "PEXPIRE" | "PEXPIREAT" | "RENAME" | "RENAMENX" | "GETDEL"
        | "HDEL" | "JSON.ARRPOP" | "JSON.ARRTRIM" | "JSON.CLEAR" | "JSON.DEL" | "JSON.FORGET" | "BLMOVE" | "BLMPOP"
        | "BLPOP" | "BRPOP" | "BRPOPLPUSH" | "LPOP" | "LMOVE" | "LMPOP" | "RPOP" | "RPOPLPUSH" | "LREM" | "LTRIM"
        | "SPOP" | "SREM" | "ZREM" | "ZPOPMAX" | "ZPOPMIN" | "ZMPOP" | "BZMPOP" | "BZPOPMAX" | "BZPOPMIN"
        | "ZREMRANGEBYLEX" | "ZREMRANGEBYRANK" | "ZREMRANGEBYSCORE" | "XDEL" | "XTRIM" | "MOVE" | "SORT"
        | "SDIFFSTORE" | "SINTERSTORE" | "SUNIONSTORE" | "ZDIFFSTORE" | "ZINTERSTORE" | "ZRANGESTORE"
        | "ZUNIONSTORE" | "PFMERGE" | "GEOSEARCHSTORE" => RedisCommandSafety::Confirm,
        "APPEND" | "BITFIELD" | "BITOP" | "COPY" | "DECR" | "DECRBY" | "GEOADD" | "GEORADIUS" | "GEORADIUSBYMEMBER"
        | "GETEX" | "GETSET" | "INCR" | "INCRBY" | "INCRBYFLOAT" | "SET" | "SETEX" | "PSETEX" | "SETNX"
        | "SETRANGE" | "MSET" | "MSETNX" | "PERSIST" | "HSET" | "HMSET" | "HINCRBY" | "HINCRBYFLOAT" | "HSETNX"
        | "JSON.ARRAPPEND" | "JSON.ARRINSERT" | "JSON.MERGE" | "JSON.MSET" | "JSON.NUMINCRBY" | "JSON.NUMMULTBY"
        | "JSON.SET" | "JSON.STRAPPEND" | "JSON.TOGGLE" | "LINSERT" | "LSET" | "LPUSH" | "LPUSHX" | "PFADD"
        | "RPUSH" | "RPUSHX" | "RESTORE" | "SADD" | "ZADD" | "ZINCRBY" | "SETBIT" | "SPUBLISH" | "PUBLISH"
        | "TOUCH" | "XADD" | "XACK" | "XAUTOCLAIM" | "XCLAIM" | "XREADGROUP" | "XSETID" => RedisCommandSafety::Write,
        _ => RedisCommandSafety::Blocked,
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
        RedisRawValue::BulkString(bytes) => {
            let text = redis_bytes_to_display(&bytes);
            let trimmed = text.trim();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    return json_value_for_js(json);
                }
            }
            serde_json::Value::String(text)
        }
        RedisRawValue::SimpleString(value) => serde_json::Value::String(value),
        RedisRawValue::Okay => serde_json::Value::String("OK".to_string()),
        RedisRawValue::Int(value) => super::safe_i64_to_json(value),
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

pub fn redis_json_raw_to_text(value: RedisRawValue) -> Result<String, String> {
    match value {
        RedisRawValue::BulkString(bytes) => {
            String::from_utf8(bytes).map_err(|e| format!("RedisJSON value is not valid UTF-8: {e}"))
        }
        RedisRawValue::SimpleString(text) => Ok(text),
        RedisRawValue::VerbatimString { text, .. } => Ok(text),
        // Do not turn a key deleted between TYPE and JSON.GET into an editable
        // JSON null; saving that draft would recreate a phantom key.
        RedisRawValue::Nil => Err("RedisJSON key no longer exists".to_string()),
        other => Err(format!("Unexpected RedisJSON response: {other:?}")),
    }
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

/// Retrieve slowlog entries via `SLOWLOG GET <count>`.
/// The response is a nested array where each entry has the structure:
///   [id, timestamp_unix_secs, duration_micros, [arg1, arg2, ...], client_addr, client_name, ...]
pub async fn get_slowlog<C>(con: &mut C, count: usize) -> Result<Vec<RedisSlowlogEntry>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let raw: RedisRawValue = redis::cmd("SLOWLOG")
        .arg("GET")
        .arg(count as u64)
        .query_async(con)
        .await
        .map_err(|e| format!("SLOWLOG GET failed: {e}"))?;

    let RedisRawValue::Array(entries) = raw else {
        return Err("SLOWLOG GET returned non-array response".to_string());
    };

    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let RedisRawValue::Array(fields) = entry else {
            continue;
        };
        if fields.len() < 4 {
            continue;
        }

        let id = redis_value_to_u64(&fields[0]).unwrap_or(0);
        let timestamp = fields[1].clone();
        let duration = fields[2].clone();
        let args_raw = fields[3].clone();
        let client_addr = if fields.len() > 4 { redis_raw_value_to_optional_string(&fields[4]) } else { None };
        let client_name = if fields.len() > 5 { redis_raw_value_to_optional_string(&fields[5]) } else { None };

        let command = match args_raw {
            RedisRawValue::Array(args) => {
                let mut parts = Vec::with_capacity(args.len());
                for arg in args {
                    if let Some(s) = redis_raw_value_to_command_arg(&arg) {
                        parts.push(s);
                    }
                }
                parts.join(" ")
            }
            _ => String::new(),
        };

        let timestamp_secs = match timestamp {
            RedisRawValue::Int(i) => i,
            RedisRawValue::BulkString(ref bytes) => {
                std::str::from_utf8(bytes).ok().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0)
            }
            _ => 0,
        };

        let duration_micros = match duration {
            RedisRawValue::Int(i) => i as u64,
            RedisRawValue::BulkString(ref bytes) => {
                std::str::from_utf8(bytes).ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0)
            }
            _ => 0,
        };

        result.push(RedisSlowlogEntry {
            id,
            timestamp: timestamp_secs,
            duration_micros,
            command,
            client_addr,
            client_name,
        });
    }

    Ok(result)
}

/// Try to convert a RedisRawValue to an optional string (None for Nil).
fn redis_raw_value_to_optional_string(v: &RedisRawValue) -> Option<String> {
    match v {
        RedisRawValue::BulkString(bytes) => {
            if bytes.is_empty() {
                None
            } else {
                std::str::from_utf8(bytes).ok().map(|s| s.to_string())
            }
        }
        RedisRawValue::SimpleString(s) => Some(s.clone()),
        RedisRawValue::Nil => None,
        _ => None,
    }
}

/// Convert a RedisRawValue to an command argument string.
/// Unlike `redis_raw_value_to_optional_string`, this preserves empty strings
/// and uses `redis_bytes_to_display` to handle non-UTF-8 binary data.
fn redis_raw_value_to_command_arg(v: &RedisRawValue) -> Option<String> {
    match v {
        RedisRawValue::BulkString(bytes) => Some(redis_bytes_to_display(bytes)),
        RedisRawValue::SimpleString(s) => Some(s.clone()),
        RedisRawValue::Nil => None,
        _ => None,
    }
}

/// Try to convert a RedisRawValue to a u64.
fn redis_value_to_u64(v: &RedisRawValue) -> Option<u64> {
    match v {
        RedisRawValue::Int(i) => Some(*i as u64),
        RedisRawValue::BulkString(bytes) => std::str::from_utf8(bytes).ok().and_then(|s| s.parse().ok()),
        _ => None,
    }
}

/// Extract a string reference from a `RedisRawValue` if it is a BulkString or SimpleString.
fn redis_raw_value_as_str(v: &RedisRawValue) -> Option<&str> {
    match v {
        RedisRawValue::BulkString(bytes) => std::str::from_utf8(bytes).ok(),
        RedisRawValue::SimpleString(s) => Some(s.as_str()),
        _ => None,
    }
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

    // Special handling for INFO command in cluster mode.
    // redis-rs ClusterConnection routes INFO to all primaries and
    // aggregates the results as a Map(node_addr → full_info_text).

    // We detect this pattern and return it as an array of
    // [node_addr, info_text] pairs, which the frontend renders
    // as a two-column (index → node_addr, value → info_text) table.
    if command == "INFO" {
        if let RedisRawValue::Map(entries) = &raw {
            // Cluster-aggregated INFO has multi-line values starting with "# "
            // (e.g. "# Server", "# Memory", "# Clients").
            // This distinguishes it from a RESP3 standalone INFO map where values
            // are single field values (e.g. "redis_version", "os") or nested maps.
            let is_cluster_aggregation =
                entries.iter().any(|(_, v)| redis_raw_value_as_str(v).is_some_and(|s| s.starts_with("# ")));

            if is_cluster_aggregation {
                let pairs: Vec<serde_json::Value> = entries
                    .iter()
                    .filter_map(|(key, value)| {
                        let addr = redis_raw_value_as_str(key)?;
                        let info = redis_raw_value_as_str(value)?;
                        Some(serde_json::json!([addr, info]))
                    })
                    .collect();
                return Ok(RedisCommandResult { command, safety, value: serde_json::Value::Array(pairs) });
            }
        }
    }

    Ok(RedisCommandResult { command, safety, value: redis_command_raw_to_json(raw) })
}

pub async fn scan_keys_page<C>(con: &mut C, cursor: u64, pattern: &str, count: usize) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    scan_keys_batch(con, cursor, pattern, count, 1, true).await
}

pub async fn scan_keys_page_with_options<C>(
    con: &mut C,
    cursor: u64,
    pattern: &str,
    count: usize,
    include_types: bool,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    scan_keys_batch(con, cursor, pattern, count, 1, include_types).await
}

/// Batch-scan keys with server-side multi-SCAN support.
///
/// Performs up to `max_iterations` SCAN cycles in a single call. TYPE metadata
/// is optional so large key-name searches can avoid extra Redis work.
/// DBSIZE is only called on the first iteration (cursor == 0).
pub async fn scan_keys_batch<C>(
    con: &mut C,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let iterations = max_iterations.max(1);
    let total_keys: u64 = if cursor == 0 { redis::cmd("DBSIZE").query_async(con).await.unwrap_or(0) } else { 0 };

    let is_exact_match = !pattern.contains('*') && !pattern.contains('?') && !pattern.contains('[');
    if cursor == 0 && is_exact_match && !pattern.is_empty() {
        match redis::cmd("EXISTS").arg(pattern).query_async::<bool>(con).await {
            Ok(true) => {
                let key_type: String = if include_types {
                    redis::cmd("TYPE").arg(pattern).query_async(con).await.unwrap_or_else(|_| "unknown".to_string())
                } else {
                    String::new()
                };

                let value_preview = if include_types { redis_key_value_preview(&key_type) } else { String::new() };

                let key_info = RedisKeyInfo {
                    key_display: redis_key_bytes_to_display(pattern.as_bytes()),
                    key_raw: redis_key_bytes_to_raw(pattern.as_bytes()),
                    key_type,
                    ttl: -2,
                    size: 0,
                    value_preview,
                };
                return Ok(RedisScanResult { cursor: 0, keys: vec![key_info], total_keys });
            }
            Ok(false) => {
                return Ok(RedisScanResult { cursor: 0, keys: vec![], total_keys });
            }
            Err(_) => {}
        }
    }

    let mut all_keys: Vec<RedisKeyInfo> = Vec::new();

    let mut current_cursor = cursor;

    for iteration in 0..iterations {
        let raw: RedisRawValue = redis::cmd("SCAN")
            .arg(current_cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(count)
            .query_async(con)
            .await
            .map_err(|e| e.to_string())?;

        let (next_cursor, keys) = parse_scan_keys(raw)?;

        if !keys.is_empty() {
            let key_types: Vec<String> = if include_types {
                let mut pipe = redis::pipe();
                for key in &keys {
                    pipe.cmd("TYPE").arg(key);
                }
                pipe.query_async(con).await.unwrap_or_default()
            } else {
                Vec::new()
            };

            for (index, key) in keys.iter().enumerate() {
                let key_type = if include_types {
                    key_types.get(index).cloned().unwrap_or_else(|| "unknown".to_string())
                } else {
                    String::new()
                };
                let value_preview = if include_types {
                    redis_key_value_preview(key_types.get(index).map(String::as_str).unwrap_or("unknown"))
                } else {
                    String::new()
                };
                all_keys.push(RedisKeyInfo {
                    key_display: redis_key_bytes_to_display(key),
                    key_raw: redis_key_bytes_to_raw(key),
                    key_type,
                    ttl: -2,
                    size: 0,
                    value_preview,
                });
            }
        }

        if next_cursor == 0 {
            return Ok(RedisScanResult { cursor: 0, keys: all_keys, total_keys });
        }
        current_cursor = next_cursor;

        // MATCH may yield sparse or empty batches. Keep scanning within the
        // caller's bounded budget, but stop once this result page is full.
        if !should_continue_key_scan(all_keys.len(), count, iteration + 1, iterations) {
            break;
        }
    }

    Ok(RedisScanResult { cursor: current_cursor, keys: all_keys, total_keys })
}

fn should_continue_key_scan(
    matched_keys: usize,
    target_keys: usize,
    completed_iterations: usize,
    max_iterations: usize,
) -> bool {
    matched_keys < target_keys.max(1) && completed_iterations < max_iterations.max(1)
}

pub async fn scan_values_page<C>(
    con: &mut C,
    cursor: u64,
    pattern: &str,
    query: &str,
    include_key_matches: bool,
    count: usize,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    // Only call DBSIZE on the first page (cursor == 0) to avoid redundant work.
    let total_keys: u64 = if cursor == 0 { redis::cmd("DBSIZE").query_async(con).await.unwrap_or(0) } else { 0 };
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
    let keys: Vec<_> = keys
        .into_iter()
        .map(|key| {
            let key_display = redis_key_bytes_to_display(&key);
            let key_raw = redis_key_bytes_to_raw(&key);
            let key_matches = include_key_matches && redis_key_matches_query(&key_display, &key_raw, query);
            (key, key_display, key_raw, key_matches)
        })
        .collect();

    let mut key_match_types = Vec::new();
    if include_key_matches {
        let mut pipe = redis::pipe();
        let mut key_match_count = 0usize;
        for (key, _, _, key_matches) in &keys {
            if *key_matches {
                pipe.cmd("TYPE").arg(key);
                key_match_count += 1;
            }
        }
        if key_match_count > 0 {
            key_match_types = pipe.query_async(con).await.unwrap_or_default();
        }
    }

    let mut key_match_type_index = 0usize;
    for (key, key_display, key_raw, key_matches) in keys {
        if key_matches {
            let key_type = key_match_types.get(key_match_type_index).cloned().unwrap_or_else(|| "unknown".to_string());
            key_match_type_index += 1;
            result.push(RedisKeyInfo {
                key_display,
                key_raw,
                value_preview: redis_key_value_preview(&key_type),
                key_type,
                ttl: -2,
                size: 0,
            });
            continue;
        }

        let Ok(value) = get_value(con, &key).await else {
            continue;
        };
        if !redis_value_matches_query(&value, query) {
            continue;
        }

        let value_preview = redis_search_value_preview(&value.data);
        let size = redis_search_value_size(&value);
        result.push(RedisKeyInfo {
            key_display: value.key_display,
            key_raw: value.key_raw,
            key_type: value.redis_type,
            ttl: value.ttl,
            size,
            value_preview,
        });
    }

    Ok(RedisScanResult { cursor: next_cursor, keys: result, total_keys })
}

pub async fn get_value<C>(con: &mut C, key: &[u8]) -> Result<RedisValue, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let redis_type: String = redis::cmd("TYPE").arg(key).query_async(con).await.map_err(|e| e.to_string())?;

    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(con).await.unwrap_or(-1);

    let data = match redis_type.as_str() {
        "string" => {
            let v: RedisRawValue = redis::cmd("GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            RedisValueData::String {
                content: redis_value_to_bytes(v)
                    .map(|bytes| redis_blob_from_bytes(&bytes))
                    .ok_or_else(|| "Redis string payload is not byte-addressable".to_string())?,
            }
        }
        "list" => {
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(con).await.unwrap_or(0);
            let end = (COLLECTION_PAGE_SIZE as i64) - 1;
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(0).arg(end).query_async(con).await.map_err(|e| e.to_string())?;
            let cursor = if len > COLLECTION_PAGE_SIZE as u64 { Some(COLLECTION_PAGE_SIZE as u64) } else { None };
            RedisValueData::List { items: redis_list_items_from_raw(v, 0), total: len, scan_cursor: cursor }
        }
        "set" => {
            let len: u64 = redis::cmd("SCARD").arg(key).query_async(con).await.unwrap_or(0);
            let (cursor, items) = sscan_page_raw(con, key, 0, COLLECTION_PAGE_SIZE).await?;
            RedisValueData::Set { items, total: len, scan_cursor: (cursor > 0).then_some(cursor) }
        }
        "zset" => {
            let len: u64 = redis::cmd("ZCARD").arg(key).query_async(con).await.unwrap_or(0);
            let (cursor, items) = zscan_page_raw(con, key, 0, COLLECTION_PAGE_SIZE).await?;
            RedisValueData::Zset { items, total: len, scan_cursor: (cursor > 0).then_some(cursor) }
        }
        "hash" => {
            let len: u64 = redis::cmd("HLEN").arg(key).query_async(con).await.unwrap_or(0);
            let (cursor, items) = hscan_page_raw(con, key, 0, COLLECTION_PAGE_SIZE, None).await?;
            RedisValueData::Hash { items, total: len, scan_cursor: (cursor > 0).then_some(cursor) }
        }
        "stream" => RedisValueData::Stream { entries: get_stream_entries(con, key).await? },
        key_type if is_redis_json_type(key_type) => {
            let raw: RedisRawValue =
                redis::cmd("JSON.GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            RedisValueData::Json { value: redis_json_raw_to_text(raw)? }
        }
        _ => RedisValueData::Unknown,
    };

    Ok(RedisValue {
        key_display: redis_key_bytes_to_display(key),
        key_raw: redis_key_bytes_to_raw(key),
        redis_type,
        ttl,
        data,
    })
}

fn redis_value_matches_query(value: &RedisValue, query: &str) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return false;
    }
    redis_search_value_text(&value.data).to_lowercase().contains(&query.to_lowercase())
}

fn redis_key_matches_query(key_display: &str, key_raw: &str, query: &str) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return false;
    }
    let query = query.to_lowercase();
    key_display.to_lowercase().contains(&query) || key_raw.to_lowercase().contains(&query)
}

fn redis_search_value_text(value: &RedisValueData) -> String {
    match value {
        RedisValueData::String { content } => redis_blob_display_text(content),
        RedisValueData::Json { value } => value.clone(),
        RedisValueData::List { items, .. } => {
            items.iter().map(|item| redis_blob_display_text(&item.value)).collect::<Vec<_>>().join(" ")
        }
        RedisValueData::Set { items, .. } => {
            items.iter().map(|item| redis_blob_display_text(&item.member)).collect::<Vec<_>>().join(" ")
        }
        RedisValueData::Hash { items, .. } => items
            .iter()
            .flat_map(|item| [redis_blob_display_text(&item.field), redis_blob_display_text(&item.value)])
            .collect::<Vec<_>>()
            .join(" "),
        RedisValueData::Zset { items, .. } => items
            .iter()
            .flat_map(|item| [item.score.clone(), redis_blob_display_text(&item.member)])
            .collect::<Vec<_>>()
            .join(" "),
        RedisValueData::Stream { entries } => entries
            .iter()
            .flat_map(|entry| {
                entry.fields.iter().flat_map(|field| [field.field.clone(), field.value.clone()]).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
            .join(" "),
        RedisValueData::Unknown => String::new(),
    }
}

fn redis_search_value_preview(value: &RedisValueData) -> String {
    const MAX_PREVIEW_LEN: usize = 160;
    let text = redis_search_value_text(value);
    if text.chars().count() <= MAX_PREVIEW_LEN {
        return text;
    }
    let mut preview = text.chars().take(MAX_PREVIEW_LEN).collect::<String>();
    preview.push('…');
    preview
}

fn redis_search_value_size(value: &RedisValue) -> u64 {
    match &value.data {
        RedisValueData::String { content } => base64::engine::general_purpose::STANDARD
            .decode(&content.raw_base64)
            .map(|bytes| bytes.len() as u64)
            .unwrap_or(0),
        RedisValueData::Json { value } => value.len() as u64,
        RedisValueData::List { total, .. }
        | RedisValueData::Set { total, .. }
        | RedisValueData::Hash { total, .. }
        | RedisValueData::Zset { total, .. } => *total,
        RedisValueData::Stream { entries } => entries.len() as u64,
        RedisValueData::Unknown => 0,
    }
}

async fn get_stream_entries<C>(con: &mut C, key: &[u8]) -> Result<Vec<RedisStreamEntry>, String>
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

fn parse_stream_entries(raw: RedisRawValue) -> Vec<RedisStreamEntry> {
    match raw {
        RedisRawValue::Array(entries) => entries.into_iter().filter_map(parse_stream_entry).collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_entry(entry: RedisRawValue) -> Option<RedisStreamEntry> {
    let mut parts = match entry {
        RedisRawValue::Array(parts) if parts.len() == 2 => parts.into_iter(),
        _ => return None,
    };

    let id = redis_value_to_string(parts.next()?)?;
    let fields = match parts.next()? {
        RedisRawValue::Array(fields) => fields,
        _ => return None,
    };

    let mut parsed_fields = Vec::new();
    let mut fields = fields.into_iter();
    while let Some(field) = fields.next() {
        let Some(value) = fields.next() else {
            break;
        };
        if let Some(field_name) = redis_value_to_string(field) {
            let value = redis_value_to_string(value).unwrap_or_default();
            parsed_fields.push(RedisStreamField { field: field_name, value });
        }
    }

    Some(RedisStreamEntry { id, fields: parsed_fields })
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

fn redis_blob_from_bytes(bytes: &[u8]) -> RedisBlob {
    RedisBlob {
        raw_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        encoding: if std::str::from_utf8(bytes).is_ok() { RedisBlobEncoding::Utf8 } else { RedisBlobEncoding::Binary },
    }
}

fn redis_blob_display_text(blob: &RedisBlob) -> String {
    let bytes = base64::engine::general_purpose::STANDARD.decode(&blob.raw_base64).unwrap_or_default();
    if matches!(blob.encoding, RedisBlobEncoding::Utf8) {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            return text.to_string();
        }
    }
    redis_bytes_to_display(&bytes)
}

fn redis_list_items_from_raw(value: RedisRawValue, start_index: u64) -> Vec<RedisListItem> {
    match value {
        RedisRawValue::Array(values) => values
            .into_iter()
            .enumerate()
            .filter_map(|(offset, value)| {
                redis_value_to_bytes(value).map(|bytes| RedisListItem {
                    index: start_index + offset as u64,
                    value: redis_blob_from_bytes(&bytes),
                })
            })
            .collect(),
        _ => Vec::new(),
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
    match ttl {
        Some(t) => {
            redis::cmd("SET").arg(key).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
            if t > 0 {
                redis::cmd("EXPIRE").arg(key).arg(t).query_async::<()>(con).await.map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        None => set_string_preserving_ttl(con, key, value).await,
    }
}

async fn set_string_preserving_ttl<C>(con: &mut C, key: &[u8], value: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    match redis::cmd("SET").arg(key).arg(value).arg("KEEPTTL").query_async::<()>(con).await {
        Ok(()) => Ok(()),
        Err(error) if is_unsupported_keepttl_error(&error) => {
            let remaining_ms = redis::cmd("PTTL").arg(key).query_async::<i64>(con).await.map_err(|e| e.to_string())?;
            let mut command = redis::cmd("SET");
            command.arg(key).arg(value);
            if remaining_ms >= 0 {
                // Redis requires PX to be positive. A zero PTTL means the key is
                // about to expire, so one millisecond is the closest equivalent.
                command.arg("PX").arg(remaining_ms.max(1));
            }
            command.query_async::<()>(con).await.map_err(|e| e.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn is_unsupported_keepttl_error(error: &redis::RedisError) -> bool {
    if error.kind() != redis::ErrorKind::ResponseError {
        return false;
    }

    let detail = error.detail().unwrap_or_default().to_ascii_lowercase();
    detail.contains("syntax error")
        || ((detail.contains("unknown") || detail.contains("unsupported")) && detail.contains("keepttl"))
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
    filter_query: Option<&str>,
) -> Result<RedisCollectionPage, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    match key_type {
        "list" => {
            let start = cursor as i64;
            let end = start + count as i64 - 1;
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(start).arg(end).query_async(con).await.map_err(|e| e.to_string())?;
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(con).await.unwrap_or(0);
            let next = cursor + count as u64;
            Ok(RedisCollectionPage::List {
                items: redis_list_items_from_raw(v, cursor),
                scan_cursor: (next < len).then_some(next),
            })
        }
        "set" => {
            let (next_cursor, items) = sscan_page_raw(con, key, cursor, count).await?;
            Ok(RedisCollectionPage::Set { items, scan_cursor: (next_cursor > 0).then_some(next_cursor) })
        }
        "zset" => {
            let (next_cursor, items) = zscan_page_raw(con, key, cursor, count).await?;
            Ok(RedisCollectionPage::Zset { items, scan_cursor: (next_cursor > 0).then_some(next_cursor) })
        }
        "hash" => {
            let (next_cursor, items) = if let Some(query) = filter_query.filter(|query| !query.is_empty()) {
                hscan_filtered_page_raw(con, key, cursor, count, query).await?
            } else {
                hscan_page_raw(con, key, cursor, count, None).await?
            };
            Ok(RedisCollectionPage::Hash { items, scan_cursor: (next_cursor > 0).then_some(next_cursor) })
        }
        _ => Err(format!("Pagination not supported for type: {key_type}")),
    }
}

async fn hscan_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
    match_pattern: Option<&str>,
) -> Result<(u64, Vec<RedisHashItem>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cmd = redis::cmd("HSCAN");
    cmd.arg(key).arg(cursor).arg("COUNT").arg(count);
    if let Some(pattern) = match_pattern {
        cmd.arg("MATCH").arg(pattern);
    }
    let raw: RedisRawValue = cmd.query_async(con).await.map_err(|e| e.to_string())?;
    parse_scan_hash_entries(raw)
}

async fn hscan_filtered_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
    query: &str,
) -> Result<(u64, Vec<RedisHashItem>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cur = cursor;
    let mut items = Vec::new();
    let target = count.max(1);

    for _ in 0..HASH_FILTER_SCAN_MAX_ITERATIONS {
        let (next, page) = hscan_page_raw(con, key, cur, target, None).await?;
        items.extend(page.into_iter().filter(|item| hash_entry_matches_query(item, query)));
        cur = next;
        // HSCAN MATCH only checks field names, so value search has to filter returned pairs client-side.
        // Keep a hard scan bound so sparse value matches cannot turn one UI search into a full hash walk.
        if cur == 0 || items.len() >= target {
            break;
        }
    }

    Ok((cur, items))
}

fn hash_entry_matches_query(item: &RedisHashItem, query: &str) -> bool {
    let query = query.to_lowercase();
    if query.is_empty() {
        return true;
    }
    let field = redis_blob_display_text(&item.field);
    let value = redis_blob_display_text(&item.value);
    field.to_lowercase().contains(&query) || value.to_lowercase().contains(&query)
}

async fn sscan_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
) -> Result<(u64, Vec<RedisSetItem>), String>
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
) -> Result<(u64, Vec<RedisZsetItem>), String>
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
    let (next_cursor, items) = parse_scan_pairs(raw)?;
    Ok((next_cursor, items.into_iter().map(|(member, score)| RedisZsetItem { score, member }).collect()))
}

fn parse_scan_pairs(raw: RedisRawValue) -> Result<(u64, Vec<(RedisBlob, String)>), String> {
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
        let member = redis_value_to_bytes(a.clone())
            .map(|bytes| redis_blob_from_bytes(&bytes))
            .ok_or_else(|| "Invalid SCAN member payload".to_string())?;
        let value = redis_value_to_string(b.clone()).unwrap_or_default();
        items.push((member, value));
    }

    Ok((cursor, items))
}

fn parse_scan_hash_entries(raw: RedisRawValue) -> Result<(u64, Vec<RedisHashItem>), String> {
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
    while let Some(field) = iter.next() {
        let Some(value) = iter.next() else { break };
        let field = redis_value_to_bytes(field.clone())
            .map(|bytes| redis_blob_from_bytes(&bytes))
            .ok_or_else(|| "Invalid hash field payload".to_string())?;
        let value = redis_value_to_bytes(value.clone())
            .map(|bytes| redis_blob_from_bytes(&bytes))
            .ok_or_else(|| "Invalid hash value payload".to_string())?;
        items.push(RedisHashItem { field, value });
    }

    Ok((cursor, items))
}

fn parse_scan_members(raw: RedisRawValue) -> Result<(u64, Vec<RedisSetItem>), String> {
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

    let items = entries
        .iter()
        .filter_map(|value| {
            redis_value_to_bytes(value.clone()).map(|bytes| RedisSetItem { member: redis_blob_from_bytes(&bytes) })
        })
        .collect();

    Ok((cursor, items))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::{
        classify_command, connection_info, decode_cluster_cursor, encode_cluster_cursor, is_redis_json_type,
        parse_cluster_slots, parse_command_argv, parse_database_count, parse_redis_endpoint, parse_scan_keys,
        parse_stream_entries, redis_auth_candidates, redis_blob_from_bytes, redis_cluster_slot,
        redis_command_raw_to_json, redis_database_index, redis_key_bytes_to_display, redis_key_bytes_to_raw,
        redis_key_matches_query, redis_key_raw_to_bytes, redis_key_value_preview, redis_sentinel_master_endpoint,
        redis_value_matches_query, redis_value_to_bytes, RedisAuthCandidate, RedisBlob, RedisBlobEncoding,
        RedisClusterSlotRange, RedisCollectionPage, RedisCommandSafety, RedisHashItem, RedisNodeEndpoint,
        RedisRawValue, RedisSetItem, RedisStreamEntry, RedisStreamField, RedisValue, RedisValueData,
    };
    use crate::models::connection::ConnectionConfig;
    use redis::{aio::ConnectionLike, Cmd, ConnectionAddr, Pipeline, RedisFuture};

    struct FakeRedisConnection {
        responses: VecDeque<redis::RedisResult<RedisRawValue>>,
        commands: Vec<String>,
    }

    impl FakeRedisConnection {
        fn new(responses: Vec<RedisRawValue>) -> Self {
            Self { responses: responses.into_iter().map(Ok).collect(), commands: Vec::new() }
        }

        fn with_results(responses: Vec<redis::RedisResult<RedisRawValue>>) -> Self {
            Self { responses: responses.into(), commands: Vec::new() }
        }

        fn command_count(&self, command: &str) -> usize {
            let needle = format!("\r\n{command}\r\n");
            self.commands.iter().filter(|packed| packed.contains(&needle)).count()
        }
    }

    impl ConnectionLike for FakeRedisConnection {
        fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, RedisRawValue> {
            self.commands.push(String::from_utf8_lossy(&cmd.get_packed_command()).into_owned());
            let response = self.responses.pop_front().unwrap_or(Ok(RedisRawValue::Nil));
            Box::pin(async move { response })
        }

        fn req_packed_commands<'a>(
            &'a mut self,
            _cmd: &'a Pipeline,
            _offset: usize,
            _count: usize,
        ) -> RedisFuture<'a, Vec<RedisRawValue>> {
            Box::pin(async move { Ok(Vec::new()) })
        }

        fn get_db(&self) -> i64 {
            0
        }
    }

    fn bulk(value: &str) -> RedisRawValue {
        RedisRawValue::BulkString(value.as_bytes().to_vec())
    }

    fn scan_response(cursor: &str, keys: Vec<&str>) -> RedisRawValue {
        RedisRawValue::Array(vec![
            bulk(cursor),
            RedisRawValue::Array(
                keys.into_iter().map(|key| RedisRawValue::BulkString(key.as_bytes().to_vec())).collect(),
            ),
        ])
    }

    fn hscan_response(cursor: &str, pairs: Vec<(&str, &str)>) -> RedisRawValue {
        let entries = pairs.into_iter().flat_map(|(field, value)| [bulk(field), bulk(value)]).collect();
        RedisRawValue::Array(vec![bulk(cursor), RedisRawValue::Array(entries)])
    }

    fn text_blob(value: &str) -> RedisBlob {
        redis_blob_from_bytes(value.as_bytes())
    }

    fn redis_value(redis_type: &str, data: RedisValueData) -> RedisValue {
        RedisValue {
            key_display: "test:key".to_string(),
            key_raw: redis_key_bytes_to_raw(b"test:key"),
            ttl: -1,
            redis_type: redis_type.to_string(),
            data,
        }
    }

    fn string_value(value: &str) -> RedisValue {
        redis_value("string", RedisValueData::String { content: text_blob(value) })
    }

    fn hash_value(entries: &[(&str, &str)]) -> RedisValue {
        redis_value(
            "hash",
            RedisValueData::Hash {
                items: entries
                    .iter()
                    .map(|(field, value)| RedisHashItem { field: text_blob(field), value: text_blob(value) })
                    .collect(),
                total: entries.len() as u64,
                scan_cursor: None,
            },
        )
    }

    fn set_value(entries: &[&str]) -> RedisValue {
        redis_value(
            "set",
            RedisValueData::Set {
                items: entries.iter().map(|value| RedisSetItem { member: text_blob(value) }).collect(),
                total: entries.len() as u64,
                scan_cursor: None,
            },
        )
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
            vec![RedisStreamEntry {
                id: "1714470000000-0".to_string(),
                fields: vec![
                    RedisStreamField { field: "event".to_string(), value: "login".to_string() },
                    RedisStreamField { field: "user_id".to_string(), value: "42".to_string() },
                ],
            }]
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
            vec![RedisStreamEntry {
                id: "1714470000001-0".to_string(),
                fields: vec![RedisStreamField { field: "event".to_string(), value: "logout".to_string() }],
            }]
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

    #[tokio::test]
    async fn set_string_uses_keepttl_when_no_ttl_is_specified() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Okay]);

        super::set_string(&mut con, b"session", "updated", None).await.unwrap();

        assert_eq!(con.commands.len(), 1);
        assert!(con.commands[0].contains("\r\nSET\r\n"));
        assert!(con.commands[0].contains("\r\nKEEPTTL\r\n"));
    }

    #[tokio::test]
    async fn set_string_with_explicit_no_expiry_uses_plain_set() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Okay]);

        super::set_string(&mut con, b"settings", "updated", Some(-1)).await.unwrap();

        assert_eq!(con.commands.len(), 1);
        assert!(con.commands[0].contains("\r\nSET\r\n"));
        assert!(!con.commands[0].contains("\r\nKEEPTTL\r\n"));
        assert!(!con.commands[0].contains("\r\nEXPIRE\r\n"));
    }

    #[tokio::test]
    async fn set_string_falls_back_to_pttl_and_px_when_keepttl_is_unsupported() {
        let unsupported = redis::RedisError::from((
            redis::ErrorKind::ResponseError,
            "An error was signalled by the server",
            "syntax error".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![
            Err(unsupported),
            Ok(RedisRawValue::Int(4_200)),
            Ok(RedisRawValue::Okay),
        ]);

        super::set_string(&mut con, b"session", "updated", None).await.unwrap();

        assert_eq!(con.commands.len(), 3);
        assert!(con.commands[0].contains("\r\nKEEPTTL\r\n"));
        assert!(con.commands[1].contains("\r\nPTTL\r\n"));
        assert!(con.commands[2].contains("\r\nPX\r\n$4\r\n4200\r\n"));
    }

    #[tokio::test]
    async fn set_string_fallback_keeps_persistent_keys_persistent() {
        let unsupported = redis::RedisError::from((
            redis::ErrorKind::ResponseError,
            "An error was signalled by the server",
            "syntax error".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![
            Err(unsupported),
            Ok(RedisRawValue::Int(-1)),
            Ok(RedisRawValue::Okay),
        ]);

        super::set_string(&mut con, b"settings", "updated", None).await.unwrap();

        assert_eq!(con.commands.len(), 3);
        assert!(!con.commands[2].contains("\r\nPX\r\n"));
        assert!(!con.commands[2].contains("\r\nKEEPTTL\r\n"));
    }

    #[tokio::test]
    async fn set_string_does_not_fallback_for_unrelated_errors() {
        let read_only = redis::RedisError::from((
            redis::ErrorKind::ReadOnly,
            "The server is read-only",
            "You can't write against a read only replica".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(read_only)]);

        let error = super::set_string(&mut con, b"session", "updated", None).await.unwrap_err();

        assert!(error.contains("read-only"));
        assert_eq!(con.commands.len(), 1);
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

    #[tokio::test]
    async fn scan_keys_batch_respects_iteration_limit_on_empty_cursor_pages() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(3001),
            scan_response("512", vec![]),
            scan_response("0", vec!["user:room:snapshot:200063:1"]),
        ]);

        let result = super::scan_keys_batch(&mut con, 0, "user:room:snapshot:200063:*", 1000, 1, false).await.unwrap();

        assert_eq!(result.cursor, 512);
        assert!(result.keys.is_empty());
        assert_eq!(con.command_count("SCAN"), 1);
    }

    #[tokio::test]
    async fn scan_keys_batch_can_skip_empty_cursor_pages_for_sparse_match() {
        let key = "user:room:snapshot:200063:1";
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(3001),
            scan_response("512", vec![]),
            scan_response("0", vec![key]),
        ]);

        let result = super::scan_keys_batch(&mut con, 0, "user:room:snapshot:200063:*", 1000, 2, false).await.unwrap();

        assert_eq!(result.cursor, 0);
        assert_eq!(result.total_keys, 3001);
        assert_eq!(result.keys.len(), 1);
        assert_eq!(result.keys[0].key_display, key);
        assert_eq!(result.keys[0].key_raw, redis_key_bytes_to_raw(key.as_bytes()));
        assert_eq!(con.command_count("SCAN"), 2);
    }

    #[tokio::test]
    async fn filtered_hash_load_more_matches_fields_and_keeps_scan_cursor() {
        let mut con = FakeRedisConnection::new(vec![
            hscan_response("512", vec![("user:1", "Ada")]),
            hscan_response("0", vec![("user:2", "Bob")]),
        ]);

        let result = super::load_more_collection(&mut con, b"hash-key", "hash", 0, 1, Some("user")).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, Some(512));
        assert_eq!(items, vec![RedisHashItem { field: text_blob("user:1"), value: text_blob("Ada") }]);
        assert_eq!(con.command_count("HSCAN"), 1);
        assert!(!con.commands[0].contains("\r\nMATCH\r\n"));
    }

    #[tokio::test]
    async fn filtered_hash_load_more_matches_values() {
        let mut con =
            FakeRedisConnection::new(vec![hscan_response("0", vec![("status", "Ada Lovelace"), ("name", "Bob")])]);

        let result = super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, Some("lovelace")).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(items, vec![RedisHashItem { field: text_blob("status"), value: text_blob("Ada Lovelace") }]);
        assert_eq!(con.command_count("HSCAN"), 1);
        assert!(!con.commands[0].contains("\r\nMATCH\r\n"));
    }

    #[tokio::test]
    async fn filtered_hash_load_more_caps_sparse_scan_iterations() {
        let responses = (1..=super::HASH_FILTER_SCAN_MAX_ITERATIONS + 1)
            .map(|cursor| hscan_response(&cursor.to_string(), vec![]))
            .collect();
        let mut con = FakeRedisConnection::new(responses);

        let result = super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, Some("missing")).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, Some(super::HASH_FILTER_SCAN_MAX_ITERATIONS as u64));
        assert!(items.is_empty());
        assert_eq!(con.command_count("HSCAN"), super::HASH_FILTER_SCAN_MAX_ITERATIONS);
    }

    #[test]
    fn does_not_treat_utf8_with_backslashes_as_binary() {
        let raw = RedisRawValue::BulkString(br#"C:\Users\path"#.to_vec());

        let blob = redis_value_to_bytes(raw).map(|bytes| redis_blob_from_bytes(&bytes)).unwrap();
        assert_eq!(blob.encoding, RedisBlobEncoding::Utf8);
    }

    #[test]
    fn preserves_non_ascii_utf8_as_utf8() {
        let raw = RedisRawValue::BulkString("你好，redis".as_bytes().to_vec());

        let blob = redis_value_to_bytes(raw).map(|bytes| redis_blob_from_bytes(&bytes)).unwrap();
        assert_eq!(blob.encoding, RedisBlobEncoding::Utf8);
    }

    #[test]
    fn parses_command_text_with_quotes_and_escapes() {
        let argv = parse_command_argv(r#"SET "user:1" "Ada \"Lovelace\"""#).unwrap();

        assert_eq!(argv, vec!["SET", "user:1", "Ada \"Lovelace\""]);
    }

    #[test]
    fn parses_quoted_and_escaped_command_names_before_classification() {
        for command_text in [r#""JSON.SET" user:1 $ {}"#, r#"JSON\.SET user:1 $ {}"#] {
            let argv = parse_command_argv(command_text).unwrap();
            assert_eq!(classify_command(&argv[0]), RedisCommandSafety::Write);
        }
    }

    #[test]
    fn rejects_empty_command_text() {
        assert_eq!(parse_command_argv("   ").unwrap_err(), "Redis command is empty");
    }

    #[tokio::test]
    async fn raw_command_execution_fails_closed_before_sending_invalid_or_unknown_commands() {
        let mut con = FakeRedisConnection::new(Vec::new());

        let unknown = super::execute_command(&mut con, "VENDOR.WRITE key value", false).await.unwrap_err();
        assert!(unknown.contains("blocked for safety"));

        let malformed = super::execute_command(&mut con, r#"GET "unterminated"#, true).await.unwrap_err();
        assert_eq!(malformed, "Redis command has an unterminated quote");
        assert!(con.commands.is_empty());
    }

    #[test]
    fn matches_redis_values_case_insensitively() {
        assert!(redis_value_matches_query(&string_value("Hello Redis"), "redis"));
        assert!(redis_value_matches_query(&hash_value(&[("field", "Ada Lovelace")]), "lovelace"));
        assert!(!redis_value_matches_query(&string_value("Hello Redis"), ""));
        assert!(!redis_value_matches_query(&string_value("Hello Redis"), "mysql"));
    }

    #[test]
    fn matches_redis_keys_case_insensitively() {
        assert!(redis_key_matches_query("User:42:Profile", "User:42:Profile", "profile"));
        assert!(redis_key_matches_query("binary key", "ff75736572", "FF75"));
        assert!(!redis_key_matches_query("User:42:Profile", "User:42:Profile", ""));
        assert!(!redis_key_matches_query("User:42:Profile", "User:42:Profile", "order"));
    }

    #[test]
    fn sparse_key_scan_continues_after_empty_iterations() {
        assert!(super::should_continue_key_scan(0, 1000, 8, 50));
    }

    #[test]
    fn key_scan_stops_when_result_page_is_full() {
        assert!(!super::should_continue_key_scan(1000, 1000, 3, 50));
        assert!(!super::should_continue_key_scan(1200, 1000, 3, 50));
    }

    #[test]
    fn key_scan_respects_iteration_budget() {
        assert!(!super::should_continue_key_scan(0, 1000, 50, 50));
        assert!(!super::should_continue_key_scan(0, 0, 1, 1));
    }

    #[test]
    fn matches_hash_field_name_in_value_search() {
        let hash_value = hash_value(&[("name", "Alice"), ("email", "alice@example.com")]);
        assert!(redis_value_matches_query(&hash_value, "name"));
        assert!(redis_value_matches_query(&hash_value, "email"));
    }

    #[test]
    fn matches_hash_field_value_in_value_search() {
        let hash_value = hash_value(&[("name", "Alice"), ("email", "alice@example.com")]);
        assert!(redis_value_matches_query(&hash_value, "alice"));
        assert!(redis_value_matches_query(&hash_value, "example"));
    }

    #[test]
    fn empty_hash_does_not_match() {
        let empty_hash = hash_value(&[]);
        assert!(!redis_value_matches_query(&empty_hash, "anything"));
    }

    #[test]
    fn non_hash_array_unaffected() {
        let set_value = set_value(&["member1", "member2", "hello"]);
        assert!(redis_value_matches_query(&set_value, "member1"));
        assert!(redis_value_matches_query(&set_value, "hello"));
        assert!(!redis_value_matches_query(&set_value, "nonexistent"));
    }

    #[test]
    fn classifies_safe_confirmed_and_blocked_commands() {
        assert_eq!(classify_command("GET"), RedisCommandSafety::Allowed);
        assert_eq!(classify_command("JSON.GET"), RedisCommandSafety::Allowed);
        assert_eq!(classify_command("set"), RedisCommandSafety::Write);
        assert_eq!(classify_command("hset"), RedisCommandSafety::Write);
        assert_eq!(classify_command("JSON.SET"), RedisCommandSafety::Write);
        assert_eq!(classify_command("GETEX"), RedisCommandSafety::Write);
        assert_eq!(classify_command("XREADGROUP"), RedisCommandSafety::Write);
        assert_eq!(classify_command("del"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("flushdb"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("KEYS"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("flushall"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("eval"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("FCALL"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("XGROUP"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("VENDOR.WRITE"), RedisCommandSafety::Blocked);
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
    fn converts_command_unsafe_int64_to_string_for_js() {
        let raw = RedisRawValue::Int(2_326_645_729_978_441_729);

        assert_eq!(redis_command_raw_to_json(raw), serde_json::json!("2326645729978441729"));
    }

    #[test]
    fn converts_bulkstring_json_with_unsafe_int64_for_js() {
        let raw = RedisRawValue::BulkString(br#"{"uid":2321205972557213697,"name":"test"}"#.to_vec());

        assert_eq!(redis_command_raw_to_json(raw), serde_json::json!({"uid": "2321205972557213697", "name": "test"}));
    }

    #[test]
    fn keeps_plain_bulkstring_as_is() {
        let raw = RedisRawValue::BulkString(b"hello world".to_vec());
        assert_eq!(redis_command_raw_to_json(raw), serde_json::json!("hello world"));
    }

    #[test]
    fn keeps_string_like_number_as_string() {
        let raw = RedisRawValue::BulkString(b"42".to_vec());
        assert_eq!(redis_command_raw_to_json(raw), serde_json::json!("42"));
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
    fn parses_redis_sentinel_master_lookup_response() {
        let raw = RedisRawValue::Array(vec![bulk("10.0.0.8"), bulk("6379")]);

        assert_eq!(
            redis_sentinel_master_endpoint(raw).unwrap(),
            RedisNodeEndpoint { host: "10.0.0.8".to_string(), port: 6379 }
        );
    }

    #[test]
    fn rejects_invalid_redis_sentinel_master_lookup_response() {
        let raw = RedisRawValue::Array(vec![bulk("10.0.0.8")]);

        assert_eq!(
            redis_sentinel_master_endpoint(raw).unwrap_err(),
            "Redis Sentinel master lookup returned an invalid endpoint"
        );
    }

    #[test]
    fn redis_connection_info_marks_tls_as_insecure_when_requested() {
        let info = connection_info("cache.example.com", 6379, true, true, "default", "secret", 0);

        assert!(matches!(info.addr, ConnectionAddr::TcpTls { insecure: true, .. }));
    }

    #[test]
    fn redis_connection_info_preserves_acl_username_and_password() {
        let info = connection_info("cache.example.com", 6379, false, false, "app-user", "secret", 0);

        assert_eq!(info.redis.username.as_deref(), Some("app-user"));
        assert_eq!(info.redis.password.as_deref(), Some("secret"));
    }

    #[test]
    fn redis_auth_candidates_try_username_at_password_fallback() {
        let candidates = redis_auth_candidates("app-user", "secret");

        assert_eq!(
            candidates,
            vec![
                RedisAuthCandidate { username: "app-user".to_string(), password: "secret".to_string() },
                RedisAuthCandidate { username: String::new(), password: "app-user@secret".to_string() },
            ]
        );
    }

    #[test]
    fn redis_database_index_uses_numeric_database_only() {
        let mut config = ConnectionConfig {
            id: "redis".to_string(),
            name: "Redis".to_string(),
            db_type: crate::models::connection::DatabaseType::Redis,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "cache.example.com".to_string(),
            port: 6379,
            username: String::new(),
            password: String::new(),
            database: Some("4".to_string()),
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: crate::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: crate::models::connection::default_query_timeout_secs(),
            idle_timeout_secs: crate::models::connection::default_idle_timeout_secs(),
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: crate::models::connection::default_redis_key_separator(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        };

        assert_eq!(redis_database_index(&config), 4);
        config.database = Some("not-a-number".to_string());
        assert_eq!(redis_database_index(&config), 0);
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
                RedisClusterSlotRange {
                    start: 0,
                    end: 5460,
                    master: RedisNodeEndpoint { host: "10.0.0.1".to_string(), port: 7000 },
                },
                RedisClusterSlotRange {
                    start: 5461,
                    end: 10922,
                    master: RedisNodeEndpoint { host: "10.0.0.2".to_string(), port: 7001 },
                },
            ]
        );
    }

    #[test]
    fn calculates_redis_cluster_hash_tag_slots() {
        assert_eq!(redis_cluster_slot(b"issue1246:{user}:a"), redis_cluster_slot(b"issue1246:{user}:b"));
        assert_ne!(redis_cluster_slot(b"issue1246:{user}:a"), redis_cluster_slot(b"issue1246:{other}:a"));
    }

    #[test]
    fn preserves_raw_redis_json_text_without_parsing_numbers_for_js() {
        let raw_text =
            r#"{"id":2326645729978441729,"fraction":0.123456789012345678901234,"scientific":1.234567890123456789e20}"#;

        assert_eq!(super::redis_json_raw_to_text(bulk(raw_text)).unwrap(), raw_text);
        assert_eq!(super::redis_json_raw_to_text(RedisRawValue::Nil).unwrap_err(), "RedisJSON key no longer exists");
        assert!(super::redis_json_raw_to_text(RedisRawValue::BulkString(vec![0xff])).is_err());
    }

    #[tokio::test]
    async fn returns_lossless_value_text_for_native_redis_json_values() {
        let value_text = r#"{"id":2326645729978441729,"fraction":0.123456789012345678901234,"name":"Ada"}"#;
        let mut con = FakeRedisConnection::new(vec![bulk("ReJSON-RL"), RedisRawValue::Int(-1), bulk(value_text)]);

        let value = super::get_value(&mut con, b"json:key").await.unwrap();
        let response = serde_json::to_value(&value).unwrap();
        let RedisValueData::Json { value: returned } = value.data else {
            panic!("expected RedisJSON value");
        };
        assert_eq!(returned, value_text);
        assert_eq!(con.command_count("JSON.GET"), 1);

        assert_eq!(response["data"]["value"], value_text);
        assert!(response["data"].get("raw_text").is_none());
    }

    #[tokio::test]
    async fn rejects_a_native_redis_json_key_deleted_after_type_lookup() {
        let mut con = FakeRedisConnection::new(vec![bulk("ReJSON-RL"), RedisRawValue::Int(-1), RedisRawValue::Nil]);

        let error = super::get_value(&mut con, b"json:key").await.unwrap_err();

        assert_eq!(error, "RedisJSON key no longer exists");
    }

    #[tokio::test]
    async fn redis_json_set_keeps_lossless_numeric_literals_in_the_command() {
        let raw_text = r#"{"id":2326645729978441729,"fraction":0.123456789012345678901234}"#;
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Okay]);

        super::json_set(&mut con, b"json:key", raw_text, None).await.unwrap();

        assert_eq!(con.command_count("JSON.SET"), 1);
        assert!(con.commands[0].contains(raw_text));
    }

    #[test]
    fn uses_lightweight_redis_json_placeholder_for_key_scan_preview() {
        assert_eq!(redis_key_value_preview("ReJSON-RL"), "{...}");
        assert_eq!(redis_key_value_preview("string"), "");
    }
}
