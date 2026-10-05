package dbxpluginsdk

// The fixed plugin task contract (ADR scheduler-task-contract.md §6): exactly
// five task/* request methods and exactly four task/* events. Plugins cannot
// invent task/<custom> methods — the host rejects anything outside this frozen
// set, so the SDK only names the frozen shapes here.
//
// Secrets never travel through this contract: task configs carry a
// connectionId binding and the host hydrates credentials into the connection
// lifecycle payload at execution time. Never put a password, token, private
// key, or authorization value into a config, log, event, or artifact — the
// host rejects payloads whose keys look like credentials.

const (
	TaskValidateMethod = "task/validate"
	TaskExecuteMethod  = "task/execute"
	TaskStartMethod    = "task/start"
	TaskStopMethod     = "task/stop"
	TaskStatusMethod   = "task/status"

	TaskLogEventMethod      = "task/log"
	TaskProgressEventMethod = "task/progress"
	TaskStateEventMethod    = "task/state"
	TaskArtifactEventMethod = "task/artifact"
)

// TaskValidateTask is the task object of task/validate:
// { providerId, triggerId, connectionId, configVersion, config }.
type TaskValidateTask struct {
	ProviderID    string `json:"providerId"`
	TriggerID     string `json:"triggerId"`
	ConnectionID  string `json:"connectionId,omitempty"`
	ConfigVersion uint32 `json:"configVersion"`
	Config        any    `json:"config"`
}

// TaskValidateRequest is the task/validate request: { task, connection, runtime }.
type TaskValidateRequest struct {
	Task       TaskValidateTask `json:"task"`
	Connection any              `json:"connection,omitempty"`
	Runtime    any              `json:"runtime,omitempty"`
}

// TaskValidateResult is the task/validate response:
// { valid, errors, warnings, fieldValues, options }.
type TaskValidateResult struct {
	Valid       bool                         `json:"valid"`
	Errors      []string                     `json:"errors"`
	Warnings    []string                     `json:"warnings"`
	FieldValues map[string]any               `json:"fieldValues,omitempty"`
	Options     map[string][]TaskFieldOption `json:"options,omitempty"`
}

// TaskFieldOption is one dynamic option of a choice field.
type TaskFieldOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// TaskRunTask is the task object of task/execute and task/start:
// { taskId, runId, triggerId, connectionId, configVersion, config }.
type TaskRunTask struct {
	TaskID        string `json:"taskId"`
	RunID         string `json:"runId"`
	TriggerID     string `json:"triggerId"`
	ConnectionID  string `json:"connectionId,omitempty"`
	ConfigVersion uint32 `json:"configVersion"`
	Config        any    `json:"config"`
}

// TaskRunRef identifies one execution attempt; Attempt is 1-based.
type TaskRunRef struct {
	RunID   string `json:"runId"`
	Attempt uint64 `json:"attempt"`
}

// TaskRunRequest is the task/execute and task/start request:
// { task, run, connection, runtime }.
type TaskRunRequest struct {
	Task       TaskRunTask `json:"task"`
	Run        TaskRunRef  `json:"run"`
	Connection any         `json:"connection,omitempty"`
	Runtime    any         `json:"runtime,omitempty"`
}

// TaskArtifact is one output file of a run: metadata + URI only, never the
// file body.
type TaskArtifact struct {
	Name string `json:"name"`
	URI  string `json:"uri"`
	Size uint64 `json:"size,omitempty"`
}

// TaskExecuteResult is the task/execute response:
// { success, exitCode, message, artifacts }.
type TaskExecuteResult struct {
	Success   bool           `json:"success"`
	ExitCode  *int           `json:"exitCode,omitempty"`
	Message   string         `json:"message,omitempty"`
	Artifacts []TaskArtifact `json:"artifacts"`
}

// TaskSessionState is a resident session state (ADR §2.7): running means the
// latest heartbeat was answered; degraded means the host stopped restarting.
type TaskSessionState string

const (
	TaskSessionStopped  TaskSessionState = "stopped"
	TaskSessionStarting TaskSessionState = "starting"
	TaskSessionRunning  TaskSessionState = "running"
	TaskSessionStopping TaskSessionState = "stopping"
	TaskSessionCrashed  TaskSessionState = "crashed"
	TaskSessionDegraded TaskSessionState = "degraded"
)

