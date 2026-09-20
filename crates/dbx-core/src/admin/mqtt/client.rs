//! MQTT 客户端封装（基于 rumqttc），管理 MQTT broker 的长连接和消息收发。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rumqttc::tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use rumqttc::v5::{
    mqttbytes::{v5::Filter as MqttV5Filter, QoS as QoSV5},
    AsyncClient as AsyncClientV5, Event as EventV5, Incoming as IncomingV5, MqttOptions as MqttOptionsV5,
};
use rumqttc::{
    mqttbytes::Protocol, valid_filter, valid_topic, AsyncClient as AsyncClientV4, Event as EventV4,
    Incoming as IncomingV4, MqttOptions as MqttOptionsV4, Outgoing, QoS as QoSV4, TlsConfiguration, Transport,
};
use sha2::{Digest, Sha256};
use tokio::sync::{oneshot, Mutex, Notify, RwLock};
use tokio::task::JoinHandle;

use super::types::{
    MqttAuth, MqttBrokerInfo, MqttConnectionConfig, MqttMessage, MqttMessageDirection, MqttPublishRequest, MqttQoS,
    MqttSavedTopic, MqttTlsVerificationMode, MqttTopicNode, MqttTransport,
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

const MQTT_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const RETAINED_DEDUP_CAPACITY: usize = 512;

type SubscriptionCompletion = oneshot::Sender<Result<(), String>>;
type PublishCompletion = oneshot::Sender<Result<(), String>>;

struct PendingSubscribe {
    sequence: u64,
    topic: String,
    qos: MqttQoS,
    no_local: bool,
    add_to_desired: bool,
    completion: Option<SubscriptionCompletion>,
}

struct PendingUnsubscribe {
    sequence: u64,
    topic: String,
    completion: Option<SubscriptionCompletion>,
}

struct PendingPublish {
    sequence: u64,
    qos: QoSV4,
    message: MqttMessage,
    completion: Option<PublishCompletion>,
}

impl PendingPublish {
    fn fail(&mut self, error: &str) {
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(Err(error.to_string()));
        }
    }
}

#[derive(Default)]
struct PublishRequestTracker {
    next_sequence: u64,
    queued: VecDeque<PendingPublish>,
    inflight: HashMap<u16, PendingPublish>,
    orphaned_queued: usize,
    orphaned_inflight: HashSet<u16>,
}

impl PublishRequestTracker {
    fn queue(&mut self, qos: QoSV4, message: MqttMessage, completion: PublishCompletion) -> u64 {
        self.next_sequence = self.next_sequence.wrapping_add(1);
        let sequence = self.next_sequence;
        self.queued.push_back(PendingPublish { sequence, qos, message, completion: Some(completion) });
        sequence
    }

    fn remove_queued(&mut self, sequence: u64) {
        self.queued.retain(|pending| pending.sequence != sequence);
    }

    fn mark_outgoing(&mut self, pkid: u16) -> Option<PendingPublish> {
        if pkid != 0 && (self.inflight.contains_key(&pkid) || self.orphaned_inflight.contains(&pkid)) {
            return None;
        }
        if self.orphaned_queued > 0 {
            self.orphaned_queued -= 1;
            if pkid != 0 {
                self.orphaned_inflight.insert(pkid);
            }
            return None;
        }
        let Some(pending) = self.queued.pop_front() else {
            log::warn!("MQTT PUBLISH 已发送，但未找到对应的本地待确认请求: pkid={pkid}");
            return None;
        };
        if pending.qos == QoSV4::AtMostOnce {
            return Some(pending);
        }
        self.inflight.insert(pkid, pending);
        None
    }

    fn take_acknowledged(&mut self, pkid: u16) -> Option<PendingPublish> {
        if self.orphaned_inflight.remove(&pkid) {
            return None;
        }
        self.inflight.remove(&pkid)
    }

    fn fail_next_queued(&mut self, error: &str) {
        if let Some(mut pending) = self.queued.pop_front() {
            pending.fail(error);
        } else {
            log::warn!("MQTT 事件循环拒绝了 PUBLISH，但没有找到对应的本地请求: {error}");
        }
    }

    fn take_for_connection_loss(&mut self) -> Vec<PendingPublish> {
        self.orphaned_queued = self.orphaned_queued.saturating_add(self.queued.len());
        let mut pending = self.queued.drain(..).collect::<Vec<_>>();
        for (pkid, request) in self.inflight.drain() {
            self.orphaned_inflight.insert(pkid);
            pending.push(request);
        }
        pending.sort_by_key(|request| request.sequence);
        pending
    }
    fn take_all(&mut self) -> Vec<PendingPublish> {
        let mut pending = self.queued.drain(..).collect::<Vec<_>>();
        pending.extend(self.inflight.drain().map(|(_, request)| request));
        pending.sort_by_key(|request| request.sequence);
        pending
    }
}

struct RetainedDedup {
    capacity: usize,
    order: VecDeque<(String, [u8; 32])>,
    entries: HashSet<(String, [u8; 32])>,
}

impl RetainedDedup {
    fn new(capacity: usize) -> Self {
        Self { capacity, order: VecDeque::with_capacity(capacity), entries: HashSet::with_capacity(capacity) }
    }

    fn insert(&mut self, topic: &str, payload: &[u8]) -> bool {
        let digest: [u8; 32] = Sha256::digest(payload).into();
        let key = (topic.to_string(), digest);
        if !self.entries.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        true
    }

    fn clear_filter(&mut self, filter: &str) {
        self.order.retain(|(topic, _)| !topic_matches_filter(topic, filter));
        self.entries.retain(|(topic, _)| !topic_matches_filter(topic, filter));
    }

    fn clear(&mut self) {
        self.order.clear();
        self.entries.clear();
    }
}

enum PendingSubscriptionAction {
    Subscribe(PendingSubscribe),
    Unsubscribe(PendingUnsubscribe),
}

impl PendingSubscriptionAction {
    fn sequence(&self) -> u64 {
        match self {
            Self::Subscribe(pending) => pending.sequence,
            Self::Unsubscribe(pending) => pending.sequence,
        }
    }

    fn fail(self, error: &str) {
        let completion = match self {
            Self::Subscribe(pending) => pending.completion,
            Self::Unsubscribe(pending) => pending.completion,
        };
        if let Some(completion) = completion {
            let _ = completion.send(Err(error.to_string()));
        }
    }
}

#[derive(Default)]
struct SubscriptionRequestTracker {
    next_sequence: u64,
    queued_subscribes: VecDeque<PendingSubscribe>,
    queued_unsubscribes: VecDeque<PendingUnsubscribe>,
    inflight_subscribes: HashMap<u16, PendingSubscribe>,
    inflight_unsubscribes: HashMap<u16, PendingUnsubscribe>,
}

impl SubscriptionRequestTracker {
    fn next_sequence(&mut self) -> u64 {
        self.next_sequence = self.next_sequence.wrapping_add(1);
        self.next_sequence
    }

    fn mark_subscribe_outgoing(&mut self, pkid: u16) {
        if self.inflight_subscribes.contains_key(&pkid) {
            return;
        }
        if let Some(pending) = self.queued_subscribes.pop_front() {
            self.inflight_subscribes.insert(pkid, pending);
        } else {
            log::warn!("MQTT SUBSCRIBE 已发送，但未找到对应的本地待确认请求: pkid={pkid}");
        }
    }

    fn mark_unsubscribe_outgoing(&mut self, pkid: u16) {
        if self.inflight_unsubscribes.contains_key(&pkid) {
            return;
        }
        if let Some(pending) = self.queued_unsubscribes.pop_front() {
            self.inflight_unsubscribes.insert(pkid, pending);
        } else {
            log::warn!("MQTT UNSUBSCRIBE 已发送，但未找到对应的本地待确认请求: pkid={pkid}");
        }
    }

    fn take_subscribe(&mut self, pkid: u16) -> Option<PendingSubscribe> {
        self.inflight_subscribes.remove(&pkid)
    }

    fn take_unsubscribe(&mut self, pkid: u16) -> Option<PendingUnsubscribe> {
        self.inflight_unsubscribes.remove(&pkid)
    }

    fn take_inflight(&mut self) -> Vec<PendingSubscriptionAction> {
        let mut pending = self
            .inflight_subscribes
            .drain()
            .map(|(_, request)| PendingSubscriptionAction::Subscribe(request))
            .chain(
                self.inflight_unsubscribes.drain().map(|(_, request)| PendingSubscriptionAction::Unsubscribe(request)),
            )
            .collect::<Vec<_>>();
        pending.sort_by_key(PendingSubscriptionAction::sequence);
        pending
    }

