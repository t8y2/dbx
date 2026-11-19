package main

import (
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"strings"
	"testing"
)

func TestPLDebugNativeCurrentBreakpointProofMapsOnlySameRevisionExactSource(t *testing.T) {
	for _, scenario := range []string{"verified", "runtime_identity", "missing_namespace", "known_rejection", "source_changed"} {
		t.Run(scenario, func(t *testing.T) {
			metadata := plDebugTargetFixture()
			pkg, member := " Pkg.\"\n ", " f.x "
			code := "PACKAGE BODY " + quoteIdentifier(pkg) + " AS\n FUNCTION " + quoteIdentifier(member) + "(X NUMBER,Y OUT NUMBER) RETURN NUMBER IS\n BEGIN\n Y := X; -- selected\n RETURN X;\n END " + quoteIdentifier(member) + ";\nEND " + quoteIdentifier(pkg) + ";"
			metadata.sourceRows = nil
			line := int64(0)
			for i, text := range strings.Split(code, "\n") {
				metadata.sourceRows = append(metadata.sourceRows, []driver.Value{"body-id", "VALID", "2026-10-23 01:02:03", int64(i + 1), text + "\n"})
				if strings.Contains(text, "-- selected") {
					line = int64(i + 1)
				}
			}
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			stop := plDebugNativeStop{Result: integer(0), Line: integer(line), Terminated: integer(0), Reason: integer(9), StackDepth: integer(1), Namespace: integer(2)}
			runtimeIdentity := scenario == "runtime_identity"
			if runtimeIdentity {
				stop.Program = sql.NullString{String: pkg, Valid: true}
				stop.Owner = sql.NullString{String: metadata.owner, Valid: true}
			}
			if scenario == "missing_namespace" {
				stop.Namespace = sql.NullInt64{}
			}
			owner, status := metadata.owner, int64(1)
			payload, _ := json.Marshal([]plDebugNativeBreakpoint{{ID: 77, Name: &pkg, Owner: &owner, Line: &line, Status: &status, LocalActive: true}})
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			native := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, complete: 1, stops: []plDebugNativeStop{stop, stop}, payloads: []string{"[]", "[]", string(payload), "[]", "[]", "[]", string(payload)}}
			if scenario == "known_rejection" {
				native.setCode, native.setRejected = plDebugErrBadHandle, 1
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
			proved := scenario != "missing_namespace" && scenario != "known_rejection"
			wantName, wantOwner, evidence := "", "", "current_breakpoint"
			sets, deletes, reads := 1, 1, 3
			if runtimeIdentity {
				wantName, wantOwner, evidence = pkg, owner, "runtime"
				sets, deletes, reads = 0, 0, 1
			}
			if scenario == "known_rejection" {
				deletes, reads = 0, 2
				if state["state"] != "paused" || state["currentProgramProbe"].(plDebugNativeProgramProbe).Uncertain {
					t.Fatal("definite rejection invalidated the original paused session")
				}
			}
			if state["program"] != wantName || state["programOwner"] != wantOwner || native.sets != sets || native.deletes != deletes || (state["sourceRef"] != nil) != proved {
				t.Fatalf("native NULL identity was overwritten or untyped proof authorized source: %#v", state)
			}
			if proved {
				ref := state["sourceRef"].(*plDebugNativeSourceRef)
				if ref.EvidenceKind != evidence || *ref.Owner != owner || *ref.Name != pkg || state["entryState"] != "reached" || state["entryError"] != "" || state["stackComplete"] != false {
					t.Fatal("current native location was confused with a complete backtrace")
				}
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if native.sets != sets || native.executions != reads {
				t.Fatal("cached start replayed native proof")
			}
			if scenario == "source_changed" {
				for _, row := range metadata.sourceRows {
					metadata.sourceNext = append(metadata.sourceNext, append([]driver.Value{}, row...))
				}
				metadata.sourceNext[3][4] = "different code with unchanged signature\n"
			}
			refreshed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "named-1"}))
			if native.sets != sets || native.deletes != deletes || native.executions != reads+1 || refreshed["structuredBacktraceError"] == "" {
				t.Fatal("same-stop proof was replayed or partial stack failure hidden")
			}
			if scenario == "source_changed" {
				if refreshed["sourceRef"] != nil || refreshed["sourceError"] == "" || refreshed["entryState"] != "unresolved" {
					t.Fatal("old breakpoint proof bypassed source version validation")
				}
			} else {
				plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_step_in", map[string]interface{}{"debugId": "named-1"}))
				next := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "named-1"}))
				if native.sets != sets*2 || native.deletes != deletes*2 || next["stopRevision"] != int64(2) || (next["sourceRef"] != nil) != proved {
					t.Fatal("new stop reused an old breakpoint identity or lost its new cleanup")
				}
				if proved && next["sourceRef"].(*plDebugNativeSourceRef).StopRevision != 2 {
					t.Fatal("source reference kept the old stop revision")
				}
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 {
				t.Fatal("breakpoint identity resolution replayed business or lost original cleanup")
			}
		})
	}
}
