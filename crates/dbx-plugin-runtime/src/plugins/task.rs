//! The fixed plugin task RPC contract (ADR `scheduler-task-contract.md` §6,
//! frozen — see also `docs/scheduler/implementation-plan.md` §27–§36).
//!
//! A plugin that declares a `task-provider` contribution is driven by the
//! scheduler through exactly five request methods and exactly four events.
//! Plugins cannot invent `task/<custom>` methods: anything outside the fixed
//! set is unknown to the host, and anything outside the fixed events is an
//! ordinary plugin event that no scheduler consumer will decode.
//!
//! Secrets never travel through this contract: task configs carry a
//! `connectionId`/`secretRef` binding, the host hydrates secrets into the
//! connection lifecycle payload at execution time, and any structured payload
//! (config, event, artifact metadata) whose keys look like a credential
//! (`password` / `token` / `privateKey` / `authorization` / session-key
//! fragments, ADR §10) is rejected before it reaches the sidecar or the
//! scheduler.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    PluginFormFieldOption, PluginHost, PluginTaskCapability, PluginTaskMode, PluginTaskProviderContribution,
    PluginTaskTriggerContribution, PLUGIN_REQUEST_TIMEOUT,
};

pub const PLUGIN_TASK_VALIDATE_METHOD: &str = "task/validate";
pub const PLUGIN_TASK_EXECUTE_METHOD: &str = "task/execute";
pub const PLUGIN_TASK_START_METHOD: &str = "task/start";
pub const PLUGIN_TASK_STOP_METHOD: &str = "task/stop";
pub const PLUGIN_TASK_STATUS_METHOD: &str = "task/status";

pub const PLUGIN_TASK_LOG_EVENT: &str = "task/log";
pub const PLUGIN_TASK_PROGRESS_EVENT: &str = "task/progress";
pub const PLUGIN_TASK_STATE_EVENT: &str = "task/state";
pub const PLUGIN_TASK_ARTIFACT_EVENT: &str = "task/artifact";

/// Upper bound for one `task/log` message. Log lines stream per record; a
/// single line bigger than this is a misbehaving provider, not a log.
pub const MAX_PLUGIN_TASK_LOG_MESSAGE_BYTES: usize = 64 * 1024;
/// Upper bound for human-readable result messages (`task/execute`,
/// `task/stop`), mirroring the filesystem mutation contract.
pub const MAX_PLUGIN_TASK_MESSAGE_BYTES: usize = 4_096;
/// Upper bound for `taskId` / `runId` / `sessionId` identity strings.
pub const MAX_PLUGIN_TASK_ID_CHARS: usize = 256;

/// The five fixed host -> plugin task request methods. Exhaustive on purpose:
/// `task/<custom>` has no mapping, so a caller asking for it fails at the
/// host instead of teaching plugins to expect arbitrary RPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PluginTaskMethod {
    Validate,
    Execute,
    Start,
    Stop,
    Status,
}

impl PluginTaskMethod {
    pub fn from_method_name(method: &str) -> Option<Self> {
        match method {
            PLUGIN_TASK_VALIDATE_METHOD => Some(Self::Validate),
            PLUGIN_TASK_EXECUTE_METHOD => Some(Self::Execute),
            PLUGIN_TASK_START_METHOD => Some(Self::Start),
            PLUGIN_TASK_STOP_METHOD => Some(Self::Stop),
            PLUGIN_TASK_STATUS_METHOD => Some(Self::Status),
            _ => None,
        }
    }

    pub fn method_name(self) -> &'static str {
        match self {
            Self::Validate => PLUGIN_TASK_VALIDATE_METHOD,
            Self::Execute => PLUGIN_TASK_EXECUTE_METHOD,
            Self::Start => PLUGIN_TASK_START_METHOD,
            Self::Stop => PLUGIN_TASK_STOP_METHOD,
            Self::Status => PLUGIN_TASK_STATUS_METHOD,
        }
    }
}

/// Key fragments that mark a structured field as a credential the task
/// contract must never carry (ADR §10: password, token, privateKey,
/// authorization, session keys — `secret`-named keys included). Matching is a
/// case-insensitive substring on JSON object keys, so `password`, `apiToken`,
/// and `client_secret` are all caught; the false-positive cost (a config key
/// that merely contains the fragment is rejected) is the price of never
/// letting a credential slip into task configs, logs, events, or exports.
const SECRET_KEY_FRAGMENTS: &[&str] =
    &["password", "token", "secret", "privatekey", "private_key", "authorization", "sessionkey", "session_key"];

