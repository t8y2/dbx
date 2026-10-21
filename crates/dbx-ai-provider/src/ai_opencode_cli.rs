use crate::agent_events::AgentEvent;
use crate::ai::{AiCapabilitySource, AiConfig, AiEffortCapability, AiModelInfo, AiTestConnectionResult};
use crate::ai_cli_agent::{
    build_cli_agent_prompt, cli_command, dbx_mcp_scope_env, parse_cli_jsonl_event, run_cli_jsonl_agent,
    CliAgentCommandSpec, CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, RwLock};

const OPENCODE_MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const OPENCODE_CONTROL_ENV: &[&str] = &[
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DB",
    "OPENCODE_PERMISSION",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
];

pub type OpenCodeRunOptions = CliAgentRunOptions;
pub type OpenCodeCommandSpec = CliAgentCommandSpec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeVersion {
    V1,
    V2,
}

static OPENCODE_DETECTED_V2: LazyLock<RwLock<HashMap<String, bool>>> = LazyLock::new(|| RwLock::new(HashMap::new()));

pub fn resolve_configured_opencode_version(config: &AiConfig) -> Option<OpenCodeVersion> {
    if let Some(version) = &config.opencode_cli_version {
        let trimmed = version.trim().to_ascii_lowercase();
        if trimmed == "v2" || trimmed == "2" || trimmed == "opencode2" {
            return Some(OpenCodeVersion::V2);
        }
        if trimmed == "v1" || trimmed == "1" || trimmed == "opencode1" {
            return Some(OpenCodeVersion::V1);
        }
    }
    None
}

pub fn is_opencode_v2_program_name(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    let file_name = Path::new(&lower).file_name().and_then(|n| n.to_str()).unwrap_or(&lower);
    file_name.contains("opencode2")
        || file_name.contains("opencode-2")
        || file_name.contains("opencode-v2")
        || file_name.contains("opencode_v2")
}

pub fn parse_opencode_version_is_v2(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    for token in lower.split_whitespace() {
        let cleaned = token.trim_start_matches('v');
        if let Some(major_str) = cleaned.split('.').next() {
            if let Ok(major) = major_str.parse::<u32>() {
                if major >= 2 {
                    return true;
                }
            }
        }
    }
    false
}

pub async fn record_opencode_version_v2(program: &str) {
    OPENCODE_DETECTED_V2.write().await.insert(program.to_string(), true);
}

pub async fn detect_opencode_version(program: &str) -> OpenCodeVersion {
    if is_opencode_v2_program_name(program) {
        return OpenCodeVersion::V2;
    }
    if let Some(&is_v2) = OPENCODE_DETECTED_V2.read().await.get(program) {
        return if is_v2 { OpenCodeVersion::V2 } else { OpenCodeVersion::V1 };
    }

    let mut process = cli_command(program);
    process.arg("--version");
    let is_v2 = match tokio::time::timeout(Duration::from_millis(1500), process.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_opencode_version_is_v2(&stdout)
        }
        _ => false,
    };

    OPENCODE_DETECTED_V2.write().await.insert(program.to_string(), is_v2);
    if is_v2 {
        OpenCodeVersion::V2
    } else {
        OpenCodeVersion::V1
    }
}

pub fn resolve_opencode_version_fast(config: &AiConfig) -> OpenCodeVersion {
    if let Some(version) = resolve_configured_opencode_version(config) {
        return version;
    }
    let program = opencode_program(config);
    if is_opencode_v2_program_name(&program) {
        return OpenCodeVersion::V2;
    }
    if let Ok(guard) = OPENCODE_DETECTED_V2.try_read() {
        if let Some(&is_v2) = guard.get(&program) {
            return if is_v2 { OpenCodeVersion::V2 } else { OpenCodeVersion::V1 };
        }
    }
    OpenCodeVersion::V1
}

pub fn is_unrecognized_pure_flag(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("--pure")
        && (lower.contains("unrecognized") || lower.contains("unknown") || lower.contains("unexpected"))
}

