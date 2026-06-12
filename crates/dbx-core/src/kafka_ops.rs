use std::sync::Arc;
use std::time::Duration;

use crate::connection::{AppState, PoolKind};
use base64::Engine;

use crate::db::kafka_driver::{
    self, KafkaAclEntry, KafkaBrokerInfo, KafkaConsumerGroupDetail, KafkaConsumerGroupSummary, KafkaCreateTopicRequest,
    KafkaCreateTopicResult, KafkaDeleteTopicResult, KafkaMessageRecord, KafkaPayload, KafkaProduceRequest,
    KafkaProduceResult, KafkaStartOffset, KafkaTopicDetail, KafkaTopicSummary,
};
use crate::db::schema_registry::{self, KafkaDecodedPayload, SchemaRegistrySchemaDetail};
use crate::kafka_tail::{self, KafkaTailEvent, KafkaTailStartRequest};
use crate::kafka_topic_counts;

async fn ensure_kafka_writable(state: &AppState, connection_id: &str, action: &str) -> Result<(), String> {
    if let Some(name) = crate::query::connection_readonly_name(state, connection_id).await {
        return Err(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        ));
    }
    Ok(())
}

fn fetch_timeout_for_connection(state: &AppState, connection_id: &str) -> Duration {
    let configs = state.configs.try_read();
    let secs = configs
        .ok()
        .and_then(|configs| configs.get(connection_id).map(|c| c.effective_connect_timeout_secs()))
        .unwrap_or(5);
    Duration::from_secs(secs.max(1))
}

