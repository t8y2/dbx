//! Interactive SSH prompt bridge between the backend (russh handshake /
//! authentication callbacks) and the frontend UI.
//!
//! russh invokes `Handler::check_server_key` *before* any credential is sent,
//! and drives keyboard-interactive challenges mid-auth. Both
//! need to pause the backend task, ask the user via a dialog, and resume with
//! the answer. This module provides a process-wide gateway so the backend can
//! suspend on a `oneshot` while the Tauri layer forwards the request to the UI
//! and the UI answers through a command.
//!
//! The same gateway carries generic [`SshPromptKind::UserInput`] questions that
//! are not part of a host-owned SSH transport, e.g. a plugin backend asking for
//! a bastion MFA code through the `host/requestUserInput` Host API method. The
//! channel is intentionally transport-agnostic: the host only relays a question
//! and the typed answer, and it never answers on the user's behalf.
//!
//! The gateway is installed once at app startup by the Tauri layer
//! (`install_ssh_prompt_gateway`). In headless / test contexts where no
//! gateway is installed, `request_ssh_prompt` returns `None` and callers MUST
//! fail closed — never trust an unverified host, never send a credential.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// What kind of input the UI should present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshPromptKind {
    /// Confirm/deny a server host key (explicit TOFU).
    HostKeyVerify,
    /// Confirm replacing a previously saved host key that no longer matches.
    HostKeyChanged,
    /// Collect a secret typed by the user (e.g. a dynamic verification code).
    SecretInput,
    /// Confirm uploading the SQLite worker binary onto the file host.
    WorkerUploadConsent,
    /// A caller that is not a host-owned transport (today: a plugin backend
    /// through the `host/requestUserInput` Host API method) needs a value typed
    /// by the user. Unlike [`SshPromptKind::SecretInput`] the host never
    /// synthesizes or auto-answers it: without a user there is no answer.
    UserInput,
}

/// A fixed answer a [`SshPromptKind::UserInput`] request offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshPromptOption {
    /// Value returned to the caller when the user picks this option.
    pub value: String,
    /// Text the dialog shows.
    pub label: String,
}

/// A request for user input, sent from the backend to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshPromptRequest {
    /// Unique id; the UI echoes it back when answering.
    pub id: String,
    pub kind: SshPromptKind,
    pub host: String,
    pub port: u16,
    /// HostKeyVerify: key algorithm, e.g. `ssh-ed25519`.
    #[serde(default)]
    pub key_type: Option<String>,
    /// HostKeyVerify / HostKeyChanged: SHA256 fingerprint string, e.g. `SHA256:xxxx`.
    #[serde(default)]
    pub fingerprint: Option<String>,
    /// HostKeyChanged: previously saved SHA256 fingerprint for comparison.
    #[serde(default)]
    pub previous_fingerprint: Option<String>,
    /// SecretInput: the challenge text to show the user.
    #[serde(default)]
    pub prompt: Option<String>,
    /// SecretInput: whether the server allows the response to be echoed.
    /// Passwords and verification codes normally set this to false.
    #[serde(default)]
    pub echo: bool,
    /// UserInput: who is asking (e.g. the plugin display name), shown so the
    /// user can tell a bastion login prompt from a host-owned one.
    #[serde(default)]
    pub source: Option<String>,
    /// UserInput: heading above `prompt`, already localized by the caller.
    #[serde(default)]
    pub title: Option<String>,
    /// UserInput: preset answer offered in the input.
    #[serde(default)]
    pub default_value: Option<String>,
    /// UserInput: fixed answers; empty means free-form input.
    #[serde(default)]
    pub options: Vec<SshPromptOption>,
}

/// The user's answer, sent from the UI back to the backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshPromptAnswer {
    /// Accept and (for HostKeyVerify) optionally persist the key.
    Accept { remember: bool },
    /// Reject.
    Reject,
    /// A typed value (SecretInput / UserInput).
    Secret(String),
}

impl Default for SshPromptRequest {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: SshPromptKind::HostKeyVerify,
            host: String::new(),
            port: 0,
            key_type: None,
            fingerprint: None,
            previous_fingerprint: None,
            prompt: None,
            echo: false,
            source: None,
            title: None,
            default_value: None,
            options: Vec::new(),
        }
    }
}

