//! Shared desktop/Web orchestration, adapted from Ziyu Yang's PL/SQL debugger.
//! Native state stays in the Agent; Core retains intent and the original channel.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::agent_connection::{agent_connect_params_with_role, AgentSessionRole};
use crate::backend_error::BackendError;
use crate::connection::session_credentials::{current_credential_owner, with_credential_owner};
use crate::connection::{
    agent_connect_timeout, AppState, ConnectionLifecycleSnapshot, ConnectionTransportPlan, ConnectionTransportStamp,
};
use crate::db::agent_driver::{AgentCallError, AgentOperationOutcome};
use dbx_drivers::agent_runtime::{prepare_pl_debug_channel, PlDebugAgentChannel};

pub const PL_DEBUG_CONTINUE_TIMEOUT: Duration = Duration::from_secs(120);
pub const PL_DEBUG_RUN_TO_END_TIMEOUT: Duration = Duration::from_secs(300);
pub const PL_DEBUG_CLEANUP_TIMEOUT: Duration = Duration::from_secs(60);
pub const PL_DEBUG_LEASE: Duration = Duration::from_secs(120);
const QUICK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 128;
const MAX_START_IDENTITIES: usize = 4096;
const MAX_OPERATIONS: usize = 4096;
const RESULT_TTL: Duration = Duration::from_secs(30 * 60);
const INACCESSIBLE: &str = "PL debug session is not accessible in this client context";

#[derive(Debug)]
pub enum PlDebugSubmissionError {
    RejectedBeforeRegistration(String),
    Unresolved(String),
}

impl PlDebugSubmissionError {
    pub fn into_legacy_message(self) -> String {
        match self {
            Self::RejectedBeforeRegistration(message) | Self::Unresolved(message) => message,
        }
    }

    pub fn into_backend_error(self) -> BackendError {
        match self {
            Self::RejectedBeforeRegistration(message) => BackendError::from_pl_debug_admission_rejection(&message),
            Self::Unresolved(message) => BackendError::from_legacy_string(&message),
        }
    }

    pub fn into_boundary_string(self) -> String {
        match self {
            Self::RejectedBeforeRegistration(_) => serde_json::to_string(&self.into_backend_error()).unwrap(),
            Self::Unresolved(message) => message,
        }
    }
}

impl From<String> for PlDebugSubmissionError {
    fn from(message: String) -> Self {
        Self::Unresolved(message)
    }
}

impl From<&str> for PlDebugSubmissionError {
    fn from(message: &str) -> Self {
        Self::Unresolved(message.into())
    }
}

// Access identity is created at a trusted Rust request boundary, never from JSON.
#[derive(Clone, PartialEq, Eq, Hash)]
enum AccessOwner {
    Desktop,
    Web(String),
}

#[derive(Clone)]
pub struct PlDebugAccess {
    owner: AccessOwner,
    credential_owner: Option<String>,
}

pub enum PlDebugMutationScope {
    Connections(Vec<String>),
    WriteProtection { connection_id: String, credential_owner: Option<String> },
    TunnelProfiles(Vec<String>),
    Driver(String),
    AllRuntimes,
}

pub struct PlDebugMutationPermit<'a> {
    app: &'a AppState,
    token: Uuid,
    entries: Vec<(Arc<Entry>, u64)>,
    inspections: Vec<Arc<InspectionOwner>>,
}

struct MutationIntent {
    scope: PlDebugMutationScope,
    connections: Vec<String>,
}

pub(crate) struct PlDebugPreparation {
    entry: Arc<Entry>,
    generation: u64,
}

impl PlDebugAccess {
    pub fn desktop() -> Self {
        Self { owner: AccessOwner::Desktop, credential_owner: current_credential_owner() }
    }

