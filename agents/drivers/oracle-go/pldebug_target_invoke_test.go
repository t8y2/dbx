package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/converters"
)

type plDebugNamedTestConnector struct {
	metadata          *plDebugTargetTestConnector
	native            *plDebugManagerTestConnector
	phase             int64
	fields            []*string
	copied            []int64
	transferFailureAt int
	prepared          string
	bound             []driver.NamedValue
}

func (c *plDebugNamedTestConnector) Driver() driver.Driver { return c.native.Driver() }
func (c *plDebugNamedTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.native.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugNamedTestConnection{plDebugManagerTestConnection: conn.(*plDebugManagerTestConnection), state: c}, nil
}

type plDebugNamedTestConnection struct {
	*plDebugManagerTestConnection
	state *plDebugNamedTestConnector
}

func (c *plDebugNamedTestConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return (&plDebugTargetTestConnection{plDebugConnectTestConnection: c.plDebugConnectTestConnection, owner: c.state.metadata}).QueryContext(ctx, query, args)
}
func (c *plDebugNamedTestConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	stmt, err := c.plDebugManagerTestConnection.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(query, "_PHASE") {
		return stmt, nil
	}
	c.state.prepared = query
	return &plDebugNamedTestStatement{plDebugManagerTestStatement: stmt.(*plDebugManagerTestStatement), state: c.state}, nil
}

type plDebugNamedTestStatement struct {
	*plDebugManagerTestStatement
	state *plDebugNamedTestConnector
}

