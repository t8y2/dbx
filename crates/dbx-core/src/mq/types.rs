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
    #[serde(rename = "rabbitmq")]
    RabbitMq,
}

impl MqSystemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MqSystemKind::Pulsar => "pulsar",
            MqSystemKind::Kafka => "kafka",
            MqSystemKind::RocketMq => "rocketmq",
            MqSystemKind::RabbitMq => "rabbitmq",
        }
    }
}

/// Capability flags. The frontend reads these to show/hide functionality, and
/// the adapter computes them from the detected server version so unsupported
/// features are hidden rather than failing at call time.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
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
    /// RocketMQ: view/query messages by msgId or key.
    #[serde(default)]
    pub supports_message_query: bool,
    /// RocketMQ: dedicated dead-letter browsing.
    #[serde(default)]
    pub supports_dlq: bool,
    /// RocketMQ: message trace lookup (requires broker trace topic).
    #[serde(default)]
    pub supports_message_trace: bool,
    /// RabbitMQ: exchange & binding management.
    #[serde(default)]
    pub supports_exchanges: bool,
    /// RabbitMQ: client connection & channel management (list/close).
    #[serde(default)]
    pub supports_client_connections: bool,
    /// RabbitMQ: user & virtual-host permission management.
    #[serde(default)]
    pub supports_user_permissions: bool,
    /// RabbitMQ: policy management (list/set/delete policies per vhost).
    #[serde(default)]
    pub supports_policies: bool,
    /// RabbitMQ: cluster overview & node monitoring via the management API.
    #[serde(default)]
    pub supports_cluster_monitoring: bool,
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
    /// RocketMQ-only create hint: NORMAL / DELAY / FIFO / TRANSACTION.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_type: Option<String>,
    /// RocketMQ-only: target broker name for create/delete/update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_queue_nums: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_queue_nums: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perm: Option<u32>,
}

fn default_true() -> bool {
    true
}

impl Default for TopicRef {
    fn default() -> Self {
        Self {
            tenant: String::new(),
            namespace: String::new(),
            topic: String::new(),
            persistent: true,
            partitioned: None,
            message_type: None,
            broker_name: None,
            read_queue_nums: None,
            write_queue_nums: None,
            perm: None,
        }
    }
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

    /// `{tenant}/{namespace}/{topic}` - the path used by most Pulsar endpoints.
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
    /// Kafka/RocketMQ internal or system topic; hidden by default in the MQ console UI.
    #[serde(default)]
    pub internal: bool,
    /// RocketMQ message type from broker topic config (NORMAL, DELAY, FIFO, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_type: Option<String>,
    /// Namespace (RabbitMQ: virtual host) this item belongs to; set on
    /// cross-namespace listings such as the RabbitMQ "all vhosts" mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
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
    /// RocketMQ: subscribed topic names for this consumer group (cluster-wide listing).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub topics: Vec<String>,
    /// RocketMQ: online consumer client count (cluster-wide listing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online_members: Option<u32>,
    /// RocketMQ: NORMAL / FIFO / SYSTEM (aligned with Dashboard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer_group_type: Option<String>,
    /// RocketMQ: CLUSTERING / BROADCASTING.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_model: Option<String>,
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
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
/// them to optionally narrow a non-committing peek to one partition / offset.
/// When omitted, Kafka peeks across all partitions from each partition's earliest
/// readable offset (still capped by `count`).
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
                ..Default::default()
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
/// `admin_url` base ? arbitrary hosts are not allowed (SSRF guard).
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
// Exchange / Binding (RabbitMQ)
// ---------------------------------------------------------------------------

/// A RabbitMQ exchange. Namespaces map to virtual hosts, so the exchange's
/// vhost is normally carried by the `NamespaceRef` passed alongside it; in
/// "all vhosts" listings the per-item vhost is reported via `namespace`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqExchangeInfo {
    pub name: String,
    /// `direct` | `fanout` | `topic` | `headers`.
    #[serde(rename = "type")]
    pub exchange_type: String,
    #[serde(default)]
    pub durable: bool,
    #[serde(default)]
    pub auto_delete: bool,
    /// Internal exchange (`amq.*`); cannot be deleted and is hidden by default in the UI.
    #[serde(default)]
    pub internal: bool,
    /// Virtual host this exchange belongs to, set on all-vhosts listings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// A RabbitMQ binding between an exchange (source) and a queue or another
/// exchange (destination).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqBindingInfo {
    /// Source exchange name.
    pub source: String,
    /// Destination queue or exchange name.
    pub destination: String,
    /// `queue` | `exchange`.
    pub destination_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<HashMap<String, serde_json::Value>>,
    /// Virtual host this binding belongs to, set on all-vhosts listings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

// ---------------------------------------------------------------------------
// Client connections / channels (RabbitMQ)
// ---------------------------------------------------------------------------

/// A RabbitMQ client connection as reported by the management API. Virtual
/// host scoping is normally carried by the `NamespaceRef` passed alongside
/// it; in "all vhosts" listings the per-item vhost is reported via
/// `namespace`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqClientConnectionInfo {
    /// Server-side connection name (`host:port -> host:port`).
    pub name: String,
    /// Authenticated username.
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub peer_host: String,
    #[serde(default)]
    pub peer_port: i32,
    /// `running` | `blocked` | `blocking` | ...
    #[serde(default)]
    pub state: String,
    /// Number of channels open on this connection.
    #[serde(default)]
    pub channels: u32,
    /// Receive rate (bytes/s), when the management API reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recv_rate: Option<f64>,
    /// Send rate (bytes/s), when the management API reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_rate: Option<f64>,
    /// Connection establishment time (epoch milliseconds), when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<i64>,
    /// Virtual host this connection is attached to, set on all-vhosts listings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// A RabbitMQ channel as reported by the management API.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqChannelInfo {
    /// Channel name (`<connection name> (<channel number>)`).
    pub name: String,
    /// Name of the connection this channel belongs to, when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefetch: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages_unacked: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer_count: Option<u32>,
    /// Virtual host this channel belongs to, set on all-vhosts listings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

// ---------------------------------------------------------------------------
// Users & virtual-host permissions (RabbitMQ)
// ---------------------------------------------------------------------------

/// A RabbitMQ user account as reported by the management API.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqUserInfo {
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A RabbitMQ user × virtual host permission triple: the `configure` / `write`
/// / `read` regexes scoped to one virtual host.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqVhostPermission {
    pub user: String,
    pub vhost: String,
    pub configure: String,
    pub write: String,
    pub read: String,
}

