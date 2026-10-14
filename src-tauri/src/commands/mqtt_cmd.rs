use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::connection::PoolKind;
use dbx_core::mqtt::service;
use dbx_core::mqtt::types::*;

const MQTT_LIVE_MESSAGE_LIMIT: usize = 200;
const MQTT_VISIBLE_MESSAGE_LIMIT: usize = MQTT_LIVE_MESSAGE_LIMIT * 2;

type MqttMessageIdentity = (String, String, Option<String>, u8, bool, bool, u64);

fn mqtt_message_identity(message: &MqttMessage) -> MqttMessageIdentity {
    (
        message.topic.clone(),
        message.payload_base64.clone(),
        message.payload_text.clone(),
        message.qos,
        message.retain,
        message.direction == MqttMessageDirection::Sent,
        message.received_at_ms,
    )
}

fn mqtt_topic_matches_filter(topic: &str, filter: &str) -> bool {
    let topic_segments = topic.split('/').collect::<Vec<_>>();
    let filter_segments = filter.split('/').collect::<Vec<_>>();
    let (mut topic_index, mut filter_index) = (0, 0);
    while filter_index < filter_segments.len() {
        match filter_segments[filter_index] {
            "#" => return filter_index + 1 == filter_segments.len(),
            "+" if topic_index < topic_segments.len() => {
                topic_index += 1;
                filter_index += 1;
            }
            segment if topic_index < topic_segments.len() && topic_segments[topic_index] == segment => {
                topic_index += 1;
                filter_index += 1;
            }
            _ => return false,
        }
    }
    topic_index == topic_segments.len()
}

fn mqtt_message_matches_filter(message: &MqttMessage, filter: Option<&str>) -> bool {
    filter.is_none_or(|filter| message.topic == filter || mqtt_topic_matches_filter(&message.topic, filter))
}

/// 从 connections map 中获取 MQTT 客户端
async fn get_mqtt_client(
    state: &AppState,
    connection_id: &str,
) -> Result<Arc<dbx_core::mqtt::client::MqttClient>, String> {
    let pool = state.pool_handle(connection_id).await.ok_or_else(|| format!("连接 {} 未建立", connection_id))?;
    match pool {
        PoolKind::Mqtt(client) => Ok(client),
        _ => Err(format!("连接 {} 不是 MQTT 类型", connection_id)),
    }
}

async fn persist_mqtt_topics(
    state: &AppState,
    connection_id: &str,
    client: &dbx_core::mqtt::client::MqttClient,
) -> Result<(), String> {
    let saved_topics = client.desired_topic_configs().await;
    if !state.configs.read().await.contains_key(connection_id) {
        return Ok(());
    }
    let saved_topics = serde_json::to_value(saved_topics).map_err(|e| e.to_string())?;
    state.storage.save_connection_mqtt_saved_topics(connection_id, saved_topics.clone()).await?;
    if let Some(config) = state.configs.write().await.get_mut(connection_id) {
        let mut external_config = config.external_config.take().unwrap_or_else(|| json!({}));
        let Some(external_object) = external_config.as_object_mut() else {
            return Err("MQTT external_config 必须是 JSON 对象".to_string());
        };
        external_object.insert("savedTopics".to_string(), saved_topics);
        config.external_config = Some(external_config);
    }
    Ok(())
}
/// 获取 broker 基本信息
#[tauri::command]
pub async fn mqtt_get_broker_info(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<MqttBrokerInfo, String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::get_broker_info(&client).await
}

/// 订阅 topic
#[tauri::command]
pub async fn mqtt_subscribe(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
    qos: Option<MqttQoS>,
    no_local: Option<bool>,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::subscribe(&client, &topic, qos.unwrap_or_default(), no_local.unwrap_or(false)).await?;
    persist_mqtt_topics(state.inner(), &connection_id, &client).await
}

/// 保存订阅配置，不向 broker 发送 SUBSCRIBE。
#[tauri::command]
pub async fn mqtt_save_topic_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    config: MqttSavedTopic,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    client.save_topic_config(config).await?;
    persist_mqtt_topics(state.inner(), &connection_id, &client).await
}

/// 取消订阅 topic
#[tauri::command]
pub async fn mqtt_unsubscribe(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::unsubscribe(&client, &topic).await?;
    persist_mqtt_topics(state.inner(), &connection_id, &client).await
}

/// 删除已保存的订阅配置；当前订阅由调用方先取消。
#[tauri::command]
pub async fn mqtt_delete_topic_config(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic: String,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    client.delete_topic_config(&topic).await?;
    persist_mqtt_topics(state.inner(), &connection_id, &client).await
}

/// 发布消息
#[tauri::command]
pub async fn mqtt_publish(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: MqttPublishRequest,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    let _history_guard = client.lock_message_history().await;
    let published_message = service::publish(&client, &request).await?;

    if let Err(error) = state.storage.append_mqtt_sent_message(&connection_id, &published_message).await {
        log::warn!("保存 MQTT 发布历史失败: {error}");
    }
    Ok(())
}

/// 获取已订阅的 topic 列表
#[tauri::command]
pub async fn mqtt_list_topics(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<(String, MqttQoS)>, String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::list_topics(&client).await
}

/// 获取全部已保存的订阅配置（包含未启用配置）。
#[tauri::command]
pub async fn mqtt_list_saved_topic_configs(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<MqttSavedTopic>, String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    Ok(client.desired_topic_configs().await)
}

