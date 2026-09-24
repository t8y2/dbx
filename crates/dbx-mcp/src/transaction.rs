use std::{
    collections::HashMap,
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};

use async_trait::async_trait;
use dbx_core::db::QueryResult;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use dbx_core::connection::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    Idle,
    Active,
    Unknown,
}

impl TransactionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Active => "active",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionOutcome {
    Committed,
    RolledBack,
    Unknown,
}

impl TransactionOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Committed => "committed",
            Self::RolledBack => "rolled_back",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug)]
pub struct TransactionIoSuccess {
    pub result: QueryResult,
    pub in_transaction: bool,
}

#[derive(Debug)]
pub enum TransactionIoError {
    Server { code: u16, message: String },
    Transport(String),
}

#[async_trait]
pub trait TransactionIo: Send + 'static {
    async fn execute(&mut self, sql: &str, max_rows: Option<usize>)
        -> Result<TransactionIoSuccess, TransactionIoError>;

    async fn ping_in_transaction(&mut self) -> Result<bool, TransactionIoError>;

    async fn disconnect(&mut self);
}

pub struct MysqlTransactionIo {
    conn: Option<mysql_async::Conn>,
    state: Arc<AppState>,
    connection_id: String,
    database: String,
    client_session_id: String,
}

impl MysqlTransactionIo {
    pub fn new(
        conn: mysql_async::Conn,
        state: Arc<AppState>,
        connection_id: String,
        database: String,
        client_session_id: String,
    ) -> Self {
        Self { conn: Some(conn), state, connection_id, database, client_session_id }
    }

    fn conn(&mut self) -> Result<&mut mysql_async::Conn, TransactionIoError> {
        self.conn.as_mut().ok_or_else(|| TransactionIoError::Transport("MySQL connection is closed".to_string()))
    }
}

#[async_trait]
impl TransactionIo for MysqlTransactionIo {
    async fn execute(
        &mut self,
        sql: &str,
        max_rows: Option<usize>,
    ) -> Result<TransactionIoSuccess, TransactionIoError> {
        let execution = dbx_core::db::mysql::execute_transaction_statement_on_conn(self.conn()?, sql, max_rows)
            .await
            .map_err(map_mysql_transaction_error)?;
        Ok(TransactionIoSuccess { result: execution.result, in_transaction: execution.in_transaction })
    }

    async fn ping_in_transaction(&mut self) -> Result<bool, TransactionIoError> {
        dbx_core::db::mysql::ping_transaction_status_on_conn(self.conn()?).await.map_err(map_mysql_transaction_error)
    }

    async fn disconnect(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.disconnect().await;
        }
        let _ = self
            .state
            .close_client_session_pool(&self.connection_id, Some(&self.database), &self.client_session_id)
            .await;
    }
}

fn map_mysql_transaction_error(error: dbx_core::db::mysql::MySqlTransactionError) -> TransactionIoError {
    match error {
        dbx_core::db::mysql::MySqlTransactionError::Server { code, message, .. } => {
            TransactionIoError::Server { code, message }
        }
        dbx_core::db::mysql::MySqlTransactionError::Transport(message) => TransactionIoError::Transport(message),
    }
}

#[derive(Default)]
pub struct TransactionOwnerRegistry {
    owners: Mutex<HashMap<String, Vec<Weak<TransactionOwner>>>>,
}

impl TransactionOwnerRegistry {
    pub fn register(&self, connection_id: &str, owner: &Arc<TransactionOwner>) {
        let mut owners = self.owners.lock().expect("transaction owner registry lock");
        let entries = owners.entry(connection_id.to_string()).or_default();
        entries.retain(|entry| entry.strong_count() > 0);
        entries.push(Arc::downgrade(owner));
    }

