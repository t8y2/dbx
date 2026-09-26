use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

const HOMEBREW_FORMULA: &str = "t8y2/tap/dbx-mcp";
#[cfg(not(windows))]
const INSTALLER_SCRIPT: &str = include_str!("../../../docs/public/install-mcp.sh");
#[cfg(windows)]
const INSTALLER_SCRIPT: &str = include_str!("../../../docs/public/install-mcp.ps1");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeInstallationKind {
    Installer,
    Homebrew,
}

pub(super) struct NativeInstallation {
    pub binary: PathBuf,
    pub version: Option<String>,
    kind: NativeInstallationKind,
}

pub(super) fn resolve() -> Option<NativeInstallation> {
    if let Some(installation) = discover_standalone() {
        return Some(installation);
    }
    if cfg!(windows) {
        return None;
    }
    let home = home_directory()?;
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        home.join(".linuxbrew/bin"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    directories.into_iter().find_map(|directory| discover_homebrew(&directory.join("dbx-mcp")))
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn discover_standalone() -> Option<NativeInstallation> {
    discover(&home_directory()?.join(".dbx/bin"))
}

fn parse_version(value: &str) -> Option<String> {
    let value = value.trim().strip_prefix("dbx-mcp ").unwrap_or(value.trim());
    let parts: Vec<_> = value.split('.').collect();
    (parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
        .then(|| value.to_string())
}

fn binary_version(binary: &Path) -> Option<String> {
    let mut child = dbx_core::process::new_std_command(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let output = child.wait_with_output().ok()?;
                return parse_version(std::str::from_utf8(&output.stdout).ok()?);
            }
            Ok(Some(_)) => return None,
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn discover(directory: &Path) -> Option<NativeInstallation> {
    let binary = directory.join(if cfg!(windows) { "dbx-mcp.exe" } else { "dbx-mcp" });
    let version = None;
    let mut installation = discover_binary(binary, version, NativeInstallationKind::Installer)?;
    if installation.version.is_none() {
        installation.version =
            std::fs::read_to_string(directory.join(".dbx-mcp-version")).ok().and_then(|value| parse_version(&value));
    }
    Some(installation)
}

fn discover_homebrew(binary: &Path) -> Option<NativeInstallation> {
    let resolved = binary.canonicalize().ok()?;
    let bin_directory = resolved.parent()?;
    let version_directory = bin_directory.parent()?;
    let formula_directory = version_directory.parent()?;
    if bin_directory.file_name()? != "bin"
        || formula_directory.file_name()? != "dbx-mcp"
        || formula_directory.parent()?.file_name()? != "Cellar"
    {
        return None;
    }
    let version = parse_version(version_directory.file_name()?.to_str()?);
    discover_binary(binary.to_path_buf(), version, NativeInstallationKind::Homebrew)
}

fn discover_binary(
    binary: PathBuf,
    fallback_version: Option<String>,
    kind: NativeInstallationKind,
) -> Option<NativeInstallation> {
    if !binary.is_absolute() || !binary.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if binary.metadata().ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    let version = binary_version(&binary).or(fallback_version);
    Some(NativeInstallation { binary, version, kind })
}

pub(super) fn install_command() -> &'static str {
    if cfg!(windows) {
        "powershell -NoProfile -Command \"irm https://dbxio.com/install-mcp.ps1 | iex\""
    } else {
        "curl -fsSL https://dbxio.com/install-mcp | sh"
    }
}

impl NativeInstallation {
    pub fn source(&self) -> &'static str {
        match self.kind {
            NativeInstallationKind::Installer => "native",
            NativeInstallationKind::Homebrew => "homebrew",
        }
    }

    pub fn install_command(&self) -> &'static str {
        match self.kind {
            NativeInstallationKind::Installer => install_command(),
            NativeInstallationKind::Homebrew => "brew install t8y2/tap/dbx-mcp",
        }
    }

    pub fn update_command(&self) -> &'static str {
        match self.kind {
            NativeInstallationKind::Installer => install_command(),
            NativeInstallationKind::Homebrew => "brew upgrade t8y2/tap/dbx-mcp",
        }
    }

    pub fn uninstall_command(&self) -> String {
        if self.kind == NativeInstallationKind::Homebrew {
            return "brew uninstall t8y2/tap/dbx-mcp".to_string();
        }
        let marker = self.binary.with_file_name(".dbx-mcp-version");
        #[cfg(windows)]
        {
            format!(
                "Remove-Item -LiteralPath '{}', '{}'",
                self.binary.to_string_lossy().replace('\'', "''"),
                marker.to_string_lossy().replace('\'', "''")
            )
        }
        #[cfg(not(windows))]
        {
            format!(
                "rm -f {} {}",
                super::shell_quote(&self.binary.to_string_lossy()),
                super::shell_quote(&marker.to_string_lossy())
            )
        }
    }

    pub fn uninstall(&self) -> Result<String, String> {
        match self.kind {
            NativeInstallationKind::Installer => self.uninstall_standalone(),
            NativeInstallationKind::Homebrew => self.run_homebrew("uninstall"),
        }
    }

    fn uninstall_standalone(&self) -> Result<String, String> {
        let expected = home_directory()
            .map(|home| home.join(".dbx/bin").join(if cfg!(windows) { "dbx-mcp.exe" } else { "dbx-mcp" }))
            .ok_or_else(|| "Unable to resolve the user home directory.".to_string())?;
        if self.binary != expected {
            return Err(format!("Refusing to remove unexpected native MCP path: {}", self.binary.display()));
        }
        std::fs::remove_file(&self.binary)
            .map_err(|error| format!("Failed to remove {}: {error}", self.binary.display()))?;
        let marker = self.binary.with_file_name(".dbx-mcp-version");
        if marker.exists() {
            std::fs::remove_file(&marker).map_err(|error| {
                format!("Removed the MCP binary, but failed to remove {}: {error}", marker.display())
            })?;
        }
        Ok(format!("Uninstalled native DBX MCP from {}", self.binary.display()))
    }

    fn run_homebrew(&self, action: &str) -> Result<String, String> {
        let brew = self
            .binary
            .parent()
            .map(|directory| directory.join("brew"))
            .filter(|candidate| candidate.is_file())
            .or_else(|| super::locate_command("brew").map(PathBuf::from))
            .ok_or_else(|| {
                format!(
                    "Homebrew manages this installation, but brew was not found. Run: brew {action} {HOMEBREW_FORMULA}"
                )
            })?;
        let output = dbx_core::process::new_std_command(&brew)
            .args([action, HOMEBREW_FORMULA])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Failed to run {}: {error}", brew.display()))?;
        require_success(output, &format!("brew {action}"))?;
        if action == "uninstall" {
            if discover_homebrew(&self.binary).is_some() {
                return Err("Homebrew completed, but dbx-mcp is still installed.".to_string());
            }
            return Ok("Uninstalled Homebrew DBX MCP".to_string());
        }
        let installation = discover_homebrew(&self.binary)
            .ok_or_else(|| "Homebrew completed, but the DBX MCP installation could not be validated.".to_string())?;
        Ok(format!(
            "Updated Homebrew DBX MCP{}",
            installation.version.as_deref().map(|version| format!(" to {version}")).unwrap_or_default()
        ))
    }
}

