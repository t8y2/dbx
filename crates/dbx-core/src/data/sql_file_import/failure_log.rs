//! Durable failure log for SQL file execution (dbx#11619).
//!
//! Every failing statement is appended to a JSONL file inside the application
//! data directory as it happens, so the complete source statement survives even
//! when the frontend only ever receives the 120-char `statement_summary` and
//! keeps just the newest 500 failures in memory. TXT/CSV are derived from this
//! file at export time instead of being written during execution.
//!
//! The progress emitter that feeds the frontend is a *synchronous* callback, so
//! the sink never touches the filesystem itself: [`SqlFileFailureLogHandle`]
//! serializes records and hands them to a writer task over a channel. That keeps
//! a slow or failing disk out of the execution hot path — the run must never be
//! interrupted because logging broke — and still lets an export read a snapshot
//! mid-run, because each record is written and flushed as one complete line.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};

use crate::sql::{SqlFileProgress, SqlFileStatus};

/// Sub-directory of the application data directory holding the logs.
pub const SQL_FILE_FAILURE_LOG_DIR: &str = "sql-file-logs";
/// Per-statement cap. A mysqldump extended INSERT can reach ~1MB on its own, so
/// a total-only cap would let a single statement dominate the whole budget.
pub const SQL_FILE_FAILURE_LOG_MAX_STATEMENT_BYTES: usize = 256 * 1024;
/// Per-execution cap: past this the writer stops appending and the summary
/// reports how many failures were dropped.
pub const SQL_FILE_FAILURE_LOG_MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
/// Retention: newest N executions, and never more than the byte budget below.
pub const SQL_FILE_FAILURE_LOG_MAX_FILES: usize = 20;
pub const SQL_FILE_FAILURE_LOG_MAX_DIR_BYTES: u64 = 500 * 1024 * 1024;
/// Upper bound on how long `finish` waits for the writer task.
const SQL_FILE_FAILURE_LOG_FINISH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileFailureLogStatus {
    /// Logging works.
    Available,
    /// The file was created but a later write failed (e.g. the disk filled up).
    Degraded,
    /// No file exists at all (directory or file creation failed).
    Unavailable,
}

impl SqlFileFailureLogStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Degraded => "degraded",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogFileInfo {
    pub index: usize,
    pub name: String,
    pub path: String,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SqlFileFailureLogMeta {
    pub execution_id: String,
    pub connection_id: String,
    pub connection_name: Option<String>,
    pub database: String,
    pub schema: Option<String>,
    pub files: Vec<SqlFileFailureLogFileInfo>,
    pub limits: SqlFileFailureLogLimits,
}

#[derive(Debug, Clone, Copy)]
pub struct SqlFileFailureLogLimits {
    pub max_statement_bytes: usize,
    pub max_total_bytes: u64,
}

impl Default for SqlFileFailureLogLimits {
    fn default() -> Self {
        Self {
            max_statement_bytes: SQL_FILE_FAILURE_LOG_MAX_STATEMENT_BYTES,
            max_total_bytes: SQL_FILE_FAILURE_LOG_MAX_TOTAL_BYTES,
        }
    }
}

/// Execution outcome written as the last line. Counters come from the execution
/// itself, not from the log, so a truncated log never makes them wrong.
#[derive(Debug, Clone, Default)]
pub struct SqlFileFailureLogSummary {
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum LogRecord<'a> {
    #[serde(rename_all = "camelCase")]
    Meta {
        execution_id: &'a str,
        connection_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_name: Option<&'a str>,
        database: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<&'a str>,
        started_at_ms: i64,
        files: &'a [SqlFileFailureLogFileInfo],
        max_statement_bytes: usize,
        max_total_bytes: u64,
    },
    #[serde(rename_all = "camelCase")]
    Failure {
        file_index: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        file_name: Option<&'a str>,
        file_statement_index: usize,
        statement_index: usize,
        sql: &'a str,
        sql_truncated: bool,
        error: &'a str,
        recorded_at_ms: i64,
    },
    #[serde(rename_all = "camelCase")]
    Summary {
        success_count: usize,
        failure_count: usize,
        affected_rows: u64,
        elapsed_ms: u64,
        failed_statements_logged: u64,
        /// Failures dropped because the total budget was exhausted.
        omitted_failures: u64,
        /// Records whose SQL text had to be cut at the per-statement cap.
        truncated_statements: u64,
        log_truncated: bool,
        cancelled: bool,
        log_status: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        log_status_reason: Option<&'a str>,
        finished_at_ms: i64,
    },
}

enum LogCommand {
    /// `failure` marks the lines that count as logged failures, so the summary
    /// reports what the writer actually persisted rather than what was queued.
    Line {
        line: String,
        failure: bool,
    },
    Flush(oneshot::Sender<()>),
    Finish(String, oneshot::Sender<()>),
}

#[derive(Default)]
struct LogStatusCell {
    status: AtomicU8,
    reason: Mutex<Option<String>>,
}

impl LogStatusCell {
    fn new(status: SqlFileFailureLogStatus, reason: Option<String>) -> Self {
        Self { status: AtomicU8::new(status as u8), reason: Mutex::new(reason) }
    }

    fn set(&self, status: SqlFileFailureLogStatus, reason: Option<String>) {
        self.status.store(status as u8, Ordering::Relaxed);
        if let Ok(mut slot) = self.reason.lock() {
            *slot = reason;
        }
    }

