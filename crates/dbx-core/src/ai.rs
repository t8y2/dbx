use crate::token_usage::TokenUsage;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use tokio::sync::{Notify, RwLock};
use uuid::Uuid;

/// Default number of automatic retries on transient API errors
/// (rate limits, timeouts, network blips). Users can adjust the limit in
/// Settings → AI. Set to 0 to disable automatic retries entirely.
pub const DEFAULT_MAX_RETRIES: u32 = 2;
pub const MAX_MAX_RETRIES: u32 = 10;

/// Clamp a user-provided max-retries value into the supported range.
pub fn clamp_max_retries(value: u32) -> u32 {
    value.clamp(0, MAX_MAX_RETRIES)
}

// ---------------------------------------------------------------------------
// Stream cancel registry
// ---------------------------------------------------------------------------

static AI_STREAMS: LazyLock<RwLock<HashMap<String, Arc<Notify>>>> = LazyLock::new(|| RwLock::new(HashMap::new()));

pub async fn register_stream(session_id: &str) -> Arc<Notify> {
    let notify = Arc::new(Notify::new());
    AI_STREAMS.write().await.insert(session_id.to_string(), notify.clone());
    notify
}

pub async fn cancel_stream(session_id: &str) -> bool {
    if let Some(notify) = AI_STREAMS.read().await.get(session_id) {
        notify.notify_one();
        true
    } else {
        false
    }
}

pub async fn unregister_stream(session_id: &str) {
    AI_STREAMS.write().await.remove(session_id);
}

/// Error returned by streaming functions when the user cancels mid-stream.
///
/// `run_agent_loop` matches on this exact string to distinguish a cancellation
/// from a normal completion and stop the loop cleanly. Streaming functions MUST
/// return this (not `Ok`) when `cancelled` fires, otherwise the agent loop
/// treats the truncated turn as a normal completion and keeps going.
pub const AGENT_CANCELLED_ERROR: &str = "Agent loop cancelled";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    #[serde(alias = "anthropic")]
    Claude,
    #[serde(rename = "anthropic-compatible")]
    AnthropicCompatible,
    Openai,
    Gemini,
    Deepseek,
    Qwen,
    Ollama,
    #[serde(rename = "openai-compatible")]
    OpenaiCompatible,
    #[serde(rename = "codex-cli")]
    CodexCli,
    #[serde(rename = "claude-code-cli")]
    ClaudeCodeCli,
    #[serde(rename = "pi-agent-cli")]
    PiAgentCli,
    Custom,
}

impl AiProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            AiProvider::Claude => "claude",
            AiProvider::AnthropicCompatible => "anthropic-compatible",
            AiProvider::Openai => "openai",
            AiProvider::Gemini => "gemini",
            AiProvider::Deepseek => "deepseek",
            AiProvider::Qwen => "qwen",
            AiProvider::Ollama => "ollama",
            AiProvider::OpenaiCompatible => "openai-compatible",
            AiProvider::ClaudeCodeCli => "claude-code-cli",
            AiProvider::PiAgentCli => "pi-agent-cli",
            AiProvider::CodexCli => "codex-cli",
            AiProvider::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiApiStyle {
    #[default]
    Completions,
    Responses,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AiAuthMethod {
    #[default]
    ApiKey,
    Bearer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AiReasoningLevel {
    #[default]
    Default,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl AiReasoningLevel {
    pub fn as_codex_effort(&self) -> Option<&'static str> {
        match self {
            AiReasoningLevel::Default => None,
            AiReasoningLevel::Minimal => Some("minimal"),
            AiReasoningLevel::Low => Some("low"),
            AiReasoningLevel::Medium => Some("medium"),
            AiReasoningLevel::High => Some("high"),
            AiReasoningLevel::Xhigh | AiReasoningLevel::Max => None,
        }
    }

    pub fn as_claude_code_effort(&self) -> Option<&'static str> {
        match self {
            AiReasoningLevel::Default | AiReasoningLevel::Minimal => None,
            AiReasoningLevel::Low => Some("low"),
            AiReasoningLevel::Medium => Some("medium"),
            AiReasoningLevel::High => Some("high"),
            AiReasoningLevel::Xhigh => Some("xhigh"),
            AiReasoningLevel::Max => Some("max"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum AiEffortLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl std::str::FromStr for AiEffortLevel {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::Xhigh),
            "max" => Ok(Self::Max),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiCapabilitySource {
    ProviderApi,
    LocalCli,
    OfficialRegistry,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum AiEffortSelection {
    ProviderDefault,
    Disabled,
    Enum(String),
    Integer(i64),
    Boolean(bool),
    Text(String),
}

impl AiEffortSelection {
    pub fn explicit_string(&self) -> Option<&str> {
        match self {
            Self::Enum(value) | Self::Text(value) => Some(value),
            Self::ProviderDefault | Self::Disabled | Self::Integer(_) | Self::Boolean(_) => None,
        }
    }

    pub fn cli_value(&self) -> Option<String> {
        match self {
            Self::ProviderDefault => None,
            Self::Disabled => Some("none".to_string()),
            Self::Enum(value) | Self::Text(value) => {
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_string())
            }
            Self::Integer(value) => Some(value.to_string()),
            Self::Boolean(value) => Some(if *value { "high" } else { "none" }.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiEffortOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub selection: AiEffortSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEffortCapability {
    Enum {
        options: Vec<AiEffortOption>,
        default: AiEffortSelection,
        source: AiCapabilitySource,
    },
    Integer {
        min: i64,
        max: i64,
        step: i64,
        default: AiEffortSelection,
        #[serde(default, rename = "specialValues", skip_serializing_if = "Vec::is_empty")]
        special_values: Vec<AiEffortOption>,
        source: AiCapabilitySource,
    },
    Boolean {
        default: AiEffortSelection,
        source: AiCapabilitySource,
    },
    FreeText {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        source: AiCapabilitySource,
    },
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiActiveModelSelection {
    pub config_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiModelEffortPreference {
    pub config_id: String,
    pub model_id: String,
    pub selection: AiEffortSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSelectionState {
    #[serde(default = "default_ai_chat_selection_version")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<AiActiveModelSelection>,
    #[serde(default)]
    pub effort_preferences: Vec<AiModelEffortPreference>,
}

impl Default for AiChatSelectionState {
    fn default() -> Self {
        Self { version: default_ai_chat_selection_version(), active: None, effort_preferences: Vec::new() }
    }
}

fn default_ai_chat_selection_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(flatten)]
    pub config: AiConfig,
}

impl AiConfigItem {
    pub fn new_id() -> String {
        Uuid::new_v4().to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelListItem {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_effort_levels: Vec<AiEffortLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: AiProvider,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub auth_method: AiAuthMethod,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub models: Vec<AiModelListItem>,
    #[serde(default)]
    pub api_style: AiApiStyle,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default = "default_enable_thinking")]
    pub enable_thinking: bool,
    #[serde(default)]
    pub reasoning_level: AiReasoningLevel,
    /// Per-request effort selected in the assistant. Provider settings do not
    /// persist this field; it is attached to a runtime config clone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_effort: Option<AiEffortSelection>,
    #[serde(default)]
    pub context_window: Option<u32>,
    /// Maximum number of automatic retries on transient API errors
    /// (rate limits, timeouts, network blips). `None` uses the default (2).
    /// Set to `Some(0)` to disable automatic retries entirely.
    #[serde(default)]
    pub max_retries: Option<u32>,
    #[serde(default)]
    pub codex_cli_path: Option<String>,
    #[serde(default)]
    pub codex_cli_env: HashMap<String, String>,
    #[serde(default)]
    pub claude_code_cli_path: Option<String>,
    #[serde(default)]
    pub claude_code_cli_env: HashMap<String, String>,
    #[serde(default)]
    pub pi_agent_cli_path: Option<String>,
    #[serde(default)]
    pub pi_agent_cli_env: HashMap<String, String>,
}

fn default_enable_thinking() -> bool {
    true
}

/// Whether the provider is a CLI-based provider that goes through its own
/// executable (claude-code, codex, pi) rather than through `with_retry` /
/// `with_stream_retry`.
pub fn is_cli_provider(provider: &AiProvider) -> bool {
    matches!(provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli)
}

/// Merge the global `max_retries` setting into an `AiConfig`.
///
/// Applied by all API-backed entry points at request time.  CLI providers are
/// skipped because they use their own retry logic and never reach the
/// `with_retry` / `with_stream_retry` paths.
///
/// Some API-backed entry points (model listing, effort resolution) do not
/// currently call `with_retry` and so the merged value is a no-op for them.
/// The merge is still applied uniformly so that every API-backed command
/// follows the same entry-point pattern — if retry logic is added to those
/// functions later, the global setting takes effect automatically.
pub fn merge_global_max_retries(config: &mut AiConfig, max_retries: u32) {
    if !is_cli_provider(&config.provider) {
        config.max_retries = Some(max_retries);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String,
    pub content: String,
    /// Tool call ID for tool results (role="tool"). Used to associate
    /// a tool result with its originating tool call in multi-turn loops.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool calls made by the assistant (role="assistant"). Used to
    /// reconstruct tool_use content blocks for providers like Anthropic
    /// that require them in the conversation history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallRef>,
}

/// A lightweight reference to a tool call within an assistant message.
/// Stores the id, name, and arguments needed to reconstruct provider-specific
/// tool_use content blocks (e.g. Anthropic's `{"type":"tool_use", ...}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRef {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    /// Opaque provider response data that must be replayed unchanged in
    /// follow-up requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskContract {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_request: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompletionRequest {
    pub config: AiConfig,
    pub system_prompt: String,
    pub messages: Vec<AiMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_contract: Option<AiTaskContract>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStreamChunk {
    pub session_id: String,
    pub delta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_delta: Option<String>,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covered_messages: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub connection_name: String,
    pub database: String,
    pub messages: Vec<AiChatMessage>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_effort_levels: Vec<AiEffortLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_capability: Option<AiEffortCapability>,
}

impl AiModelInfo {
    pub fn new(id: impl Into<String>, display_name: Option<String>) -> Self {
        Self { id: id.into(), display_name, supported_effort_levels: Vec::new(), effort_capability: None }
    }
}

/// Result of an AI connection test (mirrors CC-Switch's StreamCheckResult).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestConnectionResult {
    pub success: bool,
    pub message: String,
    /// First-chunk latency in milliseconds, if successful.
    pub latency_ms: Option<u64>,
    pub model_used: String,
    /// Error category for the frontend to render specific guidance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_category: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Ensure the endpoint has an OpenAI API version prefix (`/v1`) when the user
/// entered a bare origin without any path.  This handles the common mistake of
/// entering a host like `https://api.example.com` without the `/v1` path that
/// most OpenAI-compatible providers require.
///
/// Strategy (mirrors CC-Switch):
/// 1. Already ends with `/v1` → return as-is.
/// 2. Pure origin (no path after host) → append `/v1`.
/// 3. Has a custom path → leave it alone (user probably knows what they're doing).
fn ensure_openai_version_prefix(endpoint: &str) -> String {
    let ep = endpoint.trim().trim_end_matches('/');
    if ep.ends_with("/v1") {
        return ep.to_string();
    }
    // Check whether the URL is a bare origin with no path segment.
    let origin_only = match ep.split_once("://") {
        Some((_scheme, rest)) => !rest.contains('/'),
        None => !ep.contains('/'),
    };
    if origin_only {
        format!("{ep}/v1")
    } else {
        ep.to_string()
    }
}

fn ensure_anthropic_version_prefix(endpoint: &str) -> String {
    let ep = endpoint.trim().trim_end_matches('/');
    if ep.ends_with("/v1") {
        ep.to_string()
    } else {
        format!("{ep}/v1")
    }
}

pub fn resolve_endpoint(config: &AiConfig) -> String {
    let ep = config.endpoint.trim().trim_end_matches('/');
    if matches!(config.provider, AiProvider::Gemini) {
        if ep.ends_with(":generateContent") || ep.ends_with(":streamGenerateContent") {
            return ep.to_string();
        }
        let base = ep.trim_end_matches("/v1beta");
        return format!("{base}/v1beta/models/{}:generateContent", config.model);
    }
    if matches!(config.provider, AiProvider::Openai) {
        let base = ep
            .strip_suffix("/chat/completions")
            .or_else(|| ep.strip_suffix("/responses"))
            .unwrap_or(ep)
            .trim_end_matches('/');
        let base = ensure_openai_version_prefix(base);
        return if config.api_style == AiApiStyle::Responses {
            format!("{base}/responses")
        } else {
            format!("{base}/chat/completions")
        };
    }
    if ep.ends_with("/chat/completions") || ep.ends_with("/responses") || ep.ends_with("/messages") {
        return ep.to_string();
    }
    if uses_anthropic_messages_api(config) {
        let base = ensure_anthropic_version_prefix(ep);
        return format!("{base}/messages");
    }
    match config.provider {
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::Custom => {
            let base = ensure_openai_version_prefix(ep);
            if config.api_style == AiApiStyle::Responses {
                format!("{base}/responses")
            } else {
                format!("{base}/chat/completions")
            }
        }
        AiProvider::Claude
        | AiProvider::AnthropicCompatible
        | AiProvider::CodexCli
        | AiProvider::ClaudeCodeCli
        | AiProvider::PiAgentCli
        | AiProvider::Gemini => unreachable!(),
    }
}

pub fn uses_anthropic_messages_api(config: &AiConfig) -> bool {
    matches!(config.provider, AiProvider::Claude | AiProvider::AnthropicCompatible)
        || matches!(config.provider, AiProvider::Custom) && config.api_style == AiApiStyle::AnthropicMessages
}

fn resolve_gemini_stream_endpoint(config: &AiConfig) -> String {
    let endpoint = resolve_endpoint(config);
    if endpoint.ends_with(":streamGenerateContent") {
        endpoint
    } else {
        endpoint.replace(":generateContent", ":streamGenerateContent")
    }
}

pub fn resolve_model_list_endpoint(config: &AiConfig) -> Result<String, String> {
    if matches!(config.provider, AiProvider::Gemini) {
        let ep = config.endpoint.trim().trim_end_matches('/');
        if ep.is_empty() {
            return Err("Endpoint is required".to_string());
        }
        let base = ep.split("/v1beta/models/").next().unwrap_or(ep).trim_end_matches("/v1beta").trim_end_matches('/');
        return Ok(format!("{base}/v1beta/models"));
    }

    let ep = config.endpoint.trim().trim_end_matches('/');
    if ep.is_empty() {
        return Err("Endpoint is required".to_string());
    }
    if ep.ends_with("/models") {
        return Ok(ep.to_string());
    }

    let base = ep
        .strip_suffix("/chat/completions")
        .or_else(|| ep.strip_suffix("/responses"))
        .or_else(|| ep.strip_suffix("/messages"))
        .unwrap_or(ep)
        .trim_end_matches('/');

    if uses_anthropic_messages_api(config) {
        let base = ensure_anthropic_version_prefix(base);
        return Ok(format!("{base}/models"));
    }

    let base = ensure_openai_version_prefix(base);

    Ok(format!("{base}/models"))
}

pub fn stream_data_payload(line: &str) -> Option<&str> {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") || line.starts_with("id:") {
        return None;
    }
    if let Some(data) = line.strip_prefix("data:") {
        return Some(data.trim_start());
    }
    if line.starts_with('{') {
        return Some(line);
    }
    None
}

fn stream_event_name(line: &str) -> Option<&str> {
    line.trim().strip_prefix("event:").map(str::trim).filter(|event| !event.is_empty())
}

fn anthropic_stream_error(event_name: Option<&str>, event: &serde_json::Value) -> Option<String> {
    if event_name != Some("error") && event["type"].as_str() != Some("error") {
        return None;
    }

    let error = event.get("error").unwrap_or(event);
    let error_type = error["type"].as_str().filter(|value| !value.trim().is_empty());
    let message =
        error["message"].as_str().or_else(|| event["message"].as_str()).filter(|value| !value.trim().is_empty());
    let detail = match (error_type, message) {
        (Some(error_type), Some(message)) => format!("{error_type}: {message}"),
        (Some(error_type), None) => error_type.to_string(),
        (None, Some(message)) => message.to_string(),
        (None, None) => truncate_diagnostic(&event.to_string(), 500),
    };
    let category = classify_error(&detail);
    Some(format!("[{category}] Anthropic stream error ({detail})"))
}

fn drain_next_stream_line(buffer: &mut Vec<u8>) -> Result<Option<String>, String> {
    let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    let mut line = buffer.drain(..=pos).collect::<Vec<u8>>();
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    String::from_utf8(line).map(Some).map_err(|e| format!("AI stream returned invalid UTF-8: {e}"))
}

pub fn claude_stream_text(event: &serde_json::Value) -> Option<&str> {
    if event["type"] == "content_block_delta" {
        return event["delta"]["text"].as_str();
    }
    None
}

fn text_from_content_value(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
        return Some(text.to_string());
    }

    value.as_array().and_then(|parts| {
        let text = parts
            .iter()
            .filter_map(|part| {
                part["text"]
                    .as_str()
                    .or_else(|| part["content"].as_str())
                    .or_else(|| part["input_text"].as_str())
                    .or_else(|| part["output_text"].as_str())
            })
            .collect::<Vec<_>>()
            .join("");
        (!text.is_empty()).then_some(text)
    })
}

pub fn openai_response_text(data: &serde_json::Value) -> String {
    data["choices"]
        .get(0)
        .and_then(|choice| {
            text_from_content_value(&choice["message"]["content"])
                .or_else(|| text_from_content_value(&choice["text"]))
                .or_else(|| text_from_content_value(&choice["delta"]["content"]))
        })
        .or_else(|| text_from_content_value(&data["content"]))
        .or_else(|| {
            let text = responses_text(data);
            (!text.is_empty()).then_some(text)
        })
        .unwrap_or_default()
}

pub fn openai_stream_text(event: &serde_json::Value) -> Option<String> {
    event["choices"]
        .get(0)
        .and_then(|choice| {
            text_from_content_value(&choice["delta"]["content"])
                .or_else(|| text_from_content_value(&choice["message"]["content"]))
                .or_else(|| text_from_content_value(&choice["text"]))
        })
        .or_else(|| text_from_content_value(&event["content"]))
        .or_else(|| event["delta"].as_str().filter(|text| !text.is_empty()).map(ToString::to_string))
}

pub fn openai_stream_reasoning(event: &serde_json::Value) -> Option<&str> {
    event["choices"]
        .get(0)
        .and_then(|choice| {
            choice["delta"]["reasoning_content"]
                .as_str()
                .or_else(|| choice["delta"]["reasoning"].as_str())
                .or_else(|| choice["delta"]["thinking"].as_str())
        })
        .filter(|text| !text.is_empty())
}

fn openai_stream_has_finish_reason(event: &serde_json::Value) -> bool {
    event["choices"].as_array().is_some_and(|choices| {
        choices.iter().any(|choice| choice["finish_reason"].as_str().is_some_and(|reason| !reason.is_empty()))
    })
}

pub fn responses_stream_text(event: &serde_json::Value) -> Option<&str> {
    let event_type = event["type"].as_str().unwrap_or_default();
    if !event_type.is_empty() && event_type != "response.output_text.delta" {
        return None;
    }

    event["delta"].as_str().filter(|s| !s.is_empty())
}

fn responses_max_output_tokens(max_tokens: Option<u32>) -> u32 {
    max_tokens.unwrap_or(2048).max(16)
}

fn responses_token_usage(event: &serde_json::Value) -> Option<TokenUsage> {
    let usage = event.get("usage").or_else(|| event.get("response").and_then(|response| response.get("usage")))?;
    let input = usage.get("input_tokens").and_then(|v| v.as_u64())?;
    let output = usage.get("output_tokens").and_then(|v| v.as_u64())?;
    Some(TokenUsage { input_tokens: input as u32, output_tokens: output as u32 })
}

fn is_openai_api_endpoint(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.eq_ignore_ascii_case("api.openai.com")))
        .unwrap_or(false)
}

fn is_openai_api_config(config: &AiConfig) -> bool {
    // OpenAI provider can be routed through a custom proxy while still requiring OpenAI request semantics.
    matches!(config.provider, AiProvider::Openai) || is_openai_api_endpoint(&config.endpoint)
}

fn is_openai_reasoning_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model.starts_with("gpt-5") || model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4")
}

fn uses_openai_max_completion_tokens(config: &AiConfig) -> bool {
    is_openai_api_config(config) && is_openai_reasoning_model(&config.model)
}

fn set_chat_completion_token_limit(body: &mut serde_json::Value, config: &AiConfig, max_tokens: u32) {
    if uses_openai_max_completion_tokens(config) {
        body["max_completion_tokens"] = json!(max_tokens);
    } else {
        body["max_tokens"] = json!(max_tokens);
    }
}

/// Kimi K2.5+ models (including K2.7-Code) handle thinking flags differently
/// and reject the OpenAI-compatible `extra_body.chat_template_kwargs` toggle.
///
/// Matches `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code`, K3+, and future versions,
/// while excluding older K2 variants (`kimi-k2`, `kimi-k2-thinking`, etc.).
/// Regex equivalent: /kimi-k(?:2\.[5-9]\d*|[3-9]\d*)/
fn is_kimi_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    if let Some(rest) = model.strip_prefix("kimi-k") {
        if rest.starts_with("2.") && rest.len() > 2 {
            // K2.x — the digit after "2." must be >= 5 (so K2.5+)
            rest[2..].chars().next().is_some_and(|c| c.is_ascii_digit() && c >= '5')
        } else {
            // K3+ — first char must be digit >= 3
            rest.chars().next().is_some_and(|c| c.is_ascii_digit() && c >= '3')
        }
    } else {
        false
    }
}

fn apply_chat_completion_thinking_toggle(body: &mut serde_json::Value, config: &AiConfig) {
    if config.runtime_effort.is_some() {
        return;
    }
    if config.enable_thinking {
        return;
    }

    if is_openai_api_config(config) {
        // `extra_body.chat_template_kwargs` is a third-party compatibility extension,
        // not an OpenAI API parameter. OpenAI models use their native defaults here.
        return;
    }

    if matches!(config.provider, AiProvider::Ollama) {
        // Ollama's OpenAI-compatible API uses reasoning_effort instead of
        // forwarding provider-specific chat template arguments.
        body["reasoning_effort"] = json!("none");
    } else if !is_kimi_model(&config.model) {
        body["extra_body"] = json!({
            "chat_template_kwargs": { "enable_thinking": false }
        });
    }
}

fn runtime_thinking_enabled(config: &AiConfig) -> bool {
    match config.runtime_effort.as_ref() {
        Some(AiEffortSelection::Disabled | AiEffortSelection::Boolean(false)) => false,
        Some(_) => true,
        None => config.enable_thinking,
    }
}

fn responses_text(data: &serde_json::Value) -> String {
    if let Some(text) = data["output_text"].as_str().filter(|text| !text.is_empty()) {
        return text.to_string();
    }

    data["output"]
        .as_array()
        .and_then(|items| {
            items.iter().find_map(|item| {
                item["content"].as_array().and_then(|parts| parts.iter().find_map(|p| p["text"].as_str()))
            })
        })
        .unwrap_or_default()
        .to_string()
}

pub fn gemini_text(data: &serde_json::Value) -> String {
    data["candidates"]
        .get(0)
        .and_then(|candidate| candidate["content"]["parts"].as_array())
        .map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(""))
        .unwrap_or_default()
}

pub fn extract_error(data: &serde_json::Value) -> Option<String> {
    data["error"]["message"].as_str().or_else(|| data["error"].as_str()).map(ToString::to_string)
}

pub fn build_responses_input(system_prompt: &str, messages: &[AiMessage]) -> serde_json::Value {
    let mut input = Vec::new();
    if !system_prompt.is_empty() {
        input.push(json!({
            "role": "developer",
            "content": system_prompt,
        }));
    }
    for m in messages {
        input.push(json!({
            "role": m.role,
            "content": m.content,
        }));
    }
    json!(input)
}

fn build_responses_input_with_tools(system_prompt: &str, messages: &[AiMessage]) -> serde_json::Value {
    let mut input = Vec::new();
    if !system_prompt.is_empty() {
        input.push(json!({
            "role": "developer",
            "content": system_prompt,
        }));
    }

    for message in messages {
        if message.role == "tool" {
            input.push(json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id.as_deref().unwrap_or_default(),
                "output": message.content,
            }));
            continue;
        }

        if message.role == "assistant" && !message.tool_calls.is_empty() {
            if !message.content.is_empty() {
                input.push(json!({
                    "role": "assistant",
                    "content": message.content,
                }));
            }
            for tool_call in &message.tool_calls {
                input.push(json!({
                    "type": "function_call",
                    "call_id": tool_call.id,
                    "name": tool_call.name,
                    "arguments": tool_call.arguments.to_string(),
                }));
            }
            continue;
        }

        input.push(json!({
            "role": message.role,
            "content": message.content,
        }));
    }

    json!(input)
}

fn responses_function_tool(tool: &crate::agent_events::ToolDefinition) -> serde_json::Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
    })
}

