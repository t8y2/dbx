//! Apache Kafka admin adapter. Communicates with a Java agent process
//! (`KafkaAgent.java`) via JSON-RPC over stdin/stdout. The Java agent uses
//! `kafka-clients` AdminClient for admin operations and KafkaProducer for
//! message production.
//!
//! This adapter follows the same pattern as the ZooKeeper/Etcd agents:
//! 1. Spawn a Java agent process via `AgentDriverClient`
//! 2. Perform JSON-RPC handshake + connect
//! 3. Delegate all `MessageQueueAdmin` trait methods to JSON-RPC calls

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
use crate::mq::auth::MqAuth;
use crate::mq::config::MqAdminConfig;
use crate::mq::port::MessageQueueAdmin;
use crate::mq::types::*;

/// Kafka capabilities — no tenants/namespaces, supports topics, consumer groups,
/// ACLs, retention, and message production.
const KAFKA_CAPABILITIES: MqCapabilities = MqCapabilities {
    supports_tenants: false,
    supports_namespaces: false,
    supports_partitioned_topics: true,
    supports_subscriptions: true,
    supports_create_subscription: false,
    supports_reset_cursor: true,
    supports_skip_messages: false,
    supports_clear_backlog: true,
    supports_peek_messages: true,
    supports_expire_messages: false,
    supports_rate_limits: false,
    supports_backlog_quota: false,
    supports_retention: true,
    supports_permissions: true,
    supports_geo_replication: false,
    supports_token_management: false,
    supports_raw_admin_api: false,
    supports_send_message: true,
};

pub struct KafkaAdmin {
    client: Arc<Mutex<AgentDriverClient>>,
    config: MqAdminConfig,
}

impl KafkaAdmin {
    /// Spawn the Kafka Java agent, perform handshake, and connect.
    pub async fn new(cfg: MqAdminConfig, launch: AgentLaunchSpec) -> Result<Self, String> {
        let mut client = AgentDriverClient::spawn(launch).await?;

        // Handshake
        let _: serde_json::Value = client.call("handshake", serde_json::json!({})).await?;

        // Build the connection params from MqAdminConfig
        let conn_params = build_connection_params(&cfg);
        let connect_params = serde_json::json!({ "connection": conn_params });
        let _: serde_json::Value = client.call("connect", connect_params).await?;

        log::info!("Kafka admin connected via agent (bootstrap servers: {})", bootstrap_servers(&cfg));

        Ok(Self { client: Arc::new(Mutex::new(client)), config: cfg })
    }

    /// Send a JSON-RPC call to the Kafka agent and deserialize the result.
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
impl MessageQueueAdmin for KafkaAdmin {
    fn capabilities(&self) -> MqCapabilities {
        KAFKA_CAPABILITIES
    }

    fn system_kind(&self) -> MqSystemKind {
        MqSystemKind::Kafka
    }

    async fn test_connection(&self) -> Result<MqClusterInfo, String> {
        let conn_params = build_connection_params(&self.config);
        let result: serde_json::Value =
            self.call("test_connection", serde_json::json!({ "connection": conn_params })).await?;

        let cluster_id = result.get("clusterId").and_then(|v| v.as_str()).map(String::from);
        let brokers = result.get("brokers").cloned().unwrap_or(serde_json::json!([]));

        // When the broker has no authorizer configured, disable permissions in the UI
        // so the frontend hides the tab instead of showing raw errors.
        let acl_enabled = result.get("aclEnabled").and_then(|v| v.as_bool()).unwrap_or(true);
        let mut caps = KAFKA_CAPABILITIES;
        if !acl_enabled {
            caps.supports_permissions = false;
        }

        Ok(MqClusterInfo {
            system_kind: MqSystemKind::Kafka,
            server_version: None,
            resolved_profile: "kafka-agent".to_string(),
            version_detection: "agent".to_string(),
            capabilities: caps,
            extra: serde_json::json!({
                "clusterId": cluster_id,
                "brokers": brokers,
            }),
        })
    }

    // ---- Tenants (not supported by Kafka) ----

