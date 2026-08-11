use crate::agent_events::AgentEvent;
use crate::ai::{
    AiCapabilitySource, AiConfig, AiEffortCapability, AiEffortLevel, AiEffortOption, AiEffortSelection, AiModelInfo,
    AiTestConnectionResult,
};
use crate::ai_cli_agent::{
    build_cli_agent_prompt, cli_command, dbx_mcp_enabled_tools, dbx_mcp_scope_env, run_cli_jsonl_agent, toml_string,
    toml_string_array, CliAgentCommandSpec, CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

const DEFAULT_GROK_MODELS: &[&str] = &["default", "grok-4.5"];
const GROK_MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const GROK_PROCESS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const GROK_ACP_REQUEST_ID: &str = "dbx_model_discovery";
const GROK_ISOLATION_ENV_KEYS: &[&str] = &["HOME", "USERPROFILE", "GROK_HOME", "GROK_AUTH_PATH"];
const DISALLOWED_BUILTIN_TOOLS: &str = "run_terminal_command,read_file,search_replace,list_dir,grep,kill_command_or_subagent,todo_write,get_command_or_subagent_output,spawn_subagent,scheduler_create,scheduler_delete,scheduler_list,monitor,search_tool,use_tool,workflow,enter_plan_mode,exit_plan_mode,ask_user_question,image_gen,image_edit,image_to_video,reference_to_video,write,bash,shell,edit,Glob,Grep";

pub type GrokRunOptions = CliAgentRunOptions;
pub type GrokCommandSpec = CliAgentCommandSpec;

struct GrokIsolatedHome {
    path: PathBuf,
    grok_home: PathBuf,
    auth_path: Option<PathBuf>,
}

impl GrokIsolatedHome {
    fn create(config: &AiConfig, options: Option<&GrokRunOptions>) -> Result<Self, String> {
        let path = env::temp_dir().join(format!("dbx-grok-cli-{}", uuid::Uuid::new_v4()));
        let grok_dir = path.join(".grok");
        std::fs::create_dir_all(&grok_dir)
            .map_err(|error| format!("[grokCliRunFailed] Failed to create isolated Grok home: {error}"))?;

        let config_path = grok_dir.join("config.toml");
        let config_contents = options.map(grok_mcp_config_toml).unwrap_or_else(grok_discovery_config_toml);
        std::fs::write(&config_path, config_contents)
            .map_err(|error| format!("[grokCliRunFailed] Failed to write isolated Grok MCP configuration: {error}"))?;

        Ok(Self { path, grok_home: grok_dir, auth_path: resolve_grok_auth_path(config) })
    }

    fn write_prompt(&self, prompt: &str) -> Result<PathBuf, String> {
        let path = self.path.join("dbx-prompt.txt");
        std::fs::write(&path, prompt)
            .map_err(|error| format!("[grokCliRunFailed] Failed to write Grok prompt file: {error}"))?;
        Ok(path)
    }
}

impl Drop for GrokIsolatedHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn grok_discovery_config_toml() -> String {
    "[cli]\nauto_update = false\nuse_leader = false\n".to_string()
}

fn configured_grok_env_value(config: &AiConfig, name: &str) -> Option<PathBuf> {
    config
        .grok_cli_env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn resolve_grok_auth_path(config: &AiConfig) -> Option<PathBuf> {
    configured_grok_env_value(config, "GROK_AUTH_PATH")
        .or_else(|| configured_grok_env_value(config, "GROK_HOME").map(|home| home.join("auth.json")))
        .or_else(|| env::var_os("GROK_AUTH_PATH").filter(|value| !value.is_empty()).map(PathBuf::from))
        .or_else(|| {
            env::var_os("GROK_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|home| home.join("auth.json"))
        })
        .or_else(|| {
            env::var_os("HOME")
                .or_else(|| env::var_os("USERPROFILE"))
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|home| home.join(".grok").join("auth.json"))
        })
}

fn grok_program(config: &AiConfig) -> String {
    config.grok_cli_path.as_deref().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("grok").to_string()
}

fn grok_process_env(
    config: &AiConfig,
    command: &GrokCommandSpec,
    isolated_home: Option<&GrokIsolatedHome>,
) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::from_iter(grok_cli_env(config)?);
    if let Some(isolated_home) = isolated_home {
        env.retain(|key, _| !GROK_ISOLATION_ENV_KEYS.iter().any(|managed| key.eq_ignore_ascii_case(managed)));
        let home = isolated_home.path.to_string_lossy().to_string();
        env.insert("HOME".to_string(), home.clone());
        env.insert("USERPROFILE".to_string(), home);
        env.insert("GROK_HOME".to_string(), isolated_home.grok_home.to_string_lossy().to_string());
        if let Some(auth_path) = &isolated_home.auth_path {
            env.insert("GROK_AUTH_PATH".to_string(), auth_path.to_string_lossy().to_string());
        }
    }
    if let Some(dir) = command_parent_dir(command) {
        let user_path = env.get("PATH").map(String::as_str);
        env.insert("PATH".to_string(), merged_path_with_dir(&dir, user_path));
    }
    Ok(env.into_iter().collect())
}

fn command_parent_dir(command: &GrokCommandSpec) -> Option<String> {
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
        if let Some(home) = env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".grok").join("bin"));
        }
    }
    dirs
}

