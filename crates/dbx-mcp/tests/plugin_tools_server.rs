//! End-to-end external plugin-tools test against a real `.dbxp` package:
//! install → opt-in-filtered discovery → merged `tools/list` → server
//! dispatch of a connection-less tool through the real sidecar. The packaged
//! plugin must declare `external_tools: true` to be exposed here.
//!
//! The mechanism under test is plugin-agnostic; the ssh plugin is only the
//! concrete vehicle available here (mirroring `plugin_tools_bridge.rs`).
//! Set DBX_SSH_PACKAGE to a packaged `io.dbx.ssh` artifact; the test skips
//! itself otherwise.

use dbx_core::plugins::{PluginInstallPolicy, PluginPackageInstaller};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};

#[tokio::test]
async fn ssh_package_tools_are_detected_listed_and_dispatched() {
    let Ok(package) = std::env::var("DBX_SSH_PACKAGE") else {
        eprintln!("skipping: DBX_SSH_PACKAGE is not set");
        return;
    };
    let package = std::path::PathBuf::from(package);
    assert!(package.is_file(), "package missing: {}", package.display());

    let data_dir = tempfile::tempdir().unwrap();
    let plugins_root = data_dir.path().join("plugins");
    let installer = PluginPackageInstaller::new(plugins_root.clone(), "0.7.0").expect("installer");
    let result = installer.install_file(&package, PluginInstallPolicy::LocalDevelopment).expect("install .dbxp");
    assert_eq!(result.response().plugin.manifest.id, "io.dbx.ssh");

    let database_path = data_dir.path().join("dbx.db");
    let storage = dbx_core::storage::Storage::open(&database_path).await.unwrap();
    drop(storage);
    // No saved connections: every tool below must bind connection-less.
    let backend = LocalBackend::open_with_app_version(&database_path, "0.7.0").await.unwrap();

    // 1. Opt-in-filtered discovery over the real sidecar.
    let providers = backend.detect_plugin_tool_providers().await.expect("detect plugin tools");
    let ssh = providers.iter().find(|provider| provider.plugin_id == "io.dbx.ssh").expect("ssh detected");
    assert!(
        ssh.tools.iter().any(|tool| tool.name == "ssh_list_known_hosts"),
        "expected ssh_list_known_hosts in {:?}",
        ssh.tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>()
    );

    // 2. The server merges the detected tools into tools/list under the
    //    shared dbx_<prefix>__<tool> namespace.
    let backend = std::sync::Arc::new(backend);
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let tools = server.policy_filtered_tools().await;
    let exposed = "dbx_ssh__ssh_list_known_hosts";
    let tool = tools.iter().find(|tool| tool.name.as_ref() == exposed).expect("plugin tool merged into tools/list");
    assert!(
        tool.input_schema
            .get("properties")
            .map(|properties| properties.get("dbx_connection"))
            .unwrap_or(None)
            .is_none(),
        "no saved connections, so no connection selector is advertised"
    );

    // 3. Dispatch a real call through the host-bound path.
    let result = server.call_plugin_tool_dispatch(exposed, serde_json::json!({})).await.expect("dispatch ok");
    assert_ne!(result.is_error, Some(true), "tool failed: {result:?}");
    let text = result.content[0].as_text().expect("text result").text.as_str();
    let parsed: serde_json::Value = serde_json::from_str(text).expect("result JSON");
    assert!(parsed["knownHosts"].is_array(), "unexpected result: {parsed}");
}
