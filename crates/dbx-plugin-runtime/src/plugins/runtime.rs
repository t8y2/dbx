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
use tokio::time::Instant;

use super::{
    InstalledPlugin, PluginBackendTransport, PluginRuntimeEnv, SUPPORTED_PLUGIN_HOST_API_VERSION,
    SUPPORTED_PLUGIN_HOST_FEATURES, SUPPORTED_PLUGIN_PROTOCOL_VERSION,
};
use dbx_platform::ssh_prompt;

pub const PLUGIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Host API method a plugin backend calls to ask the user for input
/// (`user_input.rs` semantics). Plugin-initiated requests use string ids, which
/// is what lets one stream carry both directions (see `dispatch_json`).
pub const PLUGIN_REQUEST_USER_INPUT_METHOD: &str = "host/requestUserInput";
/// Namespace reserved for host-initiated requests, i.e. calls a plugin makes
/// back into the host. Plugin manifests never receive methods from it.
pub const PLUGIN_HOST_REQUEST_PREFIX: &str = "host/";
/// Cap on user prompts a single plugin session may have open at once, so a
/// broken or hostile backend cannot stack dialogs.
const MAX_PLUGIN_PROMPTS_IN_FLIGHT: usize = 4;
/// Total time one request may spend paused on user input before it fails.
const MAX_PROMPT_PAUSE: Duration = Duration::from_secs(600);
const USER_INPUT_DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
const USER_INPUT_MIN_TIMEOUT: Duration = Duration::from_secs(5);
const USER_INPUT_MAX_TIMEOUT: Duration = Duration::from_secs(600);
const USER_INPUT_MAX_PROMPT_CHARS: usize = 2_000;
const USER_INPUT_MAX_TITLE_CHARS: usize = 200;
const USER_INPUT_MAX_DEFAULT_CHARS: usize = 1_000;
const USER_INPUT_MAX_OPTIONS: usize = 8;
const USER_INPUT_MAX_OPTION_CHARS: usize = 200;
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
    /// Host capabilities a plugin can rely on for this session. Feature names
    /// are the Host API methods the plugin may call.
    features: &'static [&'static str],
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
    /// Open `host/requestUserInput` prompts. While non-zero the host pauses the
    /// request deadlines of this session so a user typing an MFA code cannot
    /// fail a plugin `connection/test` or `connection/connect` call.
    prompts: PromptActivity,
}

/// Tracks whether this plugin session has a user prompt open, and wakes the
/// requests that are waiting on a response so they can start or stop pausing
/// their deadline.
#[derive(Default)]
struct PromptActivity {
    state: watch::Sender<PromptState>,
}

#[derive(Clone, Copy, Default)]
struct PromptState {
    open: usize,
    closed: bool,
}

impl PromptActivity {
    fn begin(&self) {
        self.state.send_modify(|state| state.open += 1);
    }

    fn end(&self) {
        self.state.send_modify(|state| state.open -= 1);
    }

    /// Releases every open prompt when the session goes away, so the dialog
    /// does not linger in front of a plugin that can no longer answer.
    fn close(&self) {
        self.state.send_modify(|state| state.closed = true);
    }

    async fn wait_close(&self) {
        let mut state = self.state.subscribe();
        let _ = state.wait_for(|state| state.closed).await;
    }
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
            prompts: PromptActivity::default(),
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
        // Let any open user prompt resolve and close its dialog.
        self.prompts.close();
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
                features: SUPPORTED_PLUGIN_HOST_FEATURES,
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

