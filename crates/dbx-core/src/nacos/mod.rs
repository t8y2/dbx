//! Nacos admin console support.
//!
//! The public API is intentionally owned by dbx (`NacosAdmin`) instead of
//! exposing SDK/OpenAPI types. The current adapter uses Nacos OpenAPI because
//! the current nacos-sdk-rust releases require Rust edition 2024, while dbx
//! still supports an older Rust toolchain. A future SDK adapter can implement
//! the same port without changing commands, routes, or frontend contracts.

pub mod config;
pub mod http;
pub mod port;
pub mod service;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};

use crate::models::connection::ConnectionConfig;
use crate::nacos::config::NacosAdminConfig;
use crate::nacos::http::{
    new_rnacos_console_session, NacosOpenApiAdmin, RNacosConsoleSessionHandle, RNACOS_CONSOLE_SESSION_CACHE_SECS,
};
use crate::nacos::port::NacosAdmin;

pub use crate::nacos::config::{NacosAdminConfig as NacosConfig, NacosAuthConfig};
pub use crate::nacos::types::*;

type NacosAdminEntry = (NacosAdminConfig, Arc<dyn NacosAdmin>);
/// Values that bind a console token to one r-nacos login context. Deliberately
/// exclude unrelated Nacos settings such as namespace and page size, so those
/// edits do not force users through another CAPTCHA challenge.
///
/// This is also the cache key rather than the DBX connection ID: one r-nacos
/// console session authorizes every configuration in the same instance, even
/// when the UI reaches it through a different connection context.
#[derive(Clone, PartialEq, Eq, Hash)]
struct RNacosConsoleSessionScope {
    address: String,
    username: String,
    password_fingerprint: [u8; 32],
    tls_skip_verify: bool,
}

struct RNacosConsoleSessionEntry {
    session: RNacosConsoleSessionHandle,
    expires_at: Instant,
}

#[derive(Default)]
pub struct NacosAdminRegistry {
    instances: RwLock<HashMap<String, NacosAdminEntry>>,
    build_locks: RwLock<HashMap<String, Arc<Mutex<()>>>>,
    rnacos_console_sessions: RwLock<HashMap<RNacosConsoleSessionScope, RNacosConsoleSessionEntry>>,
}

impl NacosAdminRegistry {
    pub fn new() -> Self {
        Self {
            instances: RwLock::new(HashMap::new()),
            build_locks: RwLock::new(HashMap::new()),
            rnacos_console_sessions: RwLock::new(HashMap::new()),
        }
    }

    pub async fn get_or_build(&self, cfg: &ConnectionConfig) -> Result<Arc<dyn NacosAdmin>, String> {
        let admin_config = NacosAdminConfig::from_connection(cfg)?;
        self.get_or_build_config(&cfg.id, admin_config).await
    }