    pub fn invalidate_connection(&self, connection_id: &str) {
        let owners = self
            .owners
            .lock()
            .expect("transaction owner registry lock")
            .remove(connection_id)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|owner| owner.upgrade())
            .collect::<Vec<_>>();
        for owner in owners {
            owner.invalidate();
        }
    }

    pub fn invalidate_all(&self) {
        let owners = self
            .owners
            .lock()
            .expect("transaction owner registry lock")
            .drain()
            .flat_map(|(_, owners)| owners)
            .filter_map(|owner| owner.upgrade())
            .collect::<Vec<_>>();
        for owner in owners {
            owner.invalidate();
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TransactionOwnerConfig {
    pub idle_ttl: Duration,
    pub operation_timeout: Duration,
    pub cleanup_timeout: Duration,
}

impl Default for TransactionOwnerConfig {
    fn default() -> Self {
        Self {
            idle_ttl: crate::session::SESSION_IDLE_TTL,
            operation_timeout: Duration::from_secs(300),
            cleanup_timeout: Duration::from_secs(5),
        }
    }
}

impl TransactionOwnerConfig {
    pub(crate) fn from_env() -> Self {
        Self { idle_ttl: crate::session::session_idle_ttl_from_env(), ..Self::default() }
    }
}

#[derive(Debug)]
pub struct TransactionResult {
    pub result: QueryResult,
    pub state: TransactionState,
    pub outcome: Option<TransactionOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransactionFailure {
    pub code: &'static str,
    pub message: String,
    pub mysql_code: Option<u16>,
    pub state: TransactionState,
    pub outcome: Option<TransactionOutcome>,
}

#[derive(Debug, Clone, Copy)]
pub struct TransactionStatus {
    pub state: TransactionState,
    pub outcome: Option<TransactionOutcome>,
}

impl Default for TransactionStatus {
    fn default() -> Self {
        Self { state: TransactionState::Idle, outcome: None }
    }
}

enum Operation {
    Begin,
    Query { sql: String, max_rows: Option<usize> },
    Commit,
    Rollback,
}

struct Command {
    operation: Operation,
    request_cancellation: CancellationToken,
    response: oneshot::Sender<Result<TransactionResult, TransactionFailure>>,
}

struct TransactionOwnerInner {
    sender: mpsc::Sender<Command>,
    operation_gate: Arc<Semaphore>,
    cancellation: CancellationToken,
    status: Mutex<TransactionStatus>,
    closed: AtomicBool,
    closed_notify: tokio::sync::Notify,
    closed_token: CancellationToken,
    cleanup_timeout: Duration,
}

pub struct TransactionOwner {
    inner: Arc<TransactionOwnerInner>,
}

impl fmt::Debug for TransactionOwner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("TransactionOwner").field("status", &self.status()).finish_non_exhaustive()
    }
}

impl TransactionOwner {
    pub fn spawn(io: impl TransactionIo, config: TransactionOwnerConfig) -> Arc<Self> {
        Self::spawn_inner(io, config, None)
    }

    pub fn spawn_with_resource_permit(
        io: impl TransactionIo,
        config: TransactionOwnerConfig,
        resource_permit: OwnedSemaphorePermit,
    ) -> Arc<Self> {
        Self::spawn_inner(io, config, Some(resource_permit))
    }

    fn spawn_inner(
        io: impl TransactionIo,
        config: TransactionOwnerConfig,
        resource_permit: Option<OwnedSemaphorePermit>,
    ) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel(1);
        let inner = Arc::new(TransactionOwnerInner {
            sender,
            operation_gate: Arc::new(Semaphore::new(1)),
            cancellation: CancellationToken::new(),
            status: Mutex::new(TransactionStatus::default()),
            closed: AtomicBool::new(false),
            closed_notify: tokio::sync::Notify::new(),
            closed_token: CancellationToken::new(),
            cleanup_timeout: config.cleanup_timeout,
        });
        tokio::spawn(run_owner(Box::new(io), receiver, inner.clone(), config, resource_permit));
        Arc::new(Self { inner })
    }

    pub fn status(&self) -> TransactionStatus {
        *self.inner.status.lock().expect("transaction status lock")
    }

    pub async fn acquire(self: &Arc<Self>) -> Result<TransactionLease, TransactionFailure> {
        let permit = tokio::select! {
            permit = self.inner.operation_gate.clone().acquire_owned() => {
                permit.map_err(|_| self.terminal_failure("TRANSACTION_CLOSED", "Transaction session is closed."))?
            }
            _ = self.inner.cancellation.cancelled() => {
                return Err(self.terminal_failure("TRANSACTION_CLOSED", "Transaction session is closed."));
            }
        };
        if self.inner.closed.load(Ordering::Acquire) || self.inner.cancellation.is_cancelled() {
            return Err(self.terminal_failure("TRANSACTION_CLOSED", "Transaction session is closed."));
        }
        if self.status().state == TransactionState::Unknown {
            return Err(self.terminal_failure(
                "TRANSACTION_OUTCOME_UNKNOWN",
                "Transaction outcome is unknown; this session cannot execute more SQL.",
            ));
        }
        Ok(TransactionLease { owner: self.clone(), _permit: permit })
    }

    pub async fn close(&self) -> Result<TransactionStatus, TransactionStatus> {
        self.inner.cancellation.cancel();
        if !self.inner.closed.load(Ordering::Acquire) {
            let close_timeout = self.inner.cleanup_timeout.saturating_mul(2).saturating_add(Duration::from_millis(100));
            if tokio::time::timeout(close_timeout, self.wait_closed()).await.is_err() {
                return Err(self.status());
            }
        }
        Ok(self.status())
    }

    pub async fn wait_closed(&self) {
        while !self.inner.closed.load(Ordering::Acquire) {
            let notified = self.inner.closed_notify.notified();
            if self.inner.closed.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
    }

    pub fn invalidate(&self) {
        self.inner.cancellation.cancel();
    }

    pub fn closed_token(&self) -> CancellationToken {
        self.inner.closed_token.clone()
    }

    fn terminal_failure(&self, code: &'static str, message: impl Into<String>) -> TransactionFailure {
        let status = self.status();
        TransactionFailure {
            code,
            message: message.into(),
            mysql_code: None,
            state: status.state,
            outcome: status.outcome,
        }
    }
}

impl Drop for TransactionOwner {
    fn drop(&mut self) {
        // The worker owns only `TransactionOwnerInner`, not another public
        // handle. Dropping the last Arc<TransactionOwner> therefore means its
        // protocol/session owner disappeared (HTTP DELETE, stdio shutdown, or
        // server teardown) and must start bounded cleanup out-of-band.
        self.inner.cancellation.cancel();
    }
}

pub struct TransactionLease {
    owner: Arc<TransactionOwner>,
    _permit: OwnedSemaphorePermit,
}

impl fmt::Debug for TransactionLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("TransactionLease").finish_non_exhaustive()
    }
}

