use crate::ai::{
    AiApiStyle, AiCapabilitySource, AiConfig, AiEffortCapability, AiEffortOption, AiEffortSelection, AiProvider,
};
use serde_json::{json, Map, Value};

const OPENAI_REASONING_DOCS: &str = "https://platform.openai.com/docs/guides/reasoning";
const GEMINI_THINKING_DOCS: &str = "https://ai.google.dev/gemini-api/docs/thinking";
const DEEPSEEK_THINKING_DOCS: &str = "https://api-docs.deepseek.com/guides/thinking_mode";
const QWEN_THINKING_DOCS: &str = "https://help.aliyun.com/en/model-studio/deep-thinking";
const OLLAMA_THINKING_DOCS: &str = "https://docs.ollama.com/capabilities/thinking";
const MINIMAX_THINKING_DOCS: &str = "https://platform.minimax.io/docs/api-reference/text-chat-openai";

pub const EFFORT_REGISTRY_LAST_VERIFIED: &str = "2026-07-30";

fn option(id: &str, label: &str, selection: AiEffortSelection) -> AiEffortOption {
    AiEffortOption { id: id.to_string(), label: label.to_string(), description: None, selection }
}

fn enum_capability(values: &[&str], source: AiCapabilitySource) -> AiEffortCapability {
    let options = values
        .iter()
        .map(|value| option(value, &title_case_effort(value), AiEffortSelection::Enum((*value).to_string())))
        .collect::<Vec<_>>();
    let default = options.first().map(|option| option.selection.clone()).unwrap_or(AiEffortSelection::ProviderDefault);
    AiEffortCapability::Enum { options, default, source }
}

pub fn dynamic_enum_capability<I, S>(values: I, source: AiCapabilitySource) -> Option<AiEffortCapability>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = Vec::<String>::new();
    for value in values {
        let value = value.as_ref().trim();
        if value.is_empty() || seen.iter().any(|existing| existing == value) {
            continue;
        }
        seen.push(value.to_string());
    }
    (!seen.is_empty()).then(|| {
        let refs = seen.iter().map(String::as_str).collect::<Vec<_>>();
        enum_capability(&refs, source)
    })
}

fn integer_capability(min: i64, max: i64, allow_disabled: bool, source: AiCapabilitySource) -> AiEffortCapability {
    let mut special_values = vec![option("auto", "Auto", AiEffortSelection::Integer(-1))];
    if allow_disabled {
        special_values.push(option("off", "Off", AiEffortSelection::Disabled));
    }
    AiEffortCapability::Integer { min, max, step: 1, default: AiEffortSelection::Integer(-1), special_values, source }
}

fn boolean_capability(source: AiCapabilitySource) -> AiEffortCapability {
    AiEffortCapability::Boolean { default: AiEffortSelection::ProviderDefault, source }
}

fn normalized_model_id(model_id: &str) -> String {
    model_id.trim().trim_start_matches("models/").to_ascii_lowercase()
}

fn matches_family(model: &str, family: &str) -> bool {
    model == family
        || model
            .strip_prefix(family)
            .is_some_and(|suffix| suffix.starts_with('-') || suffix.starts_with(':') || suffix.starts_with('@'))
}

pub fn static_effort_capability(config: &AiConfig, model_id: &str) -> Option<AiEffortCapability> {
    let model = normalized_model_id(model_id);
    let source = AiCapabilitySource::OfficialRegistry;

    match config.provider {
        AiProvider::Openai => openai_capability(&model, source),
        AiProvider::Gemini => gemini_capability(&model, source),
        AiProvider::Deepseek => deepseek_capability(&model, source),
        AiProvider::Qwen => qwen_capability(&model, source),
        AiProvider::Ollama => ollama_capability(&model, source),
        AiProvider::MiniMax if matches_family(&model, "minimax-m3") => Some(boolean_capability(source)),
        AiProvider::MiniMax => None,
        AiProvider::AnthropicCompatible | AiProvider::OpenaiCompatible | AiProvider::Custom => {
            Some(AiEffortCapability::FreeText { placeholder: None, source: AiCapabilitySource::Custom })
        }
        AiProvider::Claude
        | AiProvider::CodexCli
        | AiProvider::ClaudeCodeCli
        | AiProvider::PiAgentCli
        | AiProvider::OpenCodeCli
        | AiProvider::CursorCli
        | AiProvider::GrokCli
        | AiProvider::CodeBuddyCli => None,
    }
}

