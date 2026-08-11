use crate::agent_events::AgentEvent;
use crate::ai::{AiConfig, AiEffortCapability, AiModelInfo, AiTestConnectionResult};
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
use tokio::sync::Notify;

const QODER_MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const QODER_SETTING_SOURCES: &str = "user";
const DEFAULT_QODER_MODELS: &[&str] = &["default"];

pub type QoderRunOptions = CliAgentRunOptions;
pub type QoderCommandSpec = CliAgentCommandSpec;

struct QoderIsolatedCwd {
    path: PathBuf,
}

impl QoderIsolatedCwd {
    fn create() -> Result<Self, String> {
        let path = env::temp_dir().join(format!("dbx-qoder-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)
            .map_err(|error| format!("[qoderRunFailed] Failed to create isolated Qoder directory: {error}"))?;
        Ok(Self { path })
    }

    fn write_mcp_config(&self, config: &str) -> Result<PathBuf, String> {
        let path = self.path.join("mcp.json");
        std::fs::write(&path, config)
            .map_err(|error| format!("[qoderRunFailed] Failed to write temporary Qoder MCP config: {error}"))?;
        Ok(path)
    }
}

impl Drop for QoderIsolatedCwd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn qoder_program(config: &AiConfig) -> String {
    config.qoder_cli_path.as_deref().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("qodercli").to_string()
}

fn validate_qoder_program(config: &AiConfig) -> Result<String, String> {
    let program = qoder_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[qoderCliPathInvalid] Qoder CLI path should contain only the executable path. Add environment variables in the Qoder CLI environment variables section.".to_string());
    }
    if is_path_like_program(&program) {
        let expanded = crate::path_utils::expand_tilde(&program);
        let path = Path::new(&expanded);
        if path.is_dir() {
            return launchable_program_in_dir(path, "qodercli").ok_or_else(|| {
                "[qoderCliPathInvalid] Qoder CLI path should point to the qodercli executable or a directory containing qodercli."
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

pub fn qoder_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::new();
    for (key, value) in &config.qoder_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[qoderEnvInvalid] Invalid Qoder CLI environment variable name `{key}`. Use names like HTTPS_PROXY or QODER_PERSONAL_ACCESS_TOKEN."
            ));
        }
        if key.to_ascii_uppercase().starts_with("DBX_MCP_") {
            return Err(format!(
                "[qoderEnvReserved] `{key}` is managed by DBX for the scoped MCP server and cannot be set here."
            ));
        }
        env.insert(key.to_string(), value.clone());
    }
    Ok(env.into_iter().collect())
}

fn qoder_process_env(config: &AiConfig, command: &QoderCommandSpec) -> Result<Vec<(String, String)>, String> {
    let current_path = env::var("PATH").ok();
    qoder_process_env_with_path(config, command, current_path.as_deref())
}

fn qoder_process_env_with_path(
    config: &AiConfig,
    command: &QoderCommandSpec,
    current_path: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    let mut process_env = BTreeMap::from_iter(qoder_cli_env(config)?);
    let mut paths = Vec::new();
    if let Some(dir) =
        Path::new(&command.program).parent().filter(|parent| !parent.as_os_str().is_empty()).map(Path::to_path_buf)
    {
        paths.push(dir);
    }
    if let Some(path) = process_env.get("PATH") {
        paths.extend(env::split_paths(path));
    }
    if let Some(path) = current_path {
        paths.extend(env::split_paths(path));
    }
    #[cfg(windows)]
    if let Ok(app_data) = env::var("APPDATA") {
        paths.push(PathBuf::from(app_data).join("npm"));
    }
    #[cfg(not(windows))]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    let mut seen = BTreeSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    if let Ok(path) = env::join_paths(paths) {
        process_env.insert("PATH".to_string(), path.to_string_lossy().to_string());
    }
    Ok(process_env.into_iter().collect())
}

pub fn qoder_enabled_tools(agent_mode: bool) -> Vec<String> {
    dbx_mcp_enabled_tools(agent_mode).into_iter().map(|tool| format!("mcp__dbx__{tool}")).collect()
}