/// Whether any object key inside `value` looks like a credential. Recurses
/// through objects and arrays; scalar values are not inspected (only key
/// names carry intent, and content scanning would reject legitimate text such
/// as a log line that merely contains the word "token").
pub fn task_payload_contains_secret_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase();
            SECRET_KEY_FRAGMENTS.iter().any(|fragment| key.contains(fragment))
                || task_payload_contains_secret_key(value)
        }),
        Value::Array(items) => items.iter().any(task_payload_contains_secret_key),
        _ => false,
    }
}

fn ensure_task_config_has_no_secrets(config: &Value) -> Result<(), String> {
    if task_payload_contains_secret_key(config) {
        Err("Task config contains a secret-like key (password/token/secret); bind credentials to a connection \
             with secretRef instead — the host hydrates them at execution time"
            .to_string())
    } else {
        Ok(())
    }
}

/// The frozen `task` object of `task/validate`
/// (`{ providerId, triggerId, connectionId, configVersion, config }`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskValidateTask {
    pub provider_id: String,
    pub trigger_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// First-class config version (ADR D2). The host owns it; plugins use it
    /// to validate or migrate the shape of `config`.
    pub config_version: u32,
    /// The task config gathered from the trigger's declared form fields.
    /// Secret-bearing keys are rejected before this leaves the host.
    pub config: Value,
}

/// `task/validate` request: `{ task, connection, runtime }` (ADR §6.2).
/// `connection` is the host-built lifecycle payload of the bound connection —
/// only fields the host decides to expose, with hydrated secrets in their
/// controlled lifecycle positions; `runtime` carries the resolved transport
/// endpoint. Both are omitted when not applicable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskValidateRequest {
    pub task: PluginTaskValidateTask,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskValidateResult {
    #[serde(default = "default_true")]
    pub valid: bool,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Field updates the plugin proposes (dynamic defaults, normalized paths).
    #[serde(default)]
    pub field_values: BTreeMap<String, Value>,
    /// Dynamic completion for select/radio fields, keyed by field key.
    #[serde(default)]
    pub options: BTreeMap<String, Vec<PluginFormFieldOption>>,
}

/// The frozen `task` object of `task/execute` and `task/start`
/// (`{ taskId, runId, triggerId, connectionId, configVersion, config }`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskRunTask {
    pub task_id: String,
    pub run_id: String,
    pub trigger_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub config_version: u32,
    pub config: Value,
}

/// The frozen `run` object of `task/execute` and `task/start`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskRunRef {
    pub run_id: String,
    /// 1-based execution attempt (retry counter of the execution policy).
    pub attempt: u64,
}

/// `task/execute` / `task/start` request:
/// `{ task, run, connection, runtime }` (ADR §6.2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskRunRequest {
    pub task: PluginTaskRunTask,
    pub run: PluginTaskRunRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskArtifact {
    pub name: String,
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskExecuteResult {
    #[serde(default = "default_true")]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<PluginTaskArtifact>,
}

/// Resident session states (ADR §2.7, frozen): `running` means the session
/// answered the latest heartbeat; `degraded` means the restart budget was
/// exhausted and the host must stop retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskSessionState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskStartResult {
    pub session_id: String,
    pub state: PluginTaskSessionState,
}

/// `task/stop` request: `{ taskId, runId, sessionId, reason }` (ADR §6.2).
/// `runId` identifies a run-mode cancellation, `sessionId` a resident one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskStopRequest {
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Why the host is stopping the task (user cancel, timeout, shutdown).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `task/stop` response: the frozen shape is the empty object `{}`; failure is
/// a JSON-RPC error, not a `success: false` body.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginTaskStopResult {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskStatusRequest {
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskStatusResult {
    pub state: PluginTaskSessionState,
    /// Timestamp of the last resident heartbeat (UTC RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
    #[serde(default)]
    pub restart_count: u64,
}

/// `task/log` event payload (ADR §6.3): `{ event, taskId, runId, seq, stream,
/// level, message, timestamp? }`. The `event` discriminator mirrors the
/// JSON-RPC method name and is ignored on decode; `seq` is the provider's
/// per-run monotonically increasing sequence so the host can persist an
/// ordered stream and the UI can tail it without re-fetching.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskLogEvent {
    pub task_id: String,
    pub run_id: String,
    pub seq: u64,
    pub stream: PluginTaskStream,
    pub level: PluginTaskLogLevel,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginTaskLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// `task/progress` event payload (ADR §6.3): `{ event, taskId, runId,