        match timeout_duration {
            Some(duration) => {
                let result = self.await_response(receiver, method, duration).await;
                if result.is_err() {
                    self.pending.lock().await.remove(&request_id);
                }
                result
            }
            None => {
                receiver.await.map_err(|_| format!("Plugin '{}' response channel closed", self.plugin.manifest.id))?
            }
        }
    }

    /// Waits for a host -> plugin response under `duration`, pausing the
    /// deadline while the plugin has a user prompt open. `connection/test` and
    /// `connection/connect` share the connection's connect timeout, which is
    /// far shorter than a human reading a bastion MFA challenge; without the
    /// pause the host would time out while the user is still typing and the
    /// answer would arrive at a dead request.
    async fn await_response(
        &self,
        mut receiver: oneshot::Receiver<Result<serde_json::Value, String>>,
        method: &str,
        duration: Duration,
    ) -> Result<serde_json::Value, String> {
        let mut prompt_state = self.prompts.state.subscribe();
        let start = Instant::now();
        let mut paused_total = Duration::ZERO;
        loop {
            let state = *prompt_state.borrow_and_update();
            if state.closed {
                return Err("Plugin session stopped".to_string());
            }
            let active = start.elapsed().saturating_sub(paused_total);
            if active >= duration {
                return Err(format!(
                    "Plugin '{}' request '{}' timed out after {} seconds",
                    self.plugin.manifest.id,
                    method,
                    duration.as_secs()
                ));
            }
            if state.open > 0 {
                // The user is answering: hold the deadline and re-measure when
                // the prompt state changes.
                let tick = Instant::now();
                tokio::select! {
                    result = &mut receiver => {
                        return result
                            .map_err(|_| format!("Plugin '{}' response channel closed", self.plugin.manifest.id))?;
                    }
                    _ = prompt_state.changed() => {}
                }
                paused_total += tick.elapsed();
                if paused_total > MAX_PROMPT_PAUSE {
                    return Err(format!(
                        "Plugin '{}' request '{}' was waiting for user input for more than {} seconds",
                        self.plugin.manifest.id,
                        method,
                        MAX_PROMPT_PAUSE.as_secs()
                    ));
                }
                continue;
            }
            tokio::select! {
                result = &mut receiver => {
                    return result
                        .map_err(|_| format!("Plugin '{}' response channel closed", self.plugin.manifest.id))?;
                }
                _ = prompt_state.changed() => {}
                _ = tokio::time::sleep(duration - active) => {
                    return Err(format!(
                        "Plugin '{}' request '{}' timed out after {} seconds",
                        self.plugin.manifest.id,
                        method,
                        duration.as_secs()
                    ));
                }
            }
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
            // A plugin that died mid-prompt can no longer answer it.
            session.prompts.close();
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

    async fn dispatch_json(self: &Arc<Self>, payload: &[u8]) -> Result<(), String> {
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
        // Host API requests initiated by the plugin sidecar. The host owns
        // numeric ids (its own requests and the responses to them), the plugin
        // owns string ids, so one stream carries both directions without
        // changing the wire format older hosts already parse. Only `host/*`
        // methods qualify, which keeps a plugin event that happens to carry a
        // string id on the legacy path.
        if let Some(request_id) = value.get("id").and_then(serde_json::Value::as_str) {
            let method = value.get("method").and_then(serde_json::Value::as_str).unwrap_or_default();
            if method.starts_with(PLUGIN_HOST_REQUEST_PREFIX) {
                let request_id = request_id.to_string();
                let method = method.to_string();
                let params = value.get("params").cloned().unwrap_or(serde_json::Value::Null);
                let session = self.clone();
                session.spawn_plugin_request(request_id, method, params);
                return Ok(());
            }
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

    /// Answers one plugin-initiated Host API request in the background. The
    /// stdout reader must keep draining plugin output while a prompt is open
    /// (the plugin may still emit events), so the work is spawned instead of
    /// being awaited inline.
    fn spawn_plugin_request(self: &Arc<Self>, id: String, method: String, params: serde_json::Value) {
        let session = self.clone();
        tokio::spawn(async move {
            let result = session.handle_plugin_request(&method, params).await;
            if let Err(error) = session.respond_to_plugin_request(&id, result).await {
                log::warn!("[plugin:{}] failed to answer '{method}': {error}", session.plugin.manifest.id);
            }
        });
    }

    /// Dispatches a Host API method a plugin called. Errors use JSON-RPC codes
    /// so a plugin can tell "the host cannot ask the user" from "you asked for
    /// something invalid" and degrade accordingly.
    async fn handle_plugin_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, PluginHostRequestError> {
        match method {
            PLUGIN_REQUEST_USER_INPUT_METHOD => self.request_user_input(params).await,
            other => Err(PluginHostRequestError::method_not_found(other)),
        }
    }

    /// `host/requestUserInput` (Host API 1.1): relay one question to the user
    /// and return the answer. The host only carries the question and the typed
    /// value — it never answers on the user's behalf, and without an attached
    /// UI it fails immediately so the plugin can fail closed instead of waiting.
    async fn request_user_input(&self, params: serde_json::Value) -> Result<serde_json::Value, PluginHostRequestError> {
        let spec = UserInputSpec::parse(params)?;
        let state = *self.prompts.state.borrow();
        if state.closed {
            return Ok(serde_json::json!({ "action": "cancel" }));
        }
        if state.open >= MAX_PLUGIN_PROMPTS_IN_FLIGHT {
            return Err(PluginHostRequestError::new(
                -32002,
                format!("Plugin already has {MAX_PLUGIN_PROMPTS_IN_FLIGHT} input prompts open"),
            ));
        }

        let prompt = ssh_prompt::UserInputRequest::new(spec.prompt.clone())
            .with_title(spec.title.clone())
            .with_source(Some(self.plugin.manifest.name.clone()))
            .with_default(spec.default_value.clone())
            .with_options(spec.options.clone())
            .with_echo(spec.echo)
            .into_request("", 0);
        let Some(receiver) = ssh_prompt::request_ssh_prompt(prompt) else {
            return Err(PluginHostRequestError::new(-32001, "The DBX host cannot ask the user for input right now"));
        };

        self.prompts.begin();
        let answer = tokio::select! {
            result = tokio::time::timeout(spec.timeout, receiver) => Some(result),
            // Session gone: drop the receiver so the dialog is dismissed.
            _ = self.prompts.wait_close() => None,
        };
        self.prompts.end();

        Ok(match answer {
            Some(Ok(Ok(answer))) => user_input_result(answer),
            // The prompt was dismissed mid-flight (the dialog closed, the
            // session went away) or the UI is gone: report a cancel, never a
            // synthesized answer.
            Some(Ok(Err(_))) | None => serde_json::json!({ "action": "cancel" }),
            Some(Err(_)) => serde_json::json!({ "action": "timeout" }),
        })
    }

    async fn respond_to_plugin_request(
        &self,
        id: &str,
        result: Result<serde_json::Value, PluginHostRequestError>,
    ) -> Result<(), String> {
        let value = match result {
            Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": error.code, "message": error.message }
            }),
        };
        let payload = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        self.write_json(&payload).await
    }
}

/// A JSON-RPC error returned to a plugin-initiated Host API call.
#[derive(Debug)]
struct PluginHostRequestError {
    code: i64,
    message: String,
}

impl PluginHostRequestError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("Method not found: {method}"))
    }

    fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(-32602, message)
    }
}

