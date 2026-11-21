//! Full installation-pipeline test: installs the real ssh-sftp `.dbxp`
//! package through PluginPackageInstaller, then verifies the MCP bridge can
//! discover the plugin, start its sidecar, and call a tool.
//!
//! Set DBX_SSH_SFTP_PACKAGE to the packaged artifact; the test skips itself
//! otherwise.

use dbx_core::plugins::{PluginInstallPolicy, PluginPackageInstaller, PluginSignatureStatus};
use dbx_mcp::LocalBackend;

#[tokio::test]
async fn ssh_sftp_package_installs_and_serves_mcp_tools() {
    let Ok(package) = std::env::var("DBX_SSH_SFTP_PACKAGE") else {
        eprintln!("skipping: DBX_SSH_SFTP_PACKAGE is not set");
        return;
    };
    let package = std::path::PathBuf::from(package);
    assert!(package.is_file(), "package missing: {}", package.display());

    let data_dir = tempfile::tempdir().unwrap();
    let plugins_root = data_dir.path().join("plugins");

    // 1. Install the .dbxp exactly like the DBX desktop app would.
    let installer = PluginPackageInstaller::new(plugins_root.clone(), "0.6.0").expect("installer");
    let result = installer.install_file(&package, PluginInstallPolicy::LocalDevelopment).expect("install .dbxp");
    let response = result.response();
    assert_eq!(response.plugin.manifest.id, "io.dbx.ssh-sftp");
    assert!(!response.plugin.manifest.version.is_empty());
    assert_eq!(response.signature, PluginSignatureStatus::Unsigned);

    // 2. The installed layout is discoverable as a connection provider.
    let database_path = data_dir.path().join("dbx.db");
    let storage = dbx_core::storage::Storage::open(&database_path).await.unwrap();
    drop(storage);
    let backend = LocalBackend::open_with_app_version(&database_path, "0.6.0").await.unwrap();
    let installed = backend.state().plugins.list_installed().unwrap();
    let plugin =
        installed.iter().find(|plugin| plugin.manifest.id == "io.dbx.ssh-sftp").expect("installed plugin listed");
    assert!(plugin.compatibility.compatible, "plugin incompatible: {:?}", plugin.compatibility.errors);

    // 3. MCP bridge: tool discovery over the real sidecar process.
    let providers = backend.list_plugin_tools().await.expect("list plugin tools");
    let ssh = providers
        .iter()
        .find(|provider| provider["pluginId"] == "io.dbx.ssh-sftp")
        .expect("plugin contributes MCP tools");
    let names = ssh["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    for expected in ["ssh_exec", "ssh_exec_sudo", "ssh_metrics", "sftp_list_dir", "sftp_chmod"] {
        assert!(names.contains(&expected), "missing {expected} in {names:?}");
    }

    // 4. MCP bridge: a real tool call through the installed sidecar.
    let listed = backend
        .call_plugin_tool("io.dbx.ssh-sftp", "ssh_list_known_hosts", None, &serde_json::json!({}))
        .await
        .expect("call plugin tool");
    assert!(!listed["isError"].as_bool().unwrap_or(true), "tool failed: {listed}");
    let text = listed["content"][0]["text"].as_str().expect("result text");
    let parsed: serde_json::Value = serde_json::from_str(text).expect("result JSON");
    assert!(parsed["knownHosts"].is_array());
}