/// percent, current?, completed?, total? }`. `percent` is required; the host
/// normalizes the payload into `TaskProgress { percent, current, completed,
/// total }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskProgressEvent {
    pub task_id: String,
    pub run_id: String,
    pub percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

/// `task/state` event payload (ADR §6.3): `{ event, taskId, runId, state }`.
/// Every event must be relatable to a run, so `runId` is required here too.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskStateEvent {
    pub task_id: String,
    pub run_id: String,
    pub state: PluginTaskSessionState,
}

/// `task/artifact` event payload (ADR §6.3): `{ event, taskId, runId,
/// artifact: { name, uri, size? } }`. The host persists the metadata plus uri
/// only — artifact bodies never enter the event channel or the database.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTaskArtifactEvent {
    pub task_id: String,
    pub run_id: String,
    pub artifact: PluginTaskArtifact,
}

/// A decoded plugin task event, tagged by the fixed event method.
#[derive(Debug, Clone, PartialEq)]
pub enum PluginTaskEvent {
    Log(PluginTaskLogEvent),
    Progress(PluginTaskProgressEvent),
    State(PluginTaskStateEvent),
    Artifact(PluginTaskArtifactEvent),
}

impl PluginTaskEvent {
    pub fn method_name(&self) -> &'static str {
        match self {
            Self::Log(_) => PLUGIN_TASK_LOG_EVENT,
            Self::Progress(_) => PLUGIN_TASK_PROGRESS_EVENT,
            Self::State(_) => PLUGIN_TASK_STATE_EVENT,
            Self::Artifact(_) => PLUGIN_TASK_ARTIFACT_EVENT,
        }
    }

    /// The provider capability the event requires: `task/log` needs `logs`,
    /// `task/progress` needs `progress`, `task/artifact` needs `artifacts`,
    /// and `task/state` is part of the base contract.
    pub fn required_capability(&self) -> Option<PluginTaskCapability> {
        match self {
            Self::Log(_) => Some(PluginTaskCapability::Logs),
            Self::Progress(_) => Some(PluginTaskCapability::Progress),
            Self::Artifact(_) => Some(PluginTaskCapability::Artifacts),
            Self::State(_) => None,
        }
    }

    /// The run the event belongs to. Every fixed task event carries
    /// `taskId` + `runId` so the host can route it to the persisted run.
    pub fn task_and_run_id(&self) -> (&str, &str) {
        match self {
            Self::Log(event) => (&event.task_id, &event.run_id),
            Self::Progress(event) => (&event.task_id, &event.run_id),
            Self::State(event) => (&event.task_id, &event.run_id),
            Self::Artifact(event) => (&event.task_id, &event.run_id),
        }
    }
}

/// Decodes and validates one plugin event against the fixed task event
/// contract. Unknown `task/…` methods are rejected here too — the four event
/// names are the only task events a scheduler consumer will ever accept.
pub fn decode_task_event(method: &str, params: &Value) -> Result<PluginTaskEvent, String> {
    if !params.is_object() {
        return Err(format!("Task event '{method}' params must be an object"));
    }
    if task_payload_contains_secret_key(params) {
        return Err(format!(
            "Task event '{method}' carries a secret-like key (password/token/secret); the plugin must redact it"
        ));
    }
    match method {
        PLUGIN_TASK_LOG_EVENT => {
            let event: PluginTaskLogEvent = serde_json::from_value(params.clone())
                .map_err(|error| format!("Task event '{method}' has an invalid payload: {error}"))?;
            validate_task_identity(Some(&event.task_id), Some(&event.run_id), None)?;
            if event.message.len() > MAX_PLUGIN_TASK_LOG_MESSAGE_BYTES {
                return Err(format!("Task event '{method}' message exceeds {MAX_PLUGIN_TASK_LOG_MESSAGE_BYTES} bytes"));
            }
            if event.message.chars().any(char::is_control) {
                return Err(format!("Task event '{method}' message contains control characters"));
            }
            if let Some(timestamp) = &event.timestamp {
                if timestamp.len() > 128 || timestamp.chars().any(char::is_control) {
                    return Err(format!("Task event '{method}' timestamp is invalid"));
                }
            }
            Ok(PluginTaskEvent::Log(event))
        }
        PLUGIN_TASK_PROGRESS_EVENT => {
            let event: PluginTaskProgressEvent = serde_json::from_value(params.clone())
                .map_err(|error| format!("Task event '{method}' has an invalid payload: {error}"))?;
            validate_task_identity(Some(&event.task_id), Some(&event.run_id), None)?;
            if !event.percent.is_finite() || !(-0.0..=100.0).contains(&event.percent) {
                return Err(format!("Task event '{method}' percent must be a finite value in 0..=100"));
            }
            Ok(PluginTaskEvent::Progress(event))
        }
        PLUGIN_TASK_STATE_EVENT => {
            let event: PluginTaskStateEvent = serde_json::from_value(params.clone())
                .map_err(|error| format!("Task event '{method}' has an invalid payload: {error}"))?;
            validate_task_identity(Some(&event.task_id), Some(&event.run_id), None)?;
            Ok(PluginTaskEvent::State(event))
        }
        PLUGIN_TASK_ARTIFACT_EVENT => {
            let event: PluginTaskArtifactEvent = serde_json::from_value(params.clone())
                .map_err(|error| format!("Task event '{method}' has an invalid payload: {error}"))?;
            validate_task_identity(Some(&event.task_id), Some(&event.run_id), None)?;
            validate_artifact(&event.artifact)?;
            Ok(PluginTaskEvent::Artifact(event))
        }
        other => Err(format!(
            "Unknown task event '{other}'; only task/log, task/progress, task/state and task/artifact are \
             part of the contract"
        )),
    }
}