    async fn list_tenants(&self) -> Result<Vec<TenantInfo>, String> {
        Ok(Vec::new())
    }

    async fn get_tenant(&self, _name: &str) -> Result<TenantInfo, String> {
        Err("Kafka does not support tenants".to_string())
    }

    async fn create_tenant(&self, _name: &str, _cfg: TenantConfig) -> Result<(), String> {
        Err("Kafka does not support tenants".to_string())
    }

    async fn update_tenant(&self, _name: &str, _cfg: TenantConfig) -> Result<(), String> {
        Err("Kafka does not support tenants".to_string())
    }

    async fn delete_tenant(&self, _name: &str, _force: bool) -> Result<(), String> {
        Err("Kafka does not support tenants".to_string())
    }

    // ---- Namespaces (not supported by Kafka) ----

    async fn list_namespaces(&self, _tenant: &str) -> Result<Vec<NamespaceInfo>, String> {
        Ok(Vec::new())
    }

    async fn create_namespace(&self, _ns: &NamespaceRef, _cfg: NamespaceConfig) -> Result<(), String> {
        Err("Kafka does not support namespaces".to_string())
    }

    async fn delete_namespace(&self, _ns: &NamespaceRef, _force: bool) -> Result<(), String> {
        Err("Kafka does not support namespaces".to_string())
    }

    async fn get_namespace_policies(&self, _ns: &NamespaceRef) -> Result<serde_json::Value, String> {
        Err("Kafka does not support namespaces".to_string())
    }

    // ---- Topics ----

    async fn list_topics(&self, _ns: &NamespaceRef, _opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String> {
        let result: serde_json::Value = self.call("mq_list_topics", serde_json::json!({})).await?;
        let topics = result.get("topics").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        Ok(topics
            .into_iter()
            .map(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let partitions = t.get("partitions").and_then(|v| v.as_u64()).map(|v| v as u32);
                TopicInfo {
                    name: name.clone(),
                    short_name: name,
                    partitioned: partitions.map(|p| p > 1).unwrap_or(false),
                    partitions,
                    persistent: true,
                }
            })
            .collect())
    }

    async fn create_topic(&self, topic: &TopicRef, partitions: Option<u32>) -> Result<(), String> {
        let params = serde_json::json!({
            "name": topic.topic,
            "partitions": partitions.unwrap_or(1),
            "replicationFactor": 1,
        });
        self.call_ok("mq_create_topic", params).await
    }

    async fn delete_topic(&self, topic: &TopicRef, _force: bool) -> Result<(), String> {
        self.call_ok("mq_delete_topic", serde_json::json!({ "name": topic.topic })).await
    }

    async fn update_partitions(&self, topic: &TopicRef, partitions: u32) -> Result<(), String> {
        self.call_ok(
            "mq_update_partitions",
            serde_json::json!({
                "name": topic.topic,
                "totalPartitions": partitions,
            }),
        )
        .await
    }

    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<TopicStats, String> {
        let result: serde_json::Value =
            self.call("mq_get_topic_stats", serde_json::json!({ "name": topic.topic })).await?;

        let total_messages = result.get("totalMessages").and_then(|v| v.as_i64()).unwrap_or(0);
        let _partitions = result.get("partitions").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

        Ok(TopicStats {
            msg_rate_in: 0.0,
            msg_rate_out: 0.0,
            msg_throughput_in: 0.0,
            msg_throughput_out: 0.0,
            storage_size: 0,
            backlog_size: 0,
            msg_in_counter: total_messages,
            msg_out_counter: 0,
            subscription_count: 0,
            producer_count: 0,
            raw: result,
        })
    }

    async fn get_topic_internal_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, String> {
        self.call("mq_get_topic_config", serde_json::json!({ "name": topic.topic })).await
    }

