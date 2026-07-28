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

    async fn get_topic_route(&self, _topic: &TopicRef) -> Result<serde_json::Value, String> {
        Err("Topic route is not supported by this MQ system".to_string())
    }

    // ---- Exchanges / bindings (RabbitMQ) ----

    async fn list_exchanges(&self, _ns: &NamespaceRef) -> Result<Vec<MqExchangeInfo>, String> {
        Err("Exchanges are not supported by this MQ system".to_string())
    }

    async fn create_exchange(
        &self,
        _ns: &NamespaceRef,
        _name: &str,
        _exchange_type: &str,
        _durable: bool,
        _auto_delete: bool,
    ) -> Result<(), String> {
        Err("Exchanges are not supported by this MQ system".to_string())
    }

    async fn delete_exchange(&self, _ns: &NamespaceRef, _name: &str) -> Result<(), String> {
        Err("Exchanges are not supported by this MQ system".to_string())
    }

    async fn list_bindings(
        &self,
        _ns: &NamespaceRef,
        _exchange: Option<&str>,
        _queue: Option<&str>,
    ) -> Result<Vec<MqBindingInfo>, String> {
        Err("Bindings are not supported by this MQ system".to_string())
    }

    async fn bind_queue(&self, _ns: &NamespaceRef, _binding: &MqBindingInfo) -> Result<(), String> {
        Err("Bindings are not supported by this MQ system".to_string())
    }

    async fn unbind_queue(&self, _ns: &NamespaceRef, _binding: &MqBindingInfo) -> Result<(), String> {
        Err("Bindings are not supported by this MQ system".to_string())
    }

    // ---- Client connections / channels (RabbitMQ) ----

    async fn list_client_connections(&self, _ns: &NamespaceRef) -> Result<Vec<MqClientConnectionInfo>, String> {
        Err("Client connections are not supported by this MQ system".to_string())
    }

    async fn list_client_channels(
        &self,
        _ns: &NamespaceRef,
        _connection: Option<String>,
    ) -> Result<Vec<MqChannelInfo>, String> {
        Err("Client channels are not supported by this MQ system".to_string())
    }

    async fn close_client_connection(&self, _ns: &NamespaceRef, _name: &str) -> Result<(), String> {
        Err("Closing client connections is not supported by this MQ system".to_string())
    }

    async fn alter_topic_config(&self, _topic: &TopicRef, _configs: serde_json::Value) -> Result<(), String> {
        Err("Alter topic config is not supported by this MQ system".to_string())
    }

    async fn skip_topic_accumulation(&self, _topic: &TopicRef) -> Result<serde_json::Value, String> {
        Err("Skip topic accumulation is not supported by this MQ system".to_string())
    }

    async fn view_message(&self, _topic: &TopicRef, _msg_id: &str) -> Result<serde_json::Value, String> {
        Err("View message is not supported by this MQ system".to_string())
    }

    async fn query_messages_by_key(
        &self,
        _topic: &TopicRef,
        _key: &str,
        _begin: i64,
        _end: i64,
        _max_num: u32,
    ) -> Result<serde_json::Value, String> {
        Err("Message query is not supported by this MQ system".to_string())
    }

    async fn query_messages_by_topic(
        &self,
        _topic: &TopicRef,
        _begin: i64,
        _end: i64,
        _max_num: u32,
    ) -> Result<serde_json::Value, String> {
        Err("Message query is not supported by this MQ system".to_string())
    }

    async fn query_message_trace(
        &self,
        _msg_id: &str,
        _trace_topic: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        Err("Message trace is not supported by this MQ system".to_string())
    }

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

    /// RocketMQ: read subscription group config from broker metadata.
    async fn get_consumer_group_config(&self, _group_id: &str) -> Result<serde_json::Value, String> {
        Err("Consumer group config is not supported by this MQ system".to_string())
    }

    /// RocketMQ: update subscription group config on brokers.
    async fn alter_consumer_group_config(&self, _group_id: &str, _config: serde_json::Value) -> Result<(), String> {
        Err("Consumer group config is not supported by this MQ system".to_string())
    }

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

    // ---- Users & virtual-host permissions (RabbitMQ) ----

    async fn list_users(&self) -> Result<Vec<MqUserInfo>, String> {
        Err("User management is not supported by this MQ system".to_string())
    }

    async fn create_user(&self, _name: &str, _password: &str, _tags: Vec<String>) -> Result<(), String> {
        Err("User management is not supported by this MQ system".to_string())
    }

    async fn delete_user(&self, _name: &str) -> Result<(), String> {
        Err("User management is not supported by this MQ system".to_string())
    }

    async fn list_user_permissions(&self, _ns: &NamespaceRef) -> Result<Vec<MqVhostPermission>, String> {
        Err("User permissions are not supported by this MQ system".to_string())
    }

    async fn grant_user_permission(
        &self,
        _ns: &NamespaceRef,
        _user: &str,
        _configure: &str,
        _write: &str,
        _read: &str,
    ) -> Result<(), String> {
        Err("User permissions are not supported by this MQ system".to_string())
    }

    async fn revoke_user_permission(&self, _ns: &NamespaceRef, _user: &str) -> Result<(), String> {
        Err("User permissions are not supported by this MQ system".to_string())
    }

    // ---- Policies (RabbitMQ) ----

    async fn list_policies(&self, _ns: &NamespaceRef) -> Result<Vec<MqPolicyInfo>, String> {
        Err("Policies are not supported by this MQ system".to_string())
    }

    async fn set_policy(&self, _ns: &NamespaceRef, _policy: &MqPolicyInfo) -> Result<(), String> {
        Err("Policies are not supported by this MQ system".to_string())
    }

    async fn delete_policy(&self, _ns: &NamespaceRef, _name: &str) -> Result<(), String> {
        Err("Policies are not supported by this MQ system".to_string())
    }

    // ---- Cluster monitoring (RabbitMQ) ----

    /// Broker-wide queue totals and message rates.
    async fn get_overview(&self) -> Result<MqOverviewInfo, String> {
        Err("Cluster overview is not supported by this MQ system".to_string())
    }

    /// Cluster node listing with resource usage.
    async fn list_nodes(&self) -> Result<Vec<MqNodeInfo>, String> {
        Err("Cluster node monitoring is not supported by this MQ system".to_string())
    }

    // ---- Message production ----

    /// Produce a message to a topic. Adapters that do not support message
    /// production (e.g. admin-only systems) return an error by default.
    async fn send_message(&self, _req: SendMessageRequest) -> Result<SendMessageResponse, String> {
        Err("Message production is not supported by this MQ system".to_string())
    }
}
