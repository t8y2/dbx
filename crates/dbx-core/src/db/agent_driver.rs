use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

type PendingAgentResponse = tokio::sync::oneshot::Sender<Result<Value, String>>;

pub struct AgentRuntimeClient {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<BufWriter<ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u64, PendingAgentResponse>>>,
    stderr_tail: Arc<Mutex<StderrTail>>,
    next_id: AtomicU64,
    active_sessions: AtomicU64,
    failed: Arc<AtomicBool>,
    handshake: AgentHandshake,
}

impl AgentRuntimeClient {
    pub async fn spawn(launch: AgentLaunchSpec, app_version: &str) -> Result<Arc<Self>, String> {
        let mut command = crate::process::new_std_command(&launch.program);
        command.args(&launch.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(working_dir) = &launch.working_dir {
            command.current_dir(working_dir);
        }
        remove_agent_proxy_env(&mut command);

        let mut child =
            command.spawn().map_err(|e| format!("Failed to spawn agent process {}: {e}", launch_display(&launch)))?;
        let child_stdin = child.stdin.take().ok_or("Failed to capture agent stdin")?;
        let child_stdout = child.stdout.take().ok_or("Failed to capture agent stdout")?;
        let child_stderr = child.stderr.take().ok_or("Failed to capture agent stderr")?;
        let stderr_tail = Arc::new(Mutex::new(StderrTail::default()));
        start_stderr_collector(child_stderr, stderr_tail.clone());

        let mut stdout = BufReader::new(child_stdout);
        let stdout = tokio::time::timeout(
            Duration::from_secs(STARTUP_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || loop {
                let line = read_agent_line(&mut stdout, "startup line")?;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(value) if value.get("ready") == Some(&Value::Bool(true)) => return Ok(stdout),
                    Ok(_) => return Err(format!("Agent did not send ready signal, got: {line}")),
                    Err(_) => log::warn!("[agent:stdout] ignoring non-JSON line during startup: {trimmed}"),
                }
            }),
        )
        .await
        .map_err(|_| format!("Agent startup timed out ({STARTUP_TIMEOUT_SECS}s)"))?
        .map_err(|e| format!("Agent startup task failed: {e}"))??;

        let runtime = Arc::new(Self {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(BufWriter::new(child_stdin))),
            pending: Arc::new(Mutex::new(HashMap::new())),
            stderr_tail,
            next_id: AtomicU64::new(0),
            active_sessions: AtomicU64::new(0),
            failed: Arc::new(AtomicBool::new(false)),
            handshake: AgentHandshake { protocol_version: 0, agent_protocol_version: 0, capabilities: Vec::new() },
        });
        runtime.start_response_reader(stdout);
        let handshake = runtime
            .call::<AgentHandshake>(
                AgentMethod::Handshake.as_str(),
                agent_handshake_params(app_version),
                Some(Duration::from_secs(RPC_TIMEOUT_SECS)),
                None,
            )
            .await?;
        if handshake.protocol_version < 2 || !handshake.supports(AgentCapability::MultiSession) {
            runtime.kill();
            return Err("Agent runtime does not support multi_session protocol v2".to_string());
        }
        let runtime =
            Arc::try_unwrap(runtime).map_err(|_| "Agent runtime initialization is still referenced".to_string())?;
        Ok(Arc::new(Self { handshake, ..runtime }))
    }

    fn start_response_reader(self: &Arc<Self>, mut stdout: BufReader<ChildStdout>) {
        let pending = self.pending.clone();
        let failed = self.failed.clone();
        std::thread::spawn(move || loop {
            let line = match read_agent_line(&mut stdout, "response") {
                Ok(line) => line,
                Err(err) => {
                    failed.store(true, Ordering::Release);
                    fail_pending_requests(&pending, err);
                    return;
                }
            };
            let response: Value = match serde_json::from_str(line.trim()) {
                Ok(response) => response,
                Err(err) => {
                    failed.store(true, Ordering::Release);
                    fail_pending_requests(&pending, format!("Invalid JSON response from agent: {err}"));
                    return;
                }
            };
            let Some(id) = response.get("id").and_then(Value::as_u64) else {
                continue;
            };
            if let Some(sender) = pending.lock().expect("agent pending response lock poisoned").remove(&id) {
                let _ = sender.send(Ok(response));
            }
        });
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        if self.failed.load(Ordering::Acquire) {
            return Err("Agent runtime is unavailable".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let request = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let request_line =
            serde_json::to_string(&request).map_err(|e| format!("Failed to serialize JSON-RPC request: {e}"))?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending.lock().map_err(|_| "Agent pending response lock poisoned".to_string())?.insert(id, sender);
        let write_result =
            self.stdin.lock().map_err(|_| "Agent stdin lock poisoned".to_string()).and_then(|mut writer| {
                writer
                    .write_all(request_line.as_bytes())
                    .and_then(|_| writer.write_all(b"\n"))
                    .and_then(|_| writer.flush())
                    .map_err(|e| format!("Failed to write agent request: {e}"))
            });
        if let Err(err) = write_result {
            self.pending.lock().expect("agent pending response lock poisoned").remove(&id);
            return Err(err);
        }

        let receive = async { receiver.await.map_err(|_| "Agent response channel closed".to_string())? };
        let response = match (timeout_duration, cancel_token) {
            (Some(duration), Some(token)) => tokio::select! {
                _ = token.cancelled() => {
                    self.cancel_session_request(&params).await;
                    Err("Query canceled".to_string())
                },
                result = tokio::time::timeout(duration, receive) => result.map_err(|_| format!("Agent RPC call timed out ({}s)", duration.as_secs()))?,
            },
            (Some(duration), None) => tokio::time::timeout(duration, receive)
                .await
                .map_err(|_| format!("Agent RPC call timed out ({}s)", duration.as_secs()))?,
            (None, Some(token)) => tokio::select! {
                _ = token.cancelled() => {
                    self.cancel_session_request(&params).await;
                    Err("Query canceled".to_string())
                },
                result = receive => result,
            },
            (None, None) => receive.await,
        };
        if response.is_err() {
            self.pending.lock().expect("agent pending response lock poisoned").remove(&id);
        }
        decode_agent_response(response?)
    }

    async fn cancel_session_request(&self, params: &Value) {
        let Some(agent_session_id) = params.get("agentSessionId").and_then(Value::as_str) else {
            return;
        };
        let _ = Box::pin(self.call::<Value>(
            AgentMethod::CancelSession.as_str(),
            serde_json::json!({ "agentSessionId": agent_session_id }),
            Some(Duration::from_secs(5)),
            None,
        ))
        .await;
    }

    pub fn handshake(&self) -> &AgentHandshake {
        &self.handshake
    }

    pub fn is_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub fn active_session_count(&self) -> u64 {
        self.active_sessions.load(Ordering::Acquire)
    }

    pub fn increment_session_count(&self) {
        self.active_sessions.fetch_add(1, Ordering::AcqRel);
    }

    pub fn decrement_session_count(runtime: &Arc<Self>) {
        let previous = runtime
            .active_sessions
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| Some(value.saturating_sub(1)))
            .unwrap_or_default();
        if previous <= 1 {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(SHARED_RUNTIME_IDLE_GRACE_SECS)).await;
                if runtime.active_session_count() == 0 {
                    runtime.kill();
                }
            });
        }
    }

    pub fn kill(&self) {
        self.failed.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        fail_pending_requests(&self.pending, "Agent runtime terminated".to_string());
    }
}

fn decode_agent_response<T: DeserializeOwned>(response: Value) -> Result<T, String> {
    if let Some(err) = response.get("error") {
        let message = err.get("message").and_then(Value::as_str).unwrap_or("Unknown agent error");
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1);
        return Err(format!("Agent RPC error ({code}): {message}"));
    }
    let result =
        response.get("result").ok_or_else(|| "Agent response missing both 'result' and 'error'".to_string())?;
    serde_json::from_value(result.clone()).map_err(|e| format!("Failed to deserialize agent result: {e}"))
}

fn fail_pending_requests(pending: &Arc<Mutex<HashMap<u64, PendingAgentResponse>>>, error: String) {
    let requests = std::mem::take(&mut *pending.lock().expect("agent pending response lock poisoned"));
    for (_, sender) in requests {
        let _ = sender.send(Err(error.clone()));
    }
}

pub const AGENT_PROTOCOL_VERSION: u32 = 2;
const RPC_TIMEOUT_SECS: u64 = 30;
const STARTUP_TIMEOUT_SECS: u64 = 15;
const STDERR_TAIL_LINES: usize = 20;
const AGENT_EXIT_DIAGNOSTIC_WAIT_MS: u64 = 1_000;
const AGENT_EXIT_DIAGNOSTIC_POLL_MS: u64 = 10;
const SHARED_RUNTIME_IDLE_GRACE_SECS: u64 = 30;
const AGENT_JAVA_OPTS_ENV: &str = "DBX_AGENT_JAVA_OPTS";
const AGENT_JAVA_TOO_OLD_MESSAGE: &str =
    "Agent requires Java 21, but DBX started it with an older Java runtime. Use DBX managed JRE 21 or select a Java 21 executable in Driver Manager.";

pub struct AgentDriverClient {
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    stdout: Option<BufReader<ChildStdout>>,
    stderr_tail: Arc<Mutex<StderrTail>>,
    handshake: Option<AgentHandshake>,
    next_id: u64,
    shared_runtime: Option<Arc<AgentRuntimeClient>>,
    agent_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_dir: Option<PathBuf>,
}

