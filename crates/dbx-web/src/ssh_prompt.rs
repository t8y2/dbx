use dbx_core::db::ssh_prompt::{SshHostKeyNotice, SshPromptAnswer, SshPromptEnvelope, SshPromptRequest};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};

const EVENT_BUFFER_SIZE: usize = 32;
const PROMPT_CHANNEL_SIZE: usize = 16;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshPromptEvent {
    Sync { pending_ids: Vec<String> },
    Prompt { request: SshPromptRequest },
    Notice { notice: SshHostKeyNotice },
    Dismiss { id: String },
}

struct PendingPrompt {
    responder: tokio::sync::oneshot::Sender<SshPromptAnswer>,
    request: SshPromptRequest,
}

pub struct SshPromptHub {
    pending: Mutex<Vec<PendingPrompt>>,
    events: broadcast::Sender<SshPromptEvent>,
}

impl SshPromptHub {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        Self { pending: Mutex::new(Vec::new()), events }
    }

    pub fn register(&self, envelope: SshPromptEnvelope) {
        let request = envelope.request;
        self.pending.lock().unwrap().push(PendingPrompt { responder: envelope.responder, request: request.clone() });
        let _ = self.events.send(SshPromptEvent::Prompt { request });
    }

    pub fn subscribe(&self) -> (Vec<SshPromptEvent>, broadcast::Receiver<SshPromptEvent>) {
        let receiver = self.events.subscribe();
        let pending = self.pending.lock().unwrap();
        let mut replay = vec![SshPromptEvent::Sync {
            pending_ids: pending.iter().map(|prompt| prompt.request.id.clone()).collect(),
        }];
        replay.extend(pending.iter().map(|prompt| SshPromptEvent::Prompt { request: prompt.request.clone() }));
        (replay, receiver)
    }

    pub fn resolve(&self, id: &str, answer: SshPromptAnswer) -> Result<(), String> {
        let pending = {
            let mut pending = self.pending.lock().unwrap();
            let index = pending
                .iter()
                .position(|prompt| prompt.request.id == id)
                .ok_or_else(|| format!("No pending SSH prompt with id {id}"))?;
            pending.remove(index)
        };
        let result = pending.responder.send(answer);
        let _ = self.events.send(SshPromptEvent::Dismiss { id: id.to_string() });
        result.map_err(|_| format!("SSH prompt {id} was already cancelled"))
    }

    pub fn notify(&self, notice: SshHostKeyNotice) {
        let _ = self.events.send(SshPromptEvent::Notice { notice });
    }

    pub fn sweep_cancelled(&self) {
        let cancelled = {
            let mut pending = self.pending.lock().unwrap();
            let cancelled = pending
                .iter()
                .filter(|prompt| prompt.responder.is_closed())
                .map(|prompt| prompt.request.id.clone())
                .collect::<Vec<_>>();
            pending.retain(|prompt| !prompt.responder.is_closed());
            cancelled
        };

        for id in cancelled {
            let _ = self.events.send(SshPromptEvent::Dismiss { id });
        }
    }
}

pub fn install_web_ssh_prompt_bridge(hub: Arc<SshPromptHub>) {
    let (prompt_tx, mut prompt_rx) = mpsc::channel(PROMPT_CHANNEL_SIZE);
    dbx_core::db::ssh_prompt::install_ssh_prompt_gateway(prompt_tx);
    let prompt_hub = hub.clone();
    tokio::spawn(async move {
        while let Some(envelope) = prompt_rx.recv().await {
            prompt_hub.register(envelope);
        }
    });

    let (notice_tx, mut notice_rx) = mpsc::channel(PROMPT_CHANNEL_SIZE);
    dbx_core::db::ssh_prompt::install_ssh_notice_gateway(notice_tx);
    let notice_hub = hub.clone();
    tokio::spawn(async move {
        while let Some(notice) = notice_rx.recv().await {
            notice_hub.notify(notice);
        }
    });

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            interval.tick().await;
            hub.sweep_cancelled();
        }
    });
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
        }
    }

    #[tokio::test]
    async fn late_subscriber_replays_pending_prompt_and_resolution() {
        let hub = SshPromptHub::new();
        let (responder, receiver) = tokio::sync::oneshot::channel();
        hub.register(SshPromptEnvelope { request: request("prompt-1"), responder });

        let (replay, mut events) = hub.subscribe();
        assert!(
            matches!(replay.as_slice(), [SshPromptEvent::Sync { pending_ids }, SshPromptEvent::Prompt { request }] if pending_ids == &["prompt-1"] && request.id == "prompt-1")
        );

        hub.resolve("prompt-1", SshPromptAnswer::Accept { remember: true }).unwrap();
        assert!(matches!(receiver.await.unwrap(), SshPromptAnswer::Accept { remember: true }));
        assert!(matches!(events.recv().await.unwrap(), SshPromptEvent::Dismiss { id } if id == "prompt-1"));
    }

    #[tokio::test]
    async fn invalid_resolution_keeps_prompt_pending() {
        let hub = SshPromptHub::new();
        let (responder, receiver) = tokio::sync::oneshot::channel();
        hub.register(SshPromptEnvelope { request: request("prompt-2"), responder });

        assert!(hub.resolve("missing", SshPromptAnswer::Reject).is_err());
        let (replay, _) = hub.subscribe();
        assert!(
            matches!(replay.as_slice(), [SshPromptEvent::Sync { pending_ids }, SshPromptEvent::Prompt { request }] if pending_ids == &["prompt-2"] && request.id == "prompt-2")
        );

        hub.resolve("prompt-2", SshPromptAnswer::Reject).unwrap();
        assert!(matches!(receiver.await.unwrap(), SshPromptAnswer::Reject));
    }
}
