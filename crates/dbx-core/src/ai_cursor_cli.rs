use crate::agent_events::AgentEvent;
use crate::ai::{AiConfig, AiEffortCapability, AiModelInfo, AiTestConnectionResult};
use crate::ai_cli_agent::{
    build_cli_agent_prompt, cli_command, dbx_mcp_enabled_tools, dbx_mcp_scope_env, parse_cli_jsonl_event,
    run_cli_jsonl_agent, CliAgentCommandSpec, CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

const CURSOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const CURSOR_CONTROL_ENV: &[&str] = &["CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"];

pub type CursorRunOptions = CliAgentRunOptions;
pub type CursorCommandSpec = CliAgentCommandSpec;

struct CursorIsolatedRuntime {
    root: PathBuf,
    workspace: PathBuf,
    config: PathBuf,
    data: PathBuf,
}

impl CursorIsolatedRuntime {
    fn create(options: Option<&CursorRunOptions>) -> Result<Self, String> {
        let root = env::temp_dir().join(format!("dbx-cursor-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        let cursor_dir = workspace.join(".cursor");
        let config = root.join("config");
        let data = root.join("data");
        for path in [&workspace, &cursor_dir, &config, &data] {
            std::fs::create_dir_all(path)
                .map_err(|error| format!("[cursorRunFailed] Failed to create isolated Cursor directory: {error}"))?;
        }

        if let Some(options) = options {
            Self::write_mcp_config(&cursor_dir, options)?;
            Self::write_permission_config(&cursor_dir, options.agent_mode)?;
        }

        Ok(Self { root, workspace, config, data })
    }

    fn write_mcp_config(cursor_dir: &Path, options: &CursorRunOptions) -> Result<(), String> {
        let command = options
            .mcp_server_command
            .as_ref()
            .cloned()
            .unwrap_or_else(|| CursorCommandSpec { program: "dbx-mcp-server".to_string(), args: Vec::new() });
        let env = dbx_mcp_scope_env(options).into_iter().collect::<BTreeMap<_, _>>();
        let config = json!({
            "mcpServers": {
                "dbx": {
                    "command": command.program,
                    "args": command.args,
                    "env": env
                }
            }
        });
        write_json_file(&cursor_dir.join("mcp.json"), &config, "Cursor MCP")
    }

    fn write_permission_config(cursor_dir: &Path, agent_mode: bool) -> Result<(), String> {
        let allow =
            dbx_mcp_enabled_tools(agent_mode).into_iter().map(|tool| format!("Mcp(dbx:{tool})")).collect::<Vec<_>>();
        let config = json!({
            "permissions": {
                "allow": allow,
                "deny": ["Shell(*)", "Read(*)", "Write(*)", "WebFetch(*)"]
            }
        });
        write_json_file(&cursor_dir.join("cli.json"), &config, "Cursor permission")
    }

    fn process_env(&self, config: &AiConfig) -> Result<Vec<(String, String)>, String> {
        let mut values = BTreeMap::from_iter(cursor_cli_env(config)?);
        values.insert("CURSOR_CONFIG_DIR".to_string(), self.config.to_string_lossy().to_string());
        values.insert("CURSOR_DATA_DIR".to_string(), self.data.to_string_lossy().to_string());
        Ok(values.into_iter().collect())
    }
}

impl Drop for CursorIsolatedRuntime {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_json_file(path: &Path, value: &Value, label: &str) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("[cursorRunFailed] Failed to serialize {label} configuration: {error}"))?;
    std::fs::write(path, content)
        .map_err(|error| format!("[cursorRunFailed] Failed to write {label} configuration: {error}"))
}

fn cursor_program(config: &AiConfig) -> String {
    config.cursor_cli_path.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or("agent").to_string()
}

fn resolve_cursor_command(config: &AiConfig) -> Result<CursorCommandSpec, String> {
    let program = cursor_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[cursorCliPathInvalid] Cursor CLI path should contain only the executable path. Add environment variables in the Cursor CLI environment variables section.".to_string());
    }

    let program = if is_path_like_program(&program) { crate::path_utils::expand_tilde(&program) } else { program };
    let path = Path::new(&program);
    if path.is_dir() {
        return ["agent", "cursor-agent"]
            .into_iter()
            .find_map(|name| launchable_program_in_dir(path, name))
            .map(|program| CursorCommandSpec { program, args: Vec::new() })
            .ok_or_else(|| {
                "[cursorCliPathInvalid] Cursor CLI path should point to the agent executable or a directory containing agent."
                    .to_string()
            });
    }
    if is_path_like_program(&program) && !path.is_file() {
        return Err("[cursorCliPathInvalid] Cursor CLI executable does not exist.".to_string());
    }
    Ok(CursorCommandSpec { program, args: Vec::new() })
}

fn launchable_program_in_dir(dir: &Path, program: &str) -> Option<String> {
    program_path_candidates(dir, program)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(not(windows))]
fn program_path_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    vec![dir.join(program)]
}

