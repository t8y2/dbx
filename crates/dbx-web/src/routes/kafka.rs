use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

/// Check if a connection is read-only and return an error if so.
async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaListTopicsRequest {
    pub connection_id: String,
    pub prefix: String,
    pub limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaDescribeTopicRequest {
    pub connection_id: String,
    pub topic: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaFetchMessagesRequest {
    pub connection_id: String,
    pub topic: String,
    pub partition: i32,
    pub start_offset: dbx_core::db::kafka_driver::KafkaStartOffset,
    pub limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaProduceMessageRequest {
    pub connection_id: String,
    #[serde(flatten)]
    pub body: dbx_core::db::kafka_driver::KafkaProduceRequest,
}

pub async fn list_topics(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaListTopicsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_list_topics_core(&state.app, &req.connection_id, &req.prefix, req.limit)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn describe_topic(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaDescribeTopicRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_describe_topic_core(&state.app, &req.connection_id, &req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn fetch_messages(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaFetchMessagesRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_fetch_messages_core(
        &state.app,
        &req.connection_id,
        &req.topic,
        req.partition,
        req.start_offset,
        req.limit,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn produce_message(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaProduceMessageRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Produce message").await?;
    let result = dbx_core::kafka_ops::kafka_produce_message_core(&state.app, &req.connection_id, req.body)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaListConsumerGroupsRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaDescribeConsumerGroupRequest {
    pub connection_id: String,
    pub group_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaCreateTopicRouteRequest {
    pub connection_id: String,
    #[serde(flatten)]
    pub body: dbx_core::db::kafka_driver::KafkaCreateTopicRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaDeleteTopicRequest {
    pub connection_id: String,
    pub topic: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaListBrokersRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaListAclsRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaGetTopicMessageCountRequest {
    pub connection_id: String,
    pub topic: String,
}

pub async fn get_topic_message_count(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaGetTopicMessageCountRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_get_topic_message_count_core(&state.app, &req.connection_id, &req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "messageCount": result })))
}

pub async fn list_brokers(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaListBrokersRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::kafka_ops::kafka_list_brokers_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_acls(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaListAclsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_list_acls_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn list_consumer_groups(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaListConsumerGroupsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::kafka_ops::kafka_list_consumer_groups_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn describe_consumer_group(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaDescribeConsumerGroupRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_describe_consumer_group_core(&state.app, &req.connection_id, &req.group_id)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn create_topic(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaCreateTopicRouteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create topic").await?;
    let result = dbx_core::kafka_ops::kafka_create_topic_core(&state.app, &req.connection_id, req.body)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn delete_topic(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaDeleteTopicRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete topic").await?;
    let result = dbx_core::kafka_ops::kafka_delete_topic_core(&state.app, &req.connection_id, &req.topic)
        .await
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaSchemaRegistryListSubjectsRequest {
    pub connection_id: String,
    pub prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaSchemaRegistryListVersionsRequest {
    pub connection_id: String,
    pub subject: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaSchemaRegistryGetSchemaRequest {
    pub connection_id: String,
    pub subject: String,
    pub version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaDecodePayloadRequest {
    pub connection_id: String,
    pub payload: dbx_core::db::kafka_driver::KafkaPayload,
    pub subject_hint: Option<String>,
}

pub async fn schema_registry_list_subjects(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaSchemaRegistryListSubjectsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::kafka_ops::kafka_schema_registry_list_subjects_core(&state.app, &req.connection_id, &req.prefix)
            .await
            .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn schema_registry_list_versions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaSchemaRegistryListVersionsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result =
        dbx_core::kafka_ops::kafka_schema_registry_list_versions_core(&state.app, &req.connection_id, &req.subject)
            .await
            .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn schema_registry_get_schema(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaSchemaRegistryGetSchemaRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_schema_registry_get_schema_core(
        &state.app,
        &req.connection_id,
        &req.subject,
        &req.version,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn decode_payload(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KafkaDecodePayloadRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::kafka_ops::kafka_decode_payload_core(
        &state.app,
        &req.connection_id,
        &req.payload,
        req.subject_hint.as_deref(),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError(e.to_string()))?))
}

pub async fn tail_start(
    State(state): State<Arc<WebState>>,
    Json(req): Json<dbx_core::kafka_tail::KafkaTailStartRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    dbx_core::kafka_ops::kafka_tail_start_core(state.app.clone(), req.clone()).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "tailId": req.tail_id })))
}

pub async fn tail_stop(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    if let Some(tail_id) = req.get("tailId").and_then(|value| value.as_str()) {
        dbx_core::kafka_ops::kafka_tail_stop_core(tail_id).await;
    }
    Json(serde_json::json!({ "stopped": true }))
}

pub async fn topic_count_start(
    State(state): State<Arc<WebState>>,
    Json(req): Json<dbx_core::kafka_topic_counts::KafkaTopicCountStartRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    dbx_core::kafka_ops::kafka_topic_count_start_core(state.app.clone(), req.clone()).await.map_err(AppError)?;
    Ok(Json(serde_json::json!({ "sessionId": req.session_id })))
}

pub async fn topic_count_stop(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    if let Some(session_id) = req.get("sessionId").and_then(|value| value.as_str()) {
        dbx_core::kafka_ops::kafka_topic_count_stop_core(session_id).await;
    }
    Json(serde_json::json!({ "stopped": true }))
}

pub async fn topic_count_progress(
    Path(session_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let rx = dbx_core::kafka_ops::kafka_topic_count_subscribe_core(&session_id).await.map_err(AppError)?;
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn tail_progress(
    Path(tail_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let rx = dbx_core::kafka_ops::kafka_tail_subscribe_core(&tail_id).await.map_err(AppError)?;
    Ok(crate::sse::sse_from_channel(rx))
}
