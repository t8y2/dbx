use crate::agent_events::AgentEvent;
use crate::ai::{AiMessage, AiModelInfo};
use crate::token_usage::TokenUsage;
use serde_json::Value;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct CliAgentRunOptions {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub schema: Option<String>,
    pub agent_mode: bool,
    pub allow_writes: bool,
    pub allow_dangerous: bool,
    /// When present, write/DDL execute_query calls in the MCP subprocess must
    /// match this SQL after trimming only surrounding whitespace.
    pub confirmed_write_sql: Option<String>,
    pub mcp_server_command: Option<CliAgentCommandSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliAgentCommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAgentJsonlDialect {
    CodexExec,
    ClaudeCodePrint,
    CodeBuddyPrint,
    OpenCodeRun,
    CursorPrint,
    /// Grok Build headless `--output-format streaming-json` (ACP-derived NDJSON).
    GrokStreamingJson,
}

pub struct CliAgentProcessSpec {
    pub command: CliAgentCommandSpec,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub stdin: Option<String>,
    pub dialect: CliAgentJsonlDialect,
    pub classify_spawn_error: fn(&str) -> String,
    pub classify_run_error: fn(&str) -> String,
}

pub fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

pub fn toml_string_array(values: &[&str]) -> String {
    let items = values.iter().map(|value| toml_string(value)).collect::<Vec<_>>().join(", ");
    format!("[{items}]")
}

pub fn dbx_mcp_enabled_tools(agent_mode: bool) -> Vec<&'static str> {
    let mut tools = vec!["dbx_list_connections", "dbx_list_tables", "dbx_describe_table", "dbx_get_schema_context"];
    if agent_mode {
        tools.push("dbx_execute_query");
        tools.push("dbx_execute_redis_command");
    }
    tools
}

pub fn dbx_mcp_scope_env(options: &CliAgentRunOptions) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("DBX_MCP_ALLOW_WRITES", if options.allow_writes { "1" } else { "0" }.to_string()),
        ("DBX_MCP_ALLOW_DANGEROUS_SQL", if options.allow_dangerous { "1" } else { "0" }.to_string()),
        ("DBX_MCP_SCOPE_CONNECTION_ID", options.connection_id.clone()),
        ("DBX_MCP_SCOPE_CONNECTION_NAME", options.connection_name.clone()),
        ("DBX_MCP_SCOPE_DATABASE", options.database.clone()),
    ];
    if let Some(schema) = options.schema.as_deref().filter(|schema| !schema.trim().is_empty()) {
        env.push(("DBX_MCP_SCOPE_SCHEMA", schema.to_string()));
    }
    if let Some(ref sql) = options.confirmed_write_sql {
        env.push(("DBX_MCP_CONFIRMED_WRITE_SQL", sql.clone()));
    }
    env
}

#[cfg(test)]
mod scope_env_tests {
    use super::*;

    #[test]
    fn confirmed_write_sql_is_passed_to_the_scoped_mcp_subprocess() {
        let options = CliAgentRunOptions {
            connection_id: "dameng-1".to_string(),
            connection_name: "Dameng".to_string(),
            database: "APPDB".to_string(),
            schema: Some("REPORTING".to_string()),
            agent_mode: true,
            allow_writes: true,
            allow_dangerous: true,
            confirmed_write_sql: Some("DELETE FROM sessions WHERE id = 7".to_string()),
            mcp_server_command: None,
        };

        let env = dbx_mcp_scope_env(&options);
        assert!(env.contains(&("DBX_MCP_CONFIRMED_WRITE_SQL", "DELETE FROM sessions WHERE id = 7".to_string())));
        assert!(env.contains(&("DBX_MCP_ALLOW_WRITES", "1".to_string())));
        assert!(env.contains(&("DBX_MCP_ALLOW_DANGEROUS_SQL", "1".to_string())));
        assert!(env.contains(&("DBX_MCP_SCOPE_DATABASE", "APPDB".to_string())));
        assert!(env.contains(&("DBX_MCP_SCOPE_SCHEMA", "REPORTING".to_string())));
    }
}

pub fn append_config_overrides(args: &mut Vec<String>, overrides: impl IntoIterator<Item = String>) {
    for override_arg in overrides {
        args.push("-c".to_string());
        args.push(override_arg);
    }
}

pub fn build_cli_agent_prompt(
    provider_label: &str,
    system_prompt: &str,
    messages: &[AiMessage],
    allow_write_sql: bool,
) -> String {
    let database_access = if allow_write_sql {
        "The user explicitly confirmed the proposed database change. DBX MCP tools may execute write and DDL SQL for this run only."
    } else {
        "Use the DBX MCP tools when you need live database schema or read-only query results."
    };
    let mut sections = vec![
        format!("You are running inside DBX Desktop as the {provider_label} CLI provider."),
        database_access.to_string(),
        "Do not modify files or run shell commands. The DBX MCP server is the only intended tool surface.".to_string(),
        String::new(),
        "## System instructions".to_string(),
        system_prompt.to_string(),
        String::new(),
        "## Conversation".to_string(),
    ];

    for message in messages {
        sections.push(format!("### {}", message.role));
        sections.push(message.content.clone());
        if !message.tool_calls.is_empty() {
            sections.push(format!("[Previous tool calls omitted from CLI replay: {}]", message.tool_calls.len()));
        }
        sections.push(String::new());
    }

    sections.join("\n")
}