func (s *plDebugNamedTestStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	e := s.engine
	e.mu.Lock()
	e.targetAttempts++
	e.mu.Unlock()
	close(e.targetStarted)
	select {
	case <-e.targetRelease:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	e.mu.Lock()
	aborted := e.aborted
	e.mu.Unlock()
	if aborted {
		return nil, errors.New("original named target aborted")
	}
	s.state.bound = append([]driver.NamedValue{}, args...)
	prefix := len(args) - 7
	phaseIndex := prefix - 1 - 2*len(s.state.fields)
	if err := plDebugManagerSetOut(args[phaseIndex], sql.NullInt64{Int64: s.state.phase, Valid: true}); err != nil {
		return nil, err
	}
	for i, value := range s.state.fields {
		if s.state.transferFailureAt == i+1 {
			return nil, errors.New("injected result transfer failure")
		}
		var text sql.NullString
		if value != nil {
			text = sql.NullString{String: *value, Valid: true}
		}
		if err := plDebugManagerSetOut(args[phaseIndex+1+2*i], text); err != nil {
			return nil, err
		}
		if err := plDebugManagerSetOut(args[phaseIndex+2+2*i], sql.NullInt64{Int64: s.state.copied[i], Valid: true}); err != nil {
			return nil, err
		}
	}
	return s.plDebugCaptureTestStatement.ExecContext(ctx, args)
}

func plDebugNamedRequest(kind, value string) map[string]interface{} {
	var input interface{} = value
	state := "value"
	if value == "<NULL>" {
		input = nil
		state = "null"
	}
	return map[string]interface{}{"agentSessionId": "a", "operationId": "named-1", "objectType": "FUNCTION", "packageName": " Pkg.\"\n ", "objectName": " f.x ", "params": []interface{}{
		map[string]interface{}{"name": "X", "mode": "IN", "type": kind, "inputState": state, "value": input}, map[string]interface{}{"name": "Y", "mode": "OUT", "type": kind},
	}}
}

func TestPLDebugNativeNamedRPCUsesTypedLocalsAndIndependentReturn(t *testing.T) {
	for _, kind := range []string{"NUMBER", "VARCHAR2"} {
		for _, null := range []bool{false, true} {
			t.Run(kind+map[bool]string{true: "/null", false: "/value"}[null], func(t *testing.T) {
				e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
				metadata := plDebugTargetFixture()
				first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
				output, returned := "9007199254740993.123456789", "82"
				input := "9007199254740993.123456789"
				if kind == "VARCHAR2" {
					input = "000123.45 ' 😀"
					output = "typed text😀"
					returned = "return value"
				}
				fields := []*string{&output, &returned}
				if null {
					input = "<NULL>"
					fields = []*string{nil, nil}
				}
				second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{output: "named output😀\n\n", complete: 1}}, phase: 2, fields: fields, copied: []int64{1, 1}}
				r := plDebugPairTestRuntime(first, second)
				if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
					t.Fatal(resp.Error)
				}
				request := plDebugNamedRequest(kind, input)
				started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
				if started["startState"] != "succeeded" || started["program"] != "raw, run_info.reason = 25\nname" || started["outParamsState"] != "pending" {
					t.Fatalf("start replaced native identity or published live OUT registers: %#v", started)
				}
				state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
				if state["executionOutcome"] != "succeeded" || state["executionStage"] != "returned" || state["outParamsState"] != "available" {
					t.Fatalf("typed business receipt missing: %#v", state)
				}
				params := state["outParams"].([]map[string]interface{})
				ret := state["returnValue"].(map[string]interface{})
				if len(params) != 1 || params[0]["name"] != "Y" || params[0]["type"] != kind || ret["type"] != kind {
					t.Fatal("return was mixed into OUT parameters or declared types lost")
				}
				if null {
					if params[0]["state"] != "null" || ret["state"] != "null" || params[0]["value"] != nil {
						t.Fatal("typed NULL became empty/unavailable")
					}
				} else if params[0]["value"] != output || ret["value"] != returned {
					t.Fatalf("typed values rounded or changed: %#v %#v", params, ret)
				}
				bound := second.bound[0].Value
				if null {
					if bound != nil {
						t.Fatal("explicit NULL was not bound")
					}
				} else if kind == "NUMBER" {
					number, ok := bound.(*go_ora.Number)
					if !ok {
						t.Fatalf("NUMBER was bound as %T", bound)
					}
					text, err := number.String()
					if err != nil || text != input {
						t.Fatal("real thin NUMBER encoder lost exact value")
					}
				} else if bound != input {
					t.Fatal("VARCHAR2 input was transformed or interpolated")
				}
				if strings.Contains(second.prepared, input) && !null && kind == "VARCHAR2" {
					t.Fatal("input value was interpolated into SQL")
				}
				line := state["wrapperCallLine"].(int)
				lines := strings.Split(second.prepared, "\n")
				if line < 1 || line > len(lines) || !strings.Contains(lines[line-1], quoteIdentifier(metadata.owner)+".") || !strings.Contains(strings.Join(lines[line-1:], "\n"), `" f.x "`) {
					t.Fatal("generated call-line offset does not identify the actual invocation")
				}
				if state["sourceMappingState"] != "unverified" {
					t.Fatal("fake driver was promoted to real source-location verification")
				}
				r.mu.RLock()
				entry := r.plNativeEntries["named-1"]
				r.mu.RUnlock()
				<-entry.captureDone
				state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
				if state["releaseState"] != "released" || second.native.base.tx.base.execs != 1 || e.targetAttempts != 1 || second.native.base.tx.rollbacks != 1 || first.native.base.tx.base.closes != 1 || second.native.base.tx.base.closes != 1 {
					t.Fatal("named execution or original release was replayed")
				}
			})
		}
	}
}

func TestPLDebugNativeNamedPartialResultDoesNotEraseBusinessSuccess(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	metadata := plDebugTargetFixture()
	first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
	one, two := "42", "82"
	second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}, phase: 2, fields: []*string{&one, &two}, copied: []int64{1, 1}, transferFailureAt: 2}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", plDebugNamedRequest("NUMBER", "3")))
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
	if state["executionOutcome"] != "succeeded" || state["outParamsState"] != "partial" || state["businessCode"] != int64(0) {
		t.Fatalf("export failure replaced known business return: %#v", state)
	}
	if state["outParams"].([]map[string]interface{})[0]["value"] != "42" || state["returnValue"].(map[string]interface{})["state"] != "error" {
		t.Fatal("partial result discarded valid OUT or invented unread NULL")
	}
	r.mu.RLock()
	entry := r.plNativeEntries["named-1"]
	r.mu.RUnlock()
	select {
	case <-entry.captureDone:
	case <-time.After(time.Second):
		t.Fatal("failed result transfer did not finish its original references")
	}
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
	if state["executionOutcome"] != "succeeded" || state["releaseState"] != "unknown" || e.targetAttempts != 1 || e.controls != 1 {
		t.Fatal("unknown output recovery replayed or rewrote successful business execution")
	}
}

