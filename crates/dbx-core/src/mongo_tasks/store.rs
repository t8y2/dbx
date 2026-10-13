use std::path::{Path, PathBuf};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use super::models::*;

#[derive(Clone)]
pub(crate) struct Store { pub directory: PathBuf }
fn err(e: rusqlite::Error) -> String { e.to_string() }
fn encode(value: &impl Serialize) -> Result<String, String> { serde_json::to_string(value).map_err(|e| e.to_string()) }
fn decode<T: DeserializeOwned>(value: String) -> Result<T, String> { serde_json::from_str(&value).map_err(|e| e.to_string()) }
fn tasks(conn: &Connection) -> Result<Vec<MongoTask>, String> {
    let mut stmt = conn.prepare("SELECT payload FROM tasks ORDER BY id").map_err(err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.map(|r| decode(r.map_err(err)?)).collect()
}
fn active(conn: &Connection, task_id: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=? AND state IN ('queued','running'))", [task_id], |r| r.get(0)).map_err(err)
}
fn persist_run(conn: &Connection, run: &MongoTaskRun) -> Result<(), String> {
    conn.execute("UPDATE runs SET state=?,payload=? WHERE id=?", params![run.status, encode(run)?, run.id]).map_err(err)?;
    conn.execute("DELETE FROM runs WHERE state NOT IN ('queued','running') AND id NOT IN (SELECT id FROM runs WHERE state NOT IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 100)", []).map_err(err)?;
    Ok(())
}
fn enqueue(conn: &Connection, task: MongoTask, trigger: &str) -> Result<MongoTaskRun, String> {
    task.validate()?;
    if active(conn, &task.id)? { return Err("Task already has a queued or running job".into()); }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM runs WHERE state IN ('queued','running')", [], |r| r.get(0)).map_err(err)?;
    if count >= 100 { return Err("At most 100 pending task runs".into()); }
    let run = MongoTaskRun { id: uuid::Uuid::new_v4().simple().to_string(), task_id: task.id.clone(), task_name: task.name.clone(), trigger: trigger.into(), status: "queued".into(), created_at: Utc::now().to_rfc3339(), completed_at: None, results: vec![], error: None };
    let job = Job { task, run: run.clone() };
    conn.execute("INSERT INTO runs(id,task_id,state,payload,job,created_at) VALUES(?,?,'queued',?,?,?)", params![run.id, run.task_id, encode(&run)?, encode(&job)?, run.created_at]).map_err(err)?;
    Ok(run)
}

