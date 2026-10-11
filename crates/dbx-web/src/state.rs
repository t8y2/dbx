use axum::response::IntoResponse;
use dbx_core::connection::AppState;
use dbx_core::persistence::access_control::EffectivePermissions;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::sse::TransferProgressChannel;

/// 已认证 Web 会话（多用户体系，按会话 token 索引）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserSession {
    pub user_id: i64,
    pub username: String,
    /// Unix 秒。
    pub created_at: u64,
}

/// 单个 `(username, ip)` 组合的登录失败计数与锁定状态。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginRateLimitEntry {
    pub fail_count: u32,
    pub locked_until: Option<Instant>,
}

impl LoginRateLimitEntry {
    /// 零失败、未锁定的初始条目。
    pub fn fresh() -> Self {
        Self { fail_count: 0, locked_until: None }
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
    /// Extra absolute roots allowed for connection-level `docsNotesPath`
    /// beyond `data_dir/docs-notes` (`DBX_DOCS_NOTES_ROOTS`), resolved once at
    /// startup; injectable so notes containment is testable (see `docs`).
    pub notes_roots: Vec<PathBuf>,
    pub public_base_path: String,
    /// 仅 `DBX_DISABLE_PASSWORD=1` 时为 true：所有请求放行（无认证）。
    pub password_disabled: bool,
    /// `DBX_DEMO_MODE`：公网演示部署的封锁开关（见 `demo` 模块）。
    pub demo_mode: bool,
    /// `DBX_TRUST_PROXY=1`：客户端 IP 优先取 `X-Forwarded-For` 首值。
    pub trust_proxy: bool,
    /// 首个认证来源的哈希（env 口令 / 旧共享口令 / setup 后的 admin 口令）。
    ///
    /// 仅供"密码保护是否启用"类判定（MCP、迁移、云同步）；登录校验一律走
    /// `users` 表（见 `auth` 模块）。旧 `app_settings.password_hash` 数据保留。
    pub password_hash: RwLock<Option<String>>,
    pub sessions: RwLock<HashMap<String, UserSession>>,
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,
    pub transfer_progress_channels: RwLock<HashMap<String, Arc<TransferProgressChannel>>>,
    pub table_import_channels: RwLock<HashMap<String, watch::Sender<String>>>,
    pub sql_file_executions: RwLock<HashMap<String, CancellationToken>>,
    pub managed_sql_previews: crate::routes::sql_file::ManagedSqlPreviews,
    pub nacos_imports: RwLock<HashMap<String, NacosImportContext>>,
    /// 登录限流：`username|ip` -> 失败计数与锁定（5 次失败锁 60 秒）。
    pub login_rate_limit: Mutex<HashMap<String, LoginRateLimitEntry>>,
    /// Completed Web export temp files waiting for the browser download.
    pub export_files: RwLock<HashMap<String, WebExportFile>>,
    pub ssh_prompts: Arc<crate::ssh_prompt::SshPromptHub>,
    pub migration_ready: Arc<AtomicBool>,
    pub web_mcp: Arc<crate::web_mcp::WebMcpRuntime>,
    /// 登录黑名单内存缓存（启动加载，T5 变更后 `reload`）。
    pub blacklist: Arc<crate::blacklist::BlacklistCache>,
    /// 有效权限缓存：user_id -> 聚合结果（角色/用户变更时失效，见
    /// [`WebState::invalidate_permission_cache_user`]）。
    pub permission_cache: RwLock<HashMap<i64, EffectivePermissions>>,
    /// `users` 表非空（认证体系已初始化）。为 false 时非 auth API 返回
    /// `403 setup_required`（迁移向导豁免端点除外，见 `auth` 模块）。
    pub user_system_ready: Arc<AtomicBool>,
}

impl WebState {
    pub async fn remove_sse_channel(&self, id: &str) {
        self.sse_channels.write().await.remove(id);
    }

    /// `DBX_DISABLE_PASSWORD=1`（用户体系关闭）时 `/api/admin/*` 的统一拒绝。
    ///
    /// T5 管理路由挂载时在每个 admin handler 前调用；返回 Some(response)
    /// 表示必须直接返回该 403。
    pub fn admin_gating_response(&self) -> Option<axum::response::Response> {
        if !self.password_disabled {
            return None;
        }
        Some(
            (axum::http::StatusCode::FORBIDDEN, axum::Json(serde_json::json!({"error": "user_system_disabled"})))
                .into_response(),
        )
    }

    /// 计算并缓存用户的有效权限。
    pub async fn effective_permissions(
        &self,
        user: &dbx_core::persistence::access_control::UserRecord,
    ) -> Result<EffectivePermissions, String> {
        if let Some(cached) = self.permission_cache.read().await.get(&user.id) {
            return Ok(cached.clone());
        }
        let effective =
            dbx_core::persistence::access_control::compute_effective_permissions(&self.app.storage, user).await?;
        self.permission_cache.write().await.insert(user.id, effective.clone());
        Ok(effective)
    }

    /// 使单个用户的有效权限缓存失效（T5：用户角色变更 / 部门无关）。
    pub async fn invalidate_permission_cache_user(&self, user_id: i64) {
        self.permission_cache.write().await.remove(&user_id);
    }

    /// 使全部有效权限缓存失效（T5：角色定义变更，影响所有持有者）。
    pub async fn invalidate_permission_cache_all(&self) {
        self.permission_cache.write().await.clear();
    }

    /// 更新"用户体系已初始化"标志（启动引导 / T5 用户增删后调用）。
    pub fn set_user_system_ready(&self, ready: bool) {
        self.user_system_ready.store(ready, std::sync::atomic::Ordering::Release);
    }

    pub fn user_system_ready(&self) -> bool {
        self.user_system_ready.load(std::sync::atomic::Ordering::Acquire)
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
            trust_proxy: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashMap::new()),
            sse_channels: RwLock::new(HashMap::new()),
            transfer_progress_channels: RwLock::new(HashMap::new()),
            table_import_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            managed_sql_previews: Default::default(),
            nacos_imports: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(HashMap::new()),
            export_files: RwLock::new(HashMap::new()),
            ssh_prompts: Arc::new(crate::ssh_prompt::SshPromptHub::new()),
            migration_ready: Arc::new(AtomicBool::new(true)),
            web_mcp: Arc::new(crate::web_mcp::WebMcpRuntime::disabled()),
            blacklist: Arc::new(crate::blacklist::BlacklistCache::empty()),
            permission_cache: RwLock::new(HashMap::new()),
            user_system_ready: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_rate_limit_entry_defaults_are_neutral() {
        let entry = LoginRateLimitEntry::fresh();
        assert_eq!(entry.fail_count, 0);
        assert!(entry.locked_until.is_none());
    }
}
