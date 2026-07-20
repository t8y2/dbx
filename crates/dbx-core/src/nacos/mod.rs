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

use tokio::sync::{Mutex, RwLock};

use crate::models::connection::ConnectionConfig;
use crate::nacos::config::NacosAdminConfig;
use crate::nacos::http::NacosOpenApiAdmin;
use crate::nacos::port::NacosAdmin;

pub use crate::nacos::config::{NacosAdminConfig as NacosConfig, NacosAuthConfig};
pub use crate::nacos::types::*;

type NacosAdminEntry = (NacosAdminConfig, Arc<dyn NacosAdmin>);

#[derive(Default)]
pub struct NacosAdminRegistry {
    instances: RwLock<HashMap<String, NacosAdminEntry>>,
    build_locks: RwLock<HashMap<String, Arc<Mutex<()>>>>,
}

impl NacosAdminRegistry {
    pub fn new() -> Self {
        Self { instances: RwLock::new(HashMap::new()), build_locks: RwLock::new(HashMap::new()) }
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

        let admin = build_admin(cfg.clone())?;
        self.instances.write().await.insert(connection_id.to_string(), (cfg, admin.clone()));
        Ok(admin)
    }

    pub async fn build_transient(&self, cfg: &ConnectionConfig) -> Result<Arc<dyn NacosAdmin>, String> {
        let admin_config = NacosAdminConfig::from_connection(cfg)?;
        self.build_transient_config(admin_config).await
    }

    pub async fn build_transient_config(&self, cfg: NacosAdminConfig) -> Result<Arc<dyn NacosAdmin>, String> {
        build_admin(cfg)
    }

    pub async fn drop_connection(&self, connection_id: &str) {
        self.instances.write().await.remove(connection_id);
        self.build_locks.write().await.remove(connection_id);
    }
}

fn build_admin(cfg: NacosAdminConfig) -> Result<Arc<dyn NacosAdmin>, String> {
    Ok(Arc::new(NacosOpenApiAdmin::new(cfg)?))
}