func TestPLDebugNativeNamedWrapperDefaultAndPhaseFailures(t *testing.T) {
	text := func(s string) *string { return &s }
	x := plDebugNativeArgument{Name: text("X"), Position: 1, Sequence: 1, Mode: "IN OUT", Type: "NUMBER"}
	y := plDebugNativeArgument{Name: text("Y"), Position: 2, Sequence: 2, Mode: "IN", Type: "VARCHAR2", Defaulted: text("Y")}
	plan := &plDebugNativePlan{target: plDebugNativeCandidate{Schema: "Owner", ObjectName: "Run", ObjectType: "PROCEDURE"}, arguments: []plDebugNativeInput{{argument: x, state: "value", value: "3"}, {argument: y, state: "default"}}}
	block, err := plan.block()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(block.SQL, `"Y" =>`) || !strings.Contains(block.SQL, `"X" =>`) || !strings.Contains(block.SQL, "_PHASE < 2 THEN") {
		t.Fatal("default was bound or export failure can roll back a returned call")
	}
	for _, name := range block.PrivateNames {
		if len(name) > 30 {
			t.Fatal("named private identifier exceeded legacy Oracle limit")
		}
	}
	call, err := plan.bind(false)
	if err != nil {
		t.Fatal(err)
	}
	call.phase = sql.NullInt64{Int64: 1, Valid: true}
	result := call.result(plDebugNativeCapture{Code: sql.NullInt64{Int64: -20001, Valid: true}}, nil)
	if result["executionOutcome"] != "failed" || result["outParamsState"] != "unavailable" {
		t.Fatal("business failure published unassigned OUT")
	}
	call.phase.Int64 = 0
	if result = call.result(plDebugNativeCapture{Code: sql.NullInt64{Int64: -6502, Valid: true}}, nil); result["executionOutcome"] != "not_started" {
		t.Fatal("input preparation failure was reported as executed business")
	}
	call.phase.Valid = false
	if result = call.result(plDebugNativeCapture{Code: sql.NullInt64{Int64: 0, Valid: true}}, nil); result["executionOutcome"] != "unknown" {
		t.Fatal("missing execution phase was guessed from wrapper success")
	}
	call.phase = sql.NullInt64{Int64: 2, Valid: true}
	call.copied[0] = sql.NullInt64{Int64: -1, Valid: true}
	if result = call.result(plDebugNativeCapture{}, nil); result["executionOutcome"] != "succeeded" || result["outParamsState"] != "partial" {
		t.Fatal("per-field server export error changed business success")
	}
}

func TestPLDebugNativeTypedInitializationAndExportPhases(t *testing.T) {
	plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{SignatureVersion: 2}}
	call, err := plan.bind(false)
	if err != nil {
		t.Fatal(err)
	}
	call.phase = sql.NullInt64{Int64: -1, Valid: true}
	capture := plDebugNativeCapture{Code: sql.NullInt64{Int64: -20071, Valid: true}, Message: sql.NullString{String: "default initializer failed", Valid: true}}
	result := call.result(capture, nil)
	if result["executionStage"] != "argument_initialization" || result["executionOutcome"] != "not_started" || result["outParamsState"] != "unavailable" || result["inputError"] != "default initializer failed" {
		t.Fatal("initialization failure lost its stage or published unassigned results")
	}
	call.phase.Int64 = 3
	result = call.result(plDebugNativeCapture{}, nil)
	if result["executionOutcome"] != "succeeded" || result["outParamsState"] != "available" {
		t.Fatal("finished export was not accepted as a returned target")
	}
	plan.typedSignature = nil
	if call.result(plDebugNativeCapture{}, nil)["executionOutcome"] != "unknown" {
		t.Fatal("new phase values leaked into the legacy receipt contract")
	}
}