    // ---- Subscriptions (mapped to consumer groups) ----

    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<SubscriptionInfo>, String> {
        // List consumer groups and filter those subscribed to this topic
        let result: serde_json::Value = self.call("mq_list_consumer_groups", serde_json::json!({})).await?;
        let groups = result.get("groups").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        // For each group, check both active assignments and committed offsets.
        let mut subs = Vec::new();
        for group in groups {
            let group_id = group.get("groupId").and_then(|v| v.as_str()).unwrap_or_default();
            let desc = match self
                .call::<serde_json::Value>("mq_describe_consumer_group", serde_json::json!({ "groupId": group_id }))
                .await
            {
                Ok(desc) => desc,
                Err(_) => continue, // Skip groups we can't describe
            };
            let lag = self
                .call::<serde_json::Value>(
                    "mq_get_consumer_lag",
                    serde_json::json!({
                        "groupId": group_id,
                        "topic": topic.topic,
                    }),
                )
                .await
                .ok();
            if let Some(sub) = kafka_subscription_for_topic(group_id, &topic.topic, &desc, lag.as_ref()) {
                subs.push(sub);
            }
        }
        Ok(subs)
    }

    async fn create_subscription(&self, _topic: &TopicRef, _sub: &str, _pos: ResetPosition) -> Result<(), String> {
        Err("Kafka consumer groups are created automatically when consumers join".to_string())
    }

    async fn delete_subscription(&self, _topic: &TopicRef, sub: &str, _force: bool) -> Result<(), String> {
        self.call_ok("mq_delete_consumer_group", serde_json::json!({ "groupId": sub })).await
    }

    async fn skip_messages(&self, _topic: &TopicRef, _sub: &str, _count: SkipCount) -> Result<(), String> {
        Err("Kafka does not support skipping messages directly".to_string())
    }

    async fn reset_cursor(&self, topic: &TopicRef, sub: &str, pos: ResetPosition) -> Result<(), String> {
        let params = reset_cursor_params(topic, sub, pos)?;
        self.call_ok("mq_reset_consumer_group_offsets", params).await
    }

    async fn clear_backlog(&self, topic: &TopicRef, sub: &str) -> Result<(), String> {
        // Clearing backlog = resetting offsets to latest
        self.call_ok(
            "mq_reset_consumer_group_offsets",
            serde_json::json!({
                "groupId": sub,
                "topic": topic.topic,
                "position": "latest",
            }),
        )
        .await
    }

    async fn peek_messages(
        &self,
        topic: &TopicRef,
        _sub: &str,
        count: u32,
        options: PeekMessagesOptions,
    ) -> Result<Vec<PeekedMessage>, String> {
        let conn_params = build_connection_params(&self.config);
        let result: serde_json::Value = self
            .call(
                "mq_peek_messages",
                serde_json::json!({
                    "topic": topic.topic,
                    "partition": options.partition.unwrap_or(0),
                    "offset": options.offset.unwrap_or(0),
                    "count": count,
                    "connection": conn_params,
                }),
            )
            .await?;

        let messages = result.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(messages
            .into_iter()
            .enumerate()
            .map(|(idx, m)| PeekedMessage {
                position: (idx + 1) as u32,
                message_id: m.get("offset").and_then(|v| v.as_i64()).map(|v| v.to_string()),
                key: m.get("key").and_then(|v| v.as_str()).map(String::from),
                publish_time: m.get("timestamp").and_then(|v| v.as_i64()).map(|v| v.to_string()),
                event_time: None,
                properties: HashMap::new(),
                headers: m
                    .get("headers")
                    .and_then(|v| v.as_object())
                    .map(|obj| {
                        obj.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect()
                    })
                    .unwrap_or_default(),
                payload_base64: m.get("payloadBase64").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                payload_text: m.get("payloadText").and_then(|v| v.as_str()).map(String::from),
            })
            .collect())
    }

    async fn expire_messages(&self, _topic: &TopicRef, _sub: &str, _expire_seconds: i64) -> Result<(), String> {
        Err("Kafka does not support expiring messages on a subscription".to_string())
    }

    // ---- Producers / consumers ----

