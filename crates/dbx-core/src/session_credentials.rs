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
//! - [`fmt::Debug`] 只暴露凭据数量，不输出 owner、连接 ID 或密码值，避免调试日志与异常文本泄露。
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

#[derive(Clone, Eq, Hash, PartialEq)]
struct CredentialKey {
    owner_scope: String,
    connection_id: String,
}

impl CredentialKey {
    fn new(owner_scope: &str, connection_id: &str) -> Self {
        Self { owner_scope: owner_scope.to_string(), connection_id: connection_id.to_string() }
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct PurposeCredentialKey {
    credential: CredentialKey,
    purpose: String,
}

impl PurposeCredentialKey {
    fn new(owner_scope: &str, connection_id: &str, purpose: &str) -> Self {
        Self { credential: CredentialKey::new(owner_scope, connection_id), purpose: purpose.to_string() }
    }
}

struct SessionCredential {
    password: String,
    generation: u64,
}

#[derive(Default)]
struct SessionCredentialState {
    credentials: HashMap<CredentialKey, SessionCredential>,
    purpose_credentials: HashMap<PurposeCredentialKey, SessionCredential>,
    pool_credential_owners: HashMap<String, String>,
    next_generation: u64,
}

pub struct SessionCredentialWriteToken {
    key: CredentialKey,
    generation: u64,
}

pub struct PurposeSessionCredentialWriteToken {
    key: PurposeCredentialKey,
    generation: u64,
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
    state: RwLock<SessionCredentialState>,
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
    pub fn set(&self, owner_scope: &str, connection_id: &str, password: &str) -> Option<SessionCredentialWriteToken> {
        if password.is_empty() {
            return None;
        }
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.next_generation = state.next_generation.checked_add(1).expect("session credential generation overflow");
        let key = CredentialKey::new(owner_scope, connection_id);
        let generation = state.next_generation;
        state.credentials.insert(key.clone(), SessionCredential { password: password.to_string(), generation });
        Some(SessionCredentialWriteToken { key, generation })
    }

    /// 读取某个 owner 作用域下的本次运行期临时密码；不存在则返回 `None`。
    pub fn get(&self, owner_scope: &str, connection_id: &str) -> Option<String> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state.credentials.get(&CredentialKey::new(owner_scope, connection_id)).map(|entry| entry.password.clone())
    }

    /// Stores an additional transient secret for a connection-specific purpose.
    pub fn set_for_purpose(&self, owner_scope: &str, connection_id: &str, purpose: &str, password: &str) {
        let _ = self.set_for_purpose_with_token(owner_scope, connection_id, purpose, password);
    }

    /// Stores a purpose-specific secret and returns a token that can roll back
    /// this exact write without deleting a newer concurrent value.
    pub fn set_for_purpose_with_token(
        &self,
        owner_scope: &str,
        connection_id: &str,
        purpose: &str,
        password: &str,
    ) -> Option<PurposeSessionCredentialWriteToken> {
        if purpose.is_empty() || password.is_empty() {
            return None;
        }
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.next_generation = state.next_generation.checked_add(1).expect("session credential generation overflow");
        let key = PurposeCredentialKey::new(owner_scope, connection_id, purpose);
        let generation = state.next_generation;
        state.purpose_credentials.insert(key.clone(), SessionCredential { password: password.to_string(), generation });
        Some(PurposeSessionCredentialWriteToken { key, generation })
    }

    pub fn get_for_purpose(&self, owner_scope: &str, connection_id: &str, purpose: &str) -> Option<String> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state
            .purpose_credentials
            .get(&PurposeCredentialKey::new(owner_scope, connection_id, purpose))
            .map(|entry| entry.password.clone())
    }

    /// 某个 owner 作用域下是否存在本次运行期临时密码。
    pub fn has(&self, owner_scope: &str, connection_id: &str) -> bool {
        self.get(owner_scope, connection_id).is_some()
    }

