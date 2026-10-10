use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::models::*;

#[derive(Clone)]
pub struct BackupStore {
    pub(crate) directory: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    pub schedules: Vec<BackupSchedule>,
    pub runs: Vec<BackupRun>,
    pub migrated: bool,
    pub heartbeat: Option<String>,
}

fn encode(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn decode<T: DeserializeOwned>(value: String) -> Result<T, String> {
    serde_json::from_str(&value).map_err(|e| e.to_string())
}
fn sql_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn schedules(conn: &Connection) -> Result<Vec<BackupSchedule>, String> {
    let mut statement = conn.prepare("SELECT payload FROM schedules ORDER BY id").map_err(sql_error)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(sql_error)?;
    rows.map(|row| decode(row.map_err(sql_error)?)).collect()
}

fn run_rows(conn: &Connection) -> Result<Vec<BackupRun>, String> {
    let mut statement =
        conn.prepare("SELECT payload FROM runs ORDER BY created_at DESC, id DESC").map_err(sql_error)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(sql_error)?;
    rows.map(|row| decode(row.map_err(sql_error)?)).collect()
}

fn active(conn: &Connection, schedule_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE schedule_id=? AND state IN ('queued','running'))",
        [schedule_id],
        |r| r.get(0),
    )
    .map_err(sql_error)
}

fn insert_job(
    conn: &Connection,
    config: BackupConfig,
    schedule: Option<&BackupSchedule>,
    name: String,
    trigger: &str,
    time_zone: Option<String>,
) -> Result<BackupRun, String> {
    let count: usize = conn
        .query_row("SELECT COUNT(*) FROM runs WHERE state IN ('queued','running')", [], |r| r.get(0))
        .map_err(sql_error)?;
    if count >= 100 {
        return Err("Too many pending backups".into());
    }
    let run = BackupRun {
        id: uuid::Uuid::new_v4().simple().to_string(),
        schedule_id: schedule.map(|s| s.id.clone()),
        schedule_name: name,
        display_name: None,
        connection_id: config.connection_id.clone(),
        connection_name: String::new(),
        destination_directory: config.destination_directory.clone(),
        trigger: trigger.into(),
        source: if schedule.is_some() { "scheduled" } else { "one-shot" }.into(),
        status: "running".into(),
        started_at: Utc::now().to_rfc3339(),
        completed_at: None,
        files: Vec::new(),
        progress_percent: 0.0,
        error: None,
    };
    let time_zone = schedule.map(|s| s.time_zone.clone()).or(time_zone).unwrap_or_else(|| "UTC".into());
    time_zone.parse::<chrono_tz::Tz>().map_err(|_| "Invalid backup time zone")?;
    let job = Job {
        run: run.clone(),
        config,
        directory_pattern: schedule
            .map(|s| s.run_directory_pattern.clone().unwrap_or_else(|| DEFAULT_DIRECTORY.into())),
        time_zone,
    };
    conn.execute(
        "INSERT INTO runs(id,schedule_id,state,payload,job,created_at) VALUES(?,?,'queued',?,?,?)",
        params![run.id, run.schedule_id, encode(&run)?, encode(&job)?, run.started_at],
    )
    .map_err(sql_error)?;
    Ok(run)
}

