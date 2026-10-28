package main

import (
	"context"
	"testing"
)

func TestPLDebugNativePublicBreakpointInventoryUsesOriginalController(t *testing.T) {
	r, controller, engine, request := plDebugNativeDriveFixture(t, "reached")
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
	defer func() {
		closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "drive-1"}))
		if closed["releaseState"] != "released" {
			t.Error("inventory lost the original cleanup owner")
		}
	}()
	controller.payloadFor = func(context.Context, bool) (string, error) {
		if resp := plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1"}); resp.Error == nil {
			t.Error("concurrent inventory was queued on the controller")
		}
		return `[{"id":77,"name":"Mixed\nName","owner":"Owner","line":9,"status":1,"localActive":true}]`, nil
	}
	before := controller.executions
	result := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1", "agentSessionId": "a"}))
	items, ok := result["breakpoints"].([]plDebugNativeListedBreakpoint)
	if !ok || len(items) != 1 || items[0].ID != 77 || items[0].BreakpointNumber != 77 || items[0].Name == nil || *items[0].Name != "Mixed\nName" {
		t.Fatalf("native inventory lost its structured identity: %#v", result)
	}
	if controller.executions != before+1 || controller.sets != 0 || controller.deletes != 0 || engine.targetAttempts != 1 {
		t.Fatal("inventory mutated breakpoints or replayed the target")
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1", "agentSessionId": "other"}); resp.Error == nil || controller.executions != before+1 {
		t.Fatal("foreign session inspected the original controller")
	}
	controller.payloadFor = func(context.Context, bool) (string, error) { return `null`, nil }
	if resp := plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1"}); resp.Error == nil {
		t.Fatal("unread inventory was published as an empty list")
	}
	controller.payloadFor = func(context.Context, bool) (string, error) { return `[]`, nil }
	empty := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_list_breakpoints", map[string]interface{}{"debugId": "drive-1"}))
	if items, ok := empty["breakpoints"].([]plDebugNativeListedBreakpoint); !ok || items == nil || len(items) != 0 {
		t.Fatal("confirmed empty inventory was not distinguished from failure")
	}
}