pub fn model_infos(ids: &[&str]) -> Vec<AiModelInfo> {
    ids.iter().map(|id| AiModelInfo::new(*id, None)).collect()
}

pub fn cli_command(program: impl AsRef<OsStr>) -> Command {
    crate::process::new_tokio_command(program)
}

pub async fn list_json_models_or_default(
    program: String,
    args: impl IntoIterator<Item = String>,
    default_models: &[&str],
) -> Result<Vec<AiModelInfo>, String> {
    let output = cli_command(program).args(args).output().await;

    let Ok(output) = output else {
        return Ok(model_infos(default_models));
    };
    if !output.status.success() {
        return Ok(model_infos(default_models));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(data) = serde_json::from_str::<Value>(&stdout) else {
        return Ok(model_infos(default_models));
    };

    let mut models = Vec::new();
    collect_model_ids(&data, &mut models);
    models.sort();
    models.dedup();

    if models.is_empty() {
        Ok(model_infos(default_models))
    } else {
        let mut result = vec![AiModelInfo::new("default", None)];
        result.extend(models.into_iter().map(|id| AiModelInfo::new(id, None)));
        Ok(result)
    }
}

fn collect_model_ids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(id) = map.get("id").and_then(Value::as_str).or_else(|| map.get("name").and_then(Value::as_str))
            {
                if !id.trim().is_empty() {
                    out.push(id.to_string());
                }
            }
            for child in map.values() {
                collect_model_ids(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_model_ids(item, out);
            }
        }
        _ => {}
    }
}

#[derive(Default)]
struct ParsedCliAgentEvent {
    events: Vec<AgentEvent>,
    final_text: Option<String>,
    error: Option<String>,
    usage_delta: Option<TokenUsage>,
}

pub fn parse_cli_jsonl_event(line: &str, dialect: CliAgentJsonlDialect) -> Option<Vec<AgentEvent>> {
    let parsed = parse_cli_jsonl_line(line, dialect);
    if parsed.events.is_empty() {
        None
    } else {
        Some(parsed.events)
    }
}

fn parse_cli_jsonl_line(line: &str, dialect: CliAgentJsonlDialect) -> ParsedCliAgentEvent {
    match dialect {
        CliAgentJsonlDialect::CodexExec => parse_codex_jsonl_line(line),
        CliAgentJsonlDialect::ClaudeCodePrint => parse_claude_compatible_jsonl_line(line, "Claude Code CLI failed"),
        CliAgentJsonlDialect::CodeBuddyPrint => parse_claude_compatible_jsonl_line(line, "CodeBuddy Code CLI failed"),
        CliAgentJsonlDialect::OpenCodeRun => parse_open_code_jsonl_line(line),
        CliAgentJsonlDialect::CursorPrint => parse_cursor_jsonl_line(line),
        CliAgentJsonlDialect::GrokStreamingJson => parse_grok_streaming_json_line(line),
    }
}

fn parse_codex_jsonl_line(line: &str) -> ParsedCliAgentEvent {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedCliAgentEvent::default();
    };

    let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
    match event_type {
        "item.started" => parse_codex_item_started(&value),
        "item.completed" => parse_codex_item_completed(&value),
        "turn.completed" => parse_codex_turn_completed(&value),
        "turn.failed" | "error" => {
            let message = codex_error_message(&value);
            ParsedCliAgentEvent {
                error: Some(message.clone()),
                events: vec![AgentEvent::Error { message }],
                ..Default::default()
            }
        }
        _ => ParsedCliAgentEvent::default(),
    }
}

fn parse_codex_item_started(value: &Value) -> ParsedCliAgentEvent {
    let item = &value["item"];
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if is_mcp_tool_item(item_type) {
        ParsedCliAgentEvent {
            events: vec![AgentEvent::ToolCallStart {
                tool_call_id: cli_item_id(item),
                tool_name: cli_tool_name(item),
                args: cli_tool_args(item),
            }],
            ..Default::default()
        }
    } else {
        ParsedCliAgentEvent::default()
    }
}

fn parse_codex_item_completed(value: &Value) -> ParsedCliAgentEvent {
    let item = &value["item"];
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();

    if item_type == "agent_message" {
        if let Some(text) = cli_text(item) {
            return ParsedCliAgentEvent {
                final_text: Some(text.clone()),
                events: vec![AgentEvent::TextDelta { delta: text }],
                ..Default::default()
            };
        }
    }

    if item_type == "reasoning" {
        if let Some(text) = cli_text(item) {
            return ParsedCliAgentEvent {
                events: vec![AgentEvent::ReasoningDelta { delta: text }],
                ..Default::default()
            };
        }
    }

    if is_mcp_tool_item(item_type) {
        return ParsedCliAgentEvent {
            events: vec![AgentEvent::ToolCallEnd {
                tool_call_id: cli_item_id(item),
                tool_name: cli_tool_name(item),
                result: cli_tool_result(item),
                is_error: item.get("status").and_then(Value::as_str).map(|status| status == "failed").unwrap_or(false),
            }],
            ..Default::default()
        };
    }

    ParsedCliAgentEvent::default()
}