impl AgentLaunchSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), args: Vec::new(), working_dir: None }
    }

    pub fn java_jar(java_path: impl Into<PathBuf>, jar_path: impl AsRef<Path>) -> Self {
        Self::java_jar_with_extra_args(java_path, jar_path, &[])
    }

    pub fn java_jar_with_extra_args(
        java_path: impl Into<PathBuf>,
        jar_path: impl AsRef<Path>,
        extra_java_args: &[String],
    ) -> Self {
        let jar_path = jar_path.as_ref();
        Self {
            program: java_path.into(),
            args: agent_java_args_with_extra_args(&jar_path.to_string_lossy(), extra_java_args),
            working_dir: jar_path.parent().map(Path::to_path_buf),
        }
    }

    pub fn with_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_working_dir(mut self, working_dir: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(working_dir.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandshake {
    pub protocol_version: u32,
    pub agent_protocol_version: u32,
    pub capabilities: Vec<String>,
}

impl AgentHandshake {
    pub fn supports(&self, capability: AgentCapability) -> bool {
        self.capabilities.iter().any(|value| value == capability.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCapability {
    Connect,
    TestConnection,
    Metadata,
    Query,
    PagedQuery,
    Transaction,
    Ddl,
    Kv,
    MultiSession,
}

impl AgentCapability {
    pub const ALL: [Self; 9] = [
        Self::Connect,
        Self::TestConnection,
        Self::Metadata,
        Self::Query,
        Self::PagedQuery,
        Self::Transaction,
        Self::Ddl,
        Self::Kv,
        Self::MultiSession,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::TestConnection => "test_connection",
            Self::Metadata => "metadata",
            Self::Query => "query",
            Self::PagedQuery => "paged_query",
            Self::Transaction => "transaction",
            Self::Ddl => "ddl",
            Self::Kv => "kv",
            Self::MultiSession => "multi_session",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMethod {
    Handshake,
    Connect,
    OpenSession,
    CloseSession,
    ValidateSession,
    CancelSession,
    TestConnection,
    ValidateConnection,
    ConnectionInfo,
    ListDatabases,
    ListSchemas,
    ListTables,
    ListObjects,
    ListDataTypes,
    CompletionAssistantSearchV1,
    GetObjectSource,
    GetColumns,
    ListIndexes,
    ListForeignKeys,
    ListTriggers,
    GetTableDdl,
    ExecuteQuery,
    ExecuteQueryPage,
    FetchQueryPage,
    CloseQuerySession,
    StartTableRead,
    FetchTableReadPage,
    CloseTableReadSession,
    GetExplainInfo,
    ExecuteBatch,
    ExecuteTransaction,
    Disconnect,
    Shutdown,
}

impl AgentMethod {
    pub const ALL: [Self; 33] = [
        Self::Handshake,
        Self::Connect,
        Self::OpenSession,
        Self::CloseSession,
        Self::ValidateSession,
        Self::CancelSession,
        Self::TestConnection,
        Self::ValidateConnection,
        Self::ConnectionInfo,
        Self::ListDatabases,
        Self::ListSchemas,
        Self::ListTables,
        Self::ListObjects,
        Self::ListDataTypes,
        Self::CompletionAssistantSearchV1,
        Self::GetObjectSource,
        Self::GetTableDdl,
        Self::GetColumns,
        Self::ListIndexes,
        Self::ListForeignKeys,
        Self::ListTriggers,
        Self::ExecuteQuery,
        Self::ExecuteQueryPage,
        Self::FetchQueryPage,
        Self::CloseQuerySession,
        Self::StartTableRead,
        Self::FetchTableReadPage,
        Self::CloseTableReadSession,
        Self::GetExplainInfo,
        Self::ExecuteBatch,
        Self::ExecuteTransaction,
        Self::Disconnect,
        Self::Shutdown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Handshake => "handshake",
            Self::Connect => "connect",
            Self::OpenSession => "open_session",
            Self::CloseSession => "close_session",
            Self::ValidateSession => "validate_session",
            Self::CancelSession => "cancel_session",
            Self::TestConnection => "test_connection",
            Self::ValidateConnection => "validate_connection",
            Self::ConnectionInfo => "connection_info",
            Self::ListDatabases => "list_databases",
            Self::ListSchemas => "list_schemas",
            Self::ListTables => "list_tables",
            Self::ListObjects => "list_objects",
            Self::ListDataTypes => "list_data_types",
            Self::CompletionAssistantSearchV1 => "completion_assistant_search_v1",
            Self::GetObjectSource => "get_object_source",
            Self::GetTableDdl => "get_table_ddl",
            Self::GetColumns => "get_columns",
            Self::ListIndexes => "list_indexes",
            Self::ListForeignKeys => "list_foreign_keys",
            Self::ListTriggers => "list_triggers",
            Self::ExecuteQuery => "execute_query",
            Self::ExecuteQueryPage => "execute_query_page",
            Self::FetchQueryPage => "fetch_query_page",
            Self::CloseQuerySession => "close_query_session",
            Self::StartTableRead => "start_table_read",
            Self::FetchTableReadPage => "fetch_table_read_page",
            Self::CloseTableReadSession => "close_table_read_session",
            Self::GetExplainInfo => "get_explain_info",
            Self::ExecuteBatch => "execute_batch",
            Self::ExecuteTransaction => "execute_transaction",
            Self::Disconnect => "disconnect",
            Self::Shutdown => "shutdown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionInfo {
    pub identifier_quote: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTableReadStartParams {
    pub sql: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub page_size: usize,
    pub max_rows: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTableReadPageParams {
    pub session_id: String,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTableReadCloseParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MongoAgentMethod {
    ListDatabases,
    ListCollections,
    FindDocuments,
    FindDocumentsExtendedJson,
    CountDocuments,
    ServerVersion,
    CreateIndex,
    DropIndexes,
    DropCollection,
    InsertDocument,
    UpdateDocument,
    UpdateDocuments,
    DeleteDocument,
    DeleteDocuments,
}

impl MongoAgentMethod {
    pub const ALL: [Self; 14] = [
        Self::ListDatabases,
        Self::ListCollections,
        Self::FindDocuments,
        Self::FindDocumentsExtendedJson,
        Self::CountDocuments,
        Self::ServerVersion,
        Self::CreateIndex,
        Self::DropIndexes,
        Self::DropCollection,
        Self::InsertDocument,
        Self::UpdateDocument,
        Self::UpdateDocuments,
        Self::DeleteDocument,
        Self::DeleteDocuments,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ListDatabases => "list_databases",
            Self::ListCollections => "list_collections",
            Self::FindDocuments => "find_documents",
            Self::FindDocumentsExtendedJson => "find_documents_extended_json",
            Self::CountDocuments => "count_documents",
            Self::ServerVersion => "server_version",
            Self::CreateIndex => "create_index",
            Self::DropIndexes => "drop_indexes",
            Self::DropCollection => "drop_collection",
            Self::InsertDocument => "insert_document",
            Self::UpdateDocument => "update_document",
            Self::UpdateDocuments => "update_documents",
            Self::DeleteDocument => "delete_document",
            Self::DeleteDocuments => "delete_documents",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKvMethod {
    ListPrefix,
    Get,
    Put,
    Delete,
}

impl AgentKvMethod {
    pub const ALL: [Self; 4] = [Self::ListPrefix, Self::Get, Self::Put, Self::Delete];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ListPrefix => "kv_list_prefix",
            Self::Get => "kv_get",
            Self::Put => "kv_put",
            Self::Delete => "kv_delete",
        }
    }
}

struct StderrTail {
    lines: VecDeque<String>,
    capacity: usize,
}

impl Default for StderrTail {
    fn default() -> Self {
        Self::with_capacity(STDERR_TAIL_LINES)
    }
}

impl StderrTail {
    fn with_capacity(capacity: usize) -> Self {
        Self { lines: VecDeque::with_capacity(capacity), capacity }
    }

    fn push_line(&mut self, line: String) {
        if self.capacity == 0 {
            return;
        }
        while self.lines.len() >= self.capacity {
            self.lines.pop_front();
        }
        self.lines.push_back(line.trim_end().to_string());
    }

    fn snapshot(&self) -> String {
        self.lines.iter().filter(|line| !line.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n")
    }
}

impl AgentDriverClient {
    /// Spawn an agent process and wait for it to signal readiness.
    ///
    /// Agents can be Java JARs, native executables, or script runtimes as long as
    /// they speak the DBX stdin/stdout JSON-RPC protocol.
    /// Blocks (async) until the agent writes `{"ready":true}` to stdout.
    pub async fn spawn(launch: AgentLaunchSpec) -> Result<Self, String> {
        let mut command = crate::process::new_std_command(&launch.program);
        command.args(&launch.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(working_dir) = &launch.working_dir {
            command.current_dir(working_dir);
        }
        remove_agent_proxy_env(&mut command);

        let mut child =
            command.spawn().map_err(|e| format!("Failed to spawn agent process {}: {e}", launch_display(&launch)))?;

        let child_stdin = child.stdin.take().ok_or("Failed to capture agent stdin")?;
        let child_stdout = child.stdout.take().ok_or("Failed to capture agent stdout")?;
        let child_stderr = child.stderr.take().ok_or("Failed to capture agent stderr")?;

        let stdin = BufWriter::new(child_stdin);
        let mut stdout = BufReader::new(child_stdout);
        let stderr_tail = Arc::new(Mutex::new(StderrTail::default()));
        start_stderr_collector(child_stderr, stderr_tail.clone());

        // Wait for the agent to signal readiness with {"ready":true}.
        // Some JDBC drivers (e.g. DM8) write banners to stdout during class
        // loading.  Skip non-JSON lines so driver output doesn't break the
        // JSON-RPC handshake.
        let startup_result = tokio::time::timeout(
            Duration::from_secs(STARTUP_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || loop {
                let line = read_agent_line(&mut stdout, "startup line")?;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(v) if v.get("ready") == Some(&Value::Bool(true)) => return Ok(stdout),
                    Ok(_) => return Err(format!("Agent did not send ready signal, got: {line}")),
                    Err(_) => {
                        log::warn!("[agent:stdout] ignoring non-JSON line during startup: {trimmed}");
                        continue;
                    }
                }
            }),
        )
        .await;

        let ready_stdout = match startup_result {
            Ok(Ok(Ok(stdout))) => stdout,
            Ok(Ok(Err(e))) => {
                return Err(format_agent_startup_error(&e, &mut child, &stderr_tail));
            }
            Ok(Err(e)) => {
                return Err(format_agent_startup_error(
                    &format!("Agent startup task failed: {e}"),
                    &mut child,
                    &stderr_tail,
                ));
            }
            Err(_) => {
                return Err(format_agent_startup_error(
                    &format!("Agent startup timed out ({STARTUP_TIMEOUT_SECS}s)"),
                    &mut child,
                    &stderr_tail,
                ));
            }
        };

        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            stdout: Some(ready_stdout),
            stderr_tail,
            handshake: None,
            next_id: 0,
            shared_runtime: None,
            agent_session_id: None,
        })
    }

    pub fn shared_session(runtime: Arc<AgentRuntimeClient>, agent_session_id: String) -> Self {
        Self {
            child: None,
            stdin: None,
            stdout: None,
            stderr_tail: runtime.stderr_tail.clone(),
            handshake: Some(runtime.handshake().clone()),
            next_id: 0,
            shared_runtime: Some(runtime),
            agent_session_id: Some(agent_session_id),
        }
    }

    /// Send a JSON-RPC 2.0 request and wait for the response.
    pub async fn call<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<T, String> {
        self.call_with_timeout(method, params, Some(Duration::from_secs(RPC_TIMEOUT_SECS))).await
    }

    /// Send a JSON-RPC 2.0 request and wait for the response.
    /// `None` disables the client-side RPC timeout for long-running query calls.
    pub async fn call_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_with_timeout_and_cancel(method, params, timeout_duration, None).await
    }

    /// Send a JSON-RPC 2.0 request and wait for the response.
    /// If cancellation happens while a response is pending, kill the agent
    /// process because the stdio stream cannot safely skip that response.
    pub async fn call_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        if let Some(runtime) = &self.shared_runtime {
            let mut params = params;
            if method != AgentMethod::Handshake.as_str()
                && method != AgentMethod::TestConnection.as_str()
                && method != AgentMethod::Shutdown.as_str()
            {
                let session_id = self.agent_session_id.as_ref().ok_or("Shared Agent session id is missing")?;
                params
                    .as_object_mut()
                    .ok_or_else(|| "Agent RPC parameters must be an object".to_string())?
                    .insert("agentSessionId".to_string(), Value::String(session_id.clone()));
            }
            return runtime.call(method, params, timeout_duration, cancel_token).await;
        }
        self.next_id += 1;
        let id = self.next_id;

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let request_line =
            serde_json::to_string(&request).map_err(|e| format!("Failed to serialize JSON-RPC request: {e}"))?;

        // Write request to stdin
        let write_result = {
            let writer = self.stdin.as_mut().ok_or("Agent stdin not available")?;
            writer
                .write_all(request_line.as_bytes())
                .map_err(|e| format!("Failed to write to agent stdin: {e}"))
                .and_then(|_| {
                    writer.write_all(b"\n").map_err(|e| format!("Failed to write newline to agent stdin: {e}"))
                })
                .and_then(|_| writer.flush().map_err(|e| format!("Failed to flush agent stdin: {e}")))
        };
        if let Err(e) = write_result {
            return Err(self.format_agent_process_error(&e));
        }

        // Read response from stdout (blocking, with timeout)
        let mut reader = self.stdout.take().ok_or("Agent stdout not available")?;

        let response_task = tokio::task::spawn_blocking(move || {
            let line = match read_agent_line(&mut reader, "response") {
                Ok(line) => line,
                Err(e) => return (reader, Err(e)),
            };

            let resp: Value = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(e) => {
                    return (reader, Err(format!("Invalid JSON response from agent: {e}")));
                }
            };

            let result = if let Some(err) = resp.get("error") {
                let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown agent error");
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                Err(format!("Agent RPC error ({code}): {msg}"))
            } else if let Some(result_val) = resp.get("result") {
                serde_json::from_value::<T>(result_val.clone())
                    .map_err(|e| format!("Failed to deserialize agent result: {e}"))
            } else {
                Err(format!("Agent response missing both 'result' and 'error': {line}"))
            };

            (reader, result)
        });
        let (returned_reader, result) = match (timeout_duration, cancel_token) {
            (Some(duration), Some(token)) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        self.kill();
                        return Err("Query canceled".to_string());
                    }
                    result = tokio::time::timeout(duration, response_task) => match result {
                        Ok(result) => result,
                        Err(_) => {
                            self.kill();
                            return Err(format!("Agent RPC call timed out ({}s)", duration.as_secs()));
                        }
                    },
                }
            }
            (Some(duration), None) => match tokio::time::timeout(duration, response_task).await {
                Ok(result) => result,
                Err(_) => {
                    self.kill();
                    return Err(format!("Agent RPC call timed out ({}s)", duration.as_secs()));
                }
            },
            (None, Some(token)) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        self.kill();
                        return Err("Query canceled".to_string());
                    }
                    result = response_task => result,
                }
            }
            (None, None) => response_task.await,
        }
        .map_err(|e| format!("Agent RPC task failed: {e}"))?;

        let _ = self.stdout.insert(returned_reader);
        result.map_err(|e| self.format_agent_process_error(&e))
    }

    pub async fn call_method<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
    ) -> Result<T, String> {
        self.call(method.as_str(), params).await
    }

    pub async fn call_method_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_with_timeout(method.as_str(), params, timeout_duration).await
    }

    pub async fn call_method_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        self.call_with_timeout_and_cancel(method.as_str(), params, timeout_duration, cancel_token).await
    }

    pub async fn connect(&mut self, params: Value) -> Result<Value, String> {
        self.call_method(AgentMethod::Connect, params).await
    }

    pub async fn open_session(&mut self, agent_session_id: &str, mut params: Value) -> Result<Value, String> {
        params
            .as_object_mut()
            .ok_or_else(|| "Agent session parameters must be an object".to_string())?
            .insert("agentSessionId".to_string(), Value::String(agent_session_id.to_string()));
        self.call_method(AgentMethod::OpenSession, params).await
    }

    pub async fn close_session(&mut self, agent_session_id: &str) -> Result<Value, String> {
        self.call_method(AgentMethod::CloseSession, serde_json::json!({ "agentSessionId": agent_session_id })).await
    }

    pub async fn validate_session(
        &mut self,
        agent_session_id: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<Value, String> {
        self.call_method_with_timeout(
            AgentMethod::ValidateSession,
            serde_json::json!({ "agentSessionId": agent_session_id }),
            timeout_duration,
        )
        .await
    }

    pub async fn test_connection(&mut self, params: Value) -> Result<Value, String> {
        self.call_method(AgentMethod::TestConnection, params).await
    }

    pub async fn validate_connection(&mut self, timeout_duration: Option<Duration>) -> Result<Value, String> {
        self.call_method_with_timeout(AgentMethod::ValidateConnection, serde_json::json!({}), timeout_duration).await
    }

    pub async fn connection_info(&mut self, timeout_duration: Option<Duration>) -> Result<AgentConnectionInfo, String> {
        self.call_method_with_timeout(AgentMethod::ConnectionInfo, serde_json::json!({}), timeout_duration).await
    }

    pub async fn disconnect(&mut self) -> Result<Value, String> {
        if self.shared_runtime.is_some() {
            let session_id = self.agent_session_id.as_ref().ok_or("Shared Agent session id is missing")?.clone();
            let result =
                self.call_method(AgentMethod::CloseSession, serde_json::json!({ "agentSessionId": session_id })).await;
            if result.is_ok() {
                if let Some(runtime) = &self.shared_runtime {
                    AgentRuntimeClient::decrement_session_count(runtime);
                }
                self.agent_session_id = None;
            }
            return result;
        }
        self.call_method(AgentMethod::Disconnect, serde_json::json!({})).await
    }

    pub async fn list_databases<T: DeserializeOwned + Send + 'static>(
        &mut self,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(AgentMethod::ListDatabases, serde_json::json!({}), timeout_duration).await
    }

    pub async fn list_schemas<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.list_schemas_filtered(database, None, timeout_duration).await
    }

    pub async fn list_schemas_filtered<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        visible_schemas: Option<&[String]>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        let mut params = serde_json::json!({ "database": database });
        if let Some(visible_schemas) = visible_schemas {
            params["visible_schemas"] = serde_json::json!(visible_schemas);
        }
        self.call_method_with_timeout(AgentMethod::ListSchemas, params, timeout_duration).await
    }

    pub async fn list_tables<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.list_tables_filtered(database, schema, None, timeout_duration).await
    }

    pub async fn list_tables_filtered<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        object_types: Option<&[String]>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.list_tables_constrained(database, schema, None, None, None, object_types, timeout_duration).await
    }

    pub async fn list_tables_constrained<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        filter: Option<&str>,
        limit: Option<usize>,
        offset: Option<usize>,
        object_types: Option<&[String]>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        let mut params = agent_schema_params(database, schema);
        if let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) {
            params["filter"] = serde_json::json!(filter);
        }
        if let Some(limit) = limit {
            params["limit"] = serde_json::json!(limit);
        }
        if let Some(offset) = offset {
            params["offset"] = serde_json::json!(offset);
        }
        if let Some(object_types) = object_types {
            params["object_types"] = serde_json::json!(object_types);
        }
        self.call_method_with_timeout(AgentMethod::ListTables, params, timeout_duration).await
    }

    pub async fn list_objects<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.list_objects_constrained(database, schema, None, None, None, None, timeout_duration).await
    }

    pub async fn list_objects_constrained<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        filter: Option<&str>,
        limit: Option<usize>,
        offset: Option<usize>,
        object_types: Option<&[String]>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        let mut params = agent_schema_params(database, schema);
        if let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) {
            params["filter"] = serde_json::json!(filter);
        }
        if let Some(limit) = limit {
            params["limit"] = serde_json::json!(limit);
        }
        if let Some(offset) = offset {
            params["offset"] = serde_json::json!(offset);
        }
        if let Some(object_types) = object_types {
            params["object_types"] = serde_json::json!(object_types);
        }
        self.call_method_with_timeout(AgentMethod::ListObjects, params, timeout_duration).await
    }

    pub async fn list_data_types<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListDataTypes,
            serde_json::json!({ "database": database }),
            timeout_duration,
        )
        .await
    }

    pub async fn completion_assistant_search<T: DeserializeOwned + Send + 'static>(
        &mut self,
        request: &crate::types::CompletionAssistantRequest,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::CompletionAssistantSearchV1,
            serde_json::to_value(request).map_err(|e| e.to_string())?,
            timeout_duration,
        )
        .await
    }

    pub async fn get_object_source<T: DeserializeOwned + Send + 'static, K: Serialize>(
        &mut self,
        database: &str,
        schema: &str,
        name: &str,
        object_type: &K,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::GetObjectSource,
            agent_object_source_params(database, schema, name, object_type),
            timeout_duration,
        )
        .await
    }

    pub async fn get_columns<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::GetColumns,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn list_indexes<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListIndexes,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn list_foreign_keys<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListForeignKeys,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn list_triggers<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListTriggers,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn get_table_ddl<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::GetTableDdl,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn execute_query<T: DeserializeOwned + Send + 'static>(&mut self, params: Value) -> Result<T, String> {
        self.call_method(AgentMethod::ExecuteQuery, params).await
    }

    pub async fn execute_query_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(AgentMethod::ExecuteQuery, params, timeout_duration).await
    }

    pub async fn execute_query_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        self.call_method_with_timeout_and_cancel(AgentMethod::ExecuteQuery, params, timeout_duration, cancel_token)
            .await
    }

    pub async fn execute_query_page<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_method(AgentMethod::ExecuteQueryPage, params).await
    }

    pub async fn execute_query_page_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(AgentMethod::ExecuteQueryPage, params, timeout_duration).await
    }

    pub async fn execute_query_page_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        self.call_method_with_timeout_and_cancel(AgentMethod::ExecuteQueryPage, params, timeout_duration, cancel_token)
            .await
    }

    pub async fn fetch_query_page<T: DeserializeOwned + Send + 'static>(&mut self, params: Value) -> Result<T, String> {
        self.call_method(AgentMethod::FetchQueryPage, params).await
    }

    pub async fn fetch_query_page_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(AgentMethod::FetchQueryPage, params, timeout_duration).await
    }

    pub async fn fetch_query_page_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        self.call_method_with_timeout_and_cancel(AgentMethod::FetchQueryPage, params, timeout_duration, cancel_token)
            .await
    }

    pub async fn get_explain_info<T: DeserializeOwned + Send + 'static>(&mut self, params: Value) -> Result<T, String> {
        self.call_method(AgentMethod::GetExplainInfo, params).await
    }

    pub async fn close_query_session<T: DeserializeOwned + Send + 'static>(
        &mut self,
        session_id: &str,
    ) -> Result<T, String> {
        self.call_method(AgentMethod::CloseQuerySession, agent_close_query_session_params(session_id)).await
    }

    pub async fn start_table_read<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: AgentTableReadStartParams,
    ) -> Result<T, String> {
        self.call_method(AgentMethod::StartTableRead, serde_json::to_value(params).map_err(|e| e.to_string())?).await
    }

    pub async fn fetch_table_read_page<T: DeserializeOwned + Send + 'static>(
        &mut self,
        session_id: &str,
        page_size: usize,
    ) -> Result<T, String> {
        self.call_method(
            AgentMethod::FetchTableReadPage,
            serde_json::to_value(AgentTableReadPageParams { session_id: session_id.to_string(), page_size })
                .map_err(|e| e.to_string())?,
        )
        .await
    }

    pub async fn close_table_read_session<T: DeserializeOwned + Send + 'static>(
        &mut self,
        session_id: &str,
    ) -> Result<T, String> {
        self.call_method(
            AgentMethod::CloseTableReadSession,
            serde_json::to_value(AgentTableReadCloseParams { session_id: session_id.to_string() })
                .map_err(|e| e.to_string())?,
        )
        .await
    }

    pub async fn execute_transaction<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: Option<&str>,
        statements: &[String],
        schema: Option<&str>,
    ) -> Result<T, String> {
        self.call_method(AgentMethod::ExecuteTransaction, agent_transaction_params(database, statements, schema)).await
    }

    pub async fn execute_batch<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: Option<&str>,
        statements: &[String],
        schema: Option<&str>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ExecuteBatch,
            agent_transaction_params(database, statements, schema),
            timeout_duration,
        )
        .await
    }

    pub async fn call_mongo_method<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: MongoAgentMethod,
        params: Value,
    ) -> Result<T, String> {
        self.call(method.as_str(), params).await
    }

    pub async fn call_kv_method<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentKvMethod,
        params: Value,
    ) -> Result<T, String> {
        self.call(method.as_str(), params).await
    }

    pub async fn mongo_list_databases<T: DeserializeOwned + Send + 'static>(&mut self) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::ListDatabases, serde_json::json!({})).await
    }

    pub async fn mongo_list_collections<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::ListCollections, mongo_database_params(database)).await
    }

    pub async fn mongo_find_documents<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::FindDocuments, params).await
    }

    /// Calls the Mongo agent read method that returns MongoDB relaxed Extended JSON.
    pub async fn mongo_find_documents_extended_json<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::FindDocumentsExtendedJson, params).await
    }

    pub async fn mongo_count_documents<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::CountDocuments, params).await
    }

    pub async fn mongo_server_version<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::ServerVersion, mongo_database_params(database)).await
    }

    pub async fn mongo_create_index<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::CreateIndex, params).await
    }

    pub async fn mongo_drop_indexes<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::DropIndexes, params).await
    }

    pub async fn mongo_drop_collection<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::DropCollection, params).await
    }

    pub async fn mongo_insert_document<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::InsertDocument, params).await
    }

    pub async fn mongo_update_document<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::UpdateDocument, params).await
    }

    pub async fn mongo_update_documents<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::UpdateDocuments, params).await
    }

    pub async fn mongo_delete_document<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::DeleteDocument, params).await
    }

    pub async fn mongo_delete_documents<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::DeleteDocuments, params).await
    }

    pub async fn try_optional_handshake(&mut self, app_version: &str) -> Option<AgentHandshake> {
        match self.call_method::<AgentHandshake>(AgentMethod::Handshake, agent_handshake_params(app_version)).await {
            Ok(handshake) => {
                log::info!(
                    "[agent] handshake complete: protocol={}, agent_protocol={}, capabilities={:?}",
                    handshake.protocol_version,
                    handshake.agent_protocol_version,
                    handshake.capabilities
                );
                self.handshake = Some(handshake.clone());
                Some(handshake)
            }
            Err(err) if is_unsupported_handshake_error(&err) => {
                log::info!("[agent] handshake unsupported by this driver; continuing with legacy protocol");
                None
            }
            Err(err) => {
                log::warn!("[agent] handshake failed; continuing with legacy protocol: {err}");
                None
            }
        }
    }

    pub fn handshake(&self) -> Option<&AgentHandshake> {
        self.handshake.as_ref()
    }

    pub fn supports_capability(&self, capability: AgentCapability) -> bool {
        agent_supports_capability(self.handshake.as_ref(), capability)
    }

    /// Send a shutdown message to the agent and wait for the process to exit.
    pub async fn shutdown(&mut self) {
        if self.shared_runtime.is_some() {
            let _ = self.disconnect().await;
            return;
        }
        // Try to send a shutdown RPC; ignore errors if the agent is already gone
        let shutdown_result: Result<Value, String> = self.call_method(AgentMethod::Shutdown, Value::Null).await;
        if let Err(e) = &shutdown_result {
            log::warn!("Agent shutdown RPC failed: {e}");
        }

        // Drop stdin to signal EOF
        self.stdin.take();

        // Wait for the child to exit
        let Some(child) = self.child.as_mut() else { return };
        match child.wait() {
            Ok(status) => log::info!("Agent process exited with {status}"),
            Err(e) => log::warn!("Failed to wait for agent process: {e}"),
        }
    }

    /// Forcefully kill the agent process.
    pub fn kill(&mut self) {
        if let Some(runtime) = &self.shared_runtime {
            runtime.kill();
            return;
        }
        self.stdin.take();
        self.stdout.take();
        let Some(child) = self.child.as_mut() else { return };
        if let Err(e) = child.kill() {
            log::warn!("Failed to kill agent process: {e}");
        }
        // Reap the child to avoid zombie processes.
        // Use try_wait() with a timeout instead of blocking wait() to avoid
        // hanging in Drop during async cleanup. Poll up to 100ms for the
        // process to exit after kill().
        for _ in 0..10 {
            match child.try_wait() {
                Ok(Some(_status)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => {
                    log::warn!("Failed to wait for agent process: {e}");
                    return;
                }
            }
        }
        // Final blocking wait as a last resort
        if let Err(e) = child.wait() {
            log::warn!("Final wait failed for agent process: {e}");
        }
    }

    pub fn pid(&self) -> u32 {
        if let Some(runtime) = &self.shared_runtime {
            return runtime.child.lock().map(|child| child.id()).unwrap_or_default();
        }
        self.child.as_ref().map(Child::id).unwrap_or_default()
    }

    pub fn protocol_mode(&self) -> &'static str {
        if self.shared_runtime.is_some() {
            "multi_session"
        } else {
            "legacy"
        }
    }

    pub fn active_session_count(&self) -> u64 {
        self.shared_runtime.as_ref().map(|runtime| runtime.active_session_count()).unwrap_or(1)
    }

    pub fn stderr_tail_snapshot(&self) -> String {
        self.stderr_tail.lock().map(|tail| tail.snapshot()).unwrap_or_default()
    }
}