impl BackupStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { directory: data_dir.join("database-backups") }
    }

    async fn access<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let dir = self.directory.clone();
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut conn = Connection::open(dir.join("state.db")).map_err(sql_error)?;
            conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(sql_error)?;
            conn.execute_batch("PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,schedule_id TEXT,state TEXT NOT NULL,payload TEXT NOT NULL,job TEXT,created_at TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS runs_pending ON runs(state,created_at);
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(sql_error)?;
            action(&mut conn)
        }).await.map_err(|e| e.to_string())?
    }

    pub async fn snapshot(&self) -> Result<BackupSnapshot, String> {
        self.access(|conn| {
            let tx = conn.transaction().map_err(sql_error)?;
            Ok(BackupSnapshot {
                schedules: schedules(&tx)?,
                runs: run_rows(&tx)?,
                migrated: tx
                    .query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key='migrated')", [], |r| r.get(0))
                    .map_err(sql_error)?,
                heartbeat: tx
                    .query_row("SELECT value FROM metadata WHERE key='heartbeat'", [], |r| r.get(0))
                    .optional()
                    .map_err(sql_error)?,
            })
        })
        .await
    }

    pub async fn save_schedule(&self, mut value: BackupSchedule) -> Result<BackupSchedule, String> {
        value.validate()?;
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            if active(&tx, &value.id)? {
                return Err("Cannot edit a running backup schedule".into());
            }
            let old: Option<String> = tx
                .query_row("SELECT payload FROM schedules WHERE id=?", [&value.id], |r| r.get(0))
                .optional()
                .map_err(sql_error)?;
            let now = Utc::now();
            let mut timing_changed = true;
            if let Some(old) = old {
                let old: BackupSchedule = decode(old)?;
                if old.updated_at != value.updated_at {
                    return Err("Backup schedule changed; reload before saving".into());
                }
                timing_changed = old.frequency != value.frequency
                    || old.interval_hours != value.interval_hours
                    || old.time_of_day != value.time_of_day
                    || old.weekday != value.weekday
                    || old.time_zone != value.time_zone
                    || (!old.enabled && value.enabled);
                value.created_at = old.created_at;
                value.last_run_at = old.last_run_at;
                value.last_run_status = old.last_run_status;
                value.next_run_at = old.next_run_at;
            } else {
                value.created_at = now.to_rfc3339();
                value.last_run_at = None;
                value.last_run_status = None;
            }
            if timing_changed {
                value.next_run_at = value.next_after(now)?.to_rfc3339();
            }
            value.updated_at = now.to_rfc3339();
            tx.execute(
                "INSERT INTO schedules(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                params![value.id, encode(&value)?],
            )
            .map_err(sql_error)?;
            tx.commit().map_err(sql_error)?;
            Ok(value)
        })
        .await
    }

    pub async fn delete_schedule(&self, id: String) -> Result<(), String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            if active(&tx, &id)? {
                return Err("Cannot delete a running backup schedule".into());
            }
            tx.execute("DELETE FROM schedules WHERE id=?", [id]).map_err(sql_error)?;
            tx.commit().map_err(sql_error)
        })
        .await
    }

    pub async fn migrate(&self, migration: Migration) -> Result<(), String> {
        if migration.schedules.len() > 1000 || migration.runs.len() > 10_000 {
            return Err("Backup migration is too large".into());
        }
        for schedule in &migration.schedules {
            schedule.validate()?;
        }
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let done: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM metadata WHERE key='migrated')", [], |r| r.get(0))
                .map_err(sql_error)?;
            if done {
                return Ok(());
            }
            for mut schedule in migration.schedules {
                if chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at).is_err() {
                    schedule.next_run_at = schedule.next_after(Utc::now())?.to_rfc3339();
                }
                tx.execute(
                    "INSERT OR IGNORE INTO schedules(id,payload) VALUES(?,?)",
                    params![schedule.id, encode(&schedule)?],
                )
                .map_err(sql_error)?;
            }
            for mut run in migration.runs {
                if run.status == "running" {
                    run.status = "failed".into();
                    run.error = Some("Backup interrupted before migration".into());
                    run.completed_at = Some(Utc::now().to_rfc3339());
                }
                if !matches!(run.status.as_str(), "success" | "failed" | "cancelled") {
                    return Err("Invalid migrated backup status".into());
                }
                tx.execute(
                    "INSERT OR IGNORE INTO runs(id,schedule_id,state,payload,created_at) VALUES(?,?,?,?,?)",
                    params![run.id, run.schedule_id, run.status, encode(&run)?, run.started_at],
                )
                .map_err(sql_error)?;
            }
            tx.execute("INSERT INTO metadata(key,value) VALUES('migrated','1')", []).map_err(sql_error)?;
            tx.commit().map_err(sql_error)
        })
        .await
    }

    pub async fn enqueue(&self, request: RunRequest) -> Result<BackupRun, String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let run = if let Some(id) = request.schedule_id {
                if active(&tx, &id)? {
                    return Err("Backup schedule is already running".into());
                }
                let value: String =
                    tx.query_row("SELECT payload FROM schedules WHERE id=?", [&id], |r| r.get(0)).map_err(sql_error)?;
                let schedule: BackupSchedule = decode(value)?;
                insert_job(&tx, schedule.config.clone(), Some(&schedule), schedule.name.clone(), "manual", None)?
            } else {
                let config = request.config.ok_or("Backup configuration is required")?;
                config.validate()?;
                let name = request.display_name.unwrap_or_else(|| "Database backup".into());
                bounded_text(&name, 256, "Backup name")?;
                insert_job(&tx, config, None, name, "manual", request.time_zone)?
            };
            tx.commit().map_err(sql_error)?;
            Ok(run)
        })
        .await
    }

    pub(crate) async fn enqueue_due(&self) -> Result<(), String> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let now = Utc::now();
            for mut schedule in schedules(&tx)? {
                if !schedule.enabled {
                    continue;
                }
                let pending: usize = tx
                    .query_row("SELECT COUNT(*) FROM runs WHERE state IN ('queued','running')", [], |r| r.get(0))
                    .map_err(sql_error)?;
                if pending >= 100 {
                    break;
                }
                let due = chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at)
                    .map_err(|_| "Invalid persisted backup time")?
                    .with_timezone(&Utc)
                    <= now;
                if !schedule.enabled || !due || active(&tx, &schedule.id)? {
                    continue;
                }
                insert_job(&tx, schedule.config.clone(), Some(&schedule), schedule.name.clone(), "scheduled", None)?;
                // Persist advancement together with the queue entry; a crash cannot replay every missed interval.
                schedule.next_run_at = schedule.next_after(now)?.to_rfc3339();
                tx.execute("UPDATE schedules SET payload=? WHERE id=?", params![encode(&schedule)?, schedule.id])
                    .map_err(sql_error)?;
            }
            tx.commit().map_err(sql_error)
        })
        .await
    }

    pub(crate) async fn claim(&self) -> Result<Option<Job>, String> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let payload: Option<String> = tx
                .query_row("SELECT job FROM runs WHERE state='queued' ORDER BY created_at,id LIMIT 1", [], |r| r.get(0))
                .optional()
                .map_err(sql_error)?;
            let job: Option<Job> = payload.map(decode).transpose()?;
            if let Some(job) = &job {
                tx.execute("UPDATE runs SET state='running' WHERE id=?", [&job.run.id]).map_err(sql_error)?;
            }
            tx.commit().map_err(sql_error)?;
            Ok(job)
        })
        .await
    }

    pub async fn cancel(&self, id: String) -> Result<bool, String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let queued: Option<String> = tx
                .query_row("SELECT payload FROM runs WHERE id=? AND state='queued'", [&id], |r| r.get(0))
                .optional()
                .map_err(sql_error)?;
            let accepted = if let Some(payload) = queued {
                let mut run: BackupRun = decode(payload)?;
                run.status = "cancelled".into();
                run.completed_at = Some(Utc::now().to_rfc3339());
                tx.execute(
                    "UPDATE runs SET state='cancelled',cancel=1,job=NULL,payload=? WHERE id=?",
                    params![encode(&run)?, id],
                )
                .map_err(sql_error)?
                    > 0
            } else {
                tx.execute("UPDATE runs SET cancel=1 WHERE id=? AND state='running'", [&id]).map_err(sql_error)? > 0
            };
            tx.commit().map_err(sql_error)?;
            Ok(accepted)
        })
        .await
    }

    pub(crate) async fn cancelled(&self, id: String) -> Result<bool, String> {
        self.access(move |conn| {
            conn.query_row("SELECT cancel FROM runs WHERE id=?", [id], |r| r.get(0)).map_err(sql_error)
        })
        .await
    }

    pub(crate) async fn progress(&self, run: BackupRun) -> Result<(), String> {
        self.access(move |conn| {
            conn.execute("UPDATE runs SET payload=? WHERE id=? AND state='running'", params![encode(&run)?, run.id])
                .map_err(sql_error)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn finish(&self, run: BackupRun) -> Result<(), String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            tx.execute(
                "UPDATE runs SET state=?,payload=?,job=NULL WHERE id=?",
                params![run.status, encode(&run)?, run.id],
            )
            .map_err(sql_error)?;
            if let Some(id) = &run.schedule_id {
                let payload: Option<String> = tx
                    .query_row("SELECT payload FROM schedules WHERE id=?", [id], |r| r.get(0))
                    .optional()
                    .map_err(sql_error)?;
                if let Some(payload) = payload {
                    let mut schedule: BackupSchedule = decode(payload)?;
                    schedule.last_run_at = run.completed_at.clone();
                    schedule.last_run_status = Some(run.status.clone());
                    let now = Utc::now();
                    if chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at)
                        .is_ok_and(|t| t.with_timezone(&Utc) <= now)
                    {
                        schedule.next_run_at = schedule.next_after(now)?.to_rfc3339();
                    }
                    tx.execute("UPDATE schedules SET payload=? WHERE id=?", params![encode(&schedule)?, id])
                        .map_err(sql_error)?;
                }
            }
            tx.commit().map_err(sql_error)
        })
        .await
    }

    pub async fn rename(&self, id: String, name: String) -> Result<(), String> {
        bounded_text(&name, 256, "Backup name")?;
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let payload: String = tx
                .query_row(
                    "SELECT payload FROM runs WHERE id=? AND state IN ('success','failed','cancelled')",
                    [&id],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            let mut run: BackupRun = decode(payload)?;
            run.display_name = Some(name);
            tx.execute("UPDATE runs SET payload=? WHERE id=?", params![encode(&run)?, id]).map_err(sql_error)?;
            tx.commit().map_err(sql_error)
        })
        .await
    }

    pub(crate) async fn mark_deleting(&self, ids: Vec<String>) -> Result<Vec<BackupRun>, String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            let mut runs = Vec::new();
            for id in ids {
                let payload: String = tx
                    .query_row(
                        "SELECT payload FROM runs WHERE id=? AND state IN ('success','failed','cancelled','deleting')",
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(sql_error)?;
                runs.push(decode(payload)?);
                tx.execute("UPDATE runs SET state='deleting' WHERE id=?", [id]).map_err(sql_error)?;
            }
            tx.commit().map_err(sql_error)?;
            Ok(runs)
        })
        .await
    }

    pub(crate) async fn remove_run(&self, id: String) -> Result<(), String> {
        self.access(move |conn| {
            conn.execute("DELETE FROM runs WHERE id=? AND state='deleting'", [id]).map_err(sql_error)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn deletion_failed(&self, run: BackupRun) -> Result<(), String> {
        self.access(move |conn| {
            conn.execute(
                "UPDATE runs SET state=?,payload=? WHERE id=? AND state='deleting'",
                params![run.status, encode(&run)?, run.id],
            )
            .map_err(sql_error)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn heartbeat(&self) -> Result<(), String> {
        self.access(|conn| { conn.execute("INSERT INTO metadata(key,value) VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [Utc::now().to_rfc3339()]).map_err(sql_error)?; Ok(()) }).await
    }

    pub(crate) async fn recover(&self) -> Result<(), String> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql_error)?;
            for mut run in run_rows(&tx)? {
                let state: String =
                    tx.query_row("SELECT state FROM runs WHERE id=?", [&run.id], |r| r.get(0)).map_err(sql_error)?;
                if state != "running" && state != "deleting" {
                    continue;
                }
                run.status = "failed".into();
                run.error =
                    Some("Backup interrupted: the previous worker stopped. Retained files may be incomplete.".into());
                run.completed_at = Some(Utc::now().to_rfc3339());
                tx.execute(
                    "UPDATE runs SET state='failed',payload=?,job=NULL WHERE id=?",
                    params![encode(&run)?, run.id],
                )
                .map_err(sql_error)?;
            }
            tx.commit().map_err(sql_error)
        })
        .await
    }
}
