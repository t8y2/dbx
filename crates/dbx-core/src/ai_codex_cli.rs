use crate::agent_events::AgentEvent;
use crate::ai::{AiConfig, AiModelInfo, AiTestConnectionResult};
use crate::ai_cli_agent::{
    append_config_overrides, build_cli_agent_prompt, dbx_mcp_enabled_tools, dbx_mcp_scope_env, model_infos,
    parse_cli_jsonl_event, run_cli_jsonl_agent, toml_string, toml_string_array, CliAgentCommandSpec,
    CliAgentJsonlDialect, CliAgentProcessSpec, CliAgentRunOptions,
};
use serde_json::Value;
use std::time::Instant;
use tokio::process::Command;
use tokio::sync::Notify;

const DEFAULT_CODEX_MODELS: &[&str] = &["default", "gpt-5.5", "gpt-5.4-mini"];

pub type CodexRunOptions = CliAgentRunOptions;
pub type CodexCommandSpec = CliAgentCommandSpec;

fn codex_program(config: &AiConfig) -> String {
    config.codex_cli_path.as_deref().map(str::trim).filter(|path| !path.is_empty()).unwrap_or("codex").to_string()
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
        "mcp_servers.dbx.default_tools_approval_mode=\"auto\"".to_string(),
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
    let output = Command::new(codex_program(config)).args(["debug", "models"]).output().await;

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
    let mut command = Command::new(codex_program(config));
    command.args(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);

    let model = config.model.trim();
    if !model.is_empty() && !model.eq_ignore_ascii_case("default") {
        command.args(["--model", model]);
    }

    let output = command
        .arg("Reply with exactly: DBX Codex OK")
        .output()
        .await
        .map_err(|e| classify_codex_spawn_error(&e.to_string()))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.contains("DBX Codex OK") {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "[codexRunFailed] Codex CLI smoke test returned unexpected output. stdout: {stdout} stderr: {stderr}"
            ));
        }
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
    let command = build_codex_exec_command(config, prompt, &options);
    run_cli_jsonl_agent(
        CliAgentProcessSpec {
            command,
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
    use super::{
        build_codex_exec_command, codex_enabled_tools, parse_codex_jsonl_event, parse_codex_models, CodexRunOptions,
        DEFAULT_CODEX_MODELS,
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
    fn default_model_list_matches_plan() {
        assert_eq!(model_infos(DEFAULT_CODEX_MODELS), model_infos(&["default", "gpt-5.5", "gpt-5.4-mini"]));
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

        let turn_done =
            parse_codex_jsonl_event(r#"{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}"#)
                .unwrap();
        assert!(matches!(&turn_done[0], AgentEvent::AgentEnd { input_tokens: Some(12), output_tokens: Some(3) }));

        let failed = parse_codex_jsonl_event(r#"{"type":"turn.failed","message":"boom"}"#).unwrap();
        assert!(matches!(&failed[0], AgentEvent::Error { message } if message == "boom"));
    }
}