impl Store {
    pub fn new(data_dir: &Path) -> Self { Self { directory: data_dir.join("mongo-tasks") } }
    async fn access<T: Send + 'static>(&self, action: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let directory = self.directory.clone();
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let mut conn = Connection::open(directory.join("state.db")).map_err(err)?;
            conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,job TEXT NOT NULL,created_at TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS pending ON runs(state,created_at);
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(err)?;
            action(&mut conn)
        }).await.map_err(|e| e.to_string())?
    }
    pub async fn snapshot(&self) -> Result<MongoTaskSnapshot, String> {
        self.access(|conn| {
            let tx = conn.transaction().map_err(err)?;
            let tasks = tasks(&tx)?;
            let mut stmt = tx.prepare("SELECT payload FROM runs ORDER BY created_at DESC,id DESC LIMIT 200").map_err(err)?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
            let runs = rows.map(|r| decode(r.map_err(err)?)).collect::<Result<Vec<MongoTaskRun>, String>>()?;
            let heartbeat = tx.query_row("SELECT value FROM metadata WHERE key='heartbeat'", [], |r| r.get(0)).optional().map_err(err)?;
            Ok(MongoTaskSnapshot { tasks, runs, heartbeat })
        }).await
    }
    pub async fn save(&self, mut task: MongoTask) -> Result<MongoTask, String> {
        task.validate()?;
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            if active(&tx, &task.id)? { return Err("Cancel or finish the active run before editing this task".into()); }
            let old: Option<String> = tx.query_row("SELECT payload FROM tasks WHERE id=?", [&task.id], |r| r.get(0)).optional().map_err(err)?;
            let mut next = None;
            if let Some(old) = old {
                let old: MongoTask = decode(old)?;
                if old.revision != task.revision { return Err("Task changed in another window; refresh before saving".into()); }
                if task.enabled && old.enabled && old.interval_minutes == task.interval_minutes { next = old.next_run_at; }
            } else {
                if !task.revision.is_empty() { return Err("Task was deleted; refresh before saving".into()); }
                let count: i64 = tx.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).map_err(err)?;
                if count >= 100 { return Err("At most 100 saved tasks".into()); }
            }
            task.next_run_at = if task.enabled { Some(next.unwrap_or_else(|| (Utc::now() + chrono::Duration::minutes(i64::from(task.interval_minutes))).to_rfc3339())) } else { None };
            task.revision = uuid::Uuid::new_v4().simple().to_string();
            tx.execute("INSERT INTO tasks(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![task.id, encode(&task)?]).map_err(err)?;
            tx.commit().map_err(err)?; Ok(task)
        }).await
    }
    pub async fn delete(&self, id: String, revision: String) -> Result<(), String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            if active(&tx, &id)? { return Err("Cancel or finish the active run before deleting this task".into()); }
            let value: String = tx.query_row("SELECT payload FROM tasks WHERE id=?", [&id], |r| r.get(0)).map_err(err)?;
            if decode::<MongoTask>(value)?.revision != revision { return Err("Task changed; refresh before deleting".into()); }
            tx.execute("DELETE FROM tasks WHERE id=?", [id]).map_err(err)?; tx.commit().map_err(err)
        }).await
    }
    pub async fn run(&self, id: String, revision: String) -> Result<MongoTaskRun, String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            let value: String = tx.query_row("SELECT payload FROM tasks WHERE id=?", [&id], |r| r.get(0)).map_err(err)?;
            let task: MongoTask = decode(value)?;
            if task.revision != revision { return Err("Task changed; refresh and review before running".into()); }
            let run = enqueue(&tx, task, "manual")?; tx.commit().map_err(err)?; Ok(run)
        }).await
    }
    pub async fn cancel(&self, id: String) -> Result<(), String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            let value: Option<String> = tx.query_row("SELECT payload FROM runs WHERE id=? AND state IN ('queued','running')", [&id], |r| r.get(0)).optional().map_err(err)?;
            if let Some(value) = value {
                let mut run: MongoTaskRun = decode(value)?;
                tx.execute("UPDATE runs SET cancel=1 WHERE id=?", [&id]).map_err(err)?;
                if run.status == "queued" { run.status = "cancelled".into(); run.completed_at = Some(Utc::now().to_rfc3339()); persist_run(&tx, &run)?; }
            }
            tx.commit().map_err(err)
        }).await
    }
    pub async fn cancelled(&self, id: String) -> Result<bool, String> {
        self.access(move |conn| conn.query_row("SELECT cancel FROM runs WHERE id=?", [id], |r| r.get(0)).map_err(err)).await
    }
    pub async fn heartbeat(&self) -> Result<(), String> {
        self.access(|conn| { conn.execute("INSERT INTO metadata(key,value) VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [Utc::now().to_rfc3339()]).map_err(err)?; Ok(()) }).await
    }
    /// Only the process holding worker.lock may recover/claim/finish. Never replay
    /// a running job after a crash: its last read may have reached the server.
    pub async fn recover(&self) -> Result<(), String> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            let values = {
                let mut stmt = tx.prepare("SELECT payload FROM runs WHERE state='running'").map_err(err)?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(err)?
            };
            for value in values {
                let mut run: MongoTaskRun = decode(value)?;
                run.status = "interrupted".into(); run.completed_at = Some(Utc::now().to_rfc3339()); run.error = Some("Backend stopped before completion; review this run and start a new run manually if needed".into());
                persist_run(&tx, &run)?;
            }
            tx.commit().map_err(err)
        }).await
    }
    pub async fn enqueue_due(&self) -> Result<(), String> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            let now = Utc::now();
            for mut task in tasks(&tx)? {
                let pending: i64 = tx.query_row("SELECT COUNT(*) FROM runs WHERE state IN ('queued','running')", [], |r| r.get(0)).map_err(err)?;
                if pending >= 100 { break; }
                if !task.enabled { continue; }
                let due = task.next_run_at.as_deref().ok_or("Enabled task lacks next run time")?.parse::<chrono::DateTime<Utc>>().map_err(|e| e.to_string())?;
                if due > now { continue; }
                if !active(&tx, &task.id)? { enqueue(&tx, task.clone(), "schedule")?; }
                // Coalesce missed intervals into at most one run, never backlog storms.
                task.next_run_at = Some((now + chrono::Duration::minutes(i64::from(task.interval_minutes))).to_rfc3339());
                tx.execute("UPDATE tasks SET payload=? WHERE id=?", params![encode(&task)?, task.id]).map_err(err)?;
            }
            tx.commit().map_err(err)
        }).await
    }
    pub async fn claim(&self) -> Result<Option<Job>, String> {
        self.access(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            let value: Option<String> = tx.query_row("SELECT job FROM runs WHERE state='queued' AND cancel=0 ORDER BY created_at,id LIMIT 1", [], |r| r.get(0)).optional().map_err(err)?;
            let Some(value) = value else { return Ok(None); };
            let mut job: Job = decode(value)?; job.run.status = "running".into();
            persist_run(&tx, &job.run)?; tx.commit().map_err(err)?; Ok(Some(job))
        }).await
    }
    pub async fn progress(&self, run: MongoTaskRun) -> Result<(), String> {
        self.access(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            persist_run(&tx, &run)?;
            tx.commit().map_err(err)
        }).await
    }
}
