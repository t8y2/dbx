package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPLDebugNativeControlConformsToSharedAgentVectors(t *testing.T) {
	var fixture struct {
		Controls []struct {
			Action string
			Flag   string
		}
		Stop struct {
			Result, Line, Reason, Depth, Breakpoint, Namespace int64
			Terminated                                         bool
			Program, Owner                                     string
		}
	}
	path := filepath.Join("..", "..", "test-support", "src", "main", "resources", "pl-debug-native-control.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("shared native agent vectors are required: %v", err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil || len(fixture.Controls) != 3 {
		t.Fatalf("invalid shared native control vectors: %v", err)
	}
	integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
	text := func(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }
	routines := map[string]string{"resume": procCntNextBreakpoint, "step_over": procCntNextLine, "step_in": procCntStepIn}
	for _, profile := range []string{"thin", "oci"} {
		for _, control := range fixture.Controls {
			t.Run(profile+"/"+control.Action, func(t *testing.T) {
				expected := fixture.Stop
				terminated := int64(0)
				if expected.Terminated {
					terminated = 1
				}
				connector := &plDebugNativeControlTestConnector{outputs: []interface{}{
					integer(expected.Result), integer(expected.Line), integer(terminated), integer(expected.Breakpoint),
					integer(expected.Depth), integer(1), integer(expected.Reason), integer(expected.Namespace),
					text(expected.Program), text(expected.Owner), sql.NullString{}, integer(expected.Line), integer(2), text("Leaf.Member"),
				}}
				runtime := plDebugConnectTestRuntime(connector)
				response, _ := runtime.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"shared-vectors","driver_profile":"` + profile + `"}}`)
				if response.Error != nil {
					t.Fatal(response.Error)
				}
				t.Cleanup(func() { _ = runtime.closeAllSessions() })
				session, _ := runtime.session("shared-vectors")
				stop, err := plDebugNativeControl(context.Background(), session.server.plConnection, profile == "oci", routines[control.Action])
				if err != nil {
					t.Fatal(err)
				}
				actual := expected
				actual.Result, actual.Line, actual.Reason = stop.Result.Int64, stop.Line.Int64, stop.Reason.Int64
				actual.Depth, actual.Breakpoint, actual.Namespace = stop.StackDepth.Int64, stop.Breakpoint.Int64, stop.Namespace.Int64
				actual.Terminated, actual.Program, actual.Owner = stop.Terminated.Int64 != 0, stop.Program.String, stop.Owner.String
				if !reflect.DeepEqual(expected, actual) || !stop.Result.Valid || !stop.Line.Valid || !stop.Reason.Valid || !stop.StackDepth.Valid || !stop.Breakpoint.Valid || !stop.Namespace.Valid || !stop.Terminated.Valid || !stop.Program.Valid || !stop.Owner.Valid {
					t.Fatalf("native shared stop changed: expected %+v, got %+v", expected, stop)
				}
				if connector.calls != 1 || !strings.Contains(connector.query, "SYS.DBMS_DEBUG."+control.Flag) {
					t.Fatalf("wrong native control dispatch: calls=%d SQL=%s", connector.calls, connector.query)
				}
			})
		}
	}
}