/// Rejects the event when the provider did not declare the capability backing
/// it. `task/state` needs no capability (the base contract covers it).
pub fn ensure_task_event_capability(
    provider: &PluginTaskProviderContribution,
    event: &PluginTaskEvent,
) -> Result<(), String> {
    match event.required_capability() {
        Some(capability) if !provider.has_capability(capability) => Err(format!(
            "Task provider '{}' emitted '{}' without declaring the '{}' capability",
            provider.id,
            event.method_name(),
            capability.as_str()
        )),
        _ => Ok(()),
    }
}

fn validate_task_identity(task_id: Option<&str>, run_id: Option<&str>, session_id: Option<&str>) -> Result<(), String> {
    let validate = |value: Option<&str>, label: &str, required: bool| -> Result<(), String> {
        match value {
            Some(value) => {
                if value.trim().is_empty()
                    || value.len() > MAX_PLUGIN_TASK_ID_CHARS
                    || value.chars().any(|character| character.is_control() || character.is_whitespace())
                {
                    Err(format!("Task event '{label}' is invalid"))
                } else {
                    Ok(())
                }
            }
            None if required => Err(format!("Task event '{label}' is required")),
            None => Ok(()),
        }
    };
    validate(task_id, "taskId", true)?;
    validate(run_id, "runId", true)?;
    validate(session_id, "sessionId", false)
}

fn validate_artifact(artifact: &PluginTaskArtifact) -> Result<(), String> {
    if artifact.name.trim().is_empty() || artifact.name.len() > 1_024 || artifact.name.chars().any(char::is_control) {
        return Err("Task event artifact name is invalid".to_string());
    }
    if artifact.uri.is_empty()
        || artifact.uri.len() > 4_096
        || artifact.uri.chars().any(char::is_control)
        || artifact.uri.chars().any(char::is_whitespace)
    {
        return Err(format!("Task event artifact '{}' has an invalid uri", artifact.name));
    }
    Ok(())
}

fn validate_message(message: Option<&str>) -> Result<(), String> {
    match message {
        Some(message) if message.len() > MAX_PLUGIN_TASK_MESSAGE_BYTES || message.chars().any(char::is_control) => {
            Err("Task result message is invalid".to_string())
        }
        _ => Ok(()),
    }
}

fn default_true() -> bool {
    true
}

impl PluginHost {
    /// Resolves a declared `task-provider` contribution, mirroring the
    /// filesystem provider lookup: only contributions the manifest declares
    /// can be driven, and only on a compatible plugin with a backend.
    pub fn resolve_task_provider(
        &self,
        plugin_id: &str,
        provider_id: &str,
    ) -> Result<PluginTaskProviderContribution, String> {
        let plugin =
            self.registry().find_plugin(plugin_id)?.ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
        if !plugin.compatibility.compatible {
            return Err(format!("Plugin '{plugin_id}' is incompatible: {}", plugin.compatibility.errors.join("; ")));
        }
        plugin
            .manifest
            .task_provider(provider_id)?
            .ok_or_else(|| format!("Task provider '{plugin_id}/{provider_id}' is not declared"))
    }