fn openai_capability(model: &str, source: AiCapabilitySource) -> Option<AiEffortCapability> {
    if matches_family(model, "gpt-5-pro") {
        return Some(enum_capability(&["high"], source));
    }
    if matches_family(model, "gpt-5.6") {
        return Some(enum_capability(&["none", "low", "medium", "high", "xhigh", "max"], source));
    }
    if matches_family(model, "gpt-5.1") {
        return Some(enum_capability(&["none", "low", "medium", "high"], source));
    }
    if matches_family(model, "gpt-5") || matches_family(model, "gpt-5.2") || matches_family(model, "gpt-5.4") {
        return Some(enum_capability(&["minimal", "low", "medium", "high", "xhigh"], source));
    }
    if ["o1", "o3", "o3-mini", "o4-mini"].iter().any(|family| matches_family(model, family)) {
        return Some(enum_capability(&["low", "medium", "high"], source));
    }
    None
}

fn gemini_capability(model: &str, source: AiCapabilitySource) -> Option<AiEffortCapability> {
    if matches_family(model, "gemini-2.5-pro") {
        return Some(integer_capability(128, 32_768, false, source));
    }
    if matches_family(model, "gemini-2.5-flash-lite") {
        return Some(integer_capability(512, 24_576, true, source));
    }
    if matches_family(model, "gemini-2.5-flash")
        || matches_family(model, "robotics-er-1.6-preview")
        || model.starts_with("gemini-2.5-flash-live")
    {
        return Some(integer_capability(0, 24_576, true, source));
    }
    if model.starts_with("gemini-3.6-flash")
        || model.starts_with("gemini-3.5-flash")
        || model.starts_with("gemini-3-flash")
    {
        return Some(enum_capability(&["minimal", "low", "medium", "high"], source));
    }
    if model.starts_with("gemini-3.1-pro") {
        return Some(enum_capability(&["low", "medium", "high"], source));
    }
    if model.starts_with("gemini-3.1-flash-lite-image") {
        return Some(enum_capability(&["minimal", "high"], source));
    }
    if model.starts_with("gemini-3-pro") {
        return Some(enum_capability(&["low", "high"], source));
    }
    None
}

fn deepseek_capability(model: &str, source: AiCapabilitySource) -> Option<AiEffortCapability> {
    if matches_family(model, "deepseek-v4-flash") || matches_family(model, "deepseek-v4-pro") {
        let mut capability = enum_capability(&["high", "max"], source);
        if let AiEffortCapability::Enum { options, default, .. } = &mut capability {
            options.insert(0, option("off", "Off", AiEffortSelection::Disabled));
            *default = AiEffortSelection::Disabled;
        }
        return Some(capability);
    }
    None
}

fn qwen_capability(model: &str, source: AiCapabilitySource) -> Option<AiEffortCapability> {
    if matches_family(model, "qwen3.8-max-preview") {
        return Some(enum_capability(&["low", "medium", "xhigh"], source));
    }
    if model.starts_with("qwen3") || model.starts_with("qwq") {
        return Some(boolean_capability(source));
    }
    None
}

