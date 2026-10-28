package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestPLDebugNativeBreakpointRulesBoundContinuationAndStopOnReadFailure(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			r, controller, engine, start := plDebugNativeDriveFixture(t, "reached")
			started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
			source := started["sourceRef"].(*plDebugNativeSourceRef)
			line := int64(source.LineOffset + 2)
			controller.payloadFor = func(context.Context, bool) (string, error) {
				items := []plDebugNativeBreakpoint{}
				if controller.sets > 0 {
					items = append(items, plDebugNativeBreakpoint{ID: 77, Line: &line, LocalActive: true})
				}
				payload, err := json.Marshal(items)
				return string(payload), err
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", map[string]interface{}{"debugId": "drive-1", "operationId": "bounded-rule", "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "stopRevision": source.StopRevision, "nativeFrameId": source.NativeFrameID, "line": 2, "rules": plDebugNativeBreakpointRules{Condition: "N == 0"}}))
			integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
			hit := plDebugNativeStop{Result: integer(0), Terminated: integer(0), Line: integer(line), Breakpoint: integer(77), StackDepth: integer(1), Reason: integer(plDebugReasonBreakpoint), Namespace: integer(0)}
			for i := 0; i < 201; i++ {
				controller.controlStops = append(controller.controlStops, hit)
			}
			reads := 0
			controller.nativeValue = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
				reads++
				if failure {
					return nil, errors.New("original controller value read failed")
				}
				if err := plDebugManagerSetOut(args[2], integer(0)); err != nil {
					return nil, err
				}
				return driver.RowsAffected(0), plDebugManagerSetOut(args[3], sql.NullString{String: "1", Valid: true})
			}
			controls := engine.controls
			response := plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "drive-1"})
			if failure {
				if response.Error == nil || reads != 1 || engine.controls != controls+1 {
					t.Fatal("failed value read became false and resumed")
				}
			} else {
				result := plDebugManagerSnapshot(t, response)
				events := result["breakpointRuleEvents"].([]plDebugNativeRuleEvent)
				if reads != 201 || engine.controls != controls+201 || result["state"] != "paused" || len(events) != 1 || events[0].Warning != "automatic continue limit (200) reached; stopped" {
					t.Fatal("automatic continuation exceeded the original finite limit or reported completion")
				}
			}
			controller.controlStops = nil
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
			if closed["releaseState"] != "released" {
				t.Fatal("bounded rule lost original resource owner")
			}
		})
	}
}

func TestPLDebugNativeBreakpointRulesStayWithOriginalOwnerAcrossStatusReads(t *testing.T) {
	r, controller, engine, start := plDebugNativeDriveFixture(t, "reached")
	started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	source := started["sourceRef"].(*plDebugNativeSourceRef)
	invalid := plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", map[string]interface{}{"debugId": "drive-1", "operationId": "invalid-rules", "stopRevision": source.StopRevision, "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "nativeFrameId": source.NativeFrameID, "line": 2, "rules": plDebugNativeBreakpointRules{IgnoreCount: -1}})
	if invalid.Error == nil || rpcDiagnostics(t, invalid)["operationOutcome"] != "not_started" || controller.sets != 0 {
		t.Fatal("invalid rules were not conclusively rejected before mutation")
	}
	line := int64(source.LineOffset + 2)
	controller.payloadFor = func(context.Context, bool) (string, error) {
		items := []plDebugNativeBreakpoint{}
		if controller.sets > 0 {
			items = append(items, plDebugNativeBreakpoint{ID: 77, Line: &line, LocalActive: true})
		}
		payload, err := json.Marshal(items)
		return string(payload), err
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", map[string]interface{}{"debugId": "drive-1", "operationId": "rule-create", "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "stopRevision": source.StopRevision, "nativeFrameId": source.NativeFrameID, "line": 2, "rules": plDebugNativeBreakpointRules{IgnoreCount: 2, Condition: "N >= 2", Message: "arrived 中"}}))
	integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
	hit := plDebugNativeStop{Result: integer(0), Terminated: integer(0), Line: integer(line), Breakpoint: integer(77), StackDepth: integer(1), Reason: integer(plDebugReasonBreakpoint), Namespace: integer(0)}
	controller.controlStops = []plDebugNativeStop{hit, hit, hit}
	reads := 0
	controller.nativeValue = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
		reads++
		if args[0].Value != "N" || fmt.Sprint(args[1].Value) != "1" {
			t.Fatal("condition read guessed a different frame or variable")
		}
		text := "0"
		if reads == 2 {
			text = "2"
		}
		if err := plDebugManagerSetOut(args[2], integer(0)); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), plDebugManagerSetOut(args[3], sql.NullString{String: text, Valid: true})
	}
	controls := engine.controls
	result := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "drive-1"}))
	if engine.controls != controls+3 || reads != 2 || result["state"] != "paused" || result["stopRevision"] != source.StopRevision+3 {
		t.Fatalf("rules did not run within one owner: %#v controls=%d reads=%d", result, engine.controls, reads)
	}
	events := result["breakpointRuleEvents"].([]plDebugNativeRuleEvent)
	if len(events) != 1 || events[0].Message != "arrived 中" || events[0].Warning != "" || events[0].StopRevision != source.StopRevision+3 {
		t.Fatal("ignored/false hits emitted a message or lost final stop identity")
	}
	for i := 0; i < 3; i++ {
		plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "drive-1"}))
	}
	listed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1"}))["breakpoints"].([]plDebugNativeListedBreakpoint)
	if listed[0].Hits != 3 || listed[0].IgnoreCount != 2 || reads != 2 || engine.controls != controls+3 {
		t.Fatal("status/refresh reset counters or drove another resume")
	}
	update := map[string]interface{}{"debugId": "drive-1", "operationId": "rule-update", "stopRevision": result["stopRevision"], "breakpointNumber": 77, "registrationId": "rule-create", "rules": plDebugNativeBreakpointRules{Condition: "N == f()", Message: "halt"}}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", update))
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", update))
	if controller.sets != 1 || controller.toggles != 0 {
		t.Fatal("rules update re-created or toggled native breakpoint")
	}
	controller.controlStops = []plDebugNativeStop{hit}
	result = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "drive-1"}))
	events = result["breakpointRuleEvents"].([]plDebugNativeRuleEvent)
	if reads != 2 || events[len(events)-1].Warning == "" || result["state"] != "paused" {
		t.Fatal("unparseable condition executed code or resumed past its stop")
	}
	closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
	if closed["releaseState"] != "released" || engine.targetAttempts != 1 {
		t.Fatal("rule owner lost original cleanup or replayed target")
	}
}
