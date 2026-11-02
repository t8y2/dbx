package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestPLDebugNativeSourceBoundBreakpointCreationDoesNotReplay(t *testing.T) {
	r, controller, engine, start := plDebugNativeDriveFixture(t, "reached")
	snapshot := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	source := snapshot["sourceRef"].(*plDebugNativeSourceRef)
	line := int64(source.LineOffset + 1)
	controller.payloadFor = func(context.Context, bool) (string, error) {
		if controller.sets == 0 || controller.deletes > 0 {
			return "[]", nil
		}
		active := controller.toggles == 0 || controller.toggleEnabled
		payload, err := json.Marshal([]plDebugNativeBreakpoint{{ID: 77, Line: &line, LocalActive: active}})
		return string(payload), err
	}
	request := map[string]interface{}{"debugId": "drive-1", "operationId": "set-1", "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "stopRevision": source.StopRevision, "nativeFrameId": source.NativeFrameID, "line": 1}
	for _, key := range []string{"sourceRevision", "stopRevision", "nativeFrameId", "line"} {
		invalid := map[string]interface{}{}
		for name, value := range request {
			invalid[name] = value
		}
		invalid["operationId"], invalid[key] = "invalid-"+key, 99999
		reads := controller.executions
		if resp := plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", invalid); resp.Error == nil || controller.sets != 0 || controller.executions != reads {
			t.Fatalf("invalid %s dispatched native SQL", key)
		}
	}
	created := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", request))
	if created["ok"] != true || created["line"] != int64(1) || created["nativeLine"] != line || created["breakpointNumber"] != int64(77) || controller.sets != 1 {
		t.Fatalf("breakpoint was not mapped and verified: %#v", created)
	}
	if created["owned"] != true || created["registrationId"] != "set-1" {
		t.Fatal("new native breakpoint was not registered to its creation intent")
	}
	reads := controller.executions
	receipt := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "drive-1", "operationId": "set-1"}))
	if receipt["action"] != "set_breakpoints" || receipt["state"] != "succeeded" || controller.executions != reads {
		t.Fatal("operation recovery changed the original native controller")
	}
	listed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1"}))["breakpoints"].([]plDebugNativeListedBreakpoint)
	if len(listed) != 1 || !listed[0].Owned || listed[0].RegistrationID != "set-1" || *listed[0].Line != 1 || *listed[0].NativeLine != line || listed[0].Kind != "ANONYMOUS" {
		t.Fatal("inventory lost its owned logical/native line mapping")
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_set_value", map[string]interface{}{"debugId": "drive-1", "operationId": "set-1", "stopRevision": source.StopRevision, "name": "N", "frame": 0, "value": "1"}); resp.Error == nil {
		t.Fatal("breakpoint operation ID was reused for assignment")
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", request))
	if controller.sets != 1 || engine.targetAttempts != 1 {
		t.Fatal("same operation replayed native SET or the target")
	}
	request["line"] = 2
	if resp := plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", request); resp.Error == nil || controller.sets != 1 {
		t.Fatal("changed request reused the original breakpoint intent")
	}
	request["operationId"], request["sourceRefId"] = "set-other", "invented"
	if resp := plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", request); resp.Error == nil || controller.sets != 1 {
		t.Fatal("an invented source reference authorized native SET")
	}
	for index, enabled := range []bool{false, true} {
		id := "disable-1"
		if enabled {
			id = "enable-1"
		}
		toggle := map[string]interface{}{"debugId": "drive-1", "operationId": id, "stopRevision": source.StopRevision, "breakpointNumber": 77, "registrationId": "set-1", "enabled": enabled}
		changed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoint_enabled", toggle))
		if changed["ok"] != true || changed["enabled"] != enabled || controller.toggles != index+1 {
			t.Fatal("owned breakpoint toggle was not read back")
		}
		plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoint_enabled", toggle))
		if controller.toggles != index+1 {
			t.Fatal("same operation replayed native toggle")
		}
		status := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "drive-1", "operationId": id}))
		if status["action"] != "set_breakpoint_enabled" || status["state"] != "succeeded" {
			t.Fatal("toggle recovery lost the original action")
		}
	}
	deletion := map[string]interface{}{"debugId": "drive-1", "operationId": "delete-1", "stopRevision": source.StopRevision, "breakpointNumber": 77, "registrationId": "foreign-registration"}
	reads = controller.executions
	if resp := plDebugManagerRPC(t, r, "pl_debug_delete_breakpoints", deletion); resp.Error == nil || controller.deletes != 0 || controller.executions != reads {
		t.Fatal("foreign breakpoint registration authorized DELETE")
	}
	deletion["registrationId"] = "set-1"
	originalInventory := controller.payloadFor
	controller.payloadFor = func(context.Context, bool) (string, error) {
		changedLine := line + 1
		payload, err := json.Marshal([]plDebugNativeBreakpoint{{ID: 77, Line: &changedLine, LocalActive: true}})
		return string(payload), err
	}
	deletion["operationId"] = "delete-stale"
	if resp := plDebugManagerRPC(t, r, "pl_debug_delete_breakpoints", deletion); resp.Error == nil || controller.deletes != 0 {
		t.Fatal("a reused native number authorized deleting a different inventory record")
	}
	changed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1"}))["breakpoints"].([]plDebugNativeListedBreakpoint)
	if len(changed) != 1 || changed[0].Owned {
		t.Fatal("changed native inventory retained an obsolete owner registration")
	}
	controller.payloadFor = originalInventory
	deletion["operationId"] = "delete-1"
	deleted := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_delete_breakpoints", deletion))
	if deleted["ok"] != true || controller.deletes != 1 {
		t.Fatal("owned breakpoint was not deleted and read back")
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_delete_breakpoints", deletion))
	if controller.deletes != 1 {
		t.Fatal("same operation replayed DELETE")
	}
	reads = controller.executions
	receipt = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "drive-1", "operationId": "delete-1"}))
	if receipt["action"] != "delete_breakpoints" || receipt["state"] != "succeeded" || controller.executions != reads {
		t.Fatal("DELETE recovery did not preserve the original receipt")
	}
	closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
	if closed["releaseState"] != "released" {
		t.Fatal("source-bound breakpoint lost the original cleanup owner")
	}
	request["sourceRefId"], request["line"], request["operationId"] = source.ID, 1, "set-1"
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", request))
	if controller.sets != 1 {
		t.Fatal("closed operation replayed native SET")
	}
}