fn qoder_mcp_config(options: &QoderRunOptions) -> String {
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

pub fn build_qoder_command(config: &AiConfig, _prompt: &str, options: &QoderRunOptions) -> QoderCommandSpec {
    build_qoder_command_with_mcp_arg(config, options, qoder_mcp_config(options))
}

fn build_qoder_command_with_mcp_arg(
    config: &AiConfig,
    options: &QoderRunOptions,
    mcp_config_arg: String,
) -> QoderCommandSpec {
    let enabled_tools = qoder_enabled_tools(options.agent_mode);
    let tool_list = enabled_tools.join(",");
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "text".to_string(),
        "--no-session-persistence".to_string(),
        "--permission-mode".to_string(),
        "dont_ask".to_string(),
        "--mcp-config".to_string(),
        mcp_config_arg,
        "--strict-mcp-config".to_string(),
        "--allowed-mcp-server-names".to_string(),
        "dbx".to_string(),
        "--setting-sources".to_string(),
        QODER_SETTING_SOURCES.to_string(),
        "--tools".to_string(),
        tool_list.clone(),
        "--allowed-tools".to_string(),
        tool_list,
    ];

    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = config.runtime_effort.as_ref().and_then(|effort| effort.cli_value()) {
        args.push("--reasoning-effort".to_string());
        args.push(effort);
    }
    if let Some(context_window) = config.context_window.filter(|value| *value > 0) {
        args.push("--context-window".to_string());
        args.push(context_window.to_string());
    }

    QoderCommandSpec { program: qoder_program(config), args }
}

pub fn build_qoder_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage], allow_write_sql: bool) -> String {
    build_cli_agent_prompt("Qoder", system_prompt, messages, allow_write_sql)
}

pub async fn list_qoder_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let output = run_qoder_model_listing(config).await?;
    Ok(parse_qoder_models(&String::from_utf8_lossy(&output.stdout)))
}

async fn run_qoder_model_listing(config: &AiConfig) -> Result<std::process::Output, String> {
    let program = validate_qoder_program(config)?;
    let command = QoderCommandSpec {
        program,
        args: vec!["--list-models".to_string(), "--setting-sources".to_string(), QODER_SETTING_SOURCES.to_string()],
    };
    let isolated_cwd = QoderIsolatedCwd::create()?;
    let mut process = cli_command(&command.program);
    process
        .args(command.args.iter().map(String::as_str))
        .envs(qoder_process_env(config, &command)?.iter().map(|(key, value)| (key.as_str(), value.as_str())))
        .current_dir(&isolated_cwd.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(QODER_MODEL_DISCOVERY_TIMEOUT, process.output())
        .await
        .map_err(|_| "[qoderTimeout] Qoder model discovery timed out.".to_string())?
        .map_err(|error| classify_qoder_spawn_error(&error.to_string()))?;
    if output.status.success() {
        Ok(output)
    } else {
        let diagnostic = [String::from_utf8_lossy(&output.stderr), String::from_utf8_lossy(&output.stdout)]
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        Err(classify_qoder_run_error(&diagnostic))
    }
}

fn parse_qoder_models(stdout: &str) -> Vec<AiModelInfo> {
    let mut ids = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) {
        collect_qoder_model_ids(&value, &mut ids);
    } else {
        for line in stdout.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            collect_qoder_model_ids(&value, &mut ids);
        }
    }

    // `--list-models` is documented as a human-readable table. Accept model
    // identifiers only from table cells or one-item bullet rows so labels and
    // descriptions cannot accidentally become selectable model IDs.
    let mut in_single_model_column = false;
    for line in stdout.lines() {
        if line.trim().eq_ignore_ascii_case("model") {
            in_single_model_column = true;
            continue;
        }
        collect_qoder_table_model_ids(line, in_single_model_column, &mut ids);
    }

    let mut seen = BTreeSet::new();
    let ids = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.to_ascii_lowercase()))
        .collect::<Vec<_>>();
    let mut models = model_infos(DEFAULT_QODER_MODELS);
    models
        .extend(ids.into_iter().filter(|id| !id.eq_ignore_ascii_case("default")).map(|id| AiModelInfo::new(id, None)));
    models
}