fn parse_codex_turn_completed(value: &Value) -> ParsedCliAgentEvent {
    let usage = value.get("usage").and_then(|usage| {
        let input =
            usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0)
                as u32;
        let output =
            usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0)
                as u32;
        (input > 0 || output > 0).then_some(TokenUsage { input_tokens: input, output_tokens: output })
    });

    ParsedCliAgentEvent {
        events: vec![AgentEvent::AgentEnd {
            input_tokens: usage.as_ref().and_then(|u| (u.input_tokens > 0).then_some(u.input_tokens)),
            output_tokens: usage.as_ref().and_then(|u| (u.output_tokens > 0).then_some(u.output_tokens)),
        }],
        ..Default::default()
    }
}

fn is_mcp_tool_item(item_type: &str) -> bool {
    item_type == "mcp_tool_call" || item_type == "mcp_tool" || item_type == "tool_call"
}

fn cli_item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("call_id").and_then(Value::as_str))
        .unwrap_or("cli-tool-call")
        .to_string()
}

fn cli_tool_name(item: &Value) -> String {
    item.get("tool_name")
        .and_then(Value::as_str)
        .or_else(|| item.get("tool").and_then(Value::as_str))
        .or_else(|| item.get("name").and_then(Value::as_str))
        .or_else(|| item.get("server_tool_name").and_then(Value::as_str))
        .unwrap_or("cli_tool")
        .to_string()
}

fn cli_tool_args(item: &Value) -> Value {
    item.get("arguments")
        .or_else(|| item.get("args"))
        .or_else(|| item.get("input"))
        .cloned()
        .unwrap_or(Value::Object(Default::default()))
}

fn cli_tool_result(item: &Value) -> Value {
    non_null_field(item, "result")
        .or_else(|| non_null_field(item, "output"))
        .or_else(|| non_null_field(item, "content"))
        .or_else(|| non_null_field(item, "error"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn non_null_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|field| !field.is_null())
}

fn cli_text(item: &Value) -> Option<String> {
    item.get("text")
        .and_then(Value::as_str)
        .or_else(|| item.get("message").and_then(Value::as_str))
        .or_else(|| item.get("content").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn codex_error_message(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.get("error").and_then(Value::as_str))
        .or_else(|| value.get("error").and_then(|e| e.get("message")).and_then(Value::as_str))
        .unwrap_or("CLI agent failed")
        .to_string()
}

fn parse_claude_compatible_jsonl_line(line: &str, fallback_error: &str) -> ParsedCliAgentEvent {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedCliAgentEvent::default();
    };

    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        "assistant" => parse_claude_code_assistant(&value),
        "user" => parse_claude_code_user(&value),
        "result" => parse_claude_code_result(&value, fallback_error),
        "error" => {
            let message = claude_code_error_message(&value, fallback_error);
            ParsedCliAgentEvent {
                error: Some(message.clone()),
                events: vec![AgentEvent::Error { message }],
                ..Default::default()
            }
        }
        _ => ParsedCliAgentEvent::default(),
    }
}

fn parse_claude_code_assistant(value: &Value) -> ParsedCliAgentEvent {
    let content = value.get("message").and_then(|message| message.get("content")).or_else(|| value.get("content"));
    let Some(content) = content else {
        return ParsedCliAgentEvent::default();
    };

    let mut events = Vec::new();
    let mut final_text = String::new();
    for block in claude_content_blocks(content) {
        match block.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                    final_text.push_str(text);
                    events.push(AgentEvent::TextDelta { delta: text.to_string() });
                }
            }
            "thinking" => {
                if let Some(text) = block.get("thinking").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                    events.push(AgentEvent::ReasoningDelta { delta: text.to_string() });
                }
            }
            "tool_use" => {
                events.push(AgentEvent::ToolCallStart {
                    tool_call_id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("claude-code-tool-call")
                        .to_string(),
                    tool_name: block.get("name").and_then(Value::as_str).unwrap_or("claude_code_tool").to_string(),
                    args: block.get("input").cloned().unwrap_or_else(|| Value::Object(Default::default())),
                });
            }
            _ => {}
        }
    }

    ParsedCliAgentEvent { final_text: (!final_text.is_empty()).then_some(final_text), events, ..Default::default() }
}

fn parse_claude_code_user(value: &Value) -> ParsedCliAgentEvent {
    let content = value.get("message").and_then(|message| message.get("content")).or_else(|| value.get("content"));
    let Some(content) = content else {
        return ParsedCliAgentEvent::default();
    };

    let mut events = Vec::new();
    for block in claude_content_blocks(content) {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        events.push(AgentEvent::ToolCallEnd {
            tool_call_id: block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .or_else(|| block.get("id").and_then(Value::as_str))
                .unwrap_or("claude-code-tool-call")
                .to_string(),
            tool_name: "mcp_tool".to_string(),
            result: block.get("content").cloned().unwrap_or(Value::Null),
            is_error: block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        });
    }

    ParsedCliAgentEvent { events, ..Default::default() }
}

