//! Apache RocketMQ admin adapter. Communicates with a Java agent process
//! (`RocketMqAgent.java`) via JSON-RPC over stdin/stdout. The Java agent uses
//! `DefaultMQAdminExt` for admin operations and `DefaultMQProducer` for
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

/// RocketMQ capabilities - no tenants/namespaces; supports topics, consumer groups,
/// ACLs, and message production.
const ROCKETMQ_CAPABILITIES: MqCapabilities = MqCapabilities {
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
    supports_retention: false,
    supports_permissions: true,
    supports_geo_replication: false,
    supports_token_management: false,
    supports_raw_admin_api: false,
    supports_send_message: true,
    supports_message_query: true,
    supports_dlq: true,
    supports_message_trace: true,
    supports_exchanges: false,
    supports_client_connections: false,
    supports_user_permissions: false,
    supports_policies: false,
    supports_cluster_monitoring: false,
};

const TOPIC_LIST_PAGE_SIZE: u32 = 200;

pub struct RocketMqAdmin {
    client: Arc<Mutex<AgentDriverClient>>,
    config: MqAdminConfig,
}

impl RocketMqAdmin {
    /// Spawn the RocketMQ Java agent, perform handshake, and connect.
    pub async fn new(cfg: MqAdminConfig, launch: AgentLaunchSpec) -> Result<Self, String> {
        let mut client = AgentDriverClient::spawn(launch).await?;

        // Handshake
        let _: serde_json::Value = client.call("handshake", serde_json::json!({})).await?;

        // Build the connection params from MqAdminConfig
        let conn_params = build_connection_params(&cfg);
        let connect_params = serde_json::json!({ "connection": conn_params });
        let _: serde_json::Value = client.call("connect", connect_params).await?;

        log::info!("RocketMQ admin connected via agent (namesrv: {})", namesrv_addr(&cfg));

        Ok(Self { client: Arc::new(Mutex::new(client)), config: cfg })
    }

    /// Send a JSON-RPC call to the RocketMQ agent and deserialize the result.
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
impl MessageQueueAdmin for RocketMqAdmin {
    fn capabilities(&self) -> MqCapabilities {
        ROCKETMQ_CAPABILITIES
    }

    fn system_kind(&self) -> MqSystemKind {
        MqSystemKind::RocketMq
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
        let mut caps = ROCKETMQ_CAPABILITIES;
        if !acl_enabled {
            caps.supports_permissions = false;
        }

        Ok(MqClusterInfo {
            system_kind: MqSystemKind::RocketMq,
            server_version: None,
            resolved_profile: "rocketmq-agent".to_string(),
            version_detection: "agent".to_string(),
            capabilities: caps,
            extra: serde_json::json!({
                "clusterId": cluster_id,
                "brokers": brokers,
            }),
        })
    }

    // ---- Tenants (not supported by RocketMQ) ----

    async fn list_tenants(&self) -> Result<Vec<TenantInfo>, String> {
        Ok(Vec::new())
    }

    async fn get_tenant(&self, _name: &str) -> Result<TenantInfo, String> {
        Err("RocketMQ does not support tenants".to_string())
    }

    async fn create_tenant(&self, _name: &str, _cfg: TenantConfig) -> Result<(), String> {
        Err("RocketMQ does not support tenants".to_string())
    }

    async fn update_tenant(&self, _name: &str, _cfg: TenantConfig) -> Result<(), String> {
        Err("RocketMQ does not support tenants".to_string())
    }

    async fn delete_tenant(&self, _name: &str, _force: bool) -> Result<(), String> {
        Err("RocketMQ does not support tenants".to_string())
    }

    // ---- Namespaces (not supported by RocketMQ) ----

    async fn list_namespaces(&self, _tenant: &str) -> Result<Vec<NamespaceInfo>, String> {
        Ok(Vec::new())
    }

    async fn create_namespace(&self, _ns: &NamespaceRef, _cfg: NamespaceConfig) -> Result<(), String> {
        Err("RocketMQ does not support namespaces".to_string())
    }

    async fn delete_namespace(&self, _ns: &NamespaceRef, _force: bool) -> Result<(), String> {
        Err("RocketMQ does not support namespaces".to_string())
    }