fn responses_tool_index(
    event: &serde_json::Value,
    item_indices: &mut HashMap<String, u32>,
    next_index: &mut u32,
) -> (String, u32) {
    let item = &event["item"];
    let item_id = item["id"]
        .as_str()
        .or_else(|| event["item_id"].as_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("responses-tool-{next_index}"));
    let index = item_indices.get(&item_id).copied().unwrap_or_else(|| {
        let index = event["output_index"].as_u64().map(|i| i as u32).unwrap_or(*next_index);
        *next_index = (*next_index).max(index + 1);
        item_indices.insert(item_id.clone(), index);
        index
    });
    (item_id, index)
}

fn emit_responses_function_call_item(
    event: &serde_json::Value,
    item_indices: &mut HashMap<String, u32>,
    started_indices: &mut HashSet<u32>,
    argument_indices: &mut HashSet<u32>,
    next_index: &mut u32,
    on_event: &impl Fn(StreamToolEvent),
) -> Option<u32> {
    let item = &event["item"];
    if item["type"].as_str() != Some("function_call") {
        return None;
    }

    let (_item_id, index) = responses_tool_index(event, item_indices, next_index);
    if started_indices.insert(index) {
        let id = item["call_id"].as_str().or_else(|| item["id"].as_str()).unwrap_or_default().to_string();
        let name = item["name"].as_str().unwrap_or_default().to_string();
        on_event(StreamToolEvent::ToolCallStart { index, id, name });
    }

    if !argument_indices.contains(&index) {
        if let Some(arguments) = item["arguments"].as_str().filter(|s| !s.is_empty()) {
            argument_indices.insert(index);
            on_event(StreamToolEvent::ToolCallDelta { index, fragment: arguments.to_string() });
        }
    }

    Some(index)
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

fn provider_requires_api_key(provider: &AiProvider) -> bool {
    matches!(
        provider,
        AiProvider::Claude | AiProvider::Openai | AiProvider::Gemini | AiProvider::Deepseek | AiProvider::Qwen
    )
}

fn normalized_api_key(config: &AiConfig) -> &str {
    config.api_key.trim()
}

fn validate_config(config: &AiConfig) -> Result<(), String> {
    crate::ai_effort::validate_runtime_effort(config)?;
    if matches!(config.provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli) {
        return Ok(());
    }
    if provider_requires_api_key(&config.provider) && config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    if config.endpoint.trim().is_empty() {
        return Err("Endpoint is required".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("Model is required".to_string());
    }
    Ok(())
}

fn validate_model_list_config(config: &AiConfig) -> Result<(), String> {
    if matches!(config.provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli) {
        return Ok(());
    }
    if provider_requires_api_key(&config.provider) && config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    resolve_model_list_endpoint(config).map(|_| ())
}

pub fn maybe_bearer_headers(config: &AiConfig) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let api_key = normalized_api_key(config);
    if !api_key.is_empty() {
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| e.to_string())?);
    }
    Ok(headers)
}

pub fn claude_headers(config: &AiConfig) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let api_key = normalized_api_key(config);
    if !api_key.is_empty() {
        match config.auth_method {
            AiAuthMethod::Bearer => {
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| e.to_string())?,
                );
            }
            AiAuthMethod::ApiKey => {
                headers.insert("x-api-key", HeaderValue::from_str(api_key).map_err(|e| e.to_string())?);
            }
        }
    }
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    Ok(headers)
}

fn claude_http_model(model: &str) -> &str {
    let model = model.trim();
    if model.to_ascii_lowercase().ends_with("[1m]") {
        model[..model.len() - "[1m]".len()].trim_end()
    } else {
        model
    }
}

fn normalize_ai_proxy_url(proxy_url: &str) -> String {
    let proxy_url = proxy_url.trim();
    if proxy_url.contains("://") || proxy_url.is_empty() {
        proxy_url.to_string()
    } else {
        format!("http://{proxy_url}")
    }
}

fn ai_endpoint_is_loopback(config: &AiConfig) -> bool {
    let endpoint = resolve_endpoint(config);
    let Ok(url) = reqwest::Url::parse(&endpoint) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().map(|addr| addr.is_loopback()).unwrap_or(false)
}

pub fn build_ai_http_client(config: &AiConfig, timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(timeout_secs));
    if config.proxy_enabled && !config.proxy_url.trim().is_empty() && !ai_endpoint_is_loopback(config) {
        let proxy_url = normalize_ai_proxy_url(&config.proxy_url);
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Invalid AI proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

fn parse_model_list_response(data: &serde_json::Value) -> Result<Vec<AiModelInfo>, String> {
    let items = data["data"].as_array().ok_or_else(|| "Invalid model list response".to_string())?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();

    for item in items {
        let Some(id) = item["id"].as_str().filter(|id| !id.trim().is_empty()) else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }

        let display_name = item["display_name"]
            .as_str()
            .or_else(|| item["name"].as_str())
            .filter(|name| !name.trim().is_empty() && *name != id)
            .map(ToString::to_string);

        let mut model = AiModelInfo::new(id, display_name);
        model.effort_capability = parse_dynamic_effort_capability(item, AiCapabilitySource::ProviderApi);
        models.push(model);
    }

    Ok(models)
}

fn parse_dynamic_effort_capability(
    model: &serde_json::Value,
    source: AiCapabilitySource,
) -> Option<AiEffortCapability> {
    let effort = model
        .pointer("/capabilities/effort")
        .or_else(|| model.pointer("/capabilities/reasoning/effort"))
        .or_else(|| model.get("effort"));
    if effort.and_then(|value| value.get("supported")).and_then(serde_json::Value::as_bool) == Some(false) {
        return Some(AiEffortCapability::Unsupported);
    }
    if let Some(levels) = effort.and_then(serde_json::Value::as_object) {
        let mut supported = levels
            .iter()
            .filter(|(level, capability)| {
                level.as_str() != "supported"
                    && capability.get("supported").and_then(serde_json::Value::as_bool) == Some(true)
            })
            .map(|(level, _)| level.as_str())
            .collect::<Vec<_>>();
        const EFFORT_ORDER: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];
        supported.sort_by_key(|level| EFFORT_ORDER.iter().position(|known| known == level).unwrap_or(usize::MAX));
        if let Some(capability) = crate::ai_effort::dynamic_enum_capability(supported, source.clone()) {
            return Some(capability);
        }
    }
    let levels = effort
        .and_then(|value| {
            value
                .get("supported_effort_levels")
                .or_else(|| value.get("supportedEffortLevels"))
                .or_else(|| value.get("values"))
                .or_else(|| value.get("levels"))
        })
        .or_else(|| model.get("supported_effort_levels"))
        .or_else(|| model.get("supportedEffortLevels"))
        .and_then(serde_json::Value::as_array)?;
    crate::ai_effort::dynamic_enum_capability(levels.iter().filter_map(serde_json::Value::as_str), source)
}

fn decorate_model_capabilities(config: &AiConfig, models: &mut [AiModelInfo]) {
    for model in models {
        if matches!(config.provider, AiProvider::AnthropicCompatible) || model.effort_capability.is_none() {
            model.effort_capability = crate::ai_effort::static_effort_capability(config, &model.id);
        }
    }
}

fn parse_gemini_model_list_response(data: &serde_json::Value) -> Result<Vec<AiModelInfo>, String> {
    let items = data["models"].as_array().ok_or_else(|| "Invalid Gemini model list response".to_string())?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for item in items {
        if !crate::ai_model_filter::gemini_item_is_assistant_compatible(item) {
            continue;
        }
        let Some(name) = item["name"].as_str() else {
            continue;
        };
        let id = name.trim().trim_start_matches("models/");
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let display_name = item["displayName"].as_str().filter(|name| !name.trim().is_empty()).map(ToString::to_string);
        models.push(AiModelInfo::new(id, display_name));
    }
    Ok(models)
}

async fn list_claude_models(client: &reqwest::Client, config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let endpoint = resolve_model_list_endpoint(config)?;
    let headers = claude_headers(config)?;
    let mut after_id: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_models = HashSet::new();
    let mut models = Vec::new();

    loop {
        let mut request = client.get(&endpoint).headers(headers.clone());
        if let Some(after_id) = after_id.as_deref() {
            request = request.query(&[("after_id", after_id)]);
        }
        let res = request.send().await.map_err(|e| format!("Claude model list request failed: {e}"))?;

        let status = res.status();
        if !status.is_success() {
            if matches!(config.provider, AiProvider::AnthropicCompatible | AiProvider::Custom)
                && matches!(status, reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED)
            {
                return Err(format!(
                    "[modelDiscoveryUnsupported] The provider does not expose a model list at {endpoint}. Save the provider and enter a model ID manually."
                ));
            }
            return Err(categorized_http_error(res, "Claude model list", &config.api_key).await);
        }

        let data: serde_json::Value =
            res.json().await.map_err(|e| format!("Claude model list returned invalid JSON (HTTP {status}): {e}"))?;
        for model in parse_model_list_response(&data)? {
            if seen_models.insert(model.id.clone()) {
                models.push(model);
            }
        }

        if data["has_more"].as_bool() != Some(true) {
            break;
        }
        let next_cursor = data["last_id"]
            .as_str()
            .filter(|cursor| !cursor.trim().is_empty())
            .ok_or_else(|| "Claude model list response has_more=true but last_id is missing".to_string())?;
        if !seen_cursors.insert(next_cursor.to_string()) {
            return Err(format!("Claude model list returned repeated last_id cursor: {next_cursor}"));
        }
        after_id = Some(next_cursor.to_string());
    }

    Ok(models)
}

async fn list_gemini_models(client: &reqwest::Client, config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let endpoint = resolve_model_list_endpoint(config)?;
    let mut page_token: Option<String> = None;
    let mut seen = HashSet::new();
    let mut models = Vec::new();

    loop {
        let mut request = client.get(&endpoint).query(&[("key", config.api_key.as_str()), ("pageSize", "1000")]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }

        let res = request.send().await.map_err(|e| format!("Gemini model list request failed: {e}"))?;
        let status = res.status();
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(extract_error(&data).unwrap_or_else(|| format!("Gemini model list API error: {status}")));
        }

        for model in parse_gemini_model_list_response(&data)? {
            if seen.insert(model.id.clone()) {
                models.push(model);
            }
        }

        page_token = data["nextPageToken"].as_str().filter(|token| !token.trim().is_empty()).map(ToString::to_string);
        if page_token.is_none() {
            break;
        }
    }

    Ok(models)
}

async fn list_openai_compatible_models(
    client: &reqwest::Client,
    config: &AiConfig,
) -> Result<Vec<AiModelInfo>, String> {
    let res = client
        .get(resolve_model_list_endpoint(config)?)
        .headers(maybe_bearer_headers(config)?)
        .send()
        .await
        .map_err(|e| format!("AI model list request failed: {e}"))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("Model list API error: {status}")));
    }

    parse_model_list_response(&data)
}

fn resolve_ollama_show_endpoint(config: &AiConfig) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&resolve_model_list_endpoint(config)?)
        .map_err(|e| format!("Invalid Ollama model endpoint: {e}"))?;
    let path = url.path().trim_end_matches('/');
    let base_path =
        path.strip_suffix("/v1/models").or_else(|| path.strip_suffix("/models")).unwrap_or(path).trim_end_matches('/');
    let show_path = if base_path.is_empty() { "/api/show".to_string() } else { format!("{base_path}/api/show") };
    url.set_path(&show_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

async fn fetch_ollama_model_details(
    client: &reqwest::Client,
    config: &AiConfig,
    show_endpoint: &str,
    model_id: &str,
) -> Result<serde_json::Value, String> {
    let response = client
        .post(show_endpoint)
        .headers(maybe_bearer_headers(config)?)
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({ "model": model_id }))
        .send()
        .await
        .map_err(|error| format!("Ollama model capability request failed for {model_id}: {error}"))?;
    let status = response.status();
    let data: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("Ollama model capability API error: {status}")));
    }
    Ok(data)
}

async fn ollama_model_completion_support(
    client: &reqwest::Client,
    config: &AiConfig,
    show_endpoint: &str,
    model_id: &str,
) -> Result<Option<bool>, String> {
    let data = fetch_ollama_model_details(client, config, show_endpoint, model_id).await?;
    Ok(crate::ai_model_filter::ollama_completion_capability(&data))
}

pub(crate) async fn ollama_selected_model_tool_support(config: &AiConfig) -> Result<Option<bool>, String> {
    let model_id = config.model.trim();
    if model_id.is_empty() {
        return Err("Model is required".to_string());
    }
    let client = build_ai_http_client(config, 5)?;
    let show_endpoint = resolve_ollama_show_endpoint(config)?;
    let data = fetch_ollama_model_details(&client, config, &show_endpoint, model_id).await?;
    Ok(crate::ai_model_filter::ollama_tool_capability(&data))
}

async fn retain_ollama_completion_models(
    client: &reqwest::Client,
    config: &AiConfig,
    models: Vec<AiModelInfo>,
) -> Vec<AiModelInfo> {
    const CAPABILITY_CONCURRENCY: usize = 8;

    let Ok(show_endpoint) = resolve_ollama_show_endpoint(config) else {
        return models;
    };
    let mut checked = futures::stream::iter(models.into_iter().enumerate().map(|(index, model)| {
        let show_endpoint = show_endpoint.clone();
        async move {
            let support = ollama_model_completion_support(client, config, &show_endpoint, &model.id).await;
            (index, model, support)
        }
    }))
    .buffer_unordered(CAPABILITY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    checked.sort_by_key(|(index, _, _)| *index);
    checked
        .into_iter()
        .filter_map(|(_, model, support)| match support {
            Ok(Some(false)) => None,
            Ok(Some(true) | None) => Some(model),
            Err(error) => {
                log::debug!("[ai][models] {error}; preserving model {}", model.id);
                Some(model)
            }
        })
        .collect()
}

pub async fn list_models_core(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let mut models = match config.provider {
        AiProvider::CodexCli => crate::ai_codex_cli::list_codex_models(config).await?,
        AiProvider::ClaudeCodeCli => crate::ai_claude_code_cli::list_claude_code_models(config).await?,
        AiProvider::PiAgentCli => crate::ai_pi_agent_cli::list_pi_agent_models(config).await?,
        _ => {
            validate_model_list_config(config)?;
            let client = build_ai_http_client(config, 30)?;
            match config.provider {
                AiProvider::Claude | AiProvider::AnthropicCompatible => list_claude_models(&client, config).await?,
                AiProvider::Gemini => list_gemini_models(&client, config).await?,
                AiProvider::Ollama => {
                    let models = list_openai_compatible_models(&client, config).await?;
                    retain_ollama_completion_models(&client, config, models).await
                }
                AiProvider::Openai | AiProvider::Deepseek | AiProvider::Qwen | AiProvider::OpenaiCompatible => {
                    list_openai_compatible_models(&client, config).await?
                }
                AiProvider::Custom => {
                    if uses_anthropic_messages_api(config) {
                        list_claude_models(&client, config).await?
                    } else {
                        list_openai_compatible_models(&client, config).await?
                    }
                }
                AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli => unreachable!(),
            }
        }
    };
    crate::ai_model_filter::retain_known_assistant_models(&config.provider, &mut models);
    decorate_model_capabilities(config, &mut models);
    Ok(models)
}

pub async fn resolve_model_effort_core(config: &AiConfig, model_id: &str) -> Result<AiEffortCapability, String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("Model is required".to_string());
    }

    if matches!(config.provider, AiProvider::PiAgentCli) {
        return crate::ai_pi_agent_cli::resolve_pi_agent_model_effort(config, model_id).await;
    }

    if matches!(config.provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli) {
        let models = list_models_core(config).await?;
        return Ok(models
            .into_iter()
            .find(|model| model.id == model_id)
            .and_then(|model| model.effort_capability)
            .unwrap_or(AiEffortCapability::Unsupported));
    }

    if matches!(config.provider, AiProvider::Claude) {
        let client = build_ai_http_client(config, 30)?;
        let mut url = reqwest::Url::parse(&resolve_model_list_endpoint(config)?)
            .map_err(|e| format!("Invalid Claude model endpoint: {e}"))?;
        url.path_segments_mut().map_err(|_| "Invalid Claude model endpoint".to_string())?.push(model_id);
        let response = client
            .get(url)
            .headers(claude_headers(config)?)
            .send()
            .await
            .map_err(|e| format!("Claude model capability request failed: {e}"))?;
        let status = response.status();
        let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(extract_error(&data).unwrap_or_else(|| format!("Claude model capability API error: {status}")));
        }
        if let Some(capability) = parse_dynamic_effort_capability(&data, AiCapabilitySource::ProviderApi) {
            return Ok(capability);
        }
    }

    Ok(crate::ai_effort::static_effort_capability(config, model_id).unwrap_or(AiEffortCapability::Unsupported))
}

// ---------------------------------------------------------------------------
// Non-streaming calls
// ---------------------------------------------------------------------------

pub async fn call_claude(client: &reqwest::Client, request: AiCompletionRequest) -> Result<String, String> {
    let mut body = json!({
        "model": claude_http_model(&request.config.model),
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "system": claude_system_prompt(&request.system_prompt),
        "messages": request.messages,
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(claude_headers(&request.config)?)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude request failed: {e}"))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("Claude API error: {status}")));
    }

    Ok(data["content"]
        .as_array()
        .and_then(|items| items.iter().find_map(|item| item["text"].as_str()))
        .unwrap_or_default()
        .to_string())
}

pub async fn call_openai_compatible(client: &reqwest::Client, request: AiCompletionRequest) -> Result<String, String> {
    let headers = maybe_bearer_headers(&request.config)?;

    let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
    messages.extend(request.messages.iter().map(|message| json!({ "role": message.role, "content": message.content })));

    let mut body_obj = json!({
        "model": request.config.model,
        "messages": messages,
    });
    set_chat_completion_token_limit(&mut body_obj, &request.config, request.max_tokens.unwrap_or(2048));
    apply_chat_completion_thinking_toggle(&mut body_obj, &request.config);
    crate::ai_effort::apply_runtime_effort(&mut body_obj, &request.config);

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(headers)
        .json(&body_obj)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("API error: {status}")));
    }

    Ok(openai_response_text(&data))
}

pub async fn call_responses_api(client: &reqwest::Client, request: AiCompletionRequest) -> Result<String, String> {
    let headers = maybe_bearer_headers(&request.config)?;

    let mut body = json!({
        "model": request.config.model,
        "input": build_responses_input(&request.system_prompt, &request.messages),
        "max_output_tokens": responses_max_output_tokens(request.max_tokens),
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("API error: {status}")));
    }

    Ok(responses_text(&data))
}