impl TransactionLease {
    pub async fn begin(self) -> Result<TransactionResult, TransactionFailure> {
        self.run(Operation::Begin).await
    }

    pub async fn query(
        self,
        sql: impl Into<String>,
        max_rows: Option<usize>,
    ) -> Result<TransactionResult, TransactionFailure> {
        self.run(Operation::Query { sql: sql.into(), max_rows }).await
    }

    pub async fn commit(self) -> Result<TransactionResult, TransactionFailure> {
        self.run(Operation::Commit).await
    }

    pub async fn rollback(self) -> Result<TransactionResult, TransactionFailure> {
        self.run(Operation::Rollback).await
    }

    pub async fn batch(
        mut self,
        statements: Vec<String>,
        max_rows: Option<usize>,
        continue_on_error: bool,
    ) -> Vec<Result<TransactionResult, TransactionFailure>> {
        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            let result = self.run_ref(Operation::Query { sql: statement, max_rows }).await;
            let stop = match &result {
                Ok(_) => false,
                Err(error) => error.state == TransactionState::Unknown || !continue_on_error,
            };
            results.push(result);
            if stop {
                break;
            }
        }
        results
    }

    async fn run(self, operation: Operation) -> Result<TransactionResult, TransactionFailure> {
        let mut this = self;
        this.run_ref(operation).await
    }

    async fn run_ref(&mut self, operation: Operation) -> Result<TransactionResult, TransactionFailure> {
        let request_cancellation = CancellationToken::new();
        let mut drop_guard = RequestDropGuard { cancellation: request_cancellation.clone(), armed: true };
        let (response, result) = oneshot::channel();
        self.owner
            .inner
            .sender
            .send(Command { operation, request_cancellation, response })
            .await
            .map_err(|_| self.owner.terminal_failure("TRANSACTION_CLOSED", "Transaction session is closed."))?;
        let result = result.await.map_err(|_| {
            self.owner.terminal_failure("TRANSACTION_CLOSED", "Transaction session closed during the operation.")
        })?;
        drop_guard.armed = false;
        result
    }
}

struct RequestDropGuard {
    cancellation: CancellationToken,
    armed: bool,
}

impl Drop for RequestDropGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

async fn run_owner(
    mut io: Box<dyn TransactionIo>,
    mut receiver: mpsc::Receiver<Command>,
    inner: Arc<TransactionOwnerInner>,
    config: TransactionOwnerConfig,
    resource_permit: Option<OwnedSemaphorePermit>,
) {
    loop {
        let command = tokio::select! {
            _ = inner.cancellation.cancelled() => None,
            _ = tokio::time::sleep(config.idle_ttl) => None,
            command = receiver.recv() => command,
        };
        let Some(command) = command else { break };
        let terminal = handle_command(io.as_mut(), &inner, command, config.operation_timeout).await;
        if terminal {
            break;
        }
    }

    let status = *inner.status.lock().expect("transaction status lock");
    if status.state == TransactionState::Active {
        let cleanup = tokio::time::timeout(config.cleanup_timeout, io.execute("ROLLBACK", None)).await;
        match cleanup {
            Ok(Ok(success)) if !success.in_transaction => {
                *inner.status.lock().expect("transaction status lock") =
                    TransactionStatus { state: TransactionState::Idle, outcome: Some(TransactionOutcome::RolledBack) };
            }
            _ => set_unknown(&inner),
        }
    }
    tokio::time::timeout(config.cleanup_timeout, io.disconnect()).await.ok();
    inner.closed.store(true, Ordering::Release);
    inner.operation_gate.close();
    inner.closed_notify.notify_waiters();
    inner.closed_token.cancel();
    drop(resource_permit);
}

