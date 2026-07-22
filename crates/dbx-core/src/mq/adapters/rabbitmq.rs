//! RabbitMQ admin adapter. Communicates with a Java agent process
//! (`RabbitMqAgent.java`) via JSON-RPC over stdin/stdout. The Java agent uses
//! the `amqp-client` library for admin and message operations.
//!
//! This adapter follows the same pattern as the Kafka agent:
//! 1. Spawn a Java agent process via `AgentDriverClient`
//! 2. Perform JSON-RPC handshake + connect
//! 3. Delegate all `MessageQueueAdmin` trait methods to JSON-RPC calls

use std::sync::Arc;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
use crate::mq::auth::MqAuth;
use crate::mq::config::MqAdminConfig;
use crate::mq::port::MessageQueueAdmin;
use crate::mq::types::*;

/// RabbitMQ capabilities - no tenants/partitions. Topics map to queues and
/// namespaces map to virtual hosts; the subscriptions panel lists queue
/// consumers; queues can be purged (clear backlog); message peeking and
/// production are supported through the agent; exchanges and bindings are
/// managed through the agent.
const RABBITMQ_CAPABILITIES: MqCapabilities = MqCapabilities {
    supports_tenants: false,
    supports_namespaces: true,
    supports_partitioned_topics: false,
    supports_subscriptions: true,
    supports_create_subscription: false,
    supports_reset_cursor: false,
    supports_skip_messages: false,
    supports_clear_backlog: true,
    supports_peek_messages: true,
    supports_expire_messages: false,
    supports_rate_limits: false,
    supports_backlog_quota: false,
    supports_retention: false,
    supports_permissions: false,
    supports_geo_replication: false,
    supports_token_management: false,
    supports_raw_admin_api: false,
    supports_send_message: true,
    supports_message_query: false,
    supports_dlq: false,
    supports_message_trace: false,
    supports_exchanges: true,
    supports_client_connections: true,
    supports_user_permissions: true,
    supports_policies: true,
    supports_cluster_monitoring: true,
};

pub struct RabbitMqAdmin {
    client: Arc<Mutex<AgentDriverClient>>,
    config: MqAdminConfig,
}

impl RabbitMqAdmin {
    /// Spawn the RabbitMQ Java agent, perform handshake, and connect.
    pub async fn new(cfg: MqAdminConfig, launch: AgentLaunchSpec) -> Result<Self, String> {
        let mut client = AgentDriverClient::spawn(launch).await?;

        // Handshake
        let _: serde_json::Value = client.call("handshake", serde_json::json!({})).await?;

        // Build the connection params from MqAdminConfig
        let conn_params = build_connection_params(&cfg)?;
        let connect_params = serde_json::json!({ "connection": conn_params });
        let _: serde_json::Value = client.call("connect", connect_params).await?;

        log::info!("RabbitMQ admin connected via agent (addresses: {})", addresses(&cfg));

        Ok(Self { client: Arc::new(Mutex::new(client)), config: cfg })
    }

    /// Send a JSON-RPC call to the RabbitMQ agent and deserialize the result.
    async fn call<T: DeserializeOwned + Send + 'static>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, String> {
        let mut client = self.client.lock().await;
        client.call(method, params).await
    }

    /// Send a JSON-RPC call that returns `{ok: true}` on success.
    async fn call_ok(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        let _: serde_json::Value = self.call(method, params).await?;
        Ok(())
    }
}

#[async_trait]
impl MessageQueueAdmin for RabbitMqAdmin {
    fn capabilities(&self) -> MqCapabilities {
        RABBITMQ_CAPABILITIES
    }

    fn system_kind(&self) -> MqSystemKind {
        MqSystemKind::RabbitMq
    }

    async fn test_connection(&self) -> Result<MqClusterInfo, String> {
        let conn_params = build_connection_params(&self.config)?;
        let result: serde_json::Value =
            self.call("test_connection", serde_json::json!({ "connection": conn_params })).await?;

        let server_version = result.get("serverVersion").and_then(|v| v.as_str()).map(String::from);
        let cluster_name = result.get("clusterName").and_then(|v| v.as_str()).map(String::from);

        Ok(MqClusterInfo {
            system_kind: MqSystemKind::RabbitMq,
            server_version,
            resolved_profile: "rabbitmq-agent".to_string(),
            version_detection: "agent".to_string(),
            capabilities: RABBITMQ_CAPABILITIES,
            extra: serde_json::json!({
                "clusterName": cluster_name,
            }),
        })
    }

    // ---- Tenants (not supported by RabbitMQ) ----

    async fn list_tenants(&self) -> Result<Vec<TenantInfo>, String> {
        Ok(Vec::new())
    }

    async fn get_tenant(&self, _name: &str) -> Result<TenantInfo, String> {
        Err("RabbitMQ does not support tenants".to_string())
    }

    async fn create_tenant(&self, _name: &str, _cfg: TenantConfig) -> Result<(), String> {
        Err("RabbitMQ does not support tenants".to_string())
    }

    async fn update_tenant(&self, _name: &str, _cfg: TenantConfig) -> Result<(), String> {
        Err("RabbitMQ does not support tenants".to_string())
    }

    async fn delete_tenant(&self, _name: &str, _force: bool) -> Result<(), String> {
        Err("RabbitMQ does not support tenants".to_string())
    }

    // ---- Namespaces (mapped to virtual hosts) ----

    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<NamespaceInfo>, String> {
        let result: serde_json::Value = self.call("mq_list_namespaces", serde_json::json!({})).await?;
        let namespaces = result.get("namespaces").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        Ok(namespaces
            .into_iter()
            .map(|n| NamespaceInfo {
                tenant: tenant.to_string(),
                namespace: n.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                ..Default::default()
            })
            .collect())
    }

    async fn create_namespace(&self, ns: &NamespaceRef, _cfg: NamespaceConfig) -> Result<(), String> {
        let vhost = namespace_vhost_name(&ns.namespace)?;
        self.call_ok("mq_create_namespace", serde_json::json!({ "namespace": vhost })).await
    }

    async fn delete_namespace(&self, ns: &NamespaceRef, _force: bool) -> Result<(), String> {
        let vhost = namespace_vhost_name(&ns.namespace)?;
        self.call_ok("mq_delete_namespace", serde_json::json!({ "namespace": vhost })).await
    }

    async fn get_namespace_policies(&self, _ns: &NamespaceRef) -> Result<serde_json::Value, String> {
        Err("RabbitMQ does not support namespaces".to_string())
    }

    // ---- Topics (mapped to queues; namespace maps to virtual host) ----

