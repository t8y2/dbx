//! MQTT 客户端封装（基于 rumqttc），管理 MQTT broker 的长连接和消息收发。

use std::collections::HashSet;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use rumqttc::v5::{
    mqttbytes::QoS as QoSV5, AsyncClient as AsyncClientV5, Event as EventV5, Incoming as IncomingV5,
    MqttOptions as MqttOptionsV5,
};
use rumqttc::{
    mqttbytes::Protocol, AsyncClient as AsyncClientV4, Event as EventV4, Incoming as IncomingV4,
    MqttOptions as MqttOptionsV4, Outgoing, QoS as QoSV4, TlsConfiguration, Transport,
};
use tokio::sync::{oneshot, Notify, RwLock};
use tokio::task::JoinHandle;

use super::types::{
    MqttAuth, MqttBrokerInfo, MqttConnectionConfig, MqttMessage, MqttMessageDirection, MqttPublishRequest, MqttQoS,
    MqttTlsVerificationMode, MqttTopicNode, MqttTransport,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MqttBackendKind {
    V4,
    V5,
}

enum MqttBackendClient {
    V4(AsyncClientV4),
    V5(AsyncClientV5),
}

struct MqttConnectPlan {
    backend: MqttBackendKind,
    broker_addr: String,
    transport: Transport,
    protocol: Option<Protocol>,
}

/// 持久化的 MQTT 异步客户端
pub struct MqttClient {
    /// rumqttc 异步客户端
    backend: MqttBackendClient,
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
    /// 通知事件循环强制退出的信号
    shutdown_notify: Arc<Notify>,
}

impl MqttClient {
    /// 创建新的 MQTT 客户端并建立连接。
    /// 等待 CONNACK 确认连接成功，超时时间由 `config.connect_timeout_secs` 指定。
    pub async fn connect(config: MqttConnectionConfig) -> Result<Arc<Self>, String> {
        let plan = build_connect_plan(&config);
        match plan.backend {
            MqttBackendKind::V4 => Self::connect_v4(config, plan).await,
            MqttBackendKind::V5 => Self::connect_v5(config, plan).await,
        }
    }

    async fn connect_v4(config: MqttConnectionConfig, plan: MqttConnectPlan) -> Result<Arc<Self>, String> {
        let client_id = config.client_id.clone();
        let connect_timeout = Duration::from_secs(config.connect_timeout_secs);
        let mut mqtt_options = MqttOptionsV4::new(&client_id, &plan.broker_addr, config.port);
        mqtt_options.set_keep_alive(Duration::from_secs(config.keep_alive_secs));
        mqtt_options.set_transport(plan.transport);
        if let Some(protocol) = plan.protocol {
            mqtt_options.set_protocol(protocol);
        }
        apply_credentials_v4(&mut mqtt_options, &config.auth);

        let (client, event_loop) = AsyncClientV4::new(mqtt_options, 100);
        let shutdown_notify = Arc::new(Notify::new());
        let instance = Self::new_with_backend(config, MqttBackendClient::V4(client), Arc::clone(&shutdown_notify));

        let (connack_tx, connack_rx) = oneshot::channel();
        let handle = Self::spawn_v4_event_loop(Arc::downgrade(&instance), event_loop, shutdown_notify, connack_tx);
        Self::wait_for_connack(instance, handle, connack_rx, connect_timeout).await
    }

    async fn connect_v5(config: MqttConnectionConfig, plan: MqttConnectPlan) -> Result<Arc<Self>, String> {
        let client_id = config.client_id.clone();
        let connect_timeout = Duration::from_secs(config.connect_timeout_secs);
        let mut mqtt_options = MqttOptionsV5::new(&client_id, &plan.broker_addr, config.port);
        mqtt_options.set_keep_alive(Duration::from_secs(config.keep_alive_secs));
        mqtt_options.set_transport(plan.transport);
        apply_credentials_v5(&mut mqtt_options, &config.auth);

        let (client, event_loop) = AsyncClientV5::new(mqtt_options, 100);
        let shutdown_notify = Arc::new(Notify::new());
        let instance = Self::new_with_backend(config, MqttBackendClient::V5(client), Arc::clone(&shutdown_notify));

        let (connack_tx, connack_rx) = oneshot::channel();
        let handle = Self::spawn_v5_event_loop(Arc::downgrade(&instance), event_loop, shutdown_notify, connack_tx);
        Self::wait_for_connack(instance, handle, connack_rx, connect_timeout).await
    }

    fn new_with_backend(
        config: MqttConnectionConfig,
        backend: MqttBackendClient,
        shutdown_notify: Arc<Notify>,
    ) -> Arc<Self> {
        Arc::new(Self {
            backend,
            config,
            subscriptions: RwLock::new(Vec::new()),
            message_buffer: RwLock::new(Vec::new()),
            max_buffer_size: 200,
            seen_retained: RwLock::new(HashSet::new()),
            event_loop_handle: RwLock::new(None),
            shutdown_notify,
        })
    }

    fn spawn_v4_event_loop(
        instance: Weak<Self>,
        mut event_loop: rumqttc::EventLoop,
        shutdown_notify: Arc<Notify>,
        connack_tx: oneshot::Sender<Result<(), String>>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut connack_tx = Some(connack_tx);
            loop {
                tokio::select! {
                    event = event_loop.poll() => {
                        match event {
                            Ok(EventV4::Incoming(IncomingV4::ConnAck(connack))) => {
                                log::info!(
                                    "MQTT CONNACK 已收到: session_present={}, code={:?}",
                                    connack.session_present,
                                    connack.code
                                );
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Ok(()));
                                }
                            }
                            Ok(EventV4::Incoming(IncomingV4::Publish(publish))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                Self::record_received_publish(
                                    &instance,
                                    publish.topic.as_bytes(),
                                    publish.payload.as_ref(),
                                    qos_to_u8(publish.qos),
                                    publish.retain,
                                ).await;
                            }
                            Ok(EventV4::Incoming(IncomingV4::Disconnect)) => {
                                log::info!("MQTT broker 发送了 DISCONNECT，事件循环退出");
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err("MQTT broker 在 CONNACK 之前断开了连接".to_string()));
                                }
                                break;
                            }
                            Ok(EventV4::Outgoing(Outgoing::Disconnect)) => {
                                log::info!("MQTT DISCONNECT 已发送，事件循环退出");
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                log::warn!("MQTT 事件循环错误: {e}");
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err(format!("MQTT 连接失败（未收到 CONNACK）: {e}")));
                                }
                                break;
                            }
                        }
                    }
                    _ = shutdown_notify.notified() => {
                        log::info!("MQTT 事件循环收到强制关闭信号，正在退出");
                        if let Some(tx) = connack_tx.take() {
                            let _ = tx.send(Err("MQTT 连接已取消".to_string()));
                        }
                        break;
                    }
                }
            }
        })
    }

    fn spawn_v5_event_loop(
        instance: Weak<Self>,
        mut event_loop: rumqttc::v5::EventLoop,
        shutdown_notify: Arc<Notify>,
        connack_tx: oneshot::Sender<Result<(), String>>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut connack_tx = Some(connack_tx);
            loop {
                tokio::select! {
                    event = event_loop.poll() => {
                        match event {
                            Ok(EventV5::Incoming(IncomingV5::ConnAck(connack))) => {
                                log::info!(
                                    "MQTT v5 CONNACK 已收到: session_present={}, code={:?}",
                                    connack.session_present,
                                    connack.code
                                );
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Ok(()));
                                }
                            }
                            Ok(EventV5::Incoming(IncomingV5::Publish(publish))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                Self::record_received_publish(
                                    &instance,
                                    publish.topic.as_ref(),
                                    publish.payload.as_ref(),
                                    qos_v5_to_u8(publish.qos),
                                    publish.retain,
                                ).await;
                            }
                            Ok(EventV5::Incoming(IncomingV5::Disconnect(_))) => {
                                log::info!("MQTT v5 broker 发送了 DISCONNECT，事件循环退出");
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err("MQTT broker 在 CONNACK 之前断开了连接".to_string()));
                                }
                                break;
                            }
                            Ok(EventV5::Outgoing(Outgoing::Disconnect)) => {
                                log::info!("MQTT v5 DISCONNECT 已发送，事件循环退出");
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                log::warn!("MQTT v5 事件循环错误: {e}");
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err(format!("MQTT 连接失败（未收到 CONNACK）: {e}")));
                                }
                                break;
                            }
                        }
                    }
                    _ = shutdown_notify.notified() => {
                        log::info!("MQTT v5 事件循环收到强制关闭信号，正在退出");
                        if let Some(tx) = connack_tx.take() {
                            let _ = tx.send(Err("MQTT 连接已取消".to_string()));
                        }
                        break;
                    }
                }
            }
        })
    }

    async fn wait_for_connack(
        instance: Arc<Self>,
        handle: JoinHandle<()>,
        connack_rx: oneshot::Receiver<Result<(), String>>,
        connect_timeout: Duration,
    ) -> Result<Arc<Self>, String> {
        match tokio::time::timeout(connect_timeout, connack_rx).await {
            Ok(Ok(Ok(()))) => {
                {
                    let mut handle_lock = instance.event_loop_handle.write().await;
                    *handle_lock = Some(handle);
                }
                log::info!("MQTT 客户端已成功连接到 {}", instance.config.broker_url());
                Ok(instance)
            }
            Ok(Ok(Err(e))) => {
                handle.abort();
                let _ = handle.await;
                Err(e)
            }
            Ok(Err(_)) => {
                handle.abort();
                let _ = handle.await;
                Err("MQTT 事件循环意外退出，未收到 CONNACK".to_string())
            }
            Err(_) => {
                handle.abort();
                let _ = handle.await;
                Err(format!("MQTT 连接超时：{} 秒内未收到 CONNACK", connect_timeout.as_secs()))
            }
        }
    }

    async fn record_received_publish(instance: &Self, topic: &[u8], payload: &[u8], qos: u8, retain: bool) {
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let topic = decode_utf8_lossy(topic);
        let payload_base64 = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(payload)
        };

        if retain {
            let mut seen = instance.seen_retained.write().await;
            let key = (topic.clone(), payload_base64.clone());
            if !seen.insert(key) {
                return;
            }
        }

        let payload_text = String::from_utf8(payload.to_vec()).ok();
        let msg = MqttMessage {
            topic,
            payload_base64,
            payload_text,
            qos,
            retain,
            received_at_ms: now_ms,
            direction: MqttMessageDirection::Received,
        };

        let mut buffer = instance.message_buffer.write().await;
        buffer.push(msg);
        if buffer.len() > instance.max_buffer_size {
            buffer.remove(0);
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
        let rumqttc_qos = mqtt_qos(qos);
        self.backend.subscribe(topic, rumqttc_qos).await?;

        let mut subscriptions = self.subscriptions.write().await;
        if !subscriptions.iter().any(|(t, _)| t == topic) {
            subscriptions.push((topic.to_string(), qos));
        }
        Ok(())
    }

    /// 取消订阅 topic
    pub async fn unsubscribe(&self, topic: &str) -> Result<(), String> {
        self.backend.unsubscribe(topic).await?;

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

        let qos = mqtt_qos(request.qos);
        self.backend.publish(&request.topic, qos, request.retain, payload.clone()).await?;

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
            qos: qos_to_u8(qos),
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

    /// 优雅关闭：发送 DISCONNECT，等待事件循环退出；超时后强制中止后台任务。
    /// 调用此方法后不应再使用该客户端。
    pub async fn disconnect(&self) {
        log::info!("MQTT 客户端正在断开连接...");

        if let Err(err) = self.backend.disconnect().await {
            log::warn!("MQTT DISCONNECT 请求发送失败: {err}");
        }

        let mut handle_lock = self.event_loop_handle.write().await;
        if let Some(mut handle) = handle_lock.take() {
            tokio::select! {
                result = &mut handle => {
                    let _ = result;
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    log::warn!("MQTT 事件循环未在 5 秒内退出，正在强制中止");
                    self.shutdown_notify.notify_waiters();
                    handle.abort();
                    let _ = handle.await;
                }
            }
        }
    }
}

