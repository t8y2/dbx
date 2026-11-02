package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"strings"
	"testing"
)

type plDebugNamedSourceTestConnector struct {
	native   *plDebugBreakpointTestConnector
	metadata *plDebugTargetTestConnector
}

func (c *plDebugNamedSourceTestConnector) Driver() driver.Driver { return c.native.Driver() }
func (c *plDebugNamedSourceTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.native.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugNamedSourceTestConnection{conn.(*plDebugBreakpointTestConnection), c.metadata}, nil
}

type plDebugNamedSourceTestConnection struct {
	*plDebugBreakpointTestConnection
	metadata *plDebugTargetTestConnector
}

func (c *plDebugNamedSourceTestConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return (&plDebugTargetTestConnection{plDebugConnectTestConnection: c.plDebugConnectTestConnection, owner: c.metadata}).QueryContext(ctx, query, args)
}

func TestPLDebugNativeNamedSourceRPCUsesFrozenExactContainerAndVersion(t *testing.T) {
	for _, scenario := range []string{"body", "spec", "other_schema", "wrong_kind", "stale_body", "stale_spec", "missing_line"} {
		t.Run(scenario, func(t *testing.T) {
			metadata := plDebugTargetFixture()
			metadata.specRows = [][]driver.Value{{metadata.objects[0][0], "VALID", "2026-10-23 01:02:03", int64(1), "\n"}, {metadata.objects[0][0], "VALID", "2026-10-23 01:02:03", int64(2), "package \" Pkg.\"\"\n \" as\n"}}
			owner, name := metadata.owner, " Pkg.\"\n "
			namespace, line := int64(2), int64(2)
			kind := "package_body"
			if scenario == "spec" {
				namespace = 1
				kind = "toplevel_or_spec"
			}
			if scenario == "other_schema" {
				owner = " Other.Owner "
			}
			if scenario == "wrong_kind" {
				namespace = 3
				kind = ""
			}
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			stop := plDebugNativeStop{Result: integer(0), Line: integer(line), Terminated: integer(0), Reason: integer(9), StackDepth: integer(1), Namespace: integer(namespace), Program: sql.NullString{String: name, Valid: true}, Owner: sql.NullString{String: owner, Valid: true}}
			record := plDebugNativeStackRecord{NativeFrameID: 1, Namespace: &namespace, Program: &name, Owner: &owner, Line: &line, NamespaceKind: kind}
			if scenario == "missing_line" {
				stop.Line = sql.NullInt64{}
				record.Line = nil
			}
			payload, _ := json.Marshal([]plDebugNativeStackRecord{record})
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			native := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payload: string(payload), complete: 1, stops: []plDebugNativeStop{stop}}
			first := &plDebugNamedSourceTestConnector{native: native, metadata: metadata}
			out, returned := "42", "82"
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}, phase: 2, fields: []*string{&out, &returned}, copied: []int64{1, 1}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", plDebugNamedRequest("NUMBER", "3")))
			if scenario == "stale_body" {
				for _, row := range metadata.sourceRows {
					metadata.sourceNext = append(metadata.sourceNext, append([]driver.Value{}, row...))
				}
				metadata.sourceNext[1][4] = "new source with identical signature/time\n"
			}
			if scenario == "stale_spec" {
				for _, row := range metadata.specRows {
					metadata.specNext = append(metadata.specNext, append([]driver.Value{}, row...))
				}
				metadata.specNext[1][4] = "new specification default expression\n"
			}
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "named-1"}))
			frame := state["frames"].([]plDebugNativeStackFrame)[0]
			resolved := scenario == "body" || scenario == "spec" || scenario == "missing_line"
			if (frame.SourceRef != nil) != resolved || state["program"] != name || state["programOwner"] != owner || state["entryState"] != "unresolved" {
				t.Fatalf("container/target identity conflated: %#v", state)
			}
			if resolved {
				ref := frame.SourceRef
				wantType, wantID := "PACKAGE BODY", "body-9007199254740993124"
				var text strings.Builder
				rows := metadata.sourceRows
				if scenario == "spec" {
					wantType, wantID = "PACKAGE", metadata.objects[0][0].(string)
					rows = metadata.specRows
				}
				for _, row := range rows {
					text.WriteString(row[4].(string))
				}
				if ref.LineBasis != "all_source" || ref.ObjectType != wantType || *ref.ObjectID != wantID || *ref.Owner != owner || *ref.Name != name || ref.Source != text.String() || ref.StopRevision != state["stopRevision"] {
					t.Fatal("source reference lost exact spec/body identity or original lines")
				}
				if scenario == "missing_line" {
					if state["sourceMappingState"] != "unverified" || state["line"] != nil || frame.SourceState != "source_only" {
						t.Fatal("missing native line acquired a source highlight")
					}
				} else if state["sourceMappingState"] != "verified" || *frame.SourceLine != line {
					t.Fatal("exact source container did not map its native line")
				}
			} else if strings.HasPrefix(scenario, "stale_") {
				if frame.SourceState != "stale" || state["sourceError"] == "" || state["structuredBacktraceError"] != "" {
					t.Fatal("changed frozen source was authorized")
				}
			} else if metadata.sourceReads != 2 {
				t.Fatal("a different owner/namespace borrowed the launch target source")
			}
			ended := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
			if ended["sourceRef"] != nil || ended["sourceMappingState"] != "unverified" {
				t.Fatal("old source reference survived execution")
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 || native.sets != 0 || native.deletes != 0 {
				t.Fatal("source lookup replayed target or mutated breakpoints")
			}
		})
	}
}

