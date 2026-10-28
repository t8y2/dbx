package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPLDebugNativeCompileTargetQuotesExactIdentifiers(t *testing.T) {
	for _, scenario := range []struct {
		name, kind, pkg, wantType string
	}{
		{"procedure", "PROCEDURE", "", "PROCEDURE"},
		{"function", "FUNCTION", "", "FUNCTION"},
		{"package member", "FUNCTION", " Pkg.\" ", "PACKAGE BODY"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			owner, name := " Owner.\" ", " Proc.\" "
			unit, err := plDebugNativeCompileTarget(owner, plDebugNativeStart{ObjectType: scenario.kind, ObjectName: name, PackageName: scenario.pkg})
			if err != nil {
				t.Fatal(err)
			}
			wantSQL := "ALTER " + scenario.kind + ` " Owner."" "." Proc."" " COMPILE DEBUG REUSE SETTINGS`
			wantName := name
			if scenario.pkg != "" {
				wantName = scenario.pkg
				wantSQL = `ALTER PACKAGE " Owner."" "." Pkg."" " COMPILE DEBUG BODY REUSE SETTINGS`
			}
			if unit.Schema != owner || unit.ObjectName != wantName || unit.ObjectType != scenario.wantType || unit.SQL != wantSQL || !unit.ReusesSettings {
				t.Fatalf("compile identity or SQL changed: %+v; want %q", unit, wantSQL)
			}
		})
	}
}

func TestPLDebugNativeCompileTargetRejectsAnonymousAndMissingIdentity(t *testing.T) {
	for _, target := range []plDebugNativeStart{
		{ObjectType: "ANONYMOUS", Source: "BEGIN NULL; END;"},
		{ObjectType: "PACKAGE", ObjectName: "P"},
		{ObjectType: "PROCEDURE"},
	} {
		if _, err := plDebugNativeCompileTarget("Owner", target); err == nil {
			t.Fatalf("accepted %+v", target)
		}
	}
	if _, err := plDebugNativeCompileTarget("", plDebugNativeStart{ObjectType: "PROCEDURE", ObjectName: "P"}); err == nil {
		t.Fatal("accepted missing owner")
	}
}

func TestPLDebugNativeCompilePreviewFreezesInvalidSourceWithoutExecuting(t *testing.T) {
	for _, scenario := range []string{"invalid", "package", "changed", "missing", "unknown_settings"} {
		t.Run(scenario, func(t *testing.T) {
			c := plDebugTargetFixture()
			c.objects = [][]driver.Value{{"object", "INVALID"}}
			c.sourceRows = [][]driver.Value{{"object", "INVALID", "2026-10-25 01:02:03", int64(1), "procedure P as begin missing_routine; end;\n"}}
			c.compileSettings = [][]driver.Value{{"FALSE", "2"}}
			target := plDebugNativeStart{Schema: c.owner, ObjectName: "P", ObjectType: "PROCEDURE"}
			switch scenario {
			case "package":
				target.PackageName = "Package"
				c.specRows = [][]driver.Value{{"object", "VALID", nil, int64(1), "package Package as procedure P; end;\n"}}
			case "changed":
				c.sourceNext = [][]driver.Value{{"object", "INVALID", "2026-10-25 01:02:03", int64(1), "changed source\n"}}
			case "missing":
				c.sourceRows = nil
			case "unknown_settings":
				c.compileSettingsError = errors.New("ORA-00942: settings unavailable")
			}
			db := sql.OpenDB(c)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			preview, err := plDebugPreviewNativeCompile(context.Background(), conn, target)
			if scenario == "changed" {
				if err == nil || !strings.Contains(err.Error(), "changed") {
					t.Fatalf("changed source accepted: %+v %v", preview, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if preview["canCompile"] != (scenario != "missing") {
					t.Fatalf("wrong source readiness: %+v", preview)
				}
				if scenario != "missing" {
					settings := preview["settings"].(map[string]interface{})
					want := "requires_compile"
					if scenario == "unknown_settings" {
						want = "unknown"
					}
					if settings["state"] != want {
						t.Fatalf("wrong settings: %+v", settings)
					}
				}
				if scenario == "package" && len(preview["sources"].([]plDebugNativeSource)) != 2 {
					t.Fatal("package specification not frozen")
				}
			}
			if c.base.execs != 0 {
				t.Fatal("read-only compilation preview executed SQL")
			}
		})
	}
}

func TestPLDebugNativeCompileSettingsDistinguishesUnknownAndFailure(t *testing.T) {
	for _, scenario := range []struct {
		name, debug, want string
		err               error
	}{
		{"ready_at_level_two", "TRUE", "ready", nil},
		{"missing_flag", "", "unknown", nil},
		{"permission", "", "unknown", errors.New("ORA-01031: denied")},
		{"connection", "", "", errors.New("ORA-03113: connection closed")},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			c := plDebugTargetFixture()
			c.compileSettings, c.compileSettingsError = [][]driver.Value{{scenario.debug, "2"}}, scenario.err
			db := sql.OpenDB(c)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			settings, err := plDebugNativeCompileSettings(context.Background(), conn, plDebugNativeCompileUnit{Schema: "O", ObjectName: "P", ObjectType: "PROCEDURE"})
			if scenario.want == "" {
				if err == nil {
					t.Fatal("connection failure became unknown settings")
				}
			} else if err != nil || settings["state"] != scenario.want {
				t.Fatalf("settings=%+v error=%v", settings, err)
			}
		})
	}
}

