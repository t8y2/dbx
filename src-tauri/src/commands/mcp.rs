use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const MCP_PACKAGE_NAME: &str = "@dbx-app/mcp-server";
const MCP_LATEST_URL: &str = "https://registry.npmjs.org/@dbx-app%2fmcp-server/latest";
const MCP_INSTALL_COMMAND: &str = "npm install -g @dbx-app/mcp-server@latest --registry=https://registry.npmjs.org";
const MCP_MIN_NODE_VERSION: NodeVersion = NodeVersion { major: 18, minor: 18, patch: 0 };
const MCP_MIN_NODE_VERSION_REQUIREMENT: &str = ">=18.18.0";
const SHELL_COMMAND_MARKER: &str = "__DBX_MCP_COMMAND_OUTPUT_START__";

#[derive(Debug, Serialize)]
pub struct McpServerStatus {
    pub installed: bool,
    pub npm_available: bool,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub bin_path: Option<String>,
    pub native_bin_path: Option<String>,
    pub script_path: Option<String>,
    pub install_command: String,
    pub update_command: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NpmLatestPackage {
    version: String,
}

#[derive(Debug, Clone)]
struct NodeRuntimeCandidate {
    node_path: PathBuf,
}

#[derive(Debug, Clone)]
struct NodeRuntime {
    node_path: PathBuf,
    npm_cli_path: PathBuf,
    npm_root: PathBuf,
    node_version: String,
    mcp_version: Option<String>,
    mcp_script_path: Option<PathBuf>,
    mcp_bin_path: Option<PathBuf>,
    mcp_native_bin_path: Option<PathBuf>,
}

#[derive(Debug)]
struct McpPackage {
    version: Option<String>,
    script_path: PathBuf,
    minimum_node_version: Option<NodeVersion>,
}

impl NodeRuntime {
    fn probe(candidate: NodeRuntimeCandidate) -> Option<Self> {
        let (node_path, node_version) = resolve_node_identity(&candidate.node_path)?;
        if !is_mcp_compatible_node_version(&node_version) {
            return None;
        }
        let npm_cli_path = find_npm_cli(&node_path)?;

        let npm_root = npm_stdout(&node_path, &npm_cli_path, &["root", "-g"]).ok()?;
        let npm_root = normalized_reported_path(Path::new(npm_root.trim()))?;
        let npm_prefix = npm_stdout(&node_path, &npm_cli_path, &["prefix", "-g"])
            .ok()
            .and_then(|value| normalized_reported_path(Path::new(value.trim())))
            .unwrap_or_else(|| npm_prefix_from_root(&npm_root));
        let package_root = npm_root.join(MCP_PACKAGE_NAME);
        let package = mcp_package(&package_root);
        let package_is_compatible = package
            .as_ref()
            .and_then(|package| package.minimum_node_version)
            .is_none_or(|minimum| parse_node_version(&node_version).is_some_and(|version| version >= minimum));
        let mcp_version = package.as_ref().and_then(|package| package.version.clone());
        // Resolve the package-declared launcher so npm layout changes do not break the built-in AI assistant.
        let mcp_script_path = package.filter(|_| package_is_compatible).map(|package| package.script_path);
        let mcp_bin_path = mcp_bin_path(&npm_prefix);
        // TRAE on Windows splits executable paths containing spaces, so expose the native package binary as a safe direct launch option.
        let mcp_native_bin_path =
            package_is_compatible.then(|| mcp_native_binary_path(&package_root, &npm_root)).flatten();

        Some(Self {
            node_path,
            npm_cli_path,
            npm_root,
            node_version,
            mcp_version,
            mcp_script_path,
            mcp_bin_path,
            mcp_native_bin_path,
        })
    }

    fn has_mcp_package(&self) -> bool {
        self.mcp_script_path.is_some()
    }

    fn npm_output(&self, args: &[&str]) -> Result<CommandOutput, String> {
        npm_output(&self.node_path, &self.npm_cli_path, args)
    }

