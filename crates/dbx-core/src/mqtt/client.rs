//! MQTT 客户端封装（基于 rumqttc），管理 MQTT broker 的长连接和消息收发。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS, TlsConfiguration, Transport};
use tokio::sync::{Notify, RwLock};
use tokio::task::JoinHandle;

use super::types::{
    MqttAuth, MqttBrokerInfo, MqttConnectionConfig, MqttMessage, MqttMessageDirection, MqttPublishRequest, MqttQoS,
    MqttTopicNode, MqttTransport,
};

/// 持久化的 MQTT 异步客户端
pub struct MqttClient {
    /// rumqttc 异步客户端
    client: AsyncClient,
    /// 连接配置
    config: MqttConnectionConfig,
    /// 当前订阅的 topic 集合
    subscriptions: RwLock<Vec<(String, MqttQoS)>>,
    /// 最近接收的消息缓冲区（保留最近 N 条）
    message_buffer: RwLock<Vec<MqttMessage>>,
    /// 最大缓冲消息数
    max_buffer_size: usize,
    /// 已见过的保留消息的 (topic, payload_base64) 哈希集合，用于去重
    seen_retained: RwLock<HashSet<(String, String)>>,
    /// 事件循环后台任务的 JoinHandle，用于优雅关闭时等待任务结束
    event_loop_handle: RwLock<Option<JoinHandle<()>>>,
    /// 通知事件循环退出的信号
    shutdown_notify: Arc<Notify>,
}

