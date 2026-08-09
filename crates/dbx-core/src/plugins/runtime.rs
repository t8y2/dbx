use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{broadcast, oneshot, watch, Mutex, RwLock};
use tokio::time::timeout;

use super::{
    InstalledPlugin, PluginBackendTransport, PluginRuntimeEnv, SUPPORTED_PLUGIN_HOST_API_VERSION,
    SUPPORTED_PLUGIN_PROTOCOL_VERSION,
};

pub const PLUGIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_JSON_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BINARY_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const FRAME_KIND_JSON: u8 = 0;
const FRAME_KIND_BINARY: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginEvent {
    pub plugin_id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginBinaryMessage {
    pub plugin_id: String,
    pub channel: String,
    pub data: Bytes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginSessionState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSessionStatus {
    pub state: PluginSessionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PluginSessionStatus {
    fn new(state: PluginSessionState, message: Option<String>) -> Self {
        Self { state, message }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginHandshake {
    pub protocol_version: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub plugin: PluginHandshakeIdentity,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginHandshakeIdentity {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginInitializeParams<'a> {
    host: PluginHostDescription<'a>,
    plugin: PluginDescription<'a>,
    permissions: &'a [String],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginHostDescription<'a> {
    dbx_version: &'a str,
    host_api_version: &'static str,
    protocol_versions: [u32; 1],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDescription<'a> {
    id: &'a str,
    version: &'a str,
}

#[derive(Debug, Serialize)]
struct PluginRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    driver: Option<&'a str>,
    method: &'a str,
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct PluginNotification<'a> {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    driver: Option<&'a str>,
    method: &'a str,
    params: serde_json::Value,
}

type PendingResponse = oneshot::Sender<Result<serde_json::Value, String>>;

pub struct PluginSidecarSession {
    plugin: InstalledPlugin,
    app_version: String,
    transport: PluginBackendTransport,
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, PendingResponse>>>,
    next_request_id: AtomicU64,
    events: broadcast::Sender<PluginEvent>,
    binary_messages: broadcast::Sender<PluginBinaryMessage>,
    status: watch::Sender<PluginSessionStatus>,
    handshake: RwLock<Option<PluginHandshake>>,
}

impl PluginSidecarSession {
    pub async fn start(
        plugin: InstalledPlugin,
        app_version: impl Into<String>,
        env: PluginRuntimeEnv,
    ) -> Result<Arc<Self>, String> {
        ensure_plugin_backend(&plugin)?;
        let transport = plugin.manifest.backend_entrypoint().map(|backend| backend.transport).unwrap_or_default();
        let app_version = app_version.into();
        let mut child = spawn_plugin_child(&plugin, &app_version, &env)?;
        let stdin = child.stdin.take().ok_or("Plugin stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Plugin stdout unavailable")?;
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(256);
        let (binary_messages, _) = broadcast::channel(64);
        let (status, _) = watch::channel(PluginSessionStatus::new(PluginSessionState::Starting, None));
        let session = Arc::new(Self {
            plugin,
            app_version,
            transport,
            child,
            stdin: Mutex::new(stdin),
            pending,
            next_request_id: AtomicU64::new(1),
            events,
            binary_messages,
            status,
            handshake: RwLock::new(None),
        });

        session.spawn_stdout_reader(stdout);
        if let Some(stderr) = stderr {
            session.spawn_stderr_reader(stderr);
        }

        if !session.plugin.manifest.is_legacy() {
            let handshake = match session.initialize().await {
                Ok(handshake) => handshake,
                Err(error) => {
                    session.shutdown().await;
                    return Err(format!("Plugin '{}' initialization failed: {error}", session.plugin.manifest.id));
                }
            };
            *session.handshake.write().await = Some(handshake);
        }
        let transitioned = session.status.send_if_modified(|status| {
            if status.state != PluginSessionState::Starting {
                return false;
            }
            *status = PluginSessionStatus::new(PluginSessionState::Running, None);
            true
        });
        if !transitioned {
            let status = session.status();
            session.shutdown().await;
            return Err(format!(
                "Plugin '{}' stopped during initialization{}",
                session.plugin.manifest.id,
                status.message.map_or_else(String::new, |message| format!(": {message}"))
            ));
        }
        Ok(session)
    }

    pub fn plugin(&self) -> &InstalledPlugin {
        &self.plugin
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<PluginEvent> {
        self.events.subscribe()
    }

    pub fn subscribe_binary(&self) -> broadcast::Receiver<PluginBinaryMessage> {
        self.binary_messages.subscribe()
    }

    pub fn subscribe_status(&self) -> watch::Receiver<PluginSessionStatus> {
        self.status.subscribe()
    }

    pub fn status(&self) -> PluginSessionStatus {
        self.status.borrow().clone()
    }

    pub async fn handshake(&self) -> Option<PluginHandshake> {
        self.handshake.read().await.clone()
    }

    pub async fn invoke<T>(&self, method: &str, params: serde_json::Value) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        self.invoke_with_timeout(method, params, None, Some(PLUGIN_REQUEST_TIMEOUT)).await
    }

    pub async fn invoke_with_timeout<T>(
        &self,
        method: &str,
        params: serde_json::Value,
        driver: Option<&str>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String>
    where
        T: DeserializeOwned,
    {
        let value = self.invoke_value(method, params, driver, timeout_duration).await?;
        serde_json::from_value(value)
            .map_err(|error| format!("Failed to decode plugin '{}' result: {error}", self.plugin.manifest.id))
    }

    pub async fn notify(&self, method: &str, params: serde_json::Value, driver: Option<&str>) -> Result<(), String> {
        self.ensure_running()?;
        validate_protocol_name(method)?;
        let notification = PluginNotification { jsonrpc: "2.0", driver, method, params };
        let payload = serde_json::to_vec(&notification).map_err(|error| error.to_string())?;
        self.write_json(&payload).await
    }

    pub async fn send_binary(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        self.ensure_running()?;
        if self.transport != PluginBackendTransport::StdioFramed {
            return Err(format!(
                "Plugin '{}' does not use the framed transport required for binary messages",
                self.plugin.manifest.id
            ));
        }
        validate_binary_channel(channel)?;
        if data.len() > MAX_BINARY_MESSAGE_BYTES {
            return Err(format!("Plugin binary message exceeds {MAX_BINARY_MESSAGE_BYTES} bytes"));
        }
        let channel_bytes = channel.as_bytes();
        let payload_len = 2usize
            .checked_add(channel_bytes.len())
            .and_then(|length| length.checked_add(data.len()))
            .ok_or("Plugin binary frame is too large")?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_u8(FRAME_KIND_BINARY).await.map_err(|error| self.write_error(error))?;
        stdin.write_u32(payload_len as u32).await.map_err(|error| self.write_error(error))?;
        stdin.write_u16(channel_bytes.len() as u16).await.map_err(|error| self.write_error(error))?;
        stdin.write_all(channel_bytes).await.map_err(|error| self.write_error(error))?;
        stdin.write_all(data).await.map_err(|error| self.write_error(error))?;
        stdin.flush().await.map_err(|error| self.write_error(error))
    }

    pub async fn shutdown(&self) {
        self.status.send_replace(PluginSessionStatus::new(PluginSessionState::Stopping, None));
        let kill_result = self.child.lock().await.kill().await;
        let message = kill_result.err().map(|error| error.to_string());
        fail_pending(&self.pending, "Plugin session stopped").await;
        self.status.send_replace(PluginSessionStatus::new(PluginSessionState::Stopped, message));
    }

    pub async fn pid(&self) -> Option<u32> {
        self.child.lock().await.id()
    }

    async fn initialize(&self) -> Result<PluginHandshake, String> {
        let params = PluginInitializeParams {
            host: PluginHostDescription {
                dbx_version: &self.app_version,
                host_api_version: SUPPORTED_PLUGIN_HOST_API_VERSION,
                protocol_versions: [SUPPORTED_PLUGIN_PROTOCOL_VERSION],
            },
            plugin: PluginDescription { id: &self.plugin.manifest.id, version: &self.plugin.manifest.version },
            permissions: &self.plugin.manifest.permissions,
        };
        let params = serde_json::to_value(params).map_err(|error| error.to_string())?;
        let handshake: PluginHandshake =
            self.invoke_with_timeout("plugin/initialize", params, None, Some(PLUGIN_REQUEST_TIMEOUT)).await?;
        if handshake.protocol_version != SUPPORTED_PLUGIN_PROTOCOL_VERSION {
            return Err(format!(
                "Plugin selected protocol version {}, expected {}",
                handshake.protocol_version, SUPPORTED_PLUGIN_PROTOCOL_VERSION
            ));
        }
        if handshake.plugin.id != self.plugin.manifest.id || handshake.plugin.version != self.plugin.manifest.version {
            return Err(format!(
                "Plugin backend identity '{}/{}' does not match manifest '{}/{}'",
                handshake.plugin.id, handshake.plugin.version, self.plugin.manifest.id, self.plugin.manifest.version
            ));
        }
        Ok(handshake)
    }

    async fn invoke_value(
        &self,
        method: &str,
        params: serde_json::Value,
        driver: Option<&str>,
        timeout_duration: Option<Duration>,
    ) -> Result<serde_json::Value, String> {
        self.ensure_running_or_starting()?;
        validate_protocol_name(method)?;
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request = PluginRequest { jsonrpc: "2.0", id: request_id, driver, method, params };
        let payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id, sender);
        if let Err(error) = self.write_json(&payload).await {
            self.pending.lock().await.remove(&request_id);
            return Err(error);
        }

        let receive = async {
            receiver.await.map_err(|_| format!("Plugin '{}' response channel closed", self.plugin.manifest.id))?
        };
        match timeout_duration {
            Some(duration) => match timeout(duration, receive).await {
                Ok(result) => result,
                Err(_) => {
                    self.pending.lock().await.remove(&request_id);
                    Err(format!(
                        "Plugin '{}' request '{}' timed out after {} seconds",
                        self.plugin.manifest.id,
                        method,
                        duration.as_secs()
                    ))
                }
            },
            None => receive.await,
        }
    }

    async fn write_json(&self, payload: &[u8]) -> Result<(), String> {
        if payload.len() > MAX_JSON_MESSAGE_BYTES {
            return Err(format!("Plugin JSON message exceeds {MAX_JSON_MESSAGE_BYTES} bytes"));
        }
        let mut stdin = self.stdin.lock().await;
        match self.transport {
            PluginBackendTransport::StdioJsonLines => {
                stdin.write_all(payload).await.map_err(|error| self.write_error(error))?;
                stdin.write_u8(b'\n').await.map_err(|error| self.write_error(error))?;
            }
            PluginBackendTransport::StdioFramed => {
                stdin.write_u8(FRAME_KIND_JSON).await.map_err(|error| self.write_error(error))?;
                stdin.write_u32(payload.len() as u32).await.map_err(|error| self.write_error(error))?;
                stdin.write_all(payload).await.map_err(|error| self.write_error(error))?;
            }
        }
        stdin.flush().await.map_err(|error| self.write_error(error))
    }

    fn write_error(&self, error: std::io::Error) -> String {
        format!("Failed to write to plugin '{}': {error}", self.plugin.manifest.id)
    }

    fn ensure_running(&self) -> Result<(), String> {
        let status = self.status();
        if status.state == PluginSessionState::Running {
            Ok(())
        } else {
            Err(format!("Plugin '{}' is not running ({:?})", self.plugin.manifest.id, status.state))
        }
    }

    fn ensure_running_or_starting(&self) -> Result<(), String> {
        let status = self.status();
        if matches!(status.state, PluginSessionState::Starting | PluginSessionState::Running) {
            Ok(())
        } else {
            Err(format!("Plugin '{}' is not available ({:?})", self.plugin.manifest.id, status.state))
        }
    }

    fn spawn_stdout_reader(self: &Arc<Self>, stdout: ChildStdout) {
        let session = self.clone();
        tokio::spawn(async move {
            let result = match session.transport {
                PluginBackendTransport::StdioJsonLines => read_json_lines(&session, BufReader::new(stdout)).await,
                PluginBackendTransport::StdioFramed => read_framed(&session, stdout).await,
            };
            let message = match result {
                Ok(()) => session.exit_message().await,
                Err(error) => error,
            };
            fail_pending(&session.pending, &message).await;
            if matches!(session.status().state, PluginSessionState::Stopping | PluginSessionState::Stopped) {
                return;
            }
            let message = session.terminate_after_output_end(message).await;
            session.status.send_if_modified(|status| {
                if matches!(status.state, PluginSessionState::Stopping | PluginSessionState::Stopped) {
                    return false;
                }
                *status = PluginSessionStatus::new(PluginSessionState::Exited, Some(message.clone()));
                true
            });
        });
    }

    fn spawn_stderr_reader(self: &Arc<Self>, stderr: tokio::process::ChildStderr) {
        let plugin_id = self.plugin.manifest.id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            loop {
                match read_limited_line(&mut reader, MAX_JSON_MESSAGE_BYTES).await {
                    Ok(Some(line)) => log::warn!("[plugin:{plugin_id}] {}", String::from_utf8_lossy(&line).trim_end()),
                    Ok(None) => break,
                    Err(error) => {
                        log::warn!("[plugin:{plugin_id}] failed to read stderr: {error}");
                        break;
                    }
                }
            }
        });
    }

    async fn exit_message(&self) -> String {
        match self.child.lock().await.try_wait() {
            Ok(Some(status)) => format!("Plugin '{}' exited with status {status}", self.plugin.manifest.id),
            Ok(None) => format!("Plugin '{}' closed its output stream", self.plugin.manifest.id),
            Err(error) => format!("Plugin '{}' output closed: {error}", self.plugin.manifest.id),
        }
    }

    async fn terminate_after_output_end(&self, message: String) -> String {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => message,
            Ok(None) => match child.kill().await {
                Ok(()) => format!("{message}; process terminated by host"),
                Err(error) => format!("{message}; failed to terminate process: {error}"),
            },
            Err(error) => format!("{message}; failed to inspect process: {error}"),
        }
    }

    async fn dispatch_json(&self, payload: &[u8]) -> Result<(), String> {
        let value: serde_json::Value = serde_json::from_slice(payload).map_err(|error| {
            format!("Failed to parse plugin '{}' protocol message: {error}", self.plugin.manifest.id)
        })?;
        if !self.plugin.manifest.is_legacy() && value.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
        {
            return Err(format!("Plugin '{}' sent a message without jsonrpc 2.0", self.plugin.manifest.id));
        }
        if let Some(request_id) = value.get("id").and_then(serde_json::Value::as_u64) {
            let result = decode_response_value(&self.plugin.manifest.id, value);
            if let Some(sender) = self.pending.lock().await.remove(&request_id) {
                let _ = sender.send(result);
            } else {
                log::warn!("[plugin:{}] ignored response for unknown request {request_id}", self.plugin.manifest.id);
            }
            return Ok(());
        }
        if let Some(method) = value.get("method").and_then(serde_json::Value::as_str) {
            if !self.plugin.manifest.is_legacy() {
                validate_protocol_name(method)?;
            }
            let event = PluginEvent {
                plugin_id: self.plugin.manifest.id.clone(),
                method: method.to_string(),
                params: value.get("params").cloned().unwrap_or(serde_json::Value::Null),
            };
            let _ = self.events.send(event);
            return Ok(());
        }
        Err(format!("Plugin '{}' sent a protocol message without id or method", self.plugin.manifest.id))
    }

    fn dispatch_binary(&self, payload: Bytes) -> Result<(), String> {
        if payload.len() < 2 {
            return Err(format!("Plugin '{}' sent an invalid binary frame", self.plugin.manifest.id));
        }
        let channel_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
        if channel_len == 0 || payload.len() < 2 + channel_len {
            return Err(format!("Plugin '{}' sent an invalid binary channel", self.plugin.manifest.id));
        }
        let channel = std::str::from_utf8(&payload[2..2 + channel_len]).map_err(|error| {
            format!("Plugin '{}' sent a non-UTF-8 binary channel: {error}", self.plugin.manifest.id)
        })?;
        validate_binary_channel(channel)?;
        let message = PluginBinaryMessage {
            plugin_id: self.plugin.manifest.id.clone(),
            channel: channel.to_string(),
            data: payload.slice(2 + channel_len..),
        };
        let _ = self.binary_messages.send(message);
        Ok(())
    }
}

async fn read_json_lines(session: &PluginSidecarSession, mut reader: BufReader<ChildStdout>) -> Result<(), String> {
    loop {
        let Some(line) = read_limited_line(&mut reader, MAX_JSON_MESSAGE_BYTES)
            .await
            .map_err(|error| format!("Failed to read plugin '{}' output: {error}", session.plugin.manifest.id))?
        else {
            return Ok(());
        };
        let trimmed = trim_ascii_whitespace(&line);
        if trimmed.is_empty() {
            continue;
        }
        if let Err(error) = session.dispatch_json(trimmed).await {
            if !session.plugin.manifest.is_legacy() {
                return Err(error);
            }
            log::warn!(
                "[plugin:{}] ignored non-protocol stdout: {} ({error})",
                session.plugin.manifest.id,
                String::from_utf8_lossy(trimmed)
            );
        }
    }
}

async fn read_framed(session: &PluginSidecarSession, mut stdout: ChildStdout) -> Result<(), String> {
    loop {
        let kind = match stdout.read_u8().await {
            Ok(kind) => kind,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => {
                return Err(format!("Failed to read plugin '{}' frame kind: {error}", session.plugin.manifest.id))
            }
        };
        let length =
            stdout.read_u32().await.map_err(|error| {
                format!("Failed to read plugin '{}' frame length: {error}", session.plugin.manifest.id)
            })? as usize;
        let maximum = if kind == FRAME_KIND_JSON { MAX_JSON_MESSAGE_BYTES } else { MAX_BINARY_MESSAGE_BYTES + 1024 };
        if length > maximum {
            return Err(format!("Plugin '{}' frame exceeds {maximum} bytes", session.plugin.manifest.id));
        }
        let mut payload = vec![0; length];
        stdout.read_exact(&mut payload).await.map_err(|error| {
            format!("Failed to read plugin '{}' frame payload: {error}", session.plugin.manifest.id)
        })?;
        match kind {
            FRAME_KIND_JSON => session.dispatch_json(&payload).await?,
            FRAME_KIND_BINARY => session.dispatch_binary(Bytes::from(payload))?,
            _ => return Err(format!("Plugin '{}' sent unknown frame kind {kind}", session.plugin.manifest.id)),
        }
    }
}

async fn read_limited_line<R>(reader: &mut R, maximum: usize) -> std::io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if output.is_empty() { Ok(None) } else { Ok(Some(output)) };
        }
        let take = available.iter().position(|byte| *byte == b'\n').map(|index| index + 1).unwrap_or(available.len());
        if output.len().saturating_add(take) > maximum {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "plugin output line is too large"));
        }
        output.extend_from_slice(&available[..take]);
        reader.consume(take);
        if output.last() == Some(&b'\n') {
            return Ok(Some(output));
        }
    }
}

