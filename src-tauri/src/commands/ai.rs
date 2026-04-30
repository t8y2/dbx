use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Claude,
    Openai,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: AiProvider,
    pub api_key: String,
    pub endpoint: String,
    pub model: String,
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

fn ai_config_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ai_config.json"))
}

#[tauri::command]
pub async fn save_ai_config(app: AppHandle, config: AiConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(ai_config_file(&app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_ai_config(app: AppHandle) -> Result<Option<AiConfig>, String> {
    let path = ai_config_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_complete(request: AiCompletionRequest) -> Result<String, String> {
    if request.config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    if request.config.endpoint.trim().is_empty() {
        return Err("Endpoint is required".to_string());
    }
    if request.config.model.trim().is_empty() {
        return Err("Model is required".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    match request.config.provider {
        AiProvider::Claude => call_claude(&client, request).await,
        AiProvider::Openai | AiProvider::Custom => call_openai_compatible(&client, request).await,
    }
}

#[derive(Debug, Clone, Serialize)]
struct AiStreamChunk {
    session_id: String,
    delta: String,
    done: bool,
}

#[tauri::command]
pub async fn ai_stream(app: AppHandle, session_id: String, request: AiCompletionRequest) -> Result<(), String> {
    if request.config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    if request.config.endpoint.trim().is_empty() {
        return Err("Endpoint is required".to_string());
    }
    if request.config.model.trim().is_empty() {
        return Err("Model is required".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    match request.config.provider {
        AiProvider::Claude => stream_claude(&app, &client, &session_id, request).await,
        AiProvider::Openai | AiProvider::Custom => stream_openai(&app, &client, &session_id, request).await,
    }
}

async fn stream_claude(app: &AppHandle, client: &reqwest::Client, session_id: &str, request: AiCompletionRequest) -> Result<(), String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-api-key",
        HeaderValue::from_str(&request.config.api_key).map_err(|e| e.to_string())?,
    );
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));

    let body = json!({
        "model": request.config.model,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "temperature": request.temperature.unwrap_or(0.2),
        "system": request.system_prompt,
        "messages": request.messages,
        "stream": true,
    });

    let res = client
        .post(&request.config.endpoint)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "Claude API error".to_string()));
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].to_string();
            buf = buf[pos + 1..].to_string();

            let line = line.trim();
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[DONE]" {
                break;
            }

            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                if event["type"] == "content_block_delta" {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        let _ = app.emit("ai-stream-chunk", AiStreamChunk {
                            session_id: session_id.to_string(),
                            delta: text.to_string(),
                            done: false,
                        });
                    }
                }
            }
        }
    }

    let _ = app.emit("ai-stream-chunk", AiStreamChunk {
        session_id: session_id.to_string(),
        delta: String::new(),
        done: true,
    });

    Ok(())
}

async fn stream_openai(app: &AppHandle, client: &reqwest::Client, session_id: &str, request: AiCompletionRequest) -> Result<(), String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", request.config.api_key)).map_err(|e| e.to_string())?,
    );

    let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
    messages.extend(
        request.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })),
    );

    let body = json!({
        "model": request.config.model,
        "messages": messages,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "temperature": request.temperature.unwrap_or(0.2),
        "stream": true,
    });

    let res = client
        .post(&request.config.endpoint)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    if !res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return Err(extract_error(&data).unwrap_or_else(|| "API error".to_string()));
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].to_string();
            buf = buf[pos + 1..].to_string();

            let line = line.trim();
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[DONE]" {
                break;
            }

            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(text) = event["choices"][0]["delta"]["content"].as_str() {
                    let _ = app.emit("ai-stream-chunk", AiStreamChunk {
                        session_id: session_id.to_string(),
                        delta: text.to_string(),
                        done: false,
                    });
                }
            }
        }
    }

    let _ = app.emit("ai-stream-chunk", AiStreamChunk {
        session_id: session_id.to_string(),
        delta: String::new(),
        done: true,
    });

    Ok(())
}

async fn call_claude(client: &reqwest::Client, request: AiCompletionRequest) -> Result<String, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-api-key",
        HeaderValue::from_str(&request.config.api_key).map_err(|e| e.to_string())?,
    );
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));

    let body = json!({
        "model": request.config.model,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "temperature": request.temperature.unwrap_or(0.2),
        "system": request.system_prompt,
        "messages": request.messages,
    });

    let res = client
        .post(&request.config.endpoint)
        .headers(headers)
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

async fn call_openai_compatible(
    client: &reqwest::Client,
    request: AiCompletionRequest,
) -> Result<String, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", request.config.api_key)).map_err(|e| e.to_string())?,
    );

    let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
    messages.extend(
        request
            .messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );

    let body = json!({
        "model": request.config.model,
        "messages": messages,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "temperature": request.temperature.unwrap_or(0.2),
    });

    let res = client
        .post(&request.config.endpoint)
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

    Ok(data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

fn extract_error(data: &serde_json::Value) -> Option<String> {
    data["error"]["message"]
        .as_str()
        .or_else(|| data["error"].as_str())
        .map(ToString::to_string)
}
