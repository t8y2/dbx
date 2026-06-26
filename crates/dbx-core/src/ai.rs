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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    #[serde(alias = "anthropic")]
    Claude,
    Openai,
    Gemini,
    Deepseek,
    Qwen,
    Ollama,
    #[serde(rename = "openai-compatible")]
    OpenaiCompatible,
    #[serde(rename = "codex-cli")]
    CodexCli,
    Custom,
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
}

impl AiReasoningLevel {
    pub fn as_codex_effort(&self) -> Option<&'static str> {
        match self {
            AiReasoningLevel::Default => None,
            AiReasoningLevel::Minimal => Some("minimal"),
            AiReasoningLevel::Low => Some("low"),
            AiReasoningLevel::Medium => Some("medium"),
            AiReasoningLevel::High => Some("high"),
        }
    }
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
    pub api_style: AiApiStyle,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default = "default_enable_thinking")]
    pub enable_thinking: bool,
    #[serde(default)]
    pub reasoning_level: AiReasoningLevel,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub codex_cli_path: Option<String>,
    #[serde(default)]
    pub codex_cli_env: HashMap<String, String>,
}

fn default_enable_thinking() -> bool {
    true
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
    pub temperature: Option<f32>,
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
        AiProvider::Claude | AiProvider::CodexCli | AiProvider::Gemini => unreachable!(),
    }
}

pub fn uses_anthropic_messages_api(config: &AiConfig) -> bool {
    matches!(config.provider, AiProvider::Claude)
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
        return Err("Model listing is only supported for OpenAI-compatible and Claude providers".to_string());
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

pub fn responses_stream_text(event: &serde_json::Value) -> Option<&str> {
    event["delta"].as_str().filter(|s| !s.is_empty())
}

fn responses_max_output_tokens(max_tokens: Option<u32>) -> u32 {
    max_tokens.unwrap_or(2048).max(16)
}

fn is_openai_api_config(config: &AiConfig) -> bool {
    matches!(config.provider, AiProvider::Openai) || config.endpoint.to_ascii_lowercase().contains("api.openai.com")
}

fn is_openai_reasoning_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model.starts_with("gpt-5") || model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4")
}

/// Kimi K2.5+ models (including K2.7-Code) require fixed sampling parameters:
/// temperature=1.0, top_p=0.95, n=1. Any other value returns an error.
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

pub fn supports_temperature(config: &AiConfig) -> bool {
    !(is_kimi_model(&config.model) || is_openai_api_config(config) && is_openai_reasoning_model(&config.model))
}

fn add_temperature_if_supported_for_config(body: &mut serde_json::Value, config: &AiConfig, temperature: Option<f32>) {
    if supports_temperature(config) {
        body["temperature"] = temperature_value(temperature);
    }
}

pub fn add_temperature_if_supported(body: &mut serde_json::Value, request: &AiCompletionRequest) {
    add_temperature_if_supported_for_config(body, &request.config, request.temperature);
}

fn temperature_value(temperature: Option<f32>) -> serde_json::Value {
    let value = ((temperature.unwrap_or(0.2) as f64) * 100.0).round() / 100.0;
    json!(value)
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

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

fn validate_config(config: &AiConfig) -> Result<(), String> {
    if matches!(config.provider, AiProvider::CodexCli) {
        return Ok(());
    }
    if !matches!(config.provider, AiProvider::Ollama) && config.api_key.trim().is_empty() {
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
    if matches!(config.provider, AiProvider::CodexCli) {
        return Ok(());
    }
    if !matches!(config.provider, AiProvider::Ollama) && config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    resolve_model_list_endpoint(config).map(|_| ())
}

pub fn maybe_bearer_headers(config: &AiConfig) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !config.api_key.trim().is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key)).map_err(|e| e.to_string())?,
        );
    }
    Ok(headers)
}

