#![cfg(feature = "duckdb-bundled")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::db;
use crate::db::duckdb_worker_protocol::{
    DuckDbWorkerConnectParams, DuckDbWorkerError, DuckDbWorkerExecuteParams, DuckDbWorkerMethod,
    DuckDbWorkerObjectSourceParams, DuckDbWorkerRequest, DuckDbWorkerResponse,
};
use crate::models::connection::AttachedDatabaseConfig;
use crate::storage::{normalize_duckdb_worker_max_processes, DUCKDB_WORKER_MAX_PROCESSES_DEFAULT};

/// Error code the worker reports when a query error left the DuckDB connection poisoned
/// (see the duckdb-rs Parser Error bug). The client kills the worker on this code so the
/// next request starts a fresh one. Must match the code emitted in `duckdb_worker_runtime`.
const DUCKDB_WORKER_POISONED_CODE: &str = "duckdb_worker_poisoned";
const DUCKDB_WORKER_REQUEST_TIMEOUT_CODE: &str = "duckdb_worker_request_timeout";
const DEFAULT_WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_WORKER_KILL_WAIT: Duration = Duration::from_secs(3);
const DEFAULT_WORKER_START_WAIT: Duration = Duration::from_secs(5);
type PendingRequests = Arc<Mutex<HashMap<String, PendingRequest>>>;

struct PendingRequest {
    generation: u64,
    sender: oneshot::Sender<DuckDbWorkerResponse>,
}

#[derive(Clone)]
pub struct DuckDbWorkerClient {
    inner: Arc<DuckDbWorkerClientInner>,
}

struct DuckDbWorkerClientInner {
    state: Mutex<WorkerProcessState>,
    pending: PendingRequests,
    connect_lock: Mutex<()>,
    query_lock: Mutex<()>,
    process_limiter: Arc<Semaphore>,
    process_limit: usize,
    executable: PathBuf,
    connect_params: DuckDbWorkerConnectParams,
    request_timeout: Duration,
    worker_start_timeout: Duration,
    next_id: AtomicU64,
}

#[derive(Default)]
struct WorkerProcessState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    connected: bool,
    generation: u64,
}