    /// `task/validate`: checks a trigger's config (and optionally its bound
    /// connection) with the provider and collects dynamic field values and
    /// options. Requires no specific capability — every task provider can be
    /// validated.
    pub async fn validate_task(
        &self,
        plugin_id: &str,
        request: PluginTaskValidateRequest,
    ) -> Result<PluginTaskValidateResult, String> {
        let provider = self.resolve_task_provider(plugin_id, &request.task.provider_id)?;
        require_task_trigger(&provider, &request.task.trigger_id)?;
        ensure_task_config_has_no_secrets(&request.task.config)?;
        let result: PluginTaskValidateResult = self
            .invoke(
                plugin_id,
                PLUGIN_TASK_VALIDATE_METHOD,
                serde_json::to_value(&request).map_err(|error| error.to_string())?,
                None,
                Some(PLUGIN_REQUEST_TIMEOUT),
            )
            .await?;
        Ok(result)
    }

    /// `task/execute`: runs one one-shot execution. Requires the `run`
    /// capability and a `run`-mode trigger; `timeout` comes from the task's
    /// execution policy (a run may legitimately outlive the default request
    /// deadline, so the scheduler passes it explicitly).
    pub async fn execute_task(
        &self,
        plugin_id: &str,
        provider_id: &str,
        request: PluginTaskRunRequest,
        timeout: Option<Duration>,
    ) -> Result<PluginTaskExecuteResult, String> {
        let provider = self.resolve_task_provider(plugin_id, provider_id)?;
        ensure_task_capability(plugin_id, &provider, PluginTaskCapability::Run)?;
        require_task_trigger_mode(&provider, &request.task.trigger_id, PluginTaskMode::Run)?;
        ensure_task_config_has_no_secrets(&request.task.config)?;
        validate_task_identity(Some(&request.task.task_id), Some(&request.task.run_id), None)?;
        if request.run.attempt == 0 {
            return Err("Task run attempt is 1-based".to_string());
        }
        let result: PluginTaskExecuteResult = self
            .invoke(
                plugin_id,
                PLUGIN_TASK_EXECUTE_METHOD,
                serde_json::to_value(&request).map_err(|error| error.to_string())?,
                None,
                timeout,
            )
            .await?;
        validate_execute_result(&provider, &result)?;
        Ok(result)
    }

    /// `task/start`: launches a resident session. Requires the `resident`
    /// capability and a `resident`-mode trigger.
    pub async fn start_task(
        &self,
        plugin_id: &str,
        provider_id: &str,
        request: PluginTaskRunRequest,
        timeout: Option<Duration>,
    ) -> Result<PluginTaskStartResult, String> {
        let provider = self.resolve_task_provider(plugin_id, provider_id)?;
        ensure_task_capability(plugin_id, &provider, PluginTaskCapability::Resident)?;
        require_task_trigger_mode(&provider, &request.task.trigger_id, PluginTaskMode::Resident)?;
        ensure_task_config_has_no_secrets(&request.task.config)?;
        validate_task_identity(Some(&request.task.task_id), Some(&request.task.run_id), None)?;
        if request.run.attempt == 0 {
            return Err("Task run attempt is 1-based".to_string());
        }
        let result: PluginTaskStartResult = self
            .invoke(
                plugin_id,
                PLUGIN_TASK_START_METHOD,
                serde_json::to_value(&request).map_err(|error| error.to_string())?,
                None,
                timeout,
            )
            .await?;
        if result.session_id.trim().is_empty() || result.session_id.len() > MAX_PLUGIN_TASK_ID_CHARS {
            return Err(format!("Task provider '{}' returned an invalid session id", provider.id));
        }
        Ok(result)
    }

    /// `task/stop`: cancels an active run or resident session. Requires the
    /// `cancel` capability (a `resident` provider may stop its own sessions).
    pub async fn stop_task(
        &self,
        plugin_id: &str,
        provider_id: &str,
        request: PluginTaskStopRequest,
    ) -> Result<PluginTaskStopResult, String> {
        let provider = self.resolve_task_provider(plugin_id, provider_id)?;
        ensure_task_capability(plugin_id, &provider, PluginTaskCapability::Cancel)
            .or_else(|_| ensure_task_capability(plugin_id, &provider, PluginTaskCapability::Resident))?;
        validate_task_identity(Some(&request.task_id), request.run_id.as_deref(), request.session_id.as_deref())?;
        if let Some(reason) = &request.reason {
            validate_message(Some(reason))?;
        }
        self.invoke(
            plugin_id,
            PLUGIN_TASK_STOP_METHOD,
            serde_json::to_value(&request).map_err(|error| error.to_string())?,
            None,
            Some(PLUGIN_REQUEST_TIMEOUT),
        )
        .await
    }

