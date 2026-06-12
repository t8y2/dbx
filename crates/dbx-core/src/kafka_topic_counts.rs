use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;

use crate::connection::{AppState, PoolKind};
use crate::db::kafka_driver;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTopicCountStartRequest {
    pub session_id: String,
    pub connection_id: String,
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTopicCountEvent {
    pub session_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct TopicCountSession {
    sender: broadcast::Sender<String>,
    task: JoinHandle<()>,
}

static TOPIC_COUNT_SESSIONS: LazyLock<RwLock<HashMap<String, TopicCountSession>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
static CANCELLED_TOPIC_COUNT_SESSIONS: LazyLock<std::sync::RwLock<HashSet<String>>> =
    LazyLock::new(|| std::sync::RwLock::new(HashSet::new()));

pub async fn subscribe_topic_count(session_id: &str) -> Result<broadcast::Receiver<String>, String> {
    let sessions = TOPIC_COUNT_SESSIONS.read().await;
    let session =
        sessions.get(session_id).ok_or_else(|| format!("Kafka topic count session '{session_id}' not found"))?;
    Ok(session.sender.subscribe())
}

pub async fn stop_topic_count(session_id: &str) {
    CANCELLED_TOPIC_COUNT_SESSIONS.write().unwrap_or_else(|e| e.into_inner()).insert(session_id.to_string());
    if let Some(session) = TOPIC_COUNT_SESSIONS.write().await.remove(session_id) {
        session.task.abort();
        let _ = session.sender.send(
            serde_json::to_string(&KafkaTopicCountEvent {
                session_id: session_id.to_string(),
                status: "stopped".to_string(),
                topic: None,
                message_count: None,
                error: None,
            })
            .unwrap_or_else(|_| "{\"status\":\"stopped\"}".to_string()),
        );
    }
    CANCELLED_TOPIC_COUNT_SESSIONS.write().unwrap_or_else(|e| e.into_inner()).remove(session_id);
}

pub async fn start_topic_count_hydration(
    state: Arc<AppState>,
    request: KafkaTopicCountStartRequest,
) -> Result<(), String> {
    let session_id = request.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }

    let topics: Vec<String> =
        request.topics.into_iter().map(|topic| topic.trim().to_string()).filter(|topic| !topic.is_empty()).collect();
    if topics.is_empty() {
        return Ok(());
    }

    stop_topic_count(&session_id).await;
    CANCELLED_TOPIC_COUNT_SESSIONS.write().unwrap_or_else(|e| e.into_inner()).remove(&session_id);

    let (sender, _) = broadcast::channel::<String>(64);
    let connection_id = request.connection_id.clone();
    let session_id_for_task = session_id.clone();
    let sender_for_task = sender.clone();
    let state_for_task = state.clone();

    let task = tokio::spawn(async move {
        let handle = {
            let connections = state_for_task.connections.read().await;
            match connections.get(&connection_id) {
                Some(PoolKind::Kafka(handle)) => Arc::clone(handle),
                Some(_) => {
                    emit_topic_count_error(&sender_for_task, &session_id_for_task, "Not a Kafka connection");
                    return;
                }
                None => {
                    emit_topic_count_error(&sender_for_task, &session_id_for_task, "Connection not found");
                    return;
                }
            }
        };

        let metadata = match kafka_driver::fetch_cluster_metadata_for_handle(&handle).await {
            Ok(metadata) => metadata,
            Err(error) => {
                emit_topic_count_error(&sender_for_task, &session_id_for_task, &error);
                return;
            }
        };

        let mut topic_partitions = Vec::with_capacity(topics.len());
        for topic in &topics {
            let partition_ids = metadata
                .topics()
                .iter()
                .find(|candidate| candidate.name() == topic)
                .map(|candidate| candidate.partitions().iter().map(|partition| partition.id()).collect())
                .unwrap_or_default();
            topic_partitions.push((topic.clone(), partition_ids));
        }

        let config = handle.connection_config().clone();
        let timeout = Duration::from_secs(handle.connection_config().effective_connect_timeout_secs().max(1));
        let session_id_for_blocking = session_id_for_task.clone();
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<(String, Option<i64>)>(32);

        let blocking = tokio::task::spawn_blocking(move || {
            kafka_driver::count_topics_messages(&config, topic_partitions, timeout, |topic, count| {
                if CANCELLED_TOPIC_COUNT_SESSIONS
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(&session_id_for_blocking)
                {
                    return false;
                }
                progress_tx.blocking_send((topic.to_string(), count)).is_ok()
            })
        });

        while let Some((topic, message_count)) = progress_rx.recv().await {
            if CANCELLED_TOPIC_COUNT_SESSIONS.read().unwrap_or_else(|e| e.into_inner()).contains(&session_id_for_task) {
                break;
            }
            emit_topic_count(&sender_for_task, &session_id_for_task, &topic, message_count);
            tokio::task::yield_now().await;
        }

        match blocking.await {
            Ok(Err(error)) => emit_topic_count_error(&sender_for_task, &session_id_for_task, &error),
            Err(error) => emit_topic_count_error(
                &sender_for_task,
                &session_id_for_task,
                &format!("Kafka topic count task failed: {error}"),
            ),
            Ok(Ok(())) => {}
        }

        let _ = sender_for_task.send(
            serde_json::to_string(&KafkaTopicCountEvent {
                session_id: session_id_for_task.clone(),
                status: "done".to_string(),
                topic: None,
                message_count: None,
                error: None,
            })
            .unwrap_or_else(|_| "{\"status\":\"done\"}".to_string()),
        );
        TOPIC_COUNT_SESSIONS.write().await.remove(&session_id_for_task);
    });

    TOPIC_COUNT_SESSIONS.write().await.insert(session_id, TopicCountSession { sender, task });
    Ok(())
}

fn emit_topic_count(sender: &broadcast::Sender<String>, session_id: &str, topic: &str, message_count: Option<i64>) {
    let event = KafkaTopicCountEvent {
        session_id: session_id.to_string(),
        status: "count".to_string(),
        topic: Some(topic.to_string()),
        message_count,
        error: None,
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = sender.send(json);
    }
}

fn emit_topic_count_error(sender: &broadcast::Sender<String>, session_id: &str, error: &str) {
    let event = KafkaTopicCountEvent {
        session_id: session_id.to_string(),
        status: "error".to_string(),
        topic: None,
        message_count: None,
        error: Some(error.to_string()),
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = sender.send(json);
    }
}
