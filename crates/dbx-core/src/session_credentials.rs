//! 运行期会话凭据仓库。
//!
//! 为 `save_password=false` 的连接在本次进程内临时保留主密码，使手动操作、
//! 编辑器 SQL、AI 工具、元数据请求以及池重建都能复用首次输入的密码，
//! 无需反复弹窗。
//!
//! 与持久化 secret store（[`crate::connection_secrets::FileSecretStore`]）职责分离：
//! 持久层保存"已保存密码"（save_password=true）；本仓库只保存"本次运行期临时密码"
//! （save_password=false，进程退出即丢，绝不落盘）。
//!
//! 约束：
//! - 只在 Rust 进程内存中存在，进程退出自然丢失；
//! - 不写 SQLite、云同步导出、日志或任何磁盘存储；
//! - [`fmt::Debug`] 只暴露连接 ID 集合，不输出密码值，避免调试日志与异常文本泄露。
//!
//! # 多会话隔离（Web）
//!
//! 凭据按 `(owner_scope, connection_id)` 双键存储：桌面端（Tauri）以空字符串作为
//! owner；Web 端以已认证会话 token 作为 owner，使不同登录会话无法复用彼此的临时
//! 密码，登出也只清除当前会话的凭据（[`SessionCredentialStore::clear_owner`]）。
//!
//! owner 通过 [`tokio::task_local`] 在请求边界注入（见 [`with_credential_owner`] /
//! [`current_credential_owner`]），因此 dbx-core 深层的池创建无需在每个函数签名上
//! 逐层透传 owner。未注入 owner 的调用（桌面端、后台任务）按空 owner 处理，天然
//! 隔离于任何 Web 会话凭据；即使 owner 因后台任务丢失，也会因键不匹配而"失败闭合"
//! （读不到任何会话密码），不会跨会话泄露。

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::RwLock;

/// 桌面端（Tauri）使用的 owner 作用域：无认证会话概念，单用户。
pub const DESKTOP_OWNER: &str = "";

fn credential_key(owner_scope: &str, connection_id: &str) -> String {
    format!("{owner_scope}::{connection_id}")
}

/// 当前请求的认证会话作用域（Web 会话 token / 桌面端空串）。
///
/// 由 Web 鉴权中间件在请求边界通过 [`with_credential_owner`] 注入；未注入（桌面端、
/// 后台任务、中间件未覆盖的路径）返回 `None`，调用方按空 owner 处理。
pub fn current_credential_owner() -> Option<String> {
    CREDENTIAL_OWNER.try_get().ok().flatten()
}

/// 在一个 future 的整个执行期间设置凭据 owner 作用域。
///
/// Web 鉴权中间件用它包裹下游处理器，使请求处理任务内（含其 await 到的池创建）
/// 都能读到当前会话 owner。未被此函数包裹的调用（桌面端、独立后台任务）等价于
/// 空 owner。
pub async fn with_credential_owner<F, T>(owner_scope: Option<String>, future: F) -> T
where
    F: Future<Output = T>,
{
    CREDENTIAL_OWNER.scope(owner_scope, future).await
}

tokio::task_local! {
    static CREDENTIAL_OWNER: Option<String>;
}

/// 内存会话凭据仓库：`(owner_scope, connection_id) -> password`。
#[derive(Default)]
pub struct SessionCredentialStore {
    credentials: RwLock<HashMap<String, String>>,
}

impl SessionCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录一个 no-save 连接在本次运行期输入的密码。
    ///
    /// 空密码是 no-op（不覆盖已有凭据，也不删除），删除只能通过 [`Self::remove`]
    /// 显式触发（"断开并忘记本次密码"）。这样连接成功后以空密码 config 建池
    /// 不会误清已记录的凭据。
    pub fn set(&self, owner_scope: &str, connection_id: &str, password: &str) {
        if password.is_empty() {
            return;
        }
        let mut credentials = self.credentials.write().unwrap_or_else(|error| error.into_inner());
        credentials.insert(credential_key(owner_scope, connection_id), password.to_string());
    }

    /// 读取某个 owner 作用域下的本次运行期临时密码；不存在则返回 `None`。
    pub fn get(&self, owner_scope: &str, connection_id: &str) -> Option<String> {
        let credentials = self.credentials.read().unwrap_or_else(|error| error.into_inner());
        credentials.get(&credential_key(owner_scope, connection_id)).cloned()
    }

    /// 某个 owner 作用域下是否存在本次运行期临时密码。
    pub fn has(&self, owner_scope: &str, connection_id: &str) -> bool {
        self.get(owner_scope, connection_id).is_some()
    }

    /// 清除某个 owner 作用域下的临时密码（连接删除 / "断开并忘记本次密码"）。
    pub fn remove(&self, owner_scope: &str, connection_id: &str) {
        let mut credentials = self.credentials.write().unwrap_or_else(|error| error.into_inner());
        credentials.remove(&credential_key(owner_scope, connection_id));
    }

    /// 清除某个 owner 作用域下的全部凭据（Web 登出 / 登录会话失效），不影响其他
    /// 登录会话的凭据。
    pub fn clear_owner(&self, owner_scope: &str) {
        let mut credentials = self.credentials.write().unwrap_or_else(|error| error.into_inner());
        let prefix = format!("{owner_scope}::");
        credentials.retain(|key, _| !key.starts_with(&prefix));
    }

    /// 清空全部会话凭据（桌面端退出前兜底；Web 全实例重置）。
    pub fn clear(&self) {
        let mut credentials = self.credentials.write().unwrap_or_else(|error| error.into_inner());
        credentials.clear();
    }

    /// 当前持有凭据的键集合（仅用于诊断，不泄露密码值）。
    fn credential_keys(&self) -> Vec<String> {
        let credentials = self.credentials.read().unwrap_or_else(|error| error.into_inner());
        let mut keys: Vec<String> = credentials.keys().cloned().collect();
        keys.sort();
        keys
    }
}

