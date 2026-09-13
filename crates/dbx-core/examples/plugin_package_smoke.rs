use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use dbx_core::models::connection::ConnectionConfig;
use dbx_core::plugins::{PluginHost, PluginInstallPolicy, PluginPackageInstaller, PluginRegistry, PluginTrustStore};
use serde_json::{json, Value};

const PLUGIN_ID: &str = "dbx.example.hello";
const APP_VERSION: &str = "0.5.68";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("plugin package smoke failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let package = std::env::args().nth(1).map(PathBuf::from).ok_or("Usage: plugin_package_smoke <package.dbxp>")?;
    let store = tempfile::tempdir().map_err(|error| error.to_string())?;
    let trusted_keys = std::env::var("DBX_PLUGIN_SMOKE_TRUSTED_KEYS_JSON")
        .ok()
        .map(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).map_err(|error| error.to_string()))
        .transpose()?;
    let (installer, policy) = match trusted_keys {
        Some(keys) => (
            PluginPackageInstaller::with_trust_store(
                store.path().to_path_buf(),
                APP_VERSION.to_string(),
                PluginTrustStore::from_base64_keys(keys)?,
            ),
            PluginInstallPolicy::LocalSigned,
        ),
        None => (
            PluginPackageInstaller::new(store.path().to_path_buf(), APP_VERSION.to_string())?,
            PluginInstallPolicy::LocalDevelopment,
        ),
    };
    let installed = installer.install_file(&package, policy)?;
    if installed.plugin.manifest.id != PLUGIN_ID {
        return Err(format!("Expected plugin '{PLUGIN_ID}', got '{}'", installed.plugin.manifest.id));
    }

    let registry = PluginRegistry::new_with_app_version(store.path().to_path_buf(), APP_VERSION);
    let plugin_icon = installed.plugin.manifest.icon.as_deref().ok_or("Example plugin does not declare an icon")?;
    let provider_icon = installed
        .plugin
        .manifest
        .connection_provider("dbx.example.hello.connection")?
        .and_then(|provider| provider.icon)
        .ok_or("Example connection provider does not declare an icon")?;
    for icon in [plugin_icon, provider_icon.as_str()] {
        let asset = registry.read_asset(PLUGIN_ID, icon)?;
        if !asset.content_type.starts_with("image/") || asset.bytes.is_empty() {
            return Err(format!("Invalid packaged plugin icon '{icon}'"));
        }
    }
    let host = PluginHost::new(registry);
    let mut events = host.subscribe_events();
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "hello-smoke-connection",
        "name": "Hello smoke connection",
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

    let test = host.test_connection(&config, "localhost", 22).await?;
    if !test.message.contains("localhost:22") {
        return Err(format!("Unexpected connection-test result: {}", test.message));
    }

    let action = host.invoke_connection_action(&config, "suggest-greeting", "localhost", 22).await?;
    if action.message.as_deref() != Some("Greeting updated by the plugin action.")
        || action.field_values.get("greeting").and_then(Value::as_str) != Some("Hello from plugin action")
    {
        return Err(format!("Unexpected connection-action result: {action:?}"));
    }

    let handle = host.connect_connection(&config, "localhost", 22).await?;
    if !handle.is_running() {
        return Err("Plugin connection handle is not running".to_string());
    }
    let greeting: Value = host
        .invoke(
            PLUGIN_ID,
            "hello/greet",
            json!({ "connectionId": config.id, "name": "Smoke" }),
            None,
            Some(Duration::from_secs(5)),
        )
        .await?;
    if greeting.get("message").and_then(Value::as_str) != Some("Hello, Smoke, from Hello smoke connection!") {
        return Err(format!("Unexpected greeting: {greeting}"));
    }
    let files = host
        .list_filesystem_entries(
            PLUGIN_ID,
            "dbx.example.hello.files",
            Some(&config.id),
            Some("hello:/"),
            None,
            Some(20),
        )
        .await?;
    if !files.entries.iter().any(|entry| entry.name == "README.txt") {
        return Err(format!("Unexpected filesystem listing: {files:?}"));
    }
    let preview = host
        .read_filesystem_file(PLUGIN_ID, "dbx.example.hello.files", Some(&config.id), "hello:/README.txt", Some(1024))
        .await?;
    if preview.truncated || preview.data_base64.is_empty() {
        return Err(format!("Unexpected filesystem preview: {preview:?}"));
    }

    let mut saw_connected = false;
    let mut saw_finished = false;
    for _ in 0..4 {
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .map_err(|_| "Timed out waiting for plugin events".to_string())?
            .map_err(|error| error.to_string())?;
        if event.method == "hello/connectionChanged"
            && event.params.get("state").and_then(Value::as_str) == Some("connected")
        {
            saw_connected = true;
        }
        if event.method == "hello/progress" && event.params.get("stage").and_then(Value::as_str) == Some("finished") {
            saw_finished = true;
        }
        if saw_connected && saw_finished {
            break;
        }
    }
    if !saw_connected || !saw_finished {
        return Err(format!("Missing expected events: connected={saw_connected}, finished={saw_finished}"));
    }

    handle.disconnect().await?;
    host.stop_all().await;
    installer.uninstall(PLUGIN_ID)?;
    if !PluginRegistry::new_with_app_version(store.path().to_path_buf(), APP_VERSION).list_installed()?.is_empty() {
        return Err("Plugin store is not empty after uninstall".to_string());
    }

    println!("plugin package smoke passed: install -> assets -> action -> test -> connect -> invoke -> filesystem -> events -> disconnect -> uninstall");
    Ok(())
}