struct OpenCodeIsolatedCwd {
    path: PathBuf,
}

impl OpenCodeIsolatedCwd {
    fn create() -> Result<Self, String> {
        let path = env::temp_dir().join(format!("dbx-opencode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)
            .map_err(|error| format!("[openCodeRunFailed] Failed to create isolated OpenCode directory: {error}"))?;
        Ok(Self { path })
    }
}

impl Drop for OpenCodeIsolatedCwd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn opencode_program(config: &AiConfig) -> String {
    config
        .opencode_cli_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("opencode")
        .to_string()
}

fn resolve_opencode_command(config: &AiConfig) -> Result<OpenCodeCommandSpec, String> {
    let program = opencode_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[openCodeCliPathInvalid] OpenCode CLI path should contain only the executable path. Add environment variables in the OpenCode CLI environment variables section.".to_string());
    }

    let program = if is_path_like_program(&program) { crate::path_utils::expand_tilde(&program) } else { program };
    let path = Path::new(&program);
    if path.is_dir() {
        return launchable_program_in_dir(path, "opencode")
            .map(opencode_command_for_program)
            .ok_or_else(|| {
                "[openCodeCliPathInvalid] OpenCode CLI path should point to the opencode executable or a directory containing opencode."
                    .to_string()
            });
    }
    if is_path_like_program(&program) && !path.is_file() {
        return Err("[openCodeCliPathInvalid] OpenCode CLI executable does not exist.".to_string());
    }
    Ok(opencode_command_for_program(program))
}

fn opencode_command_for_program(program: String) -> OpenCodeCommandSpec {
    #[cfg(windows)]
    if let Some(command) = windows_npm_opencode_shim_command(&program) {
        return command;
    }

    OpenCodeCommandSpec { program, args: Vec::new() }
}

#[cfg(windows)]
fn windows_npm_opencode_shim_command(program: &str) -> Option<OpenCodeCommandSpec> {
    let path = Path::new(program);
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if extension != "cmd" && extension != "bat" {
        return None;
    }
    let executable = path.parent()?.join("node_modules").join("opencode-ai").join("bin").join("opencode.exe");
    executable
        .is_file()
        .then(|| OpenCodeCommandSpec { program: executable.to_string_lossy().to_string(), args: Vec::new() })
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
    upper.starts_with("DBX_MCP_") || OPENCODE_CONTROL_ENV.iter().any(|reserved| upper == *reserved)
}

pub fn opencode_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::new();
    for (key, value) in &config.opencode_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[openCodeEnvInvalid] Invalid OpenCode CLI environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        if is_reserved_env_name(key) {
            return Err(format!(
                "[openCodeEnvReserved] `{key}` is managed by DBX for the isolated OpenCode session and cannot be set here."
            ));
        }
        env.insert(key.to_string(), value.clone());
    }
    Ok(env.into_iter().collect())
}

fn opencode_process_env(config: &AiConfig, runtime_config: Value) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::from_iter(opencode_cli_env(config)?);
    env.insert("OPENCODE_DB".to_string(), ":memory:".to_string());
    env.insert("OPENCODE_DISABLE_PROJECT_CONFIG".to_string(), "1".to_string());
    env.insert("OPENCODE_CONFIG_CONTENT".to_string(), runtime_config.to_string());
    Ok(env.into_iter().collect())
}

fn opencode_runtime_config(options: Option<&OpenCodeRunOptions>) -> Value {
    let mut config = Map::new();
    config.insert("permission".to_string(), json!({ "*": "deny", "dbx_*": "allow" }));

    if let Some(options) = options {
        let command = options
            .mcp_server_command
            .as_ref()
            .cloned()
            .unwrap_or_else(|| CliAgentCommandSpec { program: "dbx-mcp-server".to_string(), args: Vec::new() });
        let mut command_parts = vec![command.program];
        command_parts.extend(command.args);
        let environment = dbx_mcp_scope_env(options)
            .into_iter()
            .map(|(name, value)| (name.to_string(), Value::String(value)))
            .collect::<Map<_, _>>();
        config.insert(
            "mcp".to_string(),
            json!({
                "dbx": {
                    "type": "local",
                    "command": command_parts,
                    "enabled": true,
                    "environment": environment
                }
            }),
        );
    }

    Value::Object(config)
}

