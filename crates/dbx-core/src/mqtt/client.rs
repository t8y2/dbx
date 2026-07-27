//! MQTT 客户端封装（基于 rumqttc），管理 MQTT broker 的长连接和消息收发。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS, TlsConfiguration, Transport};
use tokio::sync::RwLock;

use super::types::{
    MqttAuth, MqttBrokerInfo, MqttConnectionConfig, MqttMessage, MqttPublishRequest, MqttQoS, MqttTopicNode,
    MqttTransport,
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
}

impl MqttClient {
    /// 创建新的 MQTT 客户端并建立连接。
    pub async fn connect(config: MqttConnectionConfig) -> Result<Arc<Self>, String> {
        let client_id = config.client_id.clone();
        let mut mqtt_options = MqttOptions::new(&client_id, &config.host, config.port);

        // Keep Alive
        mqtt_options.set_keep_alive(std::time::Duration::from_secs(config.keep_alive_secs));

        // 传输层与 TLS 设置
        match config.transport {
            MqttTransport::Tcp => {
                if config.tls {
                    let client_auth = if let MqttAuth::Certificate { .. } = config.auth {
                        None // 客户端证书暂不支持（后续版本完善）
                    } else {
                        None
                    };

                    let tls_config = TlsConfiguration::Simple { ca: vec![], client_auth, alpn: None };
                    mqtt_options.set_transport(Transport::tls_with_config(tls_config));
                }
                // 默认 TCP，不需要额外设置
            }
            MqttTransport::WebSocket => {
                // WebSocket 暂不完全支持，降级为 TCP
                if config.tls {
                    mqtt_options.set_transport(Transport::tls_with_default_config());
                }
            }
        }

        // 用户名密码认证
        if let MqttAuth::Password { ref username, ref password } = config.auth {
            mqtt_options.set_credentials(username, password);
        }

        // MQTT 5.0 协议版本（rumqttc 0.24 默认支持 3.1.1/5.0，通过 set_manual_ack 等控制）
        // 暂忽略 V3/V4 版本差异，均使用默认行为

        let (client, mut event_loop) = AsyncClient::new(mqtt_options, 100);

        let instance = Arc::new(Self {
            client,
            config,
            subscriptions: RwLock::new(Vec::new()),
            message_buffer: RwLock::new(Vec::new()),
            max_buffer_size: 200,
        });

        // 启动后台事件监听任务
        let instance_clone = Arc::clone(&instance);
        tokio::spawn(async move {
            loop {
                match event_loop.poll().await {
                    Ok(Event::Incoming(Incoming::Publish(publish))) => {
                        let now_ms =
                            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

                        let payload_text = String::from_utf8(publish.payload.to_vec()).ok();

                        let msg = MqttMessage {
                            topic: publish.topic.clone(),
                            payload_base64: {
                                use base64::Engine;
                                base64::engine::general_purpose::STANDARD.encode(&publish.payload)
                            },
                            payload_text,
                            qos: match publish.qos {
                                QoS::AtMostOnce => 0,
                                QoS::AtLeastOnce => 1,
                                QoS::ExactlyOnce => 2,
                            },
                            retain: publish.retain,
                            received_at_ms: now_ms,
                        };

                        let mut buffer = instance_clone.message_buffer.write().await;
                        buffer.push(msg);
                        if buffer.len() > instance_clone.max_buffer_size {
                            buffer.remove(0);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        log::warn!("MQTT 事件循环错误: {e}");
                        break;
                    }
                }
            }
        });

        Ok(instance)
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
            .publish(&request.topic, qos, request.retain, payload)
            .await
            .map_err(|e| format!("发布消息失败: {e}"))?;
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
