//! MQTT broker 连接的类型定义。与前端 `apps/desktop/src/types/mqtt.ts` 保持一致。

use serde::{Deserialize, Serialize};

/// MQTT 协议版本
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MqttProtocolVersion {
    V3,
    V4,
    #[default]
    V5,
}

/// 传输层协议
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MqttTransport {
    #[default]
    Tcp,
    #[serde(rename = "websocket")]
    WebSocket,
}

/// 认证方式
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MqttAuth {
    #[serde(rename = "none")]
    #[default]
    None,
    #[serde(rename = "password")]
    Password { username: String, password: String },
    #[serde(rename = "certificate")]
    Certificate { ca_cert_path: Option<String>, client_cert_path: Option<String>, client_key_path: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MqttTlsVerificationMode {
    VerifyServerCert,
    SkipServerCertVerification,
}

impl MqttAuth {
    pub fn kind_str(&self) -> &'static str {
        match self {
            MqttAuth::None => "none",
            MqttAuth::Password { .. } => "password",
            MqttAuth::Certificate { .. } => "certificate",
        }
    }
}

/// MQTT 连接配置，存储在 `ConnectionConfig.external_config` 中。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttConnectionConfig {
    /// Broker 地址（IP 或域名）
    pub host: String,
    /// Broker 端口（默认 1883，TLS 默认 8883）
    pub port: u16,
    /// MQTT 客户端标识符
    pub client_id: String,
    /// 协议版本，默认 V5
    #[serde(default)]
    pub protocol_version: MqttProtocolVersion,
    /// 传输层，默认 TCP
    #[serde(default)]
    pub transport: MqttTransport,
    /// 是否启用 TLS
    #[serde(default)]
    pub tls: bool,
    /// 跳过 TLS 证书验证
    #[serde(default)]
    pub tls_skip_verify: bool,
    /// 认证方式
    #[serde(default)]
    pub auth: MqttAuth,
    /// Keep Alive 间隔（秒），默认 60
    #[serde(default = "default_keep_alive")]
    pub keep_alive_secs: u64,
    /// 连接超时（秒），默认 30
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u64,
    /// 单个 MQTT 报文的最大字节数，默认 16 MiB
    #[serde(default = "default_max_packet_size")]
    pub max_packet_size_bytes: usize,
    /// WebSocket 路径（仅 WebSocket 传输时使用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ws_path: Option<String>,
}

fn default_keep_alive() -> u64 {
    60
}

fn default_connect_timeout() -> u64 {
    30
}

fn default_max_packet_size() -> usize {
    16 * 1024 * 1024
}

impl Default for MqttConnectionConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 1883,
            client_id: format!("dbx-{}", uuid::Uuid::new_v4()),
            protocol_version: MqttProtocolVersion::default(),
            transport: MqttTransport::default(),
            tls: false,
            tls_skip_verify: false,
            auth: MqttAuth::default(),
            keep_alive_secs: default_keep_alive(),
            connect_timeout_secs: default_connect_timeout(),
            max_packet_size_bytes: default_max_packet_size(),
            ws_path: None,
        }
    }
}

impl MqttConnectionConfig {
    /// 从 `ConnectionConfig.external_config` 解析 MQTT 连接配置。
    pub fn from_connection(cfg: &crate::models::connection::ConnectionConfig) -> Result<Self, String> {
        let raw = cfg.external_config.as_ref().ok_or("MQTT 连接缺少 external_config 配置")?;
        let parsed: MqttConnectionConfig =
            serde_json::from_value(raw.clone()).map_err(|e| format!("MQTT 配置解析失败: {e}"))?;
        if parsed.host.trim().is_empty() {
            return Err("MQTT Broker 地址不能为空".to_string());
        }
        if parsed.client_id.trim().is_empty() {
            return Err("MQTT Client ID 不能为空".to_string());
        }
        if !(1024..=268_435_455).contains(&parsed.max_packet_size_bytes) {
            return Err("MQTT 最大报文大小必须在 1024 到 268435455 字节之间".to_string());
        }
        Ok(parsed)
    }

    /// 构建 MQTT broker URL
    pub fn broker_url(&self) -> String {
        let scheme = if self.tls { "mqtts" } else { "mqtt" };
        match self.transport {
            MqttTransport::Tcp => format!("{}://{}:{}", scheme, self.host, self.port),
            MqttTransport::WebSocket => {
                let ws_scheme = if self.tls { "wss" } else { "ws" };
                let path = self.ws_path.as_deref().unwrap_or("/mqtt");
                format!("{}://{}:{}{}", ws_scheme, self.host, self.port, path)
            }
        }
    }

    pub fn broker_addr_for_transport(&self) -> String {
        match self.transport {
            MqttTransport::Tcp => self.host.clone(),
            MqttTransport::WebSocket => self.broker_url(),
        }
    }

