package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestPLDebugNativeStackRPCPreservesNativeFramesAndRuntimePosition(t *testing.T) {
	for _, scenario := range []string{"complete", "missing_identity", "sparse", "conflicting_leaf", "conflicting_entrypoint", "read_error", "invalid_indices"} {
		t.Run(scenario, func(t *testing.T) {
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			owner, name := " Exact.Owner ", " Leaf.\"\n[Line 999] "
			namespace, line := int64(1), int64(21)
			stop := plDebugNativeStop{Result: integer(0), Terminated: integer(0), StackDepth: integer(3), Line: integer(line), Reason: integer(9), Namespace: integer(namespace), Program: sql.NullString{String: name, Valid: true}, Owner: sql.NullString{String: owner, Valid: true}}
			records := []plDebugNativeStackRecord{}
			for i := int64(1); i <= 3; i++ {
				records = append(records, plDebugNativeStackRecord{NativeFrameID: i, Namespace: &namespace, Program: &name, Owner: &owner, Line: &line})
			}
			records[0].Line = nil
			switch scenario {
			case "missing_identity":
				records[1].Owner = nil
			case "sparse":
				records = append(records[:1], records[2:]...)
			case "conflicting_leaf":
				other := "different source"
				records[2].Program = &other
			case "conflicting_entrypoint":
				stop.Entrypoint = sql.NullString{String: "Original entrypoint", Valid: true}
				other := "different overload"
				records[2].Entrypoint = &other
			case "invalid_indices":
				records[1].NativeFrameID = 1
			}
			payload, err := json.Marshal(records)
			if err != nil {
				t.Fatal(err)
			}
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
			first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payload: string(payload), complete: 1, stops: []plDebugNativeStop{stop}}
			if scenario == "read_error" {
				first.executionError = errors.New("native structured backtrace unavailable")
			}
			second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "stack-1", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "stack-1"}))
			frames := state["frames"].([]plDebugNativeStackFrame)
			if state["frameMappingState"] != "verified" || state["complete"] != (scenario == "complete") || len(frames) != 3 || state["stopRevision"] != started["stopRevision"] || state["program"] != name {
				t.Fatalf("stack mapping or raw runtime changed: %#v", state)
			}
			for i, frame := range frames {
				if frame.FrameIndex != i || frame.NativeFrameID != int64(3-i) || frame.StackDepth != frame.NativeFrameID {
					t.Fatalf("renumbered native frame: %+v", frame)
				}
			}
			if *frames[0].Program != name || *frames[0].Owner != owner || *frames[0].SourceLine != line {
				t.Fatal("current raw runtime was lost")
			}
			if scenario == "complete" && (frames[2].SourceLine != nil || frames[2].NativeFrameID != 1) {
				t.Fatal("missing-line outer frame was discarded")
			}
			if (scenario == "sparse" || scenario == "conflicting_leaf" || scenario == "conflicting_entrypoint" || scenario == "read_error" || scenario == "invalid_indices") && frames[1].IdentityState != "unresolved" {
				t.Fatal("inconsistent collection authorized an outer program")
			}
			if scenario == "conflicting_leaf" && *state["nativeFrames"].([]plDebugNativeStackRecord)[2].Program != "different source" {
				t.Fatal("raw conflicting collection was overwritten")
			}
			if scenario == "conflicting_entrypoint" && (*frames[0].Entrypoint != "Original entrypoint" || *state["nativeFrames"].([]plDebugNativeStackRecord)[2].Entrypoint != "different overload") {
				t.Fatal("readonly native entrypoint conflict was hidden")
			}
			if first.executions != 1 || first.statementCloses != 1 {
				t.Fatal("stack read retained references or replayed")
			}
			ended := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "stack-1"}))
			if ended["frameMappingState"] != "unverified" {
				t.Fatal("old frame mapping survived execution")
			}
			if resp := plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "stack-1"}); resp.Error == nil || first.executions != 1 {
				t.Fatal("ended operation dispatched another stack read")
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "stack-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 {
				t.Fatal("stack inspection lost original target ownership")
			}
		})
	}
}

