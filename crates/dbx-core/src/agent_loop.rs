use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::future::join_all;
use futures::FutureExt;
use serde_json::json;
use tokio::sync::Notify;

use crate::agent_events::{AgentEvent, ToolCall, ToolDefinition, ToolResult};
use crate::agent_tools;
use crate::ai::{self, AiCompletionRequest, AiConfig, AiMessage, AiProvider, AiStreamChunk, AiTaskContract};
use crate::ai_cli_agent::CliAgentCommandSpec;
use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use crate::token_usage::TokenUsage;

/// Maximum number of agent loop turns to prevent infinite loops.
const MAX_AGENT_TURNS: u32 = 30;
const AGENT_CANCELLED_ERROR: &str = "Agent loop cancelled";
const MAX_TOOL_RESULT_CONTEXT_CHARS: usize = 12_000;
const TOOL_RESULT_HEAD_CHARS: usize = 4_000;
const TOOL_RESULT_TAIL_CHARS: usize = 4_000;
const TOOL_RESULT_SAMPLE_ITEMS: usize = 5;
const MAX_CONTRACT_REPAIR_ATTEMPTS: u32 = 2;

fn take_text(m: &std::sync::Mutex<String>) -> String {
    m.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

enum LoopExit {
    Completed,
    Cancelled,
    Interrupted(String),
    Exhausted,
}

impl LoopExit {
    fn should_break_turns(&self) -> bool {
        matches!(self, LoopExit::Cancelled | LoopExit::Interrupted(_))
    }
}

enum CompactResult {
    Skipped,
    Compacted,
    Cancelled,
}

/// Context for an agent loop run.
pub struct AgentLoopContext {
    pub state: Arc<AppState>,
    pub connection_id: String,
    pub database: String,
    pub db_type: DatabaseType,
    pub cli_mcp_server_command: Option<CliAgentCommandSpec>,
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
#[allow(clippy::too_many_arguments)]
pub async fn run_agent_loop(
    config: &AiConfig,
    system_prompt: &str,
    messages: &[AiMessage],
    agent_ctx: &AgentLoopContext,
    on_event: impl Fn(AgentEvent) + Send + Sync + Clone + 'static,
    cancelled: &Notify,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    task_contract: Option<&AiTaskContract>,
    is_agent_mode: bool,
) -> Result<String, String> {
    let contract_system_prompt = augment_system_prompt_with_task_contract(system_prompt, task_contract, is_agent_mode);
    let system_prompt = contract_system_prompt.as_str();

    if matches!(config.provider, AiProvider::CodexCli) {
        let connection_name = {
            let configs = agent_ctx.state.configs.read().await;
            configs
                .get(&agent_ctx.connection_id)
                .map(|config| config.name.clone())
                .unwrap_or_else(|| agent_ctx.connection_id.clone())
        };
        let prompt = crate::ai_codex_cli::build_codex_prompt(system_prompt, messages);
        return crate::ai_codex_cli::run_codex_agent(
            config,
            &prompt,
            crate::ai_codex_cli::CodexRunOptions {
                connection_id: agent_ctx.connection_id.clone(),
                connection_name,
                database: agent_ctx.database.clone(),
                agent_mode: is_agent_mode,
                mcp_server_command: agent_ctx.cli_mcp_server_command.clone(),
            },
            cancelled,
            on_event,
        )
        .await;
    }

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
            task_contract,
        )
        .await;
    }
    let tools = if is_agent_mode { agent_tools::all_tools(agent_ctx.db_type) } else { agent_tools::read_only_tools() };
    let task_contract = task_contract.cloned();
    let mut conversation_messages: Vec<AiMessage> = messages.to_vec();
    let mut final_text = String::new();
    let mut loop_exit = LoopExit::Exhausted;
    let mut total_usage = TokenUsage::default();
    let mut contract_repair_attempts = 0;

    for turn in 0..MAX_AGENT_TURNS {
        // Check for cancellation before each turn
        if cancelled.notified().now_or_never().is_some() {
            loop_exit = LoopExit::Cancelled;
            break;
        }

        // Check and maybe compact context
        if matches!(
            maybe_compact(
                config,
                system_prompt,
                &tools,
                &mut conversation_messages,
                max_tokens,
                &on_event,
                cancelled,
                false,
            )
            .await,
            CompactResult::Cancelled
        ) {
            loop_exit = LoopExit::Cancelled;
            break;
        }

        on_event(AgentEvent::TurnStart { turn });

        let mut stream_result: Option<(Vec<ToolCall>, Option<TokenUsage>, String)> = None;
        let mut last_stream_error: Option<String> = None;

        for attempt in 0..2 {
            // Build the LLM request with tools. Rebuild after retry compaction so the request
            // reflects the latest conversation_messages.
            let request = build_tool_request(
                config,
                system_prompt,
                &conversation_messages,
                &tools,
                max_tokens,
                temperature,
                task_contract.clone(),
            );

            // Stream the LLM response, collecting text and tool_calls.
            let accumulated_text = Arc::new(Mutex::new(String::new()));
            let emitted_any_chunk = Arc::new(AtomicBool::new(false));
            let session_id =
                if attempt == 0 { format!("agent-turn-{turn}") } else { format!("agent-turn-{turn}-retry") };

            let acc = accumulated_text.clone();
            let emitted = emitted_any_chunk.clone();
            let on_event2 = on_event.clone();
            let on_chunk = move |chunk: AiStreamChunk| {
                if !chunk.delta.is_empty() {
                    emitted.store(true, Ordering::Relaxed);
                    acc.lock().unwrap_or_else(|e| e.into_inner()).push_str(&chunk.delta);
                }
                if let Some(ref reasoning) = chunk.reasoning_delta {
                    emitted.store(true, Ordering::Relaxed);
                    on_event2(AgentEvent::ReasoningDelta { delta: reasoning.clone() });
                }
            };

            match stream_with_tools(config, &request, &session_id, &tools, cancelled, on_chunk).await {
                Ok((tool_calls, usage)) => {
                    let accumulated_text = take_text(&accumulated_text);
                    stream_result = Some((tool_calls, usage, accumulated_text));
                    break;
                }
                Err(err)
                    if attempt == 0 && is_context_length_error(&err) && !emitted_any_chunk.load(Ordering::Relaxed) =>
                {
                    last_stream_error = Some(err);
                    let compacted = maybe_compact(
                        config,
                        system_prompt,
                        &tools,
                        &mut conversation_messages,
                        max_tokens,
                        &on_event,
                        cancelled,
                        true,
                    )
                    .await;
                    match compacted {
                        CompactResult::Compacted => continue,
                        CompactResult::Cancelled => {
                            loop_exit = LoopExit::Cancelled;
                            break;
                        }
                        CompactResult::Skipped => {
                            final_text = take_text(&accumulated_text);
                            loop_exit =
                                LoopExit::Interrupted(last_stream_error.take().unwrap_or_else(|| {
                                    "LLM request failed after context compaction retry".to_string()
                                }));
                        }
                    }
                    break;
                }
                Err(err) if err == AGENT_CANCELLED_ERROR => {
                    final_text = take_text(&accumulated_text);
                    loop_exit = LoopExit::Cancelled;
                    break;
                }
                Err(err) => {
                    final_text = take_text(&accumulated_text);
                    loop_exit = LoopExit::Interrupted(err);
                    break;
                }
            }
        }

        if loop_exit.should_break_turns() {
            break;
        }

        let Some((collected_tool_calls, turn_usage, accumulated_text)) = stream_result else {
            return Err(
                last_stream_error.unwrap_or_else(|| "LLM request failed after context compaction retry".to_string())
            );
        };

        if let Some(usage) = turn_usage {
            total_usage.add(&usage);
        }

        on_event(AgentEvent::TurnEnd { turn });

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
            match validate_final_answer(task_contract.as_ref(), &accumulated_text) {
                FinalAnswerCheck::Satisfied => {
                    if !accumulated_text.is_empty() {
                        on_event(AgentEvent::TextDelta { delta: accumulated_text.clone() });
                    }
                    final_text = accumulated_text;
                    loop_exit = LoopExit::Completed;
                    break;
                }
                FinalAnswerCheck::NeedsRepair(reason) if contract_repair_attempts < MAX_CONTRACT_REPAIR_ATTEMPTS => {
                    contract_repair_attempts += 1;
                    conversation_messages.push(AiMessage {
                        role: "user".to_string(),
                        content: build_contract_repair_prompt(task_contract.as_ref(), is_agent_mode, &reason),
                        tool_call_id: None,
                        tool_calls: Vec::new(),
                    });
                    continue;
                }
                FinalAnswerCheck::NeedsRepair(reason) => {
                    let message = append_contract_failure_note(accumulated_text, &reason);
                    on_event(AgentEvent::TextDelta { delta: message.clone() });
                    final_text = message;
                    loop_exit = LoopExit::Completed;
                    break;
                }
            }
        }

        // Execute each tool call
        // Emit all ToolCallStart events first
        for tc in &collected_tool_calls {
            on_event(AgentEvent::ToolCallStart {
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                args: tc.arguments.clone(),
            });
        }

        // Execute tool calls: parallel for read tools, sequential for execute_query
        let state2 = Arc::clone(&agent_ctx.state);
        let conn2 = agent_ctx.connection_id.clone();
        let db2 = agent_ctx.database.clone();
        let db_type = agent_ctx.db_type;

        // Split by index into parallel and sequential groups using tool metadata
        let tool_parallel_map: std::collections::HashMap<&str, bool> =
            tools.iter().map(|t| (t.name, t.parallel_ok)).collect();
        let (parallel_indices, sequential_indices): (Vec<usize>, Vec<usize>) = (0..collected_tool_calls.len())
            .partition(|&i| *tool_parallel_map.get(collected_tool_calls[i].name.as_str()).unwrap_or(&false));

        let make_tc =
            |tc: &ToolCall| ToolCall { id: tc.id.clone(), name: tc.name.clone(), arguments: tc.arguments.clone() };

        // Run parallel group
        let parallel_futures: Vec<_> = parallel_indices
            .iter()
            .map(|&i| {
                let tc = make_tc(&collected_tool_calls[i]);
                let state = Arc::clone(&state2);
                let conn = conn2.clone();
                let db = db2.clone();
                async move { agent_tools::execute_tool(&tc, &state, &conn, &db, &db_type).await }
            })
            .collect();
        let parallel_results = join_all(parallel_futures).await;

        // Run sequential group one-by-one
        let mut sequential_results = Vec::with_capacity(sequential_indices.len());
        for &i in &sequential_indices {
            let tc = make_tc(&collected_tool_calls[i]);
            sequential_results.push(agent_tools::execute_tool(&tc, &state2, &conn2, &db2, &db_type).await);
        }

        // Merge results back into original order
        let mut results: Vec<Option<ToolResult>> = vec![None; collected_tool_calls.len()];
        for (pos, &i) in parallel_indices.iter().enumerate() {
            results[i] = Some(parallel_results[pos].clone());
        }
        for (pos, &i) in sequential_indices.iter().enumerate() {
            results[i] = Some(sequential_results[pos].clone());
        }
        let results: Vec<ToolResult> = results.into_iter().map(|r| r.unwrap()).collect();

        // Process results in order, emitting ToolCallEnd events
        for (tc, result) in collected_tool_calls.iter().zip(results) {
            on_event(AgentEvent::ToolCallEnd {
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                result: match &result.explain_data {
                    Some(ed) => json!({ "content": result.content, "explain_data": ed }),
                    None => json!({ "content": result.content }),
                },
                is_error: result.is_error,
            });
            conversation_messages.push(AiMessage {
                role: "tool".to_string(),
                content: tool_result_for_followup_context(&tc.name, &result.content),
                tool_call_id: Some(tc.id.clone()),
                tool_calls: Vec::new(),
            });
        }
    }

    match loop_exit {
        LoopExit::Completed => {}
        LoopExit::Cancelled => {
            let message = if final_text.trim().is_empty() {
                "Agent run was cancelled before producing output.".to_string()
            } else {
                "\n\nAgent run was cancelled. Partial output above was preserved.".to_string()
            };
            on_event(AgentEvent::TextDelta { delta: message.clone() });
            final_text.push_str(&message);
        }
        LoopExit::Interrupted(error) => {
            let message = if final_text.trim().is_empty() {
                format!("Agent stream stopped before completion: {error}.")
            } else {
                format!("\n\nAgent stream stopped before completion: {error}. Partial output above was preserved.")
            };
            on_event(AgentEvent::TextDelta { delta: message.clone() });
            final_text.push_str(&message);
        }
        LoopExit::Exhausted => {
            let message = if final_text.trim().is_empty() {
                format!("Agent reached the {MAX_AGENT_TURNS}-turn safety limit before producing output. Send Continue to let the agent keep working.")
            } else {
                format!(
                    "\n\nAgent reached the {MAX_AGENT_TURNS}-turn safety limit before a final answer. The partial output above was preserved; send Continue to let the agent keep working."
                )
            };
            on_event(AgentEvent::TextDelta { delta: message.clone() });
            final_text.push_str(&message);
        }
    }

    on_event(AgentEvent::AgentEnd {
        input_tokens: if total_usage.input_tokens > 0 { Some(total_usage.input_tokens) } else { None },
        output_tokens: if total_usage.output_tokens > 0 { Some(total_usage.output_tokens) } else { None },
    });
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
    task_contract: Option<AiTaskContract>,
) -> AiCompletionRequest {
    // Note: tools are passed via the body, not via AiCompletionRequest.
    // The actual injection happens in stream_with_tools.
    AiCompletionRequest {
        config: config.clone(),
        system_prompt: system_prompt.to_string(),
        messages: messages.to_vec(),
        task_contract,
        max_tokens: max_tokens.or(Some(4096)),
        temperature: temperature.or(Some(0.2)),
    }
}

