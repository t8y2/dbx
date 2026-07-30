use crate::ai::{AiModelInfo, AiProvider};
use serde_json::Value;

// Provider model-family exclusions last checked against official catalogs on 2026-07-27.

fn normalized_model_id(model_id: &str) -> String {
    let model_id = model_id.trim().trim_start_matches("models/").to_ascii_lowercase();
    let model_id = model_id.rsplit('/').next().unwrap_or(&model_id);
    model_id.strip_prefix("ft:").and_then(|model| model.split(':').next()).unwrap_or(model_id).to_string()
}

fn is_openai_non_assistant_model(model: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "babbage-002",
        "chatgpt-image",
        "computer-use",
        "dall-e",
        "davinci-002",
        "gpt-image",
        "omni-moderation",
        "sora",
        "text-embedding",
        "text-moderation",
        "tts",
        "whisper",
    ];

    PREFIXES.iter().any(|prefix| model.starts_with(prefix))
        || model.contains("-audio")
        || model.contains("-realtime")
        || model.contains("-transcribe")
        || model.contains("-tts")
}

fn is_gemini_non_assistant_model(model: &str) -> bool {
    const PREFIXES: &[&str] = &["antigravity", "chirp", "imagen", "lyria", "nano-banana", "veo"];

    PREFIXES.iter().any(|prefix| model.starts_with(prefix))
        || model.contains("computer-use")
        || model.contains("deep-research")
        || model.contains("embedding")
        || model.contains("-image")
        || model.contains("gemini-omni")
        || model.contains("image-generation")
        || model.contains("-live")
        || model.contains("live-")
        || model.contains("native-audio")
        || model.contains("robotics")
        || model.contains("-tts")
}

fn is_qwen_non_assistant_model(model: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "ccai-",
        "cosyvoice",
        "flux-",
        "fun-asr",
        "paraformer",
        "qwen-image",
        "qwen-mt-",
        "qwen-tts",
        "qwen3-tts",
        "sambert",
        "sensevoice",
        "speech-",
        "stable-diffusion",
        "tongyi-tingwu",
        "wan",
        "wanx",
        "z-image",
    ];

    PREFIXES.iter().any(|prefix| model.starts_with(prefix))
        || model.contains("-asr")
        || model.contains("-captioner")
        || model.contains("embedding")
        || model.contains("livetranslate")
        || model.contains("moderation")
        || model.contains("-ocr")
        || model.contains("realtime")
        || model.contains("rerank")
        || model.contains("-s2s")
}

pub(crate) fn model_is_assistant_compatible(provider: &AiProvider, model_id: &str) -> bool {
    let model = normalized_model_id(model_id);
    match provider {
        AiProvider::Openai => !is_openai_non_assistant_model(&model),
        AiProvider::Gemini => !is_gemini_non_assistant_model(&model),
        AiProvider::Qwen => !is_qwen_non_assistant_model(&model),
        AiProvider::Claude
        | AiProvider::AnthropicCompatible
        | AiProvider::Deepseek
        | AiProvider::Ollama
        | AiProvider::OpenaiCompatible
        | AiProvider::CodexCli
        | AiProvider::ClaudeCodeCli
        | AiProvider::PiAgentCli
        | AiProvider::MiniMax
        | AiProvider::Custom => true,
    }
}

pub(crate) fn retain_known_assistant_models(provider: &AiProvider, models: &mut Vec<AiModelInfo>) {
    models.retain(|model| model_is_assistant_compatible(provider, &model.id));
}

pub(crate) fn gemini_item_is_assistant_compatible(item: &Value) -> bool {
    let Some(model_id) = item["name"].as_str().or_else(|| item["id"].as_str()) else {
        return false;
    };
    if !model_is_assistant_compatible(&AiProvider::Gemini, model_id) {
        return false;
    }

    let Some(methods) = item["supportedGenerationMethods"].as_array() else {
        return true;
    };
    if methods.is_empty() {
        return true;
    }

    methods.iter().filter_map(Value::as_str).any(|method| {
        method.eq_ignore_ascii_case("generateContent") || method.eq_ignore_ascii_case("streamGenerateContent")
    })
}

fn ollama_capability(data: &Value, expected: &str) -> Option<bool> {
    let capabilities = data["capabilities"].as_array()?;
    if capabilities.is_empty() {
        return None;
    }
    Some(capabilities.iter().filter_map(Value::as_str).any(|capability| capability == expected))
}

pub(crate) fn ollama_completion_capability(data: &Value) -> Option<bool> {
    ollama_capability(data, "completion")
}

pub(crate) fn ollama_tool_capability(data: &Value) -> Option<bool> {
    ollama_capability(data, "tools")
}

#[cfg(test)]
mod tests {
    use super::{
        gemini_item_is_assistant_compatible, model_is_assistant_compatible, ollama_completion_capability,
        ollama_tool_capability,
    };
    use crate::ai::AiProvider;

