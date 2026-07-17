//! Desktop (Tauri) commands for message queue admin operations.
//!
//! These are thin wrappers around `dbx_core::mq::service::*_core` functions,
//! with read-only protection (`ensure_connection_writable`) for mutating calls.

use std::sync::Arc;

use tauri::State;

use crate::commands::connection::{ensure_connection_writable, AppState};

// ---- Test connection ----

#[tauri::command]
pub async fn mq_test_connection(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::mq::MqClusterInfo, String> {
    dbx_core::mq::service::mq_test_connection_core(&state, &connection_id).await
}

// ---- Tenants ----

#[tauri::command]
pub async fn mq_list_tenants(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::mq::TenantInfo>, String> {
    dbx_core::mq::service::mq_list_tenants_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn mq_get_tenant(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
) -> Result<dbx_core::mq::TenantInfo, String> {
    dbx_core::mq::service::mq_get_tenant_core(&state, &connection_id, &name).await
}

#[tauri::command]
pub async fn mq_create_tenant(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
    config: dbx_core::mq::TenantConfig,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Create tenant").await?;
    dbx_core::mq::service::mq_create_tenant_core(&state, &connection_id, &name, config).await
}

#[tauri::command]
pub async fn mq_update_tenant(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
    config: dbx_core::mq::TenantConfig,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Update tenant").await?;
    dbx_core::mq::service::mq_update_tenant_core(&state, &connection_id, &name, config).await
}

#[tauri::command]
pub async fn mq_delete_tenant(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete tenant").await?;
    dbx_core::mq::service::mq_delete_tenant_core(&state, &connection_id, &name, force).await
}

// ---- Namespaces ----

#[tauri::command]
pub async fn mq_list_namespaces(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    tenant: String,
) -> Result<Vec<dbx_core::mq::NamespaceInfo>, String> {
    dbx_core::mq::service::mq_list_namespaces_core(&state, &connection_id, &tenant).await
}

#[tauri::command]
pub async fn mq_create_namespace(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    config: dbx_core::mq::NamespaceConfig,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Create namespace").await?;
    dbx_core::mq::service::mq_create_namespace_core(&state, &connection_id, ns, config).await
}

#[tauri::command]
pub async fn mq_delete_namespace(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    force: bool,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete namespace").await?;
    dbx_core::mq::service::mq_delete_namespace_core(&state, &connection_id, ns, force).await
}

#[tauri::command]
pub async fn mq_get_namespace_policies(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
) -> Result<serde_json::Value, String> {
    dbx_core::mq::service::mq_get_namespace_policies_core(&state, &connection_id, ns).await
}

// ---- Topics ----

#[tauri::command]
pub async fn mq_list_topics(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    opts: dbx_core::mq::ListTopicsOpts,
) -> Result<Vec<dbx_core::mq::TopicInfo>, String> {
    dbx_core::mq::service::mq_list_topics_core(&state, &connection_id, ns, opts).await
}

#[tauri::command]
pub async fn mq_create_topic(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    partitions: Option<u32>,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Create topic").await?;
    dbx_core::mq::service::mq_create_topic_core(&state, &connection_id, topic, partitions).await
}

#[tauri::command]
pub async fn mq_delete_topic(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    force: bool,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete topic").await?;
    dbx_core::mq::service::mq_delete_topic_core(&state, &connection_id, topic, force).await
}

#[tauri::command]
pub async fn mq_update_partitions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    partitions: u32,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Update partitions").await?;
    dbx_core::mq::service::mq_update_partitions_core(&state, &connection_id, topic, partitions).await
}

#[tauri::command]
pub async fn mq_get_topic_stats(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
) -> Result<dbx_core::mq::TopicStats, String> {
    dbx_core::mq::service::mq_get_topic_stats_core(&state, &connection_id, topic).await
}

#[tauri::command]
pub async fn mq_get_topic_internal_stats(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
) -> Result<serde_json::Value, String> {
    dbx_core::mq::service::mq_get_topic_internal_stats_core(&state, &connection_id, topic).await
}

// ---- Subscriptions ----

#[tauri::command]
pub async fn mq_list_subscriptions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
) -> Result<Vec<dbx_core::mq::SubscriptionInfo>, String> {
    dbx_core::mq::service::mq_list_subscriptions_core(&state, &connection_id, topic).await
}

#[tauri::command]
pub async fn mq_create_subscription(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    pos: dbx_core::mq::ResetPosition,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Create subscription").await?;
    dbx_core::mq::service::mq_create_subscription_core(&state, &connection_id, topic, sub, pos).await
}

#[tauri::command]
pub async fn mq_delete_subscription(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    force: bool,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Delete subscription").await?;
    dbx_core::mq::service::mq_delete_subscription_core(&state, &connection_id, topic, sub, force).await
}

#[tauri::command]
pub async fn mq_skip_messages(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    count: dbx_core::mq::SkipCount,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Skip messages").await?;
    dbx_core::mq::service::mq_skip_messages_core(&state, &connection_id, topic, sub, count).await
}

#[tauri::command]
pub async fn mq_reset_cursor(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    pos: dbx_core::mq::ResetPosition,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Reset cursor").await?;
    dbx_core::mq::service::mq_reset_cursor_core(&state, &connection_id, topic, sub, pos).await
}

#[tauri::command]
pub async fn mq_clear_backlog(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Clear backlog").await?;
    dbx_core::mq::service::mq_clear_backlog_core(&state, &connection_id, topic, sub).await
}

#[tauri::command]
pub async fn mq_peek_messages(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    count: u32,
    options: Option<dbx_core::mq::PeekMessagesOptions>,
) -> Result<Vec<dbx_core::mq::PeekedMessage>, String> {
    dbx_core::mq::service::mq_peek_messages_core(&state, &connection_id, topic, sub, count, options).await
}

#[tauri::command]
pub async fn mq_expire_messages(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    expire_seconds: i64,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Expire messages").await?;
    dbx_core::mq::service::mq_expire_messages_core(&state, &connection_id, topic, sub, expire_seconds).await
}

// ---- Producers / consumers ----

#[tauri::command]
pub async fn mq_list_producers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
) -> Result<Vec<dbx_core::mq::ProducerInfo>, String> {
    dbx_core::mq::service::mq_list_producers_core(&state, &connection_id, topic).await
}

