use crate::agent_events::AgentEvent;
use crate::ai::{
    AiCapabilitySource, AiConfig, AiEffortCapability, AiEffortSelection, AiModelInfo, AiTestConnectionResult,
    AGENT_CANCELLED_ERROR,
};
use crate::ai_cli_agent::{
    build_cli_agent_prompt, cli_command, dbx_mcp_enabled_tools, dbx_mcp_scope_env, CliAgentCommandSpec,
    CliAgentRunOptions,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Notify;

const PI_RPC_TIMEOUT: Duration = Duration::from_secs(15);
const PI_BRIDGE_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const PI_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const PI_MCP_BRIDGE: &str = include_str!("../assets/pi-mcp-bridge.mjs");
const PI_PRIVATE_ENV_PREFIX: &str = "DBX_PI_";

pub type PiAgentRunOptions = CliAgentRunOptions;

struct PiIsolatedRuntime {
    path: PathBuf,
    extension_path: PathBuf,
    ready_path: PathBuf,
}

impl PiIsolatedRuntime {
    fn create() -> Result<Self, String> {
        let path = env::temp_dir().join(format!("dbx-pi-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)
            .map_err(|error| format!("[piAgentRunFailed] Failed to create isolated Pi directory: {error}"))?;
        let extension_path = path.join("dbx-mcp-bridge.mjs");
        let ready_path = path.join("dbx-mcp-ready");
        std::fs::write(&extension_path, PI_MCP_BRIDGE)
            .map_err(|error| format!("[piAgentRunFailed] Failed to write Pi MCP bridge: {error}"))?;
        Ok(Self { path, extension_path, ready_path })
    }
}

impl Drop for PiIsolatedRuntime {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct PiRpcProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr: Arc<Mutex<String>>,
    next_id: u64,
}

impl PiRpcProcess {
    async fn spawn(
        config: &AiConfig,
        runtime: Option<&PiIsolatedRuntime>,
        apply_selection: bool,
    ) -> Result<Self, String> {
        let command = resolve_pi_command(config)?;
        let mut process = cli_command(&command.program);
        process
            .args(command.args.iter().map(String::as_str))
            .args(pi_rpc_args(runtime))
            .args(if apply_selection { pi_selection_args(config)? } else { Vec::new() })
            .envs(pi_agent_process_env(config, &command)?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(runtime) = runtime {
            process.current_dir(&runtime.path);
        }

        Self::spawn_command(process).await
    }

    async fn spawn_command(mut process: Command) -> Result<Self, String> {
        let mut child = process.spawn().map_err(|error| classify_pi_spawn_error(&error.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| "[piAgentRunFailed] Failed to open Pi RPC stdin".to_string())?;
        let stdout =
            child.stdout.take().ok_or_else(|| "[piAgentRunFailed] Failed to open Pi RPC stdout".to_string())?;
        let stderr_pipe =
            child.stderr.take().ok_or_else(|| "[piAgentRunFailed] Failed to open Pi RPC stderr".to_string())?;
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_capture = stderr.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr_pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut output = stderr_capture.lock().unwrap_or_else(|error| error.into_inner());
                output.push_str(&line);
                output.push('\n');
                if output.len() > 16_384 {
                    let drain_to = output.len() - 16_384;
                    output.drain(..drain_to);
                }
            }
        });

        Ok(Self { child, stdin: Some(stdin), stdout: BufReader::new(stdout).lines(), stderr, next_id: 1 })
    }

    fn stderr_text(&self) -> String {
        self.stderr.lock().unwrap_or_else(|error| error.into_inner()).trim().to_string()
    }

    async fn write(&mut self, value: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or_else(|| "[piAgentRunFailed] Pi RPC stdin is closed".to_string())?;
        let mut data = serde_json::to_vec(value).map_err(|error| format!("[piAgentProtocolError] {error}"))?;
        data.push(b'\n');
        stdin.write_all(&data).await.map_err(|error| classify_pi_run_error(&error.to_string()))?;
        stdin.flush().await.map_err(|error| classify_pi_run_error(&error.to_string()))
    }

    async fn request(&mut self, command_type: &str, data: Value) -> Result<(Value, Vec<Value>), String> {
        let id = format!("dbx-{}", self.next_id);
        self.next_id += 1;
        let mut request = match data {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        request.insert("id".to_string(), Value::String(id.clone()));
        request.insert("type".to_string(), Value::String(command_type.to_string()));
        self.write(&Value::Object(request)).await?;

        let mut events = Vec::new();
        let response = tokio::time::timeout(PI_RPC_TIMEOUT, async {
            loop {
                let line = self
                    .stdout
                    .next_line()
                    .await
                    .map_err(|error| classify_pi_run_error(&error.to_string()))?
                    .ok_or_else(|| {
                        let stderr = self.stderr_text();
                        classify_pi_run_error(if stderr.is_empty() { "Pi RPC stdout closed" } else { &stderr })
                    })?;
                let value: Value =
                    serde_json::from_str(&line).map_err(|error| format!("[piAgentProtocolError] {error}: {line}"))?;
                if value.get("type").and_then(Value::as_str) == Some("response")
                    && value.get("id").and_then(Value::as_str) == Some(id.as_str())
                {
                    return Ok::<Value, String>(value);
                }
                events.push(value);
            }
        })
        .await
        .map_err(|_| format!("[piAgentTimeout] Pi RPC command `{command_type}` timed out"))??;

        if response.get("success").and_then(Value::as_bool) == Some(false) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| response.pointer("/data/error").and_then(Value::as_str))
                .unwrap_or("Pi RPC command failed");
            return Err(classify_pi_run_error(message));
        }
        Ok((response.get("data").cloned().unwrap_or(Value::Null), events))
    }

    async fn shutdown(mut self) {
        self.stdin.take();
        if tokio::time::timeout(PI_SHUTDOWN_TIMEOUT, self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }

    async fn abort_and_shutdown(&mut self) {
        let id = format!("dbx-{}", self.next_id);
        self.next_id += 1;
        let _ = self.write(&json!({ "id": id, "type": "abort" })).await;
        self.stdin.take();
        if tokio::time::timeout(PI_SHUTDOWN_TIMEOUT, self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }
}

fn pi_rpc_args(runtime: Option<&PiIsolatedRuntime>) -> Vec<String> {
    let mut args = vec![
        "--mode".to_string(),
        "rpc".to_string(),
        "--no-session".to_string(),
        "--no-extensions".to_string(),
        "--no-skills".to_string(),
        "--no-prompt-templates".to_string(),
        "--no-context-files".to_string(),
        "--no-builtin-tools".to_string(),
        "--no-approve".to_string(),
    ];
    if let Some(runtime) = runtime {
        args.extend(["-e".to_string(), runtime.extension_path.to_string_lossy().to_string()]);
    }
    args
}

fn pi_selection_args(config: &AiConfig) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        let (provider, model_id) = split_pi_model_key(model)?;
        args.extend(["--provider".to_string(), provider.to_string(), "--model".to_string(), model_id.to_string()]);
    }
    if let Some(level) = pi_thinking_level(config.runtime_effort.as_ref()) {
        args.extend(["--thinking".to_string(), level]);
    }
    Ok(args)
}

fn pi_program(config: &AiConfig) -> String {
    config.pi_agent_cli_path.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or("pi").to_string()
}

fn resolve_pi_command(config: &AiConfig) -> Result<CliAgentCommandSpec, String> {
    let program = pi_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[piAgentCliPathInvalid] Pi Coding Agent path should contain only the executable path. Add environment variables in the Pi Coding Agent environment variables section.".to_string());
    }
    let program = if is_path_like_program(&program) { crate::path_utils::expand_tilde(&program) } else { program };
    let path = Path::new(&program);
    if path.is_dir() {
        return Err("[piAgentCliPathInvalid] Pi Coding Agent path should point to the pi executable.".to_string());
    }

    #[cfg(windows)]
    if let Some(command) = windows_npm_pi_shim_command(&program) {
        return Ok(command);
    }

    Ok(CliAgentCommandSpec { program, args: Vec::new() })
}

