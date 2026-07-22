//! Service-layer functions for message queue admin operations. These `*_core`
//! functions are shared by both the desktop command layer
//! (`src-tauri/src/commands/mq_cmd.rs`) and the web route layer
//! (`crates/dbx-web/src/routes/mq.rs`), keeping the business logic unified.
//!
//! Mirrors the pattern used by `agent_kv::*_core`.

use crate::connection::AppState;
use crate::db::agent_driver::AgentLaunchSpec;
use crate::mq::config::MqAdminConfig;
use crate::mq::token::sign_pulsar_token;
use crate::mq::types::*;
use chrono::{TimeZone, Utc};
use uuid::Uuid;

const MAX_PEEK_MESSAGES: u32 = 100;

/// Test connectivity to the message queue admin endpoint. Successful MQ
/// adapters are cached so agent-backed systems do not cold-start on every
/// repeated test. Failed builds are not cached by the registry.
pub async fn mq_test_connection_core(state: &AppState, conn_id: &str) -> Result<MqClusterInfo, String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    let mqc = state.mq_admin_config_for_connection(conn_id, &cfg).await?;
    let agent_launch = resolve_mq_agent_launch_spec(&mqc, state);
    let adapter = match state.mq_registry.get_or_build_config(conn_id, mqc, agent_launch).await {
        Ok(adapter) => adapter,
        Err(err) => {
            state.mq_registry.drop_connection(conn_id).await;
            return Err(err);
        }
    };
    match adapter.test_connection().await {
        Ok(info) => Ok(info),
        Err(err) => {
            state.mq_registry.drop_connection(conn_id).await;
            Err(err)
        }
    }
}

// ---- Tenants ----

pub async fn mq_list_tenants_core(state: &AppState, conn_id: &str) -> Result<Vec<TenantInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_tenants().await
}

pub async fn mq_get_tenant_core(state: &AppState, conn_id: &str, name: &str) -> Result<TenantInfo, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_tenant(name).await
}

pub async fn mq_create_tenant_core(
    state: &AppState,
    conn_id: &str,
    name: &str,
    cfg: TenantConfig,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create tenant").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.create_tenant(name, cfg).await
}

pub async fn mq_update_tenant_core(
    state: &AppState,
    conn_id: &str,
    name: &str,
    cfg: TenantConfig,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update tenant").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.update_tenant(name, cfg).await
}

pub async fn mq_delete_tenant_core(state: &AppState, conn_id: &str, name: &str, force: bool) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete tenant").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_tenant(name, force).await
}

// ---- Namespaces ----

pub async fn mq_list_namespaces_core(
    state: &AppState,
    conn_id: &str,
    tenant: &str,
) -> Result<Vec<NamespaceInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_namespaces(tenant).await
}

pub async fn mq_create_namespace_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    cfg: NamespaceConfig,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create namespace").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.create_namespace(&ns, cfg).await
}

pub async fn mq_delete_namespace_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    force: bool,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete namespace").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_namespace(&ns, force).await
}

pub async fn mq_get_namespace_policies_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_namespace_policies(&ns).await
}

// ---- Topics ----

pub async fn mq_list_topics_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    opts: ListTopicsOpts,
) -> Result<Vec<TopicInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_topics(&ns, opts).await
}

pub async fn mq_create_topic_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    partitions: Option<u32>,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create topic").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.create_topic(&topic, partitions).await
}

pub async fn mq_delete_topic_core(state: &AppState, conn_id: &str, topic: TopicRef, force: bool) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete topic").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_topic(&topic, force).await
}

pub async fn mq_update_partitions_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    partitions: u32,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Update partitions").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.update_partitions(&topic, partitions).await
}

pub async fn mq_get_topic_stats_core(state: &AppState, conn_id: &str, topic: TopicRef) -> Result<TopicStats, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_topic_stats(&topic).await
}

pub async fn mq_get_topic_internal_stats_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_topic_internal_stats(&topic).await
}

// ---- Exchanges / bindings (RabbitMQ) ----

