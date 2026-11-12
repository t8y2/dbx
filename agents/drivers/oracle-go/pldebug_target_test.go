package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type plDebugTargetTestConnector struct {
	base                    plDebugConnectTestConnector
	mu                      sync.Mutex
	objects                 [][]driver.Value
	objectsByType           map[string][][]driver.Value
	sourceRows              [][]driver.Value
	sourceReads             int
	sourceNext              [][]driver.Value
	specRows                [][]driver.Value
	specNext                [][]driver.Value
	specReads               int
	subprograms             [][]driver.Value
	arguments               map[int64][][]driver.Value
	owner                   string
	queries                 []string
	bindings                [][]driver.NamedValue
	queryError              error
	queryHook               func(int) error
	compileSettings         [][]driver.Value
	compileSettingsError    error
	compileSQL              []string
	compileExecError        error
	compileDiagnostics      [][]driver.Value
	compileDiagnosticsError error
	started                 chan struct{}
	release                 chan struct{}
	once                    sync.Once
}

func (c *plDebugTargetTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugTargetTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugTargetTestConnection{plDebugConnectTestConnection: conn.(*plDebugConnectTestConnection), owner: c}, nil
}

type plDebugTargetTestConnection struct {
	*plDebugConnectTestConnection
	owner *plDebugTargetTestConnector
}

func (c *plDebugTargetTestConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if strings.HasPrefix(query, "ALTER ") {
		c.owner.mu.Lock()
		c.owner.compileSQL = append(c.owner.compileSQL, query)
		err := c.owner.compileExecError
		c.owner.mu.Unlock()
		if err != nil {
			return nil, err
		}
	}
	return c.plDebugConnectTestConnection.ExecContext(ctx, query, args)
}