    fn get(&self) -> (SqlFileFailureLogStatus, Option<String>) {
        let status = match self.status.load(Ordering::Relaxed) {
            1 => SqlFileFailureLogStatus::Degraded,
            2 => SqlFileFailureLogStatus::Unavailable,
            _ => SqlFileFailureLogStatus::Available,
        };
        let reason = self.reason.lock().ok().and_then(|slot| slot.clone());
        (status, reason)
    }
}

/// Cloneable view of a log's health. The registry keeps one of these so the
/// export/copy UI can report `degraded`/`unavailable` without holding (or being
/// able to disturb) the writer handle owned by the running execution.
#[derive(Clone)]
pub struct SqlFileFailureLogStatusProbe {
    status: Arc<LogStatusCell>,
}

impl SqlFileFailureLogStatusProbe {
    pub fn status(&self) -> SqlFileFailureLogStatus {
        self.status.get().0
    }

    pub fn reason(&self) -> Option<String> {
        self.status.get().1
    }
}

/// What the frontend needs to render the export affordances of one execution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogInfo {
    pub status: SqlFileFailureLogStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Absent when no log file could be created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Terminal counters of one run, taken from its terminal progress event.
///
/// The emitter throttles intermediate progress, so the totals must come from the
/// final event — that is also what the UI shows, which keeps the log summary and
/// the interface from disagreeing. Shared by the desktop and Web runtimes.
#[derive(Debug, Default, Clone, Copy)]
pub struct SqlFileFailureLogRunCounters {
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub cancelled: bool,
}

impl SqlFileFailureLogRunCounters {
    pub fn observe(&mut self, progress: &SqlFileProgress) {
        match progress.status {
            SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled => {
                self.success_count = progress.success_count;
                self.failure_count = progress.failure_count;
                self.affected_rows = progress.affected_rows;
                self.cancelled = progress.status == SqlFileStatus::Cancelled;
            }
            _ => {}
        }
    }

    pub fn summary(&self, elapsed_ms: u64) -> SqlFileFailureLogSummary {
        SqlFileFailureLogSummary {
            success_count: self.success_count,
            failure_count: self.failure_count,
            affected_rows: self.affected_rows,
            elapsed_ms,
            cancelled: self.cancelled,
        }
    }
}

/// Owner-scoped `executionId -> failure log` registry.
///
/// The desktop runtime uses a single fixed owner; the Web runtime binds the
/// authenticated session token, so a session that guesses another session's
/// execution id still cannot read its log.
#[derive(Default)]
pub struct SqlFileFailureLogRegistry {
    entries: std::sync::RwLock<std::collections::HashMap<String, SqlFileFailureLogRegistryEntry>>,
}

struct SqlFileFailureLogRegistryEntry {
    owner: String,
    path: Option<PathBuf>,
    probe: SqlFileFailureLogStatusProbe,
    /// False while the execution is still writing this log. Retention must keep
    /// finished logs prunable: protecting every log ever registered would let a
    /// long-lived process (the Web server runs for days) grow without bound.
    finished: bool,
}

impl SqlFileFailureLogRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        owner: &str,
        execution_id: &str,
        path: Option<PathBuf>,
        probe: SqlFileFailureLogStatusProbe,
    ) {
        let Ok(mut entries) = self.entries.write() else {
            return;
        };
        entries.insert(
            execution_id.to_string(),
            SqlFileFailureLogRegistryEntry { owner: owner.to_string(), path, probe, finished: false },
        );
    }

    /// Returns the log info only when `owner` is the one that registered it.
    ///
    /// A finished log is deliberately prunable, and the user can delete the file
    /// by hand, so the stored path is checked before it is reported: claiming
    /// `available` for a file that is gone would keep the export controls enabled
    /// and hand out a path that cannot be read.
    pub fn info(&self, owner: &str, execution_id: &str) -> Option<SqlFileFailureLogInfo> {
        let entries = self.entries.read().ok()?;
        let entry = entries.get(execution_id)?;
        if entry.owner != owner {
            return None;
        }
        match entry.path.as_ref() {
            Some(path) if !path.is_file() => Some(SqlFileFailureLogInfo {
                status: SqlFileFailureLogStatus::Unavailable,
                reason: Some("Failure log file no longer exists".to_string()),
                path: None,
            }),
            Some(path) => Some(SqlFileFailureLogInfo {
                status: entry.probe.status(),
                reason: entry.probe.reason(),
                path: Some(path.to_string_lossy().to_string()),
            }),
            None => {
                Some(SqlFileFailureLogInfo { status: entry.probe.status(), reason: entry.probe.reason(), path: None })
            }
        }
    }

    pub fn path(&self, owner: &str, execution_id: &str) -> Option<PathBuf> {
        let entries = self.entries.read().ok()?;
        let entry = entries.get(execution_id)?;
        (entry.owner == owner).then(|| entry.path.clone()).flatten().filter(|path| path.is_file())
    }

    pub fn remove(&self, owner: &str, execution_id: &str) {
        let Ok(mut entries) = self.entries.write() else {
            return;
        };
        if entries.get(execution_id).is_some_and(|entry| entry.owner == owner) {
            entries.remove(execution_id);
        }
    }

    /// Marks one execution's log as complete. The entry stays registered so the
    /// user can still export it, but it stops being protected from retention.
    pub fn mark_finished(&self, owner: &str, execution_id: &str) {
        let Ok(mut entries) = self.entries.write() else {
            return;
        };
        if let Some(entry) = entries.get_mut(execution_id) {
            if entry.owner == owner {
                entry.finished = true;
            }
        }
    }

    /// Paths of logs that are still being written, across all owners. Used as the
    /// protection list when pruning so a parallel execution keeps its in-progress
    /// log; finished logs stay prunable, which is what makes retention work.
    pub fn active_paths(&self) -> Vec<PathBuf> {
        let Ok(entries) = self.entries.read() else {
            return Vec::new();
        };
        entries.values().filter(|entry| !entry.finished).filter_map(|entry| entry.path.clone()).collect()
    }

    /// Drops every log of one owner (e.g. when a Web session ends).
    pub fn remove_owner(&self, owner: &str) -> Vec<PathBuf> {
        let Ok(mut entries) = self.entries.write() else {
            return Vec::new();
        };
        let removed_ids: Vec<String> =
            entries.iter().filter(|(_, entry)| entry.owner == owner).map(|(id, _)| id.clone()).collect();
        removed_ids.into_iter().filter_map(|id| entries.remove(&id)).filter_map(|entry| entry.path).collect()
    }
}

