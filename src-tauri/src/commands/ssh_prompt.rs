//! Bridges dbx-core's backend-driven SSH prompt gateway to the frontend.
//!
//! dbx-core suspends the SSH handshake / auth on a `oneshot` and ships the
//! request through a process-wide mpsc gateway (see `dbx_core::db::ssh_prompt`).
//! This module installs that gateway at app startup, forwards each request to
//! the UI via the `ssh-prompt` event, remembers the `oneshot` responder keyed
//! by request id, and the `resolve_ssh_prompt` command answers it when the
//! user confirms/rejects (or later types a dynamic verification code).

use std::collections::HashMap;
use std::mem;
use std::sync::Mutex;
use std::time::Duration;

use dbx_core::db::ssh_prompt::{self, SshHostKeyNotice, SshPromptAnswer, SshPromptEnvelope, SshPromptRequest};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Tracks in-flight SSH prompts (host-key verification now; dynamic
/// verification codes later) whose answers are supplied by the frontend.
pub struct SshPromptState {
    pending: Mutex<HashMap<String, PendingSshPrompt>>,
    frontend: Mutex<FrontendPromptState>,
}

struct PendingSshPrompt {
    request: SshPromptRequest,
    responder: tokio::sync::oneshot::Sender<SshPromptAnswer>,
}

struct FrontendPromptState {
    ready: bool,
    queued: Vec<String>,
}

impl SshPromptState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            frontend: Mutex::new(FrontendPromptState { ready: false, queued: Vec::new() }),
        }
    }

    fn register_prompt(
        &self,
        request: SshPromptRequest,
        responder: tokio::sync::oneshot::Sender<SshPromptAnswer>,
    ) -> bool {
        let id = request.id.clone();
        self.pending.lock().unwrap().insert(id.clone(), PendingSshPrompt { request, responder });

        let mut frontend = self.frontend.lock().unwrap();
        if frontend.ready {
            true
        } else {
            if !frontend.queued.iter().any(|queued_id| queued_id == &id) {
                frontend.queued.push(id);
            }
            false
        }
    }

    fn mark_frontend_ready(&self) -> Vec<SshPromptRequest> {
        let queued = {
            let mut frontend = self.frontend.lock().unwrap();
            frontend.ready = true;
            mem::take(&mut frontend.queued)
        };

        let pending = self.pending.lock().unwrap();
        queued.into_iter().filter_map(|id| pending.get(&id).map(|prompt| prompt.request.clone())).collect()
    }

    fn mark_frontend_not_ready(&self) {
        let pending_ids: Vec<String> = self.pending.lock().unwrap().keys().cloned().collect();
        let mut frontend = self.frontend.lock().unwrap();
        frontend.ready = false;
        for id in pending_ids {
            if !frontend.queued.iter().any(|queued_id| queued_id == &id) {
                frontend.queued.push(id);
            }
        }
    }

    fn remove_pending(&self, id: &str) -> Option<PendingSshPrompt> {
        let pending = self.pending.lock().unwrap().remove(id);
        self.remove_queued(id);
        pending
    }

    fn remove_queued(&self, id: &str) {
        self.frontend.lock().unwrap().queued.retain(|queued_id| queued_id != id);
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
            let Some(state) = bridge_app.try_state::<SshPromptState>() else {
                // State missing -> cannot answer; drop the responder and let the
                // backend fail closed on its timeout.
                continue;
            };

            // Tauri events do not replay for listeners registered later. Keep
            // the request pending until the dialog has installed all listeners.
            let emit_now = state.register_prompt(envelope.request, envelope.responder);
            if emit_now {
                emit_prompt(&bridge_app, state.inner(), &id);
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
                pending.retain(|id, prompt| {
                    if prompt.responder.is_closed() {
                        stale.push(id.clone());
                        false
                    } else {
                        true
                    }
                });
                stale
            };
            for id in &stale {
                state.remove_queued(id);
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

fn emit_prompt(app: &AppHandle, state: &SshPromptState, id: &str) {
    let Some(request) = state.pending.lock().unwrap().get(id).map(|prompt| prompt.request.clone()) else {
        return;
    };

    // If the event cannot be delivered, the user can never answer it. Remove
    // the responder and close any dialog that may still contain the request.
    if app.emit("ssh-prompt", &request).is_err() {
        state.remove_pending(id);
        let _ = app.emit("ssh-prompt-dismiss", id);
    }
}

/// Marks the SSH prompt dialog ready after it has installed all listeners and
/// replays prompts that arrived during frontend startup or remounting.
#[tauri::command]
pub fn ssh_prompt_ready(app: AppHandle, state: State<'_, SshPromptState>) -> Result<(), String> {
    for request in state.mark_frontend_ready() {
        emit_prompt(&app, state.inner(), &request.id);
    }
    Ok(())
}

/// Marks the SSH prompt dialog unavailable so future prompts are queued until
/// the dialog is mounted again. Existing prompts are replayed on the next ready
/// handshake instead of being lost during a frontend lifecycle transition.
#[tauri::command]
pub fn ssh_prompt_not_ready(state: State<'_, SshPromptState>) -> Result<(), String> {
    state.mark_frontend_not_ready();
    Ok(())
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

    let Some(pending) = state.remove_pending(&resolution.id) else {
        return Err(format!("No pending SSH prompt with id {}", resolution.id));
    };

    if pending.responder.send(answer).is_err() {
        // The backend already gave up (timed out or cancelled), so its receiver
        // was dropped. Report this so the UI can advance its queue.
        return Err(format!("SSH prompt {} was already cancelled", resolution.id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::db::ssh_prompt::SshPromptKind;

    fn request(id: &str) -> SshPromptRequest {
        SshPromptRequest {
            id: id.to_string(),
            kind: SshPromptKind::HostKeyVerify,
            host: "example.test".to_string(),
            port: 22,
            key_type: Some("ssh-ed25519".to_string()),
            fingerprint: Some("SHA256:test".to_string()),
            prompt: None,
            echo: false,
        }
    }

    #[test]
    fn queues_prompts_until_frontend_is_ready() {
        let state = SshPromptState::new();
        let (responder, _receiver) = tokio::sync::oneshot::channel();

        assert!(!state.register_prompt(request("first"), responder));
        assert!(state.frontend.lock().unwrap().queued == vec!["first"]);
    }

    #[test]
    fn ready_replays_only_pending_prompts_once() {
        let state = SshPromptState::new();
        let (first_responder, _first_receiver) = tokio::sync::oneshot::channel();
        let (second_responder, _second_receiver) = tokio::sync::oneshot::channel();

        state.register_prompt(request("first"), first_responder);
        state.register_prompt(request("second"), second_responder);
        state.remove_pending("first");

        let replayed = state.mark_frontend_ready();
        assert_eq!(replayed.iter().map(|prompt| prompt.id.as_str()).collect::<Vec<_>>(), vec!["second"]);
        assert!(state.mark_frontend_ready().is_empty());
    }

    #[test]
    fn prompts_arriving_after_ready_are_not_queued() {
        let state = SshPromptState::new();
        assert!(state.mark_frontend_ready().is_empty());
        let (responder, _receiver) = tokio::sync::oneshot::channel();

        assert!(state.register_prompt(request("after-ready"), responder));
        assert!(state.frontend.lock().unwrap().queued.is_empty());
    }

    #[test]
    fn not_ready_requeues_existing_prompts_for_remount() {
        let state = SshPromptState::new();
        let (responder, _receiver) = tokio::sync::oneshot::channel();

        state.mark_frontend_ready();
        assert!(state.register_prompt(request("remount"), responder));
        state.mark_frontend_not_ready();
        state.mark_frontend_not_ready();

        assert_eq!(state.frontend.lock().unwrap().queued, vec!["remount"]);
        assert_eq!(state.mark_frontend_ready().len(), 1);
    }
}