func TestPLDebugNativeStackCloseKeepsCanceledControllerReferencesOwned(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, readStarted: make(chan struct{}), readUntilCanceled: true}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "stack-close", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	done := make(chan response, 1)
	go func() {
		done <- plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "stack-close"})
	}()
	select {
	case <-first.readStarted:
	case <-time.After(time.Second):
		t.Fatal("stack did not reach original controller")
	}
	r.mu.RLock()
	entry := r.plNativeEntries["stack-close"]
	r.mu.RUnlock()
	entry.mu.Lock()
	entry.cleanupDeadline = time.Now().Add(100 * time.Millisecond)
	entry.mu.Unlock()
	closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "stack-close"}))
	if closed["releaseState"] != "unknown" || first.base.tx.base.closes != 0 || second.base.tx.base.closes != 0 {
		t.Fatal("canceled thin connection was physically released or reused")
	}
	select {
	case resp := <-done:
		state := plDebugManagerSnapshot(t, resp)
		if state["frameMappingState"] != "unverified" || state["complete"] != false {
			t.Fatal("canceled stack read retained a verified mapping")
		}
	case <-time.After(time.Second):
		t.Fatal("original stack action did not finish after cancellation")
	}
	entry.mu.Lock()
	pending := len(entry.nativeReadPending)
	entry.mu.Unlock()
	if pending != 1 || first.executions != 1 || first.sets != 0 || first.deletes != 0 {
		t.Fatalf("native inspection lost its reference owner or dispatched a recovery mutation: pending=%d executions=%d sets=%d deletes=%d", pending, first.executions, first.sets, first.deletes)
	}
	select {
	case <-entry.captureDone:
	case <-time.After(time.Second):
		t.Fatal("original target did not return after close cancellation")
	}
}

func TestPLDebugNativeReadCleanupKeepsReferencesPublishedDuringCleanup(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	first := &plDebugNativeCapture{ReferencesPending: true, references: &plDebugCaptureReferences{readAttempted: true, statementCloseAttempted: true, clob: &plDebugClobOutput{memory: true, release: func() error { close(started); <-release; return nil }}}}
	second := &plDebugNativeCapture{ReferencesPending: true}
	entry := &plDebugNativeEntry{server: &server{plAllocation: &plDebugAllocation{}}, nativeReadPending: []*plDebugNativeCapture{first}}
	done := make(chan error, 1)
	go func() { done <- entry.finishNativeReads(time.Now().Add(time.Second)) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("reference cleanup did not reach release barrier")
	}
	entry.mu.Lock()
	entry.nativeReadPending = append(entry.nativeReadPending, second)
	entry.mu.Unlock()
	close(release)
	select {
	case err := <-done:
		if err == nil {
			t.Error("cleanup claimed no pending references after another read published its owner")
		}
	case <-time.After(time.Second):
		t.Fatal("reference cleanup did not finish")
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if len(entry.nativeReadPending) != 1 || entry.nativeReadPending[0] != second {
		t.Fatal("cleanup discarded an inspection reference outside its original snapshot")
	}
}

func TestPLDebugNativeStackDoesNotDispatchAfterAuthoritativeLeaseDeadline(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
	first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payload: "[]", complete: 1}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "stack-expired", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	r.mu.RLock()
	entry := r.plNativeEntries["stack-expired"]
	r.mu.RUnlock()
	entry.mu.Lock()
	entry.leaseTimer.Stop()
	entry.leaseDeadline = time.Now().Add(-time.Second)
	entry.cleanupDeadline = time.Now().Add(100 * time.Millisecond)
	entry.mu.Unlock()
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "stack-expired"}))
	if state["frameMappingState"] != "unverified" || state["closeReason"] != "lease_expired" || first.prepares != 0 || first.executions != 0 {
		t.Fatal("delayed timer admitted a stack query after the authoritative deadline")
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "stack-expired"}))
	select {
	case <-entry.captureDone:
	case <-time.After(time.Second):
		t.Fatal("expired operation lost original cleanup")
	}
}

func TestPLDebugNativeStackRejectsReadAfterTargetReturnsWithoutControlReply(t *testing.T) {
	name, owner := "raw, run_info.reason = 25\nname", "Mixed Owner"
	namespace, line := int64(0), int64(21)
	payload, _ := json.Marshal([]plDebugNativeStackRecord{{NativeFrameID: 1, Namespace: &namespace, Program: &name, Owner: &owner, Line: &line}})
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payload: string(payload), complete: 1}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "stack-returned", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "stack-returned"}))
	r.mu.RLock()
	entry := r.plNativeEntries["stack-returned"]
	r.mu.RUnlock()
	e.release.Do(func() { close(e.targetRelease) })
	select {
	case <-entry.captureDone:
	case <-time.After(time.Second):
		t.Fatal("original target did not return")
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "stack-returned"}); resp.Error == nil || first.executions != 1 {
		t.Fatal("cached paused stop admitted a read after the target returned")
	}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "stack-returned"}))
	if state["frameMappingState"] != "unverified" || state["sourceRef"] != nil {
		t.Fatal("returned target retained active frame/source authority")
	}
	closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "stack-returned"}))
	if closed["releaseState"] != "released" || e.targetAttempts != 1 {
		t.Fatal("returned target was replayed or lost cleanup")
	}
}
