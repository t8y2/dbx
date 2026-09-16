use dbx_core::connection::AppState;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
            ssh_prompts: Arc::new(crate::ssh_prompt::SshPromptHub::new()),
        }
    }
}