impl Drop for MqttClient {
    fn drop(&mut self) {
        self.shutdown_notify.notify_one();
    }
}

impl MqttBackendClient {
    async fn subscribe(&self, topic: &str, qos: QoSV4) -> Result<(), String> {
        match self {
            MqttBackendClient::V4(client) => {
                client.subscribe(topic, qos).await.map_err(|e| format!("订阅 topic 失败: {e}"))
            }
            MqttBackendClient::V5(client) => {
                client.subscribe(topic, qos_v4_to_v5(qos)).await.map_err(|e| format!("订阅 topic 失败: {e}"))
            }
        }
    }

    async fn unsubscribe(&self, topic: &str) -> Result<(), String> {
        match self {
            MqttBackendClient::V4(client) => {
                client.unsubscribe(topic).await.map_err(|e| format!("取消订阅 topic 失败: {e}"))
            }
            MqttBackendClient::V5(client) => {
                client.unsubscribe(topic).await.map_err(|e| format!("取消订阅 topic 失败: {e}"))
            }
        }
    }

    async fn publish(&self, topic: &str, qos: QoSV4, retain: bool, payload: Vec<u8>) -> Result<(), String> {
        match self {
            MqttBackendClient::V4(client) => {
                client.publish(topic, qos, retain, payload).await.map_err(|e| format!("发布消息失败: {e}"))
            }
            MqttBackendClient::V5(client) => client
                .publish(topic, qos_v4_to_v5(qos), retain, payload)
                .await
                .map_err(|e| format!("发布消息失败: {e}")),
        }
    }