/// Internal envelope: the request plus the channel to deliver the answer on.
pub struct SshPromptEnvelope {
    pub request: SshPromptRequest,
    pub responder: oneshot::Sender<SshPromptAnswer>,
}

static PROMPT_GATEWAY: Mutex<Option<mpsc::Sender<SshPromptEnvelope>>> = Mutex::new(None);

/// Install the prompt gateway. Called once at app startup by the Tauri layer.
/// Tests may call it to inject their own gateway (overwriting any previous one).
pub fn install_ssh_prompt_gateway(tx: mpsc::Sender<SshPromptEnvelope>) {
    *PROMPT_GATEWAY.lock().unwrap() = Some(tx);
}

/// Clear the gateway (mainly for tests).
pub fn clear_ssh_prompt_gateway() {
    *PROMPT_GATEWAY.lock().unwrap() = None;
}

/// Serializes every test that mutates the process-global prompt gateway.
///
/// One gateway serves the host's SSH transports, the SQLite worker consent
/// prompt and plugin Host API questions, so tests in any module must hold this
/// lock while a gateway is installed — otherwise one test's gateway (or the
/// fail-closed checks that rely on *no* gateway) clobbers another's.
#[cfg(any(test, feature = "test-support"))]
pub fn prompt_gateway_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    &LOCK
}

/// Request input from the UI. Returns the receiver the caller should await, or
/// `None` if no gateway is installed (caller must fail closed).
pub fn request_ssh_prompt(request: SshPromptRequest) -> Option<oneshot::Receiver<SshPromptAnswer>> {
    let tx = PROMPT_GATEWAY.lock().unwrap().clone()?;
    let (responder_tx, responder_rx) = oneshot::channel();
    match tx.try_send(SshPromptEnvelope { request, responder: responder_tx }) {
        // Channel full or disconnected: treat as unavailable -> fail closed.
        Ok(()) => Some(responder_rx),
        Err(_) => None,
    }
}

/// Build a [`SshPromptRequest`] for host-key verification with a fresh id.
pub fn host_key_verify_request(
    host: &str,
    port: u16,
    key_type: Option<String>,
    fingerprint: Option<String>,
) -> SshPromptRequest {
    SshPromptRequest {
        id: Uuid::new_v4().to_string(),
        kind: SshPromptKind::HostKeyVerify,
        host: host.to_string(),
        port,
        key_type,
        fingerprint,
        previous_fingerprint: None,
        prompt: None,
        echo: false,
        source: None,
        title: None,
        default_value: None,
        options: Vec::new(),
    }
}

/// Build a [`SshPromptRequest`] for a changed-host-key confirmation.
pub fn host_key_changed_request(
    host: &str,
    port: u16,
    key_type: Option<String>,
    fingerprint: Option<String>,
    previous_fingerprint: Option<String>,
) -> SshPromptRequest {
    SshPromptRequest {
        id: Uuid::new_v4().to_string(),
        kind: SshPromptKind::HostKeyChanged,
        host: host.to_string(),
        port,
        key_type,
        fingerprint,
        previous_fingerprint,
        prompt: None,
        echo: false,
        source: None,
        title: None,
        default_value: None,
        options: Vec::new(),
    }
}

/// Build a [`SshPromptRequest`] for a keyboard-interactive challenge.
pub fn secret_input_request(host: &str, port: u16, prompt: String, echo: bool) -> SshPromptRequest {
    SshPromptRequest {
        id: Uuid::new_v4().to_string(),
        kind: SshPromptKind::SecretInput,
        host: host.to_string(),
        port,
        key_type: None,
        fingerprint: None,
        previous_fingerprint: None,
        prompt: Some(prompt),
        echo,
        source: None,
        title: None,
        default_value: None,
        options: Vec::new(),
    }
}

/// A generic question from a caller the host does not own (today: a plugin
/// backend). Built through [`UserInputRequest::into_request`], which allocates
/// the prompt id the UI answers with.
#[derive(Debug, Clone)]
pub struct UserInputRequest {
    pub prompt: String,
    pub echo: bool,
    pub title: Option<String>,
    pub source: Option<String>,
    pub default_value: Option<String>,
    pub options: Vec<SshPromptOption>,
}