pub fn claude_headers(config: &AiConfig) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    match config.auth_method {
        AiAuthMethod::Bearer => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", config.api_key)).map_err(|e| e.to_string())?,
            );
        }
        AiAuthMethod::ApiKey => {
            headers.insert("x-api-key", HeaderValue::from_str(&config.api_key).map_err(|e| e.to_string())?);
        }
    }
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    Ok(headers)
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

        models.push(AiModelInfo { id: id.to_string(), display_name });
    }

    Ok(models)
}

async fn list_claude_models(client: &reqwest::Client, config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let res = client
        .get(resolve_model_list_endpoint(config)?)
        .headers(claude_headers(config)?)
        .send()
        .await
        .map_err(|e| format!("Claude model list request failed: {e}"))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&data).unwrap_or_else(|| format!("Claude model list API error: {status}")));
    }

    parse_model_list_response(&data)
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

pub async fn list_models_core(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    if matches!(config.provider, AiProvider::CodexCli) {
        return crate::ai_codex_cli::list_codex_models(config).await;
    }
    validate_model_list_config(config)?;

    let client = build_ai_http_client(config, 30)?;

    match config.provider {
        AiProvider::Claude => list_claude_models(&client, config).await,
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible => list_openai_compatible_models(&client, config).await,
        AiProvider::Custom => {
            if uses_anthropic_messages_api(config) {
                list_claude_models(&client, config).await
            } else {
                list_openai_compatible_models(&client, config).await
            }
        }
        AiProvider::CodexCli => unreachable!(),
        AiProvider::Gemini => {
            Err("Model listing is only supported for OpenAI-compatible and Claude providers".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Non-streaming calls
// ---------------------------------------------------------------------------

pub async fn call_claude(client: &reqwest::Client, request: AiCompletionRequest) -> Result<String, String> {
    let body = json!({
        "model": request.config.model,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "temperature": temperature_value(request.temperature),
        "system": claude_system_prompt(&request.system_prompt),
        "messages": request.messages,
    });

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
        "max_tokens": request.max_tokens.unwrap_or(2048),
    });
    add_temperature_if_supported(&mut body_obj, &request);
    if !request.config.enable_thinking && !is_kimi_model(&request.config.model) {
        body_obj["extra_body"] = json!({
            "chat_template_kwargs": { "enable_thinking": false }
        });
    }

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
    add_temperature_if_supported(&mut body, &request);

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

    let body = json!({
        "systemInstruction": {
            "parts": [{ "text": request.system_prompt }],
        },
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": request.max_tokens.unwrap_or(2048),
            "temperature": temperature_value(request.temperature),
        },
    });

    let res = client
        .post(resolve_endpoint(&request.config))
        .query(&[("key", request.config.api_key.as_str())])
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    let status = res.status();
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
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
async fn measure_first_stream_chunk(
    mut byte_stream: impl futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
    start: std::time::Instant,
    is_claude: bool,
    is_gemini: bool,
) -> Result<(u64, String), String> {
    let mut buf = String::new();
    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].to_string();
            buf = buf[pos + 1..].to_string();

            let Some(data) = stream_data_payload(&line) else { continue };
            if data == "[DONE]" {
                // stream finished without content — not a real failure but rare
                return Err("no content in response".to_string());
            }

            // Parse the JSON to extract the text delta
            let parsed: serde_json::Value = serde_json::from_str(data).map_err(|e| format!("JSON parse error: {e}"))?;

            let delta = if is_claude {
                // Accept both text and thinking deltas — thinking is often the first
                // streamed content when extended thinking is enabled.
                claude_stream_text(&parsed).or_else(|| parsed["delta"]["thinking"].as_str()).map(|s| s.to_string())
            } else if is_gemini {
                let text = gemini_text(&parsed);
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            } else {
                // Accept text, reasoning, or responses content as the first chunk.
                openai_stream_text(&parsed)
                    .or_else(|| openai_stream_reasoning(&parsed).map(|s| s.to_string()))
                    .or_else(|| Some(responses_text(&parsed)))
            };

            if let Some(text) = delta {
                if !text.trim().is_empty() {
                    let latency = start.elapsed().as_millis() as u64;
                    return Ok((latency, text));
                }
            }
        }
    }
    Err("stream ended without content".to_string())
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
    validate_config(config)?;

    let client = build_ai_http_client(config, 15)?;
    let start = std::time::Instant::now();

    let is_claude = uses_anthropic_messages_api(config);
    let is_gemini = matches!(config.provider, AiProvider::Gemini);
    let model = config.model.clone();

    // Build the streaming request and get the byte stream
    let byte_stream = match config.provider {
        AiProvider::Claude => {
            let body = json!({
                "model": &model,
                "max_tokens": 16,
                "temperature": temperature_value(Some(0.0)),
                "system": CLAUDE_DEFAULT_SYSTEM,
                "messages": [{ "role": "user", "content": TEST_PROMPT }],
                "stream": true,
            });
            let res = client
                .post(resolve_endpoint(config))
                .headers(claude_headers(config)?)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Claude request failed: {e}"))?;
            if !res.status().is_success() {
                let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                return Err(categorize_error(&data, config));
            }
            res.bytes_stream()
        }
        AiProvider::Gemini => {
            let ep = resolve_endpoint(config);
            let res = client
                .post(&ep)
                .header(CONTENT_TYPE, "application/json")
                .query(&[("key", config.api_key.as_str()), ("alt", "sse")])
                .json(&json!({
                    "contents": [{ "parts": [{ "text": TEST_PROMPT }], "role": "user" }],
                    "generationConfig": { "maxOutputTokens": 16, "temperature": temperature_value(Some(0.0)) },
                }))
                .send()
                .await
                .map_err(|e| format!("Gemini request failed: {e}"))?;
            if !res.status().is_success() {
                let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                return Err(categorize_error(&data, config));
            }
            res.bytes_stream()
        }
        AiProvider::Custom if uses_anthropic_messages_api(config) => {
            let body = json!({
                "model": &model,
                "max_tokens": 16,
                "temperature": temperature_value(Some(0.0)),
                "system": CLAUDE_DEFAULT_SYSTEM,
                "messages": [{ "role": "user", "content": TEST_PROMPT }],
                "stream": true,
            });
            let res = client
                .post(resolve_endpoint(config))
                .headers(claude_headers(config)?)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Claude request failed: {e}"))?;
            if !res.status().is_success() {
                let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                return Err(categorize_error(&data, config));
            }
            res.bytes_stream()
        }
        _ => {
            // OpenAI-compatible providers
            let messages = vec![json!({ "role": "user", "content": TEST_PROMPT })];
            let mut body_obj = json!({
                "model": &model,
                "messages": messages,
                "max_tokens": 16,
                "stream": true,
            });
            add_temperature_if_supported_for_config(&mut body_obj, config, Some(0.0));
            if !config.enable_thinking && !is_kimi_model(&config.model) {
                body_obj["extra_body"] = json!({
                    "chat_template_kwargs": { "enable_thinking": false }
                });
            }
            let ep = resolve_endpoint(config);
            let res = client
                .post(&ep)
                .headers(maybe_bearer_headers(config)?)
                .json(&body_obj)
                .send()
                .await
                .map_err(|e| format!("AI request failed: {e}"))?;
            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                // Try JSON first (APIs like OpenAI return structured error bodies)
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) {
                    let raw = extract_error(&data).unwrap_or_else(|| "API error".to_string());
                    return Err(format!("[{}] {}", classify_error(&raw), raw));
                }
                // Non-JSON body — show HTTP status + raw body
                let msg = if body.trim().is_empty() {
                    format!("HTTP {}", status)
                } else {
                    format!("HTTP {}: {}", status, body.trim())
                };
                return Err(format!("[{}] {}", classify_error(&msg), msg));
            }
            res.bytes_stream()
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
            Err(format!("[{category}] {e}"))
        }
    }
}