func TestPLDebugNativeTypedResultRejectsMalformedScalar(t *testing.T) {
	for _, profile := range []bool{false, true} {
		for _, sample := range []struct{ kind, value string }{
			{"PL/SQL BOOLEAN", "TRUE"},
			{"DATE", "2025-02-29T00:00:00"},
			{"TIMESTAMP", "2024-01-01T00:00:00.1234567890"},
		} {
			name := "X"
			argument := plDebugNativeArgument{Name: &name, Position: 1, Mode: "OUT", Type: sample.kind}
			plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{SignatureVersion: 2}, arguments: []plDebugNativeInput{{argument: argument}}}
			call, err := plan.bind(profile)
			if err != nil {
				t.Fatal(err)
			}
			call.phase = sql.NullInt64{Int64: 3, Valid: true}
			call.copied[0] = sql.NullInt64{Int64: 1, Valid: true}
			if profile {
				call.ociValues[0] = sample.value
			} else {
				call.values[0] = sql.NullString{String: sample.value, Valid: true}
			}
			result := call.result(plDebugNativeCapture{}, nil)
			field := result["outParams"].([]map[string]interface{})[0]
			if result["executionOutcome"] != "succeeded" || result["outParamsState"] != "partial" || field["state"] != "error" || field["value"] != nil {
				t.Fatalf("malformed %s was accepted or changed business outcome: %#v", sample.kind, result)
			}
		}
	}
}

func TestPLDebugNativeNamedProcedureINOUTDefaultAndZeroArguments(t *testing.T) {
	for _, zero := range []bool{false, true} {
		t.Run(map[bool]string{false: "inout_default", true: "zero_arguments"}[zero], func(t *testing.T) {
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			metadata := plDebugTargetFixture()
			metadata.subprograms = [][]driver.Value{{int64(1)}}
			for _, row := range metadata.sourceRows {
				row[0] = metadata.objects[0][0]
			}
			metadata.arguments[1] = [][]driver.Value{plDebugTargetArgument("X", 1, 1, 0, "IN OUT", "NUMBER", "N"), plDebugTargetArgument("Y", 2, 2, 0, "IN", "VARCHAR2", "Y")}
			params := []interface{}{map[string]interface{}{"name": "X", "mode": "IN OUT", "type": "NUMBER", "value": "3"}, map[string]interface{}{"name": "Y", "mode": "IN", "type": "VARCHAR2", "inputState": "default"}}
			output := "42"
			fields := []*string{&output}
			copied := []int64{1}
			if zero {
				metadata.arguments[1] = nil
				params = nil
				fields = nil
				copied = nil
			}
			first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}, phase: 2, fields: fields, copied: copied}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			request := map[string]interface{}{"agentSessionId": "a", "operationId": "procedure-1", "schema": "Case Owner", "objectType": "PROCEDURE", "objectName": " P ", "params": params}
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if state["startState"] != "succeeded" {
				t.Fatalf("procedure did not start: %#v", state)
			}
			state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "procedure-1"}))
			if state["executionOutcome"] != "succeeded" || state["returnValue"] != nil {
				t.Fatalf("procedure invented a function return: %#v", state)
			}
			out := state["outParams"].([]map[string]interface{})
			if zero {
				if len(out) != 0 {
					t.Fatal("zero argument procedure invented parameters")
				}
			} else if len(out) != 1 || out[0]["mode"] != "IN OUT" || out[0]["value"] != "42" || strings.Contains(second.prepared, `"Y" =>`) {
				t.Fatal("IN OUT or default omission lost actual semantics")
			}
			r.mu.RLock()
			entry := r.plNativeEntries["procedure-1"]
			r.mu.RUnlock()
			<-entry.captureDone
			state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "procedure-1"}))
			if state["releaseState"] != "released" || e.targetAttempts != 1 || second.native.base.tx.rollbacks != 1 {
				t.Fatal("procedure target or transaction cleanup was replayed")
			}
		})
	}
}

