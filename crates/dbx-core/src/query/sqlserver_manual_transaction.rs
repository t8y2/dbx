//! Interactive SQL Server transactions own one isolated TDS/JDBC session.
//! An invalid session is never reconnected or replayed. Only acknowledged
//! COMMIT/ROLLBACK responses establish a known database outcome.
use super::*;
use crate::backend_error::{BackendError, ManualTransactionFailureKind as Kind, TransactionOutcome as Outcome};
use crate::connection::ConnectionLifecycleSnapshot;
use crate::query_cancel::RunningTaskMetadata;
use serde::{Deserialize, Serialize};
use std::sync::Mutex as StdMutex;
use std::time::Instant;

// Wire-level fault tests arm a scoped proxy at the exact operation boundary.
// This module and every call site are absent from normal desktop builds.
#[cfg(feature = "test-support")]
pub mod live_test_hooks {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    #[derive(Clone, Copy, Hash, Eq, PartialEq)]
    pub enum Phase {
        BeforeCommit,
        BeforeRollback,
        AfterCommitAck,
    }
    type Hook = Box<dyn FnOnce() + Send>;
    type Hooks = HashMap<(String, Phase), Hook>;
    fn hooks() -> &'static Mutex<Hooks> {
        static HOOKS: OnceLock<Mutex<Hooks>> = OnceLock::new();
        HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
    }
    pub struct Guard(String, Phase);
    impl Drop for Guard {
        fn drop(&mut self) {
            hooks().lock().unwrap().remove(&(self.0.clone(), self.1));
        }
    }
    pub fn install(id: &str, phase: Phase, hook: impl FnOnce() + Send + 'static) -> Guard {
        assert!(hooks().lock().unwrap().insert((id.to_owned(), phase), Box::new(hook)).is_none());
        Guard(id.to_owned(), phase)
    }
    pub(crate) fn run(id: &str, phase: Phase) {
        let hook = hooks().lock().unwrap().remove(&(id.to_owned(), phase));
        if let Some(hook) = hook {
            hook();
        }
    }
}
const PREFIX: &str = "sqlserver-txn-";
const ERROR_PREFIX: &str = "DBX_MANUAL_TRANSACTION_ERROR:";
const IDLE: Duration = Duration::from_secs(MANUAL_TRANSACTION_IDLE_TIMEOUT_SECS);
const MAX_ENDED_SESSIONS: usize = 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Failure {
    kind: Kind,
    outcome: Outcome,
    detail: String,
}
impl Failure {
    fn new(kind: Kind, outcome: Outcome, detail: impl Into<String>) -> Self {
        Self { kind, outcome, detail: detail.into() }
    }
    fn encode(&self) -> String {
        format!("{ERROR_PREFIX}{}", serde_json::to_string(self).expect("transaction error serializes"))
    }
}

/// Preserve the existing core String API, but return a typed envelope at the
/// desktop boundary. This marker is never rendered by the frontend.
pub fn backend_error(error: &str) -> Option<BackendError> {
    let failure: Failure = serde_json::from_str(error.strip_prefix(ERROR_PREFIX)?).ok()?;
    Some(BackendError::from_manual_transaction_failure(failure.kind, failure.outcome, &failure.detail))
}