fn augment_system_prompt_with_task_contract(
    system_prompt: &str,
    task_contract: Option<&AiTaskContract>,
    is_agent_mode: bool,
) -> String {
    let Some(contract) = task_contract else {
        return system_prompt.to_string();
    };

    let action = contract.action.as_deref().unwrap_or("unknown");
    let mode = contract.mode.as_deref().unwrap_or(if is_agent_mode { "agent" } else { "ask" });
    let user_request = contract.user_request.as_deref().unwrap_or("(not provided)");
    let mode_rule = if action_requires_sql_deliverable(action) {
        "This is a SQL-producing action: produce the final SQL in a fenced ```sql code block. Use tools only as intermediate evidence for schema/dialect; do not stop at a tool-result summary. In Agent mode, execute a query only when the original request explicitly asks for real data/results, not when it merely asks to generate SQL."
    } else if is_agent_mode {
        "For data-query intents, obtain real results with execute_query when safe; otherwise state the blocker."
    } else {
        "In Ask mode, produce SQL/explanation only and do not claim execution."
    };

    format!(
        "{system_prompt}\n\n[TASK CONTRACT]\n\
Original user request: {user_request}\n\
Action: {action}\n\
Mode: {mode}\n\
Tool results are intermediate evidence. Continue the original task after every tool call; never treat a tool-result summary as the final answer unless the user explicitly requested that summary.\n\
{mode_rule}\n\
If the final deliverable cannot be produced safely, state the exact missing information and ask one concise clarification question."
    )
}