    async fn disconnect(&self) -> Result<(), String> {
        match self {
            MqttBackendClient::V4(client) => client.disconnect().await.map_err(|e| format!("断开 MQTT 连接失败: {e}")),
            MqttBackendClient::V5(client) => client.disconnect().await.map_err(|e| format!("断开 MQTT 连接失败: {e}")),
        }
    }
}

fn build_connect_plan(config: &MqttConnectionConfig) -> MqttConnectPlan {
    let backend = match config.protocol_version {
        super::types::MqttProtocolVersion::V3 | super::types::MqttProtocolVersion::V4 => MqttBackendKind::V4,
        super::types::MqttProtocolVersion::V5 => MqttBackendKind::V5,
    };
    let protocol = match config.protocol_version {
        super::types::MqttProtocolVersion::V3 => Some(Protocol::V3),
        super::types::MqttProtocolVersion::V4 => Some(Protocol::V4),
        super::types::MqttProtocolVersion::V5 => None,
    };
    let tls_verification_mode = config.tls_verification_mode();
    let transport = build_transport(config.transport, tls_verification_mode);

    MqttConnectPlan { backend, broker_addr: config.broker_addr_for_transport(), transport, protocol }
}

fn build_transport(transport: MqttTransport, tls_verification_mode: Option<MqttTlsVerificationMode>) -> Transport {
    match (transport, tls_verification_mode) {
        (MqttTransport::Tcp, None) => Transport::Tcp,
        (MqttTransport::Tcp, Some(MqttTlsVerificationMode::VerifyServerCert)) => Transport::tls_with_default_config(),
        (MqttTransport::Tcp, Some(MqttTlsVerificationMode::SkipServerCertVerification)) => {
            Transport::tls_with_config(insecure_tls_configuration())
        }
        (MqttTransport::WebSocket, None) => Transport::ws(),
        (MqttTransport::WebSocket, Some(MqttTlsVerificationMode::VerifyServerCert)) => {
            Transport::wss_with_default_config()
        }
        (MqttTransport::WebSocket, Some(MqttTlsVerificationMode::SkipServerCertVerification)) => {
            Transport::wss_with_config(insecure_tls_configuration())
        }
    }
}

