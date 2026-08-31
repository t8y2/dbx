use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MCP_PACKAGE_NAME: &str = "@dbx-app/mcp-server";
const MCP_LATEST_URL: &str = "https://registry.npmjs.org/@dbx-app%2fmcp-server/latest";
const MCP_INSTALL_COMMAND: &str = "npm install -g @dbx-app/mcp-server@latest";
const MCP_PNPM_UPDATE_COMMAND: &str = "pnpm update -g @dbx-app/mcp-server";
const MCP_UNINSTALL_COMMAND: &str = "npm uninstall -g @dbx-app/mcp-server";
const MCP_PNPM_UNINSTALL_COMMAND: &str = "pnpm remove -g @dbx-app/mcp-server";
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
    pub data_dir: Option<String>,
    pub install_command: String,
    pub update_command: String,
    pub uninstall_command: String,
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
    node_launcher_path: PathBuf,
    node_path: PathBuf,
    npm_cli_path: PathBuf,
    npm_root: PathBuf,
    node_version: String,
    mcp_installation: Option<McpInstallation>,
}

#[derive(Debug, Clone)]
struct McpPackage {
    version: String,
    script_path: PathBuf,
    minimum_node_version: NodeVersion,
}

#[derive(Debug, Clone)]
enum McpPackageManager {
    Npm,
    Pnpm { command_path: PathBuf, pnpm_home: PathBuf, global_dir: PathBuf },
    PnpmUnavailable { pnpm_home: PathBuf, global_dir: PathBuf },
    Unmanaged { launcher_dir: PathBuf },
}

#[derive(Debug, Clone)]
struct LocatedMcpPackage {
    package_root: PathBuf,
    package: McpPackage,
    bin_path: Option<PathBuf>,
    package_manager: McpPackageManager,
}

#[derive(Debug, Clone)]
struct McpInstallation {
    package_root: PathBuf,
    launcher_path: Option<PathBuf>,
    script_path: PathBuf,
    node_path: PathBuf,
    node_version: String,
    package_version: String,
    package_manager: McpPackageManager,
    native_bin_path: Option<PathBuf>,
}

struct McpInstallationStatusFields {
    installed: bool,
    current_version: Option<String>,
    bin_path: Option<String>,
    native_bin_path: Option<String>,
    script_path: Option<String>,
}

impl NodeRuntime {
    fn probe_with_path_package(
        candidate: NodeRuntimeCandidate,
        path_package: Option<&LocatedMcpPackage>,
    ) -> Option<Self> {
        let node_launcher_path = candidate.node_path.clone();
        let launcher_dir = candidate.node_path.parent().map(Path::to_path_buf);
        let (node_path, node_version) = resolve_node_identity(&candidate.node_path)?;
        if !is_mcp_compatible_node_version(&node_version) {
            return None;
        }
        let npm_cli_path = find_npm_cli(&node_path, launcher_dir.as_deref())?;

        let npm_root = npm_stdout(&node_path, &npm_cli_path, &["root", "-g"]).ok()?;
        let npm_root = normalized_reported_path(Path::new(npm_root.trim()))?;
        let npm_prefix = npm_stdout(&node_path, &npm_cli_path, &["prefix", "-g"])
            .ok()
            .and_then(|value| normalized_reported_path(Path::new(value.trim())))
            .unwrap_or_else(|| npm_prefix_from_root(&npm_root));
        let npm_package_root = npm_root.join(MCP_PACKAGE_NAME);
        let npm_package = mcp_package(&npm_package_root).and_then(|package| {
            Some(LocatedMcpPackage {
                package_root: canonical_runtime_path(&npm_package_root)?,
                package,
                bin_path: mcp_bin_path(&npm_prefix),
                package_manager: McpPackageManager::Npm,
            })
        });
        let shim_package = preferred_mcp_package(
            launcher_dir.as_deref().and_then(mcp_package_from_command_dir),
            path_package.cloned(),
            &node_version,
        );
        let package = preferred_mcp_package(npm_package, shim_package, &node_version);
        let mcp_installation =
            package.and_then(|located| bind_mcp_installation(located, &node_path, &node_version, &npm_root));

        Some(Self { node_launcher_path, node_path, npm_cli_path, npm_root, node_version, mcp_installation })
    }

    fn has_mcp_package(&self) -> bool {
        self.mcp_installation.is_some()
    }

    fn npm_output(&self, args: &[&str]) -> Result<CommandOutput, String> {
        npm_output(&self.node_path, &self.npm_cli_path, args)
    }

    fn refresh(&self) -> Option<Self> {
        let path_package = self
            .mcp_installation
            .as_ref()
            .and_then(|installation| installation.launcher_path.as_deref())
            .and_then(mcp_package_from_command_path)
            .or_else(discover_path_mcp_package);
        Self::probe_with_path_package(
            NodeRuntimeCandidate { node_path: self.node_launcher_path.clone() },
            path_package.as_ref(),
        )
    }