func (c *plDebugTargetTestConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	s := c.owner
	if s.started != nil {
		s.once.Do(func() { close(s.started) })
		select {
		case <-s.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queries = append(s.queries, query)
	s.bindings = append(s.bindings, append([]driver.NamedValue{}, args...))
	if s.queryHook != nil {
		if err := s.queryHook(len(s.queries)); err != nil {
			return nil, err
		}
	}
	if s.queryError != nil {
		return nil, s.queryError
	}
	var rows [][]driver.Value
	columns := []string{}
	switch {
	case strings.Contains(query, "FROM SYS.ALL_ERRORS"):
		if s.compileDiagnosticsError != nil {
			return nil, s.compileDiagnosticsError
		}
		columns = []string{"SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE", "MESSAGE_NUMBER"}
		rows = s.compileDiagnostics
	case strings.Contains(query, "FROM SYS.ALL_PLSQL_OBJECT_SETTINGS"):
		if s.compileSettingsError != nil {
			return nil, s.compileSettingsError
		}
		columns = []string{"PLSQL_DEBUG", "PLSQL_OPTIMIZE_LEVEL"}
		rows = s.compileSettings
	case strings.Contains(query, "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')"):
		columns = []string{"SCHEMA"}
		rows = [][]driver.Value{{s.owner}}
	case strings.Contains(query, "LEFT JOIN SYS.ALL_SOURCE"):
		columns = []string{"OBJECT_ID", "STATUS", "LAST_DDL_TIME", "LINE", "TEXT"}
		if args[2].Value == "PACKAGE" {
			rows = s.specRows
			s.specReads++
			if s.specReads > 1 && s.specNext != nil {
				rows = s.specNext
			}
			break
		}
		rows = s.sourceRows
		s.sourceReads++
		if s.sourceReads > 1 && s.sourceNext != nil {
			rows = s.sourceNext
		}
	case strings.Contains(query, "FROM SYS.ALL_OBJECTS"):
		columns = []string{"OBJECT_ID", "STATUS"}
		rows = s.objects
		if s.objectsByType != nil && len(args) == 3 {
			rows = s.objectsByType[args[2].Value.(string)]
		}
	case strings.Contains(query, "FROM SYS.ALL_PROCEDURES"):
		columns = []string{"SUBPROGRAM_ID"}
		rows = s.subprograms
	case strings.Contains(query, "FROM SYS.ALL_ARGUMENTS"):
		columns = []string{"NAME", "POSITION", "SEQUENCE", "LEVEL", "MODE", "TYPE", "OWNER", "TYPE_NAME", "SUBNAME", "DEFAULTED"}
		rows = s.arguments[args[2].Value.(int64)]
	default:
		return nil, errors.New("unexpected metadata SQL")
	}
	return &plDebugTargetTestRows{columns: columns, rows: rows}, nil
}

type plDebugTargetTestRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *plDebugTargetTestRows) Columns() []string { return r.columns }
func (*plDebugTargetTestRows) Close() error        { return nil }
func (r *plDebugTargetTestRows) Next(values []driver.Value) error {
	if r.index == len(r.rows) {
		return io.EOF
	}
	copy(values, r.rows[r.index])
	r.index++
	return nil
}

func plDebugTargetArgument(name interface{}, position, sequence, level int64, mode, kind string, defaulted interface{}) []driver.Value {
	return []driver.Value{name, position, sequence, level, mode, kind, nil, nil, nil, defaulted}
}
func plDebugTargetFixture() *plDebugTargetTestConnector {
	return &plDebugTargetTestConnector{owner: " Mixed Owner ", objects: [][]driver.Value{{"9007199254740993123", "VALID"}}, sourceRows: [][]driver.Value{{"body-9007199254740993124", "VALID", "2026-10-23 01:02:03", int64(1), "\n"}, {"body-9007199254740993124", "VALID", "2026-10-23 01:02:03", int64(2), "package body \" Pkg.\"\"\n \" as\n"}}, subprograms: [][]driver.Value{{int64(1)}, {int64(2)}}, arguments: map[int64][][]driver.Value{
		1: {plDebugTargetArgument(nil, 0, 1, 0, "OUT", "NUMBER", "N"), plDebugTargetArgument("X", 1, 2, 0, "IN", "NUMBER", "N"), plDebugTargetArgument("Y", 2, 3, 0, "OUT", "NUMBER", "N")},
		2: {plDebugTargetArgument(nil, 0, 1, 0, "OUT", "VARCHAR2", "N"), plDebugTargetArgument("X", 1, 2, 0, "IN", "VARCHAR2", "N"), plDebugTargetArgument("Y", 2, 3, 0, "OUT", "VARCHAR2", "N")},
	}}
}
func plDebugOpenTargetFixture(t *testing.T, c *plDebugTargetTestConnector) *runtimeServer {
	t.Helper()
	r := plDebugConnectTestRuntime(c)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	t.Cleanup(func() { _ = r.closeAllSessions() })
	return r
}
func plDebugTargetRequest() map[string]interface{} {
	return map[string]interface{}{"agentSessionId": "a", "objectType": "FUNCTION", "packageName": " Pkg.\"\n ", "objectName": " f.x "}
}

func TestPLDebugNativeTargetDoesNotSilentlyDropTypedInput(t *testing.T) {
	c := plDebugTargetFixture()
	r := plDebugOpenTargetFixture(t, c)
	preview := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resolve_target", plDebugTargetRequest()))
	candidate := preview["candidates"].([]map[string]interface{})[0]["signature"].(plDebugNativeCandidate)
	for _, typed := range []interface{}{map[string]interface{}{"kind": "number", "value": "99"}, nil} {
		request := plDebugNativeStart{Params: []interface{}{
			map[string]interface{}{"name": "X", "mode": "IN", "type": "NUMBER", "typedValue": typed},
			map[string]interface{}{"name": "Y", "mode": "OUT", "type": "NUMBER"},
		}}
		if plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{candidate}, request); err == nil || plan != nil {
			t.Fatalf("typed payload was silently interpreted as legacy NULL: %#v, %v", plan, err)
		}
	}
	if c.base.execs != 0 {
		t.Fatal("typed input rejection executed a target")
	}
}