// TaskStartResult is the task/start response: { sessionId, state }.
type TaskStartResult struct {
	SessionID string           `json:"sessionId"`
	State     TaskSessionState `json:"state"`
}

// TaskStopRequest is the task/stop request: { taskId, runId, sessionId,
// reason } — RunID cancels a run-mode execution, SessionID a resident session.
type TaskStopRequest struct {
	TaskID    string `json:"taskId"`
	RunID     string `json:"runId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// TaskStopResult is the task/stop response: the frozen shape is the empty
// object {}; failures are JSON-RPC errors, not a success:false body.
type TaskStopResult struct{}

// TaskStatusRequest is the task/status request: { taskId, runId, sessionId }.
type TaskStatusRequest struct {
	TaskID    string `json:"taskId"`
	RunID     string `json:"runId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
}

// TaskStatusResult is the task/status response: { state, heartbeatAt,
// restartCount }.
type TaskStatusResult struct {
	State        TaskSessionState `json:"state"`
	HeartbeatAt  string           `json:"heartbeatAt,omitempty"`
	RestartCount uint64           `json:"restartCount"`
}

// TaskStream is where one task/log line came from. system lines are written
// by the host itself; a plugin only ever emits stdout or stderr.
type TaskStream string

const (
	TaskStreamStdout TaskStream = "stdout"
	TaskStreamStderr TaskStream = "stderr"
)

// TaskLogLevel classifies one task/log line.
type TaskLogLevel string

const (
	TaskLogLevelDebug TaskLogLevel = "debug"
	TaskLogLevelInfo  TaskLogLevel = "info"
	TaskLogLevelWarn  TaskLogLevel = "warn"
	TaskLogLevelError TaskLogLevel = "error"
)

// TaskLogEvent is the task/log event payload: { taskId, runId, seq, stream,
// level, message, timestamp? }. Seq must increase monotonically per run
// (start at 1) so the host can persist an ordered stream and the UI can tail
// it.
type TaskLogEvent struct {
	TaskID    string       `json:"taskId"`
	RunID     string       `json:"runId"`
	Seq       uint64       `json:"seq"`
	Stream    TaskStream   `json:"stream"`
	Level     TaskLogLevel `json:"level"`
	Message   string       `json:"message"`
	Timestamp string       `json:"timestamp,omitempty"`
}

// TaskProgressEvent is the task/progress event payload: { taskId, runId,
// percent, current?, completed?, total? }. Percent must be in 0..=100.
type TaskProgressEvent struct {
	TaskID    string  `json:"taskId"`
	RunID     string  `json:"runId"`
	Percent   float64 `json:"percent"`
	Current   string  `json:"current,omitempty"`
	Completed uint64  `json:"completed,omitempty"`
	Total     uint64  `json:"total,omitempty"`
}

// TaskStateEvent is the task/state event payload: { taskId, runId, state }.
type TaskStateEvent struct {
	TaskID string           `json:"taskId"`
	RunID  string           `json:"runId"`
	State  TaskSessionState `json:"state"`
}

// TaskArtifactEvent is the task/artifact event payload: { taskId, runId,
// artifact }. The host persists metadata + URI only — never stream file
// bodies through events.
type TaskArtifactEvent struct {
	TaskID   string       `json:"taskId"`
	RunID    string       `json:"runId"`
	Artifact TaskArtifact `json:"artifact"`
}

// TaskLog emits one task/log event.
func (emitter *Emitter) TaskLog(event TaskLogEvent) *PluginError {
	return emitter.Event(TaskLogEventMethod, event)
}

// TaskProgress emits one task/progress event.
func (emitter *Emitter) TaskProgress(event TaskProgressEvent) *PluginError {
	return emitter.Event(TaskProgressEventMethod, event)
}

// TaskState emits one task/state event.
func (emitter *Emitter) TaskState(event TaskStateEvent) *PluginError {
	return emitter.Event(TaskStateEventMethod, event)
}

// TaskArtifact emits one task/artifact event.
func (emitter *Emitter) TaskArtifact(event TaskArtifactEvent) *PluginError {
	return emitter.Event(TaskArtifactEventMethod, event)
}
