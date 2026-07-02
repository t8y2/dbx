//! Shared resource, statistics, and configuration types for the message queue
//! admin console. All types are `serde`-serializable in `camelCase` so they map
//! 1:1 to the frontend TypeScript definitions in `apps/desktop/src/types/mq.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Which message queue system an admin connection targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MqSystemKind {
    Pulsar,
    Kafka,
    #[serde(rename = "rocketmq")]
    RocketMq,
}

impl MqSystemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MqSystemKind::Pulsar => "pulsar",
            MqSystemKind::Kafka => "kafka",
            MqSystemKind::RocketMq => "rocketmq",
        }
    }
}

/// Capability flags. The frontend reads these to show/hide functionality, and
/// the adapter computes them from the detected server version so unsupported
/// features are hidden rather than failing at call time.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqCapabilities {
    pub supports_tenants: bool,
    pub supports_namespaces: bool,
    pub supports_partitioned_topics: bool,
    pub supports_subscriptions: bool,
    pub supports_create_subscription: bool,
    pub supports_reset_cursor: bool,
    pub supports_skip_messages: bool,
    pub supports_clear_backlog: bool,
    pub supports_peek_messages: bool,
    pub supports_expire_messages: bool,
    pub supports_rate_limits: bool,
    pub supports_backlog_quota: bool,
    pub supports_retention: bool,
    pub supports_permissions: bool,
    pub supports_geo_replication: bool,
    pub supports_token_management: bool,
    pub supports_raw_admin_api: bool,
    /// Whether the adapter supports producing messages to topics.
    #[serde(default)]
    pub supports_send_message: bool,
}

impl Default for MqCapabilities {
    fn default() -> Self {
        Self {
            supports_tenants: false,
            supports_namespaces: false,
            supports_partitioned_topics: false,
            supports_subscriptions: false,
            supports_create_subscription: false,
            supports_reset_cursor: false,
            supports_skip_messages: false,
            supports_clear_backlog: false,
            supports_peek_messages: false,
            supports_expire_messages: false,
            supports_rate_limits: false,
            supports_backlog_quota: false,
            supports_retention: false,
            supports_permissions: false,
            supports_geo_replication: false,
            supports_token_management: false,
            supports_raw_admin_api: false,
            supports_send_message: false,
        }
    }
}

/// Result of a connectivity test, including the detected server version and how
/// it was determined (probe vs. fallback) so the UI can warn appropriately.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqClusterInfo {
    pub system_kind: MqSystemKind,
    /// Raw version string reported by the broker (e.g. `3.1.2`), if available.
    pub server_version: Option<String>,
    /// Version profile the adapter resolved to (e.g. `3.1.x`).
    pub resolved_profile: String,
    /// How the version was determined: `probed` | `pinned` | `fallback`.
    pub version_detection: String,
    pub capabilities: MqCapabilities,
    /// Optional free-form extra fields (cluster list, broker count, ...).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub extra: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MqTokenSigningAlgorithm {
    Hs256,
    Rs256,
}

impl MqTokenSigningAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hs256 => "hs256",
            Self::Rs256 => "rs256",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqTokenSigningConfig {
    pub algorithm: MqTokenSigningAlgorithm,
    #[serde(default)]
    pub key: String,
}

