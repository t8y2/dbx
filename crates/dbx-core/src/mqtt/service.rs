//! MQTT 服务层：供 Tauri command 和 Web 路由复用的核心函数。

use std::sync::Arc;

use super::client::MqttClient;
use super::types::*;

/// 获取或建立 MQTT 客户端连接。
/// 将 MQTT 连接视为"获取或创建"的模式——同一 connection_id 共享同一客户端。
pub async fn ensure_mqtt_client(
    client: &Option<Arc<MqttClient>>,
    config: &MqttConnectionConfig,
) -> Result<Arc<MqttClient>, String> {
    if let Some(ref client) = client {
        return Ok(Arc::clone(client));
    }
    MqttClient::connect(config.clone()).await
}

/// 测试 MQTT 连接
pub async fn test_connection(config: &MqttConnectionConfig) -> Result<MqttBrokerInfo, String> {
    let client = MqttClient::connect(config.clone()).await?;
    let info = client.broker_info().await;
    client.disconnect().await;
    Ok(info)
}

/// 获取 broker 信息
pub async fn get_broker_info(client: &Arc<MqttClient>) -> Result<MqttBrokerInfo, String> {
    Ok(client.broker_info().await)
}

/// 订阅 topic
pub async fn subscribe(client: &Arc<MqttClient>, topic: &str, qos: MqttQoS) -> Result<(), String> {
    client.subscribe(topic, qos).await
}

/// 取消订阅 topic
pub async fn unsubscribe(client: &Arc<MqttClient>, topic: &str) -> Result<(), String> {
    client.unsubscribe(topic).await
}

/// 发布消息
pub async fn publish(client: &Arc<MqttClient>, request: &MqttPublishRequest) -> Result<(), String> {
    client.publish(request).await
}

/// 获取已订阅的 topic 列表
pub async fn list_topics(client: &Arc<MqttClient>) -> Result<Vec<(String, MqttQoS)>, String> {
    Ok(client.list_topics().await)
}

/// 获取 topic 树
pub async fn get_topic_tree(client: &Arc<MqttClient>) -> Result<MqttTopicNode, String> {
    Ok(client.build_topic_tree().await)
}

/// 获取消息列表
pub async fn get_messages(
    client: &Arc<MqttClient>,
    topic_filter: Option<&str>,
    limit: usize,
) -> Result<Vec<MqttMessage>, String> {
    Ok(client.get_messages(topic_filter, limit).await)
}

/// 清空消息缓冲区
pub async fn clear_messages(client: &Arc<MqttClient>) -> Result<(), String> {
    client.clear_messages().await;
    Ok(())
}
