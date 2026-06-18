use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::connection::AppState;
pub use dbx_core::ai::*;

#[tauri::command]
pub async fn ai_test_connection(config: AiConfig) -> Result<AiTestConnectionResult, String> {
    dbx_core::ai::test_connection_core(&config).await
}

#[tauri::command]
pub async fn ai_list_models(config: AiConfig) -> Result<Vec<AiModelInfo>, String> {
    dbx_core::ai::list_models_core(&config).await
}

#[tauri::command]
pub async fn save_ai_config(state: State<'_, Arc<AppState>>, config: AiConfig) -> Result<(), String> {
    state.storage.save_ai_config(&config).await
}

#[tauri::command]
pub async fn load_ai_config(state: State<'_, Arc<AppState>>) -> Result<Option<AiConfig>, String> {
    state.storage.load_ai_config().await
}

#[tauri::command]
pub async fn ai_complete(request: AiCompletionRequest) -> Result<String, String> {
    dbx_core::ai::complete(&request).await
}

#[tauri::command]
pub async fn ai_stream(app: AppHandle, session_id: String, request: AiCompletionRequest) -> Result<(), String> {
    let cancelled = dbx_core::ai::register_stream(&session_id).await;

    let result = dbx_core::ai::stream(&session_id, &request, &cancelled, |chunk| {
        let _ = app.emit("ai-stream-chunk", &chunk);
    })
    .await;

    dbx_core::ai::unregister_stream(&session_id).await;
    result
}

use dbx_core::agent_events::AgentEvent;
use dbx_core::agent_loop::{run_agent_loop, AgentLoopContext};
use dbx_core::ai_cli_agent::CliAgentCommandSpec;
use dbx_core::models::connection::DatabaseType;

#[tauri::command]
pub async fn ai_cancel_stream(session_id: String) -> Result<bool, String> {
    Ok(dbx_core::ai::cancel_stream(&session_id).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_agent_stream(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    session_id: String,
    request: AiCompletionRequest,
    connection_id: String,
    database: String,
    db_type: String,
    mode: Option<String>,
) -> Result<String, String> {
    let cancelled = dbx_core::ai::register_stream(&session_id).await;

    let parsed_db_type: DatabaseType =
        serde_json::from_str(&format!("\"{}\"", db_type)).map_err(|_| format!("Unknown database type: {db_type}"))?;

    let cli_mcp_server_command = if matches!(request.config.provider, AiProvider::CodexCli) {
        super::mcp::resolve_mcp_server_command().map(|(program, args)| CliAgentCommandSpec { program, args })
    } else {
        None
    };
    let agent_ctx = AgentLoopContext {
        state: state.inner().clone(),
        connection_id,
        database,
        db_type: parsed_db_type,
        cli_mcp_server_command,
    };
    let is_agent_mode = mode.as_deref() == Some("agent");

    let result = run_agent_loop(
        &request.config,
        &request.system_prompt,
        &request.messages,
        &agent_ctx,
        {
            let app = app.clone();
            move |event: AgentEvent| {
                let _ = app.emit("ai-agent-event", &event);
            }
        },
        &cancelled,
        request.max_tokens,
        request.temperature,
        is_agent_mode,
    )
    .await;

    dbx_core::ai::unregister_stream(&session_id).await;
    result
}

#[tauri::command]
pub async fn save_ai_conversation(state: State<'_, Arc<AppState>>, conversation: AiConversation) -> Result<(), String> {
    state.storage.save_ai_conversation(&conversation).await
}

#[tauri::command]
pub async fn load_ai_conversations(state: State<'_, Arc<AppState>>) -> Result<Vec<AiConversation>, String> {
    state.storage.load_ai_conversations().await
}

#[tauri::command]
pub async fn delete_ai_conversation(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_ai_conversation(&id).await
}