#[tauri::command]
pub async fn mq_list_consumers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
) -> Result<Vec<dbx_core::mq::ConsumerInfo>, String> {
    dbx_core::mq::service::mq_list_consumers_core(&state, &connection_id, topic, sub).await
}

#[tauri::command]
pub async fn mq_unload_topic(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Unload topic").await?;
    dbx_core::mq::service::mq_unload_topic_core(&state, &connection_id, topic).await
}

// ---- Rate limits / quotas / retention ----

#[tauri::command]
pub async fn mq_set_publish_rate(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    rate: dbx_core::mq::PublishRate,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Set publish rate").await?;
    dbx_core::mq::service::mq_set_publish_rate_core(&state, &connection_id, scope, rate).await
}

#[tauri::command]
pub async fn mq_set_dispatch_rate(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    rate: dbx_core::mq::DispatchRate,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Set dispatch rate").await?;
    dbx_core::mq::service::mq_set_dispatch_rate_core(&state, &connection_id, scope, rate).await
}

#[tauri::command]
pub async fn mq_set_subscribe_rate(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    rate: dbx_core::mq::SubscribeRate,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Set subscribe rate").await?;
    dbx_core::mq::service::mq_set_subscribe_rate_core(&state, &connection_id, scope, rate).await
}

#[tauri::command]
pub async fn mq_set_backlog_quota(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    quota: dbx_core::mq::BacklogQuota,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Set backlog quota").await?;
    dbx_core::mq::service::mq_set_backlog_quota_core(&state, &connection_id, scope, quota).await
}

#[tauri::command]
pub async fn mq_set_retention(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    retention: dbx_core::mq::RetentionPolicy,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Set retention").await?;
    dbx_core::mq::service::mq_set_retention_core(&state, &connection_id, scope, retention).await
}

#[tauri::command]
pub async fn mq_get_effective_policies(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
) -> Result<serde_json::Value, String> {
    dbx_core::mq::service::mq_get_effective_policies_core(&state, &connection_id, scope).await
}

// ---- Permissions ----

#[tauri::command]
pub async fn mq_grant_permission(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    role: String,
    actions: Vec<dbx_core::mq::AuthAction>,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Grant permission").await?;
    dbx_core::mq::service::mq_grant_permission_core(&state, &connection_id, scope, role, actions).await
}

#[tauri::command]
pub async fn mq_revoke_permission(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    role: String,
) -> Result<(), String> {
    ensure_connection_writable(&state, &connection_id, "Revoke permission").await?;
    dbx_core::mq::service::mq_revoke_permission_core(&state, &connection_id, scope, role).await
}

#[tauri::command]
pub async fn mq_list_permissions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
) -> Result<dbx_core::mq::PermissionMap, String> {
    dbx_core::mq::service::mq_list_permissions_core(&state, &connection_id, scope).await
}

// ---- Client tokens ----

#[tauri::command]
pub async fn mq_issue_token(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::mq::MqTokenIssueRequest,
) -> Result<dbx_core::mq::MqIssuedToken, String> {
    ensure_connection_writable(&state, &connection_id, "Issue MQ token").await?;
    dbx_core::mq::service::mq_issue_token_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn mq_list_token_records(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    subject: Option<String>,
) -> Result<Vec<dbx_core::mq::MqTokenRecord>, String> {
    dbx_core::mq::service::mq_list_token_records_core(&state, &connection_id, subject).await
}

// ---- Monitoring ----

#[tauri::command]
pub async fn mq_get_backlog(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: Option<String>,
) -> Result<dbx_core::mq::BacklogStats, String> {
    dbx_core::mq::service::mq_get_backlog_core(&state, &connection_id, topic, sub).await
}

#[tauri::command]
pub async fn mq_get_cluster_info(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<dbx_core::mq::ClusterInfo, String> {
    dbx_core::mq::service::mq_get_cluster_info_core(&state, &connection_id).await
}

// ---- Raw request (escape hatch) ----

#[tauri::command]
pub async fn mq_raw_request(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::mq::MqRawRequest,
) -> Result<dbx_core::mq::MqRawResponse, String> {
    if req.is_mutating() {
        ensure_connection_writable(&state, &connection_id, "MQ admin write").await?;
    }
    dbx_core::mq::service::mq_raw_request_core(&state, &connection_id, req).await
}

// ---- Message production ----

#[tauri::command]
pub async fn mq_send_message(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: dbx_core::mq::SendMessageRequest,
) -> Result<dbx_core::mq::SendMessageResponse, String> {
    dbx_core::mq::service::mq_send_message_core(&state, &connection_id, req).await
}