#[cfg(windows)]
fn windows_npm_pi_shim_command(program: &str) -> Option<CliAgentCommandSpec> {
    let path = Path::new(program);
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if extension != "cmd" && extension != "bat" {
        return None;
    }
    let parent = path.parent()?;
    let cli = parent.join("node_modules").join("@earendil-works").join("pi-coding-agent").join("dist").join("cli.js");
    if !cli.is_file() {
        return None;
    }
    let bundled_node = parent.join("node.exe");
    let node = if bundled_node.is_file() { bundled_node.to_string_lossy().to_string() } else { "node".to_string() };
    Some(CliAgentCommandSpec { program: node, args: vec![cli.to_string_lossy().to_string()] })
}

fn pi_agent_process_env(config: &AiConfig, command: &CliAgentCommandSpec) -> Result<Vec<(String, String)>, String> {
    let mut values = BTreeMap::new();
    for (key, value) in &config.pi_agent_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[piAgentEnvInvalid] Invalid Pi Coding Agent environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        let upper = key.to_ascii_uppercase();
        if upper.starts_with("DBX_MCP_") || upper.starts_with(PI_PRIVATE_ENV_PREFIX) {
            return Err(format!(
                "[piAgentEnvReserved] `{key}` is managed by DBX for the scoped MCP bridge and cannot be set here."
            ));
        }
        values.insert(key.to_string(), value.clone());
    }
    if let Some(parent) = Path::new(&command.program).parent().filter(|parent| !parent.as_os_str().is_empty()) {
        let user_path = values.get("PATH").map(String::as_str);
        values.insert("PATH".to_string(), merged_path_with_dir(parent, user_path));
    }
    Ok(values.into_iter().collect())
}