    fn refresh(&self) -> Option<Self> {
        Self::probe(NodeRuntimeCandidate { node_path: self.node_path.clone() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct NodeVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

#[tauri::command]
pub async fn check_mcp_server_status() -> Result<McpServerStatus, String> {
    let local_status = tauri::async_runtime::spawn_blocking(|| {
        let runtime = resolve_node_runtime();
        let fallback_bin = match runtime.as_ref() {
            Some(runtime) if runtime.has_mcp_package() => runtime.mcp_bin_path.clone(),
            _ => locate_mcp_bin(),
        };
        (runtime, fallback_bin)
    });
    let latest_version = fetch_latest_mcp_version();
    let (local_status, latest_version) = tokio::join!(local_status, latest_version);
    let (runtime, fallback_bin) = local_status.map_err(|err| err.to_string())?;
    let npm_available = runtime.is_some();
    let node_path = runtime.as_ref().map(|runtime| path_string(&runtime.node_path));
    let node_version = runtime.as_ref().map(|runtime| runtime.node_version.clone());
    let current_version = runtime.as_ref().and_then(|runtime| runtime.mcp_version.clone());
    let script_path =
        runtime.as_ref().and_then(|runtime| runtime.mcp_script_path.as_ref()).map(|path| path_string(path));
    let native_bin_path =
        runtime.as_ref().and_then(|runtime| runtime.mcp_native_bin_path.as_ref()).map(|path| path_string(path));
    let bin_path = fallback_bin.as_ref().map(|path| path_string(path));
    let latest_version = latest_version.ok();
    let update_available = current_version
        .as_deref()
        .zip(latest_version.as_deref())
        .is_some_and(|(current, latest)| dbx_core::update::is_newer_version(latest, current));
    let error = if npm_available {
        None
    } else {
        Some(format!("Unable to resolve a compatible Node.js ({}) and npm runtime.", MCP_MIN_NODE_VERSION_REQUIREMENT))
    };

    Ok(McpServerStatus {
        installed: current_version.is_some() || bin_path.is_some() || script_path.is_some(),
        npm_available,
        node_path,
        node_version,
        current_version,
        latest_version,
        update_available,
        bin_path,
        native_bin_path,
        script_path,
        install_command: MCP_INSTALL_COMMAND.to_string(),
        update_command: MCP_INSTALL_COMMAND.to_string(),
        error,
    })
}

#[tauri::command]
pub async fn install_mcp_server() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let runtime = resolve_node_runtime().ok_or_else(|| {
            format!(
                "Unable to resolve a compatible Node.js ({}) and npm runtime. Install Node.js with npm and try again.",
                MCP_MIN_NODE_VERSION_REQUIREMENT
            )
        })?;
        let output = runtime.npm_output(&[
            "install",
            "-g",
            "@dbx-app/mcp-server@latest",
            "--registry=https://registry.npmjs.org",
        ])?;

        if !output.success {
            let error_msg = if !output.stderr.is_empty() { output.stderr } else { output.stdout };
            return Err(format!("Installation failed: {}", error_msg));
        }

        let installed = runtime.refresh().ok_or_else(|| {
            format!(
                "Installation completed, but the Node.js runtime at {} could not be validated.",
                runtime.node_path.display()
            )
        })?;
        installed.mcp_script_path.as_ref().ok_or_else(|| {
            format!(
                "Installation completed, but {} was not found under {}.",
                MCP_PACKAGE_NAME,
                installed.npm_root.display()
            )
        })?;
        let version = installed.mcp_version.unwrap_or_else(|| "unknown".to_string());
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

pub(crate) async fn resolve_mcp_server_command() -> Result<(String, Vec<String>), String> {
    let command = tauri::async_runtime::spawn_blocking(resolve_mcp_server_command_sync)
        .await
        .map_err(|err| format!("Failed to resolve DBX MCP Server runtime: {err}"))?;
    require_managed_mcp_command(command)
}

fn resolve_mcp_server_command_sync() -> Option<(String, Vec<String>)> {
    let runtime = resolve_node_runtime();
    resolve_managed_mcp_command(runtime.as_ref(), locate_mcp_bin)
}

fn resolve_managed_mcp_command(
    runtime: Option<&NodeRuntime>,
    locate_path_shim: impl FnOnce() -> Option<PathBuf>,
) -> Option<(String, Vec<String>)> {
    if let Some(command) = runtime.and_then(mcp_command_for_runtime) {
        return Some(command);
    }

    // PATH shims may use `#!/usr/bin/env node`, bypassing the runtime compatibility check above.
    if let Some(shim) = locate_path_shim() {
        log::warn!("Ignoring unbound MCP package shim at {}", shim.display());
    }
    None
}

fn require_managed_mcp_command(command: Option<(String, Vec<String>)>) -> Result<(String, Vec<String>), String> {
    command.ok_or_else(|| {
        format!(
            "[dbxMcpMissing] No compatible Node.js ({}) installation containing {} was found.",
            MCP_MIN_NODE_VERSION_REQUIREMENT, MCP_PACKAGE_NAME
        )
    })
}

fn resolve_node_runtime() -> Option<NodeRuntime> {
    let mut seen = HashSet::new();
    let mut fallback = None;

    if let Some(runtime) = probe_runtime_candidate(current_path_node_candidate(), &mut seen, &mut fallback) {
        return Some(runtime);
    }
    if let Some(runtime) = probe_runtime_candidate(user_shell_node_candidate(), &mut seen, &mut fallback) {
        return Some(runtime);
    }
    for dir in common_node_dirs() {
        if let Some(runtime) = probe_runtime_candidate(node_candidate_in_dir(&dir), &mut seen, &mut fallback) {
            return Some(runtime);
        }
    }

    fallback
}

fn probe_runtime_candidate(
    candidate: Option<NodeRuntimeCandidate>,
    seen: &mut HashSet<PathBuf>,
    fallback: &mut Option<NodeRuntime>,
) -> Option<NodeRuntime> {
    let candidate = candidate?;
    let identity = canonical_runtime_path(&candidate.node_path).unwrap_or_else(|| candidate.node_path.clone());
    if !seen.insert(identity) {
        return None;
    }

    let runtime = NodeRuntime::probe(candidate)?;
    prefer_runtime(runtime, fallback)
}

fn prefer_runtime(runtime: NodeRuntime, fallback: &mut Option<NodeRuntime>) -> Option<NodeRuntime> {
    if !is_mcp_compatible_node_version(&runtime.node_version) {
        return None;
    }
    if runtime.has_mcp_package() {
        return Some(runtime);
    }
    if fallback.is_none() {
        *fallback = Some(runtime);
    }
    None
}

fn is_mcp_compatible_node_version(version: &str) -> bool {
    parse_node_version(version).is_some_and(|version| version >= MCP_MIN_NODE_VERSION)
}

fn parse_node_version(version: &str) -> Option<NodeVersion> {
    let version = version.trim().trim_start_matches('v');
    let mut parts = version.split('.');
    Some(NodeVersion {
        major: parse_node_version_part(parts.next()?)?,
        minor: parse_node_version_part(parts.next()?)?,
        patch: parse_node_version_part(parts.next()?)?,
    })
}

fn parse_node_version_part(value: &str) -> Option<u64> {
    let digits = value.chars().take_while(char::is_ascii_digit).collect::<String>();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

fn current_path_node_candidate() -> Option<NodeRuntimeCandidate> {
    let path = env::var_os("PATH")?;
    let node_path = find_command_in_path("node", &path)?;
    Some(NodeRuntimeCandidate { node_path })
}

fn node_candidate_in_dir(dir: &Path) -> Option<NodeRuntimeCandidate> {
    let node_path = find_command_in_dir("node", dir)?;
    Some(NodeRuntimeCandidate { node_path })
}

fn find_command_in_path(command: &str, path: &OsStr) -> Option<PathBuf> {
    env::split_paths(path).find_map(|dir| find_command_in_dir(command, &dir))
}

fn find_command_in_dir(command: &str, dir: &Path) -> Option<PathBuf> {
    command_file_names(command).into_iter().map(|name| dir.join(name)).find(|path| path.is_file())
}

#[cfg(not(windows))]
fn command_file_names(command: &str) -> Vec<OsString> {
    vec![OsString::from(command)]
}

#[cfg(windows)]
fn command_file_names(command: &str) -> Vec<OsString> {
    if Path::new(command).extension().is_some() {
        return vec![OsString::from(command)];
    }

    let mut extensions = vec![".exe".to_string(), ".com".to_string(), ".cmd".to_string(), ".bat".to_string()];
    if let Ok(path_ext) = env::var("PATHEXT") {
        for extension in path_ext.split(';').map(str::trim).filter(|extension| !extension.is_empty()) {
            let normalized = if extension.starts_with('.') {
                extension.to_ascii_lowercase()
            } else {
                format!(".{}", extension.to_ascii_lowercase())
            };
            if !extensions.iter().any(|existing| existing.eq_ignore_ascii_case(&normalized)) {
                extensions.push(normalized);
            }
        }
    }
    let mut names: Vec<OsString> =
        extensions.into_iter().map(|extension| OsString::from(format!("{command}{extension}"))).collect();
    names.push(OsString::from(command));
    names
}

#[cfg(not(windows))]
fn common_node_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].into_iter().map(PathBuf::from));
    dirs
}

#[cfg(windows)]
fn common_node_dirs() -> Vec<PathBuf> {
    windows_common_command_dirs()
}

#[cfg(not(windows))]
fn user_shell_node_candidate() -> Option<NodeRuntimeCandidate> {
    let script = format!(
        "printf '%s\\n' {}; printf 'node=%s\\n' \"$(command -v node 2>/dev/null)\"",
        shell_quote(SHELL_COMMAND_MARKER)
    );
    let (shell, shell_args) = user_shell_invocation_args(&script);
    let output = run_command(&shell, &shell_args).ok()?;
    if !output.success {
        return None;
    }
    let stdout = stdout_after_shell_marker(&output.stdout);
    let node_path = prefixed_output_path(&stdout, "node=")?;
    Some(NodeRuntimeCandidate { node_path })
}

#[cfg(windows)]
fn user_shell_node_candidate() -> Option<NodeRuntimeCandidate> {
    let node_path = locate_windows_command("node").map(PathBuf::from)?;
    Some(NodeRuntimeCandidate { node_path })
}

fn prefixed_output_path(output: &str, prefix: &str) -> Option<PathBuf> {
    output
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(prefix))
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(value.trim()))
}

fn canonical_runtime_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    Some(normalize_canonical_path(canonical))
}

