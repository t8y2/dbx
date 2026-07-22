//! Web (Axum) routes for message queue admin operations.
//!
//! Mirrors the desktop command layer, sharing the same `dbx_core::mq::service::*_core`
//! functions, with read-only protection for mutating operations.

use axum::extract::State;
use axum::http::HeaderMap;
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
pub(crate) struct ListExchangesReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateExchangeReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    name: String,
    exchange_type: String,
    #[serde(default)]
    durable: bool,
    #[serde(default)]
    auto_delete: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteExchangeReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListBindingsReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    #[serde(default)]
    exchange: Option<String>,
    #[serde(default)]
    queue: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindingReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    binding: dbx_core::mq::MqBindingInfo,
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
pub(crate) struct ConsumerGroupConfigReq {
    connection_id: String,
    group_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlterConsumerGroupConfigReq {
    connection_id: String,
    group_id: String,
    config: serde_json::Value,
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListClientConnectionsReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListClientChannelsReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    #[serde(default)]
    connection: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseClientConnectionReq {
    connection_id: String,
    ns: dbx_core::mq::NamespaceRef,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateUserReq {
    connection_id: String,
    name: String,
    password: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserReq {
    connection_id: String,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListUserPermissionsReq {
    connection_id: String,
    #[serde(default)]
    virtual_host: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    all_vhosts: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrantUserPermissionReq {
    connection_id: String,
    user: String,
    virtual_host: String,
    #[serde(default)]
    configure: Option<String>,
    #[serde(default)]
    write: Option<String>,
    #[serde(default)]
    read: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokeUserPermissionReq {
    connection_id: String,
    user: String,
    virtual_host: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListPoliciesReq {
    connection_id: String,
    virtual_host: Option<String>,
    all_vhosts: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetPolicyReq {
    connection_id: String,
    virtual_host: String,
    name: String,
    pattern: String,
    apply_to: Option<String>,
    priority: Option<i32>,
    definition: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletePolicyReq {
    connection_id: String,
    virtual_host: String,
    name: String,
}

// ---- Helper: writable check ----

async fn ensure_writable(app: &dbx_core::connection::AppState, conn_id: &str, action: &str) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, conn_id).await {
        return Err(AppError::from(format!("Read-only connection '{name}'. {action} is blocked.")));
    }
    Ok(())
}

// ---- Handlers ----

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConnReq>,
) -> Result<Json<dbx_core::mq::MqClusterInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_test_connection_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_tenants(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConnReq>,
) -> Result<Json<Vec<dbx_core::mq::TenantInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_list_tenants_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_tenant(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TenantReq>,
) -> Result<Json<dbx_core::mq::TenantInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_tenant_core(&state.app, &req.connection_id, &req.name)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_tenant(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CreateTenantReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create tenant").await?;
    ensure_writable(&state.app, &req.connection_id, "Create tenant").await?;
    dbx_core::mq::service::mq_create_tenant_core(&state.app, &req.connection_id, &req.name, req.config)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn update_tenant(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<UpdateTenantReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Update tenant").await?;
    ensure_writable(&state.app, &req.connection_id, "Update tenant").await?;
    dbx_core::mq::service::mq_update_tenant_core(&state.app, &req.connection_id, &req.name, req.config)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_tenant(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<DeleteTenantReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete tenant").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete tenant").await?;
    dbx_core::mq::service::mq_delete_tenant_core(&state.app, &req.connection_id, &req.name, req.force)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_namespaces(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListNamespacesReq>,
) -> Result<Json<Vec<dbx_core::mq::NamespaceInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_namespaces_core(&state.app, &req.connection_id, &req.tenant)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_namespace(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CreateNamespaceReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create namespace").await?;
    ensure_writable(&state.app, &req.connection_id, "Create namespace").await?;
    dbx_core::mq::service::mq_create_namespace_core(&state.app, &req.connection_id, req.ns, req.config)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_namespace(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<DeleteNamespaceReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete namespace").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete namespace").await?;
    dbx_core::mq::service::mq_delete_namespace_core(&state.app, &req.connection_id, req.ns, req.force)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn get_namespace_policies(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<NamespacePoliciesReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_namespace_policies_core(&state.app, &req.connection_id, req.ns)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_topics(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListTopicsReq>,
) -> Result<Json<Vec<dbx_core::mq::TopicInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_topics_core(&state.app, &req.connection_id, req.ns, req.opts)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_topic(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CreateTopicReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create topic").await?;
    ensure_writable(&state.app, &req.connection_id, "Create topic").await?;
    dbx_core::mq::service::mq_create_topic_core(&state.app, &req.connection_id, req.topic, req.partitions)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_topic(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<DeleteTopicReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete topic").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete topic").await?;
    dbx_core::mq::service::mq_delete_topic_core(&state.app, &req.connection_id, req.topic, req.force)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn update_partitions(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<UpdatePartitionsReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Update partitions").await?;
    ensure_writable(&state.app, &req.connection_id, "Update partitions").await?;
    dbx_core::mq::service::mq_update_partitions_core(&state.app, &req.connection_id, req.topic, req.partitions)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn get_topic_stats(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<dbx_core::mq::TopicStats>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_topic_stats_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_topic_internal_stats(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_topic_internal_stats_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_exchanges(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListExchangesReq>,
) -> Result<Json<Vec<dbx_core::mq::MqExchangeInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_exchanges_core(&state.app, &req.connection_id, req.ns)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn create_exchange(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CreateExchangeReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create exchange").await?;
    ensure_writable(&state.app, &req.connection_id, "Create exchange").await?;
    dbx_core::mq::service::mq_create_exchange_core(
        &state.app,
        &req.connection_id,
        req.ns,
        &req.name,
        &req.exchange_type,
        req.durable,
        req.auto_delete,
    )
    .await
    .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn delete_exchange(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<DeleteExchangeReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete exchange").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete exchange").await?;
    dbx_core::mq::service::mq_delete_exchange_core(&state.app, &req.connection_id, req.ns, &req.name)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn list_bindings(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListBindingsReq>,
) -> Result<Json<Vec<dbx_core::mq::MqBindingInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_list_bindings_core(&state.app, &req.connection_id, req.ns, req.exchange, req.queue)
            .await
            .map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn bind_queue(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<BindingReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create binding").await?;
    ensure_writable(&state.app, &req.connection_id, "Create binding").await?;
    dbx_core::mq::service::mq_bind_core(&state.app, &req.connection_id, req.ns, req.binding)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn unbind_queue(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<BindingReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Delete binding").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete binding").await?;
    dbx_core::mq::service::mq_unbind_core(&state.app, &req.connection_id, req.ns, req.binding)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn list_subscriptions(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<Vec<dbx_core::mq::SubscriptionInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_subscriptions_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_subscription(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CreateSubscriptionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create subscription").await?;
    ensure_writable(&state.app, &req.connection_id, "Create subscription").await?;
    dbx_core::mq::service::mq_create_subscription_core(&state.app, &req.connection_id, req.topic, req.sub, req.pos)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_subscription(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<DeleteSubscriptionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete subscription").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete subscription").await?;
    dbx_core::mq::service::mq_delete_subscription_core(&state.app, &req.connection_id, req.topic, req.sub, req.force)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn skip_messages(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SkipMessagesReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Skip messages").await?;
    ensure_writable(&state.app, &req.connection_id, "Skip messages").await?;
    dbx_core::mq::service::mq_skip_messages_core(&state.app, &req.connection_id, req.topic, req.sub, req.count)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn reset_cursor(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ResetCursorReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Reset cursor").await?;
    ensure_writable(&state.app, &req.connection_id, "Reset cursor").await?;
    dbx_core::mq::service::mq_reset_cursor_core(&state.app, &req.connection_id, req.topic, req.sub, req.pos)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn clear_backlog(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SubscriptionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Clear backlog").await?;
    ensure_writable(&state.app, &req.connection_id, "Clear backlog").await?;
    dbx_core::mq::service::mq_clear_backlog_core(&state.app, &req.connection_id, req.topic, req.sub)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn get_consumer_group_config(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConsumerGroupConfigReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_consumer_group_config_core(&state.app, &req.connection_id, req.group_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn alter_consumer_group_config(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<AlterConsumerGroupConfigReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Alter consumer group config").await?;
    ensure_writable(&state.app, &req.connection_id, "Alter consumer group config").await?;
    dbx_core::mq::service::mq_alter_consumer_group_config_core(
        &state.app,
        &req.connection_id,
        req.group_id,
        req.config,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn peek_messages(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<PeekMessagesReq>,
) -> Result<Json<Vec<dbx_core::mq::PeekedMessage>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_peek_messages_core(
        &state.app,
        &req.connection_id,
        req.topic,
        req.sub,
        req.count,
        req.options,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn expire_messages(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ExpireMessagesReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Expire messages").await?;
    ensure_writable(&state.app, &req.connection_id, "Expire messages").await?;
    dbx_core::mq::service::mq_expire_messages_core(
        &state.app,
        &req.connection_id,
        req.topic,
        req.sub,
        req.expire_seconds,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_producers(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<Vec<dbx_core::mq::ProducerInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_producers_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_consumers(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SubscriptionReq>,
) -> Result<Json<Vec<dbx_core::mq::ConsumerInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_consumers_core(&state.app, &req.connection_id, req.topic, req.sub)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn unload_topic(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Unload topic").await?;
    ensure_writable(&state.app, &req.connection_id, "Unload topic").await?;
    dbx_core::mq::service::mq_unload_topic_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_client_connections(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListClientConnectionsReq>,
) -> Result<Json<Vec<dbx_core::mq::MqClientConnectionInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_client_connections_core(&state.app, &req.connection_id, req.ns)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn list_client_channels(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListClientChannelsReq>,
) -> Result<Json<Vec<dbx_core::mq::MqChannelInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_list_client_channels_core(&state.app, &req.connection_id, req.ns, req.connection)
            .await
            .map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn close_client_connection(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CloseClientConnectionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Close client connection")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Close client connection").await?;
    dbx_core::mq::service::mq_close_client_connection_core(&state.app, &req.connection_id, req.ns, &req.name)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn set_publish_rate(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SetPublishRateReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Set publish rate").await?;
    ensure_writable(&state.app, &req.connection_id, "Set publish rate").await?;
    dbx_core::mq::service::mq_set_publish_rate_core(&state.app, &req.connection_id, req.scope, req.rate)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn set_dispatch_rate(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SetDispatchRateReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Set dispatch rate").await?;
    ensure_writable(&state.app, &req.connection_id, "Set dispatch rate").await?;
    dbx_core::mq::service::mq_set_dispatch_rate_core(&state.app, &req.connection_id, req.scope, req.rate)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn set_subscribe_rate(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SetSubscribeRateReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Set subscribe rate").await?;
    ensure_writable(&state.app, &req.connection_id, "Set subscribe rate").await?;
    dbx_core::mq::service::mq_set_subscribe_rate_core(&state.app, &req.connection_id, req.scope, req.rate)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn set_backlog_quota(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SetBacklogQuotaReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Set backlog quota").await?;
    ensure_writable(&state.app, &req.connection_id, "Set backlog quota").await?;
    dbx_core::mq::service::mq_set_backlog_quota_core(&state.app, &req.connection_id, req.scope, req.quota)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn set_retention(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SetRetentionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Set retention").await?;
    ensure_writable(&state.app, &req.connection_id, "Set retention").await?;
    dbx_core::mq::service::mq_set_retention_core(&state.app, &req.connection_id, req.scope, req.retention)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn get_effective_policies(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<PolicyScopeReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_effective_policies_core(&state.app, &req.connection_id, req.scope)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn grant_permission(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<GrantPermissionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Grant permission").await?;
    ensure_writable(&state.app, &req.connection_id, "Grant permission").await?;
    dbx_core::mq::service::mq_grant_permission_core(&state.app, &req.connection_id, req.scope, req.role, req.actions)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn revoke_permission(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<RevokePermissionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Revoke permission").await?;
    ensure_writable(&state.app, &req.connection_id, "Revoke permission").await?;
    dbx_core::mq::service::mq_revoke_permission_core(&state.app, &req.connection_id, req.scope, req.role)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_permissions(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<PolicyScopeReq>,
) -> Result<Json<dbx_core::mq::PermissionMap>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_permissions_core(&state.app, &req.connection_id, req.scope)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_users(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConnReq>,
) -> Result<Json<Vec<dbx_core::mq::MqUserInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_list_users_core(&state.app, &req.connection_id).await.map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn create_user(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<CreateUserReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Create user").await?;
    ensure_writable(&state.app, &req.connection_id, "Create user").await?;
    dbx_core::mq::service::mq_create_user_core(
        &state.app,
        &req.connection_id,
        &req.name,
        &req.password,
        req.tags.unwrap_or_default(),
    )
    .await
    .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn delete_user(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<UserReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete user").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete user").await?;
    dbx_core::mq::service::mq_delete_user_core(&state.app, &req.connection_id, &req.name)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

/// RabbitMQ user permissions live under the synthetic `_rabbitmq` tenant;
/// `*` is the all-vhosts marker and is only meaningful for listings.
fn user_permission_ns(virtual_host: Option<String>, all_vhosts: Option<bool>) -> dbx_core::mq::NamespaceRef {
    let namespace = match (all_vhosts.unwrap_or(false), virtual_host) {
        (true, _) => "*".to_string(),
        (false, Some(vhost)) if !vhost.trim().is_empty() => vhost,
        _ => "*".to_string(),
    };
    dbx_core::mq::NamespaceRef { tenant: "_rabbitmq".to_string(), namespace }
}

pub async fn list_user_permissions(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListUserPermissionsReq>,
) -> Result<Json<Vec<dbx_core::mq::MqVhostPermission>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let ns = user_permission_ns(req.virtual_host, req.all_vhosts);
    let mut permissions = dbx_core::mq::service::mq_list_user_permissions_core(&state.app, &req.connection_id, ns)
        .await
        .map_err(AppError::internal)?;
    if let Some(user) = req.user {
        permissions.retain(|p| p.user == user);
    }
    Ok(Json(permissions))
}

pub async fn grant_user_permission(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<GrantUserPermissionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Grant user permission").await?;
    ensure_writable(&state.app, &req.connection_id, "Grant user permission").await?;
    let ns = user_permission_ns(Some(req.virtual_host), None);
    let all = || ".*".to_string();
    dbx_core::mq::service::mq_grant_user_permission_core(
        &state.app,
        &req.connection_id,
        ns,
        &req.user,
        &req.configure.unwrap_or_else(all),
        &req.write.unwrap_or_else(all),
        &req.read.unwrap_or_else(all),
    )
    .await
    .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn revoke_user_permission(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<RevokeUserPermissionReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Revoke user permission").await?;
    ensure_writable(&state.app, &req.connection_id, "Revoke user permission").await?;
    let ns = user_permission_ns(Some(req.virtual_host), None);
    dbx_core::mq::service::mq_revoke_user_permission_core(&state.app, &req.connection_id, ns, &req.user)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

// ---- Policies & cluster monitoring (RabbitMQ) ----

pub async fn list_policies(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListPoliciesReq>,
) -> Result<Json<Vec<dbx_core::mq::MqPolicyInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let ns = user_permission_ns(req.virtual_host, req.all_vhosts);
    let result = dbx_core::mq::service::mq_list_policies_core(&state.app, &req.connection_id, ns)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn set_policy(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<SetPolicyReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Set policy").await?;
    ensure_writable(&state.app, &req.connection_id, "Set policy").await?;
    let ns = user_permission_ns(Some(req.virtual_host.clone()), None);
    let policy = dbx_core::mq::MqPolicyInfo {
        name: req.name,
        vhost: req.virtual_host,
        pattern: req.pattern,
        apply_to: req.apply_to.unwrap_or_default(),
        priority: req.priority.unwrap_or(0),
        definition: req.definition,
    };
    dbx_core::mq::service::mq_set_policy_core(&state.app, &req.connection_id, ns, policy)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn delete_policy(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<DeletePolicyReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Delete policy").await?;
    ensure_writable(&state.app, &req.connection_id, "Delete policy").await?;
    let ns = user_permission_ns(Some(req.virtual_host), None);
    dbx_core::mq::service::mq_delete_policy_core(&state.app, &req.connection_id, ns, &req.name)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(()))
}

pub async fn get_overview(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConnReq>,
) -> Result<Json<dbx_core::mq::MqOverviewInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_overview_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn list_nodes(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConnReq>,
) -> Result<Json<Vec<dbx_core::mq::MqNodeInfo>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_list_nodes_core(&state.app, &req.connection_id).await.map_err(AppError::internal)?;
    Ok(Json(result))
}

pub async fn issue_token(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<IssueTokenReq>,
) -> Result<Json<dbx_core::mq::MqIssuedToken>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Issue MQ token").await?;
    ensure_writable(&state.app, &req.connection_id, "Issue MQ token").await?;
    let result = dbx_core::mq::service::mq_issue_token_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_token_records(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ListTokenRecordsReq>,
) -> Result<Json<Vec<dbx_core::mq::MqTokenRecord>>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_list_token_records_core(&state.app, &req.connection_id, req.subject)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_backlog(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<BacklogReq>,
) -> Result<Json<dbx_core::mq::BacklogStats>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_backlog_core(&state.app, &req.connection_id, req.topic, req.sub)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClusterInfoReq {
    connection_id: String,
}

pub async fn get_cluster_info(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ClusterInfoReq>,
) -> Result<Json<dbx_core::mq::ClusterInfo>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_cluster_info_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_topic_route(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_get_topic_route_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlterTopicConfigReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    configs: serde_json::Value,
}

pub async fn alter_topic_config(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<AlterTopicConfigReq>,
) -> Result<Json<()>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Alter topic config").await?;
    ensure_writable(&state.app, &req.connection_id, "Alter topic config").await?;
    dbx_core::mq::service::mq_alter_topic_config_core(&state.app, &req.connection_id, req.topic, req.configs)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn skip_topic_accumulation(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<TopicReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "Skip topic accumulation")
        .await?;
    ensure_writable(&state.app, &req.connection_id, "Skip topic accumulation").await?;
    let result = dbx_core::mq::service::mq_skip_topic_accumulation_core(&state.app, &req.connection_id, req.topic)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewMessageReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    msg_id: String,
}

pub async fn view_message(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ViewMessageReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_view_message_core(&state.app, &req.connection_id, req.topic, req.msg_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryMessagesByKeyReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    key: String,
    begin: i64,
    end: i64,
    max_num: u32,
}

pub async fn query_messages_by_key(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<QueryMessagesByKeyReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_query_messages_by_key_core(
        &state.app,
        &req.connection_id,
        req.topic,
        req.key,
        req.begin,
        req.end,
        req.max_num,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryMessagesByTopicReq {
    connection_id: String,
    topic: dbx_core::mq::TopicRef,
    begin: i64,
    end: i64,
    max_num: u32,
}

pub async fn query_messages_by_topic(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<QueryMessagesByTopicReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result = dbx_core::mq::service::mq_query_messages_by_topic_core(
        &state.app,
        &req.connection_id,
        req.topic,
        req.begin,
        req.end,
        req.max_num,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryMessageTraceReq {
    connection_id: String,
    msg_id: String,
    trace_topic: Option<String>,
}

pub async fn query_message_trace(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<QueryMessageTraceReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    let result =
        dbx_core::mq::service::mq_query_message_trace_core(&state.app, &req.connection_id, req.msg_id, req.trace_topic)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn raw_request(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<RawRequestReq>,
) -> Result<Json<dbx_core::mq::MqRawResponse>, AppError> {
    super::mcp_policy::ensure_scope(&state, &headers, &req.connection_id).await?;
    if req.req.is_mutating() {
        super::mcp_policy::ensure_dangerous_write(&state, &headers, &req.connection_id, "", "MQ admin write").await?;
        ensure_writable(&state.app, &req.connection_id, "MQ admin write").await?;
    }
    let result = dbx_core::mq::service::mq_raw_request_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
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
    headers: HeaderMap,
    Json(req): Json<SendMessageReq>,
) -> Result<Json<dbx_core::mq::SendMessageResponse>, AppError> {
    super::mcp_policy::ensure_write(&state, &headers, &req.connection_id, "", "Send message").await?;
    ensure_writable(&state.app, &req.connection_id, "Send message").await?;
    let result = dbx_core::mq::service::mq_send_message_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

// ---- Tests: MCP authorization regression coverage ----

#[cfg(test)]
mod tests {
    use super::{create_exchange, delete_user, list_tenants, send_message, ConnReq, CreateExchangeReq, SendMessageReq};
    use crate::state::{LoginRateLimit, WebState};
    use axum::extract::State;
    use axum::http::{HeaderMap, HeaderValue};
    use axum::Json;
    use dbx_core::connection::AppState;
    use dbx_core::models::connection::ConnectionConfig;
    use dbx_core::storage::{McpGlobalPolicy, Storage};
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::{Mutex, RwLock};

    fn mq_config() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "mq-policy-test",
            "name": "MQ policy test",
            "db_type": "mq",
            "driver_profile": "rabbitmq",
            "host": "127.0.0.1",
            "port": 1,
            "username": "tester",
            "password": ""
        }))
        .unwrap()
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-mq-policy-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState {
            app,
            data_dir: dir.clone(),
            public_base_path: "/".to_string(),
            password_disabled: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashSet::new()),
            sse_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
        });
        (state, dir)
    }

    fn mcp_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-dbx-mcp-request", HeaderValue::from_static("1"));
        headers
    }

    fn writable_policy(connection_id: &str) -> McpGlobalPolicy {
        McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true,
            allowed_connection_ids: Some(vec![connection_id.to_string()]),
        }
    }

    fn exchange_req(connection_id: &str) -> CreateExchangeReq {
        CreateExchangeReq {
            connection_id: connection_id.to_string(),
            ns: dbx_core::mq::NamespaceRef { tenant: "_rabbitmq".to_string(), namespace: "/".to_string() },
            name: "demo".to_string(),
            exchange_type: "direct".to_string(),
            durable: false,
            auto_delete: false,
        }
    }

    #[tokio::test]
    async fn mcp_scope_blocks_out_of_scope_connection() {
        let (state, dir) = test_web_state().await;
        let connection = mq_config();
        state.app.storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                allowed_connection_ids: Some(vec!["some-other-connection".to_string()]),
                ..writable_policy(&connection.id)
            })
            .await
            .unwrap();
        let headers = mcp_headers();

        let read =
            list_tenants(State(state.clone()), headers.clone(), Json(ConnReq { connection_id: connection.id.clone() }))
                .await
                .unwrap_err();
        assert!(read.message.starts_with("CONNECTION_OUT_OF_SCOPE:"), "{}", read.message);

        let write = create_exchange(State(state.clone()), headers.clone(), Json(exchange_req(&connection.id)))
            .await
            .unwrap_err();
        assert!(write.message.starts_with("CONNECTION_OUT_OF_SCOPE:"), "{}", write.message);

        // Non-MCP requests bypass the MCP scope gate entirely; the handler then
        // fails on the unreachable broker instead of an authorization error.
        let bypassed = list_tenants(
            State(state.clone()),
            HeaderMap::new(),
            Json(ConnReq { connection_id: connection.id.clone() }),
        )
        .await
        .unwrap_err();
        assert!(!bypassed.message.starts_with("CONNECTION_OUT_OF_SCOPE:"), "{}", bypassed.message);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mcp_read_only_mode_blocks_mq_mutations_but_allows_reads() {
        let (state, dir) = test_web_state().await;
        let connection = mq_config();
        state.app.storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy { read_only: true, ..writable_policy(&connection.id) })
            .await
            .unwrap();
        let headers = mcp_headers();

        for result in [
            create_exchange(State(state.clone()), headers.clone(), Json(exchange_req(&connection.id)))
                .await
                .map(|_| ())
                .map_err(|error| error.message),
            send_message(
                State(state.clone()),
                headers.clone(),
                Json(SendMessageReq {
                    connection_id: connection.id.clone(),
                    req: serde_json::from_value(serde_json::json!({
                        "topic": "demo",
                        "payloadBase64": "aGVsbG8="
                    }))
                    .unwrap(),
                }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.message),
            delete_user(
                State(state.clone()),
                headers.clone(),
                Json(super::UserReq { connection_id: connection.id.clone(), name: "demo".to_string() }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.message),
        ] {
            let message = result.unwrap_err();
            assert!(message.starts_with("MCP_READ_ONLY:"), "{message}");
        }

        // Reads stay allowed under global read-only mode; they fail later on the
        // unreachable broker, not on the policy gate.
        let read = list_tenants(State(state.clone()), headers, Json(ConnReq { connection_id: connection.id.clone() }))
            .await
            .unwrap_err();
        assert!(!read.message.starts_with("MCP_READ_ONLY:"), "{}", read.message);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mcp_dangerous_gate_blocks_high_risk_mq_ops_only() {
        let (state, dir) = test_web_state().await;
        let connection = mq_config();
        state.app.storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy { allow_dangerous_sql: false, ..writable_policy(&connection.id) })
            .await
            .unwrap();
        let headers = mcp_headers();

        let dangerous = delete_user(
            State(state.clone()),
            headers.clone(),
            Json(super::UserReq { connection_id: connection.id.clone(), name: "demo".to_string() }),
        )
        .await
        .unwrap_err();
        assert!(dangerous.message.starts_with("SQL_BLOCKED:"), "{}", dangerous.message);

        // Ordinary mutations only require write access: they pass the gate and
        // fail later on the unreachable broker instead of an authorization error.
        let write = create_exchange(State(state.clone()), headers.clone(), Json(exchange_req(&connection.id)))
            .await
            .unwrap_err();
        assert!(!write.message.starts_with("SQL_BLOCKED:"), "{}", write.message);
        assert!(!write.message.starts_with("MCP_READ_ONLY:"), "{}", write.message);

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mcp_guards_allow_in_scope_writable_connection() {
        let (state, dir) = test_web_state().await;
        let connection = mq_config();
        state.app.storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        state.app.storage.save_mcp_global_policy(&writable_policy(&connection.id)).await.unwrap();
        let headers = mcp_headers();

        assert!(
            super::super::mcp_policy::ensure_scope(&state, &headers, &connection.id).await.is_ok(),
            "in-scope read should pass"
        );
        assert!(
            super::super::mcp_policy::ensure_write(&state, &headers, &connection.id, "", "Create exchange")
                .await
                .is_ok(),
            "in-scope write should pass"
        );
        assert!(
            super::super::mcp_policy::ensure_dangerous_write(&state, &headers, &connection.id, "", "Delete user")
                .await
                .is_ok(),
            "in-scope dangerous write should pass when high-risk ops are enabled"
        );

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
