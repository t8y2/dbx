use dbx_core::connection::AppState;
use dbx_core::nats::NatsService;
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::sse::TransferProgressChannel;

pub struct LoginRateLimit {
    pub fail_count: u32,
    pub locked_until: Option<std::time::Instant>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebExportFile {
    pub file_path: String,
    pub download_filename: String,
    pub format: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NacosImportContext {
    pub owner_session: Option<String>,
    pub connection_id: String,
    pub target_namespace: String,
    pub plan_hash: String,
}

const NATS_WEB_REPLAY_MAX_EVENTS: usize = 1_000;
const NATS_WEB_REPLAY_MAX_BYTES: usize = 16 * 1024 * 1024;

pub struct NatsWebSubscription {
    pub connection_id: String,
    events: broadcast::Sender<String>,
    history: std::sync::Mutex<(VecDeque<String>, usize)>,
}

impl NatsWebSubscription {
    pub fn new(connection_id: String) -> Self {
        let (events, _) = broadcast::channel(512);
        Self { connection_id, events, history: std::sync::Mutex::new((VecDeque::new(), 0)) }
    }

    pub fn send(&self, event: String) {
        let mut history = self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while !history.0.is_empty()
            && (history.0.len() >= NATS_WEB_REPLAY_MAX_EVENTS
                || history.1.saturating_add(event.len()) > NATS_WEB_REPLAY_MAX_BYTES)
        {
            if let Some(removed) = history.0.pop_front() {
                history.1 = history.1.saturating_sub(removed.len());
            }
        }
        if event.len() <= NATS_WEB_REPLAY_MAX_BYTES {
            history.1 = history.1.saturating_add(event.len());
            history.0.push_back(event.clone());
        }
        let _ = self.events.send(event);
    }

    pub fn subscribe(&self) -> (Vec<String>, broadcast::Receiver<String>) {
        // Holding history while subscribing means a late SSE client sees an
        // event either in replay or in the live channel, never neither.
        let history = self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let receiver = self.events.subscribe();
        (history.0.iter().cloned().collect(), receiver)
    }
}

pub struct NatsWebRuntime {
    pub service: Mutex<Option<NatsService>>,
    pub event_forwarder_started: AtomicBool,
    pub subscriptions: RwLock<HashMap<String, Arc<NatsWebSubscription>>>,
}

impl Default for NatsWebRuntime {
    fn default() -> Self {
        Self {
            service: Mutex::new(None),
            event_forwarder_started: AtomicBool::new(false),
            subscriptions: RwLock::new(HashMap::new()),
        }
    }
}

pub struct WebState {
    pub app: Arc<AppState>,
    pub data_dir: PathBuf,
    pub public_base_path: String,
    pub password_disabled: bool,
    pub password_hash: RwLock<Option<String>>,
    pub sessions: RwLock<HashSet<String>>,
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,
    pub transfer_progress_channels: RwLock<HashMap<String, Arc<TransferProgressChannel>>>,
    pub table_import_channels: RwLock<HashMap<String, watch::Sender<String>>>,
    pub sql_file_executions: RwLock<HashMap<String, CancellationToken>>,
    pub nacos_imports: RwLock<HashMap<String, NacosImportContext>>,
    pub nats: NatsWebRuntime,
    pub login_rate_limit: Mutex<LoginRateLimit>,
    /// Completed Web export temp files waiting for the browser download.
    pub export_files: RwLock<HashMap<String, WebExportFile>>,
    pub ssh_prompts: Arc<crate::ssh_prompt::SshPromptHub>,
}

impl WebState {
    pub async fn remove_sse_channel(&self, id: &str) {
        self.sse_channels.write().await.remove(id);
    }

    /// Test helper: full field set so new WebState fields don't break scattered test fixtures.
    #[cfg(test)]
    pub fn for_tests(app: Arc<AppState>, data_dir: PathBuf) -> Self {
        Self {
            app,
            data_dir,
            public_base_path: "/".to_string(),
            password_disabled: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashSet::new()),
            sse_channels: RwLock::new(HashMap::new()),
            transfer_progress_channels: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            nacos_imports: RwLock::new(HashMap::new()),
            nats: NatsWebRuntime::default(),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
            ssh_prompts: Arc::new(crate::ssh_prompt::SshPromptHub::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::NatsWebSubscription;

    #[test]
    fn nats_subscription_replays_events_before_sse_connects() {
        let subscription = NatsWebSubscription::new("connection-1".to_string());
        subscription.send(r#"{"kind":"state","data":{"state":"active"}}"#.to_string());
        let (replay, mut receiver) = subscription.subscribe();
        assert_eq!(replay, [r#"{"kind":"state","data":{"state":"active"}}"#.to_string()]);

        subscription.send(r#"{"kind":"message","data":{"sequence":2}}"#.to_string());
        assert_eq!(receiver.try_recv().unwrap(), r#"{"kind":"message","data":{"sequence":2}}"#);
    }
}
