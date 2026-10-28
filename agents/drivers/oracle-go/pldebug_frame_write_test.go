package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"
	"time"
)

func TestPLDebugNativeFrameWriteRPCRecordsOneOriginalAssignmentAndResult(t *testing.T) {
	for _, scenario := range []string{"success", "rejected", "missing_result", "transport_error"} {
		t.Run(scenario, func(t *testing.T) {
			integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
			engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
			first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{
				plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine}, payload: "[]", complete: 1,
				stops: []plDebugNativeStop{{Result: integer(0), Terminated: integer(0), StackDepth: integer(3), Reason: integer(9)}},
			}}
			second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
			calls := 0
			entered, release := make(chan struct{}), make(chan struct{})
			first.write = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
				calls++
				if args[0].Value != 2 || args[1].Value != "\"a(b)\"(2) := 9007199254740993123456789;" {
					t.Fatalf("assignment/frame changed: %#v", args)
				}
				close(entered)
				<-release
				code := integer(0)
				if scenario == "rejected" {
					code = integer(77)
				}
				if scenario == "missing_result" {
					code = sql.NullInt64{}
				}
				if err := plDebugManagerSetOut(args[2], code); err != nil {
					return nil, err
				}
				if scenario == "transport_error" {
					return nil, errors.New("response lost after evaluation")
				}
				return driver.RowsAffected(0), nil
			}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "write-start", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
			params := map[string]interface{}{"debugId": "write-start", "operationId": "assignment-1", "stopRevision": started["stopRevision"], "name": "\"a(b)\"", "frame": 1, "index": 2, "value": "9007199254740993123456789", "nativeFrameId": 999}
			for _, change := range []func(map[string]interface{}){
				func(p map[string]interface{}) { delete(p, "operationId") },
				func(p map[string]interface{}) { delete(p, "stopRevision") },
				func(p map[string]interface{}) { p["stopRevision"] = -1 },
				func(p map[string]interface{}) { p["frame"] = 3 },
				func(p map[string]interface{}) { p["frame"] = nil },
				func(p map[string]interface{}) { p["value"] = nil },
			} {
				invalid := map[string]interface{}{}
				for key, value := range params {
					invalid[key] = value
				}
				change(invalid)
				resp := plDebugManagerRPC(t, r, "pl_debug_set_value", invalid)
				if resp.Error == nil {
					t.Fatal("invalid assignment admitted")
				}
				data := rpcDiagnostics(t, resp)
				if data["stage"] != "request" || data["operationOutcome"] != "not_started" || data["category"] != "protocol" || calls != 0 {
					t.Fatalf("pre-dispatch reject changed contract: %#v", data)
				}
			}
			done := make(chan response, 2)
			go func() { done <- plDebugManagerRPC(t, r, "pl_debug_set_value", params) }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("SET did not reach original controller")
			}
			pending := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "write-start", "operationId": "assignment-1"}))
			if pending["state"] != "running" || pending["result"] != nil {
				t.Fatal("pending assignment invented a result")
			}
			conflict := map[string]interface{}{}
			for key, value := range params {
				conflict[key] = value
			}
			conflict["value"] = "2"
			if resp := plDebugManagerRPC(t, r, "pl_debug_set_value", conflict); resp.Error == nil {
				t.Fatal("same ID changed RHS")
			}
			go func() { done <- plDebugManagerRPC(t, r, "pl_debug_set_value", params) }()
			close(release)
			for i := 0; i < 2; i++ {
				resp := <-done
				unknown := scenario == "missing_result" || scenario == "transport_error"
				if (resp.Error != nil) != unknown {
					t.Fatalf("wrong command outcome: %+v", resp)
				}
				if !unknown {
					got := plDebugManagerSnapshot(t, resp)
					if got["ok"] != (scenario == "success") || got["snapshot"].(map[string]interface{})["operationBusy"] == true || got["stopRevision"] != started["stopRevision"] {
						t.Fatalf("wrong known receipt: %#v", got)
					}
				}
			}
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "write-start", "operationId": "assignment-1"}))
			want := "unknown"
			if scenario == "success" {
				want = "succeeded"
			} else if scenario == "rejected" {
				want = "failed"
			}
			if state["state"] != want || calls != 1 {
				t.Fatalf("lost result or replay: %#v calls=%d", state, calls)
			}
			plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "write-start"})
			plDebugManagerRPC(t, r, "pl_debug_set_value", params)
			if calls != 1 {
				t.Fatal("historical same-ID assignment replayed after close")
			}
		})
	}
}

func TestPLDebugNativeAssignmentRendersQuotedTargetsAndRawRHSOnce(t *testing.T) {
	for _, sample := range []struct {
		name  string
		index int
		want  string
	}{
		{"\"a(b)\"", 2, "\"a(b)\"(2) := '值\n';"},
		{"\"a\"\"(b\"", 2, "\"a\"\"(b\"(2) := '值\n';"},
		{"items(3)", 2, "items(3) := '值\n';"},
		{"  item  ", 0, "item := '值\n';"},
	} {
		if got := plDebugAssignmentStatement(sample.name, sample.index, "'值\n';"); got != sample.want {
			t.Fatalf("got %q want %q", got, sample.want)
		}
	}
}