    async fn get_namespace_policies(&self, _ns: &NamespaceRef) -> Result<serde_json::Value, String> {
        Err("RocketMQ does not support namespaces".to_string())
    }

    // ---- Topics ----

    async fn list_topics(&self, _ns: &NamespaceRef, _opts: ListTopicsOpts) -> Result<Vec<TopicInfo>, String> {
        let mut all = Vec::new();
        let mut offset: u32 = 0;

        loop {
            let result: serde_json::Value = self
                .call(
                    "mq_list_topics",
                    serde_json::json!({
                        "keyword": "",
                        "limit": TOPIC_LIST_PAGE_SIZE,
                        "offset": offset,
                    }),
                )
                .await?;

            let topics = result.get("topics").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let page_len = topics.len();
            for topic in topics {
                all.push(topic_info_from_agent_value(&topic));
            }

            let total = result.get("total").and_then(|v| v.as_u64()).unwrap_or(offset as u64 + page_len as u64);
            let fetch_next = topic_list_should_fetch_next(offset, page_len, total);
            offset = offset.saturating_add(page_len as u32);
            if !fetch_next {
                break;
            }
        }

        Ok(all)
    }

    async fn create_topic(&self, topic: &TopicRef, partitions: Option<u32>) -> Result<(), String> {
        let mut params = rocketmq_topic_admin_params(topic, partitions);
        params["replicationFactor"] = serde_json::json!(1);
        if let Some(message_type) = topic.message_type.as_deref().filter(|value| !value.is_empty()) {
            params["messageType"] = serde_json::json!(message_type);
        }
        self.call_ok("mq_create_topic", params).await
    }

    async fn delete_topic(&self, topic: &TopicRef, _force: bool) -> Result<(), String> {
        let mut params = serde_json::json!({ "name": topic.topic });
        if let Some(broker_name) = topic.broker_name.as_deref().filter(|value| !value.is_empty()) {
            params["brokerName"] = serde_json::json!(broker_name);
        }
        self.call_ok("mq_delete_topic", params).await
    }

    async fn update_partitions(&self, topic: &TopicRef, partitions: u32) -> Result<(), String> {
        let mut params = serde_json::json!({
            "name": topic.topic,
            "totalPartitions": partitions,
            "readQueueNums": topic.read_queue_nums.unwrap_or(partitions),
            "writeQueueNums": topic.write_queue_nums.unwrap_or(partitions),
        });
        if let Some(broker_name) = topic.broker_name.as_deref().filter(|value| !value.is_empty()) {
            params["brokerName"] = serde_json::json!(broker_name);
        }
        self.call_ok("mq_update_partitions", params).await
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
        self.call("mq_get_topic_config", rocketmq_topic_name_params(topic)).await
    }

    async fn get_topic_route(&self, topic: &TopicRef) -> Result<serde_json::Value, String> {
        self.call("mq_get_topic_route", rocketmq_topic_name_params(topic)).await
    }

    async fn alter_topic_config(&self, topic: &TopicRef, configs: serde_json::Value) -> Result<(), String> {
        let mut params = rocketmq_topic_name_params(topic);
        params["configs"] = configs;
        self.call_ok("mq_alter_topic_config", params).await
    }

    async fn skip_topic_accumulation(&self, topic: &TopicRef) -> Result<serde_json::Value, String> {
        self.call("mq_skip_topic_accumulation", serde_json::json!({ "topic": topic.topic })).await
    }

    async fn view_message(&self, topic: &TopicRef, msg_id: &str) -> Result<serde_json::Value, String> {
        self.call("mq_view_message", serde_json::json!({ "topic": topic.topic, "msgId": msg_id })).await
    }

    async fn query_messages_by_key(
        &self,
        topic: &TopicRef,
        key: &str,
        begin: i64,
        end: i64,
        max_num: u32,
    ) -> Result<serde_json::Value, String> {
        self.call(
            "mq_query_message_by_key",
            serde_json::json!({
                "topic": topic.topic,
                "key": key,
                "begin": begin,
                "end": end,
                "maxNum": max_num,
            }),
        )
        .await
    }