#[cfg(windows)]
fn program_path_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    [".exe", ".cmd", ".bat", ""].iter().map(|extension| dir.join(format!("{program}{extension}"))).collect()
}

fn is_path_like_program(program: &str) -> bool {
    program.contains('/') || program.contains('\\') || program.starts_with('~')
}

fn starts_with_env_assignment(program: &str) -> bool {
    let Some(first_token) = program.split_whitespace().next() else {
        return false;
    };
    let Some((key, _)) = first_token.split_once('=') else {
        return false;
    };
    is_env_var_name(key)
}

fn is_env_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic()) && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_reserved_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("DBX_MCP_") || CURSOR_CONTROL_ENV.iter().any(|reserved| upper == *reserved)
}

pub fn cursor_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut values = BTreeMap::new();
    for (key, value) in &config.cursor_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[cursorEnvInvalid] Invalid Cursor CLI environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        if is_reserved_env_name(key) {
            return Err(format!(
                "[cursorEnvReserved] `{key}` is managed by DBX for the isolated Cursor session and cannot be set here."
            ));
        }
        values.insert(key.to_string(), value.clone());
    }
    Ok(values.into_iter().collect())
}

fn cursor_selection_args(config: &AiConfig) -> Vec<String> {
    let model = config.model.trim();
    if model.is_empty() || model.eq_ignore_ascii_case("default") {
        Vec::new()
    } else {
        vec!["--model".to_string(), model.to_string()]
    }
}

pub fn build_cursor_command(config: &AiConfig, workspace: &Path) -> CursorCommandSpec {
    let mut command = CursorCommandSpec { program: cursor_program(config), args: Vec::new() };
    command.args.extend([
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--stream-partial-output".to_string(),
        "--approve-mcps".to_string(),
        "--trust".to_string(),
        "--workspace".to_string(),
        workspace.to_string_lossy().to_string(),
    ]);
    command.args.extend(cursor_selection_args(config));
    command
}

fn resolved_run_command(config: &AiConfig, workspace: &Path) -> Result<CursorCommandSpec, String> {
    let resolved = resolve_cursor_command(config)?;
    let mut command = build_cursor_command(config, workspace);
    command.program = resolved.program;
    command.args.splice(0..0, resolved.args);
    Ok(command)
}

pub fn build_cursor_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage], allow_write_sql: bool) -> String {
    build_cli_agent_prompt("Cursor", system_prompt, messages, allow_write_sql)
}

pub async fn list_cursor_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let runtime = CursorIsolatedRuntime::create(None)?;
    let command = resolve_cursor_command(config)?;
    let mut process = cli_command(&command.program);
    process.args(&command.args).arg("--list-models");
    for key in CURSOR_CONTROL_ENV {
        process.env_remove(key);
    }
    process.envs(runtime.process_env(config)?).current_dir(&runtime.workspace).kill_on_drop(true);
    let output = tokio::time::timeout(CURSOR_COMMAND_TIMEOUT, process.output())
        .await
        .map_err(|_| "[cursorTimeout] Cursor model discovery timed out".to_string())?
        .map_err(|error| classify_cursor_spawn_error(&error.to_string()))?;
    if !output.status.success() {
        return Err(classify_cursor_run_error(&combined_output(&output.stderr, &output.stdout)));
    }
    parse_cursor_models(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        "[cursorProtocolError] Cursor returned no models. Check the Cursor CLI version and authentication state."
            .to_string()
    })
}

