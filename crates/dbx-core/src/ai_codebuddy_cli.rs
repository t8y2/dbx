use crate::agent_events::AgentEvent;
use crate::ai::{
    AiCapabilitySource, AiConfig, AiEffortCapability, AiEffortLevel, AiEffortOption, AiEffortSelection, AiModelInfo,
    AiTestConnectionResult,
};
use crate::ai_cli_agent::{
    build_cli_agent_prompt, cli_command, dbx_mcp_enabled_tools, dbx_mcp_scope_env, parse_cli_jsonl_event,
    run_cli_jsonl_agent, CliAgentCommandSpec, CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Notify;

const CODEBUDDY_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const CODEBUDDY_ACP_TIMEOUT: Duration = Duration::from_secs(20);
const CODEBUDDY_SETTING_SOURCES: &str = "user";
const CODEBUDDY_EXECUTABLE_NAMES: &[&str] = &["codebuddy", "cbc"];

pub type CodeBuddyRunOptions = CliAgentRunOptions;
pub type CodeBuddyCommandSpec = CliAgentCommandSpec;

struct CodeBuddyIsolatedCwd {
    path: PathBuf,
}

impl CodeBuddyIsolatedCwd {
    fn create() -> Result<Self, String> {
        let path = env::temp_dir().join(format!("dbx-codebuddy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).map_err(|error| {
            format!("[codeBuddyRunFailed] Failed to create isolated CodeBuddy Code directory: {error}")
        })?;
        Ok(Self { path })
    }

    fn write_mcp_config(&self, config: &str) -> Result<PathBuf, String> {
        let path = self.path.join("mcp.json");
        std::fs::write(&path, config).map_err(|error| {
            format!("[codeBuddyRunFailed] Failed to write temporary CodeBuddy MCP configuration: {error}")
        })?;
        Ok(path)
    }
}

impl Drop for CodeBuddyIsolatedCwd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
struct CodeBuddyInitializeResult {
    models: Vec<AiModelInfo>,
    authenticated: bool,
    current_model_id: Option<String>,
}

struct CodeBuddyAcpProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_request_id: u64,
}

impl CodeBuddyAcpProcess {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let mut request = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| format!("[codeBuddyProtocolError] Failed to serialize ACP request: {error}"))?;
        request.push(b'\n');
        self.stdin
            .write_all(&request)
            .await
            .map_err(|error| format!("[codeBuddyRunFailed] Failed to write CodeBuddy ACP request: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("[codeBuddyRunFailed] Failed to flush CodeBuddy ACP request: {error}"))?;

        while let Some(line) = self
            .stdout
            .next_line()
            .await
            .map_err(|error| format!("[codeBuddyRunFailed] Failed to read CodeBuddy ACP response: {error}"))?
        {
            let Ok(response) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if response.get("id").and_then(Value::as_u64) != Some(request_id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(sanitize_diagnostic)
                    .filter(|message| !message.is_empty())
                    .unwrap_or_else(|| "CodeBuddy ACP request failed".to_string());
                return Err(format!("[codeBuddyProtocolError] {message}"));
            }
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| "[codeBuddyProtocolError] CodeBuddy ACP response omitted its result.".to_string());
        }

        Err("[codeBuddyProtocolError] CodeBuddy ACP process ended before returning a response.".to_string())
    }

    async fn stop(mut self) {
        drop(self.stdin);
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

fn append_codebuddy_isolation_args(args: &mut Vec<String>) {
    // User settings retain CodeBuddy authentication and account preferences,
    // while project/local instruction and hook sources stay excluded.
    args.extend(["--setting-sources".to_string(), CODEBUDDY_SETTING_SOURCES.to_string()]);
}

fn codebuddy_program(config: &AiConfig) -> String {
    config
        .codebuddy_cli_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("codebuddy")
        .to_string()
}

fn codebuddy_process_env(config: &AiConfig, command: &CodeBuddyCommandSpec) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::from_iter(codebuddy_cli_env(config)?);
    if let Some(dir) = command_parent_dir(command) {
        let user_path = env.get("PATH").map(String::as_str);
        env.insert("PATH".to_string(), merged_path_with_dir(&dir, user_path));
    }
    Ok(env.into_iter().collect())
}

fn command_parent_dir(command: &CodeBuddyCommandSpec) -> Option<String> {
    Path::new(&command.program)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().to_string())
}

fn merged_path_with_dir(dir: &str, user_path: Option<&str>) -> String {
    let mut seen = BTreeSet::new();
    let mut dirs = vec![PathBuf::from(dir)];
    if let Some(path) = user_path {
        dirs.extend(env::split_paths(path));
    }
    dirs.extend(common_executable_dirs());
    let paths = dirs.into_iter().filter(|path| seen.insert(path.clone())).collect::<Vec<_>>();
    env::join_paths(paths).unwrap_or_default().to_string_lossy().to_string()
}

fn common_executable_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path) = env::var("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    #[cfg(windows)]
    {
        if let Ok(app_data) = env::var("APPDATA") {
            dirs.push(PathBuf::from(app_data).join("npm"));
        }
    }
    #[cfg(not(windows))]
    {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
    }
    dirs
}

fn validate_codebuddy_program(config: &AiConfig) -> Result<String, String> {
    let program = codebuddy_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[codeBuddyCliPathInvalid] CodeBuddy Code CLI path should contain only the executable path. Add environment variables in the CodeBuddy environment variables section.".to_string());
    }
    if is_path_like_program(&program) {
        let expanded = crate::path_utils::expand_tilde(&program);
        let path = Path::new(&expanded);
        if path.is_dir() {
            return CODEBUDDY_EXECUTABLE_NAMES
                .iter()
                .find_map(|name| launchable_program_in_dir(path, name))
                .ok_or_else(|| {
                    "[codeBuddyCliPathInvalid] CodeBuddy Code CLI path should point to the codebuddy executable or a directory containing codebuddy."
                        .to_string()
                });
        }
        return Ok(expanded);
    }
    Ok(program)
}

