use crate::agent_events::AgentEvent;
use crate::ai::{AiConfig, AiModelInfo, AiTestConnectionResult};
use crate::ai_cli_agent::{
    append_config_overrides, build_cli_agent_prompt, cli_command, dbx_mcp_enabled_tools, dbx_mcp_scope_env,
    model_infos, parse_cli_jsonl_event, run_cli_jsonl_agent, toml_string, toml_string_array, CliAgentCommandSpec,
    CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;
use tokio::process::Command;
use tokio::sync::Notify;

const DEFAULT_CODEX_MODELS: &[&str] = &["default", "gpt-5.5", "gpt-5.4-mini"];
#[cfg(not(windows))]
const CODEX_PATH_MARKER: &str = "__DBX_CODEX_PATH__";

pub type CodexRunOptions = CliAgentRunOptions;
pub type CodexCommandSpec = CliAgentCommandSpec;

fn codex_program(config: &AiConfig) -> String {
    config.codex_cli_path.as_deref().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("codex").to_string()
}

async fn resolve_codex_command(config: &AiConfig) -> CodexCommandSpec {
    let configured = codex_program(config);
    if is_path_like_program(&configured) {
        let expanded = expand_tilde(&configured);
        return codex_command_for_program(direct_program_path(&expanded).unwrap_or(expanded));
    }
    if let Some(path) = resolve_program_path(&configured).await {
        codex_command_for_program(path)
    } else {
        CodexCommandSpec { program: configured, args: Vec::new() }
    }
}

fn codex_command_for_program(program: String) -> CodexCommandSpec {
    #[cfg(windows)]
    if let Some(command) = windows_npm_codex_shim_command(&program) {
        return command;
    }

    CodexCommandSpec { program, args: Vec::new() }
}

#[cfg(windows)]
fn windows_npm_codex_shim_command(program: &str) -> Option<CodexCommandSpec> {
    let path = Path::new(program);
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if extension != "cmd" && extension != "bat" {
        return None;
    }

    let parent = path.parent()?;
    let codex_js = parent.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js");
    if !codex_js.is_file() {
        return None;
    }

    let bundled_node = parent.join("node.exe");
    let node = if bundled_node.is_file() { bundled_node.to_string_lossy().to_string() } else { "node".to_string() };

    Some(CodexCommandSpec { program: node, args: vec![codex_js.to_string_lossy().to_string()] })
}

fn codex_process_env(config: &AiConfig, command: &CodexCommandSpec) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::from_iter(codex_cli_env(config)?);
    if let Some(dir) = command.parent_dir() {
        let user_path = env.get("PATH").map(String::as_str);
        env.insert("PATH".to_string(), merged_path_with_dir(&dir, user_path));
    }
    Ok(env.into_iter().collect())
}

trait CommandParentDir {
    fn parent_dir(&self) -> Option<String>;
}

impl CommandParentDir for CodexCommandSpec {
    fn parent_dir(&self) -> Option<String> {
        Path::new(&self.program)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_string_lossy().to_string())
    }
}

async fn resolve_program_path(program: &str) -> Option<String> {
    if let Some(path) = direct_program_path(program) {
        return Some(path);
    }
    if let Some(path) = common_program_path(program) {
        return Some(path);
    }
    shell_program_path(program).await
}

fn direct_program_path(program: &str) -> Option<String> {
    let path = Path::new(program);
    if !path.is_absolute() {
        return None;
    }

    if path.is_dir() {
        return launchable_program_in_dir(path, "codex");
    }

    if path.is_file() {
        #[cfg(windows)]
        return windows_launchable_program_path(path);
        #[cfg(not(windows))]
        return Some(path.to_string_lossy().to_string());
    }

    None
}