fn merged_path_with_dir(dir: &Path, user_path: Option<&str>) -> String {
    let mut seen = BTreeSet::new();
    let mut paths = vec![dir.to_path_buf()];
    if let Some(path) = user_path {
        paths.extend(env::split_paths(path));
    }
    if let Ok(path) = env::var("PATH") {
        paths.extend(env::split_paths(&path));
    }
    env::join_paths(paths.into_iter().filter(|path| seen.insert(path.clone())))
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn is_path_like_program(program: &str) -> bool {
    program.contains('/') || program.contains('\\') || program.starts_with('~')
}

fn starts_with_env_assignment(program: &str) -> bool {
    program
        .split_whitespace()
        .next()
        .and_then(|token| token.split_once('='))
        .is_some_and(|(key, _)| is_env_var_name(key))
}

fn is_env_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic()) && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn classify_pi_spawn_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("no such file") || lower.contains("not found") || lower.contains("cannot find") {
        format!("[piAgentNotInstalled] {message}")
    } else {
        format!("[piAgentRunFailed] {message}")
    }
}

fn classify_pi_run_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("no api key")
        || lower.contains("please login")
    {
        format!("[piAgentNotAuthenticated] {message}")
    } else if lower.contains("dbx mcp") || lower.contains("dbx-mcp") {
        format!("[piAgentMcpStartupFailed] {message}")
    } else if message.starts_with('[') {
        message.to_string()
    } else {
        format!("[piAgentRunFailed] {message}")
    }
}

fn pi_model_key(provider: &str, model_id: &str) -> String {
    format!("{provider}/{model_id}")
}

fn split_pi_model_key(model: &str) -> Result<(&str, &str), String> {
    model
        .split_once('/')
        .filter(|(provider, id)| !provider.is_empty() && !id.is_empty())
        .ok_or_else(|| format!("[piAgentModelInvalid] Pi model `{model}` must use the provider/model-id format."))
}

fn pi_thinking_level(selection: Option<&AiEffortSelection>) -> Option<String> {
    match selection {
        None | Some(AiEffortSelection::ProviderDefault) => None,
        Some(AiEffortSelection::Disabled | AiEffortSelection::Boolean(false)) => Some("off".to_string()),
        Some(AiEffortSelection::Boolean(true)) => Some("high".to_string()),
        Some(AiEffortSelection::Enum(value) | AiEffortSelection::Text(value)) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        Some(AiEffortSelection::Integer(value)) => Some(value.to_string()),
    }
}

