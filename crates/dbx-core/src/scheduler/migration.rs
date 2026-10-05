//! Legacy migration support (ADR §8.3). The concrete backup migration is
//! Agent A4's work (`scheduler/providers/database_backup.rs` +
//! `scheduler/migration.rs` there); this module exposes the interface and the
//! idempotent marker semantics every scheduler migration must use:
//!
//! - **Atomic**: marker check, data transform and marker write happen inside
//!   a single `BEGIN IMMEDIATE` transaction. Any failure rolls everything
//!   back — a marker is never written for partially migrated data.
//! - **Idempotent**: a present marker short-circuits; re-running is a no-op.
//! - **Restart-safe**: a crash before commit leaves no marker, so the next
//!   startup retries the whole migration cleanly.
//! - **Legacy data is preserved** after a successful migration (rollback and
//!   audit basis); callers must not delete legacy tables here.

use rusqlite::Connection;

use super::store::SchedulerStore;
use super::TaskError;

#[derive(Debug, Clone)]
pub struct SchedulerMigration {
    store: SchedulerStore,
}

impl SchedulerMigration {
    pub fn new(store: SchedulerStore) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &SchedulerStore {
        &self.store
    }

    /// Whether the migration `key` has already been applied.
    pub async fn is_applied(&self, key: &str) -> Result<bool, TaskError> {
        self.store.has_migration_marker(key.to_owned()).await
    }

    /// Runs the migration body under the idempotent marker protocol. Returns
    /// `true` when the body ran, `false` when the marker was already present.
    pub async fn apply(
        &self,
        key: &str,
        migrate: impl FnOnce(&Connection) -> Result<(), TaskError> + Send + 'static,
    ) -> Result<bool, TaskError> {
        self.store.run_migration(key, migrate).await
    }
}
