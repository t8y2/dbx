use std::collections::{HashMap, VecDeque};
use std::fmt;
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

use crate::agent_recovery::{RecoveryDecision, RecoveryPolicy, RecoveryScope};
use crate::models::connection::DatabaseConnectionInfo;

type PendingAgentResponse = tokio::sync::oneshot::Sender<Result<Value, String>>;

#[derive(Clone)]
struct CachedAgentQuery {
    key: String,
    expires_at: Instant,
    result: Result<Value, String>,
}

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
        let mut child = spawn_agent_process(&launch)?;
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
        let handshake = match runtime
            .call_typed::<AgentHandshake>(
                AgentMethod::Handshake.as_str(),
                agent_handshake_params(app_version),
                Some(Duration::from_secs(RPC_TIMEOUT_SECS)),
                None,
            )
            .await
        {
            Ok(handshake) => handshake,
            Err(error) if is_unsupported_handshake_error(&error.to_string()) => {
                runtime.kill();
                return Err("Agent runtime does not support multi_session protocol v2".to_string());
            }
            Err(error) => {
                runtime.kill();
                return Err(error.into_legacy_string());
            }
        };
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
        self.call_typed(method, params, timeout_duration, cancel_token)
            .await
            .map_err(AgentCallError::into_legacy_string)
    }

    pub async fn call_typed<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        if self.failed.load(Ordering::Acquire) {
            return Err(AgentCallError::Transport { message: "Agent runtime is unavailable".to_string() });
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let request = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let request_line = serde_json::to_string(&request)
            .map_err(|e| AgentCallError::Transport { message: format!("Failed to serialize JSON-RPC request: {e}") })?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| AgentCallError::Transport { message: "Agent pending response lock poisoned".to_string() })?
            .insert(id, sender);
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
            return Err(AgentCallError::Transport { message: err });
        }

        let receive = async {
            receiver
                .await
                .map_err(|_| AgentCallError::Transport { message: "Agent response channel closed".to_string() })?
                .map_err(|message| AgentCallError::Transport { message })
        };
        let response = match (timeout_duration, cancel_token) {
            (Some(duration), Some(token)) => tokio::select! {
                _ = token.cancelled() => {
                    self.cancel_session_request_for_method(method, &params).await;
                    Err(AgentCallError::Canceled {
                        stage: agent_error_stage(method),
                        operation_outcome: agent_operation_outcome(method),
                    })
                },
                result = tokio::time::timeout(duration, receive) => match result {
                    Ok(result) => result,
                    Err(_) => {
                        self.cancel_session_request_for_method(method, &params).await;
                        Err(AgentCallError::Timeout {
                            stage: agent_error_stage(method),
                            operation_outcome: agent_operation_outcome(method),
                        })
                    }
                },
            },
            (Some(duration), None) => match tokio::time::timeout(duration, receive).await {
                Ok(result) => result,
                Err(_) => {
                    self.cancel_session_request_for_method(method, &params).await;
                    Err(AgentCallError::Timeout {
                        stage: agent_error_stage(method),
                        operation_outcome: agent_operation_outcome(method),
                    })
                }
            },
            (None, Some(token)) => tokio::select! {
                _ = token.cancelled() => {
                    self.cancel_session_request_for_method(method, &params).await;
                    Err(AgentCallError::Canceled {
                        stage: agent_error_stage(method),
                        operation_outcome: agent_operation_outcome(method),
                    })
                },
                result = receive => result,
            },
            (None, None) => receive.await,
        };
        if response.is_err() {
            self.pending.lock().expect("agent pending response lock poisoned").remove(&id);
        }
        let response = response?;
        decode_agent_response(
            response,
            self.handshake.supports(AgentCapability::StructuredErrorV1),
            params.get("agentSessionId").and_then(Value::as_str),
        )
    }

    async fn cancel_session_request_for_method(&self, method: &str, params: &Value) {
        if method != AgentMethod::CancelSession.as_str() {
            self.cancel_session_request(params).await;
        }
    }

    async fn cancel_session_request(&self, params: &Value) {
        let Some(agent_session_id) = params.get("agentSessionId").and_then(Value::as_str) else {
            return;
        };
        let _ = Box::pin(self.call_typed::<Value>(
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

    pub fn decrement_session_count(runtime: &Arc<Self>) -> u64 {
        let previous = runtime
            .active_sessions
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| Some(value.saturating_sub(1)))
            .unwrap_or_default();
        let remaining = previous.saturating_sub(1);
        if previous <= 1 {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(SHARED_RUNTIME_IDLE_GRACE_SECS)).await;
                if runtime.active_session_count() == 0 {
                    runtime.kill();
                }
            });
        }
        remaining
    }

    pub fn kill(&self) {
        self.failed.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        fail_pending_requests(&self.pending, "Agent runtime terminated".to_string());
    }

    pub async fn kill_and_wait(&self) {
        self.failed.store(true, Ordering::Release);
        fail_pending_requests(&self.pending, "Agent runtime terminated".to_string());
        let child = self.child.clone();
        match tokio::task::spawn_blocking(move || {
            let mut child = child.lock().map_err(|_| "Shared agent process lock poisoned".to_string())?;
            let _ = child.kill();
            child.wait().map(|_| ()).map_err(|err| format!("Failed to wait for shared agent runtime: {err}"))
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(err)) => log::warn!("{err}"),
            Err(err) => log::warn!("Failed to join shared agent shutdown task: {err}"),
        }
    }
}

fn decode_agent_response<T: DeserializeOwned>(
    response: Value,
    strict_structured_errors: bool,
    expected_session_id: Option<&str>,
) -> Result<T, AgentCallError> {
    if let Some(err) = response.get("error") {
        return Err(parse_agent_call_error(err, strict_structured_errors, expected_session_id));
    }
    let result = response.get("result").ok_or_else(|| AgentCallError::ContractViolation {
        rpc_code: None,
        message: "Agent response missing both 'result' and 'error'".to_string(),
        reason: ContractViolationReason::MissingResultOrError,
    })?;
    serde_json::from_value(result.clone()).map_err(|e| AgentCallError::ContractViolation {
        rpc_code: None,
        message: format!("Failed to deserialize agent result: {e}"),
        reason: ContractViolationReason::InvalidResult,
    })
}

const AGENT_RPC_ERROR_DATA_MARKER: &str = "\nDBX_AGENT_ERROR_DATA:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionDisposition {
    Keep,
    Quarantine,
    ReplaceRuntime,
}