pub async fn call_gemini(client: &reqwest::Client, request: AiCompletionRequest) -> Result<String, String> {
    let mut contents = Vec::new();
    for message in &request.messages {
        let role = if message.role == "assistant" { "model" } else { "user" };
        contents.push(json!({
            "role": role,
            "parts": [{ "text": message.content }],
        }));
    }

    let mut body = json!({
        "systemInstruction": {
            "parts": [{ "text": request.system_prompt }],
        },
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": request.max_tokens.unwrap_or(2048),
        },
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let res = client
        .post(resolve_endpoint(&request.config))
        .query(&[("key", normalized_api_key(&request.config))])
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_transport_error("Gemini", e))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| format_transport_error("Gemini", e))?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("Gemini API error: {status}")));
    }

    Ok(gemini_text(&data))
}

// ---------------------------------------------------------------------------
// High-level: test_connection_core / complete
// ---------------------------------------------------------------------------

/// Read the SSE byte stream until the first content-bearing chunk arrives,
/// then return its latency and the delta text.  Used by `test_connection_core`
/// to mirror CC-Switch's streaming probe approach.
#[derive(Default)]
struct StreamProbeDiagnostics {
    bytes_received: usize,
    data_events: usize,
    json_events: usize,
    gemini_finish_reasons: Vec<String>,
    gemini_block_reasons: Vec<String>,
    gemini_safety_ratings: Vec<String>,
    gemini_prompt_tokens: Option<u64>,
    gemini_candidate_tokens: Option<u64>,
    gemini_thought_tokens: Option<u64>,
    gemini_total_tokens: Option<u64>,
}

impl StreamProbeDiagnostics {
    fn observe_gemini(&mut self, event: &serde_json::Value) {
        if let Some(reason) = event.pointer("/promptFeedback/blockReason").and_then(serde_json::Value::as_str) {
            push_unique(&mut self.gemini_block_reasons, reason);
        }
        if let Some(message) = event.pointer("/promptFeedback/blockReasonMessage").and_then(serde_json::Value::as_str) {
            push_unique(&mut self.gemini_block_reasons, message);
        }
        collect_gemini_safety_ratings(
            event.pointer("/promptFeedback/safetyRatings").and_then(serde_json::Value::as_array).map(Vec::as_slice),
            &mut self.gemini_safety_ratings,
        );

        if let Some(candidates) = event.get("candidates").and_then(serde_json::Value::as_array) {
            for candidate in candidates {
                if let Some(reason) = candidate.get("finishReason").and_then(serde_json::Value::as_str) {
                    push_unique(&mut self.gemini_finish_reasons, reason);
                }
                collect_gemini_safety_ratings(
                    candidate.get("safetyRatings").and_then(serde_json::Value::as_array).map(Vec::as_slice),
                    &mut self.gemini_safety_ratings,
                );
            }
        }

        if let Some(usage) = event.get("usageMetadata") {
            update_token_count(&mut self.gemini_prompt_tokens, usage.get("promptTokenCount"));
            update_token_count(&mut self.gemini_candidate_tokens, usage.get("candidatesTokenCount"));
            update_token_count(&mut self.gemini_thought_tokens, usage.get("thoughtsTokenCount"));
            update_token_count(&mut self.gemini_total_tokens, usage.get("totalTokenCount"));
        }
    }

    fn usage_summary(&self) -> String {
        let mut values = Vec::new();
        if let Some(tokens) = self.gemini_prompt_tokens {
            values.push(format!("prompt={tokens}"));
        }
        if let Some(tokens) = self.gemini_candidate_tokens {
            values.push(format!("candidates={tokens}"));
        }
        if let Some(tokens) = self.gemini_thought_tokens {
            values.push(format!("thoughts={tokens}"));
        }
        if let Some(tokens) = self.gemini_total_tokens {
            values.push(format!("total={tokens}"));
        }
        if values.is_empty() {
            String::new()
        } else {
            format!(", tokenUsage={}", values.join("/"))
        }
    }

    fn empty_stream_error(&self, is_gemini: bool) -> String {
        if self.bytes_received == 0 {
            return "AI stream response body was empty after HTTP success; the endpoint or proxy may have closed the response".to_string();
        }
        if self.data_events == 0 {
            return format!(
                "AI stream returned {} bytes but no SSE data events; verify the endpoint and proxy streaming support",
                self.bytes_received
            );
        }
        if !is_gemini {
            return format!(
                "AI stream ended without text after {} data event(s) and {} JSON event(s)",
                self.data_events, self.json_events
            );
        }

        let usage = self.usage_summary();
        if !self.gemini_block_reasons.is_empty() {
            let safety = self.safety_summary();
            return format!(
                "Gemini returned no text because the prompt was blocked (blockReason={}{}{safety})",
                self.gemini_block_reasons.join(", "),
                usage
            );
        }

        if self.gemini_finish_reasons.iter().any(|reason| reason.eq_ignore_ascii_case("MAX_TOKENS")) {
            return format!(
                "Gemini returned no text (finishReason=MAX_TOKENS{usage}). The connection-test output limit may have been consumed by thinking tokens; retry with thinking disabled or another model"
            );
        }

        let safety_finish = self.gemini_finish_reasons.iter().any(|reason| {
            matches!(
                reason.to_ascii_uppercase().as_str(),
                "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY"
            )
        });
        if safety_finish {
            return format!(
                "Gemini returned no text because the response was blocked by a safety filter (finishReason={}{}{safety})",
                self.gemini_finish_reasons.join(", "),
                usage,
                safety = self.safety_summary(),
            );
        }

        if !self.gemini_finish_reasons.is_empty() {
            return format!(
                "Gemini returned no text (finishReason={}{}{}); check the model response policy and proxy behavior",
                self.gemini_finish_reasons.join(", "),
                usage,
                self.safety_summary(),
            );
        }

        if self.gemini_thought_tokens.unwrap_or_default() > 0 {
            return format!(
                "Gemini returned thinking metadata but no visible text ({usage_without_comma}); the output limit may have been consumed by thinking",
                usage_without_comma = usage.trim_start_matches(", "),
            );
        }

        format!(
            "Gemini stream returned {} data event(s) but no text{usage}; the model returned only metadata or the proxy altered the stream",
            self.data_events
        )
    }

    fn safety_summary(&self) -> String {
        if self.gemini_safety_ratings.is_empty() {
            String::new()
        } else {
            format!(", safetyRatings={}", self.gemini_safety_ratings.join("/"))
        }
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() && !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

fn update_token_count(target: &mut Option<u64>, value: Option<&serde_json::Value>) {
    if let Some(value) = value.and_then(serde_json::Value::as_u64) {
        *target = Some(value);
    }
}

fn collect_gemini_safety_ratings(ratings: Option<&[serde_json::Value]>, output: &mut Vec<String>) {
    let Some(ratings) = ratings else { return };
    for rating in ratings {
        let category = rating.get("category").and_then(serde_json::Value::as_str).unwrap_or("UNKNOWN");
        let probability = rating.get("probability").and_then(serde_json::Value::as_str).unwrap_or("UNKNOWN");
        let blocked = rating.get("blocked").and_then(serde_json::Value::as_bool).unwrap_or(false);
        if blocked || !probability.eq_ignore_ascii_case("NEGLIGIBLE") {
            let summary =
                if blocked { format!("{category}:{probability}:blocked") } else { format!("{category}:{probability}") };
            push_unique(output, &summary);
        }
    }
}

fn probe_stream_payload(
    data: &str,
    event_name: Option<&str>,
    is_claude: bool,
    is_gemini: bool,
    diagnostics: &mut StreamProbeDiagnostics,
) -> Result<Option<String>, String> {
    diagnostics.data_events += 1;
    if data == "[DONE]" {
        return Ok(None);
    }

    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| format!("AI stream JSON parse error: {e}; payload={}", truncate_diagnostic(data, 240)))?;
    diagnostics.json_events += 1;
    if is_claude {
        if let Some(error) = anthropic_stream_error(event_name, &parsed) {
            return Err(error);
        }
    }
    if is_gemini {
        diagnostics.observe_gemini(&parsed);
    }

    let delta = if is_claude {
        claude_stream_text(&parsed).or_else(|| parsed["delta"]["thinking"].as_str()).map(ToString::to_string)
    } else if is_gemini {
        let text = gemini_text(&parsed);
        (!text.is_empty()).then_some(text)
    } else {
        openai_stream_text(&parsed).or_else(|| openai_stream_reasoning(&parsed).map(ToString::to_string)).or_else(
            || {
                let text = responses_text(&parsed);
                (!text.is_empty()).then_some(text)
            },
        )
    };
    Ok(delta.filter(|text| !text.trim().is_empty()))
}

fn truncate_diagnostic(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

async fn categorized_http_error(response: reqwest::Response, provider: &str, api_key: &str) -> String {
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|data| extract_error(&data).or_else(|| Some(data.to_string())))
        .unwrap_or_else(|| {
            if body.trim().is_empty() {
                "empty response body".to_string()
            } else {
                body.trim().to_string()
            }
        });
    let api_key = api_key.trim();
    let detail = if api_key.is_empty() { detail } else { detail.replace(api_key, "***") };
    let detail = truncate_diagnostic(&detail, 500);
    let diagnostic = format!("HTTP {}: {detail}", status.as_u16());
    maybe_tag_retry_after(&headers, format!("[{}] {provider} API error ({diagnostic})", classify_error(&diagnostic)))
}

fn format_transport_error(provider: &str, error: reqwest::Error) -> String {
    // Request URLs may contain credentials in query parameters, notably Gemini API keys.
    format!("{provider} request failed: {}", error.without_url())
}

/// Extract an error string from a non-2xx streaming response, preserving any
/// `Retry-After` header so the retry helpers can honour server-requested delays.
///
/// Mirrors [`categorized_http_error`]: always embeds `HTTP <status>` in the
/// diagnostic so that [`classify_error`] works correctly on empty-body or
/// non-JSON responses (e.g. a bare 429 from a proxy).
async fn stream_error(response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    let headers = response.headers().clone();
    // Read the body as text first so we still have it when JSON parsing fails.
    let body_text = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body_text)
        .ok()
        .and_then(|data| extract_error(&data))
        .unwrap_or_else(|| {
            let trimmed = body_text.trim();
            if trimmed.is_empty() {
                "empty response body".to_string()
            } else {
                trimmed.to_string()
            }
        });
    let diagnostic = format!("HTTP {}: {detail}", status.as_u16());
    maybe_tag_retry_after(&headers, format!("[{}] {fallback} API error ({diagnostic})", classify_error(&diagnostic)))
}

async fn measure_first_stream_chunk(
    mut byte_stream: impl futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
    start: std::time::Instant,
    is_claude: bool,
    is_gemini: bool,
) -> Result<(u64, String), String> {
    let mut buf = Vec::new();
    let mut diagnostics = StreamProbeDiagnostics::default();
    let mut event_name: Option<String> = None;
    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {}", e.without_url()))?;
        diagnostics.bytes_received += chunk.len();
        buf.extend_from_slice(&chunk);

        while let Some(line) = drain_next_stream_line(&mut buf)? {
            if line.trim().is_empty() {
                event_name = None;
                continue;
            }
            if let Some(name) = stream_event_name(&line) {
                event_name = Some(name.to_string());
                continue;
            }
            let Some(data) = stream_data_payload(&line) else { continue };
            if data == "[DONE]" {
                diagnostics.data_events += 1;
                return Err(diagnostics.empty_stream_error(is_gemini));
            }
            if let Some(text) =
                probe_stream_payload(data, event_name.as_deref(), is_claude, is_gemini, &mut diagnostics)?
            {
                let latency = start.elapsed().as_millis() as u64;
                return Ok((latency, text));
            }
        }
    }

    if !buf.is_empty() {
        let line = String::from_utf8(buf).map_err(|e| format!("AI stream returned invalid UTF-8: {e}"))?;
        if let Some(data) = stream_data_payload(&line) {
            if let Some(text) =
                probe_stream_payload(data, event_name.as_deref(), is_claude, is_gemini, &mut diagnostics)?
            {
                let latency = start.elapsed().as_millis() as u64;
                return Ok((latency, text));
            }
        }
    }

    Err(diagnostics.empty_stream_error(is_gemini))
}

const TEST_PROMPT: &str = "Who are you?";

/// Fallback system prompt for the Anthropic (Claude) API.
///
/// Anthropic rejects requests whose `system` field is an empty string with
/// `system: text content blocks must be non-empty`. When the caller has no
/// system prompt we send this minimal placeholder so the request stays valid.
const CLAUDE_DEFAULT_SYSTEM: &str = "You are a helpful assistant.";

/// Returns a non-empty system prompt for Claude requests, substituting a
/// default when the provided prompt is empty or whitespace-only.
fn claude_system_prompt(system_prompt: &str) -> &str {
    if system_prompt.trim().is_empty() {
        CLAUDE_DEFAULT_SYSTEM
    } else {
        system_prompt
    }
}

pub async fn test_connection_core(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    if matches!(config.provider, AiProvider::CodexCli) {
        return crate::ai_codex_cli::test_codex_connection(config).await;
    }
    if matches!(config.provider, AiProvider::ClaudeCodeCli) {
        return crate::ai_claude_code_cli::test_claude_code_connection(config).await;
    }
    if matches!(config.provider, AiProvider::PiAgentCli) {
        return crate::ai_pi_agent_cli::test_pi_agent_connection(config).await;
    }
    let mut resolved_config = config.clone();
    if resolved_config.model.trim().is_empty() {
        let model = list_models_core(&resolved_config)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                "[modelDiscoveryUnsupported] Model discovery returned no models. Save the provider and enter a model ID manually."
                    .to_string()
            })?;
        resolved_config.model = model.id;
    }
    let config = &resolved_config;
    validate_config(config)?;

    let client = build_ai_http_client(config, 15)?;
    let model = config.model.clone();
    let provider = config.provider.clone();
    let is_claude = uses_anthropic_messages_api(config);
    let is_gemini = matches!(config.provider, AiProvider::Gemini);
    let api_key = normalized_api_key(config).to_string();
    let endpoint = resolve_endpoint(config);
    let gemini_ep = resolve_gemini_stream_endpoint(config);
    let api_style = config.api_style.clone();
    let config_ref = config.clone();
    let config_inner = config.clone();

    with_retry(&config_ref, || {
        let client = client.clone();
        let model = model.clone();
        let provider = provider.clone();
        let api_key = api_key.clone();
        let endpoint = endpoint.clone();
        let gemini_ep = gemini_ep.clone();
        let api_style = api_style.clone();
        let config_inner = config_inner.clone();
        async move {
            let start = std::time::Instant::now();

            let byte_stream = if is_claude {
                let body = json!({
                    "model": claude_http_model(&model),
                    "max_tokens": 16,
                    "system": CLAUDE_DEFAULT_SYSTEM,
                    "messages": [{ "role": "user", "content": TEST_PROMPT }],
                    "stream": true,
                });
                let headers = claude_headers(&config_inner)?;
                let res = client
                    .post(&endpoint)
                    .headers(headers)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("Claude request failed: {e}"))?;
                if !res.status().is_success() {
                    return Err(categorized_http_error(res, "Claude", &api_key).await);
                }
                res.bytes_stream()
            } else {
                match provider {
                    AiProvider::Gemini => {
                        let res = client
                            .post(&gemini_ep)
                            .header(CONTENT_TYPE, "application/json")
                            .query(&[("key", api_key.as_str()), ("alt", "sse")])
                            .json(&json!({
                                "contents": [{ "parts": [{ "text": TEST_PROMPT }], "role": "user" }],
                                "generationConfig": { "maxOutputTokens": 256 },
                            }))
                            .send()
                            .await
                            .map_err(|e| format_transport_error("Gemini", e))?;
                        if !res.status().is_success() {
                            return Err(categorized_http_error(res, "Gemini", &api_key).await);
                        }
                        res.bytes_stream()
                    }
                    AiProvider::Claude | AiProvider::AnthropicCompatible => unreachable!(),
                    _ => {
                        let mut body_obj = if api_style == AiApiStyle::Responses {
                            json!({
                                "model": &model,
                                "input": [{ "role": "user", "content": TEST_PROMPT }],
                                "max_output_tokens": 16,
                                "stream": true,
                            })
                        } else {
                            let messages = vec![json!({ "role": "user", "content": TEST_PROMPT })];
                            let mut body = json!({
                                "model": &model,
                                "messages": messages,
                                "stream": true,
                            });
                            set_chat_completion_token_limit(&mut body, &config_inner, 16);
                            body
                        };
                        if api_style != AiApiStyle::Responses {
                            apply_chat_completion_thinking_toggle(&mut body_obj, &config_inner);
                        }
                        let headers = maybe_bearer_headers(&config_inner)?;
                        let res = client
                            .post(&endpoint)
                            .headers(headers)
                            .json(&body_obj)
                            .send()
                            .await
                            .map_err(|e| format!("AI request failed: {e}"))?;
                        if !res.status().is_success() {
                            return Err(categorized_http_error(res, "AI", &api_key).await);
                        }
                        res.bytes_stream()
                    }
                }
            };

            match measure_first_stream_chunk(byte_stream, start, is_claude, is_gemini).await {
                Ok((latency, _delta)) => Ok(AiTestConnectionResult {
                    success: true,
                    message: format!("OK — {}ms", latency),
                    latency_ms: Some(latency),
                    model_used: model,
                    error_category: None,
                }),
                Err(e) => {
                    let category = classify_error(&e);
                    let category_prefix = format!("[{category}]");
                    if e.starts_with(&category_prefix) {
                        Err(e)
                    } else {
                        Err(format!("{category_prefix} {e}"))
                    }
                }
            }
        }
    })
    .await
}

fn classify_error(msg: &str) -> &'static str {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("permission denied")
        || lower.contains("permission_denied")
        || lower.contains("invalid api key")
        || lower.contains("incorrect api key")
        || lower.contains("api key not valid")
        || lower.contains("api_key_invalid")
        || lower.contains("authentication_error")
        || lower.contains("permission_error")
    {
        "auth"
    } else if lower.contains("404")
        || lower.contains("not found")
        || lower.contains("model not found")
        || lower.contains("model does not exist")
        || lower.contains("not supported for generatecontent")
        || lower.contains("not_found_error")
    {
        "modelNotFound"
    } else if lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("resource_exhausted")
        || lower.contains("quota exceeded")
        || lower.contains("rate_limit_error")
    {
        "rateLimit"
    } else if lower.contains("timeout") || lower.contains("timed out") || lower.contains("504") {
        "timeout"
    } else if lower.contains("finishreason=max_tokens")
        || lower.contains("thinking tokens")
        || lower.contains("request_too_large")
    {
        "tokenLimit"
    } else if lower.contains("safety filter") || lower.contains("prompt was blocked") {
        "safety"
    } else if lower.contains("no text")
        || lower.contains("response body was empty")
        || lower.contains("no sse data events")
        || lower.contains("without text")
    {
        "emptyResponse"
    } else if lower.contains("connect")
        || lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("api_error")
        || lower.contains("overloaded_error")
    {
        "network"
    } else {
        "unknown"
    }
}

/// Whether an error is transient and worth retrying.
/// Rate limits, timeouts, network blips, and empty responses are retryable;
/// authentication failures, missing models, safety blocks, and token limits are not.
fn is_retryable_error(error: &str) -> bool {
    matches!(classify_error(error), "rateLimit" | "timeout" | "network" | "emptyResponse")
}

/// Extract Retry-After seconds from HTTP response headers.
///
/// Supports both integer seconds and HTTP-date (RFC 9110 §10.2.3) formats.
/// Returns `None` for missing or unparseable values, and 0 for dates in the past.
fn parse_retry_after_secs(value: &str, now: std::time::SystemTime) -> Option<u64> {
    if let Ok(secs) = value.parse::<u64>() {
        return Some(secs);
    }

    let retry_at = httpdate::parse_http_date(value).ok()?;
    match retry_at.duration_since(now) {
        Ok(delay) => Some(delay.as_secs().saturating_add(u64::from(delay.subsec_nanos() > 0))),
        Err(_) => Some(0),
    }
}

fn retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    parse_retry_after_secs(value, std::time::SystemTime::now())
}

/// Parse a Retry-After duration from an error string.
///
/// Recognises the `[retry-after:N]` prefix (N in whole seconds) optionally
/// embedded by [`categorized_http_error`] or stream error sites.
fn parse_retry_after(error: &str) -> Option<std::time::Duration> {
    let rest = error.strip_prefix("[retry-after:")?;
    let end = rest.find(']')?;
    let secs: u64 = rest[..end].parse().ok()?;
    Some(std::time::Duration::from_secs(secs))
}

/// Prepend a `[retry-after:N]` tag to an error string if the headers include
/// a Retry-After value.
fn maybe_tag_retry_after(headers: &reqwest::header::HeaderMap, mut error: String) -> String {
    if let Some(secs) = retry_after_secs(headers) {
        error = format!("[retry-after:{secs}]{error}");
    }
    error
}