/// Map known API error bodies to a short category string.
fn categorize_error(data: &serde_json::Value, _config: &AiConfig) -> String {
    let raw = extract_error(data).unwrap_or_else(|| "API error".to_string());
    let category = classify_error(&raw);
    format!("[{category}] {raw}")
}

fn classify_error(msg: &str) -> &'static str {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || lower.contains("incorrect api key")
    {
        "auth"
    } else if lower.contains("404") || lower.contains("not found") || lower.contains("model not found") {
        "modelNotFound"
    } else if lower.contains("429") || lower.contains("rate limit") || lower.contains("too many requests") {
        "rateLimit"
    } else if lower.contains("timeout") || lower.contains("timed out") || lower.contains("504") {
        "timeout"
    } else if lower.contains("connect")
        || lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("502")
        || lower.contains("503")
    {
        "network"
    } else {
        "unknown"
    }
}

pub async fn complete(request: &AiCompletionRequest) -> Result<String, String> {
    validate_config(&request.config)?;

    if matches!(request.config.provider, AiProvider::CodexCli) {
        return Err("Codex CLI provider is only supported in DBX AI agent mode".to_string());
    }

    let client = build_ai_http_client(&request.config, 60)?;

    match request.config.provider {
        AiProvider::Claude => call_claude(&client, request.clone()).await,
        AiProvider::Gemini => call_gemini(&client, request.clone()).await,
        AiProvider::CodexCli => unreachable!(),
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible => {
            if request.config.api_style == AiApiStyle::Responses {
                call_responses_api(&client, request.clone()).await
            } else {
                call_openai_compatible(&client, request.clone()).await
            }
        }
        AiProvider::Custom => {
            if uses_anthropic_messages_api(&request.config) {
                call_claude(&client, request.clone()).await
            } else if request.config.api_style == AiApiStyle::Responses {
                call_responses_api(&client, request.clone()).await
            } else {
                call_openai_compatible(&client, request.clone()).await
            }
        }
    }
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

    if matches!(request.config.provider, AiProvider::CodexCli) {
        return Err("Codex CLI provider is only supported in DBX AI agent mode".to_string());
    }

    let stream_timeout = if request.config.enable_thinking { 600 } else { 120 };
    let client = build_ai_http_client(&request.config, stream_timeout)?;

    match request.config.provider {
        AiProvider::Claude => stream_claude(&client, session_id, request, cancelled, &on_chunk).await,
        AiProvider::Gemini => stream_gemini(&client, session_id, request, cancelled, &on_chunk).await,
        AiProvider::CodexCli => unreachable!(),
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
            if uses_anthropic_messages_api(&request.config) {
                stream_claude(&client, session_id, request, cancelled, &on_chunk).await
            } else if request.config.api_style == AiApiStyle::Responses {
                stream_responses_api(&client, session_id, request, cancelled, &on_chunk).await
            } else {
                stream_openai(&client, session_id, request, cancelled, &on_chunk).await
            }
        }
    }
}

