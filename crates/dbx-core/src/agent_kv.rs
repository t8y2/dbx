use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::{AgentCapability, AgentKvMethod};
use crate::path_utils::expand_tilde;

/// Lossless JSON representation for etcd's signed/unsigned 64-bit identifiers.
///
/// Agents historically returned JSON numbers. Accept both shapes for backward
/// compatibility, but always serialize as a decimal string before data reaches
/// JavaScript, where values above 2^53 would otherwise lose precision.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct KvInt64(pub String);

impl KvInt64 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<i64> for KvInt64 {
    fn from(value: i64) -> Self {
        Self(value.to_string())
    }
}

impl Serialize for KvInt64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for KvInt64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KvInt64Visitor;

        impl<'de> Visitor<'de> for KvInt64Visitor {
            type Value = KvInt64;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a 64-bit integer or decimal string")
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(KvInt64(value.to_string()))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(KvInt64(value.to_string()))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                let parsed = value.parse::<i128>().map_err(E::custom)?;
                if parsed < i64::MIN as i128 || parsed > u64::MAX as i128 {
                    return Err(E::custom("integer exceeds 64-bit range"));
                }
                Ok(KvInt64(value.to_string()))
            }
        }

        deserializer.deserialize_any(KvInt64Visitor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvValue {
    pub encoding: KvValueEncoding,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvValueEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyMetadata {
    pub create_revision: Option<KvInt64>,
    pub mod_revision: Option<KvInt64>,
    pub version: Option<KvInt64>,
    pub lease: Option<KvInt64>,
    pub ttl: Option<i64>,
    pub value_size: Option<u64>,
    pub czxid: Option<i64>,
    pub mzxid: Option<i64>,
    pub pzxid: Option<i64>,
    pub ctime: Option<i64>,
    pub mtime: Option<i64>,
    pub cversion: Option<i64>,
    pub aversion: Option<i64>,
    pub ephemeral_owner: Option<i64>,
    pub data_length: Option<u64>,
    pub num_children: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<KvInt64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_index: Option<KvInt64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvKeySummary {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<KvValue>,
    #[serde(flatten)]
    pub metadata: KvKeyMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvListPrefixRequest {
    pub prefix: String,
    pub limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_values: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvListPrefixResponse {
    pub keys: Vec<KvKeySummary>,
    pub continuation: Option<String>,
    pub revision: Option<KvInt64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filtered_by_acls: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvGetRequest {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvGetResponse {
    pub found: bool,
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    pub value: Option<KvValue>,
    pub metadata: Option<KvKeyMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutRequest {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    pub value: KvValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_lease: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_mode: Option<KvWriteMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_mode: Option<KvCreateMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_mod_revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_create_revision: Option<KvInt64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_lease: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_mode: Option<KvWriteMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_mode: Option<KvCreateMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_mod_revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_create_revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvWriteMode {
    Upsert,
    Create,
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvCreateMode {
    Persistent,
    Ephemeral,
    PersistentSequential,
    EphemeralSequential,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvPutResponse {
    pub revision: Option<KvInt64>,
    pub key: Option<String>,
    pub created_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteRequest {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_mod_revision: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteResponse {
    pub deleted: u64,
    pub revision: Option<KvInt64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvRangeOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_values: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvGetOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_only: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_mod_revision: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvRenameRequest {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    pub new_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_mod_revision: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvRenameResponse {
    pub renamed: bool,
    pub revision: Option<KvInt64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvHistoryRequest {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_revision: Option<KvInt64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_revision: Option<KvInt64>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KvHistoryEventType {
    Put,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvHistoryEvent {
    pub event_type: KvHistoryEventType,
    pub revision: KvInt64,
    pub value: Option<KvValue>,
    pub previous_value: Option<KvValue>,
    pub metadata: Option<KvKeyMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KvHistoryResponse {
    pub events: Vec<KvHistoryEvent>,
    pub observed_revision: KvInt64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KvStatusMember {
    pub endpoint: String,
    pub member_id: Option<KvInt64>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub leader_id: Option<KvInt64>,
    pub revision: Option<KvInt64>,
    pub raft_term: Option<KvInt64>,
    pub raft_index: Option<KvInt64>,
    pub raft_applied_index: Option<KvInt64>,
    pub db_size: Option<KvInt64>,
    pub db_size_in_use: Option<KvInt64>,
    pub learner: bool,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KvPrometheusMetrics {
    pub available: bool,
    pub source_url: Option<String>,
    pub error: Option<String>,
    pub collected_at_ms: Option<u64>,
    pub sample_count: Option<u64>,
    pub server_version: Option<String>,
    pub cluster_version: Option<String>,
    pub go_version: Option<String>,
    pub auth_revision: Option<f64>,
    pub has_leader: Option<f64>,
    pub is_leader: Option<f64>,
    pub leader_changes_total: Option<f64>,
    pub proposals_committed_total: Option<f64>,
    pub proposals_applied_total: Option<f64>,
    pub proposals_pending: Option<f64>,
    pub proposals_failed_total: Option<f64>,
    pub grpc_requests_total: Option<f64>,
    pub grpc_failures_total: Option<f64>,
    #[serde(default)]
    pub grpc_method_requests_total: BTreeMap<String, f64>,
    #[serde(default)]
    pub grpc_method_failures_total: BTreeMap<String, f64>,
    #[serde(default)]
    pub request_duration_seconds_sum_by_type: BTreeMap<String, f64>,
    #[serde(default)]
    pub request_duration_seconds_count_by_type: BTreeMap<String, f64>,
    pub mvcc_put_total: Option<f64>,
    pub mvcc_delete_total: Option<f64>,
    pub mvcc_range_total: Option<f64>,
    pub mvcc_txn_total: Option<f64>,
    pub mvcc_current_revision: Option<f64>,
    pub mvcc_compact_revision: Option<f64>,
    pub mvcc_keys_total: Option<f64>,
    pub mvcc_events_total: Option<f64>,
    pub mvcc_pending_events_total: Option<f64>,
    pub mvcc_slow_watcher_total: Option<f64>,
    pub mvcc_watch_stream_total: Option<f64>,
    pub mvcc_watcher_total: Option<f64>,
    pub mvcc_total_put_size_bytes: Option<f64>,
    pub open_read_transactions: Option<f64>,
    pub lease_granted_total: Option<f64>,
    pub lease_renewed_total: Option<f64>,
    pub lease_revoked_total: Option<f64>,
    pub lease_expired_total: Option<f64>,
    pub lease_ttl_seconds_sum: Option<f64>,
    pub lease_ttl_seconds_count: Option<f64>,
    pub client_received_bytes_total: Option<f64>,
    pub client_sent_bytes_total: Option<f64>,
    pub peer_received_bytes_total: Option<f64>,
    pub peer_sent_bytes_total: Option<f64>,
    pub peer_received_failures_total: Option<f64>,
    pub peer_sent_failures_total: Option<f64>,
    pub wal_fsync_duration_seconds_sum: Option<f64>,
    pub wal_fsync_duration_seconds_count: Option<f64>,
    pub wal_write_bytes_total: Option<f64>,
    pub wal_write_duration_seconds_sum: Option<f64>,
    pub wal_write_duration_seconds_count: Option<f64>,
    pub backend_commit_duration_seconds_sum: Option<f64>,
    pub backend_commit_duration_seconds_count: Option<f64>,
    pub backend_snapshot_duration_seconds_sum: Option<f64>,
    pub backend_snapshot_duration_seconds_count: Option<f64>,
    pub backend_defrag_duration_seconds_sum: Option<f64>,
    pub backend_defrag_duration_seconds_count: Option<f64>,
    pub disk_defrag_inflight: Option<f64>,
    pub snapshot_apply_in_progress: Option<f64>,
    pub quota_backend_bytes: Option<f64>,
    pub known_peers: Option<f64>,
    pub heartbeat_send_failures_total: Option<f64>,
    pub read_indexes_failed_total: Option<f64>,
    pub slow_apply_total: Option<f64>,
    pub slow_read_indexes_total: Option<f64>,
    pub health_success_total: Option<f64>,
    pub health_failures_total: Option<f64>,
    pub resident_memory_bytes: Option<f64>,
    pub virtual_memory_bytes: Option<f64>,
    pub cpu_seconds_total: Option<f64>,
    pub process_start_time_seconds: Option<f64>,
    pub process_received_bytes_total: Option<f64>,
    pub process_transmitted_bytes_total: Option<f64>,
    pub open_fds: Option<f64>,
    pub max_fds: Option<f64>,
    pub goroutines: Option<f64>,
    pub go_threads: Option<f64>,
    pub go_max_procs: Option<f64>,
    pub go_heap_alloc_bytes: Option<f64>,
    pub go_heap_inuse_bytes: Option<f64>,
    pub go_heap_sys_bytes: Option<f64>,
    pub go_heap_objects: Option<f64>,
    pub go_next_gc_bytes: Option<f64>,
    pub go_gc_duration_seconds_sum: Option<f64>,
    pub go_gc_duration_seconds_count: Option<f64>,
    pub db_size_metric_bytes: Option<f64>,
    pub db_size_in_use_metric_bytes: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KvStatusResponse {
    pub cluster_id: Option<KvInt64>,
    pub revision: Option<KvInt64>,
    pub leader_id: Option<KvInt64>,
    pub key_count: Option<KvInt64>,
    pub alarms: Vec<String>,
    pub members: Vec<KvStatusMember>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<KvPrometheusMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdDefragMemberResult {
    pub endpoint: String,
    pub status: String,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdDefragResponse {
    pub members: Vec<EtcdDefragMemberResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdWatchStartRequest {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<KvValue>,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_revision: Option<KvInt64>,
    pub include_prev_kv: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdWatchStartResponse {
    pub watch_id: String,
    pub started_revision: KvInt64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdWatchPollResponse {
    pub watch_id: String,
    pub batches: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdLeaseListResponse {
    pub leases: Vec<serde_json::Value>,
    #[serde(default)]
    pub partial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_continuation: Option<String>,
}

/// A short-lived challenge for an irreversible etcd operation. The token is
/// opaque; the registry stores only a request digest, never the request body
/// (which may include an Auth password).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdPreflightRequest {
    pub action: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EtcdPreflightResponse {
    pub token: String,
    pub action: String,
    pub confirmation_text: String,
    pub expires_at_ms: u64,
    pub cluster_id: Option<KvInt64>,
}

#[derive(Debug, Clone)]
struct EtcdPreflightToken {
    connection_id: String,
    action: String,
    params_digest: String,
    confirmation_text: String,
    expires_at_ms: u64,
    cluster_id: Option<String>,
}

const ETCD_PREFLIGHT_TTL: Duration = Duration::from_secs(5 * 60);

fn etcd_preflight_tokens() -> &'static Mutex<HashMap<String, EtcdPreflightToken>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, EtcdPreflightToken>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn kv_list_prefix_params(prefix: &str, limit: usize, continuation: Option<&str>) -> serde_json::Value {
    kv_list_prefix_params_with_options(prefix, limit, continuation, None)
}

pub fn kv_list_prefix_params_with_options(
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
    recursive: Option<bool>,
) -> serde_json::Value {
    kv_list_prefix_params_with_range_options(prefix, limit, continuation, recursive, KvRangeOptions::default())
}

pub fn kv_list_prefix_params_with_range_options(
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
    recursive: Option<bool>,
    options: KvRangeOptions,
) -> serde_json::Value {
    serde_json::to_value(KvListPrefixRequest {
        prefix: prefix.to_string(),
        limit,
        continuation: continuation.map(str::to_string),
        recursive,
        revision: options.revision,
        include_values: options.include_values,
    })
    .expect("KV list prefix request should serialize")
}

pub fn kv_get_params(key: &str) -> serde_json::Value {
    kv_get_params_with_options(key, KvGetOptions::default())
}

pub fn kv_get_params_with_options(key: &str, options: KvGetOptions) -> serde_json::Value {
    serde_json::to_value(KvGetRequest {
        key: key.to_string(),
        key_bytes: options.key_bytes,
        revision: options.revision,
        metadata_only: options.metadata_only,
    })
    .expect("KV get request should serialize")
}

pub fn kv_put_params(key: &str, value: KvValue, lease: Option<i64>) -> serde_json::Value {
    kv_put_params_with_options(key, value, KvPutOptions { lease: lease.map(KvInt64::from), ..KvPutOptions::default() })
}

pub fn kv_put_params_with_options(key: &str, value: KvValue, options: KvPutOptions) -> serde_json::Value {
    serde_json::to_value(KvPutRequest {
        key: key.to_string(),
        key_bytes: options.key_bytes,
        value,
        lease: options.lease,
        ttl: options.ttl,
        preserve_lease: options.preserve_lease,
        write_mode: options.write_mode,
        create_mode: options.create_mode,
        expected_mod_revision: options.expected_mod_revision,
        expected_create_revision: options.expected_create_revision,
    })
    .expect("KV put request should serialize")
}

pub fn kv_delete_params(key: &str) -> serde_json::Value {
    kv_delete_params_with_options(key, KvDeleteOptions::default())
}

pub fn kv_delete_params_with_options(key: &str, options: KvDeleteOptions) -> serde_json::Value {
    serde_json::to_value(KvDeleteRequest {
        key: key.to_string(),
        key_bytes: options.key_bytes,
        expected_mod_revision: options.expected_mod_revision,
    })
    .expect("KV delete request should serialize")
}

pub async fn kv_list_prefix_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
) -> Result<KvListPrefixResponse, String> {
    kv_list_prefix_core_with_options(state, connection_id, prefix, limit, continuation, None).await
}

pub async fn kv_list_prefix_core_with_options(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
    recursive: Option<bool>,
) -> Result<KvListPrefixResponse, String> {
    call_agent_kv(
        state,
        connection_id,
        AgentKvMethod::ListPrefix,
        kv_list_prefix_params_with_options(prefix, limit, continuation, recursive),
        Vec::new(),
    )
    .await
}

pub async fn kv_list_prefix_core_with_range_options(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
    continuation: Option<&str>,
    options: KvRangeOptions,
) -> Result<KvListPrefixResponse, String> {
    let required_capabilities = kv_range_required_capabilities(&options);
    call_agent_kv(
        state,
        connection_id,
        AgentKvMethod::ListPrefix,
        kv_list_prefix_params_with_range_options(prefix, limit, continuation, None, options),
        required_capabilities,
    )
    .await
}

pub async fn kv_get_core(state: &AppState, connection_id: &str, key: &str) -> Result<KvGetResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Get, kv_get_params(key), Vec::new()).await
}

pub async fn kv_get_core_with_options(
    state: &AppState,
    connection_id: &str,
    key: &str,
    options: KvGetOptions,
) -> Result<KvGetResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Get, kv_get_params_with_options(key, options), Vec::new()).await
}

pub async fn kv_put_core(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: KvValue,
    lease: Option<i64>,
) -> Result<KvPutResponse, String> {
    kv_put_core_with_options(
        state,
        connection_id,
        key,
        value,
        KvPutOptions { lease: lease.map(KvInt64::from), ..KvPutOptions::default() },
    )
    .await
}

pub async fn kv_put_core_with_options(
    state: &AppState,
    connection_id: &str,
    key: &str,
    value: KvValue,
    options: KvPutOptions,
) -> Result<KvPutResponse, String> {
    let required_capabilities = kv_put_required_capabilities(&options);
    call_agent_kv(
        state,
        connection_id,
        AgentKvMethod::Put,
        kv_put_params_with_options(key, value, options),
        required_capabilities,
    )
    .await
}

pub async fn kv_delete_core(state: &AppState, connection_id: &str, key: &str) -> Result<KvDeleteResponse, String> {
    call_agent_kv(state, connection_id, AgentKvMethod::Delete, kv_delete_params(key), Vec::new()).await
}

pub async fn kv_delete_core_with_options(
    state: &AppState,
    connection_id: &str,
    key: &str,
    options: KvDeleteOptions,
) -> Result<KvDeleteResponse, String> {
    let required_capabilities =
        options.expected_mod_revision.is_some().then_some(AgentCapability::KvCas).into_iter().collect();
    call_agent_kv(
        state,
        connection_id,
        AgentKvMethod::Delete,
        kv_delete_params_with_options(key, options),
        required_capabilities,
    )
    .await
}

pub async fn kv_rename_core(
    state: &AppState,
    connection_id: &str,
    request: KvRenameRequest,
) -> Result<KvRenameResponse, String> {
    let params = serde_json::to_value(request).map_err(|error| error.to_string())?;
    call_agent_kv(state, connection_id, AgentKvMethod::Rename, params, vec![AgentCapability::KvCas]).await
}

pub async fn kv_history_core(
    state: &AppState,
    connection_id: &str,
    request: KvHistoryRequest,
) -> Result<KvHistoryResponse, String> {
    let params = serde_json::to_value(request).map_err(|error| error.to_string())?;
    call_agent_kv(state, connection_id, AgentKvMethod::History, params, vec![AgentCapability::KvHistory]).await
}

pub async fn kv_status_core(state: &AppState, connection_id: &str) -> Result<KvStatusResponse, String> {
    let mut status: KvStatusResponse = call_agent_kv(
        state,
        connection_id,
        AgentKvMethod::Status,
        serde_json::json!({}),
        vec![AgentCapability::KvStatus],
    )
    .await?;
    if !status.metrics.as_ref().is_some_and(|metrics| metrics.available) {
        let metrics_options =
            state.configs.read().await.get(connection_id).map(EtcdMetricsConnectionOptions::from).unwrap_or_default();
        status.metrics = Some(collect_etcd_prometheus_metrics(&metrics_options).await);
    }
    Ok(status)
}

pub async fn etcd_compact_core(
    state: &AppState,
    connection_id: &str,
    revision: KvInt64,
) -> Result<serde_json::Value, String> {
    etcd_call(
        state,
        connection_id,
        AgentKvMethod::Compact,
        serde_json::json!({ "revision": revision }),
        AgentCapability::EtcdCompaction,
    )
    .await
}

pub async fn etcd_defrag_core(
    state: &AppState,
    connection_id: &str,
    endpoints: Vec<String>,
) -> Result<EtcdDefragResponse, String> {
    etcd_call(
        state,
        connection_id,
        AgentKvMethod::Defrag,
        serde_json::json!({ "endpoints": endpoints }),
        AgentCapability::EtcdDefrag,
    )
    .await
}

pub async fn etcd_watch_start_core(
    state: &AppState,
    connection_id: &str,
    request: EtcdWatchStartRequest,
) -> Result<EtcdWatchStartResponse, String> {
    let params = serde_json::to_value(request).map_err(|error| error.to_string())?;
    etcd_call(state, connection_id, AgentKvMethod::WatchStart, params, AgentCapability::EtcdWatch).await
}

pub async fn etcd_watch_poll_core(
    state: &AppState,
    connection_id: &str,
    watch_id: &str,
) -> Result<EtcdWatchPollResponse, String> {
    etcd_call(
        state,
        connection_id,
        AgentKvMethod::WatchPoll,
        serde_json::json!({ "watchId": watch_id }),
        AgentCapability::EtcdWatch,
    )
    .await
}

pub async fn etcd_watch_stop_core(
    state: &AppState,
    connection_id: &str,
    watch_id: &str,
) -> Result<serde_json::Value, String> {
    etcd_call(
        state,
        connection_id,
        AgentKvMethod::WatchStop,
        serde_json::json!({ "watchId": watch_id }),
        AgentCapability::EtcdWatch,
    )
    .await
}

pub async fn etcd_lease_list_core(
    state: &AppState,
    connection_id: &str,
    limit: usize,
    continuation: Option<&str>,
) -> Result<EtcdLeaseListResponse, String> {
    etcd_call(
        state,
        connection_id,
        AgentKvMethod::LeaseList,
        serde_json::json!({
            "limit": limit.clamp(1, 200),
            "continuation": continuation,
        }),
        AgentCapability::EtcdLease,
    )
    .await
}

pub async fn etcd_lease_call_core(
    state: &AppState,
    connection_id: &str,
    method: AgentKvMethod,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    etcd_call(state, connection_id, method, params, AgentCapability::EtcdLease).await
}

pub async fn etcd_auth_call_core(
    state: &AppState,
    connection_id: &str,
    method: AgentKvMethod,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    etcd_call(state, connection_id, method, params, AgentCapability::EtcdAuth).await
}

/// Creates a single-use confirmation token bound to the connection, action,
/// canonical request payload, and current etcd cluster identity.
pub async fn etcd_preflight_core(
    state: &AppState,
    connection_id: &str,
    request: EtcdPreflightRequest,
) -> Result<EtcdPreflightResponse, String> {
    let action = normalize_etcd_dangerous_action(&request.action)?;
    ensure_etcd_dangerous_action_capability(state, connection_id, &action).await?;
    let status = kv_status_core(state, connection_id).await?;
    let now = current_time_millis();
    let expires_at_ms = now.saturating_add(ETCD_PREFLIGHT_TTL.as_millis().min(u64::MAX as u128) as u64);
    let cluster_id = status.cluster_id.as_ref().map(|value| value.0.clone());
    let confirmation_text = etcd_confirmation_text(&action, &request.params);
    let token = Uuid::new_v4().to_string();
    let entry = EtcdPreflightToken {
        connection_id: connection_id.to_string(),
        action: action.clone(),
        params_digest: etcd_params_digest(&request.params),
        confirmation_text: confirmation_text.clone(),
        expires_at_ms,
        cluster_id: cluster_id.clone(),
    };
    let mut tokens = etcd_preflight_tokens().lock().map_err(|_| "ETCD_PREFLIGHT_UNAVAILABLE")?;
    tokens.retain(|_, value| value.expires_at_ms > now);
    tokens.insert(token.clone(), entry);
    Ok(EtcdPreflightResponse { token, action, confirmation_text, expires_at_ms, cluster_id: cluster_id.map(KvInt64) })
}

/// Validates and consumes a token immediately before a dangerous mutation.
/// Keeping this in Core makes the rule identical for Tauri and HTTP callers.
pub async fn etcd_consume_preflight_core(
    state: &AppState,
    connection_id: &str,
    action: &str,
    params: &serde_json::Value,
    token: &str,
    confirmation_text: &str,
) -> Result<(), String> {
    let action = normalize_etcd_dangerous_action(action)?;
    let now = current_time_millis();
    let entry = etcd_preflight_tokens()
        .lock()
        .map_err(|_| "ETCD_PREFLIGHT_UNAVAILABLE")?
        .remove(token)
        .ok_or("ETCD_PREFLIGHT_INVALID: Request a new preflight confirmation")?;
    if entry.expires_at_ms <= now {
        return Err("ETCD_PREFLIGHT_EXPIRED: Request a new preflight confirmation".to_string());
    }
    if entry.connection_id != connection_id
        || entry.action != action
        || entry.params_digest != etcd_params_digest(params)
        || entry.confirmation_text != confirmation_text
    {
        return Err("ETCD_PREFLIGHT_MISMATCH: Request a new preflight confirmation".to_string());
    }
    let current_cluster = kv_status_core(state, connection_id).await?.cluster_id.map(|value| value.0);
    if current_cluster != entry.cluster_id {
        return Err("ETCD_PREFLIGHT_CLUSTER_CHANGED: Request a new preflight confirmation".to_string());
    }
    Ok(())
}

pub fn etcd_is_dangerous_action(action: &str) -> bool {
    normalize_etcd_dangerous_action(action).is_ok()
}

/// The preflight token binds the connection, action, canonical request, and
/// cluster. Keep the operator interaction deliberately simple and consistent.
fn etcd_confirmation_text(_action: &str, _params: &serde_json::Value) -> String {
    "确认".to_string()
}

fn normalize_etcd_dangerous_action(action: &str) -> Result<String, String> {
    match action {
        "compact"
        | "defrag"
        | "lease_revoke"
        | "auth_user_add"
        | "auth_user_delete"
        | "auth_user_change_password"
        | "auth_user_grant_role"
        | "auth_user_revoke_role"
        | "auth_role_add"
        | "auth_role_delete"
        | "auth_role_grant_permission"
        | "auth_role_revoke_permission" => Ok(action.to_string()),
        _ => {
            Err("ETCD_PREFLIGHT_ACTION_INVALID: This action does not support a destructive-operation preflight"
                .to_string())
        }
    }
}

async fn ensure_etcd_dangerous_action_capability(
    state: &AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), String> {
    let capability = match action {
        "compact" => AgentCapability::EtcdCompaction,
        "defrag" => AgentCapability::EtcdDefrag,
        "lease_revoke" => AgentCapability::EtcdLease,
        _ => AgentCapability::EtcdAuth,
    };
    ensure_agent_kv_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let PoolKind::Agent(client) = connections.get(connection_id).ok_or("Connection not found")? else {
        return Err("Not an agent key-value connection".to_string());
    };
    if !client.lock().await.supports_capability(capability) {
        return Err(format!(
            "ETCD_CAPABILITY_UNSUPPORTED: Installed etcd Agent does not support {}. Update the etcd driver and reconnect.",
            capability.as_str()
        ));
    }
    Ok(())
}

fn etcd_params_digest(params: &serde_json::Value) -> String {
    let canonical = canonical_json(params);
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let body = entries
                .into_iter()
                .map(|(key, value)| {
                    format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), canonical_json(value))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        serde_json::Value::Array(values) => {
            format!("[{}]", values.iter().map(canonical_json).collect::<Vec<_>>().join(","))
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

async fn etcd_call<T: serde::de::DeserializeOwned + Send + 'static>(
    state: &AppState,
    connection_id: &str,
    method: AgentKvMethod,
    params: serde_json::Value,
    capability: AgentCapability,
) -> Result<T, String> {
    call_agent_kv(state, connection_id, method, params, vec![capability]).await
}

const ETCD_METRICS_TIMEOUT: Duration = Duration::from_secs(3);
const ETCD_METRICS_MAX_BYTES: u64 = 4 * 1024 * 1024;
const ETCD_METRICS_MAX_CANDIDATES: usize = 8;

#[derive(Debug, Clone, Default)]
struct EtcdMetricsConnectionOptions {
    endpoints: String,
    url_params: Option<String>,
    username: String,
    password: String,
    ca_cert_path: String,
    client_cert_path: String,
    client_key_path: String,
}

impl From<&crate::models::connection::ConnectionConfig> for EtcdMetricsConnectionOptions {
    fn from(config: &crate::models::connection::ConnectionConfig) -> Self {
        let scheme = if config.ssl { "https" } else { "http" };
        let configured_endpoints = if config.etcd_endpoints.trim().is_empty() {
            format!("{scheme}://{}:{}", config.host, config.port)
        } else {
            config
                .etcd_endpoints
                .split([',', '\n'])
                .map(str::trim)
                .filter(|endpoint| !endpoint.is_empty())
                .map(|endpoint| {
                    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
                        endpoint.to_string()
                    } else {
                        format!("{scheme}://{endpoint}")
                    }
                })
                .collect::<Vec<_>>()
                .join(",")
        };
        Self {
            endpoints: configured_endpoints,
            url_params: config.url_params.clone(),
            username: config.username.clone(),
            password: config.password.clone(),
            ca_cert_path: config.ca_cert_path.clone(),
            client_cert_path: config.client_cert_path.clone(),
            client_key_path: config.client_key_path.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EtcdMetricsCandidate {
    url: String,
    send_credentials: bool,
}

async fn collect_etcd_prometheus_metrics(options: &EtcdMetricsConnectionOptions) -> KvPrometheusMetrics {
    let candidates = etcd_metrics_candidates(options);
    let collected_at_ms = current_time_millis();
    if candidates.is_empty() {
        return KvPrometheusMetrics {
            available: false,
            collected_at_ms: Some(collected_at_ms),
            error: Some("No HTTP(S) etcd endpoint is available for /metrics".to_string()),
            ..KvPrometheusMetrics::default()
        };
    }

    let authenticated_client = match build_etcd_metrics_client(options).await {
        Ok(client) => client,
        Err(error) => {
            return KvPrometheusMetrics {
                available: false,
                collected_at_ms: Some(collected_at_ms),
                error: Some(error),
                ..KvPrometheusMetrics::default()
            };
        }
    };
    let anonymous_client = match build_etcd_metrics_client_without_identity(options).await {
        Ok(client) => client,
        Err(error) => {
            return KvPrometheusMetrics {
                available: false,
                collected_at_ms: Some(collected_at_ms),
                error: Some(error),
                ..KvPrometheusMetrics::default()
            };
        }
    };

    let mut errors = Vec::new();
    for candidate in candidates.into_iter().take(ETCD_METRICS_MAX_CANDIDATES) {
        let display_url = sanitize_metrics_url(&candidate.url);
        let client = if candidate.send_credentials { &authenticated_client } else { &anonymous_client };
        let mut request = client.get(&candidate.url).header(reqwest::header::ACCEPT, "text/plain; version=0.0.4");
        if candidate.send_credentials && !options.username.trim().is_empty() {
            request = request.basic_auth(options.username.trim(), Some(options.password.as_str()));
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                errors.push(format!("{display_url}: {}", error.without_url()));
                continue;
            }
        };
        if !response.status().is_success() {
            errors.push(format!("{display_url}: HTTP {}", response.status().as_u16()));
            continue;
        }
        if response.content_length().is_some_and(|length| length > ETCD_METRICS_MAX_BYTES) {
            errors.push(format!("{display_url}: response exceeds 4 MiB"));
            continue;
        }
        let body = match read_etcd_metrics_body(response).await {
            Ok(body) => body,
            Err(error) => {
                errors.push(format!("{display_url}: {error}"));
                continue;
            }
        };
        let mut parsed = parse_etcd_prometheus_metrics(&String::from_utf8_lossy(&body), &display_url);
        parsed.collected_at_ms = Some(collected_at_ms);
        if parsed.available {
            return parsed;
        }
        errors.push(format!("{display_url}: no supported etcd metrics found"));
    }

    KvPrometheusMetrics {
        available: false,
        source_url: etcd_metrics_candidates(options).first().map(|candidate| sanitize_metrics_url(&candidate.url)),
        collected_at_ms: Some(collected_at_ms),
        error: Some(errors.into_iter().take(3).collect::<Vec<_>>().join("; ")),
        ..KvPrometheusMetrics::default()
    }
}

async fn read_etcd_metrics_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.without_url().to_string())? {
        if chunk.len() as u64 > ETCD_METRICS_MAX_BYTES.saturating_sub(body.len() as u64) {
            return Err("response exceeds 4 MiB".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn build_etcd_metrics_client(options: &EtcdMetricsConnectionOptions) -> Result<reqwest::Client, String> {
    build_etcd_metrics_client_with_identity(options, true).await
}

async fn build_etcd_metrics_client_without_identity(
    options: &EtcdMetricsConnectionOptions,
) -> Result<reqwest::Client, String> {
    build_etcd_metrics_client_with_identity(options, false).await
}

async fn build_etcd_metrics_client_with_identity(
    options: &EtcdMetricsConnectionOptions,
    include_identity: bool,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(ETCD_METRICS_TIMEOUT)
        .timeout(ETCD_METRICS_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());

    if !options.ca_cert_path.trim().is_empty() {
        let path = expand_tilde(options.ca_cert_path.trim());
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("Failed to read etcd metrics CA certificate at {path}: {error}"))?;
        let certificates = reqwest::Certificate::from_pem_bundle(&bytes)
            .or_else(|_| reqwest::Certificate::from_der(&bytes).map(|certificate| vec![certificate]))
            .map_err(|error| format!("Failed to parse etcd metrics CA certificate at {path}: {error}"))?;
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }

    let client_cert = if include_identity { options.client_cert_path.trim() } else { "" };
    let client_key = if include_identity { options.client_key_path.trim() } else { "" };
    if client_cert.is_empty() != client_key.is_empty() {
        return Err("Failed to initialize metrics client: etcd client certificate and key must be configured together"
            .to_string());
    }
    if !client_cert.is_empty() {
        let cert_path = expand_tilde(client_cert);
        let key_path = expand_tilde(client_key);
        let mut identity_pem = tokio::fs::read(&cert_path)
            .await
            .map_err(|error| format!("Failed to read etcd metrics client certificate at {cert_path}: {error}"))?;
        if !identity_pem.ends_with(b"\n") {
            identity_pem.push(b'\n');
        }
        identity_pem.extend(
            tokio::fs::read(&key_path)
                .await
                .map_err(|error| format!("Failed to read etcd metrics client key at {key_path}: {error}"))?,
        );
        let identity = reqwest::Identity::from_pem(&identity_pem)
            .map_err(|error| format!("Failed to parse etcd metrics client identity: {error}"))?;
        builder = builder.identity(identity);
    }

    builder.build().map_err(|error| format!("Failed to initialize metrics client: {error}"))
}

fn etcd_metrics_candidates(options: &EtcdMetricsConnectionOptions) -> Vec<EtcdMetricsCandidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let control_origins = configured_etcd_control_origins(&options.endpoints);
    let control_hosts = configured_etcd_control_hosts(&options.endpoints);
    for configured in configured_etcd_metrics_urls(options.url_params.as_deref()) {
        if !metrics_host(&configured).is_some_and(|host| control_hosts.contains(&host)) {
            continue;
        }
        push_metrics_candidate(
            &mut candidates,
            &mut seen,
            &configured,
            metrics_origin(&configured).is_some_and(|origin| control_origins.contains(&origin)),
        );
    }
    for endpoint in split_etcd_endpoints(&options.endpoints) {
        push_metrics_candidate(&mut candidates, &mut seen, endpoint, true);
    }
    candidates
}

fn split_etcd_endpoints(endpoints: &str) -> impl Iterator<Item = &str> {
    endpoints.split([',', '\n']).map(str::trim).filter(|endpoint| !endpoint.is_empty())
}

fn configured_etcd_control_origins(endpoints: &str) -> HashSet<String> {
    split_etcd_endpoints(endpoints).filter_map(metrics_origin).collect()
}

fn configured_etcd_control_hosts(endpoints: &str) -> HashSet<String> {
    split_etcd_endpoints(endpoints).filter_map(metrics_host).collect()
}

fn metrics_origin(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

fn metrics_host(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.host_str().map(|host| host.to_ascii_lowercase())
}

fn configured_etcd_metrics_urls(url_params: Option<&str>) -> Vec<String> {
    let Some(params) = url_params.map(str::trim).filter(|params| !params.is_empty()) else {
        return Vec::new();
    };
    let Ok(url) = reqwest::Url::parse(&format!("http://localhost/?{}", params.trim_start_matches('?'))) else {
        return Vec::new();
    };
    url.query_pairs()
        .filter(|(key, _)| key == "metricsUrls" || key == "metricsUrl")
        .flat_map(|(_, value)| {
            value
                .split([',', '\n'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn push_metrics_candidate(
    candidates: &mut Vec<EtcdMetricsCandidate>,
    seen: &mut HashSet<String>,
    endpoint: &str,
    send_credentials: bool,
) {
    let Some(candidate) = metrics_url_for_endpoint(endpoint) else {
        return;
    };
    if seen.insert(candidate.clone()) {
        candidates.push(EtcdMetricsCandidate { url: candidate, send_credentials });
    }
}

fn metrics_url_for_endpoint(endpoint: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(endpoint.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    if url.path().is_empty() || url.path() == "/" {
        url.set_path("/metrics");
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn sanitize_metrics_url(value: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(value) else {
        return "configured metrics endpoint".to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn parse_etcd_prometheus_metrics(text: &str, source_url: &str) -> KvPrometheusMetrics {
    let mut totals = HashMap::<String, f64>::new();
    let mut grpc_failures = 0.0;
    let mut grpc_method_requests_total = BTreeMap::<String, f64>::new();
    let mut grpc_method_failures_total = BTreeMap::<String, f64>::new();
    let mut request_duration_seconds_sum_by_type = BTreeMap::<String, f64>::new();
    let mut request_duration_seconds_count_by_type = BTreeMap::<String, f64>::new();
    let mut server_version = None;
    let mut cluster_version = None;
    let mut go_version = None;
    let mut recognized_samples = 0_u64;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(separator) = prometheus_value_separator(line) else {
            continue;
        };
        let sample = &line[..separator];
        let Some(raw_value) = line[separator..].split_whitespace().next() else {
            continue;
        };
        let labels_start = sample.find('{');
        let metric_name = labels_start.map_or(sample, |index| &sample[..index]);
        if !supported_etcd_metric(metric_name) {
            continue;
        }
        let Ok(value) = raw_value.parse::<f64>() else {
            continue;
        };
        if !value.is_finite() {
            continue;
        }
        *totals.entry(metric_name.to_string()).or_default() += value;
        match metric_name {
            "etcd_server_version" => server_version = prometheus_label(sample, "server_version"),
            "etcd_cluster_version" => cluster_version = prometheus_label(sample, "cluster_version"),
            "etcd_server_go_version" => go_version = prometheus_label(sample, "server_go_version"),
            "grpc_server_handled_total" => {
                if let Some(method) = prometheus_label(sample, "grpc_method") {
                    *grpc_method_requests_total.entry(method.clone()).or_default() += value;
                    if prometheus_label(sample, "grpc_code").as_deref() != Some("OK") {
                        *grpc_method_failures_total.entry(method).or_default() += value;
                    }
                }
                if prometheus_label(sample, "grpc_code").as_deref() != Some("OK") {
                    grpc_failures += value;
                }
            }
            "etcd_server_request_duration_seconds_sum" => {
                if let Some(request_type) = prometheus_label(sample, "type") {
                    *request_duration_seconds_sum_by_type.entry(request_type).or_default() += value;
                }
            }
            "etcd_server_request_duration_seconds_count" => {
                if let Some(request_type) = prometheus_label(sample, "type") {
                    *request_duration_seconds_count_by_type.entry(request_type).or_default() += value;
                }
            }
            _ => {}
        }
        recognized_samples += 1;
    }

    let metric = |name: &str| totals.get(name).copied();
    let available = recognized_samples > 0;
    KvPrometheusMetrics {
        available,
        source_url: Some(sanitize_metrics_url(source_url)),
        error: (!available).then(|| "No supported etcd metrics found".to_string()),
        collected_at_ms: Some(current_time_millis()),
        sample_count: Some(recognized_samples),
        server_version,
        cluster_version,
        go_version,
        auth_revision: metric("etcd_debugging_auth_revision"),
        has_leader: metric("etcd_server_has_leader"),
        is_leader: metric("etcd_server_is_leader"),
        leader_changes_total: metric("etcd_server_leader_changes_seen_total"),
        proposals_committed_total: metric("etcd_server_proposals_committed_total"),
        proposals_applied_total: metric("etcd_server_proposals_applied_total"),
        proposals_pending: metric("etcd_server_proposals_pending"),
        proposals_failed_total: metric("etcd_server_proposals_failed_total"),
        grpc_requests_total: metric("grpc_server_handled_total"),
        grpc_failures_total: totals.contains_key("grpc_server_handled_total").then_some(grpc_failures),
        grpc_method_requests_total,
        grpc_method_failures_total,
        request_duration_seconds_sum_by_type,
        request_duration_seconds_count_by_type,
        mvcc_put_total: metric("etcd_mvcc_put_total"),
        mvcc_delete_total: metric("etcd_mvcc_delete_total"),
        mvcc_range_total: metric("etcd_mvcc_range_total"),
        mvcc_txn_total: metric("etcd_mvcc_txn_total"),
        mvcc_current_revision: metric("etcd_debugging_mvcc_current_revision"),
        mvcc_compact_revision: metric("etcd_debugging_mvcc_compact_revision"),
        mvcc_keys_total: metric("etcd_debugging_mvcc_keys_total"),
        mvcc_events_total: metric("etcd_debugging_mvcc_events_total"),
        mvcc_pending_events_total: metric("etcd_debugging_mvcc_pending_events_total"),
        mvcc_slow_watcher_total: metric("etcd_debugging_mvcc_slow_watcher_total"),
        mvcc_watch_stream_total: metric("etcd_debugging_mvcc_watch_stream_total"),
        mvcc_watcher_total: metric("etcd_debugging_mvcc_watcher_total"),
        mvcc_total_put_size_bytes: metric("etcd_debugging_mvcc_total_put_size_in_bytes"),
        open_read_transactions: metric("etcd_mvcc_db_open_read_transactions"),
        lease_granted_total: metric("etcd_debugging_lease_granted_total"),
        lease_renewed_total: metric("etcd_debugging_lease_renewed_total"),
        lease_revoked_total: metric("etcd_debugging_lease_revoked_total"),
        lease_expired_total: metric("etcd_debugging_server_lease_expired_total"),
        lease_ttl_seconds_sum: metric("etcd_debugging_lease_ttl_total_sum"),
        lease_ttl_seconds_count: metric("etcd_debugging_lease_ttl_total_count"),
        client_received_bytes_total: metric("etcd_network_client_grpc_received_bytes_total"),
        client_sent_bytes_total: metric("etcd_network_client_grpc_sent_bytes_total"),
        peer_received_bytes_total: metric("etcd_network_peer_received_bytes_total"),
        peer_sent_bytes_total: metric("etcd_network_peer_sent_bytes_total"),
        peer_received_failures_total: metric("etcd_network_peer_received_failures_total"),
        peer_sent_failures_total: metric("etcd_network_peer_sent_failures_total"),
        wal_fsync_duration_seconds_sum: metric("etcd_disk_wal_fsync_duration_seconds_sum"),
        wal_fsync_duration_seconds_count: metric("etcd_disk_wal_fsync_duration_seconds_count"),
        wal_write_bytes_total: metric("etcd_disk_wal_write_bytes_total"),
        wal_write_duration_seconds_sum: metric("etcd_disk_wal_write_duration_seconds_sum"),
        wal_write_duration_seconds_count: metric("etcd_disk_wal_write_duration_seconds_count"),
        backend_commit_duration_seconds_sum: metric("etcd_disk_backend_commit_duration_seconds_sum"),
        backend_commit_duration_seconds_count: metric("etcd_disk_backend_commit_duration_seconds_count"),
        backend_snapshot_duration_seconds_sum: metric("etcd_disk_backend_snapshot_duration_seconds_sum"),
        backend_snapshot_duration_seconds_count: metric("etcd_disk_backend_snapshot_duration_seconds_count"),
        backend_defrag_duration_seconds_sum: metric("etcd_disk_backend_defrag_duration_seconds_sum"),
        backend_defrag_duration_seconds_count: metric("etcd_disk_backend_defrag_duration_seconds_count"),
        disk_defrag_inflight: metric("etcd_disk_defrag_inflight"),
        snapshot_apply_in_progress: metric("etcd_server_snapshot_apply_in_progress_total"),
        quota_backend_bytes: metric("etcd_server_quota_backend_bytes"),
        known_peers: metric("etcd_network_known_peers"),
        heartbeat_send_failures_total: metric("etcd_server_heartbeat_send_failures_total"),
        read_indexes_failed_total: metric("etcd_server_read_indexes_failed_total"),
        slow_apply_total: metric("etcd_server_slow_apply_total"),
        slow_read_indexes_total: metric("etcd_server_slow_read_indexes_total"),
        health_success_total: metric("etcd_server_health_success"),
        health_failures_total: metric("etcd_server_health_failures"),
        resident_memory_bytes: metric("process_resident_memory_bytes"),
        virtual_memory_bytes: metric("process_virtual_memory_bytes"),
        cpu_seconds_total: metric("process_cpu_seconds_total"),
        process_start_time_seconds: metric("process_start_time_seconds"),
        process_received_bytes_total: metric("process_network_receive_bytes_total"),
        process_transmitted_bytes_total: metric("process_network_transmit_bytes_total"),
        open_fds: metric("process_open_fds"),
        max_fds: metric("process_max_fds"),
        goroutines: metric("go_goroutines"),
        go_threads: metric("go_threads"),
        go_max_procs: metric("go_sched_gomaxprocs_threads"),
        go_heap_alloc_bytes: metric("go_memstats_heap_alloc_bytes"),
        go_heap_inuse_bytes: metric("go_memstats_heap_inuse_bytes"),
        go_heap_sys_bytes: metric("go_memstats_heap_sys_bytes"),
        go_heap_objects: metric("go_memstats_heap_objects"),
        go_next_gc_bytes: metric("go_memstats_next_gc_bytes"),
        go_gc_duration_seconds_sum: metric("go_gc_duration_seconds_sum"),
        go_gc_duration_seconds_count: metric("go_gc_duration_seconds_count"),
        db_size_metric_bytes: metric("etcd_mvcc_db_total_size_in_bytes"),
        db_size_in_use_metric_bytes: metric("etcd_mvcc_db_total_size_in_use_in_bytes"),
    }
}

fn prometheus_label(sample: &str, key: &str) -> Option<String> {
    let labels = sample.get(sample.find('{')? + 1..sample.rfind('}')?)?;
    let needle = format!("{key}=\"");
    let start = labels.find(&needle)? + needle.len();
    let mut value = String::new();
    let mut escaped = false;
    for current in labels[start..].chars() {
        if escaped {
            value.push(match current {
                'n' => '\n',
                other => other,
            });
            escaped = false;
        } else if current == '\\' {
            escaped = true;
        } else if current == '"' {
            return Some(value);
        } else {
            value.push(current);
        }
    }
    None
}

fn prometheus_value_separator(line: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    let mut braces = 0_u32;
    for (index, current) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && current == '\\' {
            escaped = true;
            continue;
        }
        if current == '"' {
            quoted = !quoted;
            continue;
        }
        if !quoted {
            match current {
                '{' => braces += 1,
                '}' => braces = braces.saturating_sub(1),
                _ if braces == 0 && current.is_whitespace() => return Some(index),
                _ => {}
            }
        }
    }
    None
}

fn supported_etcd_metric(metric: &str) -> bool {
    matches!(
        metric,
        "etcd_cluster_version"
            | "etcd_debugging_auth_revision"
            | "etcd_server_version"
            | "etcd_server_go_version"
            | "etcd_server_has_leader"
            | "etcd_server_is_leader"
            | "etcd_server_leader_changes_seen_total"
            | "etcd_server_proposals_committed_total"
            | "etcd_server_proposals_applied_total"
            | "etcd_server_proposals_pending"
            | "etcd_server_proposals_failed_total"
            | "etcd_server_heartbeat_send_failures_total"
            | "etcd_server_read_indexes_failed_total"
            | "etcd_server_slow_apply_total"
            | "etcd_server_slow_read_indexes_total"
            | "etcd_server_snapshot_apply_in_progress_total"
            | "etcd_server_quota_backend_bytes"
            | "etcd_server_health_success"
            | "etcd_server_health_failures"
            | "etcd_server_request_duration_seconds_sum"
            | "etcd_server_request_duration_seconds_count"
            | "grpc_server_handled_total"
            | "etcd_mvcc_put_total"
            | "etcd_mvcc_delete_total"
            | "etcd_mvcc_range_total"
            | "etcd_mvcc_txn_total"
            | "etcd_mvcc_db_open_read_transactions"
            | "etcd_debugging_mvcc_current_revision"
            | "etcd_debugging_mvcc_compact_revision"
            | "etcd_debugging_mvcc_keys_total"
            | "etcd_debugging_mvcc_events_total"
            | "etcd_debugging_mvcc_pending_events_total"
            | "etcd_debugging_mvcc_slow_watcher_total"
            | "etcd_debugging_mvcc_watch_stream_total"
            | "etcd_debugging_mvcc_watcher_total"
            | "etcd_debugging_mvcc_total_put_size_in_bytes"
            | "etcd_debugging_lease_granted_total"
            | "etcd_debugging_lease_renewed_total"
            | "etcd_debugging_lease_revoked_total"
            | "etcd_debugging_lease_ttl_total_sum"
            | "etcd_debugging_lease_ttl_total_count"
            | "etcd_debugging_server_lease_expired_total"
            | "etcd_network_client_grpc_received_bytes_total"
            | "etcd_network_client_grpc_sent_bytes_total"
            | "etcd_network_known_peers"
            | "etcd_network_peer_received_bytes_total"
            | "etcd_network_peer_sent_bytes_total"
            | "etcd_network_peer_received_failures_total"
            | "etcd_network_peer_sent_failures_total"
            | "etcd_disk_wal_fsync_duration_seconds_sum"
            | "etcd_disk_wal_fsync_duration_seconds_count"
            | "etcd_disk_wal_write_bytes_total"
            | "etcd_disk_wal_write_duration_seconds_sum"
            | "etcd_disk_wal_write_duration_seconds_count"
            | "etcd_disk_backend_commit_duration_seconds_sum"
            | "etcd_disk_backend_commit_duration_seconds_count"
            | "etcd_disk_backend_snapshot_duration_seconds_sum"
            | "etcd_disk_backend_snapshot_duration_seconds_count"
            | "etcd_disk_backend_defrag_duration_seconds_sum"
            | "etcd_disk_backend_defrag_duration_seconds_count"
            | "etcd_disk_defrag_inflight"
            | "process_resident_memory_bytes"
            | "process_virtual_memory_bytes"
            | "process_cpu_seconds_total"
            | "process_start_time_seconds"
            | "process_network_receive_bytes_total"
            | "process_network_transmit_bytes_total"
            | "process_open_fds"
            | "process_max_fds"
            | "go_goroutines"
            | "go_threads"
            | "go_sched_gomaxprocs_threads"
            | "go_memstats_heap_alloc_bytes"
            | "go_memstats_heap_inuse_bytes"
            | "go_memstats_heap_sys_bytes"
            | "go_memstats_heap_objects"
            | "go_memstats_next_gc_bytes"
            | "go_gc_duration_seconds_sum"
            | "go_gc_duration_seconds_count"
            | "etcd_mvcc_db_total_size_in_bytes"
            | "etcd_mvcc_db_total_size_in_use_in_bytes"
    )
}

fn current_time_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

fn kv_range_required_capabilities(options: &KvRangeOptions) -> Vec<AgentCapability> {
    options
        .include_values
        .is_some_and(|include_values| include_values)
        .then_some(AgentCapability::KvListValues)
        .into_iter()
        .collect()
}

fn kv_put_required_capabilities(options: &KvPutOptions) -> Vec<AgentCapability> {
    let mut capabilities = Vec::new();
    if options.ttl.is_some() || options.preserve_lease == Some(true) {
        capabilities.push(AgentCapability::KvTtl);
    }
    if options.expected_mod_revision.is_some() || options.expected_create_revision.is_some() {
        capabilities.push(AgentCapability::KvCas);
    }
    capabilities
}

pub async fn kv_supports_ttl_core(state: &AppState, connection_id: &str) -> Result<bool, String> {
    ensure_agent_kv_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;
    match pool {
        PoolKind::Agent(client) => Ok(client.lock().await.supports_capability(AgentCapability::KvTtl)),
        _ => Err("Not an agent key-value connection".to_string()),
    }
}

async fn ensure_agent_kv_pool(state: &AppState, connection_id: &str) -> Result<(), String> {
    state.get_or_create_pool(connection_id, None).await.map(|_| ())
}

async fn call_agent_kv<T: serde::de::DeserializeOwned + Send + 'static>(
    state: &AppState,
    connection_id: &str,
    method: AgentKvMethod,
    params: serde_json::Value,
    required_capabilities: Vec<AgentCapability>,
) -> Result<T, String> {
    let create_only_write = method == AgentKvMethod::Put
        && params
            .get("expectedCreateRevision")
            .is_some_and(|value| value.as_str() == Some("0") || value.as_i64() == Some(0));
    ensure_agent_kv_pool(state, connection_id).await?;

    let client = {
        let connections = state.connections.read().await;
        match connections.get(connection_id) {
            Some(PoolKind::Agent(client)) => client.clone(),
            Some(_) => return Err("Not an agent key-value connection".to_string()),
            None => return Err("Connection not found".to_string()),
        }
    };
    let result = {
        let mut agent = client.lock().await;
        if !agent.supports_capability(AgentCapability::Kv) {
            return Err("Agent does not support key-value operations".to_string());
        }
        if let Some(capability) =
            required_capabilities.into_iter().find(|capability| !agent.supports_capability(*capability))
        {
            return Err(match capability {
                    AgentCapability::KvTtl => {
                        "Installed etcd Agent does not support TTL. Update the etcd driver and reconnect.".to_string()
                    }
                    AgentCapability::KvCas => {
                        "ETCD_CAS_UNSUPPORTED: Installed etcd Agent cannot safely compare and update Keys. Update the etcd driver and reconnect."
                            .to_string()
                    }
                    AgentCapability::KvListValues => {
                        "ETCD_LIST_VALUES_UNSUPPORTED: Installed etcd Agent cannot export or search Key values safely. Update the etcd driver and reconnect."
                            .to_string()
                    }
                    AgentCapability::KvStatus => {
                        "ETCD_STATUS_UNSUPPORTED: Installed etcd Agent does not support Dashboard status. Update the etcd driver and reconnect."
                            .to_string()
                    }
                    AgentCapability::KvHistory => {
                        "ETCD_HISTORY_UNSUPPORTED: Installed etcd Agent does not support key history. Update the etcd driver and reconnect."
                            .to_string()
                    }
                    AgentCapability::EtcdCompaction
                    | AgentCapability::EtcdDefrag
                    | AgentCapability::EtcdWatch
                    | AgentCapability::EtcdLease
                    | AgentCapability::EtcdAuth => {
                        format!(
                            "ETCD_CAPABILITY_UNSUPPORTED: Installed etcd Agent does not support {}. Update the etcd driver and reconnect.",
                            capability.as_str()
                        )
                    }
                    _ => format!("Agent does not support required capability: {}", capability.as_str()),
                });
        }
        agent.call_kv_method(method, params).await
    };
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let transient = is_transient_etcd_connection_error(&error);
            let normalized = normalize_agent_kv_error(&error, method, create_only_write);
            if transient && state.invalidate_agent_pool_if_current(connection_id, &client).await {
                log::warn!("Invalidated etcd Agent pool '{connection_id}' after transient {} failure", method.as_str());
            }
            Err(normalized)
        }
    }
}

fn normalize_agent_kv_error(error: &str, method: AgentKvMethod, create_only_write: bool) -> String {
    let without_stderr = strip_recent_agent_stderr(error);
    let message = strip_agent_rpc_error_prefix(without_stderr);
    if message.to_ascii_lowercase().contains("etcd_cas_conflict") {
        if method == AgentKvMethod::Put && create_only_write {
            return "ETCD_KEY_ALREADY_EXISTS: Key already exists".to_string();
        }
        return match method {
            AgentKvMethod::Rename => {
                "ETCD_CAS_CONFLICT: The source Key changed or the target Key already exists".to_string()
            }
            AgentKvMethod::Delete => "ETCD_CAS_CONFLICT: The Key changed before it could be deleted".to_string(),
            _ => "ETCD_CAS_CONFLICT: The Key changed after it was loaded".to_string(),
        };
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("unauthenticated") {
        return "ETCD_UNAUTHENTICATED: etcd rejected the configured credentials".to_string();
    }
    if lower.contains("permission_denied") || lower.contains("permission denied") {
        return "ETCD_PERMISSION_DENIED: The current etcd user is not authorized for this operation".to_string();
    }
    if lower.contains("deadline_exceeded") || lower.contains("deadline exceeded") || lower.contains("timed out") {
        if is_mutating_etcd_method(method) {
            return "ETCD_OPERATION_RESULT_UNKNOWN: The request timed out. Refresh the relevant data before retrying because the operation may have completed on etcd."
                .to_string();
        }
        return "ETCD_CONNECTION_TIMEOUT: etcd did not respond in time. The connection will be re-established on the next operation."
            .to_string();
    }
    if is_interrupted_etcd_connection_error(&lower) {
        if is_mutating_etcd_method(method) {
            return "ETCD_OPERATION_RESULT_UNKNOWN: The connection was interrupted. Refresh the relevant data before retrying because the operation may have completed on etcd."
                .to_string();
        }
        return "ETCD_CONNECTION_UNAVAILABLE: etcd is temporarily unavailable. The connection will be re-established on the next operation."
            .to_string();
    }
    message.to_string()
}

fn is_transient_etcd_connection_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    is_interrupted_etcd_connection_error(&lower)
        || lower.contains("deadline_exceeded")
        || lower.contains("deadline exceeded")
        || lower.contains("timed out")
}

fn is_interrupted_etcd_connection_error(lower: &str) -> bool {
    lower.contains("unavailable")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("connection closed")
        || lower.contains("transport closed")
        || lower.contains("no route to host")
        || lower.contains("broken pipe")
}

fn is_mutating_etcd_method(method: AgentKvMethod) -> bool {
    matches!(
        method,
        AgentKvMethod::Put
            | AgentKvMethod::Delete
            | AgentKvMethod::Rename
            | AgentKvMethod::Compact
            | AgentKvMethod::Defrag
            | AgentKvMethod::LeaseGrant
            | AgentKvMethod::LeaseKeepalive
            | AgentKvMethod::LeaseRevoke
            | AgentKvMethod::AuthUserAdd
            | AgentKvMethod::AuthUserDelete
            | AgentKvMethod::AuthUserChangePassword
            | AgentKvMethod::AuthUserGrantRole
            | AgentKvMethod::AuthUserRevokeRole
            | AgentKvMethod::AuthRoleAdd
            | AgentKvMethod::AuthRoleDelete
            | AgentKvMethod::AuthRoleGrantPermission
            | AgentKvMethod::AuthRoleRevokePermission
    )
}

fn strip_recent_agent_stderr(error: &str) -> &str {
    let lower = error.to_ascii_lowercase();
    let end = lower.find("recent stderr:").unwrap_or(error.len());
    error[..end].trim().trim_end_matches('.').trim()
}

fn strip_agent_rpc_error_prefix(error: &str) -> &str {
    let trimmed = error.trim();
    if !trimmed.to_ascii_lowercase().starts_with("agent rpc error") {
        return trimmed;
    }
    trimmed.split_once(':').map(|(_, message)| message.trim()).unwrap_or(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kv_list_prefix_params() {
        assert_eq!(
            kv_list_prefix_params("/config/", 100, Some("next-token")),
            serde_json::json!({
                "prefix": "/config/",
                "limit": 100,
                "continuation": "next-token"
            })
        );
        assert_eq!(
            kv_list_prefix_params("", 50, None),
            serde_json::json!({
                "prefix": "",
                "limit": 50
            })
        );
    }

    #[test]
    fn maps_create_cas_conflicts_to_key_already_exists_without_agent_stderr() {
        let error = "Agent RPC error (-1): ETCD_CAS_CONFLICT: key changed after it was loaded. recent stderr: SLF4J(W): No SLF4J providers were found";

        assert_eq!(
            normalize_agent_kv_error(error, AgentKvMethod::Put, true),
            "ETCD_KEY_ALREADY_EXISTS: Key already exists"
        );
    }

    #[test]
    fn maps_grpc_connection_failures_to_stable_etcd_errors() {
        assert_eq!(
            normalize_agent_kv_error(
                "Agent RPC error (-1): io.grpc.StatusRuntimeException: UNAVAILABLE: io exception",
                AgentKvMethod::Get,
                false,
            ),
            "ETCD_CONNECTION_UNAVAILABLE: etcd is temporarily unavailable. The connection will be re-established on the next operation."
        );
        assert_eq!(
            normalize_agent_kv_error(
                "Agent RPC error (-1): io.grpc.StatusRuntimeException: DEADLINE_EXCEEDED",
                AgentKvMethod::Put,
                false,
            ),
            "ETCD_OPERATION_RESULT_UNKNOWN: The request timed out. Refresh the relevant data before retrying because the operation may have completed on etcd."
        );
        assert_eq!(
            normalize_agent_kv_error(
                "Agent RPC error (-1): io.grpc.StatusRuntimeException: UNAVAILABLE: connection reset",
                AgentKvMethod::Put,
                false,
            ),
            "ETCD_OPERATION_RESULT_UNKNOWN: The connection was interrupted. Refresh the relevant data before retrying because the operation may have completed on etcd."
        );
        assert_eq!(
            normalize_agent_kv_error(
                "Agent RPC error (-1): transport closed",
                AgentKvMethod::Put,
                false,
            ),
            "ETCD_OPERATION_RESULT_UNKNOWN: The connection was interrupted. Refresh the relevant data before retrying because the operation may have completed on etcd."
        );
        assert!(is_transient_etcd_connection_error("io.grpc.StatusRuntimeException: UNAVAILABLE: connection closed"));
        assert!(!is_transient_etcd_connection_error("io.grpc.StatusRuntimeException: PERMISSION_DENIED"));
    }

    #[test]
    fn keeps_non_create_cas_conflicts_distinct_and_sanitizes_other_rpc_errors() {
        assert_eq!(
            normalize_agent_kv_error(
                "Agent RPC error (-1): ETCD_CAS_CONFLICT: key changed after it was loaded",
                AgentKvMethod::Put,
                false,
            ),
            "ETCD_CAS_CONFLICT: The Key changed after it was loaded"
        );
        assert_eq!(
            normalize_agent_kv_error(
                "Agent RPC error (-1): etcdserver: request timed out. recent stderr: noisy warning",
                AgentKvMethod::Get,
                false,
            ),
            "ETCD_CONNECTION_TIMEOUT: etcd did not respond in time. The connection will be re-established on the next operation."
        );
    }

    #[test]
    fn serializes_kv_list_prefix_params_with_recursive_false() {
        assert_eq!(
            kv_list_prefix_params_with_options("/app", 200, None, Some(false)),
            serde_json::json!({
                "prefix": "/app",
                "limit": 200,
                "recursive": false
            })
        );
    }

    #[test]
    fn serializes_kv_get_put_delete_params() {
        assert_eq!(kv_get_params("/app/name"), serde_json::json!({ "key": "/app/name" }));
        assert_eq!(
            kv_put_params("/app/name", KvValue { encoding: KvValueEncoding::Utf8, data: "dbx".to_string() }, Some(42),),
            serde_json::json!({
                "key": "/app/name",
                "value": {
                    "encoding": "utf8",
                    "data": "dbx"
                },
                "lease": "42"
            })
        );
        assert_eq!(kv_delete_params("/app/name"), serde_json::json!({ "key": "/app/name" }));
    }

    #[test]
    fn serializes_kv_put_options_without_changing_default_shape() {
        let value = KvValue { encoding: KvValueEncoding::Utf8, data: "dbx".to_string() };
        assert_eq!(
            kv_put_params("/app/name", value.clone(), None),
            serde_json::json!({
                "key": "/app/name",
                "value": {
                    "encoding": "utf8",
                    "data": "dbx"
                }
            })
        );
        assert_eq!(
            kv_put_params_with_options(
                "/jobs/job-",
                value,
                KvPutOptions {
                    write_mode: Some(KvWriteMode::Create),
                    create_mode: Some(KvCreateMode::EphemeralSequential),
                    ..KvPutOptions::default()
                },
            ),
            serde_json::json!({
                "key": "/jobs/job-",
                "value": {
                    "encoding": "utf8",
                    "data": "dbx"
                },
                "writeMode": "create",
                "createMode": "ephemeral_sequential"
            })
        );
    }

    #[test]
    fn serializes_etcd_range_and_cas_options_losslessly() {
        let revision = KvInt64("9007199254740993".to_string());
        assert_eq!(
            kv_list_prefix_params_with_range_options(
                "/app/",
                500,
                Some("cursor"),
                None,
                KvRangeOptions { revision: Some(revision.clone()), include_values: Some(true) },
            ),
            serde_json::json!({
                "prefix": "/app/",
                "limit": 500,
                "continuation": "cursor",
                "revision": "9007199254740993",
                "includeValues": true
            })
        );
        assert_eq!(
            kv_put_params_with_options(
                "/app/name",
                KvValue { encoding: KvValueEncoding::Utf8, data: "dbx".to_string() },
                KvPutOptions {
                    lease: Some(KvInt64("9223372036854775807".to_string())),
                    expected_mod_revision: Some(revision),
                    ..KvPutOptions::default()
                },
            ),
            serde_json::json!({
                "key": "/app/name",
                "value": { "encoding": "utf8", "data": "dbx" },
                "lease": "9223372036854775807",
                "expectedModRevision": "9007199254740993"
            })
        );
    }

    #[test]
    fn requires_explicit_agent_capabilities_for_value_scans_and_safe_writes() {
        assert_eq!(
            kv_range_required_capabilities(&KvRangeOptions { include_values: Some(true), ..KvRangeOptions::default() }),
            vec![AgentCapability::KvListValues]
        );
        assert!(kv_range_required_capabilities(&KvRangeOptions::default()).is_empty());

        assert_eq!(
            kv_put_required_capabilities(&KvPutOptions {
                ttl: Some(60),
                expected_create_revision: Some(KvInt64::from(0)),
                ..KvPutOptions::default()
            }),
            vec![AgentCapability::KvTtl, AgentCapability::KvCas]
        );
        assert!(kv_put_required_capabilities(&KvPutOptions::default()).is_empty());
    }

    #[test]
    fn decodes_unsigned_etcd_ids_without_javascript_precision_loss() {
        let decoded: KvStatusResponse = serde_json::from_value(serde_json::json!({
            "clusterId": "18446744073709551615",
            "revision": "42",
            "leaderId": "9223372036854775808",
            "keyCount": "3",
            "alarms": [],
            "members": [],
            "metrics": {
                "available": true,
                "sourceUrl": "http://localhost:2380/metrics",
                "collectedAtMs": 1720000000000u64,
                "sampleCount": 12,
                "hasLeader": 1,
                "grpcRequestsTotal": 120.0,
                "residentMemoryBytes": 104857600.0
            }
        }))
        .unwrap();

        assert_eq!(decoded.cluster_id.unwrap().as_str(), "18446744073709551615");
        assert_eq!(decoded.leader_id.unwrap().as_str(), "9223372036854775808");
        let metrics = decoded.metrics.unwrap();
        assert!(metrics.available);
        assert_eq!(metrics.has_leader, Some(1.0));
        assert_eq!(metrics.grpc_requests_total, Some(120.0));
    }

    #[test]
    fn decodes_kv_list_prefix_response() {
        let decoded: KvListPrefixResponse = serde_json::from_value(serde_json::json!({
            "keys": [{
                "key": "/app/name",
                "createRevision": 1,
                "modRevision": 2,
                "version": 3,
                "lease": 0,
                "valueSize": 5
            }],
            "continuation": "next-token",
            "revision": 9
        }))
        .unwrap();

        assert_eq!(decoded.keys[0].key, "/app/name");
        assert_eq!(decoded.keys[0].metadata.mod_revision, Some(KvInt64::from(2)));
        assert_eq!(decoded.continuation.as_deref(), Some("next-token"));
        assert_eq!(decoded.revision, Some(KvInt64::from(9)));
    }

    #[test]
    fn decodes_kv_put_response_with_created_key() {
        let decoded: KvPutResponse = serde_json::from_value(serde_json::json!({
            "key": "/jobs/job-0000000001",
            "createdKey": "/jobs/job-0000000001"
        }))
        .unwrap();

        assert_eq!(decoded.revision, None);
        assert_eq!(decoded.key.as_deref(), Some("/jobs/job-0000000001"));
        assert_eq!(decoded.created_key.as_deref(), Some("/jobs/job-0000000001"));
    }

    #[test]
    fn decodes_zookeeper_metadata_fields() {
        let decoded: KvGetResponse = serde_json::from_value(serde_json::json!({
            "found": true,
            "key": "/admin",
            "value": {
                "encoding": "utf8",
                "data": ""
            },
            "metadata": {
                "czxid": 27,
                "mzxid": 27,
                "pzxid": 39825,
                "ctime": 1780674584000_i64,
                "mtime": 1780674585000_i64,
                "cversion": 5,
                "aversion": 0,
                "ephemeralOwner": 0,
                "dataLength": 0,
                "numChildren": 5
            }
        }))
        .unwrap();

        let metadata = decoded.metadata.unwrap();
        assert_eq!(metadata.czxid, Some(27));
        assert_eq!(metadata.mzxid, Some(27));
        assert_eq!(metadata.pzxid, Some(39825));
        assert_eq!(metadata.ephemeral_owner, Some(0));
        assert_eq!(metadata.num_children, Some(5));
    }

    #[test]
    fn derives_metrics_url_from_the_connected_etcd_endpoint() {
        assert_eq!(
            metrics_url_for_endpoint("http://127.0.0.1:2380"),
            Some("http://127.0.0.1:2380/metrics".to_string())
        );
        assert_eq!(
            metrics_url_for_endpoint("https://etcd.example.com:2379/"),
            Some("https://etcd.example.com:2379/metrics".to_string())
        );
        assert_eq!(
            metrics_url_for_endpoint("https://unexpected:secret@etcd.example.com:2379/"),
            Some("https://etcd.example.com:2379/metrics".to_string())
        );
    }

    #[test]
    fn keeps_legacy_metrics_url_params_as_compatibility_candidates() {
        assert_eq!(
            configured_etcd_metrics_urls(Some(
                "metricsUrls=http%3A%2F%2Fmetrics-1%3A2381%2Fmetrics%0Ahttp%3A%2F%2Fmetrics-2%3A2381%2Fmetrics"
            )),
            vec!["http://metrics-1:2381/metrics".to_string(), "http://metrics-2:2381/metrics".to_string()]
        );
    }

    #[test]
    fn rejects_metrics_urls_on_unrelated_hosts() {
        let candidates = etcd_metrics_candidates(&EtcdMetricsConnectionOptions {
            endpoints: "https://etcd.internal:2379".to_string(),
            url_params: Some("metricsUrl=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data".to_string()),
            ..EtcdMetricsConnectionOptions::default()
        });

        assert_eq!(
            candidates,
            vec![EtcdMetricsCandidate {
                url: "https://etcd.internal:2379/metrics".to_string(),
                send_credentials: true,
            }]
        );
    }

    #[test]
    fn parses_supported_etcd_prometheus_metrics() {
        let metrics = parse_etcd_prometheus_metrics(
            r#"
                # HELP etcd_server_has_leader Whether a leader exists.
                etcd_server_has_leader 1
                etcd_server_proposals_committed_total 120
                etcd_server_proposals_applied_total 118
                grpc_server_handled_total{grpc_code="OK",grpc_method="Range"} 80
                grpc_server_handled_total{grpc_code="Unavailable",grpc_method="Put"} 4
                etcd_server_request_duration_seconds_sum{success="true",type="Range"} 0.8
                etcd_server_request_duration_seconds_count{success="true",type="Range"} 40
                etcd_server_version{server_version="3.7.0"} 1
                etcd_cluster_version{cluster_version="3.7"} 1
                etcd_server_go_version{server_go_version="go1.24.4"} 1
                etcd_debugging_mvcc_watcher_total 3
                etcd_debugging_lease_granted_total 2
                go_memstats_heap_alloc_bytes 5242880
                etcd_disk_wal_fsync_duration_seconds_sum 1.5
                etcd_disk_wal_fsync_duration_seconds_count 30
                process_resident_memory_bytes 104857600
                go_goroutines 42
                unsupported_metric 99
            "#,
            "http://user:secret@127.0.0.1:2380/metrics?token=secret",
        );

        assert!(metrics.available);
        assert_eq!(metrics.source_url.as_deref(), Some("http://127.0.0.1:2380/metrics"));
        assert_eq!(metrics.has_leader, Some(1.0));
        assert_eq!(metrics.proposals_committed_total, Some(120.0));
        assert_eq!(metrics.proposals_applied_total, Some(118.0));
        assert_eq!(metrics.grpc_requests_total, Some(84.0));
        assert_eq!(metrics.grpc_failures_total, Some(4.0));
        assert_eq!(metrics.grpc_method_requests_total.get("Range"), Some(&80.0));
        assert_eq!(metrics.grpc_method_failures_total.get("Put"), Some(&4.0));
        assert_eq!(metrics.request_duration_seconds_sum_by_type.get("Range"), Some(&0.8));
        assert_eq!(metrics.server_version.as_deref(), Some("3.7.0"));
        assert_eq!(metrics.cluster_version.as_deref(), Some("3.7"));
        assert_eq!(metrics.go_version.as_deref(), Some("go1.24.4"));
        assert_eq!(metrics.mvcc_watcher_total, Some(3.0));
        assert_eq!(metrics.lease_granted_total, Some(2.0));
        assert_eq!(metrics.go_heap_alloc_bytes, Some(5_242_880.0));
        assert_eq!(metrics.wal_fsync_duration_seconds_count, Some(30.0));
        assert_eq!(metrics.sample_count, Some(17));
    }

    #[tokio::test]
    async fn sends_credentials_only_to_the_configured_etcd_origin() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let request_size = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..request_size]);
            assert!(request.starts_with("GET /metrics "));
            assert!(request.lines().any(|line| line.eq_ignore_ascii_case("Authorization: Basic ZGJ4OnNlY3JldA==")));
            let body = "etcd_server_has_leader 1\nprocess_resident_memory_bytes 2048\n";
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let metrics = collect_etcd_prometheus_metrics(&EtcdMetricsConnectionOptions {
            endpoints: format!("http://{address}"),
            username: "dbx".to_string(),
            password: "secret".to_string(),
            ..EtcdMetricsConnectionOptions::default()
        })
        .await;
        server.await.unwrap();

        assert!(metrics.available);
        assert_eq!(metrics.has_leader, Some(1.0));
        assert_eq!(metrics.resident_memory_bytes, Some(2048.0));
        assert_eq!(metrics.source_url, Some(format!("http://{address}/metrics")));
    }

    #[tokio::test]
    async fn omits_credentials_from_an_explicit_cross_origin_metrics_endpoint() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let request_size = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..request_size]);
            assert!(!request.lines().any(|line| line.to_ascii_lowercase().starts_with("authorization:")));
            let body = "etcd_server_has_leader 1\n";
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let metrics = collect_etcd_prometheus_metrics(&EtcdMetricsConnectionOptions {
            endpoints: "http://127.0.0.1:1".to_string(),
            url_params: Some(format!("metricsUrl=http%3A%2F%2F{address}%2Fmetrics")),
            username: "dbx".to_string(),
            password: "secret".to_string(),
            ..EtcdMetricsConnectionOptions::default()
        })
        .await;
        server.await.unwrap();

        assert!(metrics.available);
        assert_eq!(metrics.source_url, Some(format!("http://{address}/metrics")));
    }

    #[tokio::test]
    async fn does_not_follow_metrics_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let redirect_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect_address = redirect_listener.local_addr().unwrap();
        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let redirect_server = tokio::spawn(async move {
            let (mut stream, _) = redirect_listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/metrics\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let metrics = collect_etcd_prometheus_metrics(&EtcdMetricsConnectionOptions {
            endpoints: format!("http://{redirect_address}"),
            username: "dbx".to_string(),
            password: "secret".to_string(),
            ..EtcdMetricsConnectionOptions::default()
        })
        .await;
        redirect_server.await.unwrap();

        assert!(!metrics.available);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), target_listener.accept()).await.is_err(),
            "redirect target unexpectedly received a request"
        );
    }

    #[tokio::test]
    async fn rejects_chunked_metrics_response_before_buffering_past_limit() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            let oversized = vec![b'x'; ETCD_METRICS_MAX_BYTES as usize + 1];
            stream.write_all(format!("{:x}\r\n", oversized.len()).as_bytes()).await.unwrap();
            let _ = stream.write_all(&oversized).await;
            let _ = stream.write_all(b"\r\n0\r\n\r\n").await;
        });

        let metrics = collect_etcd_prometheus_metrics(&EtcdMetricsConnectionOptions {
            endpoints: format!("http://{address}"),
            ..EtcdMetricsConnectionOptions::default()
        })
        .await;
        server.await.unwrap();

        assert!(!metrics.available);
        assert!(metrics.error.as_deref().is_some_and(|error| error.contains("response exceeds 4 MiB")));
    }

    #[tokio::test]
    async fn rejects_incomplete_metrics_client_identity_configuration() {
        let error = build_etcd_metrics_client(&EtcdMetricsConnectionOptions {
            client_cert_path: "/tmp/client.pem".to_string(),
            ..EtcdMetricsConnectionOptions::default()
        })
        .await
        .unwrap_err();

        assert!(error.contains("certificate and key must be configured together"));
    }

    #[test]
    fn preflight_digest_is_stable_for_reordered_json_objects() {
        let first = serde_json::json!({ "user": "admin", "role": "ops", "nested": { "b": 2, "a": 1 } });
        let second = serde_json::json!({ "nested": { "a": 1, "b": 2 }, "role": "ops", "user": "admin" });
        assert_eq!(etcd_params_digest(&first), etcd_params_digest(&second));
    }

    #[test]
    fn etcd_auth_mutations_require_preflight() {
        assert!(etcd_is_dangerous_action("compact"));
        assert!(etcd_is_dangerous_action("lease_revoke"));
        assert!(etcd_is_dangerous_action("auth_role_grant_permission"));
        assert!(etcd_is_dangerous_action("auth_user_add"));
        assert!(etcd_is_dangerous_action("auth_role_add"));
        assert!(!etcd_is_dangerous_action("lease_grant"));
    }
}