fn parse_cursor_models(stdout: &str) -> Option<Vec<AiModelInfo>> {
    let mut models = Vec::new();
    let mut seen = BTreeSet::new();
    for line in stdout.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.eq_ignore_ascii_case("available models") {
            continue;
        }
        let Some((reported_id, label)) = line.split_once(" - ") else {
            continue;
        };
        let reported_id = reported_id.trim();
        if reported_id.is_empty() {
            continue;
        }
        let id = if reported_id.eq_ignore_ascii_case("auto") { "default" } else { reported_id };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let label = label.trim().trim_end_matches(" (current)").trim();
        let display_name = (!label.is_empty()).then(|| label.to_string());
        let mut info = AiModelInfo::new(id, display_name);
        info.effort_capability = Some(AiEffortCapability::Unsupported);
        models.push(info);
    }
    (!models.is_empty()).then_some(models)
}

pub async fn test_cursor_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    let runtime = CursorIsolatedRuntime::create(None)?;
    let command = resolve_cursor_command(config)?;
    let mut process = cli_command(&command.program);
    process.args(&command.args).args(["status", "--format", "json"]);
    for key in CURSOR_CONTROL_ENV {
        process.env_remove(key);
    }
    process.envs(runtime.process_env(config)?).current_dir(&runtime.workspace).kill_on_drop(true);
    let output = tokio::time::timeout(CURSOR_COMMAND_TIMEOUT, process.output())
        .await
        .map_err(|_| "[cursorTimeout] Cursor authentication check timed out".to_string())?
        .map_err(|error| classify_cursor_spawn_error(&error.to_string()))?;
    if !output.status.success() {
        return Err(classify_cursor_run_error(&combined_output(&output.stderr, &output.stdout)));
    }
    let status: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("[cursorProtocolError] Cursor returned invalid status JSON: {error}"))?;
    let authenticated = status
        .get("isAuthenticated")
        .or_else(|| status.get("is_authenticated"))
        .and_then(Value::as_bool)
        .or_else(|| {
            status.get("status").and_then(Value::as_str).map(|status| status.eq_ignore_ascii_case("authenticated"))
        })
        .unwrap_or(false);
    if !authenticated {
        return Err(
            "[cursorNotAuthenticated] Cursor CLI is not authenticated. Run `agent login`, then retry.".to_string()
        );
    }
    let elapsed = start.elapsed();
    Ok(AiTestConnectionResult {
        success: true,
        message: format!("OK - {}ms", elapsed.as_millis()),
        latency_ms: Some(elapsed.as_millis() as u64),
        model_used: config.model.trim().to_string(),
        error_category: None,
    })
}

fn combined_output(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    [stderr.trim(), stdout.trim()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n")
}

fn classify_cursor_spawn_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("no such file") || lower.contains("not found") || lower.contains("cannot find") {
        format!("[cursorNotInstalled] {message}")
    } else {
        format!("[cursorRunFailed] {message}")
    }
}