impl DuckDbWorkerClient {
    pub async fn open(
        path: String,
        attached_databases: Vec<AttachedDatabaseConfig>,
        init_script: Option<String>,
    ) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        Self::open_with_executable(executable, path, attached_databases, init_script).await
    }

    pub async fn open_with_process_limit(
        path: String,
        attached_databases: Vec<AttachedDatabaseConfig>,
        init_script: Option<String>,
        process_limit: usize,
    ) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        Self::open_with_executable_and_process_limit(executable, path, attached_databases, init_script, process_limit)
            .await
    }

    pub async fn open_with_executable(
        executable: PathBuf,
        path: String,
        attached_databases: Vec<AttachedDatabaseConfig>,
        init_script: Option<String>,
    ) -> Result<Self, String> {
        Self::open_with_executable_and_process_limit(
            executable,
            path,
            attached_databases,
            init_script,
            DUCKDB_WORKER_MAX_PROCESSES_DEFAULT,
        )
        .await
    }

    pub async fn open_with_executable_and_process_limit(
        executable: PathBuf,
        path: String,
        attached_databases: Vec<AttachedDatabaseConfig>,
        init_script: Option<String>,
        process_limit: usize,
    ) -> Result<Self, String> {
        let client = Self::new_unconnected_with_timeouts(
            executable,
            path,
            attached_databases,
            init_script,
            process_limit,
            DEFAULT_WORKER_REQUEST_TIMEOUT,
            DEFAULT_WORKER_START_WAIT,
        );
        client.ensure_connected().await?;
        Ok(client)
    }

    #[doc(hidden)]
    pub fn new_unconnected_with_timeouts(
        executable: PathBuf,
        path: String,
        attached_databases: Vec<AttachedDatabaseConfig>,
        init_script: Option<String>,
        process_limit: usize,
        request_timeout: Duration,
        worker_start_timeout: Duration,
    ) -> Self {
        let (process_limiter, process_limit) = duckdb_worker_process_limiter(process_limit);
        Self {
            inner: Arc::new(DuckDbWorkerClientInner {
                state: Mutex::new(WorkerProcessState::default()),
                pending: Arc::new(Mutex::new(HashMap::new())),
                connect_lock: Mutex::new(()),
                query_lock: Mutex::new(()),
                process_limiter,
                process_limit,
                executable,
                connect_params: DuckDbWorkerConnectParams { path, attached_databases, init_script },
                request_timeout,
                worker_start_timeout,
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub async fn execute(
        &self,
        database: Option<String>,
        sql: String,
        max_rows: Option<usize>,
        cancel_token: Option<CancellationToken>,
        query_timeout: Option<Duration>,
    ) -> Result<db::QueryResult, String> {
        let _query_guard = self.inner.query_lock.lock().await;
        let client = self.clone();
        // Cancellation and timeout restart the worker via cancel_or_kill below. An ordinary
        // query error (parser/binder/catalog/runtime) leaves the worker healthy, so we keep it
        // alive to preserve session-local state (:memory: contents, temp tables, SET, raw ATTACH).
        // The one exception is a poisoned connection: duckdb-rs can leave the connection unusable
        // after a syntax Parser Error, and the worker reports that with `duckdb_worker_poisoned`.
        // We kill on that code so the next request restarts a fresh worker. Killing here (rather
        // than letting the worker self-exit) avoids racing our own next request against a dying
        // worker, and OS-level kill never runs the destructor that would abort the process.
        let future = async move {
            client.ensure_connected().await?;
            match client
                .send_request_structured::<db::QueryResult>(
                    DuckDbWorkerMethod::Execute,
                    DuckDbWorkerExecuteParams { sql, database, max_rows },
                    None,
                )
                .await
            {
                Ok(result) => Ok(result),
                Err(error) => {
                    if error.code == DUCKDB_WORKER_POISONED_CODE {
                        client.kill().await;
                    }
                    Err(error.message)
                }
            }
        };
        tokio::pin!(future);

        match (cancel_token, query_timeout) {
            (Some(token), Some(duration)) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => self.cancel_or_kill(crate::query::canceled_error()).await,
                    result = &mut future => result,
                    _ = tokio::time::sleep(duration) => self.cancel_or_kill(crate::query::timeout_error()).await,
                }
            }
            (Some(token), None) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => self.cancel_or_kill(crate::query::canceled_error()).await,
                    result = &mut future => result,
                }
            }
            (None, Some(duration)) => {
                tokio::select! {
                    result = &mut future => result,
                    _ = tokio::time::sleep(duration) => self.cancel_or_kill(crate::query::timeout_error()).await,
                }
            }
            (None, None) => future.await,
        }
    }

    async fn cancel_or_kill(&self, final_error: String) -> Result<db::QueryResult, String> {
        let _ = self.cancel().await;
        Err(final_error)
    }

    pub async fn list_databases(&self) -> Result<Vec<db::DatabaseInfo>, String> {
        self.metadata_request(DuckDbWorkerMethod::ListDatabases, serde_json::json!({})).await
    }

    pub async fn list_schemas(&self, database: String) -> Result<Vec<String>, String> {
        self.metadata_request(DuckDbWorkerMethod::ListSchemas, serde_json::json!({ "database": database })).await
    }

    pub async fn list_tables(&self, database: String, schema: String) -> Result<Vec<db::TableInfo>, String> {
        self.metadata_request(
            DuckDbWorkerMethod::ListTables,
            serde_json::json!({ "database": database, "schema": schema }),
        )
        .await
    }

    pub async fn list_columns(
        &self,
        database: String,
        schema: String,
        table: String,
    ) -> Result<Vec<db::ColumnInfo>, String> {
        self.metadata_request(
            DuckDbWorkerMethod::ListColumns,
            serde_json::json!({ "database": database, "schema": schema, "table": table }),
        )
        .await
    }

    pub async fn get_object_source(
        &self,
        database: String,
        schema: String,
        name: String,
        object_type: db::ObjectSourceKind,
    ) -> Result<String, String> {
        self.metadata_request(
            DuckDbWorkerMethod::GetObjectSource,
            DuckDbWorkerObjectSourceParams { database, schema, name, object_type },
        )
        .await
    }

    pub async fn attach_database(&self, attached: AttachedDatabaseConfig) -> Result<(), String> {
        self.metadata_request::<serde_json::Value>(DuckDbWorkerMethod::AttachDatabase, attached).await?;
        Ok(())
    }

    /// Runs a metadata request that executes synchronously inside the worker's stdin loop.
    /// If it times out the worker is likely stuck inside DuckDB and can no longer read further
    /// requests, so we kill it; the next call restarts a fresh worker via `ensure_connected`.
    /// Ordinary errors (e.g. a missing table) leave the worker healthy and do not kill it.
    async fn metadata_request<T>(&self, method: DuckDbWorkerMethod, params: impl serde::Serialize) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
    {
        let timeout = self.inner.request_timeout;
        match tokio::time::timeout(timeout, self.request::<T>(method, params, None)).await {
            Ok(result) => result,
            Err(_) => {
                self.kill().await;
                Err(format!("DuckDB worker request timed out after {}s", timeout.as_secs()))
            }
        }
    }

    pub async fn cancel(&self) -> Result<(), String> {
        self.kill().await;
        Ok(())
    }

    pub async fn shutdown(&self) {
        let _ = self
            .send_request::<serde_json::Value>(
                DuckDbWorkerMethod::Shutdown,
                serde_json::json!({}),
                Some(self.inner.request_timeout),
            )
            .await;
        self.kill().await;
    }

    pub async fn kill(&self) {
        let (child, generation) = {
            let mut state = self.inner.state.lock().await;
            let child = state.child.take();
            let generation = state.generation;
            state.stdin = None;
            state.connected = false;
            (child, generation)
        };

        if let Some(mut child) = child {
            let _ = child.start_kill();
            match tokio::time::timeout(DEFAULT_WORKER_KILL_WAIT, child.wait()).await {
                Ok(Ok(status)) => log::info!("[duckdb-worker:kill:exit] status={status}"),
                Ok(Err(err)) => log::warn!("[duckdb-worker:kill:wait-failed] error={err}"),
                Err(_) => {
                    log::warn!("[duckdb-worker:kill:wait-timeout] wait_ms={}", DEFAULT_WORKER_KILL_WAIT.as_millis())
                }
            }
        }
        self.fail_pending_for_generation(generation, "duckdb_worker_killed", "DuckDB worker process was killed").await;
    }

    async fn request<T>(
        &self,
        method: DuckDbWorkerMethod,
        params: impl serde::Serialize,
        timeout: Option<Duration>,
    ) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
    {
        self.ensure_connected().await?;
        self.send_request(method, params, timeout).await
    }

    async fn ensure_connected(&self) -> Result<(), String> {
        let _guard = self.inner.connect_lock.lock().await;
        {
            let mut state = self.inner.state.lock().await;
            self.ensure_started_locked(&mut state).await?;
            if state.connected {
                return Ok(());
            }
        }

        let mut attempts = 0;
        loop {
            match self
                .send_request_structured::<serde_json::Value>(
                    DuckDbWorkerMethod::Connect,
                    self.inner.connect_params.clone(),
                    Some(self.inner.request_timeout),
                )
                .await
            {
                Ok(_) => break,
                Err(error) => {
                    let retry_delay = duckdb_connect_file_lock_retry_delay(attempts, &error.message);
                    // A failed Connect leaves this worker without a valid session. Keep no stale
                    // child around, especially after OS file-lock errors where the user may retry
                    // once the competing process exits.
                    self.kill().await;
                    if let Some(delay) = retry_delay {
                        attempts += 1;
                        log::warn!(
                            "[duckdb-worker:connect-retry] attempt={} delay_ms={} error={}",
                            attempts,
                            delay.as_millis(),
                            error.message
                        );
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    return Err(error.message);
                }
            }
        }

        let mut state = self.inner.state.lock().await;
        state.connected = true;
        Ok(())
    }

    async fn ensure_started_locked(&self, state: &mut WorkerProcessState) -> Result<(), String> {
        let should_restart = match state.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    log::warn!("[duckdb-worker:exit] status={status}");
                    true
                }
                Ok(None) => return Ok(()),
                Err(err) => {
                    log::warn!("[duckdb-worker:exit-check-failed] error={err}");
                    true
                }
            },
            None => true,
        };

        if should_restart {
            state.child = None;
            state.stdin = None;
            state.connected = false;
        }
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;

        let permit =
            tokio::time::timeout(self.inner.worker_start_timeout, self.inner.process_limiter.clone().acquire_owned())
                .await
                .map_err(|_| duckdb_worker_process_limit_error(self.inner.process_limit))?
                .map_err(|_| "DuckDB worker process limiter is closed".to_string())?;

        log::info!("[duckdb-worker:start] executable={}", self.inner.executable.display());
        let mut child = crate::process::new_tokio_command(&self.inner.executable)
            .arg("--duckdb-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start DuckDB worker: {e}"))?;

        let stdin = child.stdin.take().ok_or("DuckDB worker stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("DuckDB worker stdout unavailable")?;
        spawn_stdout_reader(stdout, self.inner.pending.clone(), generation, permit);

        state.child = Some(child);
        state.stdin = Some(stdin);
        state.connected = false;
        Ok(())
    }

    async fn send_request<T>(
        &self,
        method: DuckDbWorkerMethod,
        params: impl serde::Serialize,
        timeout: Option<Duration>,
    ) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
    {
        self.send_request_structured(method, params, timeout).await.map_err(|error| error.message)
    }

    /// Like `send_request` but preserves the worker error `code` so callers can react to
    /// specific conditions (e.g. `duckdb_worker_poisoned`). A protocol/transport failure is
    /// surfaced as an error with code `duckdb_worker_error`.
    async fn send_request_structured<T>(
        &self,
        method: DuckDbWorkerMethod,
        params: impl serde::Serialize,
        timeout: Option<Duration>,
    ) -> Result<T, DuckDbWorkerError>
    where
        T: serde::de::DeserializeOwned,
    {
        let id = format!("duckdb-worker-{}", self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let request = DuckDbWorkerRequest::new(&id, method, params)?;
        let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        let (tx, rx) = oneshot::channel();

        let write_result = async {
            let mut state = self.inner.state.lock().await;
            self.ensure_started_locked(&mut state).await?;
            if method != DuckDbWorkerMethod::Connect && !state.connected {
                return Err("DuckDB worker is not connected".to_string());
            }
            let generation = state.generation;
            self.inner.pending.lock().await.insert(id.clone(), PendingRequest { generation, sender: tx });
            let stdin = state.stdin.as_mut().ok_or("DuckDB worker stdin unavailable")?;
            stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
            stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
            stdin.flush().await.map_err(|e| e.to_string())
        }
        .await;

        if let Err(err) = write_result {
            self.inner.pending.lock().await.remove(&id);
            return Err(err.into());
        }

        let response = match timeout {
            Some(timeout) => match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => return Err("DuckDB worker response channel closed".into()),
                Err(_) => {
                    self.inner.pending.lock().await.remove(&id);
                    return Err(DuckDbWorkerError::new(
                        DUCKDB_WORKER_REQUEST_TIMEOUT_CODE,
                        format!("DuckDB worker request timed out after {}s", timeout.as_secs()),
                    ));
                }
            },
            None => rx.await.map_err(|_| DuckDbWorkerError::from("DuckDB worker response channel closed"))?,
        };

        if !response.ok {
            let error = response
                .error
                .unwrap_or_else(|| DuckDbWorkerError::new("duckdb_worker_error", "DuckDB worker request failed"));
            return Err(error);
        }

        let result = response.result.unwrap_or(serde_json::Value::Null);
        serde_json::from_value(result).map_err(|e| DuckDbWorkerError::from(e.to_string()))
    }

    async fn fail_pending_for_generation(&self, generation: u64, code: &'static str, message: &'static str) {
        let pending = {
            let mut pending = self.inner.pending.lock().await;
            let ids = pending
                .iter()
                .filter_map(|(id, request)| (request.generation == generation).then(|| id.clone()))
                .collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| pending.remove(&id).map(|request| (id, request.sender))).collect::<Vec<_>>()
        };
        for (id, sender) in pending {
            let _ = sender.send(DuckDbWorkerResponse::err(id, DuckDbWorkerError::new(code, message)));
        }
    }
}