#[derive(Debug, PartialEq, Eq)]
enum FinalAnswerCheck {
    Satisfied,
    NeedsRepair(String),
}

fn validate_final_answer(task_contract: Option<&AiTaskContract>, text: &str) -> FinalAnswerCheck {
    let Some(contract) = task_contract else {
        return FinalAnswerCheck::Satisfied;
    };

    let action = contract.action.as_deref().unwrap_or_default();
    if action_requires_sql_deliverable(action)
        && !contains_sql_deliverable(text)
        && !looks_like_blocker_or_clarification(text)
    {
        return FinalAnswerCheck::NeedsRepair(
            "SQL-producing actions require a final SQL code block, or a concise blocker/clarification when SQL cannot be produced safely.".to_string(),
        );
    }

    FinalAnswerCheck::Satisfied
}

fn build_contract_repair_prompt(task_contract: Option<&AiTaskContract>, is_agent_mode: bool, reason: &str) -> String {
    let action = task_contract.and_then(|c| c.action.as_deref()).unwrap_or("unknown");
    let mode = task_contract.and_then(|c| c.mode.as_deref()).unwrap_or(if is_agent_mode { "agent" } else { "ask" });
    let user_request = task_contract.and_then(|c| c.user_request.as_deref()).unwrap_or("(not provided)");
    let mode_rule = if action_requires_sql_deliverable(action) {
        "For this SQL-producing action, produce SQL in a fenced ```sql code block. Tool results are evidence only; do not answer by summarizing schema/tool output. Execute a query only when the original request explicitly asks for real data/results."
    } else if is_agent_mode {
        "If the original request asks for real data and it can be answered safely, call execute_query before the final answer."
    } else {
        "In Ask mode, generate SQL and concise explanation only; do not claim the SQL was executed."
    };

    format!(
        "[SYSTEM-GENERATED TASK CONTRACT CHECK]\n\
Your previous response did not satisfy the current task contract.\n\
Issue: {reason}\n\
Original user request: {user_request}\n\
Action: {action}\n\
Mode: {mode}\n\n\
Tool results in the conversation are intermediate evidence only. Continue the original user task; do not summarize tool results unless the user explicitly requested a summary.\n\
{mode_rule}\n\
Produce a final answer that satisfies the action contract now. If required tables/columns are missing or ambiguous, state exactly what is missing and ask one concise clarification question."
    )
}

