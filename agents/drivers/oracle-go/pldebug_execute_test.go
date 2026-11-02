package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugExecuteTestConnector struct {
	plDebugConnectTestConnector
	capture plDebugCaptureTestConnector
	execute func(context.Context, []driver.NamedValue) (driver.Result, error)
}

func TestPLDebugNativeExecuteStatusPreservesNotStartedError(t *testing.T) {
	done := make(chan struct{})
	close(done)
	entry := &plDebugNativeEntry{executeOperations: map[string]*plDebugNativeValueOperation{
		"original": {done: done, state: "failed", stopRevision: 7, err: &plDebugNativeError{message: "prepare failed", outcome: "not_started", agentSessionID: "agent", category: "sql", stage: "prepare"}},
	}}
	result, err := entry.valueOperationStatus(map[string]json.RawMessage{"operationId": json.RawMessage(`"original"`)})
	if err != nil {
		t.Fatal(err)
	}
	record := result.(map[string]interface{})
	data, ok := record["error"].(map[string]interface{})
	if !ok || data["operationOutcome"] != "not_started" || data["stage"] != "prepare" || data["category"] != "sql" || data["agentSessionId"] != "agent" || data["message"] != "prepare failed" || record["message"] != "prepare failed" {
		t.Fatalf("original receipt lost: %#v", record)
	}
}

func TestPLDebugNativeExecuteLeaseRejectionPreservesOriginalReceipt(t *testing.T) {
	fixture := &plDebugExecuteTestConnector{}
	_, entry := openPLDebugExecuteRPCTest(t, fixture)
	entry.closeReason = "lease_expired"
	_, err := entry.executeStatement(map[string]json.RawMessage{"operationId": json.RawMessage(`"lease-rejected"`), "stopRevision": json.RawMessage(`1`), "sql": json.RawMessage(`"BEGIN NULL; END;"`)})
	if err == nil {
		t.Fatal("expired lease accepted")
	}
	result, statusErr := entry.valueOperationStatus(map[string]json.RawMessage{"operationId": json.RawMessage(`"lease-rejected"`)})
	if statusErr != nil {
		t.Fatal(statusErr)
	}
	record := result.(map[string]interface{})
	data, ok := record["error"].(map[string]interface{})
	if !ok || data["operationOutcome"] != "not_started" || data["stage"] != "request" || record["state"] != "failed" {
		t.Fatalf("lease rejection lost: %#v", record)
	}
}

func TestPLDebugExecuteBlockClassificationReadsActualFirstToken(t *testing.T) {
	for _, sample := range []struct {
		source string
		block  bool
	}{
		{"-- leading comment\nBEGIN NULL; END;", true},
		{"/* heading */ DECLARE n NUMBER; BEGIN NULL; END;", true},
		{"-- heading\n<<label>> BEGIN NULL; END;", true},
		{"BEGINNING", false},
		{`"BEGIN"`, false},
		{"SELECT 'BEGIN;' FROM dual; -- tail", false},
	} {
		if _, got := plDebugExecuteSource(sample.source); got != sample.block {
			t.Fatalf("source=%q block=%v want=%v", sample.source, got, sample.block)
		}
	}
}

func TestPLDebugExecuteSourceRemovesOnlyTheSQLTerminator(t *testing.T) {
	for _, sample := range []struct{ source, want string }{
		{"SELECT 'BEGIN;' FROM dual; -- tail;", "SELECT 'BEGIN;' FROM dual -- tail;"},
		{"SELECT 'a;\r\nb' FROM dual;\r\n-- comment ;", "SELECT 'a;\r\nb' FROM dual\r\n-- comment ;"},
		{"-- heading\r\nBEGIN NULL; END;", "-- heading\r\nBEGIN NULL; END;"},
	} {
		got, _ := plDebugExecuteSource(sample.source)
		if got != sample.want {
			t.Fatalf("prepared SQL changed source: got=%q want=%q", got, sample.want)
		}
	}
}

func (c *plDebugExecuteTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.plDebugConnectTestConnector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugExecuteTestConnection{conn.(*plDebugConnectTestConnection), c}, nil
}

type plDebugExecuteTestConnection struct {
	*plDebugConnectTestConnection
	owner *plDebugExecuteTestConnector
}

func (c *plDebugExecuteTestConnection) PrepareContext(context.Context, string) (driver.Stmt, error) {
	return &plDebugExecuteTestStatement{&plDebugCaptureTestStatement{state: &c.owner.capture}, c.owner.execute}, nil
}
func (c *plDebugExecuteTestConnection) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

type plDebugExecuteTestStatement struct {
	*plDebugCaptureTestStatement
	execute func(context.Context, []driver.NamedValue) (driver.Result, error)
}

func openPLDebugExecuteRPCTest(t *testing.T, fixture *plDebugExecuteTestConnector) (*runtimeServer, *plDebugNativeEntry) {
	t.Helper()
	allocation := &plDebugAllocation{connector: fixture}
	db, conn, err := allocation.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); db.Close() })
	r := newRuntimeServer()
	r.plDebugRuntime = true
	entry := &plDebugNativeEntry{request: plDebugNativeStart{OperationID: "start"}, agentSessionID: "a", server: &server{plConnection: conn, plAllocation: allocation}, session: &plDebugSession{}, startState: "succeeded", state: "paused", stopRevision: 1, targetDispatched: true}
	r.plNativeEntries = map[string]*plDebugNativeEntry{"start": entry}
	return r, entry
}

