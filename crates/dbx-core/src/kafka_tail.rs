use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;

use crate::connection::{AppState, PoolKind};
use crate::db::kafka_driver::{self, KafkaMessageRecord};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTailStartRequest {
    pub tail_id: String,
    pub connection_id: String,
    pub topic: String,
    pub partition: i32,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
}

fn default_poll_interval_ms() -> u64 {
    1000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTailEvent {
    pub tail_id: String,
    pub status: String,
    pub message: Option<KafkaMessageRecord>,
    pub error: Option<String>,
}

struct TailSession {
    sender: broadcast::Sender<String>,
    task: JoinHandle<()>,
}

static TAIL_SESSIONS: LazyLock<RwLock<HashMap<String, TailSession>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
static CANCELLED_TAILS: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(|| RwLock::new(HashSet::new()));

pub async fn subscribe_tail(tail_id: &str) -> Result<broadcast::Receiver<String>, String> {
    let sessions = TAIL_SESSIONS.read().await;
    let session = sessions.get(tail_id).ok_or_else(|| format!("Kafka tail session '{tail_id}' not found"))?;
    Ok(session.sender.subscribe())
}

pub async fn stop_tail(tail_id: &str) {
    CANCELLED_TAILS.write().await.insert(tail_id.to_string());
    if let Some(session) = TAIL_SESSIONS.write().await.remove(tail_id) {
        session.task.abort();
        let _ = session.sender.send(
            serde_json::to_string(&KafkaTailEvent {
                tail_id: tail_id.to_string(),
                status: "stopped".to_string(),
                message: None,
                error: None,
            })
            .unwrap_or_else(|_| "{\"status\":\"stopped\"}".to_string()),
        );
    }
    CANCELLED_TAILS.write().await.remove(tail_id);
}

pub async fn start_tail(state: Arc<AppState>, request: KafkaTailStartRequest) -> Result<(), String> {
    let tail_id = request.tail_id.trim().to_string();
    if tail_id.is_empty() {
        return Err("tail_id is required".to_string());
    }
    if request.topic.trim().is_empty() {
        return Err("topic is required".to_string());
    }

    stop_tail(&tail_id).await;
    CANCELLED_TAILS.write().await.remove(&tail_id);

    let (sender, _) = broadcast::channel::<String>(256);
    let connection_id = request.connection_id.clone();
    let topic = request.topic.trim().to_string();
    let partition = request.partition;
    let tail_id_for_task = tail_id.clone();
    let sender_for_task = sender.clone();
    let state_for_task = state.clone();

    let task = tokio::spawn(async move {
        let handle = {
            let connections = state_for_task.connections.read().await;
            match connections.get(&connection_id) {
                Some(PoolKind::Kafka(handle)) => handle.clone(),
                Some(_) => {
                    emit_tail_error(&sender_for_task, &tail_id_for_task, "Not a Kafka connection");
                    return;
                }
                None => {
                    emit_tail_error(&sender_for_task, &tail_id_for_task, "Connection not found");
                    return;
                }
            }
        };

        let tail_id_for_messages = tail_id_for_task.clone();
        let sender_for_messages = sender_for_task.clone();
        let tail_result = kafka_driver::run_partition_tail(
            &handle,
            &topic,
            partition,
            None,
            move |message| {
                if sender_for_messages.receiver_count() == 0 {
                    return;
                }
                let event = KafkaTailEvent {
                    tail_id: tail_id_for_messages.clone(),
                    status: "message".to_string(),
                    message: Some(message),
                    error: None,
                };
                if let Ok(json) = serde_json::to_string(&event) {
                    let _ = sender_for_messages.send(json);
                }
            },
            || {
                let tail_id = tail_id_for_task.clone();
                async move { CANCELLED_TAILS.read().await.contains(&tail_id) }
            },
        )
        .await;

        if let Err(error) = tail_result {
            emit_tail_error(&sender_for_task, &tail_id_for_task, &error);
        }

        let stopped_tail_id = tail_id_for_task.clone();
        let _ = sender_for_task.send(
            serde_json::to_string(&KafkaTailEvent {
                tail_id: tail_id_for_task,
                status: "stopped".to_string(),
                message: None,
                error: None,
            })
            .unwrap_or_else(|_| "{\"status\":\"stopped\"}".to_string()),
        );
        TAIL_SESSIONS.write().await.remove(&stopped_tail_id);
    });

    TAIL_SESSIONS.write().await.insert(tail_id, TailSession { sender, task });
    Ok(())
}

fn emit_tail_error(sender: &broadcast::Sender<String>, tail_id: &str, error: &str) {
    let event = KafkaTailEvent {
        tail_id: tail_id.to_string(),
        status: "error".to_string(),
        message: None,
        error: Some(error.to_string()),
    };
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = sender.send(json);
    }
}