func TestPLDebugNativeTargetPreviewRPCPreservesExactDictionaryIdentity(t *testing.T) {
	c := plDebugTargetFixture()
	r := plDebugOpenTargetFixture(t, c)
	value := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resolve_target", plDebugTargetRequest()))
	previews := value["candidates"].([]map[string]interface{})
	if value["schema"] != c.owner || value["state"] != "available" || len(previews) != 2 {
		t.Fatalf("metadata candidates lost: %#v", value)
	}
	number := previews[0]["signature"].(plDebugNativeCandidate)
	if number.ObjectID != "9007199254740993123" || number.Schema != " Mixed Owner " || number.SubprogramID != 1 || number.ObjectName != " f.x " || *number.PackageName != " Pkg.\"\n " || number.returns() == nil || len(number.parameters()) != 2 {
		t.Fatalf("dictionary identity changed: %#v", number)
	}
	if number.routine() != `" Mixed Owner "." Pkg.""`+"\n"+` "." f.x "` {
		t.Fatalf("routine quote split or folded identifiers: %q", number.routine())
	}
	if previews[0]["parameterTransport"] != "implemented" {
		t.Fatal("NUMBER/VARCHAR2 native invocation transport was not exposed")
	}
	for i, query := range c.queries {
		if strings.Contains(query, "SYS.ALL_OBJECTS") {
			if !strings.Contains(query, "TO_CHAR(OBJECT_ID") || c.bindings[i][0].Value != c.owner || c.bindings[i][1].Value != " Pkg.\"\n " || c.bindings[i][2].Value != "PACKAGE" {
				t.Fatal("object identity was interpolated or rounded")
			}
		}
		if strings.Contains(query, "SYS.ALL_PROCEDURES") && c.bindings[i][4].Value != " f.x " {
			t.Fatal("member name was normalized or split")
		}
	}
	if c.base.connects != 1 || c.base.execs != 0 || len(r.plNativeEntries) != 0 {
		t.Fatal("signature preview initialized or executed a debug target")
	}
}

func TestPLDebugMetadataTargetPreviewRPCUsesOnlyItsBorrowedConnection(t *testing.T) {
	for _, fail := range []bool{false, true} {
		c := plDebugTargetFixture()
		if fail {
			c.queryError = errors.New("metadata unavailable")
		}
		s := newServer()
		s.db = sql.OpenDB(c)
		t.Cleanup(func() { _ = s.db.Close() })
		r := newRuntimeServer()
		r.sessions["metadata"] = &agentSession{server: s}
		request := plDebugTargetRequest()
		request["agentSessionId"] = "metadata"
		response := plDebugManagerRPC(t, r, "pl_debug_resolve_target", request)
		if fail {
			if response.Error == nil {
				t.Fatal("metadata failure was reported as empty successful preview")
			}
		} else {
			value := plDebugManagerSnapshot(t, response)
			if value["schema"] != c.owner || len(value["candidates"].([]map[string]interface{})) != 2 {
				t.Fatalf("metadata preview lost exact candidates: %#v", value)
			}
		}
		if s.plConnection != nil || s.plAllocation != nil || s.plDebuggeeConnection != nil || len(r.plNativeEntries) != 0 || c.base.connects != 1 {
			t.Fatal("target preview changed dedicated execution ownership")
		}
		if s.db.Stats().InUse != 0 {
			t.Fatal("target preview retained its borrowed connection")
		}
	}
}

