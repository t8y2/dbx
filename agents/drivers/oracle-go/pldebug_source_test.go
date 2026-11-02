package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"strings"
	"testing"
)

func TestPLDebugNativeSourceSnapshotPreservesExactContainerAndLines(t *testing.T) {
	c := plDebugTargetFixture()
	db := sql.OpenDB(c)
	defer db.Close()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	pkg := " Pkg.\"\n "
	target := plDebugNativeCandidate{Schema: c.owner, ObjectName: " f.x ", PackageName: &pkg, ObjectType: "FUNCTION", ObjectID: "spec-id"}
	source, err := plDebugLoadNativeSource(context.Background(), conn, target)
	if err != nil {
		t.Fatal(err)
	}
	if source.Name != pkg || source.Owner != c.owner || source.ObjectType != "PACKAGE BODY" || source.ObjectID == target.ObjectID || source.State != "candidate" || len(source.Lines) != 2 || source.Lines[0].Text != "\n" || source.Lines[1].Text != c.sourceRows[1][4] {
		t.Fatalf("source identity or original lines changed: %+v", source)
	}
	if len(c.queries) != 1 || !strings.Contains(c.queries[0], "LEFT JOIN SYS.ALL_SOURCE") || c.bindings[0][0].Value != c.owner || c.bindings[0][1].Value != pkg || c.bindings[0][2].Value != "PACKAGE BODY" {
		t.Fatal("source snapshot was split or identifiers transformed")
	}
}

func TestPLDebugNativeCompileSourceBudgetPreservesInvalidSource(t *testing.T) {
	for _, scenario := range []struct {
		name         string
		bytes, lines int
		wantError    bool
	}{
		{"exact_utf8", 8, 1, false},
		{"short_utf8", 7, 1, true},
		{"no_lines", 8, 0, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			c := plDebugTargetFixture()
			c.sourceRows = [][]driver.Value{{"object", "INVALID", nil, int64(1), "中😀\n"}}
			db := sql.OpenDB(c)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			target := plDebugNativeCandidate{Schema: c.owner, ObjectName: "P", ObjectType: "PROCEDURE", ObjectID: "object"}
			budget := &plDebugNativeSourceBudget{bytes: scenario.bytes, lines: scenario.lines}
			source, err := plDebugLoadNativeSourceBounded(context.Background(), conn, target, budget)
			if (err != nil) != scenario.wantError {
				t.Fatalf("source=%+v error=%v", source, err)
			}
			if err == nil && (source.State != "candidate" || source.Status == nil || *source.Status != "INVALID" || budget.bytes != 0 || budget.lines != 0) {
				t.Fatalf("invalid source or exact budget lost: %+v %+v", source, budget)
			}
		})
	}
}

func TestPLDebugNativeSourceSnapshotDistinguishesMissingAndIncomplete(t *testing.T) {
	for _, scenario := range []string{"not_visible", "source_unavailable", "gap", "duplicate", "conflicting_object", "null_text"} {
		t.Run(scenario, func(t *testing.T) {
			c := plDebugTargetFixture()
			switch scenario {
			case "not_visible":
				c.sourceRows = nil
			case "source_unavailable":
				c.sourceRows = [][]driver.Value{{"object", "VALID", nil, nil, nil}}
			case "gap":
				c.sourceRows[1][3] = int64(3)
			case "duplicate":
				c.sourceRows[1][3] = int64(1)
			case "conflicting_object":
				c.sourceRows[1][0] = "other-object"
			case "null_text":
				c.sourceRows[1][4] = nil
			}
			db := sql.OpenDB(c)
			defer db.Close()
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			id := "body-9007199254740993124"
			if scenario == "source_unavailable" {
				id = "object"
			}
			source, err := plDebugLoadNativeSource(context.Background(), conn, plDebugNativeCandidate{Schema: "Owner", ObjectName: "Procedure", ObjectType: "PROCEDURE", ObjectID: id})
			missing := scenario == "not_visible" || scenario == "source_unavailable"
			if (err == nil) != missing || (missing && source.State != scenario) {
				t.Fatalf("source=%+v error=%v", source, err)
			}
		})
	}
}

func TestPLDebugNativeSourceChangeBeforeDispatchDoesNotExecuteOrReplay(t *testing.T) {
	for _, scenario := range []string{"body_text", "body_object", "spec_default"} {
		t.Run(scenario, func(t *testing.T) {
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			metadata := plDebugTargetFixture()
			metadata.specRows = [][]driver.Value{{metadata.objects[0][0], "VALID", "2026-10-23 01:02:03", int64(1), "package p as procedure f(x number default 1); end;\n"}}
			for _, row := range metadata.sourceRows {
				metadata.sourceNext = append(metadata.sourceNext, append([]driver.Value{}, row...))
			}
			if scenario == "spec_default" {
				metadata.specNext = [][]driver.Value{{metadata.objects[0][0], "VALID", "2026-10-23 01:02:03", int64(1), "package p as procedure f(x number default 2); end;\n"}}
			} else if scenario == "body_text" {
				metadata.sourceNext[1][4] = "changed body; signature and timestamp unchanged\n"
			} else {
				for _, row := range metadata.sourceNext {
					row[0] = "replacement-body"
				}
			}
			first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			request := plDebugNamedRequest("NUMBER", "3")
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if state["startState"] != "failed" || state["targetDispatched"] != false || e.targetAttempts != 0 || !strings.Contains(state["startError"].(string), "changed before dispatch") {
				t.Fatalf("source change not rejected: %#v", state)
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if metadata.sourceReads != 2 || e.targetAttempts != 0 {
				t.Fatal("same operation replayed preflight or business")
			}
			state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
			if state["releaseState"] != "released" {
				t.Fatalf("undispatched source failure lost original cleanup: %#v", state)
			}
		})
	}
}