func TestPLDebugNativeCompilePreviewUsesDedicatedInspectionRPCOnly(t *testing.T) {
	c := plDebugTargetFixture()
	c.objects = [][]driver.Value{{"object", "INVALID"}}
	c.sourceRows = [][]driver.Value{{"object", "INVALID", nil, int64(1), "function F return number as begin return missing; end;\n"}}
	c.compileSettings = [][]driver.Value{{"FALSE", "2"}}
	r := plDebugOpenTargetFixture(t, c)
	target := map[string]interface{}{"schema": c.owner, "objectType": "FUNCTION", "objectName": "F", "metadataPreparation": "debug_compile"}
	value := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_inspect", map[string]interface{}{"agentSessionId": "a", "target": target}))
	preview, ok := value["compilePreview"].(map[string]interface{})
	if !ok || preview["canCompile"] != true || preview["objectType"] != "FUNCTION" {
		t.Fatalf("compile preview not returned: %+v", value)
	}
	if _, exists := value["targetPreview"]; exists {
		t.Fatal("compile preview went through the VALID-only target preparation path")
	}
	if len(preview["signatures"].([]plDebugNativeCandidate)) != 2 {
		t.Fatal("INVALID raw signatures not preserved")
	}
	if c.base.execs != 0 {
		t.Fatal("inspection executed a write")
	}
	for _, method := range []string{"pl_debug_start", "pl_debug_resolve_target"} {
		request := map[string]interface{}{"agentSessionId": "a", "operationId": "compile-not-a-start", "schema": c.owner, "objectType": "FUNCTION", "objectName": "F", "metadataPreparation": "debug_compile"}
		if response := plDebugManagerRPC(t, r, method, request); response.Error == nil {
			t.Fatalf("%s accepted compilation policy", method)
		}
	}
	if c.base.execs != 0 {
		t.Fatal("rejected compilation policy executed a write")
	}
}

func TestPLDebugNativeCompileInspectionRereadsCurrentDiagnosticsWithoutDDL(t *testing.T) {
	c := plDebugTargetFixture()
	c.objects = [][]driver.Value{{"object", "INVALID"}}
	c.sourceRows = [][]driver.Value{{"object", "INVALID", nil, int64(1), "function F return number as begin return missing; end;\n"}}
	c.compileDiagnosticsError = errors.New("ORA-01031: diagnostics denied")
	r := plDebugOpenTargetFixture(t, c)
	request := map[string]interface{}{"agentSessionId": "a", "target": map[string]interface{}{"schema": c.owner, "objectType": "FUNCTION", "objectName": "F", "metadataPreparation": "debug_compile"}}
	first := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_inspect", request))
	firstObservation := first["compileObservation"].(map[string]interface{})["readback"].(map[string]interface{})
	if firstObservation["diagnosticsComplete"] != false {
		t.Fatalf("diagnostic failure disappeared: %+v", first)
	}
	c.compileDiagnosticsError = nil
	c.compileDiagnostics = [][]driver.Value{{"1", "4", "2", "current diagnostic", "ERROR", "201"}}
	second := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_inspect", request))
	observation := second["compileObservation"].(map[string]interface{})
	current := observation["readback"].(map[string]interface{})
	if observation["schema"] != c.owner || observation["objectType"] != "FUNCTION" || current["diagnosticsComplete"] != true || len(current["diagnostics"].([]map[string]interface{})) != 1 {
		t.Fatalf("current observation missing: %+v", second)
	}
	if firstObservation["diagnosticsComplete"] != false || c.base.execs != 0 {
		t.Fatal("reread changed the prior observation or executed DDL")
	}
	if _, exists := second["compilePreview"].(map[string]interface{})["readback"]; exists {
		t.Fatal("current diagnostics were mixed into the confirmed compilation identity")
	}
}