pub fn agent_handshake_params(app_version: &str) -> Value {
    serde_json::json!({
        "appVersion": app_version,
        "supportedProtocolVersions": [AGENT_PROTOCOL_VERSION],
    })
}

pub fn is_unsupported_handshake_error(error: &str) -> bool {
    error.contains("Unknown method: handshake")
        || error.contains("Method not found: handshake")
        || error.contains("method not found: handshake")
}

pub fn agent_supports_capability(handshake: Option<&AgentHandshake>, capability: AgentCapability) -> bool {
    if capability == AgentCapability::Kv {
        return handshake.map(|value| value.supports(capability)).unwrap_or(false);
    }
    handshake.map(|value| value.supports(capability)).unwrap_or(true)
}

pub fn agent_schema_params(database: &str, schema: &str) -> Value {
    serde_json::json!({ "database": database, "schema": schema })
}

pub fn agent_schema_table_params(database: &str, schema: &str, table: &str) -> Value {
    serde_json::json!({ "database": database, "schema": schema, "table": table })
}

pub fn agent_object_source_params<K: Serialize>(database: &str, schema: &str, name: &str, object_type: &K) -> Value {
    serde_json::json!({ "database": database, "schema": schema, "name": name, "object_type": object_type })
}

pub fn agent_close_query_session_params(session_id: &str) -> Value {
    serde_json::json!({ "sessionId": session_id })
}