func TestPLDebugNativeTargetSelectionUsesTypesNullsAndFreshSignatures(t *testing.T) {
	c := plDebugTargetFixture()
	r := plDebugOpenTargetFixture(t, c)
	preview := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_resolve_target", plDebugTargetRequest()))
	candidates := []plDebugNativeCandidate{}
	for _, item := range preview["candidates"].([]map[string]interface{}) {
		candidates = append(candidates, item["signature"].(plDebugNativeCandidate))
	}
	request := plDebugNativeStart{Params: []interface{}{map[string]interface{}{"name": "X", "mode": "IN", "type": "NUMBER", "inputState": "null"}, map[string]interface{}{"name": "Y", "mode": "OUT", "type": "NUMBER"}}}
	plan, err := plDebugSelectNativeTarget(candidates, request)
	if err != nil || plan.target.SubprogramID != 1 || plan.arguments[0].value != nil {
		t.Fatalf("typed NULL selected wrong overload: %#v %v", plan, err)
	}
	request.Params = []interface{}{map[string]interface{}{"name": "X", "mode": "IN", "type": "VARCHAR2", "value": "000123.45"}, map[string]interface{}{"name": "Y", "mode": "OUT", "type": "VARCHAR2"}}
	plan, err = plDebugSelectNativeTarget(candidates, request)
	if err != nil || plan.target.SubprogramID != 2 || plan.arguments[0].value != "000123.45" {
		t.Fatal("numeric-looking text guessed a numeric overload")
	}
	signature, err := plDebugNativeJSONValue(candidates[1])
	if err != nil {
		t.Fatal(err)
	}
	request.TargetSignature = signature.(map[string]interface{})
	plan, err = plDebugSelectNativeTarget(candidates, request)
	if err != nil {
		t.Fatal(err)
	}
	changed := append([]plDebugNativeCandidate{}, candidates...)
	changed[1].ObjectID = "9007199254740993124"
	if _, err = plDebugSelectNativeTarget(changed, request); err == nil {
		t.Fatal("stale selected signature was accepted")
	}
	request.Params = []interface{}{map[string]interface{}{"name": "x", "mode": "IN", "type": "VARCHAR2", "value": "value"}, map[string]interface{}{"name": "Y", "mode": "OUT", "type": "VARCHAR2"}}
	if _, err = plDebugSelectNativeTarget(candidates, request); err == nil {
		t.Fatal("formal name was case-folded")
	}
	if c.base.execs != 0 {
		t.Fatal("signature selection executed SQL")
	}
}

func TestPLDebugNativeTargetDefaultOmissionAmbiguityAndUnsupportedTypes(t *testing.T) {
	text := func(s string) *string { return &s }
	x := plDebugNativeArgument{Name: text("X"), Position: 1, Sequence: 1, Mode: "IN", Type: "NUMBER", Defaulted: text("Y")}
	y := x
	y.Name = text("Y")
	y.Position = 2
	y.Sequence = 2
	a := plDebugNativeCandidate{ObjectID: "1", SubprogramID: 1, ObjectType: "PROCEDURE", Status: text("VALID"), Arguments: []plDebugNativeArgument{x, y}}
	b := a
	b.SubprogramID = 2
	b.Arguments = []plDebugNativeArgument{x}
	signature, _ := plDebugNativeJSONValue(a)
	request := plDebugNativeStart{TargetSignature: signature.(map[string]interface{}), Params: []interface{}{map[string]interface{}{"name": "X", "mode": "IN", "type": "NUMBER", "value": "9007199254740993.123456789"}, map[string]interface{}{"name": "Y", "mode": "IN", "type": "NUMBER", "inputState": "default"}}}
	if _, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{a, b}, request); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("default omission selected a hidden overload: %v", err)
	}
	request.Params[1] = map[string]interface{}{"name": "Y", "mode": "IN", "type": "NUMBER", "value": "42"}
	plan, err := plDebugSelectNativeTarget([]plDebugNativeCandidate{a, b}, request)
	if err != nil || plan.arguments[0].value != "9007199254740993.123456789" {
		t.Fatalf("explicit typed call or precision lost: %#v %v", plan, err)
	}
	request.Params[1] = map[string]interface{}{"name": "Y", "mode": "IN", "type": "NUMBER", "inputState": "default"}
	if _, err = plDebugSelectNativeTarget([]plDebugNativeCandidate{a}, request); err != nil {
		t.Fatal("verified default could not be omitted", err)
	}
	unsupported := a
	unsupported.Arguments = append([]plDebugNativeArgument{}, a.Arguments...)
	unsupported.Arguments[1].Type = "PL/SQL RECORD"
	unsupported.Arguments[1].TypeOwner = text("Original Owner")
	unsupported.Arguments[1].TypeName = text("Exact.Type")
	if unsupported.preview()["parameterTransport"] != "not_implemented" || unsupported.Arguments[1].TypeOwner == nil {
		t.Fatal("unsupported transport hid metadata or claimed database incompatibility")
	}
	unsupportedSignature, _ := plDebugNativeJSONValue(unsupported)
	request.TargetSignature = unsupportedSignature.(map[string]interface{})
	request.Params[1] = map[string]interface{}{"name": "Y", "mode": "IN", "type": "PL/SQL RECORD", "inputState": "null"}
	if _, err = plDebugSelectNativeTarget([]plDebugNativeCandidate{unsupported}, request); err == nil || !strings.Contains(err.Error(), "transport is not yet implemented") {
		t.Fatalf("unsupported transport became database incompatibility or a scalar bind: %v", err)
	}
}