/// Execute an async operation with automatic retry on transient errors.
///
/// Uses the `max_retries` field from `config` (defaults to
/// [`DEFAULT_MAX_RETRIES`] when `None`, capped at [`MAX_MAX_RETRIES`]).
/// Exponential back-off starts at 500 ms and doubles each
/// attempt, with a small jitter to spread retries across concurrent tasks.
async fn with_retry<F, Fut, T>(config: &AiConfig, mut op: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let max = config.max_retries.unwrap_or(DEFAULT_MAX_RETRIES).min(MAX_MAX_RETRIES);
    let mut last_err: Option<String> = None;

    for attempt in 0..=max {
        if attempt > 0 {
            // Exponential back-off: 500ms, 1s, 2s, 4s … with ±25 % jitter.
            let base_ms = 2u64.pow(attempt.saturating_sub(1)) * 500;
            // Honour Retry-After from the previous error response.
            let server_delay_ms =
                last_err.as_ref().and_then(|e| parse_retry_after(e)).map(|d| d.as_millis() as u64).unwrap_or(0);
            let base_ms = base_ms.max(server_delay_ms);
            let jitter = (base_ms as f64 * 0.25) as u64;
            // We can't use thread_rng here (wasm compat), so rely on the OS
            // scheduler to naturally jitter concurrent tasks.  A tiny fixed
            // offset per attempt avoids thundering-herd for a single caller.
            let delay_ms = base_ms + (attempt as u64 * 37) % jitter.max(1);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            log::debug!("[ai][retry] attempt {attempt}/{} ({}ms back-off)", max, delay_ms);
        }

        match op().await {
            Ok(result) => return Ok(result),
            Err(err) if attempt < max && is_retryable_error(&err) => {
                log::warn!("[ai][retry] transient error, will retry: {err}");
                last_err = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_err.unwrap_or_else(|| "retry exhausted with no recorded error".to_string()))
}

/// Variant of [`with_retry`] for streaming operations.
///
/// Streaming requests are retried only when the `emitted` flag is still `false`
/// — that is, no text, reasoning, or tool-call event has reached the frontend.
/// Once content has been emitted, retrying would cause duplicate output, so the
/// error is propagated immediately regardless of whether it is transient.
///
/// The closure rebuilds the full `send` + stream-consume each attempt.
/// When `cancelled` is provided, back-off sleep yields to cancellation
/// so the user's Stop button takes effect quickly.
async fn with_stream_retry<F, Fut, T>(
    config: &AiConfig,
    emitted: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    cancelled: Option<&Notify>,
    mut op: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let max = config.max_retries.unwrap_or(DEFAULT_MAX_RETRIES).min(MAX_MAX_RETRIES);
    let mut last_err: Option<String> = None;

    for attempt in 0..=max {
        if attempt > 0 {
            let base_ms = 2u64.pow(attempt.saturating_sub(1)) * 500;
            // Honour Retry-After from the previous error response.
            let server_delay_ms =
                last_err.as_ref().and_then(|e| parse_retry_after(e)).map(|d| d.as_millis() as u64).unwrap_or(0);
            let base_ms = base_ms.max(server_delay_ms);
            let jitter = (base_ms as f64 * 0.25) as u64;
            let delay_ms = base_ms + (attempt as u64 * 37) % jitter.max(1);
            let delay = std::time::Duration::from_millis(delay_ms);
            log::debug!("[ai][stream_retry] attempt {attempt}/{} ({}ms back-off)", max, delay_ms);
            // Yield to cancellation during back-off so Stop is responsive.
            if let Some(cancelled) = cancelled {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    _ = cancelled.notified() => return Err(AGENT_CANCELLED_ERROR.to_string()),
                }
            } else {
                tokio::time::sleep(delay).await;
            }
        }

        match op().await {
            Ok(result) => return Ok(result),
            Err(err)
                if attempt < max && is_retryable_error(&err) && !emitted.load(std::sync::atomic::Ordering::Relaxed) =>
            {
                log::warn!("[ai][stream_retry] transient error before content, will retry: {err}");
                last_err = Some(err);
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_err.unwrap_or_else(|| "stream retry exhausted with no recorded error".to_string()))
}

pub async fn complete(request: &AiCompletionRequest) -> Result<String, String> {
    validate_config(&request.config)?;

    if matches!(request.config.provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli) {
        return Err("CLI providers are only supported in DBX AI agent mode".to_string());
    }

    let config = request.config.clone();
    let client = build_ai_http_client(&config, 60)?;

    with_retry(&config, || {
        let client = client.clone();
        let request = request.clone();
        async move {
            if uses_anthropic_messages_api(&request.config) {
                return call_claude(&client, request).await;
            }

            match request.config.provider {
                AiProvider::Gemini => call_gemini(&client, request).await,
                AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli => unreachable!(),
                AiProvider::Openai
                | AiProvider::Deepseek
                | AiProvider::Qwen
                | AiProvider::Ollama
                | AiProvider::OpenaiCompatible => {
                    if request.config.api_style == AiApiStyle::Responses {
                        call_responses_api(&client, request).await
                    } else {
                        call_openai_compatible(&client, request).await
                    }
                }
                AiProvider::Custom => {
                    if request.config.api_style == AiApiStyle::Responses {
                        call_responses_api(&client, request).await
                    } else {
                        call_openai_compatible(&client, request).await
                    }
                }
                AiProvider::Claude | AiProvider::AnthropicCompatible => unreachable!(),
            }
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

pub async fn stream(
    session_id: &str,
    request: &AiCompletionRequest,
    cancelled: &Notify,
    on_chunk: impl Fn(AiStreamChunk),
) -> Result<(), String> {
    validate_config(&request.config)?;

    if matches!(request.config.provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli) {
        return Err("CLI providers are only supported in DBX AI agent mode".to_string());
    }

    let stream_timeout = if runtime_thinking_enabled(&request.config) { 600 } else { 120 };
    let client = build_ai_http_client(&request.config, stream_timeout)?;

    if uses_anthropic_messages_api(&request.config) {
        return stream_claude(&client, session_id, request, cancelled, &on_chunk).await;
    }

    match request.config.provider {
        AiProvider::Gemini => stream_gemini(&client, session_id, request, cancelled, &on_chunk).await,
        AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli => unreachable!(),
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible => {
            if request.config.api_style == AiApiStyle::Responses {
                stream_responses_api(&client, session_id, request, cancelled, &on_chunk).await
            } else {
                stream_openai(&client, session_id, request, cancelled, &on_chunk).await
            }
        }
        AiProvider::Custom => {
            if request.config.api_style == AiApiStyle::Responses {
                stream_responses_api(&client, session_id, request, cancelled, &on_chunk).await
            } else {
                stream_openai(&client, session_id, request, cancelled, &on_chunk).await
            }
        }
        AiProvider::Claude | AiProvider::AnthropicCompatible => unreachable!(),
    }
}

async fn stream_claude(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    cancelled: &Notify,
    on_chunk: &impl Fn(AiStreamChunk),
) -> Result<(), String> {
    let mut body = json!({
        "model": claude_http_model(&request.config.model),
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "system": claude_system_prompt(&request.system_prompt),
        "messages": request.messages,
        "stream": true,
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let headers = claude_headers(&request.config)?;
    let endpoint = resolve_endpoint(&request.config);
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let headers = headers.clone();
        let endpoint = endpoint.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Claude request failed: {e}"))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "Claude API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();
            let mut event_name: Option<String> = None;

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.to_string())?;
                        buf.extend_from_slice(&chunk);

                        let mut finished = false;
                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            if line.trim().is_empty() {
                                event_name = None;
                                continue;
                            }
                            if let Some(name) = stream_event_name(&line) {
                                event_name = Some(name.to_string());
                                continue;
                            }
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if data == "[DONE]" {
                                finished = true;
                                break;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(error) = anthropic_stream_error(event_name.as_deref(), &event) {
                                    return Err(error);
                                }
                                if let Some(text) = claude_stream_text(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: text.to_string(),
                                        reasoning_delta: None,
                                        done: false,
                                    });
                                }
                            }
                        }

                        if finished { break; }
                    }
                    _ = cancelled.notified() => { break; }
                }
            }

            on_chunk(AiStreamChunk {
                session_id: session_id.clone(),
                delta: String::new(),
                reasoning_delta: None,
                done: true,
            });

            Ok(())
        }
    })
    .await
}

async fn stream_openai(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    cancelled: &Notify,
    on_chunk: &impl Fn(AiStreamChunk),
) -> Result<(), String> {
    let headers = maybe_bearer_headers(&request.config)?;

    let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
    messages.extend(request.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })));

    let mut body_obj = json!({
        "model": request.config.model,
        "messages": messages,
        "stream": true,
    });
    set_chat_completion_token_limit(&mut body_obj, &request.config, request.max_tokens.unwrap_or(2048));
    apply_chat_completion_thinking_toggle(&mut body_obj, &request.config);
    crate::ai_effort::apply_runtime_effort(&mut body_obj, &request.config);

    let endpoint = resolve_endpoint(&request.config);
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body_obj = body_obj.clone();
        let headers = headers.clone();
        let endpoint = endpoint.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .headers(headers)
                .json(&body_obj)
                .send()
                .await
                .map_err(|e| format!("AI request failed: {e}"))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();
            let mut finish_reason_deadline = None;

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.to_string())?;
                        buf.extend_from_slice(&chunk);

                        let mut finished = false;
                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if data == "[DONE]" {
                                finished = true;
                                break;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(reasoning) = openai_stream_reasoning(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: String::new(),
                                        reasoning_delta: Some(reasoning.to_string()),
                                        done: false,
                                    });
                                }
                                if let Some(text) = openai_stream_text(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: text,
                                        reasoning_delta: None,
                                        done: false,
                                    });
                                }
                                if finish_reason_deadline.is_none() && openai_stream_has_finish_reason(&event) {
                                    finish_reason_deadline =
                                        Some(tokio::time::Instant::now() + std::time::Duration::from_secs(1));
                                }
                            }
                        }

                        if finished { break; }
                    }
                    _ = cancelled.notified() => { break; }
                    _ = async {
                        match finish_reason_deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline).await,
                            None => std::future::pending().await,
                        }
                    } => { break; }
                }
            }

            on_chunk(AiStreamChunk {
                session_id: session_id.clone(),
                delta: String::new(),
                reasoning_delta: None,
                done: true,
            });

            Ok(())
        }
    })
    .await
}

async fn stream_responses_api(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    cancelled: &Notify,
    on_chunk: &impl Fn(AiStreamChunk),
) -> Result<(), String> {
    let headers = maybe_bearer_headers(&request.config)?;

    let mut body = json!({
        "model": request.config.model,
        "input": build_responses_input(&request.system_prompt, &request.messages),
        "max_output_tokens": responses_max_output_tokens(request.max_tokens),
        "stream": true,
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let endpoint = resolve_endpoint(&request.config);
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let headers = headers.clone();
        let endpoint = endpoint.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("AI request failed: {e}"))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.to_string())?;
                        buf.extend_from_slice(&chunk);

                        let mut finished = false;
                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if data == "[DONE]" {
                                finished = true;
                                break;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(text) = responses_stream_text(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: text.to_string(),
                                        reasoning_delta: None,
                                        done: false,
                                    });
                                }
                            }
                        }

                        if finished { break; }
                    }
                    _ = cancelled.notified() => { break; }
                }
            }

            on_chunk(AiStreamChunk {
                session_id: session_id.clone(),
                delta: String::new(),
                reasoning_delta: None,
                done: true,
            });

            Ok(())
        }
    })
    .await
}

async fn stream_gemini(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    cancelled: &Notify,
    on_chunk: &impl Fn(AiStreamChunk),
) -> Result<(), String> {
    let mut contents = Vec::new();
    for message in &request.messages {
        let role = if message.role == "assistant" { "model" } else { "user" };
        contents.push(json!({
            "role": role,
            "parts": [{ "text": message.content }],
        }));
    }

    let mut body = json!({
        "systemInstruction": {
            "parts": [{ "text": request.system_prompt }],
        },
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": request.max_tokens.unwrap_or(2048),
        },
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let endpoint = resolve_gemini_stream_endpoint(&request.config);
    let api_key = normalized_api_key(&request.config).to_string();
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let endpoint = endpoint.clone();
        let api_key = api_key.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .query(&[("key", api_key.as_str()), ("alt", "sse")])
                .header(CONTENT_TYPE, "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format_transport_error("Gemini", e))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "Gemini API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.without_url().to_string())?;
                        buf.extend_from_slice(&chunk);

                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                let text = gemini_text(&event);
                                if !text.is_empty() {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: text,
                                        reasoning_delta: None,
                                        done: false,
                                    });
                                }
                            }
                        }
                    }
                    _ = cancelled.notified() => { break; }
                }
            }

            on_chunk(AiStreamChunk {
                session_id: session_id.clone(),
                delta: String::new(),
                reasoning_delta: None,
                done: true,
            });

            Ok(())
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Streaming with tools (agent loop)
// ---------------------------------------------------------------------------

/// Events emitted by provider-specific streaming-with-tools functions.
/// The public `stream_with_tools` entry point uses these to accumulate
/// tool calls and forward text/reasoning chunks to the caller.
pub enum StreamToolEvent {
    /// A text or reasoning delta for the frontend.
    Chunk(AiStreamChunk),
    /// A tool_use / function_call block has started.
    ToolCallStart { index: u32, id: String, name: String },
    /// An argument fragment for an in-progress tool call.
    ToolCallDelta { index: u32, fragment: String },
    /// Opaque provider response data required to replay the tool call.
    ToolCallProviderPayload { index: u32, payload: serde_json::Value },
    /// A tool_use / function_call block has ended.
    ToolCallComplete { index: u32 },
}

/// Partially accumulated tool call during streaming.
#[derive(Debug)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
    provider_payload: Option<serde_json::Value>,
}

/// Accumulates streaming tool-call events into complete `ToolCall` objects.
#[derive(Debug)]
pub struct StreamingToolCallAccumulator {
    calls: std::collections::HashMap<u32, PartialToolCall>,
    ordered_indices: Vec<u32>,
}

impl Default for StreamingToolCallAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingToolCallAccumulator {
    pub fn new() -> Self {
        Self { calls: std::collections::HashMap::new(), ordered_indices: Vec::new() }
    }

    pub fn process(&mut self, event: StreamToolEvent, on_chunk: &impl Fn(AiStreamChunk)) {
        match event {
            StreamToolEvent::Chunk(chunk) => on_chunk(chunk),
            StreamToolEvent::ToolCallStart { index, id, name } => {
                // Merge with any existing entry for this index instead of
                // overwriting it. Some OpenAI-compatible providers (e.g. GLM)
                // re-send `id` (as an empty string) or omit `name` on
                // subsequent delta chunks; a blind insert would wipe a
                // previously-correct name and reset accumulated arguments,
                // producing "Unknown tool:" errors.
                if let Some(existing) = self.calls.get_mut(&index) {
                    if !id.is_empty() {
                        existing.id = id;
                    }
                    if !name.is_empty() {
                        existing.name = name;
                    }
                } else {
                    self.calls
                        .insert(index, PartialToolCall { id, name, arguments: String::new(), provider_payload: None });
                }
                if !self.ordered_indices.contains(&index) {
                    self.ordered_indices.push(index);
                }
            }
            StreamToolEvent::ToolCallDelta { index, fragment } => {
                if let Some(tc) = self.calls.get_mut(&index) {
                    tc.arguments.push_str(&fragment);
                }
            }
            StreamToolEvent::ToolCallProviderPayload { index, payload } => {
                if let Some(tc) = self.calls.get_mut(&index) {
                    tc.provider_payload = Some(payload);
                }
            }
            StreamToolEvent::ToolCallComplete { index: _ } => {
                // Nothing extra to do — the call is already accumulated.
            }
        }
    }

    pub fn finalize(self) -> Vec<crate::agent_events::ToolCall> {
        let mut result = Vec::new();
        for idx in &self.ordered_indices {
            if let Some(tc) = self.calls.get(idx) {
                let args: serde_json::Value = serde_json::from_str(&tc.arguments).unwrap_or(json!({}));
                result.push(crate::agent_events::ToolCall {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: args,
                    provider_payload: tc.provider_payload.clone(),
                });
            }
        }
        result
    }
}

/// Streaming Claude call with tool support.
/// Returns a stream of `StreamToolEvent` via the `on_event` callback.
async fn stream_claude_with_tools(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    tools: &[crate::agent_events::ToolDefinition],
    cancelled: &Notify,
    on_event: &impl Fn(StreamToolEvent),
) -> Result<Option<TokenUsage>, String> {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();
    for m in &request.messages {
        if m.role == "tool" {
            // Collect consecutive tool results; flush as a single user message.
            pending_tool_results.push(json!({
                "type": "tool_result",
                "tool_use_id": m.tool_call_id.as_deref().unwrap_or_default(),
                "content": m.content
            }));
        } else {
            // Flush any pending tool results before emitting a non-tool message.
            if !pending_tool_results.is_empty() {
                messages.push(json!({
                    "role": "user",
                    "content": std::mem::take(&mut pending_tool_results)
                }));
            }
            if m.role == "assistant" && !m.tool_calls.is_empty() {
                let mut content_blocks: Vec<serde_json::Value> = Vec::new();
                if !m.content.is_empty() {
                    content_blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for tc in &m.tool_calls {
                    content_blocks
                        .push(json!({ "type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments }));
                }
                messages.push(json!({ "role": "assistant", "content": content_blocks }));
            } else {
                messages.push(json!({ "role": m.role, "content": m.content }));
            }
        }
    }
    // Flush any remaining tool results at the end of the message list.
    if !pending_tool_results.is_empty() {
        messages.push(json!({
            "role": "user",
            "content": std::mem::take(&mut pending_tool_results)
        }));
    }

    let tool_json: Vec<serde_json::Value> = tools.iter().map(|t| t.to_anthropic_tool()).collect();

    let mut body = json!({
        "model": claude_http_model(&request.config.model),
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "system": claude_system_prompt(&request.system_prompt),
        "messages": messages,
        "tools": tool_json,
        "stream": true,
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let headers = claude_headers(&request.config)?;
    let endpoint = resolve_endpoint(&request.config);
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let headers = headers.clone();
        let endpoint = endpoint.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Claude request failed: {e}"))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "Claude API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();
            let mut event_name: Option<String> = None;
            // Track the current content block index and type for tool_use blocks
            let mut current_block_index: Option<u32> = None;
            let mut current_block_type: Option<String> = None;
            let mut token_usage: Option<TokenUsage> = None;

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.to_string())?;
                        buf.extend_from_slice(&chunk);

                        let mut finished = false;
                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            if line.trim().is_empty() {
                                event_name = None;
                                continue;
                            }
                            if let Some(name) = stream_event_name(&line) {
                                event_name = Some(name.to_string());
                                continue;
                            }
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if data == "[DONE]" {
                                finished = true;
                                break;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(error) = anthropic_stream_error(event_name.as_deref(), &event) {
                                    return Err(error);
                                }
                                let event_type = event["type"].as_str().unwrap_or("");

                                match event_type {
                                    // message_start carries input_tokens (prompt cost)
                                    "message_start" => {
                                        if let Some(i) = event["message"]["usage"]["input_tokens"].as_u64() {
                                            let existing_output = token_usage.as_ref().map(|u| u.output_tokens).unwrap_or(0);
                                            token_usage = Some(TokenUsage { input_tokens: i as u32, output_tokens: existing_output });
                                        }
                                    }
                                    // message_delta carries output_tokens (generation cost)
                                    "message_delta" => {
                                        if let Some(o) = event["usage"]["output_tokens"].as_u64() {
                                            let existing_input = token_usage.as_ref().map(|u| u.input_tokens).unwrap_or(0);
                                            token_usage = Some(TokenUsage { input_tokens: existing_input, output_tokens: o as u32 });
                                        }
                                    }
                                    "content_block_start" => {
                                        let idx = event["index"].as_u64().unwrap_or(0) as u32;
                                        let block_type = event["content_block"]["type"].as_str().unwrap_or("");
                                        current_block_index = Some(idx);
                                        current_block_type = Some(block_type.to_string());

                                        if block_type == "tool_use" {
                                            let id = event["content_block"]["id"].as_str().unwrap_or_default().to_string();
                                            let name = event["content_block"]["name"].as_str().unwrap_or_default().to_string();
                                            emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                            on_event(StreamToolEvent::ToolCallStart { index: idx, id, name });
                                        }
                                    }
                                    "content_block_delta" => {
                                        let idx = event["index"].as_u64().unwrap_or(0) as u32;
                                        let delta_type = event["delta"]["type"].as_str().unwrap_or("");

                                        match delta_type {
                                            "text_delta" => {
                                                if let Some(text) = event["delta"]["text"].as_str() {
                                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                                    on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                                        session_id: session_id.clone(),
                                                        delta: text.to_string(),
                                                        reasoning_delta: None,
                                                        done: false,
                                                    }));
                                                }
                                            }
                                            "thinking_delta" => {
                                                if let Some(thinking) = event["delta"]["thinking"].as_str() {
                                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                                    on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                                        session_id: session_id.clone(),
                                                        delta: String::new(),
                                                        reasoning_delta: Some(thinking.to_string()),
                                                        done: false,
                                                    }));
                                                }
                                            }
                                            "input_json_delta" => {
                                                if let Some(fragment) = event["delta"]["partial_json"].as_str() {
                                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                                    on_event(StreamToolEvent::ToolCallDelta {
                                                        index: idx,
                                                        fragment: fragment.to_string(),
                                                    });
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                    "content_block_stop" => {
                                        if let Some(idx) = current_block_index.take() {
                                            if current_block_type.as_deref() == Some("tool_use") {
                                                on_event(StreamToolEvent::ToolCallComplete { index: idx });
                                            }
                                        }
                                        current_block_type = None;
                                    }
                                    _ => {}
                                }
                            }
                        }

                        if finished { break; }
                    }
                    _ = cancelled.notified() => {
                        return Err(AGENT_CANCELLED_ERROR.to_string());
                    }
                }
            }

            Ok(token_usage)
        }
    })
    .await
}

