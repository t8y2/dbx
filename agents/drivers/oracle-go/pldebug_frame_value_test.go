package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type plDebugFrameValueTestConnector struct {
	plDebugBreakpointTestConnector
	read     func(context.Context, []driver.NamedValue) (driver.Result, error)
	write    func(context.Context, []driver.NamedValue) (driver.Result, error)
	metadata *plDebugTargetTestConnector
}

func TestPLDebugNativeVariablesRPCReadsAnonymousDeclarationsOnOriginalFrame(t *testing.T) {
	integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
	engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{
		plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine}, payload: "[]", complete: 1,
		stops: []plDebugNativeStop{{Result: integer(0), Terminated: integer(0), StackDepth: integer(1), Reason: integer(9)}},
	}}
	second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
	names := []string{}
	failName := ""
	first.read = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
		name := args[0].Value.(string)
		names = append(names, name)
		if args[1].Value != 1 {
			t.Fatalf("enumeration escaped original native frame: %#v", args)
		}
		if name == failName {
			return nil, errors.New("ORA-01031: insufficient privileges")
		}
		code, value := integer(0), sql.NullString{String: "9007199254740993123456789", Valid: true}
		if name == "V_NULL" {
			code, value = integer(plDebugErrNullValue), sql.NullString{}
		}
		if err := plDebugManagerSetOut(args[2], code); err != nil {
			return nil, err
		}
		if err := plDebugManagerSetOut(args[3], value); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), nil
	}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{
		"agentSessionId": "a", "operationId": "variables-anonymous", "objectType": "ANONYMOUS",
		"source": "DECLARE\n V_N\n NUMBER;\n V_NULL VARCHAR2(10);\nBEGIN NULL; END;",
	}))
	t.Cleanup(func() {
		plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "variables-anonymous"})
	})
	got := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_variables", map[string]interface{}{
		"debugId": "variables-anonymous", "frame": 0, "stopRevision": start["stopRevision"],
	}))
	variables, ok := got["variables"].([]plDebugNativeVariable)
	if !ok || len(variables) != 2 || len(names) != 2 || names[0] != "V_N" || names[1] != "V_NULL" {
		t.Fatalf("declaration discovery lost multiline names: %#v / %#v", got, names)
	}
	if variables[0].Value == nil || *variables[0].Value != "9007199254740993123456789" || variables[1].State != "null" || variables[1].Value != nil {
		t.Fatalf("enumeration changed exact numeric/NULL values: %+v", variables)
	}
	if variables[0].Type == nil || *variables[0].Type != "NUMBER" || variables[1].Type == nil || *variables[1].Type != "VARCHAR2(10)" {
		t.Fatalf("enumeration lost declared source types: %+v", variables)
	}
	failName = "V_N"
	partial := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_variables", map[string]interface{}{
		"debugId": "variables-anonymous", "frame": 0, "stopRevision": start["stopRevision"],
	}))
	items := partial["variables"].([]plDebugNativeVariable)
	if partial["variablesComplete"] != false || len(items) != 2 || items[0].State != "error" || items[0].Message == nil || !strings.Contains(*items[0].Message, "ORA-01031") || items[1].State != "null" {
		t.Fatalf("enumeration discarded partial values or read error: %#v", partial)
	}
	if first.base.tx.base.connects != 1 || second.base.tx.base.connects != 1 || engine.targetAttempts != 1 || first.sets != 0 {
		t.Fatal("enumeration opened another allocation, replayed target, or installed breakpoint/helper state")
	}
}

