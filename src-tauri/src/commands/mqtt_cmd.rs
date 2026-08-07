use serde_json::json;
use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::connection::PoolKind;
use dbx_core::mqtt::service;
use dbx_core::mqtt::types::*;

/// 从 connections map 中获取 MQTT 客户端
async fn get_mqtt_client(
    state: &AppState,
    connection_id: &str,
) -> Result<Arc<dbx_core::mqtt::client::MqttClient>, String> {
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or_else(|| format!("连接 {} 未建立", connection_id))?;
    match pool {
        PoolKind::Mqtt(client) => Ok(Arc::clone(client)),
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

/// 发布消息
#[tauri::command]
pub async fn mqtt_publish(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    request: MqttPublishRequest,
) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::publish(&client, &request).await
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
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::get_messages(&client, topic_filter.as_deref(), limit.unwrap_or(50)).await
}

/// 清空消息历史记录
#[tauri::command]
pub async fn mqtt_clear_messages(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    let client = get_mqtt_client(&state, &connection_id).await?;
    service::clear_messages(&client).await
}
