package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func plDebugNativeDriveFixture(t *testing.T, scenario string) (*runtimeServer, *plDebugBreakpointTestConnector, *plDebugManagerTestEngine, map[string]interface{}) {
	t.Helper()
	source := "BEGIN\n NULL;\nEND;"
	block, err := plDebugWrapNativeTarget(source, 0)
	if err != nil {
		t.Fatal(err)
	}
	integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
	private := plDebugNativeStop{Result: integer(0), Line: integer(1), Terminated: integer(0), Reason: integer(9), StackDepth: integer(1), Namespace: integer(0)}
	initial := private
	initial.Line = sql.NullInt64{}
	initial.Reason = integer(2)
	user := private
	user.Line = integer(int64(block.SourceLineOffset + 1))
	stops := []plDebugNativeStop{initial, private, user}
	switch scenario {
	case "breakpoint":
		private.Reason = integer(plDebugReasonBreakpoint)
		private.Breakpoint = integer(77)
		stops = []plDebugNativeStop{private}
	case "exception":
		private.Reason = integer(plDebugReasonException)
		stops = []plDebugNativeStop{private}
	case "unresolved":
		private.Line = sql.NullInt64{}
		stops = []plDebugNativeStop{initial, private}
	case "limit":
		stops = nil
		for i := 0; i <= plDebugStartStepInLimit+block.SourceLineOffset; i++ {
			stops = append(stops, private)
		}
	case "ended":
		end := private
		end.Line = sql.NullInt64{}
		end.Terminated = integer(1)
		stops = []plDebugNativeStop{initial, end}
	case "close":
		stops = []plDebugNativeStop{private}
	}
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
	first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, complete: 1, stops: stops}
	first.payloadFor = func(_ context.Context, sourceRead bool) (string, error) {
		if sourceRead {
			e.mu.Lock()
			sqlText := e.targetBlock
			e.mu.Unlock()
			lines := []plDebugNativeFrameSourceLine{}
			for i, text := range strings.Split(sqlText, "\n") {
				value := text
				lines = append(lines, plDebugNativeFrameSourceLine{Line: int64(i + 1), Text: &value})
			}
			payload, err := json.Marshal(lines)
			return string(payload), err
		}
		stop := first.stops[first.stopIndex-1]
		record := plDebugNativeStackRecord{NativeFrameID: 1, Namespace: &stop.Namespace.Int64, Anonymous: scenario != "unresolved"}
		if stop.Line.Valid {
			record.Line = &stop.Line.Int64
		}
		payload, err := json.Marshal([]plDebugNativeStackRecord{record})
		return string(payload), err
	}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	return r, first, e, map[string]interface{}{"agentSessionId": "a", "operationId": "drive-1", "objectType": "ANONYMOUS", "source": source}
}