pub(super) fn install_or_update(existing: Option<&NativeInstallation>, npm_installed: bool) -> Result<String, String> {
    if let Some(existing) = existing.filter(|installation| installation.kind == NativeInstallationKind::Homebrew) {
        return existing.run_homebrew("upgrade");
    }

    run_embedded_installer()?;
    let installation = discover_standalone()
        .ok_or_else(|| "The native installer completed, but ~/.dbx/bin/dbx-mcp could not be validated.".to_string())?;
    let action = if existing.is_some() { "Updated" } else { "Installed" };
    let mut message = format!(
        "{action} native DBX MCP{} at {}",
        installation.version.as_deref().map(|version| format!(" {version}")).unwrap_or_default(),
        installation.binary.display()
    );
    if existing.is_none() && npm_installed {
        message.push_str(". The existing npm installation was kept as a fallback; update external client configurations to use the native path.");
    }
    Ok(message)
}

fn run_embedded_installer() -> Result<(), String> {
    #[cfg(windows)]
    let (program, arguments): (&str, &[&str]) =
        ("powershell", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
    #[cfg(not(windows))]
    let (program, arguments): (&str, &[&str]) = ("sh", &["-s"]);

    let mut command = dbx_core::process::new_std_command(program);
    command.args(arguments).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .into_iter()
        .all(|name| std::env::var_os(name).is_none())
    {
        if let Some(proxy) = dbx_core::update::system_proxy_url() {
            command.env("HTTPS_PROXY", &proxy).env("HTTP_PROXY", &proxy).env("ALL_PROXY", proxy);
        }
    }
    let mut child =
        command.spawn().map_err(|error| format!("Failed to start the native MCP installer with {program}: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open the native MCP installer input.".to_string())?
        .write_all(INSTALLER_SCRIPT.as_bytes())
        .map_err(|error| format!("Failed to start the native MCP installer: {error}"))?;
    let output =
        child.wait_with_output().map_err(|error| format!("Failed to wait for the native MCP installer: {error}"))?;
    require_success(output, "Native MCP installer")
}

fn require_success(output: Output, action: &str) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(if detail.is_empty() {
        format!("{action} failed with {}.", output.status)
    } else {
        format!("{action} failed: {detail}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_output_and_rejects_marker_commands() {
        assert_eq!(parse_version("dbx-mcp 0.4.96\n").as_deref(), Some("0.4.96"));
        assert_eq!(parse_version("0.4.95\n").as_deref(), Some("0.4.95"));
        for invalid in ["", "0.4", "0.4.1; rm", "0.4.1\n0.4.2", "dbx-mcp unknown"] {
            assert!(parse_version(invalid).is_none());
        }
    }

    #[test]
    fn marker_alone_is_not_an_installation() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(".dbx-mcp-version"), "0.4.96\n").unwrap();
        assert!(discover(directory.path()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn native_version_precedes_marker_and_legacy_binary_uses_marker() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("dbx-mcp");
        std::fs::write(&binary, "#!/bin/sh\nprintf 'dbx-mcp 0.4.96\\n'\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(directory.path().join(".dbx-mcp-version"), "0.4.95\n").unwrap();
        let installation = discover(directory.path()).unwrap();
        assert_eq!(installation.binary, binary);
        assert_eq!(installation.version.as_deref(), Some("0.4.96"));
        assert_eq!(installation.source(), "native");
        std::fs::write(&binary, "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(discover(directory.path()).unwrap().version.as_deref(), Some("0.4.95"));
        std::fs::remove_file(directory.path().join(".dbx-mcp-version")).unwrap();
        assert!(discover(directory.path()).unwrap().version.is_none());
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(discover(directory.path()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn stalled_version_probe_times_out_and_uses_marker() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("dbx-mcp");
        std::fs::write(&binary, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(directory.path().join(".dbx-mcp-version"), "0.4.95\n").unwrap();
        let started = Instant::now();
        assert_eq!(discover(directory.path()).unwrap().version.as_deref(), Some("0.4.95"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn homebrew_keeps_a_stable_path_and_its_own_management_commands() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let cellar_binary = directory.path().join("Cellar/dbx-mcp/0.4.96/bin/dbx-mcp");
        std::fs::create_dir_all(cellar_binary.parent().unwrap()).unwrap();
        std::fs::write(&cellar_binary, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&cellar_binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = directory.path().join("dbx-mcp");
        symlink(&cellar_binary, &link).unwrap();
        let installation = discover_homebrew(&link).unwrap();
        assert_eq!(installation.binary, link);
        assert_eq!(installation.version.as_deref(), Some("0.4.96"));
        assert_eq!(installation.source(), "homebrew");
        assert_eq!(installation.install_command(), "brew install t8y2/tap/dbx-mcp");
        assert_eq!(installation.update_command(), "brew upgrade t8y2/tap/dbx-mcp");
        assert_eq!(installation.uninstall_command(), "brew uninstall t8y2/tap/dbx-mcp");
        assert!(discover_homebrew(Path::new("/bin/sh")).is_none());
    }
}
