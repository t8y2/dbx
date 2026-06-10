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
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiApiStyle {
    #[default]
    Completions,
    Responses,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AiAuthMethod {
    #[default]
    ApiKey,
    Bearer,
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
}

fn default_enable_thinking() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompletionRequest {
    pub config: AiConfig,
    pub system_prompt: String,
    pub messages: Vec<AiMessage>,
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
    match config.provider {
        AiProvider::Claude => format!("{ep}/messages"),
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::Custom => {
            if config.api_style == AiApiStyle::Responses {
                format!("{ep}/responses")
            } else {
                format!("{ep}/chat/completions")
            }
        }
        AiProvider::Gemini => unreachable!(),
    }
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
        .and_then(|choice| choice["delta"]["reasoning_content"].as_str())
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

pub fn supports_temperature(config: &AiConfig) -> bool {
    !(is_openai_api_config(config) && is_openai_reasoning_model(&config.model))
}

fn add_temperature_if_supported(body: &mut serde_json::Value, request: &AiCompletionRequest) {
    if supports_temperature(&request.config) {
        body["temperature"] = json!(request.temperature.unwrap_or(0.2));
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

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

fn validate_config(config: &AiConfig) -> Result<(), String> {
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
    if !matches!(config.provider, AiProvider::Ollama) && config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    resolve_model_list_endpoint(config).map(|_| ())
}

fn maybe_bearer_headers(config: &AiConfig) -> Result<HeaderMap, String> {
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

fn claude_headers(config: &AiConfig) -> Result<HeaderMap, String> {
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
    validate_model_list_config(config)?;

    let client = build_ai_http_client(config, 30)?;

    match config.provider {
        AiProvider::Claude => list_claude_models(&client, config).await,
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::Custom => list_openai_compatible_models(&client, config).await,
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
        "temperature": request.temperature.unwrap_or(0.2),
        "system": request.system_prompt,
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
    if !request.config.enable_thinking {
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
            "temperature": request.temperature.unwrap_or(0.2),
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

pub async fn test_connection_core(config: &AiConfig) -> Result<String, String> {
    validate_config(config)?;

    let client = build_ai_http_client(config, 15)?;

    let request = AiCompletionRequest {
        config: config.clone(),
        system_prompt: String::new(),
        messages: vec![AiMessage { role: "user".into(), content: "hi".into() }],
        max_tokens: Some(1),
        temperature: Some(0.0),
    };

    match request.config.provider {
        AiProvider::Claude => call_claude(&client, request).await,
        AiProvider::Gemini => call_gemini(&client, request).await,
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::Custom => {
            if request.config.api_style == AiApiStyle::Responses {
                call_responses_api(&client, request).await
            } else {
                call_openai_compatible(&client, request).await
            }
        }
    }
    .map(|_| "OK".to_string())
}

pub async fn complete(request: &AiCompletionRequest) -> Result<String, String> {
    validate_config(&request.config)?;

    let client = build_ai_http_client(&request.config, 60)?;

    match request.config.provider {
        AiProvider::Claude => call_claude(&client, request.clone()).await,
        AiProvider::Gemini => call_gemini(&client, request.clone()).await,
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::Custom => {
            if request.config.api_style == AiApiStyle::Responses {
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

    let stream_timeout = if request.config.enable_thinking { 600 } else { 120 };
    let client = build_ai_http_client(&request.config, stream_timeout)?;

    match request.config.provider {
        AiProvider::Claude => stream_claude(&client, session_id, request, cancelled, &on_chunk).await,
        AiProvider::Gemini => stream_gemini(&client, session_id, request, cancelled, &on_chunk).await,
        AiProvider::Openai
        | AiProvider::Deepseek
        | AiProvider::Qwen
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::Custom => {
            if request.config.api_style == AiApiStyle::Responses {
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
        "temperature": request.temperature.unwrap_or(0.2),
        "system": request.system_prompt,
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
    if !request.config.enable_thinking {
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
            "temperature": request.temperature.unwrap_or(0.2),
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
        build_ai_http_client, claude_headers, gemini_text, openai_response_text, openai_stream_text,
        parse_model_list_response, resolve_endpoint, resolve_model_list_endpoint, responses_max_output_tokens,
        responses_text, supports_temperature, validate_config, AiApiStyle, AiAuthMethod, AiConfig, AiModelInfo,
        AiProvider, AUTHORIZATION,
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
        };
        assert_eq!(resolve_model_list_endpoint(&claude).unwrap(), "https://api.anthropic.com/v1/models");
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