    #[test]
    fn openai_filter_keeps_assistant_models_and_hides_specialized_endpoints() {
        for model in ["gpt-4o", "gpt-5.6", "o4-mini", "ft:gpt-4o-mini:org:name:id"] {
            assert!(model_is_assistant_compatible(&AiProvider::Openai, model), "{model}");
        }
        for model in [
            "text-embedding-3-large",
            "gpt-image-1",
            "sora-2",
            "omni-moderation-latest",
            "gpt-4o-mini-transcribe",
            "gpt-4o-realtime-preview",
            "tts-1-hd",
        ] {
            assert!(!model_is_assistant_compatible(&AiProvider::Openai, model), "{model}");
        }
    }

    #[test]
    fn qwen_filter_keeps_multimodal_assistants_and_hides_non_chat_families() {
        for model in
            ["qwen-plus", "qwen3-max", "qwen-vl-max", "qwen-omni-turbo", "qwen3.5-omni-plus", "qwen3.5-omni-flash"]
        {
            assert!(model_is_assistant_compatible(&AiProvider::Qwen, model), "{model}");
        }
        for model in [
            "ccai-pro",
            "qwen-mt-plus",
            "qwen-vl-ocr-2025-11-20",
            "qwen3.5-livetranslate-flash",
            "qwen3.5-omni-plus-realtime",
            "qwen3-omni-30b-a3b-captioner",
            "qwen3-s2s-flash-realtime",
            "text-embedding-v4",
            "tongyi-tingwu-slp",
            "z-image-turbo",
            "qwen3-vl-embedding",
            "qwen3-reranker",
            "qwen3-asr-flash",
            "qwen-moderation-latest",
            "wan2.1-t2v-turbo",
            "qwen-image-plus",
            "cosyvoice-v3-flash",
        ] {
            assert!(!model_is_assistant_compatible(&AiProvider::Qwen, model), "{model}");
        }
    }

    #[test]
    fn generic_providers_do_not_filter_unknown_model_taxonomies() {
        for provider in
            [AiProvider::AnthropicCompatible, AiProvider::OpenaiCompatible, AiProvider::Custom, AiProvider::MiniMax]
        {
            for model in ["text-embedding-private-chat", "company/image-reasoner", "future-model"] {
                assert!(model_is_assistant_compatible(&provider, model), "{}:{model}", provider.as_str());
            }
        }
    }

    #[test]
    fn gemini_filter_uses_generation_methods_and_excludes_media_output_models() {
        assert!(gemini_item_is_assistant_compatible(&serde_json::json!({
            "name": "models/gemini-2.5-pro",
            "supportedGenerationMethods": ["generateContent", "countTokens"]
        })));
        assert!(gemini_item_is_assistant_compatible(&serde_json::json!({
            "name": "models/gemma-3-27b-it",
            "supportedGenerationMethods": ["generateContent"]
        })));
        assert!(!gemini_item_is_assistant_compatible(&serde_json::json!({
            "name": "models/gemini-embedding-001",
            "supportedGenerationMethods": ["embedContent"]
        })));
        assert!(!gemini_item_is_assistant_compatible(&serde_json::json!({
            "name": "models/gemini-3-pro-image-preview",
            "supportedGenerationMethods": ["generateContent"]
        })));
        for model in [
            "models/antigravity-preview-05-2026",
            "models/deep-research-preview-04-2026",
            "models/gemini-2.5-computer-use-preview-10-2025",
            "models/gemini-omni-flash-preview",
            "models/gemini-robotics-er-1.6-preview",
            "models/nano-banana-pro-preview",
        ] {
            assert!(
                !gemini_item_is_assistant_compatible(&serde_json::json!({
                    "name": model,
                    "supportedGenerationMethods": ["generateContent"]
                })),
                "{model}"
            );
        }
        assert!(gemini_item_is_assistant_compatible(&serde_json::json!({
            "name": "models/future-chat-model"
        })));
    }

    #[test]
    fn ollama_capabilities_only_exclude_explicit_non_completion_models() {
        assert_eq!(
            ollama_completion_capability(&serde_json::json!({ "capabilities": ["completion", "vision"] })),
            Some(true)
        );
        assert_eq!(ollama_completion_capability(&serde_json::json!({ "capabilities": ["embedding"] })), Some(false));
        assert_eq!(ollama_completion_capability(&serde_json::json!({ "capabilities": [] })), None);
        assert_eq!(ollama_completion_capability(&serde_json::json!({})), None);
    }

    #[test]
    fn ollama_tool_capability_uses_explicit_model_metadata() {
        assert_eq!(
            ollama_tool_capability(&serde_json::json!({ "capabilities": ["completion", "tools", "thinking"] })),
            Some(true)
        );
        assert_eq!(
            ollama_tool_capability(&serde_json::json!({ "capabilities": ["completion", "thinking"] })),
            Some(false)
        );
        assert_eq!(ollama_tool_capability(&serde_json::json!({ "capabilities": [] })), None);
        assert_eq!(ollama_tool_capability(&serde_json::json!({})), None);
    }
}