fn ollama_capability(model: &str, source: AiCapabilitySource) -> Option<AiEffortCapability> {
    if matches_family(model, "gpt-oss") {
        return Some(enum_capability(&["low", "medium", "high"], source));
    }
    if model.starts_with("deepseek-r1")
        || model.starts_with("qwen3")
        || model.starts_with("qwq")
        || model.starts_with("nemotron")
        || model.starts_with("glm-4.7")
    {
        return Some(boolean_capability(source));
    }
    None
}

pub fn registry_source_url(provider: &AiProvider) -> Option<&'static str> {
    match provider {
        AiProvider::Openai => Some(OPENAI_REASONING_DOCS),
        AiProvider::Gemini => Some(GEMINI_THINKING_DOCS),
        AiProvider::Deepseek => Some(DEEPSEEK_THINKING_DOCS),
        AiProvider::Qwen => Some(QWEN_THINKING_DOCS),
        AiProvider::Ollama => Some(OLLAMA_THINKING_DOCS),
        AiProvider::MiniMax => Some(MINIMAX_THINKING_DOCS),
        AiProvider::Claude
        | AiProvider::AnthropicCompatible
        | AiProvider::OpenaiCompatible
        | AiProvider::CodexCli
        | AiProvider::ClaudeCodeCli
        | AiProvider::PiAgentCli
        | AiProvider::OpenCodeCli
        | AiProvider::CursorCli
        | AiProvider::GrokCli
        | AiProvider::CodeBuddyCli
        | AiProvider::Custom => None,
    }
}

pub fn validate_runtime_effort(config: &AiConfig) -> Result<(), String> {
    let Some(selection) = config.runtime_effort.as_ref() else {
        return Ok(());
    };
    if matches!(selection, AiEffortSelection::ProviderDefault) {
        return Ok(());
    }

    if matches!(
        config.provider,
        AiProvider::Claude
            | AiProvider::CodexCli
            | AiProvider::ClaudeCodeCli
            | AiProvider::PiAgentCli
            | AiProvider::OpenCodeCli
            | AiProvider::CursorCli
            | AiProvider::GrokCli
            | AiProvider::CodeBuddyCli
    ) {
        return match selection {
            AiEffortSelection::Enum(value) if !value.trim().is_empty() => Ok(()),
            _ => Err("Invalid effort selection for dynamic provider".to_string()),
        };
    }

    let capability = static_effort_capability(config, &config.model).unwrap_or(AiEffortCapability::Unsupported);
    let valid = match capability {
        AiEffortCapability::Enum { options, .. } => options.iter().any(|option| option.selection == *selection),
        AiEffortCapability::Integer { min, max, step, special_values, .. } => {
            special_values.iter().any(|option| option.selection == *selection)
                || matches!(selection, AiEffortSelection::Integer(value) if *value >= min && *value <= max && (*value - min) % step == 0)
        }
        AiEffortCapability::Boolean { .. } => {
            matches!(selection, AiEffortSelection::Boolean(_) | AiEffortSelection::Disabled)
        }
        AiEffortCapability::FreeText { .. } => {
            matches!(selection, AiEffortSelection::Text(value) if valid_custom_effort(value))
        }
        AiEffortCapability::Unsupported => false,
    };

    valid.then_some(()).ok_or_else(|| format!("Invalid effort selection for model '{}'", config.model))
}

pub fn apply_runtime_effort(body: &mut Value, config: &AiConfig) {
    let Some(selection) = config.runtime_effort.as_ref() else {
        return;
    };
    if matches!(selection, AiEffortSelection::ProviderDefault) {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };

    match config.provider {
        AiProvider::Claude | AiProvider::AnthropicCompatible => apply_claude_effort(object, selection),
        AiProvider::Gemini => apply_gemini_effort(object, &config.model, selection),
        AiProvider::Deepseek => apply_deepseek_effort(object, selection),
        AiProvider::Qwen => apply_qwen_effort(object, selection),
        AiProvider::Ollama => apply_openai_effort(object, &config.api_style, selection),
        AiProvider::MiniMax => apply_minimax_effort(object, selection),
        AiProvider::Openai | AiProvider::OpenaiCompatible => apply_openai_effort(object, &config.api_style, selection),
        AiProvider::Custom => {
            if config.api_style == AiApiStyle::AnthropicMessages {
                apply_claude_effort(object, selection);
            } else {
                apply_openai_effort(object, &config.api_style, selection);
            }
        }
        AiProvider::CodexCli
        | AiProvider::ClaudeCodeCli
        | AiProvider::PiAgentCli
        | AiProvider::OpenCodeCli
        | AiProvider::CursorCli
        | AiProvider::GrokCli
        | AiProvider::CodeBuddyCli => {}
    }
}

