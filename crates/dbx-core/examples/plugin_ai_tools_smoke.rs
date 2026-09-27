//! End-to-end check of plugin MCP tools in the built-in AI agent, run against
//! the packaged example plugin: install it, open a plugin connection, opt the
//! plugin in, discover its tools through the real sidecar, and call them the
//! way an agent run does.

use std::path::PathBuf;
use std::sync::Arc;

use dbx_core::agent_events::ToolCall;
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::plugin_tools::{self, PluginToolSet};
use dbx_core::plugins::{PluginInstallPolicy, PluginPackageInstaller};
use dbx_core::storage::Storage;
use serde_json::{json, Value};

const PLUGIN_ID: &str = "dbx.example.hello";
const APP_VERSION: &str = "0.5.68";
const CONNECTION_ID: &str = "hello-ai-connection";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("plugin AI tools smoke failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let package = std::env::args().nth(1).map(PathBuf::from).ok_or("Usage: plugin_ai_tools_smoke <package.dbxp>")?;
    let root = tempfile::tempdir().map_err(|error| error.to_string())?;
    let plugin_dir = root.path().join("plugins");
    PluginPackageInstaller::new(plugin_dir.clone(), APP_VERSION.to_string())?
        .install_file(&package, PluginInstallPolicy::LocalDevelopment)?;
    let storage = Storage::open(&root.path().join("dbx.db")).await?;
    let state = Arc::new(AppState::new_with_plugin_dir_and_app_version(storage, plugin_dir, APP_VERSION));
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": CONNECTION_ID,
        "name": "Hello AI connection",
        "db_type": "plugin",
        "driver_profile": "plugin",
        "host": "localhost",
        "port": 22,
        "username": "",
        "password": "",
        "database": null,
        "external_config": { "greeting": "Hello" },
        "plugin_id": PLUGIN_ID,
        "plugin_connection_provider": "dbx.example.hello.connection",
        "plugin_connection_type": "hello",
        "connection_secrets": { "api_token": "smoke-secret" }
    }))
    .map_err(|error| error.to_string())?;
    state.configs.write().await.insert(CONNECTION_ID.to_string(), config);

    // Nothing reaches the model before the user opts the plugin in, and
    // nothing for a connection that is not open.
    if !plugin_tools::discover_plugin_tools(&state, None).await.is_empty() {
        return Err("tools were exposed before the plugin was enabled for the AI".to_string());
    }
    state.storage.set_ai_plugin_tool_plugin_enabled(PLUGIN_ID, true).await?;
    if !plugin_tools::discover_plugin_tools(&state, None).await.is_empty() {
        return Err("tools were exposed without an open plugin connection".to_string());
    }

    state.get_or_create_pool(CONNECTION_ID, None).await?;
    let tools = plugin_tools::discover_plugin_tools(&state, None).await;
    let definitions = tools.definitions();
    let names = definitions.iter().map(|definition| definition.name.as_ref()).collect::<Vec<_>>();
    if names != ["hello__hello_greet", "hello__hello_set_greeting"] {
        return Err(format!("unexpected tool names: {names:?}"));
    }
    let read_only = definitions.iter().map(|definition| definition.read_only).collect::<Vec<_>>();
    if read_only != [true, false] {
        return Err(format!("readOnlyHint was not honored: {read_only:?}"));
    }
    if definitions.iter().any(|definition| definition.parameters.pointer("/properties/connectionId").is_some()) {
        return Err("the host-bound connectionId leaked into a model-facing schema".to_string());
    }

    expect_tool_text(
        &state,
        &tools,
        "hello__hello_greet",
        json!({ "name": "Agent" }),
        "Hello, Agent, from Hello AI connection!",
    )
    .await?;
    // A real run pauses here for the user's approval; this call stands in for
    // an approved one.
    expect_tool_text(
        &state,
        &tools,
        "hello__hello_set_greeting",
        json!({ "greeting": "Hi" }),
        "Hello AI connection now greets with \"Hi\".",
    )
    .await?;
    expect_tool_text(
        &state,
        &tools,
        "hello__hello_greet",
        json!({ "name": "Agent" }),
        "Hi, Agent, from Hello AI connection!",
    )
    .await?;

    let preview = plugin_tools::preview_plugin_tools(&state, None, PLUGIN_ID).await?;
    let preview_names = preview.tools.iter().map(|tool| (tool.name.as_str(), tool.read_only)).collect::<Vec<_>>();
    if preview_names != [("hello_greet", true), ("hello_set_greeting", false)]
        || preview.open_connections.iter().map(|connection| connection.id.as_str()).collect::<Vec<_>>()
            != [CONNECTION_ID]
    {
        return Err(format!("unexpected preview: {preview:?}"));
    }

    let call = ToolCall {
        id: "revoked-call".to_string(),
        name: "hello__hello_set_greeting".to_string(),
        arguments: json!({ "greeting": "Must not run" }),
        provider_payload: None,
    };
    let prepared = tools.prepare_call(&call).ok_or("missing write tool")??;
    state.storage.set_ai_plugin_tool_plugin_enabled(PLUGIN_ID, false).await?;
    let revoked = plugin_tools::execute_plugin_tool(&state, None, &call, &prepared).await;
    if !revoked.is_error || !revoked.content.contains("has been disabled") {
        return Err(format!("revoked AI access was not enforced: {revoked:?}"));
    }
    state.storage.set_ai_plugin_tool_plugin_enabled(PLUGIN_ID, true).await?;
    expect_tool_text(
        &state,
        &tools,
        "hello__hello_greet",
        json!({ "name": "Agent" }),
        "Hi, Agent, from Hello AI connection!",
    )
    .await?;
    state.remove_connection_pools(CONNECTION_ID).await;
    let closed = plugin_tools::execute_plugin_tool(&state, None, &call, &prepared).await;
    if !closed.is_error || !closed.content.contains("no longer open") {
        return Err(format!("closed plugin connection was not rejected: {closed:?}"));
    }

    println!("plugin AI tools smoke passed: {names:?}");
    Ok(())
}

async fn expect_tool_text(
    state: &Arc<AppState>,
    tools: &PluginToolSet,
    name: &str,
    arguments: Value,
    expected: &str,
) -> Result<(), String> {
    let call = ToolCall { id: format!("call-{name}"), name: name.to_string(), arguments, provider_payload: None };
    let prepared = tools.prepare_call(&call).ok_or_else(|| format!("{name} is not a plugin tool"))??;
    if prepared.connection_id != CONNECTION_ID || prepared.arguments.get("connectionId") != Some(&json!(CONNECTION_ID))
    {
        return Err(format!("{name} was not bound to the open connection: {prepared:?}"));
    }
    let result = plugin_tools::execute_plugin_tool(state, None, &call, &prepared).await;
    if result.is_error || result.content != expected {
        return Err(format!("{name} returned {:?} (error: {})", result.content, result.is_error));
    }
    Ok(())
}