/// Streaming OpenAI-compatible call with tool support.
async fn stream_openai_with_tools(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    tools: &[crate::agent_events::ToolDefinition],
    cancelled: &Notify,
    on_event: &impl Fn(StreamToolEvent),
) -> Result<Option<TokenUsage>, String> {
    let headers = maybe_bearer_headers(&request.config)?;

    let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
    messages.extend(request.messages.iter().map(|m| {
        let mut msg = json!({ "role": m.role, "content": m.content });
        if m.role == "tool" {
            if let Some(ref tc_id) = m.tool_call_id {
                msg["tool_call_id"] = json!(tc_id);
            }
        } else if m.role == "assistant" && !m.tool_calls.is_empty() {
            let calls: Vec<serde_json::Value> = m
                .tool_calls
                .iter()
                .map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": tc.arguments.to_string()
                        }
                    })
                })
                .collect();
            msg["tool_calls"] = json!(calls);
        }
        msg
    }));

    let tool_json: Vec<serde_json::Value> = tools.iter().map(|t| t.to_openai_tool()).collect();

    let mut body = json!({
        "model": request.config.model,
        "messages": messages,
        "tools": tool_json,
        "tool_choice": "auto",
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    set_chat_completion_token_limit(&mut body, &request.config, request.max_tokens.unwrap_or(4096));

    if request.config.runtime_effort.is_none() && !request.config.enable_thinking {
        if matches!(request.config.provider, AiProvider::Ollama) {
            apply_chat_completion_thinking_toggle(&mut body, &request.config);
        } else if matches!(request.config.provider, AiProvider::Deepseek) {
            // DeepSeek uses its own thinking field for tool-enabled requests.
            body["thinking"] = json!({ "type": "disabled" });
        }
    }
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let endpoint = resolve_endpoint(&request.config);
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let headers = headers.clone();
        let endpoint = endpoint.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("AI request failed: {e}"))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();
            let mut token_usage: Option<TokenUsage> = None;
            let mut finish_reason_deadline = None;

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.to_string())?;
                        buf.extend_from_slice(&chunk);

                        let mut finished = false;
                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if data == "[DONE]" {
                                finished = true;
                                break;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                // Token usage (final chunk from OpenAI with include_usage)
                                if let Some(usage) = event.get("usage") {
                                    if let (Some(p), Some(c)) = (
                                        usage.get("prompt_tokens").and_then(|v| v.as_u64()),
                                        usage.get("completion_tokens").and_then(|v| v.as_u64()),
                                    ) {
                                        token_usage = Some(TokenUsage { input_tokens: p as u32, output_tokens: c as u32 });
                                    }
                                }
                                // Reasoning
                                if let Some(reasoning) = openai_stream_reasoning(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: String::new(),
                                        reasoning_delta: Some(reasoning.to_string()),
                                        done: false,
                                    }));
                                }
                                // Text
                                if let Some(text) = openai_stream_text(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: text,
                                        reasoning_delta: None,
                                        done: false,
                                    }));
                                }
                                // Tool calls
                                if let Some(tool_calls) = event["choices"].get(0).and_then(|c| c["delta"]["tool_calls"].as_array()) {
                                    for tc in tool_calls {
                                        let idx = tc["index"].as_u64().unwrap_or(0) as u32;
                                        // The first delta carries the tool call id and
                                        // function name. Some OpenAI-compatible providers
                                        // (e.g. GLM) send id="" on subsequent deltas, so
                                        // only a non-empty id marks a genuine start.
                                        if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                                            let name = tc["function"]["name"].as_str().unwrap_or_default().to_string();
                                            emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                            on_event(StreamToolEvent::ToolCallStart { index: idx, id: id.to_string(), name });
                                        }
                                        // Argument fragments
                                        if let Some(fragment) = tc["function"]["arguments"].as_str() {
                                            emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                            on_event(StreamToolEvent::ToolCallDelta { index: idx, fragment: fragment.to_string() });
                                        }
                                    }
                                }
                                if finish_reason_deadline.is_none() && openai_stream_has_finish_reason(&event) {
                                    finish_reason_deadline =
                                        Some(tokio::time::Instant::now() + std::time::Duration::from_secs(1));
                                }
                            }
                        }

                        if finished { break; }
                    }
                    _ = cancelled.notified() => {
                        return Err(AGENT_CANCELLED_ERROR.to_string());
                    }
                    _ = async {
                        match finish_reason_deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline).await,
                            None => std::future::pending().await,
                        }
                    } => { break; }
                }
            }

            Ok(token_usage)
        }
    })
    .await
}

async fn stream_responses_with_tools(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    tools: &[crate::agent_events::ToolDefinition],
    cancelled: &Notify,
    on_event: &impl Fn(StreamToolEvent),
) -> Result<Option<TokenUsage>, String> {
    let headers = maybe_bearer_headers(&request.config)?;
    let tool_json: Vec<serde_json::Value> = tools.iter().map(responses_function_tool).collect();

    let mut body = json!({
        "model": request.config.model,
        "input": build_responses_input_with_tools(&request.system_prompt, &request.messages),
        "max_output_tokens": responses_max_output_tokens(request.max_tokens),
        "tools": tool_json,
        "tool_choice": "auto",
        "stream": true,
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let endpoint = resolve_endpoint(&request.config);
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let headers = headers.clone();
        let endpoint = endpoint.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("AI request failed: {e}"))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();
            let mut item_indices: HashMap<String, u32> = HashMap::new();
            let mut started_indices: HashSet<u32> = HashSet::new();
            let mut argument_indices: HashSet<u32> = HashSet::new();
            let mut next_index: u32 = 0;
            let mut token_usage: Option<TokenUsage> = None;

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.to_string())?;
                        buf.extend_from_slice(&chunk);

                        let mut finished = false;
                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if data == "[DONE]" {
                                finished = true;
                                break;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(usage) = responses_token_usage(&event) {
                                    token_usage = Some(usage);
                                }

                                if let Some(text) = responses_stream_text(&event) {
                                    emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                        session_id: session_id.clone(),
                                        delta: text.to_string(),
                                        reasoning_delta: None,
                                        done: false,
                                    }));
                                }

                                match event["type"].as_str().unwrap_or_default() {
                                    "response.output_item.added" => {
                                        emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                        emit_responses_function_call_item(
                                            &event,
                                            &mut item_indices,
                                            &mut started_indices,
                                            &mut argument_indices,
                                            &mut next_index,
                                            on_event,
                                        );
                                    }
                                    "response.output_item.done" => {
                                        emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                        if let Some(index) = emit_responses_function_call_item(
                                            &event,
                                            &mut item_indices,
                                            &mut started_indices,
                                            &mut argument_indices,
                                            &mut next_index,
                                            on_event,
                                        ) {
                                            on_event(StreamToolEvent::ToolCallComplete { index });
                                        }
                                    }
                                    "response.function_call_arguments.delta" => {
                                        let index = event["item_id"]
                                            .as_str()
                                            .and_then(|id| item_indices.get(id).copied())
                                            .or_else(|| event["output_index"].as_u64().map(|i| i as u32))
                                            .unwrap_or(0);
                                        if let Some(fragment) = event["delta"].as_str() {
                                            argument_indices.insert(index);
                                            emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                            on_event(StreamToolEvent::ToolCallDelta { index, fragment: fragment.to_string() });
                                        }
                                    }
                                    "response.function_call_arguments.done" => {
                                        let index = event["item_id"]
                                            .as_str()
                                            .and_then(|id| item_indices.get(id).copied())
                                            .or_else(|| event["output_index"].as_u64().map(|i| i as u32))
                                            .unwrap_or(0);
                                        on_event(StreamToolEvent::ToolCallComplete { index });
                                    }
                                    _ => {}
                                }
                            }
                        }

                        if finished { break; }
                    }
                    _ = cancelled.notified() => {
                        return Err(AGENT_CANCELLED_ERROR.to_string());
                    }
                }
            }

            Ok(token_usage)
        }
    })
    .await
}

fn build_gemini_contents(messages: &[AiMessage]) -> Vec<serde_json::Value> {
    let mut contents: Vec<serde_json::Value> = Vec::new();
    let mut pending_function_responses: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        if m.role == "tool" {
            let tool_name = m
                .tool_call_id
                .as_deref()
                .and_then(|s| s.strip_prefix("gemini-tc-"))
                .and_then(|s| s.rsplit_once('-').map(|x| x.0))
                .unwrap_or("unknown");
            pending_function_responses.push(json!({
                "functionResponse": {
                    "name": tool_name,
                    "response": { "content": m.content }
                }
            }));
        } else {
            // Flush any pending function responses before emitting a non-tool message.
            if !pending_function_responses.is_empty() {
                contents.push(json!({
                    "role": "user",
                    "parts": std::mem::take(&mut pending_function_responses)
                }));
            }
            if m.role == "assistant" && !m.tool_calls.is_empty() {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "text": m.content }));
                }
                for tc in &m.tool_calls {
                    if let Some(payload) =
                        tc.provider_payload.as_ref().filter(|payload| payload.get("functionCall").is_some())
                    {
                        parts.push(payload.clone());
                    } else {
                        parts.push(json!({ "functionCall": { "name": tc.name, "args": tc.arguments } }));
                    }
                }
                contents.push(json!({ "role": "model", "parts": parts }));
            } else {
                let role = if m.role == "assistant" { "model" } else { "user" };
                contents.push(json!({ "role": role, "parts": [{ "text": m.content }] }));
            }
        }
    }
    // Flush any remaining function responses at the end of the message list.
    if !pending_function_responses.is_empty() {
        contents.push(json!({
            "role": "user",
            "parts": std::mem::take(&mut pending_function_responses)
        }));
    }

    contents
}

fn emit_gemini_tool_call_part(part: &serde_json::Value, index: u32, on_event: &impl Fn(StreamToolEvent)) -> bool {
    let Some(function_call) = part.get("functionCall") else {
        return false;
    };

    let name = function_call["name"].as_str().unwrap_or_default().to_string();
    let arguments = function_call["args"].clone();
    let id = format!("gemini-tc-{name}-{index}");
    on_event(StreamToolEvent::ToolCallStart { index, id, name });
    on_event(StreamToolEvent::ToolCallProviderPayload { index, payload: part.clone() });
    on_event(StreamToolEvent::ToolCallDelta { index, fragment: arguments.to_string() });
    on_event(StreamToolEvent::ToolCallComplete { index });
    true
}