struct WorkerProcessLimiterState {
    limit: usize,
    limiter: Arc<Semaphore>,
}

fn duckdb_worker_process_limiter(process_limit: usize) -> (Arc<Semaphore>, usize) {
    static LIMITER: OnceLock<StdMutex<WorkerProcessLimiterState>> = OnceLock::new();
    let process_limit = normalize_duckdb_worker_max_processes(process_limit);
    let state = LIMITER.get_or_init(|| {
        StdMutex::new(WorkerProcessLimiterState {
            limit: process_limit,
            limiter: Arc::new(Semaphore::new(process_limit)),
        })
    });
    let mut state = state.lock().expect("DuckDB worker process limiter lock poisoned");
    if state.limit != process_limit && state.limiter.available_permits() == state.limit {
        *state = WorkerProcessLimiterState { limit: process_limit, limiter: Arc::new(Semaphore::new(process_limit)) };
    }
    (state.limiter.clone(), state.limit)
}

fn duckdb_worker_process_limit_error(process_limit: usize) -> String {
    format!(
        "DuckDB worker process limit reached (max {}). Close another DuckDB worker connection or retry later.",
        process_limit
    )
}

fn duckdb_connect_file_lock_retry_delay(attempts: usize, message: &str) -> Option<Duration> {
    if !is_transient_duckdb_file_lock_error(message) {
        return None;
    }
    match attempts {
        0 => Some(Duration::from_millis(50)),
        1 => Some(Duration::from_millis(100)),
        2 => Some(Duration::from_millis(200)),
        3 => Some(Duration::from_millis(400)),
        4 => Some(Duration::from_millis(800)),
        _ => None,
    }
}

