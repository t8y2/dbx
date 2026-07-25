//! Bridges dbx-core's backend-driven SSH prompt gateway to the frontend.
//!
//! dbx-core suspends the SSH handshake / auth on a `oneshot` and ships the
//! request through a process-wide mpsc gateway (see `dbx_core::db::ssh_prompt`).
//! This module installs that gateway at app startup, forwards each request to
//! the UI via the `ssh-prompt` event, remembers the `oneshot` responder keyed
//! by request id, and the `resolve_ssh_prompt` command answers it when the
//! user confirms/rejects (or later types a dynamic verification code).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use dbx_core::db::ssh_prompt::{self, SshHostKeyNotice, SshPromptAnswer, SshPromptEnvelope};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Tracks in-flight SSH prompts (host-key verification now; dynamic
/// verification codes later) whose answers are supplied by the frontend.
pub struct SshPromptState {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<SshPromptAnswer>>>,
}

impl SshPromptState {
    pub fn new() -> Self {
        Self { pending: Mutex::new(HashMap::new()) }
    }
}

/// Install the dbx-core SSH prompt gateway and spawn the forwarding task that
/// bridges backend prompts to the frontend. Must be called *after*
/// `SshPromptState` has been registered with `app.manage(...)`. Call once
/// during app setup.
pub fn install_ssh_prompt_bridge(app: &AppHandle) {
    // Fail fast if the state was not registered — the bridge cannot function.
    let _ = app.state::<SshPromptState>();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SshPromptEnvelope>(16);
    ssh_prompt::install_ssh_prompt_gateway(tx);

    let bridge_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(envelope) = rx.recv().await {
            let id = envelope.request.id.clone();
            // Stash the responder so the resolve command can answer it later.
            if let Some(state) = bridge_app.try_state::<SshPromptState>() {
                state.pending.lock().unwrap().insert(id.clone(), envelope.responder);
            } else {
                // State missing -> cannot answer; drop the responder and let the
                // backend fail closed on its timeout.
                continue;
            }
            // Forward the prompt to the UI dialog. If the event cannot be
            // delivered the user can never answer it, so clean up the responder
            // immediately and tell the UI to close the orphaned dialog instead
            // of leaving a dangling entry that blocks future prompts.
            if bridge_app.emit("ssh-prompt", &envelope.request).is_err() {
                if let Some(state) = bridge_app.try_state::<SshPromptState>() {
                    state.pending.lock().unwrap().remove(&id);
                }
                let _ = bridge_app.emit("ssh-prompt-dismiss", &id);
            }
        }
    });

    // Sweeper: when a backend prompt times out or is otherwise cancelled, its
    // oneshot receiver is dropped, leaving a *closed* sender in `pending`. Reap
    // those so they never accumulate or block, and notify the UI to close the
    // orphaned dialog. Best-effort; failures are ignored.
    let sweeper_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let Some(state) = sweeper_app.try_state::<SshPromptState>() else {
                continue;
            };
            let stale: Vec<String> = {
                let mut pending = state.pending.lock().unwrap();
                let mut stale = Vec::new();
                pending.retain(|id, tx| {
                    if tx.is_closed() {
                        stale.push(id.clone());
                        false
                    } else {
                        true
                    }
                });
                stale
            };
            for id in &stale {
                let _ = sweeper_app.emit("ssh-prompt-dismiss", id);
            }
        }
    });
}

/// Install the dbx-core SSH host-key *notice* gateway and spawn the forwarding
/// task that delivers out-of-band host-key events (key changed => possible
/// MITM, or the user rejected the host) to the frontend via the
/// `ssh-host-key-notice` event. The frontend shows these as toasts so the user
/// understands *why* a connection failed. Call once during app setup, after
/// `SshPromptState` is registered.
pub fn install_ssh_notice_bridge(app: &AppHandle) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<SshHostKeyNotice>(16);
    ssh_prompt::install_ssh_notice_gateway(tx);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(notice) = rx.recv().await {
            let _ = app.emit("ssh-host-key-notice", &notice);
        }
    });
}

/// The frontend's answer to a prompt it received via the `ssh-prompt` event.
#[derive(Debug, Deserialize)]
pub struct SshPromptResolution {
    /// Id of the prompt being answered (matches the emitted `ssh-prompt` event).
    pub id: String,
    /// One of: `accept`, `reject`, `secret`.
    pub action: String,
    /// HostKeyVerify: persist the accepted key for future sessions.
    #[serde(default)]
    pub remember: Option<bool>,
    /// SecretInput: the typed verification code.
    #[serde(default)]
    pub secret: Option<String>,
}

/// Answers a pending SSH prompt (host-key confirmation or dynamic code) and
/// resumes the suspended backend task.
#[tauri::command]
pub async fn resolve_ssh_prompt(
    resolution: SshPromptResolution,
    state: State<'_, SshPromptState>,
) -> Result<(), String> {
    // Validate the action first so an unknown action does not consume the
    // responder — a later, well-formed retry must still be able to answer the
    // same prompt.
    let answer = match resolution.action.as_str() {
        "accept" => SshPromptAnswer::Accept { remember: resolution.remember.unwrap_or(false) },
        "reject" => SshPromptAnswer::Reject,
        "secret" => SshPromptAnswer::Secret(resolution.secret.unwrap_or_default()),
        other => return Err(format!("Unknown SSH prompt action: {other}")),
    };

    let Some(responder) = state.pending.lock().unwrap().remove(&resolution.id) else {
        return Err(format!("No pending SSH prompt with id {}", resolution.id));
    };

    if responder.send(answer).is_err() {
        // The backend already gave up (timed out or cancelled), so its receiver
        // was dropped. The sweeper will reap the entry; report so the UI can
        // advance its queue.
        return Err(format!("SSH prompt {} was already cancelled", resolution.id));
    }
    Ok(())
}