/// Streaming Gemini call with tool support.
async fn stream_gemini_with_tools(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    tools: &[crate::agent_events::ToolDefinition],
    cancelled: &Notify,
    on_event: &impl Fn(StreamToolEvent),
) -> Result<Option<TokenUsage>, String> {
    let contents = build_gemini_contents(&request.messages);
    let tool_declarations: Vec<serde_json::Value> = tools.iter().map(|t| t.to_gemini_tool()).collect();

    let mut body = json!({
        "contents": contents,
        "systemInstruction": { "parts": [{ "text": request.system_prompt }] },
        "tools": [{ "functionDeclarations": tool_declarations }],
        "generationConfig": {
            "maxOutputTokens": request.max_tokens.unwrap_or(4096),
        }
    });
    crate::ai_effort::apply_runtime_effort(&mut body, &request.config);

    let endpoint = resolve_gemini_stream_endpoint(&request.config);
    let api_key = normalized_api_key(&request.config).to_string();
    let config = request.config.clone();
    let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    with_stream_retry(&config, &emitted, Some(cancelled), || {
        let body = body.clone();
        let endpoint = endpoint.clone();
        let api_key = api_key.clone();
        let session_id = session_id.to_string();
        let emitted = emitted.clone();
        async move {
            let res = client
                .post(&endpoint)
                .query(&[("key", api_key.as_str()), ("alt", "sse")])
                .header(CONTENT_TYPE, "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format_transport_error("Gemini", e))?;
            if !res.status().is_success() {
                return Err(stream_error(res, "Gemini API error").await);
            }

            let mut byte_stream = res.bytes_stream();
            let mut buf = Vec::new();
            let mut tool_call_idx: u32 = 0;
            let mut token_usage: Option<TokenUsage> = None;

            loop {
                tokio::select! {
                    chunk = byte_stream.next() => {
                        let Some(chunk) = chunk else { break };
                        let chunk = chunk.map_err(|e| e.without_url().to_string())?;
                        buf.extend_from_slice(&chunk);

                        while let Some(line) = drain_next_stream_line(&mut buf)? {
                            let Some(data) = stream_data_payload(&line) else { continue };
                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                // Token usage (overwrite each chunk, keep last value)
                                if let (Some(p), Some(c)) = (
                                    event["usageMetadata"]["promptTokenCount"].as_u64(),
                                    event["usageMetadata"]["candidatesTokenCount"].as_u64(),
                                ) {
                                    token_usage = Some(TokenUsage { input_tokens: p as u32, output_tokens: c as u32 });
                                }
                                if let Some(candidates) = event["candidates"].as_array() {
                                    if let Some(parts) = candidates[0]["content"]["parts"].as_array() {
                                        for part in parts {
                                            // Text
                                            if let Some(text) = part["text"].as_str() {
                                                emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                                on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                                    session_id: session_id.clone(),
                                                    delta: text.to_string(),
                                                    reasoning_delta: None,
                                                    done: false,
                                                }));
                                            }
                                            // Function call (Gemini sends complete objects, not deltas)
                                            emitted.store(true, std::sync::atomic::Ordering::Relaxed);
                                            if emit_gemini_tool_call_part(part, tool_call_idx, on_event) {
                                                tool_call_idx += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ = cancelled.notified() => {
                        return Err(AGENT_CANCELLED_ERROR.to_string());
                    }
                }
            }

            Ok(token_usage)
        }
    })
    .await
}

/// Public entry point: stream an LLM call with tool support, accumulating tool calls.
/// Returns completed tool calls and token usage when the stream finishes.
pub async fn stream_with_tools(
    config: &AiConfig,
    request: &AiCompletionRequest,
    session_id: &str,
    tools: &[crate::agent_events::ToolDefinition],
    cancelled: &Notify,
    on_chunk: impl Fn(AiStreamChunk),
) -> Result<(Vec<crate::agent_events::ToolCall>, Option<TokenUsage>), String> {
    validate_config(config)?;
    if matches!(config.provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli | AiProvider::PiAgentCli) {
        return Err("CLI providers are only supported through the DBX AI agent loop".to_string());
    }

    let stream_timeout = if runtime_thinking_enabled(config) { 600 } else { 120 };
    let client = build_ai_http_client(config, stream_timeout)?;

    let accumulator = Arc::new(std::sync::Mutex::new(StreamingToolCallAccumulator::new()));

    let token_usage = if uses_anthropic_messages_api(config) {
        stream_claude_with_tools(&client, session_id, request, tools, cancelled, &|event| {
            accumulator.lock().unwrap().process(event, &on_chunk);
        })
        .await?
    } else {
        match config.provider {
            AiProvider::Gemini => {
                stream_gemini_with_tools(&client, session_id, request, tools, cancelled, &|event| {
                    accumulator.lock().unwrap().process(event, &on_chunk);
                })
                .await?
            }
            _ if config.api_style == AiApiStyle::Responses => {
                stream_responses_with_tools(&client, session_id, request, tools, cancelled, &|event| {
                    accumulator.lock().unwrap().process(event, &on_chunk);
                })
                .await?
            }
            _ => {
                stream_openai_with_tools(&client, session_id, request, tools, cancelled, &|event| {
                    accumulator.lock().unwrap().process(event, &on_chunk);
                })
                .await?
            }
        }
    };

    let tool_calls = Arc::try_unwrap(accumulator)
        .expect("stream_with_tools: accumulator Arc should have single owner")
        .into_inner()
        .expect("stream_with_tools: accumulator Mutex should not be poisoned")
        .finalize();

    Ok((tool_calls, token_usage))
}

// ---------------------------------------------------------------------------
// Conversation persistence (path-based)
// ---------------------------------------------------------------------------

const MAX_CONVERSATIONS: usize = 50;

pub fn read_conversations(path: &Path) -> Result<Vec<AiConversation>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

pub fn write_conversations(path: &Path, conversations: &[AiConversation]) -> Result<(), String> {
    let json = serde_json::to_string(conversations).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn save_conversation(path: &Path, conversation: AiConversation) -> Result<(), String> {
    let mut conversations = read_conversations(path)?;
    if let Some(pos) = conversations.iter().position(|c| c.id == conversation.id) {
        conversations[pos] = conversation;
    } else {
        conversations.insert(0, conversation);
        conversations.truncate(MAX_CONVERSATIONS);
    }
    write_conversations(path, &conversations)
}

pub fn load_conversations(path: &Path) -> Result<Vec<AiConversation>, String> {
    read_conversations(path)
}

pub fn delete_conversation(path: &Path, id: &str) -> Result<(), String> {
    let conversations: Vec<AiConversation> = read_conversations(path)?.into_iter().filter(|c| c.id != id).collect();
    write_conversations(path, &conversations)
}

pub fn save_config(path: &Path, config: &AiConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn load_config(path: &Path) -> Result<Option<AiConfig>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map(Some).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use tokio::sync::Notify;

    use super::{
        apply_chat_completion_thinking_toggle, build_ai_http_client, build_gemini_contents,
        build_responses_input_with_tools, call_claude, classify_error, claude_headers, claude_system_prompt, complete,
        drain_next_stream_line, emit_gemini_tool_call_part, emit_responses_function_call_item, format_transport_error,
        gemini_text, is_kimi_model, is_retryable_error, list_models_core, maybe_bearer_headers, maybe_tag_retry_after,
        measure_first_stream_chunk, merge_global_max_retries, ollama_selected_model_tool_support, openai_response_text,
        openai_stream_reasoning, openai_stream_text, parse_dynamic_effort_capability, parse_gemini_model_list_response,
        parse_model_list_response, parse_retry_after, parse_retry_after_secs, resolve_endpoint,
        resolve_gemini_stream_endpoint, resolve_model_effort_core, resolve_model_list_endpoint,
        resolve_ollama_show_endpoint, responses_function_tool, responses_max_output_tokens, responses_stream_text,
        responses_text, responses_token_usage, retain_ollama_completion_models, retry_after_secs,
        set_chat_completion_token_limit, stream, stream_claude, stream_claude_with_tools, stream_data_payload,
        stream_error, stream_openai_with_tools, stream_with_tools, test_connection_core, uses_anthropic_messages_api,
        validate_config, validate_model_list_config, with_retry, with_stream_retry, AiApiStyle, AiAuthMethod,
        AiCapabilitySource, AiCompletionRequest, AiConfig, AiEffortCapability, AiEffortOption, AiEffortSelection,
        AiMessage, AiModelInfo, AiProvider, AiReasoningLevel, StreamToolEvent, StreamingToolCallAccumulator,
        ToolCallRef, AUTHORIZATION, CLAUDE_DEFAULT_SYSTEM, TEST_PROMPT,
    };

    struct CapturedJsonRequest {
        headers: String,
        body: serde_json::Value,
    }

    async fn spawn_json_capture_server(
        response_content_type: &'static str,
        response_body: &'static str,
    ) -> (String, tokio::task::JoinHandle<CapturedJsonRequest>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let header_end = loop {
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before headers were complete");
                request.extend_from_slice(&chunk[..read]);
            };
            let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while request.len() < header_end + content_length {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before body was complete");
                request.extend_from_slice(&chunk[..read]);
            }
            let body = serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {response_content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            CapturedJsonRequest { headers, body }
        });

        (format!("http://{address}/v1/messages"), server)
    }

    async fn spawn_error_server_with_body(
        status: u16,
        reason: &'static str,
        body: &'static str,
        retry_after_secs: Option<u64>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0, "server received no request");

            let mut resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            );
            if let Some(secs) = retry_after_secs {
                resp.push_str(&format!("Retry-After: {secs}\r\n"));
            }
            resp.push_str("Connection: close\r\n\r\n");
            resp.push_str(body);
            socket.write_all(resp.as_bytes()).await.unwrap();
        });

        (format!("http://{address}/test"), server)
    }

    async fn spawn_get_response_server(
        status: &'static str,
        response_body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before headers were complete");
                request.extend_from_slice(&chunk[..read]);
            }
            let request = String::from_utf8(request).unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });

        (format!("http://{address}"), server)
    }

    async fn spawn_paginated_model_server() -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let responses = [
                r#"{"data":[{"id":"vendor/first"},{"id":"vendor/shared"}],"has_more":true,"last_id":"cursor-1"}"#,
                r#"{"data":[{"id":"vendor/shared"},{"id":"vendor/second"}],"has_more":false,"last_id":"vendor/second"}"#,
            ];
            let mut requests = Vec::new();

            for response_body in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let bytes_read = socket.read(&mut chunk).await.unwrap();
                    assert!(bytes_read > 0, "request ended before headers were complete");
                    request.extend_from_slice(&chunk[..bytes_read]);
                }
                requests.push(String::from_utf8(request).unwrap());

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                    response_body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }

            requests
        });

        (format!("http://{address}"), server)
    }

    async fn spawn_model_discovery_and_stream_server() -> (String, tokio::task::JoinHandle<CapturedJsonRequest>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        async fn read_request(socket: &mut tokio::net::TcpStream) -> (String, Vec<u8>) {
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let header_end = loop {
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before headers were complete");
                request.extend_from_slice(&chunk[..read]);
            };
            let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or_default();
            while request.len() < header_end + content_length {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before body was complete");
                request.extend_from_slice(&chunk[..read]);
            }
            (headers, request[header_end..header_end + content_length].to_vec())
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut model_socket, _) = listener.accept().await.unwrap();
            let (model_headers, _) = read_request(&mut model_socket).await;
            assert!(model_headers.starts_with("GET /v1/models "));
            let model_body = r#"{"data":[{"id":"discovered-model"}]}"#;
            let model_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{model_body}",
                model_body.len()
            );
            model_socket.write_all(model_response.as_bytes()).await.unwrap();

            let (mut stream_socket, _) = listener.accept().await.unwrap();
            let (stream_headers, stream_body) = read_request(&mut stream_socket).await;
            assert!(stream_headers.starts_with("POST /v1/messages "));
            let stream_response_body =
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n";
            let stream_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{stream_response_body}",
                stream_response_body.len()
            );
            stream_socket.write_all(stream_response.as_bytes()).await.unwrap();

            CapturedJsonRequest { headers: stream_headers, body: serde_json::from_slice(&stream_body).unwrap() }
        });

        (format!("http://{address}"), server)
    }

    fn claude_http_test_request(endpoint: String) -> AiCompletionRequest {
        AiCompletionRequest {
            config: AiConfig {
                provider: AiProvider::Claude,
                api_key: "secret".to_string(),
                auth_method: AiAuthMethod::ApiKey,
                endpoint,
                model: "claude-sonnet-4-6[1m]".to_string(),
                models: Vec::new(),
                api_style: AiApiStyle::Completions,
                proxy_enabled: false,
                proxy_url: String::new(),
                enable_thinking: true,
                reasoning_level: AiReasoningLevel::Default,
                runtime_effort: None,
                context_window: Some(1_000_000),
                max_retries: None,
                codex_cli_path: None,
                codex_cli_env: Default::default(),
                claude_code_cli_path: None,
                claude_code_cli_env: Default::default(),
                pi_agent_cli_path: None,
                pi_agent_cli_env: Default::default(),
            },
            system_prompt: "Be concise.".to_string(),
            messages: vec![AiMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            }],
            task_contract: None,
            max_tokens: Some(64),
        }
    }

    fn anthropic_compatible_test_request(endpoint: String) -> AiCompletionRequest {
        let mut request = claude_http_test_request(endpoint);
        request.config.provider = AiProvider::AnthropicCompatible;
        request.config.auth_method = AiAuthMethod::Bearer;
        request.config.api_style = AiApiStyle::AnthropicMessages;
        request.config.model = "gateway-model".to_string();
        request
    }

    fn assert_claude_http_request(captured: CapturedJsonRequest) {
        assert_eq!(captured.body["model"], "claude-sonnet-4-6");
        assert!(!captured.headers.to_ascii_lowercase().contains("anthropic-beta:"));
    }

    #[tokio::test]
    async fn claude_http_completion_strips_cli_context_suffix_without_beta_header() {
        let (endpoint, server) =
            spawn_json_capture_server("application/json", r#"{"content":[{"type":"text","text":"ok"}]}"#).await;
        let request = claude_http_test_request(endpoint);
        let client = build_ai_http_client(&request.config, 10).unwrap();

        assert_eq!(call_claude(&client, request).await.unwrap(), "ok");
        assert_claude_http_request(server.await.unwrap());
    }

    #[tokio::test]
    async fn anthropic_compatible_completion_uses_messages_runtime_and_bearer_auth() {
        let (endpoint, server) =
            spawn_json_capture_server("application/json", r#"{"content":[{"type":"text","text":"compatible"}]}"#).await;
        let request = anthropic_compatible_test_request(endpoint);

        assert_eq!(complete(&request).await.unwrap(), "compatible");

        let captured = server.await.unwrap();
        let headers = captured.headers.to_ascii_lowercase();
        assert!(headers.contains("authorization: bearer secret"));
        assert!(headers.contains("anthropic-version: 2023-06-01"));
        assert!(!headers.contains("x-api-key:"));
        assert_eq!(captured.body["model"], "gateway-model");
    }

    #[tokio::test]
    async fn anthropic_compatible_connection_test_uses_anthropic_sse_and_api_key_auth() {
        let response = concat!(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n",
            "data: [DONE]\n\n"
        );
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", response).await;
        let mut config = anthropic_compatible_test_request(endpoint).config;
        config.auth_method = AiAuthMethod::ApiKey;

        let result = test_connection_core(&config).await.unwrap();

        assert!(result.success);
        assert_eq!(result.model_used, "gateway-model");
        let captured = server.await.unwrap();
        let headers = captured.headers.to_ascii_lowercase();
        assert!(headers.contains("x-api-key: secret"));
        assert!(!headers.contains("authorization: bearer"));
        assert_eq!(captured.body["stream"], true);
    }

    #[tokio::test]
    async fn anthropic_compatible_connection_test_surfaces_stream_error_once() {
        let response = concat!(
            "event: error\n",
            "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
        );
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", response).await;
        let mut config = anthropic_compatible_test_request(endpoint).config;
        config.max_retries = Some(0);

        let error = test_connection_core(&config).await.unwrap_err();

        assert!(error.starts_with("[network] Anthropic stream error"));
        assert_eq!(error.matches("[network]").count(), 1);
        assert!(error.contains("overloaded_error: Overloaded"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn anthropic_compatible_connection_test_discovers_a_model_before_messages() {
        let (endpoint, server) = spawn_model_discovery_and_stream_server().await;
        let mut config = anthropic_compatible_test_request(endpoint).config;
        config.model.clear();

        let result = test_connection_core(&config).await.unwrap();

        assert!(result.success);
        assert_eq!(result.model_used, "discovered-model");
        let captured = server.await.unwrap();
        assert_eq!(captured.body["model"], "discovered-model");
        assert_eq!(captured.body["stream"], true);
    }

    #[tokio::test]
    async fn anthropic_compatible_stream_reuses_anthropic_event_parsing() {
        let response = concat!(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"compatible stream\"}}\n\n",
            "data: [DONE]\n\n"
        );
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", response).await;
        let request = anthropic_compatible_test_request(endpoint);
        let chunks = RefCell::new(Vec::new());

        stream("compatible-session", &request, &Notify::new(), |chunk| chunks.borrow_mut().push(chunk)).await.unwrap();

        let chunks = chunks.into_inner();
        assert_eq!(chunks[0].delta, "compatible stream");
        assert!(!chunks[0].done);
        assert!(chunks.last().unwrap().done);
        let captured = server.await.unwrap();
        assert_eq!(captured.body["model"], "gateway-model");
    }

    #[tokio::test]
    async fn anthropic_compatible_stream_surfaces_sse_error_event() {
        let response = concat!(
            "event: error\n",
            "data: {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Too many requests\"}}\n\n"
        );
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", response).await;
        let mut request = anthropic_compatible_test_request(endpoint);
        request.config.max_retries = Some(0);
        let chunks = RefCell::new(Vec::new());

        let error = stream("compatible-session", &request, &Notify::new(), |chunk| chunks.borrow_mut().push(chunk))
            .await
            .unwrap_err();

        assert!(error.starts_with("[rateLimit]"));
        assert!(error.contains("rate_limit_error: Too many requests"));
        assert!(chunks.into_inner().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn anthropic_compatible_tool_stream_reuses_anthropic_tool_events() {
        let response = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"get_tables\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"schema\\\":\\\"public\\\"}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":6}}\n\n",
            "data: [DONE]\n\n"
        );
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", response).await;
        let request = anthropic_compatible_test_request(endpoint);
        let tools = [crate::agent_events::ToolDefinition {
            name: "get_tables",
            description: "List tables",
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "schema": { "type": "string" } }
            }),
            read_only: true,
            parallel_ok: true,
        }];

        let (calls, usage) =
            stream_with_tools(&request.config, &request, "compatible-session", &tools, &Notify::new(), |_| {})
                .await
                .unwrap();

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "tool-1");
        assert_eq!(calls[0].name, "get_tables");
        assert_eq!(calls[0].arguments["schema"], "public");
        assert_eq!(usage.unwrap().input_tokens, 4);
        assert_eq!(server.await.unwrap().body["tools"][0]["name"], "get_tables");
    }

    #[tokio::test]
    async fn anthropic_compatible_tool_stream_surfaces_json_error_event() {
        let response =
            "data: {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}\n\n";
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", response).await;
        let mut request = anthropic_compatible_test_request(endpoint);
        request.config.max_retries = Some(0);

        let error = stream_with_tools(&request.config, &request, "compatible-session", &[], &Notify::new(), |_| {})
            .await
            .unwrap_err();

        assert!(error.starts_with("[auth]"));
        assert!(error.contains("authentication_error: invalid x-api-key"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn claude_http_stream_strips_cli_context_suffix_without_beta_header() {
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", "data: [DONE]\n\n").await;
        let request = claude_http_test_request(endpoint);
        let client = build_ai_http_client(&request.config, 10).unwrap();

        stream_claude(&client, "test", &request, &Notify::new(), &|_| {}).await.unwrap();
        assert_claude_http_request(server.await.unwrap());
    }

    #[tokio::test]
    async fn claude_http_tool_stream_strips_cli_context_suffix_without_beta_header() {
        let (endpoint, server) = spawn_json_capture_server("text/event-stream", "data: [DONE]\n\n").await;
        let request = claude_http_test_request(endpoint);
        let client = build_ai_http_client(&request.config, 10).unwrap();
        let tools = [crate::agent_events::ToolDefinition {
            name: "get_tables",
            description: "List tables",
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
            read_only: true,
            parallel_ok: true,
        }];

        stream_claude_with_tools(&client, "test", &request, &tools, &Notify::new(), &|_| {}).await.unwrap();
        assert_claude_http_request(server.await.unwrap());
    }

    /// Reproduce the "Unknown tool:" bug: some OpenAI-compatible providers
    /// (e.g. GLM via proxy) re-send the `id` field in every tool-call delta.
    /// The second delta carries `id` but omits `function.name`, so the OpenAI
    /// parser emits a second ToolCallStart with an empty name. The
    /// accumulator's `insert` then overwrites the previously-correct name.
    #[test]
    fn accumulator_preserves_name_when_provider_resends_id() {
        let mut acc = StreamingToolCallAccumulator::new();
        let noop = |_chunk| {};

        // First chunk: id + name present (standard OpenAI first delta)
        acc.process(
            StreamToolEvent::ToolCallStart { index: 0, id: "call_1".to_string(), name: "get_columns".to_string() },
            &noop,
        );
        acc.process(StreamToolEvent::ToolCallDelta { index: 0, fragment: "{\"table\":".to_string() }, &noop);

        // Second chunk: provider re-sends `id` but omits `function.name`.
        // The OpenAI parser sees `id` is Some and emits ToolCallStart with
        // name = "" (from unwrap_or_default()).
        acc.process(StreamToolEvent::ToolCallStart { index: 0, id: "call_1".to_string(), name: String::new() }, &noop);
        acc.process(StreamToolEvent::ToolCallDelta { index: 0, fragment: "\"record_trip_id_t\"}".to_string() }, &noop);

        let calls = acc.finalize();
        assert_eq!(calls.len(), 1, "expected exactly one accumulated tool call");
        assert_eq!(
            calls[0].name, "get_columns",
            "tool name was wiped to empty by a re-sent ToolCallStart — this is the \"Unknown tool:\" bug"
        );
        assert_eq!(calls[0].arguments["table"], "record_trip_id_t", "arguments were reset by a re-sent ToolCallStart");
    }

    #[test]
    fn gemini_tool_call_replays_provider_payload_unchanged() {
        let response_part = serde_json::json!({
            "functionCall": {
                "name": "list_tables",
                "args": { "schema": "public" }
            },
            "thoughtSignature": "encrypted-signature"
        });
        let accumulator = RefCell::new(StreamingToolCallAccumulator::new());

        assert!(emit_gemini_tool_call_part(&response_part, 0, &|event| {
            accumulator.borrow_mut().process(event, &|_| {});
        }));

        let calls = accumulator.into_inner().finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "list_tables");
        assert_eq!(calls[0].arguments, serde_json::json!({ "schema": "public" }));
        assert_eq!(calls[0].provider_payload.as_ref(), Some(&response_part));

        let contents = build_gemini_contents(&[
            AiMessage {
                role: "assistant".to_string(),
                content: String::new(),
                tool_call_id: None,
                tool_calls: vec![ToolCallRef {
                    id: calls[0].id.clone(),
                    name: calls[0].name.clone(),
                    arguments: calls[0].arguments.clone(),
                    provider_payload: calls[0].provider_payload.clone(),
                }],
            },
            AiMessage {
                role: "tool".to_string(),
                content: "users".to_string(),
                tool_call_id: Some(calls[0].id.clone()),
                tool_calls: Vec::new(),
            },
        ]);

        assert_eq!(contents[0]["role"], "model");
        assert_eq!(contents[0]["parts"][0], response_part);
        assert_eq!(contents[1]["parts"][0]["functionResponse"]["name"], "list_tables");
    }

    #[test]
    fn gemini_tool_call_without_provider_payload_uses_canonical_part() {
        let contents = build_gemini_contents(&[AiMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_call_id: None,
            tool_calls: vec![ToolCallRef {
                id: "gemini-tc-list_tables-0".to_string(),
                name: "list_tables".to_string(),
                arguments: serde_json::json!({ "schema": "public" }),
                provider_payload: None,
            }],
        }]);

        assert_eq!(
            contents[0]["parts"][0],
            serde_json::json!({
                "functionCall": {
                    "name": "list_tables",
                    "args": { "schema": "public" }
                }
            })
        );
    }

    #[test]
    fn stream_line_decoder_preserves_split_multibyte_utf8() {
        let text = "\u{8bf4}\u{660e}";
        let json = serde_json::json!({ "delta": text }).to_string();
        let line = format!("data: {json}\n");
        let bytes = line.as_bytes();
        let split = bytes.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
        let mut buffer = Vec::new();

        buffer.extend_from_slice(&bytes[..split]);
        assert_eq!(drain_next_stream_line(&mut buffer).unwrap(), None);

        buffer.extend_from_slice(&bytes[split..]);
        let decoded = drain_next_stream_line(&mut buffer).unwrap().unwrap();
        let payload = stream_data_payload(&decoded).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(payload).unwrap();

        assert_eq!(parsed["delta"].as_str(), Some(text));
        assert!(!decoded.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn gemini_connection_probe_reports_thinking_token_exhaustion() {
        let event = serde_json::json!({
            "candidates": [{ "finishReason": "MAX_TOKENS" }],
            "usageMetadata": {
                "promptTokenCount": 5,
                "candidatesTokenCount": 0,
                "thoughtsTokenCount": 256,
                "totalTokenCount": 261
            }
        });
        let stream = futures::stream::iter([Ok::<_, reqwest::Error>(bytes::Bytes::from(format!("data: {event}\n\n")))]);

        let error = measure_first_stream_chunk(stream, std::time::Instant::now(), false, true).await.unwrap_err();

        assert!(error.contains("finishReason=MAX_TOKENS"));
        assert!(error.contains("thoughts=256"));
        assert!(error.contains("thinking tokens"));
        assert_eq!(classify_error(&error), "tokenLimit");
    }

    #[tokio::test]
    async fn gemini_connection_probe_reports_prompt_safety_block() {
        let event = serde_json::json!({
            "promptFeedback": {
                "blockReason": "SAFETY",
                "safetyRatings": [{
                    "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                    "probability": "HIGH",
                    "blocked": true
                }]
            }
        });
        let stream = futures::stream::iter([Ok::<_, reqwest::Error>(bytes::Bytes::from(format!("data: {event}\n\n")))]);

        let error = measure_first_stream_chunk(stream, std::time::Instant::now(), false, true).await.unwrap_err();

        assert!(error.contains("blockReason=SAFETY"));
        assert!(error.contains("HARM_CATEGORY_DANGEROUS_CONTENT:HIGH:blocked"));
        assert_eq!(classify_error(&error), "safety");
    }

    #[tokio::test]
    async fn transport_errors_do_not_expose_request_query_parameters() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let secret = "gemini-secret-key";
        let error = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/models?key={secret}"))
            .send()
            .await
            .unwrap_err();

        assert!(error.url().is_some_and(|url| url.as_str().contains(secret)));
        let message = format_transport_error("Gemini", error);
        assert!(!message.contains(secret));
        assert!(!message.contains("?key="));
    }

    #[tokio::test]
    async fn connection_probe_distinguishes_empty_body_from_non_sse_proxy_response() {
        let empty = futures::stream::empty::<Result<bytes::Bytes, reqwest::Error>>();
        let empty_error = measure_first_stream_chunk(empty, std::time::Instant::now(), false, true).await.unwrap_err();
        assert!(empty_error.contains("response body was empty"));
        assert!(empty_error.contains("endpoint or proxy"));
        assert_eq!(classify_error(&empty_error), "emptyResponse");

        let proxy = futures::stream::iter([Ok::<_, reqwest::Error>(bytes::Bytes::from_static(b"proxy response"))]);
        let proxy_error = measure_first_stream_chunk(proxy, std::time::Instant::now(), false, true).await.unwrap_err();
        assert!(proxy_error.contains("14 bytes but no SSE data events"));
        assert!(proxy_error.contains("proxy streaming support"));
        assert_eq!(classify_error(&proxy_error), "emptyResponse");
    }

    #[tokio::test]
    async fn connection_probe_accepts_final_sse_line_without_newline() {
        let event = serde_json::json!({
            "candidates": [{ "content": { "parts": [{ "text": "OK" }] } }]
        });
        let stream = futures::stream::iter([Ok::<_, reqwest::Error>(bytes::Bytes::from(format!("data: {event}")))]);

        let (_, text) = measure_first_stream_chunk(stream, std::time::Instant::now(), false, true).await.unwrap();

        assert_eq!(text, "OK");
    }

    #[test]
    fn classifies_google_api_error_codes() {
        assert_eq!(classify_error("HTTP 403: API_KEY_INVALID"), "auth");
        assert_eq!(classify_error("HTTP 404: model is not supported for generateContent"), "modelNotFound");
        assert_eq!(classify_error("HTTP 429: RESOURCE_EXHAUSTED quota exceeded"), "rateLimit");
    }

    #[test]
    fn ai_config_proxy_fields_default_for_legacy_config() {
        let config: AiConfig = serde_json::from_value(serde_json::json!({
            "provider": "openai",
            "apiKey": "key",
            "endpoint": "https://api.openai.com/v1/chat/completions",
            "model": "gpt-4o",
            "apiStyle": "completions"
        }))
        .unwrap();

        assert!(!config.proxy_enabled);
        assert_eq!(config.proxy_url, "");
        assert!(config.enable_thinking);
        assert_eq!(config.auth_method, AiAuthMethod::ApiKey);
        assert!(config.claude_code_cli_path.is_none());
        assert!(config.claude_code_cli_env.is_empty());
        assert!(config.codex_cli_env.is_empty());
        assert!(config.pi_agent_cli_path.is_none());
        assert!(config.pi_agent_cli_env.is_empty());
    }

    #[test]
    fn ai_http_client_rejects_invalid_proxy_url() {
        let config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-4o".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: true,
            proxy_url: "not a proxy url".to_string(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        let err = build_ai_http_client(&config, 1).unwrap_err();

        assert!(err.contains("Invalid AI proxy URL"));
    }

    #[test]
    fn ai_http_client_accepts_proxy_host_port_without_scheme() {
        let config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-4o".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: true,
            proxy_url: "127.0.0.1:7890".to_string(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        build_ai_http_client(&config, 1).unwrap();
    }

    #[test]
    fn ai_http_client_bypasses_proxy_for_loopback_endpoint() {
        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "http://127.0.0.1:3456/v1".to_string(),
            model: "gpt-4o".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: true,
            proxy_url: "not a proxy url".to_string(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        build_ai_http_client(&config, 1).unwrap();
    }

    #[test]
    fn resolves_gemini_and_ollama_endpoints() {
        let gemini = AiConfig {
            provider: AiProvider::Gemini,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: "https://generativelanguage.googleapis.com".to_string(),
            model: "gemini-1.5-pro".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        assert_eq!(
            resolve_endpoint(&gemini),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent"
        );
        assert_eq!(
            resolve_gemini_stream_endpoint(&gemini),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent"
        );

        let ollama = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "http://localhost:11434/v1".to_string(),
            model: "llama3.1".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        assert_eq!(resolve_endpoint(&ollama), "http://localhost:11434/v1/chat/completions");
        assert!(validate_config(&ollama).is_ok());
    }

    #[test]
    fn allows_empty_api_keys_only_for_self_hosted_providers() {
        let base = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "http://localhost:8080/v1".to_string(),
            model: "local-model".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        for provider in
            [AiProvider::Ollama, AiProvider::AnthropicCompatible, AiProvider::OpenaiCompatible, AiProvider::Custom]
        {
            let config = AiConfig { provider, ..base.clone() };
            assert!(validate_config(&config).is_ok());
            assert!(validate_model_list_config(&config).is_ok());
            assert!(maybe_bearer_headers(&config).unwrap().get(AUTHORIZATION).is_none());
        }

        for provider in
            [AiProvider::Claude, AiProvider::Openai, AiProvider::Gemini, AiProvider::Deepseek, AiProvider::Qwen]
        {
            let config = AiConfig { provider, ..base.clone() };
            assert_eq!(validate_config(&config).unwrap_err(), "API key is required");
            assert_eq!(validate_model_list_config(&config).unwrap_err(), "API key is required");
        }
    }

    #[test]
    fn resolves_model_list_endpoints_from_base_and_completion_urls() {
        let openai = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: String::new(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        assert_eq!(resolve_model_list_endpoint(&openai).unwrap(), "https://api.openai.com/v1/models");

        let claude = AiConfig {
            provider: AiProvider::Claude,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: "https://api.anthropic.com/v1/messages".to_string(),
            model: String::new(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        assert_eq!(resolve_model_list_endpoint(&claude).unwrap(), "https://api.anthropic.com/v1/models");
    }

    #[test]
    fn custom_anthropic_messages_style_uses_claude_endpoints() {
        let config = AiConfig {
            provider: AiProvider::Custom,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: "https://gateway.example.com/anthropic/v1".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::AnthropicMessages,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        assert!(uses_anthropic_messages_api(&config));
        assert_eq!(resolve_endpoint(&config), "https://gateway.example.com/anthropic/v1/messages");
        assert_eq!(resolve_model_list_endpoint(&config).unwrap(), "https://gateway.example.com/anthropic/v1/models");

        let full_messages =
            AiConfig { endpoint: "https://gateway.example.com/anthropic/v1/messages".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&full_messages), "https://gateway.example.com/anthropic/v1/messages");
        assert_eq!(
            resolve_model_list_endpoint(&full_messages).unwrap(),
            "https://gateway.example.com/anthropic/v1/models"
        );

        let bare_origin = AiConfig { endpoint: "https://gateway.example.com".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&bare_origin), "https://gateway.example.com/v1/messages");
        assert_eq!(resolve_model_list_endpoint(&bare_origin).unwrap(), "https://gateway.example.com/v1/models");

        let kimi_coding = AiConfig {
            endpoint: "https://api.kimi.com/coding/".to_string(),
            model: "kimi-for-coding".to_string(),
            ..config.clone()
        };
        assert_eq!(resolve_endpoint(&kimi_coding), "https://api.kimi.com/coding/v1/messages");
        assert_eq!(resolve_model_list_endpoint(&kimi_coding).unwrap(), "https://api.kimi.com/coding/v1/models");
    }

    #[test]
    fn anthropic_compatible_provider_uses_fixed_messages_endpoints_and_round_trips() {
        let config = anthropic_compatible_test_request("https://gateway.example.com".to_string()).config;

        assert!(uses_anthropic_messages_api(&config));
        assert_eq!(resolve_endpoint(&config), "https://gateway.example.com/v1/messages");
        assert_eq!(resolve_model_list_endpoint(&config).unwrap(), "https://gateway.example.com/v1/models");

        let v1 = AiConfig { endpoint: "https://gateway.example.com/v1".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&v1), "https://gateway.example.com/v1/messages");

        let nested =
            AiConfig { endpoint: "https://gateway.example.com/anthropic/v1/messages".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&nested), "https://gateway.example.com/anthropic/v1/messages");
        assert_eq!(resolve_model_list_endpoint(&nested).unwrap(), "https://gateway.example.com/anthropic/v1/models");

        let dashscope =
            AiConfig { endpoint: "https://dashscope-intl.aliyuncs.com/apps/anthropic".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&dashscope), "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages");
        assert_eq!(
            resolve_model_list_endpoint(&dashscope).unwrap(),
            "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/models"
        );

        let provider_json = serde_json::to_string(&AiProvider::AnthropicCompatible).unwrap();
        assert_eq!(provider_json, r#""anthropic-compatible""#);
        assert!(matches!(serde_json::from_str::<AiProvider>(&provider_json).unwrap(), AiProvider::AnthropicCompatible));
    }

    #[test]
    fn auto_adds_v1_to_openai_compatible_endpoints() {
        // Endpoint without /v1 — auto add
        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.example.com".to_string(),
            model: "test-model".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        assert_eq!(resolve_endpoint(&config), "https://api.example.com/v1/chat/completions");
        assert_eq!(resolve_model_list_endpoint(&config).unwrap(), "https://api.example.com/v1/models");

        // Endpoint with /v1 already present — no change
        let config_v1 = AiConfig { endpoint: "https://api.example.com/v1".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&config_v1), "https://api.example.com/v1/chat/completions");
        assert_eq!(resolve_model_list_endpoint(&config_v1).unwrap(), "https://api.example.com/v1/models");

        // Endpoint with /v2 — no change
        let config_v2 = AiConfig { endpoint: "https://api.example.com/v2".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&config_v2), "https://api.example.com/v2/chat/completions");

        // Full path already specified — no change
        let config_full =
            AiConfig { endpoint: "https://api.openai.com/v1/chat/completions".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&config_full), "https://api.openai.com/v1/chat/completions");

        // Responses API style with /v1 missing
        let config_responses = AiConfig { api_style: AiApiStyle::Responses, ..config.clone() };
        assert_eq!(resolve_endpoint(&config_responses), "https://api.example.com/v1/responses");

        // Ollama preset already has /v1 — no change
        let ollama = AiConfig {
            provider: AiProvider::Ollama,
            endpoint: "http://localhost:11434/v1".to_string(),
            ..config.clone()
        };
        assert_eq!(resolve_endpoint(&ollama), "http://localhost:11434/v1/chat/completions");

        // Custom path without /v1 — left alone (CC-Switch strategy: only bare origin gets auto /v1)
        let custom_path = AiConfig { endpoint: "https://my-gateway.com/api".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&custom_path), "https://my-gateway.com/api/chat/completions");
        assert_eq!(resolve_model_list_endpoint(&custom_path).unwrap(), "https://my-gateway.com/api/models");

        // Bare host with port — add /v1
        let bare_with_port = AiConfig { endpoint: "http://localhost:8080".to_string(), ..config.clone() };
        assert_eq!(resolve_endpoint(&bare_with_port), "http://localhost:8080/v1/chat/completions");
    }

    #[test]
    fn official_openai_endpoint_tracks_api_style() {
        let config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-5.6-luna".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Responses,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        assert_eq!(resolve_endpoint(&config), "https://api.openai.com/v1/responses");

        let completions = AiConfig {
            endpoint: "https://api.openai.com/v1/responses".to_string(),
            api_style: AiApiStyle::Completions,
            ..config
        };
        assert_eq!(resolve_endpoint(&completions), "https://api.openai.com/v1/chat/completions");
    }

    #[test]
    fn claude_headers_support_api_key_and_bearer_auth() {
        let mut config = AiConfig {
            provider: AiProvider::Claude,
            api_key: " \tsecret\r\n".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: "https://api.anthropic.com/v1/messages".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        let api_key_headers = claude_headers(&config).unwrap();
        assert_eq!(api_key_headers.get("x-api-key").unwrap(), "secret");
        assert!(api_key_headers.get(AUTHORIZATION).is_none());
        assert!(api_key_headers.get("anthropic-beta").is_none());

        let compatible_headers = maybe_bearer_headers(&config).unwrap();
        assert_eq!(compatible_headers.get(AUTHORIZATION).unwrap(), "Bearer secret");

        config.auth_method = AiAuthMethod::Bearer;
        let bearer_headers = claude_headers(&config).unwrap();
        assert_eq!(bearer_headers.get(AUTHORIZATION).unwrap(), "Bearer secret");
        assert!(bearer_headers.get("x-api-key").is_none());

        config.provider = AiProvider::Custom;
        config.api_key.clear();
        let unauthenticated_headers = claude_headers(&config).unwrap();
        assert!(unauthenticated_headers.get(AUTHORIZATION).is_none());
        assert!(unauthenticated_headers.get("x-api-key").is_none());
        assert_eq!(unauthenticated_headers.get("anthropic-version").unwrap(), "2023-06-01");
    }

    #[test]
    fn claude_system_prompt_substitutes_default_when_empty() {
        // Empty or whitespace-only prompts must fall back to a non-empty value,
        // otherwise Anthropic rejects the request with
        // "system: text content blocks must be non-empty".
        assert_eq!(claude_system_prompt(""), CLAUDE_DEFAULT_SYSTEM);
        assert_eq!(claude_system_prompt("   \n\t"), CLAUDE_DEFAULT_SYSTEM);
        assert!(!CLAUDE_DEFAULT_SYSTEM.is_empty());

        // Real prompts pass through unchanged.
        assert_eq!(claude_system_prompt("Be concise."), "Be concise.");
    }

    #[test]
    fn parses_openai_and_claude_model_list_items() {
        let data = serde_json::json!({
            "data": [
                { "id": "gpt-4o-mini" },
                { "id": "claude-sonnet-4-20250514", "display_name": "Claude Sonnet 4" },
                { "id": "gpt-4o-mini" },
                { "display_name": "Missing ID" }
            ]
        });

        assert_eq!(
            parse_model_list_response(&data).unwrap(),
            vec![
                AiModelInfo::new("gpt-4o-mini", None),
                AiModelInfo::new("claude-sonnet-4-20250514", Some("Claude Sonnet 4".to_string())),
            ]
        );
    }

    #[test]
    fn parses_only_assistant_compatible_gemini_models() {
        let data = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-2.5-pro",
                    "displayName": "Gemini 2.5 Pro",
                    "supportedGenerationMethods": ["generateContent", "countTokens"]
                },
                {
                    "name": "models/gemini-embedding-001",
                    "supportedGenerationMethods": ["embedContent"]
                },
                {
                    "name": "models/gemini-3-pro-image-preview",
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/future-chat-model"
                },
                {
                    "name": "models/gemini-2.5-pro",
                    "supportedGenerationMethods": ["generateContent"]
                }
            ]
        });

        assert_eq!(
            parse_gemini_model_list_response(&data).unwrap(),
            vec![
                AiModelInfo::new("gemini-2.5-pro", Some("Gemini 2.5 Pro".to_string())),
                AiModelInfo::new("future-chat-model", None),
            ]
        );
    }

    #[test]
    fn resolves_ollama_native_show_endpoint_from_openai_compatibility_url() {
        let config = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "http://localhost:11434/v1/chat/completions".to_string(),
            model: String::new(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        assert_eq!(resolve_ollama_show_endpoint(&config).unwrap(), "http://localhost:11434/api/show");

        let prefixed = AiConfig { endpoint: "https://example.com/ollama/v1".to_string(), ..config };
        assert_eq!(resolve_ollama_show_endpoint(&prefixed).unwrap(), "https://example.com/ollama/api/show");
    }

    #[tokio::test]
    async fn ollama_selected_model_tool_support_reads_show_capabilities() {
        let (endpoint, server) =
            spawn_json_capture_server("application/json", r#"{"capabilities":["completion","tools"]}"#).await;
        let config = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint,
            model: "qwen3:0.6b".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        assert_eq!(ollama_selected_model_tool_support(&config).await.unwrap(), Some(true));
        assert_eq!(server.await.unwrap().body["model"], "qwen3:0.6b");
    }

    #[tokio::test]
    async fn ollama_catalog_excludes_models_with_explicit_non_completion_capability() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requested_models = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                let header_end = loop {
                    if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break index + 4;
                    }
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "request ended before headers were complete");
                    request.extend_from_slice(&chunk[..read]);
                };
                let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                assert!(headers.starts_with("POST /api/show "));
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                while request.len() < header_end + content_length {
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "request ended before body was complete");
                    request.extend_from_slice(&chunk[..read]);
                }
                let body: serde_json::Value =
                    serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
                let model = body["model"].as_str().unwrap().to_string();
                requested_models.push(model.clone());
                let response_body = match model.as_str() {
                    "qwen3:0.6b" => r#"{"capabilities":["completion","tools"]}"#,
                    "embeddinggemma:latest" => r#"{"capabilities":["embedding"]}"#,
                    "legacy-model" => r#"{"details":{"family":"legacy"}}"#,
                    other => panic!("unexpected model request: {other}"),
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                    response_body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requested_models.sort();
            requested_models
        });

        let config = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: format!("http://{address}/v1"),
            model: String::new(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let models = vec![
            AiModelInfo::new("qwen3:0.6b", None),
            AiModelInfo::new("embeddinggemma:latest", None),
            AiModelInfo::new("legacy-model", None),
        ];

        let filtered = retain_ollama_completion_models(&reqwest::Client::new(), &config, models).await;

        assert_eq!(filtered.into_iter().map(|model| model.id).collect::<Vec<_>>(), vec!["qwen3:0.6b", "legacy-model"]);
        assert_eq!(server.await.unwrap(), vec!["embeddinggemma:latest", "legacy-model", "qwen3:0.6b"]);
    }

    #[test]
    fn responses_api_clamps_tiny_output_token_requests() {
        assert_eq!(responses_max_output_tokens(Some(1)), 16);
        assert_eq!(responses_max_output_tokens(Some(16)), 16);
        assert_eq!(responses_max_output_tokens(Some(2400)), 2400);
        assert_eq!(responses_max_output_tokens(None), 2048);
    }

    #[test]
    fn responses_stream_text_reads_current_delta_shapes() {
        assert_eq!(
            responses_stream_text(&serde_json::json!({
                "type": "response.output_text.delta",
                "delta": "SELECT"
            })),
            Some("SELECT")
        );
        assert_eq!(
            responses_stream_text(&serde_json::json!({
                "type": "response.output_text.done",
                "text": "SELECT 1;"
            })),
            None
        );
    }

    #[test]
    fn responses_token_usage_reads_stream_completed_response_usage() {
        let completed_usage = responses_token_usage(&serde_json::json!({
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 34
                }
            }
        }))
        .unwrap();
        assert_eq!(completed_usage.input_tokens, 12);
        assert_eq!(completed_usage.output_tokens, 34);

        let top_level_usage = responses_token_usage(&serde_json::json!({
            "usage": {
                "input_tokens": 56,
                "output_tokens": 78
            }
        }))
        .unwrap();
        assert_eq!(top_level_usage.input_tokens, 56);
        assert_eq!(top_level_usage.output_tokens, 78);
    }

    #[test]
    fn responses_tools_use_responses_schema() {
        let input = build_responses_input_with_tools(
            "system",
            &[
                AiMessage {
                    role: "user".to_string(),
                    content: "inspect db".to_string(),
                    tool_call_id: None,
                    tool_calls: Vec::new(),
                },
                AiMessage {
                    role: "assistant".to_string(),
                    content: String::new(),
                    tool_call_id: None,
                    tool_calls: vec![ToolCallRef {
                        id: "call_1".to_string(),
                        name: "list_tables".to_string(),
                        arguments: serde_json::json!({"schema": "public"}),
                        provider_payload: None,
                    }],
                },
                AiMessage {
                    role: "tool".to_string(),
                    content: "users".to_string(),
                    tool_call_id: Some("call_1".to_string()),
                    tool_calls: Vec::new(),
                },
            ],
        );

        assert_eq!(input[0]["role"], "developer");
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["call_id"], "call_1");
        assert_eq!(input[2]["arguments"], "{\"schema\":\"public\"}");
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "call_1");

        let tool = crate::agent_events::ToolDefinition {
            name: "list_tables",
            description: "List tables",
            parameters: serde_json::json!({"type": "object"}),
            read_only: true,
            parallel_ok: true,
        };
        let tool_json = responses_function_tool(&tool);
        assert_eq!(tool_json["type"], "function");
        assert_eq!(tool_json["name"], "list_tables");
        assert!(tool_json.get("function").is_none());
    }

    #[test]
    fn responses_tool_done_item_can_supply_complete_function_call() {
        let mut accumulator = StreamingToolCallAccumulator::new();
        let mut item_indices = HashMap::new();
        let mut started_indices = HashSet::new();
        let mut argument_indices = HashSet::new();
        let mut next_index = 0;
        let event = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "fc_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "list_tables",
                "arguments": "{\"schema\":\"public\"}"
            }
        });
        let events = RefCell::new(Vec::new());
        if let Some(index) = emit_responses_function_call_item(
            &event,
            &mut item_indices,
            &mut started_indices,
            &mut argument_indices,
            &mut next_index,
            &|event| events.borrow_mut().push(event),
        ) {
            events.borrow_mut().push(StreamToolEvent::ToolCallComplete { index });
        }
        for event in events.into_inner() {
            accumulator.process(event, &|_| {});
        }

        let calls = accumulator.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "list_tables");
        assert_eq!(calls[0].arguments["schema"], "public");
    }

    #[test]
    fn responses_tool_arguments_are_not_duplicated_when_done_follows_delta() {
        let mut accumulator = StreamingToolCallAccumulator::new();
        let mut item_indices = HashMap::new();
        let mut started_indices = HashSet::new();
        let mut argument_indices = HashSet::new();
        let mut next_index = 0;
        let added = serde_json::json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": "fc_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "list_tables"
            }
        });
        let done = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "fc_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "list_tables",
                "arguments": "{\"schema\":\"public\"}"
            }
        });

        let events = RefCell::new(Vec::new());
        emit_responses_function_call_item(
            &added,
            &mut item_indices,
            &mut started_indices,
            &mut argument_indices,
            &mut next_index,
            &|event| events.borrow_mut().push(event),
        );
        for event in events.take() {
            accumulator.process(event, &|_| {});
        }

        let delta_index = item_indices.get("fc_1").copied().unwrap();
        argument_indices.insert(delta_index);
        accumulator.process(
            StreamToolEvent::ToolCallDelta { index: delta_index, fragment: "{\"schema\":\"public\"}".to_string() },
            &|_| {},
        );

        if let Some(index) = emit_responses_function_call_item(
            &done,
            &mut item_indices,
            &mut started_indices,
            &mut argument_indices,
            &mut next_index,
            &|event| events.borrow_mut().push(event),
        ) {
            events.borrow_mut().push(StreamToolEvent::ToolCallComplete { index });
        }
        for event in events.into_inner() {
            accumulator.process(event, &|_| {});
        }

        let calls = accumulator.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments, serde_json::json!({"schema": "public"}));
    }

    #[test]
    fn detects_kimi_models_that_skip_extra_body_thinking_toggle() {
        assert!(is_kimi_model("kimi-k2.7-code"));
        assert!(is_kimi_model("kimi-k2.6"));
        assert!(is_kimi_model("kimi-k2.5"));
        assert!(is_kimi_model("kimi-k3"));

        // Older K2 variants should not skip OpenAI-compatible thinking toggles.
        assert!(!is_kimi_model("kimi-k2"));
        assert!(!is_kimi_model("kimi-k2-thinking"));
        assert!(!is_kimi_model("kimi-k2-0711-preview"));
        assert!(!is_kimi_model("kimi-k2.4"));
    }

    #[test]
    fn uses_max_completion_tokens_for_openai_reasoning_chat_completions() {
        let mut config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-5.5".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };

        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
            "stream": true,
        });
        set_chat_completion_token_limit(&mut body, &config, 1024);

        assert_eq!(body.get("max_completion_tokens"), Some(&serde_json::json!(1024)));
        assert!(body.get("max_tokens").is_none());

        config.model = "gpt-4o".to_string();
        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
            "stream": true,
        });
        set_chat_completion_token_limit(&mut body, &config, 1024);

        assert_eq!(body.get("max_tokens"), Some(&serde_json::json!(1024)));
        assert!(body.get("max_completion_tokens").is_none());

        config.endpoint = "http://localhost:11434/v1".to_string();
        config.model = "gpt-5-proxy".to_string();
        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
            "stream": true,
        });
        set_chat_completion_token_limit(&mut body, &config, 1024);

        assert_eq!(body.get("max_completion_tokens"), Some(&serde_json::json!(1024)));
        assert!(body.get("max_tokens").is_none());

        config.provider = AiProvider::OpenaiCompatible;
        config.endpoint = "http://localhost:11434/v1".to_string();
        config.model = "gpt-5-local".to_string();
        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
            "stream": true,
        });
        set_chat_completion_token_limit(&mut body, &config, 1024);

        assert_eq!(body.get("max_tokens"), Some(&serde_json::json!(1024)));
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn parses_claude_effort_capability_object_in_strength_order() {
        let capability = parse_dynamic_effort_capability(
            &serde_json::json!({
                "capabilities": {
                    "effort": {
                        "max": { "supported": true },
                        "low": { "supported": true },
                        "medium": { "supported": false },
                        "high": { "supported": true },
                        "future": { "supported": true }
                    }
                }
            }),
            AiCapabilitySource::ProviderApi,
        )
        .unwrap();
        let AiEffortCapability::Enum { options, .. } = capability else {
            panic!("expected enum capability");
        };

        assert_eq!(
            options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>(),
            ["low", "high", "max", "future"]
        );
    }

    #[tokio::test]
    async fn claude_effort_capability_propagates_model_api_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before headers were complete");
                request.extend_from_slice(&chunk[..read]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /v1/models/claude-opus-4-6 "));

            let response_body = r#"{"error":{"message":"invalid x-api-key"}}"#;
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let endpoint = format!("http://{address}/v1/messages");
        let config = claude_http_test_request(endpoint).config;

        let error = resolve_model_effort_core(&config, "claude-opus-4-6").await.unwrap_err();

        assert_eq!(error, "invalid x-api-key");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn anthropic_compatible_lists_unknown_models_without_filtering() {
        let response_body = r#"{"data":[{"id":"vendor/future-model","display_name":"Future Model","capabilities":{"effort":{"low":{"supported":true},"high":{"supported":true}}}}]}"#;
        let (origin, server) = spawn_get_response_server("200 OK", response_body).await;
        let config = anthropic_compatible_test_request(format!("{origin}/v1/messages")).config;

        let models = list_models_core(&config).await.unwrap();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "vendor/future-model");
        assert_eq!(models[0].display_name.as_deref(), Some("Future Model"));
        assert!(matches!(
            models[0].effort_capability,
            Some(AiEffortCapability::FreeText { source: AiCapabilitySource::Custom, .. })
        ));
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /v1/models "));
        assert!(request.contains("authorization: bearer secret"));
    }

    #[tokio::test]
    async fn anthropic_compatible_model_list_paginates_and_deduplicates() {
        let (origin, server) = spawn_paginated_model_server().await;
        let config = anthropic_compatible_test_request(format!("{origin}/v1/messages")).config;

        let models = list_models_core(&config).await.unwrap();

        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            ["vendor/first", "vendor/shared", "vendor/second",]
        );
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /v1/models "));
        assert!(requests[1].starts_with("GET /v1/models?after_id=cursor-1 "));
    }

    #[tokio::test]
    async fn anthropic_compatible_model_list_uses_free_text_effort() {
        let response_body = r#"{"data":[{"id":"vendor/future-model","display_name":"Future Model"}]}"#;
        let (origin, server) = spawn_get_response_server("200 OK", response_body).await;
        let config = anthropic_compatible_test_request(format!("{origin}/v1/messages")).config;

        let models = list_models_core(&config).await.unwrap();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "vendor/future-model");
        assert!(matches!(
            models[0].effort_capability,
            Some(AiEffortCapability::FreeText { source: AiCapabilitySource::Custom, .. })
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn anthropic_compatible_reports_optional_model_discovery_as_unsupported() {
        let (origin, server) = spawn_get_response_server("404 Not Found", "<html>not found</html>").await;
        let mut config = anthropic_compatible_test_request(format!("{origin}/v1/messages")).config;
        config.model.clear();

        let error = test_connection_core(&config).await.unwrap_err();

        assert!(error.starts_with("[modelDiscoveryUnsupported]"));
        assert!(error.contains("/v1/models"));
        assert!(error.contains("enter a model ID manually"));
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /v1/models "));
    }

    #[tokio::test]
    async fn anthropic_compatible_effort_is_free_text_without_model_detail_request() {
        let config = anthropic_compatible_test_request("http://127.0.0.1:1/v1/messages".to_string()).config;

        let capability = resolve_model_effort_core(&config, "vendor/model").await.unwrap();

        assert!(matches!(capability, AiEffortCapability::FreeText { source: AiCapabilitySource::Custom, .. }));
    }

    #[test]
    fn omits_extra_body_for_kimi_test_connection_body() {
        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.moonshot.cn/v1".to_string(),
            model: "kimi-k2.5".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
            "max_tokens": 16,
            "stream": true,
        });

        apply_chat_completion_thinking_toggle(&mut body, &config);

        assert!(body.get("extra_body").is_none());
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn omits_thinking_toggle_for_openai_requests() {
        let mut config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-5".to_string(),
            models: vec![],
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let mut body = serde_json::json!({ "model": &config.model });

        apply_chat_completion_thinking_toggle(&mut body, &config);

        assert!(body.get("extra_body").is_none());
        assert!(body.get("reasoning_effort").is_none());

        // Provider identity preserves OpenAI semantics when requests use a custom gateway.
        config.endpoint = "https://gateway.example.com/v1/chat/completions".to_string();
        apply_chat_completion_thinking_toggle(&mut body, &config);
        assert!(body.get("extra_body").is_none());

        // The official endpoint must also stay strict if a legacy config has a compatible provider value.
        config.provider = AiProvider::OpenaiCompatible;
        config.endpoint = "https://api.openai.com/v1/chat/completions".to_string();
        apply_chat_completion_thinking_toggle(&mut body, &config);
        assert!(body.get("extra_body").is_none());
    }

    #[test]
    fn keeps_extra_body_thinking_toggle_for_other_compatible_providers() {
        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://example.com/v1".to_string(),
            model: "qwen3".to_string(),
            models: vec![],
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let mut body = serde_json::json!({ "model": &config.model });

        apply_chat_completion_thinking_toggle(&mut body, &config);

        assert_eq!(
            body.get("extra_body"),
            Some(&serde_json::json!({
                "chat_template_kwargs": { "enable_thinking": false }
            }))
        );
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn runtime_provider_default_suppresses_legacy_thinking_toggle() {
        let mut config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://example.com/v1".to_string(),
            model: "qwen3".to_string(),
            models: vec![],
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::High,
            runtime_effort: Some(AiEffortSelection::ProviderDefault),
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let mut body = serde_json::json!({ "model": &config.model });

        apply_chat_completion_thinking_toggle(&mut body, &config);

        assert!(body.get("extra_body").is_none());
        assert!(body.get("reasoning_effort").is_none());

        config.runtime_effort = None;
        apply_chat_completion_thinking_toggle(&mut body, &config);
        assert!(body.get("extra_body").is_some());
    }

    #[tokio::test]
    async fn openai_tool_stream_finishes_without_done_marker_after_finish_reason() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let payload =
                concat!("data: {\"choices\":[{\"delta\":{\"content\":\"done\"},", "\"finish_reason\":\"stop\"}]}\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n{:X}\r\n{}\r\n",
                payload.len(),
                payload
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            let keep_alive = ": keep-alive\n\n";
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let chunk = format!("{:X}\r\n{}\r\n", keep_alive.len(), keep_alive);
                if socket.write_all(chunk.as_bytes()).await.is_err() {
                    break;
                }
                if socket.flush().await.is_err() {
                    break;
                }
            }
        });

        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "lm-studio".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: format!("http://{address}/v1"),
            model: "local-model".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let request = AiCompletionRequest {
            config: config.clone(),
            system_prompt: "Use tools when needed.".to_string(),
            messages: vec![AiMessage {
                role: "tool".to_string(),
                content: "query failed".to_string(),
                tool_call_id: Some("call-1".to_string()),
                tool_calls: Vec::new(),
            }],
            task_contract: None,
            max_tokens: Some(64),
        };
        let client = build_ai_http_client(&config, 10).unwrap();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            stream_openai_with_tools(&client, "lm-studio-test", &request, &[], &Notify::new(), &move |event| {
                captured.lock().unwrap().push(event);
            }),
        )
        .await
        .expect("stream should finish after the finish_reason grace period");

        assert!(result.is_ok());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, StreamToolEvent::Chunk(chunk) if chunk.delta == "done")));
        server.abort();
    }

    #[test]
    fn uses_reasoning_effort_to_disable_ollama_thinking() {
        let config = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "http://localhost:11434/v1".to_string(),
            model: "deepseek-r1:14b".to_string(),
            models: vec![],
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: Default::default(),
        };
        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
        });

        apply_chat_completion_thinking_toggle(&mut body, &config);

        assert_eq!(body.get("reasoning_effort"), Some(&serde_json::json!("none")));
        assert!(body.get("extra_body").is_none());
    }

    #[test]
    fn parses_responses_text_from_current_and_nested_shapes() {
        assert_eq!(
            responses_text(&serde_json::json!({
                "output_text": "SELECT 1;"
            })),
            "SELECT 1;"
        );

        assert_eq!(
            responses_text(&serde_json::json!({
                "output": [{
                    "content": [{ "type": "output_text", "text": "SELECT 2;" }]
                }]
            })),
            "SELECT 2;"
        );
    }

    #[test]
    fn parses_openai_compatible_proxy_response_shapes() {
        assert_eq!(
            openai_response_text(&serde_json::json!({
                "choices": [{
                    "message": {
                        "content": [
                            { "type": "text", "text": "SELECT " },
                            { "type": "text", "text": "1;" }
                        ]
                    }
                }]
            })),
            "SELECT 1;"
        );

        assert_eq!(
            openai_stream_text(&serde_json::json!({
                "type": "response.output_text.delta",
                "delta": "SELECT 2;"
            }))
            .as_deref(),
            Some("SELECT 2;")
        );
    }

    #[test]
    fn parses_ollama_openai_reasoning_stream_chunks() {
        assert_eq!(
            openai_stream_reasoning(&serde_json::json!({
                "choices": [{ "delta": { "reasoning": "thinking..." } }]
            })),
            Some("thinking...")
        );
        assert_eq!(
            openai_stream_reasoning(&serde_json::json!({
                "choices": [{ "delta": { "thinking": "planning..." } }]
            })),
            Some("planning...")
        );
    }

    #[test]
    fn parses_gemini_text_and_provider_aliases() {
        let data = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "SELECT " },
                        { "text": "1;" }
                    ]
                }
            }]
        });

        assert_eq!(gemini_text(&data), "SELECT 1;");

        let claude: AiConfig = serde_json::from_value(serde_json::json!({
            "provider": "anthropic",
            "apiKey": "key",
            "endpoint": "https://api.anthropic.com/v1/messages",
            "model": "claude-sonnet-4-20250514"
        }))
        .unwrap();

        assert!(matches!(claude.provider, AiProvider::Claude));
    }

    #[test]
    fn serializes_integer_effort_special_values_in_camel_case() {
        let capability = AiEffortCapability::Integer {
            min: 128,
            max: 32_768,
            step: 1,
            default: AiEffortSelection::Integer(-1),
            special_values: vec![AiEffortOption {
                id: "auto".to_string(),
                label: "Auto".to_string(),
                description: None,
                selection: AiEffortSelection::Integer(-1),
            }],
            source: AiCapabilitySource::OfficialRegistry,
        };

        let value = serde_json::to_value(&capability).unwrap();
        assert!(value.get("specialValues").is_some());
        assert!(value.get("special_values").is_none());
        assert_eq!(serde_json::from_value::<AiEffortCapability>(value).unwrap(), capability);
    }

    // ------------------------------------------------------------------
    // with_retry / with_stream_retry unit tests
    // ------------------------------------------------------------------

    fn retry_config(max_retries: Option<u32>) -> AiConfig {
        serde_json::from_value(serde_json::json!({
            "provider": "openai",
            "model": "gpt-4",
            "maxRetries": max_retries,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn retry_succeeds_on_first_attempt() {
        let cfg = retry_config(Some(2));
        let result = with_retry(&cfg, || async { Ok::<&str, String>("ok") }).await;
        assert_eq!(result, Ok("ok"));
    }

    #[tokio::test]
    async fn retry_succeeds_after_transient_error() {
        let cfg = retry_config(Some(2));
        let mut calls = 0;
        let result = with_retry(&cfg, || {
            calls += 1;
            async move {
                if calls == 1 {
                    Err("rate limit exceeded (429)".to_string())
                } else {
                    Ok::<&str, String>("recovered")
                }
            }
        })
        .await;
        assert_eq!(result, Ok("recovered"));
        assert_eq!(calls, 2);
    }

    #[tokio::test]
    async fn retry_exhausts_and_returns_last_error() {
        let cfg = retry_config(Some(1)); // max 1 → 2 attempts total
        let result = with_retry(&cfg, || async { Err::<(), _>("gateway timeout (504)".to_string()) }).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("504"));
    }

    #[tokio::test]
    async fn retry_zero_means_no_retry() {
        let cfg = retry_config(Some(0));
        let mut calls = 0;
        let result = with_retry(&cfg, || {
            calls += 1;
            async move { Err::<(), _>("rate limit exceeded (429)".to_string()) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls, 1, "maxRetries=0 should not retry");
    }

    #[tokio::test]
    async fn retry_stops_on_non_retryable_error() {
        let cfg = retry_config(Some(3));
        let mut calls = 0;
        let result = with_retry(&cfg, || {
            calls += 1;
            async move { Err::<(), _>("unauthorized (401)".to_string()) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls, 1, "auth errors are not retryable");
    }

    #[tokio::test]
    async fn retry_honours_retry_after_from_error() {
        // Verify that a [retry-after:N] tag in the error forces the delay
        // to be at least N seconds.  We use a tight timing assertion: the
        // sleep call inside with_retry must take ≥ 1 second when the error
        // carries [retry-after:1].
        let cfg = retry_config(Some(2));
        let start = std::time::Instant::now();
        let mut calls = 0;
        let result = with_retry(&cfg, || {
            calls += 1;
            async move {
                if calls == 1 {
                    Err("[retry-after:1]rate limit exceeded (429)".to_string())
                } else {
                    Ok::<&str, String>("ok")
                }
            }
        })
        .await;
        let elapsed = start.elapsed();
        assert_eq!(result, Ok("ok"));
        assert_eq!(calls, 2);
        assert!(elapsed.as_millis() >= 800, "expected ≥1s Retry-After delay, got {}ms", elapsed.as_millis());
    }

    #[tokio::test]
    async fn stream_retry_succeeds_on_first_attempt() {
        let cfg = retry_config(Some(2));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result = with_stream_retry(&cfg, &emitted, None, || async { Ok::<&str, String>("ok") }).await;
        assert_eq!(result, Ok("ok"));
    }

    #[tokio::test]
    async fn stream_retry_does_not_retry_after_content_emitted() {
        let cfg = retry_config(Some(3));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)); // content already out
        let mut calls = 0;
        let result = with_stream_retry(&cfg, &emitted, None, || {
            calls += 1;
            async move { Err::<(), _>("rate limit exceeded (429)".to_string()) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls, 1, "should not retry once content has been emitted");
    }

    #[tokio::test]
    async fn stream_retry_retries_before_content_emitted() {
        let cfg = retry_config(Some(2));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut calls = 0;
        let result = with_stream_retry(&cfg, &emitted, None, || {
            calls += 1;
            async move {
                if calls == 1 {
                    Err("gateway timeout (504)".to_string())
                } else {
                    Ok::<&str, String>("recovered")
                }
            }
        })
        .await;
        assert_eq!(result, Ok("recovered"));
        assert_eq!(calls, 2);
    }

    #[tokio::test]
    async fn stream_retry_cancels_during_backoff() {
        let cfg = retry_config(Some(2));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel = tokio::sync::Notify::new();

        // Cancel immediately — the retry loop should notice during its first
        // back-off sleep and return the cancellation error.
        cancel.notify_one();

        let mut calls = 0;
        let result = with_stream_retry(&cfg, &emitted, Some(&cancel), || {
            calls += 1;
            async move {
                if calls == 1 {
                    Err("rate limit exceeded (429)".to_string())
                } else {
                    Ok::<&str, String>("never")
                }
            }
        })
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(calls, 1);
    }

    // ------------------------------------------------------------------
    // Retry-After / classify_error helpers
    // ------------------------------------------------------------------

    #[test]
    fn test_parse_retry_after_from_error() {
        assert_eq!(parse_retry_after("[retry-after:5]rate limit exceeded"), Some(std::time::Duration::from_secs(5)));
        assert_eq!(parse_retry_after("[retry-after:120]gateway timeout"), Some(std::time::Duration::from_secs(120)));
        assert_eq!(parse_retry_after("rate limit exceeded"), None);
        assert_eq!(parse_retry_after("[retry-after:abc]error"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    #[test]
    fn test_retry_after_secs_from_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after_secs(&headers), None);

        headers.insert(reqwest::header::RETRY_AFTER, reqwest::header::HeaderValue::from_static("42"));
        assert_eq!(retry_after_secs(&headers), Some(42));

        let now = std::time::UNIX_EPOCH
            + std::time::Duration::from_secs(1_700_000_000)
            + std::time::Duration::from_millis(250);
        let future = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_001);
        assert_eq!(parse_retry_after_secs(&httpdate::fmt_http_date(future), now), Some(1));

        let past = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_699_999_999);
        assert_eq!(parse_retry_after_secs(&httpdate::fmt_http_date(past), now), Some(0));
        assert_eq!(parse_retry_after_secs("not-a-number", now), None);
    }

    #[test]
    fn test_maybe_tag_retry_after() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(maybe_tag_retry_after(&headers, "err".to_string()), "err");

        headers.insert(reqwest::header::RETRY_AFTER, reqwest::header::HeaderValue::from_static("30"));
        assert_eq!(maybe_tag_retry_after(&headers, "err".to_string()), "[retry-after:30]err");
    }

    #[test]
    fn test_is_retryable_error_covers_all_categories() {
        assert!(is_retryable_error("rate limit exceeded (429)"));
        assert!(is_retryable_error("gateway timeout (504)"));
        assert!(is_retryable_error("connection refused"));
        assert!(is_retryable_error("response body was empty"));
        assert!(!is_retryable_error("unauthorized (401)"));
        assert!(!is_retryable_error("model not found (404)"));
        assert!(!is_retryable_error("safety filter blocked"));
        assert!(!is_retryable_error("finishReason=MAX_TOKENS"));
    }

    /// `stream_error` embeds `HTTP <status>` in the diagnostic; verify that
    /// classification works on the patterns it produces, including the
    /// empty-body / non-JSON case that was previously classified as `unknown`.
    #[test]
    fn test_classify_error_from_stream_error_diagnostic() {
        // JSON parse succeeded, server error text included.
        assert_eq!(classify_error("HTTP 429: rate limit exceeded"), "rateLimit");
        assert_eq!(classify_error("HTTP 504: gateway timeout"), "timeout");
        assert_eq!(classify_error("HTTP 503: service unavailable"), "network");
        assert_eq!(classify_error("HTTP 502: bad gateway"), "network");
        // Empty body — the regression case: a bare 429 with no JSON payload.
        assert_eq!(classify_error("HTTP 429: empty response body"), "rateLimit");
        // Non-JSON body that still contains a rate-limit keyword.
        assert_eq!(classify_error("HTTP 429: <html>Too Many Requests</html>"), "rateLimit");
        // Auth failures must NOT be retryable.
        assert_eq!(classify_error("HTTP 401: unauthorized"), "auth");
        assert_eq!(classify_error("HTTP 403: forbidden"), "auth");
        assert!(!is_retryable_error("[auth] Claude API error (HTTP 401: unauthorized)"));
        assert!(!is_retryable_error("[auth] Claude API error (HTTP 403: forbidden)"));
    }

    // ------------------------------------------------------------------
    // stream_error integration tests (real reqwest::Response)
    // ------------------------------------------------------------------

    /// Send a real HTTP request against a local server returning a specific
    /// error status, then run the response through `stream_error` and verify
    /// the output format, classification, and Retry-After encoding.
    async fn call_stream_error(
        status: u16,
        reason: &'static str,
        body: &'static str,
        retry_after_secs: Option<u64>,
    ) -> String {
        let (url, _server) = spawn_error_server_with_body(status, reason, body, retry_after_secs).await;
        let resp = reqwest::Client::new()
            .post(&url)
            .json(&serde_json::json!({"model": "test"}))
            .send()
            .await
            .expect("request to test server failed");
        stream_error(resp, "TestProvider").await
    }

    #[tokio::test]
    async fn stream_error_empty_body_429_is_retryable() {
        let err = call_stream_error(429, "Too Many Requests", "", None).await;
        // Expected format: [{classify}] {fallback} API error (HTTP {status}: {detail})
        assert!(err.contains("[rateLimit]"), "429 with empty body should classify as rateLimit, got: {err}");
        assert!(err.contains("HTTP 429: empty response body"), "got: {err}");
        assert!(is_retryable_error(&err), "stream_error 429 must be retryable, got: {err}");
    }

    #[tokio::test]
    async fn stream_error_empty_body_429_triggers_retry() {
        let (url, _server) = spawn_error_server_with_body(429, "Too Many Requests", "", None).await;

        let cfg = retry_config(Some(2));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut calls = 0;

        let result = with_stream_retry(&cfg, &emitted, None, || {
            calls += 1;
            let url = url.clone();
            async move {
                if calls == 1 {
                    let resp = reqwest::Client::new()
                        .post(&url)
                        .json(&serde_json::json!({"model": "test"}))
                        .send()
                        .await
                        .expect("request failed");
                    Err(stream_error(resp, "TestProvider").await)
                } else {
                    Ok::<(), String>(())
                }
            }
        })
        .await;
        assert!(result.is_ok(), "should retry after stream_error 429, got: {result:?}");
        assert_eq!(calls, 2);
    }

    #[tokio::test]
    async fn stream_error_preserves_retry_after_from_headers() {
        let err = call_stream_error(429, "Too Many Requests", r#"{"error":{"message":"rate limit"}}"#, Some(5)).await;
        // The Retry-After: 5 header should be encoded as [retry-after:5] prefix.
        assert!(err.starts_with("[retry-after:5]"), "Retry-After should be prepended, got: {err}");
        assert!(err.contains("[rateLimit]"), "got: {err}");
        assert!(err.contains("rate limit"), "should include original error detail, got: {err}");
    }

    #[tokio::test]
    async fn stream_error_retry_after_extends_backoff() {
        // If the response says Retry-After: 1, the first retry must wait ≥ 800ms
        // (after jitter) rather than the default 500ms.
        let (url, _server) =
            spawn_error_server_with_body(429, "Too Many Requests", r#"{"error":{"message":"rate limit"}}"#, Some(1))
                .await;

        let cfg = retry_config(Some(2));
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let start = std::time::Instant::now();
        let mut calls = 0;

        let result = with_stream_retry(&cfg, &emitted, None, || {
            calls += 1;
            let url = url.clone();
            async move {
                if calls == 1 {
                    let resp = reqwest::Client::new()
                        .post(&url)
                        .json(&serde_json::json!({"model": "test"}))
                        .send()
                        .await
                        .expect("request failed");
                    Err(stream_error(resp, "TestProvider").await)
                } else {
                    Ok::<(), String>(())
                }
            }
        })
        .await;
        let elapsed = start.elapsed();
        assert!(result.is_ok());
        assert_eq!(calls, 2);
        assert!(elapsed.as_millis() >= 800, "Retry-After: 1 should force ≥1s delay, got {}ms", elapsed.as_millis());
    }

    #[tokio::test]
    async fn stream_error_non_json_429_body_is_retryable() {
        // Some proxies return HTML or plain text for 429.
        let err = call_stream_error(429, "Too Many Requests", "<html>Too Many Requests</html>", None).await;
        assert!(
            err.contains("[rateLimit]"),
            "non-JSON body containing 'rate' keyword should classify as rateLimit, got: {err}"
        );
        assert!(err.contains("<html>"), "raw body should be preserved in detail, got: {err}");
        assert!(is_retryable_error(&err));
    }

    #[tokio::test]
    async fn stream_error_401_is_not_retryable() {
        let err = call_stream_error(401, "Unauthorized", r#"{"error":{"message":"invalid api key"}}"#, None).await;
        assert!(err.contains("[auth]"), "got: {err}");
        assert!(err.contains("HTTP 401"), "got: {err}");
        assert!(!is_retryable_error(&err), "401 must not be retryable");
    }

    // ------------------------------------------------------------------
    // merge_global_max_retries unit tests
    // ------------------------------------------------------------------

    fn test_config(provider: AiProvider) -> AiConfig {
        serde_json::from_value(serde_json::json!({
            "provider": serde_json::to_string(&provider).unwrap().trim_matches('"'),
            "model": "test-model",
        }))
        .unwrap()
    }

    #[test]
    fn merge_global_max_retries_sets_for_api_providers() {
        for provider in &[
            AiProvider::Claude,
            AiProvider::AnthropicCompatible,
            AiProvider::Openai,
            AiProvider::OpenaiCompatible,
            AiProvider::Custom,
            AiProvider::Gemini,
            AiProvider::Deepseek,
            AiProvider::Qwen,
            AiProvider::Ollama,
        ] {
            let mut config = test_config(provider.clone());
            config.max_retries = None;
            merge_global_max_retries(&mut config, 3);
            assert_eq!(config.max_retries, Some(3), "merge should set max_retries for {provider:?}");
        }
    }

    #[test]
    fn merge_global_max_retries_skips_cli_providers() {
        for provider in [AiProvider::CodexCli, AiProvider::ClaudeCodeCli, AiProvider::PiAgentCli] {
            let mut config = test_config(provider.clone());
            config.max_retries = None;
            merge_global_max_retries(&mut config, 0);
            assert_eq!(config.max_retries, None, "merge must not touch CLI provider {provider:?}");
        }
    }

    // ------------------------------------------------------------------
    // End-to-end: max_retries=0 prevents retry even against a real server
    // ------------------------------------------------------------------

    /// Spawn a TCP server that returns 429 for every connection and counts them.
    /// Returns (url, count, handle).  Abort the handle after the test.
    async fn spawn_counting_429_server(
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicU32>, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/v1/messages");
        let count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let count2 = count.clone();

        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                count2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = vec![0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let resp = b"HTTP/1.1 429 Too Many Requests\r\n\
                    Content-Type: application/json\r\n\
                    Content-Length: 0\r\n\
                    Connection: close\r\n\r\n";
                let _ = socket.write_all(resp).await;
            }
        });

        (url, count, handle)
    }

    #[tokio::test]
    async fn test_connection_core_no_retry_when_max_retries_zero() {
        let (url, count, server) = spawn_counting_429_server().await;

        let mut config: AiConfig = serde_json::from_value(serde_json::json!({
            "provider": "claude",
            "apiKey": "sk-test",
            "model": "claude-sonnet-4",
            "endpoint": url,
        }))
        .unwrap();
        config.max_retries = Some(0);

        let result = test_connection_core(&config).await;
        assert!(result.is_err(), "429 should fail, got: {result:?}");

        server.abort();
        let requests = count.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(requests, 1, "max_retries=0 should mean exactly 1 request, got {requests}");
    }
}
