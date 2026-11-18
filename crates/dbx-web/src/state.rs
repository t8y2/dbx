use dbx_auth::{AuthRegistry, AuthUserStore, SessionStore};
use dbx_core::connection::AppState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::{broadcast, watch, RwLock};
use tokio_util::sync::CancellationToken;

use crate::auth::LoginRateLimiter;
use crate::sse::TransferProgressChannel;

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
    /// Extra absolute roots allowed for connection-level `docsNotesPath`
    /// beyond `data_dir/docs-notes` (`DBX_DOCS_NOTES_ROOTS`), resolved once at
    /// startup; injectable so notes containment is testable (see `docs`).
    pub notes_roots: Vec<PathBuf>,
    pub public_base_path: String,
    pub password_disabled: bool,
    /// Whether the web UI may reveal saved connection passwords.
    pub password_viewer_enabled: bool,
    /// `DBX_DEMO_MODE`：公网演示部署的封锁开关（见 `demo` 模块）。
    pub demo_mode: bool,
    /// In-memory session store: token → session record (carrying the user identity).
    pub sessions: Arc<SessionStore>,
    /// Auth provider registry (local/LDAP/OIDC/callback/proxy), swappable as a whole by the admin UI.
    pub auth_registry: Arc<AuthRegistry>,
    /// User-store adapter (dbx-core Storage implements dbx-auth's `AuthUserStore`).
    pub auth_users: Arc<dyn AuthUserStore>,
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,
    pub transfer_progress_channels: RwLock<HashMap<String, Arc<TransferProgressChannel>>>,
    pub table_import_channels: RwLock<HashMap<String, watch::Sender<String>>>,
    pub sql_file_executions: RwLock<HashMap<String, CancellationToken>>,
    /// Failure logs of the executions this process ran, scoped to the session
    /// that started them (dbx#11619).
    pub sql_file_failure_logs: dbx_core::sql_file_import::SqlFileFailureLogRegistry,
    pub managed_sql_previews: crate::routes::sql_file::ManagedSqlPreviews,
    pub nacos_imports: RwLock<HashMap<String, NacosImportContext>>,
    /// Login-failure rate limiter (by provider + username).
    pub login_rate_limit: LoginRateLimiter,
    /// Single-use image challenges gating `auth::login`.
    pub captchas: crate::captcha::CaptchaStore,
    /// When `auth::login` demands a challenge. Editable from `设置 → 安全`
    /// unless `DBX_WEB_CAPTCHA` pinned it.
    pub captcha_mode: tokio::sync::RwLock<crate::captcha::CaptchaMode>,
    /// `DBX_WEB_CAPTCHA` was set, so the settings dialog must not offer to
    /// change it.
    pub captcha_env_locked: bool,
    /// Completed Web export temp files waiting for the browser download.
    pub export_files: RwLock<HashMap<String, WebExportFile>>,
    pub ssh_prompts: Arc<crate::ssh_prompt::SshPromptHub>,
    pub migration_ready: Arc<AtomicBool>,
    pub web_mcp: Arc<crate::web_mcp::WebMcpRuntime>,
}

impl WebState {
    pub async fn remove_sse_channel(&self, id: &str) {
        self.sse_channels.write().await.remove(id);
    }

    /// Whether auth is configured (not disabled and at least one user account exists). Equivalent to the legacy
    /// `!password_disabled && password_hash.is_some()`。
    pub async fn auth_configured(&self) -> bool {
        !self.password_disabled && self.auth_users.count_users().await.unwrap_or(0) > 0
    }

    /// Test helper: full field set so new WebState fields don't break scattered test fixtures.
    #[cfg(test)]
    pub fn for_tests(app: Arc<AppState>, data_dir: PathBuf) -> Self {
        let auth_users: Arc<dyn AuthUserStore> = Arc::new(crate::auth::StorageAuthUserStore::new(app.clone()));
        let registry = Arc::new(AuthRegistry::new());
        registry.set_providers(vec![Arc::new(dbx_auth::providers::LocalAuthProvider::new(auth_users.clone()))]);
        Self {
            app,
            data_dir,
            notes_roots: Vec::new(),
            public_base_path: "/".to_string(),
            password_disabled: false,
            password_viewer_enabled: true,
            demo_mode: false,
            sessions: Arc::new(SessionStore::new(None)),
            auth_registry: registry,
            auth_users,
            sse_channels: RwLock::new(HashMap::new()),
            transfer_progress_channels: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            sql_file_failure_logs: Default::default(),
            sql_file_executions: RwLock::new(HashMap::new()),
            managed_sql_previews: Default::default(),
            nacos_imports: RwLock::new(HashMap::new()),
            login_rate_limit: LoginRateLimiter::new(),
            captchas: crate::captcha::CaptchaStore::new(),
            captcha_mode: tokio::sync::RwLock::new(crate::captcha::CaptchaMode::Auto),
            captcha_env_locked: false,
            export_files: RwLock::new(HashMap::new()),
            ssh_prompts: Arc::new(crate::ssh_prompt::SshPromptHub::new()),
            migration_ready: Arc::new(AtomicBool::new(true)),
            web_mcp: Arc::new(crate::web_mcp::WebMcpRuntime::disabled()),
        }
    }
}