/// Validated `host/requestUserInput` params. Bounded so a plugin cannot push an
/// unbounded payload or an unusable timeout into the dialog.
#[derive(Debug)]
struct UserInputSpec {
    prompt: String,
    echo: bool,
    title: Option<String>,
    default_value: Option<String>,
    options: Vec<ssh_prompt::SshPromptOption>,
    timeout: Duration,
}

impl UserInputSpec {
    fn parse(params: serde_json::Value) -> Result<Self, PluginHostRequestError> {
        let object =
            params.as_object().ok_or_else(|| PluginHostRequestError::invalid_params("params must be an object"))?;
        let prompt = match object.get("prompt") {
            Some(serde_json::Value::String(prompt)) if !prompt.trim().is_empty() => prompt.clone(),
            _ => return Err(PluginHostRequestError::invalid_params("'prompt' must be a non-empty string")),
        };
        if prompt.chars().count() > USER_INPUT_MAX_PROMPT_CHARS {
            return Err(PluginHostRequestError::invalid_params(format!(
                "'prompt' must be at most {USER_INPUT_MAX_PROMPT_CHARS} characters"
            )));
        }

        let title = optional_text(object.get("title"), "title", USER_INPUT_MAX_TITLE_CHARS)?;
        let default_value = optional_text(object.get("default"), "default", USER_INPUT_MAX_DEFAULT_CHARS)?;
        let echo = match object.get("echo") {
            None | Some(serde_json::Value::Null) => false,
            Some(serde_json::Value::Bool(echo)) => *echo,
            Some(_) => return Err(PluginHostRequestError::invalid_params("'echo' must be a boolean")),
        };

        let mut options = Vec::new();
        if let Some(value) = object.get("options") {
            let list =
                value.as_array().ok_or_else(|| PluginHostRequestError::invalid_params("'options' must be an array"))?;
            if list.len() > USER_INPUT_MAX_OPTIONS {
                return Err(PluginHostRequestError::invalid_params(format!(
                    "'options' supports at most {USER_INPUT_MAX_OPTIONS} entries"
                )));
            }
            for entry in list {
                let entry = entry
                    .as_object()
                    .ok_or_else(|| PluginHostRequestError::invalid_params("each option must be an object"))?;
                let value = entry
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| PluginHostRequestError::invalid_params("each option needs a non-empty 'value'"))?;
                let label = entry
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or(value);
                if value.chars().count() > USER_INPUT_MAX_OPTION_CHARS
                    || label.chars().count() > USER_INPUT_MAX_OPTION_CHARS
                {
                    return Err(PluginHostRequestError::invalid_params(format!(
                        "option values and labels must be at most {USER_INPUT_MAX_OPTION_CHARS} characters"
                    )));
                }
                if options.iter().any(|existing: &ssh_prompt::SshPromptOption| existing.value == value) {
                    return Err(PluginHostRequestError::invalid_params("option values must be unique"));
                }
                options.push(ssh_prompt::SshPromptOption { value: value.to_string(), label: label.to_string() });
            }
        }