func TestPLDebugNativeVariablesRPCDiscoversOuterFrameWithoutBorrowingTargetParameters(t *testing.T) {
	integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
	metadata := plDebugTargetFixture()
	metadata.objects = [][]driver.Value{{"100", "PROCEDURE"}}
	metadata.sourceRows = [][]driver.Value{{"100", "VALID", "2026-10-25 00:00:00", int64(1), "PROCEDURE outer_proc(p_outer NUMBER) IS\n"}, {"100", "VALID", "2026-10-25 00:00:00", int64(2), " outer_local NUMBER; BEGIN NULL; END;\n"}}
	engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{
		plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine}, payload: "[]", complete: 1,
		stops: []plDebugNativeStop{{Result: integer(0), Terminated: integer(0), StackDepth: integer(2), Reason: integer(9)}},
	}, metadata: metadata}
	second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
	names := []string{}
	first.read = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
		names = append(names, args[0].Value.(string))
		if args[1].Value != 1 {
			t.Fatalf("outer variable used another native frame: %#v", args)
		}
		if err := plDebugManagerSetOut(args[2], integer(0)); err != nil {
			return nil, err
		}
		if err := plDebugManagerSetOut(args[3], sql.NullString{String: "11", Valid: true}); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), nil
	}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "outer-vars", "objectType": "ANONYMOUS", "source": "DECLARE target_only NUMBER; BEGIN NULL; END;"}))
	t.Cleanup(func() { plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "outer-vars"}) })
	owner, program, namespace, line := "Outer.Owner", "outer_proc", int64(1), int64(2)
	entry := r.plNativeEntries["outer-vars"]
	entry.mu.Lock()
	entry.nativeStack = &plDebugNativeStack{StopRevision: entry.stopRevision, MappingState: "verified", Frames: []plDebugNativeStackFrame{{FrameIndex: 1, IdentityState: "native", plDebugNativeStackRecord: plDebugNativeStackRecord{NativeFrameID: 1, Owner: &owner, Program: &program, Namespace: &namespace, Line: &line}}}}
	entry.mu.Unlock()
	got := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_variables", map[string]interface{}{"debugId": "outer-vars", "frame": 1, "stopRevision": start["stopRevision"]}))
	variables := got["variables"].([]plDebugNativeVariable)
	if len(variables) != 2 || len(names) != 2 || names[0] != "P_OUTER" || names[1] != "OUTER_LOCAL" || got["variablesComplete"] != true || got["nativeFrameId"] != 1 {
		t.Fatalf("outer discovery mixed source/parameters: %#v names=%#v", got, names)
	}
	if first.base.tx.base.connects != 1 || second.base.tx.base.connects != 1 || engine.targetAttempts != 1 || len(metadata.queries) != 2 {
		t.Fatal("outer inspection opened a replacement allocation or replayed target")
	}
	metadata.queryError = errors.New("ORA-01031: frame source metadata denied")
	partial := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_variables", map[string]interface{}{"debugId": "outer-vars", "frame": 1, "stopRevision": start["stopRevision"]}))
	if partial["variablesComplete"] != false || !strings.Contains(partial["variablesError"].(string), "ORA-01031") || len(names) != 2 {
		t.Fatalf("metadata denial became a confirmed empty frame or used target fallback: %#v", partial)
	}
	before := len(metadata.queries)
	if resp := plDebugManagerRPC(t, r, "pl_debug_get_variables", map[string]interface{}{"debugId": "outer-vars", "frame": 1, "stopRevision": -1}); resp.Error == nil || len(metadata.queries) != before || len(names) != 2 {
		t.Fatal("stale outer stop dispatched metadata/value reads")
	}
}