fn collect_qoder_table_model_ids(line: &str, allow_plain_name: bool, ids: &mut Vec<String>) {
    let line = line.trim();
    if line.is_empty() || line.chars().all(is_qoder_table_border) {
        return;
    }

    let cells = if line.contains('│') || line.contains('|') {
        line.split(['│', '|']).map(str::trim).filter(|cell| !cell.is_empty()).collect::<Vec<_>>()
    } else if line.contains('\t') {
        line.split('\t').map(str::trim).filter(|cell| !cell.is_empty()).collect::<Vec<_>>()
    } else {
        vec![line.trim_start_matches(['-', '*', '•']).trim()]
    };

    if let Some(id) = cells.iter().find_map(|cell| qoder_model_id_from_cell(cell, allow_plain_name)) {
        ids.push(id);
    }
}

fn is_qoder_table_border(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(ch, '-' | '=' | '+' | '─' | '━' | '┌' | '┐' | '└' | '┘' | '├' | '┤' | '┬' | '┴' | '┼' | '│')
}

fn qoder_model_id_from_cell(cell: &str, allow_plain_name: bool) -> Option<String> {
    let candidate = cell.trim().trim_matches(['`', '*']);
    if candidate.is_empty() || candidate.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = candidate.to_ascii_lowercase();
    if ["auto", "ultimate", "performance", "efficient", "lite"].contains(&lower.as_str()) {
        return Some(lower);
    }
    if matches!(lower.as_str(), "model" | "model-id" | "model_id" | "id" | "name" | "type" | "tier")
        || !candidate.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic())
        || !allow_plain_name && !candidate.chars().any(|ch| ch.is_ascii_digit())
        || !candidate.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '@'))
    {
        return None;
    }
    Some(candidate.to_string())
}

fn collect_qoder_model_ids(value: &Value, ids: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::String(id) => ids.push(id.to_string()),
                    Value::Object(fields) => {
                        if let Some(id) = fields
                            .get("id")
                            .or_else(|| fields.get("value"))
                            .or_else(|| fields.get("model"))
                            .and_then(Value::as_str)
                        {
                            ids.push(id.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        Value::Object(fields) => {
            for key in ["models", "data", "items"] {
                if let Some(models) = fields.get(key) {
                    collect_qoder_model_ids(models, ids);
                }
            }
        }
        _ => {}
    }
}

pub async fn resolve_qoder_model_effort(_config: &AiConfig, _model_id: &str) -> Result<AiEffortCapability, String> {
    // Qoder model capabilities are account-dependent and `--list-models` does
    // not currently document a stable machine-readable effort schema.
    Ok(AiEffortCapability::Unsupported)
}

pub async fn test_qoder_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    let _ = run_qoder_model_listing(config).await?;
    let elapsed = start.elapsed().as_millis() as u64;
    Ok(AiTestConnectionResult {
        success: true,
        message: format!("OK - {elapsed}ms"),
        latency_ms: Some(elapsed),
        model_used: config.model.trim().to_string(),
        error_category: None,
    })
}

fn classify_qoder_spawn_error(message: &str) -> String {
    if message.contains("No such file") || message.contains("not found") || message.contains("os error 2") {
        format!("[qoderNotInstalled] Qoder CLI was not found. Install qodercli or set its executable path in DBX AI settings. {message}")
    } else {
        format!("[qoderRunFailed] Failed to start Qoder CLI: {message}")
    }
}

fn classify_qoder_run_error(diagnostic: &str) -> String {
    let diagnostic = sanitize_diagnostic(diagnostic);
    let lower = diagnostic.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("please login")
        || lower.contains("please log in")
        || lower.contains("unauthorized")
        || lower.contains("access token") && (lower.contains("invalid") || lower.contains("expired"))
    {
        format!("[qoderNotAuthenticated] {diagnostic}")
    } else if lower.contains("invalid mcp") || lower.contains("mcp config") && lower.contains("invalid") {
        format!("[qoderMcpConfigInvalid] {diagnostic}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] {diagnostic}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[qoderMcpStartupFailed] {diagnostic}")
    } else if lower.contains("protocol") || lower.contains("invalid json") || lower.contains("parse") {
        format!("[qoderProtocolError] {diagnostic}")
    } else {
        format!("[qoderRunFailed] {diagnostic}")
    }
}

fn sanitize_diagnostic(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "Qoder CLI exited without diagnostics.".to_string();
    }
    value.chars().take(2_000).collect()
}