fn apply_claude_effort(object: &mut Map<String, Value>, selection: &AiEffortSelection) {
    if let Some(value) = effort_string(selection) {
        object.insert("output_config".to_string(), json!({ "effort": value }));
    }
}

fn apply_openai_effort(object: &mut Map<String, Value>, api_style: &AiApiStyle, selection: &AiEffortSelection) {
    if let Some(value) = effort_string(selection) {
        if *api_style == AiApiStyle::Responses {
            object.insert("reasoning".to_string(), json!({ "effort": value }));
        } else {
            object.insert("reasoning_effort".to_string(), Value::String(value));
        }
    }
}

fn apply_minimax_effort(object: &mut Map<String, Value>, selection: &AiEffortSelection) {
    let thinking_type = match selection {
        AiEffortSelection::Disabled | AiEffortSelection::Boolean(false) => "disabled",
        AiEffortSelection::Boolean(true) => "adaptive",
        _ => return,
    };
    object.insert("thinking".to_string(), json!({ "type": thinking_type }));
}

fn apply_gemini_effort(object: &mut Map<String, Value>, model_id: &str, selection: &AiEffortSelection) {
    let generation_config = object.entry("generationConfig").or_insert_with(|| Value::Object(Map::new()));
    let Some(generation_config) = generation_config.as_object_mut() else {
        return;
    };
    let thinking_config = generation_config.entry("thinkingConfig").or_insert_with(|| Value::Object(Map::new()));
    let Some(thinking_config) = thinking_config.as_object_mut() else {
        return;
    };

    if normalized_model_id(model_id).starts_with("gemini-2.5")
        || normalized_model_id(model_id).starts_with("robotics-er")
    {
        let value = match selection {
            AiEffortSelection::Disabled => Some(0),
            AiEffortSelection::Integer(value) => Some(*value),
            _ => None,
        };
        if let Some(value) = value {
            thinking_config.insert("thinkingBudget".to_string(), Value::Number(value.into()));
        }
    } else if let Some(value) = effort_string(selection) {
        thinking_config.insert("thinkingLevel".to_string(), Value::String(value));
    }
}

fn apply_deepseek_effort(object: &mut Map<String, Value>, selection: &AiEffortSelection) {
    match selection {
        AiEffortSelection::Disabled | AiEffortSelection::Boolean(false) => {
            object.insert("thinking".to_string(), json!({ "type": "disabled" }));
        }
        AiEffortSelection::Boolean(true) => {
            object.insert("thinking".to_string(), json!({ "type": "enabled" }));
        }
        _ => {
            if let Some(value) = effort_string(selection) {
                object.insert("thinking".to_string(), json!({ "type": "enabled" }));
                object.insert("reasoning_effort".to_string(), Value::String(value));
            }
        }
    }
}

fn apply_qwen_effort(object: &mut Map<String, Value>, selection: &AiEffortSelection) {
    object.remove("reasoning_effort");
    object.remove("thinking_budget");
    object.remove("enable_thinking");
    match selection {
        AiEffortSelection::Disabled | AiEffortSelection::Boolean(false) => {
            object.insert("enable_thinking".to_string(), Value::Bool(false));
        }
        AiEffortSelection::Boolean(true) => {
            object.insert("enable_thinking".to_string(), Value::Bool(true));
        }
        AiEffortSelection::Integer(value) => {
            object.insert("thinking_budget".to_string(), Value::Number((*value).into()));
        }
        _ => {
            if let Some(value) = effort_string(selection) {
                object.insert("reasoning_effort".to_string(), Value::String(value));
            }
        }
    }
}

