use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::connection::AppState;
pub use dbx_core::ai::*;

#[tauri::command]
pub async fn ai_test_connection(config: AiConfig) -> Result<AiTestConnectionResult, String> {
    let config = resolve_cli_provider_config(config);
    dbx_core::ai::test_connection_core(&config).await
}

#[tauri::command]
pub async fn ai_list_models(config: AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let config = resolve_cli_provider_config(config);
    dbx_core::ai::list_models_core(&config).await
}

#[tauri::command]
pub async fn ai_resolve_model_effort(config: AiConfig, model_id: String) -> Result<AiEffortCapability, String> {
    let config = resolve_cli_provider_config(config);
    dbx_core::ai::resolve_model_effort_core(&config, &model_id).await
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
pub async fn save_ai_provider_config(
    state: State<'_, Arc<AppState>>,
    provider: String,
    config: AiConfig,
) -> Result<(), String> {
    let parsed_provider: AiProvider = serde_json::from_value(serde_json::Value::String(provider.clone()))
        .map_err(|_| format!("Invalid AI provider: {provider}"))?;
    let mut config = config;
    config.provider = parsed_provider;
    state.storage.save_ai_provider_config(&provider, &config).await
}

#[tauri::command]
pub async fn load_ai_provider_configs(
    state: State<'_, Arc<AppState>>,
) -> Result<std::collections::HashMap<String, AiConfig>, String> {
    state.storage.load_ai_provider_configs().await
}

#[tauri::command]
pub async fn save_ai_chat_selection(
    state: State<'_, Arc<AppState>>,
    selection: AiChatSelectionState,
) -> Result<(), String> {
    state.storage.save_ai_chat_selection(&selection).await
}

#[tauri::command]
pub async fn load_ai_chat_selection(state: State<'_, Arc<AppState>>) -> Result<Option<AiChatSelectionState>, String> {
    state.storage.load_ai_chat_selection().await
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
    allow_write_sql: Option<bool>,
    confirmed_write_sql: Option<String>,
    confirmed_connection_id: Option<String>,
    confirmed_database: Option<String>,
) -> Result<String, String> {
    let request = resolve_cli_provider_request(request);

    let parsed_db_type: DatabaseType =
        serde_json::from_str(&format!("\"{}\"", db_type)).map_err(|_| format!("Unknown database type: {db_type}"))?;

    let cli_mcp_server_command = if is_cli_provider(&request.config.provider) {
        let (program, args) = super::mcp::resolve_mcp_server_command().await?;
        Some(CliAgentCommandSpec { program, args })
    } else {
        None
    };
    let cancelled = dbx_core::ai::register_stream(&session_id).await;
    let production_database = state
        .configs
        .read()
        .await
        .get(&connection_id)
        .is_some_and(|config| dbx_core::production_safety::is_production_database(config, &database));
    let max_agent_turns = state.storage.load_max_agent_turns().await.unwrap_or_else(|err| {
        log::warn!("Failed to load max_agent_turns setting, using default: {err}");
        dbx_core::agent_loop::DEFAULT_MAX_AGENT_TURNS
    });
    // Reject the confirmed-write grant when the connection or database changed
    // between the user's confirmation and this backend request.  The frontend
    // also verifies this synchronously, but this backend check provides
    // defense-in-depth for CLI-provider and API-driven paths.
    let (allow_write_sql, confirmed_write_sql) = dbx_core::agent_tools::verify_confirmed_target(
        allow_write_sql,
        confirmed_write_sql,
        confirmed_connection_id,
        confirmed_database,
        &connection_id,
        &database,
    );
    // Explicit confirmation grants write access only to this agent run, never to
    // production.  Writes are only allowed when a specific SQL statement was
    // confirmed — an empty confirmed_write_sql is treated as "no confirmation"
    // so the agent cannot execute arbitrary write/DDL statements.
    let sql_permissions = dbx_core::agent_tools::confirmed_write_sql_permissions(
        production_database,
        allow_write_sql.unwrap_or(false),
        confirmed_write_sql,
    );
    let agent_ctx = AgentLoopContext {
        state: state.inner().clone(),
        connection_id,
        database,
        db_type: parsed_db_type,
        cli_mcp_server_command,
        sql_permissions,
        max_agent_turns,
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
        request.task_contract.as_ref(),
        is_agent_mode,
    )
    .await;

    dbx_core::ai::unregister_stream(&session_id).await;
    result
}

fn resolve_cli_provider_request(mut request: AiCompletionRequest) -> AiCompletionRequest {
    request.config = resolve_cli_provider_config(request.config);
    request
}

fn resolve_cli_provider_config(mut config: AiConfig) -> AiConfig {
    let (path_slot, default_command) = match config.provider {
        AiProvider::CodexCli => (&mut config.codex_cli_path, "codex"),
        AiProvider::ClaudeCodeCli => (&mut config.claude_code_cli_path, "claude"),
        _ => return config,
    };
    let command = path_slot.as_deref().map(str::trim).filter(|path| !path.is_empty()).unwrap_or(default_command);
    if is_explicit_cli_path(command) {
        return config;
    }

    if let Some(path) = super::mcp::locate_command(command) {
        *path_slot = Some(path);
    }
    config
}

fn is_cli_provider(provider: &AiProvider) -> bool {
    matches!(provider, AiProvider::CodexCli | AiProvider::ClaudeCodeCli)
}

fn is_explicit_cli_path(command: &str) -> bool {
    let path = Path::new(command);
    path.is_absolute() || command.contains('/') || command.contains('\\')
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

#[cfg(test)]
mod tests {

    #[test]
    fn verify_confirmed_target_allows_matching_connection_and_database() {
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(true),
            Some("DELETE FROM users WHERE id = 1".to_string()),
            Some("conn-1".to_string()),
            Some("app".to_string()),
            "conn-1",
            "app",
        );
        assert_eq!(allow, Some(true));
        assert_eq!(confirmed, Some("DELETE FROM users WHERE id = 1".to_string()));
    }

    #[test]
    fn verify_confirmed_target_rejects_mismatched_connection() {
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(true),
            Some("DELETE FROM users WHERE id = 1".to_string()),
            Some("conn-staging".to_string()),
            Some("app".to_string()),
            "conn-production",
            "app",
        );
        assert_eq!(allow, Some(false));
        assert_eq!(confirmed, None);
    }

    #[test]
    fn verify_confirmed_target_rejects_mismatched_database() {
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(true),
            Some("DELETE FROM users WHERE id = 1".to_string()),
            Some("conn-1".to_string()),
            Some("staging".to_string()),
            "conn-1",
            "production",
        );
        assert_eq!(allow, Some(false));
        assert_eq!(confirmed, None);
    }

    #[test]
    fn verify_confirmed_target_passes_through_when_no_sql_confirmed() {
        // Without a confirmed SQL, no target verification is needed — the
        // grant has no write permission to protect.
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(false),
            None,
            Some("conn-staging".to_string()),
            Some("staging".to_string()),
            "conn-production",
            "production",
        );
        assert_eq!(allow, Some(false));
        assert_eq!(confirmed, None);
    }

    #[test]
    fn verify_confirmed_target_rejects_when_no_snapshot_provided() {
        // When confirmed_connection_id is None (e.g. older frontend that
        // doesn't send snapshots), the target cannot be verified, so the
        // grant must be rejected — fail-closed.
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(true),
            Some("DELETE FROM users WHERE id = 1".to_string()),
            None,
            None,
            "conn-1",
            "app",
        );
        assert_eq!(allow, Some(false));
        assert_eq!(confirmed, None);
    }
}