impl MqttClient {
    /// 创建新的 MQTT 客户端并建立连接。
    /// 等待 CONNACK 确认连接成功，超时时间由 `config.connect_timeout_secs` 指定。
    pub async fn connect(config: MqttConnectionConfig) -> Result<Arc<Self>, String> {
        let client_id = config.client_id.clone();
        let mut mqtt_options = MqttOptions::new(&client_id, &config.host, config.port);

        // Keep Alive
        mqtt_options.set_keep_alive(Duration::from_secs(config.keep_alive_secs));

        // 传输层与 TLS 设置
        match config.transport {
            MqttTransport::Tcp => {
                if config.tls {
                    if config.tls_skip_verify {
                        // 跳过证书验证：空 CA 列表意味着不验证服务器证书
                        let tls_config = TlsConfiguration::Simple { ca: vec![], client_auth: None, alpn: None };
                        mqtt_options.set_transport(Transport::tls_with_config(tls_config));
                    } else {
                        mqtt_options.set_transport(Transport::tls_with_default_config());
                    }
                }
                // 默认 TCP，不需要额外设置
            }
            MqttTransport::WebSocket => {
                if config.tls {
                    if config.tls_skip_verify {
                        let tls_config = TlsConfiguration::Simple { ca: vec![], client_auth: None, alpn: None };
                        mqtt_options.set_transport(Transport::wss_with_config(tls_config));
                    } else {
                        mqtt_options.set_transport(Transport::wss_with_config(TlsConfiguration::Simple {
                            ca: vec![],
                            client_auth: None,
                            alpn: None,
                        }));
                    }
                } else {
                    mqtt_options.set_transport(Transport::ws());
                }
            }
        }

        // 用户名密码认证
        if let MqttAuth::Password { ref username, ref password } = config.auth {
            mqtt_options.set_credentials(username, password);
        }

        let (client, mut event_loop) = AsyncClient::new(mqtt_options, 100);

        let shutdown_notify = Arc::new(Notify::new());
        let shutdown_notify_clone = Arc::clone(&shutdown_notify);

        let instance = Arc::new(Self {
            client,
            config,
            subscriptions: RwLock::new(Vec::new()),
            message_buffer: RwLock::new(Vec::new()),
            max_buffer_size: 200,
            seen_retained: RwLock::new(HashSet::new()),
            event_loop_handle: RwLock::new(None),
            shutdown_notify,
        });

        // 启动后台事件监听任务，并等待 CONNACK
        let instance_clone = Arc::clone(&instance);
        let connect_timeout = Duration::from_secs(instance.config.connect_timeout_secs);

        let (connack_result_tx, connack_result_rx) = tokio::sync::oneshot::channel();
        let mut connack_result_tx = Some(connack_result_tx);

        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    event = event_loop.poll() => {
                        match event {
                            Ok(Event::Incoming(Incoming::ConnAck(connack))) => {
                                log::info!(
                                    "MQTT CONNACK 已收到: session_present={}, code={:?}",
                                    connack.session_present,
                                    connack.code
                                );
                                if let Some(tx) = connack_result_tx.take() {
                                    let _ = tx.send(Ok(()));
                                }
                            }
                            Ok(Event::Incoming(Incoming::Publish(publish))) => {
                                let now_ms = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64;

                                let payload_base64 = {
                                    use base64::Engine;
                                    base64::engine::general_purpose::STANDARD.encode(&publish.payload)
                                };

                                // 保留消息去重：同一 (topic, payload) 的保留消息只记录一次
                                if publish.retain {
                                    let mut seen = instance_clone.seen_retained.write().await;
                                    let key = (publish.topic.clone(), payload_base64.clone());
                                    if !seen.insert(key) {
                                        continue;
                                    }
                                }

                                let payload_text = String::from_utf8(publish.payload.to_vec()).ok();

                                let msg = MqttMessage {
                                    topic: publish.topic.clone(),
                                    payload_base64,
                                    payload_text,
                                    qos: match publish.qos {
                                        QoS::AtMostOnce => 0,
                                        QoS::AtLeastOnce => 1,
                                        QoS::ExactlyOnce => 2,
                                    },
                                    retain: publish.retain,
                                    received_at_ms: now_ms,
                                    direction: MqttMessageDirection::Received,
                                };

                                let mut buffer = instance_clone.message_buffer.write().await;
                                buffer.push(msg);
                                if buffer.len() > instance_clone.max_buffer_size {
                                    buffer.remove(0);
                                }
                            }
                            Ok(Event::Incoming(Incoming::Disconnect)) => {
                                log::info!("MQTT broker 发送了 DISCONNECT，事件循环退出");
                                if let Some(tx) = connack_result_tx.take() {
                                    let _ = tx.send(Err(
                                        "MQTT broker 在 CONNACK 之前断开了连接".to_string()
                                    ));
                                }
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                log::warn!("MQTT 事件循环错误: {e}");
                                if let Some(tx) = connack_result_tx.take() {
                                    let _ = tx.send(Err(format!(
                                        "MQTT 连接失败（未收到 CONNACK）: {e}"
                                    )));
                                }
                                break;
                            }
                        }
                    }
                    _ = shutdown_notify_clone.notified() => {
                        log::info!("MQTT 事件循环收到关闭信号，正在退出");
                        break;
                    }
                }
            }
        });

        // 等待 CONNACK 或超时
        match tokio::time::timeout(connect_timeout, connack_result_rx).await {
            Ok(Ok(Ok(()))) => {
                // CONNACK 成功收到，存储事件循环句柄
                {
                    let mut handle_lock = instance.event_loop_handle.write().await;
                    *handle_lock = Some(handle);
                }
                log::info!("MQTT 客户端已成功连接到 {}", instance.config.broker_url());
                Ok(instance)
            }
            Ok(Ok(Err(e))) => {
                // CONNACK 之前出错
                handle.abort();
                Err(e)
            }
            Ok(Err(_)) => {
                // oneshot sender 已丢弃（事件循环异常退出）
                handle.abort();
                Err("MQTT 事件循环意外退出，未收到 CONNACK".to_string())
            }
            Err(_) => {
                // 超时
                handle.abort();
                Err(format!("MQTT 连接超时：{} 秒内未收到 CONNACK", connect_timeout.as_secs()))
            }
        }
    }

    /// 获取 broker 基本信息
    pub async fn broker_info(&self) -> MqttBrokerInfo {
        let subscriptions = self.subscriptions.read().await;
        let protocol_version = match self.config.protocol_version {
            super::types::MqttProtocolVersion::V3 => "MQTT 3.1".to_string(),
            super::types::MqttProtocolVersion::V4 => "MQTT 3.1.1".to_string(),
            super::types::MqttProtocolVersion::V5 => "MQTT 5.0".to_string(),
        };
        MqttBrokerInfo {
            broker_url: self.config.broker_url(),
            client_id: self.config.client_id.clone(),
            connected: true,
            protocol_version,
            subscription_count: subscriptions.len(),
        }
    }

    /// 订阅 topic
    pub async fn subscribe(&self, topic: &str, qos: MqttQoS) -> Result<(), String> {
        let rumqttc_qos = match qos {
            MqttQoS::AtMostOnce => QoS::AtMostOnce,
            MqttQoS::AtLeastOnce => QoS::AtLeastOnce,
            MqttQoS::ExactlyOnce => QoS::ExactlyOnce,
        };
        self.client.subscribe(topic, rumqttc_qos).await.map_err(|e| format!("订阅 topic 失败: {e}"))?;

        let mut subscriptions = self.subscriptions.write().await;
        if !subscriptions.iter().any(|(t, _)| t == topic) {
            subscriptions.push((topic.to_string(), qos));
        }
        Ok(())
    }

    /// 取消订阅 topic
    pub async fn unsubscribe(&self, topic: &str) -> Result<(), String> {
        self.client.unsubscribe(topic).await.map_err(|e| format!("取消订阅 topic 失败: {e}"))?;

        let mut subscriptions = self.subscriptions.write().await;
        subscriptions.retain(|(t, _)| t != topic);
        Ok(())
    }

    /// 发布消息
    pub async fn publish(&self, request: &MqttPublishRequest) -> Result<(), String> {
        let payload = if let Some(ref text) = request.payload_text {
            text.as_bytes().to_vec()
        } else {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(&request.payload_base64)
                .map_err(|e| format!("Base64 解码失败: {e}"))?
        };

        let qos = match request.qos {
            MqttQoS::AtMostOnce => QoS::AtMostOnce,
            MqttQoS::AtLeastOnce => QoS::AtLeastOnce,
            MqttQoS::ExactlyOnce => QoS::ExactlyOnce,
        };

        self.client
            .publish(&request.topic, qos, request.retain, payload.clone())
            .await
            .map_err(|e| format!("发布消息失败: {e}"))?;

        // 将已发送的消息也加入缓冲区，方便前端区分发送/接收
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let payload_text = request.payload_text.clone();
        let payload_base64 = if request.payload_text.is_some() {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(&payload)
        } else {
            request.payload_base64.clone()
        };
        let sent_msg = MqttMessage {
            topic: request.topic.clone(),
            payload_base64,
            payload_text,
            qos: qos as u8,
            retain: request.retain,
            received_at_ms: now_ms,
            direction: MqttMessageDirection::Sent,
        };
        let mut buffer = self.message_buffer.write().await;
        buffer.push(sent_msg);
        if buffer.len() > self.max_buffer_size {
            buffer.remove(0);
        }
        Ok(())
    }

    /// 获取已订阅的 topic 列表
    pub async fn list_topics(&self) -> Vec<(String, MqttQoS)> {
        self.subscriptions.read().await.clone()
    }

    /// 获取消息缓冲区中的消息
    pub async fn get_messages(&self, topic_filter: Option<&str>, limit: usize) -> Vec<MqttMessage> {
        let buffer = self.message_buffer.read().await;
        let filtered: Vec<MqttMessage> = buffer
            .iter()
            .filter(|msg| {
                topic_filter
                    .map(|filter| msg.topic == filter || topic_matches_filter(&msg.topic, filter))
                    .unwrap_or(true)
            })
            .rev()
            .take(limit)
            .cloned()
            .collect();
        filtered
    }

    /// 清空消息缓冲区
    pub async fn clear_messages(&self) {
        let mut buffer = self.message_buffer.write().await;
        buffer.clear();
    }

    /// 从 topic 列表构建 topic 树
    pub async fn build_topic_tree(&self) -> MqttTopicNode {
        let subscriptions = self.subscriptions.read().await;
        let mut root = MqttTopicNode {
            name: "root".to_string(),
            full_path: String::new(),
            children: Vec::new(),
            message_count: None,
            is_leaf: false,
        };

        for (topic, _) in subscriptions.iter() {
            insert_topic_into_tree(&mut root, topic);
        }
        root
    }

    /// 优雅关闭：发送 DISCONNECT、通知事件循环退出、等待任务结束。
    /// 调用此方法后不应再使用该客户端。
    pub async fn disconnect(&self) {
        log::info!("MQTT 客户端正在断开连接...");

        // 发送 DISCONNECT 给 broker
        let _ = self.client.disconnect().await;

        // 通知事件循环退出
        self.shutdown_notify.notify_one();

        // 等待事件循环任务结束（最多 5 秒）。
        // 超时后 JoinHandle 被丢弃，任务在后台继续运行，
        // 当 AsyncClient 被丢弃时内部 channel 关闭，事件循环会因 poll() 报错而退出。
        let mut handle_lock = self.event_loop_handle.write().await;
        if let Some(handle) = handle_lock.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }
    }
}