func TestPLDebugNativeTargetMetadataFailuresDifferFromNoVisibleRows(t *testing.T) {
	for _, scenario := range []string{"empty", "null_object", "duplicate_object", "null_subprogram", "duplicate_argument", "null_position", "query_error"} {
		t.Run(scenario, func(t *testing.T) {
			c := plDebugTargetFixture()
			switch scenario {
			case "empty":
				c.objects = nil
			case "null_object":
				c.objects[0][0] = nil
			case "duplicate_object":
				c.objects = append(c.objects, c.objects[0])
			case "null_subprogram":
				c.subprograms[0][0] = nil
			case "duplicate_argument":
				c.arguments[1] = append(c.arguments[1], c.arguments[1][0])
			case "null_position":
				c.arguments[1][0][1] = nil
			case "query_error":
				c.queryError = errors.New("dictionary read failed")
			}
			r := plDebugOpenTargetFixture(t, c)
			resp := plDebugManagerRPC(t, r, "pl_debug_resolve_target", plDebugTargetRequest())
			if scenario == "empty" {
				result := plDebugManagerSnapshot(t, resp)
				if result["state"] != "not_visible" {
					t.Fatal("empty metadata claimed permission denial")
				}
			} else if resp.Error == nil {
				t.Fatalf("%s metadata became an empty success", scenario)
			}
			if c.base.execs != 0 || len(r.plNativeEntries) != 0 {
				t.Fatal("failed preview dispatched a business operation")
			}
		})
	}
}

func TestPLDebugNativeTargetPreviewBusyRejectsStartWithoutRegistering(t *testing.T) {
	c := plDebugTargetFixture()
	c.started, c.release = make(chan struct{}), make(chan struct{})
	r := plDebugOpenTargetFixture(t, c)
	var release sync.Once
	defer release.Do(func() { close(c.release) })
	done := make(chan response, 1)
	go func() { done <- plDebugManagerRPC(t, r, "pl_debug_resolve_target", plDebugTargetRequest()) }()
	select {
	case <-c.started:
	case <-time.After(time.Second):
		t.Fatal("metadata query did not start")
	}
	resp := plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "during-preview", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"})
	if resp.Error == nil || len(r.plNativeEntries) != 0 || c.base.connects != 1 {
		t.Fatal("busy preview allowed a start to allocate or register")
	}
	data := rpcDiagnostics(t, resp)
	if data["stage"] != "request" || data["operationOutcome"] != "not_started" || data["category"] != "resource" || data["agentSessionId"] != "a" {
		t.Fatalf("pre-dispatch refusal lost its typed contract: %#v", data)
	}
	release.Do(func() { close(c.release) })
	select {
	case resp := <-done:
		if resp.Error != nil {
			t.Fatal(resp.Error)
		}
	case <-time.After(time.Second):
		t.Fatal("preview did not finish")
	}
}