fn parse_claude_code_result(value: &Value, fallback_error: &str) -> ParsedCliAgentEvent {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("success");
    if subtype != "success" {
        let message = claude_code_error_message(value, fallback_error);
        return ParsedCliAgentEvent {
            error: Some(message.clone()),
            events: vec![AgentEvent::Error { message }],
            ..Default::default()
        };
    }

    let usage = value.get("usage").and_then(|usage| {
        let input =
            usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0)
                as u32;
        let output =
            usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0)
                as u32;
        (input > 0 || output > 0).then_some(TokenUsage { input_tokens: input, output_tokens: output })
    });

    ParsedCliAgentEvent {
        events: vec![AgentEvent::AgentEnd {
            input_tokens: usage.as_ref().and_then(|u| (u.input_tokens > 0).then_some(u.input_tokens)),
            output_tokens: usage.as_ref().and_then(|u| (u.output_tokens > 0).then_some(u.output_tokens)),
        }],
        ..Default::default()
    }
}

fn claude_content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(blocks) => blocks.clone(),
        Value::String(text) => vec![serde_json::json!({ "type": "text", "text": text })],
        Value::Object(_) => vec![content.clone()],
        _ => Vec::new(),
    }
}

fn claude_code_error_message(value: &Value, fallback_error: &str) -> String {
    value
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .or_else(|| value.get("error").and_then(|error| error.get("message")).and_then(Value::as_str))
        .or_else(|| value.get("result").and_then(Value::as_str))
        .unwrap_or(fallback_error)
        .to_string()
}

fn parse_open_code_jsonl_line(line: &str) -> ParsedCliAgentEvent {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedCliAgentEvent::default();
    };

    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => {
            let Some(text) = value.pointer("/part/text").and_then(Value::as_str).filter(|text| !text.is_empty()) else {
                return ParsedCliAgentEvent::default();
            };
            ParsedCliAgentEvent {
                events: vec![AgentEvent::TextDelta { delta: text.to_string() }],
                final_text: Some(text.to_string()),
                ..Default::default()
            }
        }
        "reasoning" => {
            let Some(text) = value.pointer("/part/text").and_then(Value::as_str).filter(|text| !text.is_empty()) else {
                return ParsedCliAgentEvent::default();
            };
            ParsedCliAgentEvent {
                events: vec![AgentEvent::ReasoningDelta { delta: text.to_string() }],
                ..Default::default()
            }
        }
        "tool_use" => parse_open_code_tool(&value),
        "step_finish" => {
            let input = value.pointer("/part/tokens/input").and_then(Value::as_u64).unwrap_or(0) as u32;
            let output = value.pointer("/part/tokens/output").and_then(Value::as_u64).unwrap_or(0) as u32;
            ParsedCliAgentEvent {
                usage_delta: (input > 0 || output > 0)
                    .then_some(TokenUsage { input_tokens: input, output_tokens: output }),
                ..Default::default()
            }
        }
        "error" => {
            let message = open_code_error_message(&value);
            ParsedCliAgentEvent {
                error: Some(message.clone()),
                events: vec![AgentEvent::Error { message }],
                ..Default::default()
            }
        }
        _ => ParsedCliAgentEvent::default(),
    }
}

fn parse_open_code_tool(value: &Value) -> ParsedCliAgentEvent {
    let part = &value["part"];
    let state = &part["state"];
    let status = state.get("status").and_then(Value::as_str).unwrap_or_default();
    if status != "completed" && status != "error" {
        return ParsedCliAgentEvent::default();
    }

    let tool_call_id = part
        .get("callID")
        .and_then(Value::as_str)
        .or_else(|| part.get("call_id").and_then(Value::as_str))
        .or_else(|| part.get("id").and_then(Value::as_str))
        .unwrap_or("opencode-tool-call")
        .to_string();
    let tool_name = part.get("tool").and_then(Value::as_str).unwrap_or("opencode_tool").to_string();
    let args = state.get("input").cloned().unwrap_or_else(|| Value::Object(Default::default()));
    let result = state
        .get("output")
        .filter(|value| !value.is_null())
        .or_else(|| state.get("error").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or(Value::Null);

    ParsedCliAgentEvent {
        events: vec![
            AgentEvent::ToolCallStart { tool_call_id: tool_call_id.clone(), tool_name: tool_name.clone(), args },
            AgentEvent::ToolCallEnd { tool_call_id, tool_name, result, is_error: status == "error" },
        ],
        ..Default::default()
    }
}

fn open_code_error_message(value: &Value) -> String {
    value
        .pointer("/error/data/message")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/error/message").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))
        .or_else(|| value.get("error").and_then(Value::as_str))
        .unwrap_or("OpenCode CLI failed")
        .to_string()
}

fn parse_cursor_jsonl_line(line: &str) -> ParsedCliAgentEvent {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedCliAgentEvent::default();
    };

    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        "assistant" => parse_cursor_assistant(&value),
        "thinking" => parse_cursor_thinking(&value),
        "tool_call" => parse_cursor_tool_call(&value),
        "result" => parse_cursor_result(&value),
        "error" => {
            let message = cursor_error_message(&value);
            ParsedCliAgentEvent {
                error: Some(message.clone()),
                events: vec![AgentEvent::Error { message }],
                ..Default::default()
            }
        }
        _ => ParsedCliAgentEvent::default(),
    }
}