async fn handle_command(
    io: &mut dyn TransactionIo,
    inner: &Arc<TransactionOwnerInner>,
    command: Command,
    timeout: Duration,
) -> bool {
    let request_cancellation = command.request_cancellation.clone();
    let current = *inner.status.lock().expect("transaction status lock");
    let invalid = match &command.operation {
        Operation::Begin if current.state == TransactionState::Active => {
            Some(("TRANSACTION_ALREADY_ACTIVE", "A transaction is already active for this session."))
        }
        Operation::Commit | Operation::Rollback if current.state != TransactionState::Active => {
            Some(("TRANSACTION_NOT_ACTIVE", "No active transaction exists for this session."))
        }
        _ => None,
    };
    if let Some((code, message)) = invalid {
        let _ = command.response.send(Err(failure(code, message, None, current)));
        return false;
    }

    let is_begin = matches!(&command.operation, Operation::Begin);
    let is_commit = matches!(&command.operation, Operation::Commit);
    let (sql, max_rows, success_outcome) = match command.operation {
        Operation::Begin => ("START TRANSACTION".to_string(), None, None),
        Operation::Query { sql, max_rows } => (sql, max_rows, None),
        Operation::Commit => ("COMMIT".to_string(), None, Some(TransactionOutcome::Committed)),
        Operation::Rollback => ("ROLLBACK".to_string(), None, Some(TransactionOutcome::RolledBack)),
    };

    let execution = tokio::select! {
        _ = inner.cancellation.cancelled() => {
            set_unknown(inner);
            let status = *inner.status.lock().expect("transaction status lock");
            let _ = command.response.send(Err(failure("TRANSACTION_CANCELLED", "Transaction operation was cancelled.", None, status)));
            return true;
        }
        _ = request_cancellation.cancelled() => {
            set_unknown(inner);
            let status = *inner.status.lock().expect("transaction status lock");
            let _ = command.response.send(Err(failure("TRANSACTION_CANCELLED", "Transaction request was dropped before completion.", None, status)));
            return true;
        }
        result = tokio::time::timeout(timeout, io.execute(&sql, max_rows)) => result,
    };

    match execution {
        Ok(Ok(success)) => {
            let expected_in_transaction = match success_outcome {
                Some(_) => false,
                None if is_begin => true,
                None => success.in_transaction,
            };
            if success.in_transaction != expected_in_transaction {
                set_unknown(inner);
                let status = *inner.status.lock().expect("transaction status lock");
                let _ = command.response.send(Err(failure(
                    "TRANSACTION_STATE_UNKNOWN",
                    "MySQL acknowledged the operation with an unexpected transaction state.",
                    None,
                    status,
                )));
                return true;
            }
            let status = TransactionStatus {
                state: if success.in_transaction { TransactionState::Active } else { TransactionState::Idle },
                outcome: success_outcome,
            };
            *inner.status.lock().expect("transaction status lock") = status;
            let _ = command.response.send(Ok(TransactionResult {
                result: success.result,
                state: status.state,
                outcome: status.outcome,
            }));
            false
        }
        Ok(Err(TransactionIoError::Server { code, message })) => {
            if is_commit {
                set_unknown(inner);
                let status = *inner.status.lock().expect("transaction status lock");
                let _ = command.response.send(Err(failure("TRANSACTION_STATE_UNKNOWN", message, Some(code), status)));
                return true;
            }
            let probe = tokio::select! {
                _ = inner.cancellation.cancelled() => {
                    set_unknown(inner);
                    let status = *inner.status.lock().expect("transaction status lock");
                    let _ = command.response.send(Err(failure(
                        "TRANSACTION_CANCELLED",
                        "Transaction operation was cancelled during status verification.",
                        Some(code),
                        status,
                    )));
                    return true;
                }
                _ = request_cancellation.cancelled() => {
                    set_unknown(inner);
                    let status = *inner.status.lock().expect("transaction status lock");
                    let _ = command.response.send(Err(failure(
                        "TRANSACTION_CANCELLED",
                        "Transaction request was dropped during status verification.",
                        Some(code),
                        status,
                    )));
                    return true;
                }
                result = tokio::time::timeout(timeout, io.ping_in_transaction()) => result,
            };
            match probe {
                Ok(Ok(in_transaction)) => {
                    let status = TransactionStatus {
                        state: if in_transaction { TransactionState::Active } else { TransactionState::Idle },
                        outcome: if current.state == TransactionState::Active && !in_transaction {
                            Some(TransactionOutcome::RolledBack)
                        } else {
                            None
                        },
                    };
                    *inner.status.lock().expect("transaction status lock") = status;
                    let _ = command.response.send(Err(failure("MYSQL_SERVER_ERROR", message, Some(code), status)));
                    false
                }
                _ => {
                    set_unknown(inner);
                    let status = *inner.status.lock().expect("transaction status lock");
                    let _ =
                        command.response.send(Err(failure("TRANSACTION_STATE_UNKNOWN", message, Some(code), status)));
                    true
                }
            }
        }
        Ok(Err(TransactionIoError::Transport(message))) => {
            set_unknown(inner);
            let status = *inner.status.lock().expect("transaction status lock");
            let _ = command.response.send(Err(failure("TRANSACTION_STATE_UNKNOWN", message, None, status)));
            true
        }
        Err(_) => {
            set_unknown(inner);
            let status = *inner.status.lock().expect("transaction status lock");
            let _ = command.response.send(Err(failure(
                "TRANSACTION_TIMEOUT",
                format!("Transaction operation timed out after {} seconds.", timeout.as_secs()),
                None,
                status,
            )));
            true
        }
    }
}

fn set_unknown(inner: &TransactionOwnerInner) {
    *inner.status.lock().expect("transaction status lock") =
        TransactionStatus { state: TransactionState::Unknown, outcome: Some(TransactionOutcome::Unknown) };
}

