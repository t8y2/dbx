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
use crate::mq::adapters::rabbitmq::RabbitMqAdmin;
use crate::mq::adapters::rocketmq::RocketMqAdmin;
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
/// Clone shares the same cache (needed for keepalive tasks that must drop adapters).
#[derive(Clone, Default)]
pub struct MqAdminRegistry {
    instances: Arc<RwLock<HashMap<String, CachedMqAdmin>>>,
    build_locks: Arc<RwLock<HashMap<String, Arc<Mutex<()>>>>>,
}

struct CachedMqAdmin {
    fingerprint: u64,
    adapter: Arc<dyn MessageQueueAdmin>,
}

/// Result of resolving an MQ admin adapter for a connection attempt.
pub struct MqBuildResult {
    pub adapter: Arc<dyn MessageQueueAdmin>,
    /// True when an existing cached adapter was reused (reconnect fast path).
    pub was_cached: bool,
}

impl MqAdminRegistry {
    pub fn new() -> Self {
        Self { instances: Arc::new(RwLock::new(HashMap::new())), build_locks: Arc::new(RwLock::new(HashMap::new())) }
    }

    /// Return the cached adapter for this connection, building it from the
    /// connection's `external_config` if not already present.
    pub async fn get_or_build(&self, cfg: &ConnectionConfig) -> Result<MqBuildResult, String> {
        let mqc = MqAdminConfig::from_connection(cfg)?;
        self.get_or_build_config(&cfg.id, mqc, None).await
    }

    pub async fn get_or_build_config(
        &self,
        connection_id: &str,
        mqc: MqAdminConfig,
        agent_launch: Option<AgentLaunchSpec>,
    ) -> Result<MqBuildResult, String> {
        let fingerprint = adapter_fingerprint(&mqc, agent_launch.as_ref());

        // Fast path: return the cached adapter.
        if let Some(entry) = self.instances.read().await.get(connection_id) {
            if entry.fingerprint == fingerprint {
                return Ok(MqBuildResult { adapter: entry.adapter.clone(), was_cached: true });
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
                return Ok(MqBuildResult { adapter: entry.adapter.clone(), was_cached: true });
            }
        }

        // Config changed — drop the stale adapter so its agent process is released.
        self.instances.write().await.remove(connection_id);

        let adapter = build_adapter_with_connect_timeout(mqc, agent_launch).await?;
        self.instances
            .write()
            .await
            .insert(connection_id.to_string(), CachedMqAdmin { fingerprint, adapter: adapter.clone() });
        Ok(MqBuildResult { adapter, was_cached: false })
    }

    /// Cached adapter for keepalive / diagnostics. Returns `None` when not built yet.
    pub async fn get_cached_adapter(&self, connection_id: &str) -> Option<Arc<dyn MessageQueueAdmin>> {
        self.instances.read().await.get(connection_id).map(|entry| entry.adapter.clone())
    }

    /// Whether `adapter` is still the live registry entry for this connection (Arc identity).
    /// Used so a stale keepalive cannot drop a replacement built after reconnect.
    pub async fn is_current_adapter(&self, connection_id: &str, adapter: &Arc<dyn MessageQueueAdmin>) -> bool {
        self.instances.read().await.get(connection_id).is_some_and(|entry| Arc::ptr_eq(&entry.adapter, adapter))
    }

    /// Drop the cached adapter for a connection (called on disconnect).
    pub async fn drop_connection(&self, connection_id: &str) {
        self.instances.write().await.remove(connection_id);
        self.build_locks.write().await.remove(connection_id);
    }

    /// Whether an adapter is currently cached for this connection id.
    pub async fn has_cached_connection(&self, connection_id: &str) -> bool {
        self.instances.read().await.contains_key(connection_id)
    }

    /// Connection ids currently holding a cached MQ adapter (for cleanup assertions).
    pub async fn cached_connection_ids(&self) -> Vec<String> {
        self.instances.read().await.keys().cloned().collect()
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
        agent_launch: Option<AgentLaunchSpec>,
    ) -> Result<Arc<dyn MessageQueueAdmin>, String> {
        build_adapter_with_connect_timeout(mqc, agent_launch).await
    }
}

async fn build_adapter_with_connect_timeout(
    mqc: MqAdminConfig,
    agent_launch: Option<AgentLaunchSpec>,
) -> Result<Arc<dyn MessageQueueAdmin>, String> {
    let budget = mqc.connect_timeout();
    // RocketMQ: TCP-probe NameServer outside the connect wall so cold JVM spawn
    // retains the full connect_timeout (probe used to steal up to half of it).
    if mqc.system_kind == MqSystemKindInternal::RocketMq {
        // Probe runs outside the connect wall; scale with Advanced connect_timeout (no hard 5s cap).
        let probe_budget = (budget / 2).max(std::time::Duration::from_millis(500));
        crate::mq::adapters::rocketmq::probe_namesrv_before_connect(&mqc, probe_budget).await?;
    }
    match tokio::time::timeout(budget, build_adapter(mqc, agent_launch)).await {
        Ok(result) => result,
        Err(_) => Err(format!("Message queue connect timed out after {}s", budget.as_secs())),
    }
}

/// Validate connectivity after resolving an MQ adapter. Skips an immediate probe when
/// the adapter was just built and its connect path already verified the cluster.
pub async fn validate_mq_adapter_after_build(build: &MqBuildResult) -> Result<(), String> {
    if build.was_cached || !build.adapter.build_includes_connect_test() {
        build.adapter.test_connection().await?;
    }
    Ok(())
}

fn adapter_fingerprint(mqc: &MqAdminConfig, agent_launch: Option<&AgentLaunchSpec>) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{mqc:?}").hash(&mut hasher);
    format!("{agent_launch:?}").hash(&mut hasher);
    hasher.finish()
}

async fn build_adapter(
    mqc: MqAdminConfig,
    agent_launch: Option<AgentLaunchSpec>,
) -> Result<Arc<dyn MessageQueueAdmin>, String> {
    match mqc.system_kind {
        MqSystemKindInternal::Pulsar => {
            let adapter = PulsarAdmin::new(mqc).await?;
            Ok(Arc::new(adapter))
        }
        MqSystemKindInternal::Kafka => {
            let launch = agent_launch
                .ok_or("Kafka adapter requires an agent launch spec. The Kafka agent driver is not installed or not configured.")?;
            let adapter = KafkaAdmin::new(mqc, launch).await?;
            Ok(Arc::new(adapter))
        }
        MqSystemKindInternal::RocketMq => {
            let launch = agent_launch.ok_or(
                "RocketMQ adapter requires an agent launch spec. The RocketMQ agent driver is not installed or not configured.",
            )?;
            let adapter = RocketMqAdmin::new(mqc, launch).await?;
            Ok(Arc::new(adapter))
        }
        MqSystemKindInternal::RabbitMq => {
            let launch = agent_launch.ok_or(
                "RabbitMQ adapter requires an agent launch spec. The RabbitMQ agent driver is not installed or not configured.",
            )?;
            let adapter = RabbitMqAdmin::new(mqc, launch).await?;
            Ok(Arc::new(adapter))
        }
    }
}