fn parse_cursor_assistant(value: &Value) -> ParsedCliAgentEvent {
    // Cursor emits timestamped partial assistant messages followed by one
    // un-timestamped buffered message. Only partials are deltas; consuming the
    // buffered copy would duplicate the entire response.
    if value.get("timestamp_ms").or_else(|| value.get("timestampMs")).is_none() {
        return ParsedCliAgentEvent::default();
    }
    let Some(content) = value.pointer("/message/content").or_else(|| value.get("content")) else {
        return ParsedCliAgentEvent::default();
    };
    let mut text = String::new();
    for block in claude_content_blocks(content) {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(delta) = block.get("text").and_then(Value::as_str).filter(|delta| !delta.is_empty()) {
                text.push_str(delta);
            }
        }
    }
    if text.is_empty() {
        return ParsedCliAgentEvent::default();
    }
    ParsedCliAgentEvent {
        events: vec![AgentEvent::TextDelta { delta: text.clone() }],
        final_text: Some(text),
        ..Default::default()
    }
}

fn parse_cursor_thinking(value: &Value) -> ParsedCliAgentEvent {
    if value.get("subtype").and_then(Value::as_str) != Some("delta") {
        return ParsedCliAgentEvent::default();
    }
    let Some(text) = value.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) else {
        return ParsedCliAgentEvent::default();
    };
    ParsedCliAgentEvent { events: vec![AgentEvent::ReasoningDelta { delta: text.to_string() }], ..Default::default() }
}

fn parse_cursor_tool_call(value: &Value) -> ParsedCliAgentEvent {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or_default();
    let call = value.get("tool_call").or_else(|| value.get("toolCall")).unwrap_or(&Value::Null);
    let payload = call.as_object().and_then(|object| object.values().next()).unwrap_or(call);
    let call_kind = call.as_object().and_then(|object| object.keys().next()).map(String::as_str);
    let tool_call_id = value
        .get("call_id")
        .or_else(|| value.get("callId"))
        .and_then(Value::as_str)
        .or_else(|| payload.get("call_id").and_then(Value::as_str))
        .or_else(|| payload.get("callId").and_then(Value::as_str))
        .unwrap_or("cursor-tool-call")
        .to_string();
    let tool_name = payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .or_else(|| payload.get("name"))
        .or_else(|| payload.get("tool"))
        .or_else(|| payload.pointer("/args/toolName"))
        .or_else(|| payload.pointer("/args/tool_name"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| call_kind.map(cursor_tool_name_from_kind))
        .unwrap_or_else(|| "cursor_tool".to_string());
    let args = payload
        .get("args")
        .or_else(|| payload.get("arguments"))
        .or_else(|| payload.get("input"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));

    match subtype {
        "started" => ParsedCliAgentEvent {
            events: vec![AgentEvent::ToolCallStart { tool_call_id, tool_name, args }],
            ..Default::default()
        },
        "completed" => {
            let result = payload
                .get("result")
                .or_else(|| payload.get("output"))
                .or_else(|| payload.get("error"))
                .cloned()
                .unwrap_or(Value::Null);
            let is_error = payload
                .get("is_error")
                .or_else(|| payload.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| payload.get("error").is_some_and(|error| !error.is_null()));
            ParsedCliAgentEvent {
                events: vec![AgentEvent::ToolCallEnd { tool_call_id, tool_name, result, is_error }],
                ..Default::default()
            }
        }
        _ => ParsedCliAgentEvent::default(),
    }
}

fn cursor_tool_name_from_kind(kind: &str) -> String {
    let stem = kind.strip_suffix("ToolCall").unwrap_or(kind);
    let mut name = String::new();
    for (index, ch) in stem.chars().enumerate() {
        if ch.is_ascii_uppercase() && index > 0 {
            name.push('_');
        }
        name.push(ch.to_ascii_lowercase());
    }
    name
}

fn parse_cursor_result(value: &Value) -> ParsedCliAgentEvent {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("success");
    let is_error = value.get("is_error").or_else(|| value.get("isError")).and_then(Value::as_bool).unwrap_or(false);
    if subtype != "success" || is_error {
        let message = cursor_error_message(value);
        return ParsedCliAgentEvent {
            error: Some(message.clone()),
            events: vec![AgentEvent::Error { message }],
            ..Default::default()
        };
    }
    let usage = value.get("usage");
    let input_tokens = usage
        .and_then(|usage| usage.get("inputTokens").or_else(|| usage.get("input_tokens")))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as u32);
    let output_tokens = usage
        .and_then(|usage| usage.get("outputTokens").or_else(|| usage.get("output_tokens")))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as u32);
    ParsedCliAgentEvent { events: vec![AgentEvent::AgentEnd { input_tokens, output_tokens }], ..Default::default() }
}

fn cursor_error_message(value: &Value) -> String {
    value
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .or_else(|| value.get("result").and_then(Value::as_str))
        .or_else(|| value.pointer("/error/message").and_then(Value::as_str))
        .unwrap_or("Cursor CLI failed")
        .to_string()
}