fn failure(
    code: &'static str,
    message: impl Into<String>,
    mysql_code: Option<u16>,
    status: TransactionStatus,
) -> TransactionFailure {
    TransactionFailure { code, message: message.into(), mysql_code, state: status.state, outcome: status.outcome }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };

    use async_trait::async_trait;
    use dbx_core::db::QueryResult;
    use tokio::sync::{Notify, Semaphore};

    use super::{
        TransactionIo, TransactionIoError, TransactionIoSuccess, TransactionOutcome, TransactionOwner,
        TransactionOwnerConfig, TransactionOwnerRegistry, TransactionState,
    };

    #[derive(Clone)]
    enum Step {
        Success { in_transaction: bool },
        ServerError { code: u16, message: &'static str },
        TransportError(&'static str),
        Ping { in_transaction: bool },
        WaitPing { entered: Arc<Notify>, release: Arc<Notify>, in_transaction: bool },
        Wait(Arc<Notify>),
    }

    struct ScriptedIo {
        steps: VecDeque<Step>,
        active_calls: Arc<AtomicUsize>,
        max_active_calls: Arc<AtomicUsize>,
        disconnects: Arc<AtomicUsize>,
        ping_calls: Arc<AtomicUsize>,
        executed_sql: Arc<Mutex<Vec<String>>>,
    }

    struct IoProbe {
        active_calls: Arc<AtomicUsize>,
        max_active_calls: Arc<AtomicUsize>,
        disconnects: Arc<AtomicUsize>,
        ping_calls: Arc<AtomicUsize>,
        executed_sql: Arc<Mutex<Vec<String>>>,
    }

    impl ScriptedIo {
        fn new(steps: impl IntoIterator<Item = Step>) -> (Self, IoProbe) {
            let active_calls = Arc::new(AtomicUsize::new(0));
            let max_active_calls = Arc::new(AtomicUsize::new(0));
            let disconnects = Arc::new(AtomicUsize::new(0));
            let ping_calls = Arc::new(AtomicUsize::new(0));
            let executed_sql = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    steps: steps.into_iter().collect(),
                    active_calls: active_calls.clone(),
                    max_active_calls: max_active_calls.clone(),
                    disconnects: disconnects.clone(),
                    ping_calls: ping_calls.clone(),
                    executed_sql: executed_sql.clone(),
                },
                IoProbe { active_calls, max_active_calls, disconnects, ping_calls, executed_sql },
            )
        }

        async fn run_step(&mut self, step: Step) -> Result<TransactionIoSuccess, TransactionIoError> {
            let active = self.active_calls.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active_calls.fetch_max(active, Ordering::SeqCst);
            let result = match step {
                Step::Success { in_transaction } => Ok(TransactionIoSuccess { result: empty_result(), in_transaction }),
                Step::ServerError { code, message } => {
                    Err(TransactionIoError::Server { code, message: message.to_string() })
                }
                Step::TransportError(message) => Err(TransactionIoError::Transport(message.to_string())),
                Step::Ping { .. } => panic!("ping step used as SQL execution"),
                Step::WaitPing { .. } => panic!("waiting ping step used as SQL execution"),
                Step::Wait(notify) => {
                    notify.notified().await;
                    Ok(TransactionIoSuccess { result: empty_result(), in_transaction: true })
                }
            };
            self.active_calls.fetch_sub(1, Ordering::SeqCst);
            result
        }
    }

    #[async_trait]
    impl TransactionIo for ScriptedIo {
        async fn execute(
            &mut self,
            sql: &str,
            _max_rows: Option<usize>,
        ) -> Result<TransactionIoSuccess, TransactionIoError> {
            self.executed_sql.lock().unwrap().push(sql.to_string());
            let step = self.steps.pop_front().expect("scripted SQL step");
            self.run_step(step).await
        }

        async fn ping_in_transaction(&mut self) -> Result<bool, TransactionIoError> {
            self.ping_calls.fetch_add(1, Ordering::SeqCst);
            match self.steps.pop_front().expect("scripted ping step") {
                Step::Ping { in_transaction } => Ok(in_transaction),
                Step::WaitPing { entered, release, in_transaction } => {
                    entered.notify_one();
                    release.notified().await;
                    Ok(in_transaction)
                }
                other => panic!("expected ping step, got {}", step_name(&other)),
            }
        }

        async fn disconnect(&mut self) {
            self.disconnects.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn step_name(step: &Step) -> &'static str {
        match step {
            Step::Success { .. } => "success",
            Step::ServerError { .. } => "server error",
            Step::TransportError(_) => "transport error",
            Step::Ping { .. } => "ping",
            Step::WaitPing { .. } => "waiting ping",
            Step::Wait(_) => "wait",
        }
    }

    fn empty_result() -> QueryResult {
        QueryResult {
            columns: Vec::new(),
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: Vec::new(),
            affected_rows: 0,
            execution_time_ms: 0,
            server_execute_time_us: None,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        }
    }

    fn config() -> TransactionOwnerConfig {
        TransactionOwnerConfig {
            idle_ttl: Duration::from_secs(30 * 60),
            operation_timeout: Duration::from_secs(30),
            cleanup_timeout: Duration::from_secs(1),
        }
    }

    #[tokio::test]
    async fn begin_ack_and_commit_ack_drive_visible_state_and_outcome() {
        let (io, _) =
            ScriptedIo::new([Step::Success { in_transaction: true }, Step::Success { in_transaction: false }]);
        let owner = TransactionOwner::spawn(io, config());

        let begin = owner.acquire().await.unwrap().begin().await.unwrap();
        assert_eq!(begin.state, TransactionState::Active);
        assert_eq!(begin.outcome, None);

        let commit = owner.acquire().await.unwrap().commit().await.unwrap();
        assert_eq!(commit.state, TransactionState::Idle);
        assert_eq!(commit.outcome, Some(TransactionOutcome::Committed));
    }

    #[tokio::test]
    async fn recoverable_server_error_probes_fresh_status_and_keeps_transaction_active() {
        let (io, probe) = ScriptedIo::new([
            Step::Success { in_transaction: true },
            Step::ServerError { code: 1062, message: "Duplicate entry" },
            Step::Ping { in_transaction: true },
            Step::Success { in_transaction: true },
            Step::Success { in_transaction: false },
        ]);
        let owner = TransactionOwner::spawn(io, config());
        owner.acquire().await.unwrap().begin().await.unwrap();

        let duplicate = owner.acquire().await.unwrap().query("INSERT INTO t VALUES (1)", None).await.unwrap_err();
        assert_eq!(duplicate.mysql_code, Some(1062));
        assert_eq!(duplicate.state, TransactionState::Active);

        let read = owner.acquire().await.unwrap().query("SELECT * FROM t FOR UPDATE", None).await.unwrap();
        assert_eq!(read.state, TransactionState::Active);
        let rollback = owner.acquire().await.unwrap().rollback().await.unwrap();
        assert_eq!(rollback.outcome, Some(TransactionOutcome::RolledBack));
        assert_eq!(probe.executed_sql.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn lost_commit_ack_is_permanently_unknown_even_after_cleanup() {
        let (io, probe) = ScriptedIo::new([
            Step::Success { in_transaction: true },
            Step::TransportError("connection reset after COMMIT"),
        ]);
        let owner = TransactionOwner::spawn(io, config());
        owner.acquire().await.unwrap().begin().await.unwrap();

        let failure = owner.acquire().await.unwrap().commit().await.unwrap_err();
        assert_eq!(failure.state, TransactionState::Unknown);
        assert_eq!(failure.outcome, Some(TransactionOutcome::Unknown));

        let close = owner.close().await.unwrap();
        assert_eq!(close.state, TransactionState::Unknown);
        assert_eq!(close.outcome, Some(TransactionOutcome::Unknown));
        assert_eq!(probe.disconnects.load(Ordering::SeqCst), 1);
        let later = owner.acquire().await.unwrap_err();
        assert_eq!(later.state, TransactionState::Unknown);
    }

    #[tokio::test]
    async fn commit_server_error_is_terminal_unknown_without_status_probe() {
        let (io, probe) = ScriptedIo::new([
            Step::Success { in_transaction: true },
            Step::ServerError { code: 1180, message: "Got error during COMMIT" },
            Step::Ping { in_transaction: false },
        ]);
        let owner = TransactionOwner::spawn(io, config());
        owner.acquire().await.unwrap().begin().await.unwrap();

        let failure = owner.acquire().await.unwrap().commit().await.unwrap_err();

        assert_eq!(failure.code, "TRANSACTION_STATE_UNKNOWN");
        assert_eq!(failure.mysql_code, Some(1180));
        assert_eq!(failure.state, TransactionState::Unknown);
        assert_eq!(failure.outcome, Some(TransactionOutcome::Unknown));
        assert_eq!(probe.ping_calls.load(Ordering::SeqCst), 0);

        let close = owner.close().await.unwrap();
        assert_eq!(close.state, TransactionState::Unknown);
        assert_eq!(close.outcome, Some(TransactionOutcome::Unknown));
        assert_eq!(probe.ping_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn one_owner_serializes_operations_while_distinct_owners_run_independently() {
        let release_a = Arc::new(Notify::new());
        let release_b = Arc::new(Notify::new());
        let (io_a, probe_a) = ScriptedIo::new([Step::Wait(release_a.clone()), Step::Success { in_transaction: true }]);
        let (io_b, probe_b) = ScriptedIo::new([Step::Wait(release_b.clone())]);
        let owner_a = TransactionOwner::spawn(io_a, config());
        let owner_b = TransactionOwner::spawn(io_b, config());

        let a1 = {
            let owner = owner_a.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("SELECT 1", None).await })
        };
        while probe_a.active_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let a2 = {
            let owner = owner_a.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("SELECT 2", None).await })
        };
        let b1 = {
            let owner = owner_b.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("SELECT 3", None).await })
        };
        while probe_b.active_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }

        assert_eq!(probe_a.max_active_calls.load(Ordering::SeqCst), 1);
        assert_eq!(probe_b.max_active_calls.load(Ordering::SeqCst), 1);
        assert_eq!(probe_a.executed_sql.lock().unwrap().as_slice(), ["SELECT 1"]);

        release_b.notify_one();
        b1.await.unwrap().unwrap();
        release_a.notify_one();
        a1.await.unwrap().unwrap();
        a2.await.unwrap().unwrap();
        assert_eq!(probe_a.max_active_calls.load(Ordering::SeqCst), 1);
        assert_eq!(probe_a.executed_sql.lock().unwrap().as_slice(), ["SELECT 1", "SELECT 2"]);
    }

    #[tokio::test]
    async fn dropping_an_in_flight_request_terminates_the_owner_and_disposes_the_connection() {
        let never_release = Arc::new(Notify::new());
        let (io, probe) = ScriptedIo::new([Step::Wait(never_release)]);
        let owner = TransactionOwner::spawn(io, config());
        let request = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("SELECT SLEEP(30)", None).await })
        };
        while probe.active_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        let later = tokio::time::timeout(Duration::from_millis(250), async {
            match owner.acquire().await {
                Ok(lease) => lease.query("SELECT 2", None).await.unwrap_err(),
                Err(failure) => failure,
            }
        })
        .await
        .expect("dropped caller must terminate the owner");

        assert_eq!(later.state, TransactionState::Unknown);
        assert_eq!(later.outcome, Some(TransactionOutcome::Unknown));
        assert_eq!(probe.disconnects.load(Ordering::SeqCst), 1);
        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["SELECT SLEEP(30)"]);
    }

    #[tokio::test]
    async fn dropping_a_request_during_server_error_probe_disposes_the_connection() {
        let ping_entered = Arc::new(Notify::new());
        let never_release = Arc::new(Notify::new());
        let (io, probe) = ScriptedIo::new([
            Step::ServerError { code: 1062, message: "Duplicate entry" },
            Step::WaitPing { entered: ping_entered.clone(), release: never_release, in_transaction: true },
        ]);
        let owner = TransactionOwner::spawn(io, config());
        let request = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("INSERT duplicate", None).await })
        };
        ping_entered.notified().await;

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_millis(250), owner.wait_closed())
            .await
            .expect("dropped caller must cancel a busy status probe");

        assert_eq!(owner.status().state, TransactionState::Unknown);
        assert_eq!(probe.disconnects.load(Ordering::SeqCst), 1);
        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["INSERT duplicate"]);
    }

    #[tokio::test]
    async fn active_idle_expiry_rolls_back_and_disposes_the_connection() {
        let (io, probe) =
            ScriptedIo::new([Step::Success { in_transaction: true }, Step::Success { in_transaction: false }]);
        let owner = TransactionOwner::spawn(
            io,
            TransactionOwnerConfig {
                idle_ttl: Duration::from_millis(20),
                operation_timeout: Duration::from_secs(1),
                cleanup_timeout: Duration::from_millis(20),
            },
        );
        owner.acquire().await.unwrap().begin().await.unwrap();

        tokio::time::timeout(Duration::from_millis(250), async {
            while probe.disconnects.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("idle owner must be disposed without another request");

        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["START TRANSACTION", "ROLLBACK"]);
        let status = owner.status();
        assert_eq!(status.state, TransactionState::Idle);
        assert_eq!(status.outcome, Some(TransactionOutcome::RolledBack));
    }

    #[tokio::test]
    async fn close_waits_until_bounded_active_cleanup_releases_the_owner() {
        let rollback_release = Arc::new(Notify::new());
        let (io, probe) = ScriptedIo::new([Step::Success { in_transaction: true }, Step::Wait(rollback_release)]);
        let owner = TransactionOwner::spawn(
            io,
            TransactionOwnerConfig {
                idle_ttl: Duration::from_secs(60),
                operation_timeout: Duration::from_secs(1),
                cleanup_timeout: Duration::from_millis(20),
            },
        );
        owner.acquire().await.unwrap().begin().await.unwrap();

        let status = owner.close().await.expect("owner cleanup must reach its bounded disposal path");

        assert_eq!(status.state, TransactionState::Unknown);
        assert_eq!(probe.disconnects.load(Ordering::SeqCst), 1);
        assert!(owner.inner.closed.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn resource_permit_is_held_until_pending_owner_cleanup_finishes() {
        let rollback_release = Arc::new(Notify::new());
        let budget = Arc::new(Semaphore::new(1));
        let permit = budget.clone().acquire_owned().await.unwrap();
        let (io, probe) =
            ScriptedIo::new([Step::Success { in_transaction: true }, Step::Wait(rollback_release.clone())]);
        let owner = TransactionOwner::spawn_with_resource_permit(io, config(), permit);
        owner.acquire().await.unwrap().begin().await.unwrap();

        let closing = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.close().await })
        };
        while probe.active_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert!(budget.clone().try_acquire_owned().is_err());

        rollback_release.notify_one();
        closing.await.unwrap().unwrap();
        assert!(budget.clone().try_acquire_owned().is_ok());
    }

    #[tokio::test]
    async fn operation_timeout_is_terminal_unknown_and_disposes_the_connection() {
        let never_release = Arc::new(Notify::new());
        let (io, probe) = ScriptedIo::new([Step::Wait(never_release)]);
        let owner = TransactionOwner::spawn(
            io,
            TransactionOwnerConfig {
                idle_ttl: Duration::from_secs(60),
                operation_timeout: Duration::from_millis(20),
                cleanup_timeout: Duration::from_millis(20),
            },
        );

        let failure = owner.acquire().await.unwrap().query("SELECT SLEEP(30)", None).await.unwrap_err();

        assert_eq!(failure.code, "TRANSACTION_TIMEOUT");
        assert_eq!(failure.state, TransactionState::Unknown);
        owner.wait_closed().await;
        assert_eq!(probe.disconnects.load(Ordering::SeqCst), 1);
        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["SELECT SLEEP(30)"]);
    }

    #[tokio::test]
    async fn cancelling_a_queued_operation_never_sends_its_sql() {
        let release_first = Arc::new(Notify::new());
        let (io, probe) = ScriptedIo::new([
            Step::Wait(release_first.clone()),
            Step::Success { in_transaction: true },
            Step::Success { in_transaction: false },
        ]);
        let owner = TransactionOwner::spawn(io, config());
        let first = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("SELECT 1", None).await })
        };
        while probe.active_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let queued = {
            let owner = owner.clone();
            tokio::spawn(async move { owner.acquire().await.unwrap().query("SELECT 2", None).await })
        };
        tokio::task::yield_now().await;
        queued.abort();
        assert!(queued.await.unwrap_err().is_cancelled());

        release_first.notify_one();
        first.await.unwrap().unwrap();
        owner.acquire().await.unwrap().query("SELECT 3", None).await.unwrap();
        owner.close().await.unwrap();

        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["SELECT 1", "SELECT 3", "ROLLBACK"]);
    }

    #[tokio::test]
    async fn server_error_probe_can_report_an_implicit_rollback() {
        let (io, probe) = ScriptedIo::new([
            Step::Success { in_transaction: true },
            Step::ServerError { code: 1213, message: "Deadlock found" },
            Step::Ping { in_transaction: false },
        ]);
        let owner = TransactionOwner::spawn(io, config());
        owner.acquire().await.unwrap().begin().await.unwrap();

        let failure = owner.acquire().await.unwrap().query("UPDATE t SET value = 1", None).await.unwrap_err();

        assert_eq!(failure.mysql_code, Some(1213));
        assert_eq!(failure.state, TransactionState::Idle);
        assert_eq!(failure.outcome, Some(TransactionOutcome::RolledBack));
        let commit = owner.acquire().await.unwrap().commit().await.unwrap_err();
        assert_eq!(commit.code, "TRANSACTION_NOT_ACTIVE");
        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["START TRANSACTION", "UPDATE t SET value = 1"]);
    }

    #[tokio::test]
    async fn registry_invalidation_rolls_back_active_owners_without_holding_the_registry_lock() {
        let (io, probe) =
            ScriptedIo::new([Step::Success { in_transaction: true }, Step::Success { in_transaction: false }]);
        let owner = TransactionOwner::spawn(io, config());
        let registry = TransactionOwnerRegistry::default();
        registry.register("connection-1", &owner);
        owner.acquire().await.unwrap().begin().await.unwrap();

        registry.invalidate_connection("connection-1");
        owner.wait_closed().await;

        assert_eq!(probe.executed_sql.lock().unwrap().as_slice(), ["START TRANSACTION", "ROLLBACK"]);
        assert_eq!(probe.disconnects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dropping_the_last_public_handle_disposes_an_idle_owner() {
        let (io, probe) = ScriptedIo::new([]);
        let owner = TransactionOwner::spawn(io, config());

        drop(owner);

        tokio::time::timeout(Duration::from_millis(250), async {
            while probe.disconnects.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping the protocol-owned handle must dispose its connection");
    }

    #[tokio::test]
    async fn batch_continues_after_recoverable_error_but_stops_on_unknown() {
        let (recoverable_io, recoverable_probe) = ScriptedIo::new([
            Step::ServerError { code: 1062, message: "Duplicate entry" },
            Step::Ping { in_transaction: true },
            Step::Success { in_transaction: true },
            Step::Success { in_transaction: false },
        ]);
        let recoverable = TransactionOwner::spawn(recoverable_io, config());
        let results = recoverable
            .acquire()
            .await
            .unwrap()
            .batch(vec!["INSERT duplicate".to_string(), "SELECT winner".to_string()], None, true)
            .await;
        assert_eq!(results.len(), 2);
        assert!(results[0].is_err());
        assert!(results[1].is_ok());
        recoverable.close().await.unwrap();
        assert_eq!(
            recoverable_probe.executed_sql.lock().unwrap().as_slice(),
            ["INSERT duplicate", "SELECT winner", "ROLLBACK"]
        );

        let (unknown_io, unknown_probe) = ScriptedIo::new([Step::TransportError("connection reset")]);
        let unknown = TransactionOwner::spawn(unknown_io, config());
        let results = unknown
            .acquire()
            .await
            .unwrap()
            .batch(vec!["UPDATE first".to_string(), "UPDATE forbidden".to_string()], None, true)
            .await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].as_ref().unwrap_err().state, TransactionState::Unknown);
        unknown.wait_closed().await;
        assert_eq!(unknown_probe.executed_sql.lock().unwrap().as_slice(), ["UPDATE first"]);
    }
}