pub async fn mq_list_exchanges_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
) -> Result<Vec<MqExchangeInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_exchanges(&ns).await
}

pub async fn mq_create_exchange_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    name: &str,
    exchange_type: &str,
    durable: bool,
    auto_delete: bool,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create exchange").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.create_exchange(&ns, name, exchange_type, durable, auto_delete).await
}

pub async fn mq_delete_exchange_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    name: &str,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete exchange").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_exchange(&ns, name).await
}

pub async fn mq_list_bindings_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    exchange: Option<String>,
    queue: Option<String>,
) -> Result<Vec<MqBindingInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_bindings(&ns, exchange.as_deref(), queue.as_deref()).await
}

pub async fn mq_bind_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    binding: MqBindingInfo,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create binding").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.bind_queue(&ns, &binding).await
}

pub async fn mq_unbind_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    binding: MqBindingInfo,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete binding").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.unbind_queue(&ns, &binding).await
}

// ---- Client connections / channels (RabbitMQ) ----

pub async fn mq_list_client_connections_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
) -> Result<Vec<MqClientConnectionInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_client_connections(&ns).await
}

pub async fn mq_list_client_channels_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    connection: Option<String>,
) -> Result<Vec<MqChannelInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_client_channels(&ns, connection).await
}

pub async fn mq_close_client_connection_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    name: &str,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Close client connection").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.close_client_connection(&ns, name).await
}

// ---- Users & virtual-host permissions (RabbitMQ) ----

pub async fn mq_list_users_core(state: &AppState, conn_id: &str) -> Result<Vec<MqUserInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_users().await
}

pub async fn mq_create_user_core(
    state: &AppState,
    conn_id: &str,
    name: &str,
    password: &str,
    tags: Vec<String>,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create user").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.create_user(name, password, tags).await
}

pub async fn mq_delete_user_core(state: &AppState, conn_id: &str, name: &str) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete user").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_user(name).await
}

pub async fn mq_list_user_permissions_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
) -> Result<Vec<MqVhostPermission>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_user_permissions(&ns).await
}

pub async fn mq_grant_user_permission_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    user: &str,
    configure: &str,
    write: &str,
    read: &str,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Grant user permission").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.grant_user_permission(&ns, user, configure, write, read).await
}

pub async fn mq_revoke_user_permission_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    user: &str,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Revoke user permission").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.revoke_user_permission(&ns, user).await
}

// ---- Policies (RabbitMQ) ----

pub async fn mq_list_policies_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
) -> Result<Vec<MqPolicyInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_policies(&ns).await
}

pub async fn mq_set_policy_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    policy: MqPolicyInfo,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Set policy").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.set_policy(&ns, &policy).await
}

pub async fn mq_delete_policy_core(
    state: &AppState,
    conn_id: &str,
    ns: NamespaceRef,
    name: &str,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete policy").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_policy(&ns, name).await
}

// ---- Cluster monitoring (RabbitMQ) ----

pub async fn mq_get_overview_core(state: &AppState, conn_id: &str) -> Result<MqOverviewInfo, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_overview().await
}

pub async fn mq_list_nodes_core(state: &AppState, conn_id: &str) -> Result<Vec<MqNodeInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_nodes().await
}

// ---- Subscriptions ----

pub async fn mq_list_subscriptions_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
) -> Result<Vec<SubscriptionInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_subscriptions(&topic).await
}

pub async fn mq_create_subscription_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
    pos: ResetPosition,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Create subscription").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.create_subscription(&topic, &sub, pos).await
}

pub async fn mq_delete_subscription_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
    force: bool,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Delete subscription").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.delete_subscription(&topic, &sub, force).await
}

pub async fn mq_skip_messages_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
    count: SkipCount,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Skip messages").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.skip_messages(&topic, &sub, count).await
}

pub async fn mq_reset_cursor_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
    pos: ResetPosition,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Reset cursor").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.reset_cursor(&topic, &sub, pos).await
}