fn launchable_program_in_dir(dir: &Path, program: &str) -> Option<String> {
    program_path_candidates(dir, program)
        .into_iter()
        .find(|candidate| is_launchable_program_path(candidate) && candidate.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(not(windows))]
fn program_path_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    vec![dir.join(program)]
}

#[cfg(windows)]
fn program_path_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    let path = Path::new(program);
    if path.extension().is_some() {
        return vec![dir.join(program)];
    }
    [".cmd", ".exe", ".bat", ".com", ""].iter().map(|extension| dir.join(format!("{program}{extension}"))).collect()
}

#[cfg(not(windows))]
fn is_launchable_program_path(_path: &Path) -> bool {
    true
}

#[cfg(windows)]
fn is_launchable_program_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("exe" | "cmd" | "bat" | "com")
    )
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

fn is_reserved_dbx_mcp_env_name(name: &str) -> bool {
    name.to_ascii_uppercase().starts_with("DBX_MCP_")
}

pub fn codebuddy_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::new();
    for (key, value) in &config.codebuddy_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[codeBuddyEnvInvalid] Invalid CodeBuddy environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        if is_reserved_dbx_mcp_env_name(key) {
            return Err(format!(
                "[codeBuddyEnvReserved] `{key}` is managed by DBX for the scoped MCP server and cannot be set here."
            ));
        }
        env.insert(key.to_string(), value.clone());
    }
    Ok(env.into_iter().collect())
}

pub fn codebuddy_enabled_tools(agent_mode: bool) -> Vec<String> {
    dbx_mcp_enabled_tools(agent_mode).into_iter().map(|tool| format!("mcp__dbx__{tool}")).collect()
}

fn codebuddy_mcp_config(options: &CodeBuddyRunOptions) -> String {
    let mcp_command =
        options.mcp_server_command.as_ref().map(|command| command.program.as_str()).unwrap_or("dbx-mcp-server");
    let mut server = Map::new();
    server.insert("type".to_string(), Value::String("stdio".to_string()));
    server.insert("command".to_string(), Value::String(mcp_command.to_string()));
    if let Some(command) = options.mcp_server_command.as_ref().filter(|command| !command.args.is_empty()) {
        server.insert("args".to_string(), json!(command.args));
    }
    let env = dbx_mcp_scope_env(options)
        .into_iter()
        .map(|(name, value)| (name.to_string(), Value::String(value)))
        .collect::<Map<_, _>>();
    server.insert("env".to_string(), Value::Object(env));
    json!({ "mcpServers": { "dbx": Value::Object(server) } }).to_string()
}

pub fn build_codebuddy_command(
    config: &AiConfig,
    _prompt: &str,
    options: &CodeBuddyRunOptions,
) -> CodeBuddyCommandSpec {
    build_codebuddy_command_with_mcp_arg(config, options, codebuddy_mcp_config(options))
}

fn build_codebuddy_command_with_mcp_arg(
    config: &AiConfig,
    options: &CodeBuddyRunOptions,
    mcp_config_arg: String,
) -> CodeBuddyCommandSpec {
    let enabled_tools = codebuddy_enabled_tools(options.agent_mode);
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--input-format".to_string(),
        "text".to_string(),
        "--no-session-persistence".to_string(),
        "--permission-mode".to_string(),
        "dontAsk".to_string(),
        "--mcp-config".to_string(),
        mcp_config_arg,
        "--strict-mcp-config".to_string(),
        "--settings".to_string(),
        json!({ "enabledMcpjsonServers": ["dbx"] }).to_string(),
    ];
    append_codebuddy_isolation_args(&mut args);
    // Supplying only NoDefer(MCP tool) entries keeps built-in file/shell tools
    // out of the model context while making the scoped DBX tools immediately
    // available after the temporary server connects.
    args.push("--tools".to_string());
    args.push(enabled_tools.iter().map(|tool| format!("NoDefer({tool})")).collect::<Vec<_>>().join(","));
    args.push("--allowedTools".to_string());
    args.extend(enabled_tools);

    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = config.runtime_effort.as_ref().and_then(|effort| effort.cli_value()) {
        args.push("--effort".to_string());
        args.push(effort);
    }

    CodeBuddyCommandSpec { program: codebuddy_program(config), args }
}

pub fn build_codebuddy_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage], allow_write_sql: bool) -> String {
    build_cli_agent_prompt("CodeBuddy Code", system_prompt, messages, allow_write_sql)
}

pub async fn list_codebuddy_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let initialized = initialize_codebuddy(config).await?;
    if !initialized.authenticated {
        return Err("[codeBuddyNotAuthenticated] CodeBuddy Code is not authenticated. Open `codebuddy` in a terminal, sign in, and try again.".to_string());
    }
    if initialized.models.is_empty() {
        return Err("[codeBuddyProtocolError] CodeBuddy initialization returned no usable models.".to_string());
    }
    Ok(initialized.models)
}