fn opencode_selection_args(config: &AiConfig) -> Vec<String> {
    let mut args = Vec::new();
    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(variant) = config.runtime_effort.as_ref().and_then(|selection| selection.cli_value()) {
        args.extend(["--variant".to_string(), variant]);
    }
    args
}

pub fn build_opencode_command(config: &AiConfig) -> OpenCodeCommandSpec {
    let version = resolve_opencode_version_fast(config);
    build_opencode_command_for_version(config, version)
}

pub fn build_opencode_command_for_version(config: &AiConfig, version: OpenCodeVersion) -> OpenCodeCommandSpec {
    let mut command = OpenCodeCommandSpec { program: opencode_program(config), args: Vec::new() };
    command.args.extend(["run".to_string(), "--format".to_string(), "json".to_string()]);
    if version == OpenCodeVersion::V1 {
        command.args.push("--pure".to_string());
    }
    command.args.extend(opencode_selection_args(config));
    command
}

pub fn resolved_models_command(config: &AiConfig) -> Result<OpenCodeCommandSpec, String> {
    let version = resolve_opencode_version_fast(config);
    resolved_models_command_for_version(config, version)
}

pub fn resolved_models_command_for_version(
    config: &AiConfig,
    version: OpenCodeVersion,
) -> Result<OpenCodeCommandSpec, String> {
    let mut command = resolve_opencode_command(config)?;
    command.args.extend(["models".to_string(), "--verbose".to_string()]);
    if version == OpenCodeVersion::V1 {
        command.args.push("--pure".to_string());
    }
    Ok(command)
}

pub fn resolved_run_command(config: &AiConfig) -> Result<OpenCodeCommandSpec, String> {
    let version = resolve_opencode_version_fast(config);
    resolved_run_command_for_version(config, version)
}

pub fn resolved_run_command_for_version(
    config: &AiConfig,
    version: OpenCodeVersion,
) -> Result<OpenCodeCommandSpec, String> {
    let resolved = resolve_opencode_command(config)?;
    let mut command = build_opencode_command_for_version(config, version);
    command.program = resolved.program;
    command.args.splice(0..0, resolved.args);
    Ok(command)
}

pub fn build_opencode_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage], allow_write_sql: bool) -> String {
    build_cli_agent_prompt("OpenCode", system_prompt, messages, allow_write_sql)
}