pub async fn mq_clear_backlog_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Clear backlog").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.clear_backlog(&topic, &sub).await
}

pub async fn mq_get_consumer_group_config_core(
    state: &AppState,
    conn_id: &str,
    group_id: String,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_consumer_group_config(&group_id).await
}

pub async fn mq_alter_consumer_group_config_core(
    state: &AppState,
    conn_id: &str,
    group_id: String,
    config: serde_json::Value,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Alter consumer group config").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.alter_consumer_group_config(&group_id, config).await
}

pub async fn mq_peek_messages_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
    count: u32,
    options: Option<PeekMessagesOptions>,
) -> Result<Vec<PeekedMessage>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if count > MAX_PEEK_MESSAGES {
        return Err(format!("Peek message count must be between 1 and {MAX_PEEK_MESSAGES}"));
    }
    let adapter = get_adapter(state, conn_id).await?;
    adapter.peek_messages(&topic, &sub, count, options.unwrap_or_default()).await
}

pub async fn mq_expire_messages_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
    expire_seconds: i64,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Expire messages").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.expire_messages(&topic, &sub, expire_seconds).await
}

// ---- Producers / consumers ----

pub async fn mq_list_producers_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
) -> Result<Vec<ProducerInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_producers(&topic).await
}

pub async fn mq_list_consumers_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: String,
) -> Result<Vec<ConsumerInfo>, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_consumers(&topic, &sub).await
}

pub async fn mq_unload_topic_core(state: &AppState, conn_id: &str, topic: TopicRef) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Unload topic").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.unload_topic(&topic).await
}

// ---- Rate limits / quotas / retention ----

pub async fn mq_set_publish_rate_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    rate: PublishRate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Set publish rate").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.set_publish_rate(&scope, rate).await
}

pub async fn mq_set_dispatch_rate_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    rate: DispatchRate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Set dispatch rate").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.set_dispatch_rate(&scope, rate).await
}

pub async fn mq_set_subscribe_rate_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    rate: SubscribeRate,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Set subscribe rate").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.set_subscribe_rate(&scope, rate).await
}

pub async fn mq_set_backlog_quota_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    quota: BacklogQuota,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Set backlog quota").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.set_backlog_quota(&scope, quota).await
}

pub async fn mq_set_retention_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    retention: RetentionPolicy,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Set retention").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.set_retention(&scope, retention).await
}

pub async fn mq_get_effective_policies_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_effective_policies(&scope).await
}

// ---- Permissions ----

pub async fn mq_grant_permission_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    role: String,
    actions: Vec<AuthAction>,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Grant permission").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.grant_permission(&scope, &role, actions).await
}

pub async fn mq_revoke_permission_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
    role: String,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Revoke permission").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.revoke_permission(&scope, &role).await
}

pub async fn mq_list_permissions_core(
    state: &AppState,
    conn_id: &str,
    scope: PolicyScope,
) -> Result<PermissionMap, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.list_permissions(&scope).await
}

// ---- Client tokens ----

pub async fn mq_issue_token_core(
    state: &AppState,
    conn_id: &str,
    req: MqTokenIssueRequest,
) -> Result<MqIssuedToken, String> {
    ensure_connection_writable(state, conn_id, "Issue MQ token").await?;
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    let mqc = MqAdminConfig::from_connection(&cfg)?;
    let signing_config = mqc
        .token_signing
        .as_ref()
        .filter(|config| config.is_configured())
        .ok_or("Token signing is not configured for this MQ connection. Edit the connection and configure Broker Token signing with an HS256 secret or RS256 private key.")?;

    let now = Utc::now();
    let signed = sign_pulsar_token(signing_config, &req, now.timestamp())?;
    let expires_at =
        signed.expires_at_unix.and_then(|value| Utc.timestamp_opt(value, 0).single()).map(|value| value.to_rfc3339());
    let record = MqTokenRecord {
        id: Uuid::new_v4().to_string(),
        connection_id: conn_id.to_string(),
        subject: req.subject.trim().to_string(),
        algorithm: signing_config.algorithm,
        token_fingerprint: signed.fingerprint,
        scope: req.scope.clone(),
        actions: req.actions.clone(),
        expires_at,
        created_at: now.to_rfc3339(),
        note: req.note.as_deref().unwrap_or_default().trim().to_string(),
    };

    state.storage.save_mq_token_record(&record).await?;
    Ok(MqIssuedToken { token: signed.token, record })
}