func TestPLDebugNativeVariablesRPCReadsExternalSpecOnOriginalFrame(t *testing.T) {
	fixture, metadata := plDebugExternalPackageVariableFixture(t)
	integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
	engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
	first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine}, payload: "[]", complete: 1, stops: []plDebugNativeStop{{Result: integer(0), Terminated: integer(0), StackDepth: integer(2), Reason: integer(9)}}}, metadata: metadata}
	second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
	names := []string{}
	first.read = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
		name := args[0].Value.(string)
		names = append(names, name)
		if args[1].Value != 1 {
			t.Fatalf("external variable escaped original native frame: %#v", args)
		}
		code, value := integer(0), sql.NullString{String: "31", Valid: true}
		if name == "PUBLIC_VALUE" {
			code, value = integer(plDebugErrNullValue), sql.NullString{}
		}
		if err := plDebugManagerSetOut(args[2], code); err != nil {
			return nil, err
		}
		if err := plDebugManagerSetOut(args[3], value); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), nil
	}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "external-vars", "objectType": "ANONYMOUS", "source": "BEGIN NULL;END;"}))
	t.Cleanup(func() { plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "external-vars"}) })
	entry := r.plNativeEntries["external-vars"]
	entry.mu.Lock()
	frame := fixture.nativeStack.Frames[0]
	frame.FrameIndex = 1
	frame.SourceRef.StopRevision = entry.stopRevision
	entry.nativeStack = &plDebugNativeStack{StopRevision: entry.stopRevision, MappingState: "verified", Frames: []plDebugNativeStackFrame{frame}}
	entry.mu.Unlock()
	params := map[string]interface{}{"debugId": "external-vars", "frame": 1, "stopRevision": start["stopRevision"]}
	got := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_variables", params))
	variables := got["variables"].([]plDebugNativeVariable)
	if got["variablesComplete"] != true || got["nativeFrameId"] != 1 || len(variables) != 2 || !reflect.DeepEqual(names, []string{"LOCAL_VALUE", "PUBLIC_VALUE"}) || variables[1].State != "null" {
		t.Fatalf("external spec discovery/value context lost: %#v names=%#v", got, names)
	}
	metadata.objectsByType["PACKAGE"] = nil
	partial := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_variables", params))
	items := partial["variables"].([]plDebugNativeVariable)
	if partial["variablesComplete"] != false || len(items) != 1 || items[0].Name != "LOCAL_VALUE" || items[0].Value == nil || *items[0].Value != "31" || partial["variablesError"] == "" {
		t.Fatalf("spec failure discarded local value: %#v", partial)
	}
	if first.base.tx.base.connects != 1 || second.base.tx.base.connects != 1 || engine.targetAttempts != 1 || first.sets != 0 {
		t.Fatal("external discovery replaced connection, replayed, or installed state")
	}
}

func TestPLDebugNativeFrameValueCloseCancelsOnlyOriginalReadWithoutReplay(t *testing.T) {
	for _, method := range []string{"pl_debug_get_value", "pl_debug_set_value", "pl_debug_get_variables"} {
		t.Run(method, func(t *testing.T) {
			engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{})}
			first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{
				plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine}, payload: "[]", complete: 1,
			}}
			second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
			entered := make(chan struct{})
			calls := 0
			first.read = func(ctx context.Context, _ []driver.NamedValue) (driver.Result, error) {
				calls++
				close(entered)
				<-ctx.Done()
				return nil, ctx.Err()
			}
			first.write = first.read
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "value-close", "objectType": "ANONYMOUS", "source": "DECLARE N NUMBER; BEGIN NULL; END;"}))
			params := map[string]interface{}{"debugId": "value-close", "operationId": "value-action", "name": "N", "frame": 0, "stopRevision": started["stopRevision"], "value": "1"}
			done := make(chan response, 1)
			go func() { done <- plDebugManagerRPC(t, r, method, params) }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("read did not enter the original controller")
			}
			busyParams := map[string]interface{}{}
			for key, value := range params {
				busyParams[key] = value
			}
			busyParams["operationId"] = "other-value-action"
			if resp := plDebugManagerRPC(t, r, method, busyParams); resp.Error == nil {
				t.Fatal("busy original controller accepted another read")
			}
			r.mu.RLock()
			entry := r.plNativeEntries["value-close"]
			r.mu.RUnlock()
			entry.mu.Lock()
			entry.cleanupDeadline = time.Now().Add(100 * time.Millisecond)
			entry.mu.Unlock()
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "value-close"}))
			select {
			case resp := <-done:
				if resp.Error == nil {
					t.Fatal("canceled read published a current scalar value")
				}
				data := rpcDiagnostics(t, resp)
				if data["category"] != "canceled" || data["sessionDisposition"] != "quarantine" || data["operationOutcome"] != "unknown" {
					t.Fatalf("canceled read broke the existing typed error contract: %#v", data)
				}
			case <-time.After(time.Second):
				t.Fatal("original action owner did not complete after cancellation")
			}
			if closed["releaseState"] != "unknown" || first.base.tx.base.closes != 0 || second.base.tx.base.closes != 0 || calls != 1 {
				t.Fatal("canceled thin allocation was released, replaced, or replayed")
			}
			if resp := plDebugManagerRPC(t, r, method, params); resp.Error == nil || calls != 1 {
				t.Fatal("closed entry accepted another native read")
			}
		})
	}
}