fn parse_thinking_levels(data: &Value) -> Vec<String> {
    let mut seen = BTreeSet::new();
    data.get("levels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .filter(|level| seen.insert((*level).to_string()))
        .map(ToString::to_string)
        .collect()
}

fn pi_effort_capability(data: &Value) -> Option<AiEffortCapability> {
    crate::ai_effort::dynamic_enum_capability(parse_thinking_levels(data), AiCapabilitySource::LocalCli)
}

pub async fn list_pi_agent_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let mut process = PiRpcProcess::spawn(config, None, false).await?;
    let result = list_pi_agent_models_with_process(&mut process).await;
    process.shutdown().await;
    result
}

async fn list_pi_agent_models_with_process(process: &mut PiRpcProcess) -> Result<Vec<AiModelInfo>, String> {
    let (state, _) = process.request("get_state", json!({})).await?;
    let (data, _) = process.request("get_available_models", json!({})).await?;
    let models = data
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "[piAgentProtocolError] Pi did not return an available model list".to_string())?;
    if models.is_empty() {
        return Err("[piAgentNotAuthenticated] Pi Coding Agent did not report any available models".to_string());
    }

    let default_label = state
        .get("model")
        .and_then(|model| model.get("name").and_then(Value::as_str).or_else(|| model.get("id").and_then(Value::as_str)))
        .map(|name| format!("Default ({name})"))
        .unwrap_or_else(|| "Default".to_string());
    let (levels, _) = process.request("get_available_thinking_levels", json!({})).await?;
    let mut result = vec![AiModelInfo {
        id: "default".to_string(),
        display_name: Some(default_label),
        supported_effort_levels: Vec::new(),
        effort_capability: pi_effort_capability(&levels),
    }];
    let mut seen = BTreeSet::new();

    for model in models {
        let Some(provider) = model.get("provider").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
            continue;
        };
        let Some(model_id) = model.get("id").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
            continue;
        };
        let key = pi_model_key(provider, model_id);
        if !seen.insert(key.clone()) {
            continue;
        }
        let name = model.get("name").and_then(Value::as_str).unwrap_or(model_id);
        result.push(AiModelInfo {
            id: key,
            display_name: Some(format!("{name} ({provider})")),
            supported_effort_levels: Vec::new(),
            effort_capability: None,
        });
    }
    Ok(result)
}

pub async fn resolve_pi_agent_model_effort(config: &AiConfig, model_id: &str) -> Result<AiEffortCapability, String> {
    let mut config = config.clone();
    config.model = model_id.to_string();
    config.runtime_effort = None;
    let mut process = PiRpcProcess::spawn(&config, None, true).await?;
    let result = async {
        let (levels, _) = process.request("get_available_thinking_levels", json!({})).await?;
        Ok(pi_effort_capability(&levels).unwrap_or(AiEffortCapability::Unsupported))
    }
    .await;
    process.shutdown().await;
    result
}

pub async fn test_pi_agent_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    list_pi_agent_models(config).await?;
    Ok(AiTestConnectionResult {
        success: true,
        message: format!("OK - {}ms", start.elapsed().as_millis()),
        latency_ms: Some(start.elapsed().as_millis() as u64),
        model_used: config.model.trim().to_string(),
        error_category: None,
    })
}

pub fn build_pi_agent_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage], allow_write_sql: bool) -> String {
    build_cli_agent_prompt("Pi Coding Agent", system_prompt, messages, allow_write_sql)
}

fn configure_pi_bridge(
    process: &mut Command,
    runtime: &PiIsolatedRuntime,
    options: &PiAgentRunOptions,
) -> Result<(), String> {
    let mcp = options
        .mcp_server_command
        .as_ref()
        .ok_or_else(|| "[dbxMcpMissing] DBX MCP server was not resolved for Pi Coding Agent".to_string())?;
    process.env("DBX_PI_MCP_PROGRAM", &mcp.program);
    process.env(
        "DBX_PI_MCP_ARGS",
        serde_json::to_string(&mcp.args).map_err(|error| format!("[piAgentRunFailed] {error}"))?,
    );
    process.env(
        "DBX_PI_ENABLED_TOOLS",
        serde_json::to_string(&dbx_mcp_enabled_tools(options.agent_mode))
            .map_err(|error| format!("[piAgentRunFailed] {error}"))?,
    );
    process.env("DBX_PI_BRIDGE_READY_FILE", &runtime.ready_path);
    for (name, value) in dbx_mcp_scope_env(options) {
        process.env(name, value);
    }
    Ok(())
}