    async fn query_messages_by_topic(
        &self,
        topic: &TopicRef,
        begin: i64,
        end: i64,
        max_num: u32,
    ) -> Result<serde_json::Value, String> {
        self.call(
            "mq_query_message_by_topic",
            serde_json::json!({
                "topic": topic.topic,
                "begin": begin,
                "end": end,
                "maxNum": max_num,
            }),
        )
        .await
    }

    async fn query_message_trace(&self, msg_id: &str, trace_topic: Option<&str>) -> Result<serde_json::Value, String> {
        let mut params = serde_json::json!({ "msgId": msg_id });
        if let Some(topic) = trace_topic.filter(|value| !value.is_empty()) {
            params["traceTopic"] = serde_json::json!(topic);
        }
        self.call("mq_query_message_trace", params).await
    }

    // ---- Subscriptions (mapped to consumer groups) ----

    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<SubscriptionInfo>, String> {
        if topic.topic.is_empty() {
            let result: serde_json::Value = self
                .call(
                    "mq_list_consumer_groups",
                    serde_json::json!({
                        "limit": 500,
                        "offset": 0,
                        "enrich": true,
                    }),
                )
                .await?;
            let groups = result.get("groups").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            return Ok(groups.iter().map(rocketmq_subscription_from_group).collect());
        }

        // Agent uses queryTopicConsumeByWho (Dashboard queryTopicConsumerInfo); include all
        // returned groups even when consumers are offline and offsets are zero.
        let result: serde_json::Value = self
            .call(
                "mq_list_consumer_groups",
                serde_json::json!({
                    "topic": topic.topic,
                    "limit": 200,
                    "offset": 0,
                    "enrich": true,
                }),
            )
            .await?;
        let groups = result.get("groups").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        let mut subs = Vec::new();
        for group in groups {
            let group_id = group.get("groupId").and_then(|v| v.as_str()).unwrap_or_default();
            if group_id.is_empty() {
                continue;
            }
            let mut sub = rocketmq_subscription_from_group(&group);
            if let Ok(lag) = self
                .call::<serde_json::Value>(
                    "mq_get_consumer_lag",
                    serde_json::json!({
                        "groupId": group_id,
                        "topic": topic.topic,
                    }),
                )
                .await
            {
                sub.msg_backlog = lag.get("totalLag").and_then(|v| v.as_i64()).unwrap_or(0);
            }
            subs.push(sub);
        }
        Ok(subs)
    }

    async fn create_subscription(&self, _topic: &TopicRef, _sub: &str, _pos: ResetPosition) -> Result<(), String> {
        Err("RocketMQ consumer groups are created automatically when consumers join".to_string())
    }

    async fn delete_subscription(&self, _topic: &TopicRef, sub: &str, _force: bool) -> Result<(), String> {
        self.call_ok("mq_delete_consumer_group", serde_json::json!({ "groupId": sub })).await
    }

    async fn skip_messages(&self, _topic: &TopicRef, _sub: &str, _count: SkipCount) -> Result<(), String> {
        Err("RocketMQ does not support skipping messages directly".to_string())
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
        let mut params = serde_json::json!({
            "topic": topic.topic,
            "count": count,
            "connection": conn_params,
        });
        // Omit partition/offset so the agent defaults to all partitions + earliest.
        // Do not coerce missing values to 0 ? that forced PARTITION 0 OFFSET 0 UX.
        if let Some(partition) = options.partition {
            params["partition"] = serde_json::json!(partition);
        }
        if let Some(offset) = options.offset {
            params["offset"] = serde_json::json!(offset);
        }
        let result: serde_json::Value = self.call("mq_peek_messages", params).await?;

        let messages = result.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(messages.into_iter().enumerate().map(|(idx, m)| peeked_message_from_agent_json(idx, &m)).collect())
    }

    async fn expire_messages(&self, _topic: &TopicRef, _sub: &str, _expire_seconds: i64) -> Result<(), String> {
        Err("RocketMQ does not support expiring messages on a subscription".to_string())
    }

    async fn get_consumer_group_config(&self, group_id: &str) -> Result<serde_json::Value, String> {
        self.call("mq_get_subscription_group_config", serde_json::json!({ "groupId": group_id })).await
    }