fn classify_cursor_run_error(message: &str) -> String {
    if message.starts_with("[cursor") || message.starts_with("[dbxMcpMissing]") {
        return message.to_string();
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("unauthorized")
        || lower.contains("please login")
        || lower.contains("please sign in")
    {
        format!("[cursorNotAuthenticated] {message}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] {message}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[cursorMcpStartupFailed] {message}")
    } else if lower.contains("json") || lower.contains("protocol") {
        format!("[cursorProtocolError] {message}")
    } else {
        format!("[cursorRunFailed] {message}")
    }
}

pub fn parse_cursor_jsonl_event(line: &str) -> Option<Vec<AgentEvent>> {
    parse_cli_jsonl_event(line, CliAgentJsonlDialect::CursorPrint)
}

pub async fn run_cursor_agent(
    config: &AiConfig,
    prompt: &str,
    options: CursorRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let runtime = CursorIsolatedRuntime::create(Some(&options))?;
    let result = run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command: resolved_run_command(config, &runtime.workspace)?,
            env: runtime.process_env(config)?,
            env_remove: CURSOR_CONTROL_ENV.iter().map(|value| (*value).to_string()).collect(),
            current_dir: Some(runtime.workspace.clone()),
            stdin: Some(prompt.to_string()),
            dialect: CliAgentJsonlDialect::CursorPrint,
            classify_spawn_error: classify_cursor_spawn_error,
            classify_run_error: classify_cursor_run_error,
        },
        cancelled,
        on_event,
    )
    .await?;
    if result.trim().is_empty() {
        Err("[cursorProtocolError] Cursor completed without a text response".to_string())
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiApiStyle, AiAuthMethod, AiProvider, AiReasoningLevel};
    use std::sync::{Arc, Mutex};

    fn config(model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::CursorCli,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: String::new(),
            model: model.to_string(),
            models: Vec::new(),
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
            opencode_cli_path: None,
            opencode_cli_env: Default::default(),
            cursor_cli_path: None,
            cursor_cli_env: Default::default(),
            grok_cli_path: None,
            grok_cli_env: Default::default(),
            codebuddy_cli_path: None,
            codebuddy_cli_env: Default::default(),
        }
    }

    #[test]
    fn default_command_uses_stream_json_and_stdin_mode() {
        let workspace = Path::new("/tmp/dbx-cursor-workspace");
        let command = build_cursor_command(&config("default"), workspace);
        assert_eq!(command.program, "agent");
        assert_eq!(
            command.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--stream-partial-output",
                "--approve-mcps",
                "--trust",
                "--workspace",
                "/tmp/dbx-cursor-workspace"
            ]
        );
    }

    #[test]
    fn explicit_model_is_forwarded() {
        let command = build_cursor_command(&config("composer-2.5"), Path::new("/tmp/workspace"));
        assert!(command.args.ends_with(&["--model".to_string(), "composer-2.5".to_string()]));
    }

    #[test]
    fn models_map_auto_to_default_and_strip_current_marker() {
        let models =
            parse_cursor_models("Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\n")
                .unwrap();
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["default", "composer-2.5"]);
        assert_eq!(models[1].display_name.as_deref(), Some("Composer 2.5"));
        assert!(models.iter().all(|model| model.effort_capability == Some(AiEffortCapability::Unsupported)));
    }

    #[test]
    fn cursor_env_rejects_runtime_and_mcp_overrides() {
        let mut invalid = config("default");
        invalid.cursor_cli_env.insert("CURSOR_DATA_DIR".to_string(), "/tmp/shared".to_string());
        assert!(cursor_cli_env(&invalid).unwrap_err().starts_with("[cursorEnvReserved]"));

        invalid.cursor_cli_env.clear();
        invalid.cursor_cli_env.insert("DBX_MCP_ALLOW_WRITES".to_string(), "1".to_string());
        assert!(cursor_cli_env(&invalid).unwrap_err().starts_with("[cursorEnvReserved]"));
    }

    #[test]
    fn cursor_stream_parser_ignores_buffered_assistant_copy() {
        let partial = parse_cursor_jsonl_event(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]},"timestamp_ms":1}"#,
        )
        .unwrap();
        assert!(matches!(&partial[0], AgentEvent::TextDelta { delta } if delta == "hello"));
        assert!(parse_cursor_jsonl_event(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#
        )
        .is_none());
    }

    #[test]
    fn cursor_stream_parser_maps_usage_and_tool_events() {
        let start = parse_cursor_jsonl_event(
            r#"{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"mcpToolCall":{"args":{"toolName":"dbx_list_tables","args":{"database":"main"}}}}}"#,
        )
        .unwrap();
        assert!(
            matches!(&start[0], AgentEvent::ToolCallStart { tool_call_id, tool_name, .. } if tool_call_id == "call-1" && tool_name == "dbx_list_tables")
        );

        let end = parse_cursor_jsonl_event(
            r#"{"type":"result","subtype":"success","is_error":false,"usage":{"inputTokens":10,"outputTokens":4}}"#,
        )
        .unwrap();
        assert!(matches!(&end[0], AgentEvent::AgentEnd { input_tokens: Some(10), output_tokens: Some(4) }));
    }

    #[test]
    fn isolated_runtime_writes_scoped_mcp_and_permissions() {
        let options = CursorRunOptions {
            connection_id: "sqlite-1".to_string(),
            connection_name: "SQLite".to_string(),
            database: "main".to_string(),
            schema: None,
            agent_mode: false,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CursorCommandSpec {
                program: "node".to_string(),
                args: vec!["server.js".to_string()],
            }),
        };
        let runtime = CursorIsolatedRuntime::create(Some(&options)).unwrap();
        let mcp: Value =
            serde_json::from_slice(&std::fs::read(runtime.workspace.join(".cursor/mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp.pointer("/mcpServers/dbx/command").and_then(Value::as_str), Some("node"));
        assert_eq!(
            mcp.pointer("/mcpServers/dbx/env/DBX_MCP_SCOPE_CONNECTION_ID").and_then(Value::as_str),
            Some("sqlite-1")
        );
        let permissions: Value =
            serde_json::from_slice(&std::fs::read(runtime.workspace.join(".cursor/cli.json")).unwrap()).unwrap();
        let allow = permissions.pointer("/permissions/allow").and_then(Value::as_array).unwrap();
        assert!(allow.iter().any(|value| value == "Mcp(dbx:dbx_list_connections)"));
        assert!(!allow.iter().any(|value| value == "Mcp(dbx:dbx_execute_query)"));
    }

    fn live_config() -> AiConfig {
        let mut config = config("default");
        config.cursor_cli_path = std::env::var("DBX_LIVE_CURSOR_PATH").ok();
        config
    }

    #[tokio::test]
    #[ignore = "requires an installed and authenticated Cursor CLI"]
    async fn live_model_discovery_and_connection_test() {
        let config = live_config();
        let models = list_cursor_models(&config).await.unwrap();
        assert!(models.iter().any(|model| model.id == "default"));
        let result = test_cursor_connection(&config).await.unwrap();
        assert!(result.success);
        assert!(result.latency_ms.is_some());
    }

    #[tokio::test]
    #[ignore = "requires Cursor, a running DBX MCP bridge, and DBX_LIVE_MCP_CONNECTION_NAME/DATABASE"]
    async fn live_scoped_dbx_mcp_agent_run() {
        let config = live_config();
        let connection_name = std::env::var("DBX_LIVE_MCP_CONNECTION_NAME")
            .expect("set DBX_LIVE_MCP_CONNECTION_NAME to a saved DBX connection");
        let database = std::env::var("DBX_LIVE_MCP_DATABASE").expect("set DBX_LIVE_MCP_DATABASE to a visible database");
        let mcp_command = std::env::var("DBX_LIVE_MCP_COMMAND").unwrap_or_else(|_| "dbx-mcp-server".to_string());
        let options = CursorRunOptions {
            connection_id: String::new(),
            connection_name: connection_name.clone(),
            database,
            schema: None,
            agent_mode: false,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CursorCommandSpec { program: mcp_command, args: Vec::new() }),
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let result = tokio::time::timeout(
            Duration::from_secs(90),
            run_cursor_agent(
                &config,
                "You must use the DBX MCP list-connections tool. Reply with the visible connection name only.",
                options,
                &Notify::new(),
                move |event| captured.lock().unwrap().push(event),
            ),
        )
        .await
        .expect("Cursor MCP smoke test timed out")
        .unwrap();

        assert!(result.contains(&connection_name));
        let events = events.lock().unwrap();
        assert!(
            events.iter().any(|event| {
                matches!(event, AgentEvent::ToolCallStart { tool_name, .. } if tool_name.contains("dbx_list_connections"))
            }),
            "Cursor events did not expose the expected DBX tool name: {events:#?}"
        );
    }
}
