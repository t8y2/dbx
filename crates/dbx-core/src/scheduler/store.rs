//! Scheduler persistence (ADR §3): SQLite at `<data-dir>/scheduler/state.db`.
//!
//! The store only owns persistence and atomic state transitions — it never
//! executes plugins or knows about provider business. Every state transition
//! runs inside a `TransactionBehavior::Immediate` transaction so concurrent
//! workers can never claim the same run.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::artifacts::TaskArtifact;
use super::logs::{self, TaskLogPage, TaskLogQuery};
use super::models::*;
use super::policy;
use super::resident::{ResidentSession, ResidentState};
use super::trigger::TaskTrigger;
use super::TaskError;

/// The seven frozen tables (ADR §3.2). Column semantics must not change.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS task_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_status TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_task_definitions_next_run ON task_definitions(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  exit_code INTEGER,
  error_code TEXT,
  error_message TEXT,
  progress_percent REAL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES task_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_active ON task_runs(status);

CREATE TABLE IF NOT EXISTS task_runtime_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  heartbeat_at TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  checksum TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_run ON task_artifacts(run_id);

CREATE TABLE IF NOT EXISTS task_log_index (
  run_id TEXT NOT NULL,
  segment INTEGER NOT NULL,
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, segment)
);

CREATE TABLE IF NOT EXISTS task_audit (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
";

/// Default lease name of the single desktop worker (ADR §3.2).
pub const SCHEDULER_LEASE: &str = "scheduler";

/// Lease-row prefix used to persist migration markers (ADR §8.3).
pub const MIGRATION_MARKER_PREFIX: &str = "migration/";

/// Snapshot persisted with every queued run: the definition as it looked at
/// trigger time plus the cancel flag. Secret values are already redacted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunJob {
    pub run: TaskRun,
    pub task: TaskDefinition,
    #[serde(default)]
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecoveryReport {
    /// `starting` runs returned to the queue (executor never started).
    pub requeued: Vec<String>,
    /// Run-mode `running` runs marked failed with `worker_interrupted`.
    pub interrupted: Vec<String>,
    /// Resident sessions marked crashed for later reconcile/restart.
    pub crashed_sessions: Vec<String>,
}

fn encode(value: &impl Serialize) -> Result<String, TaskError> {
    serde_json::to_string(value).map_err(|error| TaskError::internal(format!("Encode failed: {error}")))
}

fn decode<T: DeserializeOwned>(value: &str) -> Result<T, TaskError> {
    serde_json::from_str(value).map_err(|error| TaskError::internal(format!("Decode failed: {error}")))
}

fn rfc3339(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, TaskError> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|error| TaskError::internal(format!("Invalid stored timestamp {value}: {error}")))
}

#[derive(Debug, Clone)]
pub struct SchedulerStore {
    directory: PathBuf,
}