impl UserInputRequest {
    pub fn new(prompt: impl Into<String>) -> Self {
        Self { prompt: prompt.into(), echo: false, title: None, source: None, default_value: None, options: Vec::new() }
    }

    pub fn with_title(mut self, title: Option<String>) -> Self {
        self.title = title;
        self
    }

    pub fn with_source(mut self, source: Option<String>) -> Self {
        self.source = source;
        self
    }

    pub fn with_default(mut self, default_value: Option<String>) -> Self {
        self.default_value = default_value;
        self
    }

    pub fn with_options(mut self, options: Vec<SshPromptOption>) -> Self {
        self.options = options;
        self
    }

    pub fn with_echo(mut self, echo: bool) -> Self {
        self.echo = echo;
        self
    }

    /// Turn the question into a prompt request. `host`/`port` are display-only
    /// context a caller outside the host's own transports usually leaves empty.
    pub fn into_request(self, host: &str, port: u16) -> SshPromptRequest {
        SshPromptRequest {
            id: Uuid::new_v4().to_string(),
            kind: SshPromptKind::UserInput,
            host: host.to_string(),
            port,
            key_type: None,
            fingerprint: None,
            previous_fingerprint: None,
            prompt: Some(self.prompt),
            echo: self.echo,
            source: self.source,
            title: self.title,
            default_value: self.default_value,
            options: self.options,
        }
    }
}

/// Out-of-band notice about host-key verification outcomes that the user should
/// see even when the connection ultimately fails (e.g. the key changed => a
/// possible MITM, or the user explicitly rejected the host). Unlike
/// [`SshPromptRequest`] these do not block the handshake — they are fired
/// best-effort so the UI can surface a clear, human-readable reason for the
/// failure. They never affect the connection outcome, which is decided by the
/// caller's return value (fail-closed always wins).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshHostKeyNoticeKind {
    /// The server's key changed vs a known entry — possible man-in-the-middle.
    Changed,
    /// The user rejected the host key in the explicit-TOFU dialog.
    Rejected,
    /// The user accepted the host key (with "remember this host") but the
    /// host-key store could not be written — the host is therefore trusted
    /// for this session only and will be re-prompted on the next connect.
    LearnFailed,
}

/// A best-effort notice delivered to the UI (see [`SshHostKeyNoticeKind`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostKeyNotice {
    pub kind: SshHostKeyNoticeKind,
    pub host: String,
    pub port: u16,
    /// Human-readable detail (e.g. the recorded location/line for a changed
    /// key). The UI may show this verbatim or use `kind` to pick a translation.
    pub message: String,
}

static NOTICE_GATEWAY: Mutex<Option<mpsc::Sender<SshHostKeyNotice>>> = Mutex::new(None);

/// Install the host-key notice gateway. Called once at app startup by the Tauri
/// layer. Tests generally do not install it; see [`notify_host_key`].
pub fn install_ssh_notice_gateway(tx: mpsc::Sender<SshHostKeyNotice>) {
    *NOTICE_GATEWAY.lock().unwrap() = Some(tx);
}

/// Clear the notice gateway (mainly for tests).
pub fn clear_ssh_notice_gateway() {
    *NOTICE_GATEWAY.lock().unwrap() = None;
}

/// Best-effort: deliver a host-key notice to the UI. Returns `false` (and
/// silently no-ops) when no UI gateway is installed, when the channel is full,
/// or when the receiver is gone. This is purely informational and must never
/// change the connection decision taken by the caller.
pub fn notify_host_key(kind: SshHostKeyNoticeKind, host: &str, port: u16, message: &str) -> bool {
    let tx = match NOTICE_GATEWAY.lock().unwrap().clone() {
        Some(tx) => tx,
        None => return false,
    };
    match tx.try_send(SshHostKeyNotice { kind, host: host.to_string(), port, message: message.to_string() }) {
        Ok(()) => true,
        // Channel full or disconnected: treat as unavailable -> silently drop.
        Err(_) => false,
    }
}
