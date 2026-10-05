//! Legacy migration support (ADR §8.3). This module owns the idempotent
//! marker protocol every scheduler migration uses and the concrete legacy
//! Database Backup migration (the field mapping itself lives in
//! `scheduler/providers/database_backup.rs`):
//!
//! - **Atomic**: marker check, data transform and marker write happen inside
//!   a single `BEGIN IMMEDIATE` transaction. Any failure rolls everything
//!   back — a marker is never written for partially migrated data.
//! - **Idempotent**: a present marker short-circuits; re-running is a no-op,
//!   and rows are inserted with `INSERT OR IGNORE`.
//! - **Restart-safe**: a crash before commit leaves no marker, so the next
//!   startup retries the whole migration cleanly.
//! - **Legacy data is preserved** after a successful migration (rollback and
//!   audit basis); this module only ever reads the legacy store.

use std::{collections::HashSet, path::Path, sync::Mutex};

use rusqlite::{Connection, OptionalExtension};

use super::models::TaskDefinition;
use super::providers::database_backup::{backup_run_to_task_run, backup_schedule_to_task};
use super::store::SchedulerStore;
use super::TaskError;
use crate::scheduled_backup::BackupStore;

/// Marker key of the legacy Database Backup → builtin task provider
/// migration (ADR §8). Stored as `migration/<key>` in `scheduler_leases`.
pub const DATABASE_BACKUP_MIGRATION_KEY: &str = "database-backup";

/// What a successful [`SchedulerMigration::migrate_legacy_database_backups`]
/// run converted. Zero on a short-circuit (marker already present).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LegacyBackupMigrationReport {
    pub schedules: usize,
    pub runs: usize,
}

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

    /// Migrates legacy scheduled database backups into the generic scheduler
    /// (ADR §8): every `BackupSchedule` becomes a `dbx.database-backup` task
    /// definition (old id, name, timestamps, enabled flag and last-run
    /// bookkeeping kept), every scheduled `BackupRun` becomes a `TaskRun`
    /// (old run id kept; runs that were in flight when the migration ran are
    /// recorded as `failed` with `error_code = "worker_interrupted"`).
    ///
    /// Guarantees (ADR §8.3):
    /// - **Idempotent**: a present marker short-circuits; rows are inserted
    ///   with `INSERT OR IGNORE`, so even a racing duplicate cannot duplicate
    ///   history.
    /// - **Atomic**: reads, transforms, inserts and (via `run_migration`) the
    ///   marker write share one `BEGIN IMMEDIATE` transaction. Any failure —
    ///   including one invalid legacy schedule or run — rolls everything back
    ///   and the marker is not written.
    /// - **Restart-safe**: a crash before commit leaves no marker, so the
    ///   next startup retries the whole migration.
    /// - **Legacy data is preserved**: the `database-backups/` store is only
    ///   ever read; nothing is deleted or disabled (rollback / audit basis,
    ///   and the compatibility adapter keeps working).
    ///
    /// One-shot runs (no schedule) are not migrated — the frozen schema
    /// requires every run to reference a task; they stay in the preserved
    /// legacy history. Runs whose schedule is absent (e.g. deleted) are
    /// skipped for the same foreign-key reason.
    pub async fn migrate_legacy_database_backups(
        &self,
        legacy: &BackupStore,
    ) -> Result<LegacyBackupMigrationReport, TaskError> {
        if self.is_applied(DATABASE_BACKUP_MIGRATION_KEY).await? {
            return Ok(LegacyBackupMigrationReport::default());
        }
        let legacy_path = legacy.directory.join("state.db");
        let counts = std::sync::Arc::new(Mutex::new(LegacyBackupMigrationReport::default()));
        let applied = {
            let counts = std::sync::Arc::clone(&counts);
            self.apply(DATABASE_BACKUP_MIGRATION_KEY, move |tx| {
                let schedules = read_legacy_schedules(&legacy_path)?;
                let runs = read_legacy_runs(&legacy_path)?;
                for schedule in &schedules {
                    let task = backup_schedule_to_task(schedule)?;
                    // A definition that already exists (e.g. created by hand
                    // between two partial attempts) wins: INSERT OR IGNORE
                    // keeps both the data and the protocol idempotent.
                    insert_task_definition(tx, &task)?;
                    counts.lock().expect("migration counts").schedules += 1;
                }
                // Runs only migrate when their schedule was migrated: the
                // frozen schema enforces the foreign key.
                let task_ids: HashSet<String> = schedules.iter().map(|schedule| schedule.id.clone()).collect();
                for (state, run) in &runs {
                    if state == "deleting" {
                        continue;
                    }
                    let Some(task_run) = backup_run_to_task_run(run, chrono::Utc::now())? else { continue };
                    if !task_ids.contains(&task_run.task_id) {
                        continue;
                    }
                    // payload_json keeps the original legacy run payload
                    // (files, display name, connection name) as the audit
                    // record. The scheduler only decodes payloads of active
                    // runs, and migrated runs are terminal by construction.
                    let legacy_payload = serde_json::to_string(run)
                        .map_err(|error| TaskError::internal(format!("Encode failed: {error}")))?;
                    insert_task_run(tx, &task_run, &legacy_payload)?;
                    counts.lock().expect("migration counts").runs += 1;
                }
                Ok(())
            })
            .await?
        };
        Ok(if applied { *counts.lock().expect("migration counts") } else { LegacyBackupMigrationReport::default() })
    }
}