pub async fn list_opencode_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let mut version = if let Some(configured) = resolve_configured_opencode_version(config) {
        configured
    } else {
        let program = opencode_program(config);
        detect_opencode_version(&program).await
    };
    let command = resolved_models_command_for_version(config, version)?;
    let runtime = OpenCodeIsolatedCwd::create()?;
    let mut process = cli_command(&command.program);
    process.args(&command.args);
    for key in OPENCODE_CONTROL_ENV {
        process.env_remove(key);
    }
    process
        .envs(opencode_process_env(config, opencode_runtime_config(None))?)
        .current_dir(&runtime.path)
        .kill_on_drop(true);
    let output = tokio::time::timeout(OPENCODE_MODEL_DISCOVERY_TIMEOUT, process.output())
        .await
        .map_err(|_| "[openCodeTimeout] OpenCode model discovery timed out".to_string())?
        .map_err(|error| classify_opencode_spawn_error(&error.to_string()))?;

    if !output.status.success() {
        let err_output = combined_output(&output.stderr, &output.stdout);
        if version == OpenCodeVersion::V1 && is_unrecognized_pure_flag(&err_output) {
            let program = opencode_program(config);
            record_opencode_version_v2(&program).await;
            version = OpenCodeVersion::V2;
            let retry_command = resolved_models_command_for_version(config, version)?;
            let mut retry_process = cli_command(&retry_command.program);
            retry_process.args(&retry_command.args);
            for key in OPENCODE_CONTROL_ENV {
                retry_process.env_remove(key);
            }
            retry_process
                .envs(opencode_process_env(config, opencode_runtime_config(None))?)
                .current_dir(&runtime.path)
                .kill_on_drop(true);
            let retry_output = tokio::time::timeout(OPENCODE_MODEL_DISCOVERY_TIMEOUT, retry_process.output())
                .await
                .map_err(|_| "[openCodeTimeout] OpenCode model discovery timed out".to_string())?
                .map_err(|error| classify_opencode_spawn_error(&error.to_string()))?;
            if !retry_output.status.success() {
                return Err(classify_opencode_run_error(&combined_output(&retry_output.stderr, &retry_output.stdout)));
            }
            return parse_opencode_models(&String::from_utf8_lossy(&retry_output.stdout)).ok_or_else(|| {
                "[openCodeNotAuthenticated] OpenCode returned no configured models. Sign in or configure a provider in OpenCode, then retry."
                    .to_string()
            });
        }
        return Err(classify_opencode_run_error(&err_output));
    }
    parse_opencode_models(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        "[openCodeNotAuthenticated] OpenCode returned no configured models. Sign in or configure a provider in OpenCode, then retry."
            .to_string()
    })
}

fn parse_opencode_models(stdout: &str) -> Option<Vec<AiModelInfo>> {
    let mut models = Vec::new();
    let mut seen = BTreeSet::new();
    let mut pending_id: Option<String> = None;
    let mut json_buffer = String::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        if json_buffer.is_empty() {
            if trimmed.starts_with('{') {
                json_buffer.push_str(line);
                json_buffer.push('\n');
            } else if !trimmed.is_empty() {
                pending_id = Some(trimmed.to_string());
            }
        } else {
            json_buffer.push_str(line);
            json_buffer.push('\n');
        }

        if json_buffer.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&json_buffer) {
            Ok(metadata) => {
                if let Some(info) = opencode_model_info(pending_id.take(), &metadata) {
                    if seen.insert(info.id.clone()) {
                        models.push(info);
                    }
                }
                json_buffer.clear();
            }
            Err(error) if error.is_eof() => {}
            Err(_) => {
                json_buffer.clear();
                pending_id = None;
            }
        }
    }

    if models.is_empty() {
        return None;
    }
    if seen.insert("default".to_string()) {
        models.insert(0, AiModelInfo::new("default", Some("Default".to_string())));
    }
    Some(models)
}

fn opencode_model_info(reported_id: Option<String>, metadata: &Value) -> Option<AiModelInfo> {
    let id = reported_id.or_else(|| {
        let provider = metadata.get("providerID").and_then(Value::as_str)?;
        let model = metadata.get("id").and_then(Value::as_str)?;
        Some(format!("{provider}/{model}"))
    })?;
    let id = id.trim();
    if id.is_empty() || !id.contains('/') {
        return None;
    }

    let display_name = metadata
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string);
    let variants = metadata
        .get("variants")
        .and_then(Value::as_object)
        .map(|variants| variants.keys().map(String::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut info = AiModelInfo::new(id, display_name);
    info.supported_effort_levels = variants.iter().filter_map(|variant| variant.parse().ok()).collect();
    info.effort_capability = crate::ai_effort::dynamic_enum_capability(variants, AiCapabilitySource::LocalCli);
    Some(info)
}

pub async fn resolve_opencode_model_effort(config: &AiConfig, model_id: &str) -> Result<AiEffortCapability, String> {
    Ok(list_opencode_models(config)
        .await?
        .into_iter()
        .find(|model| model.id == model_id)
        .and_then(|model| model.effort_capability)
        .unwrap_or(AiEffortCapability::Unsupported))
}

pub async fn test_opencode_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    list_opencode_models(config).await?;
    Ok(AiTestConnectionResult {
        success: true,
        message: format!("OK - {}ms", start.elapsed().as_millis()),
        latency_ms: Some(start.elapsed().as_millis() as u64),
        model_used: config.model.trim().to_string(),
        error_category: None,
    })
}

