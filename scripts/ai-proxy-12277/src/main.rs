use dbx_ai_provider::ai::{build_ai_http_client, AiConfig};

mod registry;

async fn core_call(config: AiConfig, mode: &str) -> serde_json::Value {
    use dbx_ai_provider::ai::{complete, list_models_core, stream, test_connection_core, AiCompletionRequest};
    let request: AiCompletionRequest = serde_json::from_value(serde_json::json!({
        "config": config, "systemPrompt": "", "messages": [{"role":"user","content":"hello"}],
        "maxTokens": 16
    }))
    .unwrap();
    let result = match mode {
        "core-models" => list_models_core(&config).await.map(|models| serde_json::json!(models)),
        "core-test" => test_connection_core(&config).await.map(|result| serde_json::json!(result)),
        "core-complete" => complete(&request).await.map(|text| serde_json::json!({"text":text})),
        "core-stream" => {
            let chunks = std::sync::Mutex::new(Vec::new());
            let cancelled = tokio::sync::Notify::new();
            stream("issue-12277-proof", &request, &cancelled, |chunk| chunks.lock().unwrap().push(chunk))
                .await
                .map(|_| serde_json::json!({"chunks":chunks.into_inner().unwrap()}))
        }
        _ => unreachable!(),
    };
    match result {
        Ok(value) => serde_json::json!({"ok":true,"result":value}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sandbox = registry::RegistrySandbox::from_env()?;
    let args: Vec<String> = std::env::args().collect();
    let endpoint = &args[1];
    let mode = &args[2];
    let config: AiConfig = serde_json::from_value(serde_json::json!({
        "provider": "openai-compatible",
        "endpoint": endpoint,
        "proxyEnabled": mode == "explicit" || std::env::var("DBX_PROOF_EXPLICIT").as_deref() == Ok("1"),
        "proxyUrl": args.get(3).map(String::as_str).unwrap_or(""),
        "model": "local-repro", "maxRetries": 0, "enableThinking": false
    }))?;
    if mode.starts_with("core-") {
        let result = core_call(config, mode).await;
        drop(sandbox);
        println!("{result}");
        return Ok(());
    }
    let client = if mode == "direct-control" {
        reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(8)).build()?
    } else if mode == "proxy-control" {
        reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(&args[3])?)
            .timeout(std::time::Duration::from_secs(8))
            .build()?
    } else {
        build_ai_http_client(&config, 8)?
    };
    let response = if mode == "stream" {
        client
            .post(format!("{endpoint}/chat/completions"))
            .json(&serde_json::json!({"model":"local-repro","stream":true,"messages":[]}))
            .send()
            .await?
    } else {
        client.get(format!("{endpoint}/models")).send().await?
    };
    let status = response.status().as_u16();
    let peer = response.remote_addr().map(|addr| addr.to_string());
    let body = response.text().await?;
    drop(sandbox);
    let url = reqwest::Url::parse(endpoint)?;
    println!("{}", serde_json::json!({"status":status,"peer":peer,"body":body,"url_host":url.host_str()}));
    Ok(())
}