fn action_requires_sql_deliverable(action: &str) -> bool {
    matches!(action.to_ascii_lowercase().as_str(), "generate" | "optimize" | "fix" | "convert" | "sampledata")
}

fn append_contract_failure_note(text: String, reason: &str) -> String {
    if text.trim().is_empty() {
        return format!("Unable to produce a contract-compliant final answer: {reason}");
    }

    format!("{text}\n\nTask contract warning: {reason}")
}

fn contains_sql_deliverable(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let mut rest = lower.as_str();

    while let Some(fence_start) = rest.find("```") {
        let after_open = &rest[fence_start + 3..];
        let Some(info_end) = after_open.find('\n') else {
            return false;
        };
        let info = after_open[..info_end].trim();
        let after_info = &after_open[info_end + 1..];
        let Some(fence_end) = after_info.find("```") else {
            return false;
        };
        let body = &after_info[..fence_end];

        if (info.is_empty() || info.starts_with("sql")) && contains_sql_keyword(body) {
            return true;
        }

        rest = &after_info[fence_end + 3..];
    }

    false
}

fn contains_sql_keyword(lower_text: &str) -> bool {
    lower_text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').any(|token| {
        matches!(
            token,
            "select" | "with" | "show" | "describe" | "explain" | "insert" | "update" | "delete" | "create" | "alter"
        )
    })
}

fn looks_like_blocker_or_clarification(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let markers = [
        "missing",
        "not enough",
        "cannot determine",
        "can't determine",
        "unable to determine",
        "which column",
        "please clarify",
        "need to know",
        "缺少",
        "不足",
        "无法确定",
        "不能确定",
        "没有找到",
        "未找到",
        "请确认",
        "请提供",
        "需要明确",
        "哪个字段",
    ];
    markers.iter().any(|marker| lower.contains(marker))
}

/// Stream an LLM response with tool support, parsing tool_calls from SSE deltas.
///
/// Reasoning and tool call arguments are emitted incrementally as they arrive.
/// Assistant text is buffered until it satisfies the task contract so an
/// intermediate tool-result summary is not shown as the final answer.
async fn stream_with_tools(
    config: &AiConfig,
    request: &AiCompletionRequest,
    session_id: &str,
    tools: &[ToolDefinition],
    cancelled: &Notify,
    on_chunk: impl Fn(AiStreamChunk) + Send + Sync + 'static,
) -> Result<(Vec<ToolCall>, Option<TokenUsage>), String> {
    // Return early if the user cancelled before the LLM call started.
    if cancelled.notified().now_or_never().is_some() {
        return Err(AGENT_CANCELLED_ERROR.to_string());
    }

    ai::stream_with_tools(config, request, session_id, tools, cancelled, on_chunk).await
}