impl AgentSessionDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Quarantine => "quarantine",
            Self::ReplaceRuntime => "replace_runtime",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorCategory {
    Connection,
    Sql,
    Resource,
    Protocol,
    Timeout,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorStage {
    Request,
    Checkout,
    Connect,
    Validate,
    Execute,
    Fetch,
    Cancel,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOperationOutcome {
    NotStarted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentErrorContext {
    pub contract_version: u8,
    pub category: AgentErrorCategory,
    pub retryable: bool,
    pub session_disposition: AgentSessionDisposition,
    pub stage: AgentErrorStage,
    pub operation_outcome: AgentOperationOutcome,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub sql_state: Option<String>,
    #[serde(default)]
    pub vendor_code: Option<i32>,
    #[serde(default)]
    pub exception_class: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyAgentHints {
    pub category: Option<AgentErrorCategory>,
    pub retryable: Option<bool>,
    pub session_disposition: Option<AgentSessionDisposition>,
    pub stage: Option<AgentErrorStage>,
    pub operation_outcome: Option<AgentOperationOutcome>,
    pub agent_session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractViolationReason {
    MissingContractVersion,
    UnsupportedContractVersion,
    InvalidDataShape,
    InvalidSessionId,
    InvalidCombination,
    MissingResultOrError,
    InvalidResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCallError {
    Structured { rpc_code: i64, message: String, context: AgentErrorContext },
    Legacy { rpc_code: Option<i64>, message: String, hints: LegacyAgentHints },
    ContractViolation { rpc_code: Option<i64>, message: String, reason: ContractViolationReason },
    Transport { message: String },
    Timeout { stage: AgentErrorStage, operation_outcome: AgentOperationOutcome },
    Canceled { stage: AgentErrorStage, operation_outcome: AgentOperationOutcome },
}

/// Decode an already-stringified Agent failure at the compatibility boundary.
///
/// Business modules must use this adapter instead of inspecting the legacy
/// `DBX_AGENT_ERROR_DATA` marker themselves. Callers must only use it after the
/// owning pool has been identified as an Agent pool.
pub(crate) fn agent_error_from_legacy(error: &str, expected_session_id: Option<&str>) -> AgentCallError {
    if error == "Query canceled" {
        return AgentCallError::Canceled {
            stage: AgentErrorStage::Cancel,
            operation_outcome: AgentOperationOutcome::Unknown,
        };
    }
    let lower = error.to_ascii_lowercase();
    if lower.starts_with("agent rpc call timed out") {
        return AgentCallError::Timeout {
            stage: AgentErrorStage::Execute,
            operation_outcome: AgentOperationOutcome::Unknown,
        };
    }
    legacy_agent_call_error(error.to_string(), expected_session_id)
}

/// Returns a typed error only when a mixed legacy path can prove the string
/// originated from the Agent call corridor.
pub(crate) fn try_agent_error_from_legacy(error: &str) -> Option<AgentCallError> {
    let lower = error.to_ascii_lowercase();
    let is_local_agent_failure = error == "Query canceled"
        || lower.starts_with("agent rpc call timed out")
        || lower.contains("agent stdin not available")
        || lower.contains("agent stdout not available")
        || lower.contains("agent runtime terminated")
        || lower.contains("agent runtime is unavailable")
        || lower.contains("agent runtime unavailable")
        || lower.contains("failed to write to agent stdin")
        || lower.contains("failed to flush agent stdin")
        || lower.contains("agent rpc task failed");
    (is_agent_rpc_response_error(error) || is_local_agent_failure).then(|| agent_error_from_legacy(error, None))
}

pub(crate) fn agent_recovery_decision(error: &str, scope: RecoveryScope) -> RecoveryDecision {
    RecoveryPolicy::decide(&agent_error_from_legacy(error, None), scope)
}

impl AgentCallError {
    pub fn into_legacy_string(self) -> String {
        match self {
            Self::Structured { rpc_code, message, context } => {
                let data = serde_json::json!({
                    "contractVersion": context.contract_version,
                    "category": category_name(context.category),
                    "retryable": context.retryable,
                    "sessionDisposition": context.session_disposition.as_str(),
                    "stage": stage_name(context.stage),
                    "operationOutcome": outcome_name(context.operation_outcome),
                    "agentSessionId": context.agent_session_id,
                    "sqlState": context.sql_state,
                    "vendorCode": context.vendor_code,
                    "exceptionClass": context.exception_class,
                });
                format_agent_rpc_error_parts(rpc_code, &message, Some(&data))
            }
            Self::Legacy { rpc_code, message, hints } => {
                let data = serde_json::json!({
                    "category": hints.category.map(category_name),
                    "retryable": hints.retryable,
                    "sessionDisposition": hints.session_disposition.map(|value| value.as_str()),
                    "stage": hints.stage.map(stage_name),
                    "operationOutcome": hints.operation_outcome.map(outcome_name),
                    "agentSessionId": hints.agent_session_id,
                });
                format_agent_rpc_error_parts(rpc_code.unwrap_or(-1), &message, Some(&data))
            }
            Self::ContractViolation { rpc_code, message, .. } => format_agent_rpc_error_parts(
                rpc_code.unwrap_or(-1),
                &message,
                Some(&serde_json::json!({ "contractVersion": 1 })),
            ),
            Self::Transport { message } => message,
            Self::Timeout { stage, .. } => format!("Agent RPC call timed out at {}", stage_name(stage)),
            Self::Canceled { .. } => "Query canceled".to_string(),
        }
    }

    fn into_legacy_string_with_session_id(self, agent_session_id: Option<&str>) -> String {
        let has_session_id = self.session_id().is_some();
        let message = self.into_legacy_string();
        match (has_session_id, agent_session_id) {
            (false, Some(agent_session_id)) => append_legacy_agent_session_id(&message, agent_session_id),
            _ => message,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Structured { context, .. } => context.agent_session_id.as_deref(),
            Self::Legacy { hints, .. } => hints.agent_session_id.as_deref(),
            _ => None,
        }
    }

    pub fn session_disposition(&self) -> Option<AgentSessionDisposition> {
        match self {
            Self::Structured { context, .. } => Some(context.session_disposition),
            Self::Legacy { hints, .. } => hints.session_disposition,
            _ => None,
        }
    }

    pub fn category(&self) -> Option<AgentErrorCategory> {
        match self {
            Self::Structured { context, .. } => Some(context.category),
            Self::Legacy { hints, .. } => hints.category,
            Self::Timeout { .. } => Some(AgentErrorCategory::Timeout),
            Self::Canceled { .. } => Some(AgentErrorCategory::Canceled),
            Self::ContractViolation { .. } | Self::Transport { .. } => None,
        }
    }

    pub fn operation_outcome(&self) -> AgentOperationOutcome {
        match self {
            Self::Structured { context, .. } => context.operation_outcome,
            Self::Legacy { hints, .. } => hints.operation_outcome.unwrap_or(AgentOperationOutcome::Unknown),
            Self::Timeout { operation_outcome, .. } | Self::Canceled { operation_outcome, .. } => *operation_outcome,
            Self::ContractViolation { .. } | Self::Transport { .. } => AgentOperationOutcome::Unknown,
        }
    }

    fn with_legacy_session_id(mut self, agent_session_id: Option<&str>) -> Self {
        if let (Self::Legacy { hints, .. }, Some(agent_session_id)) = (&mut self, agent_session_id) {
            hints.agent_session_id.get_or_insert_with(|| agent_session_id.to_string());
        }
        self
    }
}

fn append_legacy_agent_session_id(error: &str, agent_session_id: &str) -> String {
    if let Some((header, data)) = error.rsplit_once(AGENT_RPC_ERROR_DATA_MARKER) {
        if let Some((mut data, suffix)) = parse_legacy_agent_error_data(data) {
            if let Some(object) = data.as_object_mut() {
                object.insert("agentSessionId".to_string(), Value::String(agent_session_id.to_string()));
                return format!("{header}{AGENT_RPC_ERROR_DATA_MARKER}{data}{suffix}");
            }
        }
    }
    format!("{error}{AGENT_RPC_ERROR_DATA_MARKER}{}", serde_json::json!({ "agentSessionId": agent_session_id }))
}

impl fmt::Display for AgentCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Structured { message, .. } | Self::Legacy { message, .. } => f.write_str(message),
            Self::ContractViolation { message, .. } => write!(f, "Agent error contract violation: {message}"),
            Self::Transport { message } => f.write_str(message),
            Self::Timeout { stage, .. } => write!(f, "Agent RPC call timed out at {}", stage_name(*stage)),
            Self::Canceled { .. } => f.write_str("Query canceled"),
        }
    }
}

impl From<AgentCallError> for String {
    fn from(error: AgentCallError) -> Self {
        error.into_legacy_string()
    }
}

impl From<String> for AgentCallError {
    fn from(message: String) -> Self {
        Self::Transport { message }
    }
}

impl From<&str> for AgentCallError {
    fn from(message: &str) -> Self {
        Self::Transport { message: message.to_string() }
    }
}

fn parse_agent_call_error(
    error: &Value,
    strict_structured_errors: bool,
    expected_session_id: Option<&str>,
) -> AgentCallError {
    let rpc_code = error.get("code").and_then(Value::as_i64);
    let message = error.get("message").and_then(Value::as_str).unwrap_or("Unknown agent error").to_string();
    let data = error.get("data");

    if !strict_structured_errors {
        return AgentCallError::Legacy { rpc_code, message, hints: data.map(legacy_agent_hints).unwrap_or_default() };
    }

    let Some(data) = data.filter(|value| value.is_object()) else {
        return AgentCallError::ContractViolation {
            rpc_code,
            message,
            reason: ContractViolationReason::MissingContractVersion,
        };
    };
    match parse_structured_error_context(data, expected_session_id) {
        Ok(context) => AgentCallError::Structured { rpc_code: rpc_code.unwrap_or(-1), message, context },
        Err(reason) => AgentCallError::ContractViolation { rpc_code, message, reason },
    }
}

fn parse_structured_error_context(
    data: &Value,
    expected_session_id: Option<&str>,
) -> Result<AgentErrorContext, ContractViolationReason> {
    let Some(contract_version_value) = data.get("contractVersion") else {
        return Err(ContractViolationReason::MissingContractVersion);
    };
    let Some(contract_version) = contract_version_value.as_u64() else {
        return Err(ContractViolationReason::InvalidDataShape);
    };
    if contract_version != 1 {
        return Err(ContractViolationReason::UnsupportedContractVersion);
    }
    let context = serde_json::from_value::<AgentErrorContext>(data.clone())
        .map_err(|_| ContractViolationReason::InvalidDataShape)?;
    if context.contract_version != 1 {
        return Err(ContractViolationReason::UnsupportedContractVersion);
    }
    if let Some(expected_session_id) = expected_session_id {
        if context.agent_session_id.as_deref() != Some(expected_session_id) {
            return Err(ContractViolationReason::InvalidSessionId);
        }
    }
    if !valid_agent_error_combination(&context) {
        return Err(ContractViolationReason::InvalidCombination);
    }
    Ok(context)
}

fn legacy_agent_hints(data: &Value) -> LegacyAgentHints {
    LegacyAgentHints {
        category: data.get("category").and_then(|value| serde_json::from_value(value.clone()).ok()),
        retryable: data.get("retryable").and_then(Value::as_bool),
        session_disposition: match data.get("sessionDisposition").and_then(Value::as_str) {
            Some("keep") => Some(AgentSessionDisposition::Keep),
            Some("quarantine") => Some(AgentSessionDisposition::Quarantine),
            Some("replace_runtime") => Some(AgentSessionDisposition::ReplaceRuntime),
            _ => None,
        },
        stage: data.get("stage").and_then(|value| serde_json::from_value(value.clone()).ok()),
        operation_outcome: data.get("operationOutcome").and_then(|value| serde_json::from_value(value.clone()).ok()),
        agent_session_id: data.get("agentSessionId").and_then(Value::as_str).map(str::to_string),
    }
}

pub(crate) fn valid_agent_error_combination(context: &AgentErrorContext) -> bool {
    let expected_outcome = match context.stage {
        AgentErrorStage::Request | AgentErrorStage::Checkout | AgentErrorStage::Connect | AgentErrorStage::Validate => {
            AgentOperationOutcome::NotStarted
        }
        AgentErrorStage::Execute | AgentErrorStage::Fetch | AgentErrorStage::Cancel | AgentErrorStage::Close => {
            AgentOperationOutcome::Unknown
        }
    };
    if context.operation_outcome != expected_outcome {
        return false;
    }
    let valid_disposition = match context.category {
        AgentErrorCategory::Connection => context.session_disposition != AgentSessionDisposition::ReplaceRuntime,
        AgentErrorCategory::Sql => {
            matches!(
                context.stage,
                AgentErrorStage::Execute | AgentErrorStage::Fetch | AgentErrorStage::Cancel | AgentErrorStage::Close
            ) && context.session_disposition != AgentSessionDisposition::ReplaceRuntime
        }
        AgentErrorCategory::Resource => {
            context.session_disposition == AgentSessionDisposition::ReplaceRuntime
                || context.operation_outcome == AgentOperationOutcome::NotStarted
        }
        AgentErrorCategory::Protocol => {
            context.session_disposition != AgentSessionDisposition::ReplaceRuntime
                || context.operation_outcome == AgentOperationOutcome::Unknown
        }
        AgentErrorCategory::Timeout | AgentErrorCategory::Canceled => {
            context.session_disposition == AgentSessionDisposition::Quarantine
        }
    };
    if !valid_disposition {
        return false;
    }
    valid_ascii_diagnostic(context.sql_state.as_deref(), 16)
        && valid_ascii_diagnostic(context.exception_class.as_deref(), 160)
        && context.agent_session_id.as_deref().is_none_or(valid_ascii_identifier)
}

fn valid_ascii_diagnostic(value: Option<&str>, max_length: usize) -> bool {
    value.is_none_or(|value| {
        !value.is_empty() && value.len() <= max_length && value.bytes().all(|byte| byte.is_ascii_graphic())
    })
}

fn valid_ascii_identifier(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(crate) fn category_name(category: AgentErrorCategory) -> &'static str {
    match category {
        AgentErrorCategory::Connection => "connection",
        AgentErrorCategory::Sql => "sql",
        AgentErrorCategory::Resource => "resource",
        AgentErrorCategory::Protocol => "protocol",
        AgentErrorCategory::Timeout => "timeout",
        AgentErrorCategory::Canceled => "canceled",
    }
}

pub(crate) fn stage_name(stage: AgentErrorStage) -> &'static str {
    match stage {
        AgentErrorStage::Request => "request",
        AgentErrorStage::Checkout => "checkout",
        AgentErrorStage::Connect => "connect",
        AgentErrorStage::Validate => "validate",
        AgentErrorStage::Execute => "execute",
        AgentErrorStage::Fetch => "fetch",
        AgentErrorStage::Cancel => "cancel",
        AgentErrorStage::Close => "close",
    }
}

pub(crate) fn outcome_name(outcome: AgentOperationOutcome) -> &'static str {
    match outcome {
        AgentOperationOutcome::NotStarted => "not_started",
        AgentOperationOutcome::Unknown => "unknown",
    }
}

fn agent_error_stage(method: &str) -> AgentErrorStage {
    match method {
        "handshake" => AgentErrorStage::Request,
        "connect" | "open_session" | "test_connection" => AgentErrorStage::Connect,
        "validate_connection" | "validate_session" => AgentErrorStage::Validate,
        "cancel_session" => AgentErrorStage::Cancel,
        "close_session" | "disconnect" | "shutdown" | "close_query_session" | "close_table_read_session" => {
            AgentErrorStage::Close
        }
        "fetch_query_page" | "fetch_table_read_page" => AgentErrorStage::Fetch,
        _ => AgentErrorStage::Execute,
    }
}

fn agent_operation_outcome(method: &str) -> AgentOperationOutcome {
    match agent_error_stage(method) {
        AgentErrorStage::Request | AgentErrorStage::Checkout | AgentErrorStage::Connect | AgentErrorStage::Validate => {
            AgentOperationOutcome::NotStarted
        }
        _ => AgentOperationOutcome::Unknown,
    }
}

fn format_agent_rpc_error(error: &Value) -> String {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("Unknown agent error");
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(-1);
    format_agent_rpc_error_parts(code, message, error.get("data").filter(|data| data.is_object()))
}

fn format_agent_rpc_error_parts(code: i64, message: &str, data: Option<&Value>) -> String {
    let mut formatted = format!("Agent RPC error ({code}): {message}");
    if let Some(data) = data {
        formatted.push_str(AGENT_RPC_ERROR_DATA_MARKER);
        formatted.push_str(&data.to_string());
    }
    formatted
}

fn deserialize_cached_agent_result<T: DeserializeOwned>(result: Result<Value, String>) -> Result<T, String> {
    result
        .and_then(|value| serde_json::from_value(value).map_err(|e| format!("Failed to deserialize agent result: {e}")))
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
    cached_query: Option<CachedAgentQuery>,
}

/// Keeps serialized session RPC access separate from the process-level fail-stop handle.
/// A stuck RPC may hold `client` indefinitely, but it must never prevent terminating the
/// shared Agent runtime after the pool has been removed from routing.
pub struct PooledAgentClient {
    client: tokio::sync::Mutex<AgentDriverClient>,
    shared_runtime: Option<Arc<AgentRuntimeClient>>,
    agent_session_id: Option<String>,
}

impl PooledAgentClient {
    pub fn new(client: AgentDriverClient) -> Self {
        let shared_runtime = client.shared_runtime.clone();
        let agent_session_id = client.agent_session_id.clone();
        Self { client: tokio::sync::Mutex::new(client), shared_runtime, agent_session_id }
    }

    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, AgentDriverClient> {
        self.client.lock().await
    }

    pub fn try_lock(&self) -> Result<tokio::sync::MutexGuard<'_, AgentDriverClient>, tokio::sync::TryLockError> {
        self.client.try_lock()
    }

    pub fn shares_runtime_with(&self, other: &Self) -> bool {
        match (&self.shared_runtime, &other.shared_runtime) {
            (Some(runtime), Some(other_runtime)) => Arc::ptr_eq(runtime, other_runtime),
            _ => false,
        }
    }

    pub fn uses_runtime(&self, runtime: &Arc<AgentRuntimeClient>) -> bool {
        self.shared_runtime.as_ref().is_some_and(|current| Arc::ptr_eq(current, runtime))
    }

    pub fn matches_session_id(&self, session_id: &str) -> bool {
        self.agent_session_id.as_deref() == Some(session_id)
    }

    pub fn is_runtime_available(&self) -> bool {
        self.shared_runtime.as_ref().is_none_or(|runtime| !runtime.is_failed())
    }

    /// Terminates a protocol-v2 shared runtime without waiting for the logical session lock.
    /// Legacy single-session clients can only be killed immediately when they are not busy.
    pub fn fail_stop(&self) -> bool {
        if let Some(runtime) = &self.shared_runtime {
            runtime.kill();
            return true;
        }
        match self.client.try_lock() {
            Ok(mut client) => {
                client.kill();
                true
            }
            Err(_) => false,
        }
    }
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
    KvTtl,
    KvCas,
    KvListValues,
    KvStatus,
    KvHistory,
    EtcdCompaction,
    EtcdDefrag,
    EtcdWatch,
    EtcdLease,
    EtcdAuth,
    MongoDropDatabase,
    MultiSession,
    StructuredErrorV1,
}