func TestPLDebugNativeTargetStartBeforeOpenCompletionDoesNotAllocate(t *testing.T) {
	c := plDebugTargetFixture()
	c.base.started, c.base.release = make(chan struct{}), make(chan struct{})
	r := plDebugConnectTestRuntime(c)
	var release sync.Once
	defer release.Do(func() { close(c.base.release) })
	done := make(chan response, 1)
	go func() { done <- plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}) }()
	select {
	case <-c.base.started:
	case <-time.After(time.Second):
		t.Fatal("original open did not start")
	}
	resp := plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "before-open", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"})
	if resp.Error == nil || len(r.plNativeEntries) != 0 || c.base.connects != 1 {
		t.Fatal("start raced original open and acquired a second allocation")
	}
	if rpcDiagnostics(t, resp)["operationOutcome"] != "not_started" {
		t.Fatal("unfinished original open was classified as a dispatched business call")
	}
	release.Do(func() { close(c.base.release) })
	select {
	case resp := <-done:
		if resp.Error != nil {
			t.Fatal(resp.Error)
		}
	case <-time.After(time.Second):
		t.Fatal("original open did not finish")
	}
	if err := r.closeAllSessions(); err != nil {
		t.Fatal(err)
	}
}

func TestPLDebugNativeMetadataPreparationIsValidatedAndFrozen(t *testing.T) {
	params := map[string]json.RawMessage{"operationId": json.RawMessage(`"metadata-policy"`)}
	_, legacy, err := plDebugFreezeStart(params)
	if err != nil {
		t.Fatal(err)
	}
	params["metadataPreparation"] = json.RawMessage(`null`)
	_, absent, err := plDebugFreezeStart(params)
	if err != nil || absent != legacy {
		t.Fatal("an absent/null policy changed the legacy operation identity")
	}
	params["metadataPreparation"] = json.RawMessage(`"type_only"`)
	_, typed, err := plDebugFreezeStart(params)
	if err != nil {
		t.Fatal(err)
	}
	if typed == legacy || !strings.Contains(typed, `"metadataPreparation":"type_only"`) {
		t.Fatal("metadata preparation policy was discarded from the frozen operation identity")
	}
	for _, raw := range []string{`"execute"`, `""`, `true`, `1`, `{}`} {
		params["metadataPreparation"] = json.RawMessage(raw)
		if _, _, err := plDebugFreezeStart(params); err == nil {
			t.Fatalf("invalid metadata policy accepted: %s", raw)
		}
	}
}

func TestPLDebugNativeDecimalNeverRoundsThroughFloat(t *testing.T) {
	valid := map[string]string{"9007199254740993.123456789": "9007199254740993.123456789", "+0001.2300E+2": "123", "-.0100e+1": "-0.1", "-0e999999999999999999999": "0", ".50": "0.5", "1e-130": "0." + strings.Repeat("0", 129) + "1", "1e125": "1" + strings.Repeat("0", 125), "123456789012345678901234567890123456789": "123456789012345678901234567890123456789", "1234567890123456789012345678901234567891": "1234567890123456789012345678901234567891"}
	for input, want := range valid {
		got, err := plDebugNativeDecimal(input)
		if err != nil || got != want {
			t.Fatalf("%q -> %q (%v), want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"", "+", "NaN", "Infinity", "1e126", "1e-131", "1e99999999999999999999", "1; BEGIN NULL; END;", " 1"} {
		if _, err := plDebugNativeDecimal(input); err == nil {
			t.Fatalf("invalid/unpreservable decimal accepted: %q", input)
		}
	}
	// The request freeze must preserve nested signature identities and values.
	params := map[string]json.RawMessage{"operationId": json.RawMessage(`"decimal-freeze"`), "targetSignature": json.RawMessage(`{"subprogramId":9007199254740993,"arguments":[]}`)}
	a, frozen, err := plDebugFreezeStart(params)
	if err != nil {
		t.Fatal(err)
	}
	if a.TargetSignature["subprogramId"] != json.Number("9007199254740993") || !strings.Contains(frozen, "9007199254740993") {
		t.Fatal("request freeze rounded dictionary identity")
	}
	if reflect.TypeOf(a.TargetSignature["subprogramId"]) == reflect.TypeOf(float64(0)) {
		t.Fatal("signature used floating point")
	}
}