/// 将 topic 路径插入到树结构中
fn insert_topic_into_tree(root: &mut MqttTopicNode, topic: &str) {
    let segments: Vec<&str> = topic.split('/').collect();
    let mut current: *mut MqttTopicNode = root;

    for (i, segment) in segments.iter().enumerate() {
        let full_path = segments[..=i].join("/");
        let is_leaf = i == segments.len() - 1;

        // SAFETY: 我们在单线程上下文中操作，current 始终指向 root 或其子节点
        let cur = unsafe { &mut *current };

        // 检查是否已存在该子节点
        let child_idx = cur.children.iter().position(|child| child.name == *segment);

        match child_idx {
            Some(idx) => {
                if is_leaf {
                    cur.children[idx].is_leaf = true;
                }
                current = &mut cur.children[idx] as *mut MqttTopicNode;
            }
            None => {
                let new_node = MqttTopicNode {
                    name: segment.to_string(),
                    full_path: full_path.clone(),
                    children: Vec::new(),
                    message_count: None,
                    is_leaf,
                };
                cur.children.push(new_node);
                let last_idx = cur.children.len() - 1;
                current = &mut cur.children[last_idx] as *mut MqttTopicNode;
            }
        }
    }
}

/// 简单 topic 通配符匹配（支持 + 和 #）
fn topic_matches_filter(topic: &str, filter: &str) -> bool {
    let topic_segments: Vec<&str> = topic.split('/').collect();
    let filter_segments: Vec<&str> = filter.split('/').collect();

    let mut ti = 0;
    let mut fi = 0;

    while fi < filter_segments.len() {
        match filter_segments[fi] {
            "#" => return true,
            "+" => {
                if ti >= topic_segments.len() {
                    return false;
                }
                ti += 1;
                fi += 1;
            }
            segment => {
                if ti >= topic_segments.len() || topic_segments[ti] != segment {
                    return false;
                }
                ti += 1;
                fi += 1;
            }
        }
    }

    ti == topic_segments.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_tree_from_subscriptions() {
        let mut root = MqttTopicNode {
            name: "root".to_string(),
            full_path: String::new(),
            children: Vec::new(),
            message_count: None,
            is_leaf: false,
        };
        insert_topic_into_tree(&mut root, "sensors/building1/temperature");
        insert_topic_into_tree(&mut root, "sensors/building1/humidity");
        insert_topic_into_tree(&mut root, "sensors/building2/temperature");

        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].children.len(), 2);
        assert_eq!(root.children[0].children[0].children.len(), 2);
    }

    #[test]
    fn topic_filter_wildcards() {
        assert!(topic_matches_filter("sensors/b1/temp", "sensors/+/temp"));
        assert!(topic_matches_filter("a/b/c/d", "a/#"));
        assert!(!topic_matches_filter("sensors/b1/temp", "actuators/+/temp"));
        assert!(topic_matches_filter("a/b", "a/b"));
    }
}