async fn wait_for_bridge(process: &mut PiRpcProcess, runtime: &PiIsolatedRuntime) -> Result<(), String> {
    tokio::time::timeout(PI_BRIDGE_STARTUP_TIMEOUT, async {
        loop {
            if runtime.ready_path.is_file() {
                return Ok(());
            }
            if let Some(status) = process.child.try_wait().map_err(|error| classify_pi_run_error(&error.to_string()))? {
                let stderr = process.stderr_text();
                let message = if stderr.is_empty() {
                    format!("Pi exited before the DBX MCP bridge started: {status}")
                } else {
                    stderr
                };
                return Err(classify_pi_run_error(&message));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| {
        let stderr = process.stderr_text();
        classify_pi_run_error(if stderr.is_empty() { "DBX MCP bridge startup timed out" } else { &stderr })
    })?
}

fn event_text(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer).and_then(Value::as_str).filter(|text| !text.is_empty()).map(ToString::to_string)
}

fn u32_token(value: Option<u64>) -> Option<u32> {
    value.map(|token| token.min(u32::MAX as u64) as u32)
}

fn add_tokens(total: &mut Option<u32>, value: Option<u64>) {
    if let Some(value) = u32_token(value) {
        *total = Some(total.unwrap_or_default().saturating_add(value));
    }
}

fn emit_pi_event(
    value: &Value,
    on_event: &impl Fn(AgentEvent),
    final_text: &mut String,
    input_tokens: &mut Option<u32>,
    output_tokens: &mut Option<u32>,
) -> Result<bool, String> {
    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        "turn_start" => on_event(AgentEvent::TurnStart { turn: 0 }),
        "turn_end" => on_event(AgentEvent::TurnEnd { turn: 0 }),
        "message_update" => {
            if value.pointer("/message/role").and_then(Value::as_str) != Some("assistant") {
                return Ok(false);
            }
            let update = value.get("assistantMessageEvent").unwrap_or(&Value::Null);
            match update.get("type").and_then(Value::as_str).unwrap_or_default() {
                "text_delta" => {
                    if let Some(delta) = update.get("delta").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                        final_text.push_str(delta);
                        on_event(AgentEvent::TextDelta { delta: delta.to_string() });
                    }
                }
                "thinking_delta" | "reasoning_delta" => {
                    if let Some(delta) = update.get("delta").and_then(Value::as_str).filter(|text| !text.is_empty()) {
                        on_event(AgentEvent::ReasoningDelta { delta: delta.to_string() });
                    }
                }
                "error" => {
                    let message =
                        update.get("error").and_then(Value::as_str).unwrap_or("Pi Coding Agent response failed");
                    on_event(AgentEvent::Error { message: message.to_string() });
                    return Err(classify_pi_run_error(message));
                }
                _ => {}
            }
        }
        "message_end" => {
            let message = value.get("message").unwrap_or(&Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return Ok(false);
            }
            let usage = message.get("usage").unwrap_or(&Value::Null);
            add_tokens(
                input_tokens,
                usage
                    .get("input")
                    .or_else(|| usage.get("inputTokens"))
                    .or_else(|| usage.get("input_tokens"))
                    .and_then(Value::as_u64),
            );
            add_tokens(
                output_tokens,
                usage
                    .get("output")
                    .or_else(|| usage.get("outputTokens"))
                    .or_else(|| usage.get("output_tokens"))
                    .and_then(Value::as_u64),
            );
            if final_text.is_empty() {
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for item in content {
                        if item.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(text) = item.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())
                            {
                                final_text.push_str(text);
                                on_event(AgentEvent::TextDelta { delta: text.to_string() });
                            }
                        }
                    }
                }
            }
            if message.get("stopReason").and_then(Value::as_str) == Some("error") {
                let error =
                    message.get("errorMessage").and_then(Value::as_str).unwrap_or("Pi Coding Agent response failed");
                on_event(AgentEvent::Error { message: error.to_string() });
                return Err(classify_pi_run_error(error));
            }
        }
        "tool_execution_start" => on_event(AgentEvent::ToolCallStart {
            tool_call_id: value.get("toolCallId").and_then(Value::as_str).unwrap_or("pi-tool-call").to_string(),
            tool_name: value.get("toolName").and_then(Value::as_str).unwrap_or("unknown").to_string(),
            args: value.get("args").cloned().unwrap_or_else(|| json!({})),
        }),
        "tool_execution_end" => on_event(AgentEvent::ToolCallEnd {
            tool_call_id: value.get("toolCallId").and_then(Value::as_str).unwrap_or("pi-tool-call").to_string(),
            tool_name: value.get("toolName").and_then(Value::as_str).unwrap_or("unknown").to_string(),
            result: value.get("result").cloned().unwrap_or(Value::Null),
            is_error: value.get("isError").and_then(Value::as_bool).unwrap_or(false),
        }),
        "agent_settled" => return Ok(true),
        "error" => {
            let message =
                event_text(value, "/message").unwrap_or_else(|| "Pi Coding Agent response failed".to_string());
            on_event(AgentEvent::Error { message: message.clone() });
            return Err(classify_pi_run_error(&message));
        }
        _ => {}
    }
    Ok(false)
}