/// Parse Grok Build `--output-format streaming-json` NDJSON events.
///
/// Documented event types: `text`, `thought`, `tool_call`, `tool_call_update`,
/// `usage`, `plan`, `available_commands`, `end`, `error` (list is non-exhaustive).
fn parse_grok_streaming_json_line(line: &str) -> ParsedCliAgentEvent {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ParsedCliAgentEvent::default();
    };

    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => {
            let Some(text) = value.get("data").and_then(Value::as_str).filter(|text| !text.is_empty()) else {
                return ParsedCliAgentEvent::default();
            };
            ParsedCliAgentEvent {
                final_text: Some(text.to_string()),
                events: vec![AgentEvent::TextDelta { delta: text.to_string() }],
                ..Default::default()
            }
        }
        "thought" => {
            let Some(text) = value.get("data").and_then(Value::as_str).filter(|text| !text.is_empty()) else {
                return ParsedCliAgentEvent::default();
            };
            ParsedCliAgentEvent {
                events: vec![AgentEvent::ReasoningDelta { delta: text.to_string() }],
                ..Default::default()
            }
        }
        "tool_call" => {
            let status = value.get("status").and_then(Value::as_str).unwrap_or("in_progress");
            if status == "failed" || status == "error" {
                return parse_grok_tool_call_end(&value, true);
            }
            ParsedCliAgentEvent {
                events: vec![AgentEvent::ToolCallStart {
                    tool_call_id: grok_tool_call_id(&value),
                    tool_name: grok_tool_name(&value),
                    args: value
                        .get("rawInput")
                        .or_else(|| value.get("raw_input"))
                        .or_else(|| value.get("input"))
                        .cloned()
                        .unwrap_or_else(|| Value::Object(Default::default())),
                }],
                ..Default::default()
            }
        }
        "tool_call_update" => {
            let status = value.get("status").and_then(Value::as_str).unwrap_or("completed");
            let is_error = matches!(status, "failed" | "error" | "cancelled" | "rejected");
            if matches!(status, "in_progress" | "pending" | "running") {
                return ParsedCliAgentEvent::default();
            }
            parse_grok_tool_call_end(&value, is_error)
        }
        "end" => {
            let usage = value.get("usage").and_then(grok_usage_tokens);
            ParsedCliAgentEvent {
                events: vec![AgentEvent::AgentEnd {
                    input_tokens: usage.as_ref().and_then(|u| (u.input_tokens > 0).then_some(u.input_tokens)),
                    output_tokens: usage.as_ref().and_then(|u| (u.output_tokens > 0).then_some(u.output_tokens)),
                }],
                ..Default::default()
            }
        }
        "error" => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .or_else(|| value.get("data").and_then(Value::as_str))
                .unwrap_or("Grok CLI failed")
                .to_string();
            ParsedCliAgentEvent {
                error: Some(message.clone()),
                events: vec![AgentEvent::Error { message }],
                ..Default::default()
            }
        }
        _ => ParsedCliAgentEvent::default(),
    }
}

fn parse_grok_tool_call_end(value: &Value, is_error: bool) -> ParsedCliAgentEvent {
    let result = value
        .get("rawOutput")
        .or_else(|| value.get("raw_output"))
        .or_else(|| value.get("content"))
        .or_else(|| value.get("error"))
        .cloned()
        .unwrap_or(Value::Null);
    ParsedCliAgentEvent {
        events: vec![AgentEvent::ToolCallEnd {
            tool_call_id: grok_tool_call_id(value),
            tool_name: grok_tool_name(value),
            result,
            is_error,
        }],
        ..Default::default()
    }
}

fn grok_tool_call_id(value: &Value) -> String {
    value
        .get("toolCallId")
        .and_then(Value::as_str)
        .or_else(|| value.get("tool_call_id").and_then(Value::as_str))
        .or_else(|| value.get("id").and_then(Value::as_str))
        .unwrap_or("grok-tool-call")
        .to_string()
}

fn grok_tool_name(value: &Value) -> String {
    value
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| value.get("tool_name").and_then(Value::as_str))
        .or_else(|| value.get("title").and_then(Value::as_str))
        .or_else(|| value.get("name").and_then(Value::as_str))
        .unwrap_or("mcp_tool")
        .to_string()
}

fn grok_usage_tokens(usage: &Value) -> Option<TokenUsage> {
    let input =
        usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0) as u32;
    let output =
        usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0)
            as u32;
    (input > 0 || output > 0).then_some(TokenUsage { input_tokens: input, output_tokens: output })
}