func TestPLDebugNativeFrameValueRejectsUnverifiedDepthAndKeepsUnknownCallOwned(t *testing.T) {
	for _, scenario := range []string{"unknown_depth", "missing_result", "panic"} {
		t.Run(scenario, func(t *testing.T) {
			integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
			stop := plDebugNativeStop{Result: integer(0), Terminated: integer(0), StackDepth: integer(2), Reason: integer(9)}
			if scenario == "unknown_depth" {
				stop.StackDepth = sql.NullInt64{}
			}
			engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
			first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{
				plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine}, payload: "[]", complete: 1, stops: []plDebugNativeStop{stop},
			}}
			second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
			calls := 0
			first.read = func(_ context.Context, _ []driver.NamedValue) (driver.Result, error) {
				calls++
				if scenario == "panic" {
					panic("native read panic")
				}
				return driver.RowsAffected(0), nil
			}
			r := plDebugPairTestRuntime(first, second)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			started := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": scenario, "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
			if resp := plDebugManagerRPC(t, r, "pl_debug_get_value", map[string]interface{}{"debugId": scenario, "name": "N", "frame": 0, "stopRevision": started["stopRevision"]}); resp.Error == nil {
				t.Fatal("unverified native read returned a scalar")
			}
			wantCalls := 1
			if scenario == "unknown_depth" {
				wantCalls = 0
			}
			if calls != wantCalls {
				t.Fatal("invalid depth dispatched SQL or uncertain call replayed")
			}
			r.mu.RLock()
			entry := r.plNativeEntries[scenario]
			r.mu.RUnlock()
			entry.mu.Lock()
			busy := entry.actionBusy
			entry.cleanupDeadline = time.Now().Add(100 * time.Millisecond)
			entry.mu.Unlock()
			if busy {
				t.Fatal("failed read lost original action completion")
			}
			closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": scenario}))
			if scenario == "panic" {
				if closed["releaseState"] != "unknown" || first.base.tx.base.closes != 0 {
					t.Fatal("panic released uncertain original allocation")
				}
			} else if closed["releaseState"] != "released" {
				t.Fatal("known idle allocation lost its cleanup owner")
			}
		})
	}
}

func (c *plDebugFrameValueTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.plDebugBreakpointTestConnector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugFrameValueTestConnection{conn.(*plDebugBreakpointTestConnection), c.read, c.write, c.metadata}, nil
}

type plDebugFrameValueTestConnection struct {
	*plDebugBreakpointTestConnection
	read     func(context.Context, []driver.NamedValue) (driver.Result, error)
	write    func(context.Context, []driver.NamedValue) (driver.Result, error)
	metadata *plDebugTargetTestConnector
}

func (c *plDebugFrameValueTestConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if c.metadata == nil {
		return nil, errors.New("unexpected metadata query")
	}
	return (&plDebugTargetTestConnection{plDebugConnectTestConnection: c.plDebugConnectTestConnection, owner: c.metadata}).QueryContext(ctx, query, args)
}

func (c *plDebugFrameValueTestConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if strings.Contains(query, "SYS.DBMS_DEBUG.GET_VALUE") {
		return c.read(ctx, args)
	}
	if strings.Contains(query, "SYS.DBMS_DEBUG.SET_VALUE") {
		return c.write(ctx, args)
	}
	return c.plDebugBreakpointTestConnection.ExecContext(ctx, query, args)
}

