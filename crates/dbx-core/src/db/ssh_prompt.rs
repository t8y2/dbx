//! Interactive SSH prompt bridge between the backend (russh handshake /
//! authentication callbacks) and the frontend UI.
//!
//! russh invokes `Handler::check_server_key` *before* any credential is sent,
//! and (in the future) drives keyboard-interactive challenges mid-auth. Both
//! need to pause the backend task, ask the user via a dialog, and resume with
//! the answer. This module provides a process-wide gateway so the backend can
//! suspend on a `oneshot` while the Tauri layer forwards the request to the UI
//! and the UI answers through a command.
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
    /// Collect a secret typed by the user (e.g. a dynamic verification code).
    /// Reserved for the future keyboard-interactive flow.
    SecretInput,
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
    /// HostKeyVerify: SHA256 fingerprint string, e.g. `SHA256:xxxx`.
    #[serde(default)]
    pub fingerprint: Option<String>,
    /// SecretInput: the challenge text to show the user.
    #[serde(default)]
    pub prompt: Option<String>,
}

/// The user's answer, sent from the UI back to the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshPromptAnswer {
    /// Accept and (for HostKeyVerify) optionally persist the key.
    Accept { remember: bool },
    /// Reject.
    Reject,
    /// A typed secret (SecretInput).
    Secret(String),
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
        prompt: None,
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