fn validate_grok_program(config: &AiConfig) -> Result<String, String> {
    let program = grok_program(config);
    if starts_with_env_assignment(&program) {
        return Err("[grokCliPathInvalid] Grok CLI path should contain only the executable path. Add environment variables in the Grok CLI environment variables section.".to_string());
    }
    if is_path_like_program(&program) {
        let expanded = crate::path_utils::expand_tilde(&program);
        let path = Path::new(&expanded);
        if path.is_dir() {
            return launchable_program_in_dir(path, "grok").ok_or_else(|| {
                "[grokCliPathInvalid] Grok CLI path should point to the grok executable or a directory containing grok."
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

pub fn grok_cli_env(config: &AiConfig) -> Result<Vec<(String, String)>, String> {
    let mut env = BTreeMap::new();
    for (key, value) in &config.grok_cli_env {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if !is_env_var_name(key) {
            return Err(format!(
                "[grokCliEnvInvalid] Invalid Grok CLI environment variable name `{key}`. Use names like HTTPS_PROXY."
            ));
        }
        if is_reserved_dbx_mcp_env_name(key) {
            return Err(format!(
                "[grokCliEnvReserved] `{key}` is managed by DBX for the scoped MCP server and cannot be set here."
            ));
        }
        env.insert(key.to_string(), value.clone());
    }
    Ok(env.into_iter().collect())
}

/// Grok MCP tool names are `server__tool` (no `mcp__` prefix). Permission rules
/// must use `MCPTool(server__tool)` form — `mcp__server__tool` never matches.
fn grok_mcp_permission_rules(options: &GrokRunOptions) -> Vec<String> {
    let mut rules = vec!["MCPTool(dbx__*)".to_string()];
    for tool in dbx_mcp_enabled_tools(options.agent_mode) {
        rules.push(format!("MCPTool(dbx__{tool})"));
    }
    rules
}

fn grok_mcp_config_toml(options: &GrokRunOptions) -> String {
    let mcp_command =
        options.mcp_server_command.as_ref().map(|command| command.program.as_str()).unwrap_or("dbx-mcp-server");
    let permission_rules = grok_mcp_permission_rules(options);
    let permission_rule_refs = permission_rules.iter().map(String::as_str).collect::<Vec<_>>();
    let mut lines = vec![
        "[cli]".to_string(),
        "auto_update = false".to_string(),
        "use_leader = false".to_string(),
        String::new(),
        // Tool auto-approval is driven by the `--always-approve` CLI flag, not a
        // config key: grok's permission_mode enum has no "always-approve" value
        // (valid values: default/acceptEdits/auto/dontAsk/bypassPermissions/plan).
        "[permission]".to_string(),
        format!("allow = {}", toml_string_array(&permission_rule_refs)),
        String::new(),
        // Only command/args/env are part of the documented mcp_servers schema
        // (per `grok mcp add`); startup_timeout_sec/tool_timeout_sec/enabled_tools
        // are not recognized fields and would be silently ignored.
        "[mcp_servers.dbx]".to_string(),
        format!("command = {}", toml_string(mcp_command)),
    ];
    if let Some(command) = options.mcp_server_command.as_ref().filter(|command| !command.args.is_empty()) {
        let args = command.args.iter().map(String::as_str).collect::<Vec<_>>();
        lines.push(format!("args = {}", toml_string_array(&args)));
    }
    lines.push(String::new());
    lines.push("[mcp_servers.dbx.env]".to_string());
    for (name, value) in dbx_mcp_scope_env(options) {
        lines.push(format!("{name} = {}", toml_string(&value)));
    }
    lines.push(String::new());
    lines.join("\n")
}

pub fn build_grok_command(config: &AiConfig, prompt_file: &Path, options: &GrokRunOptions) -> GrokCommandSpec {
    // Align with Grok Build headless docs (`--prompt-file`, `streaming-json`,
    // `--always-approve`, `--effort`). Prompt is written to a temp file so long
    // DBX system+conversation prompts stay under OS argv limits.
    let mut args = vec![
        "--no-leader".to_string(),
        "--prompt-file".to_string(),
        prompt_file.to_string_lossy().to_string(),
        "--output-format".to_string(),
        "streaming-json".to_string(),
        "--always-approve".to_string(),
        "--disable-web-search".to_string(),
        "--no-subagents".to_string(),
        "--no-plan".to_string(),
        "--disallowed-tools".to_string(),
        DISALLOWED_BUILTIN_TOOLS.to_string(),
        "--verbatim".to_string(),
    ];

    // Grok permission rules: `MCPTool(server__tool)`, not Claude-style `mcp__server__tool`.
    for rule in grok_mcp_permission_rules(options) {
        args.push("--allow".to_string());
        args.push(rule);
    }

    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    let effort =
        config.runtime_effort.as_ref().and_then(|effort| effort.cli_value()).or_else(|| match config.reasoning_level {
            crate::ai::AiReasoningLevel::Default | crate::ai::AiReasoningLevel::Minimal => None,
            crate::ai::AiReasoningLevel::Low => Some("low".to_string()),
            crate::ai::AiReasoningLevel::Medium => Some("medium".to_string()),
            crate::ai::AiReasoningLevel::High => Some("high".to_string()),
            crate::ai::AiReasoningLevel::Xhigh | crate::ai::AiReasoningLevel::Max => Some("high".to_string()),
        });
    if let Some(effort) = effort {
        // `--effort` is the documented alias of `--reasoning-effort`.
        args.push("--effort".to_string());
        args.push(effort);
    }

    GrokCommandSpec { program: grok_program(config), args }
}

pub fn build_grok_prompt(system_prompt: &str, messages: &[crate::ai::AiMessage], allow_write_sql: bool) -> String {
    build_cli_agent_prompt("Grok", system_prompt, messages, allow_write_sql)
}

fn default_grok_models() -> Vec<AiModelInfo> {
    DEFAULT_GROK_MODELS
        .iter()
        .map(|id| {
            let display = if *id == "default" { Some("Default".to_string()) } else { None };
            AiModelInfo::new(*id, display)
        })
        .collect()
}

pub async fn list_grok_models(config: &AiConfig) -> Result<Vec<AiModelInfo>, String> {
    let program = validate_grok_program(config)?;
    Ok(discover_grok_models(config, program).await.unwrap_or_else(default_grok_models))
}

async fn discover_grok_models(config: &AiConfig, program: String) -> Option<Vec<AiModelInfo>> {
    if let Some(models) = discover_grok_models_acp(config, program.clone()).await {
        return Some(models);
    }
    discover_grok_models_listing(config, program).await
}

async fn discover_grok_models_acp(config: &AiConfig, program: String) -> Option<Vec<AiModelInfo>> {
    let isolated_home = GrokIsolatedHome::create(config, None).ok()?;
    let command =
        GrokCommandSpec { program, args: vec!["agent".to_string(), "--no-leader".to_string(), "stdio".to_string()] };
    let env = grok_process_env(config, &command, Some(&isolated_home)).ok()?;
    let mut process = cli_command(&command.program);
    process
        .args(command.args.iter().map(String::as_str))
        .current_dir(&isolated_home.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in GROK_ISOLATION_ENV_KEYS {
        process.env_remove(key);
    }
    process.envs(env.iter().map(|(key, value)| (key.as_str(), value.as_str())));

    let mut child = process.spawn().ok()?;
    let discovery = async {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let mut request = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": GROK_ACP_REQUEST_ID,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
                "clientInfo": { "name": "DBX", "version": env!("CARGO_PKG_VERSION") },
            },
        }))
        .ok()?;
        request.push(b'\n');
        stdin.write_all(&request).await.ok()?;
        stdin.flush().await.ok()?;

        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(models) = parse_grok_acp_initialize(&line) {
                return Some(models);
            }
        }
        None
    };
    let result = tokio::time::timeout(GROK_MODEL_DISCOVERY_TIMEOUT, discovery).await.ok().flatten();
    stop_grok_process(&mut child).await;
    result
}

async fn stop_grok_process(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(GROK_PROCESS_SHUTDOWN_TIMEOUT, child.wait()).await;
}

async fn discover_grok_models_listing(config: &AiConfig, program: String) -> Option<Vec<AiModelInfo>> {
    let command = GrokCommandSpec { program, args: vec!["models".to_string()] };
    let env = grok_process_env(config, &command, None).ok()?;
    let mut process = cli_command(&command.program);
    process
        .args(command.args.iter().map(String::as_str))
        .envs(env.iter().map(|(key, value)| (key.as_str(), value.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = process.spawn().ok()?;
    let output = tokio::time::timeout(GROK_MODEL_DISCOVERY_TIMEOUT, child.wait_with_output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    parse_grok_models(&String::from_utf8_lossy(&output.stdout))
}

fn parse_grok_acp_initialize(line: &str) -> Option<Vec<AiModelInfo>> {
    let response = serde_json::from_str::<Value>(line.trim()).ok()?;
    if response.get("id").and_then(Value::as_str) != Some(GROK_ACP_REQUEST_ID) || response.get("error").is_some() {
        return None;
    }
    let result = response.get("result")?;
    let model_state = result
        .get("_meta")
        .and_then(|metadata| metadata.get("modelState").or_else(|| metadata.get("model_state")))
        .or_else(|| {
            result.get("meta").and_then(|metadata| metadata.get("modelState").or_else(|| metadata.get("model_state")))
        })
        .or_else(|| result.get("modelState"))
        .or_else(|| result.get("model_state"))?;
    parse_grok_model_state(model_state)
}

fn parse_grok_model_state(model_state: &Value) -> Option<Vec<AiModelInfo>> {
    let current_model_id = model_state
        .get("currentModelId")
        .or_else(|| model_state.get("current_model_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string);
    let available_models =
        model_state.get("availableModels").or_else(|| model_state.get("available_models")).and_then(Value::as_array)?;

    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for model in available_models {
        let Some(id) = model
            .get("modelId")
            .or_else(|| model.get("model_id"))
            .or_else(|| model.get("value"))
            .or_else(|| model.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let display_name = model
            .get("name")
            .or_else(|| model.get("displayName"))
            .or_else(|| model.get("display_name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string);
        let mut info = AiModelInfo::new(id, display_name);
        info.effort_capability = parse_grok_effort_capability(model);
        info.supported_effort_levels = grok_legacy_effort_levels(info.effort_capability.as_ref());
        models.push(info);
    }
    if models.is_empty() {
        return None;
    }

    let inherited = current_model_id
        .as_deref()
        .and_then(|current| models.iter().find(|model| model.id == current))
        .or_else(|| models.iter().find(|model| model.id.eq_ignore_ascii_case("default")))
        .cloned();
    models.retain(|model| !model.id.eq_ignore_ascii_case("default"));
    let mut default_model = AiModelInfo::new("default", Some("Default".to_string()));
    if let Some(inherited) = inherited {
        default_model.effort_capability = inherited.effort_capability;
        default_model.supported_effort_levels = inherited.supported_effort_levels;
    }
    models.insert(0, default_model);

    Some(models)
}

fn grok_model_metadata_field<'a>(model: &'a Value, camel_case: &str, snake_case: &str) -> Option<&'a Value> {
    model
        .get("_meta")
        .and_then(|metadata| metadata.get(camel_case).or_else(|| metadata.get(snake_case)))
        .or_else(|| {
            model.get("meta").and_then(|metadata| metadata.get(camel_case).or_else(|| metadata.get(snake_case)))
        })
        .or_else(|| model.get(camel_case))
        .or_else(|| model.get(snake_case))
}

fn parse_grok_effort_capability(model: &Value) -> Option<AiEffortCapability> {
    if grok_model_metadata_field(model, "supportsReasoningEffort", "supports_reasoning_effort").and_then(Value::as_bool)
        == Some(false)
    {
        return Some(AiEffortCapability::Unsupported);
    }
    let efforts = grok_model_metadata_field(model, "reasoningEfforts", "reasoning_efforts")?.as_array()?;
    let mut seen = BTreeSet::new();
    let mut provider_default = None;
    let options = efforts
        .iter()
        .filter_map(|effort| {
            let id = match effort {
                Value::String(value) => value.as_str(),
                Value::Object(_) => effort.get("value").or_else(|| effort.get("id")).and_then(Value::as_str)?,
                _ => return None,
            }
            .trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            if provider_default.is_none()
                && effort
                    .get("default")
                    .or_else(|| effort.get("isDefault"))
                    .or_else(|| effort.get("is_default"))
                    .and_then(Value::as_bool)
                    == Some(true)
            {
                provider_default = Some(AiEffortSelection::Enum(id.to_string()));
            }
            let label = effort
                .get("label")
                .or_else(|| effort.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .unwrap_or(id)
                .to_string();
            let description = effort
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
    let default = provider_default.or_else(|| options.first().map(|option| option.selection.clone()))?;
    Some(AiEffortCapability::Enum { options, default, source: AiCapabilitySource::LocalCli })
}

fn grok_legacy_effort_levels(capability: Option<&AiEffortCapability>) -> Vec<AiEffortLevel> {
    let Some(AiEffortCapability::Enum { options, .. }) = capability else {
        return Vec::new();
    };
    options.iter().filter_map(|option| option.id.parse::<AiEffortLevel>().ok()).collect()
}

fn parse_grok_models(stdout: &str) -> Option<Vec<AiModelInfo>> {
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        let Some(id) = trimmed.strip_prefix('*').map(str::trim).filter(|id| !id.is_empty()) else {
            continue;
        };
        let id = id.split_whitespace().next().unwrap_or(id).trim_matches(|ch| ch == '(' || ch == ')' || ch == ',');
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        models.push(AiModelInfo::new(id, None));
    }
    if models.is_empty() {
        return None;
    }
    if seen.insert("default".to_string()) {
        models.insert(0, AiModelInfo::new("default", Some("Default".to_string())));
    }
    Some(models)
}

pub async fn test_grok_connection(config: &AiConfig) -> Result<AiTestConnectionResult, String> {
    test_grok_connection_with_timeout(config, GROK_MODEL_DISCOVERY_TIMEOUT).await
}

async fn test_grok_connection_with_timeout(
    config: &AiConfig,
    timeout: Duration,
) -> Result<AiTestConnectionResult, String> {
    let start = Instant::now();
    let program = validate_grok_program(config)?;
    let command = GrokCommandSpec { program, args: vec!["models".to_string()] };
    let mut process = cli_command(&command.program);
    process.args(command.args.iter().map(String::as_str));
    process.envs(grok_process_env(config, &command, None)?.iter().map(|(key, value)| (key.as_str(), value.as_str())));
    process.kill_on_drop(true);

    let output = tokio::time::timeout(timeout, process.output())
        .await
        .map_err(|_| "[grokCliRunFailed] Grok CLI connection test timed out.".to_string())?
        .map_err(|e| classify_grok_spawn_error(&e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined =
        [stdout.trim(), stderr.trim()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n");

    if output.status.success() {
        // `grok models` can exit 0 yet print an auth warning; catch the same
        // "Not signed in" wording the headless run emits (see classify_grok_run_error).
        let combined_lower = combined.to_ascii_lowercase();
        if combined_lower.contains("not signed in")
            || combined_lower.contains("not logged")
            || combined_lower.contains("not authenticated")
        {
            return Err(classify_grok_run_error(&combined));
        }
        Ok(AiTestConnectionResult {
            success: true,
            message: format!("OK - {}ms", start.elapsed().as_millis()),
            latency_ms: Some(start.elapsed().as_millis() as u64),
            model_used: config.model.trim().to_string(),
            error_category: None,
        })
    } else {
        Err(classify_grok_run_error(&combined))
    }
}

fn classify_grok_spawn_error(message: &str) -> String {
    if message.contains("No such file") || message.contains("not found") {
        "[grokCliNotInstalled] Grok CLI was not found. Install Grok CLI or set the Grok CLI path in DBX AI settings."
            .to_string()
    } else if is_command_line_too_long_error(message) {
        "[grokCliCommandLineTooLong] Grok CLI command line is too long. Update DBX so Grok prompts are sent through a temporary prompt file."
            .to_string()
    } else {
        format!("[grokCliRunFailed] Failed to start Grok CLI: {message}")
    }
}

fn is_command_line_too_long_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("os error 206")
        || message.contains("文件名或扩展名太长")
        || lower.contains("filename or extension is too long")
        || lower.contains("the filename or extension is too long")
}

fn classify_grok_run_error(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    // Grok's real headless auth error is "Not signed in. ... run `grok login` ..."
    // (verified against @xai-official/grok 1.0.0). Older wording used
    // "not authenticated"/"not logged", so cover both for robustness.
    if lower.contains("not signed in")
        || lower.contains("not authenticated")
        || lower.contains("not logged")
        || lower.contains("please login")
        || lower.contains("login required")
        || lower.contains("authentication required")
    {
        format!("[grokCliNotAuthenticated] Grok CLI is not authenticated. Run `grok login` and try again. {stderr}")
    } else if lower.contains("dbx-mcp-server") || lower.contains("enoent") {
        format!("[dbxMcpMissing] DBX MCP server was not found. Install @dbx-app/mcp-server and try again. {stderr}")
    } else if lower.contains("mcp") && (lower.contains("dbx") || lower.contains("server")) {
        format!("[grokCliMcpStartupFailed] Grok could not start the DBX MCP server. {stderr}")
    } else {
        format!("[grokCliRunFailed] Grok CLI failed. {stderr}")
    }
}

pub async fn run_grok_agent(
    config: &AiConfig,
    prompt: &str,
    options: GrokRunOptions,
    cancelled: &Notify,
    on_event: impl Fn(AgentEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let program = validate_grok_program(config)?;
    let isolated_home = GrokIsolatedHome::create(config, Some(&options))?;
    let prompt_path = isolated_home.write_prompt(prompt)?;
    let mut command = build_grok_command(config, &prompt_path, &options);
    command.program = program;
    let env = grok_process_env(config, &command, Some(&isolated_home))?;
    run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
            env,
            env_remove: GROK_ISOLATION_ENV_KEYS.iter().map(|key| (*key).to_string()).collect(),
            current_dir: Some(isolated_home.path.clone()),
            stdin: None,
            // Grok headless `streaming-json`: text/thought/tool_call/tool_call_update/end/error.
            dialect: CliAgentJsonlDialect::GrokStreamingJson,
            classify_spawn_error: classify_grok_spawn_error,
            classify_run_error: classify_grok_run_error,
        },
        cancelled,
        on_event,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        build_grok_command, classify_grok_run_error, default_grok_models, grok_cli_env, grok_mcp_config_toml,
        grok_process_env, parse_grok_acp_initialize, parse_grok_models, validate_grok_program, GrokIsolatedHome,
        GrokRunOptions,
    };
    use crate::ai::{
        AiApiStyle, AiAuthMethod, AiCapabilitySource, AiConfig, AiEffortCapability, AiEffortLevel, AiEffortSelection,
        AiProvider, AiReasoningLevel,
    };
    use crate::ai_cli_agent::CliAgentCommandSpec;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn base_config() -> AiConfig {
        AiConfig {
            provider: AiProvider::GrokCli,
            api_key: String::new(),
            auth_method: AiAuthMethod::Bearer,
            endpoint: String::new(),
            model: "default".to_string(),
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

    fn run_options() -> GrokRunOptions {
        GrokRunOptions {
            connection_id: "conn-1".to_string(),
            connection_name: "Demo".to_string(),
            database: "app".to_string(),
            schema: None,
            agent_mode: true,
            allow_writes: false,
            allow_dangerous: false,
            confirmed_write_sql: None,
            mcp_server_command: Some(CliAgentCommandSpec {
                program: "dbx-mcp-server".to_string(),
                args: vec!["--stdio".to_string()],
            }),
        }
    }

    #[test]
    fn validates_path_and_env() {
        let mut config = base_config();
        assert_eq!(validate_grok_program(&config).unwrap(), "grok");

        config.grok_cli_path = Some("HTTPS_PROXY=http://proxy:1 /usr/bin/grok".to_string());
        assert!(validate_grok_program(&config).unwrap_err().contains("[grokCliPathInvalid]"));

        config.grok_cli_path = None;
        config.grok_cli_env.insert("HTTPS_PROXY".to_string(), "http://proxy:9800".to_string());
        assert_eq!(grok_cli_env(&config).unwrap(), vec![("HTTPS_PROXY".to_string(), "http://proxy:9800".to_string())]);

        config.grok_cli_env.insert("DBX_MCP_ALLOW_WRITES".to_string(), "1".to_string());
        assert!(grok_cli_env(&config).unwrap_err().contains("[grokCliEnvReserved]"));
    }

    #[test]
    fn builds_headless_command_with_prompt_file_and_model() {
        let mut config = base_config();
        config.model = "grok-4.5".to_string();
        let prompt = PathBuf::from("/tmp/dbx-prompt.txt");
        let command = build_grok_command(&config, &prompt, &run_options());
        assert_eq!(command.program, "grok");
        assert!(command.args.iter().any(|arg| arg == "--no-leader"));
        assert!(command.args.windows(2).any(|pair| pair == ["--prompt-file", "/tmp/dbx-prompt.txt"]));
        assert!(command.args.windows(2).any(|pair| pair == ["--output-format", "streaming-json"]));
        assert!(command.args.iter().any(|arg| arg == "--always-approve"));
        assert!(command.args.windows(2).any(|pair| pair == ["--model", "grok-4.5"]));
        assert!(command.args.iter().any(|arg| arg == "--disable-web-search"));
        // Grok permission rule form — not Claude-style mcp__server__tool.
        assert!(command.args.windows(2).any(|pair| pair == ["--allow", "MCPTool(dbx__*)"]));
        assert!(command.args.windows(2).any(|pair| pair == ["--allow", "MCPTool(dbx__dbx_list_tables)"]));
        assert!(!command.args.iter().any(|arg| arg.contains("mcp__dbx__")));
    }

    #[test]
    fn builds_effort_flag_from_runtime_effort() {
        let mut config = base_config();
        config.model = "grok-4.5".to_string();
        config.runtime_effort = Some(AiEffortSelection::Enum("medium".to_string()));
        let prompt = PathBuf::from("/tmp/dbx-prompt.txt");
        let command = build_grok_command(&config, &prompt, &run_options());
        assert!(command.args.windows(2).any(|pair| pair == ["--effort", "medium"]));
    }

    #[test]
    fn parses_model_specific_effort_from_acp_initialize() {
        let models = parse_grok_acp_initialize(
            r#"{"jsonrpc":"2.0","id":"dbx_model_discovery","result":{"_meta":{"modelState":{"currentModelId":"grok-4.5","availableModels":[{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"supportsReasoningEffort":true,"reasoningEfforts":[{"value":"medium","label":"Medium Effort","default":false},{"id":"deep","value":"high","label":"High Effort","description":"Deep reasoning","default":true},{"value":"future","label":"Future Effort"},{"value":"high","label":"Duplicate","default":true}]}},{"modelId":"grok-fast","name":"Grok Fast","meta":{"supportsReasoningEffort":false}}]}}}}"#,
        )
        .unwrap();

        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["default", "grok-4.5", "grok-fast"]
        );
        for id in ["default", "grok-4.5"] {
            let model = models.iter().find(|model| model.id == id).unwrap();
            let Some(AiEffortCapability::Enum { options, default, source }) = &model.effort_capability else {
                panic!("expected dynamic Grok effort capability");
            };
            assert_eq!(*source, AiCapabilitySource::LocalCli);
            assert_eq!(*default, AiEffortSelection::Enum("high".to_string()));
            assert_eq!(
                options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>(),
                vec!["medium", "high", "future"]
            );
            assert_eq!(options[1].label, "High Effort");
            assert_eq!(options[1].description.as_deref(), Some("Deep reasoning"));
            assert_eq!(model.supported_effort_levels, vec![AiEffortLevel::Medium, AiEffortLevel::High]);
        }
        let fast = models.iter().find(|model| model.id == "grok-fast").unwrap();
        assert_eq!(fast.effort_capability, Some(AiEffortCapability::Unsupported));
        assert!(fast.supported_effort_levels.is_empty());
    }

    #[test]
    fn accepts_compatibility_shapes_and_bare_effort_values() {
        let models = parse_grok_acp_initialize(
            r#"{"jsonrpc":"2.0","id":"dbx_model_discovery","result":{"meta":{"model_state":{"current_model_id":"grok-next","available_models":[{"model_id":"grok-next","display_name":"Grok Next","supports_reasoning_effort":true,"reasoning_efforts":["low","xhigh","quantum","low"]}]}}}}"#,
        )
        .unwrap();
        let model = models.iter().find(|model| model.id == "grok-next").unwrap();
        let Some(AiEffortCapability::Enum { options, .. }) = &model.effort_capability else {
            panic!("expected dynamic Grok effort capability");
        };
        assert_eq!(
            options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>(),
            vec!["low", "xhigh", "quantum"]
        );
        assert_eq!(model.supported_effort_levels, vec![AiEffortLevel::Low, AiEffortLevel::Xhigh]);
    }

    #[test]
    fn missing_effort_metadata_and_listing_fallback_do_not_invent_levels() {
        let models = parse_grok_acp_initialize(
            r#"{"jsonrpc":"2.0","id":"dbx_model_discovery","result":{"_meta":{"modelState":{"currentModelId":"grok-plain","availableModels":[{"modelId":"grok-plain"},{"modelId":"grok-empty","_meta":{"supportsReasoningEffort":true}}]}}}}"#,
        )
        .unwrap();
        assert!(models.iter().all(|model| model.effort_capability.is_none()));
        assert!(models.iter().all(|model| model.supported_effort_levels.is_empty()));

        let stdout = "You are logged in with grok.com.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n";
        let models = parse_grok_models(stdout).unwrap();
        assert!(models.iter().all(|model| model.effort_capability.is_none()));
        assert!(default_grok_models().iter().all(|model| model.effort_capability.is_none()));
    }

    #[test]
    fn isolated_environment_overrides_config_home_but_reuses_selected_auth() {
        let mut config = base_config();
        config.grok_cli_env.insert("GROK_HOME".to_string(), "/configured/grok-home".to_string());
        config.grok_cli_env.insert("GROK_AUTH_PATH".to_string(), "/selected/auth.json".to_string());
        let isolated = GrokIsolatedHome::create(&config, None).unwrap();
        let command = super::GrokCommandSpec {
            program: "grok".to_string(),
            args: vec!["agent".to_string(), "stdio".to_string()],
        };
        let env = grok_process_env(&config, &command, Some(&isolated))
            .unwrap()
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>();

        assert_eq!(env.get("HOME"), Some(&isolated.path.to_string_lossy().to_string()));
        assert_eq!(env.get("USERPROFILE"), Some(&isolated.path.to_string_lossy().to_string()));
        assert_eq!(env.get("GROK_HOME"), Some(&isolated.grok_home.to_string_lossy().to_string()));
        assert_eq!(env.get("GROK_AUTH_PATH").map(String::as_str), Some("/selected/auth.json"));
        assert_ne!(env.get("GROK_HOME").map(String::as_str), Some("/configured/grok-home"));
    }

    #[cfg(unix)]
    fn fake_grok_config() -> (AiConfig, PathBuf, PathBuf, PathBuf) {
        let project_dir = std::env::temp_dir().join(format!("dbx-grok-project-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(project_dir.join(".grok")).unwrap();
        let fallback_marker = project_dir.join("models-command-used");
        let inference_marker = project_dir.join("inference-command-used");
        let isolation_marker = project_dir.join("isolation-failed");
        let executable = project_dir.join("grok");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
case " $* " in
  *" --prompt-file "*)
    printf used > "$DBX_TEST_INFERENCE_MARKER"
    exit 12
    ;;
  *" agent --no-leader stdio "*)
    if [ "$GROK_HOME" = "$DBX_TEST_PROJECT_DIR/.grok" ] || [ "$PWD" = "$DBX_TEST_PROJECT_DIR" ] || [ "$GROK_AUTH_PATH" != "/selected/auth.json" ]; then
      printf leaked > "$DBX_TEST_ISOLATION_MARKER"
      exit 13
    fi
    IFS= read -r request
    case "$request" in
      *'"method":"initialize"'*)
        printf '%s\n' '{"jsonrpc":"2.0","id":"dbx_model_discovery","result":{"_meta":{"modelState":{"currentModelId":"grok-dynamic","availableModels":[{"modelId":"grok-dynamic","name":"Grok Dynamic","_meta":{"supportsReasoningEffort":true,"reasoningEfforts":[{"value":"xhigh","label":"Extra High"},{"value":"future","label":"Future"}]}}]}}}}'
        ;;
      *)
        exit 14
        ;;
    esac
    ;;
  *" models "*)
    if [ "$DBX_TEST_MODELS_HANG" = "1" ]; then
      while :; do :; done
    fi
    printf used > "$DBX_TEST_MODELS_MARKER"
    printf '%s\n' 'You are logged in with grok.com.' 'Available models:' '  * grok-fallback (default)'
    ;;
  *)
    exit 15
    ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let mut config = base_config();
        config.grok_cli_path = Some(executable.to_string_lossy().to_string());
        config.grok_cli_env.insert("GROK_HOME".to_string(), project_dir.join(".grok").to_string_lossy().to_string());
        config.grok_cli_env.insert("GROK_AUTH_PATH".to_string(), "/selected/auth.json".to_string());
        config.grok_cli_env.insert("DBX_TEST_PROJECT_DIR".to_string(), project_dir.to_string_lossy().to_string());
        config.grok_cli_env.insert("DBX_TEST_MODELS_MARKER".to_string(), fallback_marker.to_string_lossy().to_string());
        config
            .grok_cli_env
            .insert("DBX_TEST_INFERENCE_MARKER".to_string(), inference_marker.to_string_lossy().to_string());
        config
            .grok_cli_env
            .insert("DBX_TEST_ISOLATION_MARKER".to_string(), isolation_marker.to_string_lossy().to_string());
        (config, project_dir, fallback_marker, inference_marker)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_uses_isolated_acp_initialize_without_inference() {
        let (config, project_dir, models_marker, inference_marker) = fake_grok_config();
        let models = super::list_grok_models(&config).await.unwrap();
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["default", "grok-dynamic"]);
        let Some(AiEffortCapability::Enum { options, .. }) = &models[1].effort_capability else {
            panic!("expected dynamic Grok effort capability");
        };
        assert_eq!(options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>(), ["xhigh", "future"]);
        assert!(!models_marker.exists(), "ACP success must not fall back to the human-readable model listing");
        assert!(!inference_marker.exists(), "model discovery must not issue an inference request");
        assert!(!project_dir.join("isolation-failed").exists());

        let result = super::test_grok_connection(&config).await.unwrap();
        assert!(result.success);
        assert!(models_marker.exists(), "connection testing should use the non-inference models command");
        assert!(!inference_marker.exists());
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connection_test_is_timeout_bounded() {
        let (mut config, project_dir, _, _) = fake_grok_config();
        config.grok_cli_env.insert("DBX_TEST_MODELS_HANG".to_string(), "1".to_string());
        let error =
            super::test_grok_connection_with_timeout(&config, std::time::Duration::from_millis(50)).await.unwrap_err();
        assert!(error.starts_with("[grokCliRunFailed]"));
        assert!(error.contains("timed out"));
        let _ = std::fs::remove_dir_all(project_dir);
    }

    #[test]
    fn mcp_config_includes_scoped_dbx_server() {
        let toml = grok_mcp_config_toml(&run_options());
        assert!(toml.contains("[mcp_servers.dbx]"));
        assert!(toml.contains("command = \"dbx-mcp-server\""));
        assert!(toml.contains("args = [\"--stdio\"]"));
        assert!(toml.contains("DBX_MCP_SCOPE_CONNECTION_ID = \"conn-1\""));
        assert!(toml.contains("DBX_MCP_ALLOW_WRITES = \"0\""));
        assert!(toml.contains("[permission]"));
        assert!(toml.contains("use_leader = false"));
        assert!(toml.contains("MCPTool(dbx__*)"));
        // Invalid fields removed: grok has no "always-approve" permission_mode,
        // and startup_timeout_sec/tool_timeout_sec/enabled_tools are not mcp_servers keys.
        assert!(!toml.contains("permission_mode"));
        assert!(!toml.contains("always-approve"));
        assert!(!toml.contains("startup_timeout_sec"));
        assert!(!toml.contains("tool_timeout_sec"));
        assert!(!toml.contains("enabled_tools"));
    }

    #[test]
    fn parses_models_listing() {
        let stdout = "You are logged in with grok.com.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n  * grok-4\n";
        let models = parse_grok_models(stdout).unwrap();
        assert_eq!(models[0].id, "default");
        assert!(models.iter().any(|model| model.id == "grok-4.5"));
        assert!(models.iter().any(|model| model.id == "grok-4"));
        assert_eq!(default_grok_models()[1].id, "grok-4.5");
    }

    #[test]
    fn classifies_auth_errors() {
        let err = classify_grok_run_error("not authenticated; please login");
        assert!(err.contains("[grokCliNotAuthenticated]"));

        // Real @xai-official/grok 1.0.0 headless auth failure emits this exact wording.
        let real = classify_grok_run_error(
            "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
        );
        assert!(real.contains("[grokCliNotAuthenticated]"));
    }
}
