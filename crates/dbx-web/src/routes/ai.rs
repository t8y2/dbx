use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::Deserialize;

use dbx_core::agent_events::AgentEvent;
use dbx_core::agent_loop::{run_agent_loop, AgentLoopContext};
use dbx_core::ai::{
    AiChatSelectionState, AiCompletionRequest, AiConfig, AiConfigItem, AiConversation, AiEffortCapability, AiModelInfo,
    AiProvider, AiStreamChunk, AiTestConnectionResult,
};
use dbx_core::models::connection::DatabaseType;

use crate::error::AppError;
use crate::state::WebState;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiProviderConfigRequest {
    pub provider: String,
    pub config: AiConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConfigRequest {
    pub config: AiConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConversationRequest {
    pub conversation: AiConversation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteRequest {
    pub request: AiCompletionRequest,
}

#[derive(Deserialize)]
pub struct AiStreamRequest {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub request: AiCompletionRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestConnectionRequest {
    pub config: AiConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiListModelsRequest {
    pub config: AiConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResolveModelEffortRequest {
    pub config: AiConfig,
    pub model_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiChatSelectionRequest {
    pub selection: AiChatSelectionState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCancelStreamRequest {
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentStreamRequest {
    pub session_id: String,
    pub request: AiCompletionRequest,
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub db_type: String,
    /// Agent mode: "ask" (read-only tools) or "agent" (all tools including execute_query).
    /// Defaults to "ask" if not provided.
    #[serde(default = "default_agent_mode")]
    pub mode: String,
    #[serde(default)]
    pub allow_write_sql: bool,
    /// When allow_write_sql is true, the specific SQL the user confirmed.
    #[serde(default)]
    pub confirmed_write_sql: Option<String>,
    /// Connection/database snapshot at confirmation time; verified at this boundary.
    #[serde(default)]
    pub confirmed_connection_id: Option<String>,
    #[serde(default)]
    pub confirmed_database: Option<String>,
    #[serde(default)]
    pub confirmed_schema: Option<String>,
}

fn default_agent_mode() -> String {
    "ask".to_string()
}

fn reject_web_unsupported_ai_provider(config: &AiConfig) -> Result<(), AppError> {
    if dbx_core::ai::is_cli_provider(&config.provider) {
        return Err(AppError::bad_request("CLI providers are only supported in DBX Desktop."));
    }
    Ok(())
}

fn ai_provider_from_key(provider: &str) -> Result<AiProvider, AppError> {
    serde_json::from_value(serde_json::Value::String(provider.to_string()))
        .map_err(|_| AppError::bad_request(format!("Invalid AI provider: {provider}")))
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

pub async fn save_ai_config(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConfigRequest>,
) -> Result<Json<()>, AppError> {
    reject_web_unsupported_ai_provider(&body.config)?;
    state.app.storage.save_ai_config(&body.config).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_ai_config(State(state): State<Arc<WebState>>) -> Result<Json<Option<AiConfig>>, AppError> {
    let config = state.app.storage.load_ai_config().await.map_err(AppError::from)?;
    Ok(Json(config))
}

pub async fn save_ai_provider_config(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiProviderConfigRequest>,
) -> Result<Json<()>, AppError> {
    let parsed_provider = ai_provider_from_key(&body.provider)?;
    let mut config = body.config;
    config.provider = parsed_provider;
    reject_web_unsupported_ai_provider(&config)?;
    state.app.storage.save_ai_provider_config(&body.provider, &config).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_ai_provider_configs(
    State(state): State<Arc<WebState>>,
) -> Result<Json<HashMap<String, AiConfig>>, AppError> {
    let configs = state.app.storage.load_ai_provider_configs().await.map_err(AppError::from)?;
    Ok(Json(configs))
}

pub async fn save_ai_chat_selection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiChatSelectionRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_ai_chat_selection(&body.selection).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_ai_chat_selection(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Option<AiChatSelectionState>>, AppError> {
    let selection = state.app.storage.load_ai_chat_selection().await.map_err(AppError::from)?;
    Ok(Json(selection))
}

// ---------------------------------------------------------------------------
// Multi-config
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConfigsRequest {
    pub configs: Vec<AiConfigItem>,
}

pub async fn save_ai_configs(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConfigsRequest>,
) -> Result<Json<()>, AppError> {
    for item in &body.configs {
        reject_web_unsupported_ai_provider(&item.config)?;
    }
    state.app.storage.save_ai_configs(&body.configs).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_ai_configs(State(state): State<Arc<WebState>>) -> Result<Json<Vec<AiConfigItem>>, AppError> {
    let configs = state.app.storage.load_ai_configs().await.map_err(AppError::from)?;
    Ok(Json(configs))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultAiConfigRequest {
    pub config_id: String,
}

pub async fn set_default_ai_config(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SetDefaultAiConfigRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.set_default_ai_config(&body.config_id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConfigItemRequest {
    pub config: AiConfigItem,
}

pub async fn save_ai_config_item(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConfigItemRequest>,
) -> Result<Json<()>, AppError> {
    reject_web_unsupported_ai_provider(&body.config.config)?;
    state.app.storage.save_ai_config_item(&body.config).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_ai_config(
    State(state): State<Arc<WebState>>,
    Path(config_id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_ai_config(&config_id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

pub async fn save_ai_conversation(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConversationRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_ai_conversation(&body.conversation).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_ai_conversations(State(state): State<Arc<WebState>>) -> Result<Json<Vec<AiConversation>>, AppError> {
    let conversations = state.app.storage.load_ai_conversations().await.map_err(AppError::from)?;
    Ok(Json(conversations))
}

pub async fn delete_ai_conversation(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_ai_conversation(&id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

// ---------------------------------------------------------------------------
// AI complete (non-streaming)
// ---------------------------------------------------------------------------

pub async fn ai_complete(
    State(state): State<Arc<WebState>>,
    Json(body): Json<AiCompleteRequest>,
) -> Result<Json<String>, AppError> {
    reject_web_unsupported_ai_provider(&body.request.config)?;
    let mut request = body.request;
    dbx_core::ai::merge_global_max_retries(
        &mut request.config,
        state.app.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    let result = dbx_core::ai::complete(&request).await.map_err(AppError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI test connection
// ---------------------------------------------------------------------------

pub async fn ai_test_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<AiTestConnectionRequest>,
) -> Result<Json<AiTestConnectionResult>, AppError> {
    let mut config = body.config;
    reject_web_unsupported_ai_provider(&config)?;
    dbx_core::ai::merge_global_max_retries(
        &mut config,
        state.app.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    let result = dbx_core::ai::test_connection_core(&config).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn ai_list_models(
    State(state): State<Arc<WebState>>,
    Json(body): Json<AiListModelsRequest>,
) -> Result<Json<Vec<AiModelInfo>>, AppError> {
    let mut config = body.config;
    reject_web_unsupported_ai_provider(&config)?;
    dbx_core::ai::merge_global_max_retries(
        &mut config,
        state.app.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    let result = dbx_core::ai::list_models_core(&config).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn ai_resolve_model_effort(
    State(state): State<Arc<WebState>>,
    Json(body): Json<AiResolveModelEffortRequest>,
) -> Result<Json<AiEffortCapability>, AppError> {
    let mut config = body.config;
    reject_web_unsupported_ai_provider(&config)?;
    dbx_core::ai::merge_global_max_retries(
        &mut config,
        state.app.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    let result = dbx_core::ai::resolve_model_effort_core(&config, &body.model_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI cancel stream
// ---------------------------------------------------------------------------

pub async fn ai_cancel_stream(Json(body): Json<AiCancelStreamRequest>) -> Result<Json<bool>, AppError> {
    let result = dbx_core::ai::cancel_stream(&body.session_id).await;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI stream (POST returns SSE directly)
// ---------------------------------------------------------------------------

pub async fn ai_stream(
    State(state): State<Arc<WebState>>,
    Json(body): Json<AiStreamRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let session_id = body.session_id;
    let mut request = body.request;
    reject_web_unsupported_ai_provider(&request.config)?;
    dbx_core::ai::merge_global_max_retries(
        &mut request.config,
        state.app.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );

    let cancelled = dbx_core::ai::register_stream(&session_id).await;
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(256);

    let sid = session_id.clone();
    tokio::spawn(async move {
        let result = dbx_core::ai::stream(&sid, &request, &cancelled, |chunk: AiStreamChunk| {
            let json = serde_json::to_string(&chunk).unwrap_or_default();
            let _ = tx.send(json);
        })
        .await;

        if let Err(_e) = result {
            let error_chunk =
                AiStreamChunk { session_id: sid.clone(), delta: String::new(), reasoning_delta: None, done: true };
            let _ = tx.send(serde_json::to_string(&error_chunk).unwrap_or_default());
        }

        dbx_core::ai::unregister_stream(&sid).await;
    });

    let stream = async_stream::stream! {
        let mut rx = rx;
        while let Ok(data) = rx.recv().await {
            yield Ok(Event::default().data(data));
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

// ---------------------------------------------------------------------------
// AI agent stream (POST returns SSE with AgentEvent)
// ---------------------------------------------------------------------------

pub async fn ai_agent_stream(
    State(state): State<Arc<WebState>>,
    Json(body): Json<AiAgentStreamRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let session_id = body.session_id;
    let request = body.request;
    reject_web_unsupported_ai_provider(&request.config)?;

    let cancelled = dbx_core::ai::register_stream(&session_id).await;
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(256);

    let parsed_db_type: DatabaseType = serde_json::from_str(&format!("\"{}\"", body.db_type))
        .map_err(|_| AppError::from(format!("Unknown database type: {}", body.db_type)))?;
    let production_database = state
        .app
        .configs
        .read()
        .await
        .get(&body.connection_id)
        .is_some_and(|config| dbx_core::production_safety::is_production_database(config, &body.database));

    let max_agent_turns = state.app.storage.load_max_agent_turns().await.unwrap_or_else(|err| {
        log::warn!("Failed to load max_agent_turns setting, using default: {err}");
        dbx_core::agent_loop::DEFAULT_MAX_AGENT_TURNS
    });
    let max_retries = state.app.storage.load_max_retries().await.unwrap_or_else(|err| {
        log::warn!("Failed to load max_retries setting, using default: {err}");
        dbx_core::ai::DEFAULT_MAX_RETRIES
    });
    // Reject the confirmed-write grant when the connection or database changed
    // between the user's confirmation and this backend request (defense-in-depth).
    let (allow_write_sql, confirmed_write_sql) = dbx_core::agent_tools::verify_confirmed_target(
        Some(body.allow_write_sql),
        body.confirmed_write_sql,
        body.confirmed_connection_id,
        body.confirmed_database,
        body.confirmed_schema,
        &body.connection_id,
        &body.database,
        body.schema.as_deref(),
    );
    // Writes are only allowed when a specific SQL statement was confirmed —
    // an empty confirmed_write_sql is treated as "no confirmation" so the
    // agent cannot execute arbitrary write/DDL statements.
    let sql_permissions = dbx_core::agent_tools::confirmed_write_sql_permissions(
        production_database,
        allow_write_sql.unwrap_or(false),
        confirmed_write_sql,
    );
    let agent_ctx = AgentLoopContext {
        state: state.app.clone(),
        connection_id: body.connection_id,
        database: body.database,
        schema: body.schema,
        db_type: parsed_db_type,
        cli_mcp_server_command: None,
        sql_permissions,
        max_agent_turns,
    };

    let sid = session_id.clone();
    let mut req_config = request.config;
    dbx_core::ai::merge_global_max_retries(&mut req_config, max_retries);
    let req_system_prompt = request.system_prompt;
    let req_messages = request.messages;
    let req_task_contract = request.task_contract;
    let req_max_tokens = request.max_tokens;
    let is_agent_mode = body.mode == "agent";
    let tx2 = tx.clone();
    tokio::task::spawn_blocking(move || {
        let rt =
            tokio::runtime::Builder::new_current_thread().enable_all().build().expect("failed to create agent runtime");
        rt.block_on(async move {
            let result = run_agent_loop(
                &req_config,
                &req_system_prompt,
                &req_messages,
                &agent_ctx,
                move |event: AgentEvent| {
                    let json = serde_json::to_string(&event).unwrap_or_default();
                    let _ = tx2.send(json);
                },
                &cancelled,
                req_max_tokens,
                req_task_contract.as_ref(),
                is_agent_mode,
            )
            .await;

            if let Err(e) = result {
                let error_event = AgentEvent::Error { message: e };
                let _ = tx.send(serde_json::to_string(&error_event).unwrap_or_default());
            }

            dbx_core::ai::unregister_stream(&sid).await;
        });
    });

    let stream = async_stream::stream! {
        let mut rx = rx;
        while let Ok(data) = rx.recv().await {
            yield Ok(Event::default().data(data));
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod tests {
    use super::reject_web_unsupported_ai_provider;
    use dbx_core::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiProvider, AiReasoningLevel};

    fn make_config(provider: AiProvider) -> AiConfig {
        AiConfig {
            provider,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: "https://example.com".to_string(),
            model: "test".to_string(),
            models: vec![],
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
        }
    }

    #[test]
    fn rejects_local_cli_providers_single() {
        for provider in [AiProvider::CodexCli, AiProvider::ClaudeCodeCli, AiProvider::PiAgentCli] {
            let config = make_config(provider);
            assert!(reject_web_unsupported_ai_provider(&config).is_err());
        }
    }

    #[test]
    fn allows_other_providers_single() {
        for provider in &[
            AiProvider::Claude,
            AiProvider::AnthropicCompatible,
            AiProvider::Openai,
            AiProvider::OpenaiCompatible,
            AiProvider::Custom,
            AiProvider::Gemini,
            AiProvider::Deepseek,
            AiProvider::Qwen,
            AiProvider::MiniMax,
            AiProvider::Ollama,
        ] {
            let config = make_config(provider.clone());
            assert!(reject_web_unsupported_ai_provider(&config).is_ok(), "provider {:?} should be allowed", provider);
        }
    }

    /// Integration test: the `ai_test_connection` web handler applies global
    /// max_retries=0 so that a 429 is not retried.
    #[tokio::test]
    async fn web_test_connection_respects_global_max_retries_zero() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        use axum::extract::State;
        use dbx_core::connection::AppState;

        let dir = std::env::temp_dir().join(format!("dbx-web-intg-max-retries-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let storage = dbx_core::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        storage.save_max_retries(0).await.unwrap();
        assert_eq!(storage.load_max_retries().await.unwrap(), 0);

        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let web_state = Arc::new(crate::state::WebState::for_tests(app, dir.clone()));

        // Counting 429 server
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let count = Arc::new(AtomicU32::new(0));
        let count2 = count.clone();
        let srv = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                count2.fetch_add(1, Ordering::SeqCst);
                let mut buf = vec![0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let resp = b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(resp).await;
            }
        });

        let config = AiConfig {
            provider: AiProvider::Claude,
            api_key: "sk-test".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: url.clone(),
            model: "claude-sonnet-4".to_string(),
            models: vec![],
            api_style: AiApiStyle::AnthropicMessages,
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

        let body = super::AiTestConnectionRequest { config };
        let result = super::ai_test_connection(State(web_state), axum::Json(body)).await;

        // 429 → should NOT succeed (no retry).
        if let Ok(axum::Json(resp)) = result {
            assert!(!resp.success, "429 with max_retries=0 must fail, got success");
        }

        srv.abort();
        assert_eq!(count.load(Ordering::SeqCst), 1, "max_retries=0 must mean exactly 1 request");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