pub fn agent_transaction_params(database: Option<&str>, statements: &[String], schema: Option<&str>) -> Value {
    let database = database.map(str::trim).filter(|database| !database.is_empty());
    serde_json::json!({
        "database": database,
        "statements": statements,
        "schema": schema,
    })
}

pub fn mongo_database_params(database: &str) -> Value {
    serde_json::json!({ "database": database })
}

pub fn mongo_collection_params(database: &str, collection: &str) -> Value {
    serde_json::json!({ "database": database, "collection": collection })
}

pub fn mongo_document_id_params(database: &str, collection: &str, id: &str) -> Value {
    serde_json::json!({ "database": database, "collection": collection, "id": id })
}

#[cfg(test)]
fn agent_java_args(jar_path: &str) -> Vec<String> {
    agent_java_args_with_extra(jar_path, std::env::var(AGENT_JAVA_OPTS_ENV).ok().as_deref())
}

#[cfg(test)]
fn agent_java_args_with_extra(jar_path: &str, extra_opts: Option<&str>) -> Vec<String> {
    agent_java_args_with_extra_opts(jar_path, extra_opts, &[])
}

fn agent_java_args_with_extra_args(jar_path: &str, extra_java_args: &[String]) -> Vec<String> {
    agent_java_args_with_extra_opts(jar_path, std::env::var(AGENT_JAVA_OPTS_ENV).ok().as_deref(), extra_java_args)
}

