//! The fixed plugin task contract (ADR `scheduler-task-contract.md` §6):
//! exactly five `task/*` request methods and exactly four `task/*` events.
//! Plugins cannot invent `task/<custom>` methods — the host rejects anything
//! outside this frozen set, so the SDK only names the frozen shapes here.
//!
//! Secrets never travel through this contract: task configs carry a
//! `connectionId` binding and the host hydrates credentials into the
//! connection lifecycle payload at execution time. Never put a password,
//! token, private key, or authorization value into a config, log, event, or
//! artifact — the host rejects payloads whose keys look like credentials.

use serde::{Deserialize, Serialize};

use crate::{PluginEmitter, PluginError};

pub const TASK_VALIDATE_METHOD: &str = "task/validate";
pub const TASK_EXECUTE_METHOD: &str = "task/execute";
pub const TASK_START_METHOD: &str = "task/start";
pub const TASK_STOP_METHOD: &str = "task/stop";
pub const TASK_STATUS_METHOD: &str = "task/status";

pub const TASK_LOG_EVENT: &str = "task/log";
pub const TASK_PROGRESS_EVENT: &str = "task/progress";
pub const TASK_STATE_EVENT: &str = "task/state";
pub const TASK_ARTIFACT_EVENT: &str = "task/artifact";

/// The `task` object of `task/validate`:
/// `{ providerId, triggerId, connectionId, configVersion, config }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidateTask {
    pub provider_id: String,
    pub trigger_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// Host-owned config schema version; validate against it or migrate.
    pub config_version: u32,
    /// The config gathered from the trigger's declared form fields. It must
    /// not contain credentials — bind them to a connection instead.
    pub config: serde_json::Value,
}

/// `task/validate` request: `{ task, connection, runtime }` (ADR §6.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidateRequest {
    pub task: TaskValidateTask,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<serde_json::Value>,
}

/// `task/validate` response: `{ valid, errors, warnings, fieldValues, options }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidateResult {
    #[serde(default = "yes")]
    pub valid: bool,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Field updates the plugin proposes (dynamic defaults, normalized paths).
    #[serde(default)]
    pub field_values: Vec<(String, serde_json::Value)>,
    /// Dynamic completion for choice fields, keyed by field key.
    #[serde(default)]
    pub options: Vec<(String, Vec<TaskFieldOption>)>,
}

/// One dynamic option of a choice field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFieldOption {
    pub value: String,
    pub label: String,
}

fn yes() -> bool {
    true
}

/// The `task` object of `task/execute` and `task/start`:
/// `{ taskId, runId, triggerId, connectionId, configVersion, config }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunTask {
    pub task_id: String,
    pub run_id: String,
    pub trigger_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub config_version: u32,
    pub config: serde_json::Value,
}

/// The `run` object of `task/execute` and `task/start`.
/// `attempt` is 1-based (retry counter of the execution policy).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunRef {
    pub run_id: String,
    pub attempt: u64,
}

/// `task/execute` / `task/start` request: `{ task, run, connection, runtime }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunRequest {
    pub task: TaskRunTask,
    pub run: TaskRunRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<serde_json::Value>,
}

/// One output file of a run: metadata + URI only, never the file body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    pub name: String,
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// `task/execute` response: `{ success, exitCode, message, artifacts }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecuteResult {
    #[serde(default = "yes")]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<TaskArtifact>,
}

/// Resident session states (ADR §2.7): `running` means the latest heartbeat
/// was answered; `degraded` means the host stopped restarting the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskSessionState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    Degraded,
}

/// `task/start` response: `{ sessionId, state }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStartResult {
    pub session_id: String,
    pub state: TaskSessionState,
}

/// `task/stop` request: `{ taskId, runId, sessionId, reason }` — `runId`
/// cancels a run-mode execution, `sessionId` a resident session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStopRequest {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `task/stop` response: the frozen shape is the empty object `{}`; failures
/// are JSON-RPC errors, not a `success: false` body.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TaskStopResult {}