        let timeout = match object.get("timeoutSecs") {
            None | Some(serde_json::Value::Null) => USER_INPUT_DEFAULT_TIMEOUT,
            Some(value) => match value.as_u64() {
                Some(seconds) => Duration::from_secs(seconds).clamp(USER_INPUT_MIN_TIMEOUT, USER_INPUT_MAX_TIMEOUT),
                None => return Err(PluginHostRequestError::invalid_params("'timeoutSecs' must be a number")),
            },
        };

        Ok(Self { prompt, echo, title, default_value, options, timeout })
    }
}

fn optional_text(
    value: Option<&serde_json::Value>,
    name: &str,
    maximum: usize,
) -> Result<Option<String>, PluginHostRequestError> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(text)) if text.chars().count() <= maximum => Ok(Some(text.clone())),
        Some(serde_json::Value::String(_)) => {
            Err(PluginHostRequestError::invalid_params(format!("'{name}' must be at most {maximum} characters")))
        }
        Some(_) => Err(PluginHostRequestError::invalid_params(format!("'{name}' must be a string"))),
    }
}

/// Maps a user's answer to the `host/requestUserInput` result payload. Only a
/// typed value counts as a submission: host-key wording or a dismissal is a
/// cancel, so a plugin can never mistake "the dialog went away" for an answer.
fn user_input_result(answer: ssh_prompt::SshPromptAnswer) -> serde_json::Value {
    match answer {
        ssh_prompt::SshPromptAnswer::Secret(value) => serde_json::json!({ "action": "submit", "value": value }),
        ssh_prompt::SshPromptAnswer::Reject | ssh_prompt::SshPromptAnswer::Accept { .. } => {
            serde_json::json!({ "action": "cancel" })
        }
    }
}