fn agent_java_args_with_extra_opts(
    jar_path: &str,
    extra_opts: Option<&str>,
    extra_java_args: &[String],
) -> Vec<String> {
    let mut args = vec![
        "-Dfile.encoding=UTF-8",
        "-Dsun.stdout.encoding=UTF-8",
        "-Dsun.stderr.encoding=UTF-8",
        "-Djava.net.useSystemProxies=false",
        "-Dhttp.proxyHost=",
        "-Dhttps.proxyHost=",
        "-DsocksProxyHost=",
        "-Doracle.net.disableOob=true",
        "-Doracle.jdbc.javaNetNio=false",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();

    if agent_jar_path_matches_key(jar_path, "kingbase") || agent_jar_path_matches_key(jar_path, "informix") {
        args.push("-Djava.net.preferIPv4Stack=true".to_string());
    }

    // Hive/Kerberos JDBC drivers read JAAS and krb5 settings during JVM startup,
    // so users need a process-level escape hatch before the agent jar is loaded.
    if let Some(extra) = extra_opts {
        args.extend(parse_agent_java_opts(extra));
    }
    args.extend(extra_java_args.iter().map(|arg| arg.trim()).filter(|arg| !arg.is_empty()).map(str::to_string));

    args.push("--add-opens=java.sql/java.sql=ALL-UNNAMED".to_string());

    args.extend(["-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC", "-jar", jar_path].into_iter().map(str::to_string));

    args
}

fn parse_agent_java_opts(opts: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = opts.chars().peekable();

    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (None, ch) if ch.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            (None, '\'' | '"') => quote = Some(ch),
            (Some(q), ch) if ch == q => quote = None,
            (Some('"'), '\\') => {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\\' {
                        current.push(chars.next().unwrap());
                    } else {
                        current.push(ch);
                    }
                } else {
                    current.push(ch);
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

fn agent_jar_path_matches_key(jar_path: &str, key: &str) -> bool {
    Path::new(jar_path).components().any(|component| component.as_os_str().to_string_lossy() == key)
}

fn launch_display(launch: &AgentLaunchSpec) -> String {
    let mut parts = vec![launch.program.to_string_lossy().to_string()];
    parts.extend(launch.args.iter().cloned());
    parts.join(" ")
}

fn remove_agent_proxy_env(command: &mut Command) {
    for key in agent_proxy_env_vars() {
        command.env_remove(key);
    }
}

fn agent_proxy_env_vars() -> &'static [&'static str] {
    &["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
}

fn read_agent_line<R: BufRead>(reader: &mut R, context: &str) -> Result<String, String> {
    const MAX_RESPONSE_BYTES: usize = 512 * 1024 * 1024;
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|e| format!("Failed to read {context} from agent: {e}"))?;
        if available.is_empty() {
            break;
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            bytes.extend_from_slice(&available[..=pos]);
            reader.consume(pos + 1);
            break;
        }
        bytes.extend_from_slice(available);
        let len = available.len();
        reader.consume(len);
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(format!("Agent {context} exceeded maximum size ({} bytes)", MAX_RESPONSE_BYTES));
        }
    }
    if bytes.is_empty() {
        return Err(format!("Failed to read {context} from agent: end of stream"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn start_stderr_collector(stderr: ChildStderr, stderr_tail: Arc<Mutex<StderrTail>>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    log::warn!("[agent:stderr] {}", line.trim_end());
                    if let Ok(mut tail) = stderr_tail.lock() {
                        tail.push_line(line.clone());
                    }
                }
                Err(err) => {
                    log::warn!("[agent:stderr] failed to read stderr: {err}");
                    break;
                }
            }
        }
    });
}

fn child_exit_status(child: &mut Child) -> Option<String> {
    match child.try_wait() {
        Ok(Some(status)) => Some(status.to_string()),
        Ok(None) => None,
        Err(err) => Some(format!("status unavailable: {err}")),
    }
}

fn child_exit_status_after_short_wait(child: &mut Child) -> Option<String> {
    let deadline = Instant::now() + Duration::from_millis(AGENT_EXIT_DIAGNOSTIC_WAIT_MS);
    loop {
        if let Some(status) = child_exit_status(child) {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(AGENT_EXIT_DIAGNOSTIC_POLL_MS));
    }
}

fn stderr_tail_snapshot(stderr_tail: &Arc<Mutex<StderrTail>>) -> StderrTail {
    let snapshot = stderr_tail.lock().map(|tail| tail.snapshot()).unwrap_or_default();
    let mut tail = StderrTail::with_capacity(STDERR_TAIL_LINES);
    for line in snapshot.lines() {
        tail.push_line(line.to_string());
    }
    tail
}

fn format_agent_process_error(base: &str, exit_status: Option<String>, stderr_tail: &StderrTail) -> String {
    let stderr = stderr_tail.snapshot();
    let mut parts = Vec::new();
    if let Some(hint) = agent_process_error_hint(&stderr) {
        parts.push(hint.to_string());
        parts.push(format!("details: {base}"));
    } else {
        parts.push(base.to_string());
    }
    if let Some(status) = exit_status {
        parts.push(format!("agent process exited with {status}"));
    }
    if !stderr.is_empty() {
        parts.push(format!("recent stderr:\n{stderr}"));
    }
    parts.join(". ")
}

fn agent_process_error_hint(stderr: &str) -> Option<&'static str> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("unsupportedclassversionerror")
        && (lower.contains("class file version 65.0") || lower.contains("only recognizes class file versions up to"))
    {
        return Some(AGENT_JAVA_TOO_OLD_MESSAGE);
    }
    None
}

fn format_agent_startup_error(base: &str, child: &mut Child, stderr_tail: &Arc<Mutex<StderrTail>>) -> String {
    format_agent_process_error(base, child_exit_status_after_short_wait(child), &stderr_tail_snapshot(stderr_tail))
}

impl AgentDriverClient {
    fn format_agent_process_error(&mut self, base: &str) -> String {
        // Runtime RPC errors are common SQL/driver paths. Do not wait for the
        // child to exit unless startup diagnostics already expect the process to die.
        let exit_status = self.child.as_mut().and_then(child_exit_status);
        format_agent_process_error(base, exit_status, &stderr_tail_snapshot(&self.stderr_tail))
    }
}

