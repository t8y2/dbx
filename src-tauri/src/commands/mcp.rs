#[cfg(not(windows))]
use std::env;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const MCP_PACKAGE_NAME: &str = "@dbx-app/mcp-server";
const MCP_LATEST_URL: &str = "https://registry.npmjs.org/@dbx-app%2fmcp-server/latest";
const MCP_INSTALL_COMMAND: &str = "npm install -g @dbx-app/mcp-server@latest --registry=https://registry.npmjs.org";
const SHELL_COMMAND_MARKER: &str = "__DBX_MCP_COMMAND_OUTPUT_START__";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    let local_status = tauri::async_runtime::spawn_blocking(|| {
        let npm_available = command_success("npm", &["--version"]);
        let node_version = command_stdout("node", &["--version"]).ok().and_then(first_non_empty_line);
        let current_version = if npm_available { installed_mcp_version() } else { None };
        let bin_path = locate_mcp_bin();
        (npm_available, node_version, current_version, bin_path)
    });
    let latest_version = fetch_latest_mcp_version();
    let (local_status, latest_version) = tokio::join!(local_status, latest_version);
    let (npm_available, node_version, current_version, bin_path) = local_status.map_err(|err| err.to_string())?;
    let latest_version = latest_version.ok();
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

#[tauri::command]
pub async fn install_mcp_server() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = command_output(
            "npm",
            &["install", "-g", "@dbx-app/mcp-server@latest", "--registry=https://registry.npmjs.org"],
        )?;

        if !output.success {
            let error_msg = if !output.stderr.is_empty() { output.stderr } else { output.stdout };
            return Err(format!("Installation failed: {}", error_msg));
        }

        let version = installed_mcp_version().unwrap_or_else(|| "unknown".to_string());
        Ok(format!("Successfully installed @dbx-app/mcp-server@{}", version))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn fetch_latest_mcp_version() -> Result<String, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(10)).user_agent("dbx-mcp-status-checker");
    let proxy_url =
        tauri::async_runtime::spawn_blocking(dbx_core::update::system_proxy_url).await.map_err(|e| e.to_string())?;
    if let Some(proxy_url) = proxy_url {
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
    let root = command_stdout("npm", &["root", "-g"]).ok()?;
    let pkg_json_path = Path::new(root.trim()).join(MCP_PACKAGE_NAME).join("package.json");
    let content = std::fs::read_to_string(pkg_json_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value.get("version")?.as_str().map(ToOwned::to_owned)
}

pub(crate) fn resolve_mcp_server_command() -> Option<(String, Vec<String>)> {
    locate_mcp_bin()
        .map(|path| (path, Vec::new()))
        .or_else(|| installed_mcp_bin_script().map(|script| ("node".to_string(), vec![script])))
}

pub(crate) fn locate_command(command: &str) -> Option<String> {
    #[cfg(windows)]
    {
        return locate_windows_command(command);
    }
    #[cfg(not(windows))]
    {
        command_stdout("which", &[command]).ok().and_then(first_non_empty_line)
    }
}

fn locate_mcp_bin() -> Option<String> {
    locate_command("dbx-mcp-server")
}

fn installed_mcp_bin_script() -> Option<String> {
    let root = command_stdout("npm", &["root", "-g"]).ok()?;
    let script = Path::new(root.trim()).join(MCP_PACKAGE_NAME).join("dist").join("index.js");
    script.is_file().then(|| script.to_string_lossy().to_string())
}

#[cfg(windows)]
fn locate_windows_command(command: &str) -> Option<String> {
    command_stdout("where", &[command]).ok().and_then(first_non_empty_line).or_else(|| {
        let script = format!("(Get-Command {} -ErrorAction SilentlyContinue).Source", windows_shell_quote(command));
        command_stdout("powershell.exe", &["-NoProfile", "-Command", &script]).ok().and_then(first_non_empty_line)
    })
}

fn command_success(command: &str, args: &[&str]) -> bool {
    command_output(command, args).is_ok_and(|output| output.success)
}

fn command_stdout(command: &str, args: &[&str]) -> Result<String, String> {
    let output = command_output(command, args)?;
    if !output.success {
        return Err(output.stderr.trim().to_string());
    }
    Ok(output.stdout.trim().to_string())
}

fn first_non_empty_line(value: String) -> Option<String> {
    value.lines().map(str::trim).find(|line| !line.is_empty()).map(ToOwned::to_owned)
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn command_output(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let direct = run_command(command, args);
    if direct.as_ref().is_ok_and(|output| output.success) {
        return direct;
    }

    #[cfg(windows)]
    {
        return run_windows_command_candidates(command, args).or(direct);
    }

    #[cfg(not(windows))]
    {
        run_command_through_user_shell(command, args).or(direct)
    }
}

fn run_command(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    Ok(CommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

#[cfg(windows)]
fn run_windows_command_candidates(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    for candidate in windows_command_candidates(command) {
        let output = run_command(&candidate, args);
        if output.as_ref().is_ok_and(|output| output.success) {
            return output;
        }
    }
    run_command_through_user_shell(command, args)
}

#[cfg(windows)]
fn windows_command_candidates(command: &str) -> Vec<String> {
    if Path::new(command).extension().is_some() {
        return Vec::new();
    }
    ["cmd", "exe", "ps1"].iter().map(|extension| format!("{command}.{extension}")).collect()
}

#[cfg(windows)]
fn run_command_through_user_shell(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let script = windows_command_script(command, args);
    let mut output = run_command("powershell.exe", &["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])?;
    output.stdout = stdout_after_shell_marker(&output.stdout);
    Ok(output)
}

#[cfg(windows)]
fn windows_command_script(command: &str, args: &[&str]) -> String {
    let mut words = Vec::with_capacity(args.len() + 1);
    words.push(windows_shell_quote(command));
    words.extend(args.iter().map(|arg| windows_shell_quote(arg)));
    format!("Write-Output {}; & {}", windows_shell_quote(SHELL_COMMAND_MARKER), words.join(" "))
}

#[cfg(windows)]
fn windows_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(not(windows))]
fn run_command_through_user_shell(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let script = shell_command_script(command, args);
    let (shell, shell_args) = user_shell_invocation_args(&script);
    let shell_arg_refs = shell_args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut output = run_command(&shell, &shell_arg_refs)?;
    output.stdout = stdout_after_shell_marker(&output.stdout);
    Ok(output)
}

#[cfg(not(windows))]
fn user_shell_invocation_args(script: &str) -> (String, Vec<String>) {
    let shell = env::var("SHELL").ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(default_user_shell);
    let shell_name = Path::new(&shell).file_name().and_then(|value| value.to_str()).unwrap_or_default();
    let args = match shell_name {
        "fish" => vec!["-l".to_string(), "-i".to_string(), "-c".to_string(), script.to_string()],
        "bash" => vec![
            "--noprofile".to_string(),
            "--norc".to_string(),
            "-i".to_string(),
            "-c".to_string(),
            bash_login_script(script),
        ],
        "sh" | "dash" => vec!["-ic".to_string(), script.to_string()],
        "zsh" => vec!["-ilc".to_string(), script.to_string()],
        _ => vec!["-lc".to_string(), script.to_string()],
    };
    (shell, args)
}

#[cfg(not(windows))]
fn bash_login_script(script: &str) -> String {
    format!(
        "for dbx_profile in ~/.bash_profile ~/.bash_login ~/.profile ~/.bashrc; do \
         [ -r \"$dbx_profile\" ] && . \"$dbx_profile\"; \
         done; unset dbx_profile; {script}"
    )
}

#[cfg(not(windows))]
fn default_user_shell() -> String {
    if Path::new("/bin/zsh").exists() {
        "/bin/zsh".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

#[cfg(not(windows))]
fn shell_command_script(command: &str, args: &[&str]) -> String {
    let mut words = Vec::with_capacity(args.len() + 1);
    words.push(shell_quote(command));
    words.extend(args.iter().map(|arg| shell_quote(arg)));
    format!("printf '%s\\n' {}; {}", shell_quote(SHELL_COMMAND_MARKER), words.join(" "))
}

#[cfg(not(windows))]
fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn stdout_after_shell_marker(stdout: &str) -> String {
    stdout
        .find(SHELL_COMMAND_MARKER)
        .map(|index| stdout[index + SHELL_COMMAND_MARKER.len()..].trim_start_matches(['\r', '\n']).to_string())
        .unwrap_or_else(|| stdout.to_string())
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    use super::bash_login_script;
    #[cfg(not(windows))]
    use super::{shell_command_script, shell_quote};
    use super::{stdout_after_shell_marker, SHELL_COMMAND_MARKER};

    #[cfg(not(windows))]
    #[test]
    fn shell_quote_handles_empty_and_single_quotes() {
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("npm"), "'npm'");
        assert_eq!(shell_quote("can't"), "'can'\"'\"'t'");
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_command_script_marks_command_output_after_startup_noise() {
        let script = shell_command_script("npm", &["list", "-g", "@dbx-app/mcp-server", "--json"]);

        assert!(script.contains(SHELL_COMMAND_MARKER));
        assert!(script.contains("'@dbx-app/mcp-server'"));
    }

    #[cfg(not(windows))]
    #[test]
    fn bash_login_script_sources_profile_and_rc_files() {
        let script = bash_login_script("node --version");

        assert!(script.contains("~/.bash_profile"));
        assert!(script.contains("~/.bashrc"));
        assert!(script.ends_with("node --version"));
    }

    #[test]
    fn stdout_after_shell_marker_ignores_shell_startup_output() {
        let stdout = format!("loading profile\n{SHELL_COMMAND_MARKER}\n22.19.0\n");

        assert_eq!(stdout_after_shell_marker(&stdout), "22.19.0\n");
    }
}