pub async fn mq_list_token_records_core(
    state: &AppState,
    conn_id: &str,
    subject: Option<String>,
) -> Result<Vec<MqTokenRecord>, String> {
    if !state.configs.read().await.contains_key(conn_id) {
        return Err("Connection not found".to_string());
    }
    let subject = subject.as_deref().map(str::trim).filter(|value| !value.is_empty());
    state.storage.load_mq_token_records(conn_id, subject).await
}

// ---- Monitoring ----

pub async fn mq_get_backlog_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    sub: Option<String>,
) -> Result<BacklogStats, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_backlog(&topic, sub.as_deref()).await
}

pub async fn mq_get_cluster_info_core(state: &AppState, conn_id: &str) -> Result<ClusterInfo, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_cluster_info().await
}

pub async fn mq_get_topic_route_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.get_topic_route(&topic).await
}

pub async fn mq_alter_topic_config_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    configs: serde_json::Value,
) -> Result<(), String> {
    ensure_connection_writable(state, conn_id, "Alter topic config").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.alter_topic_config(&topic, configs).await
}

pub async fn mq_skip_topic_accumulation_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
) -> Result<serde_json::Value, String> {
    ensure_connection_writable(state, conn_id, "Skip topic accumulation").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.skip_topic_accumulation(&topic).await
}

pub async fn mq_view_message_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    msg_id: String,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.view_message(&topic, &msg_id).await
}

pub async fn mq_query_messages_by_key_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    key: String,
    begin: i64,
    end: i64,
    max_num: u32,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.query_messages_by_key(&topic, &key, begin, end, max_num).await
}

pub async fn mq_query_messages_by_topic_core(
    state: &AppState,
    conn_id: &str,
    topic: TopicRef,
    begin: i64,
    end: i64,
    max_num: u32,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.query_messages_by_topic(&topic, begin, end, max_num).await
}

pub async fn mq_query_message_trace_core(
    state: &AppState,
    conn_id: &str,
    msg_id: String,
    trace_topic: Option<String>,
) -> Result<serde_json::Value, String> {
    let adapter = get_adapter(state, conn_id).await?;
    adapter.query_message_trace(&msg_id, trace_topic.as_deref()).await
}

// ---- Raw request (escape hatch) ----

pub async fn mq_raw_request_core(state: &AppState, conn_id: &str, req: MqRawRequest) -> Result<MqRawResponse, String> {
    if req.is_mutating() {
        ensure_connection_writable(state, conn_id, "MQ admin write").await?;
    }
    let adapter = get_adapter(state, conn_id).await?;
    adapter.raw_request(req).await
}

// ---- Message production ----