/// `task/status` request: `{ taskId, runId, sessionId }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusRequest {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `task/status` response: `{ state, heartbeatAt, restartCount }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusResult {
    pub state: TaskSessionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
    #[serde(default)]
    pub restart_count: u64,
}

/// Where one `task/log` line came from. `system` lines are written by the host
/// itself; a plugin only ever emits `stdout` or `stderr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// `task/log` event payload: `{ taskId, runId, seq, stream, level, message,
/// timestamp? }`. `seq` must increase monotonically per run (start at 1) so
/// the host can persist an ordered stream and the UI can tail it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogEvent {
    pub task_id: String,
    pub run_id: String,
    pub seq: u64,
    pub stream: TaskStream,
    pub level: TaskLogLevel,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

/// `task/progress` event payload: `{ taskId, runId, percent, current?,
/// completed?, total? }`. `percent` must be a finite value in 0..=100.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    pub task_id: String,
    pub run_id: String,
    pub percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// `task/state` event payload: `{ taskId, runId, state }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStateEvent {
    pub task_id: String,
    pub run_id: String,
    pub state: TaskSessionState,
}

/// `task/artifact` event payload: `{ taskId, runId, artifact }`. The host
/// persists metadata + URI only — never stream file bodies through events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactEvent {
    pub task_id: String,
    pub run_id: String,
    pub artifact: TaskArtifact,
}

impl PluginEmitter {
    /// Emits one fixed task event. The four task event names are the only task
    /// events the scheduler decodes; anything else is ignored by the host.
    pub fn task_event(&self, event: &TaskEvent) -> Result<(), PluginError> {
        let (method, params) = match event {
            TaskEvent::Log(event) => (TASK_LOG_EVENT, serde_json::to_value(event)),
            TaskEvent::Progress(event) => (TASK_PROGRESS_EVENT, serde_json::to_value(event)),
            TaskEvent::State(event) => (TASK_STATE_EVENT, serde_json::to_value(event)),
            TaskEvent::Artifact(event) => (TASK_ARTIFACT_EVENT, serde_json::to_value(event)),
        };
        let params = params.map_err(|error| PluginError::new(-32603, error.to_string()))?;
        self.event(method, params)
    }
}

/// One of the four fixed task events, tagged for `PluginEmitter::task_event`.
#[derive(Debug, Clone)]
pub enum TaskEvent {
    Log(TaskLogEvent),
    Progress(TaskProgressEvent),
    State(TaskStateEvent),
    Artifact(TaskArtifactEvent),
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::PluginTransport;

    /// Output sink that records every frame the plugin writes.
    #[derive(Clone, Default)]
    struct RecordingOutput(Arc<Mutex<Vec<u8>>>);