func TestPLDebugNativeExecuteRPCWaitsForOriginalCaptureAndNeverDispatchesDuplicate(t *testing.T) {
	fixture := &plDebugExecuteTestConnector{}
	var calls atomic.Int32
	fixture.execute = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
		calls.Add(1)
		values := []interface{}{sql.NullInt64{Int64: 1, Valid: true}, sql.NullString{}, go_ora.Clob{String: `{"rows":[],"count":0,"complete":true,"truncated":false}`, Valid: true}, sql.NullInt64{Int64: 1, Valid: true}, sql.NullInt64{Int64: 0, Valid: true}, sql.NullString{}}
		for i, value := range values {
			if err := plDebugManagerSetOut(args[i+4], value); err != nil {
				return nil, err
			}
		}
		return driver.RowsAffected(0), nil
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var closeOnce, releaseOnce sync.Once
	fixture.capture.closeCheck = func() error { closeOnce.Do(func() { close(entered); <-release }); return nil }
	r, _ := openPLDebugExecuteRPCTest(t, fixture)
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	params := map[string]interface{}{"debugId": "start", "operationId": "sql-once", "stopRevision": 1, "sql": "BEGIN NULL; END;"}
	first, duplicate := make(chan response, 1), make(chan response, 1)
	go func() { first <- plDebugManagerRPC(t, r, "pl_debug_execute", params) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("original capture did not enter statement cleanup")
	}
	status := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "start", "operationId": "sql-once"}))
	if status["state"] != "running" || status["result"].(map[string]interface{})["ok"] != true {
		t.Fatalf("known execution was confused with completed capture: %#v", status)
	}
	go func() { duplicate <- plDebugManagerRPC(t, r, "pl_debug_execute", params) }()
	if resp := plDebugManagerRPC(t, r, "pl_debug_execute", map[string]interface{}{"debugId": "start", "operationId": "different-sql", "stopRevision": 1, "sql": "BEGIN NULL; END;"}); resp.Error == nil {
		t.Fatal("another SQL operation entered a busy original controller")
	}
	unblock()
	for _, done := range []chan response{first, duplicate} {
		select {
		case resp := <-done:
			if resp.Error != nil {
				t.Fatal(resp.Error)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("original or duplicate SQL receipt did not complete")
		}
	}
	if calls.Load() != 1 || fixture.connects != 1 {
		t.Fatal("concurrent duplicate executed SQL or opened a replacement allocation")
	}
}

func (s *plDebugExecuteTestStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.execute(ctx, args)
}

func TestPLDebugNativeExecuteKeepsExecutionFactBeforeResultAndReferenceFailures(t *testing.T) {
	for _, scenario := range []string{"success", "truncated", "capture_error", "close_error", "missing_receipt", "native_error", "transport_error", "missing_metadata"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := &plDebugExecuteTestConnector{}
			observed, known, calls := false, false, 0
			closeFailed := false
			fixture.capture.closeCheck = func() error {
				if !observed {
					t.Fatal("statement released before execution facts were consumed")
				}
				if scenario == "close_error" && !closeFailed {
					closeFailed = true
					return errors.New("original statement close failed")
				}
				return nil
			}
			fixture.execute = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
				calls++
				if len(args) != 10 || args[0].Value != "BEGIN :1 := rows; END;" || args[1].Value != 1 || args[2].Value != plDebugExecuteMaxRows {
					t.Fatalf("execution inputs changed: %#v", args)
				}
				returned := sql.NullInt64{Int64: 1, Valid: true}
				if scenario == "missing_receipt" || scenario == "transport_error" {
					returned = sql.NullInt64{}
				}
				payload, _ := json.Marshal(map[string]interface{}{"rows": []interface{}{nil, "", "中\n\x1f"}, "count": 3, "complete": true, "truncated": false})
				if scenario == "truncated" {
					payload, _ = json.Marshal(map[string]interface{}{"rows": []interface{}{nil, "", "中\n\x1f"}, "count": 3, "complete": false, "truncated": true})
				}
				if scenario == "missing_metadata" {
					payload = []byte(`{"rows":[],"complete":true}`)
				}
				nativeError, outputError := sql.NullString{}, sql.NullString{}
				complete := sql.NullInt64{Int64: 1, Valid: true}
				if scenario == "native_error" {
					nativeError = sql.NullString{String: "ORA-20001: target failed after partial work", Valid: true}
				}
				if scenario == "capture_error" {
					outputError = sql.NullString{String: "result encoding failed", Valid: true}
					complete.Int64 = 0
				}
				outputs := []interface{}{returned, nativeError, go_ora.Clob{String: string(payload), Valid: true}, complete, sql.NullInt64{Int64: 0, Valid: true}, outputError}
				for index, value := range outputs {
					if err := plDebugManagerSetOut(args[index+4], value); err != nil {
						return nil, err
					}
				}
				if scenario == "transport_error" {
					return nil, errors.New("original response lost")
				}
				return driver.RowsAffected(0), nil
			}
			allocation := &plDebugAllocation{connector: fixture}
			db, conn, err := allocation.open(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer func() { conn.Close(); db.Close() }()
			result, err := plDebugExecuteNativeStatement(context.Background(), conn, allocation, false, " BEGIN :1 := rows; END; ", 999, nil, func(returned sql.NullInt64, _ sql.NullString, _ error) {
				observed = true
				known = returned.Valid && returned.Int64 == 1
			})
			wantError := scenario != "success" && scenario != "native_error" && scenario != "truncated"
			if (err != nil) != wantError || !observed || known != (scenario != "missing_receipt" && scenario != "transport_error") || calls != 1 || fixture.connects != 1 {
				t.Fatalf("execution facts/replay changed: result=%+v err=%v known=%v calls=%d", result, err, known, calls)
			}
			if !wantError && (len(result.Result.Rows) != 3 || result.Result.Rows[0] != nil || *result.Result.Rows[1] != "" || *result.Result.Rows[2] != "中\n\x1f") {
				t.Fatalf("structured result corrupted: %+v", result.Result)
			}
			if scenario == "native_error" && !result.Error.Valid {
				t.Fatal("native execution error disappeared behind captured rows")
			}
			if scenario == "close_error" && len(result.Result.Rows) != 3 {
				t.Fatal("statement cleanup failure discarded already captured rows")
			}
			if scenario == "truncated" && (result.Result.Complete || !result.Result.Truncated) {
				t.Fatal("bounded rows were reported complete")
			}
		})
	}
}