/// Produce a message to a topic through the MQ adapter.
pub async fn mq_send_message_core(
    state: &AppState,
    conn_id: &str,
    req: SendMessageRequest,
) -> Result<SendMessageResponse, String> {
    ensure_connection_writable(state, conn_id, "Send message").await?;
    let adapter = get_adapter(state, conn_id).await?;
    adapter.send_message(req).await
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async fn get_adapter(
    state: &AppState,
    conn_id: &str,
) -> Result<std::sync::Arc<dyn crate::mq::port::MessageQueueAdmin>, String> {
    let cfg = state.configs.read().await.get(conn_id).cloned().ok_or("Connection not found")?;
    let mqc = state.mq_admin_config_for_connection(conn_id, &cfg).await?;
    let agent_launch = resolve_mq_agent_launch_spec(&mqc, state);
    state.mq_registry.get_or_build_config(conn_id, mqc, agent_launch).await
}

/// Resolve the MQ agent launch spec for agent-backed systems (Kafka, RocketMQ, RabbitMQ).
/// Returns `None` for native REST systems so the registry skips agent resolution.
pub fn resolve_mq_agent_launch_spec(mqc: &MqAdminConfig, state: &AppState) -> Option<AgentLaunchSpec> {
    let agent_key = match mqc.system_kind {
        MqSystemKind::Kafka => "kafka",
        MqSystemKind::RocketMq => "rocketmq",
        MqSystemKind::RabbitMq => "rabbitmq",
        _ => return None,
    };
    let agent_state = state.agent_manager.load_state();
    let jre_key = agent_state
        .installed_drivers
        .get(agent_key)
        .map(|driver| driver.jre.as_str())
        .unwrap_or(crate::agent_manager::DEFAULT_JRE_KEY);
    match state.agent_manager.resolve_agent_launch_spec(&agent_state, agent_key, jre_key) {
        Ok(launch) => Some(launch),
        Err(err) => {
            log::warn!("Failed to resolve {agent_key} agent launch spec: {err}");
            None
        }
    }
}

#[deprecated(note = "use resolve_mq_agent_launch_spec")]
pub fn resolve_kafka_launch_spec(mqc: &MqAdminConfig, state: &AppState) -> Option<AgentLaunchSpec> {
    resolve_mq_agent_launch_spec(mqc, state)
}

async fn ensure_connection_writable(state: &AppState, conn_id: &str, operation: &str) -> Result<(), String> {
    let configs = state.configs.read().await;
    if let Some(config) = configs.get(conn_id) {
        if config.read_only {
            return Err(format!(
                "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
                config.name, operation
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use crate::storage::Storage;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn mq_connection(read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: "readonly-mq".to_string(),
            name: "Read only MQ".to_string(),
            db_type: DatabaseType::MessageQueue,
            driver_profile: Some("pulsar".to_string()),
            driver_label: Some("Apache Pulsar".to_string()),
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8080,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
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
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({
                "systemKind": "pulsar",
                "adminUrl": "http://127.0.0.1:8080",
                "auth": { "kind": "none" }
            })),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        }
    }

    fn mq_connection_with_token_signing() -> ConnectionConfig {
        let mut config = mq_connection(false);
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "http://127.0.0.1:8080",
            "auth": { "kind": "none" },
            "tokenSigning": {
                "algorithm": "hs256",
                "key": "broker-signing-secret"
            }
        }));
        config
    }

    async fn test_state_with(config: ConnectionConfig) -> (AppState, std::path::PathBuf) {
        let stamp =
            SystemTime::now().duration_since(UNIX_EPOCH).expect("system time should be after UNIX epoch").as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx-mq-service-test-{stamp}"));
        std::fs::create_dir_all(&dir).expect("failed to create test directory");
        let storage = Storage::open(&dir.join("storage.db")).await.expect("failed to open test storage");
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        state.configs.write().await.insert(config.id.clone(), config);
        (state, dir)
    }

    #[tokio::test]
    async fn mutating_service_calls_block_read_only_connections_before_adapter_build() {
        let (state, dir) = test_state_with(mq_connection(true)).await;
        let err = mq_create_topic_core(
            &state,
            "readonly-mq",
            TopicRef {
                tenant: "public".to_string(),
                namespace: "default".to_string(),
                topic: "orders".to_string(),
                persistent: true,
                partitioned: None,
                message_type: None,
                ..TopicRef::default()
            },
            None,
        )
        .await
        .expect_err("read-only write should fail");

        assert!(err.contains("Read-only mode"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mutating_exchange_calls_block_read_only_connections_before_adapter_build() {
        let (state, dir) = test_state_with(mq_connection(true)).await;
        let ns = NamespaceRef { tenant: "_rabbitmq".to_string(), namespace: "_rabbitmq".to_string() };

        let err = mq_create_exchange_core(&state, "readonly-mq", ns, "dbx-events", "topic", true, false)
            .await
            .expect_err("read-only exchange create should fail");

        assert!(err.contains("Read-only mode"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mutating_raw_requests_block_read_only_connections_before_adapter_build() {
        let (state, dir) = test_state_with(mq_connection(true)).await;
        let err = mq_raw_request_core(
            &state,
            "readonly-mq",
            MqRawRequest {
                method: "POST".to_string(),
                path: "/admin/v2/tenants".to_string(),
                query: None,
                body: Some(serde_json::json!({ "adminRoles": [] })),
            },
        )
        .await
        .expect_err("read-only raw write should fail");

        assert!(err.contains("Read-only mode"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mutating_user_permission_calls_block_read_only_connections_before_adapter_build() {
        let (state, dir) = test_state_with(mq_connection(true)).await;
        let ns = NamespaceRef { tenant: "_rabbitmq".to_string(), namespace: "orders".to_string() };

        let err = mq_create_user_core(&state, "readonly-mq", "dbx-app", "secret", vec![])
            .await
            .expect_err("read-only user create should fail");
        assert!(err.contains("Read-only mode"));

        let err =
            mq_delete_user_core(&state, "readonly-mq", "dbx-app").await.expect_err("read-only user delete should fail");
        assert!(err.contains("Read-only mode"));

        let err = mq_grant_user_permission_core(&state, "readonly-mq", ns.clone(), "dbx-app", ".*", ".*", ".*")
            .await
            .expect_err("read-only permission grant should fail");
        assert!(err.contains("Read-only mode"));

        let err = mq_revoke_user_permission_core(&state, "readonly-mq", ns, "dbx-app")
            .await
            .expect_err("read-only permission revoke should fail");
        assert!(err.contains("Read-only mode"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mutating_policy_calls_block_read_only_connections_before_adapter_build() {
        let (state, dir) = test_state_with(mq_connection(true)).await;
        let ns = NamespaceRef { tenant: "_rabbitmq".to_string(), namespace: "orders".to_string() };
        let policy =
            MqPolicyInfo { name: "dbx-ttl".to_string(), pattern: "^dbx-".to_string(), ..MqPolicyInfo::default() };

        let err = mq_set_policy_core(&state, "readonly-mq", ns.clone(), policy)
            .await
            .expect_err("read-only policy set should fail");
        assert!(err.contains("Read-only mode"));

        let err = mq_delete_policy_core(&state, "readonly-mq", ns, "dbx-ttl")
            .await
            .expect_err("read-only policy delete should fail");
        assert!(err.contains("Read-only mode"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn peek_messages_rejects_counts_above_service_limit_before_adapter_call() {
        let (state, dir) = test_state_with(mq_connection(false)).await;
        let err = mq_peek_messages_core(
            &state,
            "readonly-mq",
            TopicRef {
                tenant: "public".to_string(),
                namespace: "default".to_string(),
                topic: "orders".to_string(),
                persistent: true,
                partitioned: None,
                message_type: None,
                ..TopicRef::default()
            },
            "sub-a".to_string(),
            101,
            None,
        )
        .await
        .expect_err("peek count above the service limit should fail");

        assert!(err.contains("between 1 and 100"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn issue_token_saves_record_without_plaintext() {
        let (state, dir) = test_state_with(mq_connection_with_token_signing()).await;

        let issued = mq_issue_token_core(
            &state,
            "readonly-mq",
            MqTokenIssueRequest {
                subject: "rt-erp-server".to_string(),
                expires_in_seconds: Some(3600),
                scope: None,
                actions: vec![AuthAction::Consume],
                note: Some("integration test".to_string()),
            },
        )
        .await
        .expect("token issuance should succeed");

        assert!(!issued.token.is_empty());
        assert_eq!(issued.record.subject, "rt-erp-server");
        let records = mq_list_token_records_core(&state, "readonly-mq", Some("rt-erp-server".to_string()))
            .await
            .expect("listing token records should succeed");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0], issued.record);
        let record_json = serde_json::to_value(&records[0]).expect("record should serialize to JSON");
        assert!(record_json.get("token").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