    async fn list_producers(&self, topic: &TopicRef) -> Result<Vec<ProducerInfo>, String> {
        let result: serde_json::Value =
            match self.call("mq_list_producers", serde_json::json!({ "topic": topic.topic })).await {
                Ok(result) => result,
                Err(err) if is_describe_producers_unsupported(&err) => {
                    log::info!("Kafka broker does not support DESCRIBE_PRODUCERS; active producers are unavailable");
                    return Ok(Vec::new());
                }
                Err(err) => return Err(err),
            };
        let producers = result.get("producers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(producers
            .into_iter()
            .map(|p| ProducerInfo {
                producer_id: p.get("producerId").and_then(|v| v.as_i64()).unwrap_or(0),
                producer_name: p.get("producerName").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                msg_rate_in: p.get("msgRateIn").and_then(|v| v.as_f64()).unwrap_or(0.0),
                msg_throughput_in: p.get("msgThroughputIn").and_then(|v| v.as_f64()).unwrap_or(0.0),
                address: p.get("address").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                client_version: p.get("clientVersion").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            })
            .collect())
    }

    async fn list_consumers(&self, _topic: &TopicRef, sub: &str) -> Result<Vec<ConsumerInfo>, String> {
        let result: serde_json::Value =
            self.call("mq_describe_consumer_group", serde_json::json!({ "groupId": sub })).await?;

        let members = result.get("members").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(members
            .into_iter()
            .map(|m| ConsumerInfo {
                consumer_name: m.get("memberId").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                msg_rate_out: 0.0,
                msg_throughput_out: 0.0,
                available_permits: 0,
                address: m.get("host").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                client_version: String::new(),
            })
            .collect())
    }

    async fn unload_topic(&self, _topic: &TopicRef) -> Result<(), String> {
        Err("Kafka 不支持卸载主题".to_string())
    }

    // ---- Rate limits / quotas / retention ----

    async fn set_publish_rate(&self, _scope: &PolicyScope, _rate: PublishRate) -> Result<(), String> {
        Err("Kafka does not support publish rate limits via AdminClient".to_string())
    }

    async fn set_dispatch_rate(&self, _scope: &PolicyScope, _rate: DispatchRate) -> Result<(), String> {
        Err("Kafka does not support dispatch rate limits via AdminClient".to_string())
    }

    async fn set_subscribe_rate(&self, _scope: &PolicyScope, _rate: SubscribeRate) -> Result<(), String> {
        Err("Kafka does not support subscribe rate limits via AdminClient".to_string())
    }

    async fn set_backlog_quota(&self, _scope: &PolicyScope, _quota: BacklogQuota) -> Result<(), String> {
        Err("Kafka does not support backlog quotas via AdminClient".to_string())
    }

    async fn set_retention(&self, scope: &PolicyScope, retention: RetentionPolicy) -> Result<(), String> {
        let topic_name = match scope {
            PolicyScope::Topic { topic, .. } => topic.clone(),
            PolicyScope::Namespace { .. } => return Err("Kafka retention can only be set on topics".to_string()),
        };

        let retention_ms = if retention.retention_time_in_minutes < 0 {
            "-1".to_string()
        } else {
            (retention.retention_time_in_minutes as i64 * 60 * 1000).to_string()
        };

        let mut configs = vec![serde_json::json!({ "key": "retention.ms", "value": retention_ms })];
        if retention.retention_size_in_mb >= 0 {
            let retention_bytes = (retention.retention_size_in_mb as i64 * 1024 * 1024).to_string();
            configs.push(serde_json::json!({ "key": "retention.bytes", "value": retention_bytes }));
        }

        self.call_ok(
            "mq_alter_topic_config",
            serde_json::json!({
                "name": topic_name,
                "configs": configs,
            }),
        )
        .await
    }

    async fn get_effective_policies(&self, scope: &PolicyScope) -> Result<serde_json::Value, String> {
        let topic_name = match scope {
            PolicyScope::Topic { topic, .. } => topic.clone(),
            PolicyScope::Namespace { .. } => return Err("Kafka does not support namespace policies".to_string()),
        };
        self.call("mq_get_topic_config", serde_json::json!({ "name": topic_name })).await
    }

    // ---- Permissions (mapped to Kafka ACLs) ----

