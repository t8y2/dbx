use dbx_core::connection::AppState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::sse::TransferProgressChannel;

#[derive(Clone, Debug)]
pub struct LoginRateLimit {
    pub fail_count: u32,
    pub locked_until: Option<Instant>,
}

/// An in-memory login session. `last_active` drives the optional idle
/// timeout (`DBX_SESSION_IDLE_TIMEOUT_MINUTES`); sessions always die on
/// process restart.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub username: String,
    pub last_active: Instant,
}

impl SessionInfo {
    pub fn new(username: String) -> Self {
        Self { username, last_active: Instant::now() }
    }
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

pub struct WebState {
    pub app: Arc<AppState>,
    pub data_dir: PathBuf,
    pub public_base_path: String,
    pub password_disabled: bool,
    /// Add the `Secure` attribute to session cookies (`DBX_COOKIE_SECURE`).
    pub cookie_secure: bool,
    /// Idle timeout for login sessions (`DBX_SESSION_IDLE_TIMEOUT_MINUTES`);
    /// `None` means sessions never expire while the process runs.
    pub session_idle_timeout: Option<Duration>,
    /// Host-provided accounts from `DBX_USERNAME`/`DBX_PASSWORD` env vars
    /// (username -> Argon2 hash). Checked before DB users, never persisted.
    pub bootstrap_users: HashMap<String, String>,
    /// Cached "users table is non-empty" flag; kept in sync by auth handlers.
    pub has_db_users: RwLock<bool>,
    /// Session token -> session info.
    pub sessions: RwLock<HashMap<String, SessionInfo>>,
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,
    pub transfer_progress_channels: RwLock<HashMap<String, Arc<TransferProgressChannel>>>,
    pub table_import_channels: RwLock<HashMap<String, watch::Sender<String>>>,
    pub sql_file_executions: RwLock<HashMap<String, CancellationToken>>,
    pub nacos_imports: RwLock<HashMap<String, NacosImportContext>>,
    /// Failed-login tracking, keyed by lowercased username so one account's
    /// failures do not lock out the others.
    pub login_rate_limit: Mutex<HashMap<String, LoginRateLimit>>,
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
            cookie_secure: false,
            session_idle_timeout: None,
            bootstrap_users: HashMap::new(),
            has_db_users: RwLock::new(false),
            sessions: RwLock::new(HashMap::new()),
            sse_channels: RwLock::new(HashMap::new()),
            transfer_progress_channels: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            nacos_imports: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(HashMap::new()),
            export_files: RwLock::new(HashMap::new()),
            ssh_prompts: Arc::new(crate::ssh_prompt::SshPromptHub::new()),
        }
    }
}