func TestPLDebugNativeExecuteRPCReusesOriginalReceiptAndRejectsConflicts(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "unknown"}[lost], func(t *testing.T) {
			fixture := &plDebugExecuteTestConnector{}
			calls := 0
			fixture.execute = func(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
				calls++
				if lost {
					return nil, errors.New("original EXECUTE response lost")
				}
				values := []interface{}{sql.NullInt64{Int64: 1, Valid: true}, sql.NullString{}, go_ora.Clob{String: `{"rows":[null,"first"],"count":2,"complete":true,"truncated":false}`, Valid: true}, sql.NullInt64{Int64: 1, Valid: true}, sql.NullInt64{Int64: 0, Valid: true}, sql.NullString{}}
				for i, value := range values {
					if err := plDebugManagerSetOut(args[i+4], value); err != nil {
						return nil, err
					}
				}
				return driver.RowsAffected(0), nil
			}
			r, entry := openPLDebugExecuteRPCTest(t, fixture)
			params := map[string]interface{}{"debugId": "start", "operationId": "sql-1", "stopRevision": 1, "sql": "BEGIN :1 := rows; END;", "maxRows": 50}
			first := plDebugManagerRPC(t, r, "pl_debug_execute", params)
			if (first.Error != nil) != lost || calls != 1 {
				t.Fatalf("first execution=%+v calls=%d", first, calls)
			}
			if !lost {
				if result := plDebugManagerSnapshot(t, first); result["ok"] != true || result["count"] != 2 || result["operationId"] != "sql-1" {
					t.Fatalf("missing original SQL result: %#v", result)
				}
			}
			entry.mu.Lock()
			entry.stopRevision = 2
			entry.mu.Unlock()
			second := plDebugManagerRPC(t, r, "pl_debug_execute", params)
			if (second.Error != nil) != lost || calls != 1 {
				t.Fatal("same SQL ID replayed instead of returning original receipt")
			}
			status := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_operation_status", map[string]interface{}{"debugId": "start", "operationId": "sql-1"}))
			wantState := "succeeded"
			if lost {
				wantState = "unknown"
			}
			if status["state"] != wantState || status["action"] != "execute" || status["stopRevision"] != int64(1) {
				t.Fatalf("receipt changed identity/outcome: %#v", status)
			}
			for _, change := range []func(map[string]interface{}){func(p map[string]interface{}) { p["sql"] = "BEGIN NULL; END;" }, func(p map[string]interface{}) { p["maxRows"] = 1 }, func(p map[string]interface{}) { p["stopRevision"] = 2 }, func(p map[string]interface{}) { p["operationId"] = "new-stale" }, func(p map[string]interface{}) { p["agentSessionId"] = "foreign" }} {
				other := map[string]interface{}{}
				for key, value := range params {
					other[key] = value
				}
				change(other)
				if resp := plDebugManagerRPC(t, r, "pl_debug_execute", other); resp.Error == nil || calls != 1 {
					t.Fatal("changed/foreign/stale SQL request was dispatched")
				}
			}
			if resp := plDebugManagerRPC(t, r, "pl_debug_set_value", map[string]interface{}{"debugId": "start", "operationId": "sql-1", "stopRevision": 2, "name": "N", "frame": 0, "value": "1"}); resp.Error == nil || calls != 1 {
				t.Fatal("assignment reused the original SQL operation ID")
			}
		})
	}
}