func TestPLDebugNativeOwnedBreakpointToggleUnknownNeverReplays(t *testing.T) {
	for _, scenario := range []string{"missing_result", "driver_error", "unchanged_inventory"} {
		t.Run(scenario, func(t *testing.T) {
			r, controller, _, start := plDebugNativeDriveFixture(t, "reached")
			snapshot := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
			source := snapshot["sourceRef"].(*plDebugNativeSourceRef)
			line := int64(source.LineOffset + 1)
			controller.payloadFor = func(context.Context, bool) (string, error) {
				items := []plDebugNativeBreakpoint{}
				if controller.sets > 0 {
					items = append(items, plDebugNativeBreakpoint{ID: 77, Line: &line, LocalActive: true})
				}
				payload, err := json.Marshal(items)
				return string(payload), err
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", map[string]interface{}{"debugId": "drive-1", "operationId": "create-1", "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "stopRevision": source.StopRevision, "nativeFrameId": source.NativeFrameID, "line": 1}))
			controller.toggleMissing = scenario == "missing_result"
			if scenario == "driver_error" {
				controller.toggleError = errors.New("native toggle response lost")
			}
			request := map[string]interface{}{"debugId": "drive-1", "operationId": "toggle-unknown", "stopRevision": source.StopRevision, "breakpointNumber": 77, "registrationId": "create-1", "enabled": false}
			for attempt := 0; attempt < 2; attempt++ {
				resp := plDebugManagerRPC(t, r, "pl_debug_set_breakpoint_enabled", request)
				if resp.Error == nil || controller.toggles != 1 || rpcDiagnostics(t, resp)["operationOutcome"] != "unknown" {
					t.Fatal("unknown native toggle was accepted or repeated")
				}
			}
			reads := controller.executions
			receipt := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "drive-1", "operationId": "toggle-unknown"}))
			if receipt["state"] != "unknown" || receipt["action"] != "set_breakpoint_enabled" || controller.executions != reads {
				t.Fatal("unknown toggle recovery changed the original controller")
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
			if closed["releaseState"] != "released" {
				t.Fatal("unknown toggle lost its cleanup owner")
			}
		})
	}
}

func TestPLDebugNativeSourceBoundBreakpointUnknownReceiptNeverReplays(t *testing.T) {
	for _, scenario := range []string{"missing", "changed_existing"} {
		t.Run(scenario, func(t *testing.T) {
			r, controller, _, start := plDebugNativeDriveFixture(t, "reached")
			snapshot := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
			source := snapshot["sourceRef"].(*plDebugNativeSourceRef)
			line := int64(source.LineOffset + 1)
			controller.payloadFor = func(context.Context, bool) (string, error) {
				items := []plDebugNativeBreakpoint{}
				if scenario == "changed_existing" {
					existingLine := int64(1 + controller.sets)
					items = append(items, plDebugNativeBreakpoint{ID: 5, Line: &existingLine, LocalActive: true})
					if controller.sets > 0 {
						items = append(items, plDebugNativeBreakpoint{ID: 77, Line: &line, LocalActive: true})
					}
				}
				payload, err := json.Marshal(items)
				return string(payload), err
			}
			request := map[string]interface{}{"debugId": "drive-1", "operationId": "set-unknown", "sourceRefId": source.ID, "sourceRevision": source.SourceRevision, "stopRevision": source.StopRevision, "nativeFrameId": source.NativeFrameID, "line": 1}
			for attempt := 0; attempt < 2; attempt++ {
				resp := plDebugManagerRPC(t, r, "pl_debug_set_breakpoints", request)
				if resp.Error == nil || controller.sets != 1 {
					t.Fatal("unverified mutation was accepted or repeated")
				}
				data := rpcDiagnostics(t, resp)
				if data["operationOutcome"] != "unknown" {
					t.Fatal("dispatched unverified mutation was reported as not_started")
				}
			}
			reads := controller.executions
			receipt := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "drive-1", "operationId": "set-unknown"}))
			if receipt["state"] != "unknown" || receipt["action"] != "set_breakpoints" || controller.executions != reads {
				t.Fatal("unknown receipt recovery repeated native work")
			}
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "drive-1"}))
			if state["state"] != "unknown" {
				t.Fatal("unverified breakpoint side effect left the session resumable")
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
			if closed["releaseState"] != "released" {
				t.Fatal("unverified breakpoint lost its cleanup owner")
			}
		})
	}
}