    fn update_command(&self) -> &'static str {
        match self.mcp_installation.as_ref().map(|installation| &installation.package_manager) {
            Some(McpPackageManager::Pnpm { .. } | McpPackageManager::PnpmUnavailable { .. }) => MCP_PNPM_UPDATE_COMMAND,
            _ => MCP_INSTALL_COMMAND,
        }
    }

    fn uninstall_command(&self) -> &'static str {
        match self.mcp_installation.as_ref().map(|installation| &installation.package_manager) {
            Some(McpPackageManager::Pnpm { .. } | McpPackageManager::PnpmUnavailable { .. }) => {
                MCP_PNPM_UNINSTALL_COMMAND
            }
            _ => MCP_UNINSTALL_COMMAND,
        }
    }

    fn install_or_update(&self) -> Result<CommandOutput, String> {
        match self.mcp_installation.as_ref().map(|installation| &installation.package_manager) {
            Some(McpPackageManager::Pnpm { command_path, pnpm_home, global_dir }) => {
                let global_dir = global_dir.as_os_str().to_os_string();
                run_package_manager_command(
                    command_path,
                    &[
                        OsString::from("update"),
                        OsString::from("-g"),
                        OsString::from(MCP_PACKAGE_NAME),
                        OsString::from("--global-dir"),
                        global_dir,
                    ],
                    &self.node_launcher_path,
                    pnpm_home,
                )
            }
            Some(McpPackageManager::PnpmUnavailable { pnpm_home, global_dir }) => Err(format!(
                "Cannot safely update {} in {} because no pnpm executable was found next to its launcher in {}.",
                MCP_PACKAGE_NAME,
                global_dir.display(),
                pnpm_home.display()
            )),
            Some(McpPackageManager::Unmanaged { launcher_dir }) => Err(format!(
                "Cannot safely update {} because the package manager for the launcher in {} could not be verified.",
                MCP_PACKAGE_NAME,
                launcher_dir.display()
            )),
            _ => self.npm_output(&["install", "-g", "@dbx-app/mcp-server@latest"]),
        }
    }

    fn uninstall(&self) -> Result<CommandOutput, String> {
        let installation = self
            .mcp_installation
            .as_ref()
            .ok_or_else(|| format!("{} is not installed in the detected Node.js runtime.", MCP_PACKAGE_NAME))?;
        match &installation.package_manager {
            McpPackageManager::Pnpm { command_path, pnpm_home, global_dir } => {
                let global_dir = global_dir.as_os_str().to_os_string();
                run_package_manager_command(
                    command_path,
                    &[
                        OsString::from("remove"),
                        OsString::from("-g"),
                        OsString::from(MCP_PACKAGE_NAME),
                        OsString::from("--global-dir"),
                        global_dir,
                    ],
                    &self.node_launcher_path,
                    pnpm_home,
                )
            }
            McpPackageManager::PnpmUnavailable { pnpm_home, global_dir } => Err(format!(
                "Cannot safely uninstall {} from {} because no pnpm executable was found next to its launcher in {}.",
                MCP_PACKAGE_NAME,
                global_dir.display(),
                pnpm_home.display()
            )),
            McpPackageManager::Unmanaged { launcher_dir } => Err(format!(
                "Cannot safely uninstall {} because the package manager for the launcher in {} could not be verified.",
                MCP_PACKAGE_NAME,
                launcher_dir.display()
            )),
            McpPackageManager::Npm => self.npm_output(&["uninstall", "-g", MCP_PACKAGE_NAME]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct NodeVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

#[tauri::command]
pub async fn check_mcp_server_status(app: AppHandle) -> Result<McpServerStatus, String> {
    let default_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let data_dir = crate::data_dir::resolve_data_dir_with_mode(default_data_dir).custom_data_dir().map(path_string);
    let local_status = tauri::async_runtime::spawn_blocking(resolve_node_runtime);
    let latest_version = fetch_latest_mcp_version();
    let (local_status, latest_version) = tokio::join!(local_status, latest_version);
    let runtime = local_status.map_err(|err| err.to_string())?;
    let installation = runtime.as_ref().and_then(|runtime| runtime.mcp_installation.as_ref());
    let installation_status = mcp_installation_status_fields(runtime.as_ref());
    let npm_available = runtime.is_some();
    let node_path = runtime.as_ref().map(|runtime| path_string(&runtime.node_path));
    let node_version = runtime.as_ref().map(|runtime| runtime.node_version.clone());
    let current_version = installation_status.current_version;
    let latest_version = latest_version.ok();
    let update_available = current_version
        .as_deref()
        .zip(latest_version.as_deref())
        .is_some_and(|(current, latest)| dbx_core::update::is_newer_version(latest, current));
    let error = match (runtime.as_ref(), installation) {
        (None, _) => {
            Some(format!("Unable to resolve a compatible Node.js ({}) and npm runtime.", MCP_MIN_NODE_VERSION_REQUIREMENT))
        }
        (
            Some(_),
            Some(McpInstallation {
                package_manager: McpPackageManager::PnpmUnavailable { pnpm_home, global_dir },
                ..
            }),
        ) => {
            Some(format!(
                "{} is installed in {}, but automatic update and uninstall are disabled because pnpm was not found in {}.",
                MCP_PACKAGE_NAME,
                global_dir.display(),
                pnpm_home.display()
            ))
        }
        (
            Some(_),
            Some(McpInstallation {
                package_manager: McpPackageManager::Unmanaged { launcher_dir },
                ..
            }),
        ) => Some(format!(
            "{} is installed, but automatic update and uninstall are disabled because the package manager for {} could not be verified.",
            MCP_PACKAGE_NAME,
            launcher_dir.display()
        )),
        _ => None,
    };

    Ok(McpServerStatus {
        installed: installation_status.installed,
        npm_available,
        node_path,
        node_version,
        current_version,
        latest_version,
        update_available,
        bin_path: installation_status.bin_path,
        native_bin_path: installation_status.native_bin_path,
        script_path: installation_status.script_path,
        data_dir,
        install_command: MCP_INSTALL_COMMAND.to_string(),
        update_command: runtime.as_ref().map(NodeRuntime::update_command).unwrap_or(MCP_INSTALL_COMMAND).to_string(),
        uninstall_command: runtime
            .as_ref()
            .map(NodeRuntime::uninstall_command)
            .unwrap_or(MCP_UNINSTALL_COMMAND)
            .to_string(),
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
        let output = runtime.install_or_update()?;

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
        let installation = installed.mcp_installation.as_ref().ok_or_else(|| {
            format!(
                "Installation completed, but {} was not found under {}.",
                MCP_PACKAGE_NAME,
                installed.npm_root.display()
            )
        })?;
        Ok(format!("Successfully installed @dbx-app/mcp-server@{}", installation.package_version))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn uninstall_mcp_server() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let runtime = resolve_node_runtime().ok_or_else(|| {
            format!("Unable to resolve a compatible Node.js ({}) and npm runtime.", MCP_MIN_NODE_VERSION_REQUIREMENT)
        })?;
        if !runtime.has_mcp_package() {
            return Err(format!("{} is not installed in the detected Node.js runtime.", MCP_PACKAGE_NAME));
        }

        let output = runtime.uninstall()?;
        if !output.success {
            let error_msg = if !output.stderr.is_empty() { output.stderr } else { output.stdout };
            return Err(format!("Uninstallation failed: {}", error_msg));
        }

        if runtime.refresh().is_some_and(|refreshed| refreshed.has_mcp_package()) {
            return Err(format!("Uninstallation completed, but {} is still installed.", MCP_PACKAGE_NAME));
        }
        Ok(format!("Successfully uninstalled {}", MCP_PACKAGE_NAME))
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
    if let Some(command) = runtime.as_ref().and_then(mcp_command_for_runtime) {
        return Some(command);
    }

    let path_shim = locate_mcp_bin();
    resolve_mise_mcp_command_from_path(runtime.as_ref(), path_shim.as_deref())
        .or_else(|| resolve_managed_mcp_command(runtime.as_ref(), || path_shim))
}

fn resolve_mise_mcp_command_from_path(
    runtime: Option<&NodeRuntime>,
    shim_path: Option<&Path>,
) -> Option<(String, Vec<String>)> {
    let shim_path = shim_path?;
    if !is_shims_command_path(shim_path) {
        return None;
    }
    let mise_path = locate_command("mise").map(PathBuf::from).and_then(|path| canonical_runtime_path(&path))?;
    resolve_mise_mcp_command(runtime, Some(shim_path), |command| mise_which_path(&mise_path, command))
}

fn resolve_mise_mcp_command(
    runtime: Option<&NodeRuntime>,
    shim_path: Option<&Path>,
    mut resolve_mise_command: impl FnMut(&str) -> Option<PathBuf>,
) -> Option<(String, Vec<String>)> {
    let runtime = runtime?;
    if !is_mcp_compatible_node_version(&runtime.node_version) {
        return None;
    }
    let shim_path = shim_path?;
    if !is_shims_command_path(shim_path) {
        return None;
    }

    let runtime_node = canonical_runtime_path(&runtime.node_path)?;
    let mise_node = resolve_mise_command("node").and_then(|path| canonical_runtime_path(&path))?;
    if runtime_node != mise_node {
        return None;
    }

    let shim_path = canonical_runtime_path(shim_path)?;
    let script_path = resolve_mise_command("dbx-mcp-server").and_then(|path| canonical_runtime_path(&path))?;
    if script_path == shim_path {
        return None;
    }
    let (_, package) = mcp_package_from_script(&script_path)?;
    let node_version = parse_node_version(&runtime.node_version)?;
    if !mcp_package_supports_node(&package, node_version) {
        return None;
    }

    Some((path_string(&runtime_node), vec![path_string(&package.script_path)]))
}

fn is_shims_command_path(path: &Path) -> bool {
    path.is_file() && path.parent().and_then(Path::file_name).is_some_and(|name| name.eq_ignore_ascii_case("shims"))
}

fn mise_which_path(mise_path: &Path, command: &str) -> Option<PathBuf> {
    let output = direct_command_stdout(mise_path, &["which", command]).ok()?;
    first_non_empty_line(output).and_then(|path| canonical_runtime_path(Path::new(&path)))
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
    let path_package = discover_path_mcp_package();
    let mut seen = HashSet::new();
    let mut fallback = None;

    if let Some(runtime) =
        probe_runtime_candidate(current_path_node_candidate(), path_package.as_ref(), &mut seen, &mut fallback)
    {
        return Some(runtime);
    }
    if let Some(runtime) =
        probe_runtime_candidate(user_shell_node_candidate(), path_package.as_ref(), &mut seen, &mut fallback)
    {
        return Some(runtime);
    }
    for dir in common_node_dirs() {
        if let Some(runtime) =
            probe_runtime_candidate(node_candidate_in_dir(&dir), path_package.as_ref(), &mut seen, &mut fallback)
        {
            return Some(runtime);
        }
    }

    fallback
}

fn probe_runtime_candidate(
    candidate: Option<NodeRuntimeCandidate>,
    path_package: Option<&LocatedMcpPackage>,
    seen: &mut HashSet<PathBuf>,
    fallback: &mut Option<NodeRuntime>,
) -> Option<NodeRuntime> {
    let candidate = candidate?;
    let identity = canonical_runtime_path(&candidate.node_path).unwrap_or_else(|| candidate.node_path.clone());
    if !seen.insert(identity) {
        return None;
    }

    let runtime = NodeRuntime::probe_with_path_package(candidate, path_package)?;
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

#[cfg(not(windows))]
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

fn find_npm_cli(node_path: &Path, launcher_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = launcher_dir.map(npm_cli_candidates_in_dir).unwrap_or_default();
    candidates.extend(npm_cli_candidates(node_path));
    let mut seen = HashSet::new();

    candidates.into_iter().find_map(|candidate| {
        let script_path = node_script_from_launcher(&candidate)?;
        if !seen.insert(script_path.clone()) || npm_stdout(node_path, &script_path, &["--version"]).is_err() {
            return None;
        }
        Some(script_path)
    })
}

fn npm_cli_candidates(node_path: &Path) -> Vec<PathBuf> {
    node_path.parent().map(npm_cli_candidates_in_dir).unwrap_or_default()
}

fn npm_cli_candidates_in_dir(dir: &Path) -> Vec<PathBuf> {
    vec![
        dir.join("npm"),
        dir.join("npm.cmd"),
        dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"),
        dir.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"),
        dir.join("..").join("node_modules").join("npm").join("bin").join("npm-cli.js"),
    ]
}

fn is_native_npm_launcher(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("cmd" | "bat" | "exe" | "com" | "ps1")
    )
}

fn node_script_from_launcher(path: &Path) -> Option<PathBuf> {
    let canonical = canonical_runtime_path(path)?;
    if let Some(target) = generated_node_shim_target(&canonical) {
        return Some(target);
    }
    if is_native_npm_launcher(&canonical) || is_shell_script(&canonical) {
        return None;
    }
    Some(canonical)
}

fn generated_node_shim_target(path: &Path) -> Option<PathBuf> {
    if std::fs::metadata(path).ok()?.len() > 128 * 1024 {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let uses_basedir = (content.starts_with("#!/bin/sh") && content.contains("basedir=$(dirname"))
        || (content.starts_with("#!/usr/bin/env pwsh") && content.contains("$basedir=Split-Path"));
    let relative_target = if uses_basedir {
        generated_shim_relative_target(&content, "$basedir/")
    } else if content.trim_start().starts_with("@SETLOCAL") && content.contains("%~dp0") {
        generated_shim_relative_target(&content, "%~dp0")
    } else {
        None
    }?;
    let target = join_launcher_relative_path(path.parent()?, relative_target)?;
    canonical_runtime_path(&target)
}

fn generated_shim_relative_target<'a>(content: &'a str, base_variable: &str) -> Option<&'a str> {
    content.lines().rev().find_map(|line| {
        quoted_values(line).into_iter().rev().find_map(|value| {
            let relative = strip_ascii_prefix(value, base_variable)?;
            relative.to_ascii_lowercase().ends_with(".js").then_some(relative)
        })
    })
}

fn mcp_installation_status_fields(runtime: Option<&NodeRuntime>) -> McpInstallationStatusFields {
    let installation = runtime.and_then(|runtime| runtime.mcp_installation.as_ref());
    McpInstallationStatusFields {
        installed: installation.is_some(),
        current_version: installation.map(|installation| installation.package_version.clone()),
        bin_path: installation
            .and_then(|installation| installation.launcher_path.as_ref())
            .map(|path| path_string(path)),
        native_bin_path: installation
            .and_then(|installation| installation.native_bin_path.as_ref())
            .map(|path| path_string(path)),
        script_path: installation.map(|installation| path_string(&installation.script_path)),
    }
}

fn quoted_values(line: &str) -> Vec<&str> {
    line.split('"').skip(1).step_by(2).collect()
}

fn strip_ascii_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let candidate = value.get(..prefix.len())?;
    candidate.eq_ignore_ascii_case(prefix).then(|| &value[prefix.len()..])
}

fn join_launcher_relative_path(base: &Path, relative: &str) -> Option<PathBuf> {
    let mut target = base.to_path_buf();
    for component in relative.trim_start_matches(['/', '\\']).split(['/', '\\']) {
        match component {
            "" | "." => {}
            ".." => target.push(".."),
            value if value.contains(':') || value.contains('\0') => return None,
            value => target.push(value),
        }
    }
    Some(target)
}

fn is_shell_script(path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let Some(first_line) = content.lines().next() else {
        return false;
    };
    first_line.starts_with("#!") && ["/sh", "/bash", "/zsh", "/fish"].iter().any(|shell| first_line.contains(shell))
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

fn run_package_manager_command(
    command_path: &Path,
    args: &[OsString],
    node_launcher_path: &Path,
    pnpm_home: &Path,
) -> Result<CommandOutput, String> {
    let mut command = dbx_core::process::new_std_command(command_path);
    command.args(args);
    let mut paths = command_path.parent().into_iter().map(Path::to_path_buf).collect::<Vec<_>>();
    if let Some(node_dir) = node_launcher_path.parent() {
        paths.push(node_dir.to_path_buf());
    }
    if let Some(current_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current_path));
    }
    if let Ok(path) = env::join_paths(paths) {
        command.env("PATH", path);
    }
    command.env("PNPM_HOME", pnpm_home);
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
    if value.get("name").and_then(serde_json::Value::as_str)? != MCP_PACKAGE_NAME {
        return None;
    }
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
    let version = value.get("version").and_then(serde_json::Value::as_str)?.to_owned();
    let minimum_node_version =
        value.pointer("/engines/node").and_then(serde_json::Value::as_str).and_then(parse_minimum_node_version)?;
    Some(McpPackage { version, script_path, minimum_node_version })
}

fn preferred_mcp_package(
    primary: Option<LocatedMcpPackage>,
    secondary: Option<LocatedMcpPackage>,
    node_version: &str,
) -> Option<LocatedMcpPackage> {
    let node_version = parse_node_version(node_version)?;
    match (primary, secondary) {
        (Some(primary), Some(secondary)) => {
            if mcp_package_supports_node(&primary.package, node_version) {
                Some(primary)
            } else if mcp_package_supports_node(&secondary.package, node_version) {
                Some(secondary)
            } else {
                Some(primary)
            }
        }
        (primary, secondary) => primary.or(secondary),
    }
}

fn mcp_package_supports_node(package: &McpPackage, node_version: NodeVersion) -> bool {
    node_version >= package.minimum_node_version
}

fn mcp_package_from_command_dir(dir: &Path) -> Option<LocatedMcpPackage> {
    ["dbx-mcp-server", "mcp-server"].into_iter().find_map(|command| {
        command_file_names(command).into_iter().map(|name| dir.join(name)).find_map(|path| {
            if !path.is_file() {
                return None;
            }
            mcp_package_from_command_path(&path)
        })
    })
}

fn mcp_package_from_command_path(command_path: &Path) -> Option<LocatedMcpPackage> {
    let bin_path = canonical_runtime_path(command_path)?;
    let script_path = node_script_from_launcher(&bin_path)?;
    let (package_root, package) = mcp_package_from_script(&script_path)?;
    let launcher_dir = bin_path.parent()?.to_path_buf();
    let package_manager = pnpm_global_dir(&package_root, &launcher_dir)
        .map(|global_dir| {
            pnpm_command_near(&launcher_dir)
                .map(|command_path| McpPackageManager::Pnpm {
                    command_path,
                    pnpm_home: launcher_dir.clone(),
                    global_dir: global_dir.clone(),
                })
                .unwrap_or(McpPackageManager::PnpmUnavailable { pnpm_home: launcher_dir.clone(), global_dir })
        })
        .unwrap_or(McpPackageManager::Unmanaged { launcher_dir });
    Some(LocatedMcpPackage { package_root, package, bin_path: Some(bin_path), package_manager })
}

fn pnpm_global_dir(package_root: &Path, launcher_dir: &Path) -> Option<PathBuf> {
    let virtual_store = package_root
        .ancestors()
        .find(|ancestor| ancestor.file_name().is_some_and(|name| name.eq_ignore_ascii_case(".pnpm")))?;
    let global_dir = virtual_store.parent()?.to_path_buf();
    if !package_root.starts_with(virtual_store) || launcher_dir.starts_with(&global_dir) {
        return None;
    }
    let manifest = std::fs::read_to_string(global_dir.join("package.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    manifest
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
        .and_then(|dependencies| dependencies.get(MCP_PACKAGE_NAME))
        .and_then(serde_json::Value::as_str)
        .filter(|requirement| !requirement.trim().is_empty())
        .map(|_| global_dir)
}

fn mcp_package_from_script(script_path: &Path) -> Option<(PathBuf, McpPackage)> {
    let script_path = canonical_runtime_path(script_path)?;
    for ancestor in script_path.ancestors().skip(1) {
        if !ancestor.ends_with(Path::new(MCP_PACKAGE_NAME)) {
            continue;
        }
        let package = mcp_package(ancestor)?;
        if package.script_path == script_path {
            return Some((canonical_runtime_path(ancestor)?, package));
        }
    }
    None
}

fn pnpm_command_near(dir: &Path) -> Option<PathBuf> {
    [Some(dir), dir.parent()].into_iter().flatten().find_map(|candidate_dir| {
        command_file_names("pnpm").into_iter().map(|name| candidate_dir.join(name)).find(|path| path.is_file())
    })
}

fn discover_path_mcp_package() -> Option<LocatedMcpPackage> {
    let launcher = locate_mcp_bin()?;
    let package = mcp_package_from_command_path(&launcher);
    if package.is_none() {
        log::warn!("Ignoring unbound MCP package shim at {}", launcher.display());
    }
    package
}

fn bind_mcp_installation(
    located: LocatedMcpPackage,
    node_path: &Path,
    node_version: &str,
    npm_root: &Path,
) -> Option<McpInstallation> {
    let parsed_node_version = parse_node_version(node_version)?;
    if !mcp_package_supports_node(&located.package, parsed_node_version) {
        log::warn!(
            "Ignoring MCP package at {} because Node.js {} does not satisfy its engine requirement",
            located.package_root.display(),
            node_version
        );
        return None;
    }
    let native_bin_path =
        mcp_native_binary_path(&located.package_root, npm_root, &located.package_manager, &located.package.version);
    Some(McpInstallation {
        package_root: located.package_root,
        launcher_path: located.bin_path,
        script_path: located.package.script_path,
        node_path: node_path.to_path_buf(),
        node_version: node_version.to_string(),
        package_version: located.package.version,
        package_manager: located.package_manager,
        native_bin_path,
    })
}

fn mcp_native_binary_path(
    package_root: &Path,
    npm_root: &Path,
    package_manager: &McpPackageManager,
    package_version: &str,
) -> Option<PathBuf> {
    let (package_name, binary_name) = mcp_native_package()?;
    mcp_native_binary_path_for(package_root, npm_root, package_manager, package_version, package_name, binary_name)
}

fn mcp_native_binary_path_for(
    package_root: &Path,
    npm_root: &Path,
    package_manager: &McpPackageManager,
    package_version: &str,
    package_name: &str,
    binary_name: &str,
) -> Option<PathBuf> {
    let package_root = canonical_runtime_path(package_root)?;
    let (boundary, allow_hoisted) = match package_manager {
        McpPackageManager::Npm => {
            let npm_root = canonical_runtime_path(npm_root)?;
            if package_root != canonical_runtime_path(&npm_root.join(MCP_PACKAGE_NAME))? {
                return None;
            }
            (npm_root, true)
        }
        McpPackageManager::Pnpm { global_dir, .. } | McpPackageManager::PnpmUnavailable { global_dir, .. } => {
            (canonical_runtime_path(global_dir)?, false)
        }
        McpPackageManager::Unmanaged { .. } => (package_root.clone(), false),
    };
    let mut candidates = vec![package_root.join("node_modules").join(package_name)];
    if allow_hoisted {
        candidates.push(npm_root.join(package_name));
    }
    candidates.into_iter().find_map(|native_package_root| {
        let native_package_root = canonical_runtime_path(&native_package_root)?;
        if !native_package_root.starts_with(&boundary) {
            return None;
        }
        let manifest = std::fs::read_to_string(native_package_root.join("package.json")).ok()?;
        let manifest: serde_json::Value = serde_json::from_str(&manifest).ok()?;
        if manifest.get("name").and_then(serde_json::Value::as_str) != Some(package_name)
            || manifest.get("version").and_then(serde_json::Value::as_str) != Some(package_version)
        {
            return None;
        }
        let binary = canonical_runtime_path(&native_package_root.join("bin").join(binary_name))?;
        binary.starts_with(&boundary).then_some(binary)
    })
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
    let installation = runtime.mcp_installation.as_ref()?;
    if installation.node_path != runtime.node_path
        || installation.node_version != runtime.node_version
        || !installation.script_path.starts_with(&installation.package_root)
    {
        return None;
    }
    Some((path_string(&installation.node_path), vec![path_string(&installation.script_path)]))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[allow(clippy::needless_return)]
pub(crate) fn locate_command(command: &str) -> Option<String> {
    #[cfg(windows)]
    {
        locate_windows_command(command)
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

#[allow(clippy::needless_return)]
fn command_output(command: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let direct = run_command(command, args);
    if direct.as_ref().is_ok_and(|output| output.success) {
        return direct;
    }

    #[cfg(windows)]
    {
        run_windows_command_candidates(command, args).or(direct)
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
    let mut output = run_command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])?;
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
    use super::{bash_login_script, prefixed_output_path, NodeRuntimeCandidate};
    use super::{
        bind_mcp_installation, canonical_runtime_path, is_mcp_compatible_node_version, mcp_command_for_runtime,
        mcp_installation_status_fields, mcp_native_binary_path_for, mcp_package, mcp_package_from_command_path,
        node_script_from_launcher, normalized_reported_path, npm_cli_candidates, parse_minimum_node_version,
        parse_node_version, prefer_runtime, require_managed_mcp_command, resolve_managed_mcp_command,
        resolve_mise_mcp_command, stdout_after_shell_marker, McpInstallation, McpPackageManager, NodeRuntime,
        NodeVersion, MCP_MIN_NODE_VERSION_REQUIREMENT, MCP_PACKAGE_NAME, SHELL_COMMAND_MARKER,
    };
    #[cfg(not(windows))]
    use super::{shell_command_script, shell_quote};
    use std::path::PathBuf;

    const PNPM_10_27_POSIX_SHIM: &str = include_str!("../../tests/fixtures/pnpm/10.27.0/dbx-mcp-server");
    const PNPM_10_27_CMD_SHIM: &str = include_str!("../../tests/fixtures/pnpm/10.27.0/dbx-mcp-server.cmd");
    const PNPM_10_27_POWERSHELL_SHIM: &str = include_str!("../../tests/fixtures/pnpm/10.27.0/dbx-mcp-server.ps1");

    struct PnpmFixture {
        root: PathBuf,
        pnpm_home: PathBuf,
        launcher_path: PathBuf,
        pnpm_path: PathBuf,
        package_root: PathBuf,
        script_path: PathBuf,
        global_dir: PathBuf,
    }

    impl Drop for PnpmFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn pnpm_fixture(launcher_name: &str, launcher: &str) -> PnpmFixture {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dbx-pnpm-10-27-fixture-{}-{nonce}", std::process::id()));
        let pnpm_home = root.join("pnpm-home");
        let launcher_path = pnpm_home.join(launcher_name);
        let pnpm_path = pnpm_home.join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" });
        let global_dir = root.join("global").join("5");
        let package_root = global_dir
            .join(".pnpm")
            .join("@dbx-app+mcp-server@0.4.71")
            .join("node_modules")
            .join("@dbx-app")
            .join("mcp-server");
        let script_path = package_root.join("bin").join("dbx-mcp-server.js");

        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&pnpm_home).unwrap();
        std::fs::write(&launcher_path, launcher).unwrap();
        std::fs::write(&pnpm_path, "pnpm 10.27.0 fixture\n").unwrap();
        std::fs::write(&script_path, "// @dbx-app/mcp-server fixture\n").unwrap();
        std::fs::write(global_dir.join("package.json"), r#"{"dependencies":{"@dbx-app/mcp-server":"^0.4.71"}}"#)
            .unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.71","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        PnpmFixture { root, pnpm_home, launcher_path, pnpm_path, package_root, script_path, global_dir }
    }

    fn runtime_for_installation(installation: McpInstallation, npm_root: PathBuf) -> NodeRuntime {
        NodeRuntime {
            node_launcher_path: installation.node_path.clone(),
            node_path: installation.node_path.clone(),
            npm_cli_path: installation.node_path.with_file_name("npm-cli.js"),
            npm_root,
            node_version: installation.node_version.clone(),
            mcp_installation: Some(installation),
        }
    }

    fn runtime(node_path: &str, script_path: Option<&str>) -> NodeRuntime {
        runtime_with_version_and_root(node_path, &format!("{node_path}-root"), script_path, "v24.16.0")
    }

    fn runtime_with_version_and_root(
        node_path: &str,
        npm_root: &str,
        script_path: Option<&str>,
        node_version: &str,
    ) -> NodeRuntime {
        let node_path = PathBuf::from(node_path);
        let npm_root = PathBuf::from(npm_root);
        let mcp_installation = script_path.map(|script_path| McpInstallation {
            package_root: npm_root.join(MCP_PACKAGE_NAME),
            launcher_path: None,
            script_path: PathBuf::from(script_path),
            node_path: node_path.clone(),
            node_version: node_version.to_string(),
            package_version: "0.4.29".to_string(),
            package_manager: McpPackageManager::Npm,
            native_bin_path: None,
        });
        NodeRuntime {
            node_launcher_path: node_path.clone(),
            npm_cli_path: PathBuf::from(format!("{}-npm-cli.js", node_path.display())),
            node_path,
            npm_root,
            node_version: node_version.to_string(),
            mcp_installation,
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
    #[cfg(not(windows))]
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
        assert_eq!(
            selected.mcp_installation.as_ref().map(|installation| &installation.script_path),
            installed.mcp_installation.as_ref().map(|installation| &installation.script_path)
        );
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
        assert_eq!(
            selected.mcp_installation.as_ref().map(|installation| &installation.script_path),
            compatible_runtime.mcp_installation.as_ref().map(|installation| &installation.script_path)
        );
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
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.38","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        let current = mcp_package(&dir).unwrap();
        assert_eq!(current.version, "0.4.38");
        assert_eq!(current.script_path, canonical_runtime_path(&current_entry).unwrap());
        assert_eq!(current.minimum_node_version, NodeVersion { major: 18, minor: 18, patch: 0 });

        let legacy_entry = dir.join("dist").join("index.js");
        std::fs::create_dir_all(legacy_entry.parent().unwrap()).unwrap();
        std::fs::write(&legacy_entry, "// legacy server\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.32","bin":{"dbx-mcp-server":"dist/index.js"},"engines":{"node":">=22.13.0"}}"#,
        )
        .unwrap();

        let legacy = mcp_package(&dir).unwrap();
        assert_eq!(legacy.version, "0.4.32");
        assert_eq!(legacy.script_path, canonical_runtime_path(&legacy_entry).unwrap());
        assert_eq!(legacy.minimum_node_version, NodeVersion { major: 22, minor: 13, patch: 0 });

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mcp_package_from_script_rejects_undeclared_entry() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx-mcp-script-entry-test-{}-{nonce}", std::process::id()));
        let package_root = dir.join("@dbx-app").join("mcp-server");
        let declared_entry = package_root.join("bin").join("dbx-mcp-server.js");
        let undeclared_entry = package_root.join("bin").join("other.js");

        std::fs::create_dir_all(declared_entry.parent().unwrap()).unwrap();
        std::fs::write(&declared_entry, "// declared entry\n").unwrap();
        std::fs::write(&undeclared_entry, "// undeclared entry\n").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.44","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        assert!(super::mcp_package_from_script(&declared_entry).is_some());
        assert!(super::mcp_package_from_script(&undeclared_entry).is_none());

        let _ = std::fs::remove_dir_all(dir);
    }

    fn assert_real_pnpm_launcher(launcher_name: &str, launcher: &str) {
        let fixture = pnpm_fixture(launcher_name, launcher);

        assert_ne!(fixture.pnpm_home, fixture.global_dir);
        assert_eq!(node_script_from_launcher(&fixture.launcher_path), canonical_runtime_path(&fixture.script_path));
        let located = mcp_package_from_command_path(&fixture.launcher_path).unwrap();
        assert_eq!(located.package_root, canonical_runtime_path(&fixture.package_root).unwrap());
        assert_eq!(located.package.version, "0.4.71");
        assert!(matches!(
            located.package_manager,
            McpPackageManager::Pnpm {
                ref command_path,
                ref pnpm_home,
                ref global_dir,
            } if command_path == &fixture.pnpm_path
                && pnpm_home == &canonical_runtime_path(&fixture.pnpm_home).unwrap()
                && global_dir == &canonical_runtime_path(&fixture.global_dir).unwrap()
        ));
    }

    #[test]
    fn parses_real_pnpm_10_27_posix_global_shim() {
        assert_real_pnpm_launcher("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
    }

    #[test]
    fn parses_real_pnpm_10_27_windows_cmd_global_shim() {
        assert_real_pnpm_launcher("dbx-mcp-server.cmd", PNPM_10_27_CMD_SHIM);
    }

    #[test]
    fn parses_real_pnpm_10_27_windows_powershell_global_shim() {
        assert_real_pnpm_launcher("dbx-mcp-server.ps1", PNPM_10_27_POWERSHELL_SHIM);
    }

    #[test]
    fn rejects_private_marker_and_unrecognized_shell_launcher() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dbx-mcp-unrecognized-shim-{}-{nonce}", std::process::id()));
        let target = root.join("target.js");
        let launcher = root.join("dbx-mcp-server");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&target, "// untrusted target\n").unwrap();
        std::fs::write(&launcher, format!("#!/bin/sh\nexit 1\n# cmd-shim-target={}\n", target.display())).unwrap();

        assert!(node_script_from_launcher(&launcher).is_none());

        let _ = std::fs::remove_dir_all(root);
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
        std::fs::write(
            nested_binary.parent().unwrap().parent().unwrap().join("package.json"),
            r#"{"name":"@dbx-app/mcp-win32-x64","version":"0.4.71"}"#,
        )
        .unwrap();

        assert_eq!(
            mcp_native_binary_path_for(
                &package_root,
                &npm_root,
                &McpPackageManager::Npm,
                "0.4.71",
                package_name,
                binary_name,
            ),
            canonical_runtime_path(&nested_binary)
        );

        std::fs::remove_dir_all(nested_binary.parent().unwrap().parent().unwrap()).unwrap();
        let hoisted_binary = npm_root.join(package_name).join("bin").join(binary_name);
        std::fs::create_dir_all(hoisted_binary.parent().unwrap()).unwrap();
        std::fs::write(&hoisted_binary, "hoisted binary").unwrap();
        std::fs::write(
            hoisted_binary.parent().unwrap().parent().unwrap().join("package.json"),
            r#"{"name":"@dbx-app/mcp-win32-x64","version":"0.4.71"}"#,
        )
        .unwrap();

        assert_eq!(
            mcp_native_binary_path_for(
                &package_root,
                &npm_root,
                &McpPackageManager::Npm,
                "0.4.71",
                package_name,
                binary_name,
            ),
            canonical_runtime_path(&hoisted_binary)
        );

        assert_eq!(
            mcp_native_binary_path_for(
                &package_root,
                &npm_root,
                &McpPackageManager::Npm,
                "0.4.72",
                package_name,
                binary_name,
            ),
            None
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mcp_command_binds_script_to_the_installation_node() {
        let script_path = "/runtime/node-24-root/@dbx-app/mcp-server/dist/index.js";
        let installed = runtime("/runtime/node-24", Some(script_path));

        let command = mcp_command_for_runtime(&installed).unwrap();

        assert_eq!(command.0, "/runtime/node-24");
        assert_eq!(command.1, vec![script_path]);
    }

    #[test]
    fn mcp_command_resolves_native_mise_shim_to_declared_package_entry() {
        use std::cell::Cell;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("dbx mise shim test {} {nonce}", std::process::id()));
        let shim_dir = dir.join("mise").join("shims");
        let shim_path = shim_dir.join("dbx-mcp-server.exe");
        let node_path = dir.join("mise").join("installs").join("node").join("22.23.1").join("node.exe");
        let package_root = dir
            .join("mise")
            .join("installs")
            .join("npm-db-server")
            .join("node_modules")
            .join("@dbx-app")
            .join("mcp-server");
        let script_path = package_root.join("bin").join("dbx-mcp-server.js");

        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::create_dir_all(node_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&shim_path, "native mise shim\n").unwrap();
        std::fs::write(&node_path, "real node runtime\n").unwrap();
        std::fs::write(&script_path, "// declared MCP entry\n").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.44","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        assert!(super::node_script_from_launcher(&shim_path).is_none());
        let node_path = canonical_runtime_path(&node_path).unwrap();
        let script_path = canonical_runtime_path(&script_path).unwrap();
        let compatible_runtime = runtime_with_version_and_root(
            node_path.to_string_lossy().as_ref(),
            dir.join("npm-root").to_string_lossy().as_ref(),
            None,
            "v22.23.1",
        );

        let command = resolve_mise_mcp_command(Some(&compatible_runtime), Some(&shim_path), |command| match command {
            "node" => Some(node_path.clone()),
            "dbx-mcp-server" => Some(script_path.clone()),
            _ => None,
        })
        .unwrap();

        assert_eq!(command.0, node_path.to_string_lossy());
        assert_eq!(command.1, vec![script_path.to_string_lossy()]);

        let wrong_node = dir.join("other-node.exe");
        std::fs::write(&wrong_node, "wrong node runtime\n").unwrap();
        assert!(resolve_mise_mcp_command(Some(&compatible_runtime), Some(&shim_path), |command| match command {
            "node" => Some(wrong_node.clone()),
            "dbx-mcp-server" => Some(script_path.clone()),
            _ => None,
        })
        .is_none());

        let old_runtime = runtime_with_version_and_root(
            node_path.to_string_lossy().as_ref(),
            dir.join("old-npm-root").to_string_lossy().as_ref(),
            None,
            "v18.17.1",
        );
        assert!(resolve_mise_mcp_command(Some(&old_runtime), Some(&shim_path), |command| match command {
            "node" => Some(node_path.clone()),
            "dbx-mcp-server" => Some(script_path.clone()),
            _ => None,
        })
        .is_none());

        assert!(resolve_mise_mcp_command(Some(&compatible_runtime), Some(&shim_path), |_| None).is_none());
        let unrelated_script = package_root.join("bin").join("other.js");
        std::fs::write(&unrelated_script, "// not the declared entry\n").unwrap();
        assert!(resolve_mise_mcp_command(Some(&compatible_runtime), Some(&shim_path), |command| match command {
            "node" => Some(node_path.clone()),
            "dbx-mcp-server" => Some(unrelated_script.clone()),
            _ => None,
        })
        .is_none());

        let ordinary_bin = dir.join("bin");
        let ordinary_shim = ordinary_bin.join("dbx-mcp-server.exe");
        std::fs::create_dir_all(&ordinary_bin).unwrap();
        std::fs::write(&ordinary_shim, "ordinary native shim\n").unwrap();
        let resolver_calls = Cell::new(0);
        assert!(resolve_mise_mcp_command(Some(&compatible_runtime), Some(&ordinary_shim), |_| {
            resolver_calls.set(resolver_calls.get() + 1);
            None
        })
        .is_none());
        assert_eq!(resolver_calls.get(), 0);

        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.44","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=23.0.0"}}"#,
        )
        .unwrap();
        assert!(resolve_mise_mcp_command(Some(&compatible_runtime), Some(&shim_path), |command| match command {
            "node" => Some(node_path.clone()),
            "dbx-mcp-server" => Some(script_path.clone()),
            _ => None,
        })
        .is_none());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn local_pnpm_project_shim_is_not_treated_as_a_global_installation() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dbx-pnpm-local-fixture-{}-{nonce}", std::process::id()));
        let node_modules = root.join("project").join("node_modules");
        let launcher_dir = node_modules.join(".bin");
        let launcher_path = launcher_dir.join("dbx-mcp-server");
        let package_relative = ".pnpm/@dbx-app+mcp-server@0.4.71/node_modules/@dbx-app/mcp-server";
        let package_root = node_modules.join(package_relative);
        let script_path = package_root.join("bin").join("dbx-mcp-server.js");
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&launcher_dir).unwrap();
        std::fs::write(&script_path, "// local MCP fixture\n").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.71","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();
        std::fs::write(node_modules.join("package.json"), r#"{"dependencies":{"@dbx-app/mcp-server":"^0.4.71"}}"#)
            .unwrap();
        std::fs::write(launcher_dir.join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" }), "pnpm fixture\n").unwrap();
        std::fs::write(
            &launcher_path,
            format!(
                "#!/bin/sh\nbasedir=$(dirname \"$0\")\nexec node \"$basedir/../{package_relative}/bin/dbx-mcp-server.js\" \"$@\"\n"
            ),
        )
        .unwrap();

        let located = mcp_package_from_command_path(&launcher_path).unwrap();

        assert!(matches!(
            located.package_manager,
            McpPackageManager::Unmanaged { launcher_dir: ref detected_launcher_dir }
                if detected_launcher_dir == &canonical_runtime_path(&launcher_dir).unwrap()
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mcp_command_rejects_script_outside_installation_package_root() {
        let installed = runtime("/runtime/node-24", Some("/outside/@dbx-app/mcp-server/dist/index.js"));

        assert!(mcp_command_for_runtime(&installed).is_none());
    }

    #[test]
    fn npm_global_installation_keeps_existing_runtime_behavior() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dbx-mcp-npm-regression-{}-{nonce}", std::process::id()));
        let npm_root = root.join("lib").join("node_modules");
        let package_root = npm_root.join(MCP_PACKAGE_NAME);
        let script_path = package_root.join("bin").join("dbx-mcp-server.js");
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&script_path, "// npm global MCP\n").unwrap();
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.65","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();
        let located = super::LocatedMcpPackage {
            package_root: canonical_runtime_path(&package_root).unwrap(),
            package: mcp_package(&package_root).unwrap(),
            bin_path: None,
            package_manager: McpPackageManager::Npm,
        };
        let installation =
            bind_mcp_installation(located, PathBuf::from("/npm-runtime/node").as_path(), "v24.16.0", &npm_root)
                .unwrap();
        let runtime = runtime_for_installation(installation, npm_root);

        assert_eq!(runtime.update_command(), super::MCP_INSTALL_COMMAND);
        assert_eq!(runtime.uninstall_command(), super::MCP_UNINSTALL_COMMAND);
        assert!(matches!(
            runtime.mcp_installation.as_ref().map(|installation| &installation.package_manager),
            Some(McpPackageManager::Npm)
        ));
        assert_eq!(
            mcp_command_for_runtime(&runtime).unwrap().1,
            vec![super::path_string(&canonical_runtime_path(&script_path).unwrap())]
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn split_pnpm_installation_is_shared_by_status_launch_update_and_uninstall() {
        let fixture = pnpm_fixture("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
        let node_prefix = fixture.root.join("selected-node-runtime");
        let node_path = node_prefix.join(if cfg!(windows) { "node.exe" } else { "bin/node" });
        let npm_root = node_prefix.join("lib").join("node_modules");
        std::fs::create_dir_all(&npm_root).unwrap();
        std::fs::create_dir_all(node_path.parent().unwrap()).unwrap();
        std::fs::write(&node_path, "selected Node runtime\n").unwrap();
        let (native_package_name, native_binary_name) = super::mcp_native_package().unwrap();
        let unrelated_native_root = npm_root.join(native_package_name);
        let unrelated_native_binary = unrelated_native_root.join("bin").join(native_binary_name);
        std::fs::create_dir_all(unrelated_native_binary.parent().unwrap()).unwrap();
        std::fs::write(&unrelated_native_binary, "unrelated native binary\n").unwrap();
        std::fs::write(
            unrelated_native_root.join("package.json"),
            format!(r#"{{"name":"{native_package_name}","version":"0.4.71"}}"#),
        )
        .unwrap();

        let located = mcp_package_from_command_path(&fixture.launcher_path).unwrap();
        let node_path = canonical_runtime_path(&node_path).unwrap();
        let installation = bind_mcp_installation(located, &node_path, "v24.16.0", &npm_root).unwrap();
        let runtime = runtime_for_installation(installation, npm_root.clone());

        assert!(!fixture.pnpm_home.starts_with(&node_prefix));
        assert!(!runtime.mcp_installation.as_ref().unwrap().package_root.starts_with(&npm_root));
        assert!(runtime.has_mcp_package());
        let installation = runtime.mcp_installation.as_ref().unwrap();
        let status = mcp_installation_status_fields(Some(&runtime));
        assert!(status.installed);
        assert_eq!(status.current_version.as_deref(), Some("0.4.71"));
        assert_eq!(status.script_path, Some(super::path_string(&installation.script_path)));
        assert_eq!(installation.package_version, "0.4.71");
        assert_eq!(installation.script_path, canonical_runtime_path(&fixture.script_path).unwrap());
        assert_eq!(installation.launcher_path, canonical_runtime_path(&fixture.launcher_path));
        assert_eq!(installation.native_bin_path, None);
        assert_eq!(runtime.update_command(), super::MCP_PNPM_UPDATE_COMMAND);
        assert_eq!(runtime.uninstall_command(), super::MCP_PNPM_UNINSTALL_COMMAND);
        assert!(matches!(
            installation.package_manager,
            McpPackageManager::Pnpm {
                ref command_path,
                ref pnpm_home,
                ref global_dir,
            } if command_path == &fixture.pnpm_path
                && pnpm_home == &canonical_runtime_path(&fixture.pnpm_home).unwrap()
                && global_dir == &canonical_runtime_path(&fixture.global_dir).unwrap()
        ));

        let command = mcp_command_for_runtime(&runtime).unwrap();
        assert_eq!(command.0, node_path.to_string_lossy().to_string());
        assert_eq!(
            command.1,
            vec![canonical_runtime_path(&fixture.script_path).unwrap().to_string_lossy().to_string()]
        );
    }

    #[test]
    fn split_pnpm_without_verified_pnpm_disables_update_and_uninstall() {
        let fixture = pnpm_fixture("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
        std::fs::remove_file(&fixture.pnpm_path).unwrap();
        let located = mcp_package_from_command_path(&fixture.launcher_path).unwrap();
        let installation = bind_mcp_installation(
            located,
            PathBuf::from("/selected-runtime/node").as_path(),
            "v24.16.0",
            &fixture.root.join("unrelated-npm-root"),
        )
        .unwrap();
        let runtime = runtime_for_installation(installation, fixture.root.join("unrelated-npm-root"));

        assert!(matches!(
            runtime.mcp_installation.as_ref().map(|installation| &installation.package_manager),
            Some(McpPackageManager::PnpmUnavailable { .. })
        ));
        assert!(runtime.install_or_update().err().unwrap().contains("Cannot safely update"));
        assert!(runtime.uninstall().err().unwrap().contains("Cannot safely uninstall"));
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
    fn path_shim_rejects_wrong_package_identity() {
        let fixture = pnpm_fixture("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
        std::fs::write(
            fixture.package_root.join("package.json"),
            r#"{"name":"untrusted-package","version":"0.4.71","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        assert!(mcp_package_from_command_path(&fixture.launcher_path).is_none());
    }

    #[test]
    fn path_shim_rejects_package_bin_outside_package_root() {
        let fixture = pnpm_fixture("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
        std::fs::write(
            fixture.package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.71","bin":{"dbx-mcp-server":"../../outside.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();

        assert!(mcp_package_from_command_path(&fixture.launcher_path).is_none());
    }

    #[test]
    fn path_shim_rejects_incompatible_node_engine() {
        let fixture = pnpm_fixture("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
        std::fs::write(
            fixture.package_root.join("package.json"),
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.71","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=25.0.0"}}"#,
        )
        .unwrap();
        let located = mcp_package_from_command_path(&fixture.launcher_path).unwrap();

        assert!(bind_mcp_installation(located, PathBuf::from("/runtime/node-24").as_path(), "v24.16.0", &fixture.root)
            .is_none());
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
            r#"{"name":"@dbx-app/mcp-server","version":"0.4.38","bin":{"dbx-mcp-server":"bin/dbx-mcp-server.js"},"engines":{"node":">=18.18.0"}}"#,
        )
        .unwrap();
        let node_script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nprintf 'PATH=%s\\n' \"$PATH\" >> {}\n\
             if [ \"$1\" = '--version' ]; then printf 'v24.16.0\\n'; \
             elif [ \"$2\" = '--version' ]; then printf '10.9.2\\n'; \
             elif [ \"$2\" = 'root' ]; then printf '%s\\n' {}; \
             elif [ \"$2\" = 'prefix' ]; then printf '%s\\n' {}; \
             elif [ \"$2\" = 'install' ]; then exit 0; \
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

        let probed =
            NodeRuntime::probe_with_path_package(NodeRuntimeCandidate { node_path: node_alias.clone() }, None).unwrap();

        assert_eq!(probed.node_path, canonical_runtime_path(&node_path).unwrap());
        assert_eq!(probed.npm_root, canonical_runtime_path(&npm_root).unwrap());
        assert_eq!(probed.node_version, "v24.16.0");
        assert_eq!(
            probed.mcp_installation.as_ref().map(|installation| &installation.script_path),
            canonical_runtime_path(&script_path).as_ref()
        );
        assert!(matches!(
            probed.mcp_installation.as_ref().map(|installation| &installation.package_manager),
            Some(McpPackageManager::Npm)
        ));
        let install_output = probed.install_or_update().unwrap();
        assert!(install_output.success);
        let calls = std::fs::read_to_string(log_path).unwrap();
        assert!(calls.contains("npm root -g"));
        assert!(calls.contains("npm prefix -g"));
        assert!(calls
            .lines()
            .any(|line| line == format!("{} install -g @dbx-app/mcp-server@latest", npm_cli_path.display())));
        assert!(!calls.contains("--registry"));
        assert!(calls.contains(&format!("PATH={}", canonical_runtime_path(&dir).unwrap().display())));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn runtime_probe_resolves_pnpm_global_shims_and_update_command() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = pnpm_fixture("dbx-mcp-server", PNPM_10_27_POSIX_SHIM);
        let bin_dir = fixture.root.join("selected-node-runtime").join("bin");
        let npm_root = fixture.root.join("selected-node-runtime").join("lib").join("node_modules");
        let npm_prefix = fixture.root.join("selected-node-runtime");
        let npm_cli_path = bin_dir.join("npm");
        let node_path = fixture.root.join("selected-node-runtime").join("node-v24");
        let node_alias = bin_dir.join("node");
        let log_path = fixture.root.join("calls.log");
        let pnpm_log_path = fixture.root.join("pnpm.log");

        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&npm_root).unwrap();
        std::fs::write(&npm_cli_path, "// selected runtime npm cli\n").unwrap();
        let node_script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\n\
             if [ \"$1\" = '--version' ]; then printf 'v24.16.0\\n'; \
             elif [ \"$2\" = '--version' ]; then printf '11.16.0\\n'; \
             elif [ \"$2\" = 'root' ]; then printf '%s\\n' {}; \
             elif [ \"$2\" = 'prefix' ]; then printf '%s\\n' {}; \
             else exit 1; fi\n",
            shell_quote(log_path.to_string_lossy().as_ref()),
            shell_quote(npm_root.to_string_lossy().as_ref()),
            shell_quote(npm_prefix.to_string_lossy().as_ref())
        );
        std::fs::write(&node_path, node_script).unwrap();
        std::fs::write(
            &fixture.pnpm_path,
            format!(
                "#!/bin/sh\nprintf 'ARGS=%s\\nPNPM_HOME=%s\\nPATH=%s\\n' \"$*\" \"$PNPM_HOME\" \"$PATH\" > {}\n",
                shell_quote(pnpm_log_path.to_string_lossy().as_ref())
            ),
        )
        .unwrap();
        for executable in [&node_path, &fixture.pnpm_path] {
            let mut permissions = std::fs::metadata(executable).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(executable, permissions).unwrap();
        }
        symlink(&node_path, &node_alias).unwrap();

        let located = mcp_package_from_command_path(&fixture.launcher_path).unwrap();
        let probed = NodeRuntime::probe_with_path_package(
            NodeRuntimeCandidate { node_path: node_alias.clone() },
            Some(&located),
        )
        .unwrap();

        assert_eq!(probed.node_launcher_path, node_alias);
        assert_eq!(probed.node_path, canonical_runtime_path(&node_path).unwrap());
        assert_eq!(probed.npm_cli_path, canonical_runtime_path(&npm_cli_path).unwrap());
        assert_eq!(probed.npm_root, canonical_runtime_path(&npm_root).unwrap());
        let installation = probed.mcp_installation.as_ref().unwrap();
        assert_eq!(installation.script_path, canonical_runtime_path(&fixture.script_path).unwrap());
        assert_eq!(installation.package_version, "0.4.71");
        assert_eq!(probed.update_command(), super::MCP_PNPM_UPDATE_COMMAND);
        assert_eq!(probed.uninstall_command(), super::MCP_PNPM_UNINSTALL_COMMAND);
        assert!(matches!(
            installation.package_manager,
            McpPackageManager::Pnpm { ref command_path, .. } if command_path == &fixture.pnpm_path
        ));
        let update_output = probed.install_or_update().unwrap();
        assert!(update_output.success);
        let pnpm_log = std::fs::read_to_string(&pnpm_log_path).unwrap();
        assert!(pnpm_log.contains("ARGS=update -g @dbx-app/mcp-server --global-dir"));
        assert!(pnpm_log.contains(fixture.global_dir.to_string_lossy().as_ref()));
        assert!(!pnpm_log.contains("--registry"));
        assert!(pnpm_log.contains(&format!("PNPM_HOME={}", fixture.pnpm_home.display())));
        assert!(pnpm_log.contains(&format!("PATH={}", fixture.pnpm_home.display())));
        assert!(pnpm_log.contains(bin_dir.to_string_lossy().as_ref()));

        let uninstall_output = probed.uninstall().unwrap();
        assert!(uninstall_output.success);
        let pnpm_log = std::fs::read_to_string(&pnpm_log_path).unwrap();
        assert!(pnpm_log.contains("ARGS=remove -g @dbx-app/mcp-server --global-dir"));
        assert!(pnpm_log.contains(fixture.global_dir.to_string_lossy().as_ref()));
        assert!(pnpm_log.contains(&format!("PNPM_HOME={}", fixture.pnpm_home.display())));
        assert!(pnpm_log.contains(&format!("PATH={}", fixture.pnpm_home.display())));
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