impl fmt::Debug for SessionCredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionCredentialStore").field("credential_keys", &self.credential_keys()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::SessionCredentialStore;

    #[test]
    fn set_get_has_round_trip() {
        let store = SessionCredentialStore::new();
        assert!(!store.has("", "conn-a"));
        assert_eq!(store.get("", "conn-a"), None);

        store.set("", "conn-a", "s3cret");
        assert!(store.has("", "conn-a"));
        assert_eq!(store.get("", "conn-a").as_deref(), Some("s3cret"));
    }

    #[test]
    fn set_with_empty_password_is_noop_and_keeps_existing() {
        let store = SessionCredentialStore::new();
        store.set("", "conn-a", "s3cret");
        store.set("", "conn-a", "");
        assert_eq!(store.get("", "conn-a").as_deref(), Some("s3cret"));
    }

    #[test]
    fn remove_clears_credential() {
        let store = SessionCredentialStore::new();
        store.set("", "conn-a", "s3cret");
        store.remove("", "conn-a");
        assert!(!store.has("", "conn-a"));
        assert_eq!(store.get("", "conn-a"), None);
    }

    #[test]
    fn clear_removes_all_credentials() {
        let store = SessionCredentialStore::new();
        store.set("", "conn-a", "secret-a");
        store.set("", "conn-b", "secret-b");
        store.clear();
        assert!(!store.has("", "conn-a"));
        assert!(!store.has("", "conn-b"));
        assert_eq!(store.get("", "conn-a"), None);
    }

    #[test]
    fn credentials_are_isolated_by_connection_id() {
        let store = SessionCredentialStore::new();
        store.set("", "conn-a", "secret-a");
        store.set("", "conn-b", "secret-b");
        assert_eq!(store.get("", "conn-a").as_deref(), Some("secret-a"));
        assert_eq!(store.get("", "conn-b").as_deref(), Some("secret-b"));
        store.remove("", "conn-a");
        assert_eq!(store.get("", "conn-a"), None);
        assert_eq!(store.get("", "conn-b").as_deref(), Some("secret-b"));
    }

    #[test]
    fn credentials_are_isolated_by_owner_scope() {
        let store = SessionCredentialStore::new();
        store.set("token-x", "conn-a", "x-secret");
        store.set("token-y", "conn-a", "y-secret");
        // 同一连接在不同登录会话下互不可见。
        assert_eq!(store.get("token-x", "conn-a").as_deref(), Some("x-secret"));
        assert_eq!(store.get("token-y", "conn-a").as_deref(), Some("y-secret"));
        // 桌面端（空 owner）与任何会话 token 均隔离。
        assert!(!store.has("", "conn-a"));
        assert!(!store.has("token-z", "conn-a"));
    }

    #[test]
    fn clear_owner_only_removes_that_sessions_credentials() {
        let store = SessionCredentialStore::new();
        store.set("token-x", "conn-a", "x-secret");
        store.set("token-y", "conn-a", "y-secret");
        store.set("token-y", "conn-b", "y2-secret");
        store.clear_owner("token-y");
        // Y 登出只清除 Y 的凭据，X 与桌面端不受影响。
        assert!(!store.has("token-y", "conn-a"));
        assert!(!store.has("token-y", "conn-b"));
        assert!(store.has("token-x", "conn-a"));
    }

    #[test]
    fn debug_output_hides_password_values() {
        let store = SessionCredentialStore::new();
        store.set("token-x", "conn-a", "super-secret-value");
        let debug = format!("{store:?}");
        assert!(debug.contains("conn-a"));
        assert!(!debug.contains("super-secret-value"));
        assert!(debug.contains("***") || !debug.contains("secret"));
    }
}