    /// 清除某个 owner 作用域下的临时密码（连接删除 / "断开并忘记本次密码"）。
    pub fn remove(&self, owner_scope: &str, connection_id: &str) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.credentials.remove(&CredentialKey::new(owner_scope, connection_id));
        state.purpose_credentials.retain(|key, _| {
            key.credential.owner_scope != owner_scope || key.credential.connection_id != connection_id
        });
    }

    /// 仅当指定写入仍是当前值时删除，用于连接失败回滚，避免旧 attempt 删除更新密码。
    pub fn remove_if_current(&self, token: &SessionCredentialWriteToken) -> bool {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        let is_current =
            state.credentials.get(&token.key).is_some_and(|credential| credential.generation == token.generation);
        if is_current {
            state.credentials.remove(&token.key);
        }
        is_current
    }

    pub fn remove_purpose_if_current(&self, token: &PurposeSessionCredentialWriteToken) -> bool {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        let is_current = state
            .purpose_credentials
            .get(&token.key)
            .is_some_and(|credential| credential.generation == token.generation);
        if is_current {
            state.purpose_credentials.remove(&token.key);
        }
        is_current
    }

    /// 清除某个 owner 作用域下的全部凭据（Web 登出 / 登录会话失效），不影响其他
    /// 登录会话的凭据。
    pub fn clear_owner(&self, owner_scope: &str) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.credentials.retain(|key, _| key.owner_scope != owner_scope);
        state.purpose_credentials.retain(|key, _| key.credential.owner_scope != owner_scope);
    }

    /// 全局连接配置被编辑、删除或复用 ID 时，原子清除所有 owner 的临时凭据和
    /// 该连接的全部池 owner 标记，防止旧密码或旧池流入新的连接定义。
    pub fn clear_connection(&self, connection_id: &str) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.credentials.retain(|key, _| key.connection_id != connection_id);
        state.purpose_credentials.retain(|key, _| key.credential.connection_id != connection_id);
        let pool_prefix = format!("{connection_id}:");
        state
            .pool_credential_owners
            .retain(|pool_key, _| pool_key != connection_id && !pool_key.starts_with(&pool_prefix));
    }

    /// 清空全部会话凭据（桌面端退出前兜底；Web 全实例重置）。
    pub fn clear(&self) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.credentials.clear();
        state.purpose_credentials.clear();
    }

    pub fn record_pool_owner(&self, pool_key: &str, owner_scope: &str) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.pool_credential_owners.insert(pool_key.to_string(), owner_scope.to_string());
    }

    pub fn pool_owner_mismatch(&self, pool_key: &str, owner_scope: &str) -> bool {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state.pool_credential_owners.get(pool_key).is_none_or(|recorded| recorded != owner_scope)
    }

    pub fn has_pool_owner(&self, pool_key: &str) -> bool {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state.pool_credential_owners.contains_key(pool_key)
    }

    pub fn remove_pool_owners(&self, pool_keys: &[String]) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        for pool_key in pool_keys {
            state.pool_credential_owners.remove(pool_key);
        }
    }

    pub fn clear_pool_owners(&self) {
        let mut state = self.state.write().unwrap_or_else(|error| error.into_inner());
        state.pool_credential_owners.clear();
    }

    fn credential_count(&self) -> usize {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state.credentials.len() + state.purpose_credentials.len()
    }
}

