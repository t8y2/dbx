use crate::agent_events::AgentEvent;
use crate::ai::{AiConfig, AiEffortLevel, AiModelInfo, AiTestConnectionResult};
use crate::ai_cli_agent::{
    build_cli_agent_prompt, cli_command, dbx_mcp_enabled_tools, dbx_mcp_scope_env, model_infos, parse_cli_jsonl_event,
    run_cli_jsonl_agent, CliAgentCommandSpec, CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

const DEFAULT_CLAUDE_CODE_MODELS: &[&str] = &["default", "sonnet", "opus", "fable"];
const CLAUDE_CODE_MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_CODE_SETTING_SOURCES: &str = "user";

pub type ClaudeCodeRunOptions = CliAgentRunOptions;
pub type ClaudeCodeCommandSpec = CliAgentCommandSpec;

struct ClaudeCodeIsolatedCwd {
    path: PathBuf,
}

impl ClaudeCodeIsolatedCwd {
    fn create() -> Result<Self, String> {
        let path = env::temp_dir().join(format!("dbx-claude-code-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).map_err(|error| {
            format!("[claudeCodeRunFailed] Failed to create isolated Claude Code directory: {error}")
        })?;
        Ok(Self { path })
    }

    fn write_mcp_config(&self, config: &str) -> Result<PathBuf, String> {
        let path = self.path.join("mcp.json");
        std::fs::write(&path, config)
            .map_err(|error| format!("[claudeCodeRunFailed] Failed to write temporary MCP configuration: {error}"))?;
        Ok(path)
    }
}

impl Drop for ClaudeCodeIsolatedCwd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn append_claude_code_isolation_args(args: &mut Vec<String>) {
    // User settings retain authentication and preferences without loading project hooks or local overrides.
    args.extend(["--setting-sources".to_string(), CLAUDE_CODE_SETTING_SOURCES.to_string()]);
}

fn claude_code_program(config: &AiConfig) -> String {
    config
        .claude_code_cli_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("claude")
        .to_string()
}

fn claude_code_process_env(
    config: &AiConfig,
    command: &ClaudeCodeCommandSpec,
) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::from_iter(claude_code_cli_env(config)?);
    if let Some(dir) = command_parent_dir(command) {
        let user_path = env.get("PATH").map(String::as_str);
        env.insert("PATH".to_string(), merged_path_with_dir(&dir, user_path));
    }
    Ok(env.into_iter().collect())
}