impl Drop for AgentDriverClient {
    fn drop(&mut self) {
        // Shared-session clients do not own the runtime process. Session closure
        // is explicit in pool cleanup; dropping one tab must not kill other tabs.
        if let Some(runtime) = &self.shared_runtime {
            if self.agent_session_id.take().is_some() {
                AgentRuntimeClient::decrement_session_count(runtime);
            }
        } else {
            self.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_close_query_session_params, agent_handshake_params, agent_java_args, agent_java_args_with_extra,
        agent_java_args_with_extra_opts, agent_object_source_params, agent_proxy_env_vars, agent_schema_params,
        agent_schema_table_params, agent_supports_capability, agent_transaction_params, format_agent_process_error,
        format_agent_startup_error, is_unsupported_handshake_error, mongo_collection_params, mongo_database_params,
        mongo_document_id_params, parse_agent_java_opts, read_agent_line, start_stderr_collector, AgentCapability,
        AgentDriverClient, AgentHandshake, AgentKvMethod, AgentLaunchSpec, AgentMethod, AgentRuntimeClient,
        AgentTableReadCloseParams, AgentTableReadPageParams, AgentTableReadStartParams, MongoAgentMethod, StderrTail,
        AGENT_PROTOCOL_VERSION,
    };
    use std::io::Cursor;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn agent_java_args_include_oracle_network_compatibility_flags() {
        let args = agent_java_args("/tmp/dbx-agent-oracle.jar");

        assert!(args.iter().any(|arg| arg == "-Doracle.net.disableOob=true"));
        assert!(args.iter().any(|arg| arg == "-Doracle.jdbc.javaNetNio=false"));
    }

    #[test]
    fn agent_java_args_open_java_sql_for_legacy_timestamp_serializers() {
        let args = agent_java_args("/tmp/dbx-agent-dameng.jar");

        assert!(args.iter().any(|arg| arg == "--add-opens=java.sql/java.sql=ALL-UNNAMED"));
    }

    #[test]
    fn agent_java_args_disable_ambient_proxy_settings() {
        let args = agent_java_args("/tmp/dbx-agent-opengauss.jar");

        assert!(args.iter().any(|arg| arg == "-Djava.net.useSystemProxies=false"));
        assert!(args.iter().any(|arg| arg == "-Dhttp.proxyHost="));
        assert!(args.iter().any(|arg| arg == "-Dhttps.proxyHost="));
        assert!(args.iter().any(|arg| arg == "-DsocksProxyHost="));
    }

    #[test]
    fn agent_java_args_prefer_ipv4_for_kingbase() {
        let args = agent_java_args("/tmp/dbx/drivers/kingbase/agent.jar");

        assert!(args.iter().any(|arg| arg == "-Djava.net.preferIPv4Stack=true"));
    }

    #[test]
    fn agent_java_args_prefer_ipv4_for_informix() {
        let args = agent_java_args("/tmp/dbx/drivers/informix/agent.jar");

        assert!(args.iter().any(|arg| arg == "-Djava.net.preferIPv4Stack=true"));
    }

    #[test]
    fn agent_java_args_do_not_prefer_ipv4_for_other_agents() {
        let args = agent_java_args("/tmp/dbx/drivers/highgo/agent.jar");

        assert!(!args.iter().any(|arg| arg == "-Djava.net.preferIPv4Stack=true"));
    }

    #[test]
    fn agent_java_args_include_custom_jvm_options_before_jar() {
        let args = agent_java_args_with_extra(
            "/tmp/dbx/drivers/hive/agent.jar",
            Some("-Djava.security.auth.login.config=C:\\jaas.conf -Djavax.security.auth.useSubjectCredsOnly=false"),
        );

        let login_config = args
            .iter()
            .position(|arg| arg == "-Djava.security.auth.login.config=C:\\jaas.conf")
            .expect("custom JAAS option should be present");
        let jar = args.iter().position(|arg| arg == "-jar").expect("agent jar marker should be present");

        assert!(login_config < jar);
        assert!(args.iter().any(|arg| arg == "-Djavax.security.auth.useSubjectCredsOnly=false"));
    }

    #[test]
    fn agent_java_args_include_connection_jvm_options_after_env_options() {
        let args = agent_java_args_with_extra_opts(
            "/tmp/dbx/drivers/hive/agent.jar",
            Some("-Djava.security.krb5.conf=/etc/global-krb5.conf"),
            &["-Djava.security.krb5.conf=/etc/connection-krb5.conf".to_string()],
        );

        let global = args
            .iter()
            .position(|arg| arg == "-Djava.security.krb5.conf=/etc/global-krb5.conf")
            .expect("global krb5 option should be present");
        let connection = args
            .iter()
            .position(|arg| arg == "-Djava.security.krb5.conf=/etc/connection-krb5.conf")
            .expect("connection krb5 option should be present");
        let jar = args.iter().position(|arg| arg == "-jar").expect("agent jar marker should be present");

        assert!(global < connection);
        assert!(connection < jar);
    }

    #[test]
    fn agent_java_opts_parser_preserves_quoted_windows_paths() {
        let args = parse_agent_java_opts(
            r#"-Djava.security.krb5.conf="C:\Program Files\MIT\Kerberos5\krb5.ini" -Dsun.security.krb5.debug=true"#,
        );

        assert_eq!(
            args,
            vec![
                "-Djava.security.krb5.conf=C:\\Program Files\\MIT\\Kerberos5\\krb5.ini",
                "-Dsun.security.krb5.debug=true"
            ]
        );
    }

    #[test]
    fn agent_process_environment_removes_common_proxy_variables() {
        let proxy_env_vars = agent_proxy_env_vars();

        for key in
            ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
        {
            assert!(proxy_env_vars.contains(&key));
        }
    }

    #[test]
    fn decodes_non_utf8_agent_lines_lossily() {
        let mut reader =
            Cursor::new(vec![b'{', b'"', b'e', b'r', b'r', b'o', b'r', b'"', b':', 0xB2, 0xE2, b'}', b'\n']);

        let line = read_agent_line(&mut reader, "response").expect("line should be readable");

        assert_eq!(line, format!("{{\"error\":{}}}\n", "\u{fffd}\u{fffd}"));
    }

    #[test]
    fn formats_agent_process_error_with_exit_status_and_stderr_tail() {
        let mut stderr_tail = StderrTail::default();
        stderr_tail.push_line("java.lang.NoClassDefFoundError: org/apache/hive/jdbc/HiveDriver".to_string());
        stderr_tail.push_line("\tat com.dbx.agent.hive.HiveAgent.connect(HiveAgent.kt:21)".to_string());

        let message = format_agent_process_error(
            "Failed to read response from agent: end of stream",
            Some("exit status: 1".to_string()),
            &stderr_tail,
        );

        assert!(message.contains("Failed to read response from agent: end of stream"));
        assert!(message.contains("agent process exited with exit status: 1"));
        assert!(message.contains("recent stderr:"));
        assert!(message.contains("NoClassDefFoundError"));
        assert!(message.contains("HiveAgent.connect"));
    }

    #[test]
    fn startup_error_waits_briefly_for_exit_status_and_stderr_tail() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 0.05; echo 'java.lang.UnsupportedClassVersionError: class file version 65.0' >&2; exit 1")
            .stderr(Stdio::piped())
            .spawn()
            .expect("child should start");
        let stderr_tail = Arc::new(Mutex::new(StderrTail::default()));
        start_stderr_collector(child.stderr.take().expect("stderr should be piped"), Arc::clone(&stderr_tail));

        let message = format_agent_startup_error(
            "Failed to read startup line from agent: end of stream",
            &mut child,
            &stderr_tail,
        );

        assert!(message.contains("Failed to read startup line from agent: end of stream"));
        assert!(message.contains("agent process exited with exit status: 1"));
        assert!(message.contains("Agent requires Java 21"));
        assert!(message.contains("details: Failed to read startup line from agent: end of stream"));
        assert!(message.contains("UnsupportedClassVersionError"));
    }

    #[test]
    fn runtime_agent_process_error_does_not_wait_for_live_child() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("sleep 2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("child should start");
        let mut client = AgentDriverClient {
            child: Some(child),
            stdin: None,
            stdout: None,
            stderr_tail: Arc::new(Mutex::new(StderrTail::default())),
            handshake: None,
            next_id: 0,
            shared_runtime: None,
            agent_session_id: None,
        };

        let started_at = std::time::Instant::now();
        let message = client.format_agent_process_error("Agent RPC error (-1): syntax error");

        assert!(started_at.elapsed() < std::time::Duration::from_millis(500));
        assert!(message.contains("Agent RPC error (-1): syntax error"));
        assert!(!message.contains("agent process exited"));
    }

    #[tokio::test]
    async fn multiplexed_runtime_correlates_out_of_order_responses() {
        let script_path = std::env::temp_dir().join(format!("dbx-agent-runtime-test-{}.py", uuid::Uuid::new_v4()));
        let mut script = std::fs::File::create(&script_path).unwrap();
        script
            .write_all(
                br#"import json, sys, threading, time
print(json.dumps({'ready': True}), flush=True)
def respond(req):
    if req['method'] == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    else:
        time.sleep(0.05 if req['params']['value'] == 1 else 0.0)
        result = req['params']['value']
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}), flush=True)
for line in sys.stdin:
    threading.Thread(target=respond, args=(json.loads(line),), daemon=True).start()