func TestPLDebugNativeCompileRPCPreservesOriginalReceiptAndIndependentRelease(t *testing.T) {
	for _, scenario := range []string{"invalid", "changed", "diagnostics_failure", "connection_failure", "permission"} {
		t.Run(scenario, func(t *testing.T) {
			c := plDebugTargetFixture()
			c.objects = [][]driver.Value{{"object", "INVALID"}}
			c.sourceRows = [][]driver.Value{{"object", "INVALID", nil, int64(1), "function F return number as begin return missing; end;\n"}}
			c.compileSettings = [][]driver.Value{{"FALSE", "2"}}
			c.compileDiagnostics = [][]driver.Value{{"1", "1", "4", "missing routine", "ERROR", "201"}}
			r := plDebugOpenTargetFixture(t, c)
			target := map[string]interface{}{"schema": c.owner, "objectType": "FUNCTION", "objectName": "F", "metadataPreparation": "debug_compile"}
			inspected := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_inspect", map[string]interface{}{"agentSessionId": "a", "target": target}))
			preview := inspected["compilePreview"]
			switch scenario {
			case "changed":
				c.sourceNext = [][]driver.Value{{"object", "INVALID", nil, int64(1), "changed\n"}}
			case "diagnostics_failure":
				c.compileDiagnosticsError = errors.New("ORA-01031: diagnostics denied")
			case "connection_failure":
				c.compileExecError = errors.New("ORA-03113: lost DDL response")
			case "permission":
				c.compileExecError = errors.New("ORA-01031: compilation denied")
			}
			request := map[string]interface{}{"agentSessionId": "a", "operationId": "compile-1", "target": target, "preview": preview}
			result := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_compile", request))
			want, attempts := "executed", 1
			if scenario == "changed" {
				want, attempts = "not_started", 0
			}
			if scenario == "connection_failure" {
				want = "unknown"
			}
			if scenario == "permission" {
				want = "failed"
			}
			if result["ddlState"] != want || len(c.compileSQL) != attempts || result["releaseState"] != "unconfirmed" {
				t.Fatalf("wrong execution facts: %+v SQL=%v", result, c.compileSQL)
			}
			if want == "executed" {
				observed := result["readback"].(map[string]interface{})
				if observed["diagnosticsComplete"] != (scenario != "diagnostics_failure") {
					t.Fatalf("lost readback completeness: %+v", observed)
				}
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_compile", request))
			request["target"] = json.RawMessage(`{"metadataPreparation":"debug_compile","objectType":"FUNCTION","objectName":"F","schema":" Mixed Owner "}`)
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_compile", request))
			foreign := map[string]interface{}{"agentSessionId": "foreign", "operationId": "compile-1"}
			if plDebugManagerRPC(t, r, "pl_debug_compile_status", foreign).Error == nil {
				t.Fatal("foreign session read a receipt")
			}
			changed := map[string]interface{}{"agentSessionId": "a", "operationId": "compile-1", "target": target, "preview": map[string]interface{}{"sql": "other"}}
			if plDebugManagerRPC(t, r, "pl_debug_compile", changed).Error == nil {
				t.Fatal("same ID accepted different content")
			}
			request["operationId"] = "compile-2"
			if plDebugManagerRPC(t, r, "pl_debug_compile", request).Error == nil {
				t.Fatal("new ID bypassed unresolved release")
			}
			if plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "start", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}).Error == nil {
				t.Fatal("start bypassed compilation ownership")
			}
			if len(c.compileSQL) != attempts {
				t.Fatal("receipt lookup replayed DDL")
			}
			if attempts > 0 && c.compileSQL[0] != `ALTER FUNCTION " Mixed Owner "."F" COMPILE DEBUG REUSE SETTINGS` {
				t.Fatalf("wrong fixed SQL: %q", c.compileSQL[0])
			}
			if response := plDebugManagerRPC(t, r, "close_session", map[string]interface{}{"agentSessionId": "a"}); response.Error != nil {
				t.Fatal(response.Error)
			}
			status := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_compile_status", map[string]interface{}{"agentSessionId": "a", "operationId": "compile-1"}))
			if status["ddlState"] != want || status["releaseState"] != "released" {
				t.Fatalf("physical release discarded DDL fact: %+v", status)
			}
		})
	}
}

func TestPLDebugNativeCompileReceiptIsQueryableWhileOriginalPreflightIsPending(t *testing.T) {
	c := plDebugTargetFixture()
	c.objects = [][]driver.Value{{"object", "INVALID"}}
	c.sourceRows = [][]driver.Value{{"object", "INVALID", nil, int64(1), "function F return number as begin return missing; end;\n"}}
	r := plDebugOpenTargetFixture(t, c)
	target := map[string]interface{}{"schema": c.owner, "objectType": "FUNCTION", "objectName": "F", "metadataPreparation": "debug_compile"}
	inspected := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_inspect", map[string]interface{}{"agentSessionId": "a", "target": target}))
	request, err := json.Marshal(map[string]interface{}{"agentSessionId": "a", "operationId": "pending-compile", "target": target, "preview": inspected["compilePreview"]})
	if err != nil {
		t.Fatal(err)
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(request, &params); err != nil {
		t.Fatal(err)
	}
	c.started, c.release = make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-c.release:
		default:
			close(c.release)
		}
	}()
	done := make(chan error, 1)
	go func() { _, err := r.compileNativeTarget(params); done <- err }()
	select {
	case <-c.started:
	case <-time.After(2 * time.Second):
		t.Fatal("compile preflight did not enter its original connection")
	}
	status := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_compile_status", map[string]interface{}{"agentSessionId": "a", "operationId": "pending-compile"}))
	if status["finished"] != false || status["dispatched"] != false || status["releaseState"] != "unconfirmed" {
		t.Fatalf("pending receipt lost original state: %+v", status)
	}
	if response := plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "raced-start", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}); response.Error == nil {
		t.Fatal("start passed pending compile admission")
	}
	close(c.release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("original compilation did not finish")
	}
	if len(c.compileSQL) != 1 {
		t.Fatalf("expected one DDL, got %v", c.compileSQL)
	}
}
