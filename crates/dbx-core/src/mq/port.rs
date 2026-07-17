//! The message queue admin port — the abstraction all MQ systems implement.
//!
//! Commands and routes program against this trait only; concrete systems
//! (Pulsar today, Kafka / RocketMQ later) live in `adapters/`.

use async_trait::async_trait;

use crate::mq::types::*;

/// Unified management interface for message queue systems.
#[async_trait]
pub trait MessageQueueAdmin: Send + Sync {
    /// Capability flags so the frontend can show/hide functionality.
    fn capabilities(&self) -> MqCapabilities;

    fn system_kind(&self) -> MqSystemKind;

    /// Connectivity test; returns cluster/version info.
    async fn test_connection(&self) -> Result<MqClusterInfo, String>;

    // ---- Tenants ----
    async fn list_tenants(&self) -> Result<Vec<TenantInfo>, String>;
    async fn get_tenant(&self, name: &str) -> Result<TenantInfo, String>;
    async fn create_tenant(&self, name: &str, cfg: TenantConfig) -> Result<(), String>;
    async fn update_tenant(&self, name: &str, cfg: TenantConfig) -> Result<(), String>;
    async fn delete_tenant(&self, name: &str, force: bool) -> Result<(), String>;

    // ---- Namespaces ----
    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<NamespaceInfo>, String>;
    async fn create_namespace(&self, ns: &NamespaceRef, cfg: NamespaceConfig) -> Result<(), String>;
    async fn delete_namespace(&self, ns: &NamespaceRef, force: bool) -> Result<(), String>;
    async fn get_namespace_policies(&self, ns: &NamespaceRef) -> Result<serde_json::Value, String>;

    // ---- Topics ----
    async fn list_topics(&self, ns: &NamespaceRef, opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String>;
    async fn create_topic(&self, topic: &TopicRef, partitions: Option<u32>) -> Result<(), String>;
    async fn delete_topic(&self, topic: &TopicRef, force: bool) -> Result<(), String>;
    async fn update_partitions(&self, topic: &TopicRef, partitions: u32) -> Result<(), String>;
    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<TopicStats, String>;
    async fn get_topic_internal_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, String>;

    // ---- Subscriptions ----
    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<SubscriptionInfo>, String>;
    async fn create_subscription(&self, topic: &TopicRef, sub: &str, pos: ResetPosition) -> Result<(), String>;
    async fn delete_subscription(&self, topic: &TopicRef, sub: &str, force: bool) -> Result<(), String>;
    async fn skip_messages(&self, topic: &TopicRef, sub: &str, count: SkipCount) -> Result<(), String>;
    async fn reset_cursor(&self, topic: &TopicRef, sub: &str, pos: ResetPosition) -> Result<(), String>;
    async fn clear_backlog(&self, topic: &TopicRef, sub: &str) -> Result<(), String>;
    async fn peek_messages(
        &self,
        topic: &TopicRef,
        sub: &str,
        count: u32,
        options: PeekMessagesOptions,
    ) -> Result<Vec<PeekedMessage>, String>;
    async fn expire_messages(&self, topic: &TopicRef, sub: &str, expire_seconds: i64) -> Result<(), String>;

    // ---- Producers / consumers (runtime, read from stats) ----
    async fn list_producers(&self, topic: &TopicRef) -> Result<Vec<ProducerInfo>, String>;
    async fn list_consumers(&self, topic: &TopicRef, sub: &str) -> Result<Vec<ConsumerInfo>, String>;
    /// Unload a topic (Pulsar has no per-connection kill; unload is the closest).
    async fn unload_topic(&self, topic: &TopicRef) -> Result<(), String>;

    // ---- Rate limits / quotas / retention ----
    async fn set_publish_rate(&self, scope: &PolicyScope, rate: PublishRate) -> Result<(), String>;
    async fn set_dispatch_rate(&self, scope: &PolicyScope, rate: DispatchRate) -> Result<(), String>;
    async fn set_subscribe_rate(&self, scope: &PolicyScope, rate: SubscribeRate) -> Result<(), String>;
    async fn set_backlog_quota(&self, scope: &PolicyScope, quota: BacklogQuota) -> Result<(), String>;
    async fn set_retention(&self, scope: &PolicyScope, retention: RetentionPolicy) -> Result<(), String>;
    async fn get_effective_policies(&self, scope: &PolicyScope) -> Result<serde_json::Value, String>;

    // ---- Permissions (who can produce / consume) ----
    async fn grant_permission(&self, scope: &PolicyScope, role: &str, actions: Vec<AuthAction>) -> Result<(), String>;
    async fn revoke_permission(&self, scope: &PolicyScope, role: &str) -> Result<(), String>;
    async fn list_permissions(&self, scope: &PolicyScope) -> Result<PermissionMap, String>;

    // ---- Monitoring ----
    async fn get_backlog(&self, topic: &TopicRef, sub: Option<&str>) -> Result<BacklogStats, String>;

    /// Cluster-level info for the Broker monitoring panel.
    async fn get_cluster_info(&self) -> Result<ClusterInfo, String> {
        Err("Cluster info is not supported by this MQ system".to_string())
    }

    /// Escape hatch: proxy an arbitrary admin REST call. Covers any endpoint the
    /// typed methods do not.
    async fn raw_request(&self, req: MqRawRequest) -> Result<MqRawResponse, String>;

    // ---- Message production ----

    /// Produce a message to a topic. Adapters that do not support message
    /// production (e.g. admin-only systems) return an error by default.
    async fn send_message(&self, _req: SendMessageRequest) -> Result<SendMessageResponse, String> {
        Err("Message production is not supported by this MQ system".to_string())
    }
}