/// Synchronous producer used from the progress emitter callback.
pub struct SqlFileFailureLogHandle {
    commands: Option<mpsc::UnboundedSender<LogCommand>>,
    status: Arc<LogStatusCell>,
    path: Option<PathBuf>,
    limits: SqlFileFailureLogLimits,
    total_bytes: u64,
    log_truncated: bool,
    omitted_failures: u64,
    truncated_statements: u64,
    /// Bumped by the writer task after a record is on disk. Counting at queue
    /// time would let the summary claim failures that a failed write dropped.
    persisted_failures: Arc<AtomicU64>,
    /// Context of the file currently executing. Statement progress events carry
    /// no file info (only file-boundary events do), so the sink tracks the last
    /// boundary itself — the same thing the frontend does to label failures.
    current_file_index: usize,
    current_file_name: Option<String>,
    /// Global statement counter when the current file started; per-file 1-based
    /// indexes are derived from it.
    file_start_statement_index: usize,
    finished: bool,
}

impl SqlFileFailureLogHandle {
    /// A handle for an execution whose log could not be created at all.
    pub fn unavailable(reason: String) -> Self {
        Self {
            commands: None,
            status: Arc::new(LogStatusCell::new(SqlFileFailureLogStatus::Unavailable, Some(reason))),
            path: None,
            limits: SqlFileFailureLogLimits::default(),
            total_bytes: 0,
            log_truncated: false,
            omitted_failures: 0,
            truncated_statements: 0,
            persisted_failures: Arc::new(AtomicU64::new(0)),
            current_file_index: 0,
            current_file_name: None,
            file_start_statement_index: 0,
            finished: false,
        }
    }

    pub fn status(&self) -> SqlFileFailureLogStatus {
        self.status.get().0
    }

    pub fn status_reason(&self) -> Option<String> {
        self.status.get().1
    }