fn launchable_program_in_dir(dir: &Path, program: &str) -> Option<String> {
    program_path_candidates(dir, program)
        .into_iter()
        .find(|candidate| is_launchable_program_path(candidate) && candidate.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(windows)]
fn windows_launchable_program_path(path: &Path) -> Option<String> {
    if is_windows_launchable_program(path) {
        return Some(path.to_string_lossy().to_string());
    }
    let parent = path.parent()?;
    let stem = path.file_name()?.to_str()?;
    program_path_candidates(parent, stem)
        .into_iter()
        .find(|candidate| is_windows_launchable_program(candidate))
        .and_then(|candidate| candidate.is_file().then(|| candidate.to_string_lossy().to_string()))
}

#[cfg(windows)]
fn is_windows_launchable_program(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("exe" | "cmd" | "bat" | "com")
    )
}

fn common_program_path(program: &str) -> Option<String> {
    common_executable_dirs()
        .into_iter()
        .flat_map(|dir| program_path_candidates(&dir, program))
        .filter(|path| is_launchable_program_path(path))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(not(windows))]
fn is_launchable_program_path(_path: &Path) -> bool {
    true
}

#[cfg(windows)]
fn is_launchable_program_path(path: &Path) -> bool {
    is_windows_launchable_program(path)
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
    [".cmd", ".exe", ".bat", ".com", "", ".ps1"]
        .iter()
        .map(|extension| dir.join(format!("{program}{extension}")))
        .collect()
}

#[cfg(not(windows))]
async fn shell_program_path(program: &str) -> Option<String> {
    let script = shell_resolve_script(program);
    let mut command = Command::new(user_shell());
    command.args(user_shell_args(&script));
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let output = command.output().await.ok()?;
    output.status.success().then_some(())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .find(CODEX_PATH_MARKER)
        .and_then(|index| {
            stdout[index + CODEX_PATH_MARKER.len()..].lines().map(str::trim).find(|line| !line.is_empty())
        })
        .filter(|path| Path::new(path).is_file())
        .map(ToString::to_string)
}

#[cfg(windows)]
async fn shell_program_path(program: &str) -> Option<String> {
    let script = format!("(Get-Command -All {} -ErrorAction SilentlyContinue).Source", windows_shell_quote(program));
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-Command", &script]);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let output = command.output().await.ok()?;
    output.status.success().then_some(())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    first_windows_program_path(&stdout)
}

#[cfg(windows)]
fn first_windows_program_path(value: &str) -> Option<String> {
    let paths = value.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    paths
        .into_iter()
        .find(|path| is_windows_launchable_program(Path::new(path)) && Path::new(path).is_file())
        .map(ToOwned::to_owned)
}

#[cfg(windows)]
fn windows_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn is_path_like_program(program: &str) -> bool {
    program.contains('/') || program.contains('\\') || program.starts_with('~')
}

fn expand_tilde(path: &str) -> String {
    crate::path_utils::expand_tilde(path)
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

#[cfg(not(windows))]
fn user_shell() -> String {
    env::var("SHELL").ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| {
        if Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/sh".to_string()
        }
    })
}

#[cfg(not(windows))]
fn user_shell_args(script: &str) -> Vec<String> {
    let shell = user_shell();
    let shell_name = Path::new(&shell).file_name().and_then(|value| value.to_str()).unwrap_or_default();
    match shell_name {
        "fish" => vec!["-l".to_string(), "-i".to_string(), "-c".to_string(), script.to_string()],
        "bash" => vec![
            "--noprofile".to_string(),
            "--norc".to_string(),
            "-i".to_string(),
            "-c".to_string(),
            bash_login_script(script),
        ],
        "sh" | "dash" => vec!["-ic".to_string(), script.to_string()],
        "zsh" => vec!["-ilc".to_string(), script.to_string()],
        _ => vec!["-lc".to_string(), script.to_string()],
    }
}

#[cfg(not(windows))]
fn bash_login_script(script: &str) -> String {
    format!(
        "for dbx_profile in ~/.bash_profile ~/.bash_login ~/.profile ~/.bashrc; do \
         [ -r \"$dbx_profile\" ] && . \"$dbx_profile\"; \
         done; unset dbx_profile; {script}"
    )
}

#[cfg(not(windows))]
fn shell_resolve_script(program: &str) -> String {
    format!("printf '%s\\n' {}; command -v {}", shell_quote(CODEX_PATH_MARKER), shell_quote(program))
}

