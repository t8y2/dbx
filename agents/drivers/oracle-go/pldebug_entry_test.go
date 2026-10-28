package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

func TestPLDebugNativeEntryCurrentProgramUsesCompleteInventoryAndKeepsRawStop(t *testing.T) {
	for _, scenario := range []string{"new", "existing", "existing_changed", "other_changed", "wrong_line", "remote", "incomplete_before", "known_rejection", "set_unknown", "delete_unknown", "initial_once"} {
		t.Run(scenario, func(t *testing.T) {
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			stop := plDebugNativeStop{Result: integer(0), Line: integer(21), Terminated: integer(0), Reason: integer(9), StackDepth: integer(1), Namespace: integer(1)}
			name, owner := " Pkg.\"\n ", " Exact.Owner "
			line, status := int64(21), int64(123)
			record := plDebugNativeBreakpoint{ID: 77, Name: &name, Owner: &owner, Line: &line, Status: &status, LocalActive: true}
			payload, _ := json.Marshal([]plDebugNativeBreakpoint{record})
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
			first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payload: "[]", afterPayload: string(payload), complete: 1, stops: []plDebugNativeStop{stop}}
			second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
			wantState, wantSets, wantDeletes := "native_location", 1, 1
			switch scenario {
			case "existing":
				first.payload = string(payload)
				wantDeletes = 0
			case "existing_changed":
				first.payload = string(payload)
				changed := record
				other := int64(22)
				changed.Line = &other
				encoded, _ := json.Marshal([]plDebugNativeBreakpoint{changed})
				first.afterPayload = string(encoded)
				wantState, wantDeletes = "unresolved", 0
			case "other_changed":
				other := record
				other.ID = 66
				encoded, _ := json.Marshal([]plDebugNativeBreakpoint{other})
				first.payload = string(encoded)
				changedLine := int64(22)
				other.Line = &changedLine
				encoded, _ = json.Marshal([]plDebugNativeBreakpoint{other, record})
				first.afterPayload = string(encoded)
				wantState = "unresolved"
			case "wrong_line":
				other := int64(22)
				record.Line = &other
				encoded, _ := json.Marshal([]plDebugNativeBreakpoint{record})
				first.afterPayload = string(encoded)
				wantState = "unresolved"
			case "remote":
				record.DBLink = &name
				record.LocalActive = false
				encoded, _ := json.Marshal([]plDebugNativeBreakpoint{record})
				first.afterPayload = string(encoded)
				wantState = "unresolved"
			case "incomplete_before":
				first.complete = 0
				wantState, wantSets, wantDeletes = "unresolved", 0, 0
			case "set_unknown":
				first.setError = errors.New("SET response lost")
				wantState, wantDeletes = "unresolved", 0
			case "known_rejection":
				first.setCode, first.setRejected = plDebugErrBadHandle, 1
				wantState, wantDeletes = "unresolved", 0
			case "delete_unknown":
				first.deleteError = errors.New("DELETE response lost")
				wantState = "unresolved"
			case "initial_once":
				initial := stop
				initial.Reason = integer(2)
				initial.Line = sql.NullInt64{}
				first.stops = []plDebugNativeStop{initial, stop}
			}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			request := map[string]interface{}{"agentSessionId": "a", "operationId": "entry-1", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			probe := state["currentProgramProbe"].(plDebugNativeProgramProbe)
			if state["startState"] != "succeeded" || state["entryState"] != "unresolved" || probe.State != wantState || first.sets != wantSets || first.deletes != wantDeletes {
				t.Fatalf("state=%#v probe=%+v SET=%d DELETE=%d", state, probe, first.sets, first.deletes)
			}
			if state["program"] != "" || state["sourceMappingState"] != "unverified" {
				t.Fatal("breakpoint identity overwrote NULL runtime or invented source mapping")
			}
			if (scenario == "set_unknown" || scenario == "delete_unknown" || scenario == "existing_changed" || scenario == "other_changed") && state["state"] != "unknown" {
				t.Fatal("uncertain breakpoint mutation was advertised as controllable")
			}
			if scenario == "known_rejection" && (state["state"] != "paused" || probe.Uncertain || !probe.Rejected || probe.Result == nil || *probe.Result != plDebugErrBadHandle) {
				t.Fatal("definite native rejection was turned into an unknown mutation")
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if first.sets != wantSets || first.deletes != wantDeletes {
				t.Fatal("same start replayed native inspection")
			}
			if scenario == "initial_once" && first.stopIndex != 2 {
				t.Fatal("initial event did not advance exactly once")
			}
			state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "entry-1"}))
			if state["releaseState"] != "released" || first.sets != wantSets || first.deletes != wantDeletes || e.targetAttempts != 1 {
				t.Fatalf("original owner lost cleanup or replayed inspection: %#v", state)
			}
		})
	}
}
