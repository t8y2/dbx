package dbxpluginsdk

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

func TestEmitterWritesFixedTaskEvents(t *testing.T) {
	var output bytes.Buffer
	emitter := &Emitter{writer: &output, mutex: &sync.Mutex{}, transport: TransportJSONLines}

	if err := emitter.TaskLog(TaskLogEvent{
		TaskID: "task-1", RunID: "run-1", Seq: 1,
		Stream: TaskStreamStdout, Level: TaskLogLevelInfo, Message: "started",
	}); err != nil {
		t.Fatalf("TaskLog returned an error: %v", err)
	}
	if err := emitter.TaskProgress(TaskProgressEvent{
		TaskID: "task-1", RunID: "run-1", Percent: 50, Current: "table_a", Completed: 1, Total: 2,
	}); err != nil {
		t.Fatalf("TaskProgress returned an error: %v", err)
	}
	if err := emitter.TaskState(TaskStateEvent{TaskID: "task-1", RunID: "run-1", State: TaskSessionStarting}); err != nil {
		t.Fatalf("TaskState returned an error: %v", err)
	}
	if err := emitter.TaskArtifact(TaskArtifactEvent{
		TaskID: "task-1", RunID: "run-1",
		Artifact: TaskArtifact{Name: "dump.sql.gz", URI: "files:/backups/dump.sql.gz", Size: 1024},
	}); err != nil {
		t.Fatalf("TaskArtifact returned an error: %v", err)
	}

	var methods []string
	var log map[string]any
	for _, line := range bytes.Split(output.Bytes(), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal(line, &frame); err != nil {
			t.Fatalf("event frame is not valid JSON: %v", err)
		}
		methods = append(methods, frame["method"].(string))
		if frame["method"] == TaskLogEventMethod {
			log = frame["params"].(map[string]any)
		}
	}
	want := []string{"task/log", "task/progress", "task/state", "task/artifact"}
	if len(methods) != len(want) {
		t.Fatalf("emitted events %v, want %v", methods, want)
	}
	for index, method := range want {
		if methods[index] != method {
			t.Fatalf("emitted event %d = %q, want %q", index, methods[index], method)
		}
	}
	if log["taskId"] != "task-1" || log["runId"] != "run-1" || log["seq"] != float64(1) ||
		log["stream"] != "stdout" || log["level"] != "info" || log["message"] != "started" {
		t.Fatalf("task/log payload does not match the frozen shape: %v", log)
	}
}

func TestTaskPayloadsRoundTripInCamelCase(t *testing.T) {
	exitCode := 0
	result, err := json.Marshal(TaskExecuteResult{
		Success: true, ExitCode: &exitCode, Message: "done",
		Artifacts: []TaskArtifact{{Name: "dump.sql.gz", URI: "files:/backups/dump.sql.gz", Size: 1024}},
	})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(result, &payload); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if _, ok := payload["exitCode"]; !ok {
		t.Fatalf("exitCode key missing: %v", payload)
	}
	artifact := payload["artifacts"].([]any)[0].(map[string]any)
	if artifact["uri"] != "files:/backups/dump.sql.gz" || artifact["name"] != "dump.sql.gz" {
		t.Fatalf("artifact metadata missing: %v", payload)
	}

	stop, err := json.Marshal(TaskStopResult{})
	if err != nil || string(stop) != "{}" {
		t.Fatalf("task/stop result must be the empty object, got %s (%v)", stop, err)
	}
	if TaskSessionDegraded != "degraded" || TaskSessionRunning != "running" {
		t.Fatalf("session states must serialize to the frozen lowercase strings")
	}
}