func TestPLDebugNativeNamedPreflightFailureReleasesOnlyOriginalController(t *testing.T) {
	for _, scenario := range []string{"stale_signature", "out_input", "invalid_number", "unsupported_adapter"} {
		t.Run(scenario, func(t *testing.T) {
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			metadata := plDebugTargetFixture()
			first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			request := plDebugNamedRequest("NUMBER", "3")
			params := request["params"].([]interface{})
			switch scenario {
			case "stale_signature":
				preview := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resolve_target", plDebugTargetRequest()))
				signature, _ := plDebugNativeJSONValue(preview["candidates"].([]map[string]interface{})[0]["signature"])
				request["targetSignature"] = signature
				metadata.objects[0][0] = "9007199254740993124"
			case "out_input":
				params[1].(map[string]interface{})["value"] = "must not be accepted"
			case "invalid_number":
				params[0].(map[string]interface{})["value"] = "not-a-number"
			case "unsupported_adapter":
				metadata.arguments[1][2][5] = "DATE"
				params[1].(map[string]interface{})["type"] = "DATE"
			}
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if state["startState"] != "failed" || state["targetDispatched"] != false || state["executionOutcome"] != "not_started" {
				t.Fatalf("preflight failure executed a target: %#v", state)
			}
			r.mu.RLock()
			entry := r.plNativeEntries["named-1"]
			r.mu.RUnlock()
			select {
			case <-entry.startOwnerDone:
			case <-time.After(time.Second):
				t.Fatal("preflight rejection did not finish its original cleanup owner")
			}
			state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "named-1"}))
			if state["releaseState"] != "released" || state["closeReason"] != "preflight_rejected" || len(r.sessions) != 0 || first.native.base.tx.base.closes != 1 || second.native.base.tx.base.connects != 0 || e.targetAttempts != 0 || len(e.queries) != 0 {
				t.Fatalf("preflight rejection retained clean resources or initialized/replayed a target: %#v", state)
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", request))
			if first.native.base.tx.base.connects != 1 || second.native.base.tx.base.connects != 0 {
				t.Fatal("failed receipt replayed preflight or target allocation")
			}
		})
	}
}

func TestPLDebugNativeNamedFailuresRespectBusinessPhase(t *testing.T) {
	for _, phase := range []int64{0, 1} {
		t.Run(map[int64]string{0: "input_preparation", 1: "business_exception"}[phase], func(t *testing.T) {
			e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			metadata := plDebugTargetFixture()
			first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
			second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{output: "before failure\n", code: -20001, message: "original failure", rollback: 1, complete: 1}}, phase: phase, fields: []*string{nil, nil}, copied: []int64{0, 0}}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", plDebugNamedRequest("NUMBER", "3")))
			state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
			outcome := "not_started"
			if phase == 1 {
				outcome = "failed"
			}
			if state["executionOutcome"] != outcome || state["outParamsState"] != "unavailable" || state["returnValue"].(map[string]interface{})["state"] != "unavailable" || state["savepointRollback"] != int64(1) {
				t.Fatalf("failure manufactured completed results or lost rollback facts: %#v", state)
			}
			if phase == 0 {
				if state["businessCode"] != nil || state["inputError"] != "original failure" || state["wrapperCode"] != int64(-20001) {
					t.Fatal("input preparation error was mislabeled as a business failure")
				}
			} else if state["businessCode"] != int64(-20001) {
				t.Fatal("business exception lost its original code")
			}
			r.mu.RLock()
			entry := r.plNativeEntries["named-1"]
			r.mu.RUnlock()
			<-entry.captureDone
			state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
			if state["releaseState"] != "released" || e.targetAttempts != 1 || second.native.base.tx.rollbacks != 1 {
				t.Fatal("failed wrapper execution was replayed or its resources forgotten")
			}
		})
	}
}