    impl RecordingOutput {
        fn frames(&self) -> Vec<serde_json::Value> {
            let bytes = self.0.lock().unwrap().clone();
            String::from_utf8(bytes)
                .unwrap()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    impl Write for RecordingOutput {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn recording_emitter() -> (PluginEmitter, RecordingOutput) {
        let output = RecordingOutput::default();
        let emitter = PluginEmitter {
            output: Arc::new(Mutex::new(Box::new(output.clone()))),
            transport: PluginTransport::JsonLines,
        };
        (emitter, output)
    }

    #[test]
    fn fixed_methods_and_events_are_the_frozen_set() {
        assert_eq!(TASK_VALIDATE_METHOD, "task/validate");
        assert_eq!(TASK_EXECUTE_METHOD, "task/execute");
        assert_eq!(TASK_START_METHOD, "task/start");
        assert_eq!(TASK_STOP_METHOD, "task/stop");
        assert_eq!(TASK_STATUS_METHOD, "task/status");
        assert_eq!(TASK_LOG_EVENT, "task/log");
        assert_eq!(TASK_PROGRESS_EVENT, "task/progress");
        assert_eq!(TASK_STATE_EVENT, "task/state");
        assert_eq!(TASK_ARTIFACT_EVENT, "task/artifact");
    }

    #[test]
    fn payloads_round_trip_in_the_frozen_camel_case_shape() {
        let request = TaskRunRequest {
            task: TaskRunTask {
                task_id: "task-1".into(),
                run_id: "run-1".into(),
                trigger_id: "io.dbx.ssh.tasks/execute".into(),
                connection_id: Some("conn-1".into()),
                config_version: 1,
                config: json!({ "command": "echo hi" }),
            },
            run: TaskRunRef { run_id: "run-1".into(), attempt: 2 },
            connection: None,
            runtime: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["task"]["taskId"], "task-1");
        assert_eq!(value["task"]["configVersion"], 1);
        assert_eq!(value["run"]["attempt"], 2);
        assert!(value.get("connection").is_none(), "absent optional members stay absent");
        let round: TaskRunRequest = serde_json::from_value(value).unwrap();
        assert_eq!(round.run.attempt, 2);

        let start = serde_json::to_value(TaskStartResult { session_id: "s1".into(), state: TaskSessionState::Running })
            .unwrap();
        assert_eq!(start, json!({ "sessionId": "s1", "state": "running" }));

        let status = serde_json::to_value(TaskStatusResult {
            state: TaskSessionState::Degraded,
            heartbeat_at: Some("2026-10-05T00:00:00Z".into()),
            restart_count: 3,
        })
        .unwrap();
        assert_eq!(status["state"], "degraded");
        assert_eq!(status["restartCount"], 3);

        let stop = serde_json::to_value(TaskStopRequest {
            task_id: "task-1".into(),
            run_id: Some("run-1".into()),
            session_id: None,
            reason: Some("user cancel".into()),
        })
        .unwrap();
        assert_eq!(stop["runId"], "run-1");
        assert!(stop.get("sessionId").is_none());
        assert_eq!(serde_json::to_value(TaskStopResult {}).unwrap(), json!({}));
    }

    #[test]
    fn task_events_serialize_with_their_fixed_method_names() {
        let (emitter, output) = recording_emitter();
        emitter
            .task_event(&TaskEvent::Log(TaskLogEvent {
                task_id: "t".into(),
                run_id: "r".into(),
                seq: 1,
                stream: TaskStream::Stdout,
                level: TaskLogLevel::Info,
                message: "started".into(),
                timestamp: None,
            }))
            .unwrap();
        emitter
            .task_event(&TaskEvent::Progress(TaskProgressEvent {
                task_id: "t".into(),
                run_id: "r".into(),
                percent: 50.0,
                current: Some("table_a".into()),
                completed: Some(1),
                total: Some(2),
            }))
            .unwrap();
        emitter
            .task_event(&TaskEvent::State(TaskStateEvent {
                task_id: "t".into(),
                run_id: "r".into(),
                state: TaskSessionState::Starting,
            }))
            .unwrap();
        emitter
            .task_event(&TaskEvent::Artifact(TaskArtifactEvent {
                task_id: "t".into(),
                run_id: "r".into(),
                artifact: TaskArtifact {
                    name: "dump.sql.gz".into(),
                    uri: "files:/backups/dump.sql.gz".into(),
                    size: Some(1024),
                },
            }))
            .unwrap();

        let frames = output.frames();
        let methods: Vec<&str> = frames.iter().map(|frame| frame["method"].as_str().unwrap()).collect();
        assert_eq!(methods, vec!["task/log", "task/progress", "task/state", "task/artifact"]);
        let log = &frames[0]["params"];
        assert_eq!(log["taskId"], "t");
        assert_eq!(log["runId"], "r");
        assert_eq!(log["seq"], 1);
        assert_eq!(log["stream"], "stdout");
        assert_eq!(log["level"], "info");
        assert_eq!(log["message"], "started");
    }
}