    async fn grant_permission(&self, scope: &PolicyScope, role: &str, actions: Vec<AuthAction>) -> Result<(), String> {
        let (resource_type, resource_name) = match scope {
            PolicyScope::Topic { topic, .. } => ("TOPIC", topic.clone()),
            PolicyScope::Namespace { .. } => ("TOPIC", "*".to_string()),
        };

        let acls: Vec<serde_json::Value> = actions
            .into_iter()
            .map(|action| {
                let operation = match action {
                    AuthAction::Produce => "WRITE",
                    AuthAction::Consume => "READ",
                    _ => "ALL",
                };
                serde_json::json!({
                    "resourceType": resource_type,
                    "resourceName": resource_name,
                    "patternType": "LITERAL",
                    "principal": format!("User:{}", role),
                    "host": "*",
                    "operation": operation,
                    "permissionType": "ALLOW",
                })
            })
            .collect();

        self.call_ok("mq_create_acls", serde_json::json!({ "acls": acls })).await
    }

    async fn revoke_permission(&self, scope: &PolicyScope, role: &str) -> Result<(), String> {
        let (resource_type, resource_name) = match scope {
            PolicyScope::Topic { topic, .. } => ("TOPIC", topic.clone()),
            PolicyScope::Namespace { .. } => ("TOPIC", "*".to_string()),
        };

        self.call_ok(
            "mq_delete_acls",
            serde_json::json!({
                "filters": [{
                    "resourceType": resource_type,
                    "resourceName": resource_name,
                    "principal": format!("User:{}", role),
                }]
            }),
        )
        .await
    }

    async fn list_permissions(&self, scope: &PolicyScope) -> Result<PermissionMap, String> {
        let (resource_type, resource_name) = match scope {
            PolicyScope::Topic { topic, .. } => ("TOPIC", topic.clone()),
            PolicyScope::Namespace { .. } => ("TOPIC", "*".to_string()),
        };

        let result: serde_json::Value = self
            .call(
                "mq_list_acls",
                serde_json::json!({
                    "resourceType": resource_type,
                    "resourceName": resource_name,
                }),
            )
            .await?;

        let acls = result.get("acls").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut permissions: PermissionMap = HashMap::new();

        for acl in acls {
            let principal = acl.get("principal").and_then(|v| v.as_str()).unwrap_or_default();
            let role = principal.strip_prefix("User:").unwrap_or(principal).to_string();
            let operation = acl.get("operation").and_then(|v| v.as_str()).unwrap_or_default();
            let action = match operation {
                "WRITE" => AuthAction::Produce,
                "READ" => AuthAction::Consume,
                _ => continue,
            };
            permissions.entry(role).or_default().push(action);
        }
        Ok(permissions)
    }

    // ---- Monitoring ----

    async fn get_backlog(&self, topic: &TopicRef, sub: Option<&str>) -> Result<BacklogStats, String> {
        let group_id = sub.ok_or("Consumer group name (subscription) is required for Kafka backlog")?;
        let result: serde_json::Value = self
            .call(
                "mq_get_consumer_lag",
                serde_json::json!({
                    "groupId": group_id,
                    "topic": topic.topic,
                }),
            )
            .await?;

        let total_lag = result.get("totalLag").and_then(|v| v.as_i64()).unwrap_or(0);
        Ok(BacklogStats { msg_backlog: total_lag, backlog_size: 0 })
    }