fn command_parent_dir(command: &ClaudeCodeCommandSpec) -> Option<String> {
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

fn validate_claude_code_program(config: &AiConfig) -> Result<String, String> {
    let program = claude_code_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[claudeCodeCliPathInvalid] Claude Code CLI path should contain only the executable path. Add environment variables in the Claude Code CLI environment variables section.".to_string());
    }
    if is_path_like_program(&program) {
        let expanded = crate::path_utils::expand_tilde(&program);
        let path = Path::new(&expanded);
        if path.is_dir() {
            return launchable_program_in_dir(path, "claude").ok_or_else(|| {
                "[claudeCodeCliPathInvalid] Claude Code CLI path should point to the claude executable or a directory containing claude."
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

pub fn claude_code_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::new();
    for (key, value) in &config.claude_code_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[claudeCodeEnvInvalid] Invalid Claude Code CLI environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        if is_reserved_dbx_mcp_env_name(key) {
            return Err(format!(
                "[claudeCodeEnvReserved] `{key}` is managed by DBX for the scoped MCP server and cannot be set here."
            ));
        }
        env.insert(key.to_string(), value.clone());
    }
    Ok(env.into_iter().collect())
}

pub fn claude_code_enabled_tools(agent_mode: bool) -> Vec<String> {
    dbx_mcp_enabled_tools(agent_mode).into_iter().map(|tool| format!("mcp__dbx__{tool}")).collect()
}

fn claude_code_mcp_config(options: &ClaudeCodeRunOptions) -> String {
    let mcp_command =
        options.mcp_server_command.as_ref().map(|command| command.program.as_str()).unwrap_or("dbx-mcp-server");
    let mut server = Map::new();
    server.insert("command".to_string(), Value::String(mcp_command.to_string()));
    if let Some(command) = options.mcp_server_command.as_ref().filter(|command| !command.args.is_empty()) {
        server.insert("args".to_string(), json!(command.args));
    }

    let env = dbx_mcp_scope_env(options)
        .into_iter()
        .map(|(name, value)| (name.to_string(), Value::String(value)))
        .collect::<Map<_, _>>();
    server.insert("env".to_string(), Value::Object(env));

    json!({
        "mcpServers": {
            "dbx": Value::Object(server)
        }
    })
    .to_string()
}

pub fn build_claude_code_command(
    config: &AiConfig,
    _prompt: &str,
    options: &ClaudeCodeRunOptions,
) -> ClaudeCodeCommandSpec {
    build_claude_code_command_with_mcp_arg(config, options, claude_code_mcp_config(options))
}

fn build_claude_code_command_with_mcp_arg(
    config: &AiConfig,
    options: &ClaudeCodeRunOptions,
    mcp_config_arg: String,
) -> ClaudeCodeCommandSpec {
    let enabled_tools = claude_code_enabled_tools(options.agent_mode);
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
    ];
    append_claude_code_isolation_args(&mut args);
    args.push("--tools".to_string());
    args.extend(enabled_tools.iter().cloned());
    args.push("--allowedTools".to_string());
    args.extend(enabled_tools);

    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = config.reasoning_level.as_claude_code_effort() {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }

    ClaudeCodeCommandSpec { program: claude_code_program(config), args }
}

pub fn build_claude_code_prompt(
    system_prompt: &str,
    messages: &[crate::ai::AiMessage],
    allow_write_sql: bool,
) -> String {
    build_cli_agent_prompt("Claude Code", system_prompt, messages, allow_write_sql)
}

pub async fn list_claude_code_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let program = validate_claude_code_program(config)?;
    Ok(discover_claude_code_models(config, program).await.unwrap_or_else(|| model_infos(DEFAULT_CLAUDE_CODE_MODELS)))
}

async fn discover_claude_code_models(config: &AiConfig, program: String) -> Option<Vec<AiModelInfo>> {
    let mut command = ClaudeCodeCommandSpec {
        program,
        args: vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ],
    };
    append_claude_code_isolation_args(&mut command.args);
    let env = claude_code_process_env(config, &command).ok()?;
    let isolated_cwd = ClaudeCodeIsolatedCwd::create().ok()?;
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

    let mut child = process.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut request = serde_json::to_vec(&json!({
        "type": "control_request",
        "request_id": "dbx_model_discovery",
        "request": { "subtype": "initialize" }
    }))
    .ok()?;
    request.push(b'\n');
    stdin.write_all(&request).await.ok()?;
    drop(stdin);

    let output =
        tokio::time::timeout(CLAUDE_CODE_MODEL_DISCOVERY_TIMEOUT, child.wait_with_output()).await.ok()?.ok()?;
    parse_claude_code_models(&String::from_utf8_lossy(&output.stdout))
}