func TestPLDebugNativeFrameValueRPCUsesOriginalStopWithoutSourceIdentity(t *testing.T) {
	integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
	engine := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
	first := &plDebugFrameValueTestConnector{plDebugBreakpointTestConnector: plDebugBreakpointTestConnector{
		plDebugManagerTestConnector: plDebugManagerTestConnector{engine: engine},
		payload:                     "[]", complete: 1,
		stops: []plDebugNativeStop{{Result: integer(0), Terminated: integer(0), StackDepth: integer(3), Reason: integer(9)}},
	}}
	second := &plDebugManagerTestConnector{engine: engine, base: plDebugCaptureTestConnector{complete: 1}}
	calls := 0
	var nativeCode sql.NullInt64
	var nativeValue sql.NullString
	var nativeError error
	frame := 0
	first.read = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
		calls++
		if args[0].Value != "same_name" || args[1].Value != 3-frame {
			t.Fatalf("wrong original frame/name: %#v", args)
		}
		if err := plDebugManagerSetOut(args[2], nativeCode); err != nil {
			return nil, err
		}
		if err := plDebugManagerSetOut(args[3], nativeValue); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), nativeError
	}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "frame-value", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	request := func() map[string]interface{} {
		return map[string]interface{}{"debugId": "frame-value", "name": "same_name", "frame": frame, "stopRevision": start["stopRevision"], "nativeFrameId": 999}
	}
	for _, sample := range []struct {
		code  int64
		value sql.NullString
		state string
	}{
		{0, sql.NullString{String: "9007199254740993123456789", Valid: true}, "value"},
		{0, sql.NullString{String: "'NULL'\n\x00值", Valid: true}, "value"},
		{0, sql.NullString{String: "NULL", Valid: true}, "value"},
		{0, sql.NullString{Valid: true}, "empty"},
		{0, sql.NullString{}, "unknown"},
		{plDebugErrNullValue, sql.NullString{}, "null"},
		{plDebugErrNoSuchObject, sql.NullString{}, "out_of_scope"},
		{734, sql.NullString{String: "raw error payload", Valid: true}, "error"},
	} {
		for frame = 0; frame < 3; frame++ {
			nativeCode, nativeValue = integer(sample.code), sample.value
			got := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_value", request()))
			variable := got["variable"].(plDebugNativeVariable)
			if variable.State != sample.state || variable.NativeResult == nil || *variable.NativeResult != sample.code || got["stopRevision"] != start["stopRevision"] || got["operationBusy"] == true || got["nativeFrameId"] != 3-frame {
				t.Fatalf("lost scalar/frame/stop result: %#v %+v", got, variable)
			}
			if sample.value.Valid && (variable.RawValue == nil || *variable.RawValue != sample.value.String) {
				t.Fatalf("changed exact raw payload: %+v", variable)
			}
		}
	}
	before := calls
	for _, change := range []func(map[string]interface{}){
		func(p map[string]interface{}) { delete(p, "stopRevision") },
		func(p map[string]interface{}) { p["stopRevision"] = -1 },
		func(p map[string]interface{}) { p["frame"] = -1 },
		func(p map[string]interface{}) { p["frame"] = 3 },
		func(p map[string]interface{}) { p["frame"] = nil },
		func(p map[string]interface{}) { p["frame"] = 0.5 },
	} {
		frame = 0
		p := request()
		change(p)
		if resp := plDebugManagerRPC(t, r, "pl_debug_get_value", p); resp.Error == nil {
			t.Fatalf("invalid request admitted: %#v", p)
		}
	}
	if calls != before {
		t.Fatal("rejected request dispatched native SQL")
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_get_stack", map[string]interface{}{"debugId": "frame-value", "stopRevision": -1}); resp.Error == nil {
		t.Fatal("stale stack revision admitted")
	}
	frame = 0
	nativeError = errors.New("read failed after native dispatch")
	if resp := plDebugManagerRPC(t, r, "pl_debug_get_value", request()); resp.Error == nil || calls != before+1 {
		t.Fatal("native failure was hidden or replayed")
	}
	closed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "frame-value"}))
	if closed["releaseState"] != "released" || engine.targetAttempts != 1 || first.sets != 0 {
		t.Fatal("scalar reads changed target ownership or created helpers/breakpoints")
	}
}