    /// Shareable health probe for the registry (see [`SqlFileFailureLogStatusProbe`]).
    pub fn status_probe(&self) -> SqlFileFailureLogStatusProbe {
        SqlFileFailureLogStatusProbe { status: self.status.clone() }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn omitted_failures(&self) -> u64 {
        self.omitted_failures
    }

    /// Called for every progress event. File-boundary events update the file
    /// context; `StatementFailed` events carrying the full source SQL are logged.
    pub fn record(&mut self, progress: &SqlFileProgress) {
        self.track_file_boundary(progress);

        if progress.status != SqlFileStatus::StatementFailed {
            return;
        }
        let Some(sql) = progress.failure_sql.as_deref() else {
            return;
        };

        let (sql, sql_truncated) = truncate_utf8(sql, self.limits.max_statement_bytes);
        if sql_truncated {
            self.truncated_statements += 1;
        }
        let error = progress.error.as_deref().unwrap_or_default();
        let file_statement_index = progress.statement_index.saturating_sub(self.file_start_statement_index);
        let record = LogRecord::Failure {
            file_index: self.current_file_index,
            file_name: self.current_file_name.as_deref(),
            file_statement_index,
            statement_index: progress.statement_index,
            sql,
            sql_truncated,
            error,
            recorded_at_ms: now_ms(),
        };
        let line = match serde_json::to_string(&record) {
            Ok(line) => line,
            Err(_) => {
                self.status.set(SqlFileFailureLogStatus::Degraded, Some("Serialize failure record failed".to_string()));
                self.omitted_failures += 1;
                return;
            }
        };

        // The summary line is written even after the budget is exhausted: it is
        // the only place that reports that truncation happened, so losing it
        // would make the log silently incomplete.
        let record_bytes = line.len() as u64 + 1;
        if self.total_bytes + record_bytes > self.limits.max_total_bytes {
            self.log_truncated = true;
            self.omitted_failures += 1;
            return;
        }
        self.total_bytes += record_bytes;
        self.send(LogCommand::Line { line, failure: true });
    }

    /// Writes the summary record and waits (bounded) for the writer to flush.
    pub async fn finish(&mut self, summary: SqlFileFailureLogSummary) {
        if self.finished {
            return;
        }
        self.finished = true;
        let (status, reason) = self.status.get();

        // Drain first: the writer owns the persisted counter, and the summary
        // must describe records that are already on disk.
        self.flush().await;
        let persisted_failures = self.persisted_failures.load(Ordering::Relaxed);
        let line = match serde_json::to_string(&LogRecord::Summary {
            success_count: summary.success_count,
            failure_count: summary.failure_count,
            affected_rows: summary.affected_rows,
            elapsed_ms: summary.elapsed_ms,
            failed_statements_logged: persisted_failures,
            omitted_failures: self.omitted_failures,
            truncated_statements: self.truncated_statements,
            log_truncated: self.log_truncated,
            cancelled: summary.cancelled,
            log_status: status.as_str(),
            log_status_reason: reason.as_deref(),
            finished_at_ms: now_ms(),
        }) {
            Ok(line) => line,
            Err(_) => return,
        };
        let Some(commands) = self.commands.take() else {
            return;
        };
        let (ack_tx, ack_rx) = oneshot::channel();
        if commands.send(LogCommand::Finish(line, ack_tx)).is_err() {
            return;
        }
        // A wedged writer must not hang the end of an execution.
        let _ = tokio::time::timeout(SQL_FILE_FAILURE_LOG_FINISH_TIMEOUT, ack_rx).await;
    }

    /// Waits until everything queued so far has been written and flushed. Used
    /// by the export/copy path, which reads the file while the run continues.
    pub async fn flush(&mut self) {
        let Some(commands) = self.commands.as_ref() else {
            return;
        };
        let (ack_tx, ack_rx) = oneshot::channel();
        if commands.send(LogCommand::Flush(ack_tx)).is_err() {
            return;
        }
        let _ = tokio::time::timeout(SQL_FILE_FAILURE_LOG_FINISH_TIMEOUT, ack_rx).await;
    }

    fn track_file_boundary(&mut self, progress: &SqlFileProgress) {
        // Only the *start-of-file* event carries the global statement counter at
        // the file boundary. The end-of-file summary event sets `file_index` too
        // but its `statement_index` is a per-file delta, so using it here would
        // corrupt every later per-file index.
        if progress.status != SqlFileStatus::Running {
            return;
        }
        let Some(file_index) = progress.file_index else {
            return;
        };
        self.current_file_index = file_index;
        self.current_file_name = progress.file_name.clone();
        self.file_start_statement_index = progress.statement_index;
    }

    fn send(&mut self, command: LogCommand) {
        let Some(commands) = self.commands.as_ref() else {
            return;
        };
        if commands.send(command).is_err() {
            // Writer task is gone; keep reporting the degradation instead of
            // failing the execution that is producing the failures.
            self.status.set(SqlFileFailureLogStatus::Degraded, Some("Failure log writer stopped".to_string()));
        }
    }
}

/// Creates the log file, writes its `meta` line and spawns the writer task.
/// Never fails: a log that cannot be created yields an `Unavailable` handle so
/// the SQL file execution still runs.
pub async fn start_sql_file_failure_log(dir: &Path, meta: SqlFileFailureLogMeta) -> SqlFileFailureLogHandle {
    let limits = meta.limits;
    let file_name = format!("{}-{}.jsonl", sanitize_execution_id(&meta.execution_id), timestamp_suffix());
    let path = dir.join(file_name);

    match open_log_file(dir, &path).await {
        Ok(file) => {
            let meta_record = LogRecord::Meta {
                execution_id: &meta.execution_id,
                connection_id: &meta.connection_id,
                connection_name: meta.connection_name.as_deref(),
                database: &meta.database,
                schema: meta.schema.as_deref(),
                started_at_ms: now_ms(),
                files: &meta.files,
                max_statement_bytes: limits.max_statement_bytes,
                max_total_bytes: limits.max_total_bytes,
            };
            let meta_line = serde_json::to_string(&meta_record).unwrap_or_default();
            let status = Arc::new(LogStatusCell::new(SqlFileFailureLogStatus::Available, None));
            let (commands, receiver) = mpsc::unbounded_channel();
            let persisted_failures = Arc::new(AtomicU64::new(0));
            tokio::spawn(run_writer(file, receiver, status.clone(), persisted_failures.clone()));

            let mut handle = SqlFileFailureLogHandle {
                commands: Some(commands),
                status,
                path: Some(path),
                limits,
                total_bytes: 0,
                log_truncated: false,
                omitted_failures: 0,
                truncated_statements: 0,
                persisted_failures,
                current_file_index: 0,
                current_file_name: None,
                file_start_statement_index: 0,
                finished: false,
            };
            handle.total_bytes = meta_line.len() as u64 + 1;
            // A single-file run emits no file-boundary event, so seed the context
            // from the meta file list; multi-file runs overwrite it per file.
            if meta.files.len() == 1 {
                handle.current_file_name = Some(meta.files[0].name.clone());
            }
            handle.send(LogCommand::Line { line: meta_line, failure: false });
            handle
        }
        Err(reason) => SqlFileFailureLogHandle::unavailable(reason),
    }
}

async fn open_log_file(dir: &Path, path: &Path) -> Result<tokio::fs::File, String> {
    create_log_dir(dir).await?;
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    // POSIX: the log holds full SQL text and database errors, so keep it private.
    // On Windows the file inherits the user-profile ACL of the data directory.
    // `mode` is tokio's own unix-only method, so no std extension trait is needed.
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    options.open(path).await.map_err(|error| format!("Cannot create failure log: {error}"))
}

async fn create_log_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        builder.mode(0o700);
    }
    builder.create(dir).await.map_err(|error| format!("Cannot create failure log directory: {error}"))
}

async fn run_writer(
    mut file: tokio::fs::File,
    mut receiver: mpsc::UnboundedReceiver<LogCommand>,
    status: Arc<LogStatusCell>,
    persisted_failures: Arc<AtomicU64>,
) {
    while let Some(command) = receiver.recv().await {
        match command {
            LogCommand::Line { line, failure } => {
                if write_line(&mut file, &line, &status).await && failure {
                    persisted_failures.fetch_add(1, Ordering::Relaxed);
                }
            }
            LogCommand::Flush(ack) => {
                let _ = file.flush().await;
                let _ = ack.send(());
            }
            LogCommand::Finish(line, ack) => {
                // The summary line is not a failure record; only flush it.
                let _ = write_line(&mut file, &line, &status).await;
                let _ = file.flush().await;
                let _ = ack.send(());
                break;
            }
        }
    }
}