pub(crate) fn legacy_agent_call_error(error: String, agent_session_id: Option<&str>) -> AgentCallError {
    if !is_agent_rpc_response_error(&error) {
        return AgentCallError::Transport { message: error };
    }
    let (header, data, suffix) =
        error.rsplit_once(AGENT_RPC_ERROR_DATA_MARKER).map_or((error.as_str(), None, ""), |(header, data)| {
            match parse_legacy_agent_error_data(data) {
                Some((data, suffix)) => (header, Some(data), suffix),
                None => (header, None, ""),
            }
        });
    let header_with_suffix = (!suffix.is_empty()).then(|| format!("{header}{suffix}"));
    let header = header_with_suffix.as_deref().unwrap_or(header);
    let (rpc_code, message) = parse_agent_rpc_error_header(header);
    if let Some(data) = data.as_ref().filter(|data| data.get("contractVersion").is_some()) {
        return match parse_structured_error_context(data, agent_session_id) {
            Ok(context) => AgentCallError::Structured { rpc_code: rpc_code.unwrap_or(-1), message, context },
            Err(reason) => AgentCallError::ContractViolation { rpc_code, message, reason },
        };
    }
    let mut hints = data.as_ref().map(legacy_agent_hints).unwrap_or_default();
    if hints.category.is_none() && is_legacy_connection_message(&message) {
        hints.category = Some(AgentErrorCategory::Connection);
        hints.session_disposition.get_or_insert(AgentSessionDisposition::Quarantine);
    }
    AgentCallError::Legacy { rpc_code, message, hints }.with_legacy_session_id(agent_session_id)
}

fn parse_legacy_agent_error_data(data: &str) -> Option<(Value, &str)> {
    let mut values = serde_json::Deserializer::from_str(data).into_iter::<Value>();
    let value = values.next()?.ok()?;
    Some((value, &data[values.byte_offset()..]))
}

pub(crate) fn append_legacy_error_context(error: &str, context: &str) -> String {
    if error.contains(context) {
        return error.to_string();
    }
    if let Some((header, data)) = error.rsplit_once(AGENT_RPC_ERROR_DATA_MARKER) {
        return format!("{header}\n{context}{AGENT_RPC_ERROR_DATA_MARKER}{data}");
    }
    format!("{error}\n{context}")
}

fn is_legacy_connection_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "connection lost",
        "connection reset",
        "broken pipe",
        "communications link failure",
        "sqlrecoverableexception",
        "sqlnontransientconnectionexception",
        "sqltransientconnectionexception",
        "network communication",
        "网络通信异常",
        "通信异常",
        "关闭的连接",
        "连接已关闭",
        "not connected",
        "end of stream",
        "end-of-file",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn parse_agent_rpc_error_header(header: &str) -> (Option<i64>, String) {
    let Some(rest) = header.strip_prefix("Agent RPC error (") else {
        return (None, header.to_string());
    };
    let Some((code, message)) = rest.split_once("): ") else {
        return (None, header.to_string());
    };
    (code.parse().ok(), message.to_string())
}