    fn take_all(&mut self) -> Vec<PendingSubscriptionAction> {
        let mut pending = self
            .queued_subscribes
            .drain(..)
            .map(PendingSubscriptionAction::Subscribe)
            .chain(self.queued_unsubscribes.drain(..).map(PendingSubscriptionAction::Unsubscribe))
            .collect::<Vec<_>>();
        pending.extend(self.take_inflight());
        pending.sort_by_key(PendingSubscriptionAction::sequence);
        pending
    }

    fn has_pending_topic(&self, topic: &str) -> bool {
        self.queued_subscribes.iter().any(|pending| pending.topic == topic)
            || self.queued_unsubscribes.iter().any(|pending| pending.topic == topic)
            || self.inflight_subscribes.values().any(|pending| pending.topic == topic)
            || self.inflight_unsubscribes.values().any(|pending| pending.topic == topic)
    }
}

/// 持久化的 MQTT 异步客户端
pub struct MqttClient {
    /// rumqttc 异步客户端
    backend: MqttBackendClient,
    /// 连接配置
    config: MqttConnectionConfig,
    /// 当前 broker 已通过 ACK 确认的 topic 集合
    subscriptions: RwLock<Vec<(String, MqttQoS)>>,
    /// broker 最近一次实际授予的 QoS，用于恢复持久会话的显示状态
    granted_subscriptions: RwLock<Vec<(String, MqttQoS)>>,
    /// 需要在无会话重连后恢复的 topic 集合
    desired_subscriptions: RwLock<Vec<(String, MqttQoS)>>,
    /// All persisted subscription configurations, including disabled entries.
    saved_topic_configs: RwLock<Vec<MqttSavedTopic>>,
    no_local_topics: RwLock<HashSet<String>>,
    /// 当前连接是否已收到有效 CONNACK
    connected: AtomicBool,
    /// 订阅请求与 packet id 的关联状态
    subscription_requests: Mutex<SubscriptionRequestTracker>,
    /// 保证本地排队顺序与 rumqttc 请求通道顺序一致
    subscription_send_lock: Mutex<()>,
    /// 发布请求与 PUBLISH/PUBACK/PUBCOMP 的关联状态
    publish_requests: Mutex<PublishRequestTracker>,
    /// 保证本地发布排队顺序与 rumqttc 请求通道顺序一致
    publish_send_lock: Mutex<()>,
    /// 最近接收的消息缓冲区（保留最近 N 条）
    message_buffer: RwLock<Vec<MqttMessage>>,
    /// 最大缓冲消息数
    max_buffer_size: usize,
    /// 当前订阅生命周期内已见过的保留消息指纹
    seen_retained: RwLock<RetainedDedup>,
    /// 事件循环后台任务的 JoinHandle，用于优雅关闭时等待任务结束
    event_loop_handle: RwLock<Option<JoinHandle<()>>>,
    /// 通知事件循环强制退出的信号
    shutdown_notify: Arc<Notify>,
}