func TestPLDebugNativeStartDrivesOnlyVerifiedWrapperWithinOriginalBudget(t *testing.T) {
	for _, scenario := range []string{"reached", "breakpoint", "exception", "unresolved", "limit", "ended"} {
		t.Run(scenario, func(t *testing.T) {
			r, first, e, request := plDebugNativeDriveFixture(t, scenario)
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			want := "reached"
			steps := 2
			switch scenario {
			case "breakpoint", "exception":
				want = "wrapper"
				steps = 0
			case "unresolved":
				want = "unresolved"
				steps = 1
			case "limit":
				want = "unresolved"
				steps = len(first.stops) - 1
			case "ended":
				want = "ended_before_entry"
				steps = 1
			}
			if state["startState"] != "succeeded" || state["entryState"] != want || e.controls != steps || state["stopRevision"] != int64(steps+1) || first.sets != 0 || first.deletes != 0 || e.targetAttempts != 1 {
				t.Fatalf("state=%#v controls=%d SET=%d DELETE=%d", state, e.controls, first.sets, first.deletes)
			}
			if scenario == "reached" && (state["sourceMappingState"] != "verified" || *state["line"].(*int64) != 1) {
				t.Fatal("start did not stop at the frozen user source entry")
			}
			if scenario == "limit" && !strings.Contains(state["entryError"].(string), "step limit") {
				t.Fatal("entry limit was hidden")
			}
			reads := first.executions
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if e.controls != steps || first.executions != reads {
				t.Fatal("same operation replayed entry drive or source reads")
			}
			r.mu.RLock()
			entry := r.plNativeEntries["drive-1"]
			r.mu.RUnlock()
			if scenario == "ended" {
				select {
				case <-entry.captureDone:
				case <-time.After(time.Second):
					t.Fatal("terminated native stop lost target completion")
				}
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 {
				t.Fatal("entry drive replayed business or lost original cleanup")
			}
		})
	}
}

func TestPLDebugNativeStartCloseDuringEntryProofDoesNotAdvanceAgain(t *testing.T) {
	r, first, e, request := plDebugNativeDriveFixture(t, "close")
	read := first.payloadFor
	started := make(chan struct{})
	first.payloadFor = func(ctx context.Context, source bool) (string, error) {
		if source {
			close(started)
			<-ctx.Done()
			return "", ctx.Err()
		}
		return read(ctx, source)
	}
	done := make(chan response, 1)
	go func() { done <- plDebugManagerRPC(t, r, "pl_debug_start", request) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("start did not reach original source proof")
	}
	r.mu.RLock()
	entry := r.plNativeEntries["drive-1"]
	r.mu.RUnlock()
	entry.mu.Lock()
	entry.cleanupDeadline = time.Now().Add(100 * time.Millisecond)
	entry.mu.Unlock()
	closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
	if closed["releaseState"] != "unknown" || e.controls != 0 || first.sets != 0 || first.deletes != 0 {
		t.Fatal("closed entry proof advanced or pretended to release canceled thin resources")
	}
	select {
	case resp := <-done:
		if resp.Error != nil {
			t.Fatal(resp.Error)
		}
	case <-time.After(time.Second):
		t.Fatal("start receipt did not return")
	}
	select {
	case <-entry.startOwnerDone:
	case <-time.After(time.Second):
		t.Fatal("original start owner did not finish")
	}
	entry.mu.Lock()
	pending := len(entry.nativeReadPending)
	entry.mu.Unlock()
	if pending != 1 || e.targetAttempts != 1 || first.base.tx.base.closes != 0 {
		t.Fatal("in-flight source references or original target owner were lost")
	}
}

func TestPLDebugNativeStartEntersNamedMemberButHandsBackPackageInitialization(t *testing.T) {
	for _, initializing := range []bool{false, true} {
		t.Run(map[bool]string{false: "member", true: "initialization"}[initializing], func(t *testing.T) {
			metadata := plDebugTargetFixture()
			pkg, member := " Pkg.\"\n ", " f.x "
			code := "PACKAGE BODY " + quoteIdentifier(pkg) + " AS\n FUNCTION " + quoteIdentifier(member) + "(X NUMBER,Y OUT NUMBER) RETURN NUMBER IS\n BEGIN\n Y := X; -- member\n RETURN X;\n END " + quoteIdentifier(member) + ";\nBEGIN\n NULL; -- initialization\nEND " + quoteIdentifier(pkg) + ";"
			line := int64(0)
			marker := "-- member"
			if initializing {
				marker = "-- initialization"
			}
			metadata.sourceRows = nil
			for i, text := range strings.Split(code, "\n") {
				metadata.sourceRows = append(metadata.sourceRows, []driver.Value{"body-id", "VALID", "2026-10-23 01:02:03", int64(i + 1), text + "\n"})
				if strings.Contains(text, marker) {
					line = int64(i + 1)
				}
			}
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			initial := plDebugNativeStop{Result: integer(0), Terminated: integer(0), Reason: integer(2), StackDepth: integer(1), Namespace: integer(0)}
			wrapper := initial
			wrapper.Reason = integer(9)
			wrapper.Line = integer(1)
			current := wrapper
			current.Namespace = integer(2)
			current.StackDepth = integer(2)
			current.Line = integer(line)
			current.Program = sql.NullString{String: pkg, Valid: true}
			current.Owner = sql.NullString{String: metadata.owner, Valid: true}
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			native := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, complete: 1, stops: []plDebugNativeStop{initial, wrapper, current}}
			native.payloadFor = func(_ context.Context, source bool) (string, error) {
				if source {
					e.mu.Lock()
					sqlText := e.targetBlock
					e.mu.Unlock()
					lines := []plDebugNativeFrameSourceLine{}
					for i, text := range strings.Split(sqlText, "\n") {
						value := text
						lines = append(lines, plDebugNativeFrameSourceLine{Line: int64(i + 1), Text: &value})
					}
					payload, err := json.Marshal(lines)
					return string(payload), err
				}
				cursor := int64(0)
				records := []plDebugNativeStackRecord{{NativeFrameID: 1, Namespace: &cursor, Anonymous: true}}
				if native.stopIndex < 3 {
					one := int64(1)
					records[0].Line = &one
				} else {
					two := int64(2)
					owner := metadata.owner
					records = append(records, plDebugNativeStackRecord{NativeFrameID: 2, Namespace: &two, Program: &pkg, Owner: &owner, Line: &line, NamespaceKind: "package_body"})
				}
				payload, err := json.Marshal(records)
				return string(payload), err
			}
			first := &plDebugNamedSourceTestConnector{native: native, metadata: metadata}
			out, returned := "42", "82"
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}, phase: 2, fields: []*string{&out, &returned}, copied: []int64{1, 1}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			request := plDebugNamedRequest("NUMBER", "3")
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			want := "reached"
			if initializing {
				want = "package_initialization"
			}
			if state["startState"] != "succeeded" || state["entryState"] != want || state["program"] != pkg || state["sourceMappingState"] != "verified" || e.controls != 2 || e.targetAttempts != 1 || native.sets != 0 || native.deletes != 0 {
				t.Fatalf("named entry did not preserve its actual stop: %#v", state)
			}
			r.mu.RLock()
			entry := r.plNativeEntries["named-1"]
			r.mu.RUnlock()
			lines := strings.Split(e.targetBlock, "\n")
			last := entry.block.CallLastLine
			if last <= entry.block.CallLine || !strings.HasSuffix(strings.TrimSpace(lines[last-1]), ");") || !strings.Contains(lines[last], "PHASE := 2;") {
				t.Fatal("multiline named invocation bound does not end before returned phase")
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if e.controls != 2 {
				t.Fatal("same named start replayed entry steps")
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 {
				t.Fatal("named entry lost original cleanup")
			}
		})
	}
}