impl fmt::Debug for SessionCredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionCredentialStore").field("credential_count", &self.credential_count()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::SessionCredentialStore;
    use std::sync::{Arc, Barrier};

    #[test]
    fn set_get_has_round_trip() {
        let store = SessionCredentialStore::new();
        assert!(!store.has("", "conn-a"));
        assert_eq!(store.get("", "conn-a"), None);

        let _ = store.set("", "conn-a", "s3cret");
        assert!(store.has("", "conn-a"));
        assert_eq!(store.get("", "conn-a").as_deref(), Some("s3cret"));
    }

    #[test]
    fn set_with_empty_password_is_noop_and_keeps_existing() {
        let store = SessionCredentialStore::new();
        let _ = store.set("", "conn-a", "s3cret");
        let empty_write = store.set("", "conn-a", "");
        assert!(empty_write.is_none());
        assert_eq!(store.get("", "conn-a").as_deref(), Some("s3cret"));
    }

    #[test]
    fn remove_clears_credential() {
        let store = SessionCredentialStore::new();
        let _ = store.set("", "conn-a", "s3cret");
        store.remove("", "conn-a");
        assert!(!store.has("", "conn-a"));
        assert_eq!(store.get("", "conn-a"), None);
    }

    #[test]
    fn clear_removes_all_credentials() {
        let store = SessionCredentialStore::new();
        let _ = store.set("", "conn-a", "secret-a");
        let _ = store.set("", "conn-b", "secret-b");
        store.clear();
        assert!(!store.has("", "conn-a"));
        assert!(!store.has("", "conn-b"));
        assert_eq!(store.get("", "conn-a"), None);
    }

    #[test]
    fn credentials_are_isolated_by_connection_id() {
        let store = SessionCredentialStore::new();
        let _ = store.set("", "conn-a", "secret-a");
        let _ = store.set("", "conn-b", "secret-b");
        assert_eq!(store.get("", "conn-a").as_deref(), Some("secret-a"));
        assert_eq!(store.get("", "conn-b").as_deref(), Some("secret-b"));
        store.remove("", "conn-a");
        assert_eq!(store.get("", "conn-a"), None);
        assert_eq!(store.get("", "conn-b").as_deref(), Some("secret-b"));
    }

    #[test]
    fn credentials_are_isolated_by_owner_scope() {
        let store = SessionCredentialStore::new();
        let _ = store.set("token-x", "conn-a", "x-secret");
        let _ = store.set("token-y", "conn-a", "y-secret");
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
        let _ = store.set("token-x", "conn-a", "x-secret");
        let _ = store.set("token-y", "conn-a", "y-secret");
        let _ = store.set("token-y", "conn-b", "y2-secret");
        store.clear_owner("token-y");
        // Y 登出只清除 Y 的凭据，X 与桌面端不受影响。
        assert!(!store.has("token-y", "conn-a"));
        assert!(!store.has("token-y", "conn-b"));
        assert!(store.has("token-x", "conn-a"));
    }

    #[test]
    fn purpose_credentials_follow_owner_and_connection_cleanup() {
        let store = SessionCredentialStore::new();
        store.set_for_purpose("token-x", "conn-a", "nacos-primary", "new-secret");
        store.set_for_purpose("token-y", "conn-a", "nacos-primary", "other-secret");

        assert_eq!(store.get_for_purpose("token-x", "conn-a", "nacos-primary").as_deref(), Some("new-secret"));
        assert_eq!(store.get_for_purpose("token-y", "conn-a", "nacos-primary").as_deref(), Some("other-secret"));
        store.clear_owner("token-x");
        assert_eq!(store.get_for_purpose("token-x", "conn-a", "nacos-primary"), None);
        store.clear_connection("conn-a");
        assert_eq!(store.get_for_purpose("token-y", "conn-a", "nacos-primary"), None);
    }

    #[test]
    fn stale_purpose_write_token_cannot_remove_newer_credential() {
        let store = SessionCredentialStore::new();
        let first = store.set_for_purpose_with_token("token-x", "conn-a", "nacos-console", "first-secret").unwrap();
        let second = store.set_for_purpose_with_token("token-x", "conn-a", "nacos-console", "second-secret").unwrap();

        assert!(!store.remove_purpose_if_current(&first));
        assert_eq!(store.get_for_purpose("token-x", "conn-a", "nacos-console").as_deref(), Some("second-secret"));
        assert!(store.remove_purpose_if_current(&second));
        assert_eq!(store.get_for_purpose("token-x", "conn-a", "nacos-console"), None);
    }

    #[test]
    fn debug_output_hides_password_values() {
        let store = SessionCredentialStore::new();
        let _ = store.set("session-token-sensitive", "connection-sensitive", "super-secret-value");
        let debug = format!("{store:?}");
        assert!(debug.contains("credential_count: 1"));
        assert!(!debug.contains("session-token-sensitive"));
        assert!(!debug.contains("connection-sensitive"));
        assert!(!debug.contains("super-secret-value"));
    }

    #[test]
    fn clear_connection_removes_all_owners_and_pool_owner_state() {
        let store = SessionCredentialStore::new();
        let _ = store.set("token-x", "conn-a", "x-secret");
        let _ = store.set("token-y", "conn-a", "y-secret");
        let _ = store.set("token-y", "conn-b", "other-secret");
        store.record_pool_owner("conn-a", "token-x");
        store.record_pool_owner("conn-a:analytics", "token-y");
        store.record_pool_owner("conn-b", "token-y");

        store.clear_connection("conn-a");

        assert!(!store.has("token-x", "conn-a"));
        assert!(!store.has("token-y", "conn-a"));
        assert!(store.has("token-y", "conn-b"));
        assert!(!store.has_pool_owner("conn-a"));
        assert!(!store.has_pool_owner("conn-a:analytics"));
        assert!(store.pool_owner_mismatch("conn-a", "token-z"));
        assert!(store.pool_owner_mismatch("conn-a:analytics", "token-z"));
        assert!(store.has_pool_owner("conn-b"));
        assert!(store.pool_owner_mismatch("conn-b", "token-z"));
    }

    #[test]
    fn stale_write_token_cannot_remove_newer_credential() {
        let store = Arc::new(SessionCredentialStore::new());
        let first_write_done = Arc::new(Barrier::new(2));
        let second_write_done = Arc::new(Barrier::new(2));
        let attempt_store = store.clone();
        let attempt_first_write_done = first_write_done.clone();
        let attempt_second_write_done = second_write_done.clone();

        let attempt_a = std::thread::spawn(move || {
            let token = attempt_store.set("token-x", "conn-a", "attempt-a-password").unwrap();
            attempt_first_write_done.wait();
            attempt_second_write_done.wait();
            assert!(!attempt_store.remove_if_current(&token));
        });

        first_write_done.wait();
        let _attempt_b_token = store.set("token-x", "conn-a", "attempt-b-password").unwrap();
        second_write_done.wait();
        attempt_a.join().unwrap();

        assert_eq!(store.get("token-x", "conn-a").as_deref(), Some("attempt-b-password"));
    }
}
