use base64::Engine;
use serde::{Deserialize, Serialize};

const MAX_CAPTURE_DURATION_MS: u64 = 60_000;
const MAX_CAPTURE_MESSAGES: usize = 1_000;
const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PUBLISH_BYTES: usize = 16 * 1024 * 1024;
// Keep this aligned with the native Agent so a request accepted by Rust is
// never rejected solely because it crosses the Agent boundary.
const MAX_HEADER_COUNT: usize = 100;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_JETSTREAM_HISTORY_MESSAGES: usize = 1_000;
const MAX_JETSTREAM_HISTORY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsHeader {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsMessage {
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default)]
    pub headers: Vec<NatsHeader>,
    pub payload_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_text: Option<String>,
    pub received_at_ms: u64,
    pub size_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsServerInfo {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(default)]
    pub headers_supported: bool,
    #[serde(default)]
    pub jetstream_enabled: bool,
    #[serde(default)]
    pub max_payload: usize,
    #[serde(default)]
    pub connected_url: String,
    #[serde(default)]
    pub round_trip_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsJetStreamInfo {
    pub enabled: bool,
    #[serde(default)]
    pub memory_bytes: i64,
    #[serde(default)]
    pub storage_bytes: i64,
    #[serde(default)]
    pub streams: usize,
    #[serde(default)]
    pub consumers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamInfo {
    pub name: String,
    #[serde(default)]
    pub subjects: Vec<String>,
    #[serde(default)]
    pub storage: String,
    #[serde(default)]
    pub retention: String,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub first_sequence: u64,
    #[serde(default)]
    pub last_sequence: u64,
    #[serde(default)]
    pub consumers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamList {
    #[serde(default)]
    pub streams: Vec<NatsStreamInfo>,
    /// Server-side lists are capped so an administrative account cannot make
    /// a UI, Web response, or MCP tool call allocate without bound.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsConsumerInfo {
    pub stream: String,
    pub name: String,
    #[serde(default)]
    pub filter_subject: String,
    #[serde(default)]
    pub ack_policy: String,
    #[serde(default)]
    pub delivered_consumer_sequence: u64,
    #[serde(default)]
    pub delivered_stream_sequence: u64,
    #[serde(default)]
    pub ack_floor_consumer_sequence: u64,
    #[serde(default)]
    pub ack_floor_stream_sequence: u64,
    #[serde(default)]
    pub pending: u64,
    #[serde(default)]
    pub ack_pending: usize,
    #[serde(default)]
    pub redelivered: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsConsumerList {
    pub stream: String,
    #[serde(default)]
    pub consumers: Vec<NatsConsumerInfo>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsHistoryRequest {
    pub stream: String,
    #[serde(default)]
    pub start_sequence: Option<u64>,
    #[serde(default = "default_history_messages")]
    pub max_messages: usize,
    #[serde(default = "default_history_bytes")]
    pub max_bytes: usize,
}

fn default_history_messages() -> usize {
    100
}

fn default_history_bytes() -> usize {
    1_048_576
}

impl NatsHistoryRequest {
    pub fn bounded(mut self) -> Result<Self, String> {
        self.stream = validate_jetstream_name(&self.stream, "stream")?;
        if self.start_sequence == Some(0) {
            return Err("NATS JetStream history startSequence must be positive when provided".to_string());
        }
        if self.max_messages == 0 || self.max_messages > MAX_JETSTREAM_HISTORY_MESSAGES {
            return Err("NATS JetStream history maxMessages must be between 1 and 1000".to_string());
        }
        if self.max_bytes == 0 || self.max_bytes > MAX_JETSTREAM_HISTORY_BYTES {
            return Err("NATS JetStream history maxBytes must be between 1 and 16777216".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsHistoryResult {
    pub stream: String,
    #[serde(default)]
    pub messages: Vec<NatsMessage>,
    #[serde(default)]
    pub received_count: usize,
    #[serde(default)]
    pub skipped_count: usize,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_sequence: Option<u64>,
    /// Direct stream reads never acknowledge or mutate a business consumer.
    pub ack_mode: String,
    pub consumer_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsCaptureRequest {
    pub subject: String,
    #[serde(default = "default_capture_duration_ms")]
    pub duration_ms: u64,
    #[serde(default = "default_capture_messages")]
    pub max_messages: usize,
    #[serde(default = "default_capture_bytes")]
    pub max_bytes: usize,
    #[serde(default = "default_true")]
    pub include_headers: bool,
}

fn default_capture_duration_ms() -> u64 {
    5_000
}

fn default_capture_messages() -> usize {
    100
}

fn default_capture_bytes() -> usize {
    1_048_576
}

fn default_true() -> bool {
    true
}

impl NatsCaptureRequest {
    pub fn bounded(mut self) -> Result<Self, String> {
        if self.duration_ms == 0 || self.duration_ms > MAX_CAPTURE_DURATION_MS {
            return Err("NATS capture duration must be between 1 and 60000 ms".to_string());
        }
        if self.max_messages == 0 || self.max_messages > MAX_CAPTURE_MESSAGES {
            return Err("NATS capture maxMessages must be between 1 and 1000".to_string());
        }
        if self.max_bytes == 0 || self.max_bytes > MAX_CAPTURE_BYTES {
            return Err("NATS capture maxBytes must be between 1 and 16777216".to_string());
        }
        self.subject = validate_subject(&self.subject, true)?;
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsCaptureResult {
    pub subject: String,
    #[serde(default)]
    pub messages: Vec<NatsMessage>,
    pub received_count: usize,
    pub dropped_count: usize,
    pub truncated: bool,
    pub stop_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubscriptionRequest {
    pub subscription_id: String,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_group: Option<String>,
}

impl NatsSubscriptionRequest {
    pub fn validate(mut self) -> Result<Self, String> {
        self.subscription_id = self.subscription_id.trim().to_string();
        if self.subscription_id.is_empty() || self.subscription_id.len() > 128 {
            return Err("NATS subscriptionId is required and must be at most 128 characters".to_string());
        }
        if self.subscription_id.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()) {
            return Err("NATS subscriptionId cannot contain whitespace or control characters".to_string());
        }
        self.subject = validate_subject(&self.subject, true)?;
        self.queue_group = self
            .queue_group
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(validate_queue_group)
            .transpose()?;
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubscriptionInfo {
    pub subscription_id: String,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_group: Option<String>,
    pub state: String,
    #[serde(default)]
    pub received_count: usize,
    #[serde(default)]
    pub dropped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubscriptionMessageEvent {
    #[serde(default)]
    pub connection_id: String,
    pub subscription_id: String,
    pub sequence: u64,
    #[serde(default)]
    pub dropped_count: usize,
    pub message: NatsMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubscriptionStateEvent {
    #[serde(default)]
    pub connection_id: String,
    pub subscription_id: String,
    #[serde(default)]
    pub sequence: u64,
    pub state: String,
    #[serde(default)]
    pub dropped_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubscriptionErrorEvent {
    #[serde(default)]
    pub connection_id: String,
    pub subscription_id: String,
    #[serde(default)]
    pub sequence: u64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NatsSubscriptionEvent {
    Message(NatsSubscriptionMessageEvent),
    State(NatsSubscriptionStateEvent),
    Error(NatsSubscriptionErrorEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsPublishRequest {
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default)]
    pub headers: Vec<NatsHeader>,
    pub payload_base64: String,
}

impl NatsPublishRequest {
    pub fn validate(mut self) -> Result<Self, String> {
        self.subject = validate_subject(&self.subject, false)?;
        if let Some(reply) = self.reply.as_deref() {
            self.reply = Some(validate_subject(reply, false)?);
        }
        validate_headers(&self.headers)?;
        self.payload_bytes()?;
        Ok(self)
    }

    pub fn payload_bytes(&self) -> Result<usize, String> {
        // Reject oversized encoded values before base64 allocates a potentially
        // unbounded buffer. The agent also checks the server's advertised limit.
        if self.payload_base64.len() > encoded_base64_limit(MAX_PUBLISH_BYTES) {
            return Err("NATS publish payload must not exceed 16777216 bytes".to_string());
        }
        let payload = base64::engine::general_purpose::STANDARD
            .decode(&self.payload_base64)
            .map_err(|error| format!("Invalid NATS payload base64: {error}"))?;
        if payload.len() > MAX_PUBLISH_BYTES {
            return Err("NATS publish payload must not exceed 16777216 bytes".to_string());
        }
        Ok(payload.len())
    }
}

/// Validate the NATS dot-separated Subject grammar without accepting a
/// wildcard in a concrete publish/reply target.
pub fn validate_subject(value: &str, allow_wildcards: bool) -> Result<String, String> {
    let subject = value.trim();
    if subject.is_empty() {
        return Err("NATS Subject is required".to_string());
    }
    let token_count = subject.split('.').count();
    for (index, token) in subject.split('.').enumerate() {
        if token.is_empty() {
            return Err("NATS Subject cannot contain empty tokens".to_string());
        }
        if token.bytes().any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control()) {
            return Err("NATS Subject cannot contain whitespace or control characters".to_string());
        }
        match token {
            "*" if allow_wildcards => {}
            ">" if allow_wildcards && index + 1 == token_count => {}
            "*" | ">" => return Err("NATS publish Subject cannot contain wildcards".to_string()),
            _ if token.contains('*') || token.contains('>') => {
                return Err("NATS wildcard tokens must be exactly '*' or '>'".to_string())
            }
            _ => {}
        }
    }
    Ok(subject.to_string())
}

pub fn validate_jetstream_name(value: &str, kind: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 {
        return Err(format!("NATS JetStream {kind} name is required and must be at most 256 characters"));
    }
    if value.bytes().any(|byte| {
        byte.is_ascii_control() || byte.is_ascii_whitespace() || matches!(byte, b'.' | b'*' | b'>' | b'/' | b'\\')
    }) {
        return Err(format!("NATS JetStream {kind} name contains unsupported characters"));
    }
    Ok(value.to_string())
}

fn validate_headers(headers: &[NatsHeader]) -> Result<(), String> {
    if headers.len() > MAX_HEADER_COUNT {
        return Err("NATS publish supports at most 100 headers".to_string());
    }
    for header in headers {
        let key = header.key.trim();
        if key.is_empty()
            || key.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace() || byte == b':')
        {
            return Err("NATS header keys must be non-empty printable tokens".to_string());
        }
        if header.value.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
            return Err("NATS header values cannot contain CR or LF".to_string());
        }
        if header.value.len() > MAX_HEADER_VALUE_BYTES {
            return Err("NATS header values must not exceed 8192 bytes".to_string());
        }
    }
    Ok(())
}

fn validate_queue_group(value: &str) -> Result<String, String> {
    if value.len() > 256 || value.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()) {
        return Err("NATS queue group cannot contain whitespace or control characters".to_string());
    }
    Ok(value.to_string())
}

fn encoded_base64_limit(payload_limit: usize) -> usize {
    payload_limit.div_ceil(3).saturating_mul(4)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NatsPublishResult {
    pub accepted_by_client: bool,
    pub payload_bytes: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_limits_are_enforced() {
        let request = NatsCaptureRequest {
            subject: " orders.created ".to_string(),
            duration_ms: 5_000,
            max_messages: 100,
            max_bytes: 1_024,
            include_headers: true,
        }
        .bounded()
        .unwrap();
        assert_eq!(request.subject, "orders.created");
        assert!(NatsCaptureRequest { duration_ms: 0, ..request.clone() }.bounded().is_err());
        assert!(NatsCaptureRequest { max_messages: 1_001, ..request }.bounded().is_err());
    }

    #[test]
    fn publish_rejects_wildcards_and_empty_tokens() {
        let base = NatsPublishRequest {
            subject: "orders.created".to_string(),
            reply: None,
            headers: vec![],
            payload_base64: "".to_string(),
        };
        assert!(base.clone().validate().is_ok());
        assert!(NatsPublishRequest { subject: "orders.>".to_string(), ..base.clone() }.validate().is_err());
        assert!(NatsPublishRequest { subject: "orders..created".to_string(), ..base }.validate().is_err());
    }

    #[test]
    fn capture_allows_only_valid_subscription_wildcards() {
        assert_eq!(validate_subject("orders.*", true).unwrap(), "orders.*");
        assert_eq!(validate_subject("orders.>", true).unwrap(), "orders.>");
        assert!(validate_subject("orders.>.created", true).is_err());
        assert!(validate_subject("orders*.created", true).is_err());
        assert!(validate_subject("orders.>", false).is_err());
    }

    #[test]
    fn publish_validates_payload_reply_and_headers() {
        let base = NatsPublishRequest {
            subject: "orders.created".to_string(),
            reply: Some("_INBOX.result".to_string()),
            headers: vec![NatsHeader { key: "Nats-Msg-Id".to_string(), value: "42".to_string() }],
            payload_base64: "e30=".to_string(),
        };
        assert_eq!(base.clone().validate().unwrap().payload_bytes().unwrap(), 2);
        assert!(NatsPublishRequest { reply: Some("reply.>".to_string()), ..base.clone() }.validate().is_err());
        assert!(NatsPublishRequest {
            headers: vec![NatsHeader { key: "bad key".to_string(), value: "value".to_string() }],
            ..base.clone()
        }
        .validate()
        .is_err());
        assert!(NatsPublishRequest { payload_base64: "not-base64".to_string(), ..base }.validate().is_err());
    }

    #[test]
    fn subscriptions_validate_ids_subjects_and_queue_groups() {
        let request = NatsSubscriptionRequest {
            subscription_id: " sub-1 ".to_string(),
            subject: "orders.>".to_string(),
            queue_group: Some("workers".to_string()),
        }
        .validate()
        .unwrap();
        assert_eq!(request.subscription_id, "sub-1");
        assert!(NatsSubscriptionRequest { subscription_id: "sub 1".to_string(), ..request.clone() }
            .validate()
            .is_err());
        assert!(NatsSubscriptionRequest { subject: "orders.>.created".to_string(), ..request.clone() }
            .validate()
            .is_err());
        assert!(NatsSubscriptionRequest { queue_group: Some("worker group".to_string()), ..request }
            .validate()
            .is_err());
    }

    #[test]
    fn jetstream_history_bounds_and_names_are_validated() {
        let request = NatsHistoryRequest {
            stream: " ORDERS ".to_string(),
            start_sequence: Some(5),
            max_messages: 100,
            max_bytes: 1_024,
        }
        .bounded()
        .unwrap();
        assert_eq!(request.stream, "ORDERS");
        assert!(NatsHistoryRequest { stream: "orders.stream".to_string(), ..request.clone() }.bounded().is_err());
        assert!(NatsHistoryRequest { start_sequence: Some(0), ..request.clone() }.bounded().is_err());
        assert!(NatsHistoryRequest { max_messages: 1_001, ..request }.bounded().is_err());
    }
}