async fn read_json_lines(
    session: &Arc<PluginSidecarSession>,
    mut reader: BufReader<ChildStdout>,
) -> Result<(), String> {
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

async fn read_framed(session: &Arc<PluginSidecarSession>, mut stdout: ChildStdout) -> Result<(), String> {
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
        decode_response_value, read_limited_line, trim_ascii_whitespace, user_input_result, PluginSessionState,
        PluginSidecarSession, PromptActivity, UserInputSpec, USER_INPUT_DEFAULT_TIMEOUT, USER_INPUT_MAX_OPTIONS,
        USER_INPUT_MAX_TIMEOUT, USER_INPUT_MIN_TIMEOUT,
    };
    use crate::plugins::{InstalledPlugin, PluginManifest, PluginRuntimeEnv};
    use tokio::io::BufReader;

    async fn assert_pending<F: std::future::Future>(mut future: std::pin::Pin<&mut F>) {
        std::future::poll_fn(|context| {
            assert!(future.as_mut().poll(context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
    }

    #[tokio::test]
    async fn prompt_activity_closes_all_waiters_and_stays_closed() {
        let prompts = PromptActivity::default();
        let first = prompts.wait_close();
        let second = prompts.wait_close();
        tokio::pin!(first, second);
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;

        prompts.close();
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(first, second);
        })
        .await
        .expect("every registered waiter must observe closure");
        prompts.begin();
        prompts.end();
        prompts.close();
        tokio::time::timeout(Duration::from_secs(1), prompts.wait_close())
            .await
            .expect("closure must persist for late subscribers after activity changes");
    }

    #[tokio::test]
    async fn prompt_activity_preserves_changes_between_read_and_wait() {
        let prompts = PromptActivity::default();
        let mut first = prompts.state.subscribe();
        let mut second = prompts.state.subscribe();
        for receiver in [&mut first, &mut second] {
            assert_eq!(receiver.borrow_and_update().open, 0);
        }
        prompts.begin();
        for receiver in [&mut first, &mut second] {
            tokio::time::timeout(Duration::from_secs(1), receiver.changed()).await.unwrap().unwrap();
            assert_eq!(receiver.borrow_and_update().open, 1);
        }
        prompts.end();
        for receiver in [&mut first, &mut second] {
            tokio::time::timeout(Duration::from_secs(1), receiver.changed()).await.unwrap().unwrap();
            assert_eq!(receiver.borrow_and_update().open, 0);
        }
        prompts.close();
        for receiver in [&mut first, &mut second] {
            tokio::time::timeout(Duration::from_secs(1), receiver.changed()).await.unwrap().unwrap();
            assert!(receiver.borrow_and_update().closed);
        }
    }

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

    /// Installs a sidecar that forwards two questions to the host over string
    /// ids and echoes whatever it got back, so a test can assert the Host API
    /// answers: `host/requestUserInput` plus an unknown `host/*` method.
    #[cfg(unix)]
    fn write_questioning_sidecar(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let executable = dir.join("plugin.sh");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
IFS= read -r initialize
initialize_id=$(printf '%s' "$initialize" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"capabilities":[],"plugin":{"id":"sample.sidecar","version":"1.0.0"}}}\n' "$initialize_id"
IFS= read -r echo_request
echo_id=$(printf '%s' "$echo_request" | sed -E 's/.*"id":([0-9]+).*/\1/')
printf '{"jsonrpc":"2.0","id":"prompt-1","method":"host/requestUserInput","params":{"prompt":"Verification code","echo":true}}\n'
printf '{"jsonrpc":"2.0","id":"prompt-2","method":"host/unknown","params":{}}\n'
IFS= read -r first_answer
IFS= read -r second_answer
printf '{"jsonrpc":"2.0","id":%s,"result":{"first":%s,"second":%s}}\n' "$echo_id" "$first_answer" "$second_answer"
sleep 30
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();
        executable
    }

    #[cfg(unix)]
    async fn questioning_session(dir: &std::path::Path) -> std::sync::Arc<PluginSidecarSession> {
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
        let plugin = InstalledPlugin::new(manifest, dir.to_path_buf(), "0.6.14");
        PluginSidecarSession::start(plugin, "0.6.14", PluginRuntimeEnv::default())
            .await
            .expect("v1 sidecar should initialize")
    }

    /// The sidecar echoes both answers, and the unknown method answers first, so
    /// tests must look responses up by id instead of by position.
    #[cfg(unix)]
    fn echoed_answer<'a>(echoed: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
        ["first", "second"]
            .iter()
            .map(|slot| &echoed[*slot])
            .find(|response| response["id"] == id)
            .unwrap_or_else(|| panic!("no answer for {id} in {echoed}"))
    }

    /// Installs a prompt gateway that records every request it relays and
    /// answers after `delay` — the test-visible stand-in for the desktop dialog.
    #[cfg(unix)]
    fn install_prompt_harness(
        delay: Duration,
        answer: dbx_platform::ssh_prompt::SshPromptAnswer,
    ) -> tokio::sync::mpsc::UnboundedReceiver<(
        dbx_platform::ssh_prompt::SshPromptRequest,
        dbx_platform::ssh_prompt::SshPromptAnswer,
    )> {
        use dbx_platform::ssh_prompt;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<ssh_prompt::SshPromptEnvelope>(4);
        ssh_prompt::install_ssh_prompt_gateway(tx);
        let (seen_tx, seen_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(envelope) = rx.recv().await {
                let _ = seen_tx.send((envelope.request.clone(), answer.clone()));
                tokio::time::sleep(delay).await;
                let _ = envelope.responder.send(answer.clone());
            }
        });
        seen_rx
    }

    /// Installs a prompt gateway that relays requests to the test and never
    /// answers, so the test can watch what happens to a prompt nobody answers.
    #[cfg(unix)]
    fn install_silent_prompt_harness() -> tokio::sync::mpsc::UnboundedReceiver<(
        dbx_platform::ssh_prompt::SshPromptRequest,
        tokio::sync::oneshot::Sender<dbx_platform::ssh_prompt::SshPromptAnswer>,
    )> {
        use dbx_platform::ssh_prompt;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<ssh_prompt::SshPromptEnvelope>(4);
        ssh_prompt::install_ssh_prompt_gateway(tx);
        let (seen_tx, seen_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(envelope) = rx.recv().await {
                let _ = seen_tx.send((envelope.request, envelope.responder));
            }
        });
        seen_rx
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fails_plugin_prompts_closed_without_a_prompt_ui() {
        use dbx_platform::ssh_prompt;

        let _guard = ssh_prompt::prompt_gateway_test_lock().lock().await;
        ssh_prompt::clear_ssh_prompt_gateway();
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;

        let echoed: serde_json::Value = session
            .invoke("sample/echo", serde_json::Value::Null)
            .await
            .expect("host should answer every plugin-initiated request");
        session.shutdown().await;

        // A headless host (tests, MCP) must refuse instead of hanging the
        // plugin until the prompt timeout expires.
        let prompt = echoed_answer(&echoed, "prompt-1");
        assert_eq!(prompt["error"]["code"], -32001);
        let unknown = echoed_answer(&echoed, "prompt-2");
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relays_plugin_user_input_through_the_prompt_gateway() {
        use dbx_platform::ssh_prompt::{self, SshPromptAnswer, SshPromptKind};

        let _guard = ssh_prompt::prompt_gateway_test_lock().lock().await;
        let mut prompts = install_prompt_harness(Duration::ZERO, SshPromptAnswer::Secret("123456".to_string()));
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;

        let echoed: serde_json::Value = session
            .invoke("sample/echo", serde_json::Value::Null)
            .await
            .expect("host should answer every plugin-initiated request");
        session.shutdown().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        let prompt = echoed_answer(&echoed, "prompt-1");
        assert_eq!(prompt["result"]["action"], "submit");
        assert_eq!(prompt["result"]["value"], "123456");

        // The host relays the question and the answer, nothing else: the plugin
        // asked, the user typed, and the host never synthesizes a value.
        let (request, answer) = prompts.recv().await.expect("the host should relay exactly one prompt");
        assert_eq!(request.kind, SshPromptKind::UserInput);
        assert_eq!(request.source.as_deref(), Some("Sample Sidecar"));
        assert_eq!(request.prompt.as_deref(), Some("Verification code"));
        assert!(request.echo);
        assert_eq!(answer, SshPromptAnswer::Secret("123456".to_string()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_plugin_user_input_cancel_when_the_user_dismisses_the_prompt() {
        use dbx_platform::ssh_prompt::{self, SshPromptAnswer};

        let _guard = ssh_prompt::prompt_gateway_test_lock().lock().await;
        install_prompt_harness(Duration::ZERO, SshPromptAnswer::Reject);
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;

        let echoed: serde_json::Value = session
            .invoke("sample/echo", serde_json::Value::Null)
            .await
            .expect("host should answer every plugin-initiated request");
        session.shutdown().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        let prompt = echoed_answer(&echoed, "prompt-1");
        assert_eq!(prompt["result"]["action"], "cancel");
        assert!(prompt["result"].get("value").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connection_request_timeout_pauses_while_the_user_types() {
        use dbx_platform::ssh_prompt::{self, SshPromptAnswer};

        let _guard = ssh_prompt::prompt_gateway_test_lock().lock().await;
        // The user needs longer than the caller's connect timeout. `connection/
        // test` and `connection/connect` share that timeout, so without the
        // prompt pause the plugin would answer a request the host had already
        // abandoned — exactly the bug this channel exists to avoid.
        install_prompt_harness(Duration::from_millis(700), SshPromptAnswer::Secret("123456".to_string()));
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;

        let echoed: serde_json::Value = session
            .invoke_with_timeout("sample/echo", serde_json::Value::Null, None, Some(Duration::from_millis(300)))
            .await
            .expect("a prompt must pause the request deadline instead of failing it");
        session.shutdown().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        assert_eq!(echoed_answer(&echoed, "prompt-1")["result"]["value"], "123456");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_a_plugin_session_releases_its_open_prompt() {
        use dbx_platform::ssh_prompt;

        let _guard = ssh_prompt::prompt_gateway_test_lock().lock().await;
        let mut prompts = install_silent_prompt_harness();
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;

        let caller = {
            let session = session.clone();
            tokio::spawn(
                async move { session.invoke::<serde_json::Value>("sample/echo", serde_json::Value::Null).await },
            )
        };
        let (request, responder) = prompts.recv().await.expect("the plugin should ask before answering");
        assert_eq!(request.kind, dbx_platform::ssh_prompt::SshPromptKind::UserInput);
        assert!(!responder.is_closed());

        session.shutdown().await;
        ssh_prompt::clear_ssh_prompt_gateway();

        // The request fails (the session is gone) and the prompt's responder is
        // dropped, which is how the dialog learns to dismiss itself instead of
        // waiting for a plugin that will never answer.
        let error = tokio::time::timeout(Duration::from_secs(5), async { caller.await.unwrap().unwrap_err() })
            .await
            .expect("stopping the session must not strand the caller");
        assert!(error.contains("stopped") || error.contains("closed"), "{error}");
        assert!(responder.is_closed(), "the prompt must be released when the session stops");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_a_plugin_session_releases_all_open_prompts() {
        use dbx_platform::ssh_prompt;

        let _guard = ssh_prompt::prompt_gateway_test_lock().lock().await;
        let mut prompts = install_silent_prompt_harness();
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;
        let first = session.request_user_input(serde_json::json!({ "prompt": "First code" }));
        let second = session.request_user_input(serde_json::json!({ "prompt": "Second code" }));
        tokio::pin!(first, second);
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        let (_, first_responder) = prompts.recv().await.unwrap();
        let (_, second_responder) = prompts.recv().await.unwrap();
        assert!(!first_responder.is_closed());
        assert!(!second_responder.is_closed());
        assert_eq!(session.prompts.state.borrow().open, 2);

        session.shutdown().await;
        let (first_answer, second_answer) =
            tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(first, second) })
                .await
                .expect("stopping the session must cancel all prompts without waiting for their deadlines");
        assert_eq!(first_answer.unwrap(), serde_json::json!({ "action": "cancel" }));
        assert_eq!(second_answer.unwrap(), serde_json::json!({ "action": "cancel" }));
        assert!(first_responder.is_closed());
        assert!(second_responder.is_closed());
        assert_eq!(session.prompts.state.borrow().open, 0);
        assert_eq!(
            session.request_user_input(serde_json::json!({ "prompt": "Too late" })).await.unwrap(),
            serde_json::json!({ "action": "cancel" })
        );
        assert!(prompts.try_recv().is_err());
        ssh_prompt::clear_ssh_prompt_gateway();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_response_deadlines_pause_and_resume_together() {
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;
        tokio::time::pause();
        let (_first_sender, first_receiver) = tokio::sync::oneshot::channel();
        let (_second_sender, second_receiver) = tokio::sync::oneshot::channel();
        let first = session.await_response(first_receiver, "sample/first", Duration::from_secs(30));
        let second = session.await_response(second_receiver, "sample/second", Duration::from_secs(30));
        tokio::pin!(first, second);
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;

        tokio::time::advance(Duration::from_secs(10)).await;
        session.prompts.begin();
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        session.prompts.begin();
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        session.prompts.end();
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        session.prompts.end();
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;

        tokio::time::advance(Duration::from_secs(19)).await;
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        tokio::time::advance(Duration::from_secs(1)).await;
        let (first_result, second_result) =
            tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(first, second) })
                .await
                .expect("every response deadline must resume when the final prompt ends");
        for result in [first_result, second_result] {
            assert!(result.unwrap_err().contains("timed out after 30 seconds"));
        }
        tokio::time::resume();
        session.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_paused_responses_still_accept_success_and_channel_closure() {
        let dir = tempfile::tempdir().unwrap();
        write_questioning_sidecar(dir.path());
        let session = questioning_session(dir.path()).await;
        let (first_sender, first_receiver) = tokio::sync::oneshot::channel();
        let (second_sender, second_receiver) = tokio::sync::oneshot::channel();
        session.prompts.begin();
        let first = session.await_response(first_receiver, "sample/first", Duration::from_secs(30));
        let second = session.await_response(second_receiver, "sample/second", Duration::from_secs(30));
        tokio::pin!(first, second);
        assert_pending(first.as_mut()).await;
        assert_pending(second.as_mut()).await;
        first_sender.send(Ok(serde_json::json!({ "ok": true }))).unwrap();
        drop(second_sender);
        assert_eq!(first.await.unwrap(), serde_json::json!({ "ok": true }));
        assert!(second.await.unwrap_err().contains("response channel closed"));
        session.prompts.end();
        session.shutdown().await;
    }

    #[test]
    fn maps_user_answers_to_host_request_user_input_results() {
        use dbx_platform::ssh_prompt::SshPromptAnswer;

        assert_eq!(
            user_input_result(SshPromptAnswer::Secret("123456".to_string())),
            serde_json::json!({ "action": "submit", "value": "123456" })
        );
        // Host-key wording and a dismissal are never an answer.
        assert_eq!(user_input_result(SshPromptAnswer::Reject), serde_json::json!({ "action": "cancel" }));
        assert_eq!(
            user_input_result(SshPromptAnswer::Accept { remember: true }),
            serde_json::json!({ "action": "cancel" })
        );
    }

    #[test]
    fn parses_and_bounds_host_request_user_input_params() {
        let spec = UserInputSpec::parse(serde_json::json!({
            "prompt": "Verification code",
            "title": "Bastion MFA",
            "secret": true,
            "echo": true,
            "default": "000000",
            "options": [{ "value": "totp", "label": "TOTP" }],
            "timeoutSecs": 90
        }))
        .unwrap();
        assert_eq!(spec.prompt, "Verification code");
        assert_eq!(spec.title.as_deref(), Some("Bastion MFA"));
        assert_eq!(spec.default_value.as_deref(), Some("000000"));
        assert!(spec.echo);
        assert_eq!(spec.options.len(), 1);
        assert_eq!(spec.options[0].value, "totp");
        assert_eq!(spec.timeout, Duration::from_secs(90));

        // An option without a label falls back to its value; the host clamps
        // timeouts and defaults `echo` to masked input.
        let spec = UserInputSpec::parse(serde_json::json!({
            "prompt": "Pick one",
            "options": [{ "value": "a" }],
            "timeoutSecs": 1
        }))
        .unwrap();
        assert_eq!(spec.options[0].label, "a");
        assert!(!spec.echo);
        assert_eq!(spec.timeout, USER_INPUT_MIN_TIMEOUT);

        let spec = UserInputSpec::parse(serde_json::json!({
            "prompt": "Pick one",
            "timeoutSecs": 100_000
        }))
        .unwrap();
        assert_eq!(spec.timeout, USER_INPUT_MAX_TIMEOUT);
        assert_eq!(
            UserInputSpec::parse(serde_json::json!({ "prompt": "x" })).unwrap().timeout,
            USER_INPUT_DEFAULT_TIMEOUT
        );

        for invalid in [
            serde_json::json!("not-an-object"),
            serde_json::json!({}),
            serde_json::json!({ "prompt": "   " }),
            serde_json::json!({ "prompt": "x".repeat(2001) }),
            serde_json::json!({ "prompt": "x", "title": 1 }),
            serde_json::json!({ "prompt": "x", "echo": "yes" }),
            serde_json::json!({ "prompt": "x", "timeoutSecs": -1 }),
            serde_json::json!({ "prompt": "x", "options": { "value": "a" } }),
            serde_json::json!({ "prompt": "x", "options": [{ "label": "A" }] }),
            serde_json::json!({ "prompt": "x", "options": [{ "value": "a" }, { "value": "a" }] }),
            serde_json::json!({
                "prompt": "x",
                "options": (0..USER_INPUT_MAX_OPTIONS + 1).map(|index| serde_json::json!({ "value": index.to_string() })).collect::<Vec<_>>()
            }),
        ] {
            let error = UserInputSpec::parse(invalid.clone()).expect_err("params should be rejected");
            assert_eq!(error.code, -32602, "unexpected error for {invalid}: {}", error.message);
        }
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