pub fn parse_qoder_jsonl_event(line: &str) -> Option<Vec<AgentEvent>> {
    parse_cli_jsonl_event(line, CliAgentJsonlDialect::QoderPrint)
}

pub async fn run_qoder_agent(
    config: &AiConfig,
    prompt: &str,
    options: QoderRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let program = validate_qoder_program(config)?;
    let isolated_cwd = QoderIsolatedCwd::create()?;
    let mcp_config_path = isolated_cwd.write_mcp_config(&qoder_mcp_config(&options))?;
    let mut command = build_qoder_command_with_mcp_arg(config, &options, mcp_config_path.to_string_lossy().to_string());
    command.program = program;
    let env = qoder_process_env(config, &command)?;
    run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
            env,
            env_remove: Vec::new(),
            current_dir: Some(isolated_cwd.path.clone()),
            stdin: Some(prompt.to_string()),
            dialect: CliAgentJsonlDialect::QoderPrint,
            classify_spawn_error: classify_qoder_spawn_error,
            classify_run_error: classify_qoder_run_error,
        },
        cancelled,
        on_event,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        build_qoder_command, classify_qoder_run_error, parse_qoder_jsonl_event, parse_qoder_models, qoder_cli_env,
        qoder_process_env_with_path, QoderCommandSpec, QoderRunOptions,
    };
    use crate::agent_events::AgentEvent;
    use crate::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiEffortSelection, AiProvider, AiReasoningLevel};

    fn config(model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::QoderCli,
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
            qoder_cli_path: None,
            qoder_cli_env: Default::default(),
        }
    }

    fn options() -> QoderRunOptions {
        QoderRunOptions {
            connection_id: "conn-1".to_string(),
            connection_name: "local".to_string(),
            database: "demo".to_string(),
            schema: Some("public".to_string()),
            agent_mode: true,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: None,
        }
    }

    #[test]
    fn builds_scoped_headless_qoder_command() {
        let mut config = config("performance");
        config.runtime_effort = Some(AiEffortSelection::Enum("high".to_string()));
        config.context_window = Some(400_000);
        let command = build_qoder_command(&config, "prompt stays on stdin", &options());
        assert_eq!(command.program, "qodercli");
        assert!(command.args.windows(2).any(|args| args == ["--output-format", "stream-json"]));
        assert!(command.args.windows(2).any(|args| args == ["--permission-mode", "dont_ask"]));
        assert!(command.args.windows(2).any(|args| args == ["--allowed-mcp-server-names", "dbx"]));
        assert!(command.args.windows(2).any(|args| args == ["--setting-sources", "user"]));
        assert!(command.args.windows(2).any(|args| args == ["--model", "performance"]));
        assert!(command.args.windows(2).any(|args| args == ["--reasoning-effort", "high"]));
        assert!(command.args.windows(2).any(|args| args == ["--context-window", "400000"]));
        assert!(!command.args.iter().any(|arg| arg == "prompt stays on stdin"));
        let tools = command.args[command.args.iter().position(|arg| arg == "--tools").unwrap() + 1].clone();
        assert!(tools.contains("mcp__dbx__dbx_execute_query"));
        assert!(!tools.contains("Bash"));
    }

    #[cfg(not(windows))]
    #[test]
    fn bare_qoder_command_uses_configured_gui_and_common_paths() {
        let mut config = config("default");
        config.qoder_cli_env.insert("PATH".to_string(), "/configured/bin".to_string());
        let command = QoderCommandSpec { program: "qodercli".to_string(), args: Vec::new() };

        let process_env = qoder_process_env_with_path(&config, &command, Some("/restricted/gui/bin")).unwrap();
        let path = process_env.iter().find(|(key, _)| key == "PATH").map(|(_, value)| value).unwrap();
        let paths = std::env::split_paths(path).collect::<Vec<_>>();

        assert!(paths.contains(&std::path::PathBuf::from("/configured/bin")));
        assert!(paths.contains(&std::path::PathBuf::from("/restricted/gui/bin")));
        assert!(paths.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
        assert!(paths.contains(&std::path::PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn keeps_default_model_implicit() {
        let command = build_qoder_command(&config("default"), "hello", &options());
        assert!(!command.args.contains(&"--model".to_string()));
    }

    #[test]
    fn validates_environment_and_reserves_dbx_scope() {
        let mut config = config("default");
        config.qoder_cli_env.insert("QODER_PERSONAL_ACCESS_TOKEN".to_string(), "secret".to_string());
        assert_eq!(
            qoder_cli_env(&config).unwrap(),
            vec![("QODER_PERSONAL_ACCESS_TOKEN".to_string(), "secret".to_string())]
        );
        config.qoder_cli_env.insert("DBX_MCP_SCOPE_DATABASE".to_string(), "other".to_string());
        assert!(qoder_cli_env(&config).unwrap_err().starts_with("[qoderEnvReserved]"));
    }

    #[test]
    fn qoder_provider_config_roundtrips_with_cli_credentials() {
        let mut config = config("performance");
        config.qoder_cli_path = Some("/opt/homebrew/bin/qodercli".to_string());
        config.qoder_cli_env.insert("QODER_PERSONAL_ACCESS_TOKEN".to_string(), "token".to_string());

        let decoded: AiConfig = serde_json::from_value(serde_json::to_value(config).unwrap()).unwrap();

        assert!(matches!(decoded.provider, AiProvider::QoderCli));
        assert_eq!(decoded.qoder_cli_path.as_deref(), Some("/opt/homebrew/bin/qodercli"));
        assert_eq!(decoded.qoder_cli_env.get("QODER_PERSONAL_ACCESS_TOKEN").map(String::as_str), Some("token"));
    }

    #[test]
    fn parses_json_and_human_readable_model_lists() {
        let models = parse_qoder_models(r#"{"models":[{"id":"auto"},{"value":"custom/model"}]}"#);
        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            ["default", "auto", "custom/model"]
        );
        let models = parse_qoder_models(
            "MODEL\nAuto\nUltimate\nPerformance\nEfficient\nLite\nCantus\nQwen3.8-Max-Preview\nDeepSeek-V4-Pro",
        );
        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            [
                "default",
                "auto",
                "ultimate",
                "performance",
                "efficient",
                "lite",
                "Cantus",
                "Qwen3.8-Max-Preview",
                "DeepSeek-V4-Pro"
            ]
        );
    }

    #[test]
    fn classifies_authentication_and_mcp_failures() {
        assert!(classify_qoder_run_error("Please login first").starts_with("[qoderNotAuthenticated]"));
        assert!(classify_qoder_run_error("MCP server dbx failed to start").starts_with("[qoderMcpStartupFailed]"));
    }

    #[test]
    fn parses_qoder_assistant_and_stream_deltas() {
        let assistant = parse_qoder_jsonl_event(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"thinking","thinking":"plan"}]}}"#,
        )
        .unwrap();
        assert!(assistant.iter().any(|event| matches!(event, AgentEvent::TextDelta { delta } if delta == "hello")));
        assert!(assistant.iter().any(|event| matches!(event, AgentEvent::ReasoningDelta { delta } if delta == "plan")));

        let delta = parse_qoder_jsonl_event(
            r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"partial"}}}"#,
        )
        .unwrap();
        assert!(matches!(&delta[0], AgentEvent::TextDelta { delta } if delta == "partial"));

        let error = parse_qoder_jsonl_event(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Network attempt failed"]}"#,
        )
        .unwrap();
        assert!(matches!(&error[0], AgentEvent::Error { message } if message == "Network attempt failed"));
    }
}