/// Writes one complete record per call and flushes it, so a concurrent reader
/// only ever sees whole lines (plus possibly one partial tail line, which the
/// derivation step tolerates).
/// Returns whether the record actually reached the disk, which is what the
/// summary may claim.
async fn write_line(file: &mut tokio::fs::File, line: &str, status: &Arc<LogStatusCell>) -> bool {
    let mut buffer = Vec::with_capacity(line.len() + 1);
    buffer.extend_from_slice(line.as_bytes());
    buffer.push(b'\n');
    if let Err(error) = file.write_all(&buffer).await {
        status.set(SqlFileFailureLogStatus::Degraded, Some(format!("Cannot write failure log: {error}")));
        return false;
    }
    if let Err(error) = file.flush().await {
        status.set(SqlFileFailureLogStatus::Degraded, Some(format!("Cannot flush failure log: {error}")));
        return false;
    }
    true
}

/// Retention for the log directory: newest first, keep at most
/// [`SQL_FILE_FAILURE_LOG_MAX_FILES`] files and [`SQL_FILE_FAILURE_LOG_MAX_DIR_BYTES`]
/// in total. Every path in `protected` (the logs of executions still registered
/// in this process) survives regardless of age, because two imports can run in
/// parallel and the newer one must not prune the older one's in-progress log.
pub fn prune_sql_file_failure_logs(dir: &Path, protected: &[PathBuf]) -> Result<u64, String> {
    prune_sql_file_failure_logs_with_limits(
        dir,
        protected,
        SQL_FILE_FAILURE_LOG_MAX_FILES,
        SQL_FILE_FAILURE_LOG_MAX_DIR_BYTES,
    )
}

/// Same policy with injectable limits, so tests can exercise the retention rules
/// without writing hundreds of megabytes to disk.
pub fn prune_sql_file_failure_logs_with_limits(
    dir: &Path,
    protected: &[PathBuf],
    max_files: usize,
    max_bytes: u64,
) -> Result<u64, String> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(dir).map_err(|error| format!("Cannot read failure log directory: {error}"))?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((path, modified, metadata.len()));
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    let mut removed = 0u64;
    let mut kept_bytes = 0u64;
    for (index, (path, _, size)) in entries.iter().enumerate() {
        let is_active = protected.iter().any(|entry| entry == path);
        let within_count = index < max_files;
        let within_bytes = kept_bytes + size <= max_bytes;
        if is_active || (within_count && within_bytes) {
            kept_bytes += size;
            continue;
        }
        match std::fs::remove_file(path) {
            Ok(()) => removed += 1,
            Err(error) => log::warn!("Failed to prune SQL file failure log {}: {error}", path.display()),
        }
    }
    Ok(removed)
}

