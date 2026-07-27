use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, RwLock};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::db::ssh_tunnel::connect_and_authenticate;

pub const BUILTIN_SSH_TERMINAL_DRIVER_ID: &str = "builtin-russh";
const SESSION_COMMAND_BUFFER: usize = 128;
const SESSION_EVENT_BUFFER: usize = 256;
const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;

fn default_driver_id() -> String {
    BUILTIN_SSH_TERMINAL_DRIVER_ID.to_string()
}

fn default_ssh_port() -> u16 {
    22
}

fn default_connect_timeout_secs() -> u64 {
    10
}

fn default_terminal_type() -> String {
    "xterm-256color".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshAuthMethod {
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "key")]
    Key,
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "key+password")]
    KeyPassword,
    #[serde(rename = "none")]
    None,
}

impl Default for SshAuthMethod {
    fn default() -> Self {
        Self::Password
    }
}

impl SshAuthMethod {
    fn as_tunnel_auth_method(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
            Self::Agent => "agent",
            Self::KeyPassword => "key+password",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    pub name: String,
    #[serde(default = "default_driver_id")]
    pub driver_id: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub key_passphrase: String,
    #[serde(default)]
    pub ssh_agent_sock_path: String,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_terminal_type")]
    pub terminal_type: String,
}

impl SshProfile {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_metadata()?;
        match self.auth_method {
            SshAuthMethod::Password if self.password.is_empty() => {
                Err("SSH password is required for password authentication".to_string())
            }
            SshAuthMethod::Key if self.key_path.trim().is_empty() => {
                Err("SSH private key path is required for key authentication".to_string())
            }
            SshAuthMethod::KeyPassword if self.key_path.trim().is_empty() || self.password.is_empty() => {
                Err("SSH private key and password are required for combined authentication".to_string())
            }
            _ => Ok(()),
        }
    }