fn resolve_node_identity(command_path: &Path) -> Option<(PathBuf, String)> {
    let launcher = canonical_runtime_path(command_path)?;
    if let Ok(output) = direct_command_stdout(&launcher, &["-p", "process.execPath + '\\n' + process.version"]) {
        let mut lines = output.lines().map(str::trim).filter(|line| !line.is_empty());
        if let (Some(exec_path), Some(version)) = (lines.next(), lines.next()) {
            if let Some(exec_path) = canonical_runtime_path(Path::new(exec_path)) {
                return Some((exec_path, version.to_string()));
            }
        }
    }

    let version = direct_command_stdout(&launcher, &["--version"]).ok().and_then(first_non_empty_line)?;
    Some((launcher, version))
}

fn normalized_reported_path(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    canonical_runtime_path(path).or_else(|| {
        if path.is_absolute() {
            Some(path.to_path_buf())
        } else {
            env::current_dir().ok().map(|current| current.join(path))
        }
    })
}

#[cfg(not(windows))]
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(windows)]
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", value));
    }
    value.strip_prefix(r"\\?\").map(PathBuf::from).unwrap_or(path)
}

fn find_npm_cli(node_path: &Path) -> Option<PathBuf> {
    let mut candidates = npm_cli_candidates(node_path);
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        let Some(canonical) = canonical_runtime_path(candidate) else {
            return false;
        };
        seen.insert(canonical)
    });

    candidates.into_iter().find_map(|candidate| {
        let canonical = canonical_runtime_path(&candidate)?;
        if is_native_npm_launcher(&canonical) || npm_stdout(node_path, &canonical, &["--version"]).is_err() {
            return None;
        }
        Some(canonical)
    })
}