#[derive(Default)]
pub struct EndedSessions {
    entries: HashMap<String, (Instant, Failure)>,
    cleanup_started: bool,
}
impl EndedSessions {
    fn prune(&mut self) {
        self.entries.retain(|_, (time, _)| time.elapsed() < IDLE);
    }
    fn record(&mut self, id: &str, failure: Failure) {
        self.prune();
        if self.entries.len() >= MAX_ENDED_SESSIONS {
            if let Some(oldest) = self.entries.iter().min_by_key(|(_, (time, _))| *time).map(|(id, _)| id.clone()) {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(id.to_owned(), (Instant::now(), failure));
    }
    fn missing(&mut self, id: &str) -> String {
        self.prune();
        self.entries.get(id).map(|(_, error)| error.encode()).unwrap_or_else(|| {
            Failure::new(
                Kind::ConnectionLost,
                Outcome::Unknown,
                "The transaction session is no longer available; its outcome cannot be confirmed",
            )
            .encode()
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct DriverInfo {
    pub server_version: Option<String>,
    pub product_type: Option<String>,
    pub driver_name: String,
    pub driver_version: Option<String>,
}

#[derive(Clone)]
pub struct SessionMetadata {
    pub lifecycle: ConnectionLifecycleSnapshot,
    pub driver: DriverInfo,
    ends: Arc<StdMutex<EndedSessions>>,
}
impl SessionMetadata {
    fn record(&self, id: &str, failure: Failure) {
        self.ends.lock().unwrap_or_else(|e| e.into_inner()).record(id, failure);
    }
}

pub fn is_session_id(id: &str) -> bool {
    id.starts_with(PREFIX)
}
fn missing(state: &AppState, id: &str) -> String {
    state.sqlserver_transaction_ends.lock().unwrap_or_else(|e| e.into_inner()).missing(id)
}
fn failure(kind: Kind, outcome: Outcome, detail: impl Into<String>) -> String {
    Failure::new(kind, outcome, detail).encode()
}

fn start_terminal_reason_cleanup(ends: &Arc<StdMutex<EndedSessions>>) {
    {
        let mut map = ends.lock().unwrap_or_else(|e| e.into_inner());
        if map.cleanup_started {
            return;
        }
        map.cleanup_started = true;
    }
    let ends = Arc::downgrade(ends);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(ends) = ends.upgrade() else {
                return;
            };
            ends.lock().unwrap_or_else(|e| e.into_inner()).prune();
        }
    });
}

pub async fn begin(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<String, String> {
    start_terminal_reason_cleanup(&state.sqlserver_transaction_ends);
    let lifecycle = state.connection_lifecycle_snapshot(connection_id);
    let database_context = query_pool_database(database, catalog);
    let client_session_id = format!("manual-txn-{}", uuid::Uuid::new_v4());
    // Own the routing key before creating the pool: cancellation during the
    // connection handshake must also clean up a late pool installation.
    let cleanup_guard = state
        .workload_session_pool_cleanup_guard(connection_id, database_context, &client_session_id)
        .await
        .ok_or_else(|| {
            failure(Kind::Unsupported, Outcome::Unknown, "SQL Server requires an isolated transaction connection")
        })?;
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, database_context, Some(&client_session_id))
        .await
        .map_err(|e| failure(Kind::ConnectionLost, Outcome::Unknown, e))?;
    let pool = state.pool_handle(&pool_key).await;
    let mut conn = match pool {
        Some(PoolKind::SqlServer(client)) => TxnConnection::SqlServer {
            client: Some(client),
            client_session_id,
            database: database_context.map(str::to_owned),
            cleanup_guard,
        },
        Some(PoolKind::Agent(client)) => TxnConnection::Agent {
            client,
            client_session_id,
            database: database_context.map(str::to_owned),
            cleanup_guard,
        },
        _ => {
            return Err(failure(
                Kind::Unsupported,
                Outcome::Unknown,
                "The selected SQL Server driver does not implement manual transactions",
            ))
        }
    };
    let begin = async {
        match &mut conn {
            TxnConnection::SqlServer { client: Some(client), .. } => {
                let mut client = client.lock().await;
                let info = db::sqlserver::execute_simple_batch_with_max_rows_metadata(&mut client,
                    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), CAST(SERVERPROPERTY('Edition') AS nvarchar(128))", Some(1)).await?;
                let row = info.iter().find_map(|result| result.result.rows.first());
                let driver = DriverInfo {
                    server_version: row
                        .and_then(|row| row.first())
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    product_type: row.and_then(|row| row.get(1)).and_then(serde_json::Value::as_str).map(str::to_owned),
                    driver_name: "tiberius (native TDS)".to_owned(),
                    driver_version: None,
                };
                let status = db::sqlserver::manual_transaction_status(&mut client).await?;
                if status.count != 0 {
                    return Err("The new SQL Server connection already owns a transaction".to_owned());
                }
                db::sqlserver::execute_simple_batch_with_max_rows_metadata(&mut client, "BEGIN TRANSACTION", Some(1))
                    .await?;
                require_native_transaction(&mut client).await?;
                Ok(driver)
            }
            TxnConnection::Agent { client, .. } => {
                let mut client = client.lock().await;
                let info = client.begin_manual_transaction::<serde_json::Value>(None).await?;
                if info.get("manualTransactionBatch").and_then(serde_json::Value::as_bool) != Some(true) {
                    return Err("DBX_MANUAL_TRANSACTION_UNSUPPORTED: Update the SQL Server legacy component to enable safe manual transaction batches".to_owned());
                }
                client.enable_dedicated_transaction_query_cancellation();
                if let Some(info) = info.as_object() {
                    log::info!(
                        "[manual-txn:sqlserver:jdbc] product_version={:?} driver={:?} driver_version={:?}",
                        info.get("productVersion"),
                        info.get("driverName"),
                        info.get("driverVersion")
                    );
                }
                Ok(DriverInfo {
                    server_version: info.get("productVersion").and_then(serde_json::Value::as_str).map(str::to_owned),
                    product_type: info.get("productType").and_then(serde_json::Value::as_str).map(str::to_owned),
                    driver_name: info
                        .get("driverName")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("SQL Server JDBC")
                        .to_owned(),
                    driver_version: info.get("driverVersion").and_then(serde_json::Value::as_str).map(str::to_owned),
                })
            }
            _ => unreachable!(),
        }
    };
    let result = tokio::select! {
        biased;
        _ = lifecycle.cancellation().cancelled() => Err("Connection changed while the transaction was opening".to_owned()),
        result = tokio::time::timeout(db::connection_timeout(), begin) => result.unwrap_or_else(|_| Err("Opening the transaction timed out".to_owned())),
    };
    let driver = match result {
        Ok(driver) => driver,
        Err(error) => {
            // BEGIN may have reached the server. Drop the isolated connection;
            // never issue another command on an interrupted response stream.
            let kind = if error.contains("DBX_MANUAL_TRANSACTION_UNSUPPORTED") {
                Kind::Unsupported
            } else if is_connection_error(&error)
                || lifecycle.cancellation().is_cancelled()
                || error.contains("timed out")
            {
                Kind::ConnectionLost
            } else {
                Kind::ExecutionFailed
            };
            release_manual_txn_session_pool(state, connection_id, &mut conn).await;
            return Err(failure(kind, Outcome::Unknown, error));
        }
    };
    log::info!(
        "[manual-txn:sqlserver] version={:?} product={:?} driver={} driver_version={:?}",
        driver.server_version,
        driver.product_type,
        driver.driver_name,
        driver.driver_version
    );
    let id = format!("{PREFIX}{}", uuid::Uuid::new_v4());
    let metadata = SessionMetadata { lifecycle, driver, ends: state.sqlserver_transaction_ends.clone() };
    let session = TransactionSession {
        sqlserver: Some(metadata.clone()),
        connection: Arc::new(tokio::sync::Mutex::new(conn)),
        pool_key,
        last_activity: Instant::now(),
        busy: false,
        snapshot_rotation_safe: false,
        connection_id: connection_id.to_owned(),
        database: database.to_owned(),
        schema: schema.map(str::to_owned),
    };
    {
        let mut sessions = state.transaction_sessions.write().await;
        if !state.connection_lifecycle_is_current(connection_id, &metadata.lifecycle) {
            return Err(failure(
                Kind::ContextChanged,
                Outcome::Unknown,
                "Connection changed while the transaction was opening",
            ));
        }
        sessions.insert(id.clone(), session);
    }
    spawn_idle_watcher(state.transaction_sessions.clone(), id.clone());
    Ok(id)
}

async fn require_native_transaction(client: &mut db::sqlserver::SqlServerClient) -> Result<(), String> {
    let status = db::sqlserver::manual_transaction_status(client).await?;
    if !status.is_active() {
        return Err(format!(
            "SQL Server transaction state changed (count={}, state={:?}); the session cannot continue",
            status.count, status.xact_state
        ));
    }
    Ok(())
}

/// A request dropped before it reaches its normal terminal path must discard
/// its connection rather than leave a busy, possibly half-consumed session.
struct ExecutionGuard {
    sessions: Arc<tokio::sync::RwLock<HashMap<String, TransactionSession>>>,
    id: String,
    armed: bool,
}
impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let sessions = self.sessions.clone();
        let id = self.id.clone();
        tokio::spawn(async move {
            let session = {
                let mut sessions = sessions.write().await;
                sessions.remove(&id)
            };
            if let Some(session) = session {
                if let Some(meta) = &session.sqlserver {
                    meta.record(
                        &id,
                        Failure::new(Kind::ConnectionLost, Outcome::Unknown, "Transaction request was interrupted"),
                    );
                }
                // The owned Agent RPC task consumes its cancellation corridor.
                // Waiting for its client lock prevents pool close from killing it
                // before both replies arrive; never send a competing cancel RPC.
                {
                    let mut conn = session.connection.lock().await;
                    interrupt_fixed_connection(&mut conn).await;
                }
                drop(session);
            }
        });
    }
}

/// TCP FIN alone need not stop a SQL2000 batch immediately. ATTENTION is
/// best effort, never proof of rollback; callers always discard the connection.
/// The wire call needs the vendored tiberius (dbx-driver-sqlserver feature
/// `native-attention`); standalone crates.io builds no-op inside the client.
async fn send_native_attention(conn: &mut TxnConnection) {
    if let TxnConnection::SqlServer { client: Some(client), .. } = conn {
        let attention = async { client.lock().await.send_attention().await };
        let _ = tokio::time::timeout(db::connection_timeout().min(Duration::from_secs(5)), attention).await;
    }
}

/// Dropping the outer request cancels the owned JDBC RPC, without dropping
/// its response reader or aborting the bounded cancellation corridor.
struct AgentQueryCancellation(Option<tokio_util::sync::CancellationToken>);
impl Drop for AgentQueryCancellation {
    fn drop(&mut self) {
        if let Some(token) = &self.0 {
            token.cancel();
        }
    }
}

async fn interrupt_fixed_connection(conn: &mut TxnConnection) {
    send_native_attention(conn).await;
    if let TxnConnection::Agent { client, .. } = conn {
        // The owned RPC holds this lock until query + cancel replies, or until
        // its bounded cancellation grace kills an unresponsive dedicated Agent.
        let _finished = client.lock().await;
    }
}

struct CancellationRelay(tokio::task::JoinHandle<()>);
impl Drop for CancellationRelay {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub async fn execute(
    state: &AppState,
    id: &str,
    sql: &str,
    database: &str,
    schema: Option<&str>,
    options: ManualTransactionExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, String> {
    let batches = split_sql_batches(sql);
    if batches.iter().any(|batch| db::sqlserver::manual_transaction_control_conflict(batch)) {
        return Err(failure(
            Kind::ControlConflict,
            Outcome::Unknown,
            "Transaction control and USE are managed by the manual transaction session",
        ));
    }
    let (connection, metadata, connection_id, pool_key, expired, context_changed) = {
        let mut sessions = state.transaction_sessions.write().await;
        let session = sessions.get_mut(id).ok_or_else(|| missing(state, id))?;
        let metadata = session.sqlserver.clone().expect("SQL Server session metadata");
        if session.busy {
            return Err(failure(Kind::Busy, Outcome::Unknown, "The transaction is currently executing"));
        }
        let context_changed = session.database != database || session.schema.as_deref() != schema;
        let expired = session.last_activity.elapsed() >= IDLE;
        session.busy = true;
        (
            session.connection.clone(),
            metadata,
            session.connection_id.clone(),
            session.pool_key.clone(),
            expired,
            context_changed,
        )
    };
    let mut guard = ExecutionGuard { sessions: state.transaction_sessions.clone(), id: id.to_owned(), armed: true };
    let mut conn = connection.lock().await;
    if context_changed || expired || metadata.lifecycle.cancellation().is_cancelled() {
        state.transaction_sessions.write().await.remove(id);
        let error = cleanup_failure(
            state,
            id,
            &connection_id,
            &mut conn,
            &metadata,
            if context_changed {
                Kind::ContextChanged
            } else if expired {
                Kind::IdleTimeout
            } else {
                Kind::ConnectionLost
            },
            "The transaction session ended before execution",
            false,
        )
        .await;
        guard.armed = false;
        return Err(error);
    }
    if let Err(error) = check_read_only_for_connection_multi(state, &pool_key, &batches).await {
        if let Some(session) = state.transaction_sessions.write().await.get_mut(id) {
            session.busy = false;
        }
        guard.armed = false;
        return Err(failure(Kind::ControlConflict, Outcome::Unknown, error));
    }
    let registered = options.execution_id.as_ref().map(|execution_id| {
        let registered = state.running_queries.register_task_for_terminal_confirmation(
            execution_id.clone(),
            RunningTaskMetadata::query(connection_id.clone(), database.to_owned(), None),
        );
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
        Arc::new(registered)
    });
    let token = registered.as_ref().map(|query| query.token()).unwrap_or_default();
    let timeout = resolve_query_timeout(options.timeout_secs);
    let agent_transport = matches!(&*conn, TxnConnection::Agent { .. });
    let run = async {
        let mut results = Vec::new();
        for batch in &batches {
            let rewritten = sql_for_execution_context_with_identifier_quote(
                Some(DatabaseType::SqlServer),
                batch,
                schema,
                Some("["),
            );
            match &mut *conn {
                TxnConnection::SqlServer { client: Some(client), .. } => {
                    let mut client = client.lock().await;
                    let batch_results = db::sqlserver::execute_simple_batch_with_max_rows_metadata(
                        &mut client,
                        &rewritten,
                        options.max_rows,
                    )
                    .await?;
                    results.extend(sqlserver_batch_results(batch_results));
                    require_native_transaction(&mut client).await?;
                }
                TxnConnection::Agent { client, .. } => {
                    let opts = manual_txn_agent_query_options(
                        options.max_rows.unwrap_or(MAX_ROWS),
                        options.table_data_preview,
                        None,
                        None,
                    );
                    let mut params =
                        agent_execute_query_params(&rewritten, Some(database).filter(|d| !d.is_empty()), None, opts);
                    params["timeoutSecs"] = serde_json::json!(timeout.map(|t| t.as_secs()).unwrap_or(0));
                    params["returnAllResults"] = serde_json::json!(true);
                    let client = client.clone();
                    let cancellation = token.clone();
                    let completion = registered.clone();
                    let mut drop_cancellation = AgentQueryCancellation(Some(token.clone()));
                    let task = tokio::spawn(async move {
                        // Keep terminal confirmation pending while JDBC is still
                        // executing or cancelling after the outer future is dropped.
                        let _completion = completion;
                        let mut client = client.lock().await;
                        client
                            .call_with_timeout_and_cancel::<Vec<db::QueryResult>>(
                                "execute_query",
                                params,
                                timeout,
                                Some(cancellation),
                            )
                            .await
                    });
                    let result = task.await;
                    drop_cancellation.0 = None;
                    let batch_results =
                        result.map_err(|error| format!("SQL Server Agent query task failed: {error}"))??;
                    results.extend(batch_results.into_iter().map(|result| {
                        ExecuteMultiResult::success_with_optional_server_large_values(
                            result,
                            options.table_data_preview,
                        )
                    }));
                }
                _ => return Err("The SQL Server transaction connection is no longer available".to_owned()),
            }
        }
        if results.is_empty() {
            results.push(empty_query_result(0).into());
        }
        Ok(results)
    };
    let result = if agent_transport {
        // Let the Agent corridor consume cancellation and timeout itself. An
        // outer select would drop its future before it sends cancel_session.
        let lifecycle = metadata.lifecycle.cancellation().clone();
        let cancellation = token.clone();
        let relay = CancellationRelay(tokio::spawn(async move {
            match timeout {
                Some(timeout) => tokio::select! {
                    _ = lifecycle.cancelled() => {},
                    _ = tokio::time::sleep(timeout) => {},
                },
                None => lifecycle.cancelled().await,
            }
            cancellation.cancel();
        }));
        let result = run.await;
        drop(relay);
        result
    } else {
        tokio::select! {
            biased;
            _ = metadata.lifecycle.cancellation().cancelled() => Err("SQL Server connection was disconnected".to_owned()),
            result = wait_for_result_opt(Some(token.clone()), timeout, run) => result,
        }
    };
    match result {
        Ok(results) => {
            let mut sessions = state.transaction_sessions.write().await;
            if let Some(session) = sessions.get_mut(id) {
                session.busy = false;
                session.last_activity = Instant::now();
                guard.armed = false;
                Ok(results)
            } else {
                guard.armed = false;
                Err(failure(Kind::ConnectionLost, Outcome::Unknown, "Connection ended while the query was executing"))
            }
        }
        Err(error) => {
            // Interrupted streams are poisoned: never send ROLLBACK through
            // unread TDS packets. Detaching closes this exact dedicated session.
            let interrupted = token.is_cancelled()
                || metadata.lifecycle.cancellation().is_cancelled()
                || error.contains("DBX_MANUAL_TRANSACTION_STATE_LOST")
                || error.contains("count=0")
                || is_connection_error(&error)
                || error.to_ascii_lowercase().contains("timed out")
                || error.to_ascii_lowercase().contains("timeout");
            state.transaction_sessions.write().await.remove(id);
            if token.is_cancelled()
                || metadata.lifecycle.cancellation().is_cancelled()
                || error.to_ascii_lowercase().contains("timed out")
                || error.to_ascii_lowercase().contains("timeout")
            {
                send_native_attention(&mut conn).await;
            }
            let encoded = cleanup_failure(
                state,
                id,
                &connection_id,
                &mut conn,
                &metadata,
                if interrupted { Kind::ConnectionLost } else { Kind::ExecutionFailed },
                &error,
                interrupted,
            )
            .await;
            guard.armed = false;
            Err(encoded)
        }
    }
}

async fn rollback_fixed_connection(conn: &mut TxnConnection) -> Result<(), String> {
    // The generic Agent helper intentionally tolerates an already-ended
    // transaction for other dialects. SQL Server needs a positive acknowledgment.
    match conn {
        TxnConnection::Agent { client, .. } => {
            client.lock().await.rollback_manual_transaction::<serde_json::Value>().await.map(|_| ())
        }
        _ => rollback_manual_txn_connection(conn).await,
    }
}

async fn cleanup_failure(
    state: &AppState,
    id: &str,
    connection_id: &str,
    conn: &mut TxnConnection,
    metadata: &SessionMetadata,
    kind: Kind,
    detail: &str,
    discard: bool,
) -> String {
    let result = if discard {
        None
    } else {
        Some(tokio::time::timeout(db::connection_timeout(), rollback_fixed_connection(conn)).await)
    };
    let (kind, outcome, detail) = match result {
        Some(Ok(Ok(()))) => (kind, Outcome::RolledBack, detail.to_owned()),
        Some(Ok(Err(error))) => (Kind::RollbackFailed, Outcome::Unknown, format!("{detail}; rollback failed: {error}")),
        Some(Err(_)) => (Kind::RollbackFailed, Outcome::Unknown, format!("{detail}; rollback timed out")),
        None => (kind, Outcome::Unknown, detail.to_owned()),
    };
    release_manual_txn_session_pool(state, connection_id, conn).await;
    if let TxnConnection::SqlServer { client, .. } = conn {
        *client = None;
    }
    let error = Failure::new(kind, outcome, detail);
    metadata.record(id, error.clone());
    error.encode()
}

pub async fn finish(state: &AppState, id: &str, commit: bool) -> Result<db::QueryResult, String> {
    let session = {
        let mut sessions = state.transaction_sessions.write().await;
        let session = sessions.get(id).ok_or_else(|| missing(state, id))?;
        if session.busy {
            return Err(failure(Kind::Busy, Outcome::Unknown, "The transaction is currently executing"));
        }
        sessions.remove(id).expect("checked session")
    };
    let metadata = session.sqlserver.as_ref().expect("SQL Server session metadata");
    let mut conn = session.connection.lock().await;
    if metadata.lifecycle.cancellation().is_cancelled() || session.last_activity.elapsed() >= IDLE {
        let error = cleanup_failure(
            state,
            id,
            &session.connection_id,
            &mut conn,
            metadata,
            if metadata.lifecycle.cancellation().is_cancelled() { Kind::ConnectionLost } else { Kind::IdleTimeout },
            "The transaction ended before it could be committed",
            false,
        )
        .await;
        return Err(error);
    }
    // Missing requests during COMMIT must already see an unknown outcome.
    metadata.record(
        id,
        Failure::new(
            if commit { Kind::CommitUnknown } else { Kind::RollbackFailed },
            Outcome::Unknown,
            "The transaction is ending",
        ),
    );
    let operation = async {
        if !commit {
            return rollback_fixed_connection(&mut conn).await;
        }
        match &mut *conn {
            TxnConnection::SqlServer { client: Some(client), .. } => {
                let mut client = client.lock().await;
                require_native_transaction(&mut client).await?;
                #[cfg(feature = "test-support")]
                live_test_hooks::run(id, live_test_hooks::Phase::BeforeCommit);
                db::sqlserver::execute_simple_batch_with_max_rows_metadata(&mut client, "COMMIT TRANSACTION", Some(1))
                    .await
                    .map(|_| ())
            }
            TxnConnection::Agent { client, .. } => {
                client.lock().await.commit_manual_transaction::<serde_json::Value>().await.map(|_| ())
            }
            _ => Err("Transaction connection was discarded".to_owned()),
        }
    };
    let result = tokio::time::timeout(db::connection_timeout(), operation).await;
    if matches!(result, Ok(Ok(()))) {
        metadata.record(
            id,
            Failure::new(
                Kind::ContextChanged,
                if commit { Outcome::Committed } else { Outcome::RolledBack },
                "The transaction has already ended",
            ),
        );
    }
    #[cfg(feature = "test-support")]
    if commit && matches!(result, Ok(Ok(()))) {
        live_test_hooks::run(id, live_test_hooks::Phase::AfterCommitAck);
    }
    // Release only this workload connection. A successful COMMIT stays
    // successful even if closing that connection subsequently fails.
    release_manual_txn_session_pool(state, &session.connection_id, &mut conn).await;
    if let TxnConnection::SqlServer { client, .. } = &mut *conn {
        *client = None;
    }
    match result {
        Ok(Ok(())) => {
            metadata.record(
                id,
                Failure::new(
                    Kind::ContextChanged,
                    if commit { Outcome::Committed } else { Outcome::RolledBack },
                    "The transaction has already ended",
                ),
            );
            Ok(empty_query_result(0))
        }
        result => {
            let detail = match result {
                Ok(Err(error)) => error,
                Err(_) => "Ending the transaction timed out".to_owned(),
                _ => unreachable!(),
            };
            let error =
                Failure::new(if commit { Kind::CommitUnknown } else { Kind::RollbackFailed }, Outcome::Unknown, detail);
            metadata.record(id, error.clone());
            Err(error.encode())
        }
    }
}

pub async fn disconnect(state: &AppState, id: &str, session: TransactionSession) {
    let metadata = session.sqlserver.as_ref().expect("SQL Server session metadata");
    metadata.record(id, Failure::new(Kind::ConnectionLost, Outcome::Unknown, "The connection was disconnected"));
    // Lifecycle cancellation releases an executing request's lock first.
    let mut conn = session.connection.lock().await;
    if session.busy {
        // The map may already belong to disconnect when ExecutionGuard runs.
        // This owner must also interrupt a dropped native request before FIN.
        interrupt_fixed_connection(&mut conn).await;
    }
    let _ = cleanup_failure(
        state,
        id,
        &session.connection_id,
        &mut conn,
        metadata,
        Kind::ConnectionLost,
        "The connection was disconnected",
        session.busy,
    )
    .await;
}

fn spawn_idle_watcher(sessions: Arc<tokio::sync::RwLock<HashMap<String, TransactionSession>>>, id: String) {
    tokio::spawn(async move {
        loop {
            let delay = {
                let map = sessions.read().await;
                let Some(session) = map.get(&id) else {
                    return;
                };
                if session.busy {
                    Duration::from_secs(1)
                } else {
                    IDLE.saturating_sub(session.last_activity.elapsed())
                }
            };
            tokio::time::sleep(delay).await;
            let removed = {
                let mut map = sessions.write().await;
                match map.get(&id) {
                    Some(session) if !session.busy && session.last_activity.elapsed() >= IDLE => map.remove(&id),
                    None => return,
                    _ => None,
                }
            };
            if let Some(session) = removed {
                let metadata = session.sqlserver.as_ref().expect("SQL Server session metadata");
                metadata.record(
                    &id,
                    Failure::new(Kind::IdleTimeout, Outcome::Unknown, "The idle transaction is being closed"),
                );
                let mut conn = session.connection.lock().await;
                let outcome =
                    match tokio::time::timeout(db::connection_timeout(), rollback_fixed_connection(&mut conn)).await {
                        Ok(Ok(())) => Failure::new(
                            Kind::IdleTimeout,
                            Outcome::RolledBack,
                            "Transaction rolled back after five minutes of inactivity",
                        ),
                        Ok(Err(error)) => Failure::new(
                            Kind::RollbackFailed,
                            Outcome::Unknown,
                            format!("Idle transaction rollback could not be confirmed: {error}"),
                        ),
                        Err(_) => {
                            Failure::new(Kind::RollbackFailed, Outcome::Unknown, "Idle transaction rollback timed out")
                        }
                    };
                metadata.record(&id, outcome);
                // The dedicated guard also detaches the pool when this task ends.
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_is_not_idle_rollback_and_terminal_outcomes_are_preserved() {
        let mut ended = EndedSessions::default();
        let missing = backend_error(&ended.missing("sqlserver-txn-missing")).unwrap();
        let json = serde_json::to_value(missing).unwrap();
        assert_eq!(json["code"], "DBX-TXN-1005");
        assert_eq!(json["transactionOutcome"], "unknown");
        ended.record(
            "sqlserver-txn-committed",
            Failure::new(Kind::ContextChanged, Outcome::Committed, "Already committed"),
        );
        let json = serde_json::to_value(backend_error(&ended.missing("sqlserver-txn-committed")).unwrap()).unwrap();
        assert_eq!(json["transactionOutcome"], "committed");
    }
    #[test]
    fn terminal_reason_history_is_bounded_and_expires() {
        let mut ended = EndedSessions::default();
        for index in 0..MAX_ENDED_SESSIONS + 4 {
            ended.record(&format!("{PREFIX}{index}"), Failure::new(Kind::IdleTimeout, Outcome::RolledBack, "Idle"));
        }
        assert_eq!(ended.entries.len(), MAX_ENDED_SESSIONS);
        ended.entries.insert(
            "old".into(),
            (Instant::now() - IDLE, Failure::new(Kind::IdleTimeout, Outcome::RolledBack, "Idle")),
        );
        assert!(ended.missing("old").contains("connection_lost"));
        assert!(!ended.entries.contains_key("old"));
    }

    async fn mock_session(rollback_fails: bool, commit_fails: bool) -> (Arc<AppState>, String, tempfile::TempDir) {
        use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, PooledAgentClient};
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.py");
        let events = dir.path().join("events.jsonl");
        std::fs::write(
            &script,
            r#"import json, sys, time
log = sys.argv[1]
rollback_fails = sys.argv[2] == 'true'
commit_fails = sys.argv[3] == 'true'
print(json.dumps({'ready':True}), flush=True)
pending = None
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    params = request.get('params', {})
    with open(log, 'a') as output:
        output.write(json.dumps({'method':method, 'params':params}) + '\n')
    if method == 'handshake':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session']}}), flush=True)
        continue
    if method == 'execute_query' and params.get('sql') == 'DELAYED_CANCEL':
        pending = request['id']
        continue
    if method == 'cancel_session' and pending is not None:
        assert params['agentSessionId'] == '__legacy__'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'ok':True}}), flush=True)
        time.sleep(0.4)
        with open(log, 'a') as output:
            output.write(json.dumps({'method':'cancel_completed'}) + '\n')
        print(json.dumps({'jsonrpc':'2.0','id':pending,'error':{'code':-1,'message':'Query cancelled'}}), flush=True)
        pending = None
        continue
    sql = params.get('sql','')
    error = None
    if method == 'execute_query':
        if not params.get('returnAllResults'): error = 'batch mode missing'
        elif 'RAISE_ERROR' in sql: error = 'server rejected SQL'
        elif 'STATE_LOST' in sql: error = 'DBX_MANUAL_TRANSACTION_STATE_LOST: hidden commit'
        elif 'SHORT_SLOW' in sql: time.sleep(0.65)
        elif 'SLOW' in sql: time.sleep(2)
        result = [{'columns':['sql'], 'rows':[[sql]], 'affected_rows':0, 'execution_time_ms':1}]
    else:
        result = {'ok':True}
    if method == 'rollback_manual_transaction' and rollback_fails: error = 'rollback rejected'
    if method == 'commit_manual_transaction' and commit_fails: error = 'commit response unavailable'
    response = {'jsonrpc':'2.0', 'id':request['id']}
    if error: response['error'] = {'code':-32000, 'message':error}
    else: response['result'] = result
    print(json.dumps(response), flush=True)
"#,
        )
        .unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let client = AgentDriverClient::spawn(AgentLaunchSpec::new(python).with_args([
            script.to_string_lossy().to_string(),
            events.to_string_lossy().to_string(),
            rollback_fails.to_string(),
            commit_fails.to_string(),
        ]))
        .await
        .unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let config: crate::models::connection::ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id":"mock-sqlserver", "name":"mock", "db_type":"sqlserver", "host":"localhost", "port":1433,
            "username":"", "password":"", "query_timeout_secs":30, "keepalive_interval_secs":0
        }))
        .unwrap();
        state.configs.write().await.insert(config.id.clone(), config);
        let client_session_id = format!("manual-txn-{}", uuid::Uuid::new_v4());
        let cleanup_guard =
            state.workload_session_pool_cleanup_guard("mock-sqlserver", Some("db"), &client_session_id).await.unwrap();
        let id = format!("{PREFIX}{}", uuid::Uuid::new_v4());
        state.transaction_sessions.write().await.insert(
            id.clone(),
            TransactionSession {
                sqlserver: Some(SessionMetadata {
                    lifecycle: state.connection_lifecycle_snapshot("mock-sqlserver"),
                    driver: DriverInfo::default(),
                    ends: state.sqlserver_transaction_ends.clone(),
                }),
                connection: Arc::new(tokio::sync::Mutex::new(TxnConnection::Agent {
                    client: Arc::new(PooledAgentClient::new(client)),
                    client_session_id,
                    database: Some("db".to_owned()),
                    cleanup_guard,
                })),
                pool_key: "mock-sqlserver".to_owned(),
                last_activity: Instant::now(),
                busy: false,
                snapshot_rotation_safe: false,
                connection_id: "mock-sqlserver".to_owned(),
                database: "db".to_owned(),
                schema: None,
            },
        );
        (state, id, dir)
    }

    fn events(dir: &tempfile::TempDir) -> Vec<serde_json::Value> {
        std::fs::read_to_string(dir.path().join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn error_json(error: &str) -> serde_json::Value {
        serde_json::to_value(backend_error(error).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn go_batches_keep_variables_together_and_use_the_same_dedicated_session() {
        let (state, id, dir) = mock_session(false, false).await;
        let sql =
            "DECLARE @value int = 1; SELECT @value;\nGO\nBEGIN TRY SELECT 2; END TRY BEGIN CATCH SELECT 3; END CATCH";
        let results =
            execute(&state, &id, sql, "db", None, ManualTransactionExecutionOptions::default()).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "execute_query").count(), 2);
        assert!(results[0].result.rows[0][0].as_str().unwrap().contains("DECLARE @value int = 1; SELECT @value"));
        execute(&state, &id, "SELECT 4", "db", None, ManualTransactionExecutionOptions::default()).await.unwrap();
        assert!(state.transaction_sessions.read().await.contains_key(&id));
        finish(&state, &id, false).await.unwrap();
        assert!(!state.transaction_sessions.read().await.contains_key(&id));
    }

    #[tokio::test]
    async fn execution_failure_rolls_back_once_and_invalid_session_never_replays() {
        let (state, id, dir) = mock_session(false, false).await;
        let error = execute(&state, &id, "RAISE_ERROR", "db", None, ManualTransactionExecutionOptions::default())
            .await
            .unwrap_err();
        assert_eq!(error_json(&error)["transactionOutcome"], "rolled_back");
        assert!(!state.transaction_sessions.read().await.contains_key(&id));
        let _ = execute(&state, &id, "RAISE_ERROR", "db", None, ManualTransactionExecutionOptions::default())
            .await
            .unwrap_err();
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "execute_query").count(), 1);
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "rollback_manual_transaction").count(), 1);
    }

    #[tokio::test]
    async fn rollback_failure_and_commit_response_loss_remain_unknown() {
        let (state, id, dir) = mock_session(true, false).await;
        let error = execute(&state, &id, "RAISE_ERROR", "db", None, ManualTransactionExecutionOptions::default())
            .await
            .unwrap_err();
        let error = error_json(&error);
        assert_eq!(error["code"], "DBX-TXN-1006");
        assert_eq!(error["transactionOutcome"], "unknown");
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "rollback_manual_transaction").count(), 1);
        let (state, id, dir) = mock_session(false, true).await;
        let error = finish(&state, &id, true).await.unwrap_err();
        assert_eq!(error_json(&error)["code"], "DBX-TXN-1007");
        assert_eq!(error_json(&error)["transactionOutcome"], "unknown");
        let _ = finish(&state, &id, true).await.unwrap_err();
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "commit_manual_transaction").count(), 1);
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "rollback_manual_transaction").count(), 0);
    }

    #[tokio::test]
    async fn busy_and_control_conflicts_keep_session_without_executing_sql() {
        let (state, id, dir) = mock_session(false, false).await;
        let error =
            execute(&state, &id, "COMMIT", "db", None, ManualTransactionExecutionOptions::default()).await.unwrap_err();
        assert_eq!(error_json(&error)["code"], "DBX-TXN-1008");
        state.transaction_sessions.write().await.get_mut(&id).unwrap().busy = true;
        assert_eq!(error_json(&finish(&state, &id, true).await.unwrap_err())["code"], "DBX-TXN-1003");
        assert_eq!(error_json(&finish(&state, &id, false).await.unwrap_err())["code"], "DBX-TXN-1003");
        assert_eq!(
            error_json(
                &execute(&state, &id, "SELECT 1", "db", None, ManualTransactionExecutionOptions::default())
                    .await
                    .unwrap_err()
            )["code"],
            "DBX-TXN-1003"
        );
        assert!(events(&dir).is_empty());
        state.transaction_sessions.write().await.get_mut(&id).unwrap().busy = false;
        finish(&state, &id, false).await.unwrap();
    }

    #[tokio::test]
    async fn context_change_ends_session_before_user_sql_and_commit_ack_is_retained() {
        let (state, id, dir) = mock_session(false, false).await;
        let error = execute(&state, &id, "SELECT 1", "other", None, ManualTransactionExecutionOptions::default())
            .await
            .unwrap_err();
        assert_eq!(error_json(&error)["code"], "DBX-TXN-1004");
        assert!(events(&dir).iter().all(|e| e["method"] != "execute_query"));
        let (state, id, dir) = mock_session(false, false).await;
        finish(&state, &id, true).await.unwrap();
        assert_eq!(error_json(&finish(&state, &id, true).await.unwrap_err())["transactionOutcome"], "committed");
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "commit_manual_transaction").count(), 1);
    }

    #[tokio::test]
    async fn cancellation_discards_connection_and_confirms_terminal_completion_without_replay() {
        let (state, id, dir) = mock_session(false, false).await;
        let query_state = state.clone();
        let query_id = id.clone();
        let task = tokio::spawn(async move {
            execute(
                &query_state,
                &query_id,
                "SLOW",
                "db",
                None,
                ManualTransactionExecutionOptions {
                    execution_id: Some("cancel-sqlserver".to_owned()),
                    ..Default::default()
                },
            )
            .await
        });
        for _ in 0..100 {
            if !events(&dir).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let cancellation = state.running_queries.cancel_and_wait("cancel-sqlserver", Duration::from_secs(5)).await;
        assert!(cancellation.terminal);
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error_json(&error)["transactionOutcome"], "unknown");
        assert!(!state.transaction_sessions.read().await.contains_key(&id));
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "execute_query").count(), 1);
        assert!(events(&dir).iter().all(|e| e["method"] != "rollback_manual_transaction"));
    }

    #[tokio::test]
    async fn agent_deadline_covers_all_go_batches() {
        let (state, id, dir) = mock_session(false, false).await;
        let error = execute(
            &state,
            &id,
            "SHORT_SLOW\nGO\nSHORT_SLOW",
            "db",
            None,
            ManualTransactionExecutionOptions { timeout_secs: Some(1), ..Default::default() },
        )
        .await
        .unwrap_err();
        assert_eq!(error_json(&error)["transactionOutcome"], "unknown");
        assert!(!state.transaction_sessions.read().await.contains_key(&id));
        assert_eq!(events(&dir).iter().filter(|e| e["method"] == "execute_query").count(), 2);
    }

    async fn dropped_agent_request_probe(disconnecting: bool) {
        let (state, id, dir) = mock_session(false, false).await;
        let connection = state.transaction_sessions.read().await[&id].connection.clone();
        {
            let conn = connection.lock().await;
            let TxnConnection::Agent { client, .. } = &*conn else { panic!("expected Agent") };
            let mut client = client.lock().await;
            client.try_optional_handshake("0.6.34").await.unwrap();
            client.enable_dedicated_transaction_query_cancellation();
        }
        // Only the production RPC task may keep the dedicated client alive.
        drop(connection);
        let query_state = state.clone();
        let query_id = id.clone();
        let task = tokio::spawn(async move {
            execute(
                &query_state,
                &query_id,
                "DELAYED_CANCEL",
                "db",
                None,
                ManualTransactionExecutionOptions {
                    execution_id: Some("dropped-jdbc".to_owned()),
                    ..Default::default()
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !events(&dir).iter().any(|event| event["method"] == "execute_query") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let disconnect_task = if disconnecting {
            let session = state.transaction_sessions.write().await.remove(&id).unwrap();
            let state = state.clone();
            let id = id.clone();
            Some(tokio::spawn(async move { disconnect(&state, &id, session).await }))
        } else {
            None
        };
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !events(&dir).iter().any(|event| event["method"] == "cancel_session") {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            state.running_queries.diagnostics().active_execution_ids.contains(&"dropped-jdbc".to_owned()),
            "outer abort incorrectly confirmed completion before JDBC cancellation"
        );
        if let Some(task) = disconnect_task {
            task.await.unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while !events(&dir).iter().any(|event| event["method"] == "cancel_completed") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Agent was closed before delayed JDBC cancellation completed");
        tokio::time::timeout(Duration::from_secs(2), async {
            while !state.running_queries.diagnostics().active_execution_ids.is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(events(&dir).iter().filter(|event| event["method"] == "execute_query").count(), 1);
        assert!(!state.transaction_sessions.read().await.contains_key(&id));
        assert_eq!(error_json(&missing(&state, &id))["transactionOutcome"], "unknown");
    }

    #[tokio::test]
    async fn dropped_agent_request_waits_for_delayed_cancellation() {
        dropped_agent_request_probe(false).await;
    }

    #[tokio::test]
    async fn disconnect_owns_cleanup_when_agent_request_is_dropped() {
        dropped_agent_request_probe(true).await;
    }

    #[tokio::test]
    async fn dropped_request_does_not_hold_global_session_map_during_cleanup() {
        let (state, id, _dir) = mock_session(false, false).await;
        let connection = state.transaction_sessions.read().await[&id].connection.clone();
        let held = connection.lock().await;
        let query_state = state.clone();
        let query_id = id.clone();
        let task = tokio::spawn(async move {
            execute(&query_state, &query_id, "SELECT 1", "db", None, ManualTransactionExecutionOptions::default()).await
        });
        for _ in 0..100 {
            if state.transaction_sessions.read().await[&id].busy {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let writable = tokio::time::timeout(Duration::from_secs(1), state.transaction_sessions.write()).await;
        drop(held);
        assert!(writable.is_ok(), "connection cleanup must not keep the global map locked");
    }
}
