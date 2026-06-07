use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const MCP_PACKAGE_NAME: &str = "@dbx-app/mcp-server";
const MCP_LATEST_URL: &str = "https://registry.npmjs.org/@dbx-app%2fmcp-server/latest";
const MCP_INSTALL_COMMAND: &str = "npm install -g @dbx-app/mcp-server@latest --registry=https://registry.npmjs.org";

#[derive(Debug, Serialize)]
pub struct McpServerStatus {
    pub installed: bool,
    pub npm_available: bool,
    pub node_version: Option<String>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub bin_path: Option<String>,
    pub install_command: String,
    pub update_command: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NpmLatestPackage {
    version: String,
}

#[tauri::command]
pub async fn check_mcp_server_status() -> Result<McpServerStatus, String> {
    let npm_available = command_success("npm", &["--version"]);
    let node_version = command_stdout("node", &["--version"]).ok().and_then(first_non_empty_line);
    let current_version = if npm_available { installed_mcp_version() } else { None };
    let bin_path = locate_mcp_bin();
    let latest_version = fetch_latest_mcp_version().await.ok();
    let update_available = current_version
        .as_deref()
        .zip(latest_version.as_deref())
        .is_some_and(|(current, latest)| dbx_core::update::is_newer_version(latest, current));
    let error = if npm_available { None } else { Some("npm is not available in PATH.".to_string()) };

    Ok(McpServerStatus {
        installed: current_version.is_some() || bin_path.is_some(),
        npm_available,
        node_version,
        current_version,
        latest_version,
        update_available,
        bin_path,
        install_command: MCP_INSTALL_COMMAND.to_string(),
        update_command: MCP_INSTALL_COMMAND.to_string(),
        error,
    })
}

async fn fetch_latest_mcp_version() -> Result<String, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(10)).user_agent("dbx-mcp-status-checker");
    if let Some(proxy_url) = dbx_core::update::system_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Invalid system proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let package = client
        .get(MCP_LATEST_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to check MCP Server updates: {e}"))?
        .json::<NpmLatestPackage>()
        .await
        .map_err(|e| format!("Failed to parse MCP Server update response: {e}"))?;
    Ok(package.version)
}

fn installed_mcp_version() -> Option<String> {
    let stdout = command_stdout("npm", &["list", "-g", MCP_PACKAGE_NAME, "--json", "--depth=0"]).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&stdout).ok()?;
    value
        .get("dependencies")
        .and_then(|dependencies| dependencies.get(MCP_PACKAGE_NAME))
        .and_then(|package| package.get("version"))
        .and_then(|version| version.as_str())
        .map(ToOwned::to_owned)
}

fn locate_mcp_bin() -> Option<String> {
    let (command, args): (&str, &[&str]) =
        if cfg!(windows) { ("where", &["dbx-mcp-server"]) } else { ("which", &["dbx-mcp-server"]) };
    command_stdout(command, args).ok().and_then(first_non_empty_line)
}

fn command_success(command: &str, args: &[&str]) -> bool {
    Command::new(command).args(args).output().is_ok_and(|output| output.status.success())
}

fn command_stdout(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command).args(args).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn first_non_empty_line(value: String) -> Option<String> {
    value.lines().map(str::trim).find(|line| !line.is_empty()).map(ToOwned::to_owned)
}