pub async fn run_cli_jsonl_agent(
    spec: CliAgentProcessSpec,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let mut command = cli_command(&spec.command.program);
    command.args(&spec.command.args);
    for key in &spec.env_remove {
        command.env_remove(key);
    }
    command.envs(spec.env.iter().map(|(key, value)| (key.as_str(), value.as_str())));
    if let Some(current_dir) = &spec.current_dir {
        command.current_dir(current_dir);
    }
    let mut child = command
        .stdin(if spec.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| (spec.classify_spawn_error)(&e.to_string()))?;

    if let Some(input) = spec.stdin {
        let mut stdin = child.stdin.take().ok_or_else(|| "CLI agent stdin not available".to_string())?;
        stdin.write_all(input.as_bytes()).await.map_err(|e| format!("Failed to write CLI agent stdin: {e}"))?;
        stdin.shutdown().await.map_err(|e| format!("Failed to close CLI agent stdin: {e}"))?;
    }

    let stdout = child.stdout.take().ok_or_else(|| "Failed to capture CLI agent stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Failed to capture CLI agent stderr".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = String::new();
        let _ = reader.read_to_string(&mut buf).await;
        buf
    });

    let mut final_text = String::new();
    let mut saw_agent_end = false;
    let mut total_usage = TokenUsage::default();
    let mut terminal_error: Option<String> = None;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let line = match line {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(e) => {
                        terminal_error = Some(format!("CLI agent stream read failed: {e}"));
                        let _ = child.kill().await;
                        break;
                    }
                };
                let parsed = parse_cli_jsonl_line(&line, spec.dialect);
                if let Some(text) = parsed.final_text {
                    final_text.push_str(&text);
                }
                if let Some(usage) = parsed.usage_delta {
                    total_usage.add(&usage);
                }
                for event in parsed.events {
                    if matches!(event, AgentEvent::AgentEnd { .. }) {
                        saw_agent_end = true;
                    }
                    on_event(event);
                }
                if let Some(error) = parsed.error {
                    terminal_error = Some((spec.classify_run_error)(&error));
                    let _ = child.kill().await;
                    break;
                }
            }
            _ = cancelled.notified() => {
                terminal_error = Some("Agent loop cancelled".to_string());
                let _ = child.kill().await;
                break;
            }
        }
    }

    let status = child.wait().await.map_err(|e| format!("CLI agent wait failed: {e}"))?;
    let stderr = stderr_task.await.unwrap_or_default();

    if let Some(error) = terminal_error {
        return Err(error);
    }

    if !status.success() {
        return Err((spec.classify_run_error)(&stderr));
    }

    if !saw_agent_end {
        on_event(AgentEvent::AgentEnd {
            input_tokens: (total_usage.input_tokens > 0).then_some(total_usage.input_tokens),
            output_tokens: (total_usage.output_tokens > 0).then_some(total_usage.output_tokens),
        });
    }

    Ok(final_text)
}

#[cfg(test)]
mod grok_streaming_json_tests {
    use super::*;