async fn initialize_codebuddy(config: &AiConfig) -> Result<CodeBuddyInitializeResult, String> {
    let program = validate_codebuddy_program(config)?;
    let mut command = CodeBuddyCommandSpec {
        program,
        args: vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--no-session-persistence".to_string(),
        ],
    };
    append_codebuddy_isolation_args(&mut command.args);
    let env = codebuddy_process_env(config, &command)?;
    let isolated_cwd = CodeBuddyIsolatedCwd::create()?;
    let mut process = cli_command(&command.program);
    process
        .args(command.args.iter().map(String::as_str))
        .envs(env.iter().map(|(key, value)| (key.as_str(), value.as_str())))
        .env_remove("CLAUDECODE")
        .current_dir(&isolated_cwd.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = process.spawn().map_err(|error| classify_codebuddy_spawn_error(&error.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "[codeBuddyProtocolError] CodeBuddy initialization stdin is unavailable.".to_string())?;
    let mut request = serde_json::to_vec(&json!({
        "type": "control_request",
        "request_id": "dbx_model_discovery",
        "request": { "subtype": "initialize" }
    }))
    .map_err(|error| format!("[codeBuddyProtocolError] Failed to serialize initialization request: {error}"))?;
    request.push(b'\n');
    stdin
        .write_all(&request)
        .await
        .map_err(|error| format!("[codeBuddyRunFailed] Failed to write CodeBuddy initialization request: {error}"))?;
    stdin
        .shutdown()
        .await
        .map_err(|error| format!("[codeBuddyRunFailed] Failed to close CodeBuddy initialization stdin: {error}"))?;
    drop(stdin);

    let output = tokio::time::timeout(CODEBUDDY_INITIALIZE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "[codeBuddyTimeout] CodeBuddy initialization timed out.".to_string())?
        .map_err(|error| format!("[codeBuddyRunFailed] Failed to wait for CodeBuddy initialization: {error}"))?;
    if !output.status.success() {
        return Err(classify_codebuddy_run_error(&sanitize_diagnostic(&String::from_utf8_lossy(&output.stderr))));
    }

    parse_codebuddy_initialize(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        "[codeBuddyProtocolError] CodeBuddy initialization returned no valid control response.".to_string()
    })
}