fn trim_ascii_whitespace(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[1..];
    }
    while bytes.last().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

fn decode_response_value(plugin_id: &str, value: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Err(message);
    }
    if value.get("result").is_none() && value.get("error").is_none() {
        return Err(format!("Plugin '{plugin_id}' response has neither result nor error"));
    }
    Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

async fn fail_pending(pending: &Mutex<HashMap<u64, PendingResponse>>, message: &str) {
    let responses = std::mem::take(&mut *pending.lock().await);
    for (_, sender) in responses {
        let _ = sender.send(Err(message.to_string()));
    }
}

fn validate_binary_channel(channel: &str) -> Result<(), String> {
    if channel.is_empty() || channel.len() > u16::MAX as usize {
        return Err("Plugin binary channel must contain 1-65535 bytes".to_string());
    }
    if channel.chars().any(char::is_whitespace) {
        return Err("Plugin binary channel cannot contain whitespace".to_string());
    }
    Ok(())
}

fn validate_protocol_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '/' | '-'))
    {
        return Err("Plugin protocol name is invalid".to_string());
    }
    Ok(())
}

fn ensure_plugin_backend(plugin: &InstalledPlugin) -> Result<(), String> {
    if !plugin.compatibility.compatible {
        return Err(format!(
            "Plugin '{}' is incompatible: {}",
            plugin.manifest.id,
            plugin.compatibility.errors.join("; ")
        ));
    }
    if plugin.compatibility.backend_executable.is_none() {
        return Err(format!("Plugin '{}' does not provide a backend entrypoint", plugin.manifest.id));
    }
    Ok(())
}

