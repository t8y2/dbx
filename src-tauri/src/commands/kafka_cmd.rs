use std::sync::Arc;

use dbx_core::db::kafka_driver::{
    KafkaAclEntry, KafkaBrokerInfo, KafkaConsumerGroupDetail, KafkaConsumerGroupSummary, KafkaCreateTopicRequest,
    KafkaCreateTopicResult, KafkaDeleteTopicResult, KafkaMessageRecord, KafkaPayload, KafkaProduceRequest,
    KafkaProduceResult, KafkaStartOffset, KafkaTopicDetail, KafkaTopicSummary,
};
use dbx_core::db::schema_registry::{KafkaDecodedPayload, SchemaRegistrySchemaDetail};
use dbx_core::kafka_tail::KafkaTailStartRequest;
use dbx_core::kafka_topic_counts::KafkaTopicCountStartRequest;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};

#[tauri::command]
pub async fn kafka_list_topics(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
    limit: usize,
) -> Result<Vec<KafkaTopicSummary>, String> {
    dbx_core::kafka_ops::kafka_list_topics_core(&state, &connection_id, &prefix, limit).await
}

#[tauri::command]
pub async fn kafka_describe_topic(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
) -> Result<KafkaTopicDetail, String> {
    dbx_core::kafka_ops::kafka_describe_topic_core(&state, &connection_id, &topic).await
}

#[tauri::command]
pub async fn kafka_fetch_messages(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
    partition: i32,
    start_offset: KafkaStartOffset,
    limit: usize,
) -> Result<Vec<KafkaMessageRecord>, String> {
    dbx_core::kafka_ops::kafka_fetch_messages_core(&state, &connection_id, &topic, partition, start_offset, limit).await
}

#[tauri::command]
pub async fn kafka_produce_message(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: KafkaProduceRequest,
) -> Result<KafkaProduceResult, String> {
    ensure_connection_writable(&state, &connection_id, "Produce message").await?;
    dbx_core::kafka_ops::kafka_produce_message_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn kafka_get_topic_message_count(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
) -> Result<Option<i64>, String> {
    dbx_core::kafka_ops::kafka_get_topic_message_count_core(&state, &connection_id, &topic).await
}

#[tauri::command]
pub async fn kafka_list_brokers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<KafkaBrokerInfo>, String> {
    dbx_core::kafka_ops::kafka_list_brokers_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn kafka_list_acls(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<KafkaAclEntry>, String> {
    dbx_core::kafka_ops::kafka_list_acls_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn kafka_list_consumer_groups(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<KafkaConsumerGroupSummary>, String> {
    dbx_core::kafka_ops::kafka_list_consumer_groups_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn kafka_describe_consumer_group(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    group_id: String,
) -> Result<KafkaConsumerGroupDetail, String> {
    dbx_core::kafka_ops::kafka_describe_consumer_group_core(&state, &connection_id, &group_id).await
}

#[tauri::command]
pub async fn kafka_create_topic(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    req: KafkaCreateTopicRequest,
) -> Result<KafkaCreateTopicResult, String> {
    ensure_connection_writable(&state, &connection_id, "Create topic").await?;
    dbx_core::kafka_ops::kafka_create_topic_core(&state, &connection_id, req).await
}

#[tauri::command]
pub async fn kafka_delete_topic(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
) -> Result<KafkaDeleteTopicResult, String> {
    ensure_connection_writable(&state, &connection_id, "Delete topic").await?;
    dbx_core::kafka_ops::kafka_delete_topic_core(&state, &connection_id, &topic).await
}

#[tauri::command]
pub async fn kafka_schema_registry_list_subjects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    prefix: String,
) -> Result<Vec<String>, String> {
    dbx_core::kafka_ops::kafka_schema_registry_list_subjects_core(&state, &connection_id, &prefix).await
}

#[tauri::command]
pub async fn kafka_schema_registry_list_versions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    subject: String,
) -> Result<Vec<i32>, String> {
    dbx_core::kafka_ops::kafka_schema_registry_list_versions_core(&state, &connection_id, &subject).await
}

#[tauri::command]
pub async fn kafka_schema_registry_get_schema(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    subject: String,
    version: String,
) -> Result<SchemaRegistrySchemaDetail, String> {
    dbx_core::kafka_ops::kafka_schema_registry_get_schema_core(&state, &connection_id, &subject, &version).await
}

#[tauri::command]
pub async fn kafka_decode_payload(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    payload: KafkaPayload,
    subject_hint: Option<String>,
) -> Result<KafkaDecodedPayload, String> {
    dbx_core::kafka_ops::kafka_decode_payload_core(&state, &connection_id, &payload, subject_hint.as_deref()).await
}

#[tauri::command]
pub async fn kafka_topic_count_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: KafkaTopicCountStartRequest,
) -> Result<(), String> {
    let session_id = request.session_id.clone();
    dbx_core::kafka_ops::kafka_topic_count_start_core(state.inner().clone(), request).await?;
    tokio::spawn(async move {
        let Ok(mut rx) = dbx_core::kafka_ops::kafka_topic_count_subscribe_core(&session_id).await else {
            return;
        };
        while let Ok(json) = rx.recv().await {
            let Ok(event) = serde_json::from_str::<dbx_core::kafka_topic_counts::KafkaTopicCountEvent>(&json) else {
                continue;
            };
            let _ = app.emit("kafka-topic-count-progress", &event);
            if matches!(event.status.as_str(), "done" | "stopped" | "error") {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn kafka_topic_count_stop(session_id: String) -> Result<(), String> {
    dbx_core::kafka_ops::kafka_topic_count_stop_core(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn kafka_tail_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: KafkaTailStartRequest,
) -> Result<(), String> {
    let tail_id = request.tail_id.clone();
    dbx_core::kafka_ops::kafka_tail_start_core(state.inner().clone(), request).await?;
    tokio::spawn(async move {
        let Ok(mut rx) = dbx_core::kafka_ops::kafka_tail_subscribe_core(&tail_id).await else {
            return;
        };
        while let Ok(json) = rx.recv().await {
            let Ok(event) = serde_json::from_str::<dbx_core::kafka_tail::KafkaTailEvent>(&json) else {
                continue;
            };
            let _ = app.emit("kafka-tail-progress", &event);
            if event.status == "stopped" {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn kafka_tail_stop(tail_id: String) -> Result<(), String> {
    dbx_core::kafka_ops::kafka_tail_stop_core(&tail_id).await;
    Ok(())
}