    pub fn validate_metadata(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("SSH profile id must not be empty".to_string());
        }
        if self.name.trim().is_empty() {
            return Err("SSH profile name must not be empty".to_string());
        }
        if self.driver_id.trim().is_empty() {
            return Err("SSH terminal driver id must not be empty".to_string());
        }
        if self.host.trim().is_empty() {
            return Err("SSH host must not be empty".to_string());
        }
        if self.port == 0 {
            return Err("SSH port must be between 1 and 65535".to_string());
        }
        if self.username.trim().is_empty() {
            return Err("SSH username must not be empty".to_string());
        }
        if !(1..=300).contains(&self.connect_timeout_secs) {
            return Err("SSH connection timeout must be between 1 and 300 seconds".to_string());
        }
        let terminal_type = self.terminal_type.trim();
        if terminal_type.is_empty()
            || terminal_type.len() > 64
            || terminal_type.chars().any(|character| character.is_control())
        {
            return Err("SSH terminal type is invalid".to_string());
        }
        Ok(())
    }

    pub fn scrubbed_for_storage(&self) -> Self {
        let mut profile = self.clone();
        profile.password.clear();
        profile.key_passphrase.clear();
        profile
    }

    pub fn without_irrelevant_secrets(&self) -> Self {
        let mut profile = self.clone();
        match profile.auth_method {
            SshAuthMethod::Password => profile.key_passphrase.clear(),
            SshAuthMethod::Key => profile.password.clear(),
            SshAuthMethod::Agent | SshAuthMethod::None => {
                profile.password.clear();
                profile.key_passphrase.clear();
            }
            SshAuthMethod::KeyPassword => {}
        }
        profile
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalSize {
    pub columns: u32,
    pub rows: u32,
    #[serde(default)]
    pub pixel_width: u32,
    #[serde(default)]
    pub pixel_height: u32,
}

impl SshTerminalSize {
    pub fn validate(self) -> Result<Self, String> {
        if !(1..=1_000).contains(&self.columns) || !(1..=1_000).contains(&self.rows) {
            return Err("SSH terminal size must be between 1 and 1000 columns/rows".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalDriverManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub built_in: bool,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshTerminalEvent {
    Ready,
    Data { data: String },
    Exit { exit_code: Option<u32>, signal: Option<String> },
    Error { message: String },
}

enum SshTerminalCommand {
    Input(Vec<u8>),
    Resize(SshTerminalSize),
    Close,
}

#[async_trait]
pub trait SshTerminalDriver: Send + Sync {
    fn manifest(&self) -> SshTerminalDriverManifest;

    async fn connect(
        &self,
        profile: &SshProfile,
        known_hosts_path: &Path,
        size: SshTerminalSize,
        events: mpsc::Sender<SshTerminalEvent>,
    ) -> Result<Arc<dyn SshTerminalSession>, String>;

    async fn execute(
        &self,
        profile: &SshProfile,
        known_hosts_path: &Path,
        command: &str,
        timeout_secs: u64,
    ) -> Result<SshCommandResult, String>;
}

#[async_trait]
pub trait SshTerminalSession: Send + Sync {
    async fn input(&self, data: Vec<u8>) -> Result<(), String>;
    async fn resize(&self, size: SshTerminalSize) -> Result<(), String>;
    async fn close(&self) -> Result<(), String>;
}

pub struct RusshTerminalDriver;

struct RusshTerminalSession {
    commands: mpsc::Sender<SshTerminalCommand>,
}

#[async_trait]
impl SshTerminalSession for RusshTerminalSession {
    async fn input(&self, data: Vec<u8>) -> Result<(), String> {
        self.commands
            .send(SshTerminalCommand::Input(data))
            .await
            .map_err(|_| "SSH terminal session is closed".to_string())
    }

    async fn resize(&self, size: SshTerminalSize) -> Result<(), String> {
        self.commands
            .send(SshTerminalCommand::Resize(size.validate()?))
            .await
            .map_err(|_| "SSH terminal session is closed".to_string())
    }

    async fn close(&self) -> Result<(), String> {
        self.commands.send(SshTerminalCommand::Close).await.map_err(|_| "SSH terminal session is closed".to_string())
    }
}

#[async_trait]
impl SshTerminalDriver for RusshTerminalDriver {
    fn manifest(&self) -> SshTerminalDriverManifest {
        SshTerminalDriverManifest {
            id: BUILTIN_SSH_TERMINAL_DRIVER_ID.to_string(),
            name: "DBX SSH".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            built_in: true,
            capabilities: vec![
                "pty".to_string(),
                "resize".to_string(),
                "password".to_string(),
                "private-key".to_string(),
                "ssh-agent".to_string(),
                "known-hosts".to_string(),
                "exec".to_string(),
            ],
        }
    }

    async fn connect(
        &self,
        profile: &SshProfile,
        known_hosts_path: &Path,
        size: SshTerminalSize,
        event_tx: mpsc::Sender<SshTerminalEvent>,
    ) -> Result<Arc<dyn SshTerminalSession>, String> {
        profile.validate()?;
        let size = size.validate()?;
        let use_ssh_agent = profile.auth_method == SshAuthMethod::Agent;
        let session = connect_and_authenticate(
            profile.host.trim(),
            profile.port,
            profile.host.trim(),
            profile.port,
            profile.username.trim(),
            &profile.password,
            profile.key_path.trim(),
            &profile.key_passphrase,
            use_ssh_agent,
            profile.ssh_agent_sock_path.trim(),
            profile.auth_method.as_tunnel_auth_method(),
            profile.connect_timeout_secs,
            known_hosts_path,
        )
        .await?;

        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SSH terminal channel: {error}"))?;
        channel
            .request_pty(
                true,
                profile.terminal_type.trim(),
                size.columns,
                size.rows,
                size.pixel_width,
                size.pixel_height,
                &[],
            )
            .await
            .map_err(|error| format!("Failed to request SSH PTY: {error}"))?;
        wait_for_channel_request_reply(&mut channel, "SSH PTY", profile.connect_timeout_secs).await?;
        channel.request_shell(true).await.map_err(|error| format!("Failed to start SSH shell: {error}"))?;
        wait_for_channel_request_reply(&mut channel, "SSH shell", profile.connect_timeout_secs).await?;

        let (command_tx, mut command_rx) = mpsc::channel(SESSION_COMMAND_BUFFER);
        tokio::spawn(async move {
            let _ = event_tx.send(SshTerminalEvent::Ready).await;
            let mut exit_code = None;
            let mut exit_signal = None;

            loop {
                tokio::select! {
                    command = command_rx.recv() => {
                        match command {
                            Some(SshTerminalCommand::Input(data)) => {
                                if let Err(error) = channel.data(data.as_slice()).await {
                                    let _ = event_tx.send(SshTerminalEvent::Error {
                                        message: format!("Failed to write SSH terminal input: {error}"),
                                    }).await;
                                    break;
                                }
                            }
                            Some(SshTerminalCommand::Resize(size)) => {
                                if let Err(error) = channel.window_change(
                                    size.columns,
                                    size.rows,
                                    size.pixel_width,
                                    size.pixel_height,
                                ).await {
                                    let _ = event_tx.send(SshTerminalEvent::Error {
                                        message: format!("Failed to resize SSH terminal: {error}"),
                                    }).await;
                                    break;
                                }
                            }
                            Some(SshTerminalCommand::Close) | None => {
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                let _ = session.disconnect(Disconnect::ByApplication, "DBX terminal closed", "").await;
                                break;
                            }
                        }
                    }
                    message = channel.wait() => {
                        match message {
                            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if event_tx.send(SshTerminalEvent::Data {
                                    data: BASE64_STANDARD.encode(data),
                                }).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                                exit_signal = Some(format!("{signal_name:?}"));
                            }
                            Some(ChannelMsg::Eof) => {}
                            Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                }
            }

            let _ = event_tx.send(SshTerminalEvent::Exit { exit_code, signal: exit_signal }).await;
        });

        Ok(Arc::new(RusshTerminalSession { commands: command_tx }))
    }

    async fn execute(
        &self,
        profile: &SshProfile,
        known_hosts_path: &Path,
        command: &str,
        timeout_secs: u64,
    ) -> Result<SshCommandResult, String> {
        profile.validate()?;
        let command = command.trim();
        if command.is_empty() || command.len() > 8_192 || command.chars().any(|character| character == '\0') {
            return Err("SSH command must contain between 1 and 8192 characters".to_string());
        }
        let timeout_secs = timeout_secs.clamp(1, 300);
        let session = connect_and_authenticate(
            profile.host.trim(),
            profile.port,
            profile.username.trim(),
            &profile.password,
            profile.key_path.trim(),
            &profile.key_passphrase,
            profile.auth_method == SshAuthMethod::Agent,
            profile.ssh_agent_sock_path.trim(),
            profile.auth_method.as_tunnel_auth_method(),
            profile.connect_timeout_secs,
            known_hosts_path,
        )
        .await?;
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SSH command channel: {error}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|error| format!("Failed to execute SSH command: {error}"))?;
        wait_for_channel_request_reply(&mut channel, "SSH command", profile.connect_timeout_secs).await?;

        let collect = async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            let mut signal = None;
            let mut truncated = false;
            let mut captured_bytes = 0;
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        append_command_output(&mut stdout, data.as_ref(), &mut captured_bytes, &mut truncated);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        append_command_output(&mut stderr, data.as_ref(), &mut captured_bytes, &mut truncated);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => signal = Some(format!("{signal_name:?}")),
                    Some(ChannelMsg::Eof) => {}
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            SshCommandResult {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                exit_code,
                signal,
                truncated,
            }
        };

        let result = timeout(Duration::from_secs(timeout_secs), collect)
            .await
            .map_err(|_| format!("SSH command timed out after {timeout_secs} seconds"));
        let _ = channel.close().await;
        let _ = session.disconnect(Disconnect::ByApplication, "DBX command completed", "").await;
        result
    }
}

fn append_command_output(target: &mut Vec<u8>, data: &[u8], captured_bytes: &mut usize, truncated: &mut bool) {
    let remaining = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(*captured_bytes);
    let captured = data.len().min(remaining);
    if data.len() > remaining {
        *truncated = true;
    }
    target.extend_from_slice(&data[..captured]);
    *captured_bytes += captured;
}

async fn wait_for_channel_request_reply(
    channel: &mut russh::Channel<russh::client::Msg>,
    operation: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    timeout(Duration::from_secs(timeout_secs), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => return Err(format!("Server rejected {operation} request")),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    return Err(format!("SSH channel closed while requesting {operation}"));
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| format!("Timed out while requesting {operation}"))?
}

pub struct StartedSshTerminalSession {
    pub id: String,
    pub events: mpsc::Receiver<SshTerminalEvent>,
}

pub struct SshTerminalService {
    drivers: HashMap<String, Arc<dyn SshTerminalDriver>>,
    sessions: RwLock<HashMap<String, Arc<dyn SshTerminalSession>>>,
}

impl Default for SshTerminalService {
    fn default() -> Self {
        Self::new()
    }
}

impl SshTerminalService {
    pub fn new() -> Self {
        let driver: Arc<dyn SshTerminalDriver> = Arc::new(RusshTerminalDriver);
        Self::with_drivers(vec![driver]).expect("built-in SSH terminal driver manifest must be valid")
    }

    pub fn with_drivers(drivers: Vec<Arc<dyn SshTerminalDriver>>) -> Result<Self, String> {
        let mut registry = HashMap::new();
        for driver in drivers {
            let manifest = driver.manifest();
            if manifest.id.trim().is_empty() {
                return Err("SSH terminal driver id must not be empty".to_string());
            }
            if registry.insert(manifest.id.clone(), driver).is_some() {
                return Err(format!("Duplicate SSH terminal driver id '{}'", manifest.id));
            }
        }
        Ok(Self { drivers: registry, sessions: RwLock::new(HashMap::new()) })
    }

    pub fn list_drivers(&self) -> Vec<SshTerminalDriverManifest> {
        let mut drivers = self.drivers.values().map(|driver| driver.manifest()).collect::<Vec<_>>();
        drivers.sort_by(|left, right| left.id.cmp(&right.id));
        drivers
    }

    pub async fn start(
        &self,
        profile: &SshProfile,
        known_hosts_path: PathBuf,
        size: SshTerminalSize,
    ) -> Result<StartedSshTerminalSession, String> {
        let driver = self
            .drivers
            .get(profile.driver_id.trim())
            .ok_or_else(|| format!("SSH terminal driver '{}' is not installed", profile.driver_id))?;
        let (event_tx, event_rx) = mpsc::channel(SESSION_EVENT_BUFFER);
        let driver_session = driver.connect(profile, &known_hosts_path, size, event_tx).await?;
        let id = Uuid::new_v4().to_string();
        self.sessions.write().await.insert(id.clone(), driver_session);
        Ok(StartedSshTerminalSession { id, events: event_rx })
    }

    pub async fn execute_command(
        &self,
        profile: &SshProfile,
        known_hosts_path: PathBuf,
        command: &str,
        timeout_secs: u64,
    ) -> Result<SshCommandResult, String> {
        let driver = self
            .drivers
            .get(profile.driver_id.trim())
            .ok_or_else(|| format!("SSH terminal driver '{}' is not installed", profile.driver_id))?;
        driver.execute(profile, &known_hosts_path, command, timeout_secs).await
    }

    pub async fn input(&self, session_id: &str, data: String) -> Result<(), String> {
        let session = self.session(session_id).await?;
        session.input(data.into_bytes()).await
    }

    pub async fn resize(&self, session_id: &str, size: SshTerminalSize) -> Result<(), String> {
        let session = self.session(session_id).await?;
        session.resize(size).await
    }

    pub async fn close(&self, session_id: &str) -> Result<bool, String> {
        let Some(session) = self.sessions.write().await.remove(session_id) else {
            return Ok(false);
        };
        session.close().await?;
        Ok(true)
    }

    pub async fn forget(&self, session_id: &str) {
        self.sessions.write().await.remove(session_id);
    }

    async fn session(&self, session_id: &str) -> Result<Arc<dyn SshTerminalSession>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SSH terminal session was not found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(auth_method: SshAuthMethod) -> SshProfile {
        SshProfile {
            id: "local".to_string(),
            name: "Local".to_string(),
            driver_id: BUILTIN_SSH_TERMINAL_DRIVER_ID.to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "tester".to_string(),
            auth_method,
            password: String::new(),
            key_path: String::new(),
            key_passphrase: String::new(),
            ssh_agent_sock_path: String::new(),
            connect_timeout_secs: 10,
            terminal_type: "xterm-256color".to_string(),
        }
    }

    #[test]
    fn profile_validation_requires_credentials_for_selected_method() {
        assert!(profile(SshAuthMethod::Password).validate().unwrap_err().contains("password"));
        assert!(profile(SshAuthMethod::Key).validate().unwrap_err().contains("key"));

        let mut combined = profile(SshAuthMethod::KeyPassword);
        combined.key_path = "~/.ssh/id_ed25519".to_string();
        assert!(combined.validate().unwrap_err().contains("password"));

        let mut invalid_port = profile(SshAuthMethod::Agent);
        invalid_port.port = 0;
        assert!(invalid_port.validate().unwrap_err().contains("port"));
    }

    #[test]
    fn password_is_the_default_authentication_method() {
        assert_eq!(SshAuthMethod::default(), SshAuthMethod::Password);
    }

    #[test]
    fn irrelevant_secrets_are_removed_for_selected_auth_method() {
        let mut profile = profile(SshAuthMethod::Agent);
        profile.password = "password".to_string();
        profile.key_passphrase = "key-passphrase".to_string();
        let normalized = profile.without_irrelevant_secrets();
        assert!(normalized.password.is_empty());
        assert!(normalized.key_passphrase.is_empty());
    }

    #[test]
    fn scrubbed_profile_does_not_serialize_secrets() {
        let mut profile = profile(SshAuthMethod::Password);
        profile.password = "secret".to_string();
        profile.key_passphrase = "key-secret".to_string();
        let json = serde_json::to_string(&profile.scrubbed_for_storage()).unwrap();
        assert!(!json.contains("secret"));
    }

    #[test]
    fn builtin_driver_reports_terminal_capabilities() {
        let service = SshTerminalService::new();
        let drivers = service.list_drivers();
        assert_eq!(drivers.len(), 1);
        assert_eq!(drivers[0].id, BUILTIN_SSH_TERMINAL_DRIVER_ID);
        assert!(drivers[0].capabilities.iter().any(|capability| capability == "pty"));
        assert!(drivers[0].capabilities.iter().any(|capability| capability == "known-hosts"));
    }

    #[test]
    fn terminal_size_rejects_zero_and_excessive_dimensions() {
        assert!(SshTerminalSize { columns: 0, rows: 24, pixel_width: 0, pixel_height: 0 }.validate().is_err());
        assert!(SshTerminalSize { columns: 80, rows: 1_001, pixel_width: 0, pixel_height: 0 }.validate().is_err());
    }

    #[test]
    fn command_output_limit_is_shared_between_stdout_and_stderr() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut captured_bytes = 0;
        let mut truncated = false;
        append_command_output(
            &mut stdout,
            &vec![b'o'; MAX_COMMAND_OUTPUT_BYTES - 4],
            &mut captured_bytes,
            &mut truncated,
        );
        append_command_output(&mut stderr, b"stderr", &mut captured_bytes, &mut truncated);
        assert_eq!(stdout.len() + stderr.len(), MAX_COMMAND_OUTPUT_BYTES);
        assert_eq!(stderr, b"stde");
        assert!(truncated);
    }
}