fn is_context_length_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    [
        "context length",
        "context_length",
        "maximum context",
        "max context",
        "token limit",
        "too many tokens",
        "prompt is too long",
        "input is too long",
        "reduce the length",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

/// Text-only fallback for providers that don't support function calling.
///
/// Injects database schema context into the system prompt so the LLM can still
/// give informed answers, then performs a single non-streaming completion.
#[allow(clippy::too_many_arguments)]
async fn run_agent_loop_text_only(
    config: &AiConfig,
    system_prompt: &str,
    messages: &[AiMessage],
    agent_ctx: &AgentLoopContext,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
    _cancelled: &Notify,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    task_contract: Option<&AiTaskContract>,
) -> Result<String, String> {
    // Build a schema-enriched system prompt so the LLM can answer schema questions
    // even without tool access.
    let enriched_prompt = build_schema_prompt(agent_ctx, system_prompt).await;

    let mut request = AiCompletionRequest {
        config: config.clone(),
        system_prompt: enriched_prompt,
        messages: messages.to_vec(),
        task_contract: task_contract.cloned(),
        max_tokens: max_tokens.or(Some(4096)),
        temperature: temperature.or(Some(0.2)),
    };

    for attempt in 0..=MAX_CONTRACT_REPAIR_ATTEMPTS {
        // Use non-streaming completions so contract repair can suppress incomplete drafts.
        let result = ai::complete(&request).await?;
        match validate_final_answer(task_contract, &result) {
            FinalAnswerCheck::Satisfied => {
                on_event(AgentEvent::TextDelta { delta: result.clone() });
                on_event(AgentEvent::AgentEnd { input_tokens: None, output_tokens: None });
                return Ok(result);
            }
            FinalAnswerCheck::NeedsRepair(reason) if attempt < MAX_CONTRACT_REPAIR_ATTEMPTS => {
                request.messages.push(AiMessage {
                    role: "assistant".to_string(),
                    content: result,
                    tool_call_id: None,
                    tool_calls: Vec::new(),
                });
                request.messages.push(AiMessage {
                    role: "user".to_string(),
                    content: build_contract_repair_prompt(task_contract, false, &reason),
                    tool_call_id: None,
                    tool_calls: Vec::new(),
                });
            }
            FinalAnswerCheck::NeedsRepair(reason) => {
                let message = append_contract_failure_note(result, &reason);
                on_event(AgentEvent::TextDelta { delta: message.clone() });
                on_event(AgentEvent::AgentEnd { input_tokens: None, output_tokens: None });
                return Ok(message);
            }
        }
    }

    Err("Text-only agent fallback failed to produce a final answer".to_string())
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
        None,
        None,
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

/// Estimate text tokens conservatively for mixed English, Chinese, SQL, and JSON content.
fn estimate_text_tokens(text: &str) -> u32 {
    let chars = text.chars().count() as u32;
    if chars == 0 {
        return 0;
    }

    let non_ascii = text.chars().filter(|c| !c.is_ascii()).count() as u32;
    let alpha = non_ascii as f32 / chars as f32;
    let ascii_est = (text.len() as f32 / 3.5).ceil();
    let nonascii_est = (chars as f32 * 1.2).ceil();
    let estimated = (ascii_est * (1.0 - alpha) + nonascii_est * alpha).ceil() as u32;
    estimated.max(1)
}

fn estimate_message_tokens(message: &AiMessage) -> u32 {
    let mut tokens = estimate_text_tokens(&message.content) + 4;

    if let Some(tool_call_id) = &message.tool_call_id {
        tokens += estimate_text_tokens(tool_call_id) + 2;
    }

    for tool_call in &message.tool_calls {
        tokens += estimate_text_tokens(&tool_call.id) + estimate_text_tokens(&tool_call.name) + 4;
        if let Ok(args) = serde_json::to_string(&tool_call.arguments) {
            tokens += estimate_text_tokens(&args);
        }
    }

    tokens
}

/// Estimate tokens for a slice of messages.
fn estimate_tokens(messages: &[AiMessage]) -> u32 {
    messages.iter().map(estimate_message_tokens).sum()
}

fn estimate_tool_schema_tokens(tools: &[ToolDefinition]) -> u32 {
    tools
        .iter()
        .map(|tool| {
            let schema_tokens =
                serde_json::to_string(&tool.parameters).map(|schema| estimate_text_tokens(&schema)).unwrap_or_default();
            estimate_text_tokens(tool.name) + estimate_text_tokens(tool.description) + schema_tokens + 16
        })
        .sum()
}

fn estimate_current_prompt_tokens(system_prompt: &str, tools: &[ToolDefinition], messages: &[AiMessage]) -> u32 {
    estimate_text_tokens(system_prompt) + estimate_tool_schema_tokens(tools) + estimate_tokens(messages) + 16
}

/// Returns the context window size for a given model name.
fn context_window_for_model(model: &str) -> u32 {
    let m = model.to_lowercase();
    // GPT-4.1 family: 1M context
    if m.contains("gpt-4.1") {
        return 1_000_000;
    }
    if m.contains("claude") || m.contains("o1") || m.starts_with("o3") || m.starts_with("o4") {
        200_000
    } else if m.contains("gpt-4") {
        128_000
    } else if m.contains("gemini") {
        1_000_000
    } else {
        128_000
    }
}

fn prompt_budget(window: u32, max_tokens: Option<u32>) -> u32 {
    let output_reserve = max_tokens.unwrap_or(4096).min(window / 2);
    let safety_reserve = (window / 10).clamp(2048, 16_384).min(window / 2);
    window.saturating_sub(output_reserve).saturating_sub(safety_reserve)
}

fn keep_recent_budget(prompt_budget: u32) -> u32 {
    if prompt_budget <= 4096 {
        prompt_budget / 2
    } else {
        (prompt_budget * 6 / 10).clamp(4096, 50_000)
    }
}

const COMPACT_SYSTEM_PROMPT: &str = "\
You are a conversation summarizer. Produce a concise structured summary of the conversation \
provided. Format:\n\
## Progress\n## Key Decisions\n## Critical Context\n## Next Steps\n\
Be factual. No commentary.";

async fn maybe_compact(
    config: &AiConfig,
    system_prompt: &str,
    tools: &[ToolDefinition],
    messages: &mut Vec<AiMessage>,
    max_tokens: Option<u32>,
    on_event: &(impl Fn(AgentEvent) + Send + Sync),
    cancelled: &Notify,
    force: bool,
) -> CompactResult {
    let window = config.context_window.unwrap_or_else(|| context_window_for_model(&config.model));
    let budget = prompt_budget(window, max_tokens);
    let estimated_before = estimate_current_prompt_tokens(system_prompt, tools, messages);

    if !force && estimated_before <= budget {
        return CompactResult::Skipped;
    }

    if messages.len() <= 2 {
        return CompactResult::Skipped;
    }

    // Find cut point: keep a dynamic budget of recent messages and summarize older context.
    let keep_recent_tokens = if force { keep_recent_budget(budget) / 2 } else { keep_recent_budget(budget) };
    let mut recent_tokens = 0u32;
    let mut cut = messages.len();
    for i in (0..messages.len()).rev() {
        let t = estimate_message_tokens(&messages[i]);
        if recent_tokens + t > keep_recent_tokens && i > 0 {
            cut = i + 1;
            break;
        }
        recent_tokens += t;
        cut = i;
    }

    if cut >= messages.len() {
        cut = messages.len().saturating_sub(1);
    }

    let cut = adjust_cut_for_tool_pair_integrity(messages, cut);

    // Always keep messages[0] (the original user question) verbatim outside the summary.
    // Only summarize messages[1..cut].
    if cut <= 1 {
        return CompactResult::Skipped;
    }
    let summary_start = 1usize;

    let compacted_messages = cut - summary_start;

    let convo_text: String = messages[summary_start..cut].iter().map(format_message_for_summary).collect();

    let summary_request = AiCompletionRequest {
        config: config.clone(),
        system_prompt: COMPACT_SYSTEM_PROMPT.to_string(),
        messages: vec![AiMessage {
            role: "user".to_string(),
            content: format!("<conversation>\n{convo_text}</conversation>\n\nSummarize the above."),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }],
        task_contract: None,
        max_tokens: Some(1024),
        temperature: Some(0.1),
    };

    let summary = match cancelled.notified().now_or_never() {
        Some(_) => return CompactResult::Cancelled,
        None => match tokio::select! {
            result = ai::complete(&summary_request) => result,
            _ = cancelled.notified() => return CompactResult::Cancelled,
        } {
            Ok(s) => s,
            Err(_) => fallback_summary(messages, cut),
        },
    };

    let summary = if validate_summary(&summary) { summary } else { fallback_summary(messages, cut) };

    let summary_tokens = estimate_text_tokens(&summary) + 4;

    let summary_content = format!(
        "[SYSTEM-GENERATED CONTEXT SUMMARY - earlier conversation compressed; background only, not a new user request]\n\n{summary}"
    );

    messages.drain(summary_start..cut);
    messages.insert(
        summary_start,
        AiMessage {
            role: "user".to_string(),
            content: summary_content.clone(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        },
    );

    let estimated_after = estimate_current_prompt_tokens(system_prompt, tools, messages);

    on_event(AgentEvent::ContextCompacted {
        summary: summary_content,
        summary_tokens,
        compacted_messages,
        estimated_before,
        estimated_after,
    });
    CompactResult::Compacted
}

fn tool_result_for_followup_context(tool_name: &str, content: &str) -> String {
    let result = compact_tool_result_for_context(tool_name, content);
    format!(
        "[TOOL RESULT - INTERMEDIATE EVIDENCE]\n\
Tool: {tool_name}\n\
Use this result to continue the original user task. Do not summarize this tool result as the final answer unless the user explicitly asked for a tool-result or schema summary.\n\n\
{result}"
    )
}

fn compact_tool_result_for_context(tool_name: &str, content: &str) -> String {
    if content.chars().count() <= MAX_TOOL_RESULT_CONTEXT_CHARS {
        return content.to_string();
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(content) {
        return compact_json_tool_result(tool_name, content, &value);
    }

    compact_text_tool_result(tool_name, content)
}

fn compact_json_tool_result(tool_name: &str, original: &str, value: &serde_json::Value) -> String {
    let compacted = match value {
        serde_json::Value::Array(items) => json!({
            "type": "array",
            "totalItems": items.len(),
            "head": items.iter().take(TOOL_RESULT_SAMPLE_ITEMS).collect::<Vec<_>>(),
            "tail": items.iter().rev().take(TOOL_RESULT_SAMPLE_ITEMS).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
        }),
        serde_json::Value::Object(map) => {
            let mut object = serde_json::Map::new();
            object.insert("type".to_string(), json!("object"));
            object.insert("keys".to_string(), json!(map.keys().cloned().collect::<Vec<_>>()));
            for (key, field_value) in map {
                match field_value {
                    serde_json::Value::Array(items) if items.len() > TOOL_RESULT_SAMPLE_ITEMS * 2 => {
                        object.insert(
                            key.clone(),
                            json!({
                                "totalItems": items.len(),
                                "head": items.iter().take(TOOL_RESULT_SAMPLE_ITEMS).collect::<Vec<_>>(),
                                "tail": items.iter().rev().take(TOOL_RESULT_SAMPLE_ITEMS).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
                            }),
                        );
                    }
                    _ => {
                        object.insert(key.clone(), field_value.clone());
                    }
                }
            }
            serde_json::Value::Object(object)
        }
        _ => value.clone(),
    };

    let compacted_text = serde_json::to_string_pretty(&compacted).unwrap_or_else(|_| compacted.to_string());
    if compacted_text.chars().count() <= MAX_TOOL_RESULT_CONTEXT_CHARS {
        format!(
            "[TOOL RESULT COMPACTED FOR CONTEXT]\nTool: {tool_name}\nOriginal chars: {}\nCompaction: parsed JSON with sampled arrays/fields. UI events preserve the full result.\n\n{}",
            original.chars().count(),
            compacted_text
        )
    } else {
        compact_text_tool_result(tool_name, original)
    }
}

fn compact_text_tool_result(tool_name: &str, content: &str) -> String {
    let original_chars = content.chars().count();
    let head = content.chars().take(TOOL_RESULT_HEAD_CHARS).collect::<String>();
    let tail_chars = content.chars().rev().take(TOOL_RESULT_TAIL_CHARS).collect::<Vec<_>>();
    let tail = tail_chars.into_iter().rev().collect::<String>();
    format!(
        "[TOOL RESULT COMPACTED FOR CONTEXT]\nTool: {tool_name}\nOriginal chars: {original_chars}\nCompaction: kept the head and tail; middle omitted. UI events preserve the full result.\n\n{head}\n\n...[middle omitted from tool result context]...\n\n{tail}"
    )
}

fn validate_summary(summary: &str) -> bool {
    let trimmed = summary.trim();
    trimmed.len() >= 50 && trimmed.len() <= 6000
}

fn fallback_summary(messages: &[AiMessage], cut: usize) -> String {
    // summary_start=1: messages[0] is kept verbatim, only messages[1..cut] are compacted.
    let compacted_messages = &messages[1..cut];
    let tool_calls = compacted_messages.iter().filter(|m| !m.tool_calls.is_empty()).count();
    let tool_results = compacted_messages.iter().filter(|m| m.role == "tool").count();
    let user_messages = compacted_messages.iter().filter(|m| m.role == "user").count();
    let assistant_messages = compacted_messages.iter().filter(|m| m.role == "assistant").count();

    let recent_roles = compacted_messages
        .iter()
        .rev()
        .take(8)
        .map(|message| format!("{}{}", message.role, if message.content.is_empty() { "" } else { ": content" }))
        .collect::<Vec<_>>()
        .join(", ");

    [
        "## Progress".to_string(),
        "- Context summarized by fallback generator because the LLM summary was unavailable or low quality.".to_string(),
        "## Key Decisions".to_string(),
        format!(
            "- Compacted {} messages: {} user, {} assistant, {} tool results, {} assistant tool-call messages.",
            compacted_messages.len(), user_messages, assistant_messages, tool_results, tool_calls
        ),
        "## Critical Context".to_string(),
        format!("- Recent compacted roles: {recent_roles}"),
        "## Next Steps".to_string(),
        "- Continue from the remaining recent conversation and recover any missing detail from tool handles or source paths if needed.".to_string(),
    ]
    .join("\n")
}

fn adjust_cut_for_tool_pair_integrity(messages: &[AiMessage], mut cut: usize) -> usize {
    if cut >= messages.len() {
        return cut;
    }

    while cut < messages.len() && messages[cut].role == "tool" {
        let Some(origin) = find_originating_assistant(messages, cut) else {
            break;
        };
        if origin >= cut {
            break;
        }
        cut = origin;
    }

    cut
}

fn find_originating_assistant(messages: &[AiMessage], tool_index: usize) -> Option<usize> {
    let tool_call_id = messages.get(tool_index)?.tool_call_id.as_deref();

    for i in (0..tool_index).rev() {
        let message = &messages[i];
        if message.role != "assistant" {
            continue;
        }

        if let Some(tool_call_id) = tool_call_id {
            if message.tool_calls.iter().any(|tool_call| tool_call.id == tool_call_id) {
                return Some(i);
            }
        } else if !message.tool_calls.is_empty() {
            return Some(i);
        }
    }

    None
}

fn format_message_for_summary(message: &AiMessage) -> String {
    let mut header = format!("[{}", message.role);
    if let Some(tool_call_id) = &message.tool_call_id {
        header.push_str(&format!(" tool_call_id={tool_call_id}"));
    }
    if !message.tool_calls.is_empty() {
        let tool_names =
            message.tool_calls.iter().map(|tool_call| tool_call.name.as_str()).collect::<Vec<_>>().join(", ");
        header.push_str(&format!(" tool_calls={tool_names}"));
    }
    header.push(']');

    format!("{header}: {}\n", summarize_message_content(&message.content))
}

fn summarize_message_content(content: &str) -> String {
    let char_count = content.chars().count();
    if char_count <= 4000 {
        return content.to_string();
    }

    let head = content.chars().take(1500).collect::<String>();
    let tail_chars = content.chars().rev().take(1500).collect::<Vec<_>>();
    let tail = tail_chars.into_iter().rev().collect::<String>();
    format!("{head}\n\n...[middle omitted for summary input]...\n\n{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generate_contract(user_request: &str, mode: &str) -> AiTaskContract {
        AiTaskContract {
            action: Some("generate".to_string()),
            mode: Some(mode.to_string()),
            user_request: Some(user_request.to_string()),
        }
    }

    #[test]
    fn generate_contract_rejects_schema_summary_without_sql() {
        let contract = generate_contract("帮我生成统计 2026年1月2日新注册会员数量的 sql", "ask");
        let answer = "The tb_customer table contains comprehensive customer information with key columns:\n\nCore Identity\n- c_no: customer id\nContact Information\n- c_tele: mobile";

        let check = validate_final_answer(Some(&contract), answer);

        assert!(matches!(check, FinalAnswerCheck::NeedsRepair(_)));
    }

    #[test]
    fn generate_contract_accepts_sql_code_block() {
        let contract = generate_contract("帮我生成统计新注册会员数量的 sql", "ask");
        let answer = "```sql\nSELECT COUNT(*) AS member_count FROM tb_customer WHERE created_at >= '2026-01-02' AND created_at < '2026-01-03';\n```";

        let check = validate_final_answer(Some(&contract), answer);

        assert_eq!(check, FinalAnswerCheck::Satisfied);
    }

    #[test]
    fn generate_contract_rejects_unfenced_sql_mention() {
        let contract = generate_contract("帮我生成统计新注册会员数量的 sql", "ask");
        let answer = "You can use SQL to query the table, for example SELECT COUNT(*) FROM tb_customer.";

        let check = validate_final_answer(Some(&contract), answer);

        assert!(matches!(check, FinalAnswerCheck::NeedsRepair(_)));
    }

    #[test]
    fn generate_contract_accepts_missing_column_blocker() {
        let contract = generate_contract("帮我生成统计新注册会员数量的 sql", "ask");
        let answer = "没有找到明确表示会员注册时间的字段，请确认应该使用哪个字段作为注册时间。";

        let check = validate_final_answer(Some(&contract), answer);

        assert_eq!(check, FinalAnswerCheck::Satisfied);
    }

    #[test]
    fn agent_generate_sql_accepts_sql_without_execute_query() {
        let contract = generate_contract("统计 2026年1月2日新注册会员数量", "agent");
        let answer = "```sql\nSELECT COUNT(*) FROM tb_customer;\n```";

        let check = validate_final_answer(Some(&contract), answer);

        assert_eq!(check, FinalAnswerCheck::Satisfied);
    }

    #[test]
    fn agent_generate_sql_prompt_does_not_force_execution() {
        let contract = generate_contract("帮我生成统计 2026年1月2日新注册会员数量的 sql", "agent");

        let prompt = augment_system_prompt_with_task_contract("base", Some(&contract), true);

        assert!(prompt.contains("SQL-producing action"));
        assert!(prompt.contains("execute a query only when the original request explicitly asks for real data/results"));
    }

    #[test]
    fn wraps_tool_results_as_intermediate_evidence() {
        let wrapped = tool_result_for_followup_context("get_columns", "Columns of tb_customer:\n  - c_no: VARCHAR");

        assert!(wrapped.contains("INTERMEDIATE EVIDENCE"));
        assert!(wrapped.contains("continue the original user task"));
        assert!(wrapped.contains("Columns of tb_customer"));
    }
}