impl MqttClient {
    /// 创建新的 MQTT 客户端并建立连接。
    /// 等待 CONNACK 确认连接成功，超时时间由 `config.connect_timeout_secs` 指定。
    pub async fn connect(config: MqttConnectionConfig) -> Result<Arc<Self>, String> {
        if !(1024..=268_435_455).contains(&config.max_packet_size_bytes) {
            return Err("MQTT 最大报文大小必须在 1024 到 268435455 字节之间".to_string());
        }
        let plan = build_connect_plan(&config)?;
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
        mqtt_options.set_max_packet_size(config.max_packet_size_bytes, config.max_packet_size_bytes);
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
        mqtt_options.set_max_packet_size(Some(config.max_packet_size_bytes as u32));
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
        let saved_topic_configs = config.saved_topics.clone();
        let desired_subscriptions = saved_topic_configs
            .iter()
            .filter(|saved| saved.enabled)
            .map(|saved| (saved.topic.clone(), saved.qos))
            .collect();
        let no_local_topics = saved_topic_configs
            .iter()
            .filter(|saved| saved.enabled && saved.no_local)
            .map(|saved| saved.topic.clone())
            .collect();
        Arc::new(Self {
            backend,
            config,
            subscriptions: RwLock::new(Vec::new()),
            granted_subscriptions: RwLock::new(Vec::new()),
            desired_subscriptions: RwLock::new(desired_subscriptions),
            saved_topic_configs: RwLock::new(saved_topic_configs),
            no_local_topics: RwLock::new(no_local_topics),
            connected: AtomicBool::new(false),
            subscription_requests: Mutex::new(SubscriptionRequestTracker::default()),
            subscription_send_lock: Mutex::new(()),
            publish_requests: Mutex::new(PublishRequestTracker::default()),
            publish_send_lock: Mutex::new(()),
            message_buffer: RwLock::new(Vec::new()),
            max_buffer_size: 200,
            seen_retained: RwLock::new(RetainedDedup::new(RETAINED_DEDUP_CAPACITY)),
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
                                let Some(instance) = instance.upgrade() else { break };
                                instance.handle_connack(connack.session_present).await;
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
                            Ok(EventV4::Incoming(IncomingV4::SubAck(suback))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                let result = match suback.return_codes.as_slice() {
                                    [rumqttc::SubscribeReasonCode::Success(qos)] => Ok(mqtt_qos_from_v4(*qos)),
                                    [rumqttc::SubscribeReasonCode::Failure] => {
                                        Err("MQTT broker 拒绝了订阅请求".to_string())
                                    }
                                    _ => Err("MQTT broker 返回的 SUBACK 数量与订阅请求不一致".to_string()),
                                };
                                instance.complete_subscribe_ack(suback.pkid, result).await;
                            }
                            Ok(EventV4::Incoming(IncomingV4::PubAck(puback))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.complete_publish_ack(puback.pkid).await;
                            }
                            Ok(EventV4::Incoming(IncomingV4::PubComp(pubcomp))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.complete_publish_ack(pubcomp.pkid).await;
                            }
                            Ok(EventV4::Incoming(IncomingV4::UnsubAck(unsuback))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.complete_unsubscribe_ack(unsuback.pkid, Ok(())).await;
                            }
                            Ok(EventV4::Incoming(IncomingV4::Disconnect)) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.handle_connection_lost("broker 主动断开连接").await;
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err("MQTT broker 在 CONNACK 之前断开了连接".to_string()));
                                    break;
                                }
                                log::warn!("MQTT broker 断开了连接，将在 1 秒后重新连接");
                                event_loop.clean();
                                tokio::time::sleep(MQTT_RECONNECT_DELAY).await;
                            }
                            Ok(EventV4::Outgoing(Outgoing::Publish(pkid))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.mark_publish_outgoing(pkid).await;
                            }
                            Ok(EventV4::Outgoing(Outgoing::Subscribe(pkid))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.mark_subscribe_outgoing(pkid).await;
                            }
                            Ok(EventV4::Outgoing(Outgoing::Unsubscribe(pkid))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.mark_unsubscribe_outgoing(pkid).await;
                            }
                            Ok(EventV4::Outgoing(Outgoing::Disconnect)) => {
                                log::info!("MQTT DISCONNECT 已发送，事件循环退出");
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                if let Some(instance) = instance.upgrade() {
                                    if matches!(
                                        &e,
                                        rumqttc::ConnectionError::MqttState(
                                            rumqttc::StateError::OutgoingPacketTooLarge { .. }
                                        )
                                    ) {
                                        instance.fail_next_queued_publish(&format!("发布消息失败：{e}")).await;
                                    }
                                    instance.handle_connection_lost(&e.to_string()).await;
                                }
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err(format!("MQTT 连接失败（未收到 CONNACK）: {e}")));
                                    break;
                                }
                                log::warn!("MQTT 连接发生异常，将在 1 秒后重新连接: {e}");
                                tokio::time::sleep(MQTT_RECONNECT_DELAY).await;
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
                                let Some(instance) = instance.upgrade() else { break };
                                instance.handle_connack(connack.session_present).await;
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
                            Ok(EventV5::Incoming(IncomingV5::SubAck(suback))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                let result = match suback.return_codes.as_slice() {
                                    [rumqttc::v5::mqttbytes::v5::SubscribeReasonCode::Success(qos)] => {
                                        Ok(mqtt_qos_from_v5(*qos))
                                    }
                                    [reason] => {
                                        let detail = suback
                                            .properties
                                            .as_ref()
                                            .and_then(|properties| properties.reason_string.as_deref())
                                            .map(|message| format!("，broker 提示：{message}"))
                                            .unwrap_or_default();
                                        Err(format!("MQTT v5 broker 拒绝了订阅请求：{reason:?}{detail}"))
                                    }
                                    _ => Err("MQTT v5 broker 返回的 SUBACK 数量与订阅请求不一致".to_string()),
                                };
                                instance.complete_subscribe_ack(suback.pkid, result).await;
                            }
                            Ok(EventV5::Incoming(IncomingV5::PubAck(puback))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.complete_publish_ack(puback.pkid).await;
                            }
                            Ok(EventV5::Incoming(IncomingV5::PubComp(pubcomp))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.complete_publish_ack(pubcomp.pkid).await;
                            }
                            Ok(EventV5::Incoming(IncomingV5::UnsubAck(unsuback))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                let rejected = unsuback.reasons.iter().find(|reason| {
                                    !matches!(
                                        reason,
                                        rumqttc::v5::mqttbytes::v5::UnsubAckReason::Success
                                            | rumqttc::v5::mqttbytes::v5::UnsubAckReason::NoSubscriptionExisted
                                    )
                                });
                                let result = rejected.map_or(Ok(()), |reason| {
                                    let detail = unsuback
                                        .properties
                                        .as_ref()
                                        .and_then(|properties| properties.reason_string.as_deref())
                                        .map(|message| format!("，broker 提示：{message}"))
                                        .unwrap_or_default();
                                    Err(format!("MQTT v5 broker 拒绝了取消订阅请求：{reason:?}{detail}"))
                                });
                                instance.complete_unsubscribe_ack(unsuback.pkid, result).await;
                            }
                            Ok(EventV5::Incoming(IncomingV5::Disconnect(disconnect))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.handle_connection_lost("broker 主动断开连接").await;
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err("MQTT broker 在 CONNACK 之前断开了连接".to_string()));
                                    break;
                                }
                                log::warn!("MQTT v5 broker 断开了连接，将在 1 秒后重新连接: {disconnect:?}");
                                event_loop.clean();
                                tokio::time::sleep(MQTT_RECONNECT_DELAY).await;
                            }
                            Ok(EventV5::Outgoing(Outgoing::Publish(pkid))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.mark_publish_outgoing(pkid).await;
                            }
                            Ok(EventV5::Outgoing(Outgoing::Subscribe(pkid))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.mark_subscribe_outgoing(pkid).await;
                            }
                            Ok(EventV5::Outgoing(Outgoing::Unsubscribe(pkid))) => {
                                let Some(instance) = instance.upgrade() else { break };
                                instance.mark_unsubscribe_outgoing(pkid).await;
                            }
                            Ok(EventV5::Outgoing(Outgoing::Disconnect)) => {
                                log::info!("MQTT v5 DISCONNECT 已发送，事件循环退出");
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                if let Some(instance) = instance.upgrade() {
                                    if matches!(
                                        &e,
                                        rumqttc::v5::ConnectionError::MqttState(
                                            rumqttc::v5::StateError::OutgoingPacketTooLarge { .. }
                                        )
                                    ) {
                                        instance.fail_next_queued_publish(&format!("发布消息失败：{e}")).await;
                                    }
                                    instance.handle_connection_lost(&e.to_string()).await;
                                }
                                if let Some(tx) = connack_tx.take() {
                                    let _ = tx.send(Err(format!("MQTT 连接失败（未收到 CONNACK）: {e}")));
                                    break;
                                }
                                log::warn!("MQTT v5 连接发生异常，将在 1 秒后重新连接: {e}");
                                tokio::time::sleep(MQTT_RECONNECT_DELAY).await;
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
            if !seen.insert(&topic, payload) {
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

    async fn handle_connack(self: &Arc<Self>, session_present: bool) {
        self.connected.store(true, Ordering::Release);

        if session_present {
            let granted = self.granted_subscriptions.read().await.clone();
            *self.subscriptions.write().await = granted;
            return;
        }

        self.subscriptions.write().await.clear();
        let instance = Arc::downgrade(self);
        tokio::spawn(async move {
            let Some(instance) = instance.upgrade() else {
                return;
            };
            instance.restore_desired_subscriptions().await;
        });
    }

    async fn handle_connection_lost(&self, reason: &str) {
        if self.connected.swap(false, Ordering::AcqRel) {
            log::warn!("MQTT 连接已断开: {reason}");
        }
        self.subscriptions.write().await.clear();

        let pending = self.subscription_requests.lock().await.take_inflight();
        for request in pending {
            request.fail("MQTT 连接在收到 broker 确认前中断，请重新执行该操作");
        }
        let mut pending_publishes = self.publish_requests.lock().await.take_for_connection_loss();
        for publish in &mut pending_publishes {
            publish.fail(&format!("发布消息未完成：MQTT 协议处理或连接失败（{reason}），请确认 broker 状态后重试"));
        }
    }

    async fn restore_desired_subscriptions(&self) {
        let desired = self.desired_subscriptions.read().await.clone();
        for (topic, qos) in desired {
            let has_pending = self.subscription_requests.lock().await.has_pending_topic(&topic);
            if has_pending {
                continue;
            }
            let no_local = self.no_local_topics.read().await.contains(&topic);
            if let Err(error) = self.queue_subscribe_request(topic.clone(), qos, no_local, false, None).await {
                log::warn!("MQTT 重连后恢复订阅 {topic} 失败: {error}");
            }
        }
    }

    async fn mark_subscribe_outgoing(&self, pkid: u16) {
        self.subscription_requests.lock().await.mark_subscribe_outgoing(pkid);
    }

    async fn mark_unsubscribe_outgoing(&self, pkid: u16) {
        self.subscription_requests.lock().await.mark_unsubscribe_outgoing(pkid);
    }

    async fn mark_publish_outgoing(&self, pkid: u16) {
        let pending = self.publish_requests.lock().await.mark_outgoing(pkid);
        if let Some(pending) = pending {
            self.complete_publish(pending).await;
        }
    }

    async fn complete_publish_ack(&self, pkid: u16) {
        let pending = self.publish_requests.lock().await.take_acknowledged(pkid);
        if let Some(pending) = pending {
            self.complete_publish(pending).await;
        } else {
            log::warn!("收到无法关联的 MQTT 发布确认: pkid={pkid}");
        }
    }

    async fn complete_publish(&self, mut pending: PendingPublish) {
        let mut buffer = self.message_buffer.write().await;
        buffer.push(pending.message);
        if buffer.len() > self.max_buffer_size {
            buffer.remove(0);
        }
        if let Some(completion) = pending.completion.take() {
            let _ = completion.send(Ok(()));
        }
    }

    async fn fail_next_queued_publish(&self, error: &str) {
        self.publish_requests.lock().await.fail_next_queued(error);
    }

    async fn complete_subscribe_ack(&self, pkid: u16, result: Result<MqttQoS, String>) {
        let Some(pending) = self.subscription_requests.lock().await.take_subscribe(pkid) else {
            log::warn!("收到无法关联的 MQTT SUBACK: pkid={pkid}");
            return;
        };

        let granted_qos = result.map_err(|error| format!("订阅主题“{}”失败：{error}", pending.topic));
        let completion_result = match granted_qos {
            Ok(granted_qos) => {
                upsert_subscription(&self.subscriptions, &pending.topic, granted_qos).await;
                upsert_subscription(&self.granted_subscriptions, &pending.topic, granted_qos).await;
                self.seen_retained.write().await.clear_filter(&pending.topic);
                if pending.add_to_desired {
                    if pending.no_local {
                        self.no_local_topics.write().await.insert(pending.topic.clone());
                    } else {
                        self.no_local_topics.write().await.remove(&pending.topic);
                    }
                    upsert_subscription(&self.desired_subscriptions, &pending.topic, pending.qos).await;
                    let mut saved = self.saved_topic_configs.write().await;
                    if let Some(config) = saved.iter_mut().find(|config| config.topic == pending.topic) {
                        config.qos = pending.qos;
                        config.no_local = pending.no_local;
                        config.enabled = true;
                    } else {
                        saved.push(MqttSavedTopic {
                            topic: pending.topic.clone(),
                            qos: pending.qos,
                            no_local: pending.no_local,
                            enabled: true,
                        });
                    }
                }
                Ok(())
            }
            Err(error) => {
                log::warn!("{error}");
                Err(error)
            }
        };

        if let Some(completion) = pending.completion {
            let _ = completion.send(completion_result);
        }
    }

    async fn complete_unsubscribe_ack(&self, pkid: u16, result: Result<(), String>) {
        let Some(pending) = self.subscription_requests.lock().await.take_unsubscribe(pkid) else {
            log::warn!("收到无法关联的 MQTT UNSUBACK: pkid={pkid}");
            return;
        };

        let result = result.map_err(|error| format!("取消订阅主题“{}”失败：{error}", pending.topic));
        if result.is_ok() {
            remove_subscription(&self.subscriptions, &pending.topic).await;
            remove_subscription(&self.granted_subscriptions, &pending.topic).await;
            remove_subscription(&self.desired_subscriptions, &pending.topic).await;
            self.no_local_topics.write().await.remove(&pending.topic);
            if let Some(config) =
                self.saved_topic_configs.write().await.iter_mut().find(|config| config.topic == pending.topic)
            {
                config.enabled = false;
            }
            self.seen_retained.write().await.clear_filter(&pending.topic);
        } else if let Err(error) = &result {
            log::warn!("{error}");
        }

        if let Some(completion) = pending.completion {
            let _ = completion.send(result);
        }
    }

    async fn queue_subscribe_request(
        &self,
        topic: String,
        qos: MqttQoS,
        no_local: bool,
        add_to_desired: bool,
        completion: Option<SubscriptionCompletion>,
    ) -> Result<(), String> {
        let _send_guard = self.subscription_send_lock.lock().await;
        let sequence = {
            let mut requests = self.subscription_requests.lock().await;
            if requests.has_pending_topic(&topic) {
                return Err(format!("主题“{topic}”的订阅操作正在处理中，请稍后再试"));
            }
            let sequence = requests.next_sequence();
            requests.queued_subscribes.push_back(PendingSubscribe {
                sequence,
                topic: topic.clone(),
                qos,
                no_local,
                add_to_desired,
                completion,
            });
            sequence
        };

        if let Err(error) = self.backend.subscribe(&topic, mqtt_qos(qos), no_local).await {
            self.subscription_requests.lock().await.queued_subscribes.retain(|pending| pending.sequence != sequence);
            return Err(error);
        }
        Ok(())
    }

    async fn queue_unsubscribe_request(
        &self,
        topic: String,
        completion: Option<SubscriptionCompletion>,
    ) -> Result<(), String> {
        let _send_guard = self.subscription_send_lock.lock().await;
        let sequence = {
            let mut requests = self.subscription_requests.lock().await;
            if requests.has_pending_topic(&topic) {
                return Err(format!("主题“{topic}”的订阅操作正在处理中，请稍后再试"));
            }
            let sequence = requests.next_sequence();
            requests.queued_unsubscribes.push_back(PendingUnsubscribe { sequence, topic: topic.clone(), completion });
            sequence
        };

        if let Err(error) = self.backend.unsubscribe(&topic).await {
            self.subscription_requests.lock().await.queued_unsubscribes.retain(|pending| pending.sequence != sequence);
            return Err(error);
        }
        Ok(())
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
            connected: self.connected.load(Ordering::Acquire),
            protocol_version,
            subscription_count: subscriptions.len(),
        }
    }

    /// 订阅 topic
    pub async fn subscribe(&self, topic: &str, qos: MqttQoS, no_local: bool) -> Result<(), String> {
        validate_topic_filter(topic)?;
        if no_local && !matches!(self.config.protocol_version, super::types::MqttProtocolVersion::V5) {
            return Err("MQTT 3.x 不支持 No Local 订阅选项".to_string());
        }
        let has_desired = self
            .desired_subscriptions
            .read()
            .await
            .iter()
            .any(|(current, current_qos)| current == topic && *current_qos == qos);
        let no_local_matches = self.no_local_topics.read().await.contains(topic);
        if has_desired && no_local_matches == no_local {
            return Ok(());
        }
        if self.subscription_requests.lock().await.has_pending_topic(topic) {
            return Err(format!("主题“{topic}”的订阅操作正在处理中，请稍后再试"));
        }

        let (completion, result) = oneshot::channel();
        self.queue_subscribe_request(topic.to_string(), qos, no_local, true, Some(completion)).await?;
        result.await.map_err(|_| "订阅确认通道已关闭，请检查 MQTT 连接状态".to_string())?
    }

    /// 取消订阅 topic
    pub async fn unsubscribe(&self, topic: &str) -> Result<(), String> {
        validate_topic_filter(topic)?;
        let exists = self.desired_subscriptions.read().await.iter().any(|(current, _)| current == topic);
        if !exists {
            return Ok(());
        }
        if self.subscription_requests.lock().await.has_pending_topic(topic) {
            return Err(format!("主题“{topic}”的订阅操作正在处理中，请稍后再试"));
        }

        let (completion, result) = oneshot::channel();
        self.queue_unsubscribe_request(topic.to_string(), Some(completion)).await?;
        result.await.map_err(|_| "取消订阅确认通道已关闭，请检查 MQTT 连接状态".to_string())?
    }

    /// Save or update a subscription configuration without sending a broker request.
    pub async fn save_topic_config(&self, mut config: MqttSavedTopic) -> Result<(), String> {
        config.topic = config.topic.trim().to_string();
        validate_topic_filter(&config.topic)?;
        if config.no_local && !matches!(self.config.protocol_version, super::types::MqttProtocolVersion::V5) {
            return Err("MQTT 3.x 不支持 No Local 订阅选项".to_string());
        }
        let mut saved = self.saved_topic_configs.write().await;
        if let Some(existing) = saved.iter_mut().find(|current| current.topic == config.topic) {
            *existing = config;
        } else {
            saved.push(config);
        }
        Ok(())
    }

    /// Delete a saved subscription configuration. The caller must unsubscribe first
    /// when the configuration is currently active.
    pub async fn delete_topic_config(&self, topic: &str) -> Result<(), String> {
        validate_topic_filter(topic)?;
        self.saved_topic_configs.write().await.retain(|saved| saved.topic != topic);
        Ok(())
    }

    /// 发布消息；QoS 0 等待写入网络，QoS 1/2 分别等待 PUBACK/PUBCOMP。
    pub async fn publish(&self, request: &MqttPublishRequest) -> Result<(), String> {
        validate_publish_topic(&request.topic)?;
        let payload = if let Some(ref text) = request.payload_text {
            text.as_bytes().to_vec()
        } else {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(&request.payload_base64)
                .map_err(|e| format!("Base64 解码失败: {e}"))?
        };
        let packet_size =
            mqtt_publish_packet_size(&request.topic, payload.len(), request.qos, self.config.protocol_version);
        if packet_size > self.config.max_packet_size_bytes {
            return Err(format!(
                "发布消息失败：报文大小约为 {packet_size} 字节，超过当前连接允许的 {} 字节，请调整最大报文大小或缩小消息负载",
                self.config.max_packet_size_bytes
            ));
        }

        let qos = mqtt_qos(request.qos);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let payload_base64 = if request.payload_text.is_some() {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(&payload)
        } else {
            request.payload_base64.clone()
        };
        let sent_msg = MqttMessage {
            topic: request.topic.clone(),
            payload_base64,
            payload_text: request.payload_text.clone(),
            qos: qos_to_u8(qos),
            retain: request.retain,
            received_at_ms: now_ms,
            direction: MqttMessageDirection::Sent,
        };

        let _send_guard = self.publish_send_lock.lock().await;
        let (completion, result) = oneshot::channel();
        let sequence = self.publish_requests.lock().await.queue(qos, sent_msg, completion);
        if let Err(error) = self.backend.publish(&request.topic, qos, request.retain, payload).await {
            self.publish_requests.lock().await.remove_queued(sequence);
            return Err(error);
        }
        drop(_send_guard);
        result.await.map_err(|_| "发布确认通道已关闭，请检查 MQTT 连接状态".to_string())?
    }

    /// 获取已订阅的 topic 列表
    pub async fn list_topics(&self) -> Vec<(String, MqttQoS)> {
        self.subscriptions.read().await.clone()
    }

    /// 获取持久化意图中的订阅 Topic，用于保存连接配置。
    pub async fn desired_topics(&self) -> Vec<(String, MqttQoS)> {
        self.desired_subscriptions.read().await.clone()
    }

    pub async fn desired_topic_configs(&self) -> Vec<MqttSavedTopic> {
        self.saved_topic_configs.read().await.clone()
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
        self.message_buffer.write().await.clear();
        self.seen_retained.write().await.clear();
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
        sort_topic_tree(&mut root);
        root
    }

    /// 优雅关闭：发送 DISCONNECT，等待事件循环退出；超时后强制中止后台任务。
    /// 调用此方法后不应再使用该客户端。
    pub async fn disconnect(&self) {
        log::info!("MQTT 客户端正在断开连接...");
        self.connected.store(false, Ordering::Release);
        self.subscriptions.write().await.clear();
        self.granted_subscriptions.write().await.clear();
        self.seen_retained.write().await.clear();
        let pending = self.subscription_requests.lock().await.take_all();
        for request in pending {
            request.fail("MQTT 连接已关闭，操作未完成");
        }
        let mut pending_publishes = self.publish_requests.lock().await.take_all();
        for publish in &mut pending_publishes {
            publish.fail("MQTT 连接已关闭，发布操作未完成");
        }

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
    async fn subscribe(&self, topic: &str, qos: QoSV4, no_local: bool) -> Result<(), String> {
        match self {
            MqttBackendClient::V4(client) => {
                if no_local {
                    return Err("MQTT 3.x 不支持 No Local 订阅选项".to_string());
                }
                client.subscribe(topic, qos).await.map_err(|e| format!("订阅 topic 失败: {e}"))
            }
            MqttBackendClient::V5(client) => {
                let mut filter = MqttV5Filter::new(topic.to_string(), qos_v4_to_v5(qos));
                filter.nolocal = no_local;
                client.subscribe_many([filter]).await.map_err(|e| format!("订阅 topic 失败: {e}"))
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

fn build_connect_plan(config: &MqttConnectionConfig) -> Result<MqttConnectPlan, String> {
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
    let transport = build_transport(config.transport, tls_verification_mode, &config.auth)?;

    Ok(MqttConnectPlan { backend, broker_addr: config.broker_addr_for_transport(), transport, protocol })
}

fn build_transport(
    transport: MqttTransport,
    tls_verification_mode: Option<MqttTlsVerificationMode>,
    auth: &MqttAuth,
) -> Result<Transport, String> {
    if let Some(mode) = tls_verification_mode {
        if matches!(auth, MqttAuth::Certificate { .. }) {
            let tls = certificate_tls_configuration(auth, mode)?;
            return Ok(match transport {
                MqttTransport::Tcp => Transport::tls_with_config(tls),
                MqttTransport::WebSocket => Transport::wss_with_config(tls),
            });
        }
    }

    Ok(match (transport, tls_verification_mode) {
        (MqttTransport::Tcp, None) => Transport::Tcp,
        (MqttTransport::Tcp, Some(MqttTlsVerificationMode::VerifyServerCert)) => {
            Transport::tls_with_config(verified_tls_configuration())
        }
        (MqttTransport::Tcp, Some(MqttTlsVerificationMode::SkipServerCertVerification)) => {
            Transport::tls_with_config(insecure_tls_configuration())
        }
        (MqttTransport::WebSocket, None) => Transport::ws(),
        (MqttTransport::WebSocket, Some(MqttTlsVerificationMode::VerifyServerCert)) => {
            Transport::wss_with_config(verified_tls_configuration())
        }
        (MqttTransport::WebSocket, Some(MqttTlsVerificationMode::SkipServerCertVerification)) => {
            Transport::wss_with_config(insecure_tls_configuration())
        }
    })
}

fn certificate_tls_configuration(auth: &MqttAuth, mode: MqttTlsVerificationMode) -> Result<TlsConfiguration, String> {
    let MqttAuth::Certificate { ca_cert_path, client_cert_path, client_key_path } = auth else {
        return Err("MQTT 证书认证配置无效".to_string());
    };
    let client_cert_path = client_cert_path.as_deref().filter(|path| !path.trim().is_empty());
    let client_key_path = client_key_path.as_deref().filter(|path| !path.trim().is_empty());

    let mut root_cert_store = rustls::RootCertStore::empty();
    if let Some(ca_cert_path) = ca_cert_path.as_deref().filter(|path| !path.trim().is_empty()) {
        let file = File::open(ca_cert_path).map_err(|e| format!("读取 MQTT CA 证书失败: {e}"))?;
        let certs = rustls_pemfile::certs(&mut BufReader::new(file))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("解析 MQTT CA 证书失败: {e}"))?;
        let (added, _) = root_cert_store.add_parsable_certificates(certs);
        if added == 0 {
            return Err("MQTT CA 证书文件不包含有效证书".to_string());
        }
    } else {
        root_cert_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }

    let builder = match mode {
        MqttTlsVerificationMode::VerifyServerCert => {
            rustls::ClientConfig::builder().with_root_certificates(root_cert_store)
        }
        MqttTlsVerificationMode::SkipServerCertVerification => {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoCertificateVerification { provider }))
        }
    };
    let config = match (client_cert_path, client_key_path) {
        (None, None) => builder.with_no_client_auth(),
        (None, Some(_)) => return Err("MQTT 证书认证缺少客户端证书路径".to_string()),
        (Some(_), None) => return Err("MQTT 证书认证缺少客户端私钥路径".to_string()),
        (Some(client_cert_path), Some(client_key_path)) => {
            let cert_file = File::open(client_cert_path).map_err(|e| format!("读取 MQTT 客户端证书失败: {e}"))?;
            let certs = rustls_pemfile::certs(&mut BufReader::new(cert_file))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 MQTT 客户端证书失败: {e}"))?;
            if certs.is_empty() {
                return Err("MQTT 客户端证书文件不包含有效证书".to_string());
            }
            let key_file = File::open(client_key_path).map_err(|e| format!("读取 MQTT 客户端私钥失败: {e}"))?;
            let mut key_reader = BufReader::new(key_file);
            let key = rustls_pemfile::private_key(&mut key_reader)
                .map_err(|e| format!("解析 MQTT 客户端私钥失败: {e}"))?
                .ok_or("MQTT 客户端私钥文件不包含有效私钥")?;
            builder.with_client_auth_cert(certs, key).map_err(|e| format!("构建 MQTT 客户端 TLS 配置失败: {e}"))?
        }
    };
    Ok(TlsConfiguration::from(config))
}

fn verified_tls_configuration() -> TlsConfiguration {
    static CONFIG: LazyLock<TlsConfiguration> = LazyLock::new(|| {
        let mut root_cert_store = rustls::RootCertStore::empty();
        root_cert_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder().with_root_certificates(root_cert_store).with_no_client_auth();
        TlsConfiguration::from(config)
    });
    CONFIG.clone()
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
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
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

fn mqtt_qos_from_v4(qos: QoSV4) -> MqttQoS {
    match qos {
        QoSV4::AtMostOnce => MqttQoS::AtMostOnce,
        QoSV4::AtLeastOnce => MqttQoS::AtLeastOnce,
        QoSV4::ExactlyOnce => MqttQoS::ExactlyOnce,
    }
}

fn mqtt_qos_from_v5(qos: QoSV5) -> MqttQoS {
    match qos {
        QoSV5::AtMostOnce => MqttQoS::AtMostOnce,
        QoSV5::AtLeastOnce => MqttQoS::AtLeastOnce,
        QoSV5::ExactlyOnce => MqttQoS::ExactlyOnce,
    }
}

fn mqtt_publish_packet_size(
    topic: &str,
    payload_len: usize,
    qos: MqttQoS,
    protocol: super::types::MqttProtocolVersion,
) -> usize {
    let variable_header = 2 + topic.len() + usize::from(qos != MqttQoS::AtMostOnce) * 2;
    let properties = usize::from(matches!(protocol, super::types::MqttProtocolVersion::V5));
    let remaining_len = variable_header + properties + payload_len;
    1 + mqtt_remaining_length_bytes(remaining_len) + remaining_len
}

fn mqtt_remaining_length_bytes(mut value: usize) -> usize {
    let mut bytes = 1;
    while value >= 128 {
        value /= 128;
        bytes += 1;
    }
    bytes
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

async fn upsert_subscription(subscriptions: &RwLock<Vec<(String, MqttQoS)>>, topic: &str, qos: MqttQoS) {
    let mut subscriptions = subscriptions.write().await;
    if let Some((_, current_qos)) = subscriptions.iter_mut().find(|(current, _)| current == topic) {
        *current_qos = qos;
    } else {
        subscriptions.push((topic.to_string(), qos));
    }
}

async fn remove_subscription(subscriptions: &RwLock<Vec<(String, MqttQoS)>>, topic: &str) {
    subscriptions.write().await.retain(|(current, _)| current != topic);
}

fn validate_topic_length_and_content(topic: &str, action: &str) -> Result<(), String> {
    if topic.is_empty() {
        return Err(format!("{action}主题不能为空，请输入有效的 MQTT 主题"));
    }
    if topic.contains('\0') {
        return Err(format!("{action}主题不能包含空字符"));
    }
    if topic.len() > u16::MAX as usize {
        return Err(format!("{action}主题过长，UTF-8 编码后不能超过 65535 字节"));
    }
    Ok(())
}

fn validate_topic_filter(topic: &str) -> Result<(), String> {
    validate_topic_length_and_content(topic, "订阅")?;
    if !valid_filter(topic) {
        return Err("订阅主题格式无效：通配符 + 必须独占一个层级，通配符 # 必须独占最后一个层级".to_string());
    }
    Ok(())
}

fn validate_publish_topic(topic: &str) -> Result<(), String> {
    validate_topic_length_and_content(topic, "发布")?;
    if !valid_topic(topic) {
        return Err("发布主题不能包含通配符 # 或 +，请填写一个具体主题".to_string());
    }
    Ok(())
}

/// 将 topic 路径插入到树结构中
fn insert_topic_into_tree(root: &mut MqttTopicNode, topic: &str) {
    let (path_prefix, visible_topic) = topic.strip_prefix('/').map_or(("", topic), |path| ("/", path));
    let segments: Vec<&str> = visible_topic.split('/').collect();
    let mut current = root;

    for (i, segment) in segments.iter().enumerate() {
        let full_path = format!("{path_prefix}{}", segments[..=i].join("/"));
        let is_leaf = i == segments.len() - 1;

        let child_idx = match current.children.iter().position(|child| child.name == *segment) {
            Some(index) => index,
            None => {
                current.children.push(MqttTopicNode {
                    name: segment.to_string(),
                    full_path,
                    children: Vec::new(),
                    message_count: None,
                    is_leaf,
                });
                current.children.len() - 1
            }
        };
        if is_leaf {
            current.children[child_idx].is_leaf = true;
        }
        current = &mut current.children[child_idx];
    }
}

fn sort_topic_tree(node: &mut MqttTopicNode) {
    node.children.sort_by(|left, right| left.name.cmp(&right.name));
    for child in &mut node.children {
        sort_topic_tree(child);
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
    fn topic_tree_hides_only_the_leading_separator() {
        let mut root = MqttTopicNode {
            name: "root".to_string(),
            full_path: String::new(),
            children: Vec::new(),
            message_count: None,
            is_leaf: false,
        };
        insert_topic_into_tree(&mut root, "/device/ctrl/1219/1219000213/#");

        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].name, "device");
        assert_eq!(root.children[0].full_path, "/device");
        assert_eq!(root.children[0].children[0].full_path, "/device/ctrl");
        assert_eq!(
            root.children[0].children[0].children[0].children[0].children[0].full_path,
            "/device/ctrl/1219/1219000213/#"
        );
    }

    #[test]
    fn validates_publish_topics_and_subscription_filters() {
        assert!(validate_publish_topic("/device/ctrl/1219000213/set").is_ok());
        assert_eq!(
            validate_publish_topic("/device/ctrl/1219000213/#").unwrap_err(),
            "发布主题不能包含通配符 # 或 +，请填写一个具体主题"
        );
        assert!(validate_topic_filter("/device/ctrl/1219000213/#").is_ok());
        assert!(validate_topic_filter("/device/+/status").is_ok());
        assert!(validate_topic_filter("/device/a#").is_err());
        assert!(validate_topic_filter("/device/#/status").is_err());
    }

    #[test]
    fn topic_filter_wildcards() {
        assert!(topic_matches_filter("sensors/b1/temp", "sensors/+/temp"));
        assert!(topic_matches_filter("a/b/c/d", "a/#"));
        assert!(!topic_matches_filter("sensors/b1/temp", "actuators/+/temp"));
        assert!(topic_matches_filter("a/b", "a/b"));
    }

    #[test]
    fn connect_plan_uses_ws_path_and_insecure_tls_transport() -> Result<(), Box<dyn std::error::Error>> {
        let config = MqttConnectionConfig {
            host: "broker.example.com".to_string(),
            port: 8084,
            transport: MqttTransport::WebSocket,
            tls: true,
            tls_skip_verify: true,
            ws_path: Some("/custom/mqtt".to_string()),
            ..Default::default()
        };

        let plan = build_connect_plan(&config)?;
        assert_eq!(plan.broker_addr, "wss://broker.example.com:8084/custom/mqtt");
        assert_eq!(plan.backend, MqttBackendKind::V5);
        match plan.transport {
            Transport::Wss(TlsConfiguration::Rustls(_)) => {}
            _ => panic!("tlsSkipVerify 应使用显式 Rustls 自定义校验器"),
        }

        Ok(())
    }

    #[test]
    fn verified_tls_does_not_depend_on_platform_certificate_store() {
        let missing_cert_file = std::env::temp_dir().join(format!("dbx-mqtt-missing-ca-{}.pem", uuid::Uuid::new_v4()));
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("verified_tls_platform_store_child")
            .arg("--ignored")
            .arg("--nocapture")
            .env("SSL_CERT_FILE", missing_cert_file)
            .env_remove("SSL_CERT_DIR")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(output.status.success(), "verified TLS child failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
        assert!(
            stdout.contains("verified_tls_platform_store_child") && stdout.contains("1 passed"),
            "verified TLS child did not run the regression test:\n{stdout}"
        );
    }

    #[test]
    #[ignore]
    fn verified_tls_platform_store_child() {
        let config = MqttConnectionConfig {
            host: "broker.example.com".to_string(),
            port: 8883,
            tls: true,
            tls_skip_verify: false,
            ..Default::default()
        };

        let plan = build_connect_plan(&config).unwrap();
        assert!(matches!(plan.transport, Transport::Tls(TlsConfiguration::Rustls(_))));
    }

    #[test]
    fn verified_tls_reuses_the_client_config() {
        let first = verified_tls_configuration();
        let second = verified_tls_configuration();

        match (first, second) {
            (TlsConfiguration::Rustls(first), TlsConfiguration::Rustls(second)) => {
                assert!(Arc::ptr_eq(&first, &second));
            }
            _ => panic!("verified TLS 应复用显式 Rustls 配置"),
        }
    }

    #[test]
    fn certificate_auth_allows_server_only_tls() {
        let auth = MqttAuth::Certificate { ca_cert_path: None, client_cert_path: None, client_key_path: None };

        let transport =
            build_transport(MqttTransport::Tcp, Some(MqttTlsVerificationMode::VerifyServerCert), &auth).unwrap();

        assert!(matches!(transport, Transport::Tls(TlsConfiguration::Rustls(_))));
    }

    #[test]
    fn certificate_auth_requires_client_certificate_and_key_as_a_pair() {
        let missing_cert = MqttAuth::Certificate {
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: Some("client.key".to_string()),
        };
        let missing_key = MqttAuth::Certificate {
            ca_cert_path: None,
            client_cert_path: Some("client.crt".to_string()),
            client_key_path: None,
        };
        let missing_cert_error =
            build_transport(MqttTransport::Tcp, Some(MqttTlsVerificationMode::VerifyServerCert), &missing_cert)
                .err()
                .unwrap();
        let missing_key_error =
            build_transport(MqttTransport::Tcp, Some(MqttTlsVerificationMode::VerifyServerCert), &missing_key)
                .err()
                .unwrap();

        assert_eq!(missing_cert_error, "MQTT 证书认证缺少客户端证书路径");
        assert_eq!(missing_key_error, "MQTT 证书认证缺少客户端私钥路径");
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

    #[tokio::test]
    async fn reconnect_updates_connection_state_and_restores_confirmed_subscriptions() {
        let (port, disconnect_broker, restored, broker) = spawn_v4_reconnecting_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();

        client.subscribe("device/reconnect/#", MqttQoS::AtMostOnce, false).await.unwrap();
        assert!(client.broker_info().await.connected);
        assert_eq!(client.list_topics().await.len(), 1);

        disconnect_broker.send(()).unwrap();
        wait_for_connection_state(&client, false).await;
        assert!(client.list_topics().await.is_empty());

        restored.await.unwrap();
        wait_for_connection_state(&client, true).await;
        wait_for_topic_count(&client, 1).await;

        client.disconnect().await;
        await_broker(broker).await;
    }

    #[tokio::test]
    async fn subscription_state_changes_only_after_suback_and_unsuback() {
        let (port, subscribe_seen, allow_suback, unsubscribe_seen, allow_unsuback, broker) =
            spawn_v4_delayed_ack_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();

        let subscribing_client = Arc::clone(&client);
        let subscribe =
            tokio::spawn(
                async move { subscribing_client.subscribe("device/ack/#", MqttQoS::AtLeastOnce, false).await },
            );
        subscribe_seen.await.unwrap();
        assert!(client.list_topics().await.is_empty());
        allow_suback.send(()).unwrap();
        subscribe.await.unwrap().unwrap();
        assert_eq!(client.list_topics().await, vec![("device/ack/#".to_string(), MqttQoS::AtLeastOnce)]);

        let unsubscribing_client = Arc::clone(&client);
        let unsubscribe = tokio::spawn(async move { unsubscribing_client.unsubscribe("device/ack/#").await });
        unsubscribe_seen.await.unwrap();
        assert_eq!(client.list_topics().await.len(), 1);
        allow_unsuback.send(()).unwrap();
        unsubscribe.await.unwrap().unwrap();
        assert!(client.list_topics().await.is_empty());

        client.disconnect().await;
        await_broker(broker).await;
    }

    #[tokio::test]
    async fn publish_larger_than_rumqttc_default_waits_until_written() {
        let payload = "x".repeat(12 * 1024);
        let (port, publish_seen, broker) = spawn_v4_publish_broker(payload.len(), false).await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();
        let request = publish_request("device/large", &payload, MqttQoS::AtMostOnce);

        client.publish(&request).await.unwrap();
        publish_seen.await.unwrap();
        assert_eq!(client.get_messages(None, 10).await.len(), 1);

        client.disconnect().await;
        await_broker(broker).await;
    }

    #[tokio::test]
    async fn qos1_publish_completes_only_after_puback() {
        let payload = "confirmed";
        let (port, publish_seen, allow_puback, broker) = spawn_v4_delayed_puback_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();
        let request = publish_request("device/confirmed", payload, MqttQoS::AtLeastOnce);

        let publishing_client = Arc::clone(&client);
        let publish = tokio::spawn(async move { publishing_client.publish(&request).await });
        publish_seen.await.unwrap();
        assert!(!publish.is_finished());
        assert!(client.get_messages(None, 10).await.is_empty());
        allow_puback.send(()).unwrap();
        publish.await.unwrap().unwrap();
        assert_eq!(client.get_messages(None, 10).await.len(), 1);

        client.disconnect().await;
        await_broker(broker).await;
    }

    #[tokio::test]
    async fn broker_packet_limit_error_is_returned_and_not_recorded() {
        let (port, broker) = spawn_v5_small_packet_limit_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V5);
        let client = MqttClient::connect(config).await.unwrap();
        let request = publish_request("device/too-large", &"x".repeat(128), MqttQoS::AtMostOnce);

        let error = client.publish(&request).await.unwrap_err();
        assert!(error.contains("maximum packet size"), "unexpected error: {error}");
        assert!(client.get_messages(None, 10).await.is_empty());

        drop(client);
        await_broker(broker).await;
    }
    #[tokio::test]
    async fn publish_connection_error_is_returned_and_not_recorded() {
        let (port, broker) = spawn_v4_publish_disconnect_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();
        let request = publish_request("device/failure", "not-confirmed", MqttQoS::AtLeastOnce);

        let error = client.publish(&request).await.unwrap_err();
        assert!(error.contains("发布消息未完成"), "unexpected error: {error}");
        assert!(client.get_messages(None, 10).await.is_empty());

        drop(client);
        await_broker(broker).await;
    }
    #[tokio::test]
    async fn suback_records_broker_granted_qos() {
        let (port, broker) = spawn_v4_granted_subscription_broker(QoSV4::AtMostOnce).await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();

        client.subscribe("device/downgraded/#", MqttQoS::ExactlyOnce, false).await.unwrap();
        assert_eq!(client.list_topics().await, vec![("device/downgraded/#".to_string(), MqttQoS::AtMostOnce)]);

        client.disconnect().await;
        await_broker(broker).await;
    }

    #[tokio::test]
    async fn retained_dedup_resets_for_resubscribe_and_clear() {
        let (port, send_after_clear, broker) = spawn_v4_retained_lifecycle_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();

        client.subscribe("retained/#", MqttQoS::AtMostOnce, false).await.unwrap();
        wait_for_message_count(&client, 2).await;
        let initial = client.get_messages(None, 10).await;
        assert_eq!(initial.iter().filter(|message| message.payload_text.as_deref() == Some("v1")).count(), 1);
        assert!(initial.iter().any(|message| message.payload_text.as_deref() == Some("v2")));

        client.unsubscribe("retained/#").await.unwrap();
        client.subscribe("retained/#", MqttQoS::AtMostOnce, false).await.unwrap();
        wait_for_message_count(&client, 3).await;
        assert_eq!(
            client
                .get_messages(None, 10)
                .await
                .iter()
                .filter(|message| message.payload_text.as_deref() == Some("v1"))
                .count(),
            2
        );

        client.clear_messages().await;
        send_after_clear.send(()).unwrap();
        wait_for_message_count(&client, 1).await;
        assert_eq!(client.get_messages(None, 10).await[0].payload_text.as_deref(), Some("v1"));

        client.disconnect().await;
        await_broker(broker).await;
    }

    #[test]
    fn reconnect_replayed_publish_cannot_complete_a_new_request() {
        let mut tracker = PublishRequestTracker::default();
        let old_message = test_message("old");
        let (old_completion, mut old_result) = oneshot::channel();
        tracker.queue(QoSV4::AtLeastOnce, old_message, old_completion);
        tracker.mark_outgoing(7);

        let mut failed = tracker.take_for_connection_loss();
        failed[0].fail("连接中断");
        assert_eq!(old_result.try_recv().unwrap(), Err("连接中断".to_string()));

        let (new_completion, mut new_result) = oneshot::channel();
        tracker.queue(QoSV4::AtLeastOnce, test_message("new"), new_completion);
        assert!(tracker.mark_outgoing(7).is_none());
        assert!(tracker.take_acknowledged(7).is_none());
        assert!(matches!(new_result.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)));

        tracker.mark_outgoing(8);
        let pending = tracker.take_acknowledged(8).unwrap();
        assert_eq!(pending.message.topic, "new");
    }

    fn test_message(topic: &str) -> MqttMessage {
        MqttMessage {
            topic: topic.to_string(),
            payload_base64: String::new(),
            payload_text: None,
            qos: 1,
            retain: false,
            received_at_ms: 0,
            direction: MqttMessageDirection::Sent,
        }
    }
    #[test]
    fn retained_dedup_is_bounded() {
        let mut seen = RetainedDedup::new(2);
        assert!(seen.insert("topic/1", b"payload"));
        assert!(seen.insert("topic/2", b"payload"));
        assert!(seen.insert("topic/3", b"payload"));
        assert_eq!(seen.entries.len(), 2);
        assert!(seen.insert("topic/1", b"payload"));
    }
    #[tokio::test]
    async fn rejected_suback_does_not_record_subscription() {
        let (port, broker) = spawn_v4_rejecting_subscription_broker().await;
        let config = mqtt_config(port, crate::mqtt::types::MqttProtocolVersion::V4);
        let client = MqttClient::connect(config).await.unwrap();

        let error = client.subscribe("device/rejected/#", MqttQoS::AtMostOnce, false).await.unwrap_err();
        assert!(error.contains("拒绝"), "unexpected error: {error}");
        assert!(client.list_topics().await.is_empty());

        client.disconnect().await;
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

    async fn spawn_v4_reconnecting_broker(
    ) -> (u16, oneshot::Sender<()>, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (disconnect_tx, disconnect_rx) = oneshot::channel();
        let (restored_tx, restored_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut first).await.unwrap();
            first.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            acknowledge_v4_subscribe(&mut first, rumqttc::SubscribeReasonCode::Success(QoSV4::AtMostOnce)).await;
            disconnect_rx.await.unwrap();
            drop(first);

            let (mut second, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut second).await.unwrap();
            second.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            acknowledge_v4_subscribe(&mut second, rumqttc::SubscribeReasonCode::Success(QoSV4::AtMostOnce)).await;
            restored_tx.send(()).unwrap();

            let frame = read_mqtt_frame(&mut second).await.unwrap();
            let mut bytes = BytesMut::from(&frame[..]);
            let packet = rumqttc::mqttbytes::v4::read(&mut bytes, 1024 * 1024).unwrap();
            assert!(matches!(packet, rumqttc::mqttbytes::v4::Packet::Disconnect));
        });
        (port, disconnect_tx, restored_rx, handle)
    }

    async fn spawn_v4_delayed_ack_broker() -> (
        u16,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (subscribe_seen_tx, subscribe_seen_rx) = oneshot::channel();
        let (allow_suback_tx, allow_suback_rx) = oneshot::channel();
        let (unsubscribe_seen_tx, unsubscribe_seen_rx) = oneshot::channel();
        let (allow_unsuback_tx, allow_unsuback_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            let subscribe_pkid = read_v4_subscribe_pkid(&mut stream).await;
            subscribe_seen_tx.send(()).unwrap();
            allow_suback_rx.await.unwrap();
            write_v4_suback(&mut stream, subscribe_pkid, rumqttc::SubscribeReasonCode::Success(QoSV4::AtLeastOnce))
                .await;

            let frame = read_mqtt_frame(&mut stream).await.unwrap();
            let mut bytes = BytesMut::from(&frame[..]);
            let packet = rumqttc::mqttbytes::v4::read(&mut bytes, 1024 * 1024).unwrap();
            let unsubscribe_pkid = match packet {
                rumqttc::mqttbytes::v4::Packet::Unsubscribe(unsubscribe) => unsubscribe.pkid,
                other => panic!("unexpected packet: {other:?}"),
            };
            unsubscribe_seen_tx.send(()).unwrap();
            allow_unsuback_rx.await.unwrap();
            let mut ack = BytesMut::new();
            rumqttc::UnsubAck::new(unsubscribe_pkid).write(&mut ack).unwrap();
            stream.write_all(&ack).await.unwrap();

            let frame = read_mqtt_frame(&mut stream).await.unwrap();
            assert_eq!(frame, vec![0xe0, 0x00]);
        });
        (port, subscribe_seen_rx, allow_suback_tx, unsubscribe_seen_rx, allow_unsuback_tx, handle)
    }

    fn publish_request(topic: &str, payload: &str, qos: MqttQoS) -> MqttPublishRequest {
        MqttPublishRequest {
            topic: topic.to_string(),
            payload_base64: String::new(),
            payload_text: Some(payload.to_string()),
            qos,
            retain: false,
        }
    }

    async fn spawn_v4_publish_broker(
        expected_payload_len: usize,
        acknowledge: bool,
    ) -> (u16, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            let publish = read_v4_publish(&mut stream).await;
            assert_eq!(publish.payload.len(), expected_payload_len);
            seen_tx.send(()).unwrap();
            if acknowledge {
                let mut ack = BytesMut::new();
                rumqttc::PubAck::new(publish.pkid).write(&mut ack).unwrap();
                stream.write_all(&ack).await.unwrap();
            }
            assert_eq!(read_mqtt_frame(&mut stream).await.unwrap(), vec![0xe0, 0x00]);
        });
        (port, seen_rx, handle)
    }

    async fn spawn_v4_delayed_puback_broker(
    ) -> (u16, oneshot::Receiver<()>, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = oneshot::channel();
        let (allow_tx, allow_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            let publish = read_v4_publish(&mut stream).await;
            assert_eq!(publish.qos, QoSV4::AtLeastOnce);
            seen_tx.send(()).unwrap();
            allow_rx.await.unwrap();
            let mut ack = BytesMut::new();
            rumqttc::PubAck::new(publish.pkid).write(&mut ack).unwrap();
            stream.write_all(&ack).await.unwrap();
            assert_eq!(read_mqtt_frame(&mut stream).await.unwrap(), vec![0xe0, 0x00]);
        });
        (port, seen_rx, allow_tx, handle)
    }

    async fn spawn_v5_small_packet_limit_broker() -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            // CONNACK 的 Maximum Packet Size 属性将 broker 接收上限设为 32 字节。
            stream.write_all(&[0x20, 0x08, 0x00, 0x00, 0x05, 0x27, 0x00, 0x00, 0x00, 0x20]).await.unwrap();
            expect_stream_closed(&mut stream).await;
        });
        (port, handle)
    }
    async fn spawn_v4_publish_disconnect_broker() -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            let publish = read_v4_publish(&mut stream).await;
            assert_eq!(publish.qos, QoSV4::AtLeastOnce);
        });
        (port, handle)
    }
    async fn spawn_v4_granted_subscription_broker(granted: QoSV4) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            acknowledge_v4_subscribe(&mut stream, rumqttc::SubscribeReasonCode::Success(granted)).await;
            assert_eq!(read_mqtt_frame(&mut stream).await.unwrap(), vec![0xe0, 0x00]);
        });
        (port, handle)
    }

    async fn spawn_v4_retained_lifecycle_broker() -> (u16, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (after_clear_tx, after_clear_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();

            acknowledge_v4_subscribe(&mut stream, rumqttc::SubscribeReasonCode::Success(QoSV4::AtMostOnce)).await;
            write_v4_retained(&mut stream, "retained/value", b"v1").await;
            write_v4_retained(&mut stream, "retained/value", b"v1").await;
            write_v4_retained(&mut stream, "retained/value", b"v2").await;

            let frame = read_mqtt_frame(&mut stream).await.unwrap();
            let mut bytes = BytesMut::from(&frame[..]);
            let packet = rumqttc::mqttbytes::v4::read(&mut bytes, 1024 * 1024).unwrap();
            let unsubscribe_pkid = match packet {
                rumqttc::mqttbytes::v4::Packet::Unsubscribe(unsubscribe) => unsubscribe.pkid,
                other => panic!("unexpected packet: {other:?}"),
            };
            let mut ack = BytesMut::new();
            rumqttc::UnsubAck::new(unsubscribe_pkid).write(&mut ack).unwrap();
            stream.write_all(&ack).await.unwrap();

            acknowledge_v4_subscribe(&mut stream, rumqttc::SubscribeReasonCode::Success(QoSV4::AtMostOnce)).await;
            write_v4_retained(&mut stream, "retained/value", b"v1").await;
            after_clear_rx.await.unwrap();
            write_v4_retained(&mut stream, "retained/value", b"v1").await;
            assert_eq!(read_mqtt_frame(&mut stream).await.unwrap(), vec![0xe0, 0x00]);
        });
        (port, after_clear_tx, handle)
    }

    async fn read_v4_publish(stream: &mut tokio::net::TcpStream) -> rumqttc::Publish {
        use bytes::BytesMut;

        let frame = read_mqtt_frame(stream).await.unwrap();
        let mut bytes = BytesMut::from(&frame[..]);
        match rumqttc::mqttbytes::v4::read(&mut bytes, 32 * 1024 * 1024).unwrap() {
            rumqttc::mqttbytes::v4::Packet::Publish(publish) => publish,
            other => panic!("unexpected packet: {other:?}"),
        }
    }

    async fn write_v4_retained(stream: &mut tokio::net::TcpStream, topic: &str, payload: &[u8]) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;

        let mut publish = rumqttc::Publish::new(topic, QoSV4::AtMostOnce, payload);
        publish.retain = true;
        let mut bytes = BytesMut::new();
        publish.write(&mut bytes).unwrap();
        stream.write_all(&bytes).await.unwrap();
    }
    async fn spawn_v4_rejecting_subscription_broker() -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_mqtt_frame(&mut stream).await.unwrap();
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.unwrap();
            acknowledge_v4_subscribe(&mut stream, rumqttc::SubscribeReasonCode::Failure).await;
            let frame = read_mqtt_frame(&mut stream).await.unwrap();
            assert_eq!(frame, vec![0xe0, 0x00]);
        });
        (port, handle)
    }

    async fn acknowledge_v4_subscribe(stream: &mut tokio::net::TcpStream, reason: rumqttc::SubscribeReasonCode) {
        let pkid = read_v4_subscribe_pkid(stream).await;
        write_v4_suback(stream, pkid, reason).await;
    }

    async fn read_v4_subscribe_pkid(stream: &mut tokio::net::TcpStream) -> u16 {
        use bytes::BytesMut;

        let frame = read_mqtt_frame(stream).await.unwrap();
        let mut bytes = BytesMut::from(&frame[..]);
        let packet = rumqttc::mqttbytes::v4::read(&mut bytes, 1024 * 1024).unwrap();
        match packet {
            rumqttc::mqttbytes::v4::Packet::Subscribe(subscribe) => subscribe.pkid,
            other => panic!("unexpected packet: {other:?}"),
        }
    }

    async fn write_v4_suback(stream: &mut tokio::net::TcpStream, pkid: u16, reason: rumqttc::SubscribeReasonCode) {
        use bytes::BytesMut;
        use tokio::io::AsyncWriteExt;

        let mut ack = BytesMut::new();
        rumqttc::SubAck::new(pkid, vec![reason]).write(&mut ack).unwrap();
        stream.write_all(&ack).await.unwrap();
    }

    async fn wait_for_connection_state(client: &MqttClient, expected: bool) {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if client.broker_info().await.connected == expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("MQTT connected state did not become {expected}"));
    }

    async fn wait_for_message_count(client: &MqttClient, expected: usize) {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if client.get_messages(None, expected + 10).await.len() == expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("MQTT message count did not become {expected}"));
    }
    async fn wait_for_topic_count(client: &MqttClient, expected: usize) {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if client.list_topics().await.len() == expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("MQTT topic count did not become {expected}"));
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