    #[test]
    fn parses_text_thought_and_end_with_usage() {
        let text = parse_cli_jsonl_event(r#"{"type":"text","data":"hello"}"#, CliAgentJsonlDialect::GrokStreamingJson)
            .unwrap();
        assert!(matches!(&text[0], AgentEvent::TextDelta { delta } if delta == "hello"));

        let thought = parse_cli_jsonl_event(
            r#"{"type":"thought","data":"thinking..."}"#,
            CliAgentJsonlDialect::GrokStreamingJson,
        )
        .unwrap();
        assert!(matches!(&thought[0], AgentEvent::ReasoningDelta { delta } if delta == "thinking..."));

        let end = parse_cli_jsonl_event(
            r#"{"type":"end","stopReason":"end_turn","usage":{"input_tokens":10,"output_tokens":4}}"#,
            CliAgentJsonlDialect::GrokStreamingJson,
        )
        .unwrap();
        assert!(matches!(&end[0], AgentEvent::AgentEnd { input_tokens: Some(10), output_tokens: Some(4) }));
    }

    #[test]
    fn parses_tool_call_lifecycle() {
        let start = parse_cli_jsonl_event(
            r#"{"type":"tool_call","toolCallId":"call_1","toolName":"dbx__dbx_list_tables","status":"in_progress","rawInput":{"schema":"public"}}"#,
            CliAgentJsonlDialect::GrokStreamingJson,
        )
        .unwrap();
        assert!(matches!(
            &start[0],
            AgentEvent::ToolCallStart { tool_call_id, tool_name, args }
                if tool_call_id == "call_1"
                    && tool_name == "dbx__dbx_list_tables"
                    && args.get("schema").and_then(Value::as_str) == Some("public")
        ));

        let end = parse_cli_jsonl_event(
            r#"{"type":"tool_call_update","toolCallId":"call_1","toolName":"dbx__dbx_list_tables","status":"completed","rawOutput":{"tables":["users"]}}"#,
            CliAgentJsonlDialect::GrokStreamingJson,
        )
        .unwrap();
        assert!(matches!(
            &end[0],
            AgentEvent::ToolCallEnd { tool_call_id, is_error: false, .. } if tool_call_id == "call_1"
        ));

        assert!(parse_cli_jsonl_event(
            r#"{"type":"tool_call_update","toolCallId":"call_1","status":"in_progress"}"#,
            CliAgentJsonlDialect::GrokStreamingJson,
        )
        .is_none());
    }

    #[test]
    fn parses_error_event() {
        let parsed = parse_cli_jsonl_line(
            r#"{"type":"error","message":"auth failed"}"#,
            CliAgentJsonlDialect::GrokStreamingJson,
        );
        assert_eq!(parsed.error.as_deref(), Some("auth failed"));
        assert!(matches!(&parsed.events[0], AgentEvent::Error { message } if message == "auth failed"));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::time::{sleep, timeout, Duration};

    fn classify_spawn_error(message: &str) -> String {
        message.to_string()
    }

    fn classify_run_error(message: &str) -> String {
        message.to_string()
    }

    fn process_is_alive(pid: &str) -> bool {
        StdCommand::new("kill")
            .args(["-0", pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn jsonl_agent_applies_env_to_child() {
        let spec = CliAgentProcessSpec {
            command: CliAgentCommandSpec {
                program: "sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "printf '%s\n' \"{\\\"type\\\":\\\"item.completed\\\",\\\"item\\\":{\\\"type\\\":\\\"agent_message\\\",\\\"text\\\":\\\"$DBX_TEST_ENV\\\"}}\" \"{\\\"type\\\":\\\"turn.completed\\\"}\"".to_string(),
                ],
            },
            env: vec![("DBX_TEST_ENV".to_string(), "from-env".to_string())],
            env_remove: Vec::new(),
            current_dir: None,
            stdin: None,
            dialect: CliAgentJsonlDialect::CodexExec,
            classify_spawn_error,
            classify_run_error,
        };

        let result = run_cli_jsonl_agent(spec, &Notify::new(), |_| {}).await.unwrap();

        assert_eq!(result, "from-env");
    }

    #[tokio::test]
    async fn jsonl_agent_writes_stdin_to_child() {
        let spec = CliAgentProcessSpec {
            command: CliAgentCommandSpec {
                program: "sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "input=$(cat); printf '%s\n' \"{\\\"type\\\":\\\"item.completed\\\",\\\"item\\\":{\\\"type\\\":\\\"agent_message\\\",\\\"text\\\":\\\"$input\\\"}}\" \"{\\\"type\\\":\\\"turn.completed\\\"}\"".to_string(),
                ],
            },
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: None,
            stdin: Some("prompt from stdin".to_string()),
            dialect: CliAgentJsonlDialect::CodexExec,
            classify_spawn_error,
            classify_run_error,
        };

        let result = run_cli_jsonl_agent(spec, &Notify::new(), |_| {}).await.unwrap();

        assert_eq!(result, "prompt from stdin");
    }

    #[tokio::test]
    async fn opencode_agent_aggregates_step_usage_and_emits_one_agent_end() {
        let spec = CliAgentProcessSpec {
            command: CliAgentCommandSpec {
                program: "sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    concat!(
                        "printf '%s\\n' ",
                        "'{\"type\":\"step_finish\",\"part\":{\"tokens\":{\"input\":10,\"output\":2}}}' ",
                        "'{\"type\":\"text\",\"part\":{\"text\":\"hello\"}}' ",
                        "'{\"type\":\"step_finish\",\"part\":{\"tokens\":{\"input\":3,\"output\":4}}}'",
                    )
                    .to_string(),
                ],
            },
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: None,
            stdin: None,
            dialect: CliAgentJsonlDialect::OpenCodeRun,
            classify_spawn_error,
            classify_run_error,
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let result = run_cli_jsonl_agent(spec, &Notify::new(), move |event| {
            captured.lock().unwrap().push(event);
        })
        .await
        .unwrap();

        assert_eq!(result, "hello");
        let events = events.lock().unwrap();
        assert_eq!(events.iter().filter(|event| matches!(event, AgentEvent::AgentEnd { .. })).count(), 1);
        assert!(events
            .iter()
            .any(|event| { matches!(event, AgentEvent::AgentEnd { input_tokens: Some(13), output_tokens: Some(6) }) }));
    }

    #[tokio::test]
    async fn jsonl_error_kills_and_waits_for_child() {
        let pid_file = std::env::temp_dir().join(format!(
            "dbx-cli-agent-error-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let script = format!(
            "echo $$ > {}; printf '%s\\n' '{{\"type\":\"turn.failed\",\"message\":\"boom\"}}'; exec sleep 30",
            pid_file.display()
        );

        let spec = CliAgentProcessSpec {
            command: CliAgentCommandSpec { program: "sh".to_string(), args: vec!["-c".to_string(), script] },
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: None,
            stdin: None,
            dialect: CliAgentJsonlDialect::CodexExec,
            classify_spawn_error,
            classify_run_error,
        };

        let result = timeout(Duration::from_secs(3), run_cli_jsonl_agent(spec, &Notify::new(), |_| {}))
            .await
            .expect("runner should return after JSONL error");

        assert_eq!(result.unwrap_err(), "boom");
        sleep(Duration::from_millis(100)).await;
        let pid = std::fs::read_to_string(&pid_file).expect("child pid should be captured");
        assert!(!process_is_alive(pid.trim()));
        let _ = std::fs::remove_file(pid_file);
    }

    #[tokio::test]
    async fn jsonl_cancellation_kills_and_waits_for_child() {
        let pid_file = std::env::temp_dir().join(format!(
            "dbx-cli-agent-cancel-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let script = format!("echo $$ > {}; exec sleep 30", pid_file.display());

        let spec = CliAgentProcessSpec {
            command: CliAgentCommandSpec { program: "sh".to_string(), args: vec!["-c".to_string(), script] },
            env: Vec::new(),
            env_remove: Vec::new(),
            current_dir: None,
            stdin: None,
            dialect: CliAgentJsonlDialect::CodexExec,
            classify_spawn_error,
            classify_run_error,
        };
        let cancelled = Arc::new(Notify::new());
        let runner_cancelled = Arc::clone(&cancelled);
        let runner = tokio::spawn(async move { run_cli_jsonl_agent(spec, runner_cancelled.as_ref(), |_| {}).await });

        timeout(Duration::from_secs(3), async {
            while !pid_file.exists() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("child should start before cancellation");
        cancelled.notify_waiters();

        let result = timeout(Duration::from_secs(3), runner)
            .await
            .expect("runner should return after cancellation")
            .expect("runner task should not panic");
        assert_eq!(result.unwrap_err(), "Agent loop cancelled");
        sleep(Duration::from_millis(100)).await;
        let pid = std::fs::read_to_string(&pid_file).expect("child pid should be captured");
        assert!(!process_is_alive(pid.trim()));
        let _ = std::fs::remove_file(pid_file);
    }
}