fn parse_claude_code_models(stdout: &str) -> Option<Vec<AiModelInfo>> {
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
        let Some(models) = data.get("models").and_then(Value::as_array) else {
            continue;
        };
        let mut seen = BTreeSet::new();
        let mut result = Vec::new();
        for model in models {
            let Some(id) = model
                .get("value")
                .and_then(Value::as_str)
                .or_else(|| model.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if !seen.insert(id.to_string()) {
                continue;
            }
            let display_name = model
                .get("displayName")
                .and_then(Value::as_str)
                .or_else(|| model.get("display_name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(ToString::to_string);
            let mut info = AiModelInfo::new(id, display_name);
            info.supported_effort_levels = parse_claude_code_effort_levels(model);
            result.push(info);
        }

        if result.is_empty() {
            return None;
        }
        if seen.insert("default".to_string()) {
            result.insert(0, AiModelInfo::new("default", Some("Default".to_string())));
        }
        return Some(result);
    }

    None
}

fn parse_claude_code_effort_levels(model: &Value) -> Vec<AiEffortLevel> {
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
        .filter_map(|level| level.parse::<AiEffortLevel>().ok())
        .filter(|level| seen.insert(*level))
        .collect()
}

pub async fn test_claude_code_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    let claude_command = ClaudeCodeCommandSpec { program: validate_claude_code_program(config)?, args: Vec::new() };
    let mut command = cli_command(&claude_command.program);
    command.args(claude_command.args.iter().map(String::as_str));
    command.args(["auth", "status"]);
    command.envs(
        claude_code_process_env(config, &claude_command)?.iter().map(|(key, value)| (key.as_str(), value.as_str())),
    );

    let output = command.output().await.map_err(|e| classify_claude_code_spawn_error(&e.to_string()))?;

    if output.status.success() {
        Ok(AiTestConnectionResult {
            success: true,
            message: format!("OK - {}ms", start.elapsed().as_millis()),
            latency_ms: Some(start.elapsed().as_millis() as u64),
            model_used: config.model.trim().to_string(),
            error_category: None,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message =
            [stderr.trim(), stdout.trim()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n");
        Err(classify_claude_code_run_error(&message))
    }
}

fn classify_claude_code_spawn_error(message: &str) -> String {
    if message.contains("No such file") || message.contains("not found") {
        format!("[claudeCodeNotInstalled] {message}")
    } else if is_command_line_too_long_error(message) {
        format!("[claudeCodeCommandLineTooLong] {message}")
    } else {
        format!("[claudeCodeRunFailed] {message}")
    }
}

fn is_command_line_too_long_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("os error 206")
        || message.contains("文件名或扩展名太长")
        || lower.contains("filename or extension is too long")
        || lower.contains("the filename or extension is too long")
}

fn classify_claude_code_run_error(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("invalid mcp configuration") || lower.contains("mcp config file not found") {
        format!("[claudeCodeMcpConfigInvalid] {stderr}")
    } else if lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("please login")
    {
        format!("[claudeCodeNotAuthenticated] {stderr}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] {stderr}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[claudeCodeMcpStartupFailed] {stderr}")
    } else {
        format!("[claudeCodeRunFailed] {stderr}")
    }
}

pub fn parse_claude_code_jsonl_event(line: &str) -> Option<Vec<AgentEvent>> {
    parse_cli_jsonl_event(line, CliAgentJsonlDialect::ClaudeCodePrint)
}

pub async fn run_claude_code_agent(
    config: &AiConfig,
    prompt: &str,
    options: ClaudeCodeRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let program = validate_claude_code_program(config)?;
    let isolated_cwd = ClaudeCodeIsolatedCwd::create()?;
    let mcp_config_path = isolated_cwd.write_mcp_config(&claude_code_mcp_config(&options))?;
    let mut command =
        build_claude_code_command_with_mcp_arg(config, &options, mcp_config_path.to_string_lossy().to_string());
    command.program = program;
    let env = claude_code_process_env(config, &command)?;
    let result = run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
            env,
            current_dir: Some(isolated_cwd.path.clone()),
            stdin: Some(prompt.to_string()),
            dialect: CliAgentJsonlDialect::ClaudeCodePrint,
            classify_spawn_error: classify_claude_code_spawn_error,
            classify_run_error: classify_claude_code_run_error,
        },
        cancelled,
        on_event,
    )
    .await;
    result
}

#[cfg(test)]
mod tests {
    use super::{
        build_claude_code_command, classify_claude_code_run_error, claude_code_cli_env, claude_code_enabled_tools,
        parse_claude_code_jsonl_event, parse_claude_code_models, validate_claude_code_program, ClaudeCodeRunOptions,
        DEFAULT_CLAUDE_CODE_MODELS,
    };
    #[cfg(unix)]
    use super::{list_claude_code_models, run_claude_code_agent};
    use crate::agent_events::AgentEvent;
    use crate::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiEffortLevel, AiModelInfo, AiProvider, AiReasoningLevel};
    use crate::ai_cli_agent::{model_infos, CliAgentCommandSpec};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use tokio::sync::Notify;

    fn claude_code_config(model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::ClaudeCodeCli,
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
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
            claude_code_cli_path: None,
            claude_code_cli_env: Default::default(),
        }
    }

    fn run_options() -> ClaudeCodeRunOptions {
        ClaudeCodeRunOptions {
            connection_id: "conn-1".to_string(),
            connection_name: "local".to_string(),
            database: "demo".to_string(),
            agent_mode: true,
            allow_writes: false,
            allow_dangerous: false,
            mcp_server_command: None,
        }
    }

    #[cfg(unix)]
    fn isolated_cli_test_config() -> (AiConfig, std::path::PathBuf, std::path::PathBuf) {
        let project_dir = std::env::temp_dir().join(format!("dbx-claude-project-test-{}", uuid::Uuid::new_v4()));
        let claude_dir = project_dir.join(".claude");
        let user_config_dir = project_dir.join("user-config");
        let hook_marker = project_dir.join("project-hook-loaded");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&user_config_dir).unwrap();
        std::fs::write(user_config_dir.join("auth-marker"), "authenticated").unwrap();
        std::fs::write(
            claude_dir.join("settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "model": "project-model-must-not-load",
                "hooks": {
                    "SessionStart": [{
                        "matcher": "",
                        "hooks": [{
                            "type": "command",
                            "command": format!("printf loaded > {}", hook_marker.display())
                        }]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let executable = project_dir.join("claude");
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
if [ ! -f "$CLAUDE_CONFIG_DIR/auth-marker" ]; then
  exit 9
fi
input=$(cat)
case " $* " in
  *" --input-format stream-json "*)
    printf '%s\n' '{"type":"control_response","response":{"response":{"models":[{"value":"claude-user-model","displayName":"User Model"}]}}}'
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

        let mut config = claude_code_config("default");
        config.claude_code_cli_path = Some(executable.to_string_lossy().to_string());
        config
            .claude_code_cli_env
            .insert("CLAUDE_CONFIG_DIR".to_string(), user_config_dir.to_string_lossy().to_string());
        config
            .claude_code_cli_env
            .insert("DBX_TEST_PROJECT_DIR".to_string(), project_dir.to_string_lossy().to_string());
        config
            .claude_code_cli_env
            .insert("DBX_TEST_HOOK_MARKER".to_string(), hook_marker.to_string_lossy().to_string());

        (config, project_dir, hook_marker)
    }

    #[test]
    fn builds_claude_code_command_with_scoped_mcp_and_default_model() {
        let spec = build_claude_code_command(&claude_code_config("default"), "hello", &run_options());

        assert_eq!(spec.program, "claude");
        assert!(spec.args.contains(&"--print".to_string()));
        assert!(spec.args.contains(&"stream-json".to_string()));
        assert!(spec.args.contains(&"--mcp-config".to_string()));
        assert!(spec.args.windows(2).any(|args| args == ["--setting-sources", "user"]));
        assert!(
            spec.args.iter().position(|arg| arg == "--setting-sources")
                < spec.args.iter().position(|arg| arg == "--tools")
        );
        assert!(!spec.args.contains(&"hello".to_string()));
        assert!(!spec.args.contains(&"--model".to_string()));
        assert!(!spec.args.contains(&"--effort".to_string()));
        assert!(spec.args.iter().any(|arg| arg.contains("\"command\":\"dbx-mcp-server\"")));
        assert!(spec.args.iter().any(|arg| arg.contains("\"DBX_MCP_ALLOW_WRITES\":\"0\"")));
        assert!(spec.args.iter().any(|arg| arg.contains("\"DBX_MCP_SCOPE_CONNECTION_ID\":\"conn-1\"")));
        assert!(spec.args.iter().any(|arg| arg.contains("mcp__dbx__dbx_execute_query")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn model_discovery_uses_user_settings_from_an_isolated_directory() {
        let (config, project_dir, hook_marker) = isolated_cli_test_config();

        let models = list_claude_code_models(&config).await.unwrap();

        assert!(models.iter().any(|model| model.id == "claude-user-model"));
        assert!(!hook_marker.exists());
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execution_uses_user_settings_and_temporary_mcp_config_from_an_isolated_directory() {
        let (config, project_dir, hook_marker) = isolated_cli_test_config();

        let output = run_claude_code_agent(&config, "hello", run_options(), &Notify::new(), |_| {}).await.unwrap();

        assert_eq!(output, "isolated execution");
        assert!(!hook_marker.exists());
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[test]
    fn builds_claude_code_command_with_custom_mcp_server_and_ask_tools() {
        let mut options = run_options();
        options.agent_mode = false;
        options.mcp_server_command = Some(CliAgentCommandSpec {
            program: "/opt/dbx/bin/dbx-mcp-server".to_string(),
            args: vec!["--stdio".to_string()],
        });
        let spec = build_claude_code_command(&claude_code_config("sonnet"), "hello", &options);

        let model_pos = spec.args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(spec.args[model_pos + 1], "sonnet");
        assert!(spec.args.iter().any(|arg| arg.contains("\"command\":\"/opt/dbx/bin/dbx-mcp-server\"")));
        assert!(spec.args.iter().any(|arg| arg.contains("\"args\":[\"--stdio\"]")));
        assert!(!claude_code_enabled_tools(false).iter().any(|tool| tool == "mcp__dbx__dbx_execute_query"));
        assert!(!spec.args.iter().any(|arg| arg.contains("mcp__dbx__dbx_execute_query")));
    }

    #[test]
    fn builds_claude_code_command_with_supported_effort() {
        let mut config = claude_code_config("sonnet");
        config.reasoning_level = AiReasoningLevel::Xhigh;

        let spec = build_claude_code_command(&config, "hello", &run_options());

        let effort_pos = spec.args.iter().position(|arg| arg == "--effort").unwrap();
        assert_eq!(spec.args[effort_pos + 1], "xhigh");

        config.reasoning_level = AiReasoningLevel::Minimal;
        let spec = build_claude_code_command(&config, "hello", &run_options());
        assert!(!spec.args.contains(&"--effort".to_string()));
    }

    #[test]
    fn default_model_list_matches_supported_aliases() {
        assert_eq!(model_infos(DEFAULT_CLAUDE_CODE_MODELS), model_infos(&["default", "sonnet", "opus", "fable"]));
    }

    #[test]
    fn parses_discovered_claude_code_models() {
        let stdout = concat!(
            "not json\n",
            r#"{"type":"system","subtype":"init"}"#,
            "\n",
            r#"{"type":"control_response","response":{"subtype":"success","response":{"commands":[]}}}"#,
            "\n",
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"dbx_model_discovery","response":{"models":[{"value":"default","displayName":"Default","resolvedModel":"claude-sonnet"},{"value":"claude-sonnet-4-6","displayName":"Sonnet 4.6","supportsEffort":true,"supportedEffortLevels":["low","medium","high","max","high","future"]},{"value":"claude-sonnet-4-6","displayName":"Duplicate"},{"value":"claude-opus-4-8","display_name":"Opus 4.8","supports_effort":false,"supported_effort_levels":["low"]}]}}}"#
        );

        let models = parse_claude_code_models(stdout).unwrap();

        assert_eq!(
            models,
            vec![
                AiModelInfo::new("default", Some("Default".to_string())),
                AiModelInfo {
                    id: "claude-sonnet-4-6".to_string(),
                    display_name: Some("Sonnet 4.6".to_string()),
                    supported_effort_levels: vec![
                        AiEffortLevel::Low,
                        AiEffortLevel::Medium,
                        AiEffortLevel::High,
                        AiEffortLevel::Max
                    ],
                },
                AiModelInfo::new("claude-opus-4-8", Some("Opus 4.8".to_string())),
            ]
        );
    }

    #[test]
    fn adds_default_to_discovered_claude_code_models_when_missing() {
        let stdout = r#"{"type":"control_response","response":{"models":[{"id":"claude-haiku-4-5","displayName":"Haiku 4.5"}]}}"#;

        let models = parse_claude_code_models(stdout).unwrap();

        assert_eq!(models[0].id, "default");
        assert_eq!(models[1].id, "claude-haiku-4-5");
    }

    #[test]
    fn rejects_claude_code_initialize_response_without_models() {
        let stdout = r#"{"type":"control_response","response":{"subtype":"success","response":{"commands":[]}}}"#;

        assert!(parse_claude_code_models(stdout).is_none());
    }

    #[test]
    fn invalid_mcp_config_is_not_reported_as_a_missing_server_package() {
        let error = classify_claude_code_run_error(
            r#"Invalid MCP configuration: MCP config file not found: C:\Temp\{mcpServers:{dbx:{args:[C:\node_modules\@dbx-app\mcp-server\bin\dbx-mcp-server.js]}}}"#,
        );

        assert!(error.starts_with("[claudeCodeMcpConfigInvalid]"));
        assert!(!error.contains("[dbxMcpMissing]"));
    }

    #[test]
    fn invalid_mcp_config_path_containing_auth_is_not_reported_as_authentication_failure() {
        let error = classify_claude_code_run_error(
            r#"Invalid MCP configuration: MCP config file not found: C:\Users\auth-test\AppData\Local\Temp\dbx\mcp.json"#,
        );

        assert!(error.starts_with("[claudeCodeMcpConfigInvalid]"));
        assert!(!error.contains("[claudeCodeNotAuthenticated]"));
    }

    #[test]
    fn normalizes_claude_code_cli_env() {
        let mut config = claude_code_config("default");
        config.claude_code_cli_env.insert(" HTTPS_PROXY ".to_string(), "http://proxy:9800".to_string());
        config.claude_code_cli_env.insert("NO_PROXY".to_string(), "localhost,127.0.0.1".to_string());

        let env = claude_code_cli_env(&config).unwrap();

        assert_eq!(
            env,
            vec![
                ("HTTPS_PROXY".to_string(), "http://proxy:9800".to_string()),
                ("NO_PROXY".to_string(), "localhost,127.0.0.1".to_string())
            ]
        );
    }

    #[test]
    fn rejects_reserved_dbx_mcp_env_name() {
        let mut config = claude_code_config("default");
        config.claude_code_cli_env.insert("DBX_MCP_SCOPE_DATABASE".to_string(), "main".to_string());

        let err = claude_code_cli_env(&config).unwrap_err();

        assert!(err.contains("[claudeCodeEnvReserved]"));
    }

    #[test]
    fn rejects_shell_style_env_prefix_in_claude_code_cli_path() {
        let mut config = claude_code_config("default");
        config.claude_code_cli_path = Some("HTTPS_PROXY=http://proxy:9800 /opt/homebrew/bin/claude".to_string());

        let err = validate_claude_code_program(&config).unwrap_err();

        assert!(err.contains("[claudeCodeCliPathInvalid]"));
        assert!(err.contains("environment variables section"));
    }

    #[test]
    fn resolves_claude_code_executable_from_configured_directory() {
        let dir = std::env::temp_dir().join(format!("dbx-claude-code-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join(if cfg!(windows) { "claude.cmd" } else { "claude" });
        std::fs::write(&executable, "").unwrap();
        let mut config = claude_code_config("default");
        config.claude_code_cli_path = Some(dir.to_string_lossy().to_string());

        let resolved = validate_claude_code_program(&config).unwrap();

        assert_eq!(resolved, executable.to_string_lossy());
        let _ = std::fs::remove_file(executable);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn parses_claude_code_jsonl_events() {
        let started = parse_claude_code_jsonl_event(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"mcp__dbx__dbx_list_tables","input":{"schema":"public"}}]}}"#,
        )
        .unwrap();
        assert!(
            matches!(&started[0], AgentEvent::ToolCallStart { tool_name, args, .. } if tool_name == "mcp__dbx__dbx_list_tables" && args["schema"] == "public")
        );

        let text = parse_claude_code_jsonl_event(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done"}]}}"#,
        )
        .unwrap();
        assert!(matches!(&text[0], AgentEvent::TextDelta { delta } if delta == "Done"));

        let tool_result = parse_claude_code_jsonl_event(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"users"}],"is_error":false}]}}"#,
        )
        .unwrap();
        assert!(
            matches!(&tool_result[0], AgentEvent::ToolCallEnd { tool_call_id, result, is_error, .. } if tool_call_id == "tool-1" && result[0]["text"] == "users" && !is_error)
        );

        let done = parse_claude_code_jsonl_event(
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":12,"output_tokens":3}}"#,
        )
        .unwrap();
        assert!(matches!(&done[0], AgentEvent::AgentEnd { input_tokens: Some(12), output_tokens: Some(3) }));

        let failed = parse_claude_code_jsonl_event(
            r#"{"type":"result","subtype":"error_max_turns","message":"too many turns"}"#,
        )
        .unwrap();
        assert!(matches!(&failed[0], AgentEvent::Error { message } if message == "too many turns"));
    }
}