fn valid_custom_effort(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.chars().count() <= 64 && !value.chars().any(char::is_control)
}

fn effort_string(selection: &AiEffortSelection) -> Option<String> {
    match selection {
        AiEffortSelection::Enum(value) | AiEffortSelection::Text(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        AiEffortSelection::Disabled => Some("none".to_string()),
        AiEffortSelection::Boolean(value) => Some(if *value { "high" } else { "none" }.to_string()),
        AiEffortSelection::ProviderDefault | AiEffortSelection::Integer(_) => None,
    }
}

fn title_case_effort(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_runtime_effort, dynamic_enum_capability, registry_source_url, static_effort_capability,
        validate_runtime_effort, MINIMAX_THINKING_DOCS,
    };
    use crate::ai::{
        AiApiStyle, AiAuthMethod, AiCapabilitySource, AiConfig, AiEffortCapability, AiEffortSelection, AiProvider,
        AiReasoningLevel,
    };
    use serde_json::json;
    use std::collections::HashMap;

    fn config(provider: AiProvider, model: &str) -> AiConfig {
        AiConfig {
            provider,
            api_key: String::new(),
            auth_method: AiAuthMethod::ApiKey,
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
            codex_cli_env: HashMap::new(),
            claude_code_cli_path: None,
            claude_code_cli_env: HashMap::new(),
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
    fn dynamic_levels_preserve_unknown_values_and_order() {
        let capability = dynamic_enum_capability(["low", "ultra", "low", ""], AiCapabilitySource::LocalCli).unwrap();
        let AiEffortCapability::Enum { options, .. } = capability else {
            panic!("expected enum capability");
        };
        assert_eq!(options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>(), ["low", "ultra"]);
    }

    #[test]
    fn free_text_effort_uses_the_translated_frontend_placeholder() {
        for provider in [AiProvider::AnthropicCompatible, AiProvider::OpenaiCompatible, AiProvider::Custom] {
            let capability = static_effort_capability(&config(provider, "custom-model"), "custom-model").unwrap();
            let AiEffortCapability::FreeText { placeholder, .. } = capability else {
                panic!("expected free-text capability");
            };
            assert_eq!(placeholder, None);
        }
    }

    #[test]
    fn minimax_m3_uses_boolean_adaptive_thinking() {
        let mut config = config(AiProvider::MiniMax, "MiniMax-M3");
        let capability = static_effort_capability(&config, "MiniMax-M3").unwrap();
        let AiEffortCapability::Boolean { default, source } = capability else {
            panic!("expected boolean capability");
        };
        assert_eq!(default, AiEffortSelection::ProviderDefault);
        assert_eq!(source, AiCapabilitySource::OfficialRegistry);
        assert_eq!(registry_source_url(&AiProvider::MiniMax), Some(MINIMAX_THINKING_DOCS));
        assert!(static_effort_capability(&config, "MiniMax-M2.7").is_none());

        config.runtime_effort = Some(AiEffortSelection::Boolean(true));
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert!(body.get("reasoning_effort").is_none());

        config.runtime_effort = Some(AiEffortSelection::Disabled);
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn gemini_25_pro_uses_numeric_budget_without_off() {
        let capability =
            static_effort_capability(&config(AiProvider::Gemini, "gemini-2.5-pro"), "gemini-2.5-pro").unwrap();
        let AiEffortCapability::Integer { min, max, special_values, .. } = capability else {
            panic!("expected integer capability");
        };
        assert_eq!((min, max), (128, 32_768));
        assert_eq!(special_values.len(), 1);
        assert_eq!(special_values[0].id, "auto");
    }

    #[test]
    fn qwen_effort_fields_are_mutually_exclusive() {
        let mut config = config(AiProvider::Qwen, "qwen3.8-max-preview");
        config.runtime_effort = Some(AiEffortSelection::Enum("xhigh".to_string()));
        let mut body = json!({
            "reasoning_effort": "low",
            "thinking_budget": 1024,
            "enable_thinking": false
        });

        apply_runtime_effort(&mut body, &config);

        assert_eq!(body["reasoning_effort"], "xhigh");
        assert!(body.get("thinking_budget").is_none());
        assert!(body.get("enable_thinking").is_none());
    }

    #[test]
    fn gemini_25_never_sends_thinking_level() {
        let mut config = config(AiProvider::Gemini, "gemini-2.5-flash");
        config.runtime_effort = Some(AiEffortSelection::Integer(8192));
        let mut body = json!({ "generationConfig": {} });

        apply_runtime_effort(&mut body, &config);

        assert_eq!(body["generationConfig"]["thinkingConfig"]["thinkingBudget"], 8192);
        assert!(body["generationConfig"]["thinkingConfig"].get("thinkingLevel").is_none());
    }

    #[test]
    fn openai_responses_and_chat_use_different_fields() {
        let mut responses = config(AiProvider::Openai, "gpt-5.6");
        responses.api_style = AiApiStyle::Responses;
        responses.runtime_effort = Some(AiEffortSelection::Enum("high".to_string()));
        let mut responses_body = json!({});
        apply_runtime_effort(&mut responses_body, &responses);
        assert_eq!(responses_body["reasoning"]["effort"], "high");

        responses.api_style = AiApiStyle::Completions;
        let mut chat_body = json!({});
        apply_runtime_effort(&mut chat_body, &responses);
        assert_eq!(chat_body["reasoning_effort"], "high");
    }

    #[test]
    fn enum_capability_defaults_to_lowest_registered_level() {
        let capability = static_effort_capability(&config(AiProvider::Openai, "gpt-5.6"), "gpt-5.6").unwrap();
        let AiEffortCapability::Enum { default, .. } = capability else {
            panic!("expected enum capability");
        };
        assert_eq!(default, AiEffortSelection::Enum("none".to_string()));
    }

    #[test]
    fn deepseek_capability_defaults_to_off_and_maps_thinking_fields() {
        let mut config = config(AiProvider::Deepseek, "deepseek-v4-pro");
        let capability = static_effort_capability(&config, "deepseek-v4-pro").unwrap();
        let AiEffortCapability::Enum { options, default, .. } = capability else {
            panic!("expected enum capability");
        };
        assert_eq!(options[0].selection, AiEffortSelection::Disabled);
        assert_eq!(default, AiEffortSelection::Disabled);

        config.runtime_effort = Some(AiEffortSelection::Disabled);
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["thinking"]["type"], "disabled");

        config.runtime_effort = Some(AiEffortSelection::Enum("max".to_string()));
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "max");
    }

    #[test]
    fn qwen_boolean_effort_maps_to_enable_thinking() {
        let mut config = config(AiProvider::Qwen, "qwen3");
        config.runtime_effort = Some(AiEffortSelection::Boolean(true));
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["enable_thinking"], true);

        config.runtime_effort = Some(AiEffortSelection::Disabled);
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["enable_thinking"], false);
    }

    #[test]
    fn gemini_3_uses_thinking_level() {
        let mut config = config(AiProvider::Gemini, "models/gemini-3-flash");
        config.runtime_effort = Some(AiEffortSelection::Enum("medium".to_string()));
        let mut body = json!({ "generationConfig": {} });

        apply_runtime_effort(&mut body, &config);

        assert_eq!(body["generationConfig"]["thinkingConfig"]["thinkingLevel"], "medium");
        assert!(body["generationConfig"]["thinkingConfig"].get("thinkingBudget").is_none());
    }

    #[test]
    fn rejects_out_of_range_gemini_budget() {
        let mut config = config(AiProvider::Gemini, "gemini-2.5-pro");
        config.runtime_effort = Some(AiEffortSelection::Integer(64));
        assert!(validate_runtime_effort(&config).is_err());

        config.runtime_effort = Some(AiEffortSelection::Integer(-1));
        assert!(validate_runtime_effort(&config).is_ok());
    }

    #[test]
    fn accepts_arbitrary_dynamic_cli_effort() {
        let mut config = config(AiProvider::ClaudeCodeCli, "sonnet");
        config.runtime_effort = Some(AiEffortSelection::Enum("future-effort".to_string()));
        assert!(validate_runtime_effort(&config).is_ok());
    }

    #[test]
    fn ollama_openai_compatibility_uses_reasoning_effort() {
        let mut config = config(AiProvider::Ollama, "gpt-oss");
        config.runtime_effort = Some(AiEffortSelection::Enum("medium".to_string()));
        let mut body = json!({});

        apply_runtime_effort(&mut body, &config);

        assert_eq!(body["reasoning_effort"], "medium");
        assert!(body.get("think").is_none());
    }

    #[test]
    fn ollama_boolean_effort_maps_to_openai_compatible_values() {
        let mut config = config(AiProvider::Ollama, "qwen3");
        config.runtime_effort = Some(AiEffortSelection::Boolean(true));
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["reasoning_effort"], "high");

        config.runtime_effort = Some(AiEffortSelection::Disabled);
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["reasoning_effort"], "none");
    }

    #[test]
    fn unsupported_static_model_rejects_explicit_effort() {
        let mut config = config(AiProvider::Openai, "gpt-4o");
        config.runtime_effort = Some(AiEffortSelection::Enum("high".to_string()));
        assert!(validate_runtime_effort(&config).is_err());
    }

    #[test]
    fn provider_default_does_not_change_existing_request_fields() {
        let mut config = config(AiProvider::Openai, "gpt-5.6");
        config.runtime_effort = Some(AiEffortSelection::ProviderDefault);
        let mut body = json!({ "reasoning_effort": "existing" });

        apply_runtime_effort(&mut body, &config);

        assert_eq!(body["reasoning_effort"], "existing");
    }

    #[test]
    fn claude_effort_maps_to_output_config() {
        let mut config = config(AiProvider::Claude, "claude-opus-4-6");
        config.runtime_effort = Some(AiEffortSelection::Enum("high".to_string()));
        let mut body = json!({});

        apply_runtime_effort(&mut body, &config);

        assert_eq!(body["output_config"]["effort"], "high");
    }

    #[test]
    fn anthropic_compatible_accepts_only_free_text_effort() {
        let mut config = config(AiProvider::AnthropicCompatible, "gateway-model");
        config.runtime_effort = Some(AiEffortSelection::Enum("provider-high".to_string()));
        assert!(validate_runtime_effort(&config).is_err());

        config.runtime_effort = Some(AiEffortSelection::Text("custom-level".to_string()));
        assert!(validate_runtime_effort(&config).is_ok());
        let mut body = json!({});
        apply_runtime_effort(&mut body, &config);
        assert_eq!(body["output_config"]["effort"], "custom-level");
    }

    #[test]
    fn validates_custom_effort_text_bounds() {
        let mut config = config(AiProvider::Custom, "custom-model");
        config.runtime_effort = Some(AiEffortSelection::Text("provider-level".to_string()));
        assert!(validate_runtime_effort(&config).is_ok());

        config.runtime_effort = Some(AiEffortSelection::Text("x".repeat(65)));
        assert!(validate_runtime_effort(&config).is_err());

        config.runtime_effort = Some(AiEffortSelection::Text("invalid\nvalue".to_string()));
        assert!(validate_runtime_effort(&config).is_err());
    }
}
