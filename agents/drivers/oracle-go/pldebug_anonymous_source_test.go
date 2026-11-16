package main

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

func TestPLDebugNativeAnonymousSourceRPCRequiresWholeFrozenWrapper(t *testing.T) {
	for _, scenario := range []string{"exact", "wrapper_line", "truncated", "gap", "other_frame", "not_anonymous"} {
		t.Run(scenario, func(t *testing.T) {
			source := "\nBEGIN\n  DBMS_OUTPUT.PUT_LINE(q'[值 ' \" ]');\nEND;"
			if scenario == "truncated" {
				source = "BEGIN\n  DBMS_OUTPUT.PUT_LINE('" + strings.Repeat("值", 100) + "');\nEND;"
			}
			template, err := plDebugWrapNativeTarget(source, 0)
			if err != nil {
				t.Fatal(err)
			}
			nativeLine := int64(template.SourceLineOffset + 1)
			if scenario == "wrapper_line" {
				nativeLine = 1
			}
			integer := func(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: true} }
			stop := plDebugNativeStop{Result: integer(0), Line: integer(nativeLine), Terminated: integer(0), Reason: integer(9), StackDepth: integer(1), Namespace: integer(0)}
			status := int64(1)
			bp, _ := json.Marshal([]plDebugNativeBreakpoint{{ID: 77, Line: &nativeLine, Status: &status, LocalActive: true}})
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
			first := &plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: e}, payloads: []string{"[]", "[]", string(bp)}, complete: 1, stops: []plDebugNativeStop{stop}}
			second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			request := map[string]interface{}{"agentSessionId": "a", "operationId": "source-1", "objectType": "ANONYMOUS", "source": source}
			started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			r.mu.RLock()
			entry := r.plNativeEntries["source-1"]
			r.mu.RUnlock()
			namespace := int64(0)
			records := []plDebugNativeStackRecord{{NativeFrameID: 1, Namespace: &namespace, Line: &nativeLine, Anonymous: scenario != "not_anonymous"}}
			stackJSON, _ := json.Marshal(records)
			lines := []plDebugNativeFrameSourceLine{}
			for i, text := range strings.Split(entry.block.SQL, "\n") {
				value := text
				lines = append(lines, plDebugNativeFrameSourceLine{Line: int64(i + 1), Text: &value})
			}
			if scenario == "gap" {
				lines[2].Line = 99
			}
			if scenario == "other_frame" {
				value := *lines[0].Text + " -- another anonymous unit"
				lines[0].Text = &value
			}
			if scenario == "truncated" {
				for i := range lines {
					if len([]rune(*lines[i].Text)) > 90 {
						value := string([]rune(*lines[i].Text)[:90])
						lines[i].Text = &value
					}
				}
			}
			lineJSON, _ := json.Marshal(lines)
			first.payloads = append(first.payloads, string(stackJSON), string(lineJSON))
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "source-1"}))
			frames := state["frames"].([]plDebugNativeStackFrame)
			verified := scenario == "exact" || scenario == "wrapper_line"
			if (frames[0].SourceRef != nil) != verified || state["stopRevision"] != started["stopRevision"] || state["nativeLine"] != int(nativeLine) || state["program"] != "" {
				t.Fatalf("source proof changed raw stop or accepted partial source: %#v", state)
			}
			if scenario == "exact" {
				ref := state["sourceRef"].(*plDebugNativeSourceRef)
				if state["sourceMappingState"] != "verified" || state["entryState"] != "reached" || *frames[0].SourceLine != 1 || ref.Source != source || ref.LineOffset != entry.block.SourceLineOffset || ref.StopRevision != state["stopRevision"] || ref.EvidenceKind != "anonymous_source" || ref.Namespace == nil || *ref.Namespace != 0 {
					t.Fatal("verified wrapper did not map to frozen user source")
				}
			} else if scenario == "wrapper_line" {
				if state["sourceMappingState"] != "unverified" || state["entryState"] != "wrapper" || state["line"] != nil || frames[0].SourceLine != nil {
					t.Fatal("private wrapper line became a user entry")
				}
			}
			if scenario == "not_anonymous" {
				if first.executions != 4 || len(first.sourceBindings) != 0 {
					t.Fatal("NULL name alone triggered anonymous source lookup")
				}
			} else if first.executions != 5 || first.sourceBindings[0].Value != len(lines)+1 || first.sourceBindings[1].Value != int64(1) {
				t.Fatal("source read did not bind the exact frame and one extra EOF line")
			}
			ended := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "source-1"}))
			if ended["sourceMappingState"] != "unverified" || ended["sourceRef"] != nil {
				t.Fatal("old source mapping survived execution")
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "source-1"}))
			if closed["releaseState"] != "released" || e.targetAttempts != 1 || first.sets != 1 || first.deletes != 1 {
				t.Fatal("source lookup replayed target or lost original resources")
			}
		})
	}
}

func TestPLDebugNativeAnonymousSourceComparisonPreservesWhitespaceAndLineBoundaries(t *testing.T) {
	blank := ""
	spaced := "  BEGIN  "
	end := "END;"
	lines := []plDebugNativeFrameSourceLine{{Line: 1, Text: nil}, {Line: 2, Text: &spaced}, {Line: 3, Text: &end}}
	if !plDebugNativeFrameSourceMatches("\n  BEGIN  \nEND;", lines) || !plDebugNativeFrameSourceMatches("\r\n  BEGIN  \r\nEND;", lines) {
		t.Fatal("line ending representation or NULL blank line rejected")
	}
	lines[1].Text = &blank
	if plDebugNativeFrameSourceMatches("\n  BEGIN  \nEND;", lines) {
		t.Fatal("missing content accepted")
	}
	lines[1].Text = &spaced
	if plDebugNativeFrameSourceMatches("\nBEGIN\nEND;", lines) || plDebugNativeFrameSourceMatches("  BEGIN  \nEND;", lines) {
		t.Fatal("source comparison trimmed whitespace or leading blank lines")
	}
}