"#,
            )
            .unwrap();
        drop(script);

        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new("python3").with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        let first = runtime.call::<u64>("echo", serde_json::json!({"value": 1}), Some(Duration::from_secs(2)), None);
        let second = runtime.call::<u64>("echo", serde_json::json!({"value": 2}), Some(Duration::from_secs(2)), None);
        let (first, second) = tokio::join!(first, second);

        assert_eq!(first.unwrap(), 1);
        assert_eq!(second.unwrap(), 2);
        runtime.kill();
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn canceling_one_runtime_request_keeps_other_requests_alive() {
        let script_path = std::env::temp_dir().join(format!("dbx-agent-cancel-test-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(
            &script_path,
            r#"import json, sys, threading, time
print(json.dumps({'ready': True}), flush=True)
def respond(req):
    if req['method'] == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    else:
        time.sleep(req['params'].get('delay', 0))
        result = req['params'].get('value')
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}), flush=True)
for line in sys.stdin:
    threading.Thread(target=respond, args=(json.loads(line),), daemon=True).start()
"#,
        )
        .unwrap();
        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new("python3").with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        let token = CancellationToken::new();
        let canceled = runtime.call::<u64>(
            "echo",
            serde_json::json!({"value": 1, "delay": 0.2}),
            Some(Duration::from_secs(2)),
            Some(token.clone()),
        );
        let healthy = runtime.call::<u64>(
            "echo",
            serde_json::json!({"value": 2, "delay": 0}),
            Some(Duration::from_secs(2)),
            None,
        );
        token.cancel();
        let (canceled, healthy) = tokio::join!(canceled, healthy);
        assert_eq!(canceled.unwrap_err(), "Query canceled");
        assert_eq!(healthy.unwrap(), 2);
        assert_eq!(
            runtime
                .call::<u64>("echo", serde_json::json!({"value": 3}), Some(Duration::from_secs(2)), None)
                .await
                .unwrap(),
            3
        );
        runtime.kill();
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn runtime_eof_fails_pending_requests_and_marks_runtime_failed() {
        let script_path = std::env::temp_dir().join(format!("dbx-agent-eof-test-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(
            &script_path,
            r#"import json, sys
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req['method'] == 'handshake':
        print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':{'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session']}}), flush=True)
    else:
        sys.exit(0)
"#,
        )
        .unwrap();
        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new("python3").with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();

        let error = runtime
            .call::<serde_json::Value>("crash", serde_json::json!({}), Some(Duration::from_secs(2)), None)
            .await
            .unwrap_err();
        assert!(error.contains("end of stream") || error.contains("response channel closed"));
        assert!(runtime.is_failed());
        let _ = std::fs::remove_file(script_path);
    }

    #[test]
    fn stderr_tail_keeps_recent_lines_only() {
        let mut stderr_tail = StderrTail::with_capacity(3);
        stderr_tail.push_line("line 1".to_string());
        stderr_tail.push_line("line 2".to_string());
        stderr_tail.push_line("line 3".to_string());
        stderr_tail.push_line("line 4".to_string());

        assert_eq!(stderr_tail.snapshot(), "line 2\nline 3\nline 4");
    }

    #[test]
    fn builds_agent_handshake_request_params() {
        let params = agent_handshake_params("0.5.13");

        assert_eq!(params["appVersion"], "0.5.13");
        assert_eq!(params["supportedProtocolVersions"], serde_json::json!([AGENT_PROTOCOL_VERSION]));
    }

    #[test]
    fn decodes_agent_handshake_response() {
        let handshake: AgentHandshake = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "agentProtocolVersion": 1,
            "capabilities": ["connect", "query", "metadata"]
        }))
        .unwrap();

        assert_eq!(handshake.protocol_version, 1);
        assert_eq!(handshake.agent_protocol_version, 1);
        assert_eq!(handshake.capabilities, vec!["connect", "query", "metadata"]);
    }

    #[test]
    fn defines_agent_protocol_capabilities() {
        assert_eq!(AgentCapability::Connect.as_str(), "connect");
        assert_eq!(AgentCapability::TestConnection.as_str(), "test_connection");
        assert_eq!(AgentCapability::Metadata.as_str(), "metadata");
        assert_eq!(AgentCapability::Query.as_str(), "query");
        assert_eq!(AgentCapability::PagedQuery.as_str(), "paged_query");
        assert_eq!(AgentCapability::Transaction.as_str(), "transaction");
        assert_eq!(AgentCapability::Ddl.as_str(), "ddl");
        assert_eq!(AgentCapability::Kv.as_str(), "kv");
        assert_eq!(AgentCapability::MultiSession.as_str(), "multi_session");
        assert_eq!(AgentCapability::ALL.len(), 9);
    }

    #[test]
    fn defines_agent_protocol_methods() {
        assert_eq!(AgentMethod::Handshake.as_str(), "handshake");
        assert_eq!(AgentMethod::Connect.as_str(), "connect");
        assert_eq!(AgentMethod::TestConnection.as_str(), "test_connection");
        assert_eq!(AgentMethod::ValidateConnection.as_str(), "validate_connection");
        assert_eq!(AgentMethod::ListDatabases.as_str(), "list_databases");
        assert_eq!(AgentMethod::ListSchemas.as_str(), "list_schemas");
        assert_eq!(AgentMethod::ListTables.as_str(), "list_tables");
        assert_eq!(AgentMethod::ListObjects.as_str(), "list_objects");
        assert_eq!(AgentMethod::ListDataTypes.as_str(), "list_data_types");
        assert_eq!(AgentMethod::CompletionAssistantSearchV1.as_str(), "completion_assistant_search_v1");
        assert_eq!(AgentMethod::GetObjectSource.as_str(), "get_object_source");
        assert_eq!(AgentMethod::GetColumns.as_str(), "get_columns");
        assert_eq!(AgentMethod::ListIndexes.as_str(), "list_indexes");
        assert_eq!(AgentMethod::ListForeignKeys.as_str(), "list_foreign_keys");
        assert_eq!(AgentMethod::ListTriggers.as_str(), "list_triggers");
        assert_eq!(AgentMethod::GetTableDdl.as_str(), "get_table_ddl");
        assert_eq!(AgentMethod::ExecuteQuery.as_str(), "execute_query");
        assert_eq!(AgentMethod::ExecuteQueryPage.as_str(), "execute_query_page");
        assert_eq!(AgentMethod::FetchQueryPage.as_str(), "fetch_query_page");
        assert_eq!(AgentMethod::CloseQuerySession.as_str(), "close_query_session");
        assert_eq!(AgentMethod::StartTableRead.as_str(), "start_table_read");
        assert_eq!(AgentMethod::FetchTableReadPage.as_str(), "fetch_table_read_page");
        assert_eq!(AgentMethod::CloseTableReadSession.as_str(), "close_table_read_session");
        assert_eq!(AgentMethod::ExecuteBatch.as_str(), "execute_batch");
        assert_eq!(AgentMethod::ExecuteTransaction.as_str(), "execute_transaction");
        assert_eq!(AgentMethod::Disconnect.as_str(), "disconnect");
        assert_eq!(AgentMethod::Shutdown.as_str(), "shutdown");
    }

    #[test]
    fn defines_mongo_agent_protocol_methods() {
        assert_eq!(MongoAgentMethod::ListDatabases.as_str(), "list_databases");
        assert_eq!(MongoAgentMethod::ListCollections.as_str(), "list_collections");
        assert_eq!(MongoAgentMethod::FindDocuments.as_str(), "find_documents");
        assert_eq!(MongoAgentMethod::FindDocumentsExtendedJson.as_str(), "find_documents_extended_json");
        assert_eq!(MongoAgentMethod::CountDocuments.as_str(), "count_documents");
        assert_eq!(MongoAgentMethod::ServerVersion.as_str(), "server_version");
        assert_eq!(MongoAgentMethod::CreateIndex.as_str(), "create_index");
        assert_eq!(MongoAgentMethod::DropIndexes.as_str(), "drop_indexes");
        assert_eq!(MongoAgentMethod::DropCollection.as_str(), "drop_collection");
        assert_eq!(MongoAgentMethod::InsertDocument.as_str(), "insert_document");
        assert_eq!(MongoAgentMethod::UpdateDocument.as_str(), "update_document");
        assert_eq!(MongoAgentMethod::UpdateDocuments.as_str(), "update_documents");
        assert_eq!(MongoAgentMethod::DeleteDocument.as_str(), "delete_document");
        assert_eq!(MongoAgentMethod::DeleteDocuments.as_str(), "delete_documents");
    }

    #[test]
    fn defines_kv_agent_protocol_methods() {
        assert_eq!(AgentKvMethod::ListPrefix.as_str(), "kv_list_prefix");
        assert_eq!(AgentKvMethod::Get.as_str(), "kv_get");
        assert_eq!(AgentKvMethod::Put.as_str(), "kv_put");
        assert_eq!(AgentKvMethod::Delete.as_str(), "kv_delete");
        assert_eq!(AgentKvMethod::ALL.len(), 4);
    }

    #[test]
    fn exposes_schema_and_query_protocol_wrappers() {
        let _list_databases = AgentDriverClient::list_databases::<serde_json::Value>;
        let _list_schemas = AgentDriverClient::list_schemas::<serde_json::Value>;
        let _list_tables = AgentDriverClient::list_tables::<serde_json::Value>;
        let _list_objects = AgentDriverClient::list_objects::<serde_json::Value>;
        let _get_object_source = AgentDriverClient::get_object_source::<serde_json::Value, serde_json::Value>;
        let _get_columns = AgentDriverClient::get_columns::<serde_json::Value>;
        let _list_indexes = AgentDriverClient::list_indexes::<serde_json::Value>;
        let _list_foreign_keys = AgentDriverClient::list_foreign_keys::<serde_json::Value>;
        let _list_triggers = AgentDriverClient::list_triggers::<serde_json::Value>;
        let _get_table_ddl = AgentDriverClient::get_table_ddl::<serde_json::Value>;
        let _execute_query = AgentDriverClient::execute_query::<serde_json::Value>;
        let _execute_query_page = AgentDriverClient::execute_query_page::<serde_json::Value>;
        let _fetch_query_page = AgentDriverClient::fetch_query_page::<serde_json::Value>;
        let _close_query_session = AgentDriverClient::close_query_session::<serde_json::Value>;
        let _execute_batch = AgentDriverClient::execute_batch::<serde_json::Value>;
        let _execute_transaction = AgentDriverClient::execute_transaction::<serde_json::Value>;
    }

    #[test]
    fn exposes_mongo_protocol_wrappers() {
        let _mongo_list_databases = AgentDriverClient::mongo_list_databases::<serde_json::Value>;
        let _mongo_list_collections = AgentDriverClient::mongo_list_collections::<serde_json::Value>;
        let _mongo_find_documents = AgentDriverClient::mongo_find_documents::<serde_json::Value>;
        let _mongo_find_documents_extended_json =
            AgentDriverClient::mongo_find_documents_extended_json::<serde_json::Value>;
        let _mongo_server_version = AgentDriverClient::mongo_server_version::<serde_json::Value>;
        let _mongo_create_index = AgentDriverClient::mongo_create_index::<serde_json::Value>;
        let _mongo_drop_indexes = AgentDriverClient::mongo_drop_indexes::<serde_json::Value>;
        let _mongo_drop_collection = AgentDriverClient::mongo_drop_collection::<serde_json::Value>;
        let _mongo_insert_document = AgentDriverClient::mongo_insert_document::<serde_json::Value>;
        let _mongo_update_document = AgentDriverClient::mongo_update_document::<serde_json::Value>;
        let _mongo_update_documents = AgentDriverClient::mongo_update_documents::<serde_json::Value>;
        let _mongo_delete_document = AgentDriverClient::mongo_delete_document::<serde_json::Value>;
        let _mongo_delete_documents = AgentDriverClient::mongo_delete_documents::<serde_json::Value>;
    }

    #[test]
    fn exposes_kv_protocol_wrapper() {
        let _call_kv_method = AgentDriverClient::call_kv_method::<serde_json::Value>;
    }

    #[test]
    fn exposes_table_read_protocol_wrappers() {
        let _start_table_read = AgentDriverClient::start_table_read::<serde_json::Value>;
        let _fetch_table_read_page = AgentDriverClient::fetch_table_read_page::<serde_json::Value>;
        let _close_table_read_session = AgentDriverClient::close_table_read_session::<serde_json::Value>;
    }

    #[test]
    fn serializes_table_read_params_with_agent_field_names() {
        let start = serde_json::to_value(AgentTableReadStartParams {
            sql: "SELECT * FROM users".to_string(),
            database: Some("ORCL".to_string()),
            schema: Some("APP".to_string()),
            page_size: 500,
            max_rows: 1000,
            fetch_size: Some(500),
        })
        .unwrap();
        assert_eq!(
            start,
            serde_json::json!({
                "sql": "SELECT * FROM users",
                "database": "ORCL",
                "schema": "APP",
                "pageSize": 500,
                "maxRows": 1000,
                "fetchSize": 500,
            })
        );

        let page = serde_json::to_value(AgentTableReadPageParams { session_id: "table-1".to_string(), page_size: 250 })
            .unwrap();
        assert_eq!(page, serde_json::json!({ "sessionId": "table-1", "pageSize": 250 }));

        let close = serde_json::to_value(AgentTableReadCloseParams { session_id: "table-1".to_string() }).unwrap();
        assert_eq!(close, serde_json::json!({ "sessionId": "table-1" }));
    }

    #[test]
    fn agent_query_result_default_column_types_is_empty_vec() {
        // Old agent JARs predate the column_types field. Rust tolerates the
        // missing field via #[serde(default)] on db::QueryResult.column_types
        // and consumers must see an empty vector rather than an error.
        let json = serde_json::json!({
            "columns": ["id", "name"],
            "rows": [[1, "Ada"]],
            "affected_rows": 0,
            "execution_time_ms": 1
        });
        let result: crate::types::QueryResult = serde_json::from_value(json).expect("deserialize legacy agent result");
        assert_eq!(result.columns, vec!["id".to_string(), "name".to_string()]);
        assert!(result.column_types.is_empty(), "missing column_types must default to empty");
        assert_eq!(result.rows.len(), 1);
    }

    #[test]
    fn agent_query_result_passes_through_column_types_when_present() {
        // New PostgresLike agents (HighGo / KingBase / Vastbase / openGauss /
        // GaussDB) include column_types alongside columns so the desktop UI
        // can detect geometry/geography columns and offer the map preview.
        let json = serde_json::json!({
            "columns": ["id", "geom"],
            "column_types": ["int4", "geometry"],
            "rows": [[1, "POINT(116.397 39.908)"]],
            "affected_rows": 0,
            "execution_time_ms": 5
        });
        let result: crate::types::QueryResult = serde_json::from_value(json).expect("deserialize agent result");
        assert_eq!(result.column_types, vec!["int4".to_string(), "geometry".to_string()]);
        assert_eq!(result.rows[0][1], serde_json::json!("POINT(116.397 39.908)"));
    }

    #[test]
    fn builds_mongo_agent_request_params() {
        assert_eq!(mongo_database_params("app"), serde_json::json!({ "database": "app" }));
        assert_eq!(
            mongo_collection_params("app", "orders"),
            serde_json::json!({ "database": "app", "collection": "orders" })
        );
        assert_eq!(
            mongo_document_id_params("app", "orders", "abc"),
            serde_json::json!({ "database": "app", "collection": "orders", "id": "abc" })
        );
    }

    #[test]
    fn builds_schema_table_and_transaction_params() {
        assert_eq!(
            agent_schema_params("sales", "public"),
            serde_json::json!({ "database": "sales", "schema": "public" })
        );
        assert_eq!(
            agent_schema_table_params("sales", "public", "orders"),
            serde_json::json!({ "database": "sales", "schema": "public", "table": "orders" })
        );
        assert_eq!(
            agent_object_source_params("sales", "public", "active_users", &"VIEW"),
            serde_json::json!({
                "database": "sales",
                "schema": "public",
                "name": "active_users",
                "object_type": "VIEW",
            })
        );
        assert_eq!(agent_close_query_session_params("session-1"), serde_json::json!({ "sessionId": "session-1" }));
        assert_eq!(
            agent_transaction_params(Some("sales"), &["BEGIN".to_string(), "COMMIT".to_string()], Some("public")),
            serde_json::json!({ "database": "sales", "statements": ["BEGIN", "COMMIT"], "schema": "public" })
        );
    }

    #[test]
    fn agent_protocol_matches_contract_file() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../assets/agent-protocol-v2.json")).unwrap();

        assert_eq!(contract["protocolVersion"], AGENT_PROTOCOL_VERSION);
        assert_eq!(contract["handshakeMethod"], AgentMethod::Handshake.as_str());
        assert_eq!(
            string_array(&contract["handshakeResponseFields"]),
            vec!["protocolVersion", "agentProtocolVersion", "capabilities"]
        );
        assert_eq!(
            string_array(&contract["allCapabilities"]),
            AgentCapability::ALL.iter().map(|method| method.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(string_array(&contract["capabilities"]), default_sql_capabilities());
        assert_eq!(string_array(&contract["defaultSqlCapabilities"]), default_sql_capabilities());
        assert_eq!(
            string_array(&contract["commonMethods"]),
            AgentMethod::ALL.iter().map(|method| method.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(
            string_array(&contract["mongoLegacyMethods"]),
            MongoAgentMethod::ALL.iter().map(|method| method.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(
            string_array(&contract["kvMethods"]),
            AgentKvMethod::ALL.iter().map(|method| method.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn checks_handshake_capability_support() {
        let handshake = AgentHandshake {
            protocol_version: AGENT_PROTOCOL_VERSION,
            agent_protocol_version: AGENT_PROTOCOL_VERSION,
            capabilities: vec!["connect".to_string(), "metadata".to_string()],
        };

        assert!(handshake.supports(AgentCapability::Connect));
        assert!(handshake.supports(AgentCapability::Metadata));
        assert!(!handshake.supports(AgentCapability::Query));
        assert!(!handshake.supports(AgentCapability::Kv));
    }

    #[test]
    fn treats_missing_handshake_as_legacy_capability_support() {
        let handshake = AgentHandshake {
            protocol_version: AGENT_PROTOCOL_VERSION,
            agent_protocol_version: AGENT_PROTOCOL_VERSION,
            capabilities: vec!["connect".to_string()],
        };

        assert!(agent_supports_capability(None, AgentCapability::Query));
        assert!(agent_supports_capability(Some(&handshake), AgentCapability::Connect));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::Query));
        assert!(!agent_supports_capability(None, AgentCapability::Kv));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::Kv));
    }

    #[test]
    fn treats_unknown_handshake_method_as_compatible_fallback() {
        assert!(is_unsupported_handshake_error("Agent RPC error (-1): Unknown method: handshake"));
        assert!(!is_unsupported_handshake_error("Agent RPC error (-1): Connection failed"));
    }

    fn string_array(value: &serde_json::Value) -> Vec<&str> {
        value.as_array().unwrap().iter().map(|item| item.as_str().unwrap()).collect()
    }

    fn default_sql_capabilities() -> Vec<&'static str> {
        [
            AgentCapability::Connect,
            AgentCapability::TestConnection,
            AgentCapability::Metadata,
            AgentCapability::Query,
            AgentCapability::PagedQuery,
            AgentCapability::Transaction,
            AgentCapability::Ddl,
            AgentCapability::MultiSession,
        ]
        .iter()
        .map(|capability| capability.as_str())
        .collect()
    }
}