impl AgentCapability {
    pub const ALL: [Self; 21] = [
        Self::Connect,
        Self::TestConnection,
        Self::Metadata,
        Self::Query,
        Self::PagedQuery,
        Self::Transaction,
        Self::Ddl,
        Self::Kv,
        Self::KvTtl,
        Self::KvCas,
        Self::KvListValues,
        Self::KvStatus,
        Self::KvHistory,
        Self::EtcdCompaction,
        Self::EtcdDefrag,
        Self::EtcdWatch,
        Self::EtcdLease,
        Self::EtcdAuth,
        Self::MongoDropDatabase,
        Self::MultiSession,
        Self::StructuredErrorV1,
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
            Self::KvTtl => "kv_ttl",
            Self::KvCas => "kv_cas",
            Self::KvListValues => "kv_list_values",
            Self::KvStatus => "kv_status",
            Self::KvHistory => "kv_history",
            Self::EtcdCompaction => "etcd_compaction",
            Self::EtcdDefrag => "etcd_defrag",
            Self::EtcdWatch => "etcd_watch",
            Self::EtcdLease => "etcd_lease",
            Self::EtcdAuth => "etcd_auth",
            Self::MongoDropDatabase => "mongo_drop_database",
            Self::MultiSession => "multi_session",
            Self::StructuredErrorV1 => "structured_error_v1",
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
    ListConstraints,
    ListPartitions,
    ListSubpartitions,
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
    pub const ALL: [Self; 36] = [
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
        Self::ListConstraints,
        Self::ListPartitions,
        Self::ListSubpartitions,
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
            Self::ListConstraints => "list_constraints",
            Self::ListPartitions => "list_partitions",
            Self::ListSubpartitions => "list_subpartitions",
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
    #[serde(default)]
    pub identifier_quote: String,
    #[serde(default)]
    pub compatibility_mode: Option<String>,
    #[serde(default)]
    pub database_info: Option<DatabaseConnectionInfo>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
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
    FindOne,
    ExplainFind,
    FindDocumentsExtendedJson,
    CountDocuments,
    ServerVersion,
    CreateIndex,
    DropIndexes,
    DropCollection,
    DropDatabase,
    InsertDocument,
    UpdateDocument,
    UpdateDocuments,
    DeleteDocument,
    DeleteDocuments,
}

impl MongoAgentMethod {
    pub const ALL: [Self; 17] = [
        Self::ListDatabases,
        Self::ListCollections,
        Self::FindDocuments,
        Self::FindOne,
        Self::ExplainFind,
        Self::FindDocumentsExtendedJson,
        Self::CountDocuments,
        Self::ServerVersion,
        Self::CreateIndex,
        Self::DropIndexes,
        Self::DropCollection,
        Self::DropDatabase,
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
            Self::FindOne => "find_one",
            Self::ExplainFind => "explain_find",
            Self::FindDocumentsExtendedJson => "find_documents_extended_json",
            Self::CountDocuments => "count_documents",
            Self::ServerVersion => "server_version",
            Self::CreateIndex => "create_index",
            Self::DropIndexes => "drop_indexes",
            Self::DropCollection => "drop_collection",
            Self::DropDatabase => "drop_database",
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
    Rename,
    History,
    Status,
    Compact,
    Defrag,
    WatchStart,
    WatchPoll,
    WatchStop,
    LeaseList,
    LeaseGet,
    LeaseGrant,
    LeaseKeepalive,
    LeaseRevoke,
    AuthUserList,
    AuthUserGet,
    AuthUserAdd,
    AuthUserDelete,
    AuthUserChangePassword,
    AuthUserGrantRole,
    AuthUserRevokeRole,
    AuthRoleList,
    AuthRoleGet,
    AuthRoleAdd,
    AuthRoleDelete,
    AuthRoleGrantPermission,
    AuthRoleRevokePermission,
}

impl AgentKvMethod {
    pub const ALL: [Self; 30] = [
        Self::ListPrefix,
        Self::Get,
        Self::Put,
        Self::Delete,
        Self::Rename,
        Self::History,
        Self::Status,
        Self::Compact,
        Self::Defrag,
        Self::WatchStart,
        Self::WatchPoll,
        Self::WatchStop,
        Self::LeaseList,
        Self::LeaseGet,
        Self::LeaseGrant,
        Self::LeaseKeepalive,
        Self::LeaseRevoke,
        Self::AuthUserList,
        Self::AuthUserGet,
        Self::AuthUserAdd,
        Self::AuthUserDelete,
        Self::AuthUserChangePassword,
        Self::AuthUserGrantRole,
        Self::AuthUserRevokeRole,
        Self::AuthRoleList,
        Self::AuthRoleGet,
        Self::AuthRoleAdd,
        Self::AuthRoleDelete,
        Self::AuthRoleGrantPermission,
        Self::AuthRoleRevokePermission,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ListPrefix => "kv_list_prefix",
            Self::Get => "kv_get",
            Self::Put => "kv_put",
            Self::Delete => "kv_delete",
            Self::Rename => "kv_rename",
            Self::History => "kv_history",
            Self::Status => "kv_status",
            Self::Compact => "etcd_compact",
            Self::Defrag => "etcd_defrag",
            Self::WatchStart => "etcd_watch_start",
            Self::WatchPoll => "etcd_watch_poll",
            Self::WatchStop => "etcd_watch_stop",
            Self::LeaseList => "etcd_lease_list",
            Self::LeaseGet => "etcd_lease_get",
            Self::LeaseGrant => "etcd_lease_grant",
            Self::LeaseKeepalive => "etcd_lease_keepalive_once",
            Self::LeaseRevoke => "etcd_lease_revoke",
            Self::AuthUserList => "etcd_auth_user_list",
            Self::AuthUserGet => "etcd_auth_user_get",
            Self::AuthUserAdd => "etcd_auth_user_add",
            Self::AuthUserDelete => "etcd_auth_user_delete",
            Self::AuthUserChangePassword => "etcd_auth_user_change_password",
            Self::AuthUserGrantRole => "etcd_auth_user_grant_role",
            Self::AuthUserRevokeRole => "etcd_auth_user_revoke_role",
            Self::AuthRoleList => "etcd_auth_role_list",
            Self::AuthRoleGet => "etcd_auth_role_get",
            Self::AuthRoleAdd => "etcd_auth_role_add",
            Self::AuthRoleDelete => "etcd_auth_role_delete",
            Self::AuthRoleGrantPermission => "etcd_auth_role_grant_permission",
            Self::AuthRoleRevokePermission => "etcd_auth_role_revoke_permission",
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
        let mut child = spawn_agent_process(&launch)?;

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
            cached_query: None,
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
            cached_query: None,
        }
    }

    /// Send a JSON-RPC 2.0 request and wait for the response.
    pub async fn call<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<T, String> {
        let agent_session_id = self.agent_session_id.clone();
        self.call_typed(method, params)
            .await
            .map_err(|error| error.into_legacy_string_with_session_id(agent_session_id.as_deref()))
    }

    pub async fn call_typed<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<T, AgentCallError> {
        self.call_typed_with_timeout(method, params, Some(Duration::from_secs(RPC_TIMEOUT_SECS))).await
    }

    /// Send a JSON-RPC 2.0 request and wait for the response.
    /// `None` disables the client-side RPC timeout for long-running query calls.
    pub async fn call_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        let agent_session_id = self.agent_session_id.clone();
        self.call_typed_with_timeout(method, params, timeout_duration)
            .await
            .map_err(|error| error.into_legacy_string_with_session_id(agent_session_id.as_deref()))
    }

    pub async fn call_typed_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, AgentCallError> {
        self.call_typed_with_timeout_and_cancel(method, params, timeout_duration, None).await
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
        let agent_session_id = self.agent_session_id.clone();
        self.call_typed_with_timeout_and_cancel(method, params, timeout_duration, cancel_token)
            .await
            .map_err(|error| error.into_legacy_string_with_session_id(agent_session_id.as_deref()))
    }

    pub async fn call_typed_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: &str,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        if let Some(runtime) = &self.shared_runtime {
            let agent_session_id = self.agent_session_id.clone();
            let mut params = params;
            if method != AgentMethod::Handshake.as_str()
                && method != AgentMethod::TestConnection.as_str()
                && method != AgentMethod::Shutdown.as_str()
            {
                let session_id = agent_session_id.as_ref().ok_or("Shared Agent session id is missing")?;
                params
                    .as_object_mut()
                    .ok_or_else(|| "Agent RPC parameters must be an object".to_string())?
                    .insert("agentSessionId".to_string(), Value::String(session_id.clone()));
            }
            return runtime
                .call_typed(method, params, timeout_duration, cancel_token)
                .await
                .map_err(|error| error.with_legacy_session_id(agent_session_id.as_deref()));
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
            return Err(AgentCallError::Transport { message: self.format_agent_process_error(&e) });
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
                Err(format_agent_rpc_error(err))
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
                        return Err(AgentCallError::Canceled {
                            stage: agent_error_stage(method),
                            operation_outcome: agent_operation_outcome(method),
                        });
                    }
                    result = tokio::time::timeout(duration, response_task) => match result {
                        Ok(result) => result,
                        Err(_) => {
                            self.kill();
                            return Err(AgentCallError::Timeout {
                                stage: agent_error_stage(method),
                                operation_outcome: agent_operation_outcome(method),
                            });
                        }
                    },
                }
            }
            (Some(duration), None) => match tokio::time::timeout(duration, response_task).await {
                Ok(result) => result,
                Err(_) => {
                    self.kill();
                    return Err(AgentCallError::Timeout {
                        stage: agent_error_stage(method),
                        operation_outcome: agent_operation_outcome(method),
                    });
                }
            },
            (None, Some(token)) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        self.kill();
                        return Err(AgentCallError::Canceled {
                            stage: agent_error_stage(method),
                            operation_outcome: agent_operation_outcome(method),
                        });
                    }
                    result = response_task => result,
                }
            }
            (None, None) => response_task.await,
        }
        .map_err(|e| AgentCallError::Transport { message: format!("Agent RPC task failed: {e}") })?;

        let _ = self.stdout.insert(returned_reader);
        result
            .map_err(
                |error| {
                    if is_agent_rpc_response_error(&error) {
                        error
                    } else {
                        self.format_agent_process_error(&error)
                    }
                },
            )
            .map_err(|error| legacy_agent_call_error(error, self.agent_session_id.as_deref()))
    }

    pub async fn call_method<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
    ) -> Result<T, String> {
        self.call(method.as_str(), params).await
    }

    pub async fn call_method_typed<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
    ) -> Result<T, AgentCallError> {
        self.call_typed(method.as_str(), params).await
    }

    pub async fn call_method_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_with_timeout(method.as_str(), params, timeout_duration).await
    }

    pub async fn call_method_typed_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, AgentCallError> {
        self.call_typed_with_timeout(method.as_str(), params, timeout_duration).await
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

    pub async fn call_method_typed_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        method: AgentMethod,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        self.call_typed_with_timeout_and_cancel(method.as_str(), params, timeout_duration, cancel_token).await
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

    pub async fn validate_connection_typed(
        &mut self,
        timeout_duration: Option<Duration>,
    ) -> Result<Value, AgentCallError> {
        self.call_method_typed_with_timeout(AgentMethod::ValidateConnection, serde_json::json!({}), timeout_duration)
            .await
    }

    pub async fn connection_info(&mut self, timeout_duration: Option<Duration>) -> Result<AgentConnectionInfo, String> {
        self.call_method_with_timeout(AgentMethod::ConnectionInfo, serde_json::json!({}), timeout_duration).await
    }

    pub async fn disconnect(&mut self) -> Result<Value, String> {
        self.invalidate_cached_query();
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
        self.list_schemas_filtered(database, None, false, timeout_duration).await
    }

    pub async fn list_schemas_filtered<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        visible_schemas: Option<&[String]>,
        show_system_schemas: bool,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        let mut params = serde_json::json!({ "database": database });
        if let Some(visible_schemas) = visible_schemas {
            params["visible_schemas"] = serde_json::json!(visible_schemas);
        }
        if show_system_schemas {
            params["show_system_schemas"] = serde_json::Value::Bool(true);
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

    pub async fn get_table_comment<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        // Kingbase Go exposes this driver-specific RPC without widening the common
        // agent protocol contract that every SQL agent is expected to implement.
        self.call_with_timeout(
            "get_table_comment",
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

    pub async fn list_constraints<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListConstraints,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn list_partitions<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListPartitions,
            agent_schema_table_params(database, schema, table),
            timeout_duration,
        )
        .await
    }

    pub async fn list_subpartitions<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.call_method_with_timeout(
            AgentMethod::ListSubpartitions,
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
        self.invalidate_cached_query();
        self.call_method(AgentMethod::ExecuteQuery, params).await
    }

    pub async fn execute_query_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.invalidate_cached_query();
        self.call_method_with_timeout(AgentMethod::ExecuteQuery, params, timeout_duration).await
    }

    pub async fn execute_query_typed_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, AgentCallError> {
        self.invalidate_cached_query();
        self.call_method_typed_with_timeout(AgentMethod::ExecuteQuery, params, timeout_duration).await
    }

    pub async fn execute_query_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        self.invalidate_cached_query();
        self.call_method_with_timeout_and_cancel(AgentMethod::ExecuteQuery, params, timeout_duration, cancel_token)
            .await
    }

    pub async fn execute_query_typed_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        self.invalidate_cached_query();
        self.call_method_typed_with_timeout_and_cancel(
            AgentMethod::ExecuteQuery,
            params,
            timeout_duration,
            cancel_token,
        )
        .await
    }

    pub async fn execute_query_cached_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        cache_key: String,
        cache_ttl: Duration,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        let now = Instant::now();
        if let Some(cached) = self.cached_query.as_ref() {
            if cached.key == cache_key && cached.expires_at > now {
                return deserialize_cached_agent_result(cached.result.clone());
            }
        }

        self.cached_query = None;
        let result = self.call_method_with_timeout::<Value>(AgentMethod::ExecuteQuery, params, timeout_duration).await;
        self.cached_query =
            Some(CachedAgentQuery { key: cache_key, expires_at: Instant::now() + cache_ttl, result: result.clone() });
        deserialize_cached_agent_result(result)
    }

    pub async fn execute_query_page<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.invalidate_cached_query();
        self.call_method(AgentMethod::ExecuteQueryPage, params).await
    }

    pub async fn execute_query_page_with_timeout<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.invalidate_cached_query();
        self.call_method_with_timeout(AgentMethod::ExecuteQueryPage, params, timeout_duration).await
    }

    pub async fn execute_query_page_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, String> {
        self.invalidate_cached_query();
        self.call_method_with_timeout_and_cancel(AgentMethod::ExecuteQueryPage, params, timeout_duration, cancel_token)
            .await
    }

    pub async fn execute_query_page_typed_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        self.invalidate_cached_query();
        self.call_method_typed_with_timeout_and_cancel(
            AgentMethod::ExecuteQueryPage,
            params,
            timeout_duration,
            cancel_token,
        )
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

    pub async fn fetch_query_page_typed_with_timeout_and_cancel<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
        timeout_duration: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<T, AgentCallError> {
        self.call_method_typed_with_timeout_and_cancel(
            AgentMethod::FetchQueryPage,
            params,
            timeout_duration,
            cancel_token,
        )
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
        self.invalidate_cached_query();
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
        self.invalidate_cached_query();
        self.call_method(AgentMethod::ExecuteTransaction, agent_transaction_params(database, statements, schema)).await
    }

    pub async fn execute_transaction_typed<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: Option<&str>,
        statements: &[String],
        schema: Option<&str>,
    ) -> Result<T, AgentCallError> {
        self.invalidate_cached_query();
        self.call_method_typed(AgentMethod::ExecuteTransaction, agent_transaction_params(database, statements, schema))
            .await
    }

    pub async fn execute_batch<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: Option<&str>,
        statements: &[String],
        schema: Option<&str>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, String> {
        self.invalidate_cached_query();
        self.call_method_with_timeout(
            AgentMethod::ExecuteBatch,
            agent_transaction_params(database, statements, schema),
            timeout_duration,
        )
        .await
    }

    pub async fn execute_batch_typed<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: Option<&str>,
        statements: &[String],
        schema: Option<&str>,
        timeout_duration: Option<Duration>,
    ) -> Result<T, AgentCallError> {
        self.invalidate_cached_query();
        self.call_method_typed_with_timeout(
            AgentMethod::ExecuteBatch,
            agent_transaction_params(database, statements, schema),
            timeout_duration,
        )
        .await
    }

    fn invalidate_cached_query(&mut self) {
        self.cached_query = None;
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

    /// Request collection metadata while accepting old Agents that still
    /// return the historical string array and ignore `include_types`.
    pub async fn mongo_list_collection_specs<T: DeserializeOwned + Send + 'static>(
        &mut self,
        database: &str,
    ) -> Result<T, String> {
        self.call_mongo_method(
            MongoAgentMethod::ListCollections,
            serde_json::json!({ "database": database, "include_types": true }),
        )
        .await
    }

    pub async fn mongo_find_documents<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::FindDocuments, params).await
    }

    pub async fn mongo_find_one<T: DeserializeOwned + Send + 'static>(&mut self, params: Value) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::FindOne, params).await
    }

    pub async fn mongo_explain_find<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::ExplainFind, params).await
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

    pub async fn mongo_drop_database<T: DeserializeOwned + Send + 'static>(
        &mut self,
        params: Value,
    ) -> Result<T, String> {
        self.call_mongo_method(MongoAgentMethod::DropDatabase, params).await
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
    if matches!(
        capability,
        AgentCapability::Kv
            | AgentCapability::KvTtl
            | AgentCapability::KvCas
            | AgentCapability::KvListValues
            | AgentCapability::KvStatus
            | AgentCapability::KvHistory
            | AgentCapability::EtcdCompaction
            | AgentCapability::EtcdDefrag
            | AgentCapability::EtcdWatch
            | AgentCapability::EtcdLease
            | AgentCapability::EtcdAuth
            | AgentCapability::MongoDropDatabase
    ) {
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

pub(crate) fn validate_dameng_java_system_properties(options: &[String]) -> Result<(), String> {
    for (index, option) in options.iter().enumerate() {
        let option = option.trim();
        let Some(property) = option.strip_prefix("-D") else {
            return Err(java_system_property_error(index));
        };
        let key = property.split_once('=').map_or(property, |(key, _)| key);
        if key.is_empty() || key.chars().any(char::is_whitespace) || option.contains('"') || option.contains('\'') {
            return Err(java_system_property_error(index));
        }
    }
    Ok(())
}

fn java_system_property_error(index: usize) -> String {
    format!(
        "Dameng JVM option #{} must be a Java system property (-Dkey or -Dkey=value) without shell quotes",
        index + 1
    )
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

    if agent_jar_path_matches_key(jar_path, "informix") {
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

fn spawn_agent_process(launch: &AgentLaunchSpec) -> Result<Child, String> {
    match agent_command(launch).spawn() {
        Ok(child) => Ok(child),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            let repaired = repair_native_agent_execute_permission(&launch.program).map_err(|repair_error| {
                format!(
                    "Failed to spawn agent process {}: {error}; failed to restore executable permission: {repair_error}",
                    launch_display(launch)
                )
            })?;
            if !repaired {
                return Err(format!("Failed to spawn agent process {}: {error}", launch_display(launch)));
            }
            agent_command(launch).spawn().map_err(|retry_error| {
                format!("Failed to spawn agent process {}: {retry_error}", launch_display(launch))
            })
        }
        Err(error) => Err(format!("Failed to spawn agent process {}: {error}", launch_display(launch))),
    }
}

fn agent_command(launch: &AgentLaunchSpec) -> Command {
    let mut command = crate::process::new_std_command(&launch.program);
    command.args(&launch.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(working_dir) = &launch.working_dir {
        command.current_dir(working_dir);
    }
    remove_agent_proxy_env(&mut command);
    command
}

fn repair_native_agent_execute_permission(program: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if !program.is_absolute() || program.file_name().and_then(|name| name.to_str()) != Some("agent") {
            return Ok(false);
        }
        let metadata = program
            .metadata()
            .map_err(|error| format!("Failed to inspect native agent {}: {error}", program.display()))?;
        if !metadata.is_file() {
            return Ok(false);
        }
        let mut permissions = metadata.permissions();
        let mode = permissions.mode();
        if mode & 0o100 != 0 {
            return Ok(false);
        }
        permissions.set_mode(mode | 0o100);
        std::fs::set_permissions(program, permissions)
            .map_err(|error| format!("Failed to make native agent executable {}: {error}", program.display()))?;
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        let _ = program;
        Ok(false)
    }
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

fn is_agent_rpc_response_error(message: &str) -> bool {
    message.trim_start().starts_with("Agent RPC error (")
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
    #[cfg(test)]
    pub(crate) fn test_stub() -> Self {
        Self {
            child: None,
            stdin: None,
            stdout: None,
            stderr_tail: Arc::new(Mutex::new(StderrTail::default())),
            handshake: None,
            next_id: 0,
            shared_runtime: None,
            agent_session_id: None,
            cached_query: None,
        }
    }

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
        agent_close_query_session_params, agent_error_from_legacy, agent_handshake_params, agent_java_args,
        agent_java_args_with_extra, agent_java_args_with_extra_opts, agent_object_source_params, agent_proxy_env_vars,
        agent_schema_params, agent_schema_table_params, agent_supports_capability, agent_transaction_params,
        append_legacy_error_context, decode_agent_response, format_agent_process_error, format_agent_startup_error,
        is_agent_rpc_response_error, is_unsupported_handshake_error, legacy_agent_call_error, mongo_collection_params,
        mongo_database_params, mongo_document_id_params, parse_agent_java_opts, read_agent_line,
        start_stderr_collector, validate_dameng_java_system_properties, AgentCallError, AgentCapability,
        AgentDriverClient, AgentErrorCategory, AgentErrorContext, AgentErrorStage, AgentHandshake, AgentKvMethod,
        AgentLaunchSpec, AgentMethod, AgentOperationOutcome, AgentRuntimeClient, AgentSessionDisposition,
        AgentTableReadCloseParams, AgentTableReadPageParams, AgentTableReadStartParams, MongoAgentMethod, StderrTail,
        AGENT_PROTOCOL_VERSION,
    };
    use crate::agent_recovery::{RecoveryDecision, RecoveryPolicy, RecoveryScope};
    use std::io::Cursor;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tokio_util::sync::CancellationToken;

    #[cfg(unix)]
    #[test]
    fn spawn_repairs_missing_native_execute_permission_after_eacces() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("dbx-agent-permission-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let program = dir.join("agent");
        fs::write(&program, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o600)).unwrap();

        let mut child = super::spawn_agent_process(&AgentLaunchSpec::new(&program)).unwrap();
        assert!(child.wait().unwrap().success());
        assert_ne!(fs::metadata(&program).unwrap().permissions().mode() & 0o100, 0);

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn spawn_keeps_existing_native_execute_permissions() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("dbx-agent-permission-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let program = dir.join("agent");
        fs::write(&program, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();

        let mut child = super::spawn_agent_process(&AgentLaunchSpec::new(&program)).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(fs::metadata(&program).unwrap().permissions().mode() & 0o777, 0o700);

        fs::remove_dir_all(dir).unwrap();
    }

    fn test_python() -> &'static str {
        if cfg!(windows) {
            "python"
        } else {
            "python3"
        }
    }

    fn test_shell_command(unix_script: &str, windows_script: &str) -> Command {
        if cfg!(windows) {
            let mut command = Command::new("powershell");
            command.args(["-NoProfile", "-Command", windows_script]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", unix_script]);
            command
        }
    }

    #[test]
    fn structured_agent_error_data_survives_legacy_string_boundary() {
        let response = serde_json::json!({
            "error": {
                "code": -1,
                "message": "connection lost",
                "data": {
                    "category": "connection",
                    "retryable": true,
                    "sessionDisposition": "quarantine",
                    "agentSessionId": "session-generation-1",
                    "stage": "execute"
                }
            }
        });

        let error = decode_agent_response::<serde_json::Value>(response, false, None).unwrap_err().into_legacy_string();

        assert!(error.starts_with("Agent RPC error (-1): connection lost"));
        let decoded = agent_error_from_legacy(&error, None);
        assert_eq!(decoded.category(), Some(AgentErrorCategory::Connection));
        assert_eq!(decoded.session_id(), Some("session-generation-1"));
        assert_eq!(decoded.session_disposition(), Some(AgentSessionDisposition::Quarantine));
    }

    #[test]
    fn strict_structured_error_requires_v1_and_preserves_diagnostics() {
        let response = serde_json::json!({
            "error": {
                "code": -6007,
                "message": "connection lost",
                "data": {
                    "contractVersion": 1,
                    "category": "connection",
                    "retryable": false,
                    "sessionDisposition": "quarantine",
                    "stage": "execute",
                    "operationOutcome": "unknown",
                    "agentSessionId": "session-1",
                    "sqlState": "08006",
                    "vendorCode": -6007,
                    "exceptionClass": "java.sql.SQLRecoverableException",
                    "futureField": "allowed"
                }
            }
        });

        let error = decode_agent_response::<serde_json::Value>(response, true, Some("session-1")).unwrap_err();
        match error {
            AgentCallError::Structured { rpc_code, context, .. } => {
                assert_eq!(rpc_code, -6007);
                assert_eq!(context.contract_version, 1);
                assert_eq!(context.category, AgentErrorCategory::Connection);
                assert_eq!(context.stage, AgentErrorStage::Execute);
                assert_eq!(context.operation_outcome, AgentOperationOutcome::Unknown);
                assert_eq!(context.sql_state.as_deref(), Some("08006"));
            }
            other => panic!("expected structured error, got {other:?}"),
        }
    }

    #[test]
    fn strict_structured_error_keeps_identity_across_legacy_api_boundary() {
        let response = serde_json::json!({
            "error": {
                "code": -6007,
                "message": "connection lost",
                "data": {
                    "contractVersion": 1,
                    "category": "connection",
                    "retryable": false,
                    "sessionDisposition": "quarantine",
                    "stage": "execute",
                    "operationOutcome": "unknown",
                    "agentSessionId": "session-1"
                }
            }
        });
        let legacy = decode_agent_response::<serde_json::Value>(response, true, Some("session-1"))
            .unwrap_err()
            .into_legacy_string();
        let legacy = append_legacy_error_context(&legacy, "SQL text omitted");

        assert!(matches!(agent_error_from_legacy(&legacy, Some("session-1")), AgentCallError::Structured { .. }));
    }

    #[test]
    fn contract_violation_keeps_identity_when_legacy_api_adds_session_id() {
        let legacy = AgentCallError::ContractViolation {
            rpc_code: Some(-6007),
            message: "invalid strict error".to_string(),
            reason: super::ContractViolationReason::InvalidDataShape,
        }
        .into_legacy_string_with_session_id(Some("session-1"));

        assert!(matches!(
            agent_error_from_legacy(&legacy, Some("session-1")),
            AgentCallError::ContractViolation { .. }
        ));
        assert_eq!(crate::backend_error::BackendError::from_legacy_string(&legacy).code(), "DBX-JDBC-5002");
    }

    #[test]
    fn legacy_adapter_preserves_strict_identity_when_old_callers_append_context() {
        let structured = AgentCallError::Structured {
            rpc_code: -6007,
            message: "connection lost".to_string(),
            context: AgentErrorContext {
                contract_version: 1,
                category: AgentErrorCategory::Connection,
                retryable: false,
                session_disposition: AgentSessionDisposition::Quarantine,
                stage: AgentErrorStage::Execute,
                operation_outcome: AgentOperationOutcome::Unknown,
                agent_session_id: Some("session-1".to_string()),
                sql_state: None,
                vendor_code: None,
                exception_class: None,
            },
        };
        let suffixed = format!("{}: fallback failed", structured.into_legacy_string());
        assert!(matches!(agent_error_from_legacy(&suffixed, Some("session-1")), AgentCallError::Structured { .. }));

        let violation = AgentCallError::ContractViolation {
            rpc_code: Some(-6007),
            message: "invalid strict error".to_string(),
            reason: super::ContractViolationReason::InvalidDataShape,
        };
        let suffixed = format!("{}: fallback failed", violation.into_legacy_string());
        assert!(matches!(agent_error_from_legacy(&suffixed, None), AgentCallError::ContractViolation { .. }));
        assert_eq!(crate::backend_error::BackendError::from_legacy_string(&suffixed).code(), "DBX-JDBC-5002");
    }

    #[test]
    fn strict_structured_error_rejects_missing_fields_unknown_enums_and_session_mismatch() {
        let base = serde_json::json!({
            "contractVersion": 1,
            "category": "connection",
            "retryable": false,
            "sessionDisposition": "keep",
            "stage": "connect",
            "operationOutcome": "not_started",
            "agentSessionId": "session-1"
        });

        let missing = serde_json::json!({"error": {"message": "bad", "data": {"contractVersion": 1}}});
        assert!(matches!(
            decode_agent_response::<serde_json::Value>(missing, true, None).unwrap_err(),
            AgentCallError::ContractViolation { reason: super::ContractViolationReason::InvalidDataShape, .. }
        ));

        let mut unknown_enum = base.clone();
        unknown_enum["category"] = serde_json::json!("future");
        let response = serde_json::json!({"error": {"message": "bad", "data": unknown_enum}});
        assert!(matches!(
            decode_agent_response::<serde_json::Value>(response, true, None).unwrap_err(),
            AgentCallError::ContractViolation { reason: super::ContractViolationReason::InvalidDataShape, .. }
        ));

        let response = serde_json::json!({"error": {"message": "bad", "data": base}});
        assert!(matches!(
            decode_agent_response::<serde_json::Value>(response, true, Some("other")).unwrap_err(),
            AgentCallError::ContractViolation { reason: super::ContractViolationReason::InvalidSessionId, .. }
        ));
    }

    #[test]
    fn strict_structured_error_rejects_inconsistent_operation_outcome() {
        let response = serde_json::json!({
            "error": {
                "message": "bad",
                "data": {
                    "contractVersion": 1,
                    "category": "connection",
                    "retryable": false,
                    "sessionDisposition": "keep",
                    "stage": "connect",
                    "operationOutcome": "unknown"
                }
            }
        });

        assert!(matches!(
            decode_agent_response::<serde_json::Value>(response, true, None).unwrap_err(),
            AgentCallError::ContractViolation { reason: super::ContractViolationReason::InvalidCombination, .. }
        ));
    }

    #[test]
    fn strict_structured_error_rejects_dangerous_disposition_and_invalid_diagnostics() {
        let dangerous = serde_json::json!({
            "error": {
                "message": "bad",
                "data": {
                    "contractVersion": 1,
                    "category": "protocol",
                    "retryable": false,
                    "sessionDisposition": "replace_runtime",
                    "stage": "request",
                    "operationOutcome": "not_started"
                }
            }
        });
        assert!(matches!(
            decode_agent_response::<serde_json::Value>(dangerous, true, None).unwrap_err(),
            AgentCallError::ContractViolation { reason: super::ContractViolationReason::InvalidCombination, .. }
        ));

        let invalid_diagnostic = serde_json::json!({
            "error": {
                "message": "bad",
                "data": {
                    "contractVersion": 1,
                    "category": "sql",
                    "retryable": false,
                    "sessionDisposition": "keep",
                    "stage": "execute",
                    "operationOutcome": "unknown",
                    "sqlState": "08\n006"
                }
            }
        });
        assert!(matches!(
            decode_agent_response::<serde_json::Value>(invalid_diagnostic, true, None).unwrap_err(),
            AgentCallError::ContractViolation { reason: super::ContractViolationReason::InvalidCombination, .. }
        ));
    }

    #[test]
    fn recovery_policy_never_replays_user_operations_and_retries_metadata_once() {
        let quarantined = AgentCallError::Structured {
            rpc_code: -1,
            message: "connection lost".to_string(),
            context: AgentErrorContext {
                contract_version: 1,
                category: AgentErrorCategory::Connection,
                retryable: true,
                session_disposition: AgentSessionDisposition::Quarantine,
                stage: AgentErrorStage::Execute,
                operation_outcome: AgentOperationOutcome::Unknown,
                agent_session_id: Some("session-1".to_string()),
                sql_state: Some("08006".to_string()),
                vendor_code: None,
                exception_class: None,
            },
        };

        assert_eq!(
            RecoveryPolicy::decide(&quarantined, RecoveryScope::UserOperation),
            RecoveryDecision::QuarantineSession
        );
        assert_eq!(
            RecoveryPolicy::decide(&quarantined, RecoveryScope::ReadOnlyMetadata { retried: false }),
            RecoveryDecision::RetryReadOnlyMetadata
        );
        assert_eq!(
            RecoveryPolicy::decide(&quarantined, RecoveryScope::ReadOnlyMetadata { retried: true }),
            RecoveryDecision::QuarantineSession
        );
    }

    #[test]
    fn recovery_policy_is_conservative_for_runtime_local_and_legacy_failures() {
        let replace = AgentCallError::Structured {
            rpc_code: -1,
            message: "runtime saturated".to_string(),
            context: AgentErrorContext {
                contract_version: 1,
                category: AgentErrorCategory::Resource,
                retryable: false,
                session_disposition: AgentSessionDisposition::ReplaceRuntime,
                stage: AgentErrorStage::Execute,
                operation_outcome: AgentOperationOutcome::Unknown,
                agent_session_id: Some("session-1".to_string()),
                sql_state: None,
                vendor_code: None,
                exception_class: None,
            },
        };
        assert_eq!(RecoveryPolicy::decide(&replace, RecoveryScope::Keepalive), RecoveryDecision::ReplaceRuntime);
        let structured_timeout = AgentCallError::Structured {
            rpc_code: -1,
            message: "timed out".to_string(),
            context: AgentErrorContext {
                contract_version: 1,
                category: AgentErrorCategory::Timeout,
                retryable: false,
                session_disposition: AgentSessionDisposition::Keep,
                stage: AgentErrorStage::Execute,
                operation_outcome: AgentOperationOutcome::Unknown,
                agent_session_id: Some("session-1".to_string()),
                sql_state: None,
                vendor_code: None,
                exception_class: None,
            },
        };
        assert_eq!(
            RecoveryPolicy::decide(&structured_timeout, RecoveryScope::UserOperation),
            RecoveryDecision::QuarantineSession
        );
        assert_eq!(
            RecoveryPolicy::decide(
                &AgentCallError::Timeout {
                    stage: AgentErrorStage::Connect,
                    operation_outcome: AgentOperationOutcome::NotStarted,
                },
                RecoveryScope::UserOperation,
            ),
            RecoveryDecision::QuarantineSession
        );

        let legacy = legacy_agent_call_error(
            "Agent RPC error (-1): SQLRecoverableException: connection lost".to_string(),
            Some("legacy-session"),
        );
        assert_eq!(legacy.category(), Some(AgentErrorCategory::Connection));
        assert_eq!(
            RecoveryPolicy::decide(&legacy, RecoveryScope::ReadOnlyMetadata { retried: false }),
            RecoveryDecision::RetryReadOnlyMetadata
        );
    }

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
    fn connection_java_system_properties_allow_flags_and_values_with_spaces() {
        validate_dameng_java_system_properties(&[
            "-Djava.net.preferIPv4Stack".to_string(),
            "-Ddm.config.path=C:\\Program Files\\DM\\dm.ini".to_string(),
        ])
        .unwrap();
    }

    #[test]
    fn connection_java_system_properties_reject_launcher_options_and_empty_keys() {
        for option in ["-jar", "-javaagent:agent.jar", "-agentpath:agent.dll", "-Xmx1g", "", "-D", "-D=value"] {
            assert!(validate_dameng_java_system_properties(&[option.to_string()]).is_err(), "{option}");
        }
    }

    #[test]
    fn connection_java_system_properties_reject_shell_quotes() {
        assert!(validate_dameng_java_system_properties(&[
            r#"-Ddm.config.path="C:\Program Files\DM\dm.ini""#.to_string(),
        ])
        .is_err());
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
        let mut child = test_shell_command(
            "sleep 0.05; echo 'java.lang.UnsupportedClassVersionError: class file version 65.0' >&2; exit 1",
            "Start-Sleep -Milliseconds 50; [Console]::Error.WriteLine('java.lang.UnsupportedClassVersionError: class file version 65.0'); exit 1",
        )
            .stderr(Stdio::piped())
            .spawn()
            .expect("child should start");
        let stderr_tail = Arc::new(Mutex::new(StderrTail::default()));
        start_stderr_collector(child.stderr.take().expect("stderr should be piped"), Arc::clone(&stderr_tail));

        std::thread::sleep(Duration::from_millis(200));

        let message = format_agent_startup_error(
            "Failed to read startup line from agent: end of stream",
            &mut child,
            &stderr_tail,
        );

        assert!(message.contains("Failed to read startup line from agent: end of stream"));
        let expected_exit = if cfg!(windows) {
            "agent process exited with exit code: 1"
        } else {
            "agent process exited with exit status: 1"
        };
        assert!(message.contains(expected_exit), "unexpected message: {message}");
        assert!(message.contains("Agent requires Java 21"));
        assert!(message.contains("details: Failed to read startup line from agent: end of stream"));
        assert!(message.contains("UnsupportedClassVersionError"));
    }

    #[test]
    fn runtime_agent_process_error_does_not_wait_for_live_child() {
        let child = test_shell_command("sleep 2", "Start-Sleep -Seconds 2")
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
            cached_query: None,
        };

        let started_at = std::time::Instant::now();
        let message = client.format_agent_process_error("Agent RPC error (-1): syntax error");

        assert!(started_at.elapsed() < std::time::Duration::from_millis(500));
        assert!(message.contains("Agent RPC error (-1): syntax error"));
        assert!(!message.contains("agent process exited"));
    }

    #[test]
    fn rpc_response_errors_do_not_require_process_stderr_diagnostics() {
        assert!(is_agent_rpc_response_error(
            "Agent RPC error (-1): ETCD_CAS_CONFLICT: key changed after it was loaded"
        ));
        assert!(!is_agent_rpc_response_error("Failed to read response from agent: end of stream"));
    }

    async fn spawn_stateful_test_runtime(prefix: &str) -> (Arc<AgentRuntimeClient>, std::path::PathBuf) {
        let script_path = std::env::temp_dir().join(format!("dbx-agent-{prefix}-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(
            &script_path,
            r#"import json, sys, threading
print(json.dumps({'ready': True}), flush=True)
state_lock = threading.Lock()
output_lock = threading.Lock()
session_locks = {}
blocked = {}
query_count = 0
cancel_count = 0

def write_response(req, result=None, error=None):
    response = {'jsonrpc': '2.0', 'id': req['id']}
    if error is None:
        response['result'] = result
    else:
        response['error'] = {'code': -1, 'message': error}
    with output_lock:
        print(json.dumps(response), flush=True)

def session_lock(session_id):
    with state_lock:
        return session_locks.setdefault(session_id, threading.Lock())

def respond(req):
    global query_count, cancel_count
    method = req['method']
    params = req.get('params', {})
    if method == 'handshake':
        write_response(req, {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']})
        return
    if method == 'query_count':
        with state_lock:
            value = query_count
        write_response(req, value)
        return
    if method == 'cancel_count':
        with state_lock:
            value = cancel_count
        write_response(req, value)
        return
    if method == 'cancel_session':
        session_id = params['agentSessionId']
        with state_lock:
            cancel_count += 1
            event = blocked.get(session_id)
        if event is not None:
            event.set()
        write_response(req, {'ok': True})
        return

    session_id = params.get('agentSessionId', '__legacy__')
    with session_lock(session_id):
        if method == 'execute_query':
            sql = params.get('sql', '')
            with state_lock:
                query_count += 1
                current_count = query_count
            if sql.startswith('slow'):
                event = threading.Event()
                with state_lock:
                    blocked[session_id] = event
                event.wait(2)
                with state_lock:
                    blocked.pop(session_id, None)
            if sql == 'error':
                write_response(req, error='synthetic query error')
                return
            write_response(req, {'sql': sql, 'count': current_count})
            return
        write_response(req, {'ok': True})

for line in sys.stdin:
    threading.Thread(target=respond, args=(json.loads(line),), daemon=True).start()
"#,
        )
        .unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new(python).with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        (runtime, script_path)
    }

    async fn runtime_counter(runtime: &Arc<AgentRuntimeClient>, method: &str) -> u64 {
        runtime.call(method, serde_json::json!({}), Some(Duration::from_secs(2)), None).await.unwrap()
    }

    #[tokio::test]
    async fn shared_runtime_timeout_cancels_session_with_and_without_token() {
        let (runtime, script_path) = spawn_stateful_test_runtime("timeout-cancel-test").await;
        let mut client = AgentDriverClient::shared_session(runtime.clone(), "timeout-session".to_string());

        let error = client
            .execute_query_with_timeout::<serde_json::Value>(
                serde_json::json!({"sql": "slow-without-token"}),
                Some(Duration::from_millis(75)),
            )
            .await
            .unwrap_err();
        assert!(error.contains("Agent RPC call timed out"));
        let typed_error = agent_error_from_legacy(&error, None);
        assert_eq!(typed_error.category(), Some(AgentErrorCategory::Timeout));
        assert_eq!(typed_error.operation_outcome(), AgentOperationOutcome::Unknown);
        let started = Instant::now();
        client
            .call_with_timeout::<serde_json::Value>("probe", serde_json::json!({}), Some(Duration::from_millis(500)))
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));

        let error = client
            .execute_query_with_timeout_and_cancel::<serde_json::Value>(
                serde_json::json!({"sql": "slow-with-token"}),
                Some(Duration::from_millis(75)),
                Some(CancellationToken::new()),
            )
            .await
            .unwrap_err();
        assert!(error.contains("Agent RPC call timed out"));
        let typed_error = agent_error_from_legacy(&error, None);
        assert_eq!(typed_error.category(), Some(AgentErrorCategory::Timeout));
        assert_eq!(typed_error.operation_outcome(), AgentOperationOutcome::Unknown);
        let started = Instant::now();
        client
            .call_with_timeout::<serde_json::Value>("probe", serde_json::json!({}), Some(Duration::from_millis(500)))
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(runtime_counter(&runtime, "cancel_count").await, 2);

        runtime.kill();
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn cached_agent_query_handles_hits_errors_ttl_and_invalidation() {
        let (runtime, script_path) = spawn_stateful_test_runtime("query-cache-test").await;
        let mut client = AgentDriverClient::shared_session(runtime.clone(), "cache-session".to_string());
        let timeout = Some(Duration::from_secs(2));
        let cache_ttl = Duration::from_secs(1);

        let first: serde_json::Value = client
            .execute_query_cached_with_timeout(
                "same-key".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "same"}),
                timeout,
            )
            .await
            .unwrap();
        let second: serde_json::Value = client
            .execute_query_cached_with_timeout(
                "same-key".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "same"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(runtime_counter(&runtime, "query_count").await, 1);

        let first_error = client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "error-key".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "slow-cache-error"}),
                Some(Duration::from_millis(75)),
            )
            .await
            .unwrap_err();
        let second_error = client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "error-key".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "slow-cache-error"}),
                Some(Duration::from_millis(75)),
            )
            .await
            .unwrap_err();
        assert_eq!(first_error, second_error);
        assert!(first_error.contains("Agent RPC call timed out"));
        assert_eq!(runtime_counter(&runtime, "query_count").await, 2);

        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "ttl-key".to_string(),
                Duration::from_millis(20),
                serde_json::json!({"sql": "ttl"}),
                timeout,
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "ttl-key".to_string(),
                Duration::from_millis(20),
                serde_json::json!({"sql": "ttl"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(runtime_counter(&runtime, "query_count").await, 4);

        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "query-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-query"}),
                timeout,
            )
            .await
            .unwrap();
        client.execute_query::<serde_json::Value>(serde_json::json!({"sql": "ordinary"})).await.unwrap();
        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "query-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-query"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(runtime_counter(&runtime, "query_count").await, 7);

        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "batch-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-batch"}),
                timeout,
            )
            .await
            .unwrap();
        client
            .execute_batch::<serde_json::Value>(None, &["UPDATE t SET a = 1".to_string()], None, timeout)
            .await
            .unwrap();
        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "batch-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-batch"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(runtime_counter(&runtime, "query_count").await, 9);

        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "transaction-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-transaction"}),
                timeout,
            )
            .await
            .unwrap();
        client.execute_transaction::<serde_json::Value>(None, &["UPDATE t SET a = 2".to_string()], None).await.unwrap();
        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "transaction-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-transaction"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(runtime_counter(&runtime, "query_count").await, 11);

        client
            .execute_query_cached_with_timeout::<serde_json::Value>(
                "disconnect-invalidation".to_string(),
                cache_ttl,
                serde_json::json!({"sql": "cached-before-disconnect"}),
                timeout,
            )
            .await
            .unwrap();
        assert!(client.cached_query.is_some());
        client.disconnect().await.unwrap();
        assert!(client.cached_query.is_none());

        runtime.kill();
        let _ = std::fs::remove_file(script_path);
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
            AgentLaunchSpec::new(test_python()).with_args([script_path.to_string_lossy().to_string()]),
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
    async fn shared_runtime_routes_agents_without_handshake_to_legacy_fallback() {
        let script_path =
            std::env::temp_dir().join(format!("dbx-agent-runtime-no-handshake-test-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(
            &script_path,
            r#"import json, sys
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    print(json.dumps({
        'jsonrpc': '2.0',
        'id': req['id'],
        'error': {'code': -1, 'message': 'Unknown method: ' + req['method']}
    }), flush=True)
"#,
        )
        .unwrap();

        let error = match AgentRuntimeClient::spawn(
            AgentLaunchSpec::new(test_python()).with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        {
            Ok(runtime) => {
                runtime.kill();
                panic!("agent without handshake unexpectedly started as a shared runtime");
            }
            Err(error) => error,
        };

        assert_eq!(error, "Agent runtime does not support multi_session protocol v2");
        let _ = std::fs::remove_file(script_path);
    }

    #[tokio::test]
    async fn disconnect_reports_runtime_replacement_without_owning_runtime_routing() {
        let script_path =
            std::env::temp_dir().join(format!("dbx-agent-runtime-cleanup-saturation-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(
            &script_path,
            r#"import json, sys
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req['method'] == 'handshake':
        response = {
            'jsonrpc': '2.0',
            'id': req['id'],
            'result': {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
        }
    elif req['method'] == 'close_session':
        response = {
            'jsonrpc': '2.0',
            'id': req['id'],
            'error': {
                'code': -1,
                'message': 'Agent runtime resource limit reached',
                'data': {
                    'category': 'resource',
                    'retryable': False,
                    'sessionDisposition': 'replace_runtime',
                    'stage': 'close'
                }
            }
        }
    else:
        response = {'jsonrpc': '2.0', 'id': req['id'], 'result': {}}
    print(json.dumps(response), flush=True)
"#,
        )
        .unwrap();

        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = AgentRuntimeClient::spawn(
            AgentLaunchSpec::new(python).with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        runtime.increment_session_count();
        let mut client = AgentDriverClient::shared_session(runtime.clone(), "session-1".to_string());

        let error = client.disconnect().await.unwrap_err();

        assert_eq!(
            agent_error_from_legacy(&error, None).session_disposition(),
            Some(AgentSessionDisposition::ReplaceRuntime)
        );
        assert!(!runtime.is_failed());
        runtime.kill();
        drop(client);
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
            AgentLaunchSpec::new(test_python()).with_args([script_path.to_string_lossy().to_string()]),
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
            AgentLaunchSpec::new(test_python()).with_args([script_path.to_string_lossy().to_string()]),
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
        assert_eq!(AgentCapability::KvTtl.as_str(), "kv_ttl");
        assert_eq!(AgentCapability::KvCas.as_str(), "kv_cas");
        assert_eq!(AgentCapability::KvListValues.as_str(), "kv_list_values");
        assert_eq!(AgentCapability::KvStatus.as_str(), "kv_status");
        assert_eq!(AgentCapability::KvHistory.as_str(), "kv_history");
        assert_eq!(AgentCapability::EtcdCompaction.as_str(), "etcd_compaction");
        assert_eq!(AgentCapability::EtcdDefrag.as_str(), "etcd_defrag");
        assert_eq!(AgentCapability::EtcdWatch.as_str(), "etcd_watch");
        assert_eq!(AgentCapability::EtcdLease.as_str(), "etcd_lease");
        assert_eq!(AgentCapability::EtcdAuth.as_str(), "etcd_auth");
        assert_eq!(AgentCapability::MongoDropDatabase.as_str(), "mongo_drop_database");
        assert_eq!(AgentCapability::MultiSession.as_str(), "multi_session");
        assert_eq!(AgentCapability::StructuredErrorV1.as_str(), "structured_error_v1");
        assert_eq!(AgentCapability::ALL.len(), 21);
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
        assert_eq!(AgentMethod::ListConstraints.as_str(), "list_constraints");
        assert_eq!(AgentMethod::ListPartitions.as_str(), "list_partitions");
        assert_eq!(AgentMethod::ListSubpartitions.as_str(), "list_subpartitions");
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
        assert_eq!(MongoAgentMethod::FindOne.as_str(), "find_one");
        assert_eq!(MongoAgentMethod::ExplainFind.as_str(), "explain_find");
        assert_eq!(MongoAgentMethod::FindDocumentsExtendedJson.as_str(), "find_documents_extended_json");
        assert_eq!(MongoAgentMethod::CountDocuments.as_str(), "count_documents");
        assert_eq!(MongoAgentMethod::ServerVersion.as_str(), "server_version");
        assert_eq!(MongoAgentMethod::CreateIndex.as_str(), "create_index");
        assert_eq!(MongoAgentMethod::DropIndexes.as_str(), "drop_indexes");
        assert_eq!(MongoAgentMethod::DropCollection.as_str(), "drop_collection");
        assert_eq!(MongoAgentMethod::DropDatabase.as_str(), "drop_database");
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
        assert_eq!(AgentKvMethod::Rename.as_str(), "kv_rename");
        assert_eq!(AgentKvMethod::History.as_str(), "kv_history");
        assert_eq!(AgentKvMethod::Status.as_str(), "kv_status");
        assert_eq!(AgentKvMethod::Compact.as_str(), "etcd_compact");
        assert_eq!(AgentKvMethod::Defrag.as_str(), "etcd_defrag");
        assert_eq!(AgentKvMethod::WatchStart.as_str(), "etcd_watch_start");
        assert_eq!(AgentKvMethod::WatchPoll.as_str(), "etcd_watch_poll");
        assert_eq!(AgentKvMethod::WatchStop.as_str(), "etcd_watch_stop");
        assert_eq!(AgentKvMethod::LeaseList.as_str(), "etcd_lease_list");
        assert_eq!(AgentKvMethod::LeaseGet.as_str(), "etcd_lease_get");
        assert_eq!(AgentKvMethod::LeaseGrant.as_str(), "etcd_lease_grant");
        assert_eq!(AgentKvMethod::LeaseKeepalive.as_str(), "etcd_lease_keepalive_once");
        assert_eq!(AgentKvMethod::LeaseRevoke.as_str(), "etcd_lease_revoke");
        assert_eq!(AgentKvMethod::AuthUserList.as_str(), "etcd_auth_user_list");
        assert_eq!(AgentKvMethod::AuthRoleGrantPermission.as_str(), "etcd_auth_role_grant_permission");
        assert_eq!(AgentKvMethod::ALL.len(), 30);
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
        let _list_constraints = AgentDriverClient::list_constraints::<serde_json::Value>;
        let _list_partitions = AgentDriverClient::list_partitions::<serde_json::Value>;
        let _list_subpartitions = AgentDriverClient::list_subpartitions::<serde_json::Value>;
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
        let _mongo_list_collection_specs = AgentDriverClient::mongo_list_collection_specs::<serde_json::Value>;
        let _mongo_find_documents = AgentDriverClient::mongo_find_documents::<serde_json::Value>;
        let _mongo_find_one = AgentDriverClient::mongo_find_one::<serde_json::Value>;
        let _mongo_find_documents_extended_json =
            AgentDriverClient::mongo_find_documents_extended_json::<serde_json::Value>;
        let _mongo_server_version = AgentDriverClient::mongo_server_version::<serde_json::Value>;
        let _mongo_create_index = AgentDriverClient::mongo_create_index::<serde_json::Value>;
        let _mongo_drop_indexes = AgentDriverClient::mongo_drop_indexes::<serde_json::Value>;
        let _mongo_drop_collection = AgentDriverClient::mongo_drop_collection::<serde_json::Value>;
        let _mongo_drop_database = AgentDriverClient::mongo_drop_database::<serde_json::Value>;
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
            timeout_secs: None,
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
    fn serializes_table_read_timeout_secs() {
        let with_timeout = serde_json::to_value(AgentTableReadStartParams {
            sql: "SELECT 1".to_string(),
            database: None,
            schema: None,
            page_size: 100,
            max_rows: 1000,
            fetch_size: None,
            timeout_secs: Some(30),
        })
        .unwrap();
        assert_eq!(
            with_timeout,
            serde_json::json!({
                "sql": "SELECT 1",
                "pageSize": 100,
                "maxRows": 1000,
                "timeoutSecs": 30,
            })
        );

        let without_timeout = serde_json::to_value(AgentTableReadStartParams {
            sql: "SELECT 1".to_string(),
            database: None,
            schema: None,
            page_size: 100,
            max_rows: 1000,
            fetch_size: None,
            timeout_secs: None,
        })
        .unwrap();
        assert!(
            !without_timeout.as_object().unwrap().contains_key("timeoutSecs"),
            "timeoutSecs key should be absent when None"
        );
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
        assert_eq!(string_array(&contract["capabilities"]), multi_session_capabilities());
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
        assert!(!agent_supports_capability(None, AgentCapability::KvTtl));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::KvTtl));
        assert!(!agent_supports_capability(None, AgentCapability::KvCas));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::KvCas));
        assert!(!agent_supports_capability(None, AgentCapability::KvListValues));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::KvListValues));
        assert!(!agent_supports_capability(None, AgentCapability::KvStatus));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::KvStatus));
        assert!(!agent_supports_capability(None, AgentCapability::KvHistory));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::KvHistory));
        assert!(!agent_supports_capability(None, AgentCapability::MongoDropDatabase));
        assert!(!agent_supports_capability(Some(&handshake), AgentCapability::MongoDropDatabase));

        let mongo_handshake =
            AgentHandshake { capabilities: vec![AgentCapability::MongoDropDatabase.as_str().to_string()], ..handshake };
        assert!(agent_supports_capability(Some(&mongo_handshake), AgentCapability::MongoDropDatabase));
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
            AgentCapability::StructuredErrorV1,
        ]
        .iter()
        .map(|capability| capability.as_str())
        .collect()
    }

    fn multi_session_capabilities() -> Vec<&'static str> {
        default_sql_capabilities()
            .into_iter()
            .filter(|capability| *capability != AgentCapability::StructuredErrorV1.as_str())
            .collect()
    }
}