impl SchedulerStore {
    /// `data_dir` is the DBX data directory; the scheduler database lives in
    /// its own `scheduler/` subtree (never inside `database-backups/`).
    pub fn new(data_dir: &Path) -> Self {
        Self { directory: data_dir.join("scheduler") }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn logs_root(&self) -> PathBuf {
        self.directory.join("logs")
    }

    async fn access<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut Connection) -> Result<T, TaskError> + Send + 'static,
    ) -> Result<T, TaskError> {
        let dir = self.directory.clone();
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&dir)
                .map_err(|error| TaskError::unavailable(format!("Cannot create scheduler directory: {error}")))?;
            let mut conn = Connection::open(dir.join("state.db"))?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            // WAL is part of the frozen contract (ADR §3.1) and required for
            // reliable BEGIN IMMEDIATE serialization across connections.
            conn.execute_batch("PRAGMA journal_mode=WAL;")?;
            conn.execute_batch(SCHEMA)?;
            action(&mut conn)
        })
        .await
        .map_err(|error| TaskError::unavailable(format!("Scheduler store worker failed: {error}")))?
    }

    // ------------------------------------------------------------------
    // Task definitions (CAS optimistic locking)
    // ------------------------------------------------------------------

    fn write_task(tx: &Transaction, task: &TaskDefinition) -> Result<(), TaskError> {
        tx.execute(
            "INSERT INTO task_definitions(id,name,provider_type,provider_id,target_json,trigger_json,execution_json,config_version,config_json,enabled,created_at,updated_at,next_run_at,last_run_at,last_run_status,version)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, provider_type=excluded.provider_type, provider_id=excluded.provider_id,
               target_json=excluded.target_json, trigger_json=excluded.trigger_json, execution_json=excluded.execution_json,
               config_version=excluded.config_version, config_json=excluded.config_json, enabled=excluded.enabled,
               updated_at=excluded.updated_at, next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at,
               last_run_status=excluded.last_run_status, version=excluded.version",
            params![
                task.id,
                task.name,
                encode(&task.provider_type)?,
                task.provider_id,
                encode(&task.target)?,
                encode(&task.trigger)?,
                encode(&task.execution)?,
                task.config_version,
                encode(&task.config)?,
                task.enabled,
                task.created_at,
                task.updated_at,
                task.next_run_at,
                task.last_run_at,
                task.last_run_status.map(|status| status.as_str()),
                task.version,
            ],
        )
        .map_err(|error| TaskError::unavailable(format!("Cannot save task: {error}")))?;
        Ok(())
    }

    fn read_task(row: &rusqlite::Row) -> Result<TaskDefinition, rusqlite::Error> {
        let provider_type: String = row.get("provider_type")?;
        let trigger_json: String = row.get("trigger_json")?;
        Ok(TaskDefinition {
            id: row.get("id")?,
            name: row.get("name")?,
            provider_type: serde_json::from_str(&provider_type).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
            })?,
            provider_id: row.get("provider_id")?,
            target: decode_unchecked(&row.get::<_, String>("target_json")?),
            trigger: decode_unchecked(&trigger_json),
            execution: decode_unchecked(&row.get::<_, String>("execution_json")?),
            config_version: row.get("config_version")?,
            config: decode_unchecked(&row.get::<_, String>("config_json")?),
            enabled: row.get::<_, i64>("enabled")? != 0,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            next_run_at: row.get("next_run_at")?,
            last_run_at: row.get("last_run_at")?,
            last_run_status: row
                .get::<_, Option<String>>("last_run_status")?
                .and_then(|status| serde_json::from_str(&format!("\"{status}\"")).ok()),
            version: row.get("version")?,
        })
    }

    fn load_task(conn: &Connection, id: &str) -> Result<TaskDefinition, TaskError> {
        conn.query_row("SELECT * FROM task_definitions WHERE id=?", [id], Self::read_task)
            .optional()
            .map_err(|error| TaskError::unavailable(format!("Cannot load task: {error}")))?
            .ok_or_else(|| {
                TaskError::new(super::TaskErrorKind::NonRetryable, "task_not_found", format!("Task {id} not found"))
            })
    }

    /// Creates or updates a task with optimistic locking. `expected_version`
    /// must match the stored version for updates (`None` for creation); on
    /// mismatch a `version_conflict` error is returned (HTTP 409 upstream).
    /// Secret-shaped config keys are redacted before persisting (ADR §10).
    pub async fn save_task(
        &self,
        mut task: TaskDefinition,
        expected_version: Option<i64>,
    ) -> Result<TaskDefinition, TaskError> {
        // Strip secret-shaped keys before validation: a nulled key would
        // still leak the key name into exports and events (ADR §10).
        let mut config = task.config.clone();
        super::remove_secret_keys(&mut config);
        task.config = config;
        task.validate()?;
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = Utc::now();
            let existing: Option<i64> = tx
                .query_row("SELECT version FROM task_definitions WHERE id=?", [&task.id], |row| row.get(0))
                .optional()?;
            match (existing, expected_version) {
                (None, None) => {
                    task.created_at = rfc3339(now);
                    task.version = 1;
                    // Fresh schedule from the trigger (None for manual/startup).
                    if task.next_run_at.is_none() {
                        task.next_run_at = schedule_next(&task.trigger, now).unwrap_or(None);
                    }
                }
                (Some(current), Some(expected)) if current == expected => {
                    let old = Self::load_task(&tx, &task.id)?;
                    task.created_at = old.created_at;
                    task.last_run_at = old.last_run_at;
                    task.last_run_status = old.last_run_status;
                    task.version = current + 1;
                    // `next_run_at` is scheduler-owned; a caller that leaves it
                    // empty gets a fresh schedule from the (possibly new) trigger.
                    if task.next_run_at.is_none() {
                        task.next_run_at = schedule_next(&task.trigger, now)?;
                    }
                }
                (Some(_), _) => {
                    return Err(TaskError::version_conflict("Task was modified by someone else; reload before saving"));
                }
                (None, Some(_)) => {
                    return Err(TaskError::version_conflict(format!("Task {} does not exist", task.id)));
                }
            }
            task.updated_at = rfc3339(now);
            Self::write_task(&tx, &task)?;
            tx.commit()?;
            Ok(task)
        })
        .await
    }

    pub async fn list_tasks(&self) -> Result<Vec<TaskDefinition>, TaskError> {
        self.access(|conn| {
            let mut statement = conn
                .prepare("SELECT * FROM task_definitions ORDER BY created_at, id")
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows =
                statement.query_map([], Self::read_task).map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| TaskError::unavailable(format!("Cannot list tasks: {error}")))
        })
        .await
    }

    pub async fn get_task(&self, id: &str) -> Result<TaskDefinition, TaskError> {
        let id = id.to_owned();
        self.access(move |conn| Self::load_task(conn, &id)).await
    }

    /// Deletes a task definition. Active runs block deletion so the engine
    /// never loses a run's task context; finished runs and their artifacts
    /// are removed with the task (the frozen FK requires it).
    pub async fn delete_task(&self, id: String) -> Result<(), TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !tx
                .query_row("SELECT 1 FROM task_definitions WHERE id=?", [&id], |_| Ok(()))
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?
                .is_some()
            {
                return Err(TaskError::new(
                    super::TaskErrorKind::NonRetryable,
                    "task_not_found",
                    format!("Task {id} not found"),
                ));
            }
            let active: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM task_runs WHERE task_id=? AND status IN ('queued','starting','running')",
                    [&id],
                    |row| row.get(0),
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            if active > 0 {
                return Err(TaskError::run_already_active("Cannot delete a task with active runs"));
            }
            // History runs would orphan the definition row (FK constraint),
            // so they go with the task; log files stay on disk.
            tx.execute("DELETE FROM task_artifacts WHERE run_id IN (SELECT id FROM task_runs WHERE task_id=?)", [&id])
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            tx.execute("DELETE FROM task_runs WHERE task_id=?", [&id])
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            tx.execute("DELETE FROM task_runtime_sessions WHERE task_id=?", [&id])
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            tx.execute("DELETE FROM task_definitions WHERE id=?", [&id])
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    // ------------------------------------------------------------------
    // Runs: enqueue / claim / progress / cancel / finish
    // ------------------------------------------------------------------

    fn insert_run(tx: &Transaction, job: &RunJob, status: TaskRunStatus) -> Result<(), TaskError> {
        tx.execute(
            "INSERT INTO task_runs(id,task_id,status,trigger_type,attempt,worker_id,started_at,completed_at,exit_code,error_code,error_message,progress_percent,created_at,payload_json)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                job.run.id,
                job.run.task_id,
                status.as_str(),
                serde_json::to_string(&job.run.trigger).map_err(|error| TaskError::internal(error.to_string()))?,
                job.run.attempt,
                job.run.worker_id,
                job.run.started_at,
                job.run.completed_at,
                job.run.exit_code,
                job.run.error_code,
                job.run.error_message,
                job.run.progress_percent,
                job.run.created_at,
                encode(job)?,
            ],
        )
        .map_err(|error| TaskError::unavailable(format!("Cannot insert run: {error}")))?;
        Ok(())
    }

    fn read_run_job(row: &rusqlite::Row) -> Result<RunJob, rusqlite::Error> {
        let payload: String = row.get("payload_json")?;
        serde_json::from_str(&payload)
            .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))
    }

    /// `artifacts_count` is derived from `task_artifacts`, never stored.
    const RUN_SELECT: &str =
        "SELECT task_runs.*, (SELECT COUNT(*) FROM task_artifacts WHERE task_artifacts.run_id = task_runs.id) AS artifacts_count FROM task_runs";

    fn run_from_row(row: &rusqlite::Row) -> Result<TaskRun, rusqlite::Error> {
        let status: String = row.get("status")?;
        let trigger: String = row.get("trigger_type")?;
        Ok(TaskRun {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            status: serde_json::from_str(&format!("\"{status}\"")).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
            })?,
            trigger: serde_json::from_str(&trigger).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
            })?,
            attempt: row.get("attempt")?,
            worker_id: row.get("worker_id")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            exit_code: row.get("exit_code")?,
            error_code: row.get("error_code")?,
            error_message: row.get("error_message")?,
            progress_percent: row.get("progress_percent")?,
            artifacts_count: row.get::<_, i64>("artifacts_count")? as u32,
            created_at: row.get("created_at")?,
        })
    }

    fn pending_count(conn: &Connection) -> Result<usize, TaskError> {
        Ok(conn
            .query_row("SELECT COUNT(*) FROM task_runs WHERE status IN ('queued','starting','running')", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| TaskError::unavailable(error.to_string()))? as usize)
    }

    /// Enqueues a run of an existing task outside the due-schedule flow:
    /// manual "run now", engine retry, startup triggers and resident
    /// restarts. `available_at` lets retries carry a backoff delay — claim
    /// only picks runs whose `created_at` has come.
    pub async fn enqueue_run(
        &self,
        task_id: String,
        trigger: TaskRunTrigger,
        attempt: u32,
        available_at: DateTime<Utc>,
    ) -> Result<TaskRun, TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let task = Self::load_task(&tx, &task_id)?;
            let run = Self::enqueue_run_tx(&tx, &task, trigger, attempt, available_at)?;
            tx.commit()?;
            Ok(run)
        })
        .await
    }

    fn enqueue_run_tx(
        tx: &Transaction,
        task: &TaskDefinition,
        trigger: TaskRunTrigger,
        attempt: u32,
        available_at: DateTime<Utc>,
    ) -> Result<TaskRun, TaskError> {
        if Self::pending_count(tx)? >= MAX_PENDING_RUNS {
            return Err(TaskError::unavailable("Too many pending runs"));
        }
        let mut run = TaskRun::new(&task.id, trigger, attempt, available_at);
        run.created_at = rfc3339(available_at);
        let job = RunJob { run: run.clone(), task: task.clone(), cancel_requested: false };
        Self::insert_run(tx, &job, TaskRunStatus::Queued)?;
        Ok(run)
    }

    /// Manual "run now". Enforces the concurrency policy up front: `forbid`
    /// rejects with `run_already_active`, `replace` marks superseded queued
    /// runs skipped, `queue`/`parallel` enqueue behind the active run.
    pub async fn enqueue_manual(&self, task_id: String) -> Result<TaskRun, TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let task = Self::load_task(&tx, &task_id)?;
            // `forbid` counts queued runs too: two rapid manual clicks must
            // never queue two executions behind each other.
            let pending: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM task_runs WHERE task_id=? AND status IN ('queued','starting','running')",
                    [&task.id],
                    |row| row.get(0),
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            if pending > 0 && !policy::allows_enqueue_while_active(task.execution.concurrency) {
                if task.execution.concurrency == TaskConcurrencyPolicy::Replace {
                    Self::skip_queued_runs_tx(&tx, &task.id)?;
                } else {
                    return Err(TaskError::run_already_active("Task already has an active run"));
                }
            }
            let run = Self::enqueue_run_tx(&tx, &task, TaskRunTrigger::Manual, 1, Utc::now())?;
            tx.commit()?;
            Ok(run)
        })
        .await
    }

    fn active_run_count_tx(tx: &Transaction, task_id: &str) -> Result<i64, TaskError> {
        tx.query_row(
            "SELECT COUNT(*) FROM task_runs WHERE task_id=? AND status IN ('starting','running')",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| TaskError::unavailable(error.to_string()))
    }

    fn skip_queued_runs_tx(tx: &Transaction, task_id: &str) -> Result<(), TaskError> {
        let mut statement = tx
            .prepare("SELECT payload_json FROM task_runs WHERE task_id=? AND status='queued'")
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
        let rows: Vec<RunJob> = statement
            .query_map([task_id], Self::read_run_job)
            .map_err(|error| TaskError::unavailable(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
        drop(statement);
        for mut job in rows {
            job.run.status = TaskRunStatus::Skipped;
            job.run.completed_at = Some(rfc3339(Utc::now()));
            tx.execute(
                "UPDATE task_runs SET status='skipped', completed_at=?, payload_json=? WHERE id=? AND status='queued'",
                params![job.run.completed_at, encode(&job)?, job.run.id],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
        }
        Ok(())
    }

    /// Enqueues due scheduled runs and advances `next_run_at` in the same
    /// transaction (crash cannot replay missed intervals — misfire policy
    /// takes over). `once` triggers clear `next_run_at` after firing and keep
    /// the task enabled (ADR §14 D8).
    pub async fn enqueue_due(&self, now: DateTime<Utc>) -> Result<Vec<TaskRun>, TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut tasks: Vec<TaskDefinition> = {
                let mut statement = tx
                    .prepare("SELECT * FROM task_definitions WHERE enabled=1 ORDER BY created_at, id")
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                let mapped = statement
                    .query_map([], Self::read_task)
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                mapped.collect::<Result<Vec<_>, _>>().map_err(|error| TaskError::unavailable(error.to_string()))?
            };
            let mut enqueued = Vec::new();
            for task in tasks.iter_mut() {
                let Some(next_raw) = task.next_run_at.clone() else { continue };
                let Ok(next) = parse_time(&next_raw) else { continue };
                if next > now {
                    continue;
                }
                if task.trigger.next_after(now).is_err() {
                    // Invalid/unresolvable triggers never participate in enqueue_due.
                    continue;
                }
                let missed = policy::count_missed_fires(&task.trigger, next, now);
                let run_misfire = policy::should_run_misfire(task.execution.misfire);
                let last_fire = if missed > 1 && task.execution.misfire == TaskMisfirePolicy::FireOnce {
                    last_fire_before(&task.trigger, next, now)
                } else {
                    now
                };
                let active = Self::active_run_count_tx(&tx, &task.id)?;
                let may_enqueue =
                    run_misfire && (active == 0 || policy::allows_enqueue_while_active(task.execution.concurrency));
                if may_enqueue {
                    if let Ok(run) = Self::enqueue_run_tx(&tx, task, TaskRunTrigger::Scheduled, 1, last_fire) {
                        enqueued.push(run);
                    }
                } else if task.execution.misfire == TaskMisfirePolicy::Skip {
                    // ADR §2.5: `skip` drops the missed fire but records a
                    // skipped run so the decision stays traceable.
                    let mut run = TaskRun::new(&task.id, TaskRunTrigger::Scheduled, 1, now);
                    run.status = TaskRunStatus::Skipped;
                    run.completed_at = Some(rfc3339(now));
                    run.error_message = Some(format!("Skipped by misfire policy ({missed} missed fires)"));
                    let job = RunJob { run, task: task.clone(), cancel_requested: false };
                    Self::insert_run(&tx, &job, TaskRunStatus::Skipped)?;
                }
                // Persist schedule advancement atomically with the queue entry.
                match task.trigger.next_after(now) {
                    Ok(Some(next)) => task.next_run_at = Some(rfc3339(next)),
                    // `once` fires at most once: clear the schedule, keep the task.
                    _ => task.next_run_at = None,
                }
                Self::write_task(&tx, task)?;
            }
            tx.commit()?;
            Ok(enqueued)
        })
        .await
    }

    /// Atomically claims the oldest available queued run (ADR §3.3): one
    /// `BEGIN IMMEDIATE` transaction selects and flips `queued → starting`.
    /// Runs whose backoff has not elapsed (`created_at > now`) and runs whose
    /// task still has an active run under `forbid`/`queue` are skipped.
    pub async fn claim(&self, worker_id: String, now: DateTime<Utc>) -> Result<Option<RunJob>, TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut statement = tx
                .prepare("SELECT payload_json FROM task_runs WHERE status='queued' AND created_at <= ? ORDER BY created_at, id")
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let candidates: Vec<RunJob> = statement
                .query_map([rfc3339(now)], Self::read_run_job)
                .map_err(|error| TaskError::unavailable(error.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            drop(statement);
            for mut job in candidates {
                let concurrency = job.task.execution.concurrency;
                if matches!(concurrency, TaskConcurrencyPolicy::Forbid | TaskConcurrencyPolicy::Queue) {
                    let active = Self::active_run_count_tx(&tx, &job.task.id)?;
                    if active > 0 {
                        continue;
                    }
                }
                // Keep the payload snapshot in sync with the columns so
                // recovery and consumers see the claimed status.
                job.run.status = TaskRunStatus::Starting;
                job.run.worker_id = Some(worker_id.clone());
                tx.execute(
                    "UPDATE task_runs SET status='starting', worker_id=?, payload_json=? WHERE id=? AND status='queued'",
                    params![worker_id, encode(&job)?, job.run.id],
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
                if tx.changes() == 0 {
                    continue;
                }
                tx.commit()?;
                return Ok(Some(job));
            }
            tx.commit()?;
            Ok(None)
        })
        .await
    }

    /// Dispatch invariant (ADR §3.3): the run must be `running` *before* the
    /// executor is invoked, so a `starting` run always means "executor never
    /// started" and recovery can safely requeue it.
    pub async fn mark_run_started(&self, run_id: String, worker_id: String) -> Result<(), TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let payload: String = tx
                .query_row("SELECT payload_json FROM task_runs WHERE id=?", [&run_id], |row| row.get(0))
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?
                .ok_or_else(|| TaskError::new(super::TaskErrorKind::NonRetryable, "run_not_found", "Run not found"))?;
            let mut job: RunJob = decode(&payload)?;
            // Dispatch invariant (ADR §3.3): running must be visible in the
            // columns AND the payload before the executor is invoked.
            job.run.status = TaskRunStatus::Running;
            job.run.started_at = Some(rfc3339(Utc::now()));
            job.run.worker_id = Some(worker_id.clone());
            tx.execute(
                "UPDATE task_runs SET status='running', started_at=COALESCE(started_at, ?), worker_id=?, payload_json=? WHERE id=? AND status='starting'",
                params![rfc3339(Utc::now()), worker_id, encode(&job)?, run_id],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn update_run_progress(&self, run_id: &str, percent: Option<f64>) -> Result<(), TaskError> {
        let run_id = run_id.to_owned();
        self.access(move |conn| {
            conn.execute(
                "UPDATE task_runs SET progress_percent=? WHERE id=? AND status IN ('starting','running')",
                params![percent, run_id],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    pub async fn get_run(&self, run_id: String) -> Result<TaskRun, TaskError> {
        self.access(move |conn| {
            conn.query_row(&format!("{} WHERE id=?", Self::RUN_SELECT), [run_id], |row| Ok(Self::run_from_row(row)?))
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?
                .ok_or_else(|| TaskError::new(super::TaskErrorKind::NonRetryable, "run_not_found", "Run not found"))
        })
        .await
    }

    pub async fn list_runs(&self, task_id: Option<String>, limit: u32) -> Result<Vec<TaskRun>, TaskError> {
        self.access(move |conn| {
            let (sql, bind): (String, Vec<String>) = match &task_id {
                Some(id) => (
                    format!("{} WHERE task_id=? ORDER BY created_at DESC, id DESC LIMIT ?", Self::RUN_SELECT),
                    vec![id.clone(), limit.to_string()],
                ),
                None => {
                    (format!("{} ORDER BY created_at DESC, id DESC LIMIT ?", Self::RUN_SELECT), vec![limit.to_string()])
                }
            };
            let mut statement = conn.prepare(&sql).map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(bind.iter()), |row| Ok(Self::run_from_row(row)?))
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    pub async fn active_runs_for_task(&self, task_id: String) -> Result<Vec<TaskRun>, TaskError> {
        self.access(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "{} WHERE task_runs.task_id=? AND task_runs.status IN ('queued','starting','running') ORDER BY created_at",
                    Self::RUN_SELECT
                ))
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows = statement
                .query_map([&task_id], |row| Ok(Self::run_from_row(row)?))
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    /// Cancel semantics (ADR §2.6): a queued run is cancelled directly; a
    /// starting/running run gets its cancel flag flipped — the engine polls
    /// the flag, cancels the cancellation token and the executor stops for
    /// real before the run is finished as `cancelled`.
    pub async fn request_cancel(&self, run_id: String) -> Result<bool, TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (status, payload): (String, String) = tx
                .query_row("SELECT status, payload_json FROM task_runs WHERE id=?", [&run_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?
                .ok_or_else(|| TaskError::new(super::TaskErrorKind::NonRetryable, "run_not_found", "Run not found"))?;
            let mut job: RunJob = decode(&payload)?;
            let accepted = match status.as_str() {
                "queued" => {
                    job.run.status = TaskRunStatus::Cancelled;
                    job.run.completed_at = Some(rfc3339(Utc::now()));
                    tx.execute(
                        "UPDATE task_runs SET status='cancelled', completed_at=?, error_code='cancelled', payload_json=? WHERE id=? AND status='queued'",
                        params![job.run.completed_at, encode(&job)?, run_id],
                    )
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                    true
                }
                "starting" | "running" => {
                    job.cancel_requested = true;
                    tx.execute("UPDATE task_runs SET payload_json=? WHERE id=?", params![encode(&job)?, run_id])
                        .map_err(|error| TaskError::unavailable(error.to_string()))?;
                    true
                }
                _ => false,
            };
            tx.commit()?;
            Ok(accepted)
        })
        .await
    }

    pub async fn is_cancel_requested(&self, run_id: String) -> Result<bool, TaskError> {
        self.access(move |conn| {
            let payload: Option<String> = conn
                .query_row("SELECT payload_json FROM task_runs WHERE id=?", [run_id], |row| row.get(0))
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(payload.and_then(|payload| decode::<RunJob>(&payload).ok()).map_or(false, |job| job.cancel_requested))
        })
        .await
    }

    /// Persists the final state of a run. Idempotent: finishing an already
    /// terminal run returns the stored row unchanged. Also records the last
    /// run status on the task definition.
    pub async fn finish_run(
        &self,
        run_id: String,
        status: TaskRunStatus,
        exit_code: Option<i32>,
        error_code: Option<String>,
        error_message: Option<String>,
    ) -> Result<TaskRun, TaskError> {
        debug_assert!(status.is_terminal(), "finish_run requires a terminal status");
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut job: RunJob = tx
                .query_row("SELECT payload_json FROM task_runs WHERE id=?", [&run_id], Self::read_run_job)
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?
                .ok_or_else(|| TaskError::new(super::TaskErrorKind::NonRetryable, "run_not_found", "Run not found"))?;
            if job.run.status.is_terminal() {
                tx.commit()?;
                return Ok(job.run);
            }
            let completed_at = rfc3339(Utc::now());
            job.run.status = status;
            job.run.completed_at = Some(completed_at.clone());
            job.run.exit_code = exit_code;
            job.run.error_code = error_code;
            job.run.error_message = error_message;
            let artifacts_count: i64 = tx
                .query_row("SELECT COUNT(*) FROM task_artifacts WHERE run_id=?", [&run_id], |row| row.get(0))
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            job.run.artifacts_count = artifacts_count as u32;
            // `artifacts_count` is derived (RUN_SELECT), never a stored column.
            tx.execute(
                "UPDATE task_runs SET status=?, completed_at=?, exit_code=?, error_code=?, error_message=?, payload_json=? WHERE id=?",
                params![
                    status.as_str(),
                    completed_at,
                    job.run.exit_code,
                    job.run.error_code,
                    job.run.error_message,
                    encode(&job)?,
                    run_id
                ],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            if !matches!(status, TaskRunStatus::Skipped) {
                tx.execute(
                    "UPDATE task_definitions SET last_run_at=?, last_run_status=? WHERE id=?",
                    params![completed_at, status.as_str(), job.run.task_id],
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            }
            tx.commit()?;
            Ok(job.run)
        })
        .await
    }

    /// Cancels every queued run (engine shutdown). Dispatched runs are
    /// finalized by their dispatch tasks; queued ones never started, so
    /// cancelling them directly leaves nothing permanently stuck (ADR §1.10).
    pub async fn cancel_queued_runs(&self) -> Result<usize, TaskError> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let rows: Vec<RunJob> = {
                let mut statement = tx
                    .prepare("SELECT payload_json FROM task_runs WHERE status='queued'")
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                let mapped = statement
                    .query_map([], Self::read_run_job)
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                mapped.collect::<Result<Vec<_>, _>>().map_err(|error| TaskError::unavailable(error.to_string()))?
            };
            let count = rows.len();
            for mut job in rows {
                job.run.status = TaskRunStatus::Cancelled;
                job.run.completed_at = Some(rfc3339(Utc::now()));
                tx.execute(
                    "UPDATE task_runs SET status='cancelled', completed_at=?, error_code='cancelled', payload_json=? WHERE id=? AND status='queued'",
                    params![job.run.completed_at, encode(&job)?, job.run.id],
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            }
            tx.commit()?;
            Ok(count)
        })
        .await
    }

    // ------------------------------------------------------------------
    // Recovery (ADR §3.4)
    // ------------------------------------------------------------------

    /// Startup recovery. Run mode: `starting` → back to `queued` (executor
    /// never started, attempt not consumed); `running` → failed with
    /// `worker_interrupted`. Resident mode: sessions are marked crashed and
    /// reconciled/restarted by the supervisor — never failed directly.
    pub async fn recover(&self) -> Result<RecoveryReport, TaskError> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut report = RecoveryReport::default();
            let rows: Vec<(String, RunJob)> = {
                let mut statement = tx
                    .prepare("SELECT status, payload_json FROM task_runs WHERE status IN ('starting','running') ORDER BY created_at")
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                let mapped = statement
                    .query_map([], |row| {
                        let status: String = row.get::<_, String>("status")?;
                        let payload: String = row.get("payload_json")?;
                        Ok((status, payload))
                    })
                    .map_err(|error| TaskError::unavailable(error.to_string()))?;
                mapped
                    .collect::<Result<Vec<(String, String)>, _>>()
                    .map_err(|error| TaskError::unavailable(error.to_string()))?
                    .into_iter()
                    .map(|(status, payload)| Ok((status, decode::<RunJob>(&payload)?)))
                    .collect::<Result<Vec<(String, RunJob)>, TaskError>>()?
            };
            // The status column is authoritative; the payload snapshot is
            // kept in sync for consumers and future recoveries.
            for (status, mut job) in rows {
                job.run.status = decode::<TaskRunStatus>(&format!("\"{status}\""))?;
                match job.run.status {
                    TaskRunStatus::Starting => {
                        job.run.status = TaskRunStatus::Queued;
                        job.run.worker_id = None;
                        job.cancel_requested = false;
                        tx.execute(
                            "UPDATE task_runs SET status='queued', worker_id=NULL, payload_json=? WHERE id=?",
                            params![encode(&job)?, job.run.id],
                        )
                        .map_err(|error| TaskError::unavailable(error.to_string()))?;
                        report.requeued.push(job.run.id.clone());
                    }
                    TaskRunStatus::Running => {
                        let is_resident = job.task.execution.mode == TaskExecutionMode::Resident;
                        if is_resident {
                            // Supervisor reconciles; the run stays running until
                            // the session probe decides its fate.
                            tx.execute(
                                "UPDATE task_runtime_sessions SET state='crashed', updated_at=? WHERE run_id=? AND state IN ('starting','running','stopping')",
                                params![rfc3339(Utc::now()), job.run.id],
                            )
                            .map_err(|error| TaskError::unavailable(error.to_string()))?;
                            report.crashed_sessions.push(job.run.id.clone());
                        } else {
                            job.run.status = TaskRunStatus::Failed;
                            job.run.completed_at = Some(rfc3339(Utc::now()));
                            job.run.error_code = Some("worker_interrupted".into());
                            job.run.error_message = Some("Worker stopped before the run finished".into());
                            tx.execute(
                                "UPDATE task_runs SET status='failed', completed_at=?, error_code='worker_interrupted', error_message=?, payload_json=? WHERE id=?",
                                params![job.run.completed_at, job.run.error_message, encode(&job)?, job.run.id],
                            )
                            .map_err(|error| TaskError::unavailable(error.to_string()))?;
                            report.interrupted.push(job.run.id.clone());
                        }
                    }
                    _ => {}
                }
            }
            tx.commit()?;
            Ok(report)
        })
        .await
    }

    // ------------------------------------------------------------------
    // Leases (ADR §3.4)
    // ------------------------------------------------------------------

    pub async fn acquire_lease(
        &self,
        name: String,
        worker_id: String,
        ttl: std::time::Duration,
    ) -> Result<bool, TaskError> {
        let until =
            rfc3339(Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_else(|_| chrono::Duration::seconds(30)));
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let row: Option<(String, String)> = tx
                .query_row("SELECT worker_id, lease_until FROM scheduler_leases WHERE name=?", [&name], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let acquired = match row {
                None => true,
                Some((owner, lease_until)) => {
                    parse_time(&lease_until).map(|until| until < Utc::now()).unwrap_or(true) || owner == worker_id
                }
            };
            if acquired {
                tx.execute(
                    "INSERT INTO scheduler_leases(name,worker_id,lease_until,heartbeat_at) VALUES(?,?,?,?)
                     ON CONFLICT(name) DO UPDATE SET worker_id=excluded.worker_id, lease_until=excluded.lease_until, heartbeat_at=excluded.heartbeat_at",
                    params![name, worker_id, until, rfc3339(Utc::now())],
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            }
            tx.commit()?;
            Ok(acquired)
        })
        .await
    }

    pub async fn heartbeat_lease(
        &self,
        name: String,
        worker_id: String,
        ttl: std::time::Duration,
    ) -> Result<bool, TaskError> {
        let until =
            rfc3339(Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_else(|_| chrono::Duration::seconds(30)));
        self.access(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE scheduler_leases SET lease_until=?, heartbeat_at=? WHERE name=? AND worker_id=?",
                    params![until, rfc3339(Utc::now()), name, worker_id],
                )
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(changed > 0)
        })
        .await
    }

    pub async fn release_lease(&self, name: String, worker_id: String) -> Result<(), TaskError> {
        self.access(move |conn| {
            conn.execute("DELETE FROM scheduler_leases WHERE name=? AND worker_id=?", params![name, worker_id])
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    // ------------------------------------------------------------------
    // Resident sessions
    // ------------------------------------------------------------------

    pub async fn upsert_session(&self, session: ResidentSession) -> Result<(), TaskError> {
        self.access(move |conn| {
            conn.execute(
                "INSERT INTO task_runtime_sessions(id,task_id,run_id,plugin_id,session_id,state,heartbeat_at,restart_count,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, session_id=excluded.session_id, state=excluded.state,
                   heartbeat_at=excluded.heartbeat_at, restart_count=excluded.restart_count, updated_at=excluded.updated_at",
                params![
                    session.id,
                    session.task_id,
                    session.run_id,
                    session.plugin_id,
                    session.session_id,
                    session.state.as_str(),
                    session.heartbeat_at,
                    session.restart_count,
                    session.created_at,
                    session.updated_at,
                ],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    /// The non-stopped session row of a task, if any. Resident restarts reuse
    /// the row so `restart_count` and the restart window survive restarts.
    pub async fn active_session_for_task(&self, task_id: String) -> Result<Option<ResidentSession>, TaskError> {
        self.access(move |conn| {
            let mut statement = conn
                .prepare("SELECT * FROM task_runtime_sessions WHERE task_id=? AND state != 'stopped' ORDER BY created_at DESC LIMIT 1")
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let mut rows = statement
                .query_map([&task_id], |row| {
                    let state: String = row.get("state")?;
                    Ok(ResidentSession {
                        id: row.get("id")?,
                        task_id: row.get("task_id")?,
                        run_id: row.get("run_id")?,
                        plugin_id: row.get("plugin_id")?,
                        session_id: row.get("session_id")?,
                        state: serde_json::from_str(&format!("\"{state}\"")).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
                        })?,
                        heartbeat_at: row.get("heartbeat_at")?,
                        restart_count: row.get("restart_count")?,
                        created_at: row.get("created_at")?,
                        updated_at: row.get("updated_at")?,
                    })
                })
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.next().transpose().map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    pub async fn list_sessions(&self) -> Result<Vec<ResidentSession>, TaskError> {
        self.access(|conn| {
            let mut statement = conn
                .prepare("SELECT * FROM task_runtime_sessions ORDER BY created_at, id")
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows = statement
                .query_map([], |row| {
                    let state: String = row.get("state")?;
                    Ok(ResidentSession {
                        id: row.get("id")?,
                        task_id: row.get("task_id")?,
                        run_id: row.get("run_id")?,
                        plugin_id: row.get("plugin_id")?,
                        session_id: row.get("session_id")?,
                        state: serde_json::from_str(&format!("\"{state}\"")).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
                        })?,
                        heartbeat_at: row.get("heartbeat_at")?,
                        restart_count: row.get("restart_count")?,
                        created_at: row.get("created_at")?,
                        updated_at: row.get("updated_at")?,
                    })
                })
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    pub async fn update_session_state(
        &self,
        session_id: String,
        state: ResidentState,
        restart_count: u32,
    ) -> Result<(), TaskError> {
        self.access(move |conn| {
            conn.execute(
                "UPDATE task_runtime_sessions SET state=?, restart_count=?, updated_at=? WHERE id=?",
                params![state.as_str(), restart_count, rfc3339(Utc::now()), session_id],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    pub async fn delete_session(&self, session_id: String) -> Result<(), TaskError> {
        self.access(move |conn| {
            conn.execute("DELETE FROM task_runtime_sessions WHERE id=?", [session_id])
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    // ------------------------------------------------------------------
    // Artifacts
    // ------------------------------------------------------------------

    pub async fn save_artifact(&self, run_id: String, artifact: TaskArtifact) -> Result<TaskArtifact, TaskError> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let created_at = rfc3339(Utc::now());
            tx.execute(
                "INSERT INTO task_artifacts(id,run_id,name,uri,content_type,size,checksum,created_at) VALUES(?,?,?,?,?,?,?,?)",
                params![
                    uuid::Uuid::new_v4().simple().to_string(),
                    run_id,
                    artifact.name,
                    artifact.uri,
                    artifact.content_type,
                    artifact.size.map(|size| size as i64),
                    artifact.checksum,
                    created_at,
                ],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            // `artifacts_count` is derived via RUN_SELECT; nothing to denormalize.
            tx.commit()?;
            Ok(artifact)
        })
        .await
    }

    pub async fn list_artifacts(&self, run_id: String) -> Result<Vec<TaskArtifact>, TaskError> {
        self.access(move |conn| {
            let mut statement = conn
                .prepare("SELECT name,uri,content_type,size,checksum FROM task_artifacts WHERE run_id=? ORDER BY created_at, id")
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows = statement
                .query_map([&run_id], |row| {
                    Ok(TaskArtifact {
                        name: row.get(0)?,
                        uri: row.get(1)?,
                        content_type: row.get(2)?,
                        size: row.get::<_, Option<i64>>(3)?.map(|size| size.max(0) as u64),
                        checksum: row.get(4)?,
                    })
                })
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    // ------------------------------------------------------------------
    // Logs
    // ------------------------------------------------------------------

    /// Upserts one `(run_id, segment)` index row (ADR §14 D4).
    pub async fn upsert_log_index(
        &self,
        run_id: String,
        segment: u32,
        path: PathBuf,
        byte_size: u64,
        line_count: u64,
    ) -> Result<(), TaskError> {
        self.access(move |conn| {
            let now = rfc3339(Utc::now());
            conn.execute(
                "INSERT INTO task_log_index(run_id,segment,path,byte_size,line_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
                 ON CONFLICT(run_id,segment) DO UPDATE SET path=excluded.path, byte_size=excluded.byte_size,
                   line_count=excluded.line_count, updated_at=excluded.updated_at",
                params![run_id, segment, path.to_string_lossy(), byte_size, line_count, now, now],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    pub async fn log_segments(&self, run_id: String) -> Result<Vec<(u32, PathBuf)>, TaskError> {
        self.access(move |conn| {
            let mut statement = conn
                .prepare("SELECT segment, path FROM task_log_index WHERE run_id=? ORDER BY segment")
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows = statement
                .query_map([&run_id], |row| Ok((row.get::<_, i64>(0)? as u32, PathBuf::from(row.get::<_, String>(1)?))))
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    /// Reads a run's logs. The run directory is resolved from the log index;
    /// runs without any index row report an empty, complete page.
    pub async fn list_logs(&self, run_id: String, query: TaskLogQuery) -> Result<TaskLogPage, TaskError> {
        let directory = self
            .log_segments(run_id.clone())
            .await?
            .into_iter()
            .next()
            .map(|(_, path)| path.ancestors().nth(1).map(Path::to_path_buf).unwrap_or_else(|| self.logs_root()));
        match directory {
            Some(directory) => Ok(logs::read_run_logs(&directory, &query)?),
            None => Ok(TaskLogPage { entries: Vec::new(), next_seq: query.after_seq.unwrap_or(0), eof: true }),
        }
    }

    // ------------------------------------------------------------------
    // Audit
    // ------------------------------------------------------------------

    pub async fn append_audit(&self, entry: TaskAuditEntry) -> Result<(), TaskError> {
        self.access(move |conn| {
            conn.execute(
                "INSERT INTO task_audit(id,task_id,action,actor_type,actor_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)",
                params![
                    entry.id,
                    entry.task_id,
                    serde_json::to_string(&entry.action).map_err(|error| TaskError::internal(error.to_string()))?,
                    entry.actor_type,
                    entry.actor_id,
                    encode(&entry.metadata)?,
                    entry.created_at,
                ],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            Ok(())
        })
        .await
    }

    pub async fn list_audit(&self, task_id: Option<String>, limit: u32) -> Result<Vec<TaskAuditEntry>, TaskError> {
        self.access(move |conn| {
            let (sql, bind): (&str, Vec<String>) = match &task_id {
                Some(id) => (
                    "SELECT id,task_id,action,actor_type,actor_id,metadata_json,created_at FROM task_audit WHERE task_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
                    vec![id.clone(), limit.to_string()],
                ),
                None => (
                    "SELECT id,task_id,action,actor_type,actor_id,metadata_json,created_at FROM task_audit ORDER BY created_at DESC, id DESC LIMIT ?",
                    vec![limit.to_string()],
                ),
            };
            let mut statement = conn.prepare(sql).map_err(|error| TaskError::unavailable(error.to_string()))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(bind.iter()), |row| {
                    let action: String = row.get(2)?;
                    Ok(TaskAuditEntry {
                        id: row.get(0)?,
                        task_id: row.get(1)?,
                        action: serde_json::from_str(&action).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
                        })?,
                        actor_type: row.get(3)?,
                        actor_id: row.get(4)?,
                        metadata: decode_unchecked(&row.get::<_, String>(5)?),
                        created_at: row.get(6)?,
                    })
                })
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    // ------------------------------------------------------------------
    // Migration helper
    // ------------------------------------------------------------------

    /// Whether the migration marker `key` exists (see `run_migration`).
    pub async fn has_migration_marker(&self, key: String) -> Result<bool, TaskError> {
        let marker = format!("{MIGRATION_MARKER_PREFIX}{key}");
        self.access(move |conn| {
            conn.query_row("SELECT EXISTS(SELECT 1 FROM scheduler_leases WHERE name=?)", [marker], |row| row.get(0))
                .map_err(|error| TaskError::unavailable(error.to_string()))
        })
        .await
    }

    /// Runs an idempotent, atomic, restart-safe migration (ADR §8.3): inside
    /// a single `BEGIN IMMEDIATE` transaction the marker is checked, `apply`
    /// runs, and only on success is the marker written and committed. Any
    /// failure rolls everything back and the migration can be retried.
    /// Returns whether the migration body ran (`false` = already applied).
    ///
    /// The marker reuses `scheduler_leases` (`migration/<key>`, far-future
    /// expiry) so the seven-table schema stays frozen.
    pub async fn run_migration(
        &self,
        key: &str,
        apply: impl FnOnce(&Connection) -> Result<(), TaskError> + Send + 'static,
    ) -> Result<bool, TaskError> {
        let marker = format!("{MIGRATION_MARKER_PREFIX}{key}");
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let applied: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM scheduler_leases WHERE name=?)", [&marker], |row| row.get(0))
                .map_err(|error| TaskError::unavailable(error.to_string()))?;
            if applied {
                return Ok(false);
            }
            apply(&tx)?;
            tx.execute(
                "INSERT INTO scheduler_leases(name,worker_id,lease_until,heartbeat_at) VALUES(?,?,?,?)",
                params![marker, "applied", "9999-12-31T23:59:59+00:00", rfc3339(Utc::now())],
            )
            .map_err(|error| TaskError::unavailable(error.to_string()))?;
            tx.commit()?;
            Ok(true)
        })
        .await
    }
}

fn decode_unchecked<T: DeserializeOwned>(value: &str) -> T {
    serde_json::from_str(value).expect("stored scheduler JSON must be valid")
}

/// Next UTC fire time of a schedule trigger, persisted on save. Manual and
/// startup triggers never carry a schedule.
pub(crate) fn schedule_next(trigger: &TaskTrigger, after: DateTime<Utc>) -> Result<Option<String>, TaskError> {
    Ok(trigger.next_after(after)?.map(rfc3339))
}

/// Last scheduled fire instant at or before `now`, for `fire-once` misfire
/// runs (their created_at carries the original scheduled time).
fn last_fire_before(trigger: &TaskTrigger, next: DateTime<Utc>, now: DateTime<Utc>) -> DateTime<Utc> {
    let mut cursor = next;
    let mut last = next;
    while cursor <= now {
        last = cursor;
        match trigger.next_after(cursor) {
            Ok(Some(following)) => cursor = following,
            _ => break,
        }
    }
    last
}
