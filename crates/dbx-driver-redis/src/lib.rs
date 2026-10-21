use base64::Engine;
use dbx_driver_support::db::{connection_timeout, json_value_for_js, safe_i64_to_json, CONNECTION_TIMEOUT_SECS};
use dbx_types::models::connection::{ConnectionConfig, DatabaseConnectionInfo};
use redis::{
    aio::ConnectionLike, cluster::ClusterClient, cluster_async::ClusterConnection, Cmd, ConnectionAddr, ConnectionInfo,
    FromRedisValue, IntoConnectionInfo, Pipeline, ProtocolVersion, RedisConnectionInfo, RedisFuture,
    Value as RedisRawValue,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
    time::Instant,
};
use tokio::sync::{Mutex, MutexGuard};

const STREAM_ENTRY_PAGE_SIZE: usize = 50;
const STREAM_PENDING_PAGE_SIZE: usize = 100;
const COLLECTION_PAGE_SIZE: usize = 200;
pub const STRING_PREVIEW_MAX_BYTES: usize = 64 * 1024;
pub const VALUE_PREVIEW_MAX_BYTES: usize = 64 * 1024 * 1024;

pub fn validate_value_preview_limit(limit: usize) -> Result<(), String> {
    if !(1024..=VALUE_PREVIEW_MAX_BYTES).contains(&limit) {
        return Err("Redis value preview limit must be between 1024 and 67108864 bytes".to_string());
    }
    Ok(())
}
/// A collection page is capped by payload size as well as item count.
///
/// `COLLECTION_PAGE_SIZE` alone bounds a page only when the members are small. A hash, list, set
/// or sorted set whose members are serialized blobs turns 200 members into hundreds of megabytes,
/// which then has to cross the IPC boundary and be parsed and rendered, so opening the key looks
/// like it does nothing. Strings already avoid this through `STRING_PREVIEW_MAX_BYTES`; this is
/// the same guard for collections, except that no member is ever truncated — the page simply ends
/// early and the remainder is fetched by the existing "load more" cursor.
const COLLECTION_PAGE_MAX_BYTES: usize = 4 * 1024 * 1024;
const COLLECTION_FILTER_SCAN_MAX_ITERATIONS: usize = 10;
const DEFAULT_REDIS_DATABASES: u32 = 16;
const MAX_CLUSTER_DATABASE_LIST_ENTRIES: u32 = 10_000;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CLUSTER_CURSOR_NODE_BITS: u64 = 16;
const CLUSTER_CURSOR_NODE_MASK: u64 = (1 << CLUSTER_CURSOR_NODE_BITS) - 1;
const CLUSTER_CURSOR_SCAN_MASK: u64 = (1 << (64 - CLUSTER_CURSOR_NODE_BITS)) - 1;
const CLUSTER_SCAN_SESSION_LIMIT: usize = 128;
const CLUSTER_SCAN_SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const COLLECTION_OVERFLOW_SESSION_LIMIT: usize = 128;
const COLLECTION_OVERFLOW_SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const COLLECTION_OVERFLOW_CURSOR_START: u64 = 1 << 52;
const INVALID_CLUSTER_SCAN_CURSOR_ERROR: &str = "Redis cluster scan cursor is invalid or expired";
const MAX_SAFE_INTEGER_CURSOR: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisDatabaseInfo {
    pub db: u32,
    /// 该库的键数量。`None` 表示服务端无法给出可信数量：kvrocks 的 DBSIZE / INFO keyspace
    /// 键数是异步统计的（要先执行 `DBSIZE SCAN`），未统计前一律返回 0，这里不把 0 当作事实。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<u64>,
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

/// The expiration shapes the Key Browser may apply to a batch of selected keys.
///
/// The variants mirror [`set_ttl`] and [`set_expire_at`] exactly, so a batch edit
/// and a single-key edit send the same Redis command for the same user choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedisKeysExpiry {
    Persist,
    Ttl(i64),
    At(i64),
}

impl RedisKeysExpiry {
    /// Keeps the single-key convention where a non-positive TTL means PERSIST.
    pub fn from_ttl(ttl: i64) -> Self {
        if ttl > 0 {
            Self::Ttl(ttl)
        } else {
            Self::Persist
        }
    }

    fn command(self) -> &'static str {
        match self {
            Self::Persist => "PERSIST",
            Self::Ttl(_) => "EXPIRE",
            Self::At(_) => "EXPIREAT",
        }
    }
}

/// Per-key outcome of a batch expiration so a partial failure stays reportable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisKeysExpiryResult {
    /// Keys the server confirmed as updated.
    pub applied: u64,
    /// Selected keys that no longer exist, so the caller can offer a retry.
    pub missing_key_raws: Vec<String>,
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
    /// Remaining field TTL in seconds. `-1` means the field is persistent;
    /// `None` means the Redis server does not expose hash-field expiration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_ttl: Option<i64>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamPage {
    pub entries: Vec<RedisStreamEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamGroup {
    pub name: RedisBlob,
    #[serde(serialize_with = "serialize_redis_u64_for_js")]
    pub consumers: u64,
    #[serde(serialize_with = "serialize_redis_u64_for_js")]
    pub pending: u64,
    pub last_delivered_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serialize_optional_redis_u64_for_js")]
    pub entries_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serialize_optional_redis_u64_for_js")]
    pub lag: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamConsumer {
    pub name: RedisBlob,
    #[serde(serialize_with = "serialize_redis_u64_for_js")]
    pub pending: u64,
    #[serde(serialize_with = "serialize_redis_u64_for_js")]
    pub idle_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serialize_optional_redis_u64_for_js")]
    pub inactive_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamPendingEntry {
    pub id: String,
    pub consumer: RedisBlob,
    #[serde(serialize_with = "serialize_redis_u64_for_js")]
    pub idle_ms: u64,
    #[serde(serialize_with = "serialize_redis_u64_for_js")]
    pub deliveries: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedisStreamPendingPage {
    pub entries: Vec<RedisStreamPendingEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

// JSON and Tauri IPC both deliver numbers to JavaScript, so preserve large Redis counters as text.
fn serialize_redis_u64_for_js<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if *value > JS_MAX_SAFE_INTEGER {
        serializer.serialize_str(&value.to_string())
    } else {
        serializer.serialize_u64(*value)
    }
}

fn serialize_optional_redis_u64_for_js<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        Some(value) => serialize_redis_u64_for_js(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedisValueData {
    String {
        content: RedisBlob,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        truncated: bool,
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
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            serialize_with = "serialize_optional_redis_u64_for_js"
        )]
        total: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_cursor: Option<String>,
    },
    /// kvrocks 把位图实现成独立类型（`TYPE` 返回 `bitmap`），而 Redis 里 SETBIT 写入的
    /// 就是普通字符串，所以这个分支只会在 kvrocks 一类兼容服务上出现。kvrocks 上
    /// `GETRANGE`/`STRLEN` 对该类型会报 WRONGTYPE，只有 `GET` 能读到与 Redis 位序一致的
    /// 原始字节，因此这里用 GET 取内容、用 BITCOUNT 取置位数量。
    Bitmap {
        content: RedisBlob,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        truncated: bool,
        /// `BITCOUNT` 得到的置位数量；命令不可用时为 None。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set_bits: Option<u64>,
    },
    /// kvrocks 的 HyperLogLog 独立类型（`TYPE` 返回 `hyperloglog`）：原始字节不可读，
    /// 只能通过 `PFCOUNT` 展示基数估计。
    #[serde(rename = "hyperloglog")]
    HyperLogLog {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count: Option<u64>,
    },
    /// 服务端返回了 DBX 尚未支持的类型（如 kvrocks 的 `timeseries`/`TDIS-TYPE`）。
    /// 带上原始类型名，前端据此给出明确提示，而不是渲染成空值。
    Unknown { redis_type: String },
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

#[cfg(any(test, feature = "test-support"))]
pub fn redis_connection_test_stub() -> RedisConnection {
    RedisConnection::Cluster(RedisClusterPool {
        connection: None,
        database_connections: Box::new(tokio::sync::Mutex::new(HashMap::new())),
        database_capability: Box::new(tokio::sync::Mutex::new(None)),
        seed_nodes: Vec::new(),
        seed_routes: Vec::new(),
        slot_ranges: Vec::new(),
        node_routes: Vec::new(),
        tls: false,
        tls_insecure: false,
        tls_certificates: None,
        username: String::new(),
        password: String::new(),
        scan_sessions: Box::new(Mutex::new(RedisClusterScanSessions::default())),
    })
}

type RedisClusterDatabaseConnections = HashMap<u32, Arc<Mutex<Option<ClusterConnection>>>>;

pub struct RedisClusterPool {
    pub connection: Option<Mutex<ClusterConnection>>,
    database_connections: Box<Mutex<RedisClusterDatabaseConnections>>,
    database_capability: Box<Mutex<Option<ClusterDatabaseCapability>>>,
    pub seed_nodes: Vec<RedisNodeEndpoint>,
    pub seed_routes: Vec<RedisNodeRoute>,
    pub slot_ranges: Vec<RedisClusterSlotRange>,
    pub node_routes: Vec<RedisNodeRoute>,
    pub tls: bool,
    pub tls_insecure: bool,
    pub tls_certificates: Option<Box<redis::TlsCertificates>>,
    pub username: String,
    pub password: String,
    scan_sessions: Box<Mutex<RedisClusterScanSessions>>,
}

#[derive(Debug, Clone)]
struct RedisClusterKeyScanSession {
    db: u32,
    value_filter: Option<(String, bool)>,
    total_keys: u64,
    master_nodes: Vec<RedisNodeEndpoint>,
    node_cursors: Vec<u64>,
    node_complete: Vec<bool>,
    next_node_index: usize,
    pattern: String,
    last_used: Instant,
}

impl RedisClusterKeyScanSession {
    fn new(master_nodes: Vec<RedisNodeEndpoint>, pattern: &str) -> Self {
        let node_count = master_nodes.len();
        Self {
            db: 0,
            value_filter: None,
            total_keys: 0,
            master_nodes,
            node_cursors: vec![0; node_count],
            node_complete: vec![false; node_count],
            next_node_index: 0,
            pattern: pattern.to_string(),
            last_used: Instant::now(),
        }
    }

    fn next_unfinished_node_index(&self) -> Option<usize> {
        let node_count = self.master_nodes.len();
        (0..node_count)
            .map(|offset| (self.next_node_index + offset) % node_count)
            .find(|index| !self.node_complete[*index])
    }

    fn advance_after(&mut self, node_index: usize) {
        self.next_node_index = (node_index + 1) % self.master_nodes.len();
    }

    fn is_complete(&self) -> bool {
        self.node_complete.iter().all(|complete| *complete)
    }
}

#[derive(Debug, Default)]
struct RedisClusterScanSessions {
    entries: HashMap<u64, RedisClusterKeyScanSession>,
}

impl RedisClusterScanSessions {
    fn take(&mut self, cursor: u64) -> Option<RedisClusterKeyScanSession> {
        self.remove_expired();
        self.entries.remove(&cursor)
    }

    fn insert(&mut self, cursor: Option<u64>, mut session: RedisClusterKeyScanSession) -> u64 {
        self.remove_expired();
        while self.entries.len() >= CLUSTER_SCAN_SESSION_LIMIT {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, entry)| entry.last_used).map(|(id, _)| *id) else {
                break;
            };
            self.entries.remove(&oldest);
        }

        let cursor = cursor.filter(|value| *value > 0).unwrap_or_else(|| self.next_available_cursor());
        session.last_used = Instant::now();
        self.entries.insert(cursor, session);
        cursor
    }

    fn remove_expired(&mut self) {
        self.entries.retain(|_, entry| entry.last_used.elapsed() < CLUSTER_SCAN_SESSION_TTL);
    }

    fn next_available_cursor(&mut self) -> u64 {
        // Pool-local counters could accept a token from another connection when
        // both pools happen to allocate the same cursor. Allocate process-wide.
        static NEXT_CURSOR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        loop {
            let cursor = NEXT_CURSOR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % MAX_SAFE_INTEGER_CURSOR + 1;
            if cursor != 0 && !self.entries.contains_key(&cursor) {
                return cursor;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedisCollectionOverflowKind {
    Hash,
    Set,
}

#[derive(Debug, Clone)]
enum RedisCollectionOverflowItems {
    Hash(Vec<RedisHashItem>),
    Set(Vec<RedisSetItem>),
}

#[derive(Debug, Clone)]
struct RedisCollectionOverflowSession {
    scope: RedisOperationScope,
    key: Vec<u8>,
    kind: RedisCollectionOverflowKind,
    filter: Option<String>,
    sort_direction: Option<String>,
    followup_cursor: u64,
    items: RedisCollectionOverflowItems,
    last_used: Instant,
}

#[derive(Debug)]
struct RedisCollectionOverflowSessions {
    next_cursor: u64,
    entries: HashMap<u64, RedisCollectionOverflowSession>,
}

impl Default for RedisCollectionOverflowSessions {
    fn default() -> Self {
        Self { next_cursor: COLLECTION_OVERFLOW_CURSOR_START, entries: HashMap::new() }
    }
}

impl RedisCollectionOverflowSessions {
    fn take_matching(
        &mut self,
        cursor: u64,
        scope: &RedisOperationScope,
        key: &[u8],
        kind: RedisCollectionOverflowKind,
        filter: Option<&str>,
        sort_direction: Option<&str>,
    ) -> Option<RedisCollectionOverflowSession> {
        self.remove_expired();
        let matches = self.entries.get(&cursor).is_some_and(|session| {
            session.scope == *scope
                && session.key == key
                && session.kind == kind
                && session.filter.as_deref() == filter
                && session.sort_direction.as_deref() == sort_direction
        });
        matches.then(|| self.entries.remove(&cursor)).flatten()
    }

    fn insert(&mut self, mut session: RedisCollectionOverflowSession) -> u64 {
        self.remove_expired();
        while self.entries.len() >= COLLECTION_OVERFLOW_SESSION_LIMIT {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, entry)| entry.last_used).map(|(id, _)| *id) else {
                break;
            };
            self.entries.remove(&oldest);
        }

        let cursor = self.next_available_cursor();
        session.last_used = Instant::now();
        self.entries.insert(cursor, session);
        cursor
    }

    fn reinsert(&mut self, cursor: u64, mut session: RedisCollectionOverflowSession) {
        self.remove_expired();
        while self.entries.len() >= COLLECTION_OVERFLOW_SESSION_LIMIT && !self.entries.contains_key(&cursor) {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, entry)| entry.last_used).map(|(id, _)| *id) else {
                break;
            };
            self.entries.remove(&oldest);
        }
        session.last_used = Instant::now();
        self.entries.insert(cursor, session);
    }

    fn remove_expired(&mut self) {
        self.entries.retain(|_, entry| entry.last_used.elapsed() < COLLECTION_OVERFLOW_SESSION_TTL);
    }

    fn next_available_cursor(&mut self) -> u64 {
        loop {
            let cursor = self.next_cursor;
            self.next_cursor =
                if cursor >= MAX_SAFE_INTEGER_CURSOR { COLLECTION_OVERFLOW_CURSOR_START } else { cursor + 1 };
            if cursor != 0 && !self.entries.contains_key(&cursor) {
                return cursor;
            }
        }
    }
}

/// Stable request identity, independent of mutable SELECT state on a connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RedisOperationScope {
    pub connection_id: String,
    pub db: u32,
}

fn collection_overflow_sessions() -> &'static Mutex<RedisCollectionOverflowSessions> {
    static SESSIONS: OnceLock<Mutex<RedisCollectionOverflowSessions>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(RedisCollectionOverflowSessions::default()))
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
    Database(ClusterConnection),
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
            RedisClusterConnectionGuard::Database(con) => con.req_packed_command(cmd),
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
            RedisClusterConnectionGuard::Database(con) => con.req_packed_commands(cmd, offset, count),
            RedisClusterConnectionGuard::Direct(con) => con.req_packed_commands(cmd, offset, count),
        }
    }

    fn get_db(&self) -> i64 {
        match self {
            RedisClusterConnectionGuard::Native(con) => con.get_db(),
            RedisClusterConnectionGuard::Database(con) => con.get_db(),
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
    let certificates = load_redis_tls_certificates(config)?;
    let mut last_error = None;
    for info in standalone_connection_infos(config, host, port)? {
        let client = build_redis_client(info, certificates.as_ref())?;
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

fn standalone_connection_infos(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<Vec<ConnectionInfo>, String> {
    redis_auth_candidates(&config.username, &config.password)
        .into_iter()
        .map(|auth| {
            connection_info(
                host,
                port,
                config.ssl,
                config.redis_tls_insecure(),
                &auth.username,
                &auth.password,
                redis_database_index(config),
            )
        })
        .collect()
}

async fn connect_client_with_timeout(
    client: redis::Client,
    timeout: std::time::Duration,
    label: &str,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let options = redis_async_connection_config();
    // Type-erase the transport future here: otherwise downstream core operations
    // expand the entire redis-rs TCP/TLS future when proving Send, exceeding the
    // default recursion limit of their integration-test crates. This is not a
    // spawned task; dropping the caller still cancels connection establishment.
    let connect: RedisFuture<'_, redis::aio::MultiplexedConnection> =
        Box::pin(client.get_multiplexed_async_connection_with_config(&options));
    let mut con = tokio::time::timeout(timeout, connect)
        .await
        .map_err(|_| format!("{label} connection timed out ({}s)", timeout.as_secs()))?
        .map_err(|e| format!("{label} connection failed: {e}"))?;

    // Credentials are applied while the connection is being established, so reaching this point
    // already proves AUTH succeeded. The PING below is only a liveness probe: an account that may
    // not run PING (for example a managed Redis behind a restrictive ACL) is still a usable
    // connection, so a denied PING must not fail it (issue #9394).
    redis_ping(&mut con, label, timeout).await?;

    Ok(con)
}

pub async fn connect_sentinel(config: &ConnectionConfig) -> Result<redis::aio::MultiplexedConnection, String> {
    connect_sentinel_with_timeout(config, connection_timeout()).await
}

async fn connect_sentinel_with_timeout(
    config: &ConnectionConfig,
    lookup_timeout: Duration,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let service_name = config.redis_sentinel_master.trim();
    if service_name.is_empty() {
        return Err("Redis Sentinel master name is required".to_string());
    }

    let nodes = redis_sentinel_nodes(config)?;
    let client = tokio::time::timeout(lookup_timeout, sentinel_master_client(config, &nodes, service_name))
        .await
        .map_err(|_| format!("Redis Sentinel lookup timed out ({}s)", lookup_timeout.as_secs()))?
        .map_err(|e| format!("Redis Sentinel master lookup failed: {e}"))?;

    connect_client(client).await
}

// redis-rs 1.x does not expose timeout configuration for Sentinel's private
// discovery/ROLE connections. Keep the 0.32 discovery contract here so the
// existing outer DBX lookup deadline, not new 500-ms/1-second defaults, applies.
// This is one-shot discovery, not a failover manager.
async fn sentinel_master_client(
    config: &ConnectionConfig,
    nodes: &[ConnectionInfo],
    service_name: &str,
) -> Result<redis::Client, String> {
    let certificates = load_redis_tls_certificates(config)?;
    let masters = sentinel_masters(nodes, certificates.as_ref()).await.map_err(|error| error.to_string())?;
    for master in masters {
        let Some(endpoint) = sentinel_eligible_master(&master, service_name) else { continue };
        let client = build_redis_client(
            connection_info(
                &endpoint.host,
                endpoint.port,
                config.ssl,
                config.redis_tls_insecure(),
                &config.username,
                &config.password,
                0,
            )?,
            certificates.as_ref(),
        )
        .map_err(|error| error.to_string())?;
        let mut con = client
            .get_multiplexed_async_connection_with_config(&redis_async_connection_config())
            .await
            .map_err(|error| error.to_string())?;
        if sentinel_is_master(&mut con).await.map_err(|error| error.to_string())? {
            return Ok(client);
        }
    }
    Err(format!("Master '{service_name}' not found among healthy Sentinel masters"))
}

async fn sentinel_masters(
    nodes: &[ConnectionInfo],
    certificates: Option<&redis::TlsCertificates>,
) -> Result<Vec<HashMap<String, String>>, String> {
    let mut last_error = None;
    for info in nodes {
        let result = async {
            let client = build_redis_client(info.clone(), certificates)?;
            let mut con = client
                .get_multiplexed_async_connection_with_config(&redis_async_connection_config())
                .await
                .map_err(|error| error.to_string())?;
            let result = redis::cmd("SENTINEL").arg("MASTERS").query_async(&mut con).await;
            match result {
                // Match the old Sentinel client's single reconnect on an I/O
                // query failure, followed by trying the next configured node.
                Err(error) if error.is_io_error() || error.is_unrecoverable_error() => {
                    let mut con = client
                        .get_multiplexed_async_connection_with_config(&redis_async_connection_config())
                        .await
                        .map_err(|error| error.to_string())?;
                    redis::cmd("SENTINEL").arg("MASTERS").query_async(&mut con).await.map_err(|error| error.to_string())
                }
                result => result.map_err(|error| error.to_string()),
            }
        }
        .await;
        match result {
            Ok(masters) => return Ok(masters),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "At least one Sentinel is required".to_string()))
}

fn sentinel_eligible_master(metadata: &HashMap<String, String>, service_name: &str) -> Option<RedisNodeEndpoint> {
    if metadata.get("name").map(String::as_str) != Some(service_name) {
        return None;
    }
    let flags = metadata.get("flags")?;
    if !flags.contains("master") || flags.contains("s_down") || flags.contains("o_down") {
        return None;
    }
    Some(RedisNodeEndpoint { host: metadata.get("ip")?.clone(), port: metadata.get("port")?.parse().ok()? })
}

async fn sentinel_is_master<C>(con: &mut C) -> redis::RedisResult<bool>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let role_error = match redis::cmd("ROLE").query_async::<redis::Role>(con).await {
        Ok(role) => return Ok(matches!(role, redis::Role::Primary { .. })),
        Err(error) => error,
    };
    let fallback = redis::cmd("INFO").arg("REPLICATION").query_async::<String>(con).await.and_then(|info| {
        let roles: HashMap<_, _> = info
            .split("\r\n")
            .filter(|line| !line.trim_start().starts_with('#'))
            .filter_map(|line| line.split_once(':'))
            .collect();
        roles.get("role").map(|role| *role == "master").ok_or_else(|| {
            redis::RedisError::from((redis::ErrorKind::UnexpectedReturnType, "Missing role in INFO REPLICATION"))
        })
    });
    match fallback {
        Ok(is_master) => Ok(is_master),
        // Preserve the original error when ROLE failed for more than an
        // unavailable command; otherwise expose the INFO fallback failure.
        Err(_) if role_error.kind() != redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError) => {
            Err(role_error)
        }
        Err(error) => Err(error),
    }
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

    let certificates = load_redis_tls_certificates(config)?;
    let client = build_redis_client(
        connection_info(
            host,
            port,
            config.redis_sentinel_tls,
            config.redis_tls_insecure(),
            &config.redis_sentinel_username,
            &config.redis_sentinel_password,
            0,
        )?,
        certificates.as_ref(),
    )
    .map_err(|e| format!("Redis Sentinel connect failed: {e}"))?;
    let mut con = connect_client_with_timeout(client, connection_timeout(), "Redis Sentinel").await?;
    let raw = tokio::time::timeout(
        connection_timeout(),
        redis::cmd("SENTINEL").arg("get-master-addr-by-name").arg(service_name).query_async::<RedisRawValue>(&mut con),
    )
    .await
    .map_err(|_| format!("Redis Sentinel master lookup timed out ({}s)", CONNECTION_TIMEOUT_SECS))?
    .map_err(|e| format!("Redis Sentinel master lookup failed: {e}"))?;

    redis_sentinel_master_endpoint(raw)
}

pub async fn connect_cluster(config: &ConnectionConfig) -> Result<RedisClusterPool, String> {
    let seed_nodes = redis_cluster_seed_nodes(config)?;
    let timeout = Duration::from_secs(config.effective_connect_timeout_secs());
    let certificates = load_redis_tls_certificates(config)?;
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
            .collect::<Result<_, _>>()?;
        let mut builder = ClusterClient::builder(cluster_nodes).connection_timeout(timeout);
        if let Some(certificates) = &certificates {
            builder = builder.certs(certificates.clone());
        }
        let client = builder.build().map_err(|e| format!("Redis cluster connection failed: {e}"))?;
        let mut con = match tokio::time::timeout(timeout, client.get_async_connection())
            .await
            .map_err(|_| format!("Redis cluster connection timed out ({}s)", timeout.as_secs()))?
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

        let cluster_ping = match tokio::time::timeout(timeout, redis::cmd("PING").query_async::<String>(&mut con)).await
        {
            Ok(Ok(_)) => Ok(()),
            // Reachable and authenticated, only the PING privilege is missing (issue #9394).
            Ok(Err(error)) if is_redis_command_denied_error(&error.to_string()) => Ok(()),
            Ok(Err(error)) => Err(format!("Redis cluster ping failed: {error}")),
            Err(_) => Err(format!("Redis cluster ping timed out ({}s)", timeout.as_secs())),
        };
        match cluster_ping {
            Ok(_) => {
                let seed_routes = identity_routes(&seed_nodes);
                let slot_ranges = cluster_slot_ranges_from_routes(
                    &seed_routes,
                    config.ssl,
                    config.redis_tls_insecure(),
                    certificates.as_ref(),
                    &auth.username,
                    &auth.password,
                )
                .await
                .unwrap_or_default();
                let node_routes = identity_routes(&unique_master_nodes(&slot_ranges));
                return Ok(RedisClusterPool {
                    connection: Some(Mutex::new(con)),
                    database_connections: Box::new(tokio::sync::Mutex::new(HashMap::new())),
                    database_capability: Box::new(tokio::sync::Mutex::new(None)),
                    seed_nodes,
                    seed_routes,
                    slot_ranges,
                    node_routes,
                    tls: config.ssl,
                    tls_insecure: config.redis_tls_insecure(),
                    tls_certificates: certificates.clone().map(Box::new),
                    username: auth.username,
                    password: auth.password,
                    scan_sessions: Box::new(Mutex::new(RedisClusterScanSessions::default())),
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
    let certificates = load_redis_tls_certificates(config)?;
    for auth in redis_auth_candidates(&config.username, &config.password) {
        match cluster_slot_ranges_from_routes(
            seed_routes,
            config.ssl,
            config.redis_tls_insecure(),
            certificates.as_ref(),
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
    let pool = RedisClusterPool {
        connection: None,
        database_connections: Box::new(tokio::sync::Mutex::new(HashMap::new())),
        database_capability: Box::new(tokio::sync::Mutex::new(None)),
        seed_nodes,
        seed_routes,
        slot_ranges,
        node_routes,
        tls: config.ssl,
        tls_insecure: config.redis_tls_insecure(),
        tls_certificates: load_redis_tls_certificates(config)?.map(Box::new),
        username: auth.username,
        password: auth.password,
        scan_sessions: Box::new(Mutex::new(RedisClusterScanSessions::default())),
    };
    {
        let mut con = cluster_any_connection(&pool).await?;
        redis_ping(&mut con, "Redis cluster", connection_timeout()).await?;
    }
    Ok(pool)
}

pub async fn test_connection(connection: &RedisConnection) -> Result<(), String> {
    match connection {
        RedisConnection::Direct(con) => {
            let mut con = con.lock().await;
            redis_ping(&mut *con, "Redis", connection_timeout()).await
        }
        RedisConnection::Cluster(cluster) => {
            let mut con = cluster_any_connection(cluster).await?;
            redis_ping(&mut con, "Redis cluster", connection_timeout()).await
        }
    }
}

/// Read the Redis server identity without making metadata unavailable when the
/// INFO command is disabled by ACL or server policy.
pub async fn database_connection_info(connection: &RedisConnection) -> Result<DatabaseConnectionInfo, String> {
    match connection {
        RedisConnection::Direct(con) => {
            let mut con = con.lock().await;
            redis_database_connection_info(&mut *con).await
        }
        RedisConnection::Cluster(pool) => {
            let mut con = cluster_any_connection(pool).await?;
            redis_database_connection_info(&mut con).await
        }
    }
}

async fn redis_database_connection_info<C>(con: &mut C) -> Result<DatabaseConnectionInfo, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let info =
        match tokio::time::timeout(connection_timeout(), redis::cmd("INFO").arg("server").query_async::<String>(con))
            .await
        {
            Ok(Ok(info)) => info,
            // Managed Redis accounts and proxies frequently allow connecting but not `INFO`. The
            // connection is still usable, so report the identity we do know instead of failing all
            // server metadata (issue #9394).
            Ok(Err(error)) if is_redis_command_denied_error(&error.to_string()) => String::new(),
            Ok(Err(error)) => return Err(format!("Redis INFO command failed: {error}")),
            Err(_) => {
                return Err(format!("Redis INFO command timed out ({}s)", CONNECTION_TIMEOUT_SECS));
            }
        };
    let product_version = info.lines().find_map(|line| {
        let (key, value) = line.trim().split_once(':')?;
        (key.eq_ignore_ascii_case("redis_version") && !value.trim().is_empty()).then(|| value.trim().to_string())
    });
    Ok(DatabaseConnectionInfo {
        product_name: Some("Redis".to_string()),
        product_version,
        ..DatabaseConnectionInfo::default()
    })
}

async fn redis_ping<C>(con: &mut C, label: &str, timeout: std::time::Duration) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    match tokio::time::timeout(timeout, redis::cmd("PING").query_async::<String>(con)).await {
        Ok(Ok(_)) => Ok(()),
        // The server is reachable and the credentials were accepted; only the PING privilege is
        // missing, which does not make the connection unusable (issue #9394).
        Ok(Err(error)) if is_redis_command_denied_error(&error.to_string()) => Ok(()),
        Ok(Err(error)) => Err(format!("{label} ping failed: {error}")),
        Err(_) => Err(format!("{label} ping timed out ({}s)", timeout.as_secs())),
    }
}

fn redis_sentinel_nodes(config: &ConnectionConfig) -> Result<Vec<ConnectionInfo>, String> {
    redis_sentinel_node_endpoints(config)?
        .iter()
        .map(|endpoint| {
            connection_info(
                &endpoint.host,
                endpoint.port,
                config.redis_sentinel_tls,
                config.redis_tls_insecure(),
                &config.redis_sentinel_username,
                &config.redis_sentinel_password,
                0,
            )
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

/// Loads Redis TLS material from the connection's certificate paths.
///
/// `None` keeps redis-rs on its default trust store. A CA file adds a private
/// root without disabling verification, and a client cert/key pair enables
/// mutual TLS (Redis 6+ `tls-auth-clients yes`). The paths are loaded whenever
/// they are configured because Sentinel nodes can use their own TLS switch
/// (`redis_sentinel_tls`) independently of the data connection.
fn load_redis_tls_certificates(config: &ConnectionConfig) -> Result<Option<redis::TlsCertificates>, String> {
    let ca_path = config.ca_cert_path.trim();
    let client_cert_path = config.client_cert_path.trim();
    let client_key_path = config.client_key_path.trim();
    if client_cert_path.is_empty() != client_key_path.is_empty() {
        return Err("Redis TLS client certificate and key must be configured together".to_string());
    }
    if ca_path.is_empty() && client_cert_path.is_empty() {
        return Ok(None);
    }
    let read = |path: &str, label: &str| {
        fs::read(path).map_err(|error| format!("Failed to read Redis TLS {label} '{path}': {error}"))
    };
    let root_cert = if ca_path.is_empty() { None } else { Some(read(ca_path, "CA certificate")?) };
    let client_tls = if client_cert_path.is_empty() {
        None
    } else {
        Some(redis::ClientTlsConfig {
            client_cert: read(client_cert_path, "client certificate")?,
            client_key: read(client_key_path, "client key")?,
        })
    };
    Ok(Some(redis::TlsCertificates { client_tls, root_cert }))
}

fn build_redis_client(
    info: ConnectionInfo,
    certificates: Option<&redis::TlsCertificates>,
) -> Result<redis::Client, String> {
    let tls_addr = matches!(info.addr(), ConnectionAddr::TcpTls { .. });
    let result = match (tls_addr, certificates) {
        (true, Some(certificates)) => redis::Client::build_with_tls(info, certificates.clone()),
        _ => redis::Client::open(info),
    };
    result.map_err(|error| format!("Redis connection failed: {error}"))
}

fn connection_info(
    host: &str,
    port: u16,
    tls: bool,
    insecure: bool,
    username: &str,
    password: &str,
    db: i64,
) -> Result<ConnectionInfo, String> {
    let addr = if tls {
        ConnectionAddr::TcpTls { host: host.to_string(), port, insecure, tls_params: None }
    } else {
        ConnectionAddr::Tcp(host.to_string(), port)
    };
    addr.into_connection_info()
        .map(|info| info.set_redis_settings(redis_connection_info(username, password, db)))
        .map_err(|error| format!("Redis connection configuration failed: {error}"))
}

fn redis_connection_info(username: &str, password: &str, db: i64) -> RedisConnectionInfo {
    let mut info = RedisConnectionInfo::default().set_db(db).set_protocol(ProtocolVersion::RESP2);
    if let Some(username) = non_empty_string(username) {
        info = info.set_username(username);
    }
    if let Some(password) = non_empty_string(password) {
        info = info.set_password(password);
    }
    info
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

/// True when the server rejected a command because the account may not run it, rather than because
/// the connection or the credentials are broken. Redis reports this as `NOPERM`; managed Redis
/// endpoints and proxies in front of them use "not support" / "unknown command" phrasing for the
/// same situation, which is what issue #9394 hit when its account was denied `PING`.
fn is_redis_command_denied_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("noperm")
        || error.contains("no permissions")
        || error.contains("permission denied")
        || error.contains("not support")
        || error.contains("unknown command")
        || error.contains("unsupported command")
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

fn redis_async_connection_config() -> redis::AsyncConnectionConfig {
    // redis-rs 1.x defaults to 1s connection / 500ms response deadlines. Keep DBX's
    // existing outer connection deadline and unrestricted command duration (for
    // blocking commands and large values), as with redis-rs 0.32.
    redis::AsyncConnectionConfig::new().set_connection_timeout(None).set_response_timeout(None)
}

async fn connect_client(client: redis::Client) -> Result<redis::aio::MultiplexedConnection, String> {
    connect_client_with_timeout(client, connection_timeout(), "Redis").await
}

pub async fn connect_direct_node(
    endpoint: &RedisNodeEndpoint,
    tls: bool,
    insecure: bool,
    certificates: Option<&redis::TlsCertificates>,
    username: &str,
    password: &str,
) -> Result<redis::aio::MultiplexedConnection, String> {
    connect_direct_node_in_db(endpoint, tls, insecure, certificates, username, password, 0).await
}

async fn connect_direct_node_in_db(
    endpoint: &RedisNodeEndpoint,
    tls: bool,
    insecure: bool,
    certificates: Option<&redis::TlsCertificates>,
    username: &str,
    password: &str,
    db: u32,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = build_redis_client(
        connection_info(&endpoint.host, endpoint.port, tls, insecure, username, password, i64::from(db))?,
        certificates,
    )?;
    connect_client(client).await
}

pub async fn connect_monitor(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    timeout: std::time::Duration,
) -> Result<redis::aio::Monitor, String> {
    let mut last_error = String::new();
    let certificates = load_redis_tls_certificates(config)?;
    for info in standalone_connection_infos(config, host, port)? {
        let client = build_redis_client(info, certificates.as_ref())?;
        let connect = async {
            let mut validation =
                client.get_multiplexed_async_connection_with_config(&redis_async_connection_config()).await?;
            redis::cmd("MONITOR").query_async::<()>(&mut validation).await?;
            drop(validation);
            client.get_async_monitor().await
        };
        match tokio::time::timeout(timeout, connect).await {
            Ok(Ok(monitor)) => return Ok(monitor),
            Ok(Err(error)) => {
                last_error = error.to_string();
                if !is_redis_auth_error(&last_error) {
                    break;
                }
            }
            Err(_) => return Err("Redis MONITOR connection timed out".to_string()),
        }
    }
    Err(last_error)
}

pub async fn connect_pubsub(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    timeout: std::time::Duration,
) -> Result<redis::aio::PubSub, String> {
    let mut last_error = None;
    let certificates = load_redis_tls_certificates(config)?;
    for auth in redis_auth_candidates(&config.username, &config.password) {
        let client = build_redis_client(
            connection_info(
                host,
                port,
                config.ssl,
                config.redis_tls_insecure(),
                &auth.username,
                &auth.password,
                redis_database_index(config),
            )?,
            certificates.as_ref(),
        )?;
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
    list_databases_with_timeout(con, connection_timeout()).await
}

/// Lists the logical databases of a standalone Redis connection.
///
/// Both metadata probes are bounded. A server (or a proxy in front of it) that accepts the
/// connection and answers `PING` but never replies to `CONFIG GET databases` / `INFO keyspace`
/// used to keep the caller waiting forever: the connection dialog's database picker stayed in
/// its loading state with the rest of the dialog disabled (#12426). A probe that never answers
/// now reports a timeout — the call stops there instead of issuing another command, because a
/// multiplexed connection cannot answer later requests while a reply is still outstanding.
pub async fn list_databases_with_timeout<C>(con: &mut C, timeout: Duration) -> Result<Vec<RedisDatabaseInfo>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let configured_count =
        match tokio::time::timeout(timeout, redis::cmd("CONFIG").arg("GET").arg("databases").query_async(con)).await {
            Ok(Ok(value)) => parse_database_count(value),
            // Renamed or denied CONFIG keeps the DBX default, as before.
            Ok(Err(_)) => None,
            Err(_) => {
                return Err(format!(
                    "Redis database list timed out ({}s): the server did not answer CONFIG GET databases",
                    timeout.as_secs()
                ))
            }
        };

    let keyspace_db_infos = match tokio::time::timeout(timeout, list_keyspace_databases(con)).await {
        Ok(Ok(infos)) => infos,
        Ok(Err(_)) => Vec::new(),
        Err(_) => {
            return Err(format!(
                "Redis database list timed out ({}s): the server did not answer INFO keyspace",
                timeout.as_secs()
            ))
        }
    };
    let database_count = configured_count.unwrap_or(DEFAULT_REDIS_DATABASES);
    let max_db = keyspace_db_infos.iter().map(|db| db.db).max().map(|db| db + 1).unwrap_or(0);
    let visible_count = database_count.max(max_db).max(1);
    let keyspace_counts =
        keyspace_db_infos.into_iter().map(|db| (db.db, db.keys)).collect::<std::collections::HashMap<_, _>>();

    Ok((0..visible_count)
        .map(|db| RedisDatabaseInfo { db, keys: keyspace_counts.get(&db).copied().flatten() })
        .collect())
}

fn parse_database_count(value: redis::Value) -> Option<u32> {
    let values = match value {
        redis::Value::Array(values) => values,
        _ => return None,
    };

    values.windows(2).find_map(|pair| {
        let key = String::from_redis_value(pair[0].clone()).ok()?;
        if key.eq_ignore_ascii_case("databases") {
            String::from_redis_value(pair[1].clone()).ok()?.parse().ok()
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

    // kvrocks 的键数是异步统计出来的（官方文档：需要先执行 `DBSIZE SCAN` 才会更新
    // DBSIZE 与 INFO keyspace），未统计前它会把 dbN 的 keys 全部报成 0，并在 keyspace
    // 段里带上 `last_dbsize_scan_timestamp:0`。识别到这个标记时不把 0 当成真实数量，
    // 避免侧边栏显示 "db0 (0)" 这类误导信息。
    let keyspace_counts_are_stale = info.lines().any(|line| {
        line.split_once(':').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("last_dbsize_scan_timestamp") && value.trim() == "0"
        })
    });

    let mut dbs = Vec::new();
    for line in info.lines() {
        if line.starts_with("db") {
            if let Some((db_part, stats_part)) = line.split_once(':') {
                if let Some(num) = db_part.strip_prefix("db") {
                    if let Ok(db) = num.parse::<u32>() {
                        let keys = if keyspace_counts_are_stale {
                            None
                        } else {
                            stats_part
                                .split(',')
                                .find_map(|part| part.strip_prefix("keys=").and_then(|value| value.parse::<u64>().ok()))
                        };
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

pub async fn execute_console_command<C>(
    con: &mut C,
    db: u32,
    command_text: &str,
    skip_safety_check: bool,
) -> Result<RedisCommandResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let selection: redis::RedisResult<()> = redis::cmd("SELECT").arg(db).query_async(con).await;
    if let Err(error) = selection {
        if !is_unavailable_db_zero_select(&error, db) {
            return Err(error.to_string());
        }
    }
    execute_command(con, command_text, skip_safety_check).await
}

fn is_unavailable_db_zero_select(error: &redis::RedisError, db: u32) -> bool {
    if db != 0 || error.kind() != redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError) {
        return false;
    }
    let detail = error.detail().unwrap_or_default().trim_start();
    let prefix_len = "unknown command".len();
    detail.get(..prefix_len).is_some_and(|prefix| prefix.eq_ignore_ascii_case("unknown command"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClusterDatabaseCapability {
    Known(u32),
    Unsupported,
    Unknown(String),
}

fn parse_cluster_database_capability(raw: RedisRawValue) -> Result<ClusterDatabaseCapability, String> {
    let entries = match raw {
        RedisRawValue::Array(entries) if entries.is_empty() => return Ok(ClusterDatabaseCapability::Unsupported),
        RedisRawValue::Map(entries) if entries.is_empty() => return Ok(ClusterDatabaseCapability::Unsupported),
        RedisRawValue::Array(entries) if entries.len() == 2 => entries,
        RedisRawValue::Map(mut entries) if entries.len() == 1 => {
            let (key, value) = entries.remove(0);
            vec![key, value]
        }
        _ => return Err("Malformed CONFIG GET cluster-databases response".to_string()),
    };
    if cluster_config_text(&entries[0]) != Some("cluster-databases") {
        return Err("Unexpected CONFIG GET cluster-databases setting".to_string());
    }
    let count = cluster_config_text(&entries[1])
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|count| *count > 0 && *count <= i32::MAX as u32)
        .ok_or("Invalid cluster-databases count: expected an integer from 1 through 2147483647")?;
    Ok(ClusterDatabaseCapability::Known(count))
}

fn cluster_config_text(value: &RedisRawValue) -> Option<&str> {
    // CONFIG GET returns string keys and values, not generic numeric RESP values.
    match value {
        RedisRawValue::BulkString(bytes) => std::str::from_utf8(bytes).ok(),
        RedisRawValue::SimpleString(text) => Some(text),
        _ => None,
    }
}

fn combine_cluster_database_capabilities(
    capabilities: Vec<ClusterDatabaseCapability>,
) -> Result<ClusterDatabaseCapability, String> {
    let mut known = None;
    let mut unsupported = false;
    let mut unknown = Vec::new();
    for capability in capabilities {
        match capability {
            ClusterDatabaseCapability::Known(count) => {
                if known.is_some_and(|previous| previous != count) || unsupported {
                    return Err("Conflicting cluster-databases settings across cluster masters".to_string());
                }
                known = Some(count);
            }
            ClusterDatabaseCapability::Unsupported => {
                if known.is_some() {
                    return Err("Conflicting cluster-databases support across cluster masters".to_string());
                }
                unsupported = true;
            }
            ClusterDatabaseCapability::Unknown(reason) => unknown.push(reason),
        }
    }
    if !unknown.is_empty() {
        return Ok(ClusterDatabaseCapability::Unknown(unknown.join("; ")));
    }
    if let Some(count) = known {
        Ok(ClusterDatabaseCapability::Known(count))
    } else if unsupported {
        Ok(ClusterDatabaseCapability::Unsupported)
    } else {
        Err("Redis cluster has no masters for database discovery".to_string())
    }
}

async fn discover_cluster_database_capability(pool: &RedisClusterPool) -> Result<ClusterDatabaseCapability, String> {
    // An explicit metadata refresh invalidates stale success even if it fails.
    *pool.database_capability.lock().await = None;
    let mut capabilities = Vec::new();
    for endpoint in cluster_master_nodes(pool).await? {
        let mut con = connect_cluster_node(pool, &endpoint).await?;
        let capability = match redis::cmd("CONFIG").arg("GET").arg("cluster-databases").query_async(&mut con).await {
            Ok(raw) => parse_cluster_database_capability(raw)?,
            Err(error) if is_redis_command_denied_error(&error.to_string()) => {
                ClusterDatabaseCapability::Unknown(format!("{}:{}: {error}", endpoint.host, endpoint.port))
            }
            Err(error) => {
                return Err(format!("Database discovery on {}:{} failed: {error}", endpoint.host, endpoint.port))
            }
        };
        capabilities.push(capability);
    }
    let capability = combine_cluster_database_capabilities(capabilities)?;
    *pool.database_capability.lock().await = Some(capability.clone());
    Ok(capability)
}

pub async fn cluster_database_diagnostic(pool: &RedisClusterPool) -> Option<String> {
    match &*pool.database_capability.lock().await {
        Some(ClusterDatabaseCapability::Unknown(reason)) => Some(reason.clone()),
        _ => None,
    }
}

pub async fn ensure_cluster_database(pool: &RedisClusterPool, db: u32) -> Result<(), String> {
    // Permission-limited discovery must never make the existing db0 connection unusable.
    if db == 0 {
        return Ok(());
    }
    let cached = pool.database_capability.lock().await.clone();
    let capability = match cached {
        Some(capability @ ClusterDatabaseCapability::Known(_)) => capability,
        _ => discover_cluster_database_capability(pool).await?,
    };
    match capability {
        ClusterDatabaseCapability::Known(count) if db < count => Ok(()),
        ClusterDatabaseCapability::Known(count) => Err(format!("Database db{db} is outside this cluster's configured range db0–db{}; refresh the database list", count - 1)),
        ClusterDatabaseCapability::Unsupported => Err("This cluster does not expose multiple databases; use db0".to_string()),
        ClusterDatabaseCapability::Unknown(reason) => Err(format!("Cannot verify db{db}: {reason}. Allow CONFIG GET cluster-databases on all masters and refresh the database list; db0 remains available")),
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
    let capability = discover_cluster_database_capability(pool).await?;
    let count = cluster_database_list_count(&capability)?;
    let master_nodes = cluster_master_nodes(pool).await?;
    let key_counts = cluster_database_key_counts(pool, &master_nodes).await.ok();
    Ok((0..count)
        .map(|db| RedisDatabaseInfo {
            db,
            keys: key_counts.as_ref().map(|counts| counts.get(&db).copied().unwrap_or(0)),
        })
        .collect())
}

fn cluster_database_list_count(capability: &ClusterDatabaseCapability) -> Result<u32, String> {
    let count = match *capability {
        ClusterDatabaseCapability::Known(count) => count,
        _ => 1,
    };
    if count > MAX_CLUSTER_DATABASE_LIST_ENTRIES {
        return Err(format!("This cluster is configured with {count} databases, exceeding the DBX database-list safety limit of {MAX_CLUSTER_DATABASE_LIST_ENTRIES}; no truncated list was returned"));
    }
    Ok(count)
}

fn parse_cluster_keyspace_counts(info: &str) -> Result<HashMap<u32, u64>, String> {
    if !info.lines().any(|line| line.trim() == "# Keyspace") {
        return Err("Missing INFO keyspace section".to_string());
    }
    let mut counts = HashMap::new();
    for line in info.lines().map(str::trim).filter(|line| line.starts_with("db")) {
        let (database, stats) = line.split_once(':').ok_or("Malformed INFO keyspace entry")?;
        let db = database[2..].parse::<u32>().map_err(|_| "Invalid INFO keyspace database")?;
        let keys = stats
            .split(',')
            .find_map(|stat| stat.strip_prefix("keys="))
            .and_then(|keys| keys.parse::<u64>().ok())
            .ok_or("Invalid INFO keyspace key count")?;
        if counts.insert(db, keys).is_some() {
            return Err("Duplicate INFO keyspace database".to_string());
        }
    }
    Ok(counts)
}

async fn cluster_database_key_counts(
    pool: &RedisClusterPool,
    masters: &[RedisNodeEndpoint],
) -> Result<HashMap<u32, u64>, String> {
    let mut totals: HashMap<u32, u64> = HashMap::new();
    for endpoint in masters {
        let mut con = connect_cluster_node(pool, endpoint).await?;
        let info: String =
            redis::cmd("INFO").arg("keyspace").query_async(&mut con).await.map_err(|error| error.to_string())?;
        for (db, keys) in parse_cluster_keyspace_counts(&info)? {
            let total = totals.entry(db).or_default();
            *total = total.checked_add(keys).ok_or("Cluster key count overflow")?;
        }
    }
    Ok(totals)
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
    scan_cluster_keys_batch(pool, cursor, pattern, count, 1, include_types).await
}

pub async fn scan_cluster_keys_batch(
    pool: &RedisClusterPool,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
) -> Result<RedisScanResult, String> {
    scan_cluster_keys_batch_in_db(pool, 0, cursor, pattern, count, max_iterations, include_types).await
}

pub async fn scan_cluster_keys_batch_in_db(
    pool: &RedisClusterPool,
    db: u32,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
) -> Result<RedisScanResult, String> {
    ensure_cluster_database(pool, db).await?;
    scan_cluster_keys_batch_in_db_with(
        &pool.scan_sessions,
        || async { cluster_master_nodes(pool).await },
        |endpoint| async move { connect_cluster_node_in_db(pool, &endpoint, db).await },
        db,
        cursor,
        pattern,
        count,
        max_iterations,
        include_types,
    )
    .await
}

#[cfg(test)]
async fn scan_cluster_keys_batch_with<C, Discover, DiscoverFuture, Connect, ConnectFuture>(
    sessions: &Mutex<RedisClusterScanSessions>,
    discover_master_nodes: Discover,
    connect_node: Connect,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
    Discover: FnMut() -> DiscoverFuture,
    DiscoverFuture: Future<Output = Result<Vec<RedisNodeEndpoint>, String>>,
    Connect: FnMut(RedisNodeEndpoint) -> ConnectFuture,
    ConnectFuture: Future<Output = Result<C, String>>,
{
    scan_cluster_keys_batch_in_db_with(
        sessions,
        discover_master_nodes,
        connect_node,
        0,
        cursor,
        pattern,
        count,
        max_iterations,
        include_types,
    )
    .await
}

async fn scan_cluster_keys_batch_in_db_with<C, Discover, DiscoverFuture, Connect, ConnectFuture>(
    sessions: &Mutex<RedisClusterScanSessions>,
    mut discover_master_nodes: Discover,
    connect_node: Connect,
    db: u32,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
    Discover: FnMut() -> DiscoverFuture,
    DiscoverFuture: Future<Output = Result<Vec<RedisNodeEndpoint>, String>>,
    Connect: FnMut(RedisNodeEndpoint) -> ConnectFuture,
    ConnectFuture: Future<Output = Result<C, String>>,
{
    let (mut session, can_continue) = if cursor == 0 {
        let master_nodes = canonical_cluster_master_nodes(discover_master_nodes().await?);
        if master_nodes.is_empty() {
            return Ok(RedisScanResult { cursor: 0, keys: Vec::new(), total_keys: 0 });
        }
        let mut session = RedisClusterKeyScanSession::new(master_nodes, pattern);
        session.db = db;
        (session, false)
    } else {
        let mut store = sessions.lock().await;
        store.remove_expired();
        let session = store.entries.get(&cursor).ok_or(INVALID_CLUSTER_SCAN_CURSOR_ERROR)?;
        if session.pattern != pattern || session.db != db || session.value_filter.is_some() {
            return Err(INVALID_CLUSTER_SCAN_CURSOR_ERROR.to_string());
        }
        (store.take(cursor).ok_or(INVALID_CLUSTER_SCAN_CURSOR_ERROR)?, true)
    };
    let include_total_keys = !can_continue;
    let retry_session = can_continue.then(|| session.clone());

    let batch = match scan_cluster_keys_batch_on_session(
        &mut session,
        connect_node,
        pattern,
        count,
        max_iterations,
        include_types,
        include_total_keys,
    )
    .await
    {
        Ok(batch) => batch,
        Err(error) => {
            if let Some(retry_session) = retry_session {
                // A failed batch may have advanced across nodes without returning its keys, so retries must resume
                // from the request's original position rather than the partially mutated session.
                sessions.lock().await.insert(Some(cursor), retry_session);
            }
            return Err(error);
        }
    };

    if batch.complete {
        return Ok(RedisScanResult { cursor: 0, keys: batch.keys, total_keys: batch.total_keys });
    }

    let session_cursor = sessions.lock().await.insert(can_continue.then_some(cursor), session);
    Ok(RedisScanResult { cursor: session_cursor, keys: batch.keys, total_keys: batch.total_keys })
}

struct RedisClusterKeyScanBatch {
    keys: Vec<RedisKeyInfo>,
    total_keys: u64,
    complete: bool,
}

async fn scan_cluster_keys_batch_on_session<C, Connect, ConnectFuture>(
    session: &mut RedisClusterKeyScanSession,
    mut connect_node: Connect,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
    include_total_keys: bool,
) -> Result<RedisClusterKeyScanBatch, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
    Connect: FnMut(RedisNodeEndpoint) -> ConnectFuture,
    ConnectFuture: Future<Output = Result<C, String>>,
{
    if session.master_nodes.is_empty() || session.is_complete() {
        return Ok(RedisClusterKeyScanBatch { keys: Vec::new(), total_keys: 0, complete: true });
    }

    let mut connections: Vec<Option<C>> = std::iter::repeat_with(|| None).take(session.master_nodes.len()).collect();
    let mut total_keys = 0;
    if include_total_keys {
        for (index, endpoint) in session.master_nodes.iter().cloned().enumerate() {
            let Ok(mut connection) = connect_node(endpoint).await else {
                continue;
            };
            total_keys += redis::cmd("DBSIZE").query_async::<u64>(&mut connection).await.unwrap_or(0);
            connections[index] = Some(connection);
        }
    }

    let iterations = max_iterations.max(1);
    let target_keys = count.max(1);
    let mut all_keys = Vec::new();

    for _ in 0..iterations {
        let Some(node_index) = session.next_unfinished_node_index() else {
            return Ok(RedisClusterKeyScanBatch { keys: all_keys, total_keys, complete: true });
        };
        if connections[node_index].is_none() {
            connections[node_index] = Some(connect_node(session.master_nodes[node_index].clone()).await?);
        }
        let connection = connections[node_index].as_mut().ok_or("Redis cluster node connection unavailable")?;
        let page = scan_keys_batch_inner(
            connection,
            session.node_cursors[node_index],
            pattern,
            count,
            1,
            include_types,
            false,
        )
        .await?;
        all_keys.extend(page.keys);

        session.node_cursors[node_index] = page.cursor;
        session.node_complete[node_index] = page.cursor == 0;
        session.advance_after(node_index);
        let complete = session.is_complete();

        if complete || all_keys.len() >= target_keys {
            return Ok(RedisClusterKeyScanBatch { keys: all_keys, total_keys, complete });
        }
    }

    Ok(RedisClusterKeyScanBatch { keys: all_keys, total_keys, complete: false })
}

fn canonical_cluster_master_nodes(mut master_nodes: Vec<RedisNodeEndpoint>) -> Vec<RedisNodeEndpoint> {
    master_nodes.sort_unstable_by(|left, right| left.host.cmp(&right.host).then(left.port.cmp(&right.port)));
    master_nodes.dedup();
    master_nodes
}

pub async fn scan_cluster_values_page(
    pool: &RedisClusterPool,
    cursor: u64,
    pattern: &str,
    query: &str,
    include_key_matches: bool,
    count: usize,
) -> Result<RedisScanResult, String> {
    scan_cluster_values_page_in_db(pool, 0, cursor, pattern, query, include_key_matches, count).await
}

pub async fn scan_cluster_values_page_in_db(
    pool: &RedisClusterPool,
    db: u32,
    cursor: u64,
    pattern: &str,
    query: &str,
    include_key_matches: bool,
    count: usize,
) -> Result<RedisScanResult, String> {
    ensure_cluster_database(pool, db).await?;
    scan_cluster_values_page_with(
        &pool.scan_sessions,
        || async { cluster_master_nodes(pool).await },
        |endpoint| async move { connect_cluster_node_in_db(pool, &endpoint, db).await },
        db,
        cursor,
        pattern,
        query,
        include_key_matches,
        count,
    )
    .await
}

async fn scan_cluster_values_page_with<C, Discover, DiscoverFuture, Connect, ConnectFuture>(
    sessions: &Mutex<RedisClusterScanSessions>,
    mut discover: Discover,
    mut connect: Connect,
    db: u32,
    cursor: u64,
    pattern: &str,
    query: &str,
    include_key_matches: bool,
    count: usize,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
    Discover: FnMut() -> DiscoverFuture,
    DiscoverFuture: Future<Output = Result<Vec<RedisNodeEndpoint>, String>>,
    Connect: FnMut(RedisNodeEndpoint) -> ConnectFuture,
    ConnectFuture: Future<Output = Result<C, String>>,
{
    let filter = Some((query.to_string(), include_key_matches));
    let mut session = if cursor == 0 {
        let mut session = RedisClusterKeyScanSession::new(canonical_cluster_master_nodes(discover().await?), pattern);
        session.db = db;
        session.value_filter = filter.clone();
        session
    } else {
        let mut store = sessions.lock().await;
        store.remove_expired();
        let session = store.entries.get(&cursor).ok_or(INVALID_CLUSTER_SCAN_CURSOR_ERROR)?;
        if session.db != db || session.pattern != pattern || session.value_filter != filter {
            return Err(INVALID_CLUSTER_SCAN_CURSOR_ERROR.to_string());
        }
        store.take(cursor).ok_or(INVALID_CLUSTER_SCAN_CURSOR_ERROR)?
    };
    let retry = session.clone();
    let result = async {
        let mut connections: Vec<Option<C>> =
            std::iter::repeat_with(|| None).take(session.master_nodes.len()).collect();
        if cursor == 0 {
            for (index, endpoint) in session.master_nodes.iter().cloned().enumerate() {
                // Counts are best-effort metadata, not a prerequisite for value search.
                if let Ok(mut con) = connect(endpoint).await {
                    let keys = redis::cmd("DBSIZE").query_async::<u64>(&mut con).await.unwrap_or(0);
                    session.total_keys += keys;
                    connections[index] = Some(con);
                }
            }
        }
        let mut keys = Vec::new();
        while let Some(index) = session.next_unfinished_node_index() {
            if connections[index].is_none() {
                connections[index] = Some(connect(session.master_nodes[index].clone()).await?);
            }
            let con = connections[index].as_mut().ok_or("Redis cluster node connection unavailable")?;
            let page = scan_values_page_inner(
                con,
                session.node_cursors[index],
                pattern,
                query,
                include_key_matches,
                count,
                false,
            )
            .await?;
            session.node_cursors[index] = page.cursor;
            session.node_complete[index] = page.cursor == 0;
            session.advance_after(index);
            keys.extend(page.keys);
            if !keys.is_empty() || page.cursor != 0 {
                break;
            }
        }
        Ok::<_, String>((keys, session.total_keys))
    }
    .await;
    match result {
        Ok((keys, total_keys)) => {
            let cursor = if session.is_complete() {
                0
            } else {
                sessions.lock().await.insert((cursor != 0).then_some(cursor), session)
            };
            Ok(RedisScanResult { cursor, keys, total_keys })
        }
        Err(error) => {
            if cursor != 0 {
                sessions.lock().await.insert(Some(cursor), retry);
            }
            Err(error)
        }
    }
}

pub async fn cluster_master_nodes(pool: &RedisClusterPool) -> Result<Vec<RedisNodeEndpoint>, String> {
    if !pool.seed_routes.is_empty() {
        return cluster_slot_ranges_from_routes(
            &pool.seed_routes,
            pool.tls,
            pool.tls_insecure,
            pool.tls_certificates.as_deref(),
            &pool.username,
            &pool.password,
        )
        .await
        .map(|slot_ranges| unique_master_nodes(&slot_ranges));
    }
    cluster_slot_ranges_from_seeds(
        &pool.seed_nodes,
        pool.tls,
        pool.tls_insecure,
        pool.tls_certificates.as_deref(),
        &pool.username,
        &pool.password,
    )
    .await
    .map(|slot_ranges| unique_master_nodes(&slot_ranges))
}

pub async fn flush_cluster(pool: &RedisClusterPool) -> Result<(), String> {
    flush_cluster_in_db(pool, 0).await
}

pub async fn flush_cluster_in_db(pool: &RedisClusterPool, db: u32) -> Result<(), String> {
    ensure_cluster_database(pool, db).await?;
    let master_nodes = cluster_master_nodes(pool).await?;
    for endpoint in master_nodes {
        let mut con = connect_cluster_node_in_db(pool, &endpoint, db).await?;
        flush_db(&mut con).await?;
    }
    Ok(())
}

async fn cluster_slot_ranges_from_seeds(
    seed_nodes: &[RedisNodeEndpoint],
    tls: bool,
    insecure: bool,
    certificates: Option<&redis::TlsCertificates>,
    username: &str,
    password: &str,
) -> Result<Vec<RedisClusterSlotRange>, String> {
    let seed_routes = identity_routes(seed_nodes);
    cluster_slot_ranges_from_routes(&seed_routes, tls, insecure, certificates, username, password).await
}

async fn cluster_slot_ranges_from_routes(
    seed_routes: &[RedisNodeRoute],
    tls: bool,
    insecure: bool,
    certificates: Option<&redis::TlsCertificates>,
    username: &str,
    password: &str,
) -> Result<Vec<RedisClusterSlotRange>, String> {
    let mut last_error = None;
    for route in seed_routes {
        let mut con = match connect_direct_node(&route.connect, tls, insecure, certificates, username, password).await {
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
    cluster_any_connection_in_db(pool, 0).await
}

async fn native_cluster_database_connection(pool: &RedisClusterPool, db: u32) -> Result<ClusterConnection, String> {
    let entry = pool.database_connections.lock().await.entry(db).or_default().clone();
    let mut connection = entry.lock().await;
    if let Some(connection) = &*connection {
        return Ok(connection.clone());
    }
    let nodes = pool
        .seed_nodes
        .iter()
        .map(|endpoint| {
            connection_info(
                &endpoint.host,
                endpoint.port,
                pool.tls,
                pool.tls_insecure,
                &pool.username,
                &pool.password,
                i64::from(db),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut builder = ClusterClient::builder(nodes).database_id(i64::from(db));
    if let Some(certificates) = &pool.tls_certificates {
        builder = builder.certs((**certificates).clone());
    }
    let client = builder.build().map_err(|error| error.to_string())?;
    let initialized = tokio::time::timeout(connection_timeout(), client.get_async_connection())
        .await
        .map_err(|_| format!("Redis cluster db{db} connection timed out"))?
        .map_err(|error| format!("Redis cluster db{db} connection failed: {error}"))?;
    *connection = Some(initialized.clone());
    Ok(initialized)
}

pub async fn cluster_any_connection_in_db(
    pool: &RedisClusterPool,
    db: u32,
) -> Result<RedisClusterConnectionGuard<'_>, String> {
    ensure_cluster_database(pool, db).await?;
    if let Some(connection) = &pool.connection {
        if db != 0 {
            return native_cluster_database_connection(pool, db).await.map(RedisClusterConnectionGuard::Database);
        }
        return Ok(RedisClusterConnectionGuard::Native(connection.lock().await));
    }
    let endpoint = pool
        .node_routes
        .first()
        .or_else(|| pool.seed_routes.first())
        .map(|route| &route.advertised)
        .ok_or_else(|| "Redis cluster has no routable nodes".to_string())?;
    connect_cluster_node_in_db(pool, endpoint, db).await.map(RedisClusterConnectionGuard::Direct)
}

pub async fn cluster_key_connection<'a>(
    pool: &'a RedisClusterPool,
    key: &[u8],
) -> Result<RedisClusterConnectionGuard<'a>, String> {
    cluster_key_connection_in_db(pool, key, 0).await
}

pub async fn cluster_key_connection_in_db<'a>(
    pool: &'a RedisClusterPool,
    key: &[u8],
    db: u32,
) -> Result<RedisClusterConnectionGuard<'a>, String> {
    ensure_cluster_database(pool, db).await?;
    if let Some(connection) = &pool.connection {
        if db != 0 {
            return native_cluster_database_connection(pool, db).await.map(RedisClusterConnectionGuard::Database);
        }
        return Ok(RedisClusterConnectionGuard::Native(connection.lock().await));
    }
    let endpoint = cluster_master_for_key(pool, key)?;
    connect_cluster_node_in_db(pool, &endpoint, db).await.map(RedisClusterConnectionGuard::Direct)
}

pub async fn connect_cluster_node(
    pool: &RedisClusterPool,
    advertised_endpoint: &RedisNodeEndpoint,
) -> Result<redis::aio::MultiplexedConnection, String> {
    connect_cluster_node_in_db(pool, advertised_endpoint, 0).await
}

pub async fn connect_cluster_node_in_db(
    pool: &RedisClusterPool,
    advertised_endpoint: &RedisNodeEndpoint,
    db: u32,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = build_redis_client(
        cluster_node_connection_info(pool, advertised_endpoint, db)?,
        pool.tls_certificates.as_deref(),
    )?;
    connect_client(client).await
}

fn cluster_node_connection_info(
    pool: &RedisClusterPool,
    advertised_endpoint: &RedisNodeEndpoint,
    db: u32,
) -> Result<ConnectionInfo, String> {
    let connect_endpoint = mapped_cluster_endpoint(pool, advertised_endpoint);
    connection_info(
        &connect_endpoint.host,
        connect_endpoint.port,
        pool.tls,
        pool.tls_insecure,
        &pool.username,
        &pool.password,
        i64::from(db),
    )
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
    let mut token_started = false;

    while let Some(ch) = chars.next() {
        if escaping {
            token_started = true;
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
            token_started = true;
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
            token_started = true;
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if token_started {
                argv.push(std::mem::take(&mut current));
            }
            token_started = false;
            while matches!(chars.peek(), Some(next) if next.is_whitespace()) {
                chars.next();
            }
            continue;
        }

        token_started = true;
        current.push(ch);
    }

    if escaping {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("Redis command has an unterminated quote".to_string());
    }
    if token_started {
        argv.push(current);
    }
    if argv.first().is_none_or(String::is_empty) {
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
        | "HPTTL"
        | "HTTL"
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
        | "HDEL" | "HEXPIRE" | "HEXPIREAT" | "HPEXPIRE" | "HPEXPIREAT" | "HPERSIST" | "JSON.ARRPOP"
        | "JSON.ARRTRIM" | "JSON.CLEAR" | "JSON.DEL" | "JSON.FORGET" | "BLMOVE" | "BLMPOP" | "BLPOP" | "BRPOP"
        | "BRPOPLPUSH" | "LPOP" | "LMOVE" | "LMPOP" | "RPOP" | "RPOPLPUSH" | "LREM" | "LTRIM" | "SPOP" | "SREM"
        | "ZREM" | "ZPOPMAX" | "ZPOPMIN" | "ZMPOP" | "BZMPOP" | "BZPOPMAX" | "BZPOPMIN" | "ZREMRANGEBYLEX"
        | "ZREMRANGEBYRANK" | "ZREMRANGEBYSCORE" | "XDEL" | "XTRIM" | "MOVE" | "SORT" | "SDIFFSTORE"
        | "SINTERSTORE" | "SUNIONSTORE" | "ZDIFFSTORE" | "ZINTERSTORE" | "ZRANGESTORE" | "ZUNIONSTORE" | "PFMERGE"
        | "GEOSEARCHSTORE" => RedisCommandSafety::Confirm,
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
        RedisRawValue::Int(value) => safe_i64_to_json(value),
        RedisRawValue::Double(value) => {
            serde_json::Number::from_f64(value).map_or(serde_json::Value::Null, serde_json::Value::Number)
        }
        RedisRawValue::Boolean(value) => serde_json::Value::Bool(value),
        RedisRawValue::VerbatimString { text, .. } => {
            serde_json::Value::String(redis_bytes_to_display(text.as_bytes()))
        }
        RedisRawValue::BigNumber(value) => serde_json::Value::String(value.to_string()),
        RedisRawValue::ServerError(error) => serde_json::Value::String(format!("{error:?}")),
        value => serde_json::Value::String(format!("{value:?}")),
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
        RedisRawValue::Int(i) => u64::try_from(*i).ok(),
        RedisRawValue::BulkString(bytes) => std::str::from_utf8(bytes).ok().and_then(|s| s.parse().ok()),
        RedisRawValue::SimpleString(value) => value.parse().ok(),
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
    if command == "MONITOR" {
        return Err(
            "MONITOR requires a dedicated streaming connection; run MONITOR alone in the query editor".to_string()
        );
    }
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
/// Performs up to `max_iterations` SCAN cycles in a single call. TYPE and TTL
/// metadata is optional so large key-name searches can avoid extra Redis work.
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
    scan_keys_batch_inner(con, cursor, pattern, count, max_iterations, include_types, true).await
}

async fn scan_keys_batch_inner<C>(
    con: &mut C,
    cursor: u64,
    pattern: &str,
    count: usize,
    max_iterations: usize,
    include_types: bool,
    include_total_keys: bool,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let iterations = max_iterations.max(1);
    let total_keys: u64 =
        if include_total_keys && cursor == 0 { redis::cmd("DBSIZE").query_async(con).await.unwrap_or(0) } else { 0 };

    let is_exact_match = !pattern.contains('*') && !pattern.contains('?') && !pattern.contains('[');
    if cursor == 0 && is_exact_match && !pattern.is_empty() {
        match redis::cmd("EXISTS").arg(pattern).query_async::<bool>(con).await {
            Ok(true) => {
                let key_type: String = if include_types {
                    redis::cmd("TYPE").arg(pattern).query_async(con).await.unwrap_or_else(|_| "unknown".to_string())
                } else {
                    String::new()
                };
                // 精确命中单个 key 时顺带查询一次 TTL（O(1) 命令），
                // 让前端列表行无需再点开 key 就能看到过期信息。
                let key_ttl: i64 = if include_types {
                    redis::cmd("TTL").arg(pattern).query_async(con).await.unwrap_or(-2)
                } else {
                    -2
                };

                let value_preview = if include_types { redis_key_value_preview(&key_type) } else { String::new() };

                let key_info = RedisKeyInfo {
                    key_display: redis_key_bytes_to_display(pattern.as_bytes()),
                    key_raw: redis_key_bytes_to_raw(pattern.as_bytes()),
                    key_type,
                    ttl: key_ttl,
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
            let (key_types, key_ttls): (Vec<String>, Vec<i64>) = if include_types {
                let mut type_pipe = redis::pipe();
                for key in &keys {
                    type_pipe.cmd("TYPE").arg(key);
                }
                let type_count = type_pipe.len();
                let type_values = con.req_packed_commands(&type_pipe, 0, type_count).await.unwrap_or_default();
                let key_types = type_values
                    .iter()
                    .map(|value| String::from_redis_value(value.clone()).unwrap_or_else(|_| "unknown".to_string()))
                    .collect();

                let mut ttl_pipe = redis::pipe();
                for key in &keys {
                    ttl_pipe.cmd("TTL").arg(key);
                }
                let ttl_count = ttl_pipe.len();
                let ttl_values = con.req_packed_commands(&ttl_pipe, 0, ttl_count).await.unwrap_or_default();
                let key_ttls = ttl_values.into_iter().map(|value| i64::from_redis_value(value).unwrap_or(-2)).collect();
                (key_types, key_ttls)
            } else {
                (Vec::new(), Vec::new())
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
                    ttl: key_ttls.get(index).copied().unwrap_or(-2),
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
    scan_values_page_inner(con, cursor, pattern, query, include_key_matches, count, true).await
}

async fn scan_values_page_inner<C>(
    con: &mut C,
    cursor: u64,
    pattern: &str,
    query: &str,
    include_key_matches: bool,
    count: usize,
    include_total_keys: bool,
) -> Result<RedisScanResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    // Only call DBSIZE on the first page (cursor == 0) to avoid redundant work.
    let total_keys: u64 =
        if include_total_keys && cursor == 0 { redis::cmd("DBSIZE").query_async(con).await.unwrap_or(0) } else { 0 };
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
    get_value_scoped(con, key, &RedisOperationScope::default()).await
}

pub async fn get_value_scoped<C>(con: &mut C, key: &[u8], scope: &RedisOperationScope) -> Result<RedisValue, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    get_value_scoped_with_preview_limit(con, key, scope, STRING_PREVIEW_MAX_BYTES).await
}

pub async fn get_value_scoped_with_preview_limit<C>(
    con: &mut C,
    key: &[u8],
    scope: &RedisOperationScope,
    preview_limit_bytes: usize,
) -> Result<RedisValue, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    validate_value_preview_limit(preview_limit_bytes)?;
    let redis_type: String = redis::cmd("TYPE").arg(key).query_async(con).await.map_err(|e| e.to_string())?;

    // For Streams, fetch metadata and the initial page together after TYPE.
    // This keeps the accurate XLEN without adding another Redis round trip.
    let stream_initial_page =
        if redis_type == "stream" { Some(get_stream_initial_page(con, key).await?) } else { None };
    let ttl: i64 = match stream_initial_page.as_ref() {
        Some((ttl, _, _)) => *ttl,
        None => redis::cmd("TTL").arg(key).query_async(con).await.unwrap_or(-1),
    };

    let data = match redis_type.as_str() {
        "string" => {
            // GETRANGE in spans no larger than `STRING_PREVIEW_MAX_BYTES`: some
            // Redis-compatible servers (e.g. TongRDS) reject a larger span, so a
            // configured preview above the default budget is fetched in chunks
            // (issue #11792). Filling the budget exactly means the value may
            // continue — STRLEN settles that without materializing the rest in
            // the backend or IPC layer.
            let mut bytes: Vec<u8> = Vec::new();
            let mut at_budget = false;
            while bytes.len() < preview_limit_bytes {
                let span = (preview_limit_bytes - bytes.len()).min(STRING_PREVIEW_MAX_BYTES);
                let start = bytes.len() as i64;
                let chunk: RedisRawValue = redis::cmd("GETRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(start + span as i64 - 1)
                    .query_async(con)
                    .await
                    .map_err(|e| e.to_string())?;
                let chunk = redis_value_to_bytes(chunk)
                    .ok_or_else(|| "Redis string payload is not byte-addressable".to_string())?;
                let chunk_len = chunk.len();
                bytes.extend_from_slice(&chunk);
                if chunk_len < span {
                    break;
                }
                if bytes.len() >= preview_limit_bytes {
                    at_budget = true;
                    break;
                }
            }
            let total_bytes = if at_budget {
                redis::cmd("STRLEN").arg(key).query_async(con).await.ok()
            } else {
                Some(bytes.len() as u64)
            };
            let truncated = total_bytes.map_or(at_budget, |total| total > preview_limit_bytes as u64);
            if truncated {
                bytes.truncate(preview_limit_bytes);
            }
            RedisValueData::String { content: redis_blob_from_bytes(&bytes), total_bytes, truncated }
        }
        "list" => {
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(con).await.unwrap_or(0);
            let end = (COLLECTION_PAGE_SIZE as i64) - 1;
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(0).arg(end).query_async(con).await.map_err(|e| e.to_string())?;
            let mut items = redis_list_items_from_raw(v, 0);
            items.truncate(budgeted_page_len(&items, COLLECTION_PAGE_SIZE, list_item_page_bytes));
            let next = items.len() as u64;
            RedisValueData::List { items, total: len, scan_cursor: (next < len).then_some(next) }
        }
        "set" => {
            let len: u64 = redis::cmd("SCARD").arg(key).query_async(con).await.unwrap_or(0);
            let (cursor, items) = sscan_bounded_page(con, scope, key, 0, COLLECTION_PAGE_SIZE, None).await?;
            RedisValueData::Set { items, total: len, scan_cursor: (cursor > 0).then_some(cursor) }
        }
        "zset" => {
            let len: u64 = redis::cmd("ZCARD").arg(key).query_async(con).await.unwrap_or(0);
            let end = (COLLECTION_PAGE_SIZE as i64) - 1;
            let mut items = zrange_page_raw(con, key, 0, end, false).await?;
            items.truncate(budgeted_page_len(&items, COLLECTION_PAGE_SIZE, zset_item_page_bytes));
            let next = items.len() as u64;
            RedisValueData::Zset { items, total: len, scan_cursor: (next < len).then_some(next) }
        }
        "hash" => {
            let len: u64 = redis::cmd("HLEN").arg(key).query_async(con).await.unwrap_or(0);
            let (cursor, mut items) = hscan_bounded_page(con, scope, key, 0, COLLECTION_PAGE_SIZE, None).await?;
            attach_hash_field_ttls(con, key, &mut items).await?;
            RedisValueData::Hash { items, total: len, scan_cursor: (cursor > 0).then_some(cursor) }
        }
        "stream" => {
            let (_, total, page) = stream_initial_page.expect("Stream page is loaded with its Stream type");
            RedisValueData::Stream { entries: page.entries, total, next_cursor: page.next_cursor }
        }
        key_type if is_redis_json_type(key_type) => {
            let raw: RedisRawValue =
                redis::cmd("JSON.GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            RedisValueData::Json { value: redis_json_raw_to_text(raw)? }
        }
        // kvrocks 的位图/HLL 是独立类型，标准 Redis 类型表里没有它们；不处理就会落到
        // Unknown，界面上表现为“能看到 Key、看不到值”（issue #10406）。
        "bitmap" => {
            // kvrocks 对位图类型只开放 GET（GETRANGE/STRLEN 会报 WRONGTYPE），
            // 且 GET 返回的字节与 Redis 位序一致，可直接按字符串预览。
            let raw: RedisRawValue = redis::cmd("GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
            let mut bytes = redis_value_to_bytes(raw).unwrap_or_default();
            let truncated = bytes.len() > preview_limit_bytes;
            if truncated {
                bytes.truncate(preview_limit_bytes);
            }
            // 截断后拿不到准确长度（kvrocks 位图没有可用的 STRLEN），置空交给前端按未知处理
            let total_bytes = (!truncated).then_some(bytes.len() as u64);
            let set_bits: Option<u64> = redis::cmd("BITCOUNT").arg(key).query_async(con).await.ok();
            RedisValueData::Bitmap { content: redis_blob_from_bytes(&bytes), total_bytes, truncated, set_bits }
        }
        "hyperloglog" => {
            // HLL 原始字节不可读，基数估计是唯一可展示的数据
            let count: Option<u64> = redis::cmd("PFCOUNT").arg(key).query_async(con).await.ok();
            RedisValueData::HyperLogLog { count }
        }
        _ => RedisValueData::Unknown { redis_type: redis_type.clone() },
    };

    Ok(RedisValue {
        key_display: redis_key_bytes_to_display(key),
        key_raw: redis_key_bytes_to_raw(key),
        redis_type,
        ttl,
        data,
    })
}

/// Read the complete raw payload for a Redis string-like key.
///
/// The normal value path caps previews at the configured size. Downloads must
/// bypass that cap while preserving the exact bytes, including non-UTF-8 data.
pub async fn get_raw_value<C>(con: &mut C, key: &[u8]) -> Result<RedisBlob, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let redis_type: String = redis::cmd("TYPE").arg(key).query_async(con).await.map_err(|e| e.to_string())?;
    let raw: RedisRawValue = match redis_type.as_str() {
        "string" | "bitmap" => redis::cmd("GET").arg(key).query_async(con).await.map_err(|e| e.to_string())?,
        "none" => return Err("Redis key does not exist".to_string()),
        _ => return Err("Only Redis string values can be downloaded".to_string()),
    };
    let bytes = redis_value_to_bytes(raw).ok_or_else(|| "Redis value is not byte-addressable".to_string())?;
    Ok(redis_blob_from_bytes(&bytes))
}

/// Read only a key's TTL without loading its value or collection members.
///
/// Redis returns `-2` for a missing key and `-1` for a key without an expiry;
/// callers preserve those sentinel values so the UI can update its detail view
/// without an additional round trip.
pub async fn get_ttl<C>(con: &mut C, key: &[u8]) -> Result<i64, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("TTL").arg(key).query_async(con).await.map_err(|e| e.to_string())
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
        RedisValueData::String { content, .. } => redis_blob_display_text(content),
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
        RedisValueData::Stream { entries, .. } => entries
            .iter()
            .flat_map(|entry| {
                entry.fields.iter().flat_map(|field| [field.field.clone(), field.value.clone()]).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
            .join(" "),
        RedisValueData::Bitmap { content, .. } => redis_blob_display_text(content),
        RedisValueData::HyperLogLog { count } => count.map(|value| value.to_string()).unwrap_or_default(),
        RedisValueData::Unknown { .. } => String::new(),
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
        RedisValueData::String { content, total_bytes, .. } => total_bytes.unwrap_or_else(|| {
            base64::engine::general_purpose::STANDARD
                .decode(&content.raw_base64)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(0)
        }),
        RedisValueData::Json { value } => value.len() as u64,
        RedisValueData::List { total, .. }
        | RedisValueData::Set { total, .. }
        | RedisValueData::Hash { total, .. }
        | RedisValueData::Zset { total, .. } => *total,
        RedisValueData::Stream { entries, total, .. } => total.unwrap_or(entries.len() as u64),
        RedisValueData::Bitmap { content, total_bytes, .. } => total_bytes.unwrap_or_else(|| {
            base64::engine::general_purpose::STANDARD
                .decode(&content.raw_base64)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(0)
        }),
        RedisValueData::HyperLogLog { .. } => 0,
        RedisValueData::Unknown { .. } => 0,
    }
}

pub async fn get_stream_entries_page<C>(
    con: &mut C,
    key: &[u8],
    cursor: Option<&str>,
) -> Result<RedisStreamPage, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let cursor = cursor.filter(|value| !value.is_empty());
    let start = cursor.unwrap_or("-");
    // XRANGE starts inclusively. Fetch a duplicate candidate and a lookahead
    // row so this works with Redis 5 and does not skip records after trimming.
    let requested_count = stream_entry_page_request_count(cursor);
    let raw: RedisRawValue = redis::cmd("XRANGE")
        .arg(key)
        .arg(start)
        .arg("+")
        .arg("COUNT")
        .arg(requested_count)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    Ok(stream_entries_page_from_raw(raw, cursor))
}

async fn get_stream_initial_page<C>(con: &mut C, key: &[u8]) -> Result<(i64, Option<u64>, RedisStreamPage), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut pipe = redis::pipe();
    pipe.cmd("TTL").arg(key);
    pipe.cmd("XLEN").arg(key);
    pipe.cmd("XRANGE").arg(key).arg("-").arg("+").arg("COUNT").arg(stream_entry_page_request_count(None));
    match pipe.query_async::<(i64, u64, RedisRawValue)>(con).await {
        Ok((ttl, total, raw)) => Ok((ttl, Some(total), stream_entries_page_from_raw(raw, None))),
        Err(_) => {
            // An ACL may allow XRANGE while rejecting the optional XLEN
            // metadata. Keep the Stream readable and omit the unknown size.
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(con).await.unwrap_or(-1);
            let total = redis::cmd("XLEN").arg(key).query_async::<u64>(con).await.ok();
            let page = get_stream_entries_page(con, key, None).await?;
            Ok((ttl, total, page))
        }
    }
}

fn stream_entry_page_request_count(cursor: Option<&str>) -> usize {
    STREAM_ENTRY_PAGE_SIZE + 1 + usize::from(cursor.is_some())
}

fn stream_entries_page_from_raw(raw: RedisRawValue, cursor: Option<&str>) -> RedisStreamPage {
    let mut entries = parse_stream_entries(raw);
    if let Some(cursor) = cursor {
        if entries.first().is_some_and(|entry| entry.id == cursor) {
            entries.remove(0);
        }
    }
    let next_cursor = if entries.len() > STREAM_ENTRY_PAGE_SIZE {
        entries.truncate(STREAM_ENTRY_PAGE_SIZE);
        entries.last().map(|entry| entry.id.clone())
    } else {
        None
    };

    RedisStreamPage { entries, next_cursor }
}

pub async fn get_stream_groups<C>(con: &mut C, key: &[u8]) -> Result<Vec<RedisStreamGroup>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let raw: RedisRawValue =
        redis::cmd("XINFO").arg("GROUPS").arg(key).query_async(con).await.map_err(|e| e.to_string())?;

    Ok(parse_stream_groups(raw))
}

pub async fn get_stream_consumers<C>(con: &mut C, key: &[u8], group: &[u8]) -> Result<Vec<RedisStreamConsumer>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let raw: RedisRawValue =
        redis::cmd("XINFO").arg("CONSUMERS").arg(key).arg(group).query_async(con).await.map_err(|e| e.to_string())?;

    Ok(parse_stream_consumers(raw))
}

pub async fn get_stream_pending_page<C>(
    con: &mut C,
    key: &[u8],
    group: &[u8],
    cursor: Option<&str>,
    consumer: Option<&[u8]>,
) -> Result<RedisStreamPendingPage, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let cursor = cursor.filter(|value| !value.is_empty());
    let start = cursor.unwrap_or("-");
    // Redis before 6.2 has no exclusive XPENDING ranges. A cursor page needs
    // a duplicate candidate and a lookahead row to page without skipping IDs.
    let requested_count = STREAM_PENDING_PAGE_SIZE + 1 + usize::from(cursor.is_some());
    let mut command = redis::cmd("XPENDING");
    command.arg(key).arg(group).arg(start).arg("+").arg(requested_count);
    if let Some(consumer) = consumer {
        command.arg(consumer);
    }
    let raw: RedisRawValue = command.query_async(con).await.map_err(|e| e.to_string())?;

    let mut entries = parse_stream_pending_entries(raw);
    if let Some(cursor) = cursor {
        if entries.first().is_some_and(|entry| entry.id == cursor) {
            entries.remove(0);
        }
    }
    let next_cursor = if entries.len() > STREAM_PENDING_PAGE_SIZE {
        entries.truncate(STREAM_PENDING_PAGE_SIZE);
        entries.last().map(|entry| entry.id.clone())
    } else {
        None
    };

    Ok(RedisStreamPendingPage { entries, next_cursor })
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

fn parse_stream_groups(raw: RedisRawValue) -> Vec<RedisStreamGroup> {
    match raw {
        RedisRawValue::Array(groups) => groups.into_iter().filter_map(parse_stream_group).collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_group(group: RedisRawValue) -> Option<RedisStreamGroup> {
    let mut attributes = parse_stream_info_attributes(group)?;
    Some(RedisStreamGroup {
        name: redis_value_to_blob(attributes.remove("name")?)?,
        consumers: redis_value_to_u64(&attributes.remove("consumers")?)?,
        pending: redis_value_to_u64(&attributes.remove("pending")?)?,
        last_delivered_id: redis_value_to_string(attributes.remove("last-delivered-id")?)?,
        entries_read: attributes.remove("entries-read").and_then(|value| redis_value_to_u64(&value)),
        lag: attributes.remove("lag").and_then(|value| redis_value_to_u64(&value)),
    })
}

fn parse_stream_consumers(raw: RedisRawValue) -> Vec<RedisStreamConsumer> {
    match raw {
        RedisRawValue::Array(consumers) => consumers.into_iter().filter_map(parse_stream_consumer).collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_consumer(consumer: RedisRawValue) -> Option<RedisStreamConsumer> {
    let mut attributes = parse_stream_info_attributes(consumer)?;
    Some(RedisStreamConsumer {
        name: redis_value_to_blob(attributes.remove("name")?)?,
        pending: redis_value_to_u64(&attributes.remove("pending")?)?,
        idle_ms: redis_value_to_u64(&attributes.remove("idle")?)?,
        inactive_ms: attributes.remove("inactive").and_then(|value| redis_value_to_u64(&value)),
    })
}

fn parse_stream_pending_entries(raw: RedisRawValue) -> Vec<RedisStreamPendingEntry> {
    match raw {
        RedisRawValue::Array(entries) => entries.into_iter().filter_map(parse_stream_pending_entry).collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_pending_entry(entry: RedisRawValue) -> Option<RedisStreamPendingEntry> {
    let mut parts = match entry {
        RedisRawValue::Array(parts) if parts.len() == 4 => parts.into_iter(),
        _ => return None,
    };

    Some(RedisStreamPendingEntry {
        id: redis_value_to_string(parts.next()?)?,
        consumer: redis_value_to_blob(parts.next()?)?,
        idle_ms: redis_value_to_u64(&parts.next()?)?,
        deliveries: redis_value_to_u64(&parts.next()?)?,
    })
}

fn parse_stream_info_attributes(raw: RedisRawValue) -> Option<HashMap<String, RedisRawValue>> {
    let RedisRawValue::Array(parts) = raw else {
        return None;
    };

    let mut attributes = HashMap::new();
    let mut parts = parts.into_iter();
    while let Some(name) = parts.next() {
        let value = parts.next()?;
        attributes.insert(redis_value_to_string(name)?, value);
    }
    Some(attributes)
}

fn redis_value_to_blob(value: RedisRawValue) -> Option<RedisBlob> {
    redis_value_to_bytes(value).map(|bytes| redis_blob_from_bytes(&bytes))
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
    if error.kind() != redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError) {
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

/// Rename a key without overwriting an existing destination.
pub async fn rename_key<C>(con: &mut C, key: &[u8], new_key: &[u8]) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let renamed =
        redis::cmd("RENAMENX").arg(key).arg(new_key).query_async::<bool>(con).await.map_err(|e| e.to_string())?;
    if renamed {
        Ok(())
    } else {
        Err("Target key already exists".to_string())
    }
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
    let previous_field_ttl = if ttl.is_none() { read_hash_field_ttl(con, key, field.as_bytes()).await? } else { None };
    redis::cmd("HSET").arg(key).arg(field).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
    if let Some(previous_ttl) = previous_field_ttl.filter(|ttl| *ttl > 0) {
        let remaining_ttl = previous_ttl.max(1);
        set_hash_field_ttl(con, key, field, remaining_ttl).await?;
    }
    apply_expire_if_needed(con, key, ttl).await
}

pub async fn hash_del<C>(con: &mut C, key: &[u8], field: &str) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd("HDEL").arg(key).arg(field).query_async::<()>(con).await.map_err(|e| e.to_string())
}

/// Atomically update a hash field, optionally moving it to a new name.
///
/// The operation is intentionally implemented as one Lua script rather than
/// as an HSET/HDEL pair.  That keeps destination collision checks and the
/// source deletion in the same server-side critical section.  Hash-field
/// expiry commands were introduced after hashes themselves, so the script
/// probes them with `pcall` and preserves expiry when the server supports
/// HTTL/HEXPIRE while remaining usable on older Redis versions.  Some Redis
/// cluster implementations reject the whole script before Lua can probe those
/// commands, so this also retries with an equivalent script that never
/// references field-expiry commands.  Permission errors are surfaced instead
/// of being mistaken for an unsupported command, since silently dropping a
/// field TTL would be data loss.
pub async fn hash_field_update<C>(
    con: &mut C,
    key: &[u8],
    old_field: &str,
    new_field: &str,
    value: &str,
) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    const SCRIPT_WITH_FIELD_TTL: &str = r#"
        local key = KEYS[1]
        local old_field = ARGV[1]
        local new_field = ARGV[2]
        local value = ARGV[3]

        -- Keep enough source state to undo a destination write if a later
        -- command fails.  EVAL itself is atomic, but Redis does not roll back
        -- writes made before a Lua runtime error.
        if redis.call('HEXISTS', key, old_field) == 0 then
            return 0
        end
        local old_value = redis.call('HGET', key, old_field)
        if old_value == false then
            return 0
        end
        if old_field ~= new_field and redis.call('HEXISTS', key, new_field) == 1 then
            return -1
        end

        if old_field ~= new_field then
            -- The collision check established that new_field is absent. Probe
            -- HDEL before writing so a restricted HDEL permission cannot
            -- leave both fields behind after the later source delete.
            local delete_probe = redis.pcall('HDEL', key, new_field)
            if type(delete_probe) == 'table' and delete_probe.err ~= nil then
                return -3
            end
        end

        local function optional_expiry_error(reply)
            if type(reply) ~= 'table' or reply.err == nil then
                return false
            end
            local detail = string.lower(reply.err)
            -- Redis < 7.4 reports an HTTL/HEXPIRE pcall as "Unknown Redis
            -- command called from [Lua] script", not the top-level "unknown
            -- command" wording. Permission and WRONGTYPE errors use different
            -- wording and must still fail.
            return string.find(detail, 'unknown command', 1, true) ~= nil
                or string.find(detail, 'unknown redis command', 1, true) ~= nil
                or string.find(detail, 'syntax error', 1, true) ~= nil
                or string.find(detail, 'unsupported', 1, true) ~= nil
        end

        -- HTTL returns an array containing -1 (persistent), -2 (missing), or
        -- the remaining seconds.  Unsupported commands are deliberately
        -- ignored so Redis versions without hash-field expiry still work.
        local source_ttl = -2
        local ttl_reply = redis.pcall('HTTL', key, 'FIELDS', 1, old_field)
        if type(ttl_reply) == 'table' and ttl_reply.err ~= nil then
            local detail = string.lower(ttl_reply.err)
            if not optional_expiry_error(ttl_reply)
                and detail ~= 'invalid argument: hash field expiration is not supported by legacy hash encoding'
                and detail ~= 'err invalid argument: hash field expiration is not supported by legacy hash encoding' then
                return -3
            end
        elseif type(ttl_reply) == 'table' and ttl_reply[1] ~= nil then
            source_ttl = tonumber(ttl_reply[1])
            if source_ttl == nil or source_ttl < -2 then
                return -3
            end
            -- The source can expire between the initial HGET and HTTL. Do
            -- not create a new field when the probe already says it is gone.
            if source_ttl == -2 then
                return 0
            end
            -- HTTL rounds down to seconds. HEXPIRE 0 deletes a field, so an
            -- imminent expiry must abort before HSET rather than losing data.
            if source_ttl == 0 then
                return -3
            end
        end

        local function restore_source()
            local restored = redis.pcall('HSET', key, old_field, old_value)
            if type(restored) == 'table' and restored.err ~= nil then
                return false
            end
            if source_ttl > 0 then
                local expiry = redis.pcall('HEXPIRE', key, source_ttl, 'FIELDS', 1, old_field)
                if type(expiry) == 'table' and expiry.err ~= nil and not optional_expiry_error(expiry) then
                    return false
                end
            end
            return true
        end

        local function apply_source_expiry(field)
            if source_ttl < 0 then
                return true
            end
            local expiry = redis.pcall('HEXPIRE', key, source_ttl, 'FIELDS', 1, field)
            if type(expiry) == 'table' and expiry.err ~= nil then
                -- A missing command is expected on Redis versions before
                -- hash-field expiry.  Other errors must fail safely.
                return optional_expiry_error(expiry)
            end
            return type(expiry) == 'table' and tonumber(expiry[1]) == 1
        end

        local written = redis.pcall('HSET', key, new_field, value)
        if type(written) == 'table' and written.err ~= nil then
            return -3
        end

        if not apply_source_expiry(new_field) then
            if old_field == new_field then
                restore_source()
            else
                redis.pcall('HDEL', key, new_field)
            end
            return -3
        end

        if old_field == new_field then
            return 1
        end

        local deleted = redis.pcall('HDEL', key, old_field)
        if type(deleted) == 'table' and deleted.err ~= nil then
            redis.pcall('HDEL', key, new_field)
            return -3
        end
        if tonumber(deleted) ~= 1 then
            redis.pcall('HDEL', key, new_field)
            return 0
        end
        return 2
    "#;

    const SCRIPT_WITHOUT_FIELD_TTL: &str = r#"
        local key = KEYS[1]
        local old_field = ARGV[1]
        local new_field = ARGV[2]
        local value = ARGV[3]

        if redis.call('HEXISTS', key, old_field) == 0 then
            return 0
        end
        if redis.call('HGET', key, old_field) == false then
            return 0
        end
        if old_field ~= new_field and redis.call('HEXISTS', key, new_field) == 1 then
            return -1
        end

        if old_field ~= new_field then
            local delete_probe = redis.pcall('HDEL', key, new_field)
            if type(delete_probe) == 'table' and delete_probe.err ~= nil then
                return -3
            end
        end

        local written = redis.pcall('HSET', key, new_field, value)
        if type(written) == 'table' and written.err ~= nil then
            return -3
        end

        if old_field == new_field then
            return 1
        end

        local deleted = redis.pcall('HDEL', key, old_field)
        if type(deleted) == 'table' and deleted.err ~= nil then
            redis.pcall('HDEL', key, new_field)
            return -3
        end
        if tonumber(deleted) ~= 1 then
            redis.pcall('HDEL', key, new_field)
            return 0
        end
        return 2
    "#;

    let error =
        match execute_hash_field_update_script(con, SCRIPT_WITH_FIELD_TTL, key, old_field, new_field, value).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };

    if !is_hash_field_update_cluster_script_rejection(&error) {
        return Err(error);
    }

    execute_hash_field_update_script(con, SCRIPT_WITHOUT_FIELD_TTL, key, old_field, new_field, value).await
}

async fn execute_hash_field_update_script<C>(
    con: &mut C,
    script: &str,
    key: &[u8],
    old_field: &str,
    new_field: &str,
    value: &str,
) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let result = redis::cmd("EVAL")
        .arg(script)
        .arg(1)
        .arg(key)
        .arg(old_field)
        .arg(new_field)
        .arg(value)
        .query_async::<i64>(con)
        .await;

    let result = match result {
        Ok(result) => result,
        Err(error) if is_hash_field_update_acl_compatibility_error(&error) => {
            return Err(
                "Atomic Redis hash field updates require the Redis EVAL and hash command permissions. Ask an administrator to grant them."
                    .to_string(),
            );
        }
        Err(error) => return Err(error.to_string()),
    };

    match result {
        1 | 2 => Ok(()),
        0 => Err("The Redis hash field no longer exists. Refresh and try again.".to_string()),
        -1 => Err("A Redis hash field with the new name already exists.".to_string()),
        -3 => Err("Redis hash field update failed before completion.".to_string()),
        _ => Err("Unexpected result while updating Redis hash field.".to_string()),
    }
}

fn is_hash_field_update_acl_compatibility_error(error: &redis::RedisError) -> bool {
    if error.code() != Some("NOPERM") {
        return false;
    }

    let detail = error.detail().unwrap_or_default().to_ascii_lowercase();
    detail.contains("eval")
        || detail.contains("hexists")
        || detail.contains("hget")
        || detail.contains("hset")
        || detail.contains("hdel")
        || detail.contains("httl")
        || detail.contains("hexpire")
}

fn is_hash_field_update_cluster_script_rejection(error: &str) -> bool {
    let detail = error.to_ascii_lowercase();
    detail.contains("bad lua script for redis cluster") && (detail.contains("httl") || detail.contains("hexpire"))
}

/// Which end of a Redis list to push to. `Right` (RPUSH) is the historical
/// default; `Left` (LPUSH) lets users prepend when using lists as queues.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListPushSide {
    Left,
    Right,
}

impl ListPushSide {
    pub fn from_str_lossy(value: Option<&str>) -> Self {
        match value.map(str::to_ascii_lowercase).as_deref() {
            Some("left") => ListPushSide::Left,
            _ => ListPushSide::Right,
        }
    }

    fn command(self) -> &'static str {
        match self {
            ListPushSide::Left => "LPUSH",
            ListPushSide::Right => "RPUSH",
        }
    }
}

pub async fn list_push<C>(
    con: &mut C,
    key: &[u8],
    value: &str,
    ttl: Option<i64>,
    side: ListPushSide,
) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    redis::cmd(side.command()).arg(key).arg(value).query_async::<()>(con).await.map_err(|e| e.to_string())?;
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

pub async fn zset_update<C>(
    con: &mut C,
    key: &[u8],
    original_member: &str,
    expected_score: &str,
    member: &str,
    score: &str,
) -> Result<bool, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    // Keep the source check, duplicate check, score write, and optional rename
    // in one Redis operation so a failed save cannot delete the original member.
    const SCRIPT: &str = r#"
        local current_score = redis.call('ZSCORE', KEYS[1], ARGV[1])
        if current_score == false then
            return 0
        end
        if current_score ~= ARGV[3] then
            return -2
        end
        if ARGV[1] ~= ARGV[2] and redis.call('ZSCORE', KEYS[1], ARGV[2]) ~= false then
            return -1
        end
        redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
        if ARGV[1] ~= ARGV[2] then
            redis.call('ZREM', KEYS[1], ARGV[1])
        end
        return 1
    "#;

    let result = redis::cmd("EVAL")
        .arg(SCRIPT)
        .arg(1)
        .arg(key)
        .arg(original_member)
        .arg(member)
        .arg(expected_score)
        .arg(score)
        .query_async::<i64>(con)
        .await;

    let result = match result {
        Ok(result) => result,
        Err(error) if is_zset_update_acl_compatibility_error(&error) => {
            return Err(
                "Atomic ZSet updates require the Redis EVAL and ZSCORE permissions. Ask an administrator to grant them."
                    .to_string(),
            );
        }
        Err(error) => return Err(error.to_string()),
    };

    match result {
        1 => Ok(false),
        0 => Err("The ZSet member no longer exists. Refresh and try again.".to_string()),
        -1 => Err("A ZSet member with the new value already exists.".to_string()),
        -2 => Err("The ZSet score changed after it was loaded. Refresh and try again.".to_string()),
        _ => Err("Unexpected result while updating ZSet member.".to_string()),
    }
}

fn is_zset_update_acl_compatibility_error(error: &redis::RedisError) -> bool {
    if error.code() != Some("NOPERM") {
        return false;
    }

    let detail = error.detail().unwrap_or_default().to_ascii_lowercase();
    detail.contains("eval") || detail.contains("zscore")
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
        let applied =
            redis::cmd("EXPIRE").arg(key).arg(ttl).query_async::<i64>(con).await.map_err(|e| e.to_string())?;
        if applied == 1 {
            Ok(())
        } else {
            Err("Redis key no longer exists; EXPIRE was not applied".to_string())
        }
    } else {
        // Redis treats PERSIST as idempotent: a zero reply also means the key
        // was already persistent. Follow-up reads in the UI handle a key that
        // disappeared concurrently without requiring an extra ACL permission.
        redis::cmd("PERSIST").arg(key).query_async::<()>(con).await.map_err(|e| e.to_string())
    }
}

pub async fn set_expire_at<C>(con: &mut C, key: &[u8], expire_at: i64) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let applied =
        redis::cmd("EXPIREAT").arg(key).arg(expire_at).query_async::<i64>(con).await.map_err(|e| e.to_string())?;
    if applied == 1 {
        Ok(())
    } else {
        Err("Redis key no longer exists; EXPIREAT was not applied".to_string())
    }
}

/// Applies one expiration command per selected key in a single bounded round trip.
///
/// Keys the caller already selected may disappear concurrently, so this reports
/// them instead of failing the whole batch. `PERSIST` stays idempotent: Redis
/// answers 0 both for a missing key and for a key that is already persistent.
pub async fn set_keys_expiry<C>(
    con: &mut C,
    keys: &[Vec<u8>],
    expiry: RedisKeysExpiry,
) -> Result<RedisKeysExpiryResult, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    if keys.is_empty() {
        return Ok(RedisKeysExpiryResult::default());
    }

    let mut pipeline = Pipeline::with_capacity(keys.len());
    for key in keys {
        match expiry {
            RedisKeysExpiry::Persist => {
                pipeline.cmd("PERSIST").arg(key.as_slice());
            }
            RedisKeysExpiry::Ttl(ttl) => {
                pipeline.cmd("EXPIRE").arg(key.as_slice()).arg(ttl);
            }
            RedisKeysExpiry::At(expire_at) => {
                pipeline.cmd("EXPIREAT").arg(key.as_slice()).arg(expire_at);
            }
        }
    }

    let replies: Vec<RedisRawValue> = pipeline.query_async(con).await.map_err(|error| error.to_string())?;
    summarize_keys_expiry(keys, expiry, &replies)
}

fn summarize_keys_expiry(
    keys: &[Vec<u8>],
    expiry: RedisKeysExpiry,
    replies: &[RedisRawValue],
) -> Result<RedisKeysExpiryResult, String> {
    let mut result = RedisKeysExpiryResult::default();
    for (index, key) in keys.iter().enumerate() {
        let applied = match expiry {
            // Redis answers 0 for an already-persistent key as well, so PERSIST
            // must not be reported as a missing key.
            RedisKeysExpiry::Persist => true,
            _ => match replies.get(index) {
                Some(RedisRawValue::Int(reply)) => *reply == 1,
                // A server error or a short reply must not be silently counted
                // as a per-key miss, or the batch would report a false success.
                _ => return Err(format!("{} did not return one reply per selected key", expiry.command())),
            },
        };
        if applied {
            result.applied += 1;
        } else {
            result.missing_key_raws.push(redis_key_bytes_to_raw(key));
        }
    }
    Ok(result)
}

pub async fn set_hash_field_ttl<C>(con: &mut C, key: &[u8], field: &str, ttl: i64) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    if ttl <= 0 {
        let raw: RedisRawValue = redis::cmd("HPERSIST")
            .arg(key)
            .arg("FIELDS")
            .arg(1)
            .arg(field)
            .query_async(con)
            .await
            .map_err(|e| e.to_string())?;
        return parse_hash_field_expiry_result(raw, "HPERSIST", true);
    }

    let raw: RedisRawValue = redis::cmd("HEXPIRE")
        .arg(key)
        .arg(ttl)
        .arg("FIELDS")
        .arg(1)
        .arg(field)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;
    parse_hash_field_expiry_result(raw, "HEXPIRE", false)
}

pub async fn set_hash_field_expire_at<C>(con: &mut C, key: &[u8], field: &str, expire_at: i64) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let raw: RedisRawValue = redis::cmd("HEXPIREAT")
        .arg(key)
        .arg(expire_at)
        .arg("FIELDS")
        .arg(1)
        .arg(field)
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;
    parse_hash_field_expiry_result(raw, "HEXPIREAT", false)
}

fn parse_hash_field_expiry_result(raw: RedisRawValue, command: &str, allow_persist_noop: bool) -> Result<(), String> {
    let RedisRawValue::Array(mut values) = raw else {
        return Err(format!("Invalid {command} response"));
    };
    let Some(result) = values.pop().and_then(redis_value_to_string).and_then(|value| value.parse::<i64>().ok()) else {
        return Err(format!("Invalid {command} response"));
    };
    match result {
        1 => Ok(()),
        -1 if allow_persist_noop => Ok(()),
        2 => Err(format!("{command} removed the hash field because it was already expired")),
        -2 => Err("Redis hash field no longer exists".to_string()),
        _ => Err(format!("{command} was not applied to the hash field")),
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

/// `SCAN COUNT` hint used by [`delete_keys_by_pattern`]; large enough to keep
/// the cycle count low, small enough that one cycle stays cheap on the server.
pub const DELETE_KEYS_BY_PATTERN_SCAN_COUNT: usize = 500;
/// Upper bound on the keys carried by a single `DEL` command.
const DELETE_KEYS_BY_PATTERN_DELETE_BATCH: usize = 512;

/// Deletes every key matching `pattern` with repeated `SCAN` + `DEL` cycles.
///
/// A group in the key browser is a key *prefix*: the loaded rows are only the
/// part of that subtree the browser has scanned so far, so deleting just those
/// rows leaves the rest of the subtree behind. `KEYS` or one oversized `DEL`
/// would block the server for a large subtree, so keys are discovered with one
/// `SCAN` cycle at a time and deleted in bounded batches.
pub async fn delete_keys_by_pattern<C>(con: &mut C, pattern: &str, scan_count: usize) -> Result<u64, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let count = scan_count.max(1);
    let mut cursor = 0u64;
    let mut deleted = 0u64;
    loop {
        let page = scan_keys_batch_inner(con, cursor, pattern, count, 1, false, false).await?;
        let keys: Result<Vec<Vec<u8>>, String> =
            page.keys.iter().map(|key| redis_key_raw_to_bytes(&key.key_raw)).collect();
        for batch in keys?.chunks(DELETE_KEYS_BY_PATTERN_DELETE_BATCH) {
            deleted += delete_keys(con, batch).await?;
        }
        cursor = page.cursor;
        if cursor == 0 {
            return Ok(deleted);
        }
    }
}

pub async fn load_more_collection<C>(
    con: &mut C,
    key: &[u8],
    key_type: &str,
    cursor: u64,
    count: usize,
    filter_query: Option<&str>,
    sort_direction: Option<&str>,
) -> Result<RedisCollectionPage, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    load_more_collection_scoped(
        con,
        key,
        key_type,
        cursor,
        count,
        filter_query,
        sort_direction,
        &RedisOperationScope::default(),
    )
    .await
}

pub async fn load_more_collection_scoped<C>(
    con: &mut C,
    key: &[u8],
    key_type: &str,
    cursor: u64,
    count: usize,
    filter_query: Option<&str>,
    sort_direction: Option<&str>,
    scope: &RedisOperationScope,
) -> Result<RedisCollectionPage, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    if cursor >= COLLECTION_OVERFLOW_CURSOR_START && !matches!(key_type, "hash" | "set") {
        return Err("Collection cursor belongs to a different collection type".to_string());
    }
    let filter_query = filter_query.filter(|query| !query.is_empty());
    match key_type {
        "list" => {
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(con).await.unwrap_or(0);
            if let Some(query) = filter_query {
                let (items, next) = lrange_filtered_page_raw(con, key, cursor, count, len, query).await?;
                return Ok(RedisCollectionPage::List { items, scan_cursor: (next < len).then_some(next) });
            }
            let start = cursor as i64;
            let end = start + count as i64 - 1;
            let v: RedisRawValue =
                redis::cmd("LRANGE").arg(key).arg(start).arg(end).query_async(con).await.map_err(|e| e.to_string())?;
            let mut items = redis_list_items_from_raw(v, cursor);
            items.truncate(budgeted_page_len(&items, count, list_item_page_bytes));
            let next = cursor + items.len() as u64;
            Ok(RedisCollectionPage::List { items, scan_cursor: (next < len).then_some(next) })
        }
        "set" => {
            let (next_cursor, items) = if let Some(query) = filter_query {
                sscan_bounded_page(con, scope, key, cursor, count, Some(query)).await?
            } else {
                sscan_bounded_page(con, scope, key, cursor, count, None).await?
            };
            Ok(RedisCollectionPage::Set { items, scan_cursor: (next_cursor > 0).then_some(next_cursor) })
        }
        "zset" => {
            let descending = match sort_direction.unwrap_or("asc") {
                "asc" => false,
                "desc" => true,
                direction => return Err(format!("Invalid ZSet sort direction: {direction}")),
            };
            if let Some(query) = filter_query {
                let (items, next, has_more) =
                    zrange_filtered_page_raw(con, key, cursor, count, descending, query).await?;
                return Ok(RedisCollectionPage::Zset { items, scan_cursor: has_more.then_some(next) });
            }
            let start = cursor as i64;
            let end = start + count as i64;
            let mut items = zrange_page_raw(con, key, start, end, descending).await?;
            // `zrange_page_raw` reads one extra member to detect a further page; the byte budget
            // can also end the page before `count`, which likewise leaves members behind.
            let has_more = items.len() > count;
            let page_len = budgeted_page_len(&items, count, zset_item_page_bytes);
            let ended_early = page_len < items.len().min(count);
            items.truncate(page_len);
            let next = cursor + items.len() as u64;
            Ok(RedisCollectionPage::Zset { items, scan_cursor: (has_more || ended_early).then_some(next) })
        }
        "hash" => {
            let (next_cursor, mut items) = if let Some(query) = filter_query {
                hscan_bounded_page(con, scope, key, cursor, count, Some(query)).await?
            } else {
                hscan_bounded_page(con, scope, key, cursor, count, None).await?
            };
            attach_hash_field_ttls(con, key, &mut items).await?;
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
    lowered_query: Option<&str>,
) -> Result<(u64, Vec<RedisHashItem>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cmd = redis::cmd("HSCAN");
    cmd.arg(key).arg(cursor).arg("COUNT").arg(count);
    let raw: RedisRawValue = cmd.query_async(con).await.map_err(|e| e.to_string())?;
    parse_scan_hash_entries(raw, lowered_query)
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
    let lowered = query.to_lowercase();

    // A full field name should not have to wait for its hash-table scan bucket.
    // Still scan one batch to obtain a real continuation for the fuzzy search.
    if cursor == 0 {
        let exact: Option<Vec<u8>> = match redis::cmd("HGET").arg(key).arg(query.as_bytes()).query_async(con).await {
            Ok(value) => value,
            Err(error) if is_redis_command_denied_error(&error.to_string()) => None,
            Err(error) => return Err(error.to_string()),
        };
        if let Some(value) = exact {
            items.push(RedisHashItem {
                field: redis_blob_from_bytes(query.as_bytes()),
                value: redis_blob_from_bytes(&value),
                field_ttl: None,
            });
        }
    }
    let exact_match = !items.is_empty();
    let mut positions: HashMap<String, usize> =
        items.iter().enumerate().map(|(index, item)| (item.field.raw_base64.clone(), index)).collect();
    for _ in 0..COLLECTION_FILTER_SCAN_MAX_ITERATIONS {
        let (next, page) = hscan_page_raw(con, key, cur, target, Some(&lowered)).await?;
        for item in page {
            if let Some(&index) = positions.get(&item.field.raw_base64) {
                items[index] = item;
            } else {
                positions.insert(item.field.raw_base64.clone(), items.len());
                items.push(item);
            }
        }
        cur = next;
        // HSCAN MATCH only checks field names, so value search has to filter returned pairs client-side.
        // Keep a hard scan bound so sparse value matches cannot turn one UI search into a full hash walk.
        if exact_match || cur == 0 || items.len() >= target {
            break;
        }
    }

    Ok((cur, items))
}

async fn sscan_filtered_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
    query: &str,
) -> Result<(u64, Vec<RedisSetItem>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cur = cursor;
    let mut items = Vec::new();
    let target = count.max(1);
    let lowered = query.to_lowercase();

    for _ in 0..COLLECTION_FILTER_SCAN_MAX_ITERATIONS {
        let (next, page) = sscan_page_raw(con, key, cur, target).await?;
        items.extend(page.into_iter().filter(|item| blob_matches_query(&item.member, &lowered)));
        cur = next;
        // SSCAN MATCH uses glob syntax over the raw member bytes, so substring search filters
        // returned members client-side. Keep the same hard scan bound the hash filter uses.
        if cur == 0 || items.len() >= target {
            break;
        }
    }

    Ok((cur, items))
}

/// Scans ZRANGE/ZREVRANGE pages so score ordering and the index-based cursor survive filtering.
async fn zrange_filtered_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
    descending: bool,
    query: &str,
) -> Result<(Vec<RedisZsetItem>, u64, bool), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cur = cursor;
    let mut items = Vec::new();
    let target = count.max(1);
    let lowered = query.to_lowercase();
    let mut has_more = false;

    for _ in 0..COLLECTION_FILTER_SCAN_MAX_ITERATIONS {
        let start = cur as i64;
        // Overshoot by one so a full page tells us more members remain past this window.
        let mut page = zrange_page_raw(con, key, start, start + target as i64, descending).await?;
        has_more = page.len() > target;
        page.truncate(target);
        let scanned = page.len();
        items.extend(page.into_iter().filter(|item| blob_matches_query(&item.member, &lowered)));
        cur += scanned as u64;
        if !has_more || items.len() >= target {
            break;
        }
    }

    Ok((items, cur, has_more))
}

/// Walks LRANGE windows and filters each one after indices are assigned, so the surviving
/// items keep their real list positions (the UI deletes list entries by index).
async fn lrange_filtered_page_raw<C>(
    con: &mut C,
    key: &[u8],
    cursor: u64,
    count: usize,
    len: u64,
    query: &str,
) -> Result<(Vec<RedisListItem>, u64), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let mut cur = cursor;
    let mut items = Vec::new();
    let target = count.max(1);
    let lowered = query.to_lowercase();

    for _ in 0..COLLECTION_FILTER_SCAN_MAX_ITERATIONS {
        // LLEN is only a bound here: it falls back to 0 when the command is unavailable,
        // and an empty LRANGE window is what actually proves the walk is done.
        if len > 0 && cur >= len {
            break;
        }
        let start = cur as i64;
        let raw: RedisRawValue = redis::cmd("LRANGE")
            .arg(key)
            .arg(start)
            .arg(start + target as i64 - 1)
            .query_async(con)
            .await
            .map_err(|e| e.to_string())?;
        let page = redis_list_items_from_raw(raw, cur);
        let scanned = page.len();
        items.extend(page.into_iter().filter(|item| blob_matches_query(&item.value, &lowered)));
        if scanned == 0 {
            cur = len;
            break;
        }
        cur += scanned as u64;
        if items.len() >= target {
            break;
        }
    }

    Ok((items, cur))
}

async fn hscan_bounded_page<C>(
    con: &mut C,
    scope: &RedisOperationScope,
    key: &[u8],
    cursor: u64,
    count: usize,
    filter_query: Option<&str>,
) -> Result<(u64, Vec<RedisHashItem>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let count = count.max(1);
    if let Some(page) = take_hash_overflow_page(scope, key, cursor, count, filter_query).await {
        return Ok(page);
    }
    let (scan_cursor, previous_session) =
        take_collection_scan_cursor(scope, key, cursor, RedisCollectionOverflowKind::Hash, filter_query).await?;
    let scanned = if let Some(query) = filter_query {
        hscan_filtered_page_raw(con, key, scan_cursor, count, query).await
    } else {
        hscan_page_raw(con, key, scan_cursor, count, None).await
    };
    let (next_cursor, mut items) = match scanned {
        Ok(page) => page,
        Err(error) => {
            if let Some(session) = previous_session {
                collection_overflow_sessions().lock().await.reinsert(cursor, session);
            }
            return Err(error);
        }
    };
    let page_len = budgeted_page_len(&items, count, hash_item_page_bytes);
    let next_cursor = store_hash_overflow_page(scope, key, &mut items, page_len, next_cursor, filter_query).await;
    Ok((next_cursor, items))
}

async fn sscan_bounded_page<C>(
    con: &mut C,
    scope: &RedisOperationScope,
    key: &[u8],
    cursor: u64,
    count: usize,
    filter_query: Option<&str>,
) -> Result<(u64, Vec<RedisSetItem>), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let count = count.max(1);
    if let Some(page) = take_set_overflow_page(scope, key, cursor, count, filter_query).await {
        return Ok(page);
    }
    let (scan_cursor, previous_session) =
        take_collection_scan_cursor(scope, key, cursor, RedisCollectionOverflowKind::Set, filter_query).await?;
    let scanned = if let Some(query) = filter_query {
        sscan_filtered_page_raw(con, key, scan_cursor, count, query).await
    } else {
        sscan_page_raw(con, key, scan_cursor, count).await
    };
    let (next_cursor, mut items) = match scanned {
        Ok(page) => page,
        Err(error) => {
            if let Some(session) = previous_session {
                collection_overflow_sessions().lock().await.reinsert(cursor, session);
            }
            return Err(error);
        }
    };
    let page_len = budgeted_page_len(&items, count, set_item_page_bytes);
    let next_cursor = store_set_overflow_page(scope, key, &mut items, page_len, next_cursor, filter_query).await;
    Ok((next_cursor, items))
}

async fn take_hash_overflow_page(
    scope: &RedisOperationScope,
    key: &[u8],
    cursor: u64,
    count: usize,
    filter_query: Option<&str>,
) -> Option<(u64, Vec<RedisHashItem>)> {
    if cursor == 0 {
        return None;
    }

    let mut sessions = collection_overflow_sessions().lock().await;
    let mut session =
        sessions.take_matching(cursor, scope, key, RedisCollectionOverflowKind::Hash, filter_query, None)?;
    let page = match &mut session.items {
        RedisCollectionOverflowItems::Hash(items) if !items.is_empty() => {
            take_vec_page(items, budgeted_page_len(items, count, hash_item_page_bytes))
        }
        RedisCollectionOverflowItems::Hash(_) => {
            sessions.reinsert(cursor, session);
            return None;
        }
        RedisCollectionOverflowItems::Set(_) => return None,
    };
    let has_buffered_items = match &session.items {
        RedisCollectionOverflowItems::Hash(items) => !items.is_empty(),
        RedisCollectionOverflowItems::Set(_) => false,
    };
    let retain_cursor =
        has_buffered_items || (session.followup_cursor != 0 && scope != &RedisOperationScope::default());
    let next_cursor = if retain_cursor { cursor } else { session.followup_cursor };
    if retain_cursor {
        sessions.reinsert(cursor, session);
    }
    Some((next_cursor, page))
}

async fn take_set_overflow_page(
    scope: &RedisOperationScope,
    key: &[u8],
    cursor: u64,
    count: usize,
    filter_query: Option<&str>,
) -> Option<(u64, Vec<RedisSetItem>)> {
    if cursor == 0 {
        return None;
    }

    let mut sessions = collection_overflow_sessions().lock().await;
    let mut session =
        sessions.take_matching(cursor, scope, key, RedisCollectionOverflowKind::Set, filter_query, None)?;
    let page = match &mut session.items {
        RedisCollectionOverflowItems::Set(items) if !items.is_empty() => {
            take_vec_page(items, budgeted_page_len(items, count, set_item_page_bytes))
        }
        RedisCollectionOverflowItems::Set(_) => {
            sessions.reinsert(cursor, session);
            return None;
        }
        RedisCollectionOverflowItems::Hash(_) => return None,
    };
    let has_buffered_items = match &session.items {
        RedisCollectionOverflowItems::Set(items) => !items.is_empty(),
        RedisCollectionOverflowItems::Hash(_) => false,
    };
    let retain_cursor =
        has_buffered_items || (session.followup_cursor != 0 && scope != &RedisOperationScope::default());
    let next_cursor = if retain_cursor { cursor } else { session.followup_cursor };
    if retain_cursor {
        sessions.reinsert(cursor, session);
    }
    Some((next_cursor, page))
}

async fn store_hash_overflow_page(
    scope: &RedisOperationScope,
    key: &[u8],
    items: &mut Vec<RedisHashItem>,
    count: usize,
    followup_cursor: u64,
    filter_query: Option<&str>,
) -> u64 {
    if items.len() <= count && (followup_cursor == 0 || scope == &RedisOperationScope::default()) {
        return followup_cursor;
    }

    let overflow = items.split_off(count.min(items.len()));
    let session = RedisCollectionOverflowSession {
        scope: scope.clone(),
        key: key.to_vec(),
        kind: RedisCollectionOverflowKind::Hash,
        filter: filter_query.map(str::to_string),
        sort_direction: None,
        followup_cursor,
        items: RedisCollectionOverflowItems::Hash(overflow),
        last_used: Instant::now(),
    };
    collection_overflow_sessions().lock().await.insert(session)
}

async fn store_set_overflow_page(
    scope: &RedisOperationScope,
    key: &[u8],
    items: &mut Vec<RedisSetItem>,
    count: usize,
    followup_cursor: u64,
    filter_query: Option<&str>,
) -> u64 {
    if items.len() <= count && (followup_cursor == 0 || scope == &RedisOperationScope::default()) {
        return followup_cursor;
    }

    let overflow = items.split_off(count.min(items.len()));
    let session = RedisCollectionOverflowSession {
        scope: scope.clone(),
        key: key.to_vec(),
        kind: RedisCollectionOverflowKind::Set,
        filter: filter_query.map(str::to_string),
        sort_direction: None,
        followup_cursor,
        items: RedisCollectionOverflowItems::Set(overflow),
        last_used: Instant::now(),
    };
    collection_overflow_sessions().lock().await.insert(session)
}

async fn take_collection_scan_cursor(
    scope: &RedisOperationScope,
    key: &[u8],
    cursor: u64,
    kind: RedisCollectionOverflowKind,
    filter_query: Option<&str>,
) -> Result<(u64, Option<RedisCollectionOverflowSession>), String> {
    if cursor == 0 {
        return Ok((0, None));
    }
    if let Some(session) =
        collection_overflow_sessions().lock().await.take_matching(cursor, scope, key, kind, filter_query, None)
    {
        return Ok((session.followup_cursor, Some(session)));
    }
    if cursor >= COLLECTION_OVERFLOW_CURSOR_START || scope != &RedisOperationScope::default() {
        return Err("Collection cursor is invalid, expired, or belongs to a different connection/database".to_string());
    }
    Ok((cursor, None))
}

/// How many leading items fit in one page, honouring both the item count and the byte budget.
///
/// Always returns at least one item so a member larger than the whole budget still loads (and
/// pagination cannot stall), and never more than `items.len()`.
fn budgeted_page_len<T>(items: &[T], count: usize, size_of: impl Fn(&T) -> usize) -> usize {
    let limit = count.max(1).min(items.len());
    let mut used = 0usize;
    for (index, item) in items.iter().take(limit).enumerate() {
        used = used.saturating_add(size_of(item));
        if used > COLLECTION_PAGE_MAX_BYTES {
            return index.max(1);
        }
    }
    limit
}

fn blob_page_bytes(blob: &RedisBlob) -> usize {
    blob.raw_base64.len()
}

fn hash_item_page_bytes(item: &RedisHashItem) -> usize {
    blob_page_bytes(&item.field) + blob_page_bytes(&item.value)
}

fn set_item_page_bytes(item: &RedisSetItem) -> usize {
    blob_page_bytes(&item.member)
}

fn list_item_page_bytes(item: &RedisListItem) -> usize {
    blob_page_bytes(&item.value)
}

fn zset_item_page_bytes(item: &RedisZsetItem) -> usize {
    blob_page_bytes(&item.member) + item.score.len()
}

fn take_vec_page<T>(items: &mut Vec<T>, count: usize) -> Vec<T> {
    let page_size = items.len().min(count.max(1));
    let overflow = items.split_off(page_size);
    std::mem::replace(items, overflow)
}

async fn attach_hash_field_ttls<C>(con: &mut C, key: &[u8], items: &mut [RedisHashItem]) -> Result<(), String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    if items.is_empty() {
        return Ok(());
    }

    let fields = items
        .iter()
        .map(|item| {
            base64::engine::general_purpose::STANDARD
                .decode(&item.field.raw_base64)
                .map_err(|error| format!("Invalid Redis hash field encoding: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Redis < 7.4 echoes command arguments verbatim in unknown-command errors.
    // Binary arguments can make that RESP error invalid UTF-8 (or inject CRLF),
    // so redis-rs fails to parse it before the optional-error fallback can run.
    // Discover support using ASCII-only arguments before sending unsafe bytes.
    let unsafe_error_arg =
        |bytes: &[u8]| std::str::from_utf8(bytes).is_err() || bytes.windows(2).any(|pair| pair == b"\r\n");
    if unsafe_error_arg(key) || fields.iter().any(|field| unsafe_error_arg(field)) {
        let info: RedisRawValue = match redis::cmd("COMMAND").arg("INFO").arg("HTTL").query_async(con).await {
            Ok(info) => info,
            Err(error) if is_optional_hash_field_expiry_error(&error) => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        if matches!(info, RedisRawValue::Nil)
            || matches!(&info, RedisRawValue::Array(commands) if commands.is_empty() || matches!(commands.first(), Some(RedisRawValue::Nil)))
        {
            return Ok(());
        }
    }

    let mut command = redis::cmd("HTTL");
    command.arg(key).arg("FIELDS").arg(fields.len());
    for field in fields {
        command.arg(field);
    }

    let raw: RedisRawValue = match command.query_async(con).await {
        Ok(raw) => raw,
        Err(error) if is_optional_hash_field_expiry_error(&error) => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if matches!(raw, RedisRawValue::Nil) {
        return Ok(());
    }
    let RedisRawValue::Array(values) = raw else {
        return Ok(());
    };
    if values.len() != items.len() {
        return Ok(());
    }
    for (item, value) in items.iter_mut().zip(values) {
        let Some(ttl) = redis_value_to_string(value).and_then(|value| value.parse::<i64>().ok()) else {
            return Ok(());
        };
        item.field_ttl = (ttl != -2).then_some(ttl);
    }
    Ok(())
}

async fn read_hash_field_ttl<C>(con: &mut C, key: &[u8], field: &[u8]) -> Result<Option<i64>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let raw: RedisRawValue = match redis::cmd("HTTL").arg(key).arg("FIELDS").arg(1).arg(field).query_async(con).await {
        Ok(raw) => raw,
        Err(error) if is_optional_hash_field_expiry_error(&error) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if matches!(raw, RedisRawValue::Nil) {
        return Ok(None);
    }
    let RedisRawValue::Array(mut values) = raw else {
        return Ok(None);
    };
    let Some(ttl) = values.pop().and_then(redis_value_to_string).and_then(|value| value.parse::<i64>().ok()) else {
        return Ok(None);
    };
    Ok((ttl >= 0).then_some(ttl))
}

fn is_optional_hash_field_expiry_error(error: &redis::RedisError) -> bool {
    let detail = error.detail().unwrap_or_default().to_ascii_lowercase();
    detail.contains("unknown command")
        || detail.contains("unknown redis command")
        || detail.contains("unsupported")
        || detail.contains("syntax error")
        || detail.contains("noperm")
        || detail.contains("no permission")
        || detail == "invalid argument: hash field expiration is not supported by legacy hash encoding"
}

fn blob_matches_query(blob: &RedisBlob, lowered_query: &str) -> bool {
    redis_blob_display_text(blob).to_lowercase().contains(lowered_query)
}

fn bytes_match_query(bytes: &[u8], lowered_query: &str) -> bool {
    // Match the same text as redis_blob_display_text, including binary escapes.
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_lowercase().contains(lowered_query),
        Err(_) => redis_bytes_to_display(bytes).to_lowercase().contains(lowered_query),
    }
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

async fn zrange_page_raw<C>(
    con: &mut C,
    key: &[u8],
    start: i64,
    end: i64,
    descending: bool,
) -> Result<Vec<RedisZsetItem>, String>
where
    C: ConnectionLike + Send + Sync + Unpin,
{
    let command = if descending { "ZREVRANGE" } else { "ZRANGE" };
    let raw: RedisRawValue = redis::cmd(command)
        .arg(key)
        .arg(start)
        .arg(end)
        .arg("WITHSCORES")
        .query_async(con)
        .await
        .map_err(|e| e.to_string())?;

    let RedisRawValue::Array(entries) = raw else {
        return Err("Invalid ZRANGE response".to_string());
    };
    if entries.len() % 2 != 0 {
        return Err("Invalid ZRANGE response".to_string());
    }

    let mut items = Vec::with_capacity(entries.len() / 2);
    for pair in entries.chunks_exact(2) {
        let member = redis_value_to_bytes(pair[0].clone())
            .map(|bytes| redis_blob_from_bytes(&bytes))
            .ok_or_else(|| "Invalid ZRANGE member payload".to_string())?;
        let score = redis_value_to_string(pair[1].clone()).ok_or_else(|| "Invalid ZRANGE score".to_string())?;
        items.push(RedisZsetItem { score, member });
    }
    Ok(items)
}

fn parse_scan_hash_entries(
    raw: RedisRawValue,
    lowered_query: Option<&str>,
) -> Result<(u64, Vec<RedisHashItem>), String> {
    let RedisRawValue::Array(mut parts) = raw else {
        return Err("Invalid SCAN response".to_string());
    };
    if parts.len() != 2 {
        return Err("Invalid SCAN response".to_string());
    }

    let entries = parts.pop().unwrap();
    let cursor = redis_value_to_string(parts.pop().unwrap())
        .ok_or("Invalid cursor")?
        .parse::<u64>()
        .map_err(|_| "Invalid cursor".to_string())?;

    let RedisRawValue::Array(entries) = entries else {
        return Err("Invalid SCAN entries".to_string());
    };

    let mut items = Vec::new();
    let mut iter = entries.into_iter();
    while let Some(field) = iter.next() {
        let Some(value) = iter.next() else { break };
        let field = redis_value_to_bytes(field).ok_or_else(|| "Invalid hash field payload".to_string())?;
        let value = redis_value_to_bytes(value).ok_or_else(|| "Invalid hash value payload".to_string())?;
        if lowered_query.is_some_and(|query| !bytes_match_query(&field, query) && !bytes_match_query(&value, query)) {
            continue;
        }
        let field = redis_blob_from_bytes(&field);
        let value = redis_blob_from_bytes(&value);
        items.push(RedisHashItem { field, value, field_ttl: None });
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
    use base64::Engine;
    use std::time::Duration;
    use std::{
        collections::{HashMap, VecDeque},
        future::ready,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex as StdMutex,
        },
    };

    use super::{
        classify_command, connection_info, decode_cluster_cursor, encode_cluster_cursor, is_redis_auth_error,
        is_redis_command_denied_error, is_redis_json_type, load_redis_tls_certificates, parse_cluster_slots,
        parse_command_argv, parse_database_count, parse_redis_endpoint, parse_scan_keys, parse_stream_consumers,
        parse_stream_entries, parse_stream_groups, parse_stream_pending_entries, redis_auth_candidates,
        redis_blob_display_text, redis_blob_from_bytes, redis_cluster_slot, redis_command_raw_to_json,
        redis_database_index, redis_key_bytes_to_display, redis_key_bytes_to_raw, redis_key_matches_query,
        redis_key_raw_to_bytes, redis_key_value_preview, redis_sentinel_master_endpoint, redis_value_matches_query,
        redis_value_to_bytes, standalone_connection_infos, RedisAuthCandidate, RedisBlob, RedisBlobEncoding,
        RedisClusterSlotRange, RedisCollectionPage, RedisCommandSafety, RedisHashItem, RedisListItem,
        RedisNodeEndpoint, RedisNodeRoute, RedisRawValue, RedisSetItem, RedisStreamConsumer, RedisStreamEntry,
        RedisStreamField, RedisStreamGroup, RedisStreamPendingEntry, RedisValue, RedisValueData, RedisZsetItem,
    };
    use dbx_types::models::connection::ConnectionConfig;
    use redis::{aio::ConnectionLike, Cmd, ConnectionAddr, Pipeline, RedisFuture};

    #[test]
    fn cluster_database_capability_is_strict_and_cluster_specific() {
        use super::ClusterDatabaseCapability as Capability;
        for count in [1, 4, i32::MAX as u32] {
            assert_eq!(
                super::parse_cluster_database_capability(RedisRawValue::Array(vec![
                    bulk("cluster-databases"),
                    bulk(&count.to_string())
                ]))
                .unwrap(),
                Capability::Known(count)
            );
        }
        assert_eq!(
            super::parse_cluster_database_capability(RedisRawValue::Array(vec![])).unwrap(),
            Capability::Unsupported
        );
        assert_eq!(
            super::parse_cluster_database_capability(RedisRawValue::Map(vec![(bulk("cluster-databases"), bulk("4"))]))
                .unwrap(),
            Capability::Known(4)
        );
        for raw in [
            RedisRawValue::Nil,
            RedisRawValue::Array(vec![bulk("databases"), bulk("16")]),
            RedisRawValue::Array(vec![bulk("cluster-databases")]),
            RedisRawValue::Array(vec![bulk("cluster-databases"), bulk("4"), bulk("extra")]),
        ] {
            assert!(super::parse_cluster_database_capability(raw).is_err());
        }
        for count in ["0", "-1", "2147483648", "4294967295", "4294967296", "4.0", " 4", ""] {
            assert!(
                super::parse_cluster_database_capability(RedisRawValue::Array(vec![
                    bulk("cluster-databases"),
                    bulk(count)
                ]))
                .is_err(),
                "{count}"
            );
        }
        assert_eq!(
            super::combine_cluster_database_capabilities(vec![Capability::Known(4), Capability::Known(4)]).unwrap(),
            Capability::Known(4)
        );
        assert!(super::combine_cluster_database_capabilities(vec![Capability::Known(4), Capability::Known(8)]).is_err());
        assert!(
            super::combine_cluster_database_capabilities(vec![Capability::Known(1), Capability::Unsupported]).is_err()
        );
        assert!(super::combine_cluster_database_capabilities(vec![]).is_err());
        assert_eq!(
            super::combine_cluster_database_capabilities(vec![
                Capability::Known(4),
                Capability::Unknown("node: NOPERM".to_string())
            ])
            .unwrap(),
            Capability::Unknown("node: NOPERM".to_string())
        );
        for raw in [
            RedisRawValue::Double(4.0),
            RedisRawValue::Boolean(true),
            RedisRawValue::Int(4),
            RedisRawValue::VerbatimString { format: redis::VerbatimFormat::Text, text: "4".to_string() },
            RedisRawValue::Nil,
            RedisRawValue::Okay,
            RedisRawValue::BulkString(vec![0xff]),
        ] {
            assert!(super::parse_cluster_database_capability(RedisRawValue::Array(vec![
                bulk("cluster-databases"),
                raw
            ]))
            .is_err());
        }
        assert!(super::parse_cluster_database_capability(RedisRawValue::Map(vec![(
            RedisRawValue::VerbatimString {
                format: redis::VerbatimFormat::Text,
                text: "cluster-databases".to_string()
            },
            bulk("4")
        )]))
        .is_err());
    }

    #[test]
    fn cluster_database_keyspace_counts_require_trustworthy_metadata() {
        assert_eq!(
            super::parse_cluster_keyspace_counts("# Keyspace\r\ndb0:keys=3,expires=0\r\ndb1:keys=2,expires=0\r\n")
                .unwrap(),
            HashMap::from([(0, 3), (1, 2)])
        );
        assert!(super::parse_cluster_keyspace_counts("# Keyspace\r\n").unwrap().is_empty());
        for info in [
            "",
            "db0:keys=3",
            "# Keyspace\r\ndb0:expires=1",
            "# Keyspace\r\ndb0:keys=no",
            "# Keyspace\r\ndb0:keys=1\r\ndb0:keys=2",
        ] {
            assert!(super::parse_cluster_keyspace_counts(info).is_err(), "{info}");
        }
    }

    #[test]
    fn cluster_database_list_limit_is_separate_from_server_configuration_range() {
        assert_eq!(
            super::cluster_database_list_count(&super::ClusterDatabaseCapability::Known(10_000)).unwrap(),
            10_000
        );
        let error = super::cluster_database_list_count(&super::ClusterDatabaseCapability::Known(10_001)).unwrap_err();
        assert!(error.contains("10001"));
        assert!(error.contains("10000"));
        assert!(error.contains("DBX"));
        assert!(super::parse_cluster_database_capability(RedisRawValue::Array(vec![
            bulk("cluster-databases"),
            bulk("10001")
        ]))
        .is_ok());
    }

    #[tokio::test]
    async fn cluster_database_bounds_and_db_zero_do_not_require_network() {
        let super::RedisConnection::Cluster(pool) = super::redis_connection_test_stub() else { unreachable!() };
        *pool.database_capability.lock().await = Some(super::ClusterDatabaseCapability::Known(4));
        super::ensure_cluster_database(&pool, 3).await.unwrap();
        assert!(super::ensure_cluster_database(&pool, 4).await.unwrap_err().contains("range"));
        *pool.database_capability.lock().await = Some(super::ClusterDatabaseCapability::Unknown("denied".to_string()));
        super::ensure_cluster_database(&pool, 0).await.unwrap();
        assert_eq!(super::cluster_database_diagnostic(&pool).await.as_deref(), Some("denied"));
    }

    #[test]
    fn cluster_node_connection_options_keep_database_transport_auth_and_tls() {
        let super::RedisConnection::Cluster(mut pool) = super::redis_connection_test_stub() else { unreachable!() };
        let advertised = RedisNodeEndpoint { host: "remote.invalid".to_string(), port: 7000 };
        pool.node_routes.push(RedisNodeRoute {
            advertised: advertised.clone(),
            connect: RedisNodeEndpoint { host: "127.0.0.1".to_string(), port: 17000 },
        });
        pool.username = "acl-user".to_string();
        pool.password = "acl-password".to_string();
        let info = super::cluster_node_connection_info(&pool, &advertised, 3).unwrap();
        assert!(matches!(info.addr(), ConnectionAddr::Tcp(host, 17000) if host == "127.0.0.1"));
        assert_eq!(info.redis_settings().db(), 3);
        assert_eq!(info.redis_settings().username(), Some("acl-user"));
        assert_eq!(info.redis_settings().password(), Some("acl-password"));
        pool.tls = true;
        pool.tls_insecure = true;
        let info = super::cluster_node_connection_info(&pool, &advertised, 2).unwrap();
        assert!(
            matches!(info.addr(), ConnectionAddr::TcpTls { host, port: 17000, insecure: true, .. } if host == "127.0.0.1")
        );
        assert_eq!(info.redis_settings().db(), 2);
        let fallback = super::cluster_node_connection_info(
            &pool,
            &RedisNodeEndpoint { host: "unmapped.invalid".to_string(), port: 7001 },
            2,
        )
        .unwrap();
        assert!(
            matches!(fallback.addr(), ConnectionAddr::TcpTls { host, port: 7001, insecure: true, .. } if host == "unmapped.invalid")
        );
        assert_eq!(fallback.redis_settings().db(), 2);
    }

    #[tokio::test]
    async fn cluster_value_scan_counts_all_masters_and_preserves_total_on_continuation() {
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 1 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 2 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 3 },
        ];
        let mut connections = HashMap::from([
            (
                masters[0].clone(),
                FakeRedisConnection::new(vec![
                    RedisRawValue::Int(10),
                    scan_response("0", vec!["needle:a"]),
                    bulk("string"),
                ]),
            ),
            (masters[1].clone(), FakeRedisConnection::new(vec![RedisRawValue::Int(20)])),
            (masters[2].clone(), FakeRedisConnection::new(vec![RedisRawValue::Int(30)])),
        ]);
        let first = super::scan_cluster_values_page_with(
            &sessions,
            || ready(Ok(masters.clone())),
            |endpoint| ready(connections.remove(&endpoint).ok_or("unexpected reconnect".to_string())),
            1,
            0,
            "*",
            "needle",
            true,
            1,
        )
        .await
        .unwrap();
        assert_eq!(first.total_keys, 60);
        assert_eq!(first.keys.len(), 1);
        assert_ne!(first.cursor, 0);
        let next = super::scan_cluster_values_page_with(
            &sessions,
            || ready(Err("unexpected rediscovery".to_string())),
            |_| ready(Ok(FakeRedisConnection::new(vec![scan_response("0", vec![])]))),
            1,
            first.cursor,
            "*",
            "needle",
            true,
            1,
        )
        .await
        .unwrap();
        assert_eq!(next.total_keys, 60);
        assert_eq!(next.cursor, 0);
    }

    #[tokio::test]
    async fn cluster_value_scan_count_denial_does_not_prevent_search() {
        let mut store = super::RedisClusterScanSessions::default();
        let previous = store.insert(None, super::RedisClusterKeyScanSession::new(vec![], "existing"));
        let sessions = tokio::sync::Mutex::new(store);
        let master = RedisNodeEndpoint { host: "count-node".to_string(), port: 7001 };
        let page = super::scan_cluster_values_page_with(
            &sessions,
            || ready(Ok(vec![master.clone()])),
            |_| {
                ready(Ok(FakeRedisConnection::with_results(vec![
                    Err(noperm("dbsize")),
                    Ok(scan_response("0", vec!["needle:a"])),
                    Ok(bulk("string")),
                    Ok(RedisRawValue::Int(-1)),
                    Ok(bulk("needle value")),
                ])))
            },
            1,
            0,
            "*",
            "needle",
            false,
            1,
        )
        .await
        .unwrap();
        assert_eq!(page.total_keys, 0);
        assert_eq!(page.keys.len(), 1);
        assert_eq!(page.keys[0].value_preview, "needle value");
        assert_eq!(page.cursor, 0);
        let sessions = sessions.lock().await;
        assert_eq!(sessions.entries.len(), 1);
        assert!(sessions.entries.contains_key(&previous));
    }

    #[tokio::test]
    async fn cluster_value_scan_retries_count_connection_but_propagates_scan_failures() {
        for scan_failure in [false, true] {
            let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
            let master = RedisNodeEndpoint { host: "count-node".to_string(), port: 7001 };
            let mut attempts = 0;
            let result = super::scan_cluster_values_page_with(
                &sessions,
                || ready(Ok(vec![master.clone()])),
                |_| {
                    attempts += 1;
                    ready(if attempts == 1 {
                        Err("count connection unavailable".to_string())
                    } else if scan_failure {
                        Ok(FakeRedisConnection::with_results(vec![Err(noperm("scan"))]))
                    } else {
                        Ok(FakeRedisConnection::new(vec![scan_response("0", vec!["needle:a"]), bulk("string")]))
                    })
                },
                1,
                0,
                "*",
                "needle",
                true,
                1,
            )
            .await;
            assert_eq!(attempts, 2);
            if scan_failure {
                assert_eq!(result.unwrap_err(), noperm("scan").to_string());
            } else {
                let page = result.unwrap();
                assert_eq!(page.total_keys, 0);
                assert_eq!(page.keys.len(), 1);
            }
            assert!(sessions.lock().await.entries.is_empty());
        }

        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let mut attempts = 0;
        let error = super::scan_cluster_values_page_with::<FakeRedisConnection, _, _, _, _>(
            &sessions,
            || ready(Ok(vec![RedisNodeEndpoint { host: "unavailable".to_string(), port: 7001 }])),
            |_| {
                attempts += 1;
                ready(Err("scan connection unavailable".to_string()))
            },
            1,
            0,
            "*",
            "needle",
            true,
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(attempts, 2);
        assert_eq!(error, "scan connection unavailable");
        assert!(sessions.lock().await.entries.is_empty());
    }

    #[tokio::test]
    async fn cluster_key_cursor_rejects_wrong_database_without_consuming_session() {
        let mut store = super::RedisClusterScanSessions::default();
        let mut session =
            super::RedisClusterKeyScanSession::new(vec![RedisNodeEndpoint { host: "test".to_string(), port: 1 }], "*");
        session.db = 1;
        let cursor = store.insert(None, session);
        let sessions = tokio::sync::Mutex::new(store);
        let result = super::scan_cluster_keys_batch_in_db_with::<FakeRedisConnection, _, _, _, _>(
            &sessions,
            || ready(Err("unexpected discovery".to_string())),
            |_| ready(Err("unexpected connection".to_string())),
            0,
            cursor,
            "*",
            1,
            1,
            false,
        )
        .await;
        assert_eq!(result.unwrap_err(), super::INVALID_CLUSTER_SCAN_CURSOR_ERROR);
        assert!(sessions.lock().await.entries.contains_key(&cursor));
        let result = super::scan_cluster_keys_batch_in_db_with(
            &sessions,
            || ready(Err("unexpected discovery".to_string())),
            |_| ready(Ok(FakeRedisConnection::new(vec![scan_response("0", vec![])]))),
            1,
            cursor,
            "*",
            1,
            1,
            false,
        )
        .await
        .unwrap();
        assert_eq!(result.cursor, 0);
    }

    #[tokio::test]
    async fn cluster_value_cursor_rejects_scope_and_filter_mismatch_and_restores_on_failure() {
        let mut store = super::RedisClusterScanSessions::default();
        let mut session =
            super::RedisClusterKeyScanSession::new(vec![RedisNodeEndpoint { host: "test".to_string(), port: 1 }], "*");
        session.db = 1;
        session.value_filter = Some(("needle".to_string(), false));
        session.node_cursors[0] = 42;
        let cursor = store.insert(None, session);
        let sessions = tokio::sync::Mutex::new(store);
        for (db, query, include_keys, token) in [
            (0, "needle", false, cursor),
            (1, "other", false, cursor),
            (1, "needle", true, cursor),
            (1, "needle", false, cursor + 1_000_000),
        ] {
            let error = super::scan_cluster_values_page_with::<FakeRedisConnection, _, _, _, _>(
                &sessions,
                || ready(Err("unexpected discovery".to_string())),
                |_| ready(Err("unexpected connection".to_string())),
                db,
                token,
                "*",
                query,
                include_keys,
                1,
            )
            .await
            .unwrap_err();
            assert_eq!(error, super::INVALID_CLUSTER_SCAN_CURSOR_ERROR);
            assert_eq!(sessions.lock().await.entries.get(&cursor).unwrap().node_cursors[0], 42);
        }
        let error = super::scan_cluster_values_page_with::<FakeRedisConnection, _, _, _, _>(
            &sessions,
            || ready(Err("unexpected discovery".to_string())),
            |_| ready(Err("network failed".to_string())),
            1,
            cursor,
            "*",
            "needle",
            false,
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "network failed");
        assert_eq!(sessions.lock().await.entries.get(&cursor).unwrap().node_cursors[0], 42);
        let result = super::scan_cluster_values_page_with(
            &sessions,
            || ready(Err("unexpected discovery".to_string())),
            |_| ready(Ok(FakeRedisConnection::new(vec![scan_response("0", vec![])]))),
            1,
            cursor,
            "*",
            "needle",
            false,
            1,
        )
        .await
        .unwrap();
        assert_eq!(result.cursor, 0);
    }

    #[test]
    fn cluster_cursor_ids_do_not_collide_across_connection_pools() {
        let mut first = super::RedisClusterScanSessions::default();
        let mut second = super::RedisClusterScanSessions::default();
        let session = super::RedisClusterKeyScanSession::new(vec![], "*");
        let first_id = first.insert(None, session.clone());
        let second_id = second.insert(None, session);
        assert_ne!(first_id, second_id);
        assert!(second.take(first_id).is_none());
        assert!(second.take(second_id).is_some());
    }

    #[tokio::test]
    async fn collection_overflow_is_connection_and_database_scoped() {
        let scope = super::RedisOperationScope { connection_id: "overflow-scope-test".to_string(), db: 1 };
        let pairs = (0..202).map(|index| (format!("field:{index}"), format!("value:{index}"))).collect();
        let mut con = FakeRedisConnection::new(vec![
            bulk("hash"),
            RedisRawValue::Int(-1),
            RedisRawValue::Int(202),
            hscan_response_owned("0", pairs),
            httl_response(200, -1),
        ]);
        let value = super::get_value_scoped(&mut con, b"scoped-hash", &scope).await.unwrap();
        let RedisValueData::Hash { scan_cursor: Some(cursor), .. } = value.data else {
            panic!("expected overflow");
        };
        for wrong_scope in [
            super::RedisOperationScope { db: 0, ..scope.clone() },
            super::RedisOperationScope { connection_id: "another-connection".to_string(), ..scope.clone() },
        ] {
            let mut wrong = FakeRedisConnection::new(vec![]);
            assert!(super::load_more_collection_scoped(
                &mut wrong,
                b"scoped-hash",
                "hash",
                cursor,
                1,
                None,
                None,
                &wrong_scope
            )
            .await
            .is_err());
            assert!(wrong.commands.is_empty());
        }
        let mut continuation = FakeRedisConnection::new(vec![httl_response(1, 30)]);
        let page = super::load_more_collection_scoped(
            &mut continuation,
            b"scoped-hash",
            "hash",
            cursor,
            1,
            None,
            None,
            &scope,
        )
        .await
        .unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = page else {
            panic!("expected hash");
        };
        assert_eq!(items[0].field, redis_blob_from_bytes(b"field:200"));
        assert_eq!(items[0].field_ttl, Some(30));
        assert_eq!(scan_cursor, Some(cursor));
        assert_eq!(continuation.command_count("HSCAN"), 0);
        super::collection_overflow_sessions().lock().await.entries.get_mut(&cursor).unwrap().last_used =
            std::time::Instant::now() - super::COLLECTION_OVERFLOW_SESSION_TTL;
        let mut expired = FakeRedisConnection::new(vec![]);
        assert!(super::load_more_collection_scoped(
            &mut expired,
            b"scoped-hash",
            "hash",
            cursor,
            1,
            None,
            None,
            &scope
        )
        .await
        .is_err());
        assert!(expired.commands.is_empty());
    }

    /// Replays the standalone-Redis pagination sequence from issue #12640: a large
    /// hash is read once through the scoped value API, then continued through the
    /// scoped load-more API with the same scope (the pairing the desktop app uses).
    /// Every field must eventually arrive exactly once, and a continuation under a
    /// different (unseoped) scope must fail instead of restarting the walk.
    #[tokio::test]
    async fn scoped_hash_pagination_walks_large_collections_without_repeating_the_first_page() {
        const FIELDS: usize = 4000;
        const PAGE: usize = 200;
        let scope = super::RedisOperationScope { connection_id: "issue-12640-standalone".to_string(), db: 0 };

        // Real HSCAN cursors: one batch of `PAGE` fields per server round trip.
        let mut responses = vec![bulk("hash"), RedisRawValue::Int(-1), RedisRawValue::Int(FIELDS as i64)];
        let pages = FIELDS.div_ceil(PAGE);
        for page in 0..pages {
            let cursor = if page + 1 == pages { "0".to_string() } else { (page + 1).to_string() };
            let pairs = (page * PAGE..((page + 1) * PAGE).min(FIELDS))
                .map(|index| (format!("field:{index}"), format!("value:{index}")))
                .collect();
            responses.push(hscan_response_owned(&cursor, pairs));
            responses.push(httl_response(PAGE, -1));
        }
        let mut con = FakeRedisConnection::new(responses);

        let value = super::get_value_scoped(&mut con, b"issue-12640-hash", &scope).await.unwrap();
        let RedisValueData::Hash { items: mut seen, scan_cursor, total } = value.data else {
            panic!("expected hash");
        };
        assert_eq!(total, FIELDS as u64);
        assert_eq!(seen.len(), PAGE, "the first page defaults to the configured page size");
        let mut cursor = scan_cursor.expect("a 4000-field hash must offer a continuation");
        assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START, "the continuation is an overflow session marker");

        // The old desktop path continued under the default (unseoped) connection,
        // which rejected the marker and stopped pagination at the first page.
        let mut mismatched = FakeRedisConnection::new(vec![]);
        let error = super::load_more_collection(&mut mismatched, b"issue-12640-hash", "hash", cursor, PAGE, None, None)
            .await
            .unwrap_err();
        assert!(error.contains("invalid, expired"), "{error}");
        assert!(mismatched.commands.is_empty(), "a foreign cursor must not reach the server");

        let mut pages_seen = 1;
        while cursor != 0 {
            let page = super::load_more_collection_scoped(
                &mut con,
                b"issue-12640-hash",
                "hash",
                cursor,
                PAGE,
                None,
                None,
                &scope,
            )
            .await
            .unwrap();
            let RedisCollectionPage::Hash { items, scan_cursor: next } = page else {
                panic!("expected hash");
            };
            seen.extend(items);
            pages_seen += 1;
            assert!(pages_seen <= pages, "pagination must terminate");
            match next {
                Some(next) => {
                    assert_ne!(next, cursor, "each page must continue with a fresh marker");
                    cursor = next;
                }
                None => break,
            }
        }

        assert_eq!(pages_seen, pages);
        assert_eq!(seen.len(), FIELDS);
        let unique: std::collections::HashSet<_> = seen.iter().map(|item| item.field.raw_base64.clone()).collect();
        assert_eq!(unique.len(), FIELDS, "every field arrives exactly once");
        // Every page came from a fresh HSCAN round trip — no page was re-served from
        // the start of the hash, which is what a foreign or replayed cursor would do.
        assert_eq!(con.command_count("HSCAN"), pages);
    }

    #[tokio::test]
    async fn set_overflow_rejects_unknown_and_foreign_tokens_without_server_scan() {
        let scope = super::RedisOperationScope { connection_id: "set-scope-test".to_string(), db: 1 };
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Array(vec![
            bulk("0"),
            RedisRawValue::Array(vec![bulk("a"), bulk("b")]),
        ])]);
        let page =
            super::load_more_collection_scoped(&mut con, b"scoped-set", "set", 0, 1, None, None, &scope).await.unwrap();
        let RedisCollectionPage::Set { scan_cursor: Some(cursor), .. } = page else {
            panic!("expected set overflow");
        };
        let mut wrong = FakeRedisConnection::new(vec![]);
        for token in [cursor, super::MAX_SAFE_INTEGER_CURSOR] {
            assert!(super::load_more_collection_scoped(
                &mut wrong,
                b"scoped-set",
                "set",
                token,
                1,
                None,
                None,
                &super::RedisOperationScope { db: 0, ..scope.clone() }
            )
            .await
            .is_err());
        }
        assert!(wrong.commands.is_empty());
        let page = super::load_more_collection_scoped(&mut wrong, b"scoped-set", "set", cursor, 1, None, None, &scope)
            .await
            .unwrap();
        let RedisCollectionPage::Set { items, scan_cursor } = page else {
            panic!("expected set");
        };
        assert_eq!(items[0].member, redis_blob_from_bytes(b"b"));
        assert_eq!(scan_cursor, None);
        assert!(wrong.commands.is_empty());
    }

    #[tokio::test]
    async fn native_collection_cursors_reject_foreign_scope_key_kind_and_filter() {
        for key_type in ["hash", "set"] {
            let scope = super::RedisOperationScope { connection_id: format!("native-{key_type}"), db: 1 };
            let response = if key_type == "hash" {
                hscan_response("128", vec![("field", "value")])
            } else {
                scan_response("128", vec!["member"])
            };
            let mut first = FakeRedisConnection::new(vec![response, httl_response(1, -1)]);
            let page = super::load_more_collection_scoped(&mut first, b"key", key_type, 0, 2, None, None, &scope)
                .await
                .unwrap();
            let cursor = match page {
                RedisCollectionPage::Hash { scan_cursor, .. } | RedisCollectionPage::Set { scan_cursor, .. } => {
                    scan_cursor.unwrap()
                }
                _ => panic!("expected collection"),
            };
            assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);
            let mut wrong = FakeRedisConnection::new(vec![]);
            let other_kind = if key_type == "hash" { "set" } else { "hash" };
            for (wrong_scope, wrong_key, wrong_kind, wrong_filter) in [
                (super::RedisOperationScope { db: 0, ..scope.clone() }, b"key".as_slice(), key_type, None),
                (
                    super::RedisOperationScope { connection_id: "foreign".to_string(), ..scope.clone() },
                    b"key".as_slice(),
                    key_type,
                    None,
                ),
                (scope.clone(), b"other".as_slice(), key_type, None),
                (scope.clone(), b"key".as_slice(), other_kind, None),
                (scope.clone(), b"key".as_slice(), key_type, Some("filter")),
            ] {
                assert!(super::load_more_collection_scoped(
                    &mut wrong,
                    wrong_key,
                    wrong_kind,
                    cursor,
                    2,
                    wrong_filter,
                    None,
                    &wrong_scope
                )
                .await
                .is_err());
            }
            assert!(super::load_more_collection_scoped(&mut wrong, b"key", key_type, 128, 2, None, None, &scope)
                .await
                .is_err());
            assert!(wrong.commands.is_empty());
            let response = if key_type == "hash" {
                hscan_response("0", vec![("next", "value")])
            } else {
                scan_response("0", vec!["next"])
            };
            let mut owner = FakeRedisConnection::new(vec![response, httl_response(1, -1)]);
            let page = super::load_more_collection_scoped(&mut owner, b"key", key_type, cursor, 2, None, None, &scope)
                .await
                .unwrap();
            assert!(owner.commands[0].contains("\r\n128\r\n"));
            match page {
                RedisCollectionPage::Hash { items, scan_cursor } => {
                    assert_eq!(items[0].field, redis_blob_from_bytes(b"next"));
                    assert_eq!(scan_cursor, None);
                }
                RedisCollectionPage::Set { items, scan_cursor } => {
                    assert_eq!(items[0].member, redis_blob_from_bytes(b"next"));
                    assert_eq!(scan_cursor, None);
                }
                _ => panic!("expected collection"),
            }
            assert!(!super::collection_overflow_sessions().lock().await.entries.contains_key(&cursor));
        }
    }

    #[tokio::test]
    async fn scoped_collection_overflow_keeps_followup_scoped_and_retries_failed_scan() {
        for key_type in ["hash", "set"] {
            let scope = super::RedisOperationScope { connection_id: format!("followup-{key_type}"), db: 1 };
            let response = if key_type == "hash" {
                hscan_response("128", vec![("one", "value"), ("two", "value")])
            } else {
                scan_response("128", vec!["one", "two"])
            };
            let mut first = FakeRedisConnection::new(vec![response, httl_response(1, -1)]);
            let page = super::load_more_collection_scoped(&mut first, b"key", key_type, 0, 1, None, None, &scope)
                .await
                .unwrap();
            let cursor = match page {
                RedisCollectionPage::Hash { scan_cursor, .. } | RedisCollectionPage::Set { scan_cursor, .. } => {
                    scan_cursor.unwrap()
                }
                _ => panic!("expected collection"),
            };
            let mut buffered = FakeRedisConnection::new(vec![httl_response(1, -1)]);
            let page =
                super::load_more_collection_scoped(&mut buffered, b"key", key_type, cursor, 1, None, None, &scope)
                    .await
                    .unwrap();
            match page {
                RedisCollectionPage::Hash { scan_cursor, .. } | RedisCollectionPage::Set { scan_cursor, .. } => {
                    assert_eq!(scan_cursor, Some(cursor));
                }
                _ => panic!("expected collection"),
            }
            assert_eq!(buffered.command_count("HSCAN") + buffered.command_count("SSCAN"), 0);
            let mut wrong = FakeRedisConnection::new(vec![]);
            assert!(super::load_more_collection_scoped(
                &mut wrong,
                b"key",
                key_type,
                cursor,
                1,
                None,
                None,
                &super::RedisOperationScope { db: 0, ..scope.clone() }
            )
            .await
            .is_err());
            assert!(wrong.commands.is_empty());
            let mut failed = FakeRedisConnection::with_results(vec![Err(redis::RedisError::from((
                redis::ErrorKind::Io,
                "temporary scan failure",
            )))]);
            assert!(super::load_more_collection_scoped(&mut failed, b"key", key_type, cursor, 1, None, None, &scope)
                .await
                .is_err());
            assert!(super::collection_overflow_sessions().lock().await.entries.contains_key(&cursor));
            let response = if key_type == "hash" {
                hscan_response("0", vec![("three", "value")])
            } else {
                scan_response("0", vec!["three"])
            };
            let mut retry = FakeRedisConnection::new(vec![response, httl_response(1, -1)]);
            let page = super::load_more_collection_scoped(&mut retry, b"key", key_type, cursor, 1, None, None, &scope)
                .await
                .unwrap();
            match page {
                RedisCollectionPage::Hash { items, scan_cursor } => {
                    assert_eq!(items[0].field, redis_blob_from_bytes(b"three"));
                    assert_eq!(scan_cursor, None);
                }
                RedisCollectionPage::Set { items, scan_cursor } => {
                    assert_eq!(items[0].member, redis_blob_from_bytes(b"three"));
                    assert_eq!(scan_cursor, None);
                }
                _ => panic!("expected collection"),
            }
            assert!(retry.commands[0].contains("\r\n128\r\n"));
        }
    }

    #[tokio::test]
    async fn collection_overflow_session_store_and_take_lifecycle() {
        let scope_a = super::RedisOperationScope { connection_id: "conn-alpha".to_string(), db: 2 };
        let scope_b = super::RedisOperationScope { connection_id: "conn-beta".to_string(), db: 2 };
        let scope_a_db3 = super::RedisOperationScope { connection_id: "conn-alpha".to_string(), db: 3 };
        let unscoped = super::RedisOperationScope::default();

        // 1. Direct Hash overflow store & take lifecycle
        {
            let key = b"direct-hash-lifecycle";
            let mut items: Vec<RedisHashItem> = (0..5)
                .map(|i| RedisHashItem {
                    field: text_blob(&format!("f{i}")),
                    value: text_blob(&format!("v{i}")),
                    field_ttl: None,
                })
                .collect();

            // Storing with count = 2 keeps 2 items in `items` and buffers the remaining 3 items.
            let followup_cursor = 888u64;
            let session_cursor =
                super::store_hash_overflow_page(&scope_a, key, &mut items, 2, followup_cursor, None).await;
            assert_eq!(items.len(), 2);
            assert!(session_cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);

            // Scope isolation: foreign connection, foreign db, unscoped default, wrong key, wrong filter, wrong kind
            // must all return None and leave the stored session intact.
            assert!(super::take_hash_overflow_page(&scope_b, key, session_cursor, 2, None).await.is_none());
            assert!(super::take_hash_overflow_page(&scope_a_db3, key, session_cursor, 2, None).await.is_none());
            assert!(super::take_hash_overflow_page(&unscoped, key, session_cursor, 2, None).await.is_none());
            assert!(super::take_hash_overflow_page(&scope_a, b"other-key", session_cursor, 2, None).await.is_none());
            assert!(super::take_hash_overflow_page(&scope_a, key, session_cursor, 2, Some("query")).await.is_none());
            assert!(super::take_set_overflow_page(&scope_a, key, session_cursor, 2, None).await.is_none());

            // First take with matching scope: takes 2 of the 3 buffered items.
            // Since 1 item remains in the session, cursor must be retained.
            let (next_cursor, p1) = super::take_hash_overflow_page(&scope_a, key, session_cursor, 2, None)
                .await
                .expect("take first buffered page");
            assert_eq!(p1.len(), 2);
            assert_eq!(p1[0].field, text_blob("f2"));
            assert_eq!(p1[1].field, text_blob("f3"));
            assert_eq!(next_cursor, session_cursor, "cursor must be retained while buffer has items");

            // Second take: takes the last buffered item.
            // Buffer is now empty, but followup_cursor != 0 and scope != default,
            // so cursor is still retained for the subsequent server scan.
            let (next_cursor, p2) = super::take_hash_overflow_page(&scope_a, key, session_cursor, 2, None)
                .await
                .expect("take remaining buffered page");
            assert_eq!(p2.len(), 1);
            assert_eq!(p2[0].field, text_blob("f4"));
            assert_eq!(next_cursor, session_cursor, "cursor must be retained for followup server scan");

            // Buffer is now empty, so take_hash_overflow_page returns None.
            assert!(super::take_hash_overflow_page(&scope_a, key, session_cursor, 2, None).await.is_none());

            // take_collection_scan_cursor must enforce scope isolation.
            assert!(super::take_collection_scan_cursor(
                &scope_b,
                key,
                session_cursor,
                super::RedisCollectionOverflowKind::Hash,
                None,
            )
            .await
            .is_err());
            assert!(super::take_collection_scan_cursor(
                &unscoped,
                key,
                session_cursor,
                super::RedisCollectionOverflowKind::Hash,
                None,
            )
            .await
            .is_err());

            // Matching scope takes the followup server scan cursor and consumes the session.
            let (server_cursor, session_opt) = super::take_collection_scan_cursor(
                &scope_a,
                key,
                session_cursor,
                super::RedisCollectionOverflowKind::Hash,
                None,
            )
            .await
            .expect("take scan cursor");
            assert_eq!(server_cursor, followup_cursor);
            assert!(session_opt.is_some());

            // Session has been consumed from registry; any subsequent access is rejected.
            assert!(super::take_collection_scan_cursor(
                &scope_a,
                key,
                session_cursor,
                super::RedisCollectionOverflowKind::Hash,
                None,
            )
            .await
            .is_err());
        }

        // 2. Direct Set overflow store & take lifecycle
        {
            let key = b"direct-set-lifecycle";
            let mut items: Vec<RedisSetItem> =
                (0..5).map(|i| RedisSetItem { member: text_blob(&format!("m{i}")) }).collect();

            let followup_cursor = 999u64;
            let session_cursor =
                super::store_set_overflow_page(&scope_a, key, &mut items, 2, followup_cursor, None).await;
            assert_eq!(items.len(), 2);
            assert!(session_cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);

            // Scope isolation
            assert!(super::take_set_overflow_page(&scope_b, key, session_cursor, 2, None).await.is_none());
            assert!(super::take_set_overflow_page(&scope_a_db3, key, session_cursor, 2, None).await.is_none());
            assert!(super::take_set_overflow_page(&unscoped, key, session_cursor, 2, None).await.is_none());
            assert!(super::take_set_overflow_page(&scope_a, b"other-key", session_cursor, 2, None).await.is_none());
            assert!(super::take_hash_overflow_page(&scope_a, key, session_cursor, 2, None).await.is_none());

            // Paging buffered items
            let (next_cursor, p1) =
                super::take_set_overflow_page(&scope_a, key, session_cursor, 2, None).await.expect("take set page 1");
            assert_eq!(p1.len(), 2);
            assert_eq!(p1[0].member, text_blob("m2"));
            assert_eq!(p1[1].member, text_blob("m3"));
            assert_eq!(next_cursor, session_cursor);

            let (next_cursor, p2) =
                super::take_set_overflow_page(&scope_a, key, session_cursor, 2, None).await.expect("take set page 2");
            assert_eq!(p2.len(), 1);
            assert_eq!(p2[0].member, text_blob("m4"));
            assert_eq!(next_cursor, session_cursor);

            // Buffer drained -> take_collection_scan_cursor
            let (server_cursor, session_opt) = super::take_collection_scan_cursor(
                &scope_a,
                key,
                session_cursor,
                super::RedisCollectionOverflowKind::Set,
                None,
            )
            .await
            .expect("take set scan cursor");
            assert_eq!(server_cursor, followup_cursor);
            assert!(session_opt.is_some());
        }

        // 3. Exhaustion behavior when followup_cursor is 0
        {
            let key = b"direct-exhaustion-hash";
            let mut items: Vec<RedisHashItem> = (0..3)
                .map(|i| RedisHashItem {
                    field: text_blob(&format!("fx{i}")),
                    value: text_blob(&format!("vx{i}")),
                    field_ttl: None,
                })
                .collect();

            // followup_cursor == 0: no further server pages exist
            let cursor = super::store_hash_overflow_page(&scope_a, key, &mut items, 1, 0, None).await;
            assert_eq!(items.len(), 1);
            assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);

            // Drain remaining 2 items in one page
            let (next_cursor, p) =
                super::take_hash_overflow_page(&scope_a, key, cursor, 2, None).await.expect("take exhausted page");
            assert_eq!(p.len(), 2);
            // Since buffer is now empty AND followup_cursor == 0, cursor is NOT retained
            assert_eq!(next_cursor, 0);

            // Session has been evicted from registry on exhaustion
            assert!(!super::collection_overflow_sessions().lock().await.entries.contains_key(&cursor));
            assert!(super::take_hash_overflow_page(&scope_a, key, cursor, 1, None).await.is_none());
            assert!(super::take_collection_scan_cursor(
                &scope_a,
                key,
                cursor,
                super::RedisCollectionOverflowKind::Hash,
                None,
            )
            .await
            .is_err());
        }

        // 4. Expiration behavior (TTL purge)
        {
            let key = b"direct-expiration-hash";
            let mut items: Vec<RedisHashItem> = (0..3)
                .map(|i| RedisHashItem {
                    field: text_blob(&format!("fe{i}")),
                    value: text_blob(&format!("ve{i}")),
                    field_ttl: None,
                })
                .collect();

            let cursor = super::store_hash_overflow_page(&scope_a, key, &mut items, 1, 0, None).await;
            assert!(super::collection_overflow_sessions().lock().await.entries.contains_key(&cursor));

            // Force expiration by winding last_used back past TTL
            super::collection_overflow_sessions().lock().await.entries.get_mut(&cursor).unwrap().last_used =
                std::time::Instant::now() - super::COLLECTION_OVERFLOW_SESSION_TTL - std::time::Duration::from_secs(1);

            // take_matching purges expired entries
            assert!(super::take_hash_overflow_page(&scope_a, key, cursor, 1, None).await.is_none());
            assert!(!super::collection_overflow_sessions().lock().await.entries.contains_key(&cursor));
            assert!(super::take_collection_scan_cursor(
                &scope_a,
                key,
                cursor,
                super::RedisCollectionOverflowKind::Hash,
                None,
            )
            .await
            .is_err());
        }
    }

    /// Replays standalone-Redis pagination for sets (issue #12640 sibling collection):
    /// a large set is read through get_value_scoped, then paged through load_more_collection_scoped.
    /// Every member must arrive exactly once, foreign scopes must be rejected without server scan,
    /// and pagination terminates cleanly when the collection is exhausted.
    #[tokio::test]
    async fn scoped_set_pagination_walks_large_collections_without_repeating_the_first_page() {
        const MEMBERS: usize = 4000;
        const PAGE: usize = 200;
        let scope = super::RedisOperationScope { connection_id: "issue-12640-standalone-set".to_string(), db: 0 };

        // Real SSCAN cursors: one batch of `PAGE` members per server round trip.
        let mut responses = vec![bulk("set"), RedisRawValue::Int(-1), RedisRawValue::Int(MEMBERS as i64)];
        let pages = MEMBERS.div_ceil(PAGE);
        for page in 0..pages {
            let cursor = if page + 1 == pages { "0".to_string() } else { (page + 1).to_string() };
            let members: Vec<String> =
                (page * PAGE..((page + 1) * PAGE).min(MEMBERS)).map(|index| format!("member:{index}")).collect();
            responses.push(int_scan_response_owned(&cursor, members));
        }
        let mut con = FakeRedisConnection::new(responses);

        let value = super::get_value_scoped(&mut con, b"issue-12640-set", &scope).await.unwrap();
        let RedisValueData::Set { items: mut seen, scan_cursor, total } = value.data else {
            panic!("expected set");
        };
        assert_eq!(total, MEMBERS as u64);
        assert_eq!(seen.len(), PAGE, "the first page defaults to the configured page size");
        let mut cursor = scan_cursor.expect("a 4000-member set must offer a continuation");
        assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START, "the continuation is an overflow session marker");

        // The unscoped path (default scope) must reject the marker without touching the server.
        let mut mismatched = FakeRedisConnection::new(vec![]);
        let error = super::load_more_collection(&mut mismatched, b"issue-12640-set", "set", cursor, PAGE, None, None)
            .await
            .unwrap_err();
        assert!(error.contains("invalid, expired"), "{error}");
        assert!(mismatched.commands.is_empty(), "foreign cursor must not reach the server");

        // Foreign connection id must also be rejected without touching the server.
        let foreign_scope = super::RedisOperationScope { connection_id: "foreign-conn".to_string(), db: 0 };
        let mut wrong = FakeRedisConnection::new(vec![]);
        let error = super::load_more_collection_scoped(
            &mut wrong,
            b"issue-12640-set",
            "set",
            cursor,
            PAGE,
            None,
            None,
            &foreign_scope,
        )
        .await
        .unwrap_err();
        assert!(error.contains("invalid, expired"), "{error}");
        assert!(wrong.commands.is_empty());

        // Foreign database must also be rejected without touching the server.
        let foreign_db = super::RedisOperationScope { connection_id: scope.connection_id.clone(), db: 1 };
        let error = super::load_more_collection_scoped(
            &mut wrong,
            b"issue-12640-set",
            "set",
            cursor,
            PAGE,
            None,
            None,
            &foreign_db,
        )
        .await
        .unwrap_err();
        assert!(error.contains("invalid, expired"), "{error}");
        assert!(wrong.commands.is_empty());

        // Mismatched collection type must be rejected without touching the server.
        let error = super::load_more_collection_scoped(
            &mut wrong,
            b"issue-12640-set",
            "hash",
            cursor,
            PAGE,
            None,
            None,
            &scope,
        )
        .await
        .unwrap_err();
        assert!(error.contains("different collection type") || error.contains("invalid, expired"), "{error}");
        assert!(wrong.commands.is_empty());

        let mut pages_seen = 1;
        while cursor != 0 {
            let page = super::load_more_collection_scoped(
                &mut con,
                b"issue-12640-set",
                "set",
                cursor,
                PAGE,
                None,
                None,
                &scope,
            )
            .await
            .unwrap();
            let RedisCollectionPage::Set { items, scan_cursor: next } = page else {
                panic!("expected set");
            };
            seen.extend(items);
            pages_seen += 1;
            assert!(pages_seen <= pages, "pagination must terminate");
            match next {
                Some(next) => {
                    assert_ne!(next, cursor, "each page must continue with a fresh marker");
                    cursor = next;
                }
                None => break,
            }
        }

        assert_eq!(pages_seen, pages);
        assert_eq!(seen.len(), MEMBERS);
        let unique: std::collections::HashSet<_> = seen.iter().map(|item| item.member.raw_base64.clone()).collect();
        assert_eq!(unique.len(), MEMBERS, "every member arrives exactly once");
        assert_eq!(con.command_count("SSCAN"), pages);
    }

    #[tokio::test]
    async fn concurrent_collection_overflow_sessions_isolate_across_scopes_and_keys() {
        let scope_1 = super::RedisOperationScope { connection_id: "conn-prod".to_string(), db: 0 };
        let scope_2 = super::RedisOperationScope { connection_id: "conn-staging".to_string(), db: 0 };
        let scope_3 = super::RedisOperationScope { connection_id: "conn-prod".to_string(), db: 1 };
        let unscoped = super::RedisOperationScope::default();

        let mut hash_items_1: Vec<RedisHashItem> = (0..4)
            .map(|i| RedisHashItem {
                field: text_blob(&format!("p_f{i}")),
                value: text_blob(&format!("p_v{i}")),
                field_ttl: None,
            })
            .collect();
        let mut hash_items_2: Vec<RedisHashItem> = (0..4)
            .map(|i| RedisHashItem {
                field: text_blob(&format!("s_f{i}")),
                value: text_blob(&format!("s_v{i}")),
                field_ttl: None,
            })
            .collect();
        let mut set_items_3: Vec<RedisSetItem> =
            (0..4).map(|i| RedisSetItem { member: text_blob(&format!("db1_m{i}")) }).collect();

        // All 3 use key b"shared-name", but have different scopes or kinds!
        let key = b"shared-name";
        let c1 = super::store_hash_overflow_page(&scope_1, key, &mut hash_items_1, 1, 101, None).await;
        let c2 = super::store_hash_overflow_page(&scope_2, key, &mut hash_items_2, 1, 202, None).await;
        let c3 = super::store_set_overflow_page(&scope_3, key, &mut set_items_3, 1, 303, None).await;

        // Distinct session cursors allocated
        assert_ne!(c1, c2);
        assert_ne!(c1, c3);
        assert_ne!(c2, c3);

        // Cross-scope and cross-kind isolation:
        // Session 1 (scope_1, Hash) cannot be consumed by scope_2, scope_3, unscoped, or as Set
        assert!(super::take_hash_overflow_page(&scope_2, key, c1, 1, None).await.is_none());
        assert!(super::take_hash_overflow_page(&scope_3, key, c1, 1, None).await.is_none());
        assert!(super::take_hash_overflow_page(&unscoped, key, c1, 1, None).await.is_none());
        assert!(super::take_set_overflow_page(&scope_1, key, c1, 1, None).await.is_none());

        // Session 2 (scope_2, Hash) cannot be consumed by scope_1, scope_3, unscoped, or as Set
        assert!(super::take_hash_overflow_page(&scope_1, key, c2, 1, None).await.is_none());
        assert!(super::take_hash_overflow_page(&scope_3, key, c2, 1, None).await.is_none());
        assert!(super::take_hash_overflow_page(&unscoped, key, c2, 1, None).await.is_none());
        assert!(super::take_set_overflow_page(&scope_2, key, c2, 1, None).await.is_none());

        // Session 3 (scope_3, Set) cannot be consumed by scope_1, scope_2, unscoped, or as Hash
        assert!(super::take_set_overflow_page(&scope_1, key, c3, 1, None).await.is_none());
        assert!(super::take_set_overflow_page(&scope_2, key, c3, 1, None).await.is_none());
        assert!(super::take_set_overflow_page(&unscoped, key, c3, 1, None).await.is_none());
        assert!(super::take_hash_overflow_page(&scope_3, key, c3, 1, None).await.is_none());

        // Valid interleaved page consumption:
        let (_, p1_a) = super::take_hash_overflow_page(&scope_1, key, c1, 1, None).await.unwrap();
        assert_eq!(p1_a[0].field, text_blob("p_f1"));

        let (_, p2_a) = super::take_hash_overflow_page(&scope_2, key, c2, 1, None).await.unwrap();
        assert_eq!(p2_a[0].field, text_blob("s_f1"));

        let (_, p3_a) = super::take_set_overflow_page(&scope_3, key, c3, 1, None).await.unwrap();
        assert_eq!(p3_a[0].member, text_blob("db1_m1"));

        // Drain the rest of session 1
        let (_, p1_b) = super::take_hash_overflow_page(&scope_1, key, c1, 2, None).await.unwrap();
        assert_eq!(p1_b.len(), 2);
        assert_eq!(p1_b[0].field, text_blob("p_f2"));
        assert_eq!(p1_b[1].field, text_blob("p_f3"));

        // Session 1 buffer is drained; transition to server scan cursor
        let (srv1, _) =
            super::take_collection_scan_cursor(&scope_1, key, c1, super::RedisCollectionOverflowKind::Hash, None)
                .await
                .unwrap();
        assert_eq!(srv1, 101);

        // Session 2 and Session 3 are still intact and can continue
        let (_, p2_b) = super::take_hash_overflow_page(&scope_2, key, c2, 2, None).await.unwrap();
        assert_eq!(p2_b.len(), 2);
        assert_eq!(p2_b[0].field, text_blob("s_f2"));
        assert_eq!(p2_b[1].field, text_blob("s_f3"));
        let (srv2, _) =
            super::take_collection_scan_cursor(&scope_2, key, c2, super::RedisCollectionOverflowKind::Hash, None)
                .await
                .unwrap();
        assert_eq!(srv2, 202);

        let (_, p3_b) = super::take_set_overflow_page(&scope_3, key, c3, 2, None).await.unwrap();
        assert_eq!(p3_b.len(), 2);
        assert_eq!(p3_b[0].member, text_blob("db1_m2"));
        assert_eq!(p3_b[1].member, text_blob("db1_m3"));
        let (srv3, _) =
            super::take_collection_scan_cursor(&scope_3, key, c3, super::RedisCollectionOverflowKind::Set, None)
                .await
                .unwrap();
        assert_eq!(srv3, 303);
    }

    #[test]
    fn collection_overflow_sessions_capacity_and_lru_eviction() {
        let mut sessions = super::RedisCollectionOverflowSessions::default();
        let scope = super::RedisOperationScope { connection_id: "capacity-test".to_string(), db: 0 };

        let mut cursors = Vec::new();
        for i in 0..super::COLLECTION_OVERFLOW_SESSION_LIMIT {
            let session = super::RedisCollectionOverflowSession {
                scope: scope.clone(),
                key: format!("key-{i}").into_bytes(),
                kind: super::RedisCollectionOverflowKind::Hash,
                filter: None,
                sort_direction: None,
                followup_cursor: 0,
                items: super::RedisCollectionOverflowItems::Hash(vec![]),
                last_used: std::time::Instant::now(),
            };
            let cursor = sessions.insert(session);
            cursors.push(cursor);
        }

        assert_eq!(sessions.entries.len(), super::COLLECTION_OVERFLOW_SESSION_LIMIT);

        // Mark the first cursor as oldest
        let oldest_cursor = cursors[0];
        sessions.entries.get_mut(&oldest_cursor).unwrap().last_used =
            std::time::Instant::now() - std::time::Duration::from_secs(60);

        // Inserting the 129th session must evict the oldest cursor
        let extra_session = super::RedisCollectionOverflowSession {
            scope: scope.clone(),
            key: b"extra-key".to_vec(),
            kind: super::RedisCollectionOverflowKind::Hash,
            filter: None,
            sort_direction: None,
            followup_cursor: 0,
            items: super::RedisCollectionOverflowItems::Hash(vec![]),
            last_used: std::time::Instant::now(),
        };
        let extra_cursor = sessions.insert(extra_session);

        assert_eq!(sessions.entries.len(), super::COLLECTION_OVERFLOW_SESSION_LIMIT);
        assert!(!sessions.entries.contains_key(&oldest_cursor));
        assert!(sessions
            .take_matching(oldest_cursor, &scope, b"key-0", super::RedisCollectionOverflowKind::Hash, None, None)
            .is_none());

        assert!(sessions.entries.contains_key(&extra_cursor));
        assert!(sessions
            .take_matching(extra_cursor, &scope, b"extra-key", super::RedisCollectionOverflowKind::Hash, None, None)
            .is_some());
    }

    #[tokio::test]
    #[ignore = "requires approved disposable Valkey multi-DB, default-one and Redis cluster fixtures"]
    async fn cluster_databases_live_native_mapped_and_permission_controls() {
        let mut config = redis_test_connection_config();
        config.host = "127.0.0.1".to_string();
        config.port =
            std::env::var("DBX_TEST_VALKEY_CLUSTER_PORT").expect("DBX_TEST_VALKEY_CLUSTER_PORT").parse().unwrap();
        config.username.clear();
        config.password.clear();
        let pool = super::connect_cluster(&config).await.unwrap();
        assert!(pool.database_connections.lock().await.is_empty());
        let databases = super::list_cluster_databases(&pool).await.unwrap();
        assert_eq!(databases.iter().map(|database| database.db).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        assert!(databases.iter().all(|database| database.keys.is_some()));
        assert!(
            pool.database_connections.lock().await.is_empty(),
            "listing must not create one cluster connection per database"
        );
        let mut keys = Vec::new();
        for (index, range) in pool.slot_ranges.iter().enumerate() {
            let key = (0..100_000)
                .map(|candidate| format!("dbx1271:driver-live:{}:{index}:{candidate}", std::process::id()))
                .find(|key| (range.start..=range.end).contains(&redis_cluster_slot(key.as_bytes())))
                .unwrap();
            for db in [0, 1] {
                let mut con = super::cluster_key_connection_in_db(&pool, key.as_bytes(), db).await.unwrap();
                redis::cmd("SET")
                    .arg(&key)
                    .arg(format!("db{db}:master{index}"))
                    .query_async::<()>(&mut con)
                    .await
                    .unwrap();
            }
            keys.push(key);
        }
        assert_eq!(keys.len(), 3);
        assert_eq!(pool.database_connections.lock().await.len(), 1);
        let cold = super::connect_cluster(&config).await.unwrap();
        super::list_cluster_databases(&cold).await.unwrap();
        assert!(cold.database_connections.lock().await.is_empty());
        let cold_ref = &cold;
        let cold_values = futures_util::future::join_all(keys.iter().map(|key| async move {
            let mut con = super::cluster_key_connection_in_db(cold_ref, key.as_bytes(), 1).await.unwrap();
            redis::cmd("GET").arg(key).query_async::<String>(&mut con).await.unwrap()
        }))
        .await;
        for (index, value) in cold_values.iter().enumerate() {
            assert_eq!(value, &format!("db1:master{index}"));
        }
        assert_eq!(cold.database_connections.lock().await.len(), 1);
        for (index, key) in keys.iter().enumerate() {
            for _ in 0..10 {
                let pool_ref = &pool;
                let read = |db| async move {
                    let mut con = super::cluster_key_connection_in_db(pool_ref, key.as_bytes(), db).await.unwrap();
                    redis::cmd("GET").arg(key).query_async::<String>(&mut con).await.unwrap()
                };
                let (zero, one) = tokio::join!(read(0), read(1));
                assert_eq!(zero, format!("db0:master{index}"));
                assert_eq!(one, format!("db1:master{index}"));
            }
        }
        let forwarded_port: u16 =
            std::env::var("DBX_TEST_VALKEY_FORWARDED_PORT").expect("DBX_TEST_VALKEY_FORWARDED_PORT").parse().unwrap();
        let routes = pool
            .node_routes
            .iter()
            .map(|route| RedisNodeRoute {
                advertised: route.advertised.clone(),
                connect: RedisNodeEndpoint {
                    host: "127.0.0.1".to_string(),
                    port: forwarded_port + route.advertised.port - config.port,
                },
            })
            .collect::<Vec<_>>();
        let mapped = super::connect_routed_cluster(
            &config,
            routes.clone(),
            pool.slot_ranges.clone(),
            routes,
            super::RedisClusterAuth { username: String::new(), password: String::new() },
        )
        .await
        .unwrap();
        let mapped_databases = super::list_cluster_databases(&mapped).await.unwrap();
        assert_eq!(mapped_databases.len(), 4);
        for (index, key) in keys.iter().enumerate() {
            let mut con = super::cluster_key_connection_in_db(&mapped, key.as_bytes(), 1).await.unwrap();
            assert_eq!(
                redis::cmd("GET").arg(key).query_async::<String>(&mut con).await.unwrap(),
                format!("db1:master{index}")
            );
        }
        for db in [0, 1] {
            let mut cursor = 0;
            let mut found = Vec::new();
            loop {
                let page = super::scan_cluster_keys_batch_in_db(
                    &mapped,
                    db,
                    cursor,
                    &format!("dbx1271:driver-live:{}:*", std::process::id()),
                    100,
                    3,
                    false,
                )
                .await
                .unwrap();
                found.extend(page.keys);
                cursor = page.cursor;
                if cursor == 0 {
                    break;
                }
            }
            assert_eq!(found.len(), 3);
        }
        let pattern = format!("dbx1271:driver-live:{}:*", std::process::id());
        let mut cursor = 0;
        let mut found = Vec::new();
        loop {
            let page = super::scan_cluster_values_page_in_db(&mapped, 1, cursor, &pattern, "db1:master", false, 100)
                .await
                .unwrap();
            assert_eq!(Some(page.total_keys), mapped_databases[1].keys);
            found.extend(page.keys);
            cursor = page.cursor;
            if cursor == 0 {
                break;
            }
            assert!(super::scan_cluster_values_page_in_db(&mapped, 0, cursor, &pattern, "db1:master", false, 100)
                .await
                .is_err());
        }
        assert_eq!(found.len(), 3);
        let mut denied_config = config.clone();
        denied_config.username = "dbx1271-no-config".to_string();
        denied_config.password = "dbx1271-fixture-only".to_string();
        let denied = super::connect_cluster(&denied_config).await.unwrap();
        assert_eq!(super::list_cluster_databases(&denied).await.unwrap().len(), 1);
        let diagnostic = super::cluster_database_diagnostic(&denied).await.unwrap();
        assert!(is_redis_command_denied_error(&diagnostic), "{diagnostic}");
        let mut con = super::cluster_key_connection_in_db(&denied, keys[0].as_bytes(), 0).await.unwrap();
        assert_eq!(redis::cmd("GET").arg(&keys[0]).query_async::<String>(&mut con).await.unwrap(), "db0:master0");
        assert!(super::ensure_cluster_database(&denied, 1).await.unwrap_err().contains("CONFIG"));
        for variable in ["DBX_TEST_VALKEY_DEFAULT_CLUSTER_PORT", "DBX_TEST_REDIS_CONTROL_CLUSTER_PORT"] {
            let mut control_config = config.clone();
            control_config.port = std::env::var(variable).expect(variable).parse().unwrap();
            let control = super::connect_cluster(&control_config).await.unwrap();
            assert_eq!(super::list_cluster_databases(&control).await.unwrap().len(), 1);
            assert!(super::ensure_cluster_database(&control, 1).await.is_err());
            super::cluster_any_connection_in_db(&control, 0).await.unwrap();
        }
        for db in [0, 1] {
            for key in &keys {
                let mut con = super::cluster_key_connection_in_db(&pool, key.as_bytes(), db).await.unwrap();
                redis::cmd("DEL").arg(key).query_async::<u64>(&mut con).await.unwrap();
            }
        }
    }

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
            cmd: &'a Pipeline,
            _offset: usize,
            count: usize,
        ) -> RedisFuture<'a, Vec<RedisRawValue>> {
            self.commands.push(String::from_utf8_lossy(&cmd.get_packed_pipeline()).into_owned());
            let responses = (0..count)
                .map(|_| self.responses.pop_front().unwrap_or(Ok(RedisRawValue::Nil)))
                .collect::<redis::RedisResult<Vec<_>>>();
            Box::pin(async move { responses })
        }

        fn get_db(&self) -> i64 {
            0
        }
    }

    struct TrackedRedisConnection {
        responses: VecDeque<redis::RedisResult<RedisRawValue>>,
        commands: Arc<StdMutex<Vec<String>>>,
    }

    impl TrackedRedisConnection {
        fn new(responses: Vec<RedisRawValue>, commands: Arc<StdMutex<Vec<String>>>) -> Self {
            Self { responses: responses.into_iter().map(Ok).collect(), commands }
        }
    }

    impl ConnectionLike for TrackedRedisConnection {
        fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, RedisRawValue> {
            self.commands.lock().unwrap().push(String::from_utf8_lossy(&cmd.get_packed_command()).into_owned());
            let response = self.responses.pop_front().unwrap_or(Ok(RedisRawValue::Nil));
            Box::pin(async move { response })
        }

        fn req_packed_commands<'a>(
            &'a mut self,
            cmd: &'a Pipeline,
            _offset: usize,
            count: usize,
        ) -> RedisFuture<'a, Vec<RedisRawValue>> {
            self.commands.lock().unwrap().push(String::from_utf8_lossy(&cmd.get_packed_pipeline()).into_owned());
            let responses = (0..count)
                .map(|_| self.responses.pop_front().unwrap_or(Ok(RedisRawValue::Nil)))
                .collect::<redis::RedisResult<Vec<_>>>();
            Box::pin(async move { responses })
        }

        fn get_db(&self) -> i64 {
            0
        }
    }

    fn tracked_command_count(commands: &Arc<StdMutex<Vec<String>>>, command: &str) -> usize {
        let needle = format!("\r\n{command}\r\n");
        commands.lock().unwrap().iter().filter(|packed| packed.contains(&needle)).count()
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

    fn hscan_response_owned(cursor: &str, pairs: Vec<(String, String)>) -> RedisRawValue {
        let entries = pairs.into_iter().flat_map(|(field, value)| [bulk(&field), bulk(&value)]).collect();
        RedisRawValue::Array(vec![bulk(cursor), RedisRawValue::Array(entries)])
    }

    fn int_scan_response_owned(cursor: &str, members: Vec<String>) -> RedisRawValue {
        RedisRawValue::Array(vec![
            bulk(cursor),
            RedisRawValue::Array(members.into_iter().map(|member| bulk(&member)).collect()),
        ])
    }

    fn httl_response(count: usize, ttl: i64) -> RedisRawValue {
        RedisRawValue::Array((0..count).map(|_| RedisRawValue::Int(ttl)).collect())
    }

    fn zrange_response(pairs: Vec<(&str, &str)>) -> RedisRawValue {
        RedisRawValue::Array(pairs.into_iter().flat_map(|(member, score)| [bulk(member), bulk(score)]).collect())
    }

    fn noperm(command: &str) -> redis::RedisError {
        redis::parse_redis_value(
            format!("-NOPERM this user has no permissions to run the '{command}' command\r\n").as_bytes(),
        )
        .unwrap()
        .extract_error()
        .unwrap_err()
    }

    #[test]
    fn parsed_server_errors_preserve_compatibility_classification() {
        let error =
            |response: &str| redis::parse_redis_value(response.as_bytes()).unwrap().extract_error().unwrap_err();
        let unknown_select = error("-ERR unknown command 'SELECT'\r\n");
        assert!(super::is_unavailable_db_zero_select(&unknown_select, 0));
        assert!(!super::is_unavailable_db_zero_select(&unknown_select, 1));
        assert!(super::is_unsupported_keepttl_error(&error("-ERR syntax error\r\n")));
        for response in [
            "-NOPERM unknown command SELECT syntax error\r\n",
            "-WRONGPASS syntax error\r\n",
            "-READONLY syntax error\r\n",
            "-WRONGTYPE syntax error\r\n",
        ] {
            let error = error(response);
            assert!(!super::is_unavailable_db_zero_select(&error, 0));
            assert!(!super::is_unsupported_keepttl_error(&error));
        }
        let denied_ping = noperm("ping").to_string();
        assert!(super::is_redis_command_denied_error(&denied_ping));
        assert!(!super::is_redis_auth_error(&denied_ping));
        assert!(super::is_redis_auth_error(&error("-WRONGPASS invalid username-password pair\r\n").to_string()));
        assert!(super::is_hash_field_update_acl_compatibility_error(&noperm("eval")));
        assert!(!super::is_hash_field_update_acl_compatibility_error(&noperm("unrelated")));
    }

    #[tokio::test]
    async fn connection_keeps_dbx_deadline_and_allows_slow_responses() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            // A valid handshake slower than redis-rs 1.x's new 1-second default.
            tokio::time::sleep(Duration::from_millis(1100)).await;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let count: usize = line.trim().strip_prefix('*').unwrap().parse().unwrap();
                let mut args = Vec::new();
                for _ in 0..count {
                    line.clear();
                    reader.read_line(&mut line).await.unwrap();
                    let len: usize = line.trim().strip_prefix('$').unwrap().parse().unwrap();
                    let mut arg = vec![0; len + 2];
                    reader.read_exact(&mut arg).await.unwrap();
                    arg.truncate(len);
                    args.push(arg);
                }
                if args[0] == b"GET" {
                    // Commands may legitimately exceed the new 500-ms default.
                    tokio::time::sleep(Duration::from_millis(650)).await;
                    writer.write_all(b"$3\r\n\x00\xffA\r\n").await.unwrap();
                    break;
                }
                writer.write_all(if args[0] == b"PING" { b"+PONG\r\n" } else { b"+OK\r\n" }).await.unwrap();
            }
        });
        let mut con = super::connect(&format!("redis://{address}"), Duration::from_secs(3)).await.unwrap();
        let value: Vec<u8> =
            tokio::time::timeout(Duration::from_secs(3), redis::cmd("GET").arg("slow").query_async(&mut con))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(value, b"\x00\xffA");
        server.await.unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let error = super::connect(&format!("redis://{}", listener.local_addr().unwrap()), Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(error.contains("connection timed out"));
    }

    #[derive(Clone, Copy)]
    enum ClusterDelayStage {
        Setup,
        Slots,
        Ping,
    }

    // Unlike the sequential Sentinel/standalone mocks, cluster discovery opens
    // multiple sockets. Keep their tasks owned so aborting the server closes all
    // sockets, including a deliberately delayed response after client timeout.
    async fn cluster_timeout_mock(
        stage: ClusterDelayStage,
        delay: Duration,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let slots_seen = Arc::new(AtomicUsize::new(0));
        let pings_after_slots = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let slots_seen = slots_seen.clone();
                        let pings_after_slots = pings_after_slots.clone();
                        connections.spawn(async move {
                            let (reader, mut writer) = stream.into_split();
                            let mut reader = BufReader::new(reader);
                            let mut first = true;
                            let mut ping_count = 0;
                            loop {
                                let mut line = String::new();
                                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                                    break;
                                }
                                let count: usize = line.trim().strip_prefix('*').unwrap().parse().unwrap();
                                let mut args = Vec::new();
                                for _ in 0..count {
                                    line.clear();
                                    reader.read_line(&mut line).await.unwrap();
                                    let len: usize = line.trim().strip_prefix('$').unwrap().parse().unwrap();
                                    let mut arg = vec![0; len + 2];
                                    reader.read_exact(&mut arg).await.unwrap();
                                    arg.truncate(len);
                                    args.push(arg);
                                }
                                let is_slots = args[0] == b"CLUSTER" && args[1] == b"SLOTS";
                                if args[0] == b"PING" {
                                    ping_count += 1;
                                }
                                let should_delay = match stage {
                                    ClusterDelayStage::Setup => first,
                                    ClusterDelayStage::Slots => is_slots && slots_seen.load(Ordering::SeqCst) == 0,
                                    // With this one-node topology redis-rs sends PING
                                    // on connect, then checks the reused socket after
                                    // CLUSTER SLOTS. The third PING is the DBX probe.
                                    ClusterDelayStage::Ping => args[0] == b"PING"
                                        && ping_count > 2
                                        && slots_seen.load(Ordering::SeqCst) > 0
                                        && pings_after_slots.fetch_add(1, Ordering::SeqCst) == 0,
                                };
                                first = false;
                                if should_delay {
                                    tokio::time::sleep(delay).await;
                                }
                                let response = if is_slots {
                                    slots_seen.fetch_add(1, Ordering::SeqCst);
                                    format!("*1\r\n*3\r\n:0\r\n:16383\r\n*2\r\n$9\r\n127.0.0.1\r\n:{}\r\n", address.port())
                                } else if args[0] == b"PING" {
                                    "+PONG\r\n".to_string()
                                } else {
                                    "+OK\r\n".to_string()
                                };
                                if writer.write_all(response.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                        });
                    }
                    finished = connections.join_next(), if !connections.is_empty() => {
                        finished.unwrap().unwrap();
                    }
                }
            }
        });
        (address, server)
    }

    async fn cluster_connect_with_delay(
        stage: ClusterDelayStage,
        delay: Duration,
        timeout_secs: u64,
    ) -> Result<(), String> {
        let (address, server) = cluster_timeout_mock(stage, delay).await;
        let mut config = redis_test_connection_config();
        config.host = address.ip().to_string();
        config.port = address.port();
        config.password = "test-only".to_string();
        config.connect_timeout_secs = timeout_secs;
        let result = tokio::time::timeout(Duration::from_secs(20), super::connect_cluster(&config)).await;
        server.abort();
        let _ = server.await;
        result.expect("cluster regression exceeded its test deadline").map(|_| ())
    }

    #[tokio::test]
    async fn cluster_connect_honors_configured_handshake_timeout() {
        cluster_connect_with_delay(ClusterDelayStage::Setup, Duration::from_millis(1500), 30).await.unwrap();
    }

    #[tokio::test]
    async fn cluster_connect_honors_configured_initialization_timeout() {
        cluster_connect_with_delay(ClusterDelayStage::Slots, Duration::from_millis(5500), 30).await.unwrap();
    }

    #[tokio::test]
    async fn cluster_connect_honors_configured_ping_timeout() {
        cluster_connect_with_delay(ClusterDelayStage::Ping, Duration::from_millis(5500), 30).await.unwrap();
    }

    #[tokio::test]
    async fn cluster_connect_rejects_initialization_over_configured_timeout() {
        let error =
            cluster_connect_with_delay(ClusterDelayStage::Slots, Duration::from_millis(1500), 1).await.unwrap_err();
        assert_eq!(error, "Redis cluster connection timed out (1s)");
    }

    #[tokio::test]
    async fn cluster_connect_uses_effective_timeout_for_unset_and_oversized_values() {
        for timeout in [0, u64::MAX] {
            cluster_connect_with_delay(ClusterDelayStage::Setup, Duration::from_millis(1500), timeout).await.unwrap();
        }
    }

    #[tokio::test]
    async fn cluster_connect_rejects_ping_over_configured_timeout() {
        let error =
            cluster_connect_with_delay(ClusterDelayStage::Ping, Duration::from_millis(1500), 1).await.unwrap_err();
        assert_eq!(error, "Redis cluster ping timed out (1s)");
    }

    #[derive(Clone, Copy)]
    enum MetadataReply {
        Answer,
        Deny,
        /// Accept the command and keep the socket open without ever answering it.
        Silent,
    }

    /// Minimal RESP server for the standalone database-list probes: it answers the
    /// connection handshake and `PING`, and follows the script for the two metadata
    /// commands.
    async fn database_list_mock(
        config: MetadataReply,
        info: MetadataReply,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let count: usize = line.trim().strip_prefix('*').unwrap().parse().unwrap();
                    let mut args = Vec::new();
                    for _ in 0..count {
                        line.clear();
                        reader.read_line(&mut line).await.unwrap();
                        let len: usize = line.trim().strip_prefix('$').unwrap().parse().unwrap();
                        let mut arg = vec![0; len + 2];
                        reader.read_exact(&mut arg).await.unwrap();
                        arg.truncate(len);
                        args.push(arg);
                    }
                    let command = args[0].to_ascii_uppercase();
                    match command.as_slice() {
                        b"PING" => writer.write_all(b"+PONG\r\n").await.unwrap(),
                        b"CONFIG" => match config {
                            MetadataReply::Answer => {
                                writer.write_all(b"*2\r\n$9\r\ndatabases\r\n$1\r\n4\r\n").await.unwrap();
                            }
                            MetadataReply::Deny => {
                                writer
                                    .write_all(b"-NOPERM this user has no permissions to run the 'config' command\r\n")
                                    .await
                                    .unwrap();
                            }
                            MetadataReply::Silent => {
                                tokio::time::sleep(Duration::from_secs(30)).await;
                                break;
                            }
                        },
                        b"INFO" => match info {
                            MetadataReply::Answer => {
                                let keyspace = b"# Keyspace\r\ndb2:keys=5,expires=0,avg_ttl=0\r\n";
                                writer.write_all(format!("${}\r\n", keyspace.len()).as_bytes()).await.unwrap();
                                writer.write_all(keyspace).await.unwrap();
                                writer.write_all(b"\r\n").await.unwrap();
                            }
                            MetadataReply::Deny => {
                                writer
                                    .write_all(b"-NOPERM this user has no permissions to run the 'info' command\r\n")
                                    .await
                                    .unwrap();
                            }
                            MetadataReply::Silent => {
                                tokio::time::sleep(Duration::from_secs(30)).await;
                                break;
                            }
                        },
                        _ => writer.write_all(b"+OK\r\n").await.unwrap(),
                    }
                }
            }
        });
        (address, server)
    }

    #[tokio::test]
    async fn database_list_uses_the_configured_count_with_keyspace_counts() {
        let (address, server) = database_list_mock(MetadataReply::Answer, MetadataReply::Answer).await;
        let mut con = super::connect(&format!("redis://{address}"), Duration::from_secs(3)).await.unwrap();

        let databases = super::list_databases_with_timeout(&mut con, Duration::from_millis(200)).await.unwrap();

        assert_eq!(databases.len(), 4);
        assert_eq!(databases[2].keys, Some(5));
        assert_eq!(databases[0].keys, None);
        server.abort();
    }

    // 既有的降级路径：CONFIG 被改名/拒绝时用 DBX 默认值，键数量仍来自 INFO keyspace。
    #[tokio::test]
    async fn database_list_degrades_when_the_config_probe_is_denied() {
        let (address, server) = database_list_mock(MetadataReply::Deny, MetadataReply::Answer).await;
        let mut con = super::connect(&format!("redis://{address}"), Duration::from_secs(3)).await.unwrap();

        let databases = super::list_databases_with_timeout(&mut con, Duration::from_millis(200)).await.unwrap();

        assert_eq!(databases.len(), 16);
        assert_eq!(databases[2].keys, Some(5));
        server.abort();
    }

    // #12426：服务端/代理不回答 CONFIG 时返回超时错误，而不是让选择器一直等待。
    #[tokio::test]
    async fn database_list_reports_a_timeout_when_the_config_probe_stays_silent() {
        let (address, server) = database_list_mock(MetadataReply::Silent, MetadataReply::Answer).await;
        let mut con = super::connect(&format!("redis://{address}"), Duration::from_secs(3)).await.unwrap();

        let error = super::list_databases_with_timeout(&mut con, Duration::from_millis(200)).await.unwrap_err();

        assert!(error.contains("CONFIG GET databases"), "{error}");
        server.abort();
    }

    // #12426：INFO keyspace 一直不回答时返回超时错误，而不是无限等待。
    #[tokio::test]
    async fn database_list_reports_a_timeout_when_the_keyspace_probe_stays_silent() {
        let (address, server) = database_list_mock(MetadataReply::Answer, MetadataReply::Silent).await;
        let mut con = super::connect(&format!("redis://{address}"), Duration::from_secs(3)).await.unwrap();

        let error = super::list_databases_with_timeout(&mut con, Duration::from_millis(200)).await.unwrap_err();

        assert!(error.contains("INFO keyspace"), "{error}");
        server.abort();
    }

    struct SentinelMockReply {
        command: &'static str,
        response: Vec<u8>,
        delay: Duration,
    }

    impl SentinelMockReply {
        fn immediate(command: &'static str, response: &[u8]) -> Self {
            Self { command, response: response.to_vec(), delay: Duration::ZERO }
        }
    }

    async fn sentinel_mock(
        auth: Option<(&str, &str)>,
        scripts: Vec<Vec<SentinelMockReply>>,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let auth = auth.map(|(username, password)| {
            vec![b"AUTH".to_vec(), username.as_bytes().to_vec(), password.as_bytes().to_vec()]
        });
        let server = tokio::spawn(async move {
            for script in scripts {
                let (stream, _) = listener.accept().await.unwrap();
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                let mut script = VecDeque::from(script);
                let mut authenticated = auth.is_none();
                while !script.is_empty() {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let count: usize = line.trim().strip_prefix('*').unwrap().parse().unwrap();
                    let mut args = Vec::new();
                    for _ in 0..count {
                        line.clear();
                        reader.read_line(&mut line).await.unwrap();
                        let len: usize = line.trim().strip_prefix('$').unwrap().parse().unwrap();
                        let mut arg = vec![0; len + 2];
                        reader.read_exact(&mut arg).await.unwrap();
                        arg.truncate(len);
                        args.push(arg);
                    }
                    match args[0].as_slice() {
                        b"AUTH" => {
                            assert_eq!(Some(&args), auth.as_ref());
                            authenticated = true;
                            writer.write_all(b"+OK\r\n").await.unwrap();
                        }
                        b"CLIENT" => writer.write_all(b"+OK\r\n").await.unwrap(),
                        _ => {
                            assert!(authenticated);
                            let reply = script.pop_front().unwrap();
                            assert_eq!(args[0], reply.command.as_bytes());
                            tokio::time::sleep(reply.delay).await;
                            if !reply.response.is_empty() {
                                writer.write_all(&reply.response).await.unwrap();
                            }
                            // An empty response intentionally drops the socket.
                        }
                    }
                }
            }
        });
        (address, server)
    }

    fn sentinel_masters_response(port: u16) -> Vec<u8> {
        let port = port.to_string();
        let fields = ["name", "dbx1271master", "ip", "127.0.0.1", "port", &port, "flags", "master"];
        let mut response = format!("*1\r\n*{}\r\n", fields.len());
        for field in fields {
            response.push_str(&format!("${}\r\n{}\r\n", field.len(), field));
        }
        response.into_bytes()
    }

    #[tokio::test]
    async fn sentinel_discovery_and_role_keep_dbx_deadline_and_separate_credentials() {
        let role = b"*3\r\n$6\r\nmaster\r\n:0\r\n*0\r\n";
        let (master, master_server) = sentinel_mock(
            Some(("master-user", "master-password")),
            vec![
                vec![SentinelMockReply { command: "ROLE", response: role.to_vec(), delay: Duration::from_millis(650) }],
                vec![SentinelMockReply::immediate("PING", b"+PONG\r\n")],
            ],
        )
        .await;
        let (sentinel, sentinel_server) = sentinel_mock(
            Some(("sentinel-user", "sentinel-password")),
            vec![vec![SentinelMockReply {
                command: "SENTINEL",
                response: sentinel_masters_response(master.port()),
                delay: Duration::from_millis(650),
            }]],
        )
        .await;
        let mut config = redis_test_connection_config();
        config.redis_sentinel_nodes = sentinel.to_string();
        config.redis_sentinel_master = "dbx1271master".to_string();
        config.redis_sentinel_username = "sentinel-user".to_string();
        config.redis_sentinel_password = "sentinel-password".to_string();
        config.username = "master-user".to_string();
        config.password = "master-password".to_string();
        super::connect_sentinel_with_timeout(&config, Duration::from_secs(5)).await.unwrap();
        sentinel_server.await.unwrap();
        master_server.await.unwrap();
    }

    #[tokio::test]
    async fn sentinel_lookup_outer_deadline_is_still_enforced() {
        // The open socket never sends a handshake response.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = redis_test_connection_config();
        config.redis_sentinel_nodes = listener.local_addr().unwrap().to_string();
        config.redis_sentinel_master = "dbx1271master".to_string();
        let error = super::connect_sentinel_with_timeout(&config, Duration::from_millis(30)).await.unwrap_err();
        assert!(error.contains("Redis Sentinel lookup timed out"));
    }

    #[test]
    fn sentinel_master_filter_preserves_service_flags_and_endpoint_validation() {
        let valid: HashMap<String, String> =
            [("name", "service"), ("ip", "127.0.0.1"), ("port", "6379"), ("flags", "master")]
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect();
        assert_eq!(super::sentinel_eligible_master(&valid, "service").unwrap().port, 6379);
        assert!(super::sentinel_eligible_master(&valid, "missing").is_none());
        for (field, value) in [
            ("flags", "slave"),
            ("flags", "master,s_down"),
            ("flags", "master,o_down"),
            ("port", "bad"),
            ("port", "65536"),
        ] {
            let mut metadata = valid.clone();
            metadata.insert(field.to_string(), value.to_string());
            assert!(super::sentinel_eligible_master(&metadata, "service").is_none());
        }
        for field in ["name", "ip", "port", "flags"] {
            let mut metadata = valid.clone();
            metadata.remove(field);
            assert!(super::sentinel_eligible_master(&metadata, "service").is_none());
        }
    }

    #[test]
    fn sentinel_node_options_keep_tls_and_credentials_separate_from_master() {
        let mut config = redis_test_connection_config();
        config.redis_sentinel_nodes = "sentinel.example:26379".to_string();
        config.redis_sentinel_username = "sentinel-user".to_string();
        config.redis_sentinel_password = "sentinel-secret".to_string();
        config.username = "master-user".to_string();
        config.password = "master-secret".to_string();
        config.ssl = true;
        config.redis_sentinel_tls = false;
        let nodes = super::redis_sentinel_nodes(&config).unwrap();
        assert!(matches!(nodes[0].addr(), ConnectionAddr::Tcp(_, 26379)));
        assert_eq!(nodes[0].redis_settings().username(), Some("sentinel-user"));
        assert_eq!(nodes[0].redis_settings().password(), Some("sentinel-secret"));
        assert_eq!(nodes[0].redis_settings().db(), 0);

        config.ssl = false;
        config.redis_sentinel_tls = true;
        config.url_params = Some("tls_insecure=true".to_string());
        let nodes = super::redis_sentinel_nodes(&config).unwrap();
        assert!(matches!(nodes[0].addr(), ConnectionAddr::TcpTls { insecure: true, .. }));
        assert_eq!(nodes[0].redis_settings().username(), Some("sentinel-user"));
    }

    #[tokio::test]
    async fn sentinel_role_fallback_and_error_priority_match_previous_client() {
        let parsed_error =
            |response: &str| redis::parse_redis_value(response.as_bytes()).unwrap().extract_error().unwrap_err();
        let unknown = || parsed_error("-ERR unknown command 'ROLE'\r\n");
        let primary = RedisRawValue::Array(vec![bulk("master"), RedisRawValue::Int(0), RedisRawValue::Array(vec![])]);
        let replica = RedisRawValue::Array(vec![
            bulk("slave"),
            bulk("127.0.0.1"),
            RedisRawValue::Int(6379),
            bulk("connected"),
            RedisRawValue::Int(0),
        ]);
        let mut con = FakeRedisConnection::new(vec![primary]);
        assert!(super::sentinel_is_master(&mut con).await.unwrap());
        assert_eq!(con.command_count("INFO"), 0);
        let mut con = FakeRedisConnection::new(vec![replica]);
        assert!(!super::sentinel_is_master(&mut con).await.unwrap());
        assert_eq!(con.command_count("INFO"), 0);
        for role in ["master", "slave"] {
            let mut con = FakeRedisConnection::with_results(vec![
                Err(unknown()),
                Ok(bulk(&format!("# Replication\r\nrole:{role}\r\n"))),
            ]);
            assert_eq!(super::sentinel_is_master(&mut con).await.unwrap(), role == "master");
        }
        // The old client also accepts successful INFO after a denied ROLE.
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("role")), Ok(bulk("role:master\r\n"))]);
        assert!(super::sentinel_is_master(&mut con).await.unwrap());
        let mut con = FakeRedisConnection::with_results(vec![Err(unknown()), Err(noperm("info"))]);
        assert!(super::sentinel_is_master(&mut con).await.unwrap_err().detail().unwrap().contains("info"));
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("role")), Err(noperm("info"))]);
        assert!(super::sentinel_is_master(&mut con).await.unwrap_err().detail().unwrap().contains("role"));
        let mut con = FakeRedisConnection::with_results(vec![Err(unknown()), Ok(bulk("# no role\r\n"))]);
        assert!(super::sentinel_is_master(&mut con).await.unwrap_err().to_string().contains("Missing role"));
        let io = redis::RedisError::from(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset"));
        let mut con = FakeRedisConnection::with_results(vec![Err(io), Err(noperm("info"))]);
        assert!(super::sentinel_is_master(&mut con).await.unwrap_err().is_io_error());
    }

    #[tokio::test]
    async fn sentinel_discovery_retries_io_once_and_tries_next_node_on_error() {
        let empty_masters = b"*0\r\n";
        let (first, first_server) = sentinel_mock(
            None,
            vec![
                vec![SentinelMockReply::immediate("SENTINEL", b"")],
                vec![SentinelMockReply::immediate("SENTINEL", b"-NOPERM sentinel denied\r\n")],
            ],
        )
        .await;
        let (second, second_server) =
            sentinel_mock(None, vec![vec![SentinelMockReply::immediate("SENTINEL", empty_masters)]]).await;
        let nodes = [first, second]
            .into_iter()
            .map(|node| connection_info("127.0.0.1", node.port(), false, false, "", "", 0).unwrap())
            .collect::<Vec<_>>();
        assert!(super::sentinel_masters(&nodes, None).await.unwrap().is_empty());
        first_server.await.unwrap();
        second_server.await.unwrap();
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
        redis_value(
            "string",
            RedisValueData::String {
                content: text_blob(value),
                total_bytes: Some(value.len() as u64),
                truncated: false,
            },
        )
    }

    fn hash_value(entries: &[(&str, &str)]) -> RedisValue {
        redis_value(
            "hash",
            RedisValueData::Hash {
                items: entries
                    .iter()
                    .map(|(field, value)| RedisHashItem {
                        field: text_blob(field),
                        value: text_blob(value),
                        field_ttl: None,
                    })
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

    #[tokio::test]
    async fn db0_console_command_continues_when_select_is_unavailable() {
        let select_error = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "unknown command 'select', with args beginning with: '0'".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(select_error), Ok(bulk("Ada"))]);

        let result = super::execute_console_command(&mut con, 0, "GET name", false).await.unwrap();

        assert_eq!(result.command, "GET");
        assert_eq!(result.value, serde_json::json!("Ada"));
        assert_eq!(con.command_count("SELECT"), 1);
        assert_eq!(con.command_count("GET"), 1);
    }

    #[tokio::test]
    async fn console_command_keeps_supported_db_zero_selection() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Okay, bulk("Ada")]);

        let result = super::execute_console_command(&mut con, 0, "GET name", false).await.unwrap();

        assert_eq!(result.value, serde_json::json!("Ada"));
        assert_eq!(con.command_count("SELECT"), 1);
        assert_eq!(con.command_count("GET"), 1);
    }

    #[tokio::test]
    async fn console_command_does_not_ignore_unavailable_select_for_nonzero_db() {
        let select_error = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "unknown command 'select', with args beginning with: '1'".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(select_error), Ok(bulk("wrong db"))]);

        let error = super::execute_console_command(&mut con, 1, "GET name", false).await.unwrap_err();

        assert!(error.contains("unknown command"));
        assert_eq!(con.command_count("SELECT"), 1);
        assert_eq!(con.command_count("GET"), 0);
    }

    #[tokio::test]
    async fn console_command_propagates_non_compatibility_select_errors() {
        let errors = vec![
            redis::RedisError::from((
                redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
                "An error was signalled by the server",
                "invalid DB index".to_string(),
            )),
            noperm("SELECT"),
            redis::RedisError::from((redis::ErrorKind::AuthenticationFailed, "Authentication failed")),
            redis::RedisError::from((redis::ErrorKind::Parse, "Invalid response")),
            redis::RedisError::from(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset")),
        ];

        for select_error in errors {
            let mut con = FakeRedisConnection::with_results(vec![Err(select_error), Ok(bulk("must not run"))]);

            assert!(super::execute_console_command(&mut con, 0, "GET name", false).await.is_err());
            assert_eq!(con.command_count("SELECT"), 1);
            assert_eq!(con.command_count("GET"), 0);
        }
    }

    #[tokio::test]
    async fn strict_database_selection_keeps_unavailable_select_error() {
        let select_error = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "unknown command 'select'".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(select_error)]);

        assert!(super::select_db(&mut con, 0).await.is_err());
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
    fn parses_stream_groups_with_binary_names_and_compatible_optional_fields() {
        let raw = RedisRawValue::Array(vec![
            RedisRawValue::Array(vec![
                bulk("name"),
                RedisRawValue::BulkString(vec![0xFF, b'g']),
                bulk("consumers"),
                RedisRawValue::Int(2),
                bulk("pending"),
                bulk("3"),
                bulk("last-delivered-id"),
                bulk("1714470000000-0"),
                bulk("entries-read"),
                RedisRawValue::Int(11),
                bulk("lag"),
                RedisRawValue::Nil,
                bulk("future-field"),
                bulk("ignored"),
            ]),
            RedisRawValue::Array(vec![
                bulk("name"),
                bulk("legacy-group"),
                bulk("consumers"),
                RedisRawValue::Int(0),
                bulk("pending"),
                RedisRawValue::Int(0),
                bulk("last-delivered-id"),
                bulk("0-0"),
            ]),
        ]);

        let parsed = parse_stream_groups(raw);

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, redis_blob_from_bytes(&[0xFF, b'g']));
        assert_eq!(
            parsed[0],
            RedisStreamGroup {
                name: redis_blob_from_bytes(&[0xFF, b'g']),
                consumers: 2,
                pending: 3,
                last_delivered_id: "1714470000000-0".to_string(),
                entries_read: Some(11),
                lag: None,
            }
        );
        assert_eq!(
            parsed[1],
            RedisStreamGroup {
                name: text_blob("legacy-group"),
                consumers: 0,
                pending: 0,
                last_delivered_id: "0-0".to_string(),
                entries_read: None,
                lag: None,
            }
        );
    }

    #[test]
    fn parses_stream_consumers_and_pending_entries() {
        let consumers = parse_stream_consumers(RedisRawValue::Array(vec![
            RedisRawValue::Array(vec![
                bulk("name"),
                bulk("worker-a"),
                bulk("pending"),
                RedisRawValue::Int(4),
                bulk("idle"),
                bulk("1200"),
                bulk("inactive"),
                RedisRawValue::Int(800),
            ]),
            RedisRawValue::Array(vec![
                bulk("name"),
                bulk("legacy-worker"),
                bulk("pending"),
                RedisRawValue::Int(0),
                bulk("idle"),
                RedisRawValue::Int(0),
            ]),
        ]));
        let pending = parse_stream_pending_entries(RedisRawValue::Array(vec![
            RedisRawValue::Array(vec![
                bulk("1714470000000-0"),
                RedisRawValue::BulkString(vec![0xFE, b'c']),
                RedisRawValue::Int(2_400),
                bulk("3"),
            ]),
            RedisRawValue::Array(vec![bulk("malformed")]),
        ]));

        assert_eq!(
            consumers,
            vec![
                RedisStreamConsumer { name: text_blob("worker-a"), pending: 4, idle_ms: 1_200, inactive_ms: Some(800) },
                RedisStreamConsumer { name: text_blob("legacy-worker"), pending: 0, idle_ms: 0, inactive_ms: None },
            ]
        );
        assert_eq!(
            pending,
            vec![RedisStreamPendingEntry {
                id: "1714470000000-0".to_string(),
                consumer: redis_blob_from_bytes(&[0xFE, b'c']),
                idle_ms: 2_400,
                deliveries: 3,
            }]
        );
    }

    #[test]
    fn serializes_stream_metrics_without_losing_javascript_precision() {
        let unsafe_value = super::JS_MAX_SAFE_INTEGER + 1;
        let group = RedisStreamGroup {
            name: text_blob("payments"),
            consumers: unsafe_value,
            pending: 2,
            last_delivered_id: "1714470000000-0".to_string(),
            entries_read: Some(unsafe_value),
            lag: None,
        };
        let consumer = RedisStreamConsumer {
            name: text_blob("worker-a"),
            pending: 2,
            idle_ms: unsafe_value,
            inactive_ms: Some(unsafe_value),
        };
        let entry = RedisStreamPendingEntry {
            id: "1714470000000-0".to_string(),
            consumer: text_blob("worker-a"),
            idle_ms: 2,
            deliveries: unsafe_value,
        };

        let group_json = serde_json::to_value(group).unwrap();
        let consumer_json = serde_json::to_value(consumer).unwrap();
        let entry_json = serde_json::to_value(entry).unwrap();

        assert_eq!(group_json["consumers"], unsafe_value.to_string());
        assert_eq!(group_json["pending"].as_u64(), Some(2));
        assert_eq!(group_json["entries_read"], unsafe_value.to_string());
        assert!(group_json.get("lag").is_none());
        assert_eq!(consumer_json["idle_ms"], unsafe_value.to_string());
        assert_eq!(consumer_json["inactive_ms"], unsafe_value.to_string());
        assert_eq!(entry_json["deliveries"], unsafe_value.to_string());
    }

    #[tokio::test]
    async fn string_value_uses_a_bounded_range_for_small_values() {
        let mut con = FakeRedisConnection::new(vec![bulk("string"), RedisRawValue::Int(-1), bulk("hello")]);

        let value = super::get_value(&mut con, b"message").await.unwrap();

        let RedisValueData::String { content, total_bytes, truncated } = &value.data else {
            panic!("expected a String value");
        };
        assert_eq!(redis_blob_display_text(content), "hello");
        assert_eq!(*total_bytes, Some(5));
        assert!(!truncated);
        assert_eq!(con.command_count("GETRANGE"), 1);
        assert_eq!(con.command_count("GET"), 0);
        assert_eq!(con.command_count("STRLEN"), 0);
    }

    #[tokio::test]
    async fn string_value_range_stays_within_the_64kib_server_limit() {
        // Some Redis-compatible servers reject a GETRANGE span above 64 KiB;
        // the old budget + 1 request asked for 65537 bytes (TongRDS answered
        // "0-65537 is out of bounds").
        let mut con = FakeRedisConnection::new(vec![bulk("string"), RedisRawValue::Int(-1), bulk("hello")]);

        super::get_value(&mut con, b"message").await.unwrap();

        let getrange =
            con.commands.iter().find(|packed| packed.contains("\r\nGETRANGE\r\n")).expect("GETRANGE is issued");
        assert!(getrange.contains(&format!("\r\n$5\r\n{}\r\n", super::STRING_PREVIEW_MAX_BYTES - 1)), "{getrange:?}");
        assert!(!getrange.contains(&format!("\r\n$5\r\n{}\r\n", super::STRING_PREVIEW_MAX_BYTES)), "{getrange:?}");
    }

    #[tokio::test]
    async fn string_value_at_the_preview_budget_is_not_flagged_truncated() {
        let payload = vec![b'a'; super::STRING_PREVIEW_MAX_BYTES];
        let mut con = FakeRedisConnection::new(vec![
            bulk("string"),
            RedisRawValue::Int(-1),
            RedisRawValue::BulkString(payload.clone()),
            RedisRawValue::Int(super::STRING_PREVIEW_MAX_BYTES as i64),
        ]);

        let value = super::get_value(&mut con, b"exact").await.unwrap();

        let RedisValueData::String { content, total_bytes, truncated } = &value.data else {
            panic!("expected a String value");
        };
        assert_eq!(*total_bytes, Some(super::STRING_PREVIEW_MAX_BYTES as u64));
        assert!(!truncated);
        let decoded = base64::engine::general_purpose::STANDARD.decode(&content.raw_base64).unwrap();
        assert_eq!(decoded.len(), super::STRING_PREVIEW_MAX_BYTES);
        assert_eq!(con.command_count("GETRANGE"), 1);
        assert_eq!(con.command_count("STRLEN"), 1);
    }

    #[tokio::test]
    async fn string_value_truncates_large_payloads_before_ipc_serialization() {
        let preview_with_sentinel = vec![0xFF; super::STRING_PREVIEW_MAX_BYTES + 1];
        let total_bytes = 45 * 1024 * 1024;
        let mut con = FakeRedisConnection::new(vec![
            bulk("string"),
            RedisRawValue::Int(-1),
            RedisRawValue::BulkString(preview_with_sentinel),
            RedisRawValue::Int(total_bytes as i64),
        ]);

        let value = super::get_value(&mut con, b"bf:ali_health_monitor").await.unwrap();

        let RedisValueData::String { content, total_bytes: reported_bytes, truncated } = &value.data else {
            panic!("expected a String value");
        };
        let preview = base64::engine::general_purpose::STANDARD.decode(&content.raw_base64).unwrap();
        assert_eq!(preview.len(), super::STRING_PREVIEW_MAX_BYTES);
        assert_eq!(*reported_bytes, Some(total_bytes));
        assert!(*truncated);
        assert_eq!(super::redis_search_value_size(&value), total_bytes);
        assert_eq!(con.command_count("GETRANGE"), 1);
        assert_eq!(con.command_count("GET"), 0);
        assert_eq!(con.command_count("STRLEN"), 1);
    }

    #[tokio::test]
    async fn value_preview_limit_controls_the_range_and_exact_boundary() {
        for limit in [1024, 256 * 1024, super::VALUE_PREVIEW_MAX_BYTES] {
            // A short read ends the value: the request spans min(limit, 64 KiB) and the
            // fake answers one byte less, so the total needs no STRLEN round trip.
            let span = limit.min(super::STRING_PREVIEW_MAX_BYTES);
            let size = span - 1;
            let mut con = FakeRedisConnection::new(vec![
                bulk("string"),
                RedisRawValue::Int(-1),
                RedisRawValue::BulkString(vec![b'x'; size]),
            ]);
            let value = super::get_value_scoped_with_preview_limit(
                &mut con,
                b"large",
                &super::RedisOperationScope::default(),
                limit,
            )
            .await
            .unwrap();
            let RedisValueData::String { content, total_bytes, truncated } = value.data else {
                panic!("expected string")
            };
            assert!(!truncated);
            assert_eq!(total_bytes, Some(size as u64));
            assert_eq!(content.raw_base64, base64::engine::general_purpose::STANDARD.encode(vec![b'x'; size]));
            let getrange =
                con.commands.iter().find(|packed| packed.contains("\r\nGETRANGE\r\n")).expect("GETRANGE is issued");
            assert!(getrange.contains(&format!("\r\n{}\r\n", span - 1)), "{getrange:?}");
            assert!(!getrange.contains(&format!("\r\n{}\r\n", span)), "{getrange:?}");
            assert_eq!(con.command_count("GETRANGE"), 1);
            assert_eq!(con.command_count("GET"), 0);
            assert_eq!(con.command_count("STRLEN"), 0);
        }
        // A configured limit above the 64 KiB span cap is fetched in 64 KiB chunks,
        // and filling the budget exactly asks STRLEN for the real size.
        let limit = 128 * 1024;
        let mut con = FakeRedisConnection::new(vec![
            bulk("string"),
            RedisRawValue::Int(-1),
            RedisRawValue::BulkString(vec![0xff; super::STRING_PREVIEW_MAX_BYTES]),
            RedisRawValue::BulkString(vec![0xff; super::STRING_PREVIEW_MAX_BYTES]),
            RedisRawValue::Int(200_000),
        ]);
        let value = super::get_value_scoped_with_preview_limit(
            &mut con,
            b"binary",
            &super::RedisOperationScope::default(),
            limit,
        )
        .await
        .unwrap();
        let RedisValueData::String { content, total_bytes, truncated } = value.data else { panic!("expected string") };
        assert!(truncated);
        assert_eq!(total_bytes, Some(200_000));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(content.raw_base64).unwrap().len(), limit);
        assert_eq!(con.command_count("GETRANGE"), 2);
        assert_eq!(con.command_count("STRLEN"), 1);
    }

    #[tokio::test]
    async fn value_preview_limit_rejects_invalid_sizes_before_redis_io() {
        for limit in [0, 1023, super::VALUE_PREVIEW_MAX_BYTES + 1, usize::MAX] {
            let mut con = FakeRedisConnection::new(vec![]);
            assert!(super::get_value_scoped_with_preview_limit(
                &mut con,
                b"key",
                &super::RedisOperationScope::default(),
                limit,
            )
            .await
            .is_err());
            assert!(con.commands.is_empty());
        }
    }

    #[tokio::test]
    async fn bitmap_preview_uses_the_configured_limit() {
        let mut con = FakeRedisConnection::new(vec![
            bulk("bitmap"),
            RedisRawValue::Int(-1),
            RedisRawValue::BulkString(vec![0x80; 4097]),
            RedisRawValue::Int(4097),
        ]);
        let value = super::get_value_scoped_with_preview_limit(
            &mut con,
            b"bitmap",
            &super::RedisOperationScope::default(),
            4096,
        )
        .await
        .unwrap();
        let RedisValueData::Bitmap { content, total_bytes, truncated, .. } = value.data else {
            panic!("expected bitmap")
        };
        assert!(truncated);
        assert_eq!(total_bytes, None);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(content.raw_base64).unwrap().len(), 4096);
    }

    #[test]
    fn collection_pages_stop_at_the_byte_budget_without_truncating_a_member() {
        fn hash_items(count: usize, value_bytes: usize) -> Vec<RedisHashItem> {
            (0..count)
                .map(|index| RedisHashItem {
                    field: text_blob(&format!("f{index}")),
                    value: text_blob(&"v".repeat(value_bytes)),
                    field_ttl: None,
                })
                .collect()
        }
        fn page_bytes(items: &[RedisHashItem]) -> usize {
            items.iter().map(super::hash_item_page_bytes).sum()
        }

        // Members are sized as a fraction of the budget; base64 inflates them by 4/3 on the wire,
        // so the assertions below are on the resulting page rather than on a hand-computed count.
        for divisor in [2, 3, 8] {
            let items = hash_items(200, super::COLLECTION_PAGE_MAX_BYTES / divisor);
            let page_len = super::budgeted_page_len(&items, 200, super::hash_item_page_bytes);
            assert!((1..200).contains(&page_len), "divisor {divisor}: page_len {page_len}");
            assert!(
                page_bytes(&items[..page_len]) <= super::COLLECTION_PAGE_MAX_BYTES,
                "divisor {divisor} over budget"
            );
            assert!(
                page_bytes(&items[..page_len + 1]) > super::COLLECTION_PAGE_MAX_BYTES,
                "divisor {divisor}: page ended earlier than the budget required"
            );
        }

        // Small members still fill a whole page, and a short input is returned whole.
        let small = hash_items(500, 1);
        assert_eq!(super::budgeted_page_len(&small, 200, super::hash_item_page_bytes), 200);
        assert_eq!(super::budgeted_page_len(&small[..5], 200, super::hash_item_page_bytes), 5);

        // A single member larger than the whole budget still loads, so paging cannot stall.
        let huge = hash_items(3, super::COLLECTION_PAGE_MAX_BYTES * 2);
        assert_eq!(super::budgeted_page_len(&huge, 200, super::hash_item_page_bytes), 1);

        assert_eq!(super::budgeted_page_len::<RedisHashItem>(&[], 200, super::hash_item_page_bytes), 0);
    }

    #[tokio::test]
    async fn hash_value_pages_compact_hscan_before_field_ttls() {
        let pairs = (0..512).map(|index| (format!("field:{index}"), format!("value:{index}"))).collect();
        let mut con = FakeRedisConnection::new(vec![
            bulk("hash"),
            RedisRawValue::Int(-1),
            RedisRawValue::Int(512),
            hscan_response_owned("0", pairs),
            httl_response(super::COLLECTION_PAGE_SIZE, -1),
            httl_response(super::COLLECTION_PAGE_SIZE, -1),
            httl_response(112, -1),
        ]);

        let value = super::get_value(&mut con, b"large-hash").await.unwrap();

        let RedisValueData::Hash { items, total, scan_cursor } = value.data else {
            panic!("expected a Hash value");
        };
        let cursor = scan_cursor.expect("overflow cursor");
        assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);
        assert_eq!(total, 512);
        assert_eq!(items.len(), super::COLLECTION_PAGE_SIZE);
        assert_eq!(redis_blob_display_text(&items[0].field), "field:0");
        assert_eq!(redis_blob_display_text(&items[199].field), "field:199");
        assert!(items.iter().all(|item| item.field_ttl == Some(-1)));
        assert_eq!(con.command_count("HSCAN"), 1);
        assert_eq!(con.command_count("HTTL"), 1);
        let httl_command = con.commands.iter().find(|command| command.contains("\r\nHTTL\r\n")).unwrap();
        assert!(httl_command.contains("\r\nFIELDS\r\n"));
        assert!(httl_command.contains("\r\n200\r\n"));
        assert!(!httl_command.contains("\r\nfield:200\r\n"));

        let second =
            super::load_more_collection(&mut con, b"large-hash", "hash", cursor, 200, None, None).await.unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = second else {
            panic!("expected a Hash page");
        };
        assert_eq!(scan_cursor, Some(cursor));
        assert_eq!(items.len(), 200);
        assert_eq!(redis_blob_display_text(&items[0].field), "field:200");
        assert_eq!(redis_blob_display_text(&items[199].field), "field:399");
        assert_eq!(con.command_count("HSCAN"), 1);
        assert_eq!(con.command_count("HTTL"), 2);

        let third =
            super::load_more_collection(&mut con, b"large-hash", "hash", cursor, 200, None, None).await.unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = third else {
            panic!("expected a Hash page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(items.len(), 112);
        assert_eq!(redis_blob_display_text(&items[0].field), "field:400");
        assert_eq!(redis_blob_display_text(&items[111].field), "field:511");
        assert_eq!(con.command_count("HSCAN"), 1);
        assert_eq!(con.command_count("HTTL"), 3);
    }

    #[tokio::test]
    async fn large_hash_value_stays_bounded_when_httl_is_unsupported() {
        let pairs = (0..512).map(|index| (format!("field:{index}"), format!("value:{index}"))).collect();
        let unsupported = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "unknown command 'HTTL'".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(bulk("hash")),
            Ok(RedisRawValue::Int(-1)),
            Ok(RedisRawValue::Int(512)),
            Ok(hscan_response_owned("0", pairs)),
            Err(unsupported),
        ]);

        let value = super::get_value(&mut con, b"large-hash-no-httl").await.unwrap();

        let RedisValueData::Hash { items, total, scan_cursor } = value.data else {
            panic!("expected a Hash value");
        };
        assert_eq!(total, 512);
        assert_eq!(items.len(), super::COLLECTION_PAGE_SIZE);
        assert!(scan_cursor.is_some());
        assert!(items.iter().all(|item| item.field_ttl.is_none()));
        assert_eq!(con.command_count("HSCAN"), 1);
        assert_eq!(con.command_count("HTTL"), 1);
    }

    #[tokio::test]
    async fn set_value_pages_compact_sscan_response() {
        let members = (0..512).map(|index| format!("member:{index}")).collect();
        let mut con = FakeRedisConnection::new(vec![
            bulk("set"),
            RedisRawValue::Int(-1),
            RedisRawValue::Int(512),
            int_scan_response_owned("0", members),
        ]);

        let value = super::get_value(&mut con, b"large-intset").await.unwrap();

        let RedisValueData::Set { items, total, scan_cursor } = value.data else {
            panic!("expected a Set value");
        };
        let cursor = scan_cursor.expect("overflow cursor");
        assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);
        assert_eq!(total, 512);
        assert_eq!(items.len(), super::COLLECTION_PAGE_SIZE);
        assert_eq!(redis_blob_display_text(&items[0].member), "member:0");
        assert_eq!(redis_blob_display_text(&items[199].member), "member:199");

        let second =
            super::load_more_collection(&mut con, b"large-intset", "set", cursor, 200, None, None).await.unwrap();
        let RedisCollectionPage::Set { items, scan_cursor } = second else {
            panic!("expected a Set page");
        };
        assert_eq!(scan_cursor, Some(cursor));
        assert_eq!(items.len(), 200);
        assert_eq!(redis_blob_display_text(&items[0].member), "member:200");
        assert_eq!(redis_blob_display_text(&items[199].member), "member:399");

        let third =
            super::load_more_collection(&mut con, b"large-intset", "set", cursor, 200, None, None).await.unwrap();
        let RedisCollectionPage::Set { items, scan_cursor } = third else {
            panic!("expected a Set page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(items.len(), 112);
        assert_eq!(redis_blob_display_text(&items[0].member), "member:400");
        assert_eq!(redis_blob_display_text(&items[111].member), "member:511");
        assert_eq!(con.command_count("SSCAN"), 1);
    }

    #[tokio::test]
    async fn stream_value_uses_xlen_for_its_total_size() {
        let entries = RedisRawValue::Array(vec![RedisRawValue::Array(vec![
            bulk("1714470000000-0"),
            RedisRawValue::Array(vec![bulk("event"), bulk("login")]),
        ])]);
        let mut con =
            FakeRedisConnection::new(vec![bulk("stream"), RedisRawValue::Int(-1), RedisRawValue::Int(177), entries]);

        let value = super::get_value(&mut con, b"orders").await.unwrap();

        let RedisValueData::Stream { entries, total, next_cursor } = &value.data else {
            panic!("expected a Stream value");
        };
        assert_eq!(*total, Some(177));
        assert_eq!(entries.len(), 1);
        assert!(next_cursor.is_none());
        assert_eq!(super::redis_search_value_size(&value), 177);
        assert_eq!(con.command_count("TYPE"), 1);
        assert_eq!(con.command_count("TTL"), 1);
        assert_eq!(con.command_count("XLEN"), 1);
        assert_eq!(con.command_count("XRANGE"), 1);
        assert_eq!(con.commands.len(), 2);
    }

    #[tokio::test]
    async fn stream_value_still_loads_when_xlen_is_not_permitted() {
        let entries = RedisRawValue::Array(vec![RedisRawValue::Array(vec![
            bulk("1714470000000-0"),
            RedisRawValue::Array(vec![bulk("event"), bulk("login")]),
        ])]);
        let xlen_denied = || {
            redis::make_extension_error(
                "NOPERM".to_string(),
                Some("this user has no permissions to run the 'xlen' command".to_string()),
            )
        };
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(bulk("stream")),
            Ok(RedisRawValue::Int(-1)),
            Err(xlen_denied()),
            Ok(RedisRawValue::Int(-1)),
            Err(xlen_denied()),
            Ok(entries),
        ]);

        let value = super::get_value(&mut con, b"orders").await.unwrap();

        let RedisValueData::Stream { entries, total, .. } = &value.data else {
            panic!("expected a Stream value");
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(*total, None);
        assert_eq!(super::redis_search_value_size(&value), 1);
        assert!(serde_json::to_value(&value).unwrap()["data"].get("total").is_none());
        assert_eq!(con.command_count("XLEN"), 2);
        assert_eq!(con.command_count("XRANGE"), 2);
    }

    #[tokio::test]
    async fn stream_entry_first_page_exposes_a_cursor_when_more_entries_exist() {
        let entries = RedisRawValue::Array(
            (0..=50)
                .map(|index| {
                    RedisRawValue::Array(vec![
                        bulk(&format!("1714470000000-{index}")),
                        RedisRawValue::Array(vec![bulk("event"), bulk("login")]),
                    ])
                })
                .collect(),
        );
        let mut con = FakeRedisConnection::new(vec![entries]);

        let page = super::get_stream_entries_page(&mut con, b"orders", None).await.unwrap();

        assert_eq!(page.entries.len(), 50);
        assert_eq!(page.entries.first().map(|entry| entry.id.as_str()), Some("1714470000000-0"));
        assert_eq!(page.entries.last().map(|entry| entry.id.as_str()), Some("1714470000000-49"));
        assert_eq!(page.next_cursor.as_deref(), Some("1714470000000-49"));
        assert_eq!(con.command_count("XRANGE"), 1);
        assert!(con.commands[0].contains("\r\n-\r\n"));
        assert!(con.commands[0].contains("\r\n51\r\n"));
    }

    #[tokio::test]
    async fn stream_entry_pagination_reads_all_entries_across_sequential_pages() {
        let stream_entries = |start: u64, end: u64| {
            RedisRawValue::Array(
                (start..=end)
                    .map(|index| {
                        RedisRawValue::Array(vec![
                            bulk(&format!("1714470000000-{index}")),
                            RedisRawValue::Array(vec![bulk("event"), bulk("login")]),
                        ])
                    })
                    .collect(),
            )
        };
        let mut con =
            FakeRedisConnection::new(vec![stream_entries(0, 50), stream_entries(49, 100), stream_entries(99, 120)]);

        let first = super::get_stream_entries_page(&mut con, b"orders", None).await.unwrap();
        let second = super::get_stream_entries_page(&mut con, b"orders", first.next_cursor.as_deref()).await.unwrap();
        let third = super::get_stream_entries_page(&mut con, b"orders", second.next_cursor.as_deref()).await.unwrap();

        let ids = first
            .entries
            .iter()
            .chain(&second.entries)
            .chain(&third.entries)
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        let expected = (0..=120).map(|index| format!("1714470000000-{index}")).collect::<Vec<_>>();

        assert_eq!(first.next_cursor.as_deref(), Some("1714470000000-49"));
        assert_eq!(second.next_cursor.as_deref(), Some("1714470000000-99"));
        assert_eq!(third.next_cursor, None);
        assert_eq!(ids, expected);
        assert_eq!(con.command_count("XRANGE"), 3);
    }

    #[tokio::test]
    async fn stream_entry_pagination_uses_a_lookahead_and_skips_the_duplicate_cursor() {
        let entries = RedisRawValue::Array(
            (17..=68)
                .map(|index| {
                    RedisRawValue::Array(vec![
                        bulk(&format!("1714470000000-{index}")),
                        RedisRawValue::Array(vec![bulk("event"), bulk("login")]),
                    ])
                })
                .collect(),
        );
        let mut con = FakeRedisConnection::new(vec![entries]);

        let page = super::get_stream_entries_page(&mut con, b"orders", Some("1714470000000-17")).await.unwrap();

        assert_eq!(page.entries.len(), 50);
        assert_eq!(page.entries.first().map(|entry| entry.id.as_str()), Some("1714470000000-18"));
        assert_eq!(page.entries.last().map(|entry| entry.id.as_str()), Some("1714470000000-67"));
        assert_eq!(page.next_cursor.as_deref(), Some("1714470000000-67"));
        assert_eq!(con.command_count("XRANGE"), 1);
        assert!(con.commands[0].contains("\r\n1714470000000-17\r\n"));
        assert!(!con.commands[0].contains("\r\n(1714470000000-17\r\n"));
        assert!(con.commands[0].contains("\r\n52\r\n"));
    }

    #[tokio::test]
    async fn stream_entry_pagination_keeps_the_first_entry_when_the_cursor_was_trimmed() {
        let entries = RedisRawValue::Array(
            (18..=68)
                .map(|index| {
                    RedisRawValue::Array(vec![
                        bulk(&format!("1714470000000-{index}")),
                        RedisRawValue::Array(vec![bulk("event"), bulk("login")]),
                    ])
                })
                .collect(),
        );
        let mut con = FakeRedisConnection::new(vec![entries]);

        let page = super::get_stream_entries_page(&mut con, b"orders", Some("1714470000000-17")).await.unwrap();

        assert_eq!(page.entries.len(), 50);
        assert_eq!(page.entries.first().map(|entry| entry.id.as_str()), Some("1714470000000-18"));
        assert_eq!(page.entries.last().map(|entry| entry.id.as_str()), Some("1714470000000-67"));
        assert_eq!(page.next_cursor.as_deref(), Some("1714470000000-67"));
    }

    #[tokio::test]
    async fn stream_monitoring_commands_are_read_only_and_pending_pagination_supports_redis_5() {
        let groups = RedisRawValue::Array(vec![RedisRawValue::Array(vec![
            bulk("name"),
            bulk("payments"),
            bulk("consumers"),
            RedisRawValue::Int(1),
            bulk("pending"),
            RedisRawValue::Int(101),
            bulk("last-delivered-id"),
            bulk("1714470000000-0"),
        ])]);
        let consumers = RedisRawValue::Array(vec![RedisRawValue::Array(vec![
            bulk("name"),
            bulk("worker-a"),
            bulk("pending"),
            RedisRawValue::Int(101),
            bulk("idle"),
            RedisRawValue::Int(10),
        ])]);
        let pending = RedisRawValue::Array(
            (17..=118)
                .map(|index| {
                    RedisRawValue::Array(vec![
                        bulk(&format!("1714470000000-{index}")),
                        bulk("worker-a"),
                        RedisRawValue::Int(index),
                        RedisRawValue::Int(1),
                    ])
                })
                .collect(),
        );
        let mut con = FakeRedisConnection::new(vec![groups, consumers, pending]);

        let groups = super::get_stream_groups(&mut con, b"orders").await.unwrap();
        let consumers = super::get_stream_consumers(&mut con, b"orders", b"payments").await.unwrap();
        let page = super::get_stream_pending_page(&mut con, b"orders", b"payments", Some("1714470000000-17"), None)
            .await
            .unwrap();

        assert_eq!(groups.len(), 1);
        assert_eq!(consumers.len(), 1);
        assert_eq!(page.entries.len(), 100);
        assert_eq!(page.entries.first().map(|entry| entry.id.as_str()), Some("1714470000000-18"));
        assert_eq!(page.entries.last().map(|entry| entry.id.as_str()), Some("1714470000000-117"));
        assert_eq!(page.next_cursor.as_deref(), Some("1714470000000-117"));
        assert_eq!(con.command_count("XINFO"), 2);
        assert_eq!(con.command_count("XPENDING"), 1);
        assert_eq!(con.command_count("XGROUP"), 0);
        assert_eq!(con.command_count("XACK"), 0);
        assert_eq!(con.command_count("XCLAIM"), 0);
        assert!(con.commands[0].contains("\r\nGROUPS\r\n"));
        assert!(con.commands[1].contains("\r\nCONSUMERS\r\n"));
        assert!(con.commands[2].contains("\r\n1714470000000-17\r\n"));
        assert!(!con.commands[2].contains("\r\n(1714470000000-17\r\n"));
        assert!(con.commands[2].contains("\r\n102\r\n"));
    }

    #[tokio::test]
    async fn stream_pending_pagination_keeps_the_first_entry_when_cursor_is_acknowledged() {
        let pending = RedisRawValue::Array(
            (18..=118)
                .map(|index| {
                    RedisRawValue::Array(vec![
                        bulk(&format!("1714470000000-{index}")),
                        bulk("worker-a"),
                        RedisRawValue::Int(index),
                        RedisRawValue::Int(1),
                    ])
                })
                .collect(),
        );
        let mut con = FakeRedisConnection::new(vec![pending]);

        let page = super::get_stream_pending_page(&mut con, b"orders", b"payments", Some("1714470000000-17"), None)
            .await
            .unwrap();

        assert_eq!(page.entries.len(), 100);
        assert_eq!(page.entries.first().map(|entry| entry.id.as_str()), Some("1714470000000-18"));
        assert_eq!(page.entries.last().map(|entry| entry.id.as_str()), Some("1714470000000-117"));
        assert_eq!(page.next_cursor.as_deref(), Some("1714470000000-117"));
        assert!(con.commands[0].contains("\r\n1714470000000-17\r\n"));
        assert!(!con.commands[0].contains("\r\n(1714470000000-17\r\n"));
        assert!(con.commands[0].contains("\r\n102\r\n"));
    }

    #[tokio::test]
    async fn stream_pending_filters_by_consumer_server_side() {
        let pending = RedisRawValue::Array(vec![RedisRawValue::Array(vec![
            bulk("1714470000000-0"),
            bulk("worker-a"),
            RedisRawValue::Int(2_400),
            RedisRawValue::Int(1),
        ])]);
        let mut con = FakeRedisConnection::new(vec![pending]);

        let page =
            super::get_stream_pending_page(&mut con, b"orders", b"payments", None, Some(b"worker-a")).await.unwrap();

        assert_eq!(page.entries.len(), 1);
        assert_eq!(con.command_count("XPENDING"), 1);
        assert!(con.commands[0].contains("\r\n-\r\n"));
        assert!(con.commands[0].contains("\r\n+\r\n"));
        assert!(con.commands[0].contains("\r\n101\r\n"));
        assert!(con.commands[0].contains("\r\nworker-a\r\n"));
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
    async fn rename_key_uses_renamenx_without_overwriting_the_destination() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1)]);

        super::rename_key(&mut con, b"session:old", b"session:new").await.unwrap();

        assert_eq!(con.commands.len(), 1);
        assert!(con.commands[0].contains("\r\nRENAMENX\r\n"));
        assert!(con.commands[0].contains("\r\nsession:old\r\n"));
        assert!(con.commands[0].contains("\r\nsession:new\r\n"));
    }

    #[tokio::test]
    async fn rename_key_reports_a_destination_conflict() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(0)]);

        let error = super::rename_key(&mut con, b"session:old", b"session:new").await.unwrap_err();

        assert_eq!(error, "Target key already exists");
    }

    #[tokio::test]
    async fn set_expire_at_uses_expireat_with_the_unix_timestamp() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1)]);

        super::set_expire_at(&mut con, b"session", 1_735_689_600).await.unwrap();

        assert_eq!(con.commands.len(), 1);
        assert!(con.commands[0].contains("\r\nEXPIREAT\r\n"));
        assert!(con.commands[0].contains("\r\n1735689600\r\n"));
        assert_eq!(con.command_count("EVAL"), 0);
    }

    #[tokio::test]
    async fn set_expire_at_reports_when_the_key_disappears_before_expiration_is_applied() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(0)]);

        let error = super::set_expire_at(&mut con, b"session", 1_735_689_600).await.unwrap_err();

        assert!(error.contains("EXPIREAT was not applied"));
    }

    #[tokio::test]
    async fn set_ttl_reports_when_positive_expiration_is_not_applied() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(0)]);

        let error = super::set_ttl(&mut con, b"session", 60).await.unwrap_err();

        assert!(error.contains("EXPIRE was not applied"));
    }

    #[tokio::test]
    async fn persist_is_idempotent_for_an_already_persistent_key() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(0)]);

        super::set_ttl(&mut con, b"session", 0).await.unwrap();

        assert_eq!(con.commands.len(), 1);
        assert_eq!(con.command_count("PERSIST"), 1);
        assert_eq!(con.command_count("EXISTS"), 0);
        assert_eq!(con.command_count("EVAL"), 0);
    }

    #[tokio::test]
    async fn set_keys_expiry_expires_every_selected_key_in_one_pipeline() {
        let mut con =
            FakeRedisConnection::new(vec![RedisRawValue::Int(1), RedisRawValue::Int(1), RedisRawValue::Int(1)]);
        let keys = vec![b"key:a".to_vec(), b"key:b".to_vec(), b"key:c".to_vec()];

        let result = super::set_keys_expiry(&mut con, &keys, super::RedisKeysExpiry::Ttl(3_600)).await.unwrap();

        assert_eq!(result, super::RedisKeysExpiryResult { applied: 3, missing_key_raws: Vec::new() });
        // One pipeline for the whole selection, with one command per selected key.
        assert_eq!(con.commands.len(), 1);
        assert_eq!(con.commands[0].matches("\r\nEXPIRE\r\n").count(), 3);
        assert_eq!(con.commands[0].matches("\r\nEXPIREAT\r\n").count(), 0);
        assert_eq!(con.commands[0].matches("\r\nPERSIST\r\n").count(), 0);
        assert_eq!(con.commands[0].matches("\r\n3600\r\n").count(), 3);
    }

    #[tokio::test]
    async fn set_keys_expiry_reports_only_the_keys_that_disappeared() {
        let mut con =
            FakeRedisConnection::new(vec![RedisRawValue::Int(1), RedisRawValue::Int(0), RedisRawValue::Int(1)]);
        let keys = vec![b"key:a".to_vec(), b"key:b".to_vec(), b"key:c".to_vec()];

        let result = super::set_keys_expiry(&mut con, &keys, super::RedisKeysExpiry::At(1_735_689_600)).await.unwrap();

        assert_eq!(result.applied, 2);
        assert_eq!(result.missing_key_raws, vec![super::redis_key_bytes_to_raw(b"key:b")]);
        assert_eq!(con.commands[0].matches("\r\nEXPIREAT\r\n").count(), 3);
        assert!(con.commands[0].contains("\r\n1735689600\r\n"));
    }

    #[tokio::test]
    async fn set_keys_expiry_treats_persist_as_idempotent_for_every_key() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(0), RedisRawValue::Int(1)]);
        let keys = vec![b"key:a".to_vec(), b"key:b".to_vec()];

        let result = super::set_keys_expiry(&mut con, &keys, super::RedisKeysExpiry::from_ttl(-1)).await.unwrap();

        assert_eq!(result, super::RedisKeysExpiryResult { applied: 2, missing_key_raws: Vec::new() });
        assert_eq!(con.commands.len(), 1);
        assert_eq!(con.commands[0].matches("\r\nPERSIST\r\n").count(), 2);
        assert_eq!(con.commands[0].matches("\r\nEXPIRE\r\n").count(), 0);
    }

    #[tokio::test]
    async fn set_keys_expiry_keeps_ttl_zero_on_the_persist_path() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1)]);

        let result =
            super::set_keys_expiry(&mut con, &[b"key:a".to_vec()], super::RedisKeysExpiry::from_ttl(0)).await.unwrap();

        assert_eq!(result.applied, 1);
        assert_eq!(con.command_count("PERSIST"), 1);
    }

    #[tokio::test]
    async fn set_keys_expiry_does_not_send_a_command_for_an_empty_selection() {
        let mut con = FakeRedisConnection::new(Vec::new());

        let result = super::set_keys_expiry(&mut con, &[], super::RedisKeysExpiry::Ttl(60)).await.unwrap();

        assert_eq!(result, super::RedisKeysExpiryResult::default());
        assert!(con.commands.is_empty());
    }

    #[tokio::test]
    async fn set_keys_expiry_fails_loudly_when_a_reply_is_missing() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1)]);
        let keys = vec![b"key:a".to_vec(), b"key:b".to_vec()];

        let error = super::set_keys_expiry(&mut con, &keys, super::RedisKeysExpiry::Ttl(60)).await.unwrap_err();

        // A short or failed reply must not be reported as two successful keys.
        assert!(error.contains("EXPIRE did not return one reply per selected key"));
    }

    #[tokio::test]
    async fn set_string_falls_back_to_pttl_and_px_when_keepttl_is_unsupported() {
        let unsupported = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
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
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
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
            redis::ErrorKind::Server(redis::ServerErrorKind::ReadOnly),
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
    async fn scan_keys_batch_batches_type_and_ttl_metadata() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(2),
            scan_response("0", vec!["session:a", "cache:b"]),
            RedisRawValue::SimpleString("string".to_string()),
            RedisRawValue::SimpleString("hash".to_string()),
            RedisRawValue::Int(-1),
            RedisRawValue::Int(3600),
        ]);

        let result = super::scan_keys_batch(&mut con, 0, "*", 100, 1, true).await.unwrap();

        assert_eq!(result.keys.len(), 2);
        assert_eq!(result.keys[0].key_type, "string");
        assert_eq!(result.keys[0].ttl, -1);
        assert_eq!(result.keys[1].key_type, "hash");
        assert_eq!(result.keys[1].ttl, 3600);
        let type_pipeline = con.commands.iter().find(|packed| packed.contains("\r\nTYPE\r\n")).unwrap();
        let ttl_pipeline = con.commands.iter().find(|packed| packed.contains("\r\nTTL\r\n")).unwrap();
        assert_eq!(type_pipeline.matches("\r\nTYPE\r\n").count(), 2);
        assert_eq!(type_pipeline.matches("\r\nTTL\r\n").count(), 0);
        assert_eq!(ttl_pipeline.matches("\r\nTYPE\r\n").count(), 0);
        assert_eq!(ttl_pipeline.matches("\r\nTTL\r\n").count(), 2);
    }

    #[tokio::test]
    async fn scan_keys_batch_preserves_types_when_one_ttl_command_fails() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(2),
            scan_response("0", vec!["session:a", "cache:b"]),
            RedisRawValue::SimpleString("string".to_string()),
            RedisRawValue::SimpleString("hash".to_string()),
            redis::parse_redis_value(b"-NOPERM this user has no permissions to run the 'ttl' command\r\n").unwrap(),
            RedisRawValue::Int(3600),
        ]);

        let result = super::scan_keys_batch(&mut con, 0, "*", 100, 1, true).await.unwrap();

        assert_eq!(result.keys.len(), 2);
        assert_eq!(result.keys[0].key_type, "string");
        assert_eq!(result.keys[0].ttl, -2);
        assert_eq!(result.keys[1].key_type, "hash");
        assert_eq!(result.keys[1].ttl, 3600);
    }

    #[tokio::test]
    async fn scan_keys_batch_skips_type_and_ttl_when_metadata_disabled() {
        // include_types=false 是“加载全部”的百万 key 链路，不能多发出任何 TYPE/TTL 命令
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1), scan_response("0", vec!["cache:b"])]);

        let result = super::scan_keys_batch(&mut con, 0, "*", 100, 1, false).await.unwrap();

        assert_eq!(result.keys.len(), 1);
        assert_eq!(result.keys[0].key_type, "");
        assert_eq!(result.keys[0].ttl, -2);
        assert_eq!(con.command_count("TYPE"), 0);
        assert_eq!(con.command_count("TTL"), 0);
    }

    #[tokio::test]
    async fn scan_keys_batch_exact_match_returns_ttl() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(1),
            RedisRawValue::Int(1),
            RedisRawValue::SimpleString("string".to_string()),
            RedisRawValue::Int(-1),
        ]);

        let result = super::scan_keys_batch(&mut con, 0, "session:a", 100, 1, true).await.unwrap();

        assert_eq!(result.keys.len(), 1);
        assert_eq!(result.keys[0].key_display, "session:a");
        assert_eq!(result.keys[0].key_type, "string");
        assert_eq!(result.keys[0].ttl, -1);
        assert_eq!(con.command_count("EXISTS"), 1);
        assert_eq!(con.command_count("TTL"), 1);
    }

    #[tokio::test]
    async fn cluster_key_batch_reuses_node_connections_across_scan_iterations() {
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let logs: Vec<_> = (0..masters.len()).map(|_| Arc::new(StdMutex::new(Vec::new()))).collect();
        let mut connections = HashMap::from([
            (
                masters[0].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(100), scan_response("7", vec![]), scan_response("0", vec![])],
                    logs[0].clone(),
                ),
            ),
            (
                masters[1].clone(),
                TrackedRedisConnection::new(vec![RedisRawValue::Int(200), scan_response("9", vec![])], logs[1].clone()),
            ),
            (
                masters[2].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(300), scan_response("0", vec!["membership:saas:base:token:match"])],
                    logs[2].clone(),
                ),
            ),
        ]);
        let connect_count = Arc::new(AtomicUsize::new(0));
        let connector_count = connect_count.clone();
        let topology_count = Arc::new(AtomicUsize::new(0));
        let discovery_count = topology_count.clone();
        let discovered_masters = masters.clone();

        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            move || {
                discovery_count.fetch_add(1, Ordering::Relaxed);
                ready(Ok(discovered_masters.clone()))
            },
            move |endpoint| {
                connector_count.fetch_add(1, Ordering::Relaxed);
                ready(connections.remove(&endpoint).ok_or_else(|| format!("unexpected reconnect to {}", endpoint.host)))
            },
            0,
            "membership:saas:base:token:*",
            1000,
            4,
            false,
        )
        .await
        .unwrap();

        assert_eq!(result.total_keys, 600);
        assert_eq!(result.keys.len(), 1);
        assert!(result.cursor > 0);
        assert!(result.cursor <= super::MAX_SAFE_INTEGER_CURSOR);
        assert_eq!(topology_count.load(Ordering::Relaxed), 1);
        assert_eq!(connect_count.load(Ordering::Relaxed), 3);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "DBSIZE")).sum::<usize>(), 3);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "SCAN")).sum::<usize>(), 4);
        assert_eq!(sessions.lock().await.entries.len(), 1);
    }

    #[tokio::test]
    async fn cluster_key_batch_scans_later_masters_before_exhausting_the_first_master() {
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let logs: Vec<_> = (0..masters.len()).map(|_| Arc::new(StdMutex::new(Vec::new()))).collect();
        let mut connections = HashMap::from([
            (
                masters[0].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(200_000), scan_response("7", vec!["migration:visible:first"])],
                    logs[0].clone(),
                ),
            ),
            (
                masters[1].clone(),
                TrackedRedisConnection::new(vec![RedisRawValue::Int(0), scan_response("0", vec![])], logs[1].clone()),
            ),
            (
                masters[2].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(1), scan_response("0", vec!["migration:user:1:status"])],
                    logs[2].clone(),
                ),
            ),
        ]);
        let discovered_masters = masters.clone();

        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            move || ready(Ok(discovered_masters.clone())),
            move |endpoint| {
                ready(connections.remove(&endpoint).ok_or_else(|| format!("unexpected reconnect to {}", endpoint.host)))
            },
            0,
            "*migration*",
            100,
            3,
            false,
        )
        .await
        .unwrap();

        assert_eq!(result.total_keys, 200_001);
        assert_eq!(
            result.keys.iter().map(|key| key.key_display.as_str()).collect::<Vec<_>>(),
            ["migration:visible:first", "migration:user:1:status",]
        );
        assert!(result.cursor > 0);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "SCAN")).collect::<Vec<_>>(), [1, 1, 1]);
        let continued = sessions.lock().await.take(result.cursor).unwrap();
        assert_eq!(continued.node_cursors, [7, 0, 0]);
        assert_eq!(continued.node_complete, [false, true, true]);
        assert_eq!(continued.next_node_index, 0);
    }

    #[tokio::test]
    async fn cluster_key_batch_exact_match_reaches_the_owning_master() {
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let mut connections = HashMap::from([
            (
                masters[0].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(100), RedisRawValue::Int(0)],
                    Arc::new(StdMutex::new(Vec::new())),
                ),
            ),
            (
                masters[1].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(200), RedisRawValue::Int(0)],
                    Arc::new(StdMutex::new(Vec::new())),
                ),
            ),
            (
                masters[2].clone(),
                TrackedRedisConnection::new(
                    vec![
                        RedisRawValue::Int(1),
                        RedisRawValue::Int(1),
                        RedisRawValue::SimpleString("string".to_string()),
                        RedisRawValue::Int(-1),
                    ],
                    Arc::new(StdMutex::new(Vec::new())),
                ),
            ),
        ]);
        let discovered_masters = masters.clone();

        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            move || ready(Ok(discovered_masters.clone())),
            move |endpoint| {
                ready(connections.remove(&endpoint).ok_or_else(|| format!("unexpected reconnect to {}", endpoint.host)))
            },
            0,
            "migration:user:1:status",
            100,
            3,
            true,
        )
        .await
        .unwrap();

        assert_eq!(result.cursor, 0);
        assert_eq!(result.total_keys, 301);
        assert_eq!(result.keys.len(), 1);
        assert_eq!(result.keys[0].key_display, "migration:user:1:status");
        assert_eq!(result.keys[0].key_type, "string");
        assert_eq!(result.keys[0].ttl, -1);
        assert!(sessions.lock().await.entries.is_empty());
    }

    #[tokio::test]
    async fn cluster_key_batch_continuation_skips_dbsize_and_advances_masters() {
        let pattern = "membership:saas:base:token:*";
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let mut saved_session = super::RedisClusterKeyScanSession::new(masters.clone(), pattern);
        saved_session.node_complete[0] = true;
        saved_session.node_cursors[1] = 7;
        saved_session.next_node_index = 1;
        let mut saved_sessions = super::RedisClusterScanSessions::default();
        let cursor = saved_sessions.insert(None, saved_session);
        let sessions = tokio::sync::Mutex::new(saved_sessions);
        let logs: Vec<_> = (0..masters.len()).map(|_| Arc::new(StdMutex::new(Vec::new()))).collect();
        let mut connections = HashMap::from([
            (masters[1].clone(), TrackedRedisConnection::new(vec![scan_response("0", vec![])], logs[1].clone())),
            (
                masters[2].clone(),
                TrackedRedisConnection::new(
                    vec![scan_response("0", vec!["membership:saas:base:token:last"])],
                    logs[2].clone(),
                ),
            ),
        ]);
        let connect_count = Arc::new(AtomicUsize::new(0));
        let connector_count = connect_count.clone();
        let topology_count = Arc::new(AtomicUsize::new(0));
        let discovery_count = topology_count.clone();

        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            move || {
                discovery_count.fetch_add(1, Ordering::Relaxed);
                ready(Err("continuation must not rediscover topology".to_string()))
            },
            move |endpoint| {
                connector_count.fetch_add(1, Ordering::Relaxed);
                ready(
                    connections.remove(&endpoint).ok_or_else(|| format!("unexpected connection to {}", endpoint.host)),
                )
            },
            cursor,
            pattern,
            1000,
            2,
            false,
        )
        .await
        .unwrap();

        assert_eq!(result.cursor, 0);
        assert_eq!(result.total_keys, 0);
        assert_eq!(result.keys.len(), 1);
        assert_eq!(topology_count.load(Ordering::Relaxed), 0);
        assert_eq!(connect_count.load(Ordering::Relaxed), 2);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "DBSIZE")).sum::<usize>(), 0);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "SCAN")).sum::<usize>(), 2);
        assert!(sessions.lock().await.entries.is_empty());
    }

    #[tokio::test]
    async fn cluster_key_batch_refreshes_healthy_cached_masters_before_scanning() {
        let pattern = "membership:saas:base:token:*";
        let cached_masters = [
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
        ];
        let current_masters = [
            cached_masters[0].clone(),
            cached_masters[1].clone(),
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let logs: Vec<_> = (0..current_masters.len()).map(|_| Arc::new(StdMutex::new(Vec::new()))).collect();
        let mut connections = HashMap::from([
            (
                current_masters[0].clone(),
                TrackedRedisConnection::new(vec![RedisRawValue::Int(100), scan_response("0", vec![])], logs[0].clone()),
            ),
            (
                current_masters[1].clone(),
                TrackedRedisConnection::new(vec![RedisRawValue::Int(200), scan_response("0", vec![])], logs[1].clone()),
            ),
            (
                current_masters[2].clone(),
                TrackedRedisConnection::new(
                    vec![RedisRawValue::Int(300), scan_response("0", vec!["membership:saas:base:token:new-master"])],
                    logs[2].clone(),
                ),
            ),
        ]);
        let discovered_masters = vec![
            current_masters[2].clone(),
            current_masters[0].clone(),
            current_masters[1].clone(),
            current_masters[2].clone(),
        ];
        let topology_count = Arc::new(AtomicUsize::new(0));
        let discovery_count = topology_count.clone();

        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            move || {
                discovery_count.fetch_add(1, Ordering::Relaxed);
                ready(Ok(discovered_masters.clone()))
            },
            move |endpoint| {
                ready(connections.remove(&endpoint).ok_or_else(|| format!("unexpected reconnect to {}", endpoint.host)))
            },
            0,
            pattern,
            1000,
            3,
            false,
        )
        .await
        .unwrap();

        assert_eq!(result.cursor, 0);
        assert_eq!(result.total_keys, 600);
        assert_eq!(result.keys.len(), 1);
        assert_eq!(result.keys[0].key_display, "membership:saas:base:token:new-master");
        assert_eq!(topology_count.load(Ordering::Relaxed), 1);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "DBSIZE")).sum::<usize>(), 3);
        assert_eq!(logs.iter().map(|log| tracked_command_count(log, "SCAN")).sum::<usize>(), 3);
        assert!(sessions.lock().await.entries.is_empty());
    }

    #[test]
    fn cluster_scan_routes_discovered_advertised_endpoint_through_existing_mapping() {
        let advertised = RedisNodeEndpoint { host: "redis.internal".to_string(), port: 7000 };
        let forwarded = RedisNodeEndpoint { host: "127.0.0.1".to_string(), port: 17_000 };
        let pool = super::RedisClusterPool {
            connection: None,
            database_connections: Box::new(tokio::sync::Mutex::new(HashMap::new())),
            database_capability: Box::new(tokio::sync::Mutex::new(None)),
            seed_nodes: vec![advertised.clone()],
            seed_routes: Vec::new(),
            slot_ranges: Vec::new(),
            node_routes: vec![RedisNodeRoute { advertised: advertised.clone(), connect: forwarded.clone() }],
            tls: false,
            tls_insecure: false,
            tls_certificates: None,
            username: String::new(),
            password: String::new(),
            scan_sessions: Box::new(tokio::sync::Mutex::new(super::RedisClusterScanSessions::default())),
        };

        assert_eq!(super::mapped_cluster_endpoint(&pool, &advertised), forwarded);
    }

    #[tokio::test]
    async fn cluster_key_batch_continuation_uses_stable_node_identity_without_rediscovery() {
        let pattern = "membership:*";
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let mut saved_session = super::RedisClusterKeyScanSession::new(masters.clone(), pattern);
        saved_session.node_complete[0] = true;
        saved_session.node_cursors[1] = 7;
        saved_session.next_node_index = 1;
        let mut saved_sessions = super::RedisClusterScanSessions::default();
        let cursor = saved_sessions.insert(None, saved_session);
        let sessions = tokio::sync::Mutex::new(saved_sessions);
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let mut connections = HashMap::from([(
            masters[1].clone(),
            TrackedRedisConnection::new(vec![scan_response("9", vec!["membership:stable-node"])], commands.clone()),
        )]);

        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            || ready(Err("continuation must not rediscover topology".to_string())),
            move |endpoint| {
                ready(
                    connections.remove(&endpoint).ok_or_else(|| format!("unexpected connection to {}", endpoint.host)),
                )
            },
            cursor,
            pattern,
            1,
            1,
            false,
        )
        .await
        .unwrap();

        assert_eq!(result.cursor, cursor);
        assert_eq!(result.total_keys, 0);
        assert_eq!(result.keys[0].key_display, "membership:stable-node");
        assert_eq!(tracked_command_count(&commands, "DBSIZE"), 0);
        assert_eq!(tracked_command_count(&commands, "SCAN"), 1);
        let continued = sessions.lock().await.take(cursor).unwrap();
        assert_eq!(continued.node_cursors[1], 9);
        assert_eq!(continued.next_node_index, 2);
    }

    #[tokio::test]
    async fn cluster_key_batch_continuation_restores_original_position_after_failure() {
        let pattern = "membership:*";
        let masters = vec![
            RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 },
            RedisNodeEndpoint { host: "node-b".to_string(), port: 7001 },
            RedisNodeEndpoint { host: "node-c".to_string(), port: 7002 },
        ];
        let mut saved_session = super::RedisClusterKeyScanSession::new(masters.clone(), pattern);
        saved_session.node_complete[0] = true;
        saved_session.node_cursors[1] = 7;
        saved_session.next_node_index = 1;
        let mut saved_sessions = super::RedisClusterScanSessions::default();
        let cursor = saved_sessions.insert(None, saved_session);
        let sessions = tokio::sync::Mutex::new(saved_sessions);
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let connected_nodes = Arc::new(StdMutex::new(Vec::new()));
        let first_connected_nodes = connected_nodes.clone();
        let first_commands = commands.clone();
        let first_master = masters[1].clone();
        let failed_master = masters[2].clone();
        let mut first_connection = Some(TrackedRedisConnection::new(
            vec![scan_response("0", vec!["membership:before-failure"])],
            first_commands,
        ));

        let error = super::scan_cluster_keys_batch_with(
            &sessions,
            || ready(Err("continuation must not rediscover topology".to_string())),
            move |endpoint| {
                first_connected_nodes.lock().unwrap().push(endpoint.clone());
                ready(if endpoint == first_master {
                    first_connection.take().ok_or_else(|| "unexpected reconnect".to_string())
                } else if endpoint == failed_master {
                    Err("temporary node failure".to_string())
                } else {
                    Err(format!("unexpected connection to {}", endpoint.host))
                })
            },
            cursor,
            pattern,
            1000,
            2,
            false,
        )
        .await
        .unwrap_err();

        assert_eq!(error, "temporary node failure");
        let restored = sessions.lock().await.entries.get(&cursor).unwrap().clone();
        assert_eq!(restored.node_cursors[1], 7);
        assert_eq!(restored.next_node_index, 1);

        let retry_connected_nodes = connected_nodes.clone();
        let retry_commands = commands.clone();
        let retry_master = masters[1].clone();
        let mut retry_connection =
            Some(TrackedRedisConnection::new(vec![scan_response("9", vec!["membership:retried"])], retry_commands));
        let result = super::scan_cluster_keys_batch_with(
            &sessions,
            || ready(Err("continuation must not rediscover topology".to_string())),
            move |endpoint| {
                retry_connected_nodes.lock().unwrap().push(endpoint.clone());
                ready(if endpoint == retry_master {
                    retry_connection.take().ok_or_else(|| "unexpected reconnect".to_string())
                } else {
                    Err(format!("unexpected connection to {}", endpoint.host))
                })
            },
            cursor,
            pattern,
            1,
            1,
            false,
        )
        .await
        .unwrap();

        assert_eq!(result.cursor, cursor);
        assert_eq!(result.total_keys, 0);
        assert_eq!(result.keys[0].key_display, "membership:retried");
        assert_eq!(tracked_command_count(&commands, "DBSIZE"), 0);
        assert_eq!(tracked_command_count(&commands, "SCAN"), 2);
        assert!(commands.lock().unwrap()[1].contains("\r\n7\r\n"));
        assert_eq!(*connected_nodes.lock().unwrap(), vec![masters[1].clone(), masters[2].clone(), masters[1].clone()]);
        let continued = sessions.lock().await.take(cursor).unwrap();
        assert_eq!(continued.node_cursors[1], 9);
        assert_eq!(continued.next_node_index, 2);
    }

    #[tokio::test]
    async fn cluster_key_batch_rejects_an_unknown_continuation_cursor() {
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());
        let topology_count = Arc::new(AtomicUsize::new(0));
        let discovery_count = topology_count.clone();
        let connect_count = Arc::new(AtomicUsize::new(0));
        let connector_count = connect_count.clone();

        let error = super::scan_cluster_keys_batch_with::<TrackedRedisConnection, _, _, _, _>(
            &sessions,
            move || {
                discovery_count.fetch_add(1, Ordering::Relaxed);
                ready(Err("continuation must not rediscover topology".to_string()))
            },
            move |_| {
                connector_count.fetch_add(1, Ordering::Relaxed);
                ready(Err("continuation must not connect".to_string()))
            },
            999,
            "membership:*",
            1000,
            1,
            false,
        )
        .await
        .unwrap_err();

        assert_eq!(error, super::INVALID_CLUSTER_SCAN_CURSOR_ERROR);
        assert_eq!(topology_count.load(Ordering::Relaxed), 0);
        assert_eq!(connect_count.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn cluster_key_batch_rejects_an_expired_continuation_cursor() {
        let master = RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 };
        let mut saved_sessions = super::RedisClusterScanSessions::default();
        let cursor = saved_sessions.insert(None, super::RedisClusterKeyScanSession::new(vec![master], "membership:*"));
        saved_sessions.entries.get_mut(&cursor).unwrap().last_used =
            std::time::Instant::now() - super::CLUSTER_SCAN_SESSION_TTL - std::time::Duration::from_secs(1);
        let sessions = tokio::sync::Mutex::new(saved_sessions);

        let error = super::scan_cluster_keys_batch_with::<TrackedRedisConnection, _, _, _, _>(
            &sessions,
            || ready(Err("continuation must not rediscover topology".to_string())),
            |_| ready(Err("continuation must not connect".to_string())),
            cursor,
            "membership:*",
            1000,
            1,
            false,
        )
        .await
        .unwrap_err();

        assert_eq!(error, super::INVALID_CLUSTER_SCAN_CURSOR_ERROR);
        assert!(sessions.lock().await.entries.is_empty());
    }

    #[tokio::test]
    async fn cluster_key_batch_reports_new_scan_topology_failure() {
        let sessions = tokio::sync::Mutex::new(super::RedisClusterScanSessions::default());

        let error = super::scan_cluster_keys_batch_with::<TrackedRedisConnection, _, _, _, _>(
            &sessions,
            || ready(Err("topology unavailable".to_string())),
            |_| ready(Err("scan connection must not be opened".to_string())),
            0,
            "membership:*",
            1000,
            1,
            false,
        )
        .await
        .unwrap_err();

        assert_eq!(error, "topology unavailable");
        assert!(sessions.lock().await.entries.is_empty());
    }

    #[test]
    fn cluster_scan_sessions_expire_and_remain_bounded() {
        let master = RedisNodeEndpoint { host: "node-a".to_string(), port: 7000 };
        let mut sessions = super::RedisClusterScanSessions::default();
        let expired_cursor = sessions.insert(None, super::RedisClusterKeyScanSession::new(vec![master.clone()], "*"));
        sessions.entries.get_mut(&expired_cursor).unwrap().last_used =
            std::time::Instant::now() - super::CLUSTER_SCAN_SESSION_TTL - std::time::Duration::from_secs(1);

        for index in 0..=super::CLUSTER_SCAN_SESSION_LIMIT {
            sessions
                .insert(None, super::RedisClusterKeyScanSession::new(vec![master.clone()], &format!("key:{index}:*")));
        }

        assert!(!sessions.entries.contains_key(&expired_cursor));
        assert_eq!(sessions.entries.len(), super::CLUSTER_SCAN_SESSION_LIMIT);
        assert!(sessions.entries.keys().all(|cursor| *cursor > 0 && *cursor <= super::MAX_SAFE_INTEGER_CURSOR));
    }

    // Keep the pre-optimization path as an independent semantic/benchmark oracle.
    fn hash_scan_before_filter(raw: RedisRawValue, query: Option<&str>) -> Result<(u64, Vec<RedisHashItem>), String> {
        let RedisRawValue::Array(parts) = raw else { return Err("Invalid SCAN response".to_string()) };
        if parts.len() != 2 {
            return Err("Invalid SCAN response".to_string());
        }
        let cursor = super::redis_value_to_string(parts[0].clone())
            .ok_or("Invalid cursor")?
            .parse::<u64>()
            .map_err(|_| "Invalid cursor".to_string())?;
        let RedisRawValue::Array(entries) = &parts[1] else { return Err("Invalid SCAN entries".to_string()) };
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
            items.push(RedisHashItem { field, value, field_ttl: None });
        }
        if let Some(query) = query {
            items.retain(|item| {
                super::blob_matches_query(&item.field, query) || super::blob_matches_query(&item.value, query)
            });
        }
        Ok((cursor, items))
    }

    #[test]
    fn hash_raw_filter_preserves_unicode_binary_and_value_matching() {
        let mut pairs = vec![
            (b"Exact".to_vec(), b"".to_vec()),
            (b"other".to_vec(), b"contains eXaCt".to_vec()),
            ("用户:İΣ".as_bytes().to_vec(), "Straße Σσς".as_bytes().to_vec()),
            (b"slash\\field".to_vec(), b"utf8\\value".to_vec()),
            (b"binary\\\xff".to_vec(), b"\0\x80".to_vec()),
        ];
        pairs.extend((0..=255).map(|byte| (vec![b'f', byte], vec![byte, b'V'])));
        let entries = pairs
            .into_iter()
            .flat_map(|(field, value)| [RedisRawValue::BulkString(field), RedisRawValue::BulkString(value)])
            .collect();
        let raw = RedisRawValue::Array(vec![bulk("512"), RedisRawValue::Array(entries)]);
        for query in [
            None,
            Some(""),
            Some("exact"),
            Some("用户"),
            Some("i\u{307}"),
            Some("σ"),
            Some("ς"),
            Some("straße"),
            Some("\\"),
            Some("\\\\"),
            Some("\\xff"),
            Some("\\x00"),
            Some("v"),
            Some("absent"),
        ] {
            assert_eq!(
                super::parse_scan_hash_entries(raw.clone(), query),
                hash_scan_before_filter(raw.clone(), query),
                "query {query:?}"
            );
        }
    }

    #[test]
    fn hash_raw_filter_preserves_payload_validation() {
        for raw in [
            RedisRawValue::Nil,
            RedisRawValue::Array(vec![]),
            RedisRawValue::Array(vec![bulk("bad-cursor"), RedisRawValue::Array(vec![])]),
            RedisRawValue::Array(vec![bulk("0"), RedisRawValue::Nil]),
            RedisRawValue::Array(vec![bulk("0"), RedisRawValue::Array(vec![RedisRawValue::Nil, bulk("value")])]),
            RedisRawValue::Array(vec![bulk("0"), RedisRawValue::Array(vec![bulk("unmatched"), RedisRawValue::Nil])]),
            RedisRawValue::Array(vec![
                RedisRawValue::Int(17),
                RedisRawValue::Array(vec![RedisRawValue::Int(42), RedisRawValue::Boolean(true), bulk("unpaired")]),
            ]),
        ] {
            for query in [None, Some("absent"), Some("42")] {
                assert_eq!(
                    super::parse_scan_hash_entries(raw.clone(), query),
                    hash_scan_before_filter(raw.clone(), query)
                );
            }
        }
    }

    #[test]
    #[ignore = "manual CPU benchmark; run with --ignored --nocapture using an optimized test profile"]
    fn hash_raw_filter_benchmark() {
        use std::{hint::black_box, time::Instant};
        let payload = "payload:".to_string() + &"x".repeat(1016);
        let raw = hscan_response_owned(
            "0",
            (0..25_000)
                .map(|index| {
                    (if index < 4 { format!("needle:{index}") } else { format!("field:{index}") }, payload.clone())
                })
                .collect(),
        );
        for query in ["absent", "needle", "payload"] {
            let mut before = Vec::new();
            let mut after = Vec::new();
            for _ in 0..7 {
                let input = raw.clone();
                let start = Instant::now();
                let expected = black_box(hash_scan_before_filter(black_box(input), Some(query)).unwrap());
                before.push(start.elapsed().as_secs_f64() * 1000.0);
                let input = raw.clone();
                let start = Instant::now();
                let actual = black_box(super::parse_scan_hash_entries(black_box(input), Some(query)).unwrap());
                after.push(start.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(actual, expected);
            }
            before.sort_by(f64::total_cmp);
            after.sort_by(f64::total_cmp);
            eprintln!("Hash CPU query={query} fields=25000 value_bytes=1024 median_before_ms={:.3} median_after_ms={:.3} speedup={:.2}", before[3], after[3], before[3] / after[3]);
        }
    }

    #[tokio::test]
    async fn hash_search_prioritizes_exact_fields_and_keeps_fuzzy_continuation() {
        let mut con = FakeRedisConnection::new(vec![
            bulk("old"),
            hscan_response("512", vec![("Exact", "new"), ("exact", "case variant"), ("other", "contains Exact")]),
            httl_response(3, -1),
            hscan_response("0", vec![("prefix:Exact", "tail")]),
            httl_response(1, -1),
        ]);
        let page = super::load_more_collection(&mut con, b"hash", "hash", 0, 200, Some("Exact"), None).await.unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = page else { panic!("expected hash") };
        assert_eq!(scan_cursor, Some(512));
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].field, text_blob("Exact"));
        assert_eq!(items[0].value, text_blob("new"));
        assert_eq!(con.command_count("HGET"), 1);
        assert_eq!(con.command_count("HSCAN"), 1);
        assert!(con.commands[0].contains("\r\nExact\r\n"));
        let page = super::load_more_collection(&mut con, b"hash", "hash", 512, 200, Some("Exact"), None).await.unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = page else { panic!("expected hash") };
        assert_eq!(scan_cursor, None);
        assert_eq!(items[0].field, text_blob("prefix:Exact"));
        assert_eq!(con.command_count("HGET"), 1);
    }

    #[tokio::test]
    async fn hash_search_distinguishes_empty_exact_values_from_missing_fields() {
        let mut con = FakeRedisConnection::new(vec![bulk(""), hscan_response("100", vec![])]);
        let (cursor, items) = super::hscan_filtered_page_raw(&mut con, b"hash", 0, 200, "field").await.unwrap();
        assert_eq!(cursor, 100);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].value, text_blob(""));
        assert_eq!(con.command_count("HSCAN"), 1);
    }

    #[tokio::test]
    async fn hash_search_exact_seed_keeps_overflow_pages_and_refreshes_ttls() {
        let mut con = FakeRedisConnection::new(vec![
            bulk("old"),
            hscan_response("0", vec![("wanted", "new"), ("wanted:2", "two"), ("wanted:3", "three")]),
            httl_response(1, 100),
            httl_response(1, 90),
            httl_response(1, 80),
        ]);
        let first = super::load_more_collection(&mut con, b"exact-overflow-hash", "hash", 0, 1, Some("wanted"), None)
            .await
            .unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = first else { panic!("expected Hash") };
        let cursor = scan_cursor.unwrap();
        assert!(cursor >= super::COLLECTION_OVERFLOW_CURSOR_START);
        assert_eq!(items[0].value, text_blob("new"));
        assert_eq!(items[0].field_ttl, Some(100));
        let second =
            super::load_more_collection(&mut con, b"exact-overflow-hash", "hash", cursor, 1, Some("wanted"), None)
                .await
                .unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = second else { panic!("expected Hash") };
        assert_eq!(scan_cursor, Some(cursor));
        assert_eq!(items[0].field, text_blob("wanted:2"));
        assert_eq!(items[0].field_ttl, Some(90));
        let third =
            super::load_more_collection(&mut con, b"exact-overflow-hash", "hash", cursor, 1, Some("wanted"), None)
                .await
                .unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = third else { panic!("expected Hash") };
        assert_eq!(scan_cursor, None);
        assert_eq!(items[0].field, text_blob("wanted:3"));
        assert_eq!(items[0].field_ttl, Some(80));
        assert_eq!(con.command_count("HGET"), 1);
        assert_eq!(con.command_count("HSCAN"), 1);
    }

    #[tokio::test]
    async fn hash_search_optional_lookup_errors_fall_back_without_hiding_real_failures() {
        for error in [
            noperm("hget"),
            redis::RedisError::from((
                redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
                "ERR",
                "unknown command 'HGET'".to_string(),
            )),
        ] {
            let mut con =
                FakeRedisConnection::with_results(vec![Err(error), Ok(hscan_response("0", vec![("field", "wanted")]))]);
            let (_, items) = super::hscan_filtered_page_raw(&mut con, b"hash", 0, 200, "wanted").await.unwrap();
            assert_eq!(items.len(), 1);
        }
        for error in [
            redis::RedisError::from((redis::ErrorKind::Io, "disconnected")),
            redis::RedisError::from((redis::ErrorKind::AuthenticationFailed, "WRONGPASS")),
            redis::RedisError::from((redis::ErrorKind::UnexpectedReturnType, "WRONGTYPE")),
        ] {
            let mut con = FakeRedisConnection::with_results(vec![Err(error)]);
            assert!(super::hscan_filtered_page_raw(&mut con, b"hash", 0, 200, "wanted").await.is_err());
            assert_eq!(con.command_count("HSCAN"), 0);
        }
    }

    #[tokio::test]
    async fn hash_search_exact_lookup_keeps_binary_keys_and_unicode_queries() {
        let mut con = FakeRedisConnection::new(vec![bulk("value"), hscan_response("0", vec![])]);
        let (cursor, items) = super::hscan_filtered_page_raw(&mut con, b"hash\xff", 0, 200, "用户").await.unwrap();
        assert_eq!(cursor, 0);
        assert_eq!(items[0].field, text_blob("用户"));
    }

    // Exercise the production page/TTL/overflow path against a disposable server.
    async fn verify_large_hash_search_live<C>(con: &mut C) -> Result<(), String>
    where
        C: ConnectionLike + Send + Sync + Unpin,
    {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let key = format!("dbx-11491-{}-{nonce}", std::process::id());
        let query = "EC00100051EB02DD";
        let expected = [query.to_string(), query.to_lowercase(), format!("prefix:{query}"), "value-only".to_string()];
        let result = async {
            for start in (0..25_000).step_by(500) {
                let mut command = redis::cmd("HSET");
                command.arg(&key);
                for index in start..start + 500 {
                    command.arg(format!("filler:{index:05}")).arg("unrelated payload");
                }
                command.query_async::<u64>(con).await.map_err(|error| error.to_string())?;
                // Ensure even interrupted manual runs leave no persistent test data.
                redis::cmd("EXPIRE")
                    .arg(&key)
                    .arg(600)
                    .query_async::<bool>(con)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let mut command = redis::cmd("HSET");
            command.arg(&key);
            for field in &expected {
                command.arg(field).arg(if field == "value-only" { "contains Ec00100051eb02dd" } else { "" });
            }
            command.query_async::<u64>(con).await.map_err(|error| error.to_string())?;
            for search in [query, "ec00100051eb02dd", "00100051", "absent-11491"] {
                let mut cursor = 0;
                let mut found = HashMap::new();
                let mut requests = 0;
                loop {
                    let page =
                        super::load_more_collection(con, key.as_bytes(), "hash", cursor, 200, Some(search), None)
                            .await?;
                    let RedisCollectionPage::Hash { items, scan_cursor } = page else {
                        return Err("expected Hash page".to_string());
                    };
                    requests += 1;
                    if search == query && requests == 1 {
                        if items.first().map(|item| &item.field) != Some(&text_blob(query)) || scan_cursor.is_none() {
                            return Err("exact field was not prioritized with a continuation".to_string());
                        }
                        if items[0].value != text_blob("") {
                            return Err("empty value was lost".to_string());
                        }
                    }
                    for item in items {
                        found.insert(item.field.raw_base64.clone(), item);
                    }
                    let Some(next) = scan_cursor else { break };
                    cursor = next;
                    if requests > 200 {
                        return Err("scan did not finish".to_string());
                    }
                }
                let wanted: std::collections::HashSet<_> = if search == "absent-11491" {
                    Default::default()
                } else {
                    expected.iter().map(|field| text_blob(field).raw_base64).collect()
                };
                if found.keys().cloned().collect::<std::collections::HashSet<_>>() != wanted {
                    return Err(format!("incomplete search for {search}: {} matches", found.len()));
                }
                eprintln!("large Hash search {search}: {requests} pages, {} unique matches", found.len());
            }
            Ok(())
        }
        .await;
        let cleanup = redis::cmd("DEL").arg(&key).query_async::<u64>(con).await.map_err(|error| error.to_string());
        result.and(cleanup.map(|_| ()))
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis via DBX_TEST_REDIS_URL"]
    async fn hash_search_large_hash_live() {
        let url = std::env::var("DBX_TEST_REDIS_URL").expect("DBX_TEST_REDIS_URL");
        let mut con = super::connect(&url, std::time::Duration::from_secs(5)).await.unwrap();
        verify_large_hash_search_live(&mut con).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires disposable Cluster via DBX_TEST_REDIS_CLUSTER_PORT"]
    async fn hash_search_large_hash_cluster_live() {
        let mut config = redis_test_connection_config();
        config.host = "127.0.0.1".to_string();
        config.port =
            std::env::var("DBX_TEST_REDIS_CLUSTER_PORT").expect("DBX_TEST_REDIS_CLUSTER_PORT").parse().unwrap();
        let pool = super::connect_cluster(&config).await.unwrap();
        let mut con = super::cluster_key_connection(&pool, b"dbx-11491").await.unwrap();
        verify_large_hash_search_live(&mut con).await.unwrap();
    }

    #[tokio::test]
    async fn filtered_hash_load_more_matches_fields_and_keeps_scan_cursor() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Nil,
            hscan_response("512", vec![("user:1", "Ada")]),
            hscan_response("0", vec![("user:2", "Bob")]),
        ]);

        let result =
            super::load_more_collection(&mut con, b"hash-key", "hash", 0, 1, Some("user"), None).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, Some(512));
        assert_eq!(items, vec![RedisHashItem { field: text_blob("user:1"), value: text_blob("Ada"), field_ttl: None }]);
        assert_eq!(con.command_count("HSCAN"), 1);
        assert!(!con.commands.iter().any(|command| command.contains("\r\nMATCH\r\n")));
    }

    #[tokio::test]
    async fn filtered_hash_load_more_matches_values() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Nil,
            hscan_response("0", vec![("status", "Ada Lovelace"), ("name", "Bob")]),
        ]);

        let result =
            super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, Some("lovelace"), None).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(
            items,
            vec![RedisHashItem { field: text_blob("status"), value: text_blob("Ada Lovelace"), field_ttl: None }]
        );
        assert_eq!(con.command_count("HSCAN"), 1);
        assert!(!con.commands.iter().any(|command| command.contains("\r\nMATCH\r\n")));
    }

    #[tokio::test]
    async fn filtered_set_load_more_matches_members() {
        let mut con = FakeRedisConnection::new(vec![scan_response("0", vec!["Ada Lovelace", "Bob"])]);

        let result =
            super::load_more_collection(&mut con, b"set-key", "set", 0, 20, Some("lovelace"), None).await.unwrap();

        let RedisCollectionPage::Set { items, scan_cursor } = result else {
            panic!("expected set collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(items, vec![RedisSetItem { member: text_blob("Ada Lovelace") }]);
        assert_eq!(con.command_count("SSCAN"), 1);
        // Substring search cannot be expressed as an SSCAN glob, so no MATCH is sent.
        assert!(!con.commands.iter().any(|command| command.contains("\r\nMATCH\r\n")));
    }

    #[tokio::test]
    async fn filtered_set_load_more_keeps_scanning_until_the_page_fills() {
        let mut con =
            FakeRedisConnection::new(vec![scan_response("512", vec!["Bob"]), scan_response("0", vec!["Ada Lovelace"])]);

        let result =
            super::load_more_collection(&mut con, b"set-key", "set", 0, 20, Some("lovelace"), None).await.unwrap();

        let RedisCollectionPage::Set { items, scan_cursor } = result else {
            panic!("expected set collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(items, vec![RedisSetItem { member: text_blob("Ada Lovelace") }]);
        assert_eq!(con.command_count("SSCAN"), 2);
    }

    #[tokio::test]
    async fn filtered_set_load_more_caps_sparse_scan_iterations() {
        let responses = (1..=super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS + 1)
            .map(|cursor| scan_response(&cursor.to_string(), vec![]))
            .collect();
        let mut con = FakeRedisConnection::new(responses);

        let result =
            super::load_more_collection(&mut con, b"set-key", "set", 0, 20, Some("missing"), None).await.unwrap();

        let RedisCollectionPage::Set { items, scan_cursor } = result else {
            panic!("expected set collection page");
        };
        assert_eq!(scan_cursor, Some(super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS as u64));
        assert!(items.is_empty());
        assert_eq!(con.command_count("SSCAN"), super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS);
    }

    #[tokio::test]
    async fn filtered_zset_load_more_matches_members_and_keeps_score_order() {
        let mut con = FakeRedisConnection::new(vec![zrange_response(vec![
            ("rank:alice", "1"),
            ("bob", "2"),
            ("rank:carol", "3"),
        ])]);

        let result =
            super::load_more_collection(&mut con, b"scores", "zset", 0, 20, Some("RANK:"), Some("asc")).await.unwrap();

        let RedisCollectionPage::Zset { items, scan_cursor } = result else {
            panic!("expected zset collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(
            items,
            vec![
                RedisZsetItem { score: "1".to_string(), member: text_blob("rank:alice") },
                RedisZsetItem { score: "3".to_string(), member: text_blob("rank:carol") },
            ]
        );
        // Ranked paging is kept so the score sort and the index cursor survive filtering.
        assert_eq!(con.command_count("ZRANGE"), 1);
        assert_eq!(con.command_count("ZSCAN"), 0);
    }

    #[tokio::test]
    async fn filtered_zset_load_more_honors_descending_pages() {
        let mut con = FakeRedisConnection::new(vec![zrange_response(vec![
            ("rank:carol", "3"),
            ("bob", "2"),
            ("rank:alice", "1"),
        ])]);

        let result =
            super::load_more_collection(&mut con, b"scores", "zset", 0, 20, Some("rank:"), Some("desc")).await.unwrap();

        let RedisCollectionPage::Zset { items, scan_cursor } = result else {
            panic!("expected zset collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(
            items,
            vec![
                RedisZsetItem { score: "3".to_string(), member: text_blob("rank:carol") },
                RedisZsetItem { score: "1".to_string(), member: text_blob("rank:alice") },
            ]
        );
        assert_eq!(con.command_count("ZREVRANGE"), 1);
        assert_eq!(con.command_count("ZRANGE"), 0);
    }

    #[tokio::test]
    async fn filtered_zset_load_more_advances_the_cursor_past_every_scanned_member() {
        let mut con = FakeRedisConnection::new(vec![
            zrange_response(vec![("bob", "2"), ("dave", "4"), ("erin", "5")]),
            zrange_response(vec![("rank:alice", "1"), ("rank:carol", "3"), ("grace", "7")]),
        ]);

        let result =
            super::load_more_collection(&mut con, b"scores", "zset", 0, 2, Some("rank:"), Some("asc")).await.unwrap();

        let RedisCollectionPage::Zset { items, scan_cursor } = result else {
            panic!("expected zset collection page");
        };
        assert_eq!(
            items,
            vec![
                RedisZsetItem { score: "1".to_string(), member: text_blob("rank:alice") },
                RedisZsetItem { score: "3".to_string(), member: text_blob("rank:carol") },
            ]
        );
        // Two windows of two were consumed, so resuming must not replay the first one.
        assert_eq!(scan_cursor, Some(4));
        assert_eq!(con.command_count("ZRANGE"), 2);
    }

    #[tokio::test]
    async fn filtered_list_load_more_preserves_original_indices() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(8),
            RedisRawValue::Array(vec![
                bulk("alpha"),
                bulk("beta"),
                bulk("gamma"),
                bulk("target-one"),
                bulk("delta"),
                bulk("epsilon"),
                bulk("zeta"),
                bulk("target-two"),
            ]),
        ]);

        let result =
            super::load_more_collection(&mut con, b"list-key", "list", 0, 20, Some("target-"), None).await.unwrap();

        let RedisCollectionPage::List { items, scan_cursor } = result else {
            panic!("expected list collection page");
        };
        assert_eq!(scan_cursor, None);
        // Indices must stay absolute: the viewer deletes list entries by index.
        assert_eq!(
            items,
            vec![
                RedisListItem { index: 3, value: text_blob("target-one") },
                RedisListItem { index: 7, value: text_blob("target-two") },
            ]
        );
        assert_eq!(con.command_count("LRANGE"), 1);
    }

    #[tokio::test]
    async fn filtered_list_load_more_still_walks_when_llen_is_not_permitted() {
        let mut con = FakeRedisConnection::with_results(vec![
            Err(noperm("llen")),
            Ok(RedisRawValue::Array(vec![bulk("target-one"), bulk("beta")])),
            Ok(RedisRawValue::Array(vec![])),
        ]);

        let result =
            super::load_more_collection(&mut con, b"list-key", "list", 0, 2, Some("target-"), None).await.unwrap();

        let RedisCollectionPage::List { items, scan_cursor } = result else {
            panic!("expected list collection page");
        };
        assert_eq!(items, vec![RedisListItem { index: 0, value: text_blob("target-one") }]);
        assert_eq!(scan_cursor, None);
        assert_eq!(con.command_count("LRANGE"), 2);
    }

    #[tokio::test]
    async fn filtered_list_load_more_stops_at_the_list_length() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Int(3),
            RedisRawValue::Array(vec![bulk("alpha"), bulk("beta")]),
            RedisRawValue::Array(vec![bulk("gamma")]),
        ]);

        let result =
            super::load_more_collection(&mut con, b"list-key", "list", 0, 2, Some("missing"), None).await.unwrap();

        let RedisCollectionPage::List { items, scan_cursor } = result else {
            panic!("expected list collection page");
        };
        assert!(items.is_empty());
        assert_eq!(scan_cursor, None);
        assert_eq!(con.command_count("LRANGE"), 2);
        assert_eq!(con.command_count("LLEN"), 1);
    }

    #[tokio::test]
    async fn binary_hash_ttl_discovery_avoids_unsafe_unknown_command_errors() {
        for (key, field) in
            [(b"hash".as_slice(), b"\x03kryo\xf3".as_slice()), (b"hash\xff", b"field"), (b"hash", b"field\r\n")]
        {
            let mut items = vec![RedisHashItem {
                field: redis_blob_from_bytes(field),
                value: redis_blob_from_bytes(b"\x01value\xff"),
                field_ttl: None,
            }];
            let original = items.clone();
            let mut con = FakeRedisConnection::new(vec![RedisRawValue::Array(vec![RedisRawValue::Nil])]);
            super::attach_hash_field_ttls(&mut con, key, &mut items).await.unwrap();
            assert_eq!(items, original);
            assert_eq!(con.command_count("COMMAND"), 1);
            assert_eq!(con.commands.len(), 1);
            assert!(!con.commands[0].contains("\r\nFIELDS\r\n"));
            assert!(con.responses.is_empty());

            let mut con = FakeRedisConnection::new(vec![
                RedisRawValue::Array(vec![RedisRawValue::Array(vec![bulk("httl")])]),
                httl_response(1, 42),
            ]);
            super::attach_hash_field_ttls(&mut con, key, &mut items).await.unwrap();
            assert_eq!(items[0].field_ttl, Some(42));
            assert_eq!(con.commands.len(), 2);
            assert!(con.commands[1].contains("\r\nFIELDS\r\n"));
            assert!(con.responses.is_empty());
        }
    }

    #[tokio::test]
    async fn binary_hash_command_discovery_only_suppresses_optional_errors() {
        let mut items = vec![RedisHashItem {
            field: redis_blob_from_bytes(b"\x03kryo\xf3"),
            value: text_blob("value"),
            field_ttl: None,
        }];
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("command"))]);
        super::attach_hash_field_ttls(&mut con, b"hash", &mut items).await.unwrap();
        assert_eq!(con.commands.len(), 1);
        assert_eq!(items[0].field_ttl, None);

        let mut con = FakeRedisConnection::with_results(vec![Err(redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "server error",
            "unrelated discovery failure".to_string(),
        )))]);
        assert!(super::attach_hash_field_ttls(&mut con, b"hash", &mut items)
            .await
            .unwrap_err()
            .contains("unrelated discovery failure"));
    }

    #[tokio::test]
    async fn hash_load_more_attaches_field_ttl_when_supported() {
        let mut con = FakeRedisConnection::new(vec![
            hscan_response("0", vec![("session", "Ada")]),
            RedisRawValue::Array(vec![RedisRawValue::Int(42)]),
        ]);

        let result = super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, None, None).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, None);
        assert_eq!(items[0].field_ttl, Some(42));
        assert_eq!(con.command_count("HTTL"), 1);
    }

    #[tokio::test]
    async fn hash_load_more_keeps_persistent_field_ttl() {
        let mut con = FakeRedisConnection::new(vec![
            hscan_response("0", vec![("session", "Ada")]),
            RedisRawValue::Array(vec![RedisRawValue::Int(-1)]),
        ]);

        let result = super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, None, None).await.unwrap();

        let RedisCollectionPage::Hash { items, .. } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(items[0].field_ttl, Some(-1));
    }

    #[tokio::test]
    async fn hash_load_more_degrades_when_field_ttl_is_unsupported() {
        let unsupported = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "unknown command 'HTTL'".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(hscan_response("0", vec![("session", "Ada")])),
            Err(unsupported),
        ]);

        let result = super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, None, None).await.unwrap();

        let RedisCollectionPage::Hash { items, .. } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(items[0].field_ttl, None);
    }

    #[tokio::test]
    async fn hash_set_preserves_existing_field_ttl() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Array(vec![RedisRawValue::Int(42)]),
            RedisRawValue::Okay,
            RedisRawValue::Array(vec![RedisRawValue::Int(1)]),
        ]);

        super::hash_set(&mut con, b"hash-key", "session", "Grace", None).await.unwrap();

        assert_eq!(con.command_count("HTTL"), 1);
        assert_eq!(con.command_count("HSET"), 1);
        assert_eq!(con.command_count("HEXPIRE"), 1);
    }

    fn legacy_hash_expiry_error() -> redis::RedisError {
        redis::parse_redis_value(
            b"-ERR Invalid argument: hash field expiration is not supported by legacy hash encoding\r\n",
        )
        .unwrap()
        .extract_error()
        .unwrap_err()
    }

    #[tokio::test]
    async fn legacy_hash_value_keeps_bounded_pages_and_key_ttl() {
        let pairs = (0..201).map(|index| (format!("f{index}"), format!("v{index}"))).collect();
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(bulk("hash")),
            Ok(RedisRawValue::Int(73)),
            Ok(RedisRawValue::Int(201)),
            Ok(hscan_response_owned("0", pairs)),
            Err(legacy_hash_expiry_error()),
            Err(legacy_hash_expiry_error()),
        ]);

        let value = super::get_value(&mut con, b"legacy-paged-hash").await.unwrap();
        assert_eq!(value.ttl, 73);
        let RedisValueData::Hash { items, total, scan_cursor } = value.data else {
            panic!("expected hash");
        };
        assert_eq!(total, 201);
        assert_eq!(items.len(), 200);
        assert!(items.iter().all(|item| item.field_ttl.is_none()));
        assert_eq!(items[199].field, text_blob("f199"));
        let page =
            super::load_more_collection(&mut con, b"legacy-paged-hash", "hash", scan_cursor.unwrap(), 200, None, None)
                .await
                .unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = page else {
            panic!("expected hash page");
        };
        assert_eq!(items, vec![RedisHashItem { field: text_blob("f200"), value: text_blob("v200"), field_ttl: None }]);
        assert_eq!(scan_cursor, None);
        assert_eq!(con.command_count("HSCAN"), 1);
        assert_eq!(con.command_count("HTTL"), 2);
        assert!(con.commands[4].contains("\r\n200\r\n"));
        assert!(!con.commands[4].contains("\r\nf200\r\n"));
        assert!(con.responses.is_empty());
    }

    #[tokio::test]
    async fn legacy_hash_load_more_does_not_disable_ttl_for_other_hashes() {
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(hscan_response("17", vec![("field", "value")])),
            Err(legacy_hash_expiry_error()),
            Ok(hscan_response("0", vec![("field", "value")])),
            Ok(httl_response(1, 42)),
        ]);
        for (key, cursor, expected_ttl) in [(b"legacy".as_slice(), Some(17), None), (b"modern", None, Some(42))] {
            let page = super::load_more_collection(&mut con, key, "hash", 0, 1, None, None).await.unwrap();
            let RedisCollectionPage::Hash { items, scan_cursor } = page else {
                panic!("expected hash page");
            };
            assert_eq!(scan_cursor, cursor);
            assert_eq!(
                items,
                vec![RedisHashItem { field: text_blob("field"), value: text_blob("value"), field_ttl: expected_ttl }]
            );
        }
        assert_eq!(con.command_count("HTTL"), 2);
        assert!(con.responses.is_empty());
    }

    #[tokio::test]
    async fn legacy_hash_set_does_not_disable_ttl_for_other_hashes() {
        let mut con = FakeRedisConnection::with_results(vec![
            Err(legacy_hash_expiry_error()),
            Ok(RedisRawValue::Okay),
            Ok(httl_response(1, 42)),
            Ok(RedisRawValue::Okay),
            Ok(httl_response(1, 1)),
        ]);
        super::hash_set(&mut con, b"legacy", "field", "value", None).await.unwrap();
        super::hash_set(&mut con, b"modern", "field", "value", None).await.unwrap();
        assert_eq!(con.command_count("HTTL"), 2);
        assert_eq!(con.command_count("HSET"), 2);
        assert_eq!(con.command_count("HEXPIRE"), 1);
        assert_eq!(con.command_count("EXPIRE"), 0);
        assert!(con.commands[4].contains("\r\nmodern\r\n$2\r\n42\r\n"));
        assert!(con.responses.is_empty());
    }

    #[tokio::test]
    async fn hash_ttl_discovery_keeps_unrelated_errors_fatal() {
        for detail in [
            "operation not supported",
            "Invalid argument: hash field expiration is not supported by another encoding",
            "WRONGTYPE Operation against a key holding the wrong kind of value",
            "Invalid argument: hash field expiration is not supported by legacy hash encoding: extra failure",
        ] {
            let error = || {
                redis::RedisError::from((
                    redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
                    "server error",
                    detail.to_string(),
                ))
            };
            let mut con = FakeRedisConnection::with_results(vec![Err(error())]);
            assert!(super::hash_set(&mut con, b"hash", "field", "value", None).await.unwrap_err().contains(detail));
            assert_eq!(con.command_count("HSET"), 0);
            let mut con =
                FakeRedisConnection::with_results(vec![Ok(hscan_response("0", vec![("f", "v")])), Err(error())]);
            assert!(super::load_more_collection(&mut con, b"hash", "hash", 0, 1, None, None)
                .await
                .unwrap_err()
                .contains(detail));
        }
        let disconnected =
            || redis::RedisError::from(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset"));
        let mut con = FakeRedisConnection::with_results(vec![Err(disconnected())]);
        assert!(super::hash_set(&mut con, b"hash", "field", "value", None).await.is_err());
        assert_eq!(con.command_count("HSET"), 0);
        let mut con =
            FakeRedisConnection::with_results(vec![Ok(hscan_response("0", vec![("f", "v")])), Err(disconnected())]);
        assert!(super::load_more_collection(&mut con, b"hash", "hash", 0, 1, None, None).await.is_err());
    }

    #[tokio::test]
    async fn legacy_hash_explicit_expiry_errors_remain_visible() {
        let mut con = FakeRedisConnection::with_results(vec![
            Err(legacy_hash_expiry_error()),
            Err(legacy_hash_expiry_error()),
            Err(legacy_hash_expiry_error()),
        ]);
        assert!(super::set_hash_field_ttl(&mut con, b"hash", "field", 60).await.is_err());
        assert!(super::set_hash_field_ttl(&mut con, b"hash", "field", -1).await.is_err());
        assert!(super::set_hash_field_expire_at(&mut con, b"hash", "field", 1_735_689_600).await.is_err());
        assert_eq!(con.command_count("HEXPIRE"), 1);
        assert_eq!(con.command_count("HPERSIST"), 1);
        assert_eq!(con.command_count("HEXPIREAT"), 1);
    }

    #[tokio::test]
    async fn hash_set_keeps_explicit_key_ttl_and_missing_field_behavior() {
        for ttl in [Some(60), Some(0), Some(-1)] {
            let mut con = FakeRedisConnection::new(vec![RedisRawValue::Okay, RedisRawValue::Okay]);
            super::hash_set(&mut con, b"hash", "field", "value", ttl).await.unwrap();
            assert_eq!(con.command_count("HTTL"), 0);
            assert_eq!(con.command_count("HSET"), 1);
            assert_eq!(con.command_count("EXPIRE"), usize::from(ttl == Some(60)));
        }
        for response in [httl_response(1, -2), httl_response(1, -1), httl_response(0, -2)] {
            let mut con = FakeRedisConnection::new(vec![response, RedisRawValue::Okay]);
            super::hash_set(&mut con, b"hash", "field", "value", None).await.unwrap();
            assert_eq!(con.command_count("HSET"), 1);
            assert_eq!(con.command_count("HEXPIRE"), 0);
        }
        let mut con = FakeRedisConnection::new(vec![hscan_response("0", vec![])]);
        let page = super::load_more_collection(&mut con, b"hash", "hash", 0, 1, None, None).await.unwrap();
        assert!(matches!(page, RedisCollectionPage::Hash { items, scan_cursor: None } if items.is_empty()));
        assert_eq!(con.command_count("HTTL"), 0);
    }

    #[tokio::test]
    async fn legacy_hash_update_handles_encoding_only_in_discovery() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(2)]);
        super::hash_field_update(&mut con, b"hash", "old", "new", "value").await.unwrap();
        assert_eq!(con.commands.len(), 1);
        assert_eq!(con.command_count("EVAL"), 1);
        let script = &con.commands[0];
        let discovery =
            script.split("local ttl_reply =").nth(1).unwrap().split("local function restore_source").next().unwrap();
        assert!(discovery.contains("hash field expiration is not supported by legacy hash encoding"));
        let writes = script.split("local function restore_source").nth(1).unwrap();
        assert!(!writes.contains("legacy hash encoding"));
    }

    #[tokio::test]
    async fn legacy_hash_pages_keep_byte_and_sparse_scan_limits() {
        let value = "v".repeat(super::COLLECTION_PAGE_MAX_BYTES / 2);
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(hscan_response("0", vec![("first", &value), ("second", &value)])),
            Err(legacy_hash_expiry_error()),
            Err(legacy_hash_expiry_error()),
        ]);
        let mut cursor = 0;
        for field in ["first", "second"] {
            let page = super::load_more_collection(&mut con, b"legacy-byte-limit", "hash", cursor, 200, None, None)
                .await
                .unwrap();
            let RedisCollectionPage::Hash { items, scan_cursor } = page else {
                panic!("expected hash page");
            };
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].field, text_blob(field));
            assert_eq!(items[0].value, text_blob(&value));
            assert!(items[0].field_ttl.is_none());
            assert!(super::hash_item_page_bytes(&items[0]) <= super::COLLECTION_PAGE_MAX_BYTES);
            cursor = scan_cursor.unwrap_or(0);
        }
        assert_eq!(cursor, 0);
        assert_eq!(con.command_count("HSCAN"), 1);
        assert_eq!(con.command_count("HTTL"), 2);

        let mut responses = (1..=super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS)
            .map(|cursor| Ok(hscan_response(&cursor.to_string(), vec![("field", "unmatched")])))
            .collect::<Vec<_>>();
        *responses.last_mut().unwrap() = Ok(hscan_response("10", vec![("field", "wanted")]));
        responses.push(Err(legacy_hash_expiry_error()));
        responses.insert(0, Ok(RedisRawValue::Nil));
        let mut con = FakeRedisConnection::with_results(responses);
        let page =
            super::load_more_collection(&mut con, b"legacy-sparse", "hash", 0, 20, Some("wanted"), None).await.unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor } = page else {
            panic!("expected hash page");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].value, text_blob("wanted"));
        assert!(items[0].field_ttl.is_none());
        assert_eq!(scan_cursor, Some(10));
        assert_eq!(con.command_count("HSCAN"), 10);
        assert_eq!(con.command_count("HTTL"), 1);
    }

    #[tokio::test]
    async fn hash_ttl_discovery_preserves_rust_permission_fallback() {
        let mut con = FakeRedisConnection::with_results(vec![
            Err(noperm("httl")),
            Ok(RedisRawValue::Okay),
            Ok(hscan_response("0", vec![("f", "v")])),
            Err(noperm("httl")),
        ]);
        super::hash_set(&mut con, b"hash", "field", "value", None).await.unwrap();
        let page = super::load_more_collection(&mut con, b"hash", "hash", 0, 1, None, None).await.unwrap();
        assert!(matches!(page, RedisCollectionPage::Hash { items, .. } if items[0].field_ttl.is_none()));
        assert_eq!(con.command_count("HTTL"), 2);
        assert_eq!(con.command_count("HSET"), 1);
    }

    #[tokio::test]
    async fn legacy_hash_fallback_keeps_write_and_scan_errors_visible() {
        let mut con = FakeRedisConnection::with_results(vec![Err(legacy_hash_expiry_error()), Err(noperm("hset"))]);
        assert!(super::hash_set(&mut con, b"hash", "field", "value", None).await.is_err());
        assert_eq!(con.command_count("HSET"), 1);
        assert_eq!(con.commands.len(), 2);
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(httl_response(1, 42)),
            Ok(RedisRawValue::Okay),
            Err(legacy_hash_expiry_error()),
        ]);
        assert!(super::hash_set(&mut con, b"hash", "field", "value", None).await.is_err());
        assert_eq!(con.command_count("HEXPIRE"), 1);
        let mut con = FakeRedisConnection::with_results(vec![
            Ok(bulk("hash")),
            Ok(RedisRawValue::Int(-1)),
            Ok(RedisRawValue::Int(1)),
            Err(noperm("hscan")),
        ]);
        assert!(super::get_value(&mut con, b"hash").await.is_err());
        assert_eq!(con.command_count("HTTL"), 0);
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis via DBX_TEST_REDIS_URL; injects Kvrocks HTTL replies into production Lua"]
    async fn hash_field_update_lua_legacy_encoding_regression() {
        let mut trace = FakeRedisConnection::new(vec![RedisRawValue::Int(2)]);
        super::hash_field_update(&mut trace, b"hash", "old", "new", "after").await.unwrap();
        let RedisRawValue::Array(args) = redis::parse_redis_value(trace.commands[0].as_bytes()).unwrap() else {
            panic!("expected EVAL arguments");
        };
        let script = String::from_utf8(redis_value_to_bytes(args[1].clone()).unwrap()).unwrap();
        let probe = "redis.pcall('HTTL', key, 'FIELDS', 1, old_field)";
        assert_eq!(script.matches(probe).count(), 1);
        let url = std::env::var("DBX_TEST_REDIS_URL").expect("DBX_TEST_REDIS_URL");
        let mut con = super::connect(&url, std::time::Duration::from_secs(5)).await.unwrap();
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let key = format!("dbx-10948-{}-{nonce}", std::process::id());
        for (reply, success) in [
            ("Invalid argument: hash field expiration is not supported by legacy hash encoding", true),
            ("ERR Invalid argument: hash field expiration is not supported by legacy hash encoding", true),
            ("NOPERM no permission to run HTTL", false),
            ("WRONGTYPE Operation against a key holding the wrong kind of value", false),
            ("ERR operation not supported", false),
            (
                "ERR Invalid argument: hash field expiration is not supported by legacy hash encoding: extra failure",
                false,
            ),
        ] {
            let injected = script.replace(probe, &format!("{{err = '{reply}'}}"));
            for destination in ["old", "new"] {
                redis::cmd("DEL").arg(&key).query_async::<()>(&mut con).await.unwrap();
                redis::cmd("HSET")
                    .arg(&key)
                    .arg("old")
                    .arg("before")
                    .arg("keeper")
                    .arg("keep")
                    .query_async::<()>(&mut con)
                    .await
                    .unwrap();
                redis::cmd("EXPIRE").arg(&key).arg(60).query_async::<()>(&mut con).await.unwrap();
                let result: i64 = redis::cmd("EVAL")
                    .arg(&injected)
                    .arg(1)
                    .arg(&key)
                    .arg("old")
                    .arg(destination)
                    .arg("after")
                    .query_async(&mut con)
                    .await
                    .unwrap();
                assert_eq!(
                    result,
                    if success {
                        if destination == "old" {
                            1
                        } else {
                            2
                        }
                    } else {
                        -3
                    },
                    "{reply}"
                );
                let fields: HashMap<String, String> =
                    redis::cmd("HGETALL").arg(&key).query_async(&mut con).await.unwrap();
                let expected = if success { (destination, "after") } else { ("old", "before") };
                assert_eq!(
                    fields,
                    HashMap::from([
                        (expected.0.to_string(), expected.1.to_string()),
                        ("keeper".to_string(), "keep".to_string()),
                    ])
                );
                let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(&mut con).await.unwrap();
                assert!((1..=60).contains(&ttl));
            }
        }
        redis::cmd("DEL").arg(&key).query_async::<()>(&mut con).await.unwrap();
    }

    #[tokio::test]
    async fn hash_set_degrades_when_field_ttl_is_rejected_as_unknown_redis_command() {
        let unsupported = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "unknown redis command HTTL".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(unsupported), Ok(RedisRawValue::Okay)]);

        super::hash_set(&mut con, b"hash-key", "session", "Grace", None).await.unwrap();

        assert_eq!(con.command_count("HTTL"), 1);
        assert_eq!(con.command_count("HSET"), 1);
        assert_eq!(con.command_count("HEXPIRE"), 0);
    }

    #[tokio::test]
    async fn hash_field_update_uses_one_atomic_script_and_carries_field_ttl() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(2)]);

        super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap();

        assert_eq!(con.command_count("EVAL"), 1);
        // HSET/HDEL/HTTL/HEXPIRE are script body text, not independent
        // requests.  This guards the atomic path and its TTL handling.
        assert_eq!(con.command_count("HSET"), 0);
        assert_eq!(con.command_count("HDEL"), 0);
        assert!(con.commands[0].contains("redis.call('HEXISTS'"));
        assert!(con.commands[0].contains("redis.pcall('HTTL'"));
        assert!(con.commands[0].contains("redis.pcall('HEXPIRE'"));
        assert!(con.commands[0].contains("redis.pcall('HDEL'"));
        assert!(con.commands[0].contains("local delete_probe"));
        assert!(con.commands[0].contains("if source_ttl == 0 then"));
        // Regression guard for #7584: Redis < 7.4 answers the HTTL/HEXPIRE
        // probe with "Unknown Redis command called from [Lua] script", which
        // has to be recognised as an unsupported-command reply so the update
        // degrades instead of returning -3.
        assert!(con.commands[0].contains("'unknown redis command'"));
    }

    /// End-to-end regression for #7584 against a real Redis < 7.4.
    ///
    /// Set `DBX_TEST_REDIS_URL` to a Redis that predates hash-field expiry
    /// (for example `redis://127.0.0.1:6379` backed by Redis 7.2 or 6.2).
    /// The HTTL probe inside the Lua script fails there, and before the fix
    /// the mismatched error wording made both value-only edits and renames
    /// return "failed before completion". This exercises the actual
    /// `hash_field_update` path so the Lua matcher runs on the server.
    #[tokio::test]
    #[ignore = "requires a Redis without hash-field expiry via DBX_TEST_REDIS_URL"]
    async fn hash_field_update_degrades_on_redis_without_hash_field_ttl() {
        let url = std::env::var("DBX_TEST_REDIS_URL").expect("DBX_TEST_REDIS_URL");
        let mut con = super::connect(&url, std::time::Duration::from_secs(5)).await.unwrap();

        let key = b"dbx-7584-regression";
        redis::cmd("DEL").arg(&key[..]).query_async::<()>(&mut con).await.unwrap();
        redis::cmd("HSET").arg(&key[..]).arg("old_field").arg("value1").query_async::<()>(&mut con).await.unwrap();

        // Confirm this server takes the exact unsupported-command path that
        // triggered the regression rather than merely accepting HTTL.
        let unsupported_detail: String = redis::cmd("EVAL")
            .arg(
                "local reply = redis.pcall('HTTL', KEYS[1], 'FIELDS', 1, ARGV[1]); \
                 if type(reply) == 'table' and reply.err ~= nil then return reply.err end; \
                 return 'supported'",
            )
            .arg(1)
            .arg(&key[..])
            .arg("old_field")
            .query_async(&mut con)
            .await
            .unwrap();
        assert!(
            unsupported_detail.to_ascii_lowercase().contains("unknown redis command called from"),
            "expected Redis without hash-field expiry, got: {unsupported_detail}"
        );

        // Value-only edit must still succeed even though HTTL is unsupported.
        super::hash_field_update(&mut con, key, "old_field", "old_field", "value2").await.unwrap();
        let current: String = redis::cmd("HGET").arg(&key[..]).arg("old_field").query_async(&mut con).await.unwrap();
        assert_eq!(current, "value2");

        // Field rename must also succeed and leave only the new field behind.
        super::hash_field_update(&mut con, key, "old_field", "new_field", "value3").await.unwrap();
        let renamed: String = redis::cmd("HGET").arg(&key[..]).arg("new_field").query_async(&mut con).await.unwrap();
        assert_eq!(renamed, "value3");
        let old_exists: i64 = redis::cmd("HEXISTS").arg(&key[..]).arg("old_field").query_async(&mut con).await.unwrap();
        assert_eq!(old_exists, 0);

        redis::cmd("DEL").arg(&key[..]).query_async::<()>(&mut con).await.unwrap();
    }

    #[tokio::test]
    async fn hash_field_update_rejects_destination_collisions_without_follow_up_commands() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(-1)]);

        let error = super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap_err();

        assert!(error.contains("new name already exists"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn hash_field_update_reports_a_missing_source_field() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(0)]);

        let error = super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap_err();

        assert!(error.contains("no longer exists"));
        assert_eq!(con.command_count("EVAL"), 1);
    }

    #[tokio::test]
    async fn hash_field_update_supports_value_only_edits_without_renaming() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1)]);

        super::hash_field_update(&mut con, b"hash-key", "session", "session", "Grace").await.unwrap();

        assert_eq!(con.command_count("EVAL"), 1);
        assert!(con.commands[0].contains("if old_field == new_field then"));
    }

    #[tokio::test]
    async fn hash_field_update_keeps_failures_inside_the_atomic_operation() {
        let failure = redis::make_extension_error("ERR".to_string(), Some("script command failed".to_string()));
        let mut con = FakeRedisConnection::with_results(vec![Err(failure)]);

        let error = super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap_err();

        assert!(error.contains("script command failed"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.command_count("HSET"), 0);
        assert_eq!(con.command_count("HDEL"), 0);
    }

    #[tokio::test]
    async fn hash_field_update_falls_back_when_cluster_rejects_field_ttl_script() {
        let rejection = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "bad lua script for redis cluster, redis.call/pcall unknown redis command HTTL".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(rejection), Ok(RedisRawValue::Int(1))]);

        super::hash_field_update(&mut con, b"hash-key", "session", "session", "Grace").await.unwrap();

        assert_eq!(con.command_count("EVAL"), 2);
        assert!(con.commands[0].contains("redis.pcall('HTTL'"));
        assert!(!con.commands[1].contains("redis.pcall('HTTL'"));
        assert!(!con.commands[1].contains("redis.pcall('HEXPIRE'"));
        assert!(con.commands[1].contains("redis.call('HSET'") || con.commands[1].contains("redis.pcall('HSET'"));
    }

    #[tokio::test]
    async fn hash_field_update_falls_back_for_renames_when_cluster_rejects_field_ttl_script() {
        let rejection = redis::RedisError::from((
            redis::ErrorKind::Server(redis::ServerErrorKind::ResponseError),
            "An error was signalled by the server",
            "bad lua script for redis cluster, redis.call/pcall unknown redis command HTTL".to_string(),
        ));
        let mut con = FakeRedisConnection::with_results(vec![Err(rejection), Ok(RedisRawValue::Int(2))]);

        super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap();

        assert_eq!(con.command_count("EVAL"), 2);
        assert!(!con.commands[1].contains("redis.pcall('HTTL'"));
        assert!(!con.commands[1].contains("redis.pcall('HEXPIRE'"));
        assert!(con.commands[1].contains("old_field ~= new_field"));
        assert!(con.commands[1].contains("redis.pcall('HDEL', key, old_field)"));
    }

    #[tokio::test]
    async fn hash_field_update_reports_restricted_eval_access_without_fallback() {
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("eval"))]);

        let error = super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap_err();

        assert!(error.contains("EVAL and hash command permissions"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn hash_field_update_does_not_restore_a_source_that_disappeared_before_hdel() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(2)]);

        super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap();

        let script = &con.commands[0];
        let delete_branch = script.find("if tonumber(deleted) ~= 1 then").expect("HDEL result branch");
        let branch = &script[delete_branch..];
        assert!(branch.contains("redis.pcall('HDEL', key, new_field)"));
        assert!(branch.contains("return 0"));
        assert!(!branch.contains("restore_source()"));
    }

    #[tokio::test]
    async fn concurrent_hash_field_updates_use_serialized_evals_and_reject_the_loser() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(2), RedisRawValue::Int(0)]);

        super::hash_field_update(&mut con, b"hash-key", "session", "account", "Grace").await.unwrap();
        let error = super::hash_field_update(&mut con, b"hash-key", "session", "profile", "Grace").await.unwrap_err();

        assert!(error.contains("no longer exists"));
        assert_eq!(con.command_count("EVAL"), 2);
        assert_eq!(con.commands.len(), 2);
    }

    #[tokio::test]
    async fn hash_field_expiry_commands_accept_expected_results() {
        let mut con = FakeRedisConnection::new(vec![
            RedisRawValue::Array(vec![RedisRawValue::Int(1)]),
            RedisRawValue::Array(vec![RedisRawValue::Int(-1)]),
            RedisRawValue::Array(vec![RedisRawValue::Int(1)]),
        ]);

        super::set_hash_field_ttl(&mut con, b"hash-key", "session", 60).await.unwrap();
        super::set_hash_field_ttl(&mut con, b"hash-key", "session", -1).await.unwrap();
        super::set_hash_field_expire_at(&mut con, b"hash-key", "session", 1_735_689_600).await.unwrap();

        assert_eq!(con.command_count("HEXPIRE"), 1);
        assert_eq!(con.command_count("HPERSIST"), 1);
        assert_eq!(con.command_count("HEXPIREAT"), 1);
    }

    #[tokio::test]
    async fn filtered_hash_load_more_caps_sparse_scan_iterations() {
        let responses = (1..=super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS + 1)
            .map(|cursor| hscan_response(&cursor.to_string(), vec![]))
            .collect::<Vec<_>>();
        let mut responses = responses;
        responses.insert(0, RedisRawValue::Nil);
        let mut con = FakeRedisConnection::new(responses);

        let result =
            super::load_more_collection(&mut con, b"hash-key", "hash", 0, 20, Some("missing"), None).await.unwrap();

        let RedisCollectionPage::Hash { items, scan_cursor } = result else {
            panic!("expected hash collection page");
        };
        assert_eq!(scan_cursor, Some(super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS as u64));
        assert!(items.is_empty());
        assert_eq!(con.command_count("HSCAN"), super::COLLECTION_FILTER_SCAN_MAX_ITERATIONS);
    }

    #[tokio::test]
    async fn zset_update_passes_expected_score_to_the_atomic_script() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(1)]);

        let used_acl_compatibility =
            super::zset_update(&mut con, b"scores", "alice", "10", "alice", "20").await.unwrap();

        assert!(!used_acl_compatibility);
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.command_count("ZADD"), 0);
        assert!(con.commands[0].contains("\r\n$2\r\n10\r\n"));
        assert!(con.commands[0].contains("\r\n$2\r\n20\r\n"));
    }

    #[tokio::test]
    async fn zset_update_rejects_a_second_writer_with_a_stale_score() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(-2)]);

        let error = super::zset_update(&mut con, b"scores", "alice", "10", "alice", "30").await.unwrap_err();

        assert!(error.contains("score changed"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn zset_update_rejects_a_second_writer_renaming_a_member_with_a_stale_score() {
        let mut con = FakeRedisConnection::new(vec![RedisRawValue::Int(-2)]);

        let error = super::zset_update(&mut con, b"scores", "alice", "10", "alicia", "20").await.unwrap_err();

        assert!(error.contains("score changed"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.command_count("ZADD"), 0);
        assert_eq!(con.command_count("ZREM"), 0);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn zset_update_rejects_restricted_acl_score_edits_without_writing() {
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("eval"))]);

        let error = super::zset_update(&mut con, b"scores", "alice", "10", "alice", "20").await.unwrap_err();

        assert!(error.contains("EVAL and ZSCORE permissions"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.command_count("ZADD"), 0);
        assert_eq!(con.command_count("ZREM"), 0);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn zset_update_rejects_restricted_acl_renames_without_writing() {
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("zscore"))]);

        let error = super::zset_update(&mut con, b"scores", "alice", "10", "alicia", "20").await.unwrap_err();

        assert!(error.contains("EVAL and ZSCORE permissions"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.command_count("ZADD"), 0);
        assert_eq!(con.command_count("ZREM"), 0);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn zset_update_does_not_fallback_for_unrelated_acl_errors() {
        let mut con = FakeRedisConnection::with_results(vec![Err(noperm("zrem"))]);

        let error = super::zset_update(&mut con, b"scores", "alice", "10", "alicia", "20").await.unwrap_err();

        assert!(error.to_ascii_uppercase().contains("NOPERM"));
        assert_eq!(con.command_count("EVAL"), 1);
        assert_eq!(con.commands.len(), 1);
    }

    #[tokio::test]
    async fn zset_load_more_uses_ranked_ascending_pages() {
        let mut con =
            FakeRedisConnection::new(vec![zrange_response(vec![("alice", "1"), ("bob", "2"), ("carol", "3")])]);

        let result = super::load_more_collection(&mut con, b"scores", "zset", 0, 2, None, Some("asc")).await.unwrap();

        let RedisCollectionPage::Zset { items, scan_cursor } = result else {
            panic!("expected zset collection page");
        };
        assert_eq!(
            items,
            vec![
                RedisZsetItem { score: "1".to_string(), member: text_blob("alice") },
                RedisZsetItem { score: "2".to_string(), member: text_blob("bob") },
            ]
        );
        assert_eq!(scan_cursor, Some(2));
        assert_eq!(con.command_count("ZRANGE"), 1);
        assert_eq!(con.command_count("ZREVRANGE"), 0);
        assert_eq!(con.command_count("ZSCAN"), 0);
    }

    #[tokio::test]
    async fn zset_load_more_uses_ranked_descending_pages() {
        let mut con =
            FakeRedisConnection::new(vec![zrange_response(vec![("carol", "3"), ("bob", "2"), ("alice", "1")])]);

        let result = super::load_more_collection(&mut con, b"scores", "zset", 0, 2, None, Some("desc")).await.unwrap();

        let RedisCollectionPage::Zset { items, scan_cursor } = result else {
            panic!("expected zset collection page");
        };
        assert_eq!(
            items,
            vec![
                RedisZsetItem { score: "3".to_string(), member: text_blob("carol") },
                RedisZsetItem { score: "2".to_string(), member: text_blob("bob") },
            ]
        );
        assert_eq!(scan_cursor, Some(2));
        assert_eq!(con.command_count("ZRANGE"), 0);
        assert_eq!(con.command_count("ZREVRANGE"), 1);
        assert_eq!(con.command_count("ZSCAN"), 0);
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
    fn parses_empty_quoted_arguments() {
        let argv = parse_command_argv(r#"SET "" """#).unwrap();

        assert_eq!(argv, vec!["SET", "", ""]);
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
        for command_text in ["   ", "\"\""] {
            assert_eq!(parse_command_argv(command_text).unwrap_err(), "Redis command is empty");
        }
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
        assert_eq!(classify_command("JSON.DEL"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("JSON.FORGET"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("JSON.CLEAR"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("KEYS"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("flushall"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("eval"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("FCALL"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("XGROUP"), RedisCommandSafety::Blocked);
        assert_eq!(classify_command("VENDOR.WRITE"), RedisCommandSafety::Blocked);
    }

    // Regression for review feedback: an unknown command (e.g. FCALL) inside a
    // multi-statement batch must still raise the batch to Blocked regardless
    // of its position, so "DEL victim\nFCALL wipe 0" cannot execute the
    // destructive command after the frontend scan would otherwise have
    // stopped the run.
    #[test]
    fn classify_command_batch_blocks_on_any_unknown_member() {
        for batch in [
            // destructive first, unknown second
            ["DEL victim", "FCALL wipe 0"],
            // unknown first, destructive second
            ["FCALL wipe 0", "DEL victim"],
        ] {
            let mut highest = RedisCommandSafety::Allowed;
            for cmd in batch.iter() {
                let safety = classify_command(cmd);
                if matches!(safety, RedisCommandSafety::Blocked) {
                    highest = safety;
                    break;
                }
                if matches!(safety, RedisCommandSafety::Confirm) && !matches!(highest, RedisCommandSafety::Blocked) {
                    highest = safety;
                }
            }
            assert!(
                matches!(highest, RedisCommandSafety::Blocked),
                "batch {batch:?} must be Blocked because it contains FCALL, got {highest:?}"
            );
        }
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
        let info = connection_info("cache.example.com", 6379, true, true, "default", "secret", 0).unwrap();

        assert!(matches!(info.addr(), ConnectionAddr::TcpTls { insecure: true, .. }));
    }

    #[test]
    fn redis_connection_info_preserves_acl_username_and_password() {
        let info = connection_info("cache.example.com", 6379, false, false, "app-user", "secret", 0).unwrap();

        assert_eq!(info.redis_settings().username(), Some("app-user"));
        assert_eq!(info.redis_settings().password(), Some("secret"));
    }

    #[test]
    fn redis_command_denied_errors_are_not_auth_errors() {
        // Issue #9394: a managed Redis account that may connect but may not run PING.
        let noperm = "NOPERM User noping has no permissions to run the 'ping' command";
        assert!(is_redis_command_denied_error(noperm));
        assert!(is_redis_command_denied_error("ERR unknown command 'PING'"));
        assert!(is_redis_command_denied_error("ERR command 'PING' not supported"));
        assert!(is_redis_command_denied_error("command 'PING' not support for your account"));
        assert!(!is_redis_command_denied_error("WRONGPASS invalid username-password pair"));

        // The liveness probe must report a denied PING as plain wording, otherwise the credential
        // fallback in `connect_standalone` retries with a bogus candidate and the user sees a
        // misleading "password authentication failed" instead of the real cause.
        let ping_failure = "Redis ping failed: NOPERM User noping has no permissions to run the 'ping' command";
        assert!(!is_redis_auth_error(ping_failure));
        assert!(is_redis_auth_error("Redis connection failed: WRONGPASS invalid username-password pair"));
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
    fn standalone_connection_infos_cover_no_auth_acl_fallback_tls_and_database() {
        let mut config = redis_test_connection_config();
        let no_auth = standalone_connection_infos(&config, "127.0.0.1", 6379).unwrap();
        assert_eq!(no_auth.len(), 1);
        assert_eq!(no_auth[0].redis_settings().username(), None);
        assert_eq!(no_auth[0].redis_settings().password(), None);
        assert_eq!(no_auth[0].redis_settings().db(), 0);

        config.username = "app-user".to_string();
        config.password = "secret".to_string();
        config.database = Some("4".to_string());
        config.ssl = true;
        config.url_params = Some("tls_insecure=true".to_string());
        let infos = standalone_connection_infos(&config, "cache.example.com", 6380).unwrap();

        assert_eq!(infos.len(), 2);
        assert!(matches!(infos[0].addr(), ConnectionAddr::TcpTls { port: 6380, insecure: true, .. }));
        assert_eq!(infos[0].redis_settings().username(), Some("app-user"));
        assert_eq!(infos[0].redis_settings().password(), Some("secret"));
        assert_eq!(infos[0].redis_settings().db(), 4);
        assert_eq!(infos[1].redis_settings().username(), None);
        assert_eq!(infos[1].redis_settings().password(), Some("app-user@secret"));
        assert_eq!(infos[1].redis_settings().db(), 4);
    }

    #[test]
    fn redis_database_index_uses_numeric_database_only() {
        let mut config = redis_test_connection_config();
        config.database = Some("4".to_string());

        assert_eq!(redis_database_index(&config), 4);
        config.database = Some("not-a-number".to_string());
        assert_eq!(redis_database_index(&config), 0);
    }

    #[tokio::test]
    #[ignore = "requires disposable standalone/Sentinel/TLS fixtures via DBX_TEST_REDIS_*_PORT"]
    async fn redis_client_migration_live_connections() {
        use futures_util::StreamExt;
        // Match the application entrypoints when workspace builds enable both rustls providers.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let port = |name| std::env::var(name).unwrap().parse::<u16>().unwrap();
        let timeout = Duration::from_secs(5);
        let mut config = redis_test_connection_config();
        config.host = "127.0.0.1".to_string();
        config.port = port("DBX_TEST_REDIS_PORT");
        let mut con = super::connect_standalone(&config, &config.host, config.port, timeout).await.unwrap();
        let mut pubsub = super::connect_pubsub(&config, &config.host, config.port, timeout).await.unwrap();
        let channel = format!("dbx1271:migration:{}", std::process::id());
        pubsub.subscribe(&channel).await.unwrap();
        let payload = b"\x00\xffmigration";
        redis::cmd("PUBLISH").arg(&channel).arg(payload).query_async::<usize>(&mut con).await.unwrap();
        let message = tokio::time::timeout(timeout, pubsub.on_message().next()).await.unwrap().unwrap();
        assert_eq!(message.get_payload_bytes(), payload);
        pubsub.unsubscribe(&channel).await.unwrap();
        drop(pubsub);

        let mut monitor = super::connect_monitor(&config, &config.host, config.port, timeout).await.unwrap();
        redis::cmd("PING").arg(&channel).query_async::<String>(&mut con).await.unwrap();
        let mut stream = monitor.on_message::<String>();
        tokio::time::timeout(timeout, async {
            loop {
                let message = stream.next().await.unwrap();
                if message.contains(&channel) {
                    assert!(message.contains("PING"));
                    break;
                }
            }
        })
        .await
        .unwrap();
        drop(stream);
        drop(monitor);

        config.redis_sentinel_nodes = format!("127.0.0.1:{}", port("DBX_TEST_REDIS_SENTINEL_PORT"));
        config.redis_sentinel_master = "dbx1271master".to_string();
        let mut master = super::connect_sentinel(&config).await.unwrap();
        assert_eq!(redis::cmd("PING").query_async::<String>(&mut master).await.unwrap(), "PONG");
        let role: RedisRawValue = redis::cmd("ROLE").query_async(&mut master).await.unwrap();
        let RedisRawValue::Array(role) = role else { panic!("expected ROLE array") };
        assert_eq!(role[0], bulk("master"));

        config.ssl = true;
        let tls_port = port("DBX_TEST_REDIS_TLS_PORT");
        assert!(super::connect_standalone(&config, &config.host, tls_port, timeout).await.is_err());
        config.url_params = Some("tls_insecure=true".to_string());
        let mut tls = super::connect_standalone(&config, &config.host, tls_port, timeout).await.unwrap();
        assert_eq!(redis::cmd("PING").query_async::<String>(&mut tls).await.unwrap(), "PONG");
    }

    #[test]
    fn redis_tls_certificates_are_loaded_from_configured_paths() {
        let dir = std::env::temp_dir().join(format!("dbx-redis-tls-{}-{}", std::process::id(), "load"));
        std::fs::create_dir_all(&dir).unwrap();
        let ca = dir.join("ca.pem");
        let cert = dir.join("client.pem");
        let key = dir.join("client-key.pem");
        std::fs::write(&ca, b"ca").unwrap();
        std::fs::write(&cert, b"cert").unwrap();
        std::fs::write(&key, b"key").unwrap();

        let mut config = redis_test_connection_config();
        assert!(super::load_redis_tls_certificates(&config).unwrap().is_none());

        config.ca_cert_path = ca.to_string_lossy().to_string();
        config.client_cert_path = cert.to_string_lossy().to_string();
        config.client_key_path = key.to_string_lossy().to_string();
        // Sentinel nodes can enable TLS without enabling it for the data connection.
        assert!(load_redis_tls_certificates(&config).unwrap().is_some());
        config.ssl = true;
        let certificates = load_redis_tls_certificates(&config).unwrap().unwrap();
        assert_eq!(certificates.root_cert.as_deref(), Some(b"ca".as_slice()));
        let client_tls = certificates.client_tls.unwrap();
        assert_eq!(client_tls.client_cert, b"cert");
        assert_eq!(client_tls.client_key, b"key");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn redis_tls_certificates_require_both_client_files() {
        let mut config = redis_test_connection_config();
        config.ssl = true;
        config.client_cert_path = "/tmp/only-cert.pem".to_string();
        let error = load_redis_tls_certificates(&config).err().expect("expected certificate error");
        assert!(error.contains("configured together"), "{error}");
    }

    #[test]
    fn redis_tls_certificates_report_unreadable_files() {
        let mut config = redis_test_connection_config();
        config.ssl = true;
        config.ca_cert_path = "/tmp/dbx-missing-ca-certificate.pem".to_string();
        let error = load_redis_tls_certificates(&config).err().expect("expected certificate error");
        assert!(error.contains("Failed to read Redis TLS CA certificate"), "{error}");
        assert!(error.contains("/tmp/dbx-missing-ca-certificate.pem"), "{error}");
    }

    fn redis_test_connection_config() -> ConnectionConfig {
        ConnectionConfig {
            oracle_oci_nls_lang: None,
            oracle_oci_tns_admin: None,
            docs_notes_path: None,
            id: "redis".to_string(),
            name: "Redis".to_string(),
            note: String::new(),
            db_type: dbx_types::models::connection::DatabaseType::Redis,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "cache.example.com".to_string(),
            port: 6379,
            username: String::new(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            sidebar_auto_load_all_tables: false,
            show_database_links: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: dbx_types::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: dbx_types::models::connection::default_query_timeout_secs(),
            idle_timeout_secs: dbx_types::models::connection::default_idle_timeout_secs(),
            manual_transaction_timeout_secs: dbx_types::models::connection::default_manual_transaction_timeout_secs(),
            idle_disconnect_secs: dbx_types::models::connection::default_idle_disconnect_secs(),
            keepalive_interval_secs: dbx_types::models::connection::default_keepalive_interval_secs(),
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
            redis_key_separator: dbx_types::models::connection::default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            redis_key_filter: None,
            redis_key_grouping: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            plugin_id: None,
            plugin_connection_provider: None,
            plugin_connection_type: None,
            connection_secrets: HashMap::new(),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            production_badge_scope: None,
            database_info: None,
        }
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