/// 获取 topic 树结构
#[tauri::command]
pub async fn mqtt_get_topic_tree(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<MqttTopicNode, String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::get_topic_tree(&client).await
}

/// 获取消息列表
#[tauri::command]
pub async fn mqtt_get_messages(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    topic_filter: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MqttMessage>, String> {
    mqtt_get_messages_inner(&state, connection_id, topic_filter, limit).await
}

async fn mqtt_get_messages_inner(
    state: &AppState,
    connection_id: String,
    topic_filter: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MqttMessage>, String> {
    mqtt_get_messages_inner_with_hook(state, connection_id, topic_filter, limit, || async {}).await
}

async fn mqtt_get_messages_inner_with_hook<F, Fut>(
    state: &AppState,
    connection_id: String,
    topic_filter: Option<String>,
    limit: Option<usize>,
    after_snapshot: F,
) -> Result<Vec<MqttMessage>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    let client = get_mqtt_client(state, &connection_id).await?;
    let _history_guard = client.lock_message_history().await;
    let live_messages = service::get_messages(&client, None, MQTT_LIVE_MESSAGE_LIMIT).await?;
    after_snapshot().await;
    if let Err(error) = state.storage.reconcile_mqtt_message_history(&connection_id, &live_messages).await {
        log::warn!("保存 MQTT 消息历史失败: {error}");
    }
    let history = match state.storage.load_mqtt_message_history(&connection_id).await {
        Ok(history) => history,
        Err(error) => {
            log::warn!("读取 MQTT 消息历史失败: {error}");
            Vec::new()
        }
    };
    let mut history_counts = HashMap::<MqttMessageIdentity, usize>::new();
    for message in &history {
        *history_counts.entry(mqtt_message_identity(message)).or_default() += 1;
    }
    let mut messages = history;
    for message in live_messages {
        let identity = mqtt_message_identity(&message);
        if let Some(count) = history_counts.get_mut(&identity) {
            if *count > 0 {
                *count -= 1;
                continue;
            }
        }
        messages.push(message);
    }
    messages.sort_by_key(|message| message.received_at_ms);
    let limit = limit.unwrap_or(50).min(MQTT_VISIBLE_MESSAGE_LIMIT);
    Ok(messages
        .into_iter()
        .filter(|message| mqtt_message_matches_filter(message, topic_filter.as_deref()))
        .rev()
        .take(limit)
        .collect())
}

/// 清空消息历史记录
#[tauri::command]
pub async fn mqtt_clear_messages(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    mqtt_clear_messages_inner(&state, connection_id).await
}

/// Delete one message from the local MQTT console history and live buffer.
#[tauri::command]
pub async fn mqtt_delete_message(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    message: MqttMessage,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    let _history_guard = client.lock_message_history().await;
    state.storage.delete_mqtt_message_history_entry(&connection_id, &message).await?;
    service::delete_message(&client, &message).await;
    Ok(())
}

async fn mqtt_clear_messages_inner(state: &AppState, connection_id: String) -> Result<(), String> {
    mqtt_clear_messages_inner_with_hook(state, connection_id, || async {}).await
}

async fn mqtt_clear_messages_inner_with_hook<F, Fut>(
    state: &AppState,
    connection_id: String,
    before_lock: F,
) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    let client = get_mqtt_client(state, &connection_id).await?;
    before_lock().await;
    let _history_guard = client.lock_message_history().await;
    service::clear_messages(&client).await?;
    state.storage.clear_mqtt_message_history(&connection_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::mqtt::client::MqttClient;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn clear_waits_for_poll_reconciliation_and_prevents_snapshot_writeback() {
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let message = MqttMessage {
            topic: "devices/race".to_string(),
            payload_base64: "cmFjZQ==".to_string(),
            payload_text: Some("race".to_string()),
            qos: 1,
            retain: false,
            received_at_ms: 7,
            direction: MqttMessageDirection::Received,
        };
        let client = MqttClient::test_client_with_messages(vec![message]).await;
        state
            .update_connection_pools(|connections| {
                connections.insert("mqtt-race".to_string(), PoolKind::Mqtt(client.clone()));
            })
            .await;

        let (snapshot_tx, snapshot_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        let poll_state = Arc::clone(&state);
        let poll = tokio::spawn(async move {
            mqtt_get_messages_inner_with_hook(&poll_state, "mqtt-race".to_string(), None, None, || async move {
                snapshot_tx.send(()).unwrap();
                resume_rx.await.unwrap();
            })
            .await
        });
        snapshot_rx.await.unwrap();

        let (clear_started_tx, clear_started_rx) = oneshot::channel();
        let clear_state = Arc::clone(&state);
        let clear = tokio::spawn(async move {
            mqtt_clear_messages_inner_with_hook(&clear_state, "mqtt-race".to_string(), || async move {
                clear_started_tx.send(()).unwrap();
            })
            .await
        });
        clear_started_rx.await.unwrap();
        assert!(!clear.is_finished());

        resume_tx.send(()).unwrap();
        assert_eq!(poll.await.unwrap().unwrap().len(), 1);
        clear.await.unwrap().unwrap();

        assert!(client.get_messages(None, MQTT_LIVE_MESSAGE_LIMIT).await.is_empty());
        assert!(state.storage.load_mqtt_message_history("mqtt-race").await.unwrap().is_empty());
    }
}