    async fn alter_consumer_group_config(&self, group_id: &str, config: serde_json::Value) -> Result<(), String> {
        let mut params = config.as_object().cloned().unwrap_or_default();
        params.insert("groupId".to_string(), serde_json::json!(group_id));
        self.call_ok("mq_alter_subscription_group_config", serde_json::Value::Object(params)).await
    }

    // ---- Producers / consumers ----

    async fn list_producers(&self, topic: &TopicRef) -> Result<Vec<ProducerInfo>, String> {
        let result: serde_json::Value =
            self.call("mq_list_producers", serde_json::json!({ "topic": topic.topic })).await?;
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
        Err("RocketMQ does not support unloading topics".to_string())
    }

    // ---- Rate limits / quotas / retention ----

    async fn set_publish_rate(&self, _scope: &PolicyScope, _rate: PublishRate) -> Result<(), String> {
        Err("RocketMQ does not support publish rate limits via AdminClient".to_string())
    }

    async fn set_dispatch_rate(&self, _scope: &PolicyScope, _rate: DispatchRate) -> Result<(), String> {
        Err("RocketMQ does not support dispatch rate limits via AdminClient".to_string())
    }

    async fn set_subscribe_rate(&self, _scope: &PolicyScope, _rate: SubscribeRate) -> Result<(), String> {
        Err("RocketMQ does not support subscribe rate limits via AdminClient".to_string())
    }

    async fn set_backlog_quota(&self, _scope: &PolicyScope, _quota: BacklogQuota) -> Result<(), String> {
        Err("RocketMQ does not support backlog quotas via AdminClient".to_string())
    }

    async fn set_retention(&self, scope: &PolicyScope, retention: RetentionPolicy) -> Result<(), String> {
        let topic_name = match scope {
            PolicyScope::Topic { topic, .. } => topic.clone(),
            PolicyScope::Namespace { .. } => return Err("RocketMQ retention can only be set on topics".to_string()),
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
            PolicyScope::Namespace { .. } => return Err("RocketMQ does not support namespace policies".to_string()),
        };
        self.call("mq_get_topic_config", serde_json::json!({ "name": topic_name })).await
    }

    // ---- Permissions (mapped to RocketMQ ACLs) ----

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
        let group_id = sub.ok_or("Consumer group name (subscription) is required for RocketMQ backlog")?;
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
                            broker_name: node.get("brokerName").and_then(|v| v.as_str()).map(String::from),
                            role: node.get("role").and_then(|v| v.as_str()).map(String::from),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ClusterInfo { cluster_id, broker_count, controller_id, controller_host, brokers, raw: result })
    }

    // ---- Raw request (not supported for RocketMQ) ----

    async fn raw_request(&self, _req: MqRawRequest) -> Result<MqRawResponse, String> {
        Err("RocketMQ does not have a REST admin API; raw requests are not supported".to_string())
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

fn topic_info_from_agent_value(t: &serde_json::Value) -> TopicInfo {
    let name = t.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let partitions = t.get("partitions").and_then(|v| v.as_u64()).map(|v| v as u32);
    TopicInfo {
        name: name.clone(),
        short_name: name,
        partitioned: partitions.map(|p| p > 1).unwrap_or(false),
        partitions,
        persistent: true,
        internal: t.get("internal").and_then(|v| v.as_bool()).unwrap_or(false),
        message_type: t.get("messageType").and_then(|v| v.as_str()).map(String::from),
        namespace: None,
    }
}

/// Whether another Agent topic list page should be requested after consuming `page_len` rows.
fn topic_list_should_fetch_next(offset: u32, page_len: usize, total: u64) -> bool {
    page_len > 0 && u64::from(offset) + (page_len as u64) < total
}

#[cfg(test)]
fn topic_infos_from_agent_pages(pages: &[serde_json::Value]) -> Vec<TopicInfo> {
    let mut all = Vec::new();
    let mut offset: u32 = 0;
    for page in pages {
        let topics = page.get("topics").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let page_len = topics.len();
        for topic in topics {
            all.push(topic_info_from_agent_value(&topic));
        }
        let total = page.get("total").and_then(|v| v.as_u64()).unwrap_or(offset as u64 + page_len as u64);
        offset = offset.saturating_add(page_len as u32);
        if page_len == 0 || offset as u64 >= total {
            break;
        }
    }
    all
}

/// Extract RocketMQ NameServer address from MqAdminConfig.extra.
fn namesrv_addr(cfg: &MqAdminConfig) -> String {
    extra_str(&cfg.extra, "namesrvAddr").or_else(|| extra_str(&cfg.extra, "namesrv_addr")).unwrap_or("").to_string()
}

fn extra_str<'a>(extra: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    extra.get(key).and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty())
}