    /// `task/status`: reads a resident session's state, heartbeat, and restart
    /// counter. Requires the `resident` capability — run-mode progress is
    /// scheduler-owned, not provider-owned.
    pub async fn task_status(
        &self,
        plugin_id: &str,
        provider_id: &str,
        request: PluginTaskStatusRequest,
    ) -> Result<PluginTaskStatusResult, String> {
        let provider = self.resolve_task_provider(plugin_id, provider_id)?;
        ensure_task_capability(plugin_id, &provider, PluginTaskCapability::Resident)?;
        validate_task_identity(Some(&request.task_id), request.run_id.as_deref(), request.session_id.as_deref())?;
        let result: PluginTaskStatusResult = self
            .invoke(
                plugin_id,
                PLUGIN_TASK_STATUS_METHOD,
                serde_json::to_value(&request).map_err(|error| error.to_string())?,
                None,
                Some(PLUGIN_REQUEST_TIMEOUT),
            )
            .await?;
        if let Some(heartbeat_at) = &result.heartbeat_at {
            if heartbeat_at.len() > 128 || heartbeat_at.chars().any(char::is_control) {
                return Err(format!("Task provider '{}' returned an invalid heartbeat timestamp", provider.id));
            }
        }
        Ok(result)
    }
}

fn require_task_trigger<'a>(
    provider: &'a PluginTaskProviderContribution,
    trigger_id: &str,
) -> Result<&'a PluginTaskTriggerContribution, String> {
    provider
        .trigger(trigger_id)
        .ok_or_else(|| format!("Task provider '{}' does not declare trigger '{trigger_id}'", provider.id))
}

fn require_task_trigger_mode(
    provider: &PluginTaskProviderContribution,
    trigger_id: &str,
    mode: PluginTaskMode,
) -> Result<(), String> {
    let trigger = require_task_trigger(provider, trigger_id)?;
    if trigger.mode != mode {
        Err(format!(
            "Task trigger '{}/{}' is a {} trigger, not a {} trigger",
            provider.id,
            trigger_id,
            trigger.mode.as_str(),
            mode.as_str()
        ))
    } else {
        Ok(())
    }
}

fn ensure_task_capability(
    plugin_id: &str,
    provider: &PluginTaskProviderContribution,
    capability: PluginTaskCapability,
) -> Result<(), String> {
    if provider.has_capability(capability) {
        Ok(())
    } else {
        Err(format!("Task provider '{plugin_id}/{}' does not declare {} capability", provider.id, capability.as_str()))
    }
}