async fn stream_claude(
    client: &reqwest::Client,
    session_id: &str,
    request: &AiCompletionRequest,
    cancelled: &Notify,
    on_chunk: &impl Fn(AiStreamChunk),
) -> Result<(), String> {
    let body = json!({
        "model": request.config.model,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "temperature": temperature_value(request.temperature),
        "system": claude_system_prompt(&request.system_prompt),
        "messages": request.messages,
        "stream": true,
    });

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(claude_headers(&request.config)?)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "Claude API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                let mut finished = false;
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

                    let Some(data) = stream_data_payload(&line) else { continue };
                    if data == "[DONE]" {
                        finished = true;
                        break;
                    }

                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(text) = claude_stream_text(&event) {
                            on_chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
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
        session_id: session_id.to_string(),
        delta: String::new(),
        reasoning_delta: None,
        done: true,
    });

    Ok(())
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
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "stream": true,
    });
    add_temperature_if_supported(&mut body_obj, request);
    if !request.config.enable_thinking && !is_kimi_model(&request.config.model) {
        body_obj["extra_body"] = json!({
            "chat_template_kwargs": { "enable_thinking": false }
        });
    }

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(headers)
        .json(&body_obj)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                let mut finished = false;
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

                    let Some(data) = stream_data_payload(&line) else { continue };
                    if data == "[DONE]" {
                        finished = true;
                        break;
                    }

                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(reasoning) = openai_stream_reasoning(&event) {
                            on_chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
                                delta: String::new(),
                                reasoning_delta: Some(reasoning.to_string()),
                                done: false,
                            });
                        }
                        if let Some(text) = openai_stream_text(&event) {
                            on_chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
                                delta: text,
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
        session_id: session_id.to_string(),
        delta: String::new(),
        reasoning_delta: None,
        done: true,
    });

    Ok(())
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
    add_temperature_if_supported(&mut body, request);

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                let mut finished = false;
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

                    let Some(data) = stream_data_payload(&line) else { continue };
                    if data == "[DONE]" {
                        finished = true;
                        break;
                    }

                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(text) = responses_stream_text(&event) {
                            on_chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
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
        session_id: session_id.to_string(),
        delta: String::new(),
        reasoning_delta: None,
        done: true,
    });

    Ok(())
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

    let body = json!({
        "systemInstruction": {
            "parts": [{ "text": request.system_prompt }],
        },
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": request.max_tokens.unwrap_or(2048),
            "temperature": temperature_value(request.temperature),
        },
    });

    let res = client
        .post(resolve_gemini_stream_endpoint(&request.config))
        .query(&[("key", request.config.api_key.as_str()), ("alt", "sse")])
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "Gemini API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

                    let Some(data) = stream_data_payload(&line) else { continue };
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                        let text = gemini_text(&event);
                        if !text.is_empty() {
                            on_chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
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
        session_id: session_id.to_string(),
        delta: String::new(),
        reasoning_delta: None,
        done: true,
    });

    Ok(())
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
    /// A tool_use / function_call block has ended.
    ToolCallComplete { index: u32 },
}