impl MqTokenSigningConfig {
    pub fn is_configured(&self) -> bool {
        !self.key.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqTokenIssueRequest {
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PolicyScope>,
    #[serde(default)]
    pub actions: Vec<AuthAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqTokenRecord {
    pub id: String,
    pub connection_id: String,
    pub subject: String,
    pub algorithm: MqTokenSigningAlgorithm,
    pub token_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PolicyScope>,
    #[serde(default)]
    pub actions: Vec<AuthAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqIssuedToken {
    pub token: String,
    pub record: MqTokenRecord,
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantInfo {
    pub name: String,
    #[serde(default)]
    pub admin_roles: Vec<String>,
    #[serde(default)]
    pub allowed_clusters: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantConfig {
    #[serde(default)]
    pub admin_roles: Vec<String>,
    #[serde(default)]
    pub allowed_clusters: Vec<String>,
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

/// A fully-qualified namespace reference (`tenant/namespace`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceRef {
    pub tenant: String,
    pub namespace: String,
}

impl NamespaceRef {
    /// `tenant/namespace`
    pub fn path(&self) -> String {
        format!("{}/{}", self.tenant, self.namespace)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceInfo {
    pub tenant: String,
    pub namespace: String,
    #[serde(default)]
    pub admin_roles: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceConfig {
    /// Replication clusters to bootstrap the namespace with. Pulsar requires at
    /// least one when the cluster runs with geo-replication.
    #[serde(default)]
    pub clusters: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundles: Option<u32>,
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

/// A fully-qualified topic reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicRef {
    pub tenant: String,
    pub namespace: String,
    pub topic: String,
    /// Whether the topic is persistent (`persistent://`) or not
    /// (`non-persistent://`). Defaults to persistent.
    #[serde(default = "default_true")]
    pub persistent: bool,
    /// Optional UI hint used to prefer partitioned stats when the topic came
    /// from the partitioned topic list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partitioned: Option<bool>,
}

fn default_true() -> bool {
    true
}

impl TopicRef {
    /// The URL domain segment: `persistent` or `non-persistent`.
    pub fn domain(&self) -> &'static str {
        if self.persistent {
            "persistent"
        } else {
            "non-persistent"
        }
    }

    /// `{tenant}/{namespace}/{topic}` — the path used by most Pulsar endpoints.
    pub fn path(&self) -> String {
        format!("{}/{}/{}", self.tenant, self.namespace, self.topic)
    }

    /// Full topic name, e.g. `persistent://public/default/orders`.
    pub fn full_name(&self) -> String {
        format!("{}://{}", self.domain(), self.path())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicInfo {
    /// Full topic name, e.g. `persistent://public/default/orders`.
    pub name: String,
    /// Short topic name without the namespace prefix.
    pub short_name: String,
    pub partitioned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partitions: Option<u32>,
    pub persistent: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTopicsOpts {
    /// Include non-persistent topics in the listing.
    #[serde(default)]
    pub include_non_persistent: bool,
}

/// Aggregated, UI-friendly topic statistics. Parsed from the version-specific
/// raw stats payload by the adapter's version profile.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicStats {
    pub msg_rate_in: f64,
    pub msg_rate_out: f64,
    pub msg_throughput_in: f64,
    pub msg_throughput_out: f64,
    pub storage_size: i64,
    pub backlog_size: i64,
    pub msg_in_counter: i64,
    pub msg_out_counter: i64,
    pub subscription_count: u32,
    pub producer_count: u32,
    /// Original raw stats JSON, for the detail view / advanced inspection.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub raw: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Subscription / consumers / producers
// ---------------------------------------------------------------------------

/// Cluster-level information for the Broker monitoring panel.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub cluster_id: Option<String>,
    pub broker_count: u32,
    pub controller_id: Option<i32>,
    pub controller_host: Option<String>,
    pub brokers: Vec<BrokerNode>,
    /// Free-form extra fields from the adapter.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerNode {
    pub id: i32,
    pub host: String,
    pub port: i32,
    pub rack: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    pub name: String,
    #[serde(default)]
    pub sub_type: String,
    pub msg_backlog: i64,
    pub msg_rate_out: f64,
    pub msg_throughput_out: f64,
    #[serde(default)]
    pub consumers: Vec<ConsumerInfo>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerInfo {
    pub consumer_name: String,
    pub msg_rate_out: f64,
    pub msg_throughput_out: f64,
    pub available_permits: i64,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub client_version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducerInfo {
    pub producer_id: i64,
    pub producer_name: String,
    pub msg_rate_in: f64,
    pub msg_throughput_in: f64,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub client_version: String,
}

/// Where to position a cursor when creating a subscription or resetting it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResetPosition {
    /// Earliest available message.
    Earliest,
    /// Latest message (skip the existing backlog).
    Latest,
    /// A specific point in time (milliseconds since epoch).
    Timestamp { timestamp_ms: i64 },
    /// A specific message id.
    MessageId { ledger_id: i64, entry_id: i64 },
}

/// How many messages to skip on a subscription.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkipCount {
    All,
    Count { count: u32 },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogStats {
    pub msg_backlog: i64,
    pub backlog_size: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekedMessage {
    /// 1-based subscription position passed to the Pulsar Admin API.
    pub position: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_time: Option<String>,
    #[serde(default)]
    pub properties: HashMap<String, String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Message payload encoded as base64 so binary messages are preserved.
    pub payload_base64: String,
    /// UTF-8 preview when the payload can be decoded losslessly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_text: Option<String>,
}

/// Optional hints for reading messages. Pulsar ignores these today; Kafka uses
/// them to select a partition and starting offset for a non-committing peek.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekMessagesOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
}

// ---------------------------------------------------------------------------
// Policy scope (rate limits / quotas / permissions)
// ---------------------------------------------------------------------------

/// Whether a policy applies at the namespace or topic level. Lets the rate
/// limit / quota / permission methods avoid duplicating namespace vs. topic
/// variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "level", rename_all = "camelCase")]
pub enum PolicyScope {
    Namespace { tenant: String, namespace: String },
    Topic { tenant: String, namespace: String, topic: String, persistent: bool },
}

impl PolicyScope {
    pub fn as_namespace_ref(&self) -> Option<NamespaceRef> {
        match self {
            PolicyScope::Namespace { tenant, namespace } => {
                Some(NamespaceRef { tenant: tenant.clone(), namespace: namespace.clone() })
            }
            _ => None,
        }
    }

    pub fn as_topic_ref(&self) -> Option<TopicRef> {
        match self {
            PolicyScope::Topic { tenant, namespace, topic, persistent } => Some(TopicRef {
                tenant: tenant.clone(),
                namespace: namespace.clone(),
                topic: topic.clone(),
                persistent: *persistent,
                partitioned: None,
            }),
            _ => None,
        }
    }

    pub fn is_topic(&self) -> bool {
        matches!(self, PolicyScope::Topic { .. })
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRate {
    pub publish_throttling_rate_in_msg: i32,
    pub publish_throttling_rate_in_byte: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRate {
    pub dispatch_throttling_rate_in_msg: i32,
    pub dispatch_throttling_rate_in_byte: i64,
    #[serde(default = "default_rate_period")]
    pub rate_period_in_second: i32,
}

fn default_rate_period() -> i32 {
    1
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRate {
    pub subscribe_throttling_rate_per_consumer: i32,
    #[serde(default = "default_rate_period")]
    pub rate_period_in_second: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogQuota {
    /// Limit in bytes. `-1` means no size limit.
    pub limit_size: i64,
    /// Limit in seconds. `-1` means no time limit.
    #[serde(default)]
    pub limit_time: i32,
    /// `producer_request_hold` | `producer_exception` | `consumer_backlog_eviction`.
    pub policy: String,
    /// `destination_storage` (size) or `message_age` (time).
    #[serde(default = "default_backlog_quota_type")]
    pub quota_type: String,
}

fn default_backlog_quota_type() -> String {
    "destination_storage".to_string()
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    /// Retention time in minutes. `-1` = infinite.
    pub retention_time_in_minutes: i32,
    /// Retention size in MB. `-1` = infinite.
    pub retention_size_in_mb: i32,
}

/// Authorization actions that can be granted to a role on a namespace/topic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthAction {
    Produce,
    Consume,
    Functions,
    Sources,
    Sinks,
    #[serde(rename = "packages")]
    Packages,
}

pub type PermissionMap = HashMap<String, Vec<AuthAction>>;

// ---------------------------------------------------------------------------
// Raw request (escape hatch)
// ---------------------------------------------------------------------------

/// A raw admin REST request, proxied through the adapter to cover any endpoint
/// the typed methods do not. The path is appended to the connection's
/// `admin_url` base — arbitrary hosts are not allowed (SSRF guard).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqRawRequest {
    /// HTTP method: GET / PUT / POST / DELETE.
    pub method: String,
    /// Path relative to the admin base, e.g. `/admin/v2/tenants`.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
}

impl MqRawRequest {
    /// Whether this request mutates server state and therefore must pass the
    /// read-only protection check.
    pub fn is_mutating(&self) -> bool {
        !matches!(self.method.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqRawResponse {
    pub status: u16,
    pub body: serde_json::Value,
    /// Set when the response body was not valid JSON; carries the raw text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

// ---------------------------------------------------------------------------
// Send message (produce)
// ---------------------------------------------------------------------------

/// Request to produce a message to a topic.
///
/// The payload is always base64-encoded so binary messages are preserved.
/// An optional `payload_text` field provides a UTF-8 preview for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    /// Target topic name.
    pub topic: String,
    /// Optional message key (used for partitioning in Kafka).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Message payload encoded as base64.
    pub payload_base64: String,
    /// Optional UTF-8 text preview of the payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_text: Option<String>,
    /// Optional message headers.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Optional target partition (Kafka). When `None`, the key-based partitioner
    /// is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition: Option<i32>,
}

/// Result of a successful message production.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResponse {
    /// Topic the message was written to.
    pub topic: String,
    /// Partition the message was written to.
    pub partition: i32,
    /// Offset of the produced message.
    pub offset: i64,
    /// Broker-assigned timestamp, if available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}
