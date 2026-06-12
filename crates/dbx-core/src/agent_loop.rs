use std::sync::Arc;

use futures::FutureExt;
use serde_json::json;
use tokio::sync::Notify;

use crate::agent_events::{AgentEvent, ToolCall, ToolDefinition};
use crate::agent_tools;
use crate::ai::{self, AiCompletionRequest, AiConfig, AiMessage, AiProvider, AiStreamChunk};
use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use tokio::sync::Mutex;

/// Maximum number of agent loop turns to prevent infinite loops.
const MAX_AGENT_TURNS: u32 = 10;

/// Context for an agent loop run.
pub struct AgentLoopContext {
    pub state: Arc<AppState>,
    pub connection_id: String,
    pub database: String,
    pub db_type: DatabaseType,
}

/// Check if the provider supports function calling / tool use.
/// Returns false for providers that are known to lack reliable tool support.
fn provider_supports_function_calling(config: &AiConfig) -> bool {
    match config.provider {
        // Ollama function calling support varies by model/version; conservative default is false.
        // Users with capable models can override via openai-compatible with an Ollama endpoint.
        AiProvider::Ollama => false,
        _ => true,
    }
}

/// Run the agent loop: call LLM with tools, execute tool calls, feed results back, repeat.
///
/// The `on_event` callback receives streaming events for the frontend.
/// Returns the final accumulated assistant text.
///
/// If the provider does not support function calling (e.g., Ollama), automatically
/// degrades to a text-only completion with schema context injected into the system prompt.
pub async fn run_agent_loop(
    config: &AiConfig,
    system_prompt: &str,
    messages: &[AiMessage],
    agent_ctx: &AgentLoopContext,
    on_event: impl Fn(AgentEvent) + Send + Sync + Clone + 'static,
    cancelled: &Notify,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<String, String> {
    // Auto-degrade: providers without function calling fall back to text-only completion.
    if !provider_supports_function_calling(config) {
        return run_agent_loop_text_only(
            config,
            system_prompt,
            messages,
            agent_ctx,
            on_event,
            cancelled,
            max_tokens,
            temperature,
        )
        .await;
    }
    let tools = agent_tools::read_only_tools();
    let mut conversation_messages: Vec<AiMessage> = messages.to_vec();
    let mut final_text = String::new();

    for turn in 0..MAX_AGENT_TURNS {
        // Check for cancellation before each turn
        if cancelled.notified().now_or_never().is_some() {
            on_event(AgentEvent::Error { message: "Agent loop cancelled".to_string() });
            break;
        }

        on_event(AgentEvent::TurnStart { turn });

        // Build the LLM request with tools
        let request =
            build_tool_request(config, system_prompt, &conversation_messages, &tools, max_tokens, temperature);

        // Stream the LLM response, collecting text and tool_calls
        let accumulated_text = Arc::new(Mutex::new(String::new()));
        let session_id = format!("agent-turn-{turn}");

        let acc = accumulated_text.clone();
        let on_event2 = on_event.clone();
        let on_chunk = move |chunk: AiStreamChunk| {
            if !chunk.delta.is_empty() {
                if let Ok(mut text) = acc.try_lock() {
                    text.push_str(&chunk.delta);
                }
                on_event2(AgentEvent::TextDelta { delta: chunk.delta.clone() });
            }
            if let Some(ref reasoning) = chunk.reasoning_delta {
                on_event2(AgentEvent::ReasoningDelta { delta: reasoning.clone() });
            }
        };

        // Call the LLM with tool support
        let collected_tool_calls = stream_with_tools(config, &request, &session_id, cancelled, on_chunk).await?;

        on_event(AgentEvent::TurnEnd { turn });

        let accumulated_text = accumulated_text.lock().await.clone();

        // Add assistant message to conversation (including tool_use blocks)
        conversation_messages.push(AiMessage {
            role: "assistant".to_string(),
            content: accumulated_text.clone(),
            tool_call_id: None,
            tool_calls: collected_tool_calls
                .iter()
                .map(|tc| ai::ToolCallRef { id: tc.id.clone(), name: tc.name.clone(), arguments: tc.arguments.clone() })
                .collect(),
        });

        if collected_tool_calls.is_empty() {
            // No tool calls -- we're done
            final_text = accumulated_text;
            break;
        }

        // Execute each tool call
        for tc in &collected_tool_calls {
            on_event(AgentEvent::ToolCallStart {
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                args: tc.arguments.clone(),
            });

            let result = agent_tools::execute_tool(
                tc,
                &agent_ctx.state,
                &agent_ctx.connection_id,
                &agent_ctx.database,
                &agent_ctx.db_type,
            )
            .await;

            on_event(AgentEvent::ToolCallEnd {
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                result: json!({ "content": result.content }),
                is_error: result.is_error,
            });

            // Add tool result to conversation for the next LLM call
            // Uses "tool" role per OpenAI convention; provider-specific conversion
            // happens in ai::stream_with_tools when building provider API requests.
            conversation_messages.push(AiMessage {
                role: "tool".to_string(),
                content: result.content.clone(),
                tool_call_id: Some(tc.id.clone()),
                tool_calls: Vec::new(),
            });
        }

        final_text = accumulated_text;
    }

    on_event(AgentEvent::AgentEnd { total_tokens: None });
    Ok(final_text)
}

/// Build an LLM request that includes tool definitions.
fn build_tool_request(
    config: &AiConfig,
    system_prompt: &str,
    messages: &[AiMessage],
    _tools: &[ToolDefinition], // Tools are injected in ai::stream_with_tools, not via AiCompletionRequest.
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> AiCompletionRequest {
    // Note: tools are passed via the body, not via AiCompletionRequest.
    // The actual injection happens in stream_with_tools.
    AiCompletionRequest {
        config: config.clone(),
        system_prompt: system_prompt.to_string(),
        messages: messages.to_vec(),
        max_tokens: max_tokens.or(Some(4096)),
        temperature: temperature.or(Some(0.2)),
    }
}

/// Stream an LLM response with tool support, parsing tool_calls from SSE deltas.
///
/// True streaming: text, reasoning, and tool call arguments are all emitted
/// incrementally as they arrive from the provider.
async fn stream_with_tools(
    config: &AiConfig,
    request: &AiCompletionRequest,
    session_id: &str,
    cancelled: &Notify,
    on_chunk: impl Fn(AiStreamChunk) + Send + Sync + 'static,
) -> Result<Vec<ToolCall>, String> {
    let tools = agent_tools::read_only_tools();

    // Return early if the user cancelled before the LLM call started.
    if cancelled.notified().now_or_never().is_some() {
        return Err("Agent loop cancelled".to_string());
    }

    ai::stream_with_tools(config, request, session_id, &tools, cancelled, on_chunk).await
}

/// Text-only fallback for providers that don't support function calling.
///
/// Injects database schema context into the system prompt so the LLM can still
/// give informed answers, then performs a single non-streaming completion.
async fn run_agent_loop_text_only(
    config: &AiConfig,
    system_prompt: &str,
    messages: &[AiMessage],
    agent_ctx: &AgentLoopContext,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
    _cancelled: &Notify,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<String, String> {
    // Build a schema-enriched system prompt so the LLM can answer schema questions
    // even without tool access.
    let enriched_prompt = build_schema_prompt(agent_ctx, system_prompt).await;

    let request = AiCompletionRequest {
        config: config.clone(),
        system_prompt: enriched_prompt,
        messages: messages.to_vec(),
        max_tokens: max_tokens.or(Some(4096)),
        temperature: temperature.or(Some(0.2)),
    };

    // Use a non-streaming completion as the simplest fallback.
    let result = ai::complete(&request).await?;

    on_event(AgentEvent::TextDelta { delta: result.clone() });
    on_event(AgentEvent::AgentEnd { total_tokens: None });
    Ok(result)
}

/// Build a system prompt enriched with database schema information
/// for text-only mode where the LLM cannot use tools.
async fn build_schema_prompt(agent_ctx: &AgentLoopContext, system_prompt: &str) -> String {
    let mut enriched = system_prompt.to_string();

    // Fetch real schema data using the same core functions the tools would use
    let tables_result = crate::schema::list_tables_core(
        &agent_ctx.state,
        &agent_ctx.connection_id,
        &agent_ctx.database,
        "",
        None,
        Some(50), // smaller limit for prompt injection
    )
    .await;

    match tables_result {
        Ok(tables) if !tables.is_empty() => {
            enriched.push_str("\n\n## Database Schema (for context — no tools available)\n");
            enriched.push_str(&format!("Database: {}\n", agent_ctx.database));
            enriched.push_str("Tables:\n");
            for t in &tables {
                enriched.push_str(&format!("  - {} ({})", t.name, t.table_type));
                if let Some(ref comment) = t.comment {
                    if !comment.trim().is_empty() {
                        enriched.push_str(&format!(" — {}", comment.trim()));
                    }
                }
                enriched.push('\n');
            }
        }
        _ => {
            enriched.push_str("\n\n(Note: Unable to load database schema for this request.)\n");
        }
    }

    enriched
}