fn combined_output(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    [stderr.trim(), stdout.trim()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n")
}

fn classify_opencode_spawn_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("no such file") || lower.contains("not found") || lower.contains("cannot find") {
        format!("[openCodeNotInstalled] {message}")
    } else {
        format!("[openCodeRunFailed] {message}")
    }
}

fn classify_opencode_run_error(message: &str) -> String {
    if message.starts_with("[openCode") || message.starts_with("[dbxMcpMissing]") {
        return message.to_string();
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("unauthorized")
        || lower.contains("please login")
        || lower.contains("please sign in")
    {
        format!("[openCodeNotAuthenticated] {message}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] {message}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[openCodeMcpStartupFailed] {message}")
    } else if lower.contains("json") || lower.contains("protocol") {
        format!("[openCodeProtocolError] {message}")
    } else {
        format!("[openCodeRunFailed] {message}")
    }
}

pub fn parse_opencode_jsonl_event(line: &str) -> Option<Vec<AgentEvent>> {
    parse_cli_jsonl_event(line, CliAgentJsonlDialect::OpenCodeRun)
}

pub async fn run_opencode_agent(
    config: &AiConfig,
    prompt: &str,
    options: OpenCodeRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let version = if let Some(configured) = resolve_configured_opencode_version(config) {
        configured
    } else {
        let program = opencode_program(config);
        detect_opencode_version(&program).await
    };
    let runtime = OpenCodeIsolatedCwd::create()?;
    let command = resolved_run_command_for_version(config, version)?;
    let on_event_arc = Arc::new(on_event);
    let on_event_fn = {
        let on_event_arc = Arc::clone(&on_event_arc);
        move |event| on_event_arc(event)
    };
    let run_res = run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
            env: opencode_process_env(config, opencode_runtime_config(Some(&options)))?,
            env_remove: OPENCODE_CONTROL_ENV.iter().map(|value| (*value).to_string()).collect(),
            current_dir: Some(runtime.path.clone()),
            stdin: Some(prompt.to_string()),
            dialect: CliAgentJsonlDialect::OpenCodeRun,
            classify_spawn_error: classify_opencode_spawn_error,
            classify_run_error: classify_opencode_run_error,
        },
        cancelled,
        on_event_fn,
    )
    .await;

    let result = match run_res {
        Err(err) if version == OpenCodeVersion::V1 && is_unrecognized_pure_flag(&err) => {
            let program = opencode_program(config);
            record_opencode_version_v2(&program).await;
            let v2_command = resolved_run_command_for_version(config, OpenCodeVersion::V2)?;
            let on_event_fn2 = {
                let on_event_arc = Arc::clone(&on_event_arc);
                move |event| on_event_arc(event)
            };
            run_cli_jsonl_agent(
                CliAgentProcessSpec {
                    command: v2_command,
                    env: opencode_process_env(config, opencode_runtime_config(Some(&options)))?,
                    env_remove: OPENCODE_CONTROL_ENV.iter().map(|value| (*value).to_string()).collect(),
                    current_dir: Some(runtime.path.clone()),
                    stdin: Some(prompt.to_string()),
                    dialect: CliAgentJsonlDialect::OpenCodeRun,
                    classify_spawn_error: classify_opencode_spawn_error,
                    classify_run_error: classify_opencode_run_error,
                },
                cancelled,
                on_event_fn2,
            )
            .await?
        }
        other => other?,
    };

    if result.trim().is_empty() {
        Err("[openCodeProtocolError] OpenCode completed without a text response".to_string())
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiApiStyle, AiAuthMethod, AiEffortSelection, AiProvider, AiReasoningLevel};
    use std::sync::{Arc, Mutex};

    fn config(model: &str) -> AiConfig {
        AiConfig {
            provider: AiProvider::OpenCodeCli,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: String::new(),
            model: model.to_string(),
            models: Vec::new(),
            api_style: AiApiStyle::Completions,
            custom_headers: Default::default(),
            proxy_enabled: false,
            proxy_url: String::new(),
            skip_tls_verify: false,
            enable_thinking: true,
            reasoning_level: AiReasoningLevel::Default,
            max_output_tokens: None,
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
            opencode_cli_version: None,
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

    fn options() -> OpenCodeRunOptions {
        OpenCodeRunOptions {
            connection_id: "conn-1".to_string(),
            connection_name: "Local".to_string(),
            database: "demo".to_string(),
            selected_databases: Vec::new(),
            schema: Some("public".to_string()),
            agent_mode: true,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CliAgentCommandSpec {
                program: "/opt/dbx/dbx-mcp-server".to_string(),
                args: vec!["--stdio".to_string()],
            }),
        }
    }

    fn live_config() -> AiConfig {
        let mut config = config(
            &std::env::var("DBX_LIVE_OPENCODE_MODEL")
                .expect("set DBX_LIVE_OPENCODE_MODEL to an authenticated provider/model"),
        );
        config.opencode_cli_path = std::env::var("DBX_LIVE_OPENCODE_PATH").ok();
        config
    }

    #[test]
    fn builds_run_command_with_model_and_variant() {
        let mut config = config("openai/gpt-5.4");
        config.runtime_effort = Some(AiEffortSelection::Enum("high".to_string()));

        let command = build_opencode_command(&config);

        assert_eq!(command.program, "opencode");
        assert_eq!(
            command.args,
            ["run", "--format", "json", "--pure", "--model", "openai/gpt-5.4", "--variant", "high"]
        );
    }

    #[test]
    fn default_model_and_effort_are_omitted() {
        let command = build_opencode_command(&config("default"));

        assert_eq!(command.args, ["run", "--format", "json", "--pure"]);
    }

    #[test]
    fn builds_run_command_for_opencode2_executable() {
        let mut config = config("default");
        config.opencode_cli_path = Some("/usr/local/bin/opencode2".to_string());

        let command = build_opencode_command(&config);

        assert_eq!(command.program, "/usr/local/bin/opencode2");
        assert_eq!(command.args, ["run", "--format", "json"]);
    }

    #[test]
    fn builds_run_command_for_opencode2_configured_version() {
        let mut config = config("default");
        config.opencode_cli_version = Some("v2".to_string());

        let command = build_opencode_command(&config);

        assert_eq!(command.program, "opencode");
        assert_eq!(command.args, ["run", "--format", "json"]);
    }

    #[test]
    fn models_command_omits_pure_flag_for_v2() {
        let mut config = config("default");
        config.opencode_cli_version = Some("v2".to_string());

        let command = resolved_models_command(&config).unwrap();

        assert_eq!(command.program, "opencode");
        assert_eq!(command.args, ["models", "--verbose"]);
    }

    #[test]
    fn parses_opencode_version_string() {
        assert!(parse_opencode_version_is_v2("opencode v2.0.1"));
        assert!(parse_opencode_version_is_v2("opencode 2.0.0"));
        assert!(parse_opencode_version_is_v2("2.1.0"));
        assert!(parse_opencode_version_is_v2("v2.0.0-beta.1"));
        assert!(!parse_opencode_version_is_v2("opencode v1.4.2"));
        assert!(!parse_opencode_version_is_v2("opencode 0.9.1"));
        assert!(!parse_opencode_version_is_v2(""));
    }

    #[test]
    fn detects_opencode_v2_from_program_name() {
        assert!(is_opencode_v2_program_name("opencode2"));
        assert!(is_opencode_v2_program_name("opencode-2"));
        assert!(is_opencode_v2_program_name("opencode-v2"));
        assert!(is_opencode_v2_program_name("/usr/local/bin/opencode2"));
        assert!(is_opencode_v2_program_name(r"C:\Program Files\OpenCode\opencode2.exe"));
        assert!(!is_opencode_v2_program_name("opencode"));
        assert!(!is_opencode_v2_program_name("/usr/bin/opencode"));
    }

    #[test]
    fn detects_unrecognized_pure_flag_error() {
        assert!(is_unrecognized_pure_flag("Unrecognized flag: --pure in command opencode run"));
        assert!(is_unrecognized_pure_flag("error: unknown flag: --pure"));
        assert!(is_unrecognized_pure_flag("ERROR\n  Unrecognized flag: --pure"));
        assert!(!is_unrecognized_pure_flag("connection failed"));
        assert!(!is_unrecognized_pure_flag("unknown model"));
    }

    #[test]
    fn connection_check_uses_model_discovery_without_a_model_request() {
        let command = resolved_models_command(&config("default")).unwrap();

        assert_eq!(command.program, "opencode");
        assert_eq!(command.args, ["models", "--verbose", "--pure"]);
    }

    #[test]
    fn runtime_config_scopes_mcp_and_denies_other_tools() {
        let runtime = opencode_runtime_config(Some(&options()));

        assert_eq!(runtime.pointer("/permission/*").and_then(Value::as_str), Some("deny"));
        assert_eq!(runtime.pointer("/permission/dbx_*").and_then(Value::as_str), Some("allow"));
        assert_eq!(runtime.pointer("/mcp/dbx/command/0").and_then(Value::as_str), Some("/opt/dbx/dbx-mcp-server"));
        assert_eq!(runtime.pointer("/mcp/dbx/command/1").and_then(Value::as_str), Some("--stdio"));
        assert_eq!(
            runtime.pointer("/mcp/dbx/environment/DBX_MCP_SCOPE_CONNECTION_ID").and_then(Value::as_str),
            Some("conn-1")
        );
        assert_eq!(
            runtime.pointer("/mcp/dbx/environment/DBX_MCP_SCOPE_SCHEMA").and_then(Value::as_str),
            Some("public")
        );
    }

    #[test]
    fn rejects_reserved_or_invalid_environment_names() {
        let mut invalid = config("default");
        invalid.opencode_cli_env.insert("BAD-NAME".to_string(), "1".to_string());
        assert!(opencode_cli_env(&invalid).unwrap_err().starts_with("[openCodeEnvInvalid]"));

        let mut reserved = config("default");
        reserved.opencode_cli_env.insert("OPENCODE_DB".to_string(), "file.db".to_string());
        assert!(opencode_cli_env(&reserved).unwrap_err().starts_with("[openCodeEnvReserved]"));

        reserved.opencode_cli_env.clear();
        reserved.opencode_cli_env.insert("DBX_MCP_ALLOW_WRITES".to_string(), "1".to_string());
        assert!(opencode_cli_env(&reserved).unwrap_err().starts_with("[openCodeEnvReserved]"));
    }

    #[test]
    fn parses_verbose_models_and_preserves_variant_order() {
        let stdout = concat!(
            "openai/gpt-5.4\n",
            "{\n",
            "  \"id\": \"gpt-5.4\",\n",
            "  \"providerID\": \"openai\",\n",
            "  \"name\": \"GPT-5.4\",\n",
            "  \"variants\": {\"none\": {}, \"low\": {}, \"high\": {}, \"future\": {}}\n",
            "}\n",
            "custom/model\n",
            "{\"id\":\"model\",\"providerID\":\"custom\",\"name\":\"Custom\",\"variants\":{}}\n"
        );

        let models = parse_opencode_models(stdout).unwrap();

        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            ["default", "openai/gpt-5.4", "custom/model"]
        );
        assert_eq!(models[1].display_name.as_deref(), Some("GPT-5.4"));
        let AiEffortCapability::Enum { options, .. } = models[1].effort_capability.as_ref().unwrap() else {
            panic!("expected dynamic effort options");
        };
        assert_eq!(
            options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>(),
            ["none", "low", "high", "future"]
        );
        assert!(models[2].effort_capability.is_none());
    }

    #[test]
    fn parses_text_reasoning_tool_error_and_usage_events() {
        let text = parse_opencode_jsonl_event(r#"{"type":"text","part":{"type":"text","text":"hello"}}"#).unwrap();
        assert!(matches!(&text[0], AgentEvent::TextDelta { delta } if delta == "hello"));

        let reasoning =
            parse_opencode_jsonl_event(r#"{"type":"reasoning","part":{"type":"reasoning","text":"thinking"}}"#)
                .unwrap();
        assert!(matches!(&reasoning[0], AgentEvent::ReasoningDelta { delta } if delta == "thinking"));

        let tool = parse_opencode_jsonl_event(
            r#"{"type":"tool_use","part":{"id":"part-1","callID":"call-1","tool":"dbx_dbx_list_connections","state":{"status":"completed","input":{},"output":"ok"}}}"#,
        )
        .unwrap();
        assert_eq!(tool.len(), 2);
        assert!(
            matches!(&tool[0], AgentEvent::ToolCallStart { tool_call_id, tool_name, .. } if tool_call_id == "call-1" && tool_name == "dbx_dbx_list_connections")
        );
        assert!(matches!(&tool[1], AgentEvent::ToolCallEnd { result, is_error: false, .. } if result == "ok"));

        let error = parse_opencode_jsonl_event(
            r#"{"type":"error","error":{"name":"UnknownError","data":{"message":"bad model"}}}"#,
        )
        .unwrap();
        assert!(matches!(&error[0], AgentEvent::Error { message } if message == "bad model"));

        assert!(
            parse_opencode_jsonl_event(r#"{"type":"step_finish","part":{"tokens":{"input":10,"output":3}}}"#).is_none()
        );
    }

    #[tokio::test]
    #[ignore = "requires an installed, authenticated OpenCode CLI and DBX_LIVE_OPENCODE_MODEL"]
    async fn live_model_discovery_and_connection_test() {
        let config = live_config();

        let models = list_opencode_models(&config).await.unwrap();
        assert!(models.iter().any(|model| model.id == config.model));
        let result = test_opencode_connection(&config).await.unwrap();
        assert!(result.success);
        assert!(result.latency_ms.is_some());
    }

    #[tokio::test]
    #[ignore = "requires OpenCode, a running DBX MCP bridge, and DBX_LIVE_MCP_CONNECTION_NAME/DATABASE"]
    async fn live_scoped_dbx_mcp_agent_run() {
        let config = live_config();
        let connection_name = std::env::var("DBX_LIVE_MCP_CONNECTION_NAME")
            .expect("set DBX_LIVE_MCP_CONNECTION_NAME to a saved DBX connection");
        let database = std::env::var("DBX_LIVE_MCP_DATABASE").expect("set DBX_LIVE_MCP_DATABASE to a visible database");
        let mcp_command = std::env::var("DBX_LIVE_MCP_COMMAND").unwrap_or_else(|_| "dbx-mcp-server".to_string());
        let options = OpenCodeRunOptions {
            connection_id: String::new(),
            connection_name: connection_name.clone(),
            database,
            selected_databases: Vec::new(),
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
            run_opencode_agent(
                &config,
                "You must use the DBX MCP list-connections tool. Reply with the visible connection name only.",
                options,
                &Notify::new(),
                move |event| captured.lock().unwrap().push(event),
            ),
        )
        .await
        .expect("OpenCode MCP smoke test timed out")
        .unwrap();

        assert!(result.contains(&connection_name));
        assert!(events.lock().unwrap().iter().any(|event| {
            matches!(event, AgentEvent::ToolCallStart { tool_name, .. } if tool_name.contains("dbx_list_connections"))
        }));
    }
}