    pub async fn get_or_build_config(
        &self,
        connection_id: &str,
        cfg: NacosAdminConfig,
    ) -> Result<Arc<dyn NacosAdmin>, String> {
        if let Some((existing_cfg, admin)) = self.instances.read().await.get(connection_id) {
            if existing_cfg == &cfg {
                return Ok(admin.clone());
            }
        }

        let lock = {
            let mut locks = self.build_locks.write().await;
            locks.entry(connection_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
        };
        let _guard = lock.lock().await;

        if let Some((existing_cfg, admin)) = self.instances.read().await.get(connection_id) {
            if existing_cfg == &cfg {
                return Ok(admin.clone());
            }
        }

        let rnacos_console_session = self.rnacos_console_session(&cfg).await;
        let admin = build_admin(cfg.clone(), rnacos_console_session)?;
        self.instances.write().await.insert(connection_id.to_string(), (cfg, admin.clone()));
        Ok(admin)
    }

    pub async fn build_transient(&self, cfg: &ConnectionConfig) -> Result<Arc<dyn NacosAdmin>, String> {
        let admin_config = NacosAdminConfig::from_connection(cfg)?;
        self.build_transient_config(admin_config).await
    }

    pub async fn build_transient_config(&self, cfg: NacosAdminConfig) -> Result<Arc<dyn NacosAdmin>, String> {
        build_admin(cfg, new_rnacos_console_session())
    }

    pub async fn drop_connection(&self, connection_id: &str) {
        self.instances.write().await.remove(connection_id);
        self.build_locks.write().await.remove(connection_id);
    }

    async fn rnacos_console_session(&self, cfg: &NacosAdminConfig) -> RNacosConsoleSessionHandle {
        let Some(scope) = rnacos_console_session_scope(cfg) else {
            return new_rnacos_console_session();
        };
        let mut sessions = self.rnacos_console_sessions.write().await;
        let now = Instant::now();
        sessions.retain(|_, entry| entry.expires_at > now);
        if let Some(entry) = sessions.get(&scope) {
            return entry.session.clone();
        }
        let session = new_rnacos_console_session();
        // Bound cache retention even when a user removes every matching DBX
        // connection. Tokens expire independently inside the session; this
        // entry is retained for one additional token lifetime to allow reuse.
        sessions.insert(
            scope,
            RNacosConsoleSessionEntry {
                session: session.clone(),
                expires_at: now + Duration::from_secs(RNACOS_CONSOLE_SESSION_CACHE_SECS * 2),
            },
        );
        session
    }
}

fn rnacos_console_session_scope(cfg: &NacosAdminConfig) -> Option<RNacosConsoleSessionScope> {
    if cfg.rnacos_console_addr.is_empty() {
        return None;
    }
    let (username, password) = cfg.effective_rnacos_console_credentials().ok()?;
    Some(RNacosConsoleSessionScope {
        address: cfg.rnacos_console_addr.clone(),
        username: username.to_string(),
        password_fingerprint: Sha256::digest(password.as_bytes()).into(),
        tls_skip_verify: cfg.tls_skip_verify,
    })
}

fn build_admin(
    cfg: NacosAdminConfig,
    rnacos_console_session: RNacosConsoleSessionHandle,
) -> Result<Arc<dyn NacosAdmin>, String> {
    Ok(Arc::new(NacosOpenApiAdmin::new_with_rnacos_console_session(cfg, rnacos_console_session)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nacos::config::{NacosImplementation, NacosRNacosConsoleAuth};

    fn rnacos_config(username: &str, password: &str) -> NacosAdminConfig {
        NacosAdminConfig {
            implementation: Some(NacosImplementation::RNacos),
            version_mode: None,
            server_addr: "http://127.0.0.1:8848".to_string(),
            display_server_addr: "http://127.0.0.1:8848".to_string(),
            namespace: "public".to_string(),
            context_path: "/nacos".to_string(),
            rnacos_console_addr: "http://127.0.0.1:10848".to_string(),
            rnacos_history_enabled: Some(true),
            rnacos_console_auth: NacosRNacosConsoleAuth::UsernamePassword {
                username: username.to_string(),
                password: password.to_string(),
            },
            auth: NacosAuthConfig::None,
            tls_skip_verify: false,
            page_size: 20,
            connect_override: None,
        }
    }

    #[tokio::test]
    async fn shares_console_session_across_non_auth_connection_changes() {
        let registry = NacosAdminRegistry::new();
        let config = rnacos_config("admin", "admin");
        let first = registry.rnacos_console_session(&config).await;

        let mut namespace_changed = config.clone();
        namespace_changed.namespace = "tenant-a".to_string();
        let second = registry.rnacos_console_session(&namespace_changed).await;

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn replaces_console_session_when_credentials_change() {
        let registry = NacosAdminRegistry::new();
        let first = registry.rnacos_console_session(&rnacos_config("admin", "admin")).await;
        let second = registry.rnacos_console_session(&rnacos_config("admin", "new-password")).await;

        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn shares_console_session_across_connection_contexts_for_the_same_instance() {
        let registry = NacosAdminRegistry::new();
        let first = registry.rnacos_console_session(&rnacos_config("admin", "admin")).await;
        let second = registry.rnacos_console_session(&rnacos_config("admin", "admin")).await;

        assert!(Arc::ptr_eq(&first, &second));
    }
}