fn npm_cli_candidates(node_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = node_path.parent() {
        candidates.push(parent.join("npm"));
        candidates.push(parent.join("npm.cmd"));
        candidates.push(parent.join("node_modules").join("npm").join("bin").join("npm-cli.js"));
        candidates.push(parent.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
        candidates.push(parent.join("..").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
    }
    candidates
}

fn is_native_npm_launcher(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("cmd" | "bat" | "exe" | "com" | "ps1")
    )
}

fn npm_output(node_path: &Path, npm_cli_path: &Path, args: &[&str]) -> Result<CommandOutput, String> {
    let mut command_args = Vec::with_capacity(args.len() + 1);
    command_args.push(npm_cli_path.as_os_str().to_os_string());
    command_args.extend(args.iter().map(|arg| OsString::from(*arg)));
    let mut command = dbx_core::process::new_std_command(node_path);
    command.args(&command_args);
    if let Some(node_dir) = node_path.parent() {
        let mut paths = vec![node_dir.to_path_buf()];
        if let Some(current_path) = env::var_os("PATH") {
            paths.extend(env::split_paths(&current_path));
        }
        if let Ok(path) = env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    command_output_from_process(command)
}

fn npm_stdout(node_path: &Path, npm_cli_path: &Path, args: &[&str]) -> Result<String, String> {
    successful_stdout(npm_output(node_path, npm_cli_path, args)?)
}

fn direct_command_stdout(command: &Path, args: &[&str]) -> Result<String, String> {
    successful_stdout(run_command(command, args)?)
}

fn successful_stdout(output: CommandOutput) -> Result<String, String> {
    if !output.success {
        let message = if output.stderr.is_empty() { output.stdout } else { output.stderr };
        return Err(message.trim().to_string());
    }
    Ok(output.stdout.trim().to_string())
}

fn mcp_package(package_root: &Path) -> Option<McpPackage> {
    let content = std::fs::read_to_string(package_root.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let entry = match value.get("bin")? {
        serde_json::Value::String(entry) => entry.as_str(),
        serde_json::Value::Object(entries) => {
            entries.get("dbx-mcp-server").or_else(|| entries.get("mcp-server"))?.as_str()?
        }
        _ => return None,
    };
    let package_root = canonical_runtime_path(package_root)?;
    let relative_entry = Path::new(entry);
    if relative_entry.is_absolute()
        || relative_entry.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let script_path = canonical_runtime_path(&package_root.join(relative_entry))?;
    if !script_path.starts_with(&package_root) {
        return None;
    }
    let version = value.get("version").and_then(serde_json::Value::as_str).map(ToOwned::to_owned);
    let minimum_node_version =
        value.pointer("/engines/node").and_then(serde_json::Value::as_str).and_then(parse_minimum_node_version);
    Some(McpPackage { version, script_path, minimum_node_version })
}

fn mcp_native_binary_path(package_root: &Path, npm_root: &Path) -> Option<PathBuf> {
    let (package_name, binary_name) = mcp_native_package()?;
    mcp_native_binary_path_for(package_root, npm_root, package_name, binary_name)
}

fn mcp_native_binary_path_for(
    package_root: &Path,
    npm_root: &Path,
    package_name: &str,
    binary_name: &str,
) -> Option<PathBuf> {
    [
        package_root.join("node_modules").join(package_name).join("bin").join(binary_name),
        npm_root.join(package_name).join("bin").join(binary_name),
    ]
    .into_iter()
    .find_map(|path| canonical_runtime_path(&path))
}

fn mcp_native_package() -> Option<(&'static str, &'static str)> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(("@dbx-app/mcp-darwin-arm64", "dbx-mcp"))
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some(("@dbx-app/mcp-darwin-x64", "dbx-mcp"))
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(("@dbx-app/mcp-linux-arm64-gnu", "dbx-mcp"))
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(("@dbx-app/mcp-linux-x64-gnu", "dbx-mcp"))
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Some(("@dbx-app/mcp-win32-arm64", "dbx-mcp.exe"))
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some(("@dbx-app/mcp-win32-x64", "dbx-mcp.exe"))
    } else {
        None
    }
}

fn parse_minimum_node_version(requirement: &str) -> Option<NodeVersion> {
    let version = requirement.trim().strip_prefix(">=")?.split_whitespace().next()?;
    parse_node_version(version)
}

#[cfg(not(windows))]
fn npm_prefix_from_root(npm_root: &Path) -> PathBuf {
    npm_root.parent().and_then(Path::parent).unwrap_or(npm_root).to_path_buf()
}

#[cfg(windows)]
fn npm_prefix_from_root(npm_root: &Path) -> PathBuf {
    npm_root.parent().unwrap_or(npm_root).to_path_buf()
}

#[cfg(not(windows))]
fn mcp_bin_path(npm_prefix: &Path) -> Option<PathBuf> {
    let path = npm_prefix.join("bin").join("dbx-mcp-server");
    path.is_file().then_some(path)
}

#[cfg(windows)]
fn mcp_bin_path(npm_prefix: &Path) -> Option<PathBuf> {
    ["dbx-mcp-server.cmd", "dbx-mcp-server.exe", "dbx-mcp-server.bat", "dbx-mcp-server"]
        .into_iter()
        .map(|name| npm_prefix.join(name))
        .find(|path| path.is_file())
}

fn mcp_command_for_runtime(runtime: &NodeRuntime) -> Option<(String, Vec<String>)> {
    if !is_mcp_compatible_node_version(&runtime.node_version) {
        return None;
    }
    let script_path = runtime.mcp_script_path.as_ref()?;
    Some((path_string(&runtime.node_path), vec![path_string(script_path)]))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
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

fn locate_mcp_bin() -> Option<PathBuf> {
    locate_command("dbx-mcp-server").map(PathBuf::from)
}

#[cfg(windows)]
fn locate_windows_command(command: &str) -> Option<String> {
    command_stdout("where", &[command])
        .ok()
        .and_then(first_windows_command_path)
        .or_else(|| {
            let script =
                format!("(Get-Command -All {} -ErrorAction SilentlyContinue).Source", windows_shell_quote(command));
            command_stdout("powershell.exe", &["-NoProfile", "-Command", &script])
                .ok()
                .and_then(first_windows_command_path)
        })
        .or_else(|| {
            windows_command_candidates(command)
                .into_iter()
                .find(|candidate| is_windows_launchable_command(candidate) && Path::new(candidate).is_file())
        })
}

#[cfg(windows)]
fn first_windows_command_path(value: String) -> Option<String> {
    let paths = value.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
    paths
        .into_iter()
        .find(|path| is_windows_launchable_command(path) && Path::new(path).is_file())
        .map(ToOwned::to_owned)
}

#[cfg(windows)]
fn is_windows_launchable_command(path: &str) -> bool {
    matches!(
        Path::new(path).extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("exe" | "cmd" | "bat" | "com")
    )
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

fn run_command<I, S>(command: impl AsRef<OsStr>, args: I) -> Result<CommandOutput, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = dbx_core::process::new_std_command(command);
    cmd.args(args);
    command_output_from_process(cmd)
}

fn command_output_from_process(mut command: std::process::Command) -> Result<CommandOutput, String> {
    let output = command.output().map_err(|e| e.to_string())?;
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
    let names = ["cmd", "exe", "bat", "com", "ps1"].iter().map(|extension| format!("{command}.{extension}"));
    names
        .clone()
        .chain(
            windows_common_command_dirs()
                .into_iter()
                .flat_map(|dir| names.clone().map(move |name| dir.join(name).to_string_lossy().to_string())),
        )
        .collect()
}

#[cfg(windows)]
fn windows_common_command_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
        dirs.push(nvm_symlink.into());
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        dirs.push(std::path::PathBuf::from(app_data).join("npm"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        dirs.push(std::path::PathBuf::from(program_files).join("nodejs"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        dirs.push(std::path::PathBuf::from(program_files_x86).join("nodejs"));
    }
    dirs.push(std::path::PathBuf::from(r"C:\nvm4w\nodejs"));
    dirs
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
    #[cfg(windows)]
    use super::first_windows_command_path;
    #[cfg(not(windows))]
    use super::{bash_login_script, NodeRuntimeCandidate};
    use super::{
        canonical_runtime_path, is_mcp_compatible_node_version, mcp_command_for_runtime, mcp_native_binary_path_for,
        mcp_package, normalized_reported_path, npm_cli_candidates, parse_minimum_node_version, parse_node_version,
        prefer_runtime, prefixed_output_path, require_managed_mcp_command, resolve_managed_mcp_command,
        stdout_after_shell_marker, NodeRuntime, NodeVersion, MCP_MIN_NODE_VERSION_REQUIREMENT, MCP_PACKAGE_NAME,
        SHELL_COMMAND_MARKER,
    };
    #[cfg(not(windows))]
    use super::{shell_command_script, shell_quote};
    use std::path::PathBuf;

    fn runtime(node_path: &str, script_path: Option<&str>) -> NodeRuntime {
        runtime_with_version_and_root(node_path, &format!("{node_path}-root"), script_path, "v24.16.0")
    }

    fn runtime_with_version_and_root(
        node_path: &str,
        npm_root: &str,
        script_path: Option<&str>,
        node_version: &str,
    ) -> NodeRuntime {
        NodeRuntime {
            node_path: PathBuf::from(node_path),
            npm_cli_path: PathBuf::from(format!("{node_path}-npm-cli.js")),
            npm_root: PathBuf::from(npm_root),
            node_version: node_version.to_string(),
            mcp_version: script_path.map(|_| "0.4.29".to_string()),
            mcp_script_path: script_path.map(PathBuf::from),
            mcp_bin_path: None,
            mcp_native_bin_path: None,
        }
    }

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

    #[test]
    fn prefixed_output_path_ignores_empty_values() {
        let output = "node=/opt/node/bin/node\nmissing=\n";

        assert_eq!(prefixed_output_path(output, "node="), Some(PathBuf::from("/opt/node/bin/node")));
        assert_eq!(prefixed_output_path(output, "missing="), None);
    }

    #[test]
    fn reported_global_root_can_be_resolved_before_it_exists() {
        let path = std::env::temp_dir().join(format!("dbx-mcp-missing-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);

        assert_eq!(normalized_reported_path(&path), Some(path));
    }

    #[test]
    fn installed_runtime_outranks_an_earlier_runtime_without_mcp() {
        let first = runtime("/runtime/node-26", None);
        let installed = runtime("/runtime/node-24", Some("/runtime/node-24-mcp/dist/index.js"));
        let mut fallback = None;

        assert!(prefer_runtime(first.clone(), &mut fallback).is_none());
        let selected = prefer_runtime(installed.clone(), &mut fallback).unwrap();

        assert_eq!(fallback.unwrap().node_path, first.node_path);
        assert_eq!(selected.node_path, installed.node_path);
        assert_eq!(selected.mcp_script_path, installed.mcp_script_path);
    }

    #[test]
    fn incompatible_runtime_cannot_win_with_shared_mcp_package() {
        let shared_npm_root = "/runtime/shared/node_modules";
        let shared_script = "/runtime/shared/node_modules/@dbx-app/mcp-server/dist/index.js";
        let old_runtime =
            runtime_with_version_and_root("/runtime/node-18", shared_npm_root, Some(shared_script), "v18.17.1");
        let compatible_runtime =
            runtime_with_version_and_root("/runtime/node-20", shared_npm_root, Some(shared_script), "v20.18.1");
        let mut fallback = None;

        assert!(prefer_runtime(old_runtime, &mut fallback).is_none());
        assert!(fallback.is_none());
        let selected = prefer_runtime(compatible_runtime.clone(), &mut fallback).unwrap();

        assert_eq!(selected.node_path, compatible_runtime.node_path);
        assert_eq!(selected.mcp_script_path, compatible_runtime.mcp_script_path);
    }

    #[test]
    fn node_version_parser_enforces_mcp_minimum() {
        assert_eq!(parse_node_version("v18.18.0"), Some(NodeVersion { major: 18, minor: 18, patch: 0 }));
        assert_eq!(parse_node_version("18.18.0-nightly"), Some(NodeVersion { major: 18, minor: 18, patch: 0 }));
        assert!(!is_mcp_compatible_node_version("v18.17.9"));
        assert!(!is_mcp_compatible_node_version("v17.99.99"));
        assert!(is_mcp_compatible_node_version("v18.18.0"));
        assert!(is_mcp_compatible_node_version("v24.0.0"));
    }

    #[test]
    fn package_node_requirement_parser_handles_owned_engine_format() {
        assert_eq!(parse_minimum_node_version(">=18.18.0"), Some(NodeVersion { major: 18, minor: 18, patch: 0 }));
        assert_eq!(parse_minimum_node_version("^22.13.0"), None);
    }

    #[test]
    fn mcp_package_uses_declared_current_and_legacy_entries() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx-mcp-package-test-{}-{nonce}", std::process::id()));
        let current_entry = dir.join("bin").join("dbx-mcp-server.js");
        std::fs::create_dir_all(current_entry.parent().unwrap()).unwrap();
        std::fs::write(&current_entry, "// native launcher\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"version":"0.4.38","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        let current = mcp_package(&dir).unwrap();
        assert_eq!(current.version.as_deref(), Some("0.4.38"));
        assert_eq!(current.script_path, canonical_runtime_path(&current_entry).unwrap());
        assert_eq!(current.minimum_node_version, Some(NodeVersion { major: 18, minor: 18, patch: 0 }));

        let legacy_entry = dir.join("dist").join("index.js");
        std::fs::create_dir_all(legacy_entry.parent().unwrap()).unwrap();
        std::fs::write(&legacy_entry, "// legacy server\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"version":"0.4.32","bin":{"dbx-mcp-server":"dist/index.js"},"engines":{"node":">=22.13.0"}}"#,
        )
        .unwrap();

        let legacy = mcp_package(&dir).unwrap();
        assert_eq!(legacy.version.as_deref(), Some("0.4.32"));
        assert_eq!(legacy.script_path, canonical_runtime_path(&legacy_entry).unwrap());
        assert_eq!(legacy.minimum_node_version, Some(NodeVersion { major: 22, minor: 13, patch: 0 }));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_binary_resolves_nested_and_hoisted_optional_packages() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx-mcp-native-package-test-{}-{nonce}", std::process::id()));
        let npm_root = dir.join("node_modules");
        let package_root = npm_root.join("@dbx-app").join("mcp-server");
        let package_name = "@dbx-app/mcp-win32-x64";
        let binary_name = "dbx-mcp.exe";
        let nested_binary = package_root.join("node_modules").join(package_name).join("bin").join(binary_name);
        std::fs::create_dir_all(nested_binary.parent().unwrap()).unwrap();
        std::fs::write(&nested_binary, "nested binary").unwrap();

        assert_eq!(
            mcp_native_binary_path_for(&package_root, &npm_root, package_name, binary_name),
            canonical_runtime_path(&nested_binary)
        );

        std::fs::remove_file(&nested_binary).unwrap();
        let hoisted_binary = npm_root.join(package_name).join("bin").join(binary_name);
        std::fs::create_dir_all(hoisted_binary.parent().unwrap()).unwrap();
        std::fs::write(&hoisted_binary, "hoisted binary").unwrap();

        assert_eq!(
            mcp_native_binary_path_for(&package_root, &npm_root, package_name, binary_name),
            canonical_runtime_path(&hoisted_binary)
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mcp_command_binds_script_to_the_installation_node() {
        let installed = runtime("/runtime/node-24", Some("/runtime/node-24-mcp/dist/index.js"));

        let command = mcp_command_for_runtime(&installed).unwrap();

        assert_eq!(command.0, "/runtime/node-24");
        assert_eq!(command.1, vec!["/runtime/node-24-mcp/dist/index.js"]);
    }

    #[test]
    fn incompatible_runtime_does_not_fall_back_to_available_mcp_shim() {
        let incompatible = runtime_with_version_and_root(
            "/runtime/node-18",
            "/runtime/node-18-root",
            Some("/runtime/node-18-root/bin/dbx-mcp-server"),
            "v18.17.1",
        );

        let command =
            resolve_managed_mcp_command(Some(&incompatible), || Some(PathBuf::from("/path/bin/dbx-mcp-server")));

        assert!(command.is_none());
    }

    #[test]
    fn desktop_launch_requires_a_managed_mcp_command() {
        let error = require_managed_mcp_command(None).unwrap_err();

        assert!(error.contains(MCP_MIN_NODE_VERSION_REQUIREMENT));
        assert!(error.contains(MCP_PACKAGE_NAME));
        assert!(error.starts_with("[dbxMcpMissing]"));
    }

    #[test]
    fn npm_cli_candidates_stay_with_the_selected_node_installation() {
        let candidates = npm_cli_candidates(PathBuf::from("/runtime/node-24/bin/node").as_path());

        assert_eq!(candidates.first(), Some(&PathBuf::from("/runtime/node-24/bin/npm")));
        assert!(candidates.iter().all(|path| !path.starts_with("/runtime/node-26")));
    }

    #[cfg(not(windows))]
    #[test]
    fn runtime_probe_canonicalizes_node_and_keeps_npm_root_bound_to_it() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx-mcp-runtime-test-{}-{nonce}", std::process::id()));
        let prefix = dir.join("prefix");
        let npm_root = prefix.join("lib").join("node_modules");
        let package_root = npm_root.join(super::MCP_PACKAGE_NAME);
        let script_path = package_root.join("bin").join("dbx-mcp-server.js");
        let node_path = dir.join("node-v24");
        let node_alias = dir.join("node");
        let npm_cli_path = dir.join("npm");
        let log_path = dir.join("calls.log");

        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&npm_cli_path, "// fake npm cli\n").unwrap();
        std::fs::write(&script_path, "// fake mcp server\n").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"version":"0.4.38","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();
        let node_script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nprintf 'PATH=%s\\n' \"$PATH\" >> {}\n\
             if [ \"$1\" = '--version' ]; then printf 'v24.16.0\\n'; \
             elif [ \"$2\" = '--version' ]; then printf '10.9.2\\n'; \
             elif [ \"$2\" = 'root' ]; then printf '%s\\n' {}; \
             elif [ \"$2\" = 'prefix' ]; then printf '%s\\n' {}; \
             else exit 1; fi\n",
            shell_quote(log_path.to_string_lossy().as_ref()),
            shell_quote(log_path.to_string_lossy().as_ref()),
            shell_quote(npm_root.to_string_lossy().as_ref()),
            shell_quote(prefix.to_string_lossy().as_ref())
        );
        std::fs::write(&node_path, node_script).unwrap();
        let mut permissions = std::fs::metadata(&node_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&node_path, permissions).unwrap();
        symlink(&node_path, &node_alias).unwrap();

        let probed = NodeRuntime::probe(NodeRuntimeCandidate { node_path: node_alias.clone() }).unwrap();

        assert_eq!(probed.node_path, canonical_runtime_path(&node_path).unwrap());
        assert_eq!(probed.npm_root, canonical_runtime_path(&npm_root).unwrap());
        assert_eq!(probed.node_version, "v24.16.0");
        assert_eq!(probed.mcp_script_path, canonical_runtime_path(&script_path));
        let calls = std::fs::read_to_string(log_path).unwrap();
        assert!(calls.contains("npm root -g"));
        assert!(calls.contains("npm prefix -g"));
        assert!(calls.contains(&format!("PATH={}", canonical_runtime_path(&dir).unwrap().display())));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_command_lookup_prefers_cmd_over_extensionless_shim() {
        let dir = std::env::temp_dir().join(format!("dbx-mcp-command-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let extensionless = dir.join("codex");
        let cmd = dir.join("codex.cmd");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\n").unwrap();

        let output = format!("{}\n{}\n", extensionless.display(), cmd.display());
        let resolved = first_windows_command_path(output).unwrap();

        assert_eq!(resolved, cmd.to_string_lossy().as_ref());
        let _ = std::fs::remove_file(extensionless);
        let _ = std::fs::remove_file(cmd);
        let _ = std::fs::remove_dir(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_command_lookup_rejects_extensionless_only_shim() {
        let dir = std::env::temp_dir().join(format!("dbx-mcp-command-extensionless-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let extensionless = dir.join("codex");
        std::fs::write(&extensionless, "#!/bin/sh\n").unwrap();

        let resolved = first_windows_command_path(extensionless.display().to_string());

        assert!(resolved.is_none());
        let _ = std::fs::remove_file(extensionless);
        let _ = std::fs::remove_dir(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_canonical_path_preserves_unc_paths() {
        assert_eq!(
            super::normalize_canonical_path(PathBuf::from(r"\\?\UNC\server\share\node.exe")),
            PathBuf::from(r"\\server\share\node.exe")
        );
        assert_eq!(
            super::normalize_canonical_path(PathBuf::from(r"\\?\C:\Program Files\nodejs\node.exe")),
            PathBuf::from(r"C:\Program Files\nodejs\node.exe")
        );
    }
}
