//! Scheduler lease (ADR §3.4): a named DB lease in `scheduler_leases` guards
//! the single active worker. Acquisition runs inside `BEGIN IMMEDIATE` so two
//! workers can never both believe they hold the lease; the holder heartbeats
//! to extend `lease_until` and releases on graceful shutdown. Expired leases
//! are freely takeable — a crashed worker cannot block recovery forever.

use std::time::Duration;

use super::store::{RecoveryReport, SchedulerStore};
use super::TaskError;

#[derive(Debug, Clone)]
pub struct LeaseGuard {
    store: SchedulerStore,
    name: String,
    worker_id: String,
    ttl: Duration,
}

impl LeaseGuard {
    /// Tries to take the lease. `Ok(None)` means another live worker holds it.
    pub async fn acquire(
        store: &SchedulerStore,
        name: &str,
        worker_id: &str,
        ttl: Duration,
    ) -> Result<Option<Self>, TaskError> {
        let acquired = store.acquire_lease(name.to_owned(), worker_id.to_owned(), ttl).await?;
        Ok(acquired.then(|| Self { store: store.clone(), name: name.to_owned(), worker_id: worker_id.to_owned(), ttl }))
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    /// Extends the lease. `false` means the lease was lost (expired and taken
    /// by another worker); the caller should stop claiming new work.
    pub async fn heartbeat(&self) -> Result<bool, TaskError> {
        self.store.heartbeat_lease(self.name.clone(), self.worker_id.clone(), self.ttl).await
    }

    /// Startup recovery, to be run once right after the lease is taken.
    pub async fn recover(&self) -> Result<RecoveryReport, TaskError> {
        self.store.recover().await
    }

    /// Releases the lease. Best effort: an unreachable store leaves the lease
    /// to expire on its own, which is always safe.
    pub async fn release(&self) {
        let _ = self.store.release_lease(self.name.clone(), self.worker_id.clone()).await;
    }
}
