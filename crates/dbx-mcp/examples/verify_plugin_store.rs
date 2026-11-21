//! Verifies a real DBX app store: plugin discovery + MCP tool bridge.
//!   cargo run -p dbx-mcp --example verify_plugin_store -- <data-dir> [app-version]
use dbx_mcp::LocalBackend;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let data_dir = std::path::PathBuf::from(&args[0]);
    let app_version = args.get(1).map(String::as_str).unwrap_or("0.5.96");
    let backend =
        LocalBackend::open_with_app_version(&data_dir.join("dbx.db"), app_version).await.expect("open local backend");

    let installed = backend.state().plugins.list_installed().unwrap();
    for plugin in &installed {
        println!(
            "plugin: {} v{} compatible={} errors={:?}",
            plugin.manifest.id, plugin.manifest.version, plugin.compatibility.compatible, plugin.compatibility.errors
        );
    }

    let providers = backend.list_plugin_tools().await.expect("list plugin tools");
    for provider in &providers {
        let tools = provider["tools"].as_array().map(|tools| tools.len()).unwrap_or(0);
        println!("mcp tools: {} -> {} tools", provider["pluginId"], tools);
        let call = backend
            .call_plugin_tool(
                provider["pluginId"].as_str().unwrap(),
                "ssh_list_known_hosts",
                None,
                &serde_json::json!({}),
            )
            .await;
        match call {
            Ok(result) => println!("tool call ok: isError={}", result["isError"].as_bool().unwrap_or(true)),
            Err(error) => println!("tool call failed: {error}"),
        }
    }
}