    async fn get_cluster_info(&self) -> Result<ClusterInfo, String> {
        let result: serde_json::Value = self.call("mq_describe_cluster", serde_json::json!({})).await?;

        let cluster_id = result.get("clusterId").and_then(|v| v.as_str()).map(String::from);
        let broker_count = result.get("nodeCount").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

        let controller = result.get("controller").filter(|v| !v.is_null());
        let controller_id = controller.and_then(|v| v.get("id")).and_then(|v| v.as_i64()).map(|v| v as i32);
        let controller_host = controller.and_then(|v| v.get("host")).and_then(|v| v.as_str()).map(|host| {
            let port = controller.and_then(|v| v.get("port")).and_then(|v| v.as_i64()).unwrap_or(0);
            format!("{}:{}", host, port)
        });

        let brokers = result
            .get("brokers")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|node| {
                        Some(BrokerNode {
                            id: node.get("id")?.as_i64()? as i32,
                            host: node.get("host")?.as_str()?.to_string(),
                            port: node.get("port")?.as_i64()? as i32,
                            rack: node.get("rack").and_then(|v| v.as_str()).map(String::from),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ClusterInfo { cluster_id, broker_count, controller_id, controller_host, brokers, raw: result })
    }

    // ---- Raw request (not supported for Kafka) ----

    async fn raw_request(&self, _req: MqRawRequest) -> Result<MqRawResponse, String> {
        Err("Kafka does not have a REST admin API; raw requests are not supported".to_string())
    }

    // ---- Message production ----

    async fn send_message(&self, req: SendMessageRequest) -> Result<SendMessageResponse, String> {
        let params = serde_json::json!({
            "topic": req.topic,
            "key": req.key,
            "payloadBase64": req.payload_base64,
            "headers": req.headers,
            "partition": req.partition,
        });
        let result: serde_json::Value = self.call("mq_send_message", params).await?;

        Ok(SendMessageResponse {
            topic: result.get("topic").and_then(|v| v.as_str()).unwrap_or(&req.topic).to_string(),
            partition: result.get("partition").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            offset: result.get("offset").and_then(|v| v.as_i64()).unwrap_or(0),
            timestamp: result.get("timestamp").and_then(|v| v.as_i64()).map(|v| v.to_string()),
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract Kafka bootstrap servers from MqAdminConfig.extra.
fn bootstrap_servers(cfg: &MqAdminConfig) -> String {
    cfg.extra.get("bootstrapServers").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn extra_str<'a>(extra: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    extra.get(key).and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty())
}

fn is_describe_producers_unsupported(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    (normalized.contains("unsupportedversionexception") && normalized.contains("describe_producers"))
        || normalized.contains("the node does not support describe_producers")
}

/// Build the connection params JSON from MqAdminConfig for the Java agent.
fn build_connection_params(cfg: &MqAdminConfig) -> serde_json::Value {
    let extra = &cfg.extra;
    let basic_auth = match &cfg.auth {
        MqAuth::Basic { username, password } => Some((username.as_str(), password.as_str())),
        _ => None,
    };
    let sasl_username =
        extra_str(extra, "saslUsername").or_else(|| basic_auth.map(|(username, _)| username)).unwrap_or("");
    let sasl_password =
        extra_str(extra, "saslPassword").or_else(|| basic_auth.map(|(_, password)| password)).unwrap_or("");
    let sasl_mechanism = extra_str(extra, "saslMechanism").unwrap_or(if basic_auth.is_some() { "PLAIN" } else { "" });
    let security_protocol = extra_str(extra, "securityProtocol").unwrap_or(if !sasl_mechanism.is_empty() {
        "SASL_PLAINTEXT"
    } else {
        "PLAINTEXT"
    });
    let properties =
        extra.get("properties").filter(|value| value.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));

    serde_json::json!({
        "bootstrap_servers": bootstrap_servers(cfg),
        "security_protocol": security_protocol,
        "sasl_mechanism": sasl_mechanism,
        "sasl_username": sasl_username,
        "sasl_password": sasl_password,
        "tls_skip_verify": cfg.tls_skip_verify,
        "tls": {
            "skip_verify": cfg.tls_skip_verify,
        },
        "properties": properties,
    })
}

fn reset_cursor_params(topic: &TopicRef, sub: &str, pos: ResetPosition) -> Result<serde_json::Value, String> {
    match pos {
        ResetPosition::Earliest => Ok(serde_json::json!({
            "groupId": sub,
            "topic": topic.topic,
            "position": "earliest",
        })),
        ResetPosition::Latest => Ok(serde_json::json!({
            "groupId": sub,
            "topic": topic.topic,
            "position": "latest",
        })),
        ResetPosition::Timestamp { timestamp_ms } => Ok(serde_json::json!({
            "groupId": sub,
            "topic": topic.topic,
            "position": "timestamp",
            "timestampMs": timestamp_ms,
        })),
        ResetPosition::MessageId { .. } => Err("Kafka does not support cursor reset by Pulsar message id".to_string()),
    }
}

fn kafka_subscription_for_topic(
    group_id: &str,
    topic: &str,
    desc: &serde_json::Value,
    lag: Option<&serde_json::Value>,
) -> Option<SubscriptionInfo> {
    let has_active_assignment = desc
        .get("members")
        .and_then(|v| v.as_array())
        .map(|members| {
            members.iter().any(|member| {
                member
                    .get("assignments")
                    .and_then(|v| v.as_array())
                    .map(|assignments| {
                        assignments.iter().any(|a| a.get("topic").and_then(|v| v.as_str()) == Some(topic))
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let has_committed_offsets = lag
        .and_then(|v| v.get("partitions"))
        .and_then(|v| v.as_array())
        .map(|partitions| !partitions.is_empty())
        .unwrap_or(false);

    if !has_active_assignment && !has_committed_offsets {
        return None;
    }

    Some(SubscriptionInfo {
        name: group_id.to_string(),
        sub_type: "consumer-group".to_string(),
        msg_backlog: lag.and_then(|v| v.get("totalLag")).and_then(|v| v.as_i64()).unwrap_or(0),
        msg_rate_out: 0.0,
        msg_throughput_out: 0.0,
        consumers: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mq::auth::MqAuth;
    use crate::mq::types::MqSystemKind;

    fn kafka_config(extra: serde_json::Value, auth: MqAuth, tls_skip_verify: bool) -> MqAdminConfig {
        MqAdminConfig {
            system_kind: MqSystemKind::Kafka,
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
    fn connection_params_map_basic_auth_to_kafka_sasl_without_plaintext_password_extra() {
        let cfg = kafka_config(
            serde_json::json!({
                "bootstrapServers": "localhost:9092"
            }),
            MqAuth::Basic { username: "alice".to_string(), password: "secret".to_string() },
            false,
        );

        let params = build_connection_params(&cfg);

        assert_eq!(params.get("bootstrap_servers").and_then(|v| v.as_str()), Some("localhost:9092"));
        assert_eq!(params.get("security_protocol").and_then(|v| v.as_str()), Some("SASL_PLAINTEXT"));
        assert_eq!(params.get("sasl_mechanism").and_then(|v| v.as_str()), Some("PLAIN"));
        assert_eq!(params.get("sasl_username").and_then(|v| v.as_str()), Some("alice"));
        assert_eq!(params.get("sasl_password").and_then(|v| v.as_str()), Some("secret"));
    }

    #[test]
    fn connection_params_preserve_kafka_security_extra_and_nested_tls() {
        let cfg = kafka_config(
            serde_json::json!({
                "bootstrapServers": "broker:9093",
                "securityProtocol": "SASL_SSL",
                "saslMechanism": "SCRAM-SHA-512",
                "properties": {
                    "client.id": "dbx"
                }
            }),
            MqAuth::Basic { username: "bob".to_string(), password: "pw".to_string() },
            true,
        );

        let params = build_connection_params(&cfg);

        assert_eq!(params.get("security_protocol").and_then(|v| v.as_str()), Some("SASL_SSL"));
        assert_eq!(params.get("sasl_mechanism").and_then(|v| v.as_str()), Some("SCRAM-SHA-512"));
        assert_eq!(params.pointer("/tls/skip_verify").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(params.pointer("/properties/client.id").and_then(|v| v.as_str()), Some("dbx"));
    }

    #[test]
    fn connection_params_preserve_kafka_gssapi_properties() {
        let cfg = kafka_config(
            serde_json::json!({
                "bootstrapServers": "broker:9093",
                "securityProtocol": "SASL_SSL",
                "saslMechanism": "GSSAPI",
                "properties": {
                    "sasl.jaas.config": "com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true keyTab=\"/tmp/user.keytab\" principal=\"user@EXAMPLE.COM\";",
                    "sasl.kerberos.service.name": "kafka",
                    "java.security.krb5.conf": "/tmp/krb5.conf"
                }
            }),
            MqAuth::None,
            false,
        );

        let params = build_connection_params(&cfg);

        assert_eq!(params.get("security_protocol").and_then(|v| v.as_str()), Some("SASL_SSL"));
        assert_eq!(params.get("sasl_mechanism").and_then(|v| v.as_str()), Some("GSSAPI"));
        assert_eq!(params.pointer("/properties/sasl.kerberos.service.name").and_then(|v| v.as_str()), Some("kafka"));
        assert_eq!(
            params.pointer("/properties/java.security.krb5.conf").and_then(|v| v.as_str()),
            Some("/tmp/krb5.conf")
        );
    }

    #[test]
    fn reset_cursor_params_preserve_timestamp_position() {
        let topic = TopicRef {
            tenant: "_kafka".to_string(),
            namespace: "_kafka".to_string(),
            topic: "events".to_string(),
            persistent: true,
            partitioned: None,
        };

        let params = reset_cursor_params(&topic, "group-a", ResetPosition::Timestamp { timestamp_ms: 1710000000000 })
            .expect("timestamp reset should be supported");

        assert_eq!(params.get("groupId").and_then(|v| v.as_str()), Some("group-a"));
        assert_eq!(params.get("topic").and_then(|v| v.as_str()), Some("events"));
        assert_eq!(params.get("position").and_then(|v| v.as_str()), Some("timestamp"));
        assert_eq!(params.get("timestampMs").and_then(|v| v.as_i64()), Some(1710000000000));
    }

    #[test]
    fn reset_cursor_params_reject_message_id_position() {
        let topic = TopicRef {
            tenant: "_kafka".to_string(),
            namespace: "_kafka".to_string(),
            topic: "events".to_string(),
            persistent: true,
            partitioned: None,
        };

        let err = reset_cursor_params(&topic, "group-a", ResetPosition::MessageId { ledger_id: 1, entry_id: 2 })
            .expect_err("Kafka should not accept Pulsar message ids");

        assert!(err.contains("message id"));
    }

    #[test]
    fn kafka_subscription_for_topic_includes_offline_group_with_committed_offsets() {
        let desc = serde_json::json!({
            "groupId": "orders-service",
            "members": []
        });
        let lag = serde_json::json!({
            "totalLag": 7,
            "partitions": [
                { "partition": 0, "currentOffset": 3, "endOffset": 10, "lag": 7 }
            ]
        });

        let sub = kafka_subscription_for_topic("orders-service", "orders", &desc, Some(&lag))
            .expect("committed offsets should make an inactive group visible");

        assert_eq!(sub.name, "orders-service");
        assert_eq!(sub.sub_type, "consumer-group");
        assert_eq!(sub.msg_backlog, 7);
    }

    #[test]
    fn kafka_subscription_for_topic_includes_active_assignment_without_committed_offsets() {
        let desc = serde_json::json!({
            "groupId": "live-service",
            "members": [{
                "assignments": [
                    { "topic": "events", "partition": 0 }
                ]
            }]
        });
        let lag = serde_json::json!({
            "totalLag": 0,
            "partitions": []
        });

        let sub = kafka_subscription_for_topic("live-service", "events", &desc, Some(&lag))
            .expect("active assignments should make the group visible");

        assert_eq!(sub.name, "live-service");
        assert_eq!(sub.msg_backlog, 0);
    }

    #[test]
    fn kafka_subscription_for_topic_ignores_unrelated_group() {
        let desc = serde_json::json!({
            "groupId": "billing-service",
            "members": [{
                "assignments": [
                    { "topic": "billing", "partition": 0 }
                ]
            }]
        });
        let lag = serde_json::json!({
            "totalLag": 0,
            "partitions": []
        });

        assert!(kafka_subscription_for_topic("billing-service", "orders", &desc, Some(&lag)).is_none());
    }
}