pub async fn run_pi_agent(
    config: &AiConfig,
    prompt: &str,
    options: PiAgentRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let runtime = PiIsolatedRuntime::create()?;
    let mut process = spawn_pi_with_bridge(config, &runtime, &options).await?;
    let result = run_pi_agent_session(&mut process, prompt, &runtime, cancelled, &on_event).await;
    if result.is_ok() {
        process.shutdown().await;
    } else {
        process.abort_and_shutdown().await;
    }
    result
}

async fn run_pi_agent_session(
    process: &mut PiRpcProcess,
    prompt: &str,
    runtime: &PiIsolatedRuntime,
    cancelled: &Notify,
    on_event: &impl Fn(AgentEvent),
) -> Result<String, String> {
    wait_for_bridge(process, runtime).await?;
    let (_, buffered) = process.request("prompt", json!({ "message": prompt })).await?;

    let mut final_text = String::new();
    let mut input_tokens = None;
    let mut output_tokens = None;
    for event in buffered {
        if emit_pi_event(&event, &on_event, &mut final_text, &mut input_tokens, &mut output_tokens)? {
            on_event(AgentEvent::AgentEnd { input_tokens, output_tokens });
            return Ok(final_text);
        }
    }

    loop {
        tokio::select! {
            _ = cancelled.notified() => {
                return Err(AGENT_CANCELLED_ERROR.to_string());
            }
            line = process.stdout.next_line() => {
                let line = line
                    .map_err(|error| classify_pi_run_error(&error.to_string()))?
                    .ok_or_else(|| {
                        let stderr = process.stderr_text();
                        classify_pi_run_error(if stderr.is_empty() { "Pi RPC stdout closed before agent_end" } else { &stderr })
                    })?;
                let value: Value = serde_json::from_str(&line)
                    .map_err(|error| format!("[piAgentProtocolError] {error}: {line}"))?;
                if emit_pi_event(&value, &on_event, &mut final_text, &mut input_tokens, &mut output_tokens)? {
                    on_event(AgentEvent::AgentEnd { input_tokens, output_tokens });
                    return Ok(final_text);
                }
            }
        }
    }
}