// ---------------------------------------------------------------------------
// Policies & cluster monitoring (RabbitMQ)
// ---------------------------------------------------------------------------

/// A RabbitMQ policy as reported by the management API. Unlike exchanges and
/// bindings, policies always carry their virtual host explicitly (`vhost`),
/// including on single-vhost listings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqPolicyInfo {
    pub name: String,
    #[serde(default)]
    pub vhost: String,
    /// Regex matching the queues/exchanges this policy applies to.
    #[serde(default)]
    pub pattern: String,
    /// `queues` | `exchanges` | `all`.
    #[serde(default, rename = "applyTo")]
    pub apply_to: String,
    #[serde(default)]
    pub priority: i32,
    /// Policy key/value pairs (`max-length`, `message-ttl`, ...).
    #[serde(default)]
    pub definition: HashMap<String, serde_json::Value>,
}

/// Broker-wide queue totals and message rates from the RabbitMQ management
/// API `overview` endpoint. All fields are optional because the agent omits
/// values the broker does not report.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqOverviewInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages_ready: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages_unacked: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ack_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_queues: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_exchanges: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_connections: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_channels: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_consumers: Option<i64>,
}

/// One RabbitMQ cluster node as reported by the management API.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqNodeInfo {
    pub name: String,
    #[serde(default)]
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_limit: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_free: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fd_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fd_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sockets_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sockets_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<i64>,
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
    /// RabbitMQ: target exchange. When omitted, the agent publishes to the
    /// default exchange with the queue name as routing key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange: Option<String>,
    /// RabbitMQ: routing key used together with `exchange`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_key: Option<String>,
    /// RabbitMQ: namespace hint that maps to the target virtual host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::ResetPosition;

    #[test]
    fn reset_position_deserializes_camel_case_variant_fields() {
        let pos: ResetPosition = serde_json::from_str(r#"{"kind":"timestamp","timestampMs":1710000000000}"#)
            .expect("timestamp reset position");
        assert!(matches!(pos, ResetPosition::Timestamp { timestamp_ms: 1710000000000 }));

        let pos: ResetPosition = serde_json::from_str(r#"{"kind":"messageId","ledgerId":5,"entryId":9}"#)
            .expect("message-id reset position");
        assert!(matches!(pos, ResetPosition::MessageId { ledger_id: 5, entry_id: 9 }));
    }

    #[test]
    fn exchange_info_round_trips_agent_camel_case() {
        let exchange: super::MqExchangeInfo = serde_json::from_str(
            r#"{"name":"dbx-events","type":"topic","durable":true,"autoDelete":false,"internal":false}"#,
        )
        .expect("exchange info");
        assert_eq!(exchange.name, "dbx-events");
        assert_eq!(exchange.exchange_type, "topic");
        assert!(exchange.durable);
        assert!(!exchange.auto_delete);
        assert!(!exchange.internal);

        let json = serde_json::to_value(&exchange).expect("serialize exchange info");
        assert_eq!(json.get("type").and_then(|v| v.as_str()), Some("topic"));
        assert_eq!(json.get("autoDelete").and_then(|v| v.as_bool()), Some(false));
    }

    #[test]
    fn binding_info_skips_absent_routing_key_and_arguments() {
        let binding: super::MqBindingInfo = serde_json::from_str(
            r#"{"source":"dbx-events","destination":"dbx-queue","destinationType":"queue","routingKey":"orders.*"}"#,
        )
        .expect("binding info");
        assert_eq!(binding.source, "dbx-events");
        assert_eq!(binding.destination_type, "queue");
        assert_eq!(binding.routing_key.as_deref(), Some("orders.*"));
        assert!(binding.arguments.is_none());

        let json = serde_json::to_value(&binding).expect("serialize binding info");
        assert!(json.get("arguments").is_none());

        let bare: super::MqBindingInfo =
            serde_json::from_str(r#"{"source":"dbx-a","destination":"dbx-b","destinationType":"exchange"}"#)
                .expect("binding without routing key");
        let json = serde_json::to_value(&bare).expect("serialize bare binding");
        assert!(json.get("routingKey").is_none());
        assert!(json.get("arguments").is_none());
    }

    #[test]
    fn send_message_request_defaults_new_rabbitmq_fields() {
        let req: super::SendMessageRequest =
            serde_json::from_str(r#"{"topic":"dbx-queue","payloadBase64":"aGVsbG8="}"#).expect("send request");
        assert!(req.exchange.is_none());
        assert!(req.routing_key.is_none());
        assert!(req.namespace.is_none());
    }

    #[test]
    fn client_connection_info_round_trips_agent_camel_case() {
        let conn: super::MqClientConnectionInfo = serde_json::from_str(
            r#"{"name":"192.168.1.10:52344 -> 192.168.1.126:5672","user":"jjsd","peerHost":"192.168.1.10","peerPort":52344,"state":"running","channels":3,"recvRate":12.5,"sendRate":34.0,"connectedAt":1710000000000}"#,
        )
        .expect("client connection info");
        assert_eq!(conn.name, "192.168.1.10:52344 -> 192.168.1.126:5672");
        assert_eq!(conn.user, "jjsd");
        assert_eq!(conn.peer_host, "192.168.1.10");
        assert_eq!(conn.peer_port, 52344);
        assert_eq!(conn.state, "running");
        assert_eq!(conn.channels, 3);
        assert_eq!(conn.recv_rate, Some(12.5));
        assert_eq!(conn.send_rate, Some(34.0));
        assert_eq!(conn.connected_at, Some(1710000000000));

        let json = serde_json::to_value(&conn).expect("serialize client connection info");
        assert_eq!(json.get("peerHost").and_then(|v| v.as_str()), Some("192.168.1.10"));
        assert_eq!(json.get("peerPort").and_then(|v| v.as_i64()), Some(52344));
        assert_eq!(json.get("connectedAt").and_then(|v| v.as_i64()), Some(1710000000000));
    }

    #[test]
    fn client_connection_info_skips_absent_optional_fields() {
        let conn: super::MqClientConnectionInfo = serde_json::from_str(
            r#"{"name":"a:1 -> b:5672","user":"guest","peerHost":"a","peerPort":1,"state":"running","channels":0}"#,
        )
        .expect("client connection info without rates");
        assert!(conn.recv_rate.is_none());
        assert!(conn.send_rate.is_none());
        assert!(conn.connected_at.is_none());

        let json = serde_json::to_value(&conn).expect("serialize client connection info");
        assert!(json.get("recvRate").is_none());
        assert!(json.get("sendRate").is_none());
        assert!(json.get("connectedAt").is_none());
    }

    #[test]
    fn user_info_round_trips_agent_camel_case() {
        let user: super::MqUserInfo =
            serde_json::from_str(r#"{"name":"dbx-app","tags":["management","policymaker"]}"#).expect("user info");
        assert_eq!(user.name, "dbx-app");
        assert_eq!(user.tags, vec!["management".to_string(), "policymaker".to_string()]);

        // Users without tags default to an empty list.
        let bare: super::MqUserInfo = serde_json::from_str(r#"{"name":"dbx-svc"}"#).expect("user without tags");
        assert!(bare.tags.is_empty());

        let json = serde_json::to_value(&user).expect("serialize user info");
        assert_eq!(json.get("name").and_then(|v| v.as_str()), Some("dbx-app"));
        assert_eq!(json.get("tags").and_then(|v| v.as_array()).map(|a| a.len()), Some(2));
    }

    #[test]
    fn vhost_permission_round_trips_agent_fields() {
        let perm: super::MqVhostPermission = serde_json::from_str(
            r#"{"user":"dbx-app","vhost":"orders","configure":".*","write":"dbx-.*","read":".*"}"#,
        )
        .expect("vhost permission");
        assert_eq!(perm.user, "dbx-app");
        assert_eq!(perm.vhost, "orders");
        assert_eq!(perm.configure, ".*");
        assert_eq!(perm.write, "dbx-.*");
        assert_eq!(perm.read, ".*");

        let json = serde_json::to_value(&perm).expect("serialize vhost permission");
        assert_eq!(json.get("vhost").and_then(|v| v.as_str()), Some("orders"));
        assert_eq!(json.get("write").and_then(|v| v.as_str()), Some("dbx-.*"));
    }

    #[test]
    fn capabilities_default_user_permissions_off() {
        // The older capability fields are not `serde(default)`, so a payload
        // from an adapter predating the new flag is simulated by serializing a
        // full struct and stripping the new key: it must deserialize with the
        // flag off.
        let caps = super::MqCapabilities { supports_tenants: true, ..Default::default() };
        let mut json = serde_json::to_value(caps).expect("serialize capabilities");
        assert_eq!(json.get("supportsUserPermissions").and_then(|v| v.as_bool()), Some(false));
        json.as_object_mut().expect("capabilities object").remove("supportsUserPermissions");

        let caps: super::MqCapabilities = serde_json::from_value(json).expect("deserialize without the new field");
        assert!(!caps.supports_user_permissions);
        assert!(caps.supports_tenants);
    }

    #[test]
    fn channel_info_round_trips_agent_camel_case() {
        let channel: super::MqChannelInfo = serde_json::from_str(
            r#"{"name":"a:1 -> b:5672 (1)","connectionName":"a:1 -> b:5672","state":"running","prefetch":20,"messagesUnacked":7,"consumerCount":2}"#,
        )
        .expect("channel info");
        assert_eq!(channel.name, "a:1 -> b:5672 (1)");
        assert_eq!(channel.connection_name.as_deref(), Some("a:1 -> b:5672"));
        assert_eq!(channel.state, "running");
        assert_eq!(channel.prefetch, Some(20));
        assert_eq!(channel.messages_unacked, Some(7));
        assert_eq!(channel.consumer_count, Some(2));

        let json = serde_json::to_value(&channel).expect("serialize channel info");
        assert_eq!(json.get("connectionName").and_then(|v| v.as_str()), Some("a:1 -> b:5672"));
        assert_eq!(json.get("messagesUnacked").and_then(|v| v.as_u64()), Some(7));
        assert_eq!(json.get("consumerCount").and_then(|v| v.as_u64()), Some(2));

        let bare: super::MqChannelInfo =
            serde_json::from_str(r#"{"name":"a:1 -> b:5672 (2)","state":"running"}"#).expect("bare channel info");
        let json = serde_json::to_value(&bare).expect("serialize bare channel info");
        assert!(json.get("connectionName").is_none());
        assert!(json.get("prefetch").is_none());
        assert!(json.get("messagesUnacked").is_none());
        assert!(json.get("consumerCount").is_none());
    }

    #[test]
    fn policy_info_round_trips_agent_fields() {
        let policy: super::MqPolicyInfo = serde_json::from_str(
            r#"{"name":"dbx-ttl","vhost":"orders","pattern":"^dbx-","applyTo":"queues","priority":5,"definition":{"message-ttl":60000,"max-length":1000}}"#,
        )
        .expect("policy info");
        assert_eq!(policy.name, "dbx-ttl");
        assert_eq!(policy.vhost, "orders");
        assert_eq!(policy.pattern, "^dbx-");
        assert_eq!(policy.apply_to, "queues");
        assert_eq!(policy.priority, 5);
        assert_eq!(policy.definition.get("message-ttl").and_then(|v| v.as_i64()), Some(60000));

        let json = serde_json::to_value(&policy).expect("serialize policy info");
        assert_eq!(json.get("applyTo").and_then(|v| v.as_str()), Some("queues"));
        assert_eq!(json.get("vhost").and_then(|v| v.as_str()), Some("orders"));
    }

    #[test]
    fn policy_info_defaults_absent_apply_to_and_priority() {
        let policy: super::MqPolicyInfo =
            serde_json::from_str(r#"{"name":"dbx-ha","vhost":"/","pattern":".*","definition":{"ha-mode":"all"}}"#)
                .expect("policy without applyTo/priority");
        assert!(policy.apply_to.is_empty());
        assert_eq!(policy.priority, 0);
        assert_eq!(policy.definition.get("ha-mode").and_then(|v| v.as_str()), Some("all"));
    }

    #[test]
    fn overview_info_skips_absent_optional_fields() {
        let overview: super::MqOverviewInfo = serde_json::from_str(
            r#"{"messagesReady":12,"messagesUnacked":3,"publishRate":1.5,"deliverRate":2.0,"ackRate":2.0,"totalQueues":4,"totalExchanges":7,"totalConnections":2,"totalChannels":5,"totalConsumers":6}"#,
        )
        .expect("overview info");
        assert_eq!(overview.messages_ready, Some(12));
        assert_eq!(overview.publish_rate, Some(1.5));
        assert_eq!(overview.total_consumers, Some(6));

        let json = serde_json::to_value(&overview).expect("serialize overview info");
        assert_eq!(json.get("messagesReady").and_then(|v| v.as_i64()), Some(12));
        assert_eq!(json.get("ackRate").and_then(|v| v.as_f64()), Some(2.0));

        let bare: super::MqOverviewInfo = serde_json::from_str(r#"{}"#).expect("empty overview");
        assert!(bare.messages_ready.is_none());
        let json = serde_json::to_value(&bare).expect("serialize empty overview");
        assert!(json.get("messagesReady").is_none());
        assert!(json.get("totalQueues").is_none());
    }

    #[test]
    fn node_info_round_trips_agent_camel_case() {
        let node: super::MqNodeInfo = serde_json::from_str(
            r#"{"name":"rabbit@node1","running":true,"memUsed":1024,"memLimit":2048,"diskFree":4096,"fdUsed":10,"fdTotal":100,"socketsUsed":3,"socketsTotal":50,"uptimeMs":1710000000000}"#,
        )
        .expect("node info");
        assert_eq!(node.name, "rabbit@node1");
        assert!(node.running);
        assert_eq!(node.mem_used, Some(1024));
        assert_eq!(node.fd_total, Some(100));
        assert_eq!(node.uptime_ms, Some(1710000000000));

        let json = serde_json::to_value(&node).expect("serialize node info");
        assert_eq!(json.get("memUsed").and_then(|v| v.as_i64()), Some(1024));
        assert_eq!(json.get("socketsTotal").and_then(|v| v.as_i64()), Some(50));

        let bare: super::MqNodeInfo =
            serde_json::from_str(r#"{"name":"rabbit@node2","running":false}"#).expect("bare node info");
        assert!(!bare.running);
        let json = serde_json::to_value(&bare).expect("serialize bare node info");
        assert!(json.get("memUsed").is_none());
        assert!(json.get("uptimeMs").is_none());
    }

    #[test]
    fn capabilities_default_policies_and_cluster_monitoring_off() {
        // Adapters predating the new flags omit them; deserialization must
        // default both to off.
        let caps = super::MqCapabilities { supports_tenants: true, ..Default::default() };
        let mut json = serde_json::to_value(caps).expect("serialize capabilities");
        json.as_object_mut().expect("capabilities object").remove("supportsPolicies");
        json.as_object_mut().expect("capabilities object").remove("supportsClusterMonitoring");

        let caps: super::MqCapabilities = serde_json::from_value(json).expect("deserialize without the new fields");
        assert!(!caps.supports_policies);
        assert!(!caps.supports_cluster_monitoring);
        assert!(caps.supports_tenants);
    }
}