fn is_transient_duckdb_file_lock_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let mentions_file_open = lower.contains("cannot open file")
        || lower.contains("could not set lock")
        || lower.contains("file is already open");
    let mentions_lock = lower.contains("file is already open")
        || lower.contains("being used by another process")
        || lower.contains("conflicting lock")
        || lower.contains("process cannot access the file")
        || lower.contains("sharing violation")
        || lower.contains("resource temporarily unavailable")
        || message.contains("另一个程序正在使用")
        || message.contains("进程无法访问");
    mentions_file_open && mentions_lock
}

fn spawn_stdout_reader(
    stdout: tokio::process::ChildStdout,
    pending: PendingRequests,
    generation: u64,
    permit: OwnedSemaphorePermit,
) {
    tokio::spawn(async move {
        let _permit = permit;
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<DuckDbWorkerResponse>(&line) {
                        Ok(response) => {
                            let sender = {
                                let mut pending = pending.lock().await;
                                let matches_generation = pending
                                    .get(&response.id)
                                    .map(|request| request.generation == generation)
                                    .unwrap_or(false);
                                if matches_generation {
                                    pending.remove(&response.id).map(|request| request.sender)
                                } else {
                                    None
                                }
                            };
                            if let Some(sender) = sender {
                                let _ = sender.send(response);
                            }
                        }
                        Err(err) => {
                            log::warn!("[duckdb-worker:invalid-response] error={err} line={line}");
                        }
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    log::warn!("[duckdb-worker:stdout-error] error={err}");
                    break;
                }
            }
        }

        let pending = {
            let mut pending = pending.lock().await;
            let ids = pending
                .iter()
                .filter_map(|(id, request)| (request.generation == generation).then(|| id.clone()))
                .collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| pending.remove(&id).map(|request| (id, request.sender))).collect::<Vec<_>>()
        };
        for (id, sender) in pending {
            let _ = sender.send(DuckDbWorkerResponse::err(
                id,
                DuckDbWorkerError::new("duckdb_worker_exited", "DuckDB worker process exited"),
            ));
        }
    });
}
