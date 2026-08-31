use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::connection::AppState;
pub use dbx_core::ai::*;

#[tauri::command]
pub async fn ai_test_connection(
    state: State<'_, Arc<AppState>>,
    config: AiConfig,
) -> Result<AiTestConnectionResult, String> {
    let mut config = resolve_cli_provider_config(config);
    merge_global_max_retries(
        &mut config,
        state.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    dbx_core::ai::test_connection_core(&config).await
}

#[tauri::command]
pub async fn ai_list_models(state: State<'_, Arc<AppState>>, config: AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let mut config = resolve_cli_provider_config(config);
    merge_global_max_retries(
        &mut config,
        state.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    dbx_core::ai::list_models_core(&config).await
}

#[tauri::command]
pub async fn ai_resolve_model_effort(
    state: State<'_, Arc<AppState>>,
    config: AiConfig,
    model_id: String,
) -> Result<AiEffortCapability, String> {
    let mut config = resolve_cli_provider_config(config);
    merge_global_max_retries(
        &mut config,
        state.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
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
pub async fn ai_complete(state: State<'_, Arc<AppState>>, request: AiCompletionRequest) -> Result<String, String> {
    let mut request = request;
    merge_global_max_retries(
        &mut request.config,
        state.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    dbx_core::ai::complete(&request).await
}

#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    session_id: String,
    request: AiCompletionRequest,
) -> Result<(), String> {
    let mut request = request;
    merge_global_max_retries(
        &mut request.config,
        state.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );
    let cancelled = dbx_core::ai::register_stream(&session_id).await;

    let batcher = AiStreamChunkBatcher::new(app.clone(), session_id.clone());
    let result = dbx_core::ai::stream(&session_id, &request, &cancelled, |chunk| batcher.handle(chunk)).await;
    // Emit tail deltas the interval gate was still holding when the stream ended.
    batcher.flush();

    dbx_core::ai::unregister_stream(&session_id).await;
    result
}

use dbx_core::agent_events::AgentEvent;
use dbx_core::agent_loop::{run_agent_loop, AgentLoopContext};
use dbx_core::ai_cli_agent::CliAgentCommandSpec;
use dbx_core::models::connection::DatabaseType;

#[derive(serde::Serialize)]
struct AiAgentEventPayload {
    session_id: String,
    #[serde(flatten)]
    event: AgentEvent,
}

/// Minimum interval between emitted AI delta batches. Providers surface one
/// TextDelta/ReasoningDelta per SSE chunk (30-100+/second) and each emission
/// costs a serde serialization plus a webview IPC dispatch; batching keeps that
/// load off the render path while staying above the ~10Hz rate below which
/// streamed text stops reading as smooth typing.
const AI_DELTA_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Delta batches are emitted on the first observation after a quiet period and
/// at most once per interval afterwards.
fn ai_delta_emit_due(last_emit: Option<std::time::Instant>) -> bool {
    match last_emit {
        None => true,
        Some(at) => at.elapsed() >= AI_DELTA_EMIT_INTERVAL,
    }
}

#[derive(Default)]
struct AiAgentDeltaBatch {
    text: String,
    reasoning: String,
    last_emit: Option<std::time::Instant>,
}

impl AiAgentDeltaBatch {
    fn due(&self) -> bool {
        ai_delta_emit_due(self.last_emit)
    }
}

/// Coalesces consecutive TextDelta/ReasoningDelta events before they reach the
/// webview. Cloning shares the batch, so provider implementations that clone
/// the `on_event` callback emit through the same buffer. Any non-delta event
/// flushes the pending batch first, preserving event ordering and the
/// exact-replace semantics of WriteSqlConfirmationRequired/ProductionWriteBlocked
/// on the frontend.
struct AiAgentEventBatcher<R: tauri::Runtime> {
    app: AppHandle<R>,
    session_id: String,
    batch: Arc<std::sync::Mutex<AiAgentDeltaBatch>>,
}

// Manual impl: deriving would add an unnecessary `R: Clone` bound.
impl<R: tauri::Runtime> Clone for AiAgentEventBatcher<R> {
    fn clone(&self) -> Self {
        Self { app: self.app.clone(), session_id: self.session_id.clone(), batch: self.batch.clone() }
    }
}

impl<R: tauri::Runtime> AiAgentEventBatcher<R> {
    fn new(app: AppHandle<R>, session_id: String) -> Self {
        Self { app, session_id, batch: Arc::new(std::sync::Mutex::new(AiAgentDeltaBatch::default())) }
    }

    fn handle(&self, event: AgentEvent) {
        let mut batch = self.lock_batch();
        match event {
            AgentEvent::TextDelta { delta } => {
                batch.text.push_str(&delta);
                if batch.due() {
                    self.flush_locked(&mut batch);
                }
            }
            AgentEvent::ReasoningDelta { delta } => {
                batch.reasoning.push_str(&delta);
                if batch.due() {
                    self.flush_locked(&mut batch);
                }
            }
            event => {
                self.flush_locked(&mut batch);
                self.emit_event(event);
            }
        }
    }

    /// Emits whatever deltas the interval gate is still holding.
    fn flush(&self) {
        let mut batch = self.lock_batch();
        self.flush_locked(&mut batch);
    }

    fn lock_batch(&self) -> std::sync::MutexGuard<'_, AiAgentDeltaBatch> {
        self.batch.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn flush_locked(&self, batch: &mut AiAgentDeltaBatch) {
        if !batch.text.is_empty() {
            self.emit_event(AgentEvent::TextDelta { delta: std::mem::take(&mut batch.text) });
        }
        if !batch.reasoning.is_empty() {
            self.emit_event(AgentEvent::ReasoningDelta { delta: std::mem::take(&mut batch.reasoning) });
        }
        batch.last_emit = Some(std::time::Instant::now());
    }

    fn emit_event(&self, event: AgentEvent) {
        let payload = AiAgentEventPayload { session_id: self.session_id.clone(), event };
        let _ = self.app.emit("ai-agent-event", &payload);
    }
}

#[derive(Default)]
struct AiStreamChunkBatch {
    delta: String,
    reasoning: Option<String>,
    last_emit: Option<std::time::Instant>,
}

impl AiStreamChunkBatch {
    fn due(&self) -> bool {
        ai_delta_emit_due(self.last_emit)
    }
}

/// Same delta coalescing as [`AiAgentEventBatcher`] for the legacy
/// `ai-stream-chunk` completion stream: concatenate deltas between emissions,
/// forward the terminal `done` chunk immediately after flushing.
struct AiStreamChunkBatcher<R: tauri::Runtime> {
    app: AppHandle<R>,
    session_id: String,
    batch: Arc<std::sync::Mutex<AiStreamChunkBatch>>,
}

impl<R: tauri::Runtime> Clone for AiStreamChunkBatcher<R> {
    fn clone(&self) -> Self {
        Self { app: self.app.clone(), session_id: self.session_id.clone(), batch: self.batch.clone() }
    }
}

impl<R: tauri::Runtime> AiStreamChunkBatcher<R> {
    fn new(app: AppHandle<R>, session_id: String) -> Self {
        Self { app, session_id, batch: Arc::new(std::sync::Mutex::new(AiStreamChunkBatch::default())) }
    }

    fn handle(&self, mut chunk: AiStreamChunk) {
        let mut batch = self.lock_batch();
        if chunk.done {
            self.flush_locked(&mut batch);
            self.emit_chunk(chunk);
            return;
        }
        if !chunk.delta.is_empty() {
            batch.delta.push_str(&chunk.delta);
        }
        if let Some(reasoning) = chunk.reasoning_delta.take() {
            if !reasoning.is_empty() {
                batch.reasoning.get_or_insert_with(String::new).push_str(&reasoning);
            }
        }
        if batch.due() {
            self.flush_locked(&mut batch);
        }
    }

    /// Emits whatever deltas the interval gate is still holding.
    fn flush(&self) {
        let mut batch = self.lock_batch();
        self.flush_locked(&mut batch);
    }

    fn lock_batch(&self) -> std::sync::MutexGuard<'_, AiStreamChunkBatch> {
        self.batch.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn flush_locked(&self, batch: &mut AiStreamChunkBatch) {
        if !batch.delta.is_empty() || batch.reasoning.is_some() {
            self.emit_chunk(AiStreamChunk {
                session_id: self.session_id.clone(),
                delta: std::mem::take(&mut batch.delta),
                reasoning_delta: batch.reasoning.take(),
                done: false,
            });
        }
        batch.last_emit = Some(std::time::Instant::now());
    }

    fn emit_chunk(&self, chunk: AiStreamChunk) {
        let _ = self.app.emit("ai-stream-chunk", &chunk);
    }
}

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
    schema: Option<String>,
    db_type: String,
    mode: Option<String>,
    allow_write_sql: Option<bool>,
    confirmed_write_sql: Option<String>,
    confirmed_connection_id: Option<String>,
    confirmed_database: Option<String>,
    confirmed_schema: Option<String>,
) -> Result<String, String> {
    let mut request = resolve_cli_provider_request(request);
    merge_global_max_retries(
        &mut request.config,
        state.storage.load_max_retries().await.unwrap_or(dbx_core::ai::DEFAULT_MAX_RETRIES),
    );

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
        confirmed_schema,
        &connection_id,
        &database,
        schema.as_deref(),
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
        schema,
        db_type: parsed_db_type,
        cli_mcp_server_command,
        sql_permissions,
        max_agent_turns,
    };
    let is_agent_mode = mode.as_deref() == Some("agent");

    let emitter = AiAgentEventBatcher::new(app.clone(), session_id.clone());
    let result = run_agent_loop(
        &request.config,
        &request.system_prompt,
        &request.messages,
        &agent_ctx,
        {
            let emitter = emitter.clone();
            move |event: AgentEvent| emitter.handle(event)
        },
        &cancelled,
        request.max_tokens,
        request.task_contract.as_ref(),
        is_agent_mode,
    )
    .await;
    // Emit tail deltas the interval gate was still holding when the loop ended
    // (e.g. an error return that produced no terminal AgentEvent).
    emitter.flush();

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
        AiProvider::PiAgentCli => (&mut config.pi_agent_cli_path, "pi"),
        AiProvider::OpenCodeCli => (&mut config.opencode_cli_path, "opencode"),
        AiProvider::CursorCli => (&mut config.cursor_cli_path, "agent"),
        AiProvider::GrokCli => (&mut config.grok_cli_path, "grok"),
        AiProvider::CodeBuddyCli => (&mut config.codebuddy_cli_path, "codebuddy"),
        AiProvider::QoderCli => (&mut config.qoder_cli_path, "qodercli"),
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

#[tauri::command]
pub async fn save_ai_run(state: State<'_, Arc<AppState>>, run: AiRun) -> Result<(), String> {
    state.storage.save_ai_run(&run).await
}

#[tauri::command]
pub async fn save_ai_run_state(
    state: State<'_, Arc<AppState>>,
    conversation: AiConversation,
    run: AiRun,
) -> Result<(), String> {
    state.storage.save_ai_run_state(&conversation, &run).await
}

#[tauri::command]
pub async fn load_ai_runs(state: State<'_, Arc<AppState>>) -> Result<Vec<AiRun>, String> {
    state.storage.load_ai_runs().await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use tauri::{Listener, Manager};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::super::connection::AppState;
    use dbx_core::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiProvider, AiReasoningLevel};

    /// Captures the JSON payload of every `event_name` emission on a mock app.
    fn captured_events(
        event_name: &'static str,
    ) -> (tauri::AppHandle<tauri::test::MockRuntime>, Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let received: Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = received.clone();
        handle.listen(event_name, move |event| {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                sink.lock().unwrap().push(value);
            }
        });
        (handle, received)
    }

    #[test]
    fn ai_agent_event_batcher_coalesces_deltas_between_intervals() {
        use super::AiAgentEventBatcher;
        use dbx_core::agent_events::AgentEvent;

        let (handle, received) = captured_events("ai-agent-event");
        let batcher = AiAgentEventBatcher::new(handle, "session-1".to_string());
        // Leading delta flushes immediately.
        batcher.handle(AgentEvent::TextDelta { delta: "a".to_string() });
        // Follow-up deltas within the interval are held …
        batcher.handle(AgentEvent::TextDelta { delta: "b".to_string() });
        batcher.handle(AgentEvent::ReasoningDelta { delta: "r1".to_string() });
        // … and released as one batch each before a non-delta event, so event
        // ordering (and the exact-replace semantics of confirmation events on
        // the frontend) is preserved.
        batcher.handle(AgentEvent::TurnStart { turn: 1 });

        let observed: Vec<(String, String)> = received
            .lock()
            .unwrap()
            .iter()
            .map(|value| {
                let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let delta = value.get("delta").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                (kind, delta)
            })
            .collect();
        assert_eq!(
            observed,
            vec![
                ("text_delta".to_string(), "a".to_string()),
                ("text_delta".to_string(), "b".to_string()),
                ("reasoning_delta".to_string(), "r1".to_string()),
                ("turn_start".to_string(), String::new()),
            ]
        );

        // Tail deltas the interval gate is still holding flush at stream end.
        received.lock().unwrap().clear();
        batcher.handle(AgentEvent::TextDelta { delta: "c".to_string() });
        batcher.flush();
        let observed: Vec<(String, String)> = received
            .lock()
            .unwrap()
            .iter()
            .map(|value| {
                let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let delta = value.get("delta").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                (kind, delta)
            })
            .collect();
        assert_eq!(observed, vec![("text_delta".to_string(), "c".to_string())]);
    }

    #[test]
    fn ai_agent_event_batcher_merges_held_deltas_after_interval() {
        use super::AiAgentEventBatcher;
        use dbx_core::agent_events::AgentEvent;

        let (handle, received) = captured_events("ai-agent-event");
        let batcher = AiAgentEventBatcher::new(handle, "session-1".to_string());
        batcher.handle(AgentEvent::TextDelta { delta: "a".to_string() });
        batcher.handle(AgentEvent::TextDelta { delta: "b".to_string() });
        std::thread::sleep(super::AI_DELTA_EMIT_INTERVAL + std::time::Duration::from_millis(20));
        batcher.handle(AgentEvent::TextDelta { delta: "c".to_string() });

        let deltas: Vec<String> = received
            .lock()
            .unwrap()
            .iter()
            .filter(|value| value.get("type").and_then(|v| v.as_str()) == Some("text_delta"))
            .filter_map(|value| value.get("delta").and_then(|v| v.as_str()).map(ToString::to_string))
            .collect();
        assert_eq!(deltas, vec!["a".to_string(), "bc".to_string()]);
    }

    #[test]
    fn ai_stream_chunk_batcher_merges_deltas_and_forwards_done() {
        use super::AiStreamChunkBatcher;

        let (handle, received) = captured_events("ai-stream-chunk");
        let batcher = AiStreamChunkBatcher::new(handle, "session-2".to_string());
        batcher.handle(super::AiStreamChunk {
            session_id: "session-2".to_string(),
            delta: "a".to_string(),
            reasoning_delta: None,
            done: false,
        });
        // Held within the interval …
        batcher.handle(super::AiStreamChunk {
            session_id: "session-2".to_string(),
            delta: "b".to_string(),
            reasoning_delta: Some("r".to_string()),
            done: false,
        });
        // … and flushed in order before the terminal chunk is forwarded.
        batcher.handle(super::AiStreamChunk {
            session_id: "session-2".to_string(),
            delta: String::new(),
            reasoning_delta: None,
            done: true,
        });

        let observed: Vec<(String, Option<String>, bool)> = received
            .lock()
            .unwrap()
            .iter()
            .map(|value| {
                let delta = value.get("delta").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let reasoning = value.get("reasoning_delta").and_then(|v| v.as_str()).map(ToString::to_string);
                let done = value.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                (delta, reasoning, done)
            })
            .collect();
        assert_eq!(
            observed,
            vec![
                ("a".to_string(), None, false),
                ("b".to_string(), Some("r".to_string()), false),
                (String::new(), None, true),
            ]
        );
    }

    /// Spawn a TCP server that returns 429 and counts connections.
    async fn counting_429_server() -> (String, Arc<AtomicU32>, tokio::task::JoinHandle<()>) {
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
        (url, count, srv)
    }

    fn test_ai_config(endpoint: &str, model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::Claude,
            api_key: "sk-test".to_string(),
            auth_method: AiAuthMethod::ApiKey,
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            models: vec![],
            api_style: AiApiStyle::AnthropicMessages,
            custom_headers: Default::default(),
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
            opencode_cli_path: None,
            opencode_cli_env: Default::default(),
            cursor_cli_path: None,
            cursor_cli_env: Default::default(),
            grok_cli_path: None,
            grok_cli_env: Default::default(),
            codebuddy_cli_path: None,
            codebuddy_cli_env: Default::default(),
            qoder_cli_path: None,
            qoder_cli_env: Default::default(),
        }
    }

    #[test]
    fn verify_confirmed_target_allows_matching_connection_and_database() {
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(true),
            Some("DELETE FROM users WHERE id = 1".to_string()),
            Some("conn-1".to_string()),
            Some("app".to_string()),
            None,
            "conn-1",
            "app",
            None,
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
            None,
            "conn-production",
            "app",
            None,
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
            None,
            "conn-1",
            "production",
            None,
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
            None,
            "conn-production",
            "production",
            None,
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
            None,
            "conn-1",
            "app",
            None,
        );
        assert_eq!(allow, Some(false));
        assert_eq!(confirmed, None);
    }

    #[test]
    fn verify_confirmed_target_rejects_mismatched_schema() {
        let (allow, confirmed) = dbx_core::agent_tools::verify_confirmed_target(
            Some(true),
            Some("DELETE FROM users WHERE id = 1".to_string()),
            Some("conn-1".to_string()),
            Some("APPDB".to_string()),
            Some("APP_USER".to_string()),
            "conn-1",
            "APPDB",
            Some("REPORTING"),
        );
        assert_eq!(allow, Some(false));
        assert_eq!(confirmed, None);
    }

    #[tokio::test]
    async fn tauri_entry_respects_global_max_retries_zero() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-mr-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let storage = dbx_core::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        storage.save_max_retries(0).await.unwrap();
        assert_eq!(storage.load_max_retries().await.unwrap(), 0);

        let (url, count, srv) = counting_429_server().await;

        let app_state = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let app = tauri::test::mock_app();
        app.manage(app_state);

        let state: tauri::State<'_, Arc<AppState>> = app.state();
        let config = test_ai_config(&url, "claude-sonnet-4");
        let result = super::ai_test_connection(state, config).await;

        assert!(result.is_err(), "429 with max_retries=0 must fail, got: {result:?}");
        srv.abort();
        assert_eq!(count.load(Ordering::SeqCst), 1, "max_retries=0 must mean exactly 1 request");

        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