fn sanitize_execution_id(execution_id: &str) -> String {
    let sanitized: String = execution_id
        .chars()
        .map(|value| if value.is_ascii_alphanumeric() || matches!(value, '-' | '_') { value } else { '_' })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "execution".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn timestamp_suffix() -> String {
    chrono::Local::now().format("%Y%m%d%H%M%S").to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Truncates on a UTF-8 boundary so SQL with multi-byte characters stays valid.
fn truncate_utf8(value: &str, max_bytes: usize) -> (&str, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql::SqlFileProgress;

    fn progress(status: SqlFileStatus, statement_index: usize) -> SqlFileProgress {
        SqlFileProgress {
            execution_id: "exec-1".to_string(),
            status,
            statement_index,
            success_count: 0,
            failure_count: 0,
            affected_rows: 0,
            elapsed_ms: 0,
            statement_summary: String::new(),
            error: None,
            bytes_read: None,
            total_bytes: None,
            phase: None,
            file_index: None,
            file_name: None,
            failure_sql: None,
        }
    }

    fn failure_progress(statement_index: usize, sql: &str, error: &str) -> SqlFileProgress {
        let mut value = progress(SqlFileStatus::StatementFailed, statement_index);
        value.failure_sql = Some(sql.to_string());
        value.error = Some(error.to_string());
        value
    }

    fn meta(files: Vec<SqlFileFailureLogFileInfo>, limits: SqlFileFailureLogLimits) -> SqlFileFailureLogMeta {
        SqlFileFailureLogMeta {
            execution_id: "exec-1".to_string(),
            connection_id: "conn-1".to_string(),
            connection_name: Some("MySQL".to_string()),
            database: "shop".to_string(),
            schema: None,
            files,
            limits,
        }
    }

    fn file_info(index: usize, name: &str) -> SqlFileFailureLogFileInfo {
        SqlFileFailureLogFileInfo { index, name: name.to_string(), path: format!("/tmp/{name}"), size_bytes: Some(10) }
    }

    fn lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn failure_log_writes_meta_failure_and_summary_records() {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = dir.path().join(SQL_FILE_FAILURE_LOG_DIR);
        let mut handle =
            start_sql_file_failure_log(&log_dir, meta(vec![file_info(0, "a.sql")], Default::default())).await;
        assert_eq!(handle.status(), SqlFileFailureLogStatus::Available);

        handle.record(&failure_progress(7, "INSERT INTO t VALUES (1);", "ORA-12899: value too large"));
        handle
            .finish(SqlFileFailureLogSummary {
                success_count: 6,
                failure_count: 1,
                affected_rows: 4,
                elapsed_ms: 120,
                cancelled: false,
            })
            .await;

        let path = handle.path().unwrap().to_path_buf();
        let records = lines(&path);
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["type"], "meta");
        assert_eq!(records[0]["files"][0]["name"], "a.sql");
        assert_eq!(records[1]["type"], "failure");
        assert_eq!(records[1]["statementIndex"], 7);
        assert_eq!(records[1]["fileIndex"], 0);
        assert_eq!(records[1]["fileStatementIndex"], 7);
        assert_eq!(records[1]["sql"], "INSERT INTO t VALUES (1);");
        assert_eq!(records[1]["error"], "ORA-12899: value too large");
        assert_eq!(records[1]["sqlTruncated"], false);
        assert_eq!(records[2]["type"], "summary");
        assert_eq!(records[2]["failureCount"], 1);
        assert_eq!(records[2]["failedStatementsLogged"], 1);
        assert_eq!(records[2]["omittedFailures"], 0);
        assert_eq!(records[2]["logTruncated"], false);
        assert_eq!(records[2]["logStatus"], "available");
    }

    #[tokio::test]
    async fn failure_log_derives_per_file_statement_indexes_from_boundary_events() {
        let dir = tempfile::tempdir().unwrap();
        let limits = SqlFileFailureLogLimits::default();
        let mut handle =
            start_sql_file_failure_log(dir.path(), meta(vec![file_info(0, "a.sql"), file_info(1, "b.sql")], limits))
                .await;

        // Second file starts after 5 statements of the first file.
        let mut boundary = progress(SqlFileStatus::Running, 5);
        boundary.file_index = Some(1);
        boundary.file_name = Some("b.sql".to_string());
        handle.record(&boundary);
        // The end-of-file summary for "a.sql" carries a per-file delta, not a
        // global counter; it must not become the next file's start offset.
        let mut file_summary = progress(SqlFileStatus::StatementDone, 5);
        file_summary.file_index = Some(0);
        file_summary.file_name = Some("a.sql".to_string());
        handle.record(&file_summary);
        handle.record(&failure_progress(8, "INSERT INTO b VALUES (1);", "duplicate key"));
        handle.finish(SqlFileFailureLogSummary::default()).await;

        let records = lines(handle.path().unwrap());
        let failure = records.iter().find(|record| record["type"] == "failure").unwrap();
        assert_eq!(failure["fileIndex"], 1);
        assert_eq!(failure["fileName"], "b.sql");
        assert_eq!(failure["statementIndex"], 8);
        assert_eq!(failure["fileStatementIndex"], 3);
    }

    #[tokio::test]
    async fn failure_log_truncates_oversized_statement_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let limits = SqlFileFailureLogLimits { max_statement_bytes: 32, ..Default::default() };
        let mut handle = start_sql_file_failure_log(dir.path(), meta(vec![file_info(0, "a.sql")], limits)).await;

        let sql = format!("INSERT INTO t VALUES ('{}');", "中".repeat(64));
        handle.record(&failure_progress(1, &sql, "error"));
        handle.finish(SqlFileFailureLogSummary::default()).await;

        let records = lines(handle.path().unwrap());
        let failure = records.iter().find(|record| record["type"] == "failure").unwrap();
        assert_eq!(failure["sqlTruncated"], true);
        assert!(failure["sql"].as_str().unwrap().len() <= 32);
        // Truncation must land on a char boundary, so the text stays valid UTF-8.
        assert!(std::str::from_utf8(failure["sql"].as_str().unwrap().as_bytes()).is_ok());
        let summary = records.iter().find(|record| record["type"] == "summary").unwrap();
        assert_eq!(summary["truncatedStatements"], 1);
        assert_eq!(summary["omittedFailures"], 0);
    }

    #[tokio::test]
    async fn failure_log_stops_at_total_budget_and_counts_omitted_failures() {
        let dir = tempfile::tempdir().unwrap();
        // Large enough for a couple of records, then the writer must stop.
        let limits = SqlFileFailureLogLimits { max_statement_bytes: 1024, max_total_bytes: 900 };
        let mut handle = start_sql_file_failure_log(dir.path(), meta(vec![file_info(0, "a.sql")], limits)).await;

        for index in 1..=20 {
            handle.record(&failure_progress(index, "INSERT INTO t VALUES (1);", "boom"));
        }
        handle.finish(SqlFileFailureLogSummary { failure_count: 20, ..Default::default() }).await;

        let records = lines(handle.path().unwrap());
        let failures = records.iter().filter(|record| record["type"] == "failure").count();
        let summary = records.iter().find(|record| record["type"] == "summary").unwrap();
        assert!(failures as u64 > 0 && failures < 20, "expected partial log, got {failures} records");
        assert_eq!(summary["logTruncated"], true);
        assert_eq!(summary["omittedFailures"].as_u64().unwrap() as usize, 20 - failures);
        assert_eq!(summary["failedStatementsLogged"].as_u64().unwrap() as usize, failures);
        // The summary line is written even after the budget ran out.
        assert_eq!(summary["failureCount"], 20);
    }

    #[tokio::test]
    async fn failure_log_reports_unavailable_instead_of_failing_the_execution() {
        let dir = tempfile::tempdir().unwrap();
        // A regular file where the log directory should be makes creation fail.
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();

        let mut handle =
            start_sql_file_failure_log(&blocked, meta(vec![file_info(0, "a.sql")], Default::default())).await;
        assert_eq!(handle.status(), SqlFileFailureLogStatus::Unavailable);
        assert!(handle.status_reason().is_some());
        // Recording and finishing on an unavailable log must stay silent no-ops.
        handle.record(&failure_progress(1, "SELECT 1", "boom"));
        handle.finish(SqlFileFailureLogSummary::default()).await;
    }

    #[tokio::test]
    async fn failure_log_is_readable_while_the_execution_continues() {
        let dir = tempfile::tempdir().unwrap();
        let limits = SqlFileFailureLogLimits { max_statement_bytes: 4096, max_total_bytes: 1024 * 1024 };
        let mut handle = start_sql_file_failure_log(dir.path(), meta(vec![file_info(0, "a.sql")], limits)).await;

        handle.record(&failure_progress(1, "INSERT INTO t VALUES (1);", "first"));
        handle.flush().await;
        let path = handle.path().unwrap().to_path_buf();
        let snapshot = lines(&path);
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[1]["error"], "first");

        handle.record(&failure_progress(2, "INSERT INTO t VALUES (2);", "second"));
        handle.finish(SqlFileFailureLogSummary::default()).await;
        let final_lines = lines(&path);
        assert_eq!(final_lines.len(), 4);
        assert_eq!(final_lines[3]["type"], "summary");
    }

    #[test]
    fn prune_keeps_newest_logs_within_the_file_count_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut created = Vec::new();
        for index in 0..SQL_FILE_FAILURE_LOG_MAX_FILES + 3 {
            let path = dir.path().join(format!("exec-{index}.jsonl"));
            std::fs::write(&path, b"{}\n").unwrap();
            created.push(path);
        }
        // Unrelated files must survive pruning.
        let keep_other = dir.path().join("notes.txt");
        std::fs::write(&keep_other, b"keep me").unwrap();

        let removed =
            prune_sql_file_failure_logs_with_limits(dir.path(), &[], SQL_FILE_FAILURE_LOG_MAX_FILES, u64::MAX).unwrap();
        assert_eq!(removed as usize, 3);
        let remaining: Vec<_> = created.iter().filter(|path| path.exists()).collect();
        assert_eq!(remaining.len(), SQL_FILE_FAILURE_LOG_MAX_FILES);
        assert!(keep_other.exists());
    }

    #[test]
    fn prune_shrinks_the_directory_to_the_byte_budget() {
        let dir = tempfile::tempdir().unwrap();
        let mut created = Vec::new();
        for index in 0..5 {
            let path = dir.path().join(format!("byte-{index}.jsonl"));
            std::fs::write(&path, vec![b'x'; 100]).unwrap();
            created.push(path);
        }

        // 250 bytes fits two 100-byte logs and evicts the rest regardless of count.
        let removed = prune_sql_file_failure_logs_with_limits(dir.path(), &[], 20, 250).unwrap();
        assert_eq!(removed, 3);
        assert_eq!(created.iter().filter(|path| path.exists()).count(), 2);
    }

    #[test]
    fn prune_protects_the_active_log_and_shrinks_oversized_directories() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.jsonl");
        let active = dir.path().join("active.jsonl");
        std::fs::write(&old, vec![b'x'; 200]).unwrap();
        std::fs::write(&active, vec![b'y'; 200]).unwrap();
        // Make `old` appear older so the active log is the newest entry.
        let now = std::time::SystemTime::now();
        filetime_set(&active, now);
        filetime_set(&old, now - Duration::from_secs(60));

        // The byte budget on its own would evict the active log.
        let removed =
            prune_sql_file_failure_logs_with_limits(dir.path(), std::slice::from_ref(&active), 20, 250).unwrap();
        assert_eq!(removed, 1);
        assert!(active.exists(), "the log of the running execution must survive");
        assert!(!old.exists());
    }

    #[test]
    fn prune_protects_every_concurrently_running_log() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.jsonl");
        let second = dir.path().join("second.jsonl");
        let stale = dir.path().join("stale.jsonl");
        for path in [&first, &second, &stale] {
            std::fs::write(path, vec![b'x'; 200]).unwrap();
        }
        // Write order and mtime granularity are not reliable orderings, so pin
        // the timestamps: `stale` is the oldest, `second` the newest.
        let now = std::time::SystemTime::now();
        filetime_set(&second, now);
        filetime_set(&first, now - Duration::from_secs(30));
        filetime_set(&stale, now - Duration::from_secs(60));
        // Both imports are running: pruning for the newer one must not delete the
        // older one's in-progress log, only the unregistered leftover.
        let removed =
            prune_sql_file_failure_logs_with_limits(dir.path(), &[first.clone(), second.clone()], 20, 250).unwrap();
        assert_eq!(removed, 1);
        assert!(first.exists() && second.exists());
        assert!(!stale.exists());
    }

    #[test]
    fn registry_scopes_logs_to_their_owner() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("exec-1.jsonl");
        std::fs::write(
            &log_path, b"{}
",
        )
        .unwrap();
        let registry = SqlFileFailureLogRegistry::new();
        // A still-usable log is registered with a healthy probe here; the probe's
        // own status is covered by the probe tests below.
        let handle = SqlFileFailureLogHandle::unavailable("boom".to_string());
        registry.register("session-a", "exec-1", Some(log_path.clone()), handle.status_probe());

        let info = registry.info("session-a", "exec-1").unwrap();
        assert_eq!(info.path.as_deref(), Some(log_path.to_string_lossy().as_ref()));
        assert_eq!(registry.path("session-a", "exec-1"), Some(log_path.clone()));

        // Another session holding the same execution id must be refused.
        assert!(registry.info("session-b", "exec-1").is_none());
        assert_eq!(registry.path("session-b", "exec-1"), None);
        // ...and must not be able to delete it either.
        registry.remove("session-b", "exec-1");
        assert!(registry.info("session-a", "exec-1").is_some());
        assert!(registry.info("session-a", "exec-1").unwrap().path.is_some());
    }

    #[test]
    fn registry_stops_protecting_a_log_once_its_execution_finished() {
        let registry = SqlFileFailureLogRegistry::new();
        let running = SqlFileFailureLogHandle::unavailable("running".to_string());
        let done = SqlFileFailureLogHandle::unavailable("done".to_string());
        registry.register(
            "desktop",
            "exec-running",
            Some(PathBuf::from("/logs/running.jsonl")),
            running.status_probe(),
        );
        registry.register("desktop", "exec-done", Some(PathBuf::from("/logs/done.jsonl")), done.status_probe());

        let mut active = registry.active_paths();
        active.sort();
        assert_eq!(active, vec![PathBuf::from("/logs/done.jsonl"), PathBuf::from("/logs/running.jsonl")]);

        registry.mark_finished("desktop", "exec-done");
        // Finished logs are still exportable...
        assert!(registry.info("desktop", "exec-done").is_some());
        // ...but no longer shield themselves from retention.
        assert_eq!(registry.active_paths(), vec![PathBuf::from("/logs/running.jsonl")]);

        // Another owner cannot mark (or unmark) someone else's log.
        let other = SqlFileFailureLogHandle::unavailable("other".to_string());
        registry.register("session-b", "exec-other", Some(PathBuf::from("/logs/other.jsonl")), other.status_probe());
        registry.mark_finished("session-a", "exec-other");
        assert!(registry.active_paths().contains(&PathBuf::from("/logs/other.jsonl")));
    }

    #[test]
    fn finished_logs_become_prunable_with_the_registry_protection_list() {
        let dir = tempfile::tempdir().unwrap();
        let registry = SqlFileFailureLogRegistry::new();
        let old_log = dir.path().join("old.jsonl");
        let new_log = dir.path().join("new.jsonl");
        std::fs::write(&old_log, vec![b'x'; 200]).unwrap();
        std::fs::write(&new_log, vec![b'y'; 200]).unwrap();
        let now = std::time::SystemTime::now();
        filetime_set(&new_log, now);
        filetime_set(&old_log, now - Duration::from_secs(60));

        let handle = SqlFileFailureLogHandle::unavailable("finished".to_string());
        registry.register("desktop", "exec-old", Some(old_log.clone()), handle.status_probe());
        registry.mark_finished("desktop", "exec-old");

        // The byte budget on its own would evict one of the two.
        let removed = prune_sql_file_failure_logs_with_limits(dir.path(), &registry.active_paths(), 20, 250).unwrap();
        assert_eq!(removed, 1);
        assert!(!old_log.exists(), "a finished log must be reclaimable");
        assert!(new_log.exists());
    }

    #[tokio::test]
    async fn registry_reports_a_log_whose_file_is_gone_as_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let mut handle =
            start_sql_file_failure_log(dir.path(), meta(vec![file_info(0, "a.sql")], Default::default())).await;
        handle.record(&failure_progress(1, "SELECT 1;", "boom"));
        // Finishing closes the writer's handle, which is what makes the file
        // deletable on Windows.
        handle.finish(SqlFileFailureLogSummary::default()).await;
        let path = handle.path().unwrap().to_path_buf();
        let registry = SqlFileFailureLogRegistry::new();
        registry.register("desktop", "exec-1", Some(path.clone()), handle.status_probe());
        registry.mark_finished("desktop", "exec-1");

        assert_eq!(registry.info("desktop", "exec-1").unwrap().status, SqlFileFailureLogStatus::Available);
        assert!(registry.path("desktop", "exec-1").is_some());

        // Retention (or the user) deletes a finished log behind our back.
        std::fs::remove_file(&path).unwrap();

        let info = registry.info("desktop", "exec-1").unwrap();
        assert_eq!(info.status, SqlFileFailureLogStatus::Unavailable);
        assert_eq!(info.reason.as_deref(), Some("Failure log file no longer exists"));
        assert!(info.path.is_none(), "a vanished file must not be offered for export");
        assert!(registry.path("desktop", "exec-1").is_none());
    }

    #[tokio::test]
    async fn summary_counts_only_records_the_writer_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let mut handle =
            start_sql_file_failure_log(dir.path(), meta(vec![file_info(0, "a.sql")], Default::default())).await;
        for statement_index in 1..=3 {
            handle.record(&failure_progress(statement_index, "INSERT INTO t VALUES (1);", "boom"));
        }
        handle.finish(SqlFileFailureLogSummary::default()).await;

        let path = handle.path().unwrap().to_path_buf();
        let contents = std::fs::read_to_string(&path).unwrap();
        let records: Vec<serde_json::Value> = contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let on_disk = records.iter().filter(|record| record["type"] == "failure").count();
        let summary = records.iter().find(|record| record["type"] == "summary").unwrap();

        // The summary must describe the file, not the queue.
        assert_eq!(on_disk, 3);
        assert_eq!(summary["failedStatementsLogged"].as_u64().unwrap() as usize, on_disk);
    }

    #[test]
    fn registry_status_follows_the_live_probe_and_owner_removal_is_scoped() {
        let registry = SqlFileFailureLogRegistry::new();
        let unavailable = SqlFileFailureLogHandle::unavailable("first".to_string());
        registry.register("session-a", "exec-1", None, unavailable.status_probe());
        registry.register("session-b", "exec-2", Some(PathBuf::from("/logs/exec-2.jsonl")), unavailable.status_probe());

        let removed = registry.remove_owner("session-a");
        assert_eq!(removed.len(), 0, "the unavailable log has no path to clean up");
        assert!(registry.info("session-a", "exec-1").is_none());
        assert!(registry.info("session-b", "exec-2").is_some());
    }

    /// `std::fs::File::set_modified` is stable for our use, but tests only need
    /// the ordering to be deterministic, so use the std API directly.
    fn filetime_set(path: &Path, time: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }
}