fn parse_codebuddy_initialize(stdout: &str) -> Option<CodeBuddyInitializeResult> {
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("control_response") {
            continue;
        }
        let Some(response) = event.get("response") else {
            continue;
        };
        let data = response.get("response").unwrap_or(response);
        let models = parse_codebuddy_models(data.get("models").and_then(Value::as_array).map(Vec::as_slice));
        let authenticated = parse_account_auth_state(data.get("account")).unwrap_or(!models.is_empty());
        let current_model_id = data
            .get("currentModelId")
            .or_else(|| data.get("current_model_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(normalize_codebuddy_model_id);
        return Some(CodeBuddyInitializeResult { models, authenticated, current_model_id });
    }
    None
}

fn parse_codebuddy_models(models: Option<&[Value]>) -> Vec<AiModelInfo> {
    let Some(models) = models else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for model in models {
        let Some(raw_id) = model
            .get("value")
            .and_then(Value::as_str)
            .or_else(|| model.get("id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let id = normalize_codebuddy_model_id(raw_id);
        if !seen.insert(id.clone()) {
            continue;
        }
        let display_name = model
            .get("displayName")
            .and_then(Value::as_str)
            .or_else(|| model.get("display_name").and_then(Value::as_str))
            .or_else(|| model.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string);
        let mut info = AiModelInfo::new(&id, display_name);
        let effort_levels = parse_codebuddy_effort_level_strings(model);
        info.effort_capability =
            if model.get("supportsEffort").or_else(|| model.get("supports_effort")).and_then(Value::as_bool)
                == Some(false)
            {
                Some(AiEffortCapability::Unsupported)
            } else {
                crate::ai_effort::dynamic_enum_capability(effort_levels, AiCapabilitySource::LocalCli)
            };
        info.supported_effort_levels = codebuddy_legacy_effort_levels(info.effort_capability.as_ref());
        result.push(info);
    }
    if !result.is_empty() && seen.insert("default".to_string()) {
        result.insert(0, AiModelInfo::new("default", Some("Default".to_string())));
    }
    result
}

pub async fn resolve_codebuddy_model_effort(config: &AiConfig, model_id: &str) -> Result<AiEffortCapability, String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("Model is required".to_string());
    }

    tokio::time::timeout(CODEBUDDY_ACP_TIMEOUT, resolve_codebuddy_model_effort_inner(config, model_id))
        .await
        .map_err(|_| "[codeBuddyTimeout] CodeBuddy effort discovery timed out.".to_string())?
}

async fn resolve_codebuddy_model_effort_inner(config: &AiConfig, model_id: &str) -> Result<AiEffortCapability, String> {
    let isolated_cwd = CodeBuddyIsolatedCwd::create()?;
    let mcp_config_path = isolated_cwd.write_mcp_config(r#"{"mcpServers":{}}"#)?;
    let mut acp = spawn_codebuddy_acp(config, &isolated_cwd.path, &mcp_config_path)?;
    let result = async {
        acp.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
                "clientInfo": { "name": "DBX", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
        let session = acp
            .request(
                "session/new",
                json!({
                    "cwd": isolated_cwd.path.to_string_lossy(),
                    "mcpServers": [],
                }),
            )
            .await?;

        let config_result = if model_id.eq_ignore_ascii_case("default") {
            session
        } else {
            let session_id = session
                .get("sessionId")
                .or_else(|| session.get("session_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|session_id| !session_id.is_empty())
                .ok_or_else(|| {
                    "[codeBuddyProtocolError] CodeBuddy ACP session response omitted its session ID.".to_string()
                })?;
            acp.request(
                "session/set_config_option",
                json!({
                    "sessionId": session_id,
                    "configId": "model",
                    "value": model_id,
                }),
            )
            .await?
        };

        Ok(parse_codebuddy_acp_effort_capability(&config_result))
    }
    .await;
    acp.stop().await;
    result
}

fn spawn_codebuddy_acp(config: &AiConfig, cwd: &Path, mcp_config_path: &Path) -> Result<CodeBuddyAcpProcess, String> {
    let program = validate_codebuddy_program(config)?;
    let mut command = CodeBuddyCommandSpec {
        program,
        args: vec![
            "--acp".to_string(),
            "--acp-transport".to_string(),
            "stdio".to_string(),
            "--no-session-persistence".to_string(),
            "--mcp-config".to_string(),
            mcp_config_path.to_string_lossy().to_string(),
            "--strict-mcp-config".to_string(),
        ],
    };
    append_codebuddy_isolation_args(&mut command.args);
    let env = codebuddy_process_env(config, &command)?;
    let mut process = cli_command(&command.program);
    process
        .args(command.args.iter().map(String::as_str))
        .envs(env.iter().map(|(key, value)| (key.as_str(), value.as_str())))
        .env_remove("CLAUDECODE")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = process.spawn().map_err(|error| classify_codebuddy_spawn_error(&error.to_string()))?;
    let stdin =
        child.stdin.take().ok_or_else(|| "[codeBuddyProtocolError] CodeBuddy ACP stdin is unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "[codeBuddyProtocolError] CodeBuddy ACP stdout is unavailable.".to_string())?;
    Ok(CodeBuddyAcpProcess { child, stdin, stdout: BufReader::new(stdout).lines(), next_request_id: 0 })
}

fn parse_codebuddy_acp_effort_capability(result: &Value) -> AiEffortCapability {
    let Some(options) = result
        .get("configOptions")
        .or_else(|| result.get("config_options"))
        .and_then(Value::as_array)
        .and_then(|options| {
            options.iter().find(|option| {
                option
                    .get("id")
                    .or_else(|| option.get("configId"))
                    .or_else(|| option.get("config_id"))
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.eq_ignore_ascii_case("thought_level"))
            })
        })
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array)
    else {
        return AiEffortCapability::Unsupported;
    };

    let mut seen = BTreeSet::new();
    let options = options
        .iter()
        .filter_map(|option| {
            let id = option.get("value").or_else(|| option.get("id")).and_then(Value::as_str)?.trim();
            if id.is_empty()
                || matches!(id.to_ascii_lowercase().as_str(), "enabled" | "disabled")
                || !seen.insert(id.to_string())
            {
                return None;
            }
            let label = option
                .get("name")
                .or_else(|| option.get("label"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .unwrap_or(id)
                .to_string();
            let description = option
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|description| !description.is_empty())
                .map(ToString::to_string);
            Some(AiEffortOption {
                id: id.to_string(),
                label,
                description,
                selection: AiEffortSelection::Enum(id.to_string()),
            })
        })
        .collect::<Vec<_>>();

    if options.is_empty() {
        AiEffortCapability::Unsupported
    } else {
        AiEffortCapability::Enum {
            options,
            default: AiEffortSelection::ProviderDefault,
            source: AiCapabilitySource::LocalCli,
        }
    }
}

fn codebuddy_legacy_effort_levels(capability: Option<&AiEffortCapability>) -> Vec<AiEffortLevel> {
    let Some(AiEffortCapability::Enum { options, .. }) = capability else {
        return Vec::new();
    };
    options.iter().filter_map(|option| option.id.parse::<AiEffortLevel>().ok()).collect()
}

fn normalize_codebuddy_model_id(id: &str) -> String {
    if id.eq_ignore_ascii_case("default-model") {
        "default".to_string()
    } else {
        id.to_string()
    }
}

fn parse_codebuddy_effort_level_strings(model: &Value) -> Vec<String> {
    if model.get("supportsEffort").or_else(|| model.get("supports_effort")).and_then(Value::as_bool) == Some(false) {
        return Vec::new();
    }
    let Some(levels) =
        model.get("supportedEffortLevels").or_else(|| model.get("supported_effort_levels")).and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    levels
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .filter(|level| seen.insert((*level).to_string()))
        .map(ToString::to_string)
        .collect()
}

fn parse_account_auth_state(account: Option<&Value>) -> Option<bool> {
    match account? {
        Value::Null => Some(false),
        Value::Bool(value) => Some(*value),
        Value::Object(fields) => fields
            .get("authenticated")
            .or_else(|| fields.get("isAuthenticated"))
            .or_else(|| fields.get("is_authenticated"))
            .or_else(|| fields.get("loggedIn"))
            .or_else(|| fields.get("logged_in"))
            .and_then(Value::as_bool)
            .or_else(|| Some(!fields.is_empty())),
        _ => None,
    }
}

pub async fn test_codebuddy_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    let initialized = initialize_codebuddy(config).await?;
    if !initialized.authenticated {
        return Err("[codeBuddyNotAuthenticated] CodeBuddy Code is not authenticated. Open `codebuddy` in a terminal, sign in, and try again.".to_string());
    }
    let elapsed = start.elapsed().as_millis() as u64;
    let model_used = initialized.current_model_id.unwrap_or_else(|| config.model.trim().to_string()).trim().to_string();
    Ok(AiTestConnectionResult {
        success: true,
        message: format!("OK - {elapsed}ms"),
        latency_ms: Some(elapsed),
        model_used,
        error_category: None,
    })
}

fn classify_codebuddy_spawn_error(message: &str) -> String {
    if message.contains("No such file") || message.contains("not found") || message.contains("os error 2") {
        format!("[codeBuddyNotInstalled] CodeBuddy Code CLI was not found. Install it or set its executable path in DBX AI settings. {message}")
    } else {
        format!("[codeBuddyRunFailed] Failed to start CodeBuddy Code CLI: {message}")
    }
}

fn classify_codebuddy_run_error(diagnostic: &str) -> String {
    let diagnostic = sanitize_diagnostic(diagnostic);
    let lower = diagnostic.to_ascii_lowercase();
    if lower.contains("invalid mcp configuration") || lower.contains("mcp config file not found") {
        format!("[codeBuddyMcpConfigInvalid] {diagnostic}")
    } else if lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("please login")
        || lower.contains("please log in")
        || lower.contains("unauthorized")
    {
        format!("[codeBuddyNotAuthenticated] {diagnostic}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] {diagnostic}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[codeBuddyMcpStartupFailed] {diagnostic}")
    } else if lower.contains("protocol") || lower.contains("invalid json") || lower.contains("parse") {
        format!("[codeBuddyProtocolError] {diagnostic}")
    } else {
        format!("[codeBuddyRunFailed] {diagnostic}")
    }
}

fn sanitize_diagnostic(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "CodeBuddy Code CLI exited without diagnostics.".to_string();
    }
    value.chars().take(2_000).collect()
}

pub fn parse_codebuddy_jsonl_event(line: &str) -> Option<Vec<AgentEvent>> {
    parse_cli_jsonl_event(line, CliAgentJsonlDialect::CodeBuddyPrint)
}

pub async fn run_codebuddy_agent(
    config: &AiConfig,
    prompt: &str,
    options: CodeBuddyRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let program = validate_codebuddy_program(config)?;
    let isolated_cwd = CodeBuddyIsolatedCwd::create()?;
    let mcp_config_path = isolated_cwd.write_mcp_config(&codebuddy_mcp_config(&options))?;
    let mut command =
        build_codebuddy_command_with_mcp_arg(config, &options, mcp_config_path.to_string_lossy().to_string());
    command.program = program;
    let env = codebuddy_process_env(config, &command)?;
    run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
            env,
            env_remove: vec!["CLAUDECODE".to_string()],
            current_dir: Some(isolated_cwd.path.clone()),
            stdin: Some(prompt.to_string()),
            dialect: CliAgentJsonlDialect::CodeBuddyPrint,
            classify_spawn_error: classify_codebuddy_spawn_error,
            classify_run_error: classify_codebuddy_run_error,
        },
        cancelled,
        on_event,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        build_codebuddy_command, classify_codebuddy_run_error, codebuddy_cli_env, codebuddy_enabled_tools,
        parse_codebuddy_acp_effort_capability, parse_codebuddy_initialize, parse_codebuddy_jsonl_event,
        validate_codebuddy_program, CodeBuddyRunOptions,
    };
    #[cfg(unix)]
    use super::{
        list_codebuddy_models, resolve_codebuddy_model_effort, run_codebuddy_agent, test_codebuddy_connection,
    };
    use crate::agent_events::AgentEvent;
    use crate::ai::{
        AiApiStyle, AiAuthMethod, AiConfig, AiEffortCapability, AiEffortSelection, AiProvider, AiReasoningLevel,
    };
    use crate::ai_cli_agent::CliAgentCommandSpec;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::sync::{Arc, Mutex};
    #[cfg(unix)]
    use std::time::Duration;
    #[cfg(unix)]
    use tokio::sync::Notify;

    fn codebuddy_config(model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::CodeBuddyCli,
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

    fn run_options() -> CodeBuddyRunOptions {
        CodeBuddyRunOptions {
            connection_id: "conn-1".to_string(),
            connection_name: "local".to_string(),
            database: "demo".to_string(),
            schema: None,
            agent_mode: true,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: None,
        }
    }

    #[test]
    fn builds_scoped_non_persistent_command() {
        let spec = build_codebuddy_command(&codebuddy_config("default"), "hello", &run_options());
        assert_eq!(spec.program, "codebuddy");
        assert!(spec.args.windows(2).any(|args| args == ["--output-format", "stream-json"]));
        assert!(spec.args.windows(2).any(|args| args == ["--setting-sources", "user"]));
        assert!(spec.args.windows(2).any(|args| args == ["--permission-mode", "dontAsk"]));
        assert!(spec.args.contains(&"--no-session-persistence".to_string()));
        assert!(spec.args.contains(&"--strict-mcp-config".to_string()));
        assert!(spec.args.windows(2).any(|args| args[0] == "--settings" && args[1].contains("enabledMcpjsonServers")));
        assert!(!spec.args.contains(&"hello".to_string()));
        assert!(!spec.args.contains(&"--model".to_string()));
        assert!(!spec.args.contains(&"--effort".to_string()));
        assert!(spec.args.iter().any(|arg| arg.contains("\"DBX_MCP_SCOPE_CONNECTION_ID\":\"conn-1\"")));
        assert!(spec.args.iter().any(|arg| arg.contains("\"type\":\"stdio\"")));
        let tools_index = spec.args.iter().position(|arg| arg == "--tools").unwrap();
        assert!(spec.args[tools_index + 1].contains("NoDefer(mcp__dbx__dbx_execute_query)"));
        assert!(!spec.args[tools_index + 1].contains("Bash"));
        let allowed_tools_index = spec.args.iter().position(|arg| arg == "--allowedTools").unwrap();
        assert!(spec.args[allowed_tools_index + 1..].iter().any(|arg| arg == "mcp__dbx__dbx_execute_query"));
    }

    #[test]
    fn builds_explicit_model_effort_and_ask_tool_policy() {
        let mut config = codebuddy_config("kimi-k2.5");
        config.runtime_effort = Some(AiEffortSelection::Enum("high".to_string()));
        let mut options = run_options();
        options.agent_mode = false;
        options.mcp_server_command = Some(CliAgentCommandSpec {
            program: "/opt/dbx/bin/dbx-mcp-server".to_string(),
            args: vec!["--stdio".to_string()],
        });
        let spec = build_codebuddy_command(&config, "hello", &options);
        assert!(spec.args.windows(2).any(|args| args == ["--model", "kimi-k2.5"]));
        assert!(spec.args.windows(2).any(|args| args == ["--effort", "high"]));
        assert!(spec.args.iter().any(|arg| arg.contains("\"command\":\"/opt/dbx/bin/dbx-mcp-server\"")));
        assert!(!codebuddy_enabled_tools(false).iter().any(|tool| tool == "mcp__dbx__dbx_execute_query"));
    }

    #[test]
    fn validates_path_and_environment() {
        let mut config = codebuddy_config("default");
        config.codebuddy_cli_path = Some("HTTPS_PROXY=http://proxy:1 codebuddy".to_string());
        assert!(validate_codebuddy_program(&config).unwrap_err().contains("[codeBuddyCliPathInvalid]"));
        config.codebuddy_cli_path = None;
        config.codebuddy_cli_env.insert("HTTPS_PROXY".to_string(), "http://proxy:9800".to_string());
        assert_eq!(
            codebuddy_cli_env(&config).unwrap(),
            vec![("HTTPS_PROXY".to_string(), "http://proxy:9800".to_string())]
        );
        config.codebuddy_cli_env.insert("DBX_MCP_ALLOW_WRITES".to_string(), "1".to_string());
        assert!(codebuddy_cli_env(&config).unwrap_err().contains("[codeBuddyEnvReserved]"));
    }

    #[test]
    fn parses_nested_models_without_retaining_account_payload() {
        let result = parse_codebuddy_initialize(
            r#"{"type":"control_response","response":{"response":{"models":[{"id":"default-model","name":"Default model"},{"id":"kimi-k2.5","name":"Kimi K2.5","supportsEffort":true,"supportedEffortLevels":["low","future","low"]},{"id":"kimi-k2.5","name":"duplicate"},{"id":" "}],"commands":[{"name":"/effort","description":"Set model effort"}],"account":{"authenticated":true,"opaqueField":"must-not-escape"},"currentModelId":"kimi-k2.5"}}}"#,
        )
        .unwrap();
        assert!(result.authenticated);
        assert_eq!(result.current_model_id.as_deref(), Some("kimi-k2.5"));
        assert_eq!(result.models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["default", "kimi-k2.5"]);
        assert_eq!(result.models[0].effort_capability, None);
        let capability = result.models[1].effort_capability.as_ref().unwrap();
        assert!(
            matches!(capability, AiEffortCapability::Enum { options, .. } if options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>() == ["low", "future"])
        );
    }

    #[test]
    fn parses_flat_response_and_explicit_signed_out_state() {
        let result = parse_codebuddy_initialize(
            r#"{"type":"control_response","response":{"models":[{"value":"model-a","displayName":"Model A"}],"commands":["effort"],"account":{"loggedIn":false}}}"#,
        )
        .unwrap();
        assert!(!result.authenticated);
        assert_eq!(result.models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["default", "model-a"]);
        assert!(result.models.iter().all(|model| model.effort_capability.is_none()));
    }

    #[test]
    fn only_uses_explicit_effort_metadata_from_print_initialize() {
        let result = parse_codebuddy_initialize(
            r#"{"type":"control_response","response":{"models":[{"id":"model-a"},{"id":"model-b","supportsEffort":false}],"commands":[{"command":"/EFFORT"}],"account":true}}"#,
        )
        .unwrap();
        assert_eq!(result.models[0].effort_capability, None);
        assert_eq!(result.models[1].effort_capability, None);
        assert_eq!(result.models[2].effort_capability, Some(AiEffortCapability::Unsupported));
    }

    #[test]
    fn parses_dynamic_acp_effort_options_without_synthetic_values() {
        let capability = parse_codebuddy_acp_effort_capability(&serde_json::json!({
            "configOptions": [
                {
                    "id": "model",
                    "options": [{ "value": "model-a", "name": "Model A" }]
                },
                {
                    "id": "thought_level",
                    "options": [
                        { "value": "enabled", "name": "Auto" },
                        { "value": "disabled", "name": "Off" },
                        { "value": "minimal", "name": "Minimal", "description": "Small budget" },
                        { "value": "future", "name": "Future" },
                        { "value": "minimal", "name": "Duplicate" }
                    ]
                }
            ]
        }));
        assert!(matches!(
            capability,
            AiEffortCapability::Enum { options, default: AiEffortSelection::ProviderDefault, source: crate::ai::AiCapabilitySource::LocalCli }
                if options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>() == ["minimal", "future"]
                    && options[0].label == "Minimal"
                    && options[0].description.as_deref() == Some("Small budget")
        ));
    }

    #[test]
    fn treats_missing_or_non_executable_acp_effort_options_as_unsupported() {
        assert_eq!(
            parse_codebuddy_acp_effort_capability(&serde_json::json!({ "configOptions": [] })),
            AiEffortCapability::Unsupported
        );
        assert_eq!(
            parse_codebuddy_acp_effort_capability(&serde_json::json!({
                "configOptions": [{
                    "id": "thought_level",
                    "options": [{ "value": "enabled" }, { "value": "disabled" }]
                }]
            })),
            AiEffortCapability::Unsupported
        );
    }

    #[test]
    fn does_not_invent_default_model_for_an_empty_catalog() {
        let result = parse_codebuddy_initialize(
            r#"{"type":"control_response","response":{"models":[],"account":{"authenticated":true}}}"#,
        )
        .unwrap();
        assert!(result.models.is_empty());
    }

    #[test]
    fn reuses_claude_compatible_stream_events() {
        let events = parse_codebuddy_jsonl_event(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"},{"type":"tool_use","id":"call-1","name":"mcp__dbx__dbx_list_tables","input":{}}]}}"#,
        )
        .unwrap();
        assert!(matches!(&events[0], AgentEvent::TextDelta { delta } if delta == "done"));
        assert!(matches!(&events[1], AgentEvent::ToolCallStart { tool_call_id, .. } if tool_call_id == "call-1"));

        let error = parse_codebuddy_jsonl_event(r#"{"type":"error"}"#).unwrap();
        assert!(matches!(&error[0], AgentEvent::Error { message } if message == "CodeBuddy Code CLI failed"));
    }

    #[test]
    fn classifies_codebuddy_specific_runtime_failures() {
        assert!(classify_codebuddy_run_error("invalid MCP configuration").starts_with("[codeBuddyMcpConfigInvalid]"));
        assert!(classify_codebuddy_run_error("Please log in first").starts_with("[codeBuddyNotAuthenticated]"));
        assert!(classify_codebuddy_run_error("dbx-mcp-server: ENOENT").starts_with("[dbxMcpMissing]"));
        assert!(
            classify_codebuddy_run_error("MCP dbx server failed to connect").starts_with("[codeBuddyMcpStartupFailed]")
        );
        assert!(classify_codebuddy_run_error("invalid JSON protocol response").starts_with("[codeBuddyProtocolError]"));
        assert!(classify_codebuddy_run_error("").starts_with("[codeBuddyRunFailed]"));
    }

    #[cfg(unix)]
    fn isolated_cli_test_config() -> (AiConfig, std::path::PathBuf, std::path::PathBuf) {
        let project_dir = std::env::temp_dir().join(format!("dbx-codebuddy-project-test-{}", uuid::Uuid::new_v4()));
        let project_settings = project_dir.join(".codebuddy");
        let auth_dir = project_dir.join("user-config");
        let hook_marker = project_dir.join("project-hook-loaded");
        std::fs::create_dir_all(&project_settings).unwrap();
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(auth_dir.join("auth-marker"), "authenticated").unwrap();
        std::fs::write(project_settings.join("project-marker"), "must-not-load").unwrap();

        let executable = project_dir.join("codebuddy");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
user_settings=false
mcp_config=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--setting-sources" ] && [ "$arg" = "user" ]; then
    user_settings=true
  elif [ "$previous" = "--mcp-config" ]; then
    mcp_config="$arg"
  fi
  previous="$arg"
done
if [ "$user_settings" != "true" ] || [ "$PWD" = "$DBX_TEST_PROJECT_DIR" ]; then
  printf loaded > "$DBX_TEST_HOOK_MARKER"
fi
if [ ! -f "$CODEBUDDY_CONFIG_DIR/auth-marker" ]; then
  printf '%s\n' 'not authenticated' >&2
  exit 9
fi
case " $* " in
  *" --acp "*)
    if [ ! -f "$mcp_config" ] || ! grep -q '"mcpServers"' "$mcp_config"; then
      printf '%s\n' 'invalid MCP configuration' >&2
      exit 10
    fi
    while IFS= read -r line; do
      case "$line" in
        *'"method":"initialize"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}'
          ;;
        *'"method":"session/new"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1","configOptions":[{"id":"model","options":[{"value":"codebuddy-user-model","name":"User Model"}]},{"id":"thought_level","options":[{"value":"enabled","name":"Auto"},{"value":"low","name":"Low"},{"value":"high","name":"High"}]}]}}'
          ;;
        *'"method":"session/set_config_option"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"configOptions":[{"id":"model","currentValue":"codebuddy-user-model"},{"id":"thought_level","options":[{"value":"enabled","name":"Auto"},{"value":"medium","name":"Medium"},{"value":"xhigh","name":"Extra high"}]}]}}'
          ;;
      esac
    done
    exit 0
    ;;
esac
input=$(cat)
case " $* " in
  *" --input-format stream-json "*)
    printf '%s\n' '{"type":"control_response","response":{"response":{"models":[{"id":"default-model","name":"Default"},{"id":"codebuddy-user-model","name":"User Model"}],"commands":[{"name":"/effort"}],"account":{"authenticated":true},"currentModelId":"codebuddy-user-model"}}}'
    ;;
  *)
    if [ ! -f "$mcp_config" ] || ! grep -q '"mcpServers"' "$mcp_config"; then
      printf '%s\n' 'invalid MCP configuration' >&2
      exit 10
    fi
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"isolated execution"}]}}'
    printf '%s\n' '{"type":"result","subtype":"success"}'
    ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let mut config = codebuddy_config("default");
        config.codebuddy_cli_path = Some(executable.to_string_lossy().to_string());
        config.codebuddy_cli_env.insert("CODEBUDDY_CONFIG_DIR".to_string(), auth_dir.to_string_lossy().to_string());
        config.codebuddy_cli_env.insert("DBX_TEST_PROJECT_DIR".to_string(), project_dir.to_string_lossy().to_string());
        config.codebuddy_cli_env.insert("DBX_TEST_HOOK_MARKER".to_string(), hook_marker.to_string_lossy().to_string());
        (config, project_dir, hook_marker)
    }

    #[cfg(unix)]
    #[test]
    fn resolves_codebuddy_executable_from_a_configured_directory() {
        let (mut config, project_dir, _) = isolated_cli_test_config();
        config.codebuddy_cli_path = Some(project_dir.to_string_lossy().to_string());
        assert_eq!(validate_codebuddy_program(&config).unwrap(), project_dir.join("codebuddy").to_string_lossy());
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_and_connection_test_use_initialize_without_inference() {
        let (config, project_dir, hook_marker) = isolated_cli_test_config();
        let models = list_codebuddy_models(&config).await.unwrap();
        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            ["default", "codebuddy-user-model"]
        );
        assert!(models.iter().all(|model| model.effort_capability.is_none()));
        let result = test_codebuddy_connection(&config).await.unwrap();
        assert!(result.success);
        assert_eq!(result.model_used, "codebuddy-user-model");
        let default_effort = resolve_codebuddy_model_effort(&config, "default").await.unwrap();
        assert!(matches!(
            default_effort,
            AiEffortCapability::Enum { options, default: AiEffortSelection::ProviderDefault, .. }
                if options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>() == ["low", "high"]
        ));
        let explicit_effort = crate::ai::resolve_model_effort_core(&config, "codebuddy-user-model").await.unwrap();
        assert!(matches!(
            explicit_effort,
            AiEffortCapability::Enum { options, default: AiEffortSelection::ProviderDefault, .. }
                if options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>() == ["medium", "xhigh"]
        ));
        assert!(!hook_marker.exists());
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execution_uses_temporary_mcp_config_from_isolated_directory() {
        let (config, project_dir, hook_marker) = isolated_cli_test_config();
        let output = run_codebuddy_agent(&config, "hello", run_options(), &Notify::new(), |_| {}).await.unwrap();
        assert_eq!(output, "isolated execution");
        assert!(!hook_marker.exists());
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[cfg(unix)]
    fn live_config() -> AiConfig {
        let mut config =
            codebuddy_config(&std::env::var("DBX_LIVE_CODEBUDDY_MODEL").unwrap_or_else(|_| "default".to_string()));
        config.codebuddy_cli_path = std::env::var("DBX_LIVE_CODEBUDDY_PATH").ok();
        config
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires an installed and authenticated CodeBuddy Code CLI"]
    async fn live_model_discovery_and_connection_test() {
        let config = live_config();
        let models = list_codebuddy_models(&config).await.unwrap();
        assert!(models.iter().any(|model| model.id == "default"));
        let default_effort = crate::ai::resolve_model_effort_core(&config, "default").await.unwrap();
        assert!(matches!(
            default_effort,
            AiEffortCapability::Enum { ref options, default: AiEffortSelection::ProviderDefault, source: crate::ai::AiCapabilitySource::LocalCli }
                if !options.is_empty()
        ));
        if let Some(model) = models.iter().find(|model| model.id != "default") {
            let explicit_effort = crate::ai::resolve_model_effort_core(&config, &model.id).await.unwrap();
            assert!(matches!(
                explicit_effort,
                AiEffortCapability::Enum { ref options, default: AiEffortSelection::ProviderDefault, source: crate::ai::AiCapabilitySource::LocalCli }
                    if !options.is_empty()
            ));
        }
        let result = test_codebuddy_connection(&config).await.unwrap();
        assert!(result.success);
        assert!(result.latency_ms.is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires CodeBuddy Code, a running DBX MCP bridge, and DBX_LIVE_MCP_CONNECTION_NAME/DATABASE"]
    async fn live_scoped_dbx_mcp_agent_run() {
        let config = live_config();
        let connection_name = std::env::var("DBX_LIVE_MCP_CONNECTION_NAME")
            .expect("set DBX_LIVE_MCP_CONNECTION_NAME to a saved DBX connection");
        let database = std::env::var("DBX_LIVE_MCP_DATABASE").expect("set DBX_LIVE_MCP_DATABASE to a visible database");
        let mcp_command = std::env::var("DBX_LIVE_MCP_COMMAND").unwrap_or_else(|_| "dbx-mcp-server".to_string());
        let options = CodeBuddyRunOptions {
            connection_id: String::new(),
            connection_name: connection_name.clone(),
            database,
            schema: None,
            agent_mode: false,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CliAgentCommandSpec { program: mcp_command, args: Vec::new() }),
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let result = tokio::time::timeout(
            Duration::from_secs(90),
            run_codebuddy_agent(
                &config,
                "You must use the DBX MCP list-connections tool. Reply with the visible connection name only.",
                options,
                &Notify::new(),
                move |event| captured.lock().unwrap().push(event),
            ),
        )
        .await
        .expect("CodeBuddy MCP smoke test timed out")
        .unwrap();

        let events = events.lock().unwrap();
        assert!(
            events.iter().any(
                |event| matches!(event, AgentEvent::ToolCallStart { tool_name, .. } if tool_name.contains("dbx_list_connections"))
            ),
            "CodeBuddy did not emit a DBX tool-call start; result={result:?}, events={events:#?}"
        );
        assert!(
            events.iter().any(|event| matches!(event, AgentEvent::ToolCallEnd { is_error: false, .. })),
            "CodeBuddy did not emit a successful DBX tool-call end; result={result:?}, events={events:#?}"
        );
        assert!(
            result.contains(&connection_name),
            "CodeBuddy did not include the scoped connection name in its final response: {result:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires CodeBuddy Code, a running DBX MCP bridge, and a seeded DBX_LIVE_MCP connection"]
    async fn live_scoped_dbx_mcp_query() {
        let config = live_config();
        let connection_name = std::env::var("DBX_LIVE_MCP_CONNECTION_NAME")
            .expect("set DBX_LIVE_MCP_CONNECTION_NAME to a saved DBX connection");
        let database = std::env::var("DBX_LIVE_MCP_DATABASE").expect("set DBX_LIVE_MCP_DATABASE to a visible database");
        let expected = std::env::var("DBX_LIVE_MCP_EXPECTED_VALUE").expect("set DBX_LIVE_MCP_EXPECTED_VALUE");
        let mcp_command = std::env::var("DBX_LIVE_MCP_COMMAND").unwrap_or_else(|_| "dbx-mcp-server".to_string());
        let options = CodeBuddyRunOptions {
            connection_id: String::new(),
            connection_name,
            database,
            schema: None,
            agent_mode: true,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CliAgentCommandSpec { program: mcp_command, args: Vec::new() }),
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let result = tokio::time::timeout(
            Duration::from_secs(90),
            run_codebuddy_agent(
                &config,
                "Use the DBX MCP execute-query tool to run exactly this read-only SQL: SELECT metric_value FROM codebuddy_e2e_metrics WHERE metric_name = 'verified_rows'. Reply with the returned numeric value only.",
                options,
                &Notify::new(),
                move |event| captured.lock().unwrap().push(event),
            ),
        )
        .await
        .expect("CodeBuddy database-query smoke test timed out")
        .unwrap();

        let events = events.lock().unwrap();
        assert!(
            events.iter().any(
                |event| matches!(event, AgentEvent::ToolCallStart { tool_name, .. } if tool_name.contains("dbx_execute_query"))
            ),
            "CodeBuddy did not invoke DBX execute-query; result={result:?}, events={events:#?}"
        );
        assert!(events.iter().any(|event| matches!(event, AgentEvent::ToolCallEnd { is_error: false, .. })));
        assert!(result.contains(&expected), "CodeBuddy did not return the seeded value; result={result:?}");
    }
}
