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
    AiCompletionRequest, AiConfig, AiConversation, AiModelInfo, AiProvider, AiStreamChunk, AiTestConnectionResult,
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
    pub db_type: String,
    /// Agent mode: "ask" (read-only tools) or "agent" (all tools including execute_query).
    /// Defaults to "ask" if not provided.
    #[serde(default = "default_agent_mode")]
    pub mode: String,
    #[serde(default)]
    pub allow_write_sql: bool,
}

fn default_agent_mode() -> String {
    "ask".to_string()
}

fn reject_web_unsupported_ai_provider(config: &AiConfig) -> Result<(), AppError> {
    if matches!(config.provider, AiProvider::CodexCli) {
        return Err(AppError::bad_request("Codex CLI provider is only supported in DBX Desktop."));
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
    state.app.storage.save_ai_config(&body.config).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_ai_config(State(state): State<Arc<WebState>>) -> Result<Json<Option<AiConfig>>, AppError> {
    let config = state.app.storage.load_ai_config().await.map_err(AppError)?;
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
    state.app.storage.save_ai_provider_config(&body.provider, &config).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_ai_provider_configs(
    State(state): State<Arc<WebState>>,
) -> Result<Json<HashMap<String, AiConfig>>, AppError> {
    let configs = state.app.storage.load_ai_provider_configs().await.map_err(AppError)?;
    Ok(Json(configs))
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

pub async fn save_ai_conversation(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveAiConversationRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_ai_conversation(&body.conversation).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn load_ai_conversations(State(state): State<Arc<WebState>>) -> Result<Json<Vec<AiConversation>>, AppError> {
    let conversations = state.app.storage.load_ai_conversations().await.map_err(AppError)?;
    Ok(Json(conversations))
}

pub async fn delete_ai_conversation(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_ai_conversation(&id).await.map_err(AppError)?;
    Ok(Json(()))
}

// ---------------------------------------------------------------------------
// AI complete (non-streaming)
// ---------------------------------------------------------------------------

pub async fn ai_complete(Json(body): Json<AiCompleteRequest>) -> Result<Json<String>, AppError> {
    reject_web_unsupported_ai_provider(&body.request.config)?;
    let result = dbx_core::ai::complete(&body.request).await.map_err(AppError)?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// AI test connection
// ---------------------------------------------------------------------------

pub async fn ai_test_connection(
    Json(body): Json<AiTestConnectionRequest>,
) -> Result<Json<AiTestConnectionResult>, AppError> {
    reject_web_unsupported_ai_provider(&body.config)?;
    let result = dbx_core::ai::test_connection_core(&body.config).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn ai_list_models(Json(body): Json<AiListModelsRequest>) -> Result<Json<Vec<AiModelInfo>>, AppError> {
    reject_web_unsupported_ai_provider(&body.config)?;
    let result = dbx_core::ai::list_models_core(&body.config).await.map_err(AppError)?;
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
    Json(body): Json<AiStreamRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let session_id = body.session_id;
    let request = body.request;
    reject_web_unsupported_ai_provider(&request.config)?;

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
        .map_err(|_| AppError(format!("Unknown database type: {}", body.db_type)))?;
    let production_database = state
        .app
        .configs
        .read()
        .await
        .get(&body.connection_id)
        .is_some_and(|config| dbx_core::production_safety::is_production_database(config, &body.database));

    let agent_ctx = AgentLoopContext {
        state: state.app.clone(),
        connection_id: body.connection_id,
        database: body.database,
        db_type: parsed_db_type,
        cli_mcp_server_command: None,
        sql_permissions: dbx_core::agent_tools::AgentSqlPermissions {
            allow_writes: !production_database && body.allow_write_sql,
            allow_dangerous: !production_database && body.allow_write_sql,
        },
    };

    let sid = session_id.clone();
    let req_config = request.config;
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