fn insecure_tls_configuration() -> TlsConfiguration {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertificateVerification { provider }))
        .with_no_client_auth();
    TlsConfiguration::from(config)
}

#[derive(Debug)]
struct NoCertificateVerification {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn apply_credentials_v4(options: &mut MqttOptionsV4, auth: &MqttAuth) {
    if let MqttAuth::Password { username, password } = auth {
        options.set_credentials(username, password);
    }
}

fn apply_credentials_v5(options: &mut MqttOptionsV5, auth: &MqttAuth) {
    if let MqttAuth::Password { username, password } = auth {
        options.set_credentials(username, password);
    }
}

fn mqtt_qos(qos: MqttQoS) -> QoSV4 {
    match qos {
        MqttQoS::AtMostOnce => QoSV4::AtMostOnce,
        MqttQoS::AtLeastOnce => QoSV4::AtLeastOnce,
        MqttQoS::ExactlyOnce => QoSV4::ExactlyOnce,
    }
}

fn qos_to_u8(qos: QoSV4) -> u8 {
    match qos {
        QoSV4::AtMostOnce => 0,
        QoSV4::AtLeastOnce => 1,
        QoSV4::ExactlyOnce => 2,
    }
}

fn qos_v5_to_u8(qos: QoSV5) -> u8 {
    match qos {
        QoSV5::AtMostOnce => 0,
        QoSV5::AtLeastOnce => 1,
        QoSV5::ExactlyOnce => 2,
    }
}

fn qos_v4_to_v5(qos: QoSV4) -> QoSV5 {
    match qos {
        QoSV4::AtMostOnce => QoSV5::AtMostOnce,
        QoSV4::AtLeastOnce => QoSV5::AtLeastOnce,
        QoSV4::ExactlyOnce => QoSV5::ExactlyOnce,
    }
}

fn decode_utf8_lossy(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
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
    use std::time::Duration;

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

    #[test]
    fn connect_plan_uses_ws_path_and_insecure_tls_transport() {
        let config = MqttConnectionConfig {
            host: "broker.example.com".to_string(),
            port: 8084,
            transport: MqttTransport::WebSocket,
            tls: true,
            tls_skip_verify: true,
            ws_path: Some("/custom/mqtt".to_string()),
            ..Default::default()
        };

        let plan = build_connect_plan(&config);
        assert_eq!(plan.broker_addr, "wss://broker.example.com:8084/custom/mqtt");
        assert_eq!(plan.backend, MqttBackendKind::V5);
        match plan.transport {
            Transport::Wss(TlsConfiguration::Rustls(_)) => {}
            _ => panic!("tlsSkipVerify 应使用显式 Rustls 自定义校验器"),
        }
    }

    #[tokio::test]
    async fn connect_applies_selected_protocol_versions() {
        assert_v4_connect_protocol(crate::mqtt::types::MqttProtocolVersion::V3, Protocol::V3).await;
        assert_v4_connect_protocol(crate::mqtt::types::MqttProtocolVersion::V4, Protocol::V4).await;
        assert_v5_connect_protocol().await;
    }

    #[tokio::test]
    async fn service_test_connection_disconnects_each_session() {
        let (port, broker) = spawn_v5_mock_broker(2).await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V5);

        let first = crate::mqtt::service::test_connection(&config).await.unwrap();
        assert_eq!(first.protocol_version, "MQTT 5.0");
        let second = crate::mqtt::service::test_connection(&config).await.unwrap();
        assert_eq!(second.protocol_version, "MQTT 5.0");

        await_broker(broker).await;
    }

