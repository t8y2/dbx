//! Message queue admin console support.
//!
//! Provides a pluggable, port-adapter abstraction for managing message queue
//! systems (Apache Pulsar today; Kafka / RocketMQ are reserved). The module is
//! gated behind the `mq-admin` Cargo feature so builds that don't need it pay
//! nothing.
//!
//! Architecture mirrors the existing `agent_kv` pattern: business logic lives in
//! `service::*_core` functions shared by the desktop command layer and the web
//! route layer; this module owns the trait, the typed model, and the registry
//! that caches one adapter per connection.

pub mod adapters;
pub mod auth;
pub mod config;
pub mod port;
pub mod service;
pub mod token;
pub mod types;
pub(crate) mod util;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};

use crate::db::agent_driver::AgentLaunchSpec;
use crate::models::connection::ConnectionConfig;
use crate::mq::adapters::kafka::KafkaAdmin;
use crate::mq::adapters::pulsar::PulsarAdmin;
use crate::mq::config::MqAdminConfig;
use crate::mq::port::MessageQueueAdmin;
use crate::mq::types::MqSystemKind as MqSystemKindInternal;

pub use crate::mq::auth::MqAuth;
pub use crate::mq::config::MqAdminConfig as MqConfig;
pub use crate::mq::types::*;

/// Caches one live admin adapter per connection id. Adapters are built lazily on
/// first use and dropped when the connection is closed.
///
/// Each connection has its own build-lock so concurrent first-use requests for
/// the same connection block until the first builder finishes, rather than both
/// racing to construct an adapter.
#[derive(Default)]
pub struct MqAdminRegistry {
    instances: RwLock<HashMap<String, CachedMqAdmin>>,
    build_locks: RwLock<HashMap<String, Arc<Mutex<()>>>>,
}

struct CachedMqAdmin {
    fingerprint: u64,
    adapter: Arc<dyn MessageQueueAdmin>,
}

impl MqAdminRegistry {
    pub fn new() -> Self {
        Self { instances: RwLock::new(HashMap::new()), build_locks: RwLock::new(HashMap::new()) }
    }

    /// Return the cached adapter for this connection, building it from the
    /// connection's `external_config` if not already present.
    pub async fn get_or_build(&self, cfg: &ConnectionConfig) -> Result<Arc<dyn MessageQueueAdmin>, String> {
        let mqc = MqAdminConfig::from_connection(cfg)?;
        self.get_or_build_config(&cfg.id, mqc, None).await
    }

    pub async fn get_or_build_config(
        &self,
        connection_id: &str,
        mqc: MqAdminConfig,
        kafka_launch: Option<AgentLaunchSpec>,
    ) -> Result<Arc<dyn MessageQueueAdmin>, String> {
        let fingerprint = adapter_fingerprint(&mqc, kafka_launch.as_ref());

        // Fast path: return the cached adapter.
        if let Some(entry) = self.instances.read().await.get(connection_id) {
            if entry.fingerprint == fingerprint {
                return Ok(entry.adapter.clone());
            }
        }

        // Slow path: acquire a per-connection build lock so only one task
        // constructs the adapter at a time.
        let lock = {
            let mut locks = self.build_locks.write().await;
            locks.entry(connection_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
        };
        let _guard = lock.lock().await;

        // Another task may have built it while we were waiting for the lock.
        if let Some(entry) = self.instances.read().await.get(connection_id) {
            if entry.fingerprint == fingerprint {
                return Ok(entry.adapter.clone());
            }
        }

        let adapter = build_adapter(mqc, kafka_launch).await?;
        self.instances
            .write()
            .await
            .insert(connection_id.to_string(), CachedMqAdmin { fingerprint, adapter: adapter.clone() });
        Ok(adapter)
    }

    /// Drop the cached adapter for a connection (called on disconnect).
    pub async fn drop_connection(&self, connection_id: &str) {
        self.instances.write().await.remove(connection_id);
        self.build_locks.write().await.remove(connection_id);
    }

    /// Build a fresh adapter without caching it — used for connection tests
    /// where we don't want to retain state.
    pub async fn build_transient(&self, cfg: &ConnectionConfig) -> Result<Arc<dyn MessageQueueAdmin>, String> {
        let mqc = MqAdminConfig::from_connection(cfg)?;
        self.build_transient_config(mqc, None).await
    }

    pub async fn build_transient_config(
        &self,
        mqc: MqAdminConfig,
        kafka_launch: Option<AgentLaunchSpec>,
    ) -> Result<Arc<dyn MessageQueueAdmin>, String> {
        build_adapter(mqc, kafka_launch).await
    }
}

fn adapter_fingerprint(mqc: &MqAdminConfig, kafka_launch: Option<&AgentLaunchSpec>) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{mqc:?}").hash(&mut hasher);
    format!("{kafka_launch:?}").hash(&mut hasher);
    hasher.finish()
}

async fn build_adapter(
    mqc: MqAdminConfig,
    kafka_launch: Option<AgentLaunchSpec>,
) -> Result<Arc<dyn MessageQueueAdmin>, String> {
    match mqc.system_kind {
        MqSystemKindInternal::Pulsar => {
            let adapter = PulsarAdmin::new(mqc).await?;
            Ok(Arc::new(adapter))
        }
        MqSystemKindInternal::Kafka => {
            let launch = kafka_launch
                .ok_or("Kafka adapter requires an agent launch spec. The Kafka agent driver is not installed or not configured.")?;
            let adapter = KafkaAdmin::new(mqc, launch).await?;
            Ok(Arc::new(adapter))
        }
        MqSystemKindInternal::RocketMq => Err("RocketMQ admin is not yet implemented".to_string()),
    }
}