#[cfg(not(windows))]
fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn validate_codex_program(config: &AiConfig) -> Result<String, String> {
    let program = codex_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[codexCliPathInvalid] Codex CLI path should contain only the executable path. Add environment variables in the Codex CLI environment variables section.".to_string());
    }
    if is_path_like_program(&program) {
        let expanded = expand_tilde(&program);
        let path = Path::new(&expanded);
        if path.is_dir() && direct_program_path(&expanded).is_none() {
            return Err("[codexCliPathInvalid] Codex CLI path should point to the Codex executable or a directory containing codex.".to_string());
        }
    }
    Ok(program)
}

pub fn codex_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::new();
    for (key, value) in &config.codex_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[codexEnvInvalid] Invalid Codex CLI environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        if is_reserved_dbx_mcp_env_name(key) {
            return Err(format!(
                "[codexEnvReserved] `{key}` is managed by DBX for the scoped MCP server and cannot be set here."
            ));
        }
        env.insert(key.to_string(), value.clone());
    }
    Ok(env.into_iter().collect())
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

pub fn codex_enabled_tools(agent_mode: bool) -> Vec<&'static str> {
    dbx_mcp_enabled_tools(agent_mode)
}

fn codex_mcp_config_overrides(options: &CodexRunOptions) -> Vec<String> {
    let mcp_command =
        options.mcp_server_command.as_ref().map(|command| command.program.as_str()).unwrap_or("dbx-mcp-server");
    let mut overrides = vec![
        format!("mcp_servers.dbx.command={}", toml_string(mcp_command)),
        "mcp_servers.dbx.required=true".to_string(),
        "mcp_servers.dbx.startup_timeout_sec=20".to_string(),
        "mcp_servers.dbx.tool_timeout_sec=120".to_string(),
        "mcp_servers.dbx.default_tools_approval_mode=\"approve\"".to_string(),
        format!("mcp_servers.dbx.enabled_tools={}", toml_string_array(&dbx_mcp_enabled_tools(options.agent_mode))),
    ];
    if let Some(command) = options.mcp_server_command.as_ref().filter(|command| !command.args.is_empty()) {
        let args = command.args.iter().map(String::as_str).collect::<Vec<_>>();
        overrides.push(format!("mcp_servers.dbx.args={}", toml_string_array(&args)));
    }
    overrides.extend(
        dbx_mcp_scope_env(options)
            .into_iter()
            .map(|(name, value)| format!("mcp_servers.dbx.env.{name}={}", toml_string(&value))),
    );
    overrides
}

pub fn build_codex_exec_command(config: &AiConfig, prompt: &str, options: &CodexRunOptions) -> CodexCommandSpec {
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--skip-git-repo-check".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
    ];
    let mut config_overrides = vec!["features.shell_tool=false".to_string(), "web_search=\"disabled\"".to_string()];
    if let Some(reasoning_effort) = config.reasoning_level.as_codex_effort() {
        config_overrides.push(format!("model_reasoning_effort={}", toml_string(reasoning_effort)));
    }
    append_config_overrides(&mut args, config_overrides.into_iter().chain(codex_mcp_config_overrides(options)));

    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    args.push(prompt.to_string());

    CodexCommandSpec { program: codex_program(config), args }
}

pub fn build_codex_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage]) -> String {
    build_cli_agent_prompt("Codex", system_prompt, messages)
}

pub async fn list_codex_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    validate_codex_program(config)?;
    let command = resolve_codex_command(config).await;
    let output = cli_command(&command.program)
        .args(command.args.iter().map(String::as_str))
        .args(["debug", "models"])
        .envs(codex_process_env(config, &command)?.iter().map(|(key, value)| (key.as_str(), value.as_str())))
        .output()
        .await;

    let Ok(output) = output else {
        return Ok(model_infos(DEFAULT_CODEX_MODELS));
    };
    if !output.status.success() {
        return Ok(model_infos(DEFAULT_CODEX_MODELS));
    }

    Ok(parse_codex_models(&String::from_utf8_lossy(&output.stdout))
        .unwrap_or_else(|| model_infos(DEFAULT_CODEX_MODELS)))
}