func TestPLDebugNativeNamedNumberUsesRealDriverWireEncoder(t *testing.T) {
	name := "X"
	argument := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN", Type: "NUMBER"}
	for _, input := range []string{"0", "0.5", "-0.5", "1e-128", "1e-129", "1e-130", "-1e-130", "1e125", "9007199254740993.123456789", "-9007199254740993.123456789", "1234567890123456789012345678901234567891", "-1234567890123456789012345678901234567891"} {
		t.Run(input, func(t *testing.T) {
			canonical, err := plDebugNativeDecimal(input)
			if err != nil {
				t.Fatal(err)
			}
			plan := &plDebugNativePlan{arguments: []plDebugNativeInput{{argument: argument, state: "value", value: canonical}}}
			call, err := plan.bind(false)
			if err != nil {
				t.Fatal(err)
			}
			// NewParam exercises the locked go-ora bind encoder without opening a
			// network transport. The NUMBER datatype, bytes and decoder are real.
			connection := &go_ora.Connection{State: go_ora.Opened}
			statement := go_ora.NewStmt("BEGIN NULL; END;", connection)
			parameter, err := statement.NewParam("value", call.arguments[0], 0, go_ora.Input)
			if err != nil {
				t.Fatal(err)
			}
			if parameter.DataType != go_ora.NUMBER || len(parameter.BValue) > parameter.MaxLen {
				t.Fatalf("numeric value exceeded its real wire bind type/capacity: bytes=%d max=%d", len(parameter.BValue), parameter.MaxLen)
			}
			decoded, err := converters.NumberToString(parameter.BValue)
			if err != nil {
				t.Fatal(err)
			}
			decoded, err = plDebugNativeDecimal(decoded)
			if err != nil || decoded != strings.TrimPrefix(canonical, "-") {
				t.Fatalf("actual NUMBER wire rounded or changed %s to %s: %v", canonical, decoded, err)
			}
			body := plan.render("DBX_TEST_")
			sign := ""
			if strings.HasPrefix(canonical, "-") {
				sign = "-"
			}
			if !strings.Contains(body.Source, " := "+sign+":1;") {
				t.Fatal("typed local did not restore the exact NUMBER sign")
			}
		})
	}
	for _, input := range []string{"1.234567890123456789012345678901234567891", "123456789012345678901234567890123456789123"} {
		canonical, err := plDebugNativeDecimal(input)
		if err != nil {
			t.Fatal(err)
		}
		plan := &plDebugNativePlan{arguments: []plDebugNativeInput{{argument: argument, state: "value", value: canonical}}}
		if _, err = plan.bind(false); err == nil || !strings.Contains(err.Error(), "exact 20-base-100") {
			t.Fatal("non-exact NUMBER capacity was silently rounded or passed as an oversized bind")
		}
	}
}

func TestPLDebugNativeNamedSignedInputKeepsTypedCallAndResults(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	metadata := plDebugTargetFixture()
	first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
	out, returned := "-42.5", "-82"
	second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}, phase: 2, fields: []*string{&out, &returned}, copied: []int64{1, 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	input := "-9007199254740993.123456789"
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", plDebugNamedRequest("NUMBER", input)))
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
	if state["outParams"].([]map[string]interface{})[0]["value"] != out || state["returnValue"].(map[string]interface{})["value"] != returned || !strings.Contains(second.prepared, " := -:1;") {
		t.Fatal("signed typed locals or signed returned values changed")
	}
	statement := go_ora.NewStmt("BEGIN NULL; END;", &go_ora.Connection{State: go_ora.Opened})
	parameter, err := statement.NewParam("value", second.bound[0].Value, 0, go_ora.Input)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := converters.NumberToString(parameter.BValue)
	if err != nil || decoded != strings.TrimPrefix(input, "-") {
		t.Fatal("signed target used invalid negative bind bytes instead of an exact typed magnitude")
	}
	r.mu.RLock()
	entry := r.plNativeEntries["named-1"]
	r.mu.RUnlock()
	<-entry.captureDone
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
	if state["releaseState"] != "released" || e.targetAttempts != 1 || second.native.base.tx.rollbacks != 1 {
		t.Fatal("signed target or cleanup replayed")
	}
}

func TestPLDebugNativeNamedLongTextKeepsDeclaredOutputBufferAndCachedValues(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	metadata := plDebugTargetFixture()
	first := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e}}
	value := strings.Repeat("中😀", 4000) + "\n\t'\x00 tail"
	returned := "return\n" + value
	second := &plDebugNamedTestConnector{metadata: metadata, native: &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}, phase: 2, fields: []*string{&value, &returned}, copied: []int64{1, 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", plDebugNamedRequest("VARCHAR2", value)))
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "named-1"}))
	if state["outParams"].([]map[string]interface{})[0]["value"] != value || state["returnValue"].(map[string]interface{})["value"] != returned {
		t.Fatal("long typed OUT or return was truncated/escaped/reordered")
	}
	for _, index := range []int{2, 4} {
		if out, ok := second.bound[index].Value.(go_ora.Out); !ok || out.Size != 32767 {
			t.Fatal("named text OUT used the legacy 4000-character bind size")
		}
	}
	r.mu.RLock()
	entry := r.plNativeEntries["named-1"]
	r.mu.RUnlock()
	<-entry.captureDone
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "named-1"}))
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "named-1"}))
	if state["outParams"].([]map[string]interface{})[0]["value"] != value || state["returnValue"].(map[string]interface{})["value"] != returned || e.targetAttempts != 1 {
		t.Fatal("closing or status reads lost/replayed completed values")
	}
}