func TestPLDebugNativeNamedSourceRPCKeepsMemberOverloadNestedAndInitializationSeparate(t *testing.T) {
	for _, scenario := range []string{"selected_marker", "overload_marker", "nested_marker", "init_marker"} {
		t.Run(scenario, func(t *testing.T) {
			metadata := plDebugTargetFixture()
			pkg, member := " Pkg.\"\n ", " f.x "
			code := "PACKAGE BODY " + quoteIdentifier(pkg) + " AS\n" +
				" FUNCTION " + quoteIdentifier(member) + "(X VARCHAR2, Y OUT VARCHAR2) RETURN VARCHAR2 IS\n BEGIN\n Y := X; -- overload_marker\n RETURN X;\n END " + quoteIdentifier(member) + ";\n" +
				" FUNCTION " + quoteIdentifier(member) + "(X NUMBER, Y OUT NUMBER) RETURN NUMBER IS\n FUNCTION HELPER RETURN NUMBER IS\n BEGIN\n RETURN 2; -- nested_marker\n END HELPER;\n BEGIN\n Y := X; -- selected_marker\n RETURN HELPER;\n END " + quoteIdentifier(member) + ";\nBEGIN\n NULL; -- init_marker\nEND " + quoteIdentifier(pkg) + ";"
			metadata.sourceRows = nil
			nativeLine := int64(0)
			for i, text := range strings.Split(code, "\n") {
				metadata.sourceRows = append(metadata.sourceRows, []driver.Value{"body-id", "VALID", "2026-10-23 01:02:03", int64(i + 1), text + "\n"})
				if strings.Contains(text, scenario) {
					nativeLine = int64(i + 1)
				}
			}
			spec := "PACKAGE " + quoteIdentifier(pkg) + " AS\n FUNCTION " + quoteIdentifier(member) + "(X NUMBER, Y OUT NUMBER) RETURN NUMBER;\n FUNCTION " + quoteIdentifier(member) + "(X VARCHAR2, Y OUT VARCHAR2) RETURN VARCHAR2;\nEND " + quoteIdentifier(pkg) + ";"
			for i, text := range strings.Split(spec, "\n") {
				metadata.specRows = append(metadata.specRows, []driver.Value{metadata.objects[0][0], "VALID", "2026-10-23 01:02:03", int64(i + 1), text + "\n"})
			}
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			stop := plDebugNativeStop{Result: integer(0), Line: integer(nativeLine), Terminated: integer(0), Reason: integer(9), StackDepth: integer(1), Namespace: integer(2), Program: sql.NullString{String: pkg, Valid: true}, Owner: sql.NullString{String: metadata.owner, Valid: true}}
			namespace := int64(2)
			owner := metadata.owner
			payload, _ := json.Marshal([]plDebugNativeStackRecord{{NativeFrameID: 1, Namespace: &namespace, Program: &pkg, Owner: &owner, Line: &nativeLine, NamespaceKind: "package_body"}})
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			native := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payload: string(payload), complete: 1, stops: []plDebugNativeStop{stop}}
			first := &plDebugNamedSourceTestConnector{native: native, metadata: metadata}
			out, returned := "42", "82"
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}, phase: 2, fields: []*string{&out, &returned}, copied: []int64{1, 1}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", plDebugNamedRequest("NUMBER", "3")))
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "named-1"}))
			identity := state["routineIdentity"].(*plDebugNativeRoutineIdentity)
			wantState, wantIdentity := "other_routine", "other_routine"
			if scenario == "selected_marker" {
				wantState, wantIdentity = "reached", "verified"
			}
			if scenario == "init_marker" {
				wantState, wantIdentity = "package_initialization", "package_initialization"
			}
			if state["entryState"] != wantState || identity.State != wantIdentity || identity.EvidenceKind != "source_signature" || state["program"] != pkg || state["sourceMappingState"] != "verified" {
				t.Fatalf("member identity overwrote native container or picked the wrong scope: %#v", state)
			}
			if scenario == "selected_marker" && (identity.SubprogramID == nil || *identity.SubprogramID != 1 || *identity.Name != member) {
				t.Fatal("selected complete signature was not preserved")
			}
			if scenario != "selected_marker" && identity.SubprogramID != nil {
				t.Fatal("another scope borrowed the selected SUBPROGRAM_ID")
			}
			if scenario == "nested_marker" && *identity.Name != "HELPER" {
				t.Fatal("nested scope became its parent")
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 {
				t.Fatal("scope mapping replayed business or lost original cleanup")
			}
		})
	}
}