    async fn list_topics(&self, ns: &NamespaceRef, _opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String> {
        let params = with_virtual_host(serde_json::json!({}), &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_topics", params).await?;
        let topics = result.get("topics").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        Ok(topics
            .into_iter()
            .map(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                TopicInfo {
                    name: name.clone(),
                    short_name: name,
                    partitioned: false,
                    partitions: None,
                    persistent: t.get("durable").and_then(|v| v.as_bool()).unwrap_or(true),
                    internal: t.get("internal").and_then(|v| v.as_bool()).unwrap_or(false),
                    message_type: None,
                    // All-vhosts listings report each queue's own vhost.
                    namespace: t.get("vhost").and_then(|v| v.as_str()).map(String::from),
                }
            })
            .collect())
    }

    async fn create_topic(&self, topic: &TopicRef, _partitions: Option<u32>) -> Result<(), String> {
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(
            serde_json::json!({
                "name": queue_name(topic),
                "durable": true,
            }),
            &topic.namespace,
        );
        self.call_ok("mq_create_topic", params).await
    }

    async fn delete_topic(&self, topic: &TopicRef, _force: bool) -> Result<(), String> {
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": queue_name(topic) }), &topic.namespace);
        self.call_ok("mq_delete_topic", params).await
    }

    async fn update_partitions(&self, _topic: &TopicRef, _partitions: u32) -> Result<(), String> {
        Err("RabbitMQ queues do not have partitions".to_string())
    }

    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<TopicStats, String> {
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": queue_name(topic) }), &topic.namespace);
        let result: serde_json::Value = self.call("mq_get_topic_stats", params).await?;

        let total_messages = result.get("totalMessages").and_then(|v| v.as_i64()).unwrap_or(0);
        let consumer_count = result.get("consumerCount").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

        Ok(TopicStats {
            msg_rate_in: 0.0,
            msg_rate_out: 0.0,
            msg_throughput_in: 0.0,
            msg_throughput_out: 0.0,
            storage_size: 0,
            backlog_size: total_messages,
            msg_in_counter: 0,
            msg_out_counter: 0,
            subscription_count: consumer_count,
            producer_count: 0,
            raw: result,
        })
    }

    async fn get_topic_internal_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, String> {
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": queue_name(topic) }), &topic.namespace);
        self.call("mq_get_topic_config", params).await
    }

    // ---- Exchanges / bindings ----

    async fn list_exchanges(&self, ns: &NamespaceRef) -> Result<Vec<MqExchangeInfo>, String> {
        let params = with_virtual_host(serde_json::json!({}), &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_exchanges", params).await?;
        let exchanges = result.get("exchanges").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        exchanges
            .into_iter()
            .map(|e| {
                serde_json::from_value(map_item_namespace(e))
                    .map_err(|err| format!("Invalid exchange entry from agent: {err}"))
            })
            .collect()
    }

    async fn create_exchange(
        &self,
        ns: &NamespaceRef,
        name: &str,
        exchange_type: &str,
        durable: bool,
        auto_delete: bool,
    ) -> Result<(), String> {
        require_specific_vhost(&ns.namespace)?;
        let params = with_virtual_host(
            serde_json::json!({
                "name": name,
                "type": exchange_type,
                "durable": durable,
                "autoDelete": auto_delete,
            }),
            &ns.namespace,
        );
        self.call_ok("mq_create_exchange", params).await
    }

    async fn delete_exchange(&self, ns: &NamespaceRef, name: &str) -> Result<(), String> {
        // The default exchange ("") and the built-in `amq.*` exchanges cannot be
        // deleted; refuse locally so the broker is never asked to.
        if name.is_empty() || name.starts_with("amq.") {
            return Err(format!("The built-in exchange '{name}' cannot be deleted"));
        }
        require_specific_vhost(&ns.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": name }), &ns.namespace);
        self.call_ok("mq_delete_exchange", params).await
    }

    async fn list_bindings(
        &self,
        ns: &NamespaceRef,
        exchange: Option<&str>,
        queue: Option<&str>,
    ) -> Result<Vec<MqBindingInfo>, String> {
        let mut params = serde_json::json!({});
        if let Some(exchange) = exchange.filter(|e| !e.is_empty()) {
            params["exchange"] = serde_json::json!(exchange);
        }
        if let Some(queue) = queue.filter(|q| !q.is_empty()) {
            params["queue"] = serde_json::json!(queue);
        }
        let params = with_virtual_host(params, &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_bindings", params).await?;
        let bindings = result.get("bindings").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        bindings
            .into_iter()
            .map(|b| {
                serde_json::from_value(map_item_namespace(b))
                    .map_err(|err| format!("Invalid binding entry from agent: {err}"))
            })
            .collect()
    }

    async fn bind_queue(&self, ns: &NamespaceRef, binding: &MqBindingInfo) -> Result<(), String> {
        let params = binding_params(binding, &ns.namespace)?;
        self.call_ok("mq_bind", params).await
    }

    async fn unbind_queue(&self, ns: &NamespaceRef, binding: &MqBindingInfo) -> Result<(), String> {
        let params = binding_params(binding, &ns.namespace)?;
        self.call_ok("mq_unbind", params).await
    }

    // ---- Client connections / channels ----

    async fn list_client_connections(&self, ns: &NamespaceRef) -> Result<Vec<MqClientConnectionInfo>, String> {
        let params = with_virtual_host(serde_json::json!({}), &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_connections", params).await?;
        let connections = result.get("connections").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        connections
            .into_iter()
            .map(|c| {
                serde_json::from_value(map_item_namespace(c))
                    .map_err(|err| format!("Invalid connection entry from agent: {err}"))
            })
            .collect()
    }

    async fn list_client_channels(
        &self,
        ns: &NamespaceRef,
        connection: Option<String>,
    ) -> Result<Vec<MqChannelInfo>, String> {
        let mut params = serde_json::json!({});
        if let Some(connection) = connection.filter(|c| !c.is_empty()) {
            params["connection"] = serde_json::json!(connection);
        }
        let params = with_virtual_host(params, &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_channels", params).await?;
        let channels = result.get("channels").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        channels
            .into_iter()
            .map(|c| {
                serde_json::from_value(map_item_namespace(c))
                    .map_err(|err| format!("Invalid channel entry from agent: {err}"))
            })
            .collect()
    }

    async fn close_client_connection(&self, ns: &NamespaceRef, name: &str) -> Result<(), String> {
        require_specific_vhost(&ns.namespace)?;
        self.call_ok("mq_close_connection", serde_json::json!({ "name": name })).await
    }

    // ---- Users & virtual-host permissions ----
    //
    // RabbitMQ permissions are a user × vhost configure/write/read regex
    // triple. Users are broker-global (no vhost scope); permission operations
    // are scoped by the namespace (virtual host), where the all-vhosts marker
    // (`*`) requests a cross-vhost listing but is rejected for grant/revoke.

    async fn list_users(&self) -> Result<Vec<MqUserInfo>, String> {
        let result: serde_json::Value = self.call("mq_list_users", serde_json::json!({})).await?;
        let users = result.get("users").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        users
            .into_iter()
            .map(|u| serde_json::from_value(u).map_err(|err| format!("Invalid user entry from agent: {err}")))
            .collect()
    }

    async fn create_user(&self, name: &str, password: &str, tags: Vec<String>) -> Result<(), String> {
        let mut params = serde_json::json!({ "name": name, "password": password });
        if !tags.is_empty() {
            params["tags"] = serde_json::json!(tags);
        }
        self.call_ok("mq_create_user", params).await
    }

    async fn delete_user(&self, name: &str) -> Result<(), String> {
        self.call_ok("mq_delete_user", serde_json::json!({ "name": name })).await
    }

    async fn list_user_permissions(&self, ns: &NamespaceRef) -> Result<Vec<MqVhostPermission>, String> {
        let params = with_virtual_host(serde_json::json!({}), &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_permissions", params).await?;
        let permissions = result.get("permissions").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        permissions
            .into_iter()
            .map(|p| serde_json::from_value(p).map_err(|err| format!("Invalid permission entry from agent: {err}")))
            .collect()
    }

    async fn grant_user_permission(
        &self,
        ns: &NamespaceRef,
        user: &str,
        configure: &str,
        write: &str,
        read: &str,
    ) -> Result<(), String> {
        require_specific_vhost(&ns.namespace)?;
        let mut params = serde_json::json!({ "user": user });
        // Empty patterns are omitted so the agent applies its `.*` default.
        for (key, value) in [("configure", configure), ("write", write), ("read", read)] {
            if !value.trim().is_empty() {
                params[key] = serde_json::json!(value);
            }
        }
        let params = with_virtual_host(params, &ns.namespace);
        self.call_ok("mq_grant_permission", params).await
    }

    async fn revoke_user_permission(&self, ns: &NamespaceRef, user: &str) -> Result<(), String> {
        require_specific_vhost(&ns.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "user": user }), &ns.namespace);
        self.call_ok("mq_revoke_permission", params).await
    }

    // ---- Policies ----
    //
    // RabbitMQ policies are scoped to one virtual host. The all-vhosts marker
    // (`*`) requests a cross-vhost listing (each policy reports its own
    // `vhost`); set/delete must name a specific virtual host.

    async fn list_policies(&self, ns: &NamespaceRef) -> Result<Vec<MqPolicyInfo>, String> {
        let params = with_virtual_host(serde_json::json!({}), &ns.namespace);
        let result: serde_json::Value = self.call("mq_list_policies", params).await?;
        let policies = result.get("policies").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        policies
            .into_iter()
            .map(|p| serde_json::from_value(p).map_err(|err| format!("Invalid policy entry from agent: {err}")))
            .collect()
    }

    async fn set_policy(&self, ns: &NamespaceRef, policy: &MqPolicyInfo) -> Result<(), String> {
        let params = policy_params(policy, &ns.namespace)?;
        self.call_ok("mq_set_policy", params).await
    }

    async fn delete_policy(&self, ns: &NamespaceRef, name: &str) -> Result<(), String> {
        require_specific_vhost(&ns.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": name }), &ns.namespace);
        self.call_ok("mq_delete_policy", params).await
    }

    // ---- Subscriptions ----
    //
    // RabbitMQ has no named subscriptions; consumers attach to queues directly.
    // Each queue consumer is surfaced as a subscription keyed by its consumer
    // tag (mirrors the Kafka consumer-group mapping).

    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<SubscriptionInfo>, String> {
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "topic": queue_name(topic) }), &topic.namespace);
        let result: serde_json::Value = self.call("mq_list_consumers", params).await?;

        let consumers = result.get("consumers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(consumers.iter().map(subscription_from_consumer_json).collect())
    }

    async fn create_subscription(&self, _topic: &TopicRef, _sub: &str, _pos: ResetPosition) -> Result<(), String> {
        Err("RabbitMQ consumers are created when clients subscribe to a queue".to_string())
    }

    async fn delete_subscription(&self, _topic: &TopicRef, _sub: &str, _force: bool) -> Result<(), String> {
        Err("RabbitMQ does not support deleting subscriptions; stop the consumer client instead".to_string())
    }

    async fn skip_messages(&self, _topic: &TopicRef, _sub: &str, _count: SkipCount) -> Result<(), String> {
        Err("RabbitMQ does not support skipping messages on a subscription".to_string())
    }

    async fn reset_cursor(&self, _topic: &TopicRef, _sub: &str, _pos: ResetPosition) -> Result<(), String> {
        Err("RabbitMQ does not support resetting cursors; queues are consumed in order".to_string())
    }

    async fn clear_backlog(&self, topic: &TopicRef, _sub: &str) -> Result<(), String> {
        // RabbitMQ purges whole queues; the subscription argument is ignored.
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "topic": queue_name(topic) }), &topic.namespace);
        self.call_ok("mq_purge_queue", params).await
    }

    async fn peek_messages(
        &self,
        topic: &TopicRef,
        _sub: &str,
        count: u32,
        _options: PeekMessagesOptions,
    ) -> Result<Vec<PeekedMessage>, String> {
        let conn_params = build_connection_params(&self.config)?;
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(
            serde_json::json!({
                "topic": queue_name(topic),
                "count": count,
                "connection": conn_params,
            }),
            &topic.namespace,
        );
        let result: serde_json::Value = self.call("mq_peek_messages", params).await?;

        let messages = result.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(messages.into_iter().enumerate().map(|(idx, m)| peeked_message_from_json(idx, &m)).collect())
    }

    async fn expire_messages(&self, _topic: &TopicRef, _sub: &str, _expire_seconds: i64) -> Result<(), String> {
        Err("RabbitMQ does not support expiring messages on a subscription".to_string())
    }

    // ---- Producers / consumers ----
    //
    // The agent protocol has no producer listing method yet, so producers
    // return an empty list instead of failing the whole topic detail view.
    // Consumers come from the management API via `mq_list_consumers`.

    async fn list_producers(&self, _topic: &TopicRef) -> Result<Vec<ProducerInfo>, String> {
        Ok(Vec::new())
    }

    async fn list_consumers(&self, topic: &TopicRef, _sub: &str) -> Result<Vec<ConsumerInfo>, String> {
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "topic": queue_name(topic) }), &topic.namespace);
        let result: serde_json::Value = self.call("mq_list_consumers", params).await?;

        let consumers = result.get("consumers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(consumers.iter().map(consumer_from_json).collect())
    }

    async fn unload_topic(&self, _topic: &TopicRef) -> Result<(), String> {
        Err("RabbitMQ does not support unloading queues".to_string())
    }

    // ---- Rate limits / quotas / retention ----

    async fn set_publish_rate(&self, _scope: &PolicyScope, _rate: PublishRate) -> Result<(), String> {
        Err("RabbitMQ does not support publish rate limits via the agent".to_string())
    }

    async fn set_dispatch_rate(&self, _scope: &PolicyScope, _rate: DispatchRate) -> Result<(), String> {
        Err("RabbitMQ does not support dispatch rate limits via the agent".to_string())
    }

    async fn set_subscribe_rate(&self, _scope: &PolicyScope, _rate: SubscribeRate) -> Result<(), String> {
        Err("RabbitMQ does not support subscribe rate limits via the agent".to_string())
    }

    async fn set_backlog_quota(&self, _scope: &PolicyScope, _quota: BacklogQuota) -> Result<(), String> {
        Err("RabbitMQ does not support backlog quotas via the agent".to_string())
    }

    async fn set_retention(&self, _scope: &PolicyScope, _retention: RetentionPolicy) -> Result<(), String> {
        Err("RabbitMQ retention is managed through queue TTL policies, not supported via the agent".to_string())
    }

    async fn get_effective_policies(&self, scope: &PolicyScope) -> Result<serde_json::Value, String> {
        let (topic_name, namespace) = match scope {
            PolicyScope::Topic { topic, namespace, .. } => (topic.clone(), namespace.clone()),
            PolicyScope::Namespace { .. } => return Err("RabbitMQ does not support namespace policies".to_string()),
        };
        require_specific_vhost(&namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": topic_name }), &namespace);
        self.call("mq_get_topic_config", params).await
    }

    // ---- Permissions (not supported by the agent) ----

    async fn grant_permission(
        &self,
        _scope: &PolicyScope,
        _role: &str,
        _actions: Vec<AuthAction>,
    ) -> Result<(), String> {
        Err("RabbitMQ permissions are managed per virtual host user, not supported via the agent".to_string())
    }

    async fn revoke_permission(&self, _scope: &PolicyScope, _role: &str) -> Result<(), String> {
        Err("RabbitMQ permissions are managed per virtual host user, not supported via the agent".to_string())
    }

    async fn list_permissions(&self, _scope: &PolicyScope) -> Result<PermissionMap, String> {
        Err("RabbitMQ permissions are managed per virtual host user, not supported via the agent".to_string())
    }

    // ---- Monitoring ----

    async fn get_backlog(&self, topic: &TopicRef, _sub: Option<&str>) -> Result<BacklogStats, String> {
        // For RabbitMQ the backlog is the number of ready messages on the queue.
        require_specific_vhost(&topic.namespace)?;
        let params = with_virtual_host(serde_json::json!({ "name": queue_name(topic) }), &topic.namespace);
        let result: serde_json::Value = self.call("mq_get_topic_stats", params).await?;

        let total_messages = result.get("totalMessages").and_then(|v| v.as_i64()).unwrap_or(0);
        Ok(BacklogStats { msg_backlog: total_messages, backlog_size: total_messages })
    }

    async fn get_cluster_info(&self) -> Result<ClusterInfo, String> {
        let result: serde_json::Value = self.call("mq_describe_cluster", serde_json::json!({})).await?;

        let cluster_id = result.get("clusterName").and_then(|v| v.as_str()).map(String::from);
        let brokers: Vec<BrokerNode> = result
            .get("nodes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .enumerate()
                    .map(|(idx, node)| BrokerNode {
                        id: idx as i32,
                        host: node.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                        port: node.get("port").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                        rack: None,
                        ..Default::default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let broker_count = brokers.len() as u32;

        Ok(ClusterInfo { cluster_id, broker_count, controller_id: None, controller_host: None, brokers, raw: result })
    }

    // ---- Cluster monitoring ----
    //
    // Overview and node listings are broker-global; there is no vhost concept.

    async fn get_overview(&self) -> Result<MqOverviewInfo, String> {
        let result: serde_json::Value = self.call("mq_overview", serde_json::json!({})).await?;
        serde_json::from_value(result).map_err(|err| format!("Invalid overview payload from agent: {err}"))
    }

    async fn list_nodes(&self) -> Result<Vec<MqNodeInfo>, String> {
        let result: serde_json::Value = self.call("mq_list_nodes", serde_json::json!({})).await?;
        let nodes = result.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        nodes
            .into_iter()
            .map(|n| serde_json::from_value(n).map_err(|err| format!("Invalid node entry from agent: {err}")))
            .collect()
    }

    // ---- Raw request (not supported for RabbitMQ) ----

    async fn raw_request(&self, _req: MqRawRequest) -> Result<MqRawResponse, String> {
        Err("RabbitMQ raw admin requests are not supported via the agent".to_string())
    }

    // ---- Message production ----

    async fn send_message(&self, req: SendMessageRequest) -> Result<SendMessageResponse, String> {
        let mut params = serde_json::json!({
            "topic": req.topic,
            "key": req.key,
            "payloadBase64": req.payload_base64,
            "headers": req.headers,
        });
        if let Some(exchange) = req.exchange.as_deref().filter(|e| !e.is_empty()) {
            params["exchange"] = serde_json::json!(exchange);
        }
        if let Some(routing_key) = req.routing_key.as_deref() {
            params["routingKey"] = serde_json::json!(routing_key);
        }
        if let Some(namespace) = req.namespace.as_deref() {
            require_specific_vhost(namespace)?;
            params = with_virtual_host(params, namespace);
        }
        let result: serde_json::Value = self.call("mq_send_message", params).await?;

        Ok(SendMessageResponse {
            topic: result.get("topic").and_then(|v| v.as_str()).unwrap_or(&req.topic).to_string(),
            partition: 0,
            offset: result.get("offset").and_then(|v| v.as_i64()).unwrap_or(0),
            timestamp: result.get("timestamp").and_then(|v| v.as_i64()).map(|v| v.to_string()),
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Topic refs use flat queue names for RabbitMQ: the queue name is the short
/// topic name, the tenant is ignored. The namespace maps to a virtual host
/// and is passed through separately (see `with_virtual_host`).
fn queue_name(topic: &TopicRef) -> &str {
    &topic.topic
}

/// Namespace marker meaning "all vhosts": list methods request a cross-vhost
/// listing via `all_vhosts: true` instead of scoping to one virtual host.
const ALL_VHOSTS_NAMESPACE: &str = "*";

/// Resolve the virtual host for a namespace. The synthetic flat contexts
/// (`_flat_mq` / `_rabbitmq`), the all-vhosts marker (`*`), and an empty
/// namespace mean "no explicit vhost" — the agent then falls back to the
/// connection's configured virtual host.
fn namespace_virtual_host(namespace: &str) -> Option<&str> {
    match namespace.trim() {
        "" | ALL_VHOSTS_NAMESPACE | "_flat_mq" | "_rabbitmq" => None,
        other => Some(other),
    }
}

/// Attach the `virtual_host` param when the namespace names a real vhost. The
/// all-vhosts marker (`*`) instead requests a cross-vhost listing via
/// `all_vhosts: true` (the agent then uses the management API's no-vhost
/// variant and reports each item's vhost in the response).
fn with_virtual_host(mut params: serde_json::Value, namespace: &str) -> serde_json::Value {
    if namespace.trim() == ALL_VHOSTS_NAMESPACE {
        params["all_vhosts"] = serde_json::json!(true);
        return params;
    }
    if let Some(vhost) = namespace_virtual_host(namespace) {
        params["virtual_host"] = serde_json::json!(vhost);
    }
    params
}

/// Move the agent's per-item `vhost` field into `namespace` so the typed
/// structs pick it up; all-vhosts listings report each item's own vhost.
fn map_item_namespace(mut item: serde_json::Value) -> serde_json::Value {
    if let Some(vhost) = item.get("vhost").and_then(|v| v.as_str()).map(String::from) {
        item["namespace"] = serde_json::json!(vhost);
    }
    item
}

/// Fail fast when an operation is scoped to the all-vhosts marker (`*`).
/// Cross-vhost context only makes sense for list operations; every targeted
/// operation must name a specific virtual host instead of silently falling
/// back to the connection's default vhost.
fn require_specific_vhost(namespace: &str) -> Result<(), String> {
    if namespace.trim() == ALL_VHOSTS_NAMESPACE {
        return Err("operation requires a specific virtual host (all-vhosts context)".to_string());
    }
    Ok(())
}

/// Vhost name for namespace create/delete: these address a specific vhost by
/// name, so the all-vhosts marker and synthetic/empty namespaces are invalid.
fn namespace_vhost_name(namespace: &str) -> Result<&str, String> {
    require_specific_vhost(namespace)?;
    if namespace.trim().is_empty() || namespace.starts_with('_') {
        return Err(format!("namespace create/delete requires a real virtual host name, got {namespace:?}"));
    }
    Ok(namespace)
}

/// Build the JSON-RPC params for `mq_bind` / `mq_unbind` from a binding. The
/// serialized `MqBindingInfo` already matches the agent contract
/// (`source`/`destination`/`destinationType`/`routingKey`/`arguments`). A
/// concrete vhost carried on the binding itself (e.g. picked from an
/// all-vhosts listing) wins over the namespace argument.
fn binding_params(binding: &MqBindingInfo, namespace: &str) -> Result<serde_json::Value, String> {
    let effective = binding.namespace.as_deref().filter(|ns| namespace_virtual_host(ns).is_some()).unwrap_or(namespace);
    require_specific_vhost(effective)?;
    let params = serde_json::to_value(binding).unwrap_or_else(|_| serde_json::json!({}));
    Ok(with_virtual_host(params, effective))
}

/// Build the JSON-RPC params for `mq_set_policy` from a policy. The all-vhosts
/// marker (`*`) is rejected: policies are written to one specific virtual
/// host. `applyTo` is omitted when empty so the agent applies its `queues`
/// default; `priority` is always sent (0 matches the agent default).
fn policy_params(policy: &MqPolicyInfo, namespace: &str) -> Result<serde_json::Value, String> {
    require_specific_vhost(namespace)?;
    let mut params = serde_json::json!({
        "name": policy.name,
        "pattern": policy.pattern,
        "priority": policy.priority,
        "definition": policy.definition,
    });
    if !policy.apply_to.trim().is_empty() {
        params["applyTo"] = serde_json::json!(policy.apply_to);
    }
    Ok(with_virtual_host(params, namespace))
}

/// Map one agent consumer JSON to a `ConsumerInfo`. The management API does
/// not report rates, so only identity and prefetch (as available permits,
/// same convention as Pulsar) are filled.
fn consumer_from_json(c: &serde_json::Value) -> ConsumerInfo {
    ConsumerInfo {
        consumer_name: c
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| c.get("tag").and_then(|v| v.as_str()))
            .unwrap_or_default()
            .to_string(),
        msg_rate_out: 0.0,
        msg_throughput_out: 0.0,
        available_permits: c.get("prefetch").and_then(|v| v.as_i64()).unwrap_or(0),
        address: String::new(),
        client_version: String::new(),
    }
}

/// Map one agent consumer JSON to a `SubscriptionInfo` keyed by consumer tag
/// (RabbitMQ has no named subscriptions; each consumer acts as one).
fn subscription_from_consumer_json(c: &serde_json::Value) -> SubscriptionInfo {
    let tag =
        c.get("tag").and_then(|v| v.as_str()).or_else(|| c.get("name").and_then(|v| v.as_str())).unwrap_or_default();
    SubscriptionInfo {
        name: tag.to_string(),
        sub_type: "consumer".to_string(),
        consumers: vec![consumer_from_json(c)],
        ..Default::default()
    }
}

/// Extract RabbitMQ addresses from MqAdminConfig.extra.
fn addresses(cfg: &MqAdminConfig) -> String {
    extra_str(&cfg.extra, "addresses").or_else(|| extra_str(&cfg.extra, "host")).unwrap_or("").to_string()
}

fn extra_str<'a>(extra: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    extra.get(key).and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty())
}

fn extra_port(extra: &serde_json::Value) -> Result<u16, String> {
    const DEFAULT_AMQP_PORT: u16 = 5672;
    match extra.get("port") {
        Some(v) if v.is_u64() => {
            let port = v.as_u64().unwrap_or(0);
            u16::try_from(port).map_err(|_| format!("RabbitMQ port {port} is out of range (0-65535)"))
        }
        Some(v) => match v.as_str() {
            Some(s) => s.trim().parse::<u16>().map_err(|_| format!("invalid RabbitMQ port '{s}'")),
            None => Err("RabbitMQ port must be a number or a numeric string".to_string()),
        },
        None => Ok(DEFAULT_AMQP_PORT),
    }
}

/// Build the connection params JSON from MqAdminConfig for the Java agent.
/// Blank credentials are omitted so the agent falls back to its guest/guest
/// default instead of authenticating as `:`. A non-empty `admin_url` is
/// forwarded as `management_url`; otherwise the agent derives the management
/// endpoint from the AMQP addresses itself.
fn build_connection_params(cfg: &MqAdminConfig) -> Result<serde_json::Value, String> {
    let extra = &cfg.extra;
    let basic_auth = match &cfg.auth {
        MqAuth::Basic { username, password } => Some((username.as_str(), password.as_str())),
        _ => None,
    };
    let username = extra_str(extra, "username").or_else(|| basic_auth.map(|(username, _)| username));
    let password = extra_str(extra, "password").or_else(|| basic_auth.map(|(_, password)| password));
    let virtual_host = extra_str(extra, "virtualHost").or_else(|| extra_str(extra, "virtual_host")).unwrap_or("/");
    let properties =
        extra.get("properties").filter(|value| value.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));

    let mut params = serde_json::json!({
        "addresses": addresses(cfg),
        "port": extra_port(extra)?,
        "virtual_host": virtual_host,
        "tls_skip_verify": cfg.tls_skip_verify,
        "properties": properties,
    });
    if let Some(username) = username.filter(|value| !value.trim().is_empty()) {
        params["username"] = serde_json::json!(username);
    }
    if let Some(password) = password.filter(|value| !value.trim().is_empty()) {
        params["password"] = serde_json::json!(password);
    }
    if !cfg.admin_url.trim().is_empty() {
        params["management_url"] = serde_json::json!(cfg.admin_url);
    }
    Ok(params)
}

/// Map one agent peek message JSON to a `PeekedMessage`.
fn peeked_message_from_json(idx: usize, m: &serde_json::Value) -> PeekedMessage {
    let properties = m
        .get("properties")
        .and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
        .unwrap_or_default();
    PeekedMessage {
        position: (idx + 1) as u32,
        message_id: m
            .get("messageId")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| m.get("deliveryTag").and_then(|v| v.as_i64()).map(|v| v.to_string())),
        key: m
            .get("key")
            .and_then(|v| v.as_str())
            .or_else(|| m.get("routingKey").and_then(|v| v.as_str()))
            .map(String::from),
        // The agent reports 0 for messages without a timestamp; map that to
        // `None` so the frontend does not render a 1970 date.
        publish_time: m.get("timestamp").and_then(|v| v.as_i64()).filter(|ts| *ts > 0).map(|v| v.to_string()),
        event_time: None,
        properties,
        headers: m
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default(),
        payload_base64: m.get("payloadBase64").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        payload_text: m.get("payloadText").and_then(|v| v.as_str()).map(String::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mq::auth::MqAuth;
    use crate::mq::types::MqSystemKind;

    fn rabbitmq_config(extra: serde_json::Value, auth: MqAuth, tls_skip_verify: bool) -> MqAdminConfig {
        MqAdminConfig {
            system_kind: MqSystemKind::RabbitMq,
            admin_url: String::new(),
            auth,
            tls_skip_verify,
            pinned_version: None,
            token_signing: None,
            connect_override: None,
            extra,
        }
    }

    #[test]
    fn connection_params_map_addresses_vhost_and_basic_auth() {
        let cfg = rabbitmq_config(
            serde_json::json!({
                "addresses": "rabbit1:5672,rabbit2:5672",
                "port": 5671,
                "virtualHost": "orders",
                "properties": {
                    "connectionName": "dbx"
                }
            }),
            MqAuth::Basic { username: "alice".to_string(), password: "secret".to_string() },
            true,
        );

        let params = build_connection_params(&cfg).expect("connection params");

        assert_eq!(params.get("addresses").and_then(|v| v.as_str()), Some("rabbit1:5672,rabbit2:5672"));
        assert_eq!(params.get("port").and_then(|v| v.as_u64()), Some(5671));
        assert_eq!(params.get("username").and_then(|v| v.as_str()), Some("alice"));
        assert_eq!(params.get("password").and_then(|v| v.as_str()), Some("secret"));
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("orders"));
        assert_eq!(params.get("tls_skip_verify").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(params.pointer("/properties/connectionName").and_then(|v| v.as_str()), Some("dbx"));
    }

    #[test]
    fn connection_params_fall_back_to_host_extra_and_defaults() {
        let cfg = rabbitmq_config(
            serde_json::json!({
                "host": "localhost"
            }),
            MqAuth::None,
            false,
        );

        let params = build_connection_params(&cfg).expect("connection params");

        assert_eq!(params.get("addresses").and_then(|v| v.as_str()), Some("localhost"));
        assert_eq!(params.get("port").and_then(|v| v.as_u64()), Some(5672));
        // Blank credentials are omitted so the agent applies its guest/guest
        // fallback instead of authenticating as ':'.
        assert!(params.get("username").is_none());
        assert!(params.get("password").is_none());
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("/"));
        assert_eq!(params.get("tls_skip_verify").and_then(|v| v.as_bool()), Some(false));
        // Without an explicit admin URL the agent derives the management
        // endpoint from the AMQP addresses.
        assert!(params.get("management_url").is_none());
    }

    #[test]
    fn connection_params_accept_string_port_and_extra_credentials() {
        let cfg = rabbitmq_config(
            serde_json::json!({
                "addresses": "broker",
                "port": "5673",
                "username": "bob",
                "password": "pw"
            }),
            MqAuth::None,
            false,
        );

        let params = build_connection_params(&cfg).expect("connection params");

        assert_eq!(params.get("port").and_then(|v| v.as_u64()), Some(5673));
        assert_eq!(params.get("username").and_then(|v| v.as_str()), Some("bob"));
        assert_eq!(params.get("password").and_then(|v| v.as_str()), Some("pw"));
    }

    #[test]
    fn connection_params_omit_whitespace_only_credentials() {
        let cfg = rabbitmq_config(
            serde_json::json!({ "addresses": "broker" }),
            MqAuth::Basic { username: "   ".to_string(), password: "\t".to_string() },
            false,
        );

        let params = build_connection_params(&cfg).expect("connection params");

        assert!(params.get("username").is_none());
        assert!(params.get("password").is_none());
    }

    #[test]
    fn connection_params_forward_admin_url_as_management_url() {
        // An explicit management URL (e.g. behind a reverse proxy with a path
        // prefix) is forwarded as-is so the agent does not derive it from the
        // AMQP addresses.
        let mut cfg = rabbitmq_config(
            serde_json::json!({ "addresses": "broker" }),
            MqAuth::Basic { username: "alice".to_string(), password: "secret".to_string() },
            false,
        );
        cfg.admin_url = "http://rabbit.internal:15672/proxy".to_string();

        let params = build_connection_params(&cfg).expect("connection params");

        assert_eq!(params.get("management_url").and_then(|v| v.as_str()), Some("http://rabbit.internal:15672/proxy"));
    }

    #[test]
    fn connection_params_reject_out_of_range_ports() {
        for port in [serde_json::json!(70000), serde_json::json!("99999"), serde_json::json!("abc")] {
            let cfg = rabbitmq_config(serde_json::json!({ "addresses": "broker", "port": port }), MqAuth::None, false);

            assert!(build_connection_params(&cfg).is_err(), "port {port} must be rejected");
        }
    }

    #[test]
    fn queue_name_uses_flat_topic_and_ignores_namespace() {
        let topic = TopicRef {
            tenant: "_rabbitmq".to_string(),
            namespace: "_rabbitmq".to_string(),
            topic: "orders.queue".to_string(),
            persistent: true,
            partitioned: None,
            message_type: None,
            ..TopicRef::default()
        };

        assert_eq!(queue_name(&topic), "orders.queue");
    }

    #[test]
    fn peeked_message_maps_agent_fields() {
        let msg = serde_json::json!({
            "deliveryTag": 42,
            "routingKey": "orders.new",
            "timestamp": 1710000000000i64,
            "headers": { "x-trace": "abc" },
            "properties": { "contentType": "application/json" },
            "payloadBase64": "aGVsbG8=",
            "payloadText": "hello"
        });

        let peeked = peeked_message_from_json(0, &msg);

        assert_eq!(peeked.position, 1);
        assert_eq!(peeked.message_id.as_deref(), Some("42"));
        assert_eq!(peeked.key.as_deref(), Some("orders.new"));
        assert_eq!(peeked.publish_time.as_deref(), Some("1710000000000"));
        assert_eq!(peeked.headers.get("x-trace").map(String::as_str), Some("abc"));
        assert_eq!(peeked.properties.get("contentType").map(String::as_str), Some("application/json"));
        assert_eq!(peeked.payload_base64, "aGVsbG8=");
        assert_eq!(peeked.payload_text.as_deref(), Some("hello"));
    }

    #[test]
    fn peeked_message_maps_zero_timestamp_to_no_publish_time() {
        // The agent reports 0 for messages without a timestamp; the frontend
        // would render that as 1970, so it maps to `None`.
        let msg = serde_json::json!({
            "deliveryTag": 7,
            "timestamp": 0,
            "payloadBase64": "aGVsbG8="
        });

        let peeked = peeked_message_from_json(0, &msg);

        assert_eq!(peeked.message_id.as_deref(), Some("7"));
        assert!(peeked.publish_time.is_none());
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn capabilities_enable_namespaces_and_clear_backlog() {
        assert!(RABBITMQ_CAPABILITIES.supports_namespaces);
        assert!(RABBITMQ_CAPABILITIES.supports_clear_backlog);
        assert!(RABBITMQ_CAPABILITIES.supports_subscriptions);
        assert!(RABBITMQ_CAPABILITIES.supports_exchanges);
        assert!(RABBITMQ_CAPABILITIES.supports_client_connections);
        assert!(RABBITMQ_CAPABILITIES.supports_user_permissions);
        assert!(!RABBITMQ_CAPABILITIES.supports_tenants);
        assert!(!RABBITMQ_CAPABILITIES.supports_partitioned_topics);
        assert!(!RABBITMQ_CAPABILITIES.supports_create_subscription);
    }

    #[test]
    fn user_entries_parse_from_agent_payload() {
        let payload = serde_json::json!({
            "users": [
                { "name": "dbx-app", "tags": ["management"] },
                { "name": "dbx-svc" }
            ]
        });

        let users: Vec<MqUserInfo> = payload
            .get("users")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|u| serde_json::from_value(u).expect("user entry"))
            .collect();

        assert_eq!(users.len(), 2);
        assert_eq!(users[0].name, "dbx-app");
        assert_eq!(users[0].tags, vec!["management".to_string()]);
        assert_eq!(users[1].name, "dbx-svc");
        assert!(users[1].tags.is_empty());
    }

    #[test]
    fn permission_entries_parse_from_agent_payload() {
        let payload = serde_json::json!({
            "permissions": [
                { "user": "dbx-app", "vhost": "orders", "configure": ".*", "write": "dbx-.*", "read": ".*" },
                { "user": "dbx-app", "vhost": "/", "configure": "", "write": "", "read": "" }
            ]
        });

        let permissions: Vec<MqVhostPermission> = payload
            .get("permissions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|p| serde_json::from_value(p).expect("permission entry"))
            .collect();

        assert_eq!(permissions.len(), 2);
        assert_eq!(permissions[0].user, "dbx-app");
        assert_eq!(permissions[0].vhost, "orders");
        assert_eq!(permissions[0].write, "dbx-.*");
        assert_eq!(permissions[1].vhost, "/");
        assert!(permissions[1].configure.is_empty());
    }

    #[test]
    fn client_connection_entries_parse_from_agent_payload() {
        let payload = serde_json::json!({
            "connections": [
                {
                    "name": "192.168.1.10:52344 -> 192.168.1.126:5672",
                    "user": "jjsd",
                    "peerHost": "192.168.1.10",
                    "peerPort": 52344,
                    "state": "running",
                    "channels": 2,
                    "recvRate": 10.0,
                    "sendRate": 5.5,
                    "connectedAt": 1710000000000i64
                },
                {
                    "name": "192.168.1.11:1000 -> 192.168.1.126:5672",
                    "user": "guest",
                    "peerHost": "192.168.1.11",
                    "peerPort": 1000,
                    "state": "blocked",
                    "channels": 1
                }
            ]
        });

        let connections: Vec<MqClientConnectionInfo> = payload
            .get("connections")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|c| serde_json::from_value(c).expect("connection entry"))
            .collect();

        assert_eq!(connections.len(), 2);
        assert_eq!(connections[0].channels, 2);
        assert_eq!(connections[0].recv_rate, Some(10.0));
        assert_eq!(connections[0].connected_at, Some(1710000000000));
        assert_eq!(connections[1].state, "blocked");
        assert!(connections[1].recv_rate.is_none());
        assert!(connections[1].connected_at.is_none());
    }

    #[test]
    fn channel_entries_parse_from_agent_payload() {
        let payload = serde_json::json!({
            "channels": [
                {
                    "name": "192.168.1.10:52344 -> 192.168.1.126:5672 (1)",
                    "connectionName": "192.168.1.10:52344 -> 192.168.1.126:5672",
                    "state": "running",
                    "prefetch": 10,
                    "messagesUnacked": 3,
                    "consumerCount": 1
                },
                {
                    "name": "192.168.1.11:1000 -> 192.168.1.126:5672 (1)",
                    "state": "running"
                }
            ]
        });

        let channels: Vec<MqChannelInfo> = payload
            .get("channels")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|c| serde_json::from_value(c).expect("channel entry"))
            .collect();

        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].prefetch, Some(10));
        assert_eq!(channels[0].messages_unacked, Some(3));
        assert_eq!(channels[0].consumer_count, Some(1));
        assert_eq!(channels[0].connection_name.as_deref(), Some("192.168.1.10:52344 -> 192.168.1.126:5672"));
        assert!(channels[1].connection_name.is_none());
        assert!(channels[1].prefetch.is_none());
    }

    #[test]
    fn binding_params_match_agent_contract_and_attach_vhost() {
        let binding = MqBindingInfo {
            source: "dbx-events".to_string(),
            destination: "dbx-queue".to_string(),
            destination_type: "queue".to_string(),
            routing_key: Some("orders.*".to_string()),
            arguments: None,
            namespace: None,
        };

        let params = binding_params(&binding, "orders").expect("binding params");

        assert_eq!(params.get("source").and_then(|v| v.as_str()), Some("dbx-events"));
        assert_eq!(params.get("destination").and_then(|v| v.as_str()), Some("dbx-queue"));
        assert_eq!(params.get("destinationType").and_then(|v| v.as_str()), Some("queue"));
        assert_eq!(params.get("routingKey").and_then(|v| v.as_str()), Some("orders.*"));
        assert!(params.get("arguments").is_none());
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("orders"));

        let bare = MqBindingInfo {
            source: "dbx-a".to_string(),
            destination: "dbx-b".to_string(),
            destination_type: "exchange".to_string(),
            routing_key: None,
            arguments: None,
            namespace: None,
        };
        let params = binding_params(&bare, "_rabbitmq").expect("binding params");
        assert!(params.get("routingKey").is_none());
        assert!(params.get("virtual_host").is_none());
    }

    #[test]
    fn require_specific_vhost_rejects_only_the_all_vhosts_marker() {
        let err = require_specific_vhost("*").expect_err("all-vhosts marker must fail");
        assert_eq!(err, "operation requires a specific virtual host (all-vhosts context)");

        // Whitespace padding does not disguise the marker.
        assert!(require_specific_vhost("  *  ").is_err());

        // Real vhosts, synthetic namespaces, and an empty namespace all pass:
        // they either name a vhost or legitimately use the connection default.
        for ns in ["orders", "_rabbitmq", "_flat_mq", ""] {
            assert!(require_specific_vhost(ns).is_ok(), "namespace {ns:?} must be allowed");
        }
    }

    #[test]
    fn namespace_vhost_name_rejects_star_and_synthetic_namespaces() {
        assert!(namespace_vhost_name("*").is_err(), "create/delete must reject the all-vhosts marker");
        assert!(namespace_vhost_name("").is_err());
        assert!(namespace_vhost_name("_rabbitmq").is_err());
        assert!(namespace_vhost_name("_flat_mq").is_err());
        assert_eq!(namespace_vhost_name("/").expect("root vhost"), "/");
        assert_eq!(namespace_vhost_name("orders").expect("named vhost"), "orders");
    }

    #[test]
    fn binding_params_prefers_binding_namespace_over_argument() {
        let binding = MqBindingInfo {
            source: "dbx-events".to_string(),
            destination: "dbx-queue".to_string(),
            destination_type: "queue".to_string(),
            routing_key: None,
            arguments: None,
            namespace: Some("orders".to_string()),
        };

        let params = binding_params(&binding, "other").expect("binding params");
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("orders"));

        // Synthetic, empty, and wildcard binding namespaces are not real
        // vhosts and fall back to the namespace argument.
        for binding_ns in ["_rabbitmq", "_flat_mq", "", "*"] {
            let scoped = MqBindingInfo { namespace: Some(binding_ns.to_string()), ..binding.clone() };
            let params = binding_params(&scoped, "orders").expect("binding params");
            assert_eq!(
                params.get("virtual_host").and_then(|v| v.as_str()),
                Some("orders"),
                "binding namespace {binding_ns:?} must fall back to the argument"
            );
        }
    }

    #[test]
    fn binding_params_rejects_all_vhosts_context_without_a_concrete_vhost() {
        let binding = MqBindingInfo {
            source: "dbx-events".to_string(),
            destination: "dbx-queue".to_string(),
            destination_type: "queue".to_string(),
            routing_key: None,
            arguments: None,
            namespace: None,
        };

        let err = binding_params(&binding, "*").expect_err("all-vhosts bind must fail");
        assert_eq!(err, "operation requires a specific virtual host (all-vhosts context)");

        // A concrete vhost on the binding rescues an all-vhosts argument:
        // the row picked from an all-vhosts listing carries its own vhost.
        let scoped = MqBindingInfo { namespace: Some("orders".to_string()), ..binding };
        let params = binding_params(&scoped, "*").expect("binding namespace wins over the marker");
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("orders"));
        assert!(params.get("all_vhosts").is_none());
    }

    #[test]
    fn list_helpers_keep_all_vhosts_listing_for_star() {
        // List methods never go through require_specific_vhost; the '*' marker
        // still maps to a cross-vhost listing for them.
        let params = with_virtual_host(serde_json::json!({}), "*");
        assert_eq!(params.get("all_vhosts").and_then(|v| v.as_bool()), Some(true));
        assert!(params.get("virtual_host").is_none());
    }

    #[test]
    fn namespace_virtual_host_ignores_synthetic_and_empty_namespaces() {
        assert_eq!(namespace_virtual_host(""), None);
        assert_eq!(namespace_virtual_host("_flat_mq"), None);
        assert_eq!(namespace_virtual_host("_rabbitmq"), None);
        assert_eq!(namespace_virtual_host("*"), None);
        assert_eq!(namespace_virtual_host("orders"), Some("orders"));
    }

    #[test]
    fn with_virtual_host_adds_param_only_for_real_vhosts() {
        let params = with_virtual_host(serde_json::json!({ "name": "q1" }), "orders");
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("orders"));

        for ns in ["", "_flat_mq", "_rabbitmq"] {
            let params = with_virtual_host(serde_json::json!({ "name": "q1" }), ns);
            assert!(params.get("virtual_host").is_none(), "namespace {ns:?} must not set virtual_host");
        }
    }

    #[test]
    fn with_virtual_host_maps_star_to_all_vhosts() {
        let params = with_virtual_host(serde_json::json!({ "name": "q1" }), "*");
        assert_eq!(params.get("all_vhosts").and_then(|v| v.as_bool()), Some(true));
        assert!(params.get("virtual_host").is_none(), "all-vhosts listing must not scope to a vhost");
    }

    #[test]
    fn map_item_namespace_moves_vhost_into_namespace_field() {
        let item = map_item_namespace(serde_json::json!({ "name": "dbx-q", "vhost": "orders" }));
        assert_eq!(item.get("namespace").and_then(|v| v.as_str()), Some("orders"));

        // Entries without a vhost stay untouched (single-vhost listings).
        let plain = map_item_namespace(serde_json::json!({ "name": "dbx-q" }));
        assert!(plain.get("namespace").is_none());

        // The typed structs pick the mapped vhost up as `namespace`.
        let exchange: MqExchangeInfo = serde_json::from_value(map_item_namespace(
            serde_json::json!({ "name": "dbx-ex", "type": "direct", "vhost": "orders" }),
        ))
        .expect("exchange entry");
        assert_eq!(exchange.namespace.as_deref(), Some("orders"));

        let channel: MqChannelInfo =
            serde_json::from_value(map_item_namespace(serde_json::json!({ "name": "ch (1)" }))).expect("channel entry");
        assert!(channel.namespace.is_none());
    }

    #[test]
    fn consumer_maps_agent_fields() {
        let consumer = serde_json::json!({
            "name": "consumer-1@host",
            "tag": "ctag1.0",
            "active": true,
            "ackRequired": true,
            "prefetch": 20
        });

        let info = consumer_from_json(&consumer);

        assert_eq!(info.consumer_name, "consumer-1@host");
        assert_eq!(info.available_permits, 20);
        assert_eq!(info.msg_rate_out, 0.0);

        let without_prefetch = consumer_from_json(&serde_json::json!({ "tag": "ctag2.0" }));
        assert_eq!(without_prefetch.consumer_name, "ctag2.0");
        assert_eq!(without_prefetch.available_permits, 0);
    }

    #[test]
    fn subscription_uses_consumer_tag_as_name() {
        let consumer = serde_json::json!({
            "name": "consumer-1@host",
            "tag": "ctag1.0",
            "active": true,
            "ackRequired": false,
            "prefetch": 5
        });

        let sub = subscription_from_consumer_json(&consumer);

        assert_eq!(sub.name, "ctag1.0");
        assert_eq!(sub.sub_type, "consumer");
        assert_eq!(sub.consumers.len(), 1);
        assert_eq!(sub.consumers[0].consumer_name, "consumer-1@host");
        assert_eq!(sub.consumers[0].available_permits, 5);
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn capabilities_enable_policies_and_cluster_monitoring() {
        assert!(RABBITMQ_CAPABILITIES.supports_policies);
        assert!(RABBITMQ_CAPABILITIES.supports_cluster_monitoring);
    }

    #[test]
    fn policy_entries_parse_from_agent_payload() {
        let payload = serde_json::json!({
            "policies": [
                {
                    "name": "dbx-ttl",
                    "vhost": "orders",
                    "pattern": "^dbx-",
                    "applyTo": "queues",
                    "priority": 5,
                    "definition": { "message-ttl": 60000 }
                },
                {
                    "name": "dbx-ha",
                    "vhost": "/",
                    "pattern": ".*",
                    "applyTo": "all",
                    "priority": 0,
                    "definition": { "ha-mode": "all" }
                }
            ]
        });

        let policies: Vec<MqPolicyInfo> = payload
            .get("policies")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|p| serde_json::from_value(p).expect("policy entry"))
            .collect();

        assert_eq!(policies.len(), 2);
        assert_eq!(policies[0].name, "dbx-ttl");
        assert_eq!(policies[0].vhost, "orders");
        assert_eq!(policies[0].apply_to, "queues");
        assert_eq!(policies[0].priority, 5);
        assert_eq!(policies[0].definition.get("message-ttl").and_then(|v| v.as_i64()), Some(60000));
        assert_eq!(policies[1].definition.get("ha-mode").and_then(|v| v.as_str()), Some("all"));
    }

    #[test]
    fn policy_params_match_agent_contract_and_attach_vhost() {
        let mut definition = std::collections::HashMap::new();
        definition.insert("message-ttl".to_string(), serde_json::json!(60000));
        let policy = MqPolicyInfo {
            name: "dbx-ttl".to_string(),
            vhost: String::new(),
            pattern: "^dbx-".to_string(),
            apply_to: "queues".to_string(),
            priority: 5,
            definition,
        };

        let params = policy_params(&policy, "orders").expect("policy params");
        assert_eq!(params.get("name").and_then(|v| v.as_str()), Some("dbx-ttl"));
        assert_eq!(params.get("pattern").and_then(|v| v.as_str()), Some("^dbx-"));
        assert_eq!(params.get("applyTo").and_then(|v| v.as_str()), Some("queues"));
        assert_eq!(params.get("priority").and_then(|v| v.as_i64()), Some(5));
        assert_eq!(params.pointer("/definition/message-ttl").and_then(|v| v.as_i64()), Some(60000));
        assert_eq!(params.get("virtual_host").and_then(|v| v.as_str()), Some("orders"));
        // The vhost carried on the policy itself is not forwarded; the
        // namespace argument scopes the write.
        assert!(params.get("vhost").is_none());
    }

    #[test]
    fn policy_params_omit_empty_apply_to_so_agent_default_applies() {
        let policy = MqPolicyInfo { name: "dbx-ha".to_string(), pattern: ".*".to_string(), ..MqPolicyInfo::default() };

        let params = policy_params(&policy, "_rabbitmq").expect("policy params");
        assert!(params.get("applyTo").is_none());
        assert_eq!(params.get("priority").and_then(|v| v.as_i64()), Some(0));
        // Synthetic namespaces do not scope to a vhost; the agent falls back
        // to the connection's configured virtual host.
        assert!(params.get("virtual_host").is_none());
    }

    #[test]
    fn policy_params_reject_all_vhosts_context() {
        let policy =
            MqPolicyInfo { name: "dbx-ttl".to_string(), pattern: "^dbx-".to_string(), ..MqPolicyInfo::default() };

        let err = policy_params(&policy, "*").expect_err("all-vhosts policy write must fail");
        assert_eq!(err, "operation requires a specific virtual host (all-vhosts context)");
    }

    #[test]
    fn node_entries_parse_from_agent_payload() {
        let payload = serde_json::json!({
            "nodes": [
                {
                    "name": "rabbit@node1",
                    "running": true,
                    "memUsed": 536870912i64,
                    "memLimit": 1717986918i64,
                    "diskFree": 10737418240i64,
                    "fdUsed": 42,
                    "fdTotal": 1024,
                    "socketsUsed": 10,
                    "socketsTotal": 900,
                    "uptimeMs": 86400000i64
                },
                { "name": "rabbit@node2", "running": false }
            ]
        });

        let nodes: Vec<MqNodeInfo> = payload
            .get("nodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|n| serde_json::from_value(n).expect("node entry"))
            .collect();

        assert_eq!(nodes.len(), 2);
        assert!(nodes[0].running);
        assert_eq!(nodes[0].mem_used, Some(536870912));
        assert_eq!(nodes[0].fd_total, Some(1024));
        assert_eq!(nodes[0].uptime_ms, Some(86400000));
        assert!(!nodes[1].running);
        assert!(nodes[1].mem_used.is_none());
        assert!(nodes[1].uptime_ms.is_none());
    }

    #[test]
    fn overview_payload_parses_with_partial_fields() {
        let overview: MqOverviewInfo = serde_json::from_value(serde_json::json!({
            "messagesReady": 7,
            "publishRate": 3.5,
            "totalQueues": 2
        }))
        .expect("overview payload");

        assert_eq!(overview.messages_ready, Some(7));
        assert_eq!(overview.publish_rate, Some(3.5));
        assert_eq!(overview.total_queues, Some(2));
        assert!(overview.messages_unacked.is_none());
        assert!(overview.total_consumers.is_none());
    }
}
