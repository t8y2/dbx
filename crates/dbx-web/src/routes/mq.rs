//! Web (Axum) routes for message queue admin operations.
//!
//! Mirrors the desktop command layer, sharing the same `dbx_core::mq::service::*_core`
//! functions, with read-only protection for mutating operations.

use axum::extract::State;
use axum::Json;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::WebState;

// Request wrappers for endpoints that need more than just connection_id.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnReq {
    connection_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TenantReq {
    connection_id: String,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTenantReq {
    connection_id: String,
    name: String,
    config: dbx_core::mq::TenantConfig,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateTenantReq {
    connection_id: String,
    name: String,
    config: dbx_core::mq::TenantConfig,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteTenantReq {
    connection_id: String,
    name: String,
    #[serde(default)]
    force: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListNamespacesReq {
    connection_id: String,
    tenant: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateNamespaceReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    config: dbx_core::mq::NamespaceConfig,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteNamespaceReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    #[serde(default)]
    force: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NamespacePoliciesReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListTopicsReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    opts: dbx_core::mq::ListTopicsOpts,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTopicReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    partitions: Option<u32>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteTopicReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    #[serde(default)]
    force: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatePartitionsReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    partitions: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TopicReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateSubscriptionReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    pos: dbx_core::mq::ResetPosition,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteSubscriptionReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    #[serde(default)]
    force: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkipMessagesReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    count: dbx_core::mq::SkipCount,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetCursorReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    pos: dbx_core::mq::ResetPosition,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubscriptionReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeekMessagesReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    count: u32,
    #[serde(default)]
    options: Option<dbx_core::mq::PeekMessagesOptions>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExpireMessagesReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: String,
    expire_seconds: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetPublishRateReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    rate: dbx_core::mq::PublishRate,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetDispatchRateReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    rate: dbx_core::mq::DispatchRate,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetSubscribeRateReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    rate: dbx_core::mq::SubscribeRate,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetBacklogQuotaReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    quota: dbx_core::mq::BacklogQuota,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetRetentionReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    retention: dbx_core::mq::RetentionPolicy,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyScopeReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrantPermissionReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    role: String,
    actions: Vec<dbx_core::mq::AuthAction>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokePermissionReq {
    connection_id: String,
    scope: dbx_core::mq::PolicyScope,
    role: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueTokenReq {
    connection_id: String,
    req: dbx_core::mq::MqTokenIssueRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListTokenRecordsReq {
    connection_id: String,
    subject: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BacklogReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    sub: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawRequestReq {
    connection_id: String,
    req: dbx_core::mq::MqRawRequest,
}

// ---- Helper: writable check ----

async fn ensure_writable(app: &dbx_core::connection::AppState, conn_id: &str, action: &str) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, conn_id).await {
        return Err(AppError(format!("Read-only connection '{name}'. {action} is blocked.")));
    }
    Ok(())
}

// ---- Handlers ----

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConnReq>,
) -> Result<Json<dbx_core::mq::MqClusterInfo>, AppError> {
    let result =
        dbx_core::mq::service::mq_test_connection_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_tenants(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConnReq>,
) -> Result<Json<Vec<dbx_core::mq::TenantInfo>>, AppError> {
    let result = dbx_core::mq::service::mq_list_tenants_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn get_tenant(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TenantReq>,
) -> Result<Json<dbx_core::mq::TenantInfo>, AppError> {
    let result =
        dbx_core::mq::service::mq_get_tenant_core(&state.app, &req.connection_id, &req.name).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn create_tenant(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CreateTenantReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create tenant").await?;
    dbx_core::mq::service::mq_create_tenant_core(&state.app, &req.connection_id, &req.name, req.config)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn update_tenant(
    State(state): State<Arc<WebState>>,
    Json(req): Json<UpdateTenantReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update tenant").await?;
    dbx_core::mq::service::mq_update_tenant_core(&state.app, &req.connection_id, &req.name, req.config)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn delete_tenant(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DeleteTenantReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete tenant").await?;
    dbx_core::mq::service::mq_delete_tenant_core(&state.app, &req.connection_id, &req.name, req.force)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_namespaces(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ListNamespacesReq>,
) -> Result<Json<Vec<dbx_core::mq::NamespaceInfo>>, AppError> {
    let result = dbx_core::mq::service::mq_list_namespaces_core(&state.app, &req.connection_id, &req.tenant)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn create_namespace(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CreateNamespaceReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create namespace").await?;
    dbx_core::mq::service::mq_create_namespace_core(&state.app, &req.connection_id, req.ns, req.config)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn delete_namespace(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DeleteNamespaceReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete namespace").await?;
    dbx_core::mq::service::mq_delete_namespace_core(&state.app, &req.connection_id, req.ns, req.force)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn get_namespace_policies(
    State(state): State<Arc<WebState>>,
    Json(req): Json<NamespacePoliciesReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::mq::service::mq_get_namespace_policies_core(&state.app, &req.connection_id, req.ns)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_topics(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ListTopicsReq>,
) -> Result<Json<Vec<dbx_core::mq::TopicInfo>>, AppError> {
    let result = dbx_core::mq::service::mq_list_topics_core(&state.app, &req.connection_id, req.ns, req.opts)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn create_topic(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CreateTopicReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create topic").await?;
    dbx_core::mq::service::mq_create_topic_core(&state.app, &req.connection_id, req.topic, req.partitions)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn delete_topic(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DeleteTopicReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete topic").await?;
    dbx_core::mq::service::mq_delete_topic_core(&state.app, &req.connection_id, req.topic, req.force)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn update_partitions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<UpdatePartitionsReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update partitions").await?;
    dbx_core::mq::service::mq_update_partitions_core(&state.app, &req.connection_id, req.topic, req.partitions)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn get_topic_stats(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TopicReq>,
) -> Result<Json<dbx_core::mq::TopicStats>, AppError> {
    let result = dbx_core::mq::service::mq_get_topic_stats_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn get_topic_internal_stats(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TopicReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::mq::service::mq_get_topic_internal_stats_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_subscriptions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TopicReq>,
) -> Result<Json<Vec<dbx_core::mq::SubscriptionInfo>>, AppError> {
    let result = dbx_core::mq::service::mq_list_subscriptions_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn create_subscription(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CreateSubscriptionReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create subscription").await?;
    dbx_core::mq::service::mq_create_subscription_core(&state.app, &req.connection_id, req.topic, req.sub, req.pos)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn delete_subscription(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DeleteSubscriptionReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete subscription").await?;
    dbx_core::mq::service::mq_delete_subscription_core(&state.app, &req.connection_id, req.topic, req.sub, req.force)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn skip_messages(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SkipMessagesReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Skip messages").await?;
    dbx_core::mq::service::mq_skip_messages_core(&state.app, &req.connection_id, req.topic, req.sub, req.count)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn reset_cursor(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ResetCursorReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Reset cursor").await?;
    dbx_core::mq::service::mq_reset_cursor_core(&state.app, &req.connection_id, req.topic, req.sub, req.pos)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn clear_backlog(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SubscriptionReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Clear backlog").await?;
    dbx_core::mq::service::mq_clear_backlog_core(&state.app, &req.connection_id, req.topic, req.sub)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn peek_messages(
    State(state): State<Arc<WebState>>,
    Json(req): Json<PeekMessagesReq>,
) -> Result<Json<Vec<dbx_core::mq::PeekedMessage>>, AppError> {
    let result = dbx_core::mq::service::mq_peek_messages_core(
        &state.app,
        &req.connection_id,
        req.topic,
        req.sub,
        req.count,
        req.options,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn expire_messages(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExpireMessagesReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Expire messages").await?;
    dbx_core::mq::service::mq_expire_messages_core(
        &state.app,
        &req.connection_id,
        req.topic,
        req.sub,
        req.expire_seconds,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_producers(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TopicReq>,
) -> Result<Json<Vec<dbx_core::mq::ProducerInfo>>, AppError> {
    let result = dbx_core::mq::service::mq_list_producers_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_consumers(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SubscriptionReq>,
) -> Result<Json<Vec<dbx_core::mq::ConsumerInfo>>, AppError> {
    let result = dbx_core::mq::service::mq_list_consumers_core(&state.app, &req.connection_id, req.topic, req.sub)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn unload_topic(State(state): State<Arc<WebState>>, Json(req): Json<TopicReq>) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Unload topic").await?;
    dbx_core::mq::service::mq_unload_topic_core(&state.app, &req.connection_id, req.topic).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_publish_rate(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SetPublishRateReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Set publish rate").await?;
    dbx_core::mq::service::mq_set_publish_rate_core(&state.app, &req.connection_id, req.scope, req.rate)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_dispatch_rate(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SetDispatchRateReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Set dispatch rate").await?;
    dbx_core::mq::service::mq_set_dispatch_rate_core(&state.app, &req.connection_id, req.scope, req.rate)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_subscribe_rate(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SetSubscribeRateReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Set subscribe rate").await?;
    dbx_core::mq::service::mq_set_subscribe_rate_core(&state.app, &req.connection_id, req.scope, req.rate)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_backlog_quota(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SetBacklogQuotaReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Set backlog quota").await?;
    dbx_core::mq::service::mq_set_backlog_quota_core(&state.app, &req.connection_id, req.scope, req.quota)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn set_retention(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SetRetentionReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Set retention").await?;
    dbx_core::mq::service::mq_set_retention_core(&state.app, &req.connection_id, req.scope, req.retention)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn get_effective_policies(
    State(state): State<Arc<WebState>>,
    Json(req): Json<PolicyScopeReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::mq::service::mq_get_effective_policies_core(&state.app, &req.connection_id, req.scope)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn grant_permission(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GrantPermissionReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Grant permission").await?;
    dbx_core::mq::service::mq_grant_permission_core(&state.app, &req.connection_id, req.scope, req.role, req.actions)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn revoke_permission(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RevokePermissionReq>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Revoke permission").await?;
    dbx_core::mq::service::mq_revoke_permission_core(&state.app, &req.connection_id, req.scope, req.role)
        .await
        .map_err(AppError)?;
    Ok(Json(()))
}

pub async fn list_permissions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<PolicyScopeReq>,
) -> Result<Json<dbx_core::mq::PermissionMap>, AppError> {
    let result = dbx_core::mq::service::mq_list_permissions_core(&state.app, &req.connection_id, req.scope)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn issue_token(
    State(state): State<Arc<WebState>>,
    Json(req): Json<IssueTokenReq>,
) -> Result<Json<dbx_core::mq::MqIssuedToken>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Issue MQ token").await?;
    let result =
        dbx_core::mq::service::mq_issue_token_core(&state.app, &req.connection_id, req.req).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_token_records(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ListTokenRecordsReq>,
) -> Result<Json<Vec<dbx_core::mq::MqTokenRecord>>, AppError> {
    let result = dbx_core::mq::service::mq_list_token_records_core(&state.app, &req.connection_id, req.subject)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn get_backlog(
    State(state): State<Arc<WebState>>,
    Json(req): Json<BacklogReq>,
) -> Result<Json<dbx_core::mq::BacklogStats>, AppError> {
    let result = dbx_core::mq::service::mq_get_backlog_core(&state.app, &req.connection_id, req.topic, req.sub)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClusterInfoReq {
    connection_id: String,
}

pub async fn get_cluster_info(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ClusterInfoReq>,
) -> Result<Json<dbx_core::mq::ClusterInfo>, AppError> {
    let result =
        dbx_core::mq::service::mq_get_cluster_info_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn raw_request(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RawRequestReq>,
) -> Result<Json<dbx_core::mq::MqRawResponse>, AppError> {
    if req.req.is_mutating() {
        ensure_writable(&state.app, &req.connection_id, "MQ admin write").await?;
    }
    let result =
        dbx_core::mq::service::mq_raw_request_core(&state.app, &req.connection_id, req.req).await.map_err(AppError)?;
    Ok(Json(result))
}

// ---- Message production ----

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendMessageReq {
    connection_id: String,
    req: dbx_core::mq::SendMessageRequest,
}

pub async fn send_message(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SendMessageReq>,
) -> Result<Json<dbx_core::mq::SendMessageResponse>, AppError> {
    let result =
        dbx_core::mq::service::mq_send_message_core(&state.app, &req.connection_id, req.req).await.map_err(AppError)?;
    Ok(Json(result))
}