fn validate_execute_result(
    provider: &PluginTaskProviderContribution,
    result: &PluginTaskExecuteResult,
) -> Result<(), String> {
    validate_message(result.message.as_deref())?;
    for artifact in &result.artifacts {
        validate_artifact(artifact)?;
    }
    if !result.artifacts.is_empty() && !provider.has_capability(PluginTaskCapability::Artifacts) {
        return Err(format!(
            "Task provider '{}' returned artifacts without declaring the 'artifacts' capability",
            provider.id
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        decode_task_event, ensure_task_capability, ensure_task_event_capability, task_payload_contains_secret_key,
        PluginTaskArtifact, PluginTaskCapability, PluginTaskExecuteResult, PluginTaskLogLevel, PluginTaskMethod,
        PluginTaskProviderContribution, PluginTaskStream, PLUGIN_TASK_ARTIFACT_EVENT, PLUGIN_TASK_EXECUTE_METHOD,
        PLUGIN_TASK_LOG_EVENT, PLUGIN_TASK_PROGRESS_EVENT, PLUGIN_TASK_START_METHOD, PLUGIN_TASK_STATE_EVENT,
        PLUGIN_TASK_STATUS_METHOD, PLUGIN_TASK_STOP_METHOD, PLUGIN_TASK_VALIDATE_METHOD,
    };

    fn provider(capabilities: &[PluginTaskCapability]) -> PluginTaskProviderContribution {
        PluginTaskProviderContribution {
            id: "io.dbx.ssh.tasks".to_string(),
            label: "SSH Tasks".to_string(),
            connection_providers: Vec::new(),
            capabilities: capabilities.to_vec(),
            triggers: Vec::new(),
        }
    }

    #[test]
    fn fixed_task_methods_are_exhaustive() {
        assert_eq!(PluginTaskMethod::from_method_name(PLUGIN_TASK_VALIDATE_METHOD), Some(PluginTaskMethod::Validate));
        assert_eq!(PluginTaskMethod::from_method_name(PLUGIN_TASK_EXECUTE_METHOD), Some(PluginTaskMethod::Execute));
        assert_eq!(PluginTaskMethod::from_method_name(PLUGIN_TASK_START_METHOD), Some(PluginTaskMethod::Start));
        assert_eq!(PluginTaskMethod::from_method_name(PLUGIN_TASK_STOP_METHOD), Some(PluginTaskMethod::Stop));
        assert_eq!(PluginTaskMethod::from_method_name(PLUGIN_TASK_STATUS_METHOD), Some(PluginTaskMethod::Status));
        for unknown in ["task/cancel", "task/restart", "task/logs", "task", "task/"] {
            assert_eq!(PluginTaskMethod::from_method_name(unknown), None, "{unknown} must not be a fixed method");
        }
    }

    #[test]
    fn decodes_every_fixed_task_event() {
        let log = decode_task_event(
            PLUGIN_TASK_LOG_EVENT,
            &json!({ "event": "task/log", "taskId": "task-1", "runId": "run-1", "seq": 3, "stream": "stderr",
                     "level": "warn", "message": "retrying", "timestamp": "2026-10-05T00:00:00Z" }),
        )
        .unwrap();
        assert_eq!(log.method_name(), PLUGIN_TASK_LOG_EVENT);
        assert_eq!(log.task_and_run_id(), ("task-1", "run-1"));
        assert!(matches!(
            log,
            super::PluginTaskEvent::Log(super::PluginTaskLogEvent {
                stream: PluginTaskStream::Stderr,
                level: PluginTaskLogLevel::Warn,
                ..
            })
        ));

        let progress = decode_task_event(
            PLUGIN_TASK_PROGRESS_EVENT,
            &json!({ "taskId": "task-1", "runId": "run-1", "percent": 25.0, "completed": 2, "total": 8,
                     "current": "table_a" }),
        )
        .unwrap();
        assert_eq!(progress.method_name(), PLUGIN_TASK_PROGRESS_EVENT);

        let state = decode_task_event(
            PLUGIN_TASK_STATE_EVENT,
            &json!({ "taskId": "task-1", "runId": "run-1", "state": "running" }),
        )
        .unwrap();
        assert_eq!(state.method_name(), PLUGIN_TASK_STATE_EVENT);

        let artifact = decode_task_event(
            PLUGIN_TASK_ARTIFACT_EVENT,
            &json!({ "taskId": "task-1", "runId": "run-1",
                     "artifact": { "name": "dump.sql.gz", "uri": "files:/backups/dump.sql.gz", "size": 1024 } }),
        )
        .unwrap();
        assert_eq!(artifact.method_name(), PLUGIN_TASK_ARTIFACT_EVENT);
    }

    #[test]
    fn rejects_malformed_and_unknown_task_events() {
        for method in ["task/stdout", "task/cancel", "task/log/extra"] {
            let error = decode_task_event(method, &json!({ "taskId": "t", "runId": "r" })).unwrap_err();
            assert!(error.contains("Unknown task event"), "{method}: {error}");
        }

        // taskId and runId are mandatory on every fixed task event.
        let missing_ids = decode_task_event(PLUGIN_TASK_STATE_EVENT, &json!({ "state": "running" })).unwrap_err();
        assert!(missing_ids.contains("invalid payload"), "{missing_ids}");
        let missing_run = decode_task_event(
            PLUGIN_TASK_LOG_EVENT,
            &json!({ "taskId": "task-1", "seq": 1, "stream": "stdout", "level": "info", "message": "hi" }),
        )
        .unwrap_err();
        assert!(missing_run.contains("invalid payload"), "{missing_run}");
        let missing_task =
            decode_task_event(PLUGIN_TASK_PROGRESS_EVENT, &json!({ "runId": "run-1", "percent": 10.0 })).unwrap_err();
        assert!(missing_task.contains("invalid payload"), "{missing_task}");
        let missing_artifact_identity = decode_task_event(
            PLUGIN_TASK_ARTIFACT_EVENT,
            &json!({ "runId": "run-1", "artifact": { "name": "a", "uri": "files:/a" } }),
        )
        .unwrap_err();
        assert!(missing_artifact_identity.contains("invalid payload"), "{missing_artifact_identity}");

        let bad_level = decode_task_event(
            PLUGIN_TASK_LOG_EVENT,
            &json!({ "taskId": "t", "runId": "r", "seq": 1, "stream": "stdout", "level": "loud", "message": "x" }),
        )
        .unwrap_err();
        assert!(bad_level.contains("invalid payload"), "{bad_level}");

        let bad_state =
            decode_task_event(PLUGIN_TASK_STATE_EVENT, &json!({ "taskId": "t", "runId": "r", "state": "teleporting" }))
                .unwrap_err();
        assert!(bad_state.contains("invalid payload"), "{bad_state}");

        let bad_percent =
            decode_task_event(PLUGIN_TASK_PROGRESS_EVENT, &json!({ "taskId": "t", "runId": "r", "percent": 120.0 }))
                .unwrap_err();
        assert!(bad_percent.contains("0..=100"), "{bad_percent}");

        let nan_percent =
            decode_task_event(PLUGIN_TASK_PROGRESS_EVENT, &json!({ "taskId": "t", "runId": "r", "percent": "NaN" }))
                .unwrap_err();
        assert!(nan_percent.contains("invalid payload"), "{nan_percent}");

        let bad_artifact = decode_task_event(
            PLUGIN_TASK_ARTIFACT_EVENT,
            &json!({ "taskId": "t", "runId": "r", "artifact": { "name": "", "uri": "files:/x" } }),
        )
        .unwrap_err();
        assert!(bad_artifact.contains("artifact name"), "{bad_artifact}");

        let non_object = decode_task_event(PLUGIN_TASK_STATE_EVENT, &json!(["running"])).unwrap_err();
        assert!(non_object.contains("must be an object"), "{non_object}");
    }

    #[test]
    fn secret_keys_are_rejected_in_configs_and_events() {
        assert!(task_payload_contains_secret_key(&json!({ "password": "hunter2" })));
        assert!(task_payload_contains_secret_key(&json!({ "apiToken": "x" })));
        assert!(task_payload_contains_secret_key(&json!({ "private_key": "x" })));
        assert!(task_payload_contains_secret_key(&json!({ "Authorization": "Bearer x" })));
        assert!(task_payload_contains_secret_key(&json!({ "nested": [{ "client_secret": "x" }] })));
        assert!(!task_payload_contains_secret_key(&json!({ "command": "echo hello", "timeout_seconds": 5 })));

        let leaked = decode_task_event(
            PLUGIN_TASK_LOG_EVENT,
            &json!({ "taskId": "t", "runId": "r", "seq": 1, "stream": "stdout", "level": "info",
                     "message": "hi", "password": "hunter2" }),
        )
        .unwrap_err();
        assert!(leaked.contains("secret-like key"), "{leaked}");

        let leaked_artifact = decode_task_event(
            PLUGIN_TASK_ARTIFACT_EVENT,
            &json!({ "taskId": "t", "runId": "r", "artifact": { "name": "a", "uri": "files:/a", "secretRef": "x" } }),
        )
        .unwrap_err();
        assert!(leaked_artifact.contains("secret-like key"), "{leaked_artifact}");
    }

    #[test]
    fn task_events_are_gated_on_declared_capabilities() {
        let event = decode_task_event(
            PLUGIN_TASK_LOG_EVENT,
            &json!({ "taskId": "t", "runId": "r", "seq": 1, "stream": "stdout", "level": "info", "message": "x" }),
        )
        .unwrap();
        assert!(ensure_task_event_capability(&provider(&[PluginTaskCapability::Logs]), &event).is_ok());
        let error = ensure_task_event_capability(&provider(&[]), &event).unwrap_err();
        assert!(error.contains("'logs' capability"), "{error}");

        let state =
            decode_task_event(PLUGIN_TASK_STATE_EVENT, &json!({ "taskId": "t", "runId": "r", "state": "stopped" }))
                .unwrap();
        assert!(ensure_task_event_capability(&provider(&[]), &state).is_ok(), "task/state needs no capability");

        let error = ensure_task_capability("io.dbx.ssh.tasks", &provider(&[]), PluginTaskCapability::Run).unwrap_err();
        assert!(error.contains("run capability"), "{error}");
    }

    #[test]
    fn execute_results_reject_artifacts_without_the_capability() {
        let result = PluginTaskExecuteResult {
            success: true,
            exit_code: Some(0),
            message: None,
            artifacts: vec![PluginTaskArtifact {
                name: "dump.sql.gz".to_string(),
                uri: "files:/backups/dump.sql.gz".to_string(),
                size: Some(1024),
            }],
        };
        assert!(
            super::validate_execute_result(&provider(&[PluginTaskCapability::Artifacts]), &result).is_ok(),
            "declaring artifacts accepts the result"
        );
        let error = super::validate_execute_result(&provider(&[]), &result).unwrap_err();
        assert!(error.contains("'artifacts' capability"), "{error}");
    }
}