async fn spawn_pi_with_bridge(
    config: &AiConfig,
    runtime: &PiIsolatedRuntime,
    options: &PiAgentRunOptions,
) -> Result<PiRpcProcess, String> {
    let command = resolve_pi_command(config)?;
    let mut process = cli_command(&command.program);
    process
        .args(command.args.iter().map(String::as_str))
        .args(pi_rpc_args(Some(runtime)))
        .args(pi_selection_args(config)?)
        .envs(pi_agent_process_env(config, &command)?)
        .current_dir(&runtime.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_pi_bridge(&mut process, runtime, options)?;
    PiRpcProcess::spawn_command(process).await
}

#[cfg(test)]
mod tests {
    use super::{
        build_pi_agent_prompt, classify_pi_run_error, configure_pi_bridge, emit_pi_event, parse_thinking_levels,
        pi_agent_process_env, pi_rpc_args, pi_selection_args, split_pi_model_key, PiIsolatedRuntime,
    };
    use crate::agent_events::AgentEvent;
    use crate::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiEffortSelection, AiProvider, AiReasoningLevel};
    use crate::ai_cli_agent::{CliAgentCommandSpec, CliAgentRunOptions};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn config() -> AiConfig {
        AiConfig {
            provider: AiProvider::PiAgentCli,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: String::new(),
            model: "openai-codex/gpt-5.4".to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::High,
            runtime_effort: Some(AiEffortSelection::Enum("high".to_string())),
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: HashMap::new(),
            claude_code_cli_path: None,
            claude_code_cli_env: HashMap::new(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: HashMap::new(),
            opencode_cli_path: None,
            opencode_cli_env: HashMap::new(),
        }
    }

    #[test]
    fn rpc_arguments_disable_ambient_pi_features() {
        assert_eq!(
            pi_rpc_args(None),
            [
                "--mode",
                "rpc",
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--no-builtin-tools",
                "--no-approve",
            ]
        );
    }

    #[test]
    fn selection_uses_startup_arguments_instead_of_mutating_rpc_commands() {
        let config = config();
        assert_eq!(
            pi_selection_args(&config).unwrap(),
            ["--provider", "openai-codex", "--model", "gpt-5.4", "--thinking", "high"]
        );

        let mut default_config = config;
        default_config.model = "default".to_string();
        default_config.runtime_effort = Some(AiEffortSelection::ProviderDefault);
        assert!(pi_selection_args(&default_config).unwrap().is_empty());
    }

    #[test]
    fn pi_model_keys_preserve_provider_and_nested_model_ids() {
        assert_eq!(split_pi_model_key("openai-codex/gpt-5.4").unwrap(), ("openai-codex", "gpt-5.4"));
        assert_eq!(split_pi_model_key("custom/provider/model").unwrap(), ("custom", "provider/model"));
        assert!(split_pi_model_key("missing-provider-separator").is_err());
    }

    #[test]
    fn parses_all_supported_pi_thinking_levels_in_cli_order() {
        let levels = parse_thinking_levels(&json!({
            "levels": ["off", "minimal", "low", "medium", "high", "xhigh", "max", "future", "high"]
        }));
        assert_eq!(
            serde_json::to_value(levels).unwrap(),
            json!(["off", "minimal", "low", "medium", "high", "xhigh", "max", "future"])
        );
    }

    #[test]
    fn rejects_dbx_managed_pi_environment_variables() {
        let mut config = config();
        config.pi_agent_cli_env.insert("DBX_PI_ENABLED_TOOLS".to_string(), "[]".to_string());
        let command = CliAgentCommandSpec { program: "pi".to_string(), args: Vec::new() };

        let error = pi_agent_process_env(&config, &command).unwrap_err();
        assert!(error.contains("[piAgentEnvReserved]"));
    }

    #[test]
    fn bridge_reuses_dbx_mcp_scope_and_write_policy() {
        let runtime = PiIsolatedRuntime::create().unwrap();
        let options = CliAgentRunOptions {
            connection_id: "connection-1".to_string(),
            connection_name: "Test connection".to_string(),
            database: "dbx_test".to_string(),
            schema: Some("reporting".to_string()),
            agent_mode: true,
            allow_writes: true,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CliAgentCommandSpec {
                program: "/usr/local/bin/dbx-mcp-server".to_string(),
                args: vec!["--stdio".to_string()],
            }),
        };
        let mut process = tokio::process::Command::new("pi");

        configure_pi_bridge(&mut process, &runtime, &options).unwrap();

        let env = process
            .as_std()
            .get_envs()
            .filter_map(|(name, value)| {
                value.map(|value| (name.to_string_lossy().into_owned(), value.to_string_lossy().into_owned()))
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(env.get("DBX_PI_MCP_PROGRAM").map(String::as_str), Some("/usr/local/bin/dbx-mcp-server"));
        assert_eq!(env.get("DBX_PI_MCP_ARGS").map(String::as_str), Some("[\"--stdio\"]"));
        assert_eq!(env.get("DBX_MCP_ALLOW_WRITES").map(String::as_str), Some("1"));
        assert_eq!(env.get("DBX_MCP_ALLOW_DANGEROUS_SQL").map(String::as_str), Some("0"));
        assert_eq!(env.get("DBX_MCP_SCOPE_CONNECTION_ID").map(String::as_str), Some("connection-1"));
        assert_eq!(env.get("DBX_MCP_SCOPE_CONNECTION_NAME").map(String::as_str), Some("Test connection"));
        assert_eq!(env.get("DBX_MCP_SCOPE_DATABASE").map(String::as_str), Some("dbx_test"));
        assert_eq!(env.get("DBX_MCP_SCOPE_SCHEMA").map(String::as_str), Some("reporting"));

        let enabled_tools = serde_json::from_str::<Vec<String>>(env.get("DBX_PI_ENABLED_TOOLS").unwrap()).unwrap();
        assert!(enabled_tools.iter().any(|tool| tool == "dbx_execute_query"));
        assert!(enabled_tools.iter().any(|tool| tool == "dbx_execute_redis_command"));
    }

    #[test]
    fn classifies_authentication_failures_separately() {
        assert!(classify_pi_run_error("Authentication required. Please login").starts_with("[piAgentNotAuthenticated]"));
        assert!(classify_pi_run_error("unexpected exit").starts_with("[piAgentRunFailed]"));
    }

    #[test]
    fn maps_pi_stream_events_to_dbx_agent_events_and_usage() {
        let events = Mutex::new(Vec::new());
        let on_event = |event| events.lock().unwrap().push(event);
        let mut text = String::new();
        let mut input_tokens = None;
        let mut output_tokens = None;

        assert!(!emit_pi_event(
            &json!({
                "type": "message_update",
                "message": { "role": "assistant" },
                "assistantMessageEvent": { "type": "thinking_delta", "delta": "reason" }
            }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap());
        assert!(!emit_pi_event(
            &json!({
                "type": "message_update",
                "message": { "role": "assistant" },
                "assistantMessageEvent": { "type": "text_delta", "delta": "answer" }
            }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap());
        emit_pi_event(
            &json!({
                "type": "message_end",
                "message": { "role": "assistant", "usage": { "input": 12, "output": 4 } }
            }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap();
        emit_pi_event(
            &json!({
                "type": "message_end",
                "message": { "role": "assistant", "usage": { "inputTokens": 3, "output_tokens": 2 } }
            }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap();
        assert!(!emit_pi_event(
            &json!({ "type": "agent_end", "willRetry": false }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap());
        assert!(emit_pi_event(
            &json!({ "type": "agent_settled" }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap());

        assert_eq!(text, "answer");
        assert_eq!(input_tokens, Some(15));
        assert_eq!(output_tokens, Some(6));
        let events = events.into_inner().unwrap();
        assert!(matches!(&events[0], AgentEvent::ReasoningDelta { delta } if delta == "reason"));
        assert!(matches!(&events[1], AgentEvent::TextDelta { delta } if delta == "answer"));
    }

    #[test]
    fn ignores_non_assistant_message_content() {
        let events = Mutex::new(Vec::new());
        let on_event = |event| events.lock().unwrap().push(event);
        let mut text = String::new();
        let mut input_tokens = None;
        let mut output_tokens = None;

        emit_pi_event(
            &json!({
                "type": "message_end",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "Do not echo this prompt" }]
                }
            }),
            &on_event,
            &mut text,
            &mut input_tokens,
            &mut output_tokens,
        )
        .unwrap();

        assert!(text.is_empty());
        assert!(events.into_inner().unwrap().is_empty());
    }

    #[test]
    fn prompt_includes_existing_cli_agent_safety_contract() {
        let prompt = build_pi_agent_prompt(
            "System context",
            &[crate::ai::AiMessage {
                role: "user".to_string(),
                content: "Count the keys".to_string(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            }],
            false,
        );
        assert!(prompt.contains("Pi Coding Agent"));
        assert!(prompt.contains("System context"));
        assert!(prompt.contains("Count the keys"));
    }
}