/// Partially accumulated tool call during streaming.
#[derive(Debug)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
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
                self.calls.insert(index, PartialToolCall { id, name, arguments: String::new() });
                if !self.ordered_indices.contains(&index) {
                    self.ordered_indices.push(index);
                }
            }
            StreamToolEvent::ToolCallDelta { index, fragment } => {
                if let Some(tc) = self.calls.get_mut(&index) {
                    tc.arguments.push_str(&fragment);
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
        "model": request.config.model,
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "system": claude_system_prompt(&request.system_prompt),
        "messages": messages,
        "tools": tool_json,
        "stream": true,
    });
    add_temperature_if_supported(&mut body, request);

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(claude_headers(&request.config)?)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "Claude API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();
    // Track the current content block index and type for tool_use blocks
    let mut current_block_index: Option<u32> = None;
    let mut current_block_type: Option<String> = None;
    let mut token_usage: Option<TokenUsage> = None;

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                let mut finished = false;
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

                    let Some(data) = stream_data_payload(&line) else { continue };
                    if data == "[DONE]" {
                        finished = true;
                        break;
                    }

                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
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
                                    on_event(StreamToolEvent::ToolCallStart { index: idx, id, name });
                                }
                            }
                            "content_block_delta" => {
                                let idx = event["index"].as_u64().unwrap_or(0) as u32;
                                let delta_type = event["delta"]["type"].as_str().unwrap_or("");

                                match delta_type {
                                    "text_delta" => {
                                        if let Some(text) = event["delta"]["text"].as_str() {
                                            on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                                session_id: session_id.to_string(),
                                                delta: text.to_string(),
                                                reasoning_delta: None,
                                                done: false,
                                            }));
                                        }
                                    }
                                    "thinking_delta" => {
                                        if let Some(thinking) = event["delta"]["thinking"].as_str() {
                                            on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                                session_id: session_id.to_string(),
                                                delta: String::new(),
                                                reasoning_delta: Some(thinking.to_string()),
                                                done: false,
                                            }));
                                        }
                                    }
                                    "input_json_delta" => {
                                        if let Some(fragment) = event["delta"]["partial_json"].as_str() {
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
            _ = cancelled.notified() => { break; }
        }
    }

    Ok(token_usage)
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
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "tools": tool_json,
        "tool_choice": "auto",
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    add_temperature_if_supported(&mut body, request);

    let res = client
        .post(resolve_endpoint(&request.config))
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();
    let mut token_usage: Option<TokenUsage> = None;

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                let mut finished = false;
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

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
                            on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
                                delta: String::new(),
                                reasoning_delta: Some(reasoning.to_string()),
                                done: false,
                            }));
                        }
                        // Text
                        if let Some(text) = openai_stream_text(&event) {
                            on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                session_id: session_id.to_string(),
                                delta: text,
                                reasoning_delta: None,
                                done: false,
                            }));
                        }
                        // Tool calls
                        if let Some(tool_calls) = event["choices"].get(0).and_then(|c| c["delta"]["tool_calls"].as_array()) {
                            for tc in tool_calls {
                                let idx = tc["index"].as_u64().unwrap_or(0) as u32;
                                // First chunk for this tool call has id and name
                                if let Some(id) = tc["id"].as_str() {
                                    let name = tc["function"]["name"].as_str().unwrap_or_default().to_string();
                                    on_event(StreamToolEvent::ToolCallStart { index: idx, id: id.to_string(), name });
                                }
                                // Argument fragments
                                if let Some(fragment) = tc["function"]["arguments"].as_str() {
                                    on_event(StreamToolEvent::ToolCallDelta { index: idx, fragment: fragment.to_string() });
                                }
                            }
                        }
                    }
                }

                if finished { break; }
            }
            _ = cancelled.notified() => { break; }
        }
    }

    Ok(token_usage)
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
    let mut contents: Vec<serde_json::Value> = Vec::new();
    let mut pending_function_responses: Vec<serde_json::Value> = Vec::new();
    for m in &request.messages {
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
                    parts.push(json!({ "functionCall": { "name": tc.name, "args": tc.arguments } }));
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

    let tool_declarations: Vec<serde_json::Value> = tools.iter().map(|t| t.to_gemini_tool()).collect();

    let body = json!({
        "contents": contents,
        "systemInstruction": { "parts": [{ "text": request.system_prompt }] },
        "tools": [{ "functionDeclarations": tool_declarations }],
        "generationConfig": {
            "maxOutputTokens": request.max_tokens.unwrap_or(4096),
        }
    });

    let res = client
        .post(resolve_gemini_stream_endpoint(&request.config))
        .query(&[("key", request.config.api_key.as_str()), ("alt", "sse")])
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "Gemini API error".to_string()));
    }

    let mut byte_stream = res.bytes_stream();
    let mut buf = String::new();
    let mut tool_call_idx: u32 = 0;
    let mut token_usage: Option<TokenUsage> = None;

    loop {
        tokio::select! {
            chunk = byte_stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buf.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].to_string();
                    buf = buf[pos + 1..].to_string();

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
                                        on_event(StreamToolEvent::Chunk(AiStreamChunk {
                                            session_id: session_id.to_string(),
                                            delta: text.to_string(),
                                            reasoning_delta: None,
                                            done: false,
                                        }));
                                    }
                                    // Function call (Gemini sends complete objects, not deltas)
                                    if let Some(fc) = part.get("functionCall") {
                                        let name = fc["name"].as_str().unwrap_or_default().to_string();
                                        let args = fc["args"].clone();
                                        let id = format!("gemini-tc-{name}-{tool_call_idx}");
                                        let args_str = args.to_string();
                                        on_event(StreamToolEvent::ToolCallStart {
                                            index: tool_call_idx,
                                            id: id.clone(),
                                            name: name.clone(),
                                        });
                                        on_event(StreamToolEvent::ToolCallDelta {
                                            index: tool_call_idx,
                                            fragment: args_str,
                                        });
                                        on_event(StreamToolEvent::ToolCallComplete { index: tool_call_idx });
                                        tool_call_idx += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ = cancelled.notified() => { break; }
        }
    }

    Ok(token_usage)
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

    let stream_timeout = if config.enable_thinking { 600 } else { 120 };
    let client = build_ai_http_client(config, stream_timeout)?;

    let accumulator = Arc::new(std::sync::Mutex::new(StreamingToolCallAccumulator::new()));

    let token_usage = match config.provider {
        AiProvider::Claude => {
            stream_claude_with_tools(&client, session_id, request, tools, cancelled, &|event| {
                accumulator.lock().unwrap().process(event, &on_chunk);
            })
            .await?
        }
        AiProvider::Gemini => {
            stream_gemini_with_tools(&client, session_id, request, tools, cancelled, &|event| {
                accumulator.lock().unwrap().process(event, &on_chunk);
            })
            .await?
        }
        AiProvider::Custom if uses_anthropic_messages_api(config) => {
            stream_claude_with_tools(&client, session_id, request, tools, cancelled, &|event| {
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
    use super::{
        add_temperature_if_supported_for_config, build_ai_http_client, claude_headers, claude_system_prompt,
        gemini_text, is_kimi_model, openai_response_text, openai_stream_reasoning, openai_stream_text,
        parse_model_list_response, resolve_endpoint, resolve_model_list_endpoint, responses_max_output_tokens,
        responses_text, supports_temperature, temperature_value, uses_anthropic_messages_api, validate_config,
        AiApiStyle, AiAuthMethod, AiConfig, AiModelInfo, AiProvider, AiReasoningLevel, AUTHORIZATION,
        CLAUDE_DEFAULT_SYSTEM, TEST_PROMPT,
    };

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
        assert!(config.codex_cli_env.is_empty());
    }

    #[test]
    fn ai_http_client_rejects_invalid_proxy_url() {
        let config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-4o".to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: true,
            proxy_url: "not a proxy url".to_string(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
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
            api_style: AiApiStyle::Completions,
            proxy_enabled: true,
            proxy_url: "127.0.0.1:7890".to_string(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
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
            api_style: AiApiStyle::Completions,
            proxy_enabled: true,
            proxy_url: "not a proxy url".to_string(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
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
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        };

        assert_eq!(
            resolve_endpoint(&gemini),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent"
        );

        let ollama = AiConfig {
            provider: AiProvider::Ollama,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "http://localhost:11434/v1".to_string(),
            model: "llama3.1".to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        };

        assert_eq!(resolve_endpoint(&ollama), "http://localhost:11434/v1/chat/completions");
        assert!(validate_config(&ollama).is_ok());
    }

    #[test]
    fn resolves_model_list_endpoints_from_base_and_completion_urls() {
        let openai = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: String::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        };
        assert_eq!(resolve_model_list_endpoint(&openai).unwrap(), "https://api.openai.com/v1/models");

        let claude = AiConfig {
            provider: AiProvider::Claude,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: "https://api.anthropic.com/v1/messages".to_string(),
            model: String::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
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
            api_style: AiApiStyle::AnthropicMessages,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
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
    fn auto_adds_v1_to_openai_compatible_endpoints() {
        // Endpoint without /v1 — auto add
        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.example.com".to_string(),
            model: "test-model".to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
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
    fn claude_headers_support_api_key_and_bearer_auth() {
        let mut config = AiConfig {
            provider: AiProvider::Claude,
            api_key: "secret".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: "https://api.anthropic.com/v1/messages".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        };

        let api_key_headers = claude_headers(&config).unwrap();
        assert_eq!(api_key_headers.get("x-api-key").unwrap(), "secret");
        assert!(api_key_headers.get(AUTHORIZATION).is_none());

        config.auth_method = AiAuthMethod::Bearer;
        let bearer_headers = claude_headers(&config).unwrap();
        assert_eq!(bearer_headers.get(AUTHORIZATION).unwrap(), "Bearer secret");
        assert!(bearer_headers.get("x-api-key").is_none());
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
                AiModelInfo { id: "gpt-4o-mini".to_string(), display_name: None },
                AiModelInfo {
                    id: "claude-sonnet-4-20250514".to_string(),
                    display_name: Some("Claude Sonnet 4".to_string())
                },
            ]
        );
    }

    #[test]
    fn responses_api_clamps_tiny_output_token_requests() {
        assert_eq!(responses_max_output_tokens(Some(1)), 16);
        assert_eq!(responses_max_output_tokens(Some(16)), 16);
        assert_eq!(responses_max_output_tokens(Some(2400)), 2400);
        assert_eq!(responses_max_output_tokens(None), 2048);
    }

    #[test]
    fn temperature_value_rounds_f32_to_provider_safe_precision() {
        assert_eq!(temperature_value(Some(0.15)), serde_json::json!(0.15));
        assert_eq!(temperature_value(Some(0.149)), serde_json::json!(0.15));
        assert_eq!(temperature_value(None), serde_json::json!(0.2));
        assert_eq!(serde_json::to_string(&temperature_value(Some(0.15))).unwrap(), "0.15");
    }

    #[test]
    fn omits_temperature_for_openai_reasoning_models() {
        let mut config = AiConfig {
            provider: AiProvider::Openai,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-5.5".to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        };

        assert!(!supports_temperature(&config));

        config.model = "o4-mini".to_string();
        assert!(!supports_temperature(&config));

        config.model = "gpt-4o".to_string();
        assert!(supports_temperature(&config));

        config.provider = AiProvider::OpenaiCompatible;
        config.endpoint = "http://localhost:11434/v1".to_string();
        config.model = "gpt-5-local".to_string();
        assert!(supports_temperature(&config));

        // Kimi K2.5+ models: temperature is forced to 1.0 by the API
        config.model = "kimi-k2.7-code".to_string();
        assert!(!supports_temperature(&config));
        assert!(is_kimi_model(&config.model));

        config.model = "kimi-k2.6".to_string();
        assert!(!supports_temperature(&config));
        assert!(is_kimi_model(&config.model));

        config.model = "kimi-k2.5".to_string();
        assert!(!supports_temperature(&config));
        assert!(is_kimi_model(&config.model));

        // K3+ should also be matched
        config.model = "kimi-k3".to_string();
        assert!(!supports_temperature(&config));
        assert!(is_kimi_model(&config.model));

        // Older K2 variants should NOT be matched (they support custom temperature)
        config.model = "kimi-k2".to_string();
        assert!(supports_temperature(&config));
        assert!(!is_kimi_model(&config.model));

        config.model = "kimi-k2-thinking".to_string();
        assert!(supports_temperature(&config));
        assert!(!is_kimi_model(&config.model));

        config.model = "kimi-k2-0711-preview".to_string();
        assert!(supports_temperature(&config));
        assert!(!is_kimi_model(&config.model));

        config.model = "kimi-k2.4".to_string();
        assert!(supports_temperature(&config));
        assert!(!is_kimi_model(&config.model));
    }

    #[test]
    fn omits_temperature_for_kimi_test_connection_body() {
        let config = AiConfig {
            provider: AiProvider::OpenaiCompatible,
            api_key: "key".to_string(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://api.moonshot.cn/v1".to_string(),
            model: "kimi-k2.5".to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: false,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        };
        let mut body = serde_json::json!({
            "model": &config.model,
            "messages": [{ "role": "user", "content": TEST_PROMPT }],
            "max_tokens": 16,
            "stream": true,
        });

        add_temperature_if_supported_for_config(&mut body, &config, Some(0.0));
        if !config.enable_thinking && !is_kimi_model(&config.model) {
            body["extra_body"] = serde_json::json!({
                "chat_template_kwargs": { "enable_thinking": false }
            });
        }

        assert!(body.get("temperature").is_none());
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
}