fn spawn_plugin_child(plugin: &InstalledPlugin, app_version: &str, env: &PluginRuntimeEnv) -> Result<Child, String> {
    let executable_path =
        plugin.compatibility.backend_executable.as_ref().ok_or_else(|| {
            format!("Plugin '{}' does not provide a compatible backend executable", plugin.manifest.id)
        })?;
    ensure_executable_permission(executable_path)?;
    let mut command = crate::process::new_tokio_command(executable_path);
    command
        .current_dir(&plugin.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("DBX_PLUGIN_ID", &plugin.manifest.id)
        .env("DBX_PLUGIN_VERSION", &plugin.manifest.version)
        .env("DBX_APP_VERSION", app_version)
        .env("DBX_HOST_API_VERSION", SUPPORTED_PLUGIN_HOST_API_VERSION)
        .env("DBX_PLUGIN_PROTOCOL_VERSION", SUPPORTED_PLUGIN_PROTOCOL_VERSION.to_string());
    env.apply_to(&mut command);
    command.spawn().map_err(|error| format!("Failed to start plugin '{}': {error}", plugin.manifest.id))
}

fn ensure_executable_permission(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = std::fs::metadata(path).map_err(|error| error.to_string())?.permissions().mode();
        if mode & 0o111 == 0 {
            return Err(format!("Plugin backend is not executable: {}", path.display()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        decode_response_value, read_limited_line, trim_ascii_whitespace, PluginSessionState, PluginSidecarSession,
    };
    use crate::plugins::{InstalledPlugin, PluginManifest, PluginRuntimeEnv};
    use tokio::io::BufReader;

    #[tokio::test]
    async fn rejects_oversized_json_lines_before_unbounded_growth() {
        let mut reader = BufReader::new(std::io::Cursor::new(b"123456\n"));
        let error = read_limited_line(&mut reader, 4).await.expect_err("line should be rejected");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn decodes_json_rpc_result_and_error() {
        assert_eq!(
            decode_response_value("sample", serde_json::json!({ "id": 1, "result": { "ok": true } })).unwrap(),
            serde_json::json!({ "ok": true })
        );
        assert_eq!(
            decode_response_value("sample", serde_json::json!({ "id": 1, "error": { "message": "boom" } }))
                .unwrap_err(),
            "boom"
        );
    }

    #[test]
    fn trims_protocol_whitespace() {
        assert_eq!(trim_ascii_whitespace(b" \n{}\r\n"), b"{}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn negotiates_routes_concurrent_responses_and_forwards_events() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("plugin.sh");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
IFS= read -r initialize
initialize_id=$(printf '%s' "$initialize" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"capabilities":["events"],"plugin":{"id":"sample.sidecar","version":"1.0.0"}}}\n' "$initialize_id"
IFS= read -r first
IFS= read -r second
first_id=$(printf '%s' "$first" | sed -E 's/.*"id":([0-9]+).*/\1/')
second_id=$(printf '%s' "$second" | sed -E 's/.*"id":([0-9]+).*/\1/')
first_method=$(printf '%s' "$first" | sed -E 's/.*"method":"([^"]+)".*/\1/')
second_method=$(printf '%s' "$second" | sed -E 's/.*"method":"([^"]+)".*/\1/')
printf '{"jsonrpc":"2.0","method":"sample/progress","params":{"value":50}}\n'
printf '{"jsonrpc":"2.0","id":%s,"result":"%s"}\n' "$second_id" "$second_method"
printf '{"jsonrpc":"2.0","id":%s,"result":"%s"}\n' "$first_id" "$first_method"
sleep 30
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "sample.sidecar",
            "name": "Sample Sidecar",
            "version": "1.0.0",
            "publisher": "dbx",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "permissions": ["host.events"],
            "entrypoints": {
                "backend": {
                    "protocol_versions": [1],
                    "transport": "stdio-jsonl",
                    "executable": "plugin.sh"
                }
            }
        }))
        .unwrap();
        let plugin = InstalledPlugin::new(manifest, dir.path().to_path_buf(), "0.5.67");
        let session = PluginSidecarSession::start(plugin, "0.5.67", PluginRuntimeEnv::default())
            .await
            .expect("v1 sidecar should initialize");
        assert_eq!(session.status().state, PluginSessionState::Running);
        assert_eq!(session.handshake().await.unwrap().capabilities, vec!["events"]);
        let mut events = session.subscribe_events();

        let first = session.invoke::<String>("sample/first", serde_json::Value::Null);
        let second = session.invoke::<String>("sample/second", serde_json::Value::Null);
        let (first, second) = tokio::join!(first, second);

        assert_eq!(first.unwrap(), "sample/first");
        assert_eq!(second.unwrap(), "sample/second");
        let event = events.recv().await.unwrap();
        assert_eq!(event.method, "sample/progress");
        assert_eq!(event.params["value"], 50);
        session.shutdown().await;
        assert_eq!(session.status().state, PluginSessionState::Stopped);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_initialize_terminates_plugin_process() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("plugin.sh");
        let pid_file = dir.path().join("plugin.pid");
        std::fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
printf '%s' "$$" > '{}'
IFS= read -r initialize
initialize_id=$(printf '%s' "$initialize" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":1,"capabilities":[],"plugin":{{"id":"wrong.sidecar","version":"1.0.0"}}}}}}\n' "$initialize_id"
sleep 30
"#,
                pid_file.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "sample.sidecar",
            "name": "Sample Sidecar",
            "version": "1.0.0",
            "publisher": "dbx",
            "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
            "entrypoints": {
                "backend": {
                    "protocol_versions": [1],
                    "transport": "stdio-jsonl",
                    "executable": "plugin.sh"
                }
            }
        }))
        .unwrap();
        let plugin = InstalledPlugin::new(manifest, dir.path().to_path_buf(), "0.5.67");
        let error = match PluginSidecarSession::start(plugin, "0.5.67", PluginRuntimeEnv::default()).await {
            Ok(session) => {
                session.shutdown().await;
                panic!("mismatched backend identity should fail initialization")
            }
            Err(error) => error,
        };
        assert!(error.contains("does not match manifest"));

        let pid = std::fs::read_to_string(&pid_file).unwrap().parse::<u32>().unwrap();
        for _ in 0..20 {
            if !process_exists(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!process_exists(pid), "plugin process {pid} survived failed initialization");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_jsonl_runtime_ignores_banner_output() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("plugin.sh");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
IFS= read -r request
request_id=$(printf '%s' "$request" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf 'legacy banner\n'
printf '{"id":%s,"result":{"ok":true}}\n' "$request_id"
sleep 30
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy",
            "executable": "plugin.sh"
        }))
        .unwrap();
        let plugin = InstalledPlugin::new(manifest, dir.path().to_path_buf(), "0.5.67");
        let session = PluginSidecarSession::start(plugin, "0.5.67", PluginRuntimeEnv::default()).await.unwrap();
        let result: serde_json::Value = session.invoke("ping", serde_json::Value::Null).await.unwrap();
        assert_eq!(result["ok"], true);
        session.shutdown().await;
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
