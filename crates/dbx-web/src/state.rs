use dbx_core::connection::AppState;
use std::collections::HashMap;
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

/// How the session was established.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    Password,
    Oidc,
}

/// Per-session identity information (replaces bare `HashSet<String>`).
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct SessionInfo {
    /// Opaque session token (== cookie value).
    pub token: String,
    /// How the session was created.
    pub method: AuthMethod,
    /// OIDC sub claim or empty string for password sessions.
    pub sub: String,
    /// User email extracted from OIDC claims (empty for password sessions).
    pub email: String,
    /// Display name (from `name` claim).
    pub name: String,
    /// Role determined by the admission expression ("Admin" by default).
    pub role: String,
    /// Full OIDC claims as a JSON value (`null` for password sessions).
    pub claims: serde_json::Value,
    /// Creation timestamp (UNIX seconds).
    pub created_at: u64,
}

pub struct WebState {
    pub app: Arc<AppState>,
    pub data_dir: PathBuf,
    /// Extra absolute roots allowed for connection-level `docsNotesPath`
    /// beyond `data_dir/docs-notes` (`DBX_DOCS_NOTES_ROOTS`), resolved once at
    /// startup; injectable so notes containment is testable (see `docs`).
    pub notes_roots: Vec<PathBuf>,
    pub public_base_path: String,
    pub password_disabled: bool,
    /// `DBX_DEMO_MODE`：公网演示部署的封锁开关（见 `demo` 模块）。
    pub demo_mode: bool,
    pub password_hash: RwLock<Option<String>>,
    /// Active sessions, keyed by session token.
    pub sessions: RwLock<HashMap<String, SessionInfo>>,
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,
    pub transfer_progress_channels: RwLock<HashMap<String, Arc<TransferProgressChannel>>>,
    pub table_import_channels: RwLock<HashMap<String, watch::Sender<String>>>,
    pub sql_file_executions: RwLock<HashMap<String, CancellationToken>>,
    pub managed_sql_previews: crate::routes::sql_file::ManagedSqlPreviews,
    pub nacos_imports: RwLock<HashMap<String, NacosImportContext>>,
    pub login_rate_limit: Mutex<LoginRateLimit>,
    /// Completed Web export temp files waiting for the browser download.
    pub export_files: RwLock<HashMap<String, WebExportFile>>,
    pub ssh_prompts: Arc<crate::ssh_prompt::SshPromptHub>,
    pub migration_ready: Arc<AtomicBool>,
    pub web_mcp: Arc<crate::web_mcp::WebMcpRuntime>,
    /// OIDC service (None if OIDC is not configured).
    pub oidc: Option<Arc<crate::oidc::OidcService>>,
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
            notes_roots: Vec::new(),
            public_base_path: "/".to_string(),
            password_disabled: false,
            demo_mode: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashMap::new()),
            sse_channels: RwLock::new(HashMap::new()),
            transfer_progress_channels: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            managed_sql_previews: Default::default(),
            nacos_imports: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
            ssh_prompts: Arc::new(crate::ssh_prompt::SshPromptHub::new()),
            migration_ready: Arc::new(AtomicBool::new(true)),
            web_mcp: Arc::new(crate::web_mcp::WebMcpRuntime::disabled()),
            oidc: None,
        }
    }
}