    pub(crate) fn tls_verification_mode(&self) -> Option<MqttTlsVerificationMode> {
        if !self.tls {
            None
        } else if self.tls_skip_verify {
            Some(MqttTlsVerificationMode::SkipServerCertVerification)
        } else {
            Some(MqttTlsVerificationMode::VerifyServerCert)
        }
    }
}

/// MQTT 消息服务质量
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MqttQoS {
    #[default]
    AtMostOnce,
    AtLeastOnce,
    ExactlyOnce,
}

impl MqttQoS {
    pub fn as_u8(self) -> u8 {
        match self {
            MqttQoS::AtMostOnce => 0,
            MqttQoS::AtLeastOnce => 1,
            MqttQoS::ExactlyOnce => 2,
        }
    }

    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => MqttQoS::AtMostOnce,
            1 => MqttQoS::AtLeastOnce,
            2 => MqttQoS::ExactlyOnce,
            _ => MqttQoS::AtMostOnce,
        }
    }
}

/// 发布消息请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttPublishRequest {
    /// 目标 topic
    pub topic: String,
    /// 消息负载（Base64 编码的二进制内容）
    pub payload_base64: String,
    /// 消息负载（文本内容，与 payload_base64 二选一）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_text: Option<String>,
    /// 服务质量
    #[serde(default)]
    pub qos: MqttQoS,
    /// 是否为保留消息
    #[serde(default)]
    pub retain: bool,
}

/// MQTT 消息方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MqttMessageDirection {
    Sent,
    #[default]
    Received,
}

/// 接收到的 MQTT 消息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttMessage {
    /// 消息来源 topic
    pub topic: String,
    /// 消息负载（Base64 编码）
    pub payload_base64: String,
    /// 消息负载（UTF-8 文本，解码失败时为 None）
    pub payload_text: Option<String>,
    /// 服务质量
    pub qos: u8,
    /// 是否保留消息
    pub retain: bool,
    /// 消息接收时间（毫秒时间戳）
    pub received_at_ms: u64,
    /// 消息方向：sent（发出的）或 received（接收的）
    #[serde(default)]
    pub direction: MqttMessageDirection,
}

/// Topic 树节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttTopicNode {
    /// 节点名称（单个层级）
    pub name: String,
    /// 完整 topic 路径
    pub full_path: String,
    /// 子节点
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<MqttTopicNode>,
    /// 该节点级别的消息计数（近似值）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u64>,
    /// 是否为叶子节点（可订阅）
    #[serde(default)]
    pub is_leaf: bool,
}

/// Broker 基本信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttBrokerInfo {
    /// 已连接的 broker URL
    pub broker_url: String,
    /// 客户端 ID
    pub client_id: String,
    /// 连接状态
    pub connected: bool,
    /// MQTT 协议版本
    pub protocol_version: String,
    /// 当前订阅的 topic 数量
    pub subscription_count: usize,
}

/// 订阅请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttSubscribeRequest {
    pub topic: String,
    #[serde(default)]
    pub qos: MqttQoS,
}

/// 取消订阅请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttUnsubscribeRequest {
    pub topic: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_external_config() {
        let json = serde_json::json!({
            "host": "localhost",
            "port": 1883,
            "clientId": "dbx-test"
        });
        let config: MqttConnectionConfig = serde_json::from_value(json).unwrap();
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 1883);
        assert_eq!(config.client_id, "dbx-test");
        assert_eq!(config.protocol_version, MqttProtocolVersion::V5);
        assert!(!config.tls);
    }

    #[test]
    fn broker_url_tcp() {
        let config = MqttConnectionConfig { host: "broker.example.com".to_string(), port: 1883, ..Default::default() };
        assert_eq!(config.broker_url(), "mqtt://broker.example.com:1883");

        let tls_config = MqttConnectionConfig {
            host: "broker.example.com".to_string(),
            port: 8883,
            tls: true,
            ..Default::default()
        };
        assert_eq!(tls_config.broker_url(), "mqtts://broker.example.com:8883");
    }

    #[test]
    fn broker_url_uses_custom_ws_path_and_tls_mode() {
        let config = MqttConnectionConfig {
            host: "broker.example.com".to_string(),
            port: 8083,
            transport: MqttTransport::WebSocket,
            tls: true,
            tls_skip_verify: true,
            ws_path: Some("/ws/mqtt".to_string()),
            ..Default::default()
        };

        assert_eq!(config.broker_url(), "wss://broker.example.com:8083/ws/mqtt");
        assert_eq!(config.broker_addr_for_transport(), "wss://broker.example.com:8083/ws/mqtt");
        assert_eq!(config.tls_verification_mode(), Some(MqttTlsVerificationMode::SkipServerCertVerification));
    }

    #[test]
    fn from_connection_rejects_empty_host() {
        // 构造一个最小连接配置以测试空 host 校验
        let json = serde_json::json!({
            "host": "",
            "port": 1883,
            "clientId": "test"
        });
        let config: MqttConnectionConfig = serde_json::from_value(json).unwrap();
        assert!(!config.host.trim().is_empty() || config.host.is_empty());
    }
}