fn parse_codex_models(stdout: &str) -> Option<Vec<AiModelInfo>> {
    let json_start = stdout.find('{')?;
    let data = serde_json::from_str::<Value>(&stdout[json_start..]).ok()?;
    let models = data.get("models").and_then(Value::as_array)?;

    let mut result = vec![AiModelInfo { id: "default".to_string(), display_name: Some("Default".to_string()) }];
    for model in models {
        let Some(id) = model
            .get("slug")
            .and_then(Value::as_str)
            .or_else(|| model.get("id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if result.iter().any(|existing| existing.id == id) {
            continue;
        }
        let display_name = model
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string);
        result.push(AiModelInfo { id: id.to_string(), display_name });
    }

    (result.len() > 1).then_some(result)
}

pub async fn test_codex_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    validate_codex_program(config)?;
    let codex_command = resolve_codex_command(config).await;
    let mut command = cli_command(&codex_command.program);
    command.args(codex_command.args.iter().map(String::as_str));
    command.args(["login", "status"]);
    command.envs(codex_process_env(config, &codex_command)?.iter().map(|(key, value)| (key.as_str(), value.as_str())));

    let output = command.output().await.map_err(|e| classify_codex_spawn_error(&e.to_string()))?;

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
        Err(classify_codex_run_error(&stderr))
    }
}

fn classify_codex_spawn_error(message: &str) -> String {
    if message.contains("No such file") || message.contains("not found") {
        "[codexNotInstalled] Codex CLI was not found. Install Codex CLI or set the Codex CLI path in DBX AI settings."
            .to_string()
    } else {
        format!("[codexRunFailed] Failed to start Codex CLI: {message}")
    }
}

fn classify_codex_run_error(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("not authenticated") || lower.contains("login") || lower.contains("auth") {
        format!("[codexNotAuthenticated] Codex CLI is not authenticated. Run `codex login` and try again. {stderr}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] DBX MCP server was not found. Install @dbx-app/mcp-server and try again. {stderr}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[codexMcpStartupFailed] Codex could not start the DBX MCP server. {stderr}")
    } else {
        format!("[codexRunFailed] Codex CLI failed. {stderr}")
    }
}

pub fn parse_codex_jsonl_event(line: &str) -> Option<Vec<AgentEvent>> {
    parse_cli_jsonl_event(line, CliAgentJsonlDialect::CodexExec)
}