fn rocketmq_topic_name_params(topic: &TopicRef) -> serde_json::Value {
    let mut params = serde_json::json!({ "name": topic.topic });
    if let Some(broker_name) = topic.broker_name.as_deref().filter(|value| !value.is_empty()) {
        params["brokerName"] = serde_json::json!(broker_name);
    }
    params
}

fn rocketmq_topic_admin_params(topic: &TopicRef, partitions: Option<u32>) -> serde_json::Value {
    let read_queues = topic.read_queue_nums.or(partitions).unwrap_or(8);
    let write_queues = topic.write_queue_nums.unwrap_or(read_queues);
    let mut params = serde_json::json!({
        "name": topic.topic,
        "partitions": read_queues,
        "readQueueNums": read_queues,
        "writeQueueNums": write_queues,
    });
    if let Some(perm) = topic.perm {
        params["perm"] = serde_json::json!(perm);
    }
    if let Some(broker_name) = topic.broker_name.as_deref().filter(|value| !value.is_empty()) {
        params["brokerName"] = serde_json::json!(broker_name);
    }
    params
}

/// Build the connection params JSON from MqAdminConfig for the Java agent.
fn build_connection_params(cfg: &MqAdminConfig) -> serde_json::Value {
    let extra = &cfg.extra;
    let access_key = extra_str(extra, "accessKey")
        .or_else(|| extra_str(extra, "access_key"))
        .or(match &cfg.auth {
            MqAuth::Basic { username, .. } => Some(username.as_str()),
            _ => None,
        })
        .unwrap_or("");
    let secret_key = extra_str(extra, "secretKey")
        .or_else(|| extra_str(extra, "secret_key"))
        .or(match &cfg.auth {
            MqAuth::Basic { password, .. } => Some(password.as_str()),
            _ => None,
        })
        .unwrap_or("");

    serde_json::json!({
        "namesrv_addr": namesrv_addr(cfg),
        "cluster_name": extra_str(extra, "clusterName")
            .or_else(|| extra_str(extra, "cluster_name"))
            .unwrap_or(""),
        "broker_addr": extra_str(extra, "brokerAddr")
            .or_else(|| extra_str(extra, "broker_addr"))
            .unwrap_or(""),
        "access_key": access_key,
        "secret_key": secret_key,
        "tls_skip_verify": cfg.tls_skip_verify,
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
        ResetPosition::MessageId { .. } => {
            Err("RocketMQ does not support cursor reset by Pulsar message id".to_string())
        }
    }
}

#[cfg(test)]
fn rocketmq_subscription_for_topic(
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
        topics: Vec::new(),
        online_members: None,
        consumer_group_type: None,
        message_model: None,
    })
}

fn rocketmq_subscription_from_group(group: &serde_json::Value) -> SubscriptionInfo {
    let group_id = group.get("groupId").and_then(|v| v.as_str()).unwrap_or_default();
    let group_type = group.get("groupType").and_then(|v| v.as_str()).unwrap_or("NORMAL").to_string();
    let message_model = group.get("messageModel").and_then(|v| v.as_str()).map(String::from);
    let online_members = group.get("memberCount").and_then(|v| v.as_u64()).map(|v| v as u32);
    let topics = group
        .get("topics")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
        .unwrap_or_default();
    SubscriptionInfo {
        name: group_id.to_string(),
        sub_type: group_type.clone(),
        msg_backlog: 0,
        msg_rate_out: 0.0,
        msg_throughput_out: 0.0,
        consumers: Vec::new(),
        topics,
        online_members,
        consumer_group_type: Some(group_type),
        message_model,
    }
}