fn encode(value: &impl serde::Serialize) -> Result<String, TaskError> {
    serde_json::to_string(value).map_err(|error| TaskError::internal(format!("Encode failed: {error}")))
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, TaskError> {
    serde_json::from_str(value).map_err(|error| TaskError::internal(format!("Decode failed: {error}")))
}

/// Opens the legacy backup store for reading. The connection is only ever
/// used for `SELECT`s, so migration never mutates legacy data. A missing file
/// or missing tables (fresh install, never-used legacy feature) reads as
/// "nothing to migrate".
fn open_legacy(path: &Path) -> Result<Option<Connection>, TaskError> {
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let present: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedules')", [], |row| {
            row.get(0)
        })
        .optional()?
        .unwrap_or(false);
    if !present {
        return Ok(None);
    }
    Ok(Some(conn))
}

fn read_legacy_schedules(path: &Path) -> Result<Vec<crate::scheduled_backup::BackupSchedule>, TaskError> {
    let Some(conn) = open_legacy(path)? else { return Ok(Vec::new()) };
    let mut statement = conn.prepare("SELECT payload FROM schedules ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut schedules = Vec::new();
    for row in rows {
        schedules.push(decode(&row?)?);
    }
    Ok(schedules)
}

fn read_legacy_runs(path: &Path) -> Result<Vec<(String, crate::scheduled_backup::BackupRun)>, TaskError> {
    let Some(conn) = open_legacy(path)? else { return Ok(Vec::new()) };
    let mut statement = conn.prepare("SELECT state, payload FROM runs ORDER BY created_at, id")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut runs = Vec::new();
    for row in rows {
        let (state, payload) = row?;
        runs.push((state, decode(&payload)?));
    }
    Ok(runs)
}

fn insert_task_definition(tx: &Connection, task: &TaskDefinition) -> Result<(), TaskError> {
    tx.execute(
        "INSERT OR IGNORE INTO task_definitions(id,name,provider_type,provider_id,target_json,trigger_json,execution_json,config_version,config_json,enabled,created_at,updated_at,next_run_at,last_run_at,last_run_status,version)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            task.id,
            task.name,
            encode(&task.provider_type)?,
            task.provider_id,
            encode(&task.target)?,
            encode(&task.trigger)?,
            encode(&task.execution)?,
            task.config_version,
            encode(&task.config)?,
            i64::from(task.enabled),
            task.created_at,
            task.updated_at,
            task.next_run_at,
            task.last_run_at,
            task.last_run_status.map(|status| status.as_str()),
            task.version,
        ],
    )?;
    Ok(())
}

fn insert_task_run(tx: &Connection, run: &super::models::TaskRun, legacy_payload: &str) -> Result<(), TaskError> {
    tx.execute(
        "INSERT OR IGNORE INTO task_runs(id,task_id,status,trigger_type,attempt,worker_id,started_at,completed_at,exit_code,error_code,error_message,progress_percent,created_at,payload_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            run.id,
            run.task_id,
            run.status.as_str(),
            encode(&run.trigger)?,
            run.attempt,
            run.worker_id,
            run.started_at,
            run.completed_at,
            run.exit_code,
            run.error_code,
            run.error_message,
            run.progress_percent,
            run.created_at,
            legacy_payload,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::scheduler::providers::database_backup::{backup_schedule_to_task, DATABASE_BACKUP_PROVIDER_ID};

    /// The provider id must stay the frozen builtin namespace (ADR §2.2).
    #[test]
    fn provider_id_is_frozen() {
        assert_eq!(DATABASE_BACKUP_PROVIDER_ID, "dbx.database-backup");
    }

    /// The task config must never carry secret-shaped keys (ADR §10); the
    /// legacy backup config has none, and this pins the regression.
    #[test]
    fn migrated_config_contains_no_secret_shaped_keys() {
        let schedule: crate::scheduled_backup::BackupSchedule = serde_json::from_str(
            r#"{
                "id": "s", "name": "n", "enabled": true, "connectionId": "c", "databases": [],
                "destinationDirectory": "/tmp/b", "includeStructure": true, "includeData": true,
                "includeObjects": true, "frequency": "daily", "intervalHours": 1,
                "timeOfDay": "02:30", "weekday": 0, "retentionCount": 3, "timeZone": "UTC",
                "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-01T00:00:00+00:00",
                "nextRunAt": "2026-01-01T00:00:00+00:00"
            }"#,
        )
        .unwrap();
        let task = backup_schedule_to_task(&schedule).unwrap();
        for key in task.config.as_object().unwrap().keys() {
            assert!(
                !["password", "token", "secret", "privatekey", "authorization"].contains(&key.to_lowercase().as_str()),
                "secret-shaped key leaked into task config: {key}"
            );
        }
    }
}