    #[tokio::test]
    async fn failed_test_connection_closes_session_and_event_loop() {
        let (port, broker) = spawn_stalled_v5_mock_broker().await;
        let mut config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V5);
        config.connect_timeout_secs = 1;

        let error = crate::mqtt::service::test_connection(&config).await.unwrap_err();
        assert!(error.contains("连接超时"), "unexpected error: {error}");

        await_broker(broker).await;
    }

    #[tokio::test]
    async fn dropping_client_closes_session_and_event_loop() {
        let (port, broker) = spawn_v5_mock_broker_expecting_eof().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V5);

        let client = MqttClient::connect(config).await.unwrap();
        drop(client);

        await_broker(broker).await;
    }

    async fn assert_v4_connect_protocol(protocol_version: crate::mqtt::types::MqttProtocolVersion, expected: Protocol) {
        let (port, broker) = spawn_v4_mock_broker(expected, 1).await;
        let config = mqtt_config(port, protocol_version);
        let client = MqttClient::connect(config).await.unwrap();
        client.disconnect().await;
        await_broker(broker).await;
    }

    async fn assert_v5_connect_protocol() {
        let (port, broker) = spawn_v5_mock_broker(1).await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V5);
        let client = MqttClient::connect(config).await.unwrap();
        client.disconnect().await;
        await_broker(broker).await;
    }

    fn mqtt_config(port: u16, protocol_version: crate::mqtt::types::MqttProtocolVersion) -> MqttConnectionConfig {
        MqttConnectionConfig {
            host: "127.0.0.1".to_string(),
            port,
            client_id: format!("dbx-test-{}", uuid::Uuid::new_v4()),
            protocol_version,
            connect_timeout_secs: 5,
            ..Default::default()
        }
    }

    async fn spawn_v4_mock_broker(
        expected_protocol: Protocol,
        expected_connections: usize,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            for _ in 0..expected_connections {
                let (mut stream, _) = listener.accept().await.unwrap();
                let frame = read_mqtt_frame(&mut stream).await.unwrap();
                let mut bytes = BytesMut::from(&frame[..]);
                let packet = rumqttc::mqttbytes::v4::read(&mut bytes, 1024 * 1024).unwrap();
                match packet {
                    rumqttc::mqttbytes::v4::Packet::Connect(connect) => assert_eq!(connect.protocol, expected_protocol),
                    other => panic!("unexpected packet: {other:?}"),
                }

                stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
                let frame = read_mqtt_frame(&mut stream).await.unwrap();
                let mut bytes = BytesMut::from(&frame[..]);
                let packet = rumqttc::mqttbytes::v4::read(&mut bytes, 1024 * 1024).unwrap();
                assert!(matches!(packet, rumqttc::mqttbytes::v4::Packet::Disconnect));
            }
        });
        (port, handle)
    }

    async fn spawn_v5_mock_broker(expected_connections: usize) -> (u16, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            for _ in 0..expected_connections {
                let (mut stream, _) = listener.accept().await.unwrap();
                let frame = read_mqtt_frame(&mut stream).await.unwrap();
                let mut bytes = BytesMut::from(&frame[..]);
                let packet = rumqttc::v5::mqttbytes::v5::Packet::read(&mut bytes, Some(1024 * 1024)).unwrap();
                match packet {
                    rumqttc::v5::mqttbytes::v5::Packet::Connect(connect, _, _) => {
                        assert!(connect.client_id.starts_with("dbx-test-"));
                    }
                    other => panic!("unexpected packet: {other:?}"),
                }

                let connack = rumqttc::v5::mqttbytes::v5::ConnAck {
                    session_present: false,
                    code: rumqttc::v5::mqttbytes::v5::ConnectReturnCode::Success,
                    properties: None,
                };
                let mut connack_bytes = BytesMut::new();
                connack.write(&mut connack_bytes).unwrap();
                stream.write_all(&connack_bytes).await.unwrap();

                let frame = read_mqtt_frame(&mut stream).await.unwrap();
                assert_eq!(frame, vec![0xe0, 0x00]);
            }
        });
        (port, handle)
    }

    async fn spawn_stalled_v5_mock_broker() -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            expect_stream_closed(&mut stream).await;
        });
        (port, handle)
    }

    async fn spawn_v5_mock_broker_expecting_eof() -> (u16, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();

            let connack = rumqttc::v5::mqttbytes::v5::ConnAck {
                session_present: false,
                code: rumqttc::v5::mqttbytes::v5::ConnectReturnCode::Success,
                properties: None,
            };
            let mut connack_bytes = BytesMut::new();
            connack.write(&mut connack_bytes).unwrap();
            stream.write_all(&connack_bytes).await.unwrap();

            expect_stream_closed(&mut stream).await;
        });
        (port, handle)
    }

    async fn expect_stream_closed(stream: &mut tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;

        let mut byte = [0u8; 1];
        let bytes_read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
            .await
            .expect("MQTT session was not closed")
            .expect("failed to read MQTT session state");
        assert_eq!(bytes_read, 0, "unexpected MQTT data after client cleanup");
    }

    async fn read_mqtt_frame(stream: &mut tokio::net::TcpStream) -> std::io::Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;

        let mut first = [0u8; 1];
        stream.read_exact(&mut first).await?;
        let mut len_bytes = Vec::new();
        let mut remaining_len = 0usize;
        let mut multiplier = 1usize;
        loop {
            let mut byte = [0u8; 1];
            stream.read_exact(&mut byte).await?;
            len_bytes.push(byte[0]);
            remaining_len += ((byte[0] & 0x7f) as usize) * multiplier;
            if (byte[0] & 0x80) == 0 {
                break;
            }
            multiplier *= 128;
        }

        let mut rest = vec![0u8; remaining_len];
        stream.read_exact(&mut rest).await?;
        let mut frame = Vec::with_capacity(1 + len_bytes.len() + rest.len());
        frame.push(first[0]);
        frame.extend(len_bytes);
        frame.extend(rest);
        Ok(frame)
    }

    async fn await_broker(handle: tokio::task::JoinHandle<()>) {
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("mock broker timed out")
            .expect("mock broker task failed");
    }
}