    /// The existing server-side cookie validation supplies `session`.
    /// Password-disabled Web retains its original None credential scope.
    pub fn web(session: String) -> Result<Self, String> {
        if session.is_empty() {
            return Err(INACCESSIBLE.into());
        }
        Ok(Self { owner: AccessOwner::Web(session), credential_owner: current_credential_owner() })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugStart {
    pub server_epoch: Uuid,
    pub operation_id: String,
    pub connection_id: String,
    pub database: String,
    pub client_session_id: String,
    pub target: Value,
    pub risk_accepted: bool,
    pub production_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_connection_revision: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlDebugInspectTarget {
    #[serde(default)]
    pub schema: String,
    pub object_type: String,
    pub object_name: String,
    #[serde(default)]
    pub package_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_preparation: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlDebugInspect {
    pub connection_id: String,
    pub database: String,
    pub client_session_id: String,
    pub target: Option<PlDebugInspectTarget>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugSessionRef {
    pub server_epoch: Uuid,
    pub session_id: String,
    pub connection_id: String,
    pub client_session_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlDebugAction {
    Resume,
    StepOver,
    StepIn,
    StepOut,
    RunToEnd,
    Abort,
    Close,
    Restart,
    SetBreakpoints,
    DeleteBreakpoints,
    SetBreakpointEnabled,
    SetExceptionBreakpoint,
    SetValue,
    Execute,
}

impl PlDebugAction {
    fn method(self) -> &'static str {
        match self {
            Self::Resume => "pl_debug_resume",
            Self::StepOver => "pl_debug_step_over",
            Self::StepIn => "pl_debug_step_in",
            Self::StepOut => "pl_debug_step_out",
            Self::RunToEnd => "pl_debug_resume_ignore_breakpoints",
            Self::Abort => "pl_debug_abort",
            Self::Close => "pl_debug_close",
            Self::Restart => "pl_debug_start",
            Self::SetBreakpoints => "pl_debug_set_breakpoints",
            Self::DeleteBreakpoints => "pl_debug_delete_breakpoints",
            Self::SetBreakpointEnabled => "pl_debug_set_breakpoint_enabled",
            Self::SetExceptionBreakpoint => "pl_debug_set_exception_breakpoint",
            Self::SetValue => "pl_debug_set_value",
            Self::Execute => "pl_debug_execute",
        }
    }
    fn may_write(self) -> bool {
        matches!(
            self,
            Self::Resume
                | Self::StepOver
                | Self::StepIn
                | Self::StepOut
                | Self::RunToEnd
                | Self::Restart
                | Self::SetValue
                | Self::Execute
        )
    }
    fn is_breakpoint(self) -> bool {
        matches!(self, Self::SetBreakpoints | Self::DeleteBreakpoints | Self::SetBreakpointEnabled)
    }
    fn timeout(self) -> Duration {
        match self {
            Self::RunToEnd => PL_DEBUG_RUN_TO_END_TIMEOUT,
            Self::Resume | Self::StepOver | Self::StepIn | Self::StepOut | Self::Abort => PL_DEBUG_CONTINUE_TIMEOUT,
            _ => QUICK_TIMEOUT,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugOperation {
    #[serde(flatten)]
    pub session: PlDebugSessionRef,
    pub operation_id: String,
    pub expected_revision: u64,
    pub generation: u64,
    pub action: PlDebugAction,
    #[serde(default = "empty_params")]
    pub params: Value,
    #[serde(default)]
    pub production_confirmed: bool,
}
fn empty_params() -> Value {
    json!({})
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlDebugReadKind {
    Variables,
    Value,
    Stack,
    Log,
    LogPage,
    Results,
    ResultPage,
    Breakpoints,
}
impl PlDebugReadKind {
    fn method(self) -> &'static str {
        match self {
            Self::Variables => "pl_debug_get_variables",
            Self::Value => "pl_debug_get_value",
            Self::Stack => "pl_debug_get_stack",
            Self::Log => "pl_debug_get_log",
            Self::LogPage => "pl_debug_get_log_page",
            Self::Results => "pl_debug_get_results",
            Self::ResultPage => "pl_debug_get_result_page",
            Self::Breakpoints => "pl_debug_list_breakpoints",
        }
    }
    fn needs_stop(self) -> bool {
        matches!(self, Self::Variables | Self::Value | Self::Stack)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugRead {
    #[serde(flatten)]
    pub session: PlDebugSessionRef,
    pub generation: u64,
    pub stop_revision: Option<u64>,
    pub kind: PlDebugReadKind,
    #[serde(default = "empty_params")]
    pub params: Value,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Accepted,
    Running,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugReceipt {
    pub server_epoch: Uuid,
    pub session_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub revision: u64,
    pub state: OperationState,
    pub dispatched: bool,
    pub result: Option<Value>,
    pub error: Option<Value>,
}
struct Operation {
    request: Value,
    receipt: PlDebugReceipt,
    control_serial: u64,
    action: Option<PlDebugAction>,
    breakpoint_receipts: bool,
    execute_receipts: bool,
    effective_stop_revision: Option<u64>,
}
struct CloseIntent {
    deadline: Instant,
    done: bool,
    reason: &'static str,
}

struct EntryState {
    access_revoked: bool,
    generation: u64,
    revision: u64,
    control_serial: u64,
    agent_id: String,
    scope: Uuid,
    target: Value,
    production_confirmed: bool,
    lifecycle: ConnectionLifecycleSnapshot,
    driver_key: Option<String>,
    source_profile_ids: Option<Vec<String>>,
    transport_plan: Option<ConnectionTransportPlan>,
    transport_stamp: Option<ConnectionTransportStamp>,
    channel: Option<PlDebugAgentChannel>,
    start_finished: bool,
    start_dispatched: bool,
    active_operation: Option<String>,
    interrupt_operation: Option<String>,
    close_operation: Option<String>,
    operations: HashMap<String, Operation>,
    snapshot: Value,
    retained_log: Option<Value>,
    retained_results: results::RetainedResults,
    last_heartbeat: Instant,
    close: Option<CloseIntent>,
    runtime_exited: bool,
    retired_at: Option<Instant>,
}
impl EntryState {
    fn protects_execution(&self) -> bool {
        !self.runtime_exited
            || self.snapshot["releaseState"] != "released"
            || self.snapshot["executionOutcome"] == "unknown"
    }
}
struct Entry {
    id: String,
    owner: AccessOwner,
    credential_owner: Option<String>,
    start: PlDebugStart,
    app: Weak<AppState>,
    state: Mutex<EntryState>,
    changed: Notify,
}
impl Entry {
    fn lock(&self) -> MutexGuard<'_, EntryState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    fn view(&self, epoch: Uuid) -> Value {
        let data = self.lock();
        let mut view = data.snapshot.clone();
        let object = view.as_object_mut().expect("Core snapshots are objects");
        object.insert("debugId".into(), json!(self.id));
        object.insert("sessionId".into(), json!(self.id));
        object.insert("serverEpoch".into(), json!(epoch));
        object.insert("connectionId".into(), json!(self.start.connection_id));
        object.insert("database".into(), json!(self.start.database));
        object.insert("clientSessionId".into(), json!(self.start.client_session_id));
        object.insert("startOperationId".into(), json!(self.start.operation_id));
        object.insert("generation".into(), json!(data.generation));
        object.insert("revision".into(), json!(data.revision));
        object.insert("activeOperationId".into(), json!(data.active_operation));
        let mut unresolved: Vec<_> = data
            .operations
            .iter()
            .filter(|(_, operation)| {
                operation.action.is_some()
                    && matches!(
                        operation.receipt.state,
                        OperationState::Accepted | OperationState::Running | OperationState::Unknown
                    )
            })
            .collect();
        unresolved.sort_by_key(|(_, operation)| operation.control_serial);
        object.insert(
            "recovery".into(),
            json!({
                "version": 1,
                "closeOperationId": data.close_operation,
                "operations": unresolved.into_iter().map(|(id, operation)| json!({
                    "operationId": id,
                    "action": operation.action,
                    "requestGeneration": operation.request["generation"],
                    "receiptGeneration": operation.receipt.generation,
                    "state": operation.receipt.state,
                })).collect::<Vec<_>>(),
            }),
        );
        object.insert("runtimeExited".into(), json!(data.runtime_exited));
        object.insert("closing".into(), json!(data.close.as_ref().is_some_and(|close| !close.done)));
        object.insert("target".into(), data.target.clone());
        view
    }
}
struct RegistryState {
    sessions: HashMap<String, Arc<Entry>>,
    inspections: HashMap<Uuid, Arc<InspectionOwner>>,
    compilations: HashMap<(AccessOwner, String), Arc<compilation::Compilation>>,
    // Expired identities remain tombstones for this process epoch.
    starts: HashMap<(AccessOwner, String), Option<String>>,
    accepting: bool,
    connection_fences: HashMap<String, Uuid>,
    retained_fences: std::collections::HashSet<Uuid>,
    connection_gates: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    connection_drains: HashMap<String, ConnectionDrainState>,
    mutation_permits: HashMap<Uuid, MutationIntent>,
    transports: HashMap<String, transport::TransportRecord>,
}
struct ConnectionDrain {
    token: Uuid,
    entries: Vec<Arc<Entry>>,
    inspections: Vec<Arc<InspectionOwner>>,
    deadline: Instant,
    reason: &'static str,
}
struct ConnectionDrainState {
    intent: Arc<ConnectionDrain>,
    users: usize,
}
struct ConnectionDrainUse<'a> {
    registry: &'a PlDebugRegistry,
    connection_id: String,
    intent: Arc<ConnectionDrain>,
    completed: bool,
}
impl Drop for ConnectionDrainUse<'_> {
    fn drop(&mut self) {
        let mut registry = self.registry.lock();
        let release = registry.connection_drains.get_mut(&self.connection_id).is_some_and(|current| {
            if !Arc::ptr_eq(&current.intent, &self.intent) {
                return false;
            }
            current.users -= 1;
            self.completed && current.users == 0
        });
        if release {
            registry.connection_drains.remove(&self.connection_id);
            if registry.connection_fences.get(&self.connection_id) == Some(&self.intent.token) {
                registry.connection_fences.remove(&self.connection_id);
                registry.retained_fences.remove(&self.intent.token);
            }
        }
        drop(registry);
        self.registry.changed.notify_waiters();
    }
}
pub struct PlDebugRegistry {
    epoch: Uuid,
    state: Mutex<RegistryState>,
    changed: Notify,
}
pub(crate) struct PlDebugConnectionFence<'a> {
    registry: &'a PlDebugRegistry,
    connection_id: String,
    token: Uuid,
    release: bool,
    _mutation: Option<tokio::sync::OwnedMutexGuard<()>>,
    drain: Option<ConnectionDrainUse<'a>>,
}
impl PlDebugConnectionFence<'_> {
    pub(crate) fn complete(mut self) {
        if let Some(drain) = &mut self.drain {
            drain.completed = true;
        }
        self.release = true;
    }
}
impl Drop for PlDebugConnectionFence<'_> {
    fn drop(&mut self) {
        if self.drain.is_some() || !self.release {
            return;
        }
        let mut registry = self.registry.lock();
        if registry.connection_fences.get(&self.connection_id) == Some(&self.token) {
            registry.connection_fences.remove(&self.connection_id);
            registry.retained_fences.remove(&self.token);
        }
        drop(registry);
        self.registry.changed.notify_waiters();
    }
}
impl Default for PlDebugRegistry {
    fn default() -> Self {
        Self {
            epoch: Uuid::new_v4(),
            state: Mutex::new(RegistryState {
                sessions: HashMap::new(),
                inspections: HashMap::new(),
                compilations: HashMap::new(),
                starts: HashMap::new(),
                accepting: true,
                connection_fences: HashMap::new(),
                retained_fences: std::collections::HashSet::new(),
                connection_gates: HashMap::new(),
                connection_drains: HashMap::new(),
                mutation_permits: HashMap::new(),
                transports: HashMap::new(),
            }),
            changed: Notify::new(),
        }
    }
}
impl PlDebugRegistry {
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    fn check_epoch(&self, epoch: Uuid) -> Result<(), String> {
        if epoch != self.epoch {
            return Err("unknown_after_restart: inspect the original execution before starting again".into());
        }
        Ok(())
    }
    pub(crate) fn try_idle_fence(&self, connection_id: &str) -> Option<PlDebugConnectionFence<'_>> {
        let mut registry = self.lock();
        if !registry.accepting
            || registry.connection_fences.contains_key(connection_id)
            || registry.connection_drains.contains_key(connection_id)
            || registry.mutation_permits.values().any(|scope| scope.blocks_start(connection_id))
            || registry.compilations.values().any(|entry| entry.protects_connection(connection_id))
            || registry
                .inspections
                .values()
                .any(|owner| owner.request.connection_id == connection_id && !owner.resources_quiescent())
            || registry.sessions.values().any(|entry| {
                if entry.start.connection_id != connection_id {
                    return false;
                }
                let data = entry.lock();
                !data.runtime_exited
                    || data.snapshot["releaseState"] != "released"
                    || data.snapshot["executionOutcome"] == "unknown"
            })
        {
            return None;
        }
        let token = Uuid::new_v4();
        registry.connection_fences.insert(connection_id.to_owned(), token);
        Some(PlDebugConnectionFence {
            registry: self,
            connection_id: connection_id.to_owned(),
            token,
            release: true,
            _mutation: None,
            drain: None,
        })
    }
    fn find(&self, access: &PlDebugAccess, reference: &PlDebugSessionRef) -> Result<Arc<Entry>, String> {
        self.check_epoch(reference.server_epoch)?;
        self.lock()
            .sessions
            .get(&reference.session_id)
            .filter(|entry| {
                entry.owner == access.owner
                    && entry.start.connection_id == reference.connection_id
                    && entry.start.client_session_id == reference.client_session_id
                    && !entry.lock().access_revoked
            })
            .cloned()
            .ok_or_else(|| INACCESSIBLE.into())
    }
    fn register(
        &self,
        app: &Arc<AppState>,
        access: &PlDebugAccess,
        start: PlDebugStart,
    ) -> Result<(Arc<Entry>, bool), PlDebugSubmissionError> {
        self.check_epoch(start.server_epoch)?;
        validate_identity(&start.operation_id)?;
        validate_identity(&start.client_session_id)?;
        let key = (access.owner.clone(), start.operation_id.clone());
        let mut registry = self.lock();
        if let Some(previous) = registry.starts.get(&key) {
            let entry = previous
                .as_ref()
                .and_then(|id| registry.sessions.get(id))
                .ok_or("PL debug result expired; this start identity cannot execute again")?;
            if entry.lock().access_revoked {
                return Err(INACCESSIBLE.into());
            }
            if serde_json::to_value(&entry.start).unwrap() != serde_json::to_value(&start).unwrap() {
                return Err("The start operation identity already belongs to a different request".into());
            }
            return Ok((entry.clone(), false));
        }
        let rejected = |message: &str| PlDebugSubmissionError::RejectedBeforeRegistration(message.into());
        if !start.target.is_object() {
            return Err(rejected("Debug target must be an object"));
        }
        let expired = registry
            .sessions
            .values()
            .filter(|entry| {
                let data = entry.lock();
                data.retired_at.is_some_and(|time| time.elapsed() >= RESULT_TTL)
                    && data.snapshot["releaseState"] == "released"
                    && data.snapshot["executionOutcome"] != "unknown"
            })
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(entry) = registry.sessions.remove(&id) {
                registry.starts.insert((entry.owner.clone(), entry.start.operation_id.clone()), None);
            }
        }
        if !registry.accepting {
            return Err(rejected("The application is shutting down"));
        }
        if registry.connection_fences.contains_key(&start.connection_id)
            || registry.connection_drains.contains_key(&start.connection_id)
            || registry.mutation_permits.values().any(|scope| scope.blocks_start(&start.connection_id))
            || registry.inspections.values().any(|owner| owner.blocks_debug_start(&start.connection_id))
            || registry.compilations.values().any(|entry| entry.protects_connection(&start.connection_id))
        {
            return Err(rejected("The connection is being cleaned up; wait before starting a new debug session"));
        }
        if registry.sessions.values().any(|entry| {
            if entry.owner != access.owner
                || entry.start.connection_id != start.connection_id
                || entry.start.client_session_id != start.client_session_id
            {
                return false;
            }
            let data = entry.lock();
            !data.runtime_exited
                || data.snapshot["releaseState"] != "released"
                || data.snapshot["executionOutcome"] == "unknown"
        }) {
            return Err(rejected(
                "This client already has an unresolved debug session; restore or close it before starting again",
            ));
        }
        if registry.sessions.len() >= MAX_SESSIONS || registry.starts.len() >= MAX_START_IDENTITIES {
            return Err(rejected(
                "PL debug session/receipt capacity reached; retained unknown executions cannot be evicted",
            ));
        }
        let lifecycle = app.connection_lifecycle_snapshot(&start.connection_id);
        if start
            .expected_connection_revision
            .as_ref()
            .is_some_and(|revision| revision != &connection_revision(self.epoch, &lifecycle))
        {
            return Err(rejected("The connection changed after the debug preview; inspect the target again"));
        }
        let id = Uuid::new_v4().to_string();
        let receipt = PlDebugReceipt {
            server_epoch: self.epoch,
            session_id: id.clone(),
            operation_id: start.operation_id.clone(),
            generation: 1,
            revision: 1,
            state: OperationState::Accepted,
            dispatched: false,
            result: None,
            error: None,
        };
        let operation = Operation {
            request: serde_json::to_value(&start).unwrap(),
            receipt,
            control_serial: 1,
            action: None,
            breakpoint_receipts: false,
            execute_receipts: false,
            effective_stop_revision: None,
        };
        let entry = Arc::new(Entry {
            id: id.clone(),
            owner: access.owner.clone(),
            credential_owner: access.credential_owner.clone(),
            app: Arc::downgrade(app),
            state: Mutex::new(EntryState {
                access_revoked: false,
                generation: 1,
                revision: 1,
                control_serial: 1,
                agent_id: Uuid::new_v4().simple().to_string(),
                scope: Uuid::new_v4(),
                target: start.target.clone(),
                production_confirmed: start.production_confirmed,
                lifecycle,
                driver_key: None,
                source_profile_ids: None,
                transport_plan: None,
                transport_stamp: None,
                channel: None,
                start_finished: false,
                start_dispatched: false,
                active_operation: Some(start.operation_id.clone()),
                interrupt_operation: None,
                close_operation: None,
                operations: HashMap::from([(start.operation_id.clone(), operation)]),
                snapshot: initial_snapshot(),
                retained_log: None,
                retained_results: results::RetainedResults::default(),
                last_heartbeat: Instant::now(),
                close: None,
                runtime_exited: false,
                retired_at: None,
            }),
            start,
            changed: Notify::new(),
        });
        registry.starts.insert(key, Some(id.clone()));
        registry.sessions.insert(id, entry.clone());
        Ok((entry, true))
    }
}
fn initial_snapshot() -> Value {
    json!({"state":"starting","executionOutcome":"pending","releaseState":"open",
        "transactionOutcome":"pending","targetDispatched":false,"executionStopped":false})
}
fn validate_identity(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err("A stable client/operation identity of 1–128 ASCII letters, digits, '_' or '-' is required".into());
    }
    Ok(())
}
pub fn pl_debug_bootstrap_core(state: &AppState) -> Value {
    json!({"serverEpoch":state.pl_debug.epoch,"heartbeatSeconds":15,"leaseSeconds":PL_DEBUG_LEASE.as_secs(),
        "cleanupSeconds":PL_DEBUG_CLEANUP_TIMEOUT.as_secs()})
}

fn connection_revision(epoch: Uuid, lifecycle: &ConnectionLifecycleSnapshot) -> String {
    format!("{epoch}:{}", lifecycle.generation())
}

pub async fn pl_debug_inspect_core(
    state: &AppState,
    access: &PlDebugAccess,
    request: PlDebugInspect,
) -> Result<Value, String> {
    validate_identity(&request.client_session_id)?;
    let db_type = state
        .configs
        .read()
        .await
        .get(&request.connection_id)
        .map(|config| config.db_type)
        .ok_or("Connection not found")?;
    if !matches!(
        db_type,
        crate::models::connection::DatabaseType::Oracle | crate::models::connection::DatabaseType::OceanbaseOracle
    ) {
        return Err("PL/SQL debugging requires an Oracle or OceanBase Oracle connection".into());
    }
    let preparation = request.target.as_ref().and_then(|target| target.metadata_preparation.as_deref());
    if preparation == Some("debug_compile") {
        return Err("Debug compilation inspection requires its registered dedicated channel".into());
    }
    if preparation.is_some_and(|policy| policy != "type_only") {
        return Err("Unsupported type metadata preparation policy".into());
    }
    let prepare_types = preparation.is_some();
    if prepare_types && db_type != crate::models::connection::DatabaseType::OceanbaseOracle {
        return Err("Oracle typed metadata inspection requires its registered dedicated channel".into());
    }
    with_credential_owner(access.credential_owner.clone(), async {
        let lifecycle = state.connection_lifecycle_snapshot(&request.connection_id);
        let inspect_once = || async {
            if !state.connection_lifecycle_is_current(&request.connection_id, &lifecycle) {
                return Err("The debug inspection expired; inspect the target again".into());
            }
            let pool_key = state
                .get_or_create_metadata_pool_for_session(
                    &request.connection_id,
                    Some(&request.database),
                    Some(&request.client_session_id),
                )
                .await?;
            let Some(crate::connection::PoolKind::Agent(client)) = state.pool_handle(&pool_key).await else {
                return Err("PL/SQL debug inspection requires the connection's metadata Agent".into());
            };
            let result = client
                .lock()
                .await
                .call_method_with_timeout::<Value>(
                    crate::db::agent_driver::AgentMethod::PlDebugInspect,
                    json!({"target": request.target}),
                    Some(if prepare_types { QUICK_TIMEOUT + QUICK_TIMEOUT } else { QUICK_TIMEOUT }),
                )
                .await?;
            let same_pool = matches!(state.pool_handle(&pool_key).await,
                    Some(crate::connection::PoolKind::Agent(current)) if Arc::ptr_eq(&client, &current));
            if !same_pool || !state.connection_lifecycle_is_current(&request.connection_id, &lifecycle) {
                return Err("The debug inspection expired; inspect the target again".into());
            }
            let mut result = result;
            let object = result.as_object_mut().ok_or("Invalid debug inspection response")?;
            object.insert("connectionRevision".into(), json!(connection_revision(state.pl_debug.epoch, &lifecycle)));
            Ok(result)
        };
        Box::pin(crate::schema::run_metadata_connection_for_session(
            state,
            &request.connection_id,
            Some(&request.database),
            Some(&request.client_session_id),
            !prepare_types,
            inspect_once,
        ))
        .await
    })
    .await
}
pub fn pl_debug_revoke_web_owner_core(state: &AppState, token: &str) {
    let owner = AccessOwner::Web(token.to_owned());
    compilation::revoke(&state.pl_debug.lock(), &owner);
    let entries =
        state.pl_debug.lock().sessions.values().filter(|entry| entry.owner == owner).cloned().collect::<Vec<_>>();
    let deadline = Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT;
    for entry in entries {
        entry.lock().access_revoked = true;
        request_close(&entry, "owner_revoked", deadline);
    }
    let inspections = state
        .pl_debug
        .lock()
        .inspections
        .values()
        .filter(|inspection| inspection.belongs_to(&owner))
        .cloned()
        .collect::<Vec<_>>();
    for inspection in inspections {
        inspection.invalidate();
    }
}
pub fn pl_debug_list_core(
    state: &AppState,
    access: &PlDebugAccess,
    epoch: Uuid,
    connection_id: &str,
) -> Result<Vec<Value>, String> {
    state.pl_debug.check_epoch(epoch)?;
    let entries = state
        .pl_debug
        .lock()
        .sessions
        .values()
        .filter(|entry| {
            entry.owner == access.owner && entry.start.connection_id == connection_id && !entry.lock().access_revoked
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(entries.iter().map(|entry| entry.view(epoch)).collect())
}
pub async fn pl_debug_heartbeat_core(
    state: &AppState,
    access: &PlDebugAccess,
    reference: &PlDebugSessionRef,
) -> Result<Value, String> {
    let entry = state.pl_debug.find(access, reference)?;
    let pending = {
        let mut data = entry.lock();
        if data.close.is_none() && !data.runtime_exited {
            data.last_heartbeat = Instant::now();
            if data.start_dispatched {
                data.channel.clone().map(|channel| (channel, data.agent_id.clone(), data.generation, data.revision))
            } else {
                None
            }
        } else {
            None
        }
    };
    entry.changed.notify_waiters();
    if let Some((channel, agent_id, generation, revision)) = pending {
        let value = channel
            .call::<Value>("pl_debug_heartbeat", json!({"debugId":agent_id}), QUICK_TIMEOUT, None)
            .await
            .map_err(|error| error.into_legacy_string())?;
        let mut data = entry.lock();
        if data.generation == generation && data.revision == revision && data.close.is_none() {
            apply_agent_snapshot(&mut data, &value);
            data.revision += 1;
        }
    }
    Ok(entry.view(state.pl_debug.epoch))
}
pub fn pl_debug_operation_core(
    state: &AppState,
    access: &PlDebugAccess,
    reference: &PlDebugSessionRef,
    operation_id: &str,
) -> Result<PlDebugReceipt, String> {
    let entry = state.pl_debug.find(access, reference)?;
    let receipt = entry
        .lock()
        .operations
        .get(operation_id)
        .map(|operation| operation.receipt.clone())
        .ok_or("PL debug operation is not available in this session")?;
    Ok(receipt)
}
pub fn pl_debug_start_core(
    state: &Arc<AppState>,
    access: &PlDebugAccess,
    start: PlDebugStart,
) -> Result<PlDebugReceipt, String> {
    pl_debug_start_submission_core(state, access, start).map_err(PlDebugSubmissionError::into_legacy_message)
}

pub fn pl_debug_start_submission_core(
    state: &Arc<AppState>,
    access: &PlDebugAccess,
    start: PlDebugStart,
) -> Result<PlDebugReceipt, PlDebugSubmissionError> {
    let id = start.operation_id.clone();
    let (entry, fresh) = state.pl_debug.register(state, access, start)?;
    if fresh {
        spawn_start(state, entry.clone(), id.clone(), 1);
        spawn_watchdog(state, entry.clone());
    }
    let receipt = entry.lock().operations[&id].receipt.clone();
    Ok(receipt)
}
async fn check_write_protection(state: &AppState, entry: &Entry, production_confirmed: bool) -> Result<(), String> {
    if let Some(name) = super::connection_readonly_name(state, &entry.start.connection_id).await {
        return Err(format!("Connection '{name}' is read-only; unlock writes before running or changing the debuggee"));
    }
    let configs = state.configs.read().await;
    let config = configs.get(&entry.start.connection_id).ok_or("The original connection no longer exists")?;
    if crate::production_safety::is_production_database(config, &entry.start.database) && !production_confirmed {
        return Err("Production execution requires confirmation bound to this debug request".into());
    }
    Ok(())
}
fn local_failure(code: &str, message: impl Into<String>, dispatched: bool) -> Value {
    json!({"code":code,"message":message.into(),"operationOutcome":if dispatched {"unknown"} else {"not_started"}})
}
fn call_failure(error: AgentCallError) -> Value {
    let outcome =
        if error.operation_outcome() == AgentOperationOutcome::NotStarted { "not_started" } else { "unknown" };
    json!({"code":"agent_call_failed","operationOutcome":outcome,"detail":crate::backend_error::BackendError::from_agent_call_error(&error)})
}
fn apply_agent_snapshot(data: &mut EntryState, value: &Value) {
    let snapshot = value.get("snapshot").unwrap_or(value);
    if snapshot.is_object() && snapshot.get("state").is_some() {
        data.snapshot = snapshot.clone();
    }
}
fn assignment_result_state(value: &Value) -> Option<OperationState> {
    match (value["ok"].as_bool(), value["result"].as_i64()) {
        (Some(true), Some(0)) => Some(OperationState::Succeeded),
        (Some(false), Some(code)) if code != 0 => Some(OperationState::Failed),
        _ => None,
    }
}
fn execute_result_state(value: &Value, id: &str, stop: Option<u64>, native: bool) -> Option<OperationState> {
    let ok = value["ok"].as_bool()?;
    let rows = value["rows"].as_array()?;
    if !rows.iter().all(|row| row.is_null() || row.is_string()) || value["count"].as_u64()? != rows.len() as u64 {
        return None;
    }
    if native {
        if stop.is_none()
            || value["operationId"] != id
            || value["action"] != "execute"
            || value["stopRevision"].as_u64() != stop
        {
            return None;
        }
        let complete = value["complete"].as_bool()?;
        let truncated = value["truncated"].as_bool()?;
        if (complete && truncated)
            || (!complete && !truncated && !value["resultError"].as_str().is_some_and(|message| !message.is_empty()))
        {
            return None;
        }
    }
    if ok {
        if value["error"].as_str().is_some_and(|message| !message.is_empty()) {
            return None;
        }
        Some(OperationState::Succeeded)
    } else if value["error"].as_str().or_else(|| value["message"].as_str()).is_some_and(|message| !message.is_empty()) {
        Some(OperationState::Failed)
    } else {
        None
    }
}
fn finish_operation(entry: &Entry, id: &str, generation: u64, result: Result<Value, Value>) {
    let mut data = entry.lock();
    let Some(operation) = data.operations.get(id) else {
        return;
    };
    let current = data.generation == generation && data.control_serial == operation.control_serial;
    let (status, result_value, error_value) = match result {
        Ok(value) if operation.breakpoint_receipts => {
            match (value["operationId"] == id && value["stopRevision"].as_u64() == operation.effective_stop_revision)
                .then(|| assignment_result_state(&value))
                .flatten()
            {
                Some(state) => (state, Some(value), None),
                None => (
                    OperationState::Unknown,
                    None,
                    Some(local_failure(
                        "invalid_breakpoint_result",
                        "The original breakpoint operation returned an invalid command result",
                        true,
                    )),
                ),
            }
        }
        Ok(value) if operation.action == Some(PlDebugAction::SetValue) => match assignment_result_state(&value) {
            Some(state) => (state, Some(value), None),
            None => (
                OperationState::Unknown,
                None,
                Some(local_failure(
                    "invalid_assignment_result",
                    "The original assignment returned an invalid command result",
                    true,
                )),
            ),
        },
        Ok(value) if operation.action == Some(PlDebugAction::Execute) => {
            match execute_result_state(&value, id, operation.effective_stop_revision, operation.execute_receipts) {
                Some(state) => (state, Some(value), None),
                None => (
                    OperationState::Unknown,
                    None,
                    Some(local_failure(
                        "invalid_execute_result",
                        "The original SQL operation returned an invalid result; do not repeat it",
                        true,
                    )),
                ),
            }
        }
        Ok(value) => (OperationState::Succeeded, Some(value), None),
        Err(error) => (
            if error["operationOutcome"] == "not_started" { OperationState::Failed } else { OperationState::Unknown },
            None,
            Some(error),
        ),
    };
    if current {
        if let Some(value) = &result_value {
            apply_agent_snapshot(&mut data, value);
        } else if status == OperationState::Unknown {
            data.snapshot["state"] = json!("unknown");
            data.snapshot["observationError"] = error_value.clone().unwrap();
        }
        data.revision += 1;
    }
    if data.active_operation.as_deref() == Some(id) {
        data.active_operation = None;
    }
    if data.interrupt_operation.as_deref() == Some(id) {
        data.interrupt_operation = None;
    }
    let revision = data.revision;
    if let Some(operation) = data.operations.get_mut(id) {
        operation.receipt.state = status;
        operation.receipt.result = result_value;
        operation.receipt.error = error_value;
        operation.receipt.revision = revision;
    }
    drop(data);
    entry.changed.notify_waiters();
}
fn spawn_start(state: &Arc<AppState>, entry: Arc<Entry>, id: String, generation: u64) {
    let weak = Arc::downgrade(state);
    let task_entry = entry.clone();
    let task_id = id.clone();
    let accepted = state.pl_debug_supervisor().spawn_once(
        format!("pl-debug-start:{}:{generation}", entry.id),
        move |_| async move {
            let result = match weak.upgrade() {
                Some(state) => {
                    with_credential_owner(
                        task_entry.credential_owner.clone(),
                        run_start(&state, &task_entry, &task_id, generation),
                    )
                    .await
                }
                None => Err(local_failure("application_closed", "Application state is no longer available", false)),
            };
            {
                let mut data = task_entry.lock();
                if data.generation == generation {
                    data.start_finished = true;
                }
            }
            let failed = result.is_err();
            finish_operation(&task_entry, &task_id, generation, result);
            if failed {
                request_close(&task_entry, "start_failed", Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT);
            }
        },
    );
    if !accepted {
        entry.lock().start_finished = true;
        finish_operation(
            &entry,
            &id,
            generation,
            Err(local_failure("application_closed", "The application is shutting down", false)),
        );
        request_close(&entry, "application_shutdown", Instant::now());
    }
}
async fn run_start(state: &AppState, entry: &Arc<Entry>, id: &str, generation: u64) -> Result<Value, Value> {
    if !entry.start.risk_accepted {
        return Err(local_failure(
            "confirmation_required",
            "Confirm possible target writes, commits and controller-loss risk before debugging",
            false,
        ));
    }
    let (lifecycle, scope, agent_id, mut target, confirmed) = {
        let mut data = entry.lock();
        if data.generation != generation || data.close.is_some() || data.access_revoked {
            return Err(local_failure("start_cancelled", "Debug start was stopped before dispatch", false));
        }
        data.operations.get_mut(id).unwrap().receipt.state = OperationState::Running;
        (data.lifecycle.clone(), data.scope, data.agent_id.clone(), data.target.clone(), data.production_confirmed)
    };
    check_write_protection(state, entry, confirmed)
        .await
        .map_err(|error| local_failure("write_protected", error, false))?;
    let prepared = state
        .prepare_pl_debug_connection(
            &entry.start.connection_id,
            Some(&entry.start.database),
            &lifecycle,
            &PlDebugPreparation { entry: entry.clone(), generation },
        )
        .await
        .map_err(|error| local_failure("connection_preparation_failed", error, false))?;
    let channel = prepare_pl_debug_channel(
        &state.agent_manager,
        &prepared.config.db_type,
        prepared.config.driver_profile.as_deref(),
        &prepared.config.agent_java_options,
        prepared.transport_stamp.agent_launch_env(),
        Uuid::new_v4().simple().to_string(),
        scope,
    )
    .await
    .map_err(|error| local_failure("agent_preparation_failed", error, false))?;
    {
        let mut data = entry.lock();
        data.channel = Some(channel.clone());
        if data.close.is_some() || data.generation != generation || data.access_revoked {
            if data.close.as_ref().is_some_and(|close| close.deadline <= Instant::now()) {
                channel.fail_stop();
            }
            drop(data);
            entry.changed.notify_waiters();
            return Err(local_failure(
                "start_cancelled",
                "Debug start was stopped before opening its original session",
                false,
            ));
        }
    }
    entry.changed.notify_waiters();
    if !channel.supports_native_pl_debug() {
        return Err(local_failure(
            "native_agent_required",
            "This Agent does not advertise the native no-helper PL debug contract; update the Agent before debugging",
            false,
        ));
    }
    let params = agent_connect_params_with_role(
        &prepared.config,
        &prepared.endpoint.host,
        prepared.endpoint.port,
        prepared.config.effective_database().unwrap_or(""),
        AgentSessionRole::Metadata,
    )
    .map_err(|error| local_failure("invalid_connection", error, false))?;
    PlDebugPreparation { entry: entry.clone(), generation }
        .validate_transport(state)
        .map_err(|error| local_failure("connection_changed", error, false))?;
    channel.open_session(params, agent_connect_timeout(&prepared.config)).await.map_err(call_failure)?;
    check_write_protection(state, entry, confirmed)
        .await
        .map_err(|error| local_failure("write_protected", error, false))?;
    PlDebugPreparation { entry: entry.clone(), generation }
        .validate_transport(state)
        .map_err(|error| local_failure("connection_changed", error, false))?;
    {
        let mut data = entry.lock();
        if data.close.is_some()
            || data.access_revoked
            || data.generation != generation
            || !state.connection_lifecycle_is_current(&entry.start.connection_id, &lifecycle)
        {
            return Err(local_failure(
                "start_cancelled",
                "The original debug connection changed before target dispatch",
                false,
            ));
        }
        data.start_dispatched = true;
        data.operations.get_mut(id).unwrap().receipt.dispatched = true;
    }
    target.as_object_mut().unwrap().insert("operationId".into(), json!(agent_id));
    channel.call("pl_debug_start", target, PL_DEBUG_CONTINUE_TIMEOUT, None).await.map_err(call_failure)
}
pub async fn pl_debug_status_core(
    state: &AppState,
    access: &PlDebugAccess,
    reference: &PlDebugSessionRef,
    refresh: bool,
) -> Result<Value, String> {
    let entry = state.pl_debug.find(access, reference)?;
    if refresh {
        let (channel, agent_id, generation, revision, dispatched) = {
            let data = entry.lock();
            (data.channel.clone(), data.agent_id.clone(), data.generation, data.revision, data.start_dispatched)
        };
        if let Some(channel) = channel {
            if channel.wait_for_exit(Duration::ZERO).await {
                confirm_exit(&entry, &channel).await;
            } else if dispatched {
                let result =
                    channel.call::<Value>("pl_debug_status", json!({"debugId":agent_id}), QUICK_TIMEOUT, None).await;
                {
                    let mut data = entry.lock();
                    if data.generation == generation && data.revision == revision {
                        match result {
                            Ok(value) => {
                                apply_agent_snapshot(&mut data, &value);
                                if data.operations.values().any(|operation| {
                                    (matches!(operation.action, Some(PlDebugAction::SetValue | PlDebugAction::Execute))
                                        || operation.breakpoint_receipts)
                                        && operation.receipt.state == OperationState::Unknown
                                        && operation.receipt.generation == generation
                                        && operation.control_serial == data.control_serial
                                }) {
                                    data.snapshot["state"] = json!("unknown");
                                }
                                data.revision += 1;
                            }
                            Err(error) => {
                                data.snapshot["observationError"] = call_failure(error);
                            }
                        }
                    }
                }
                if channel.supports_set_value_operation_status()
                    || channel.supports_breakpoint_operation_status()
                    || channel.supports_execute_operation_status()
                {
                    recover_value_operations(&entry, &channel, &agent_id, generation).await;
                }
            }
        }
    }
    Ok(entry.view(state.pl_debug.epoch))
}
async fn recover_value_operations(entry: &Entry, channel: &PlDebugAgentChannel, agent_id: &str, generation: u64) {
    let operations = {
        let data = entry.lock();
        if data.generation != generation || data.runtime_exited {
            return;
        }
        data.operations
            .iter()
            .filter(|(_, operation)| {
                ((operation.action == Some(PlDebugAction::SetValue) && channel.supports_set_value_operation_status())
                    || (operation.execute_receipts && channel.supports_execute_operation_status())
                    || (operation.breakpoint_receipts && channel.supports_breakpoint_operation_status()))
                    && operation.receipt.state == OperationState::Unknown
                    && operation.receipt.dispatched
                    && operation.receipt.generation == generation
            })
            .map(|(id, operation)| {
                (
                    id.clone(),
                    operation.control_serial,
                    json!(operation.effective_stop_revision),
                    operation.action.unwrap().method().trim_start_matches("pl_debug_"),
                )
            })
            .collect::<Vec<_>>()
    };
    for (id, serial, stop_revision, action) in operations {
        let Ok(record) = channel
            .call::<Value>(
                "pl_debug_operation_status",
                json!({"debugId":agent_id,"operationId":id}),
                QUICK_TIMEOUT,
                None,
            )
            .await
        else {
            continue;
        };
        let value = &record["result"];
        let rejection = &record["error"];
        let not_started = record["state"] == "failed"
            && rejection["contractVersion"] == 1
            && ((rejection["category"] == "protocol" && rejection["stage"] == "request")
                || (action == "execute"
                    && rejection["category"] == "sql"
                    && rejection["stage"] == "prepare"
                    && value.is_null()))
            && rejection["retryable"] == false
            && rejection["sessionDisposition"] == "keep"
            && rejection["operationOutcome"] == "not_started"
            && (value.is_null()
                || (value["ok"] == false
                    && value.get("result").is_none()
                    && value["operationId"] == id
                    && value["stopRevision"] == stop_revision
                    && value["items"].as_array().is_some_and(|items| {
                        !items.is_empty()
                            && items.iter().all(|item| item["state"] == "failed" || item["state"] == "not_started")
                    })
                    && value["breakpoints"].as_array().is_some_and(Vec::is_empty)));
        let status = if not_started {
            OperationState::Failed
        } else if let Some(status) = if action == "execute" {
            execute_result_state(value, &id, stop_revision.as_u64(), true)
        } else {
            assignment_result_state(value)
        } {
            if !rejection.is_null() {
                continue;
            }
            status
        } else {
            continue;
        };
        let expected_state = if status == OperationState::Succeeded { "succeeded" } else { "failed" };
        if record["operationId"] != id
            || record["action"] != action
            || record["state"] != expected_state
            || record["stopRevision"] != stop_revision
            || (!not_started && (value["operationId"] != id || value["stopRevision"] != stop_revision))
        {
            continue;
        }
        let mut data = entry.lock();
        if data.generation != generation || data.agent_id != agent_id || data.runtime_exited {
            continue;
        }
        let Some(operation) = data.operations.get(&id) else {
            continue;
        };
        if operation.receipt.state != OperationState::Unknown || operation.control_serial != serial {
            continue;
        }
        if !not_started
            && data.control_serial == serial
            && data.close.is_none()
            && !data.access_revoked
            && data.active_operation.is_none()
            && data.interrupt_operation.is_none()
            && data.snapshot["executionStopped"] != true
            && data.snapshot["targetReturned"] != true
            && data.snapshot["stopRevision"] == stop_revision
        {
            apply_agent_snapshot(&mut data, value);
        }
        data.revision += 1;
        let revision = data.revision;
        let operation = data.operations.get_mut(&id).unwrap();
        operation.receipt.state = status;
        operation.receipt.result = (!value.is_null()).then(|| value.clone());
        operation.receipt.error = not_started.then(|| rejection.clone());
        operation.receipt.revision = revision;
        drop(data);
        entry.changed.notify_waiters();
    }
}
pub async fn pl_debug_operate_core(
    state: &Arc<AppState>,
    access: &PlDebugAccess,
    request: PlDebugOperation,
) -> Result<PlDebugReceipt, String> {
    pl_debug_operate_submission_core(state, access, request).await.map_err(PlDebugSubmissionError::into_legacy_message)
}

fn legacy_breakpoint_request(request: &PlDebugOperation) -> bool {
    let params = &request.params;
    if ["registrationId", "sourceRefId", "sourceRevision", "nativeFrameId", "line", "rules"]
        .iter()
        .any(|key| params.get(key).is_some())
    {
        return false;
    }
    match request.action {
        PlDebugAction::SetBreakpoints | PlDebugAction::DeleteBreakpoints => params["breakpoints"].is_array(),
        PlDebugAction::SetBreakpointEnabled => {
            params.get("breakpoints").is_none()
                && params["breakpointNumber"].as_u64().is_some_and(|number| number > 0 && number <= i32::MAX as u64)
                && params["enabled"].is_boolean()
        }
        _ => false,
    }
}

pub async fn pl_debug_operate_submission_core(
    state: &Arc<AppState>,
    access: &PlDebugAccess,
    request: PlDebugOperation,
) -> Result<PlDebugReceipt, PlDebugSubmissionError> {
    let entry = state.pl_debug.find(access, &request.session)?;
    validate_identity(&request.operation_id)?;
    let frozen = serde_json::to_value(&request).unwrap();
    {
        let data = entry.lock();
        if let Some(operation) = data.operations.get(&request.operation_id) {
            if operation.request != frozen {
                return Err("The operation identity already belongs to a different request".into());
            }
            return Ok(operation.receipt.clone());
        }
    }
    let validation = if !request.params.is_object() {
        Err("Debug operation parameters must be an object".into())
    } else if request.action == PlDebugAction::Restart
        && request.params.get("target").is_some_and(|target| !target.is_object())
    {
        Err("Debug target must be an object".into())
    } else if request.action.may_write() {
        with_credential_owner(
            entry.credential_owner.clone(),
            check_write_protection(state, &entry, request.production_confirmed),
        )
        .await
    } else {
        Ok(())
    };
    let admission = (request.action == PlDebugAction::Restart).then(|| state.pl_debug.lock());
    {
        let mut data = entry.lock();
        if data.access_revoked {
            return Err(INACCESSIBLE.into());
        }
        if let Some(operation) = data.operations.get(&request.operation_id) {
            if operation.request != frozen {
                return Err("The operation identity already belongs to a different request".into());
            }
            return Ok(operation.receipt.clone());
        }
        let rejected = |message: &str| PlDebugSubmissionError::RejectedBeforeRegistration(message.into());
        let breakpoint_receipts = request.action.is_breakpoint()
            && data.channel.as_ref().is_some_and(|channel| channel.supports_breakpoint_operation_status());
        let execute_receipts = request.action == PlDebugAction::Execute
            && data.channel.as_ref().is_some_and(|channel| channel.supports_execute_operation_status());
        validation.map_err(PlDebugSubmissionError::RejectedBeforeRegistration)?;
        if data.generation != request.generation || data.revision != request.expected_revision {
            return Err(rejected("The debug state changed; refresh before submitting a new operation"));
        }
        if request.action == PlDebugAction::Close {
            if let Some(id) = &data.close_operation {
                return Ok(data.operations[id].receipt.clone());
            }
        } else if data.close.is_some() && request.action != PlDebugAction::Restart {
            return Err(rejected("The original debug session is closing or isolated; inspect its retained status"));
        }
        let reserved = matches!(request.action, PlDebugAction::Abort | PlDebugAction::Close);
        if data.operations.len() >= if reserved { MAX_OPERATIONS } else { MAX_OPERATIONS - 2 } {
            return Err(rejected("PL debug operation receipt capacity reached; original intents are retained"));
        }
        if request.action == PlDebugAction::Restart {
            let registry = admission.as_ref().unwrap();
            if !registry.accepting
                || registry.connection_fences.contains_key(&entry.start.connection_id)
                || registry.connection_drains.contains_key(&entry.start.connection_id)
                || registry.mutation_permits.values().any(|scope| scope.blocks_start(&entry.start.connection_id))
                || registry.inspections.values().any(|owner| owner.blocks_debug_start(&entry.start.connection_id))
                || registry
                    .compilations
                    .values()
                    .any(|compilation| compilation.protects_connection(&entry.start.connection_id))
            {
                return Err(rejected("The connection is being cleaned up; wait before starting a new debug session"));
            }
            if !data.runtime_exited
                || data.active_operation.is_some()
                || data.close.as_ref().is_some_and(|close| !close.done)
                || data.snapshot["executionStopped"] != true
                || data.snapshot["releaseState"] != "released"
                || data.snapshot["executionOutcome"] == "unknown"
            {
                return Err(rejected(
                    "Confirm the previous program stopped and its original resources were released before restarting",
                ));
            }
            data.generation += 1;
            data.agent_id = Uuid::new_v4().simple().to_string();
            data.scope = Uuid::new_v4();
            data.channel = None;
            data.driver_key = None;
            data.source_profile_ids = None;
            data.transport_plan = None;
            data.transport_stamp = None;
            data.start_finished = false;
            data.start_dispatched = false;
            data.last_heartbeat = Instant::now();
            data.close = None;
            data.close_operation = None;
            data.retained_log = None;
            data.runtime_exited = false;
            data.retired_at = None;
            data.production_confirmed = request.production_confirmed;
            data.lifecycle = state.connection_lifecycle_snapshot(&entry.start.connection_id);
            if let Some(target) = request.params.get("target") {
                data.target = target.clone();
            }
            data.snapshot = initial_snapshot();
        } else if request.action == PlDebugAction::Abort {
            if data.interrupt_operation.is_some() {
                return Err(rejected("A debug abort is already running"));
            }
        } else if request.action != PlDebugAction::Close {
            if data.active_operation.is_some() {
                return Err(rejected("A debug operation is already running"));
            }
            if data.snapshot["state"] != "paused" {
                return Err(rejected("This operation requires a current paused debug stop"));
            }
            let legacy_revision = (request.action == PlDebugAction::Execute
                || (breakpoint_receipts && legacy_breakpoint_request(&request)))
                && request.params.get("stopRevision").is_none();
            if (request.action == PlDebugAction::SetValue
                || breakpoint_receipts
                || request.action == PlDebugAction::Execute)
                && ((!legacy_revision && request.params.get("stopRevision").and_then(Value::as_u64).is_none())
                    || (legacy_revision && data.snapshot["stopRevision"].as_u64().is_none())
                    || (!legacy_revision && request.params.get("stopRevision") != data.snapshot.get("stopRevision")))
            {
                return Err(rejected(
                    "The requested operation belongs to an old debug stop; read it again before changing it",
                ));
            }
        }
        data.control_serial += 1;
        data.revision += 1;
        let receipt = PlDebugReceipt {
            server_epoch: state.pl_debug.epoch,
            session_id: entry.id.clone(),
            operation_id: request.operation_id.clone(),
            generation: data.generation,
            revision: data.revision,
            state: OperationState::Accepted,
            dispatched: false,
            result: None,
            error: None,
        };
        let control_serial = data.control_serial;
        let effective_stop_revision = if (breakpoint_receipts || request.action == PlDebugAction::Execute)
            && request.params.get("stopRevision").is_none()
        {
            data.snapshot["stopRevision"].as_u64()
        } else {
            request.params["stopRevision"].as_u64()
        };
        data.operations.insert(
            request.operation_id.clone(),
            Operation {
                request: frozen,
                receipt,
                control_serial,
                action: Some(request.action),
                breakpoint_receipts,
                execute_receipts,
                effective_stop_revision,
            },
        );
        match request.action {
            PlDebugAction::Abort => data.interrupt_operation = Some(request.operation_id.clone()),
            PlDebugAction::Close => data.close_operation = Some(request.operation_id.clone()),
            _ => data.active_operation = Some(request.operation_id.clone()),
        }
    }
    drop(admission);
    let generation = entry.lock().generation;
    match request.action {
        PlDebugAction::Close => request_close(&entry, "client_close", Instant::now() + PL_DEBUG_CLEANUP_TIMEOUT),
        PlDebugAction::Restart => {
            spawn_start(state, entry.clone(), request.operation_id.clone(), generation);
            spawn_watchdog(state, entry.clone());
        }
        _ => spawn_control(state, entry.clone(), request.clone(), generation),
    }
    let receipt = entry.lock().operations[&request.operation_id].receipt.clone();
    Ok(receipt)
}
fn spawn_control(state: &Arc<AppState>, entry: Arc<Entry>, request: PlDebugOperation, generation: u64) {
    let task_entry = entry.clone();
    let id = request.operation_id.clone();
    if !state.pl_debug_supervisor().spawn_once(format!("pl-debug-operation:{}:{id}", entry.id), move |_| async move {
        let result =
            with_credential_owner(task_entry.credential_owner.clone(), run_control(&task_entry, &request, generation))
                .await;
        finish_operation(&task_entry, &request.operation_id, generation, result);
    }) {
        finish_operation(
            &entry,
            &id,
            generation,
            Err(local_failure("application_closed", "The application is shutting down", false)),
        );
    }
}
async fn run_control(entry: &Entry, request: &PlDebugOperation, generation: u64) -> Result<Value, Value> {
    if request.action.may_write() {
        let state = entry
            .app
            .upgrade()
            .ok_or_else(|| local_failure("application_closed", "Application state is no longer available", false))?;
        check_write_protection(&state, entry, request.production_confirmed)
            .await
            .map_err(|error| local_failure("write_protected", error, false))?;
    }
    let (channel, agent_id, effective_stop_revision) = {
        let mut data = entry.lock();
        let serial = data.operations[&request.operation_id].control_serial;
        if data.generation != generation || data.close.is_some() || data.access_revoked || serial != data.control_serial
        {
            return Err(local_failure("operation_superseded", "The operation was stopped before dispatch", false));
        }
        let channel = data
            .channel
            .clone()
            .ok_or_else(|| local_failure("session_not_ready", "The original Agent session is not ready", false))?;
        if request.action.may_write() && data.lifecycle.cancellation().is_cancelled() {
            return Err(local_failure(
                "connection_changed",
                "The original connection was disconnected or changed",
                false,
            ));
        }
        let operation = data.operations.get_mut(&request.operation_id).unwrap();
        operation.receipt.state = OperationState::Running;
        operation.receipt.dispatched = true;
        let effective_stop_revision = operation.effective_stop_revision;
        (channel, data.agent_id.clone(), effective_stop_revision)
    };
    let mut params = request.params.clone();
    if let Some(revision) = effective_stop_revision {
        params.as_object_mut().unwrap().insert("stopRevision".into(), json!(revision));
    }
    params.as_object_mut().unwrap().insert("debugId".into(), json!(agent_id));
    params.as_object_mut().unwrap().insert("operationId".into(), json!(request.operation_id));
    channel.call(request.action.method(), params, request.action.timeout(), None).await.map_err(call_failure)
}
pub async fn pl_debug_read_core(
    state: &AppState,
    access: &PlDebugAccess,
    request: PlDebugRead,
) -> Result<Value, String> {
    let entry = state.pl_debug.find(access, &request.session)?;
    if matches!(request.kind, PlDebugReadKind::Results | PlDebugReadKind::ResultPage) {
        return results::read(&entry, request).await;
    }
    let (channel, agent_id, serial, retained) = {
        let data = entry.lock();
        if data.generation != request.generation {
            return Err("The debug generation changed; refresh before reading".into());
        }
        if request.kind.needs_stop()
            && (data.snapshot["state"] != "paused"
                || data.active_operation.is_some()
                || data.interrupt_operation.is_some()
                || request.stop_revision.is_none()
                || request.stop_revision != data.snapshot["stopRevision"].as_u64()
                || data.close.is_some())
        {
            return Err("The requested debug stop is no longer current".into());
        }
        (data.channel.clone(), data.agent_id.clone(), data.control_serial, data.retained_log.clone())
    };
    if let Some(log) = retained {
        match request.kind {
            PlDebugReadKind::Log => return Ok(log),
            PlDebugReadKind::LogPage => return retained_log_page(&log, &request.params),
            _ => {}
        }
    }
    let channel = channel.ok_or("The original Agent session is not ready")?;
    let mut params = request.params;
    let object = params.as_object_mut().ok_or("Debug read parameters must be an object")?;
    object.insert("debugId".into(), json!(agent_id));
    if request.kind.needs_stop() {
        object.insert("stopRevision".into(), json!(request.stop_revision));
    }
    let result = channel
        .call::<Value>(request.kind.method(), params, QUICK_TIMEOUT, None)
        .await
        .map_err(|error| error.into_legacy_string())?;
    let data = entry.lock();
    if data.generation != request.generation
        || data.control_serial != serial
        || (request.kind.needs_stop() && result["stopRevision"].as_u64() != request.stop_revision)
    {
        return Err("The read completed for an old debug stop; refresh the current frame".into());
    }
    Ok(result)
}
fn retained_log_page(log: &Value, params: &Value) -> Result<Value, String> {
    let text = log["output"].as_str().unwrap_or("");
    let number = |key: &str, default: u64| -> Result<usize, String> {
        params
            .get(key)
            .map_or(Ok(default), |v| v.as_u64().ok_or_else(|| format!("Invalid output {key}")))
            .and_then(|v| usize::try_from(v).map_err(|_| format!("Invalid output {key}")))
    };
    let offset = number("offset", 0)?;
    let limit = number("limit", 32000)?;
    if !(2..=65536).contains(&limit) {
        return Err("Invalid output page size".into());
    }
    let total = text.encode_utf16().count();
    if offset > total {
        return Err("Invalid output cursor".into());
    }
    let mut units = 0;
    let mut begin = None;
    let mut end = text.len();
    let mut next = total;
    for (byte, character) in text.char_indices() {
        if units == offset {
            begin = Some(byte);
        }
        if units < offset && units + character.len_utf16() > offset {
            return Err("Output cursor splits a Unicode character".into());
        }
        if units >= offset && units + character.len_utf16() > offset + limit {
            end = byte;
            next = units;
            break;
        }
        units += character.len_utf16();
    }
    let begin = begin.unwrap_or(text.len());
    let mut result = log.clone();
    result.as_object_mut().unwrap().remove("output");
    result["outputPage"] = json!({"text":&text[begin..end],"offset":offset,"nextOffset":next,"totalChars":total,
        "complete":log["outputComplete"],"truncated":log["outputTruncated"],"error":log["outputError"]});
    Ok(result)
}

mod compilation;
pub use compilation::{
    pl_debug_compile_core, pl_debug_compile_status_core, pl_debug_prepare_compile_core, pl_debug_submit_compile_core,
    PlDebugCompile, PlDebugCompileAdmission, PlDebugCompileRef,
};
mod inspection;
mod lifecycle;
mod mutation;
mod results;
mod transport;
pub(crate) use inspection::InspectionOwner;
pub use inspection::{
    pl_debug_inspect_dispatch_core, pl_debug_prepare_inspection_core, pl_debug_submit_inspection_core,
    PlDebugInspectionAdmission, PlDebugInspectionSubmission,
};
pub(crate) use lifecycle::{begin_shutdown, drain_connection, drain_transport};
use lifecycle::{confirm_exit, request_close, spawn_watchdog};
pub use mutation::pl_debug_claim_mutation_core;
pub(crate) use transport::{
    adopt_published_transport, current_transport, reserve_transport, retire_transport, transport_publication_guard,
};

#[cfg(test)]
mod tests;