pub async fn kafka_list_topics_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
    limit: usize,
) -> Result<Vec<KafkaTopicSummary>, String> {
    let prefix = prefix.trim();
    let prefix = if prefix.is_empty() { None } else { Some(prefix) };
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::list_topics(handle, prefix, limit).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_describe_topic_core(
    state: &AppState,
    connection_id: &str,
    topic: &str,
) -> Result<KafkaTopicDetail, String> {
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::describe_topic(handle, topic).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_fetch_messages_core(
    state: &AppState,
    connection_id: &str,
    topic: &str,
    partition: i32,
    start_offset: KafkaStartOffset,
    limit: usize,
) -> Result<Vec<KafkaMessageRecord>, String> {
    let start_offset = start_offset.to_fetch_offset()?;
    let timeout = fetch_timeout_for_connection(state, connection_id);
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => {
            kafka_driver::fetch_messages(handle, topic, partition, start_offset, limit, timeout).await
        }
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_get_topic_message_count_core(
    state: &AppState,
    connection_id: &str,
    topic: &str,
) -> Result<Option<i64>, String> {
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::get_topic_message_count(handle, topic).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_list_brokers_core(state: &AppState, connection_id: &str) -> Result<Vec<KafkaBrokerInfo>, String> {
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::list_brokers(handle).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_list_acls_core(state: &AppState, connection_id: &str) -> Result<Vec<KafkaAclEntry>, String> {
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::list_acls(handle).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_list_consumer_groups_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<KafkaConsumerGroupSummary>, String> {
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::list_consumer_groups(handle).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_describe_consumer_group_core(
    state: &AppState,
    connection_id: &str,
    group_id: &str,
) -> Result<KafkaConsumerGroupDetail, String> {
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::describe_consumer_group(handle, group_id).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_create_topic_core(
    state: &AppState,
    connection_id: &str,
    req: KafkaCreateTopicRequest,
) -> Result<KafkaCreateTopicResult, String> {
    ensure_kafka_writable(state, connection_id, "Create topic").await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::create_topic(handle, req).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_delete_topic_core(
    state: &AppState,
    connection_id: &str,
    topic: &str,
) -> Result<KafkaDeleteTopicResult, String> {
    ensure_kafka_writable(state, connection_id, "Delete topic").await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => kafka_driver::delete_topic(handle, topic).await,
        _ => Err("Not a Kafka connection".to_string()),
    }
}

pub async fn kafka_produce_message_core(
    state: &AppState,
    connection_id: &str,
    req: KafkaProduceRequest,
) -> Result<KafkaProduceResult, String> {
    ensure_kafka_writable(state, connection_id, "Produce").await?;
    let headers = if req.headers.is_empty() {
        None
    } else {
        Some(req.headers.into_iter().map(|(key, value)| (key, value.into_bytes())).collect())
    };
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Connection not found")? {
        PoolKind::Kafka(handle) => {
            kafka_driver::produce_message(
                handle,
                &req.topic,
                req.key.as_deref(),
                Some(req.value.as_bytes()),
                headers,
                req.partition,
            )
            .await
        }
        _ => Err("Not a Kafka connection".to_string()),
    }
}

async fn kafka_config(
    state: &AppState,
    connection_id: &str,
) -> Result<crate::models::connection::ConnectionConfig, String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).cloned().ok_or_else(|| "Connection not found".to_string())
}

pub async fn kafka_schema_registry_list_subjects_core(
    state: &AppState,
    connection_id: &str,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let config = kafka_config(state, connection_id).await?;
    let prefix = prefix.trim();
    let prefix = if prefix.is_empty() { None } else { Some(prefix) };
    schema_registry::list_subjects(&config, prefix).await
}

pub async fn kafka_schema_registry_list_versions_core(
    state: &AppState,
    connection_id: &str,
    subject: &str,
) -> Result<Vec<i32>, String> {
    let config = kafka_config(state, connection_id).await?;
    schema_registry::list_subject_versions(&config, subject).await
}

pub async fn kafka_schema_registry_get_schema_core(
    state: &AppState,
    connection_id: &str,
    subject: &str,
    version: &str,
) -> Result<SchemaRegistrySchemaDetail, String> {
    let config = kafka_config(state, connection_id).await?;
    schema_registry::get_schema_version(&config, subject, version).await
}

pub async fn kafka_decode_payload_core(
    state: &AppState,
    connection_id: &str,
    payload: &KafkaPayload,
    subject_hint: Option<&str>,
) -> Result<KafkaDecodedPayload, String> {
    let config = kafka_config(state, connection_id).await?;
    let bytes = payload_bytes(payload)?;
    Ok(schema_registry::decode_payload_async(&config, &bytes, subject_hint).await)
}

fn payload_bytes(payload: &KafkaPayload) -> Result<Vec<u8>, String> {
    match payload.encoding.as_str() {
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(payload.data.as_bytes())
            .map_err(|e| format!("Invalid base64 payload: {e}")),
        _ => Ok(payload.data.as_bytes().to_vec()),
    }
}

pub async fn kafka_tail_start_core(state: Arc<AppState>, request: KafkaTailStartRequest) -> Result<(), String> {
    kafka_tail::start_tail(state, request).await
}

pub async fn kafka_tail_stop_core(tail_id: &str) {
    kafka_tail::stop_tail(tail_id).await
}

pub async fn kafka_tail_subscribe_core(tail_id: &str) -> Result<tokio::sync::broadcast::Receiver<String>, String> {
    kafka_tail::subscribe_tail(tail_id).await
}

pub type KafkaTailProgressEvent = KafkaTailEvent;

pub async fn kafka_topic_count_start_core(
    state: Arc<AppState>,
    request: kafka_topic_counts::KafkaTopicCountStartRequest,
) -> Result<(), String> {
    kafka_topic_counts::start_topic_count_hydration(state, request).await
}

pub async fn kafka_topic_count_stop_core(session_id: &str) {
    kafka_topic_counts::stop_topic_count(session_id).await
}

pub async fn kafka_topic_count_subscribe_core(
    session_id: &str,
) -> Result<tokio::sync::broadcast::Receiver<String>, String> {
    kafka_topic_counts::subscribe_topic_count(session_id).await
}
