use crate::agent_events::AgentEvent;
use crate::ai::{AiMessage, AiModelInfo};
use crate::token_usage::TokenUsage;
use serde_json::Value;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct CliAgentRunOptions {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub agent_mode: bool,
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
}

pub struct CliAgentProcessSpec {
    pub command: CliAgentCommandSpec,
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
    }
    tools
}

pub fn dbx_mcp_scope_env(options: &CliAgentRunOptions) -> Vec<(&'static str, String)> {
    vec![
        ("DBX_MCP_ALLOW_WRITES", "0".to_string()),
        ("DBX_MCP_SCOPE_CONNECTION_ID", options.connection_id.clone()),
        ("DBX_MCP_SCOPE_CONNECTION_NAME", options.connection_name.clone()),
        ("DBX_MCP_SCOPE_DATABASE", options.database.clone()),
    ]
}

pub fn append_config_overrides(args: &mut Vec<String>, overrides: impl IntoIterator<Item = String>) {
    for override_arg in overrides {
        args.push("-c".to_string());
        args.push(override_arg);
    }
}

pub fn build_cli_agent_prompt(provider_label: &str, system_prompt: &str, messages: &[AiMessage]) -> String {
    let mut sections = vec![
        format!("You are running inside DBX Desktop as the {provider_label} CLI provider."),
        "Use the DBX MCP tools when you need live database schema or read-only query results.".to_string(),
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
    ids.iter().map(|id| AiModelInfo { id: (*id).to_string(), display_name: None }).collect()
}

pub async fn list_json_models_or_default(
    program: String,
    args: impl IntoIterator<Item = String>,
    default_models: &[&str],
) -> Result<Vec<AiModelInfo>, String> {
    let output = Command::new(program).args(args).output().await;

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
        let mut result = vec![AiModelInfo { id: "default".to_string(), display_name: None }];
        result.extend(models.into_iter().map(|id| AiModelInfo { id, display_name: None }));
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
    item.get("result").or_else(|| item.get("output")).or_else(|| item.get("content")).cloned().unwrap_or(Value::Null)
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

pub async fn run_cli_jsonl_agent(
    spec: CliAgentProcessSpec,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let mut child = Command::new(&spec.command.program)
        .args(&spec.command.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| (spec.classify_spawn_error)(&e.to_string()))?;

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
                for event in parsed.events {
                    if matches!(event, AgentEvent::AgentEnd { .. }) {
                        saw_agent_end = true;
                    }
                    on_event(event);
                }
                if let Some(error) = parsed.error {
                    terminal_error = Some(error);
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
        on_event(AgentEvent::AgentEnd { input_tokens: None, output_tokens: None });
    }

    Ok(final_text)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
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
}