fn peeked_message_from_agent_json(idx: usize, message: &serde_json::Value) -> PeekedMessage {
    let mut properties = HashMap::new();
    if let Some(partition) = message.get("partition").and_then(|v| v.as_i64()) {
        properties.insert("partition".to_string(), partition.to_string());
    }
    // RocketMQ MsgId lives in messageId; queue offset is a separate field used by DLQ/topic peek UIs.
    if let Some(offset) = message.get("offset").and_then(|v| v.as_i64()) {
        properties.insert("offset".to_string(), offset.to_string());
    }
    if let Some(tag) = message.get("tag").and_then(|v| v.as_str()) {
        if !tag.is_empty() {
            properties.insert("tag".to_string(), tag.to_string());
        }
    }
    PeekedMessage {
        position: (idx + 1) as u32,
        message_id: message.get("messageId").and_then(|v| v.as_str()).map(String::from),
        key: message.get("key").and_then(|v| v.as_str()).map(String::from),
        publish_time: message.get("timestamp").and_then(|v| v.as_i64()).map(|v| v.to_string()),
        event_time: None,
        properties,
        headers: message
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default(),
        payload_base64: message.get("payloadBase64").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        payload_text: message.get("payloadText").and_then(|v| v.as_str()).map(String::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mq::auth::MqAuth;
    use crate::mq::types::MqSystemKind;

    fn rocketmq_config(extra: serde_json::Value, auth: MqAuth) -> MqAdminConfig {
        MqAdminConfig {
            system_kind: MqSystemKind::RocketMq,
            admin_url: String::new(),
            auth,
            tls_skip_verify: false,
            pinned_version: None,
            token_signing: None,
            connect_override: None,
            extra,
        }
    }

    #[test]
    fn connection_params_map_namesrv_and_acl_credentials() {
        let cfg = rocketmq_config(
            serde_json::json!({
                "namesrvAddr": "127.0.0.1:9876",
                "clusterName": "DefaultCluster"
            }),
            MqAuth::Basic { username: "rocket".to_string(), password: "secret".to_string() },
        );

        let params = build_connection_params(&cfg);

        assert_eq!(params.get("namesrv_addr").and_then(|v| v.as_str()), Some("127.0.0.1:9876"));
        assert_eq!(params.get("cluster_name").and_then(|v| v.as_str()), Some("DefaultCluster"));
        assert_eq!(params.get("access_key").and_then(|v| v.as_str()), Some("rocket"));
        assert_eq!(params.get("secret_key").and_then(|v| v.as_str()), Some("secret"));
    }

    #[test]
    fn reset_cursor_params_preserve_timestamp_position() {
        let topic = TopicRef {
            tenant: "_flat_mq".to_string(),
            namespace: "_flat_mq".to_string(),
            topic: "events".to_string(),
            persistent: true,
            partitioned: None,
            message_type: None,
            ..TopicRef::default()
        };

        let params = reset_cursor_params(&topic, "group-a", ResetPosition::Timestamp { timestamp_ms: 1710000000000 })
            .expect("timestamp reset should be supported");

        assert_eq!(params.get("groupId").and_then(|v| v.as_str()), Some("group-a"));
        assert_eq!(params.get("position").and_then(|v| v.as_str()), Some("timestamp"));
    }

    #[test]
    fn rocketmq_subscription_for_topic_includes_offline_group_with_committed_offsets() {
        let desc = serde_json::json!({ "groupId": "orders-service", "members": [] });
        let lag = serde_json::json!({
            "totalLag": 7,
            "partitions": [{ "partition": 0, "currentOffset": 3, "endOffset": 10, "lag": 7 }]
        });

        let sub = rocketmq_subscription_for_topic("orders-service", "orders", &desc, Some(&lag))
            .expect("committed offsets should make an inactive group visible");

        assert_eq!(sub.name, "orders-service");
        assert_eq!(sub.msg_backlog, 7);
    }

    #[test]
    fn rocketmq_subscription_from_group_maps_offline_topic_consumer() {
        let group = serde_json::json!({
            "groupId": "cs-pt-test-group",
            "groupType": "NORMAL",
            "messageModel": "CLUSTERING",
            "memberCount": 0,
            "topics": ["CS-PT"]
        });

        let sub = rocketmq_subscription_from_group(&group);

        assert_eq!(sub.name, "cs-pt-test-group");
        assert_eq!(sub.sub_type, "NORMAL");
        assert_eq!(sub.consumer_group_type.as_deref(), Some("NORMAL"));
        assert_eq!(sub.message_model.as_deref(), Some("CLUSTERING"));
        assert_eq!(sub.online_members, Some(0));
    }

    #[test]
    fn topic_list_should_fetch_next_when_more_rows_remain() {
        assert!(!topic_list_should_fetch_next(200, 0, 201));
        assert!(topic_list_should_fetch_next(0, 200, 201));
        assert!(!topic_list_should_fetch_next(0, 200, 200));
        assert!(topic_list_should_fetch_next(200, 1, 450));
        assert!(!topic_list_should_fetch_next(400, 50, 450));
    }

    #[test]
    fn topic_infos_from_agent_pages_merges_200_201_and_multi_page_totals() {
        let page1: Vec<serde_json::Value> =
            (0..200).map(|i| serde_json::json!({ "name": format!("topic-{i}"), "partitions": 4 })).collect();
        let page2_201 = serde_json::json!({ "name": "topic-200", "partitions": 4 });
        let response_201_first = serde_json::json!({ "topics": page1, "total": 201, "offset": 0, "limit": 200 });
        let response_201_second =
            serde_json::json!({ "topics": [page2_201], "total": 201, "offset": 200, "limit": 200 });
        let merged_201 = topic_infos_from_agent_pages(&[response_201_first, response_201_second]);
        assert_eq!(merged_201.len(), 201);
        assert_eq!(merged_201.last().map(|t| t.name.as_str()), Some("topic-200"));

        let page_a: Vec<serde_json::Value> =
            (0..200).map(|i| serde_json::json!({ "name": format!("p-{i}"), "partitions": 1 })).collect();
        let page_b: Vec<serde_json::Value> =
            (200..400).map(|i| serde_json::json!({ "name": format!("p-{i}"), "partitions": 1 })).collect();
        let page_c: Vec<serde_json::Value> =
            (400..450).map(|i| serde_json::json!({ "name": format!("p-{i}"), "partitions": 1 })).collect();
        let merged_450 = topic_infos_from_agent_pages(&[
            serde_json::json!({ "topics": page_a, "total": 450 }),
            serde_json::json!({ "topics": page_b, "total": 450 }),
            serde_json::json!({ "topics": page_c, "total": 450 }),
        ]);
        assert_eq!(merged_450.len(), 450);
        assert_eq!(merged_450.first().map(|t| t.name.as_str()), Some("p-0"));
        assert_eq!(merged_450.last().map(|t| t.name.as_str()), Some("p-449"));
    }

    #[test]
    fn peeked_message_from_agent_json_maps_msg_id_tag_and_offset() {
        let message = serde_json::json!({
            "messageId": "0BC16699165C03B925DB8A404E2D****",
            "partition": 2,
            "offset": 15,
            "timestamp": 1710000000000_i64,
            "key": "order-1",
            "tag": "cs-pt-dlq-test",
            "headers": { "TAGS": "cs-pt-dlq-test" },
            "payloadBase64": "",
            "payloadText": "dlq message"
        });

        let peeked = peeked_message_from_agent_json(0, &message);

        assert_eq!(peeked.message_id.as_deref(), Some("0BC16699165C03B925DB8A404E2D****"));
        assert_eq!(peeked.key.as_deref(), Some("order-1"));
        assert_eq!(peeked.properties.get("partition").map(String::as_str), Some("2"));
        assert_eq!(peeked.properties.get("offset").map(String::as_str), Some("15"));
        assert_eq!(peeked.properties.get("tag").map(String::as_str), Some("cs-pt-dlq-test"));
        assert_eq!(peeked.publish_time.as_deref(), Some("1710000000000"));
    }
}