pub async fn run_codex_agent(
    config: &AiConfig,
    prompt: &str,
    options: CodexRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    validate_codex_program(config)?;
    let mut command = build_codex_exec_command(config, prompt, &options);
    let resolved_command = resolve_codex_command(config).await;
    command.program = resolved_command.program;
    command.args.splice(0..0, resolved_command.args);
    let env = codex_process_env(config, &command)?;
    run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
            env,
            dialect: CliAgentJsonlDialect::CodexExec,
            classify_spawn_error: classify_codex_spawn_error,
            classify_run_error: classify_codex_run_error,
        },
        cancelled,
        on_event,
    )
    .await
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    use super::shell_quote;
    use super::{
        build_codex_exec_command, codex_cli_env, codex_enabled_tools, is_path_like_program, parse_codex_jsonl_event,
        parse_codex_models, validate_codex_program, CodexRunOptions, DEFAULT_CODEX_MODELS,
    };
    #[cfg(not(windows))]
    use super::{codex_process_env, common_executable_dirs, merged_path_with_dir};
    #[cfg(windows)]
    use super::{
        direct_program_path, first_windows_program_path, program_path_candidates, resolve_codex_command,
        windows_npm_codex_shim_command,
    };
    use crate::agent_events::AgentEvent;
    use crate::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiProvider, AiReasoningLevel};
    use crate::ai_cli_agent::{model_infos, CliAgentCommandSpec};

    fn codex_config(model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::CodexCli,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: String::new(),
            model: model.to_string(),
            api_style: AiApiStyle::Completions,
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            context_window: None,
            codex_cli_path: None,
            codex_cli_env: Default::default(),
        }
    }

    fn run_options() -> CodexRunOptions {
        CodexRunOptions {
            connection_id: "conn-1".to_string(),
            connection_name: "local".to_string(),
            database: "demo".to_string(),
            agent_mode: true,
            mcp_server_command: None,
        }
    }

    #[test]
    fn builds_codex_command_with_scoped_mcp_and_omits_default_model() {
        let spec = build_codex_exec_command(&codex_config("default"), "hello", &run_options());

        assert_eq!(spec.program, "codex");
        assert!(spec.args.contains(&"--json".to_string()));
        assert!(!spec.args.contains(&"--model".to_string()));
        assert!(!spec.args.contains(&"--ask-for-approval".to_string()));
        assert!(spec.args.contains(&"mcp_servers.dbx.command=\"dbx-mcp-server\"".to_string()));
        assert!(spec.args.contains(&"mcp_servers.dbx.default_tools_approval_mode=\"approve\"".to_string()));
        assert!(spec.args.contains(&"mcp_servers.dbx.env.DBX_MCP_ALLOW_WRITES=\"0\"".to_string()));
        assert!(spec.args.contains(&"mcp_servers.dbx.env.DBX_MCP_SCOPE_CONNECTION_ID=\"conn-1\"".to_string()));
        assert!(spec.args.iter().any(|arg| arg.contains("dbx_execute_query")));
    }

    #[test]
    fn builds_codex_command_with_non_default_model_and_ask_tools() {
        let mut options = run_options();
        options.agent_mode = false;
        let spec = build_codex_exec_command(&codex_config("gpt-5.5"), "hello", &options);

        let model_pos = spec.args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(spec.args[model_pos + 1], "gpt-5.5");
        assert!(!codex_enabled_tools(false).contains(&"dbx_execute_query"));
        assert!(spec.args.iter().any(|arg| arg.contains("dbx_get_schema_context")));
        assert!(!spec.args.iter().any(|arg| arg.contains("dbx_execute_query")));
    }

    #[test]
    fn builds_codex_command_with_resolved_mcp_server_path() {
        let mut options = run_options();
        options.mcp_server_command = Some(CliAgentCommandSpec {
            program: "/opt/dbx/bin/dbx-mcp-server".to_string(),
            args: vec!["--stdio".to_string()],
        });
        let spec = build_codex_exec_command(&codex_config("default"), "hello", &options);

        assert!(spec.args.contains(&"mcp_servers.dbx.command=\"/opt/dbx/bin/dbx-mcp-server\"".to_string()));
        assert!(spec.args.contains(&"mcp_servers.dbx.args=[\"--stdio\"]".to_string()));
    }

    #[test]
    fn builds_codex_command_with_reasoning_effort_override() {
        let mut config = codex_config("default");
        config.reasoning_level = AiReasoningLevel::High;
        let spec = build_codex_exec_command(&config, "hello", &run_options());

        assert!(!spec.args.contains(&"--reasoning-effort".to_string()));
        assert!(spec.args.contains(&"model_reasoning_effort=\"high\"".to_string()));
    }

    #[test]
    fn path_like_codex_programs_are_detected() {
        assert!(is_path_like_program("/opt/homebrew/bin/codex"));
        assert!(is_path_like_program("~/bin/codex"));
        assert!(is_path_like_program(r"C:\Tools\codex.exe"));
        assert!(!is_path_like_program("codex"));
    }

    #[test]
    #[cfg(windows)]
    fn windows_codex_lookup_prefers_cmd_over_extensionless_shim() {
        let candidates = program_path_candidates(std::path::Path::new(r"C:\nvm4w\nodejs"), "codex");

        assert_eq!(candidates[0], std::path::Path::new(r"C:\nvm4w\nodejs\codex.cmd"));
        assert!(candidates.iter().position(|path| path == std::path::Path::new(r"C:\nvm4w\nodejs\codex")).unwrap() > 0);
    }

    #[test]
    #[cfg(windows)]
    fn windows_shell_lookup_prefers_launchable_command() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let extensionless = dir.join("codex");
        let cmd = dir.join("codex.cmd");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\n").unwrap();

        let output = format!("{}\n{}\n", extensionless.display(), cmd.display());
        let resolved = first_windows_program_path(&output).unwrap();

        assert_eq!(resolved, cmd.to_string_lossy());
        let _ = std::fs::remove_file(extensionless);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    #[cfg(windows)]
    fn windows_direct_extensionless_path_uses_cmd_sibling() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-direct-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let extensionless = dir.join("codex");
        let cmd = dir.join("codex.cmd");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\n").unwrap();

        let resolved = direct_program_path(extensionless.to_string_lossy().as_ref()).unwrap();

        assert_eq!(resolved, cmd.to_string_lossy().as_ref());
        let _ = std::fs::remove_file(extensionless);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    #[cfg(windows)]
    fn windows_direct_extensionless_path_is_not_launchable_without_sibling() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-direct-missing-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let extensionless = dir.join("codex");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();

        let resolved = direct_program_path(extensionless.to_string_lossy().as_ref());

        assert!(resolved.is_none());
        let _ = std::fs::remove_file(extensionless);
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    #[cfg(windows)]
    fn windows_direct_directory_path_uses_codex_cmd_inside() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-direct-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let extensionless = dir.join("codex");
        let cmd = dir.join("codex.cmd");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\n").unwrap();

        let resolved = direct_program_path(dir.to_string_lossy().as_ref()).unwrap();

        assert_eq!(resolved, cmd.to_string_lossy().as_ref());
        let _ = std::fs::remove_file(extensionless);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_dir(dir);
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn windows_configured_nvm_directory_resolves_codex_cmd_shim() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-nvm-dir-test-{}", std::process::id()));
        let bin_dir = dir.join("node_modules").join("@openai").join("codex").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let cmd = dir.join("codex.cmd");
        let node = dir.join("node.exe");
        let codex_js = bin_dir.join("codex.js");
        std::fs::write(&cmd, "@echo off\nnode codex.js %*\n").unwrap();
        std::fs::write(&node, "").unwrap();
        std::fs::write(&codex_js, "#!/usr/bin/env node\n").unwrap();

        let mut config = codex_config("default");
        config.codex_cli_path = Some(dir.to_string_lossy().to_string());

        let command = resolve_codex_command(&config).await;

        assert_eq!(command.program, node.to_string_lossy().as_ref());
        assert_eq!(command.args, vec![codex_js.to_string_lossy().to_string()]);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_file(node);
        let _ = std::fs::remove_file(codex_js);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(windows)]
    fn windows_npm_codex_cmd_shim_uses_node_directly() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-npm-shim-test-{}", std::process::id()));
        let bin_dir = dir.join("node_modules").join("@openai").join("codex").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let cmd = dir.join("codex.cmd");
        let node = dir.join("node.exe");
        let codex_js = bin_dir.join("codex.js");
        std::fs::write(&cmd, "@echo off\nnode codex.js %*\n").unwrap();
        std::fs::write(&node, "").unwrap();
        std::fs::write(&codex_js, "#!/usr/bin/env node\n").unwrap();

        let command = windows_npm_codex_shim_command(cmd.to_string_lossy().as_ref()).unwrap();

        assert_eq!(command.program, node.to_string_lossy().as_ref());
        assert_eq!(command.args, vec![codex_js.to_string_lossy().to_string()]);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_file(node);
        let _ = std::fs::remove_file(codex_js);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(not(windows))]
    fn common_codex_lookup_dirs_include_homebrew_and_system_paths() {
        let dirs = common_executable_dirs();

        assert!(dirs.iter().any(|dir| dir == std::path::Path::new("/opt/homebrew/bin")));
        assert!(dirs.iter().any(|dir| dir == std::path::Path::new("/usr/local/bin")));
        assert!(dirs.iter().any(|dir| dir == std::path::Path::new("/usr/bin")));
    }

    #[test]
    #[cfg(not(windows))]
    fn codex_command_env_prepends_resolved_program_dir_and_keeps_node_dirs() {
        let config = codex_config("default");
        let command = CliAgentCommandSpec { program: "/opt/homebrew/bin/codex".to_string(), args: Vec::new() };
        let env = codex_process_env(&config, &command).unwrap();
        let path = env.iter().find(|(key, _)| key == "PATH").map(|(_, value)| value).unwrap();
        let dirs = std::env::split_paths(path).collect::<Vec<_>>();

        assert_eq!(dirs.first().unwrap(), std::path::Path::new("/opt/homebrew/bin"));
        assert!(dirs.iter().any(|dir| dir == std::path::Path::new("/usr/bin")));
    }

    #[test]
    #[cfg(not(windows))]
    fn merged_path_deduplicates_codex_dir() {
        let path = merged_path_with_dir("/opt/homebrew/bin", None);
        let dirs = std::env::split_paths(&path).collect::<Vec<_>>();
        let count = dirs.iter().filter(|dir| *dir == std::path::Path::new("/opt/homebrew/bin")).count();

        assert_eq!(count, 1);
    }

    #[test]
    #[cfg(not(windows))]
    fn codex_process_env_keeps_resolved_program_dir_before_user_path() {
        let mut config = codex_config("default");
        config.codex_cli_env.insert("PATH".to_string(), "/custom/bin:/usr/bin".to_string());
        let command = CliAgentCommandSpec { program: "/opt/homebrew/bin/codex".to_string(), args: Vec::new() };

        let env = codex_process_env(&config, &command).unwrap();
        let path = env.iter().find(|(key, _)| key == "PATH").map(|(_, value)| value).unwrap();
        let dirs = std::env::split_paths(path).collect::<Vec<_>>();

        assert_eq!(dirs.first().unwrap(), std::path::Path::new("/opt/homebrew/bin"));
        assert!(dirs.iter().any(|dir| dir == std::path::Path::new("/custom/bin")));
    }

    #[test]
    #[cfg(not(windows))]
    fn shell_quote_handles_codex_program_names() {
        assert_eq!(shell_quote("codex"), "'codex'");
        assert_eq!(shell_quote("can't"), "'can'\"'\"'t'");
    }

    #[test]
    fn default_model_list_matches_plan() {
        assert_eq!(model_infos(DEFAULT_CODEX_MODELS), model_infos(&["default", "gpt-5.5", "gpt-5.4-mini"]));
    }

    #[test]
    fn normalizes_codex_cli_env() {
        let mut config = codex_config("default");
        config.codex_cli_env.insert(" HTTPS_PROXY ".to_string(), "http://proxy:9800".to_string());
        config.codex_cli_env.insert("NO_PROXY".to_string(), "localhost,127.0.0.1".to_string());
        config.codex_cli_env.insert("".to_string(), "ignored".to_string());

        let env = codex_cli_env(&config).unwrap();

        assert_eq!(
            env,
            vec![
                ("HTTPS_PROXY".to_string(), "http://proxy:9800".to_string()),
                ("NO_PROXY".to_string(), "localhost,127.0.0.1".to_string())
            ]
        );
    }

    #[test]
    fn rejects_invalid_codex_cli_env_name() {
        let mut config = codex_config("default");
        config.codex_cli_env.insert("BAD-NAME".to_string(), "value".to_string());

        let err = codex_cli_env(&config).unwrap_err();

        assert!(err.contains("[codexEnvInvalid]"));
    }

    #[test]
    fn rejects_reserved_dbx_mcp_env_name() {
        let mut config = codex_config("default");
        config.codex_cli_env.insert("DBX_MCP_ALLOW_DANGEROUS_SQL".to_string(), "1".to_string());

        let err = codex_cli_env(&config).unwrap_err();

        assert!(err.contains("[codexEnvReserved]"));
    }

    #[test]
    fn rejects_shell_style_env_prefix_in_codex_cli_path() {
        let mut config = codex_config("default");
        config.codex_cli_path = Some("HTTPS_PROXY=http://proxy:9800 /opt/homebrew/bin/codex".to_string());

        let err = validate_codex_program(&config).unwrap_err();

        assert!(err.contains("[codexCliPathInvalid]"));
        assert!(err.contains("environment variables section"));
    }

    #[test]
    fn rejects_directory_without_codex_in_codex_cli_path() {
        let dir = std::env::temp_dir().join(format!("dbx-codex-empty-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = codex_config("default");
        config.codex_cli_path = Some(dir.to_string_lossy().to_string());

        let err = validate_codex_program(&config).unwrap_err();

        assert!(err.contains("[codexCliPathInvalid]"));
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn parses_codex_model_catalog_without_service_tiers() {
        let models = parse_codex_models(
            r#"{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","service_tiers":[{"id":"priority","name":"Priority"}]},{"slug":"gpt-5.4-mini","display_name":"GPT-5.4 mini"}]}"#,
        )
        .unwrap();

        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["default", "gpt-5.5", "gpt-5.4-mini"]
        );
        assert_eq!(models[1].display_name.as_deref(), Some("GPT-5.5"));
        assert!(!models.iter().any(|model| model.id == "priority" || model.id == "Priority"));
    }

    #[test]
    fn parses_codex_jsonl_events() {
        assert!(parse_codex_jsonl_event(r#"{"type":"thread.started","thread_id":"t"}"#).is_none());

        let started = parse_codex_jsonl_event(
            r#"{"type":"item.started","item":{"id":"tool-1","type":"mcp_tool_call","tool_name":"dbx_list_tables","arguments":{"schema":"public"}}}"#,
        )
        .unwrap();
        assert!(matches!(&started[0], AgentEvent::ToolCallStart { tool_name, .. } if tool_name == "dbx_list_tables"));

        let completed = parse_codex_jsonl_event(
            r#"{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"Done"}}"#,
        )
        .unwrap();
        assert!(matches!(&completed[0], AgentEvent::TextDelta { delta } if delta == "Done"));

        let tool_done = parse_codex_jsonl_event(
            r#"{"type":"item.completed","item":{"id":"tool-1","type":"mcp_tool_call","tool_name":"dbx_list_tables","result":{"content":"users"}}}"#,
        )
        .unwrap();
        assert!(
            matches!(&tool_done[0], AgentEvent::ToolCallEnd { tool_name, is_error, .. } if tool_name == "dbx_list_tables" && !is_error)
        );

        let current_started = parse_codex_jsonl_event(
            r#"{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"dbx","tool":"dbx_execute_query","arguments":{"sql":"SELECT 1"},"result":null,"error":null,"status":"in_progress"}}"#,
        )
        .unwrap();
        assert!(
            matches!(&current_started[0], AgentEvent::ToolCallStart { tool_name, args, .. } if tool_name == "dbx_execute_query" && args["sql"] == "SELECT 1")
        );

        let current_tool_done = parse_codex_jsonl_event(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"dbx","tool":"dbx_execute_query","arguments":{"sql":"SELECT 1"},"result":{"content":[{"type":"text","text":"ok"}],"structured_content":null},"error":null,"status":"completed"}}"#,
        )
        .unwrap();
        assert!(
            matches!(&current_tool_done[0], AgentEvent::ToolCallEnd { tool_name, result, is_error, .. } if tool_name == "dbx_execute_query" && result["content"][0]["text"] == "ok" && !is_error)
        );

        let current_tool_error = parse_codex_jsonl_event(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"dbx","tool":"dbx_execute_query","arguments":{"sql":"SELECT 1"},"result":null,"error":{"message":"user cancelled MCP tool call"},"status":"failed"}}"#,
        )
        .unwrap();
        assert!(
            matches!(&current_tool_error[0], AgentEvent::ToolCallEnd { tool_name, result, is_error, .. } if tool_name == "dbx_execute_query" && result["message"] == "user cancelled MCP tool call" && *is_error)
        );

        let turn_done =
            parse_codex_jsonl_event(r#"{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}"#)
                .unwrap();
        assert!(matches!(&turn_done[0], AgentEvent::AgentEnd { input_tokens: Some(12), output_tokens: Some(3) }));

        let failed = parse_codex_jsonl_event(r#"{"type":"turn.failed","message":"boom"}"#).unwrap();
        assert!(matches!(&failed[0], AgentEvent::Error { message } if message == "boom"));
    }
}
