package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/t8y2/dbx/agents/go-common/gohive"
)

var scriptedDriverSequence atomic.Uint64

type scriptedBehavior struct {
	mu          sync.Mutex
	query       func(context.Context, string) (driver.Rows, error)
	exec        func(context.Context, string) (driver.Result, error)
	getSchemas  func(context.Context, string) (gohive.MetadataResult, error)
	getTables   func(context.Context, string, string, []string) (gohive.MetadataResult, error)
	getColumns  func(context.Context, string, string, string) (gohive.MetadataResult, error)
	getTypeInfo func(context.Context) (gohive.MetadataResult, error)
	beginErr    error
	queries     []string
	executions  []string
	beginCalls  int
	closeCalls  int
}

func (behavior *scriptedBehavior) queryContext(ctx context.Context, query string) (driver.Rows, error) {
	behavior.mu.Lock()
	behavior.queries = append(behavior.queries, query)
	operation := behavior.query
	behavior.mu.Unlock()
	if operation == nil {
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
	return operation(ctx, query)
}

func (behavior *scriptedBehavior) execContext(ctx context.Context, query string) (driver.Result, error) {
	behavior.mu.Lock()
	behavior.executions = append(behavior.executions, query)
	operation := behavior.exec
	behavior.mu.Unlock()
	if operation == nil {
		return nil, fmt.Errorf("unexpected execution: %s", query)
	}
	return operation(ctx, query)
}

func (behavior *scriptedBehavior) snapshot() (queries, executions []string, beginCalls, closeCalls int) {
	behavior.mu.Lock()
	defer behavior.mu.Unlock()
	return append([]string(nil), behavior.queries...), append([]string(nil), behavior.executions...), behavior.beginCalls, behavior.closeCalls
}

type scriptedDriver struct {
	behavior *scriptedBehavior
}

func (driverValue *scriptedDriver) Open(string) (driver.Conn, error) {
	return &scriptedConnection{behavior: driverValue.behavior}, nil
}

type scriptedConnection struct {
	behavior *scriptedBehavior
}

func (connection *scriptedConnection) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not supported")
}

func (connection *scriptedConnection) Close() error {
	connection.behavior.mu.Lock()
	connection.behavior.closeCalls++
	connection.behavior.mu.Unlock()
	return nil
}

func (connection *scriptedConnection) Begin() (driver.Tx, error) {
	connection.behavior.mu.Lock()
	connection.behavior.beginCalls++
	connection.behavior.mu.Unlock()
	if connection.behavior.beginErr != nil {
		return nil, connection.behavior.beginErr
	}
	return nil, driver.ErrSkip
}

func (connection *scriptedConnection) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	connection.behavior.mu.Lock()
	connection.behavior.beginCalls++
	connection.behavior.mu.Unlock()
	if connection.behavior.beginErr != nil {
		return nil, connection.behavior.beginErr
	}
	return nil, driver.ErrSkip
}

func (connection *scriptedConnection) Ping(context.Context) error {
	return nil
}

func (connection *scriptedConnection) QueryContext(
	ctx context.Context,
	query string,
	_ []driver.NamedValue,
) (driver.Rows, error) {
	return connection.behavior.queryContext(ctx, query)
}

func (connection *scriptedConnection) ExecContext(
	ctx context.Context,
	query string,
	_ []driver.NamedValue,
) (driver.Result, error) {
	return connection.behavior.execContext(ctx, query)
}

func (connection *scriptedConnection) GetHiveSchemas(ctx context.Context, pattern string) (gohive.MetadataResult, error) {
	if connection.behavior.getSchemas == nil {
		return gohive.MetadataResult{}, errors.New("GetSchemas unavailable")
	}
	return connection.behavior.getSchemas(ctx, pattern)
}

func (connection *scriptedConnection) GetHiveTables(ctx context.Context, schema, table string, tableTypes []string) (gohive.MetadataResult, error) {
	if connection.behavior.getTables == nil {
		return gohive.MetadataResult{}, errors.New("GetTables unavailable")
	}
	return connection.behavior.getTables(ctx, schema, table, tableTypes)
}

func (connection *scriptedConnection) GetHiveColumns(ctx context.Context, schema, table, column string) (gohive.MetadataResult, error) {
	if connection.behavior.getColumns == nil {
		return gohive.MetadataResult{}, errors.New("GetColumns unavailable")
	}
	return connection.behavior.getColumns(ctx, schema, table, column)
}

func (connection *scriptedConnection) GetHiveTypeInfo(ctx context.Context) (gohive.MetadataResult, error) {
	if connection.behavior.getTypeInfo == nil {
		return gohive.MetadataResult{}, errors.New("GetTypeInfo unavailable")
	}
	return connection.behavior.getTypeInfo(ctx)
}

type scriptedRows struct {
	ctx        context.Context
	columns    []string
	types      []string
	values     [][]driver.Value
	blockAfter int
	blocked    chan struct{}
	blockOnce  sync.Once

	mu     sync.Mutex
	index  int
	closed bool
}

func newScriptedRows(ctx context.Context, columns, types []string, values [][]driver.Value) *scriptedRows {
	return &scriptedRows{
		ctx:        ctx,
		columns:    columns,
		types:      types,
		values:     values,
		blockAfter: -1,
	}
}

func (rows *scriptedRows) Columns() []string {
	return append([]string(nil), rows.columns...)
}

func (rows *scriptedRows) Close() error {
	rows.mu.Lock()
	rows.closed = true
	rows.mu.Unlock()
	return nil
}

func (rows *scriptedRows) Next(destination []driver.Value) error {
	rows.mu.Lock()
	if rows.closed {
		rows.mu.Unlock()
		return io.EOF
	}
	index := rows.index
	if rows.blockAfter >= 0 && index >= rows.blockAfter {
		blocked := rows.blocked
		ctx := rows.ctx
		rows.mu.Unlock()
		if blocked != nil {
			rows.blockOnce.Do(func() { close(blocked) })
		}
		<-ctx.Done()
		return ctx.Err()
	}
	if index >= len(rows.values) {
		rows.mu.Unlock()
		return io.EOF
	}
	current := rows.values[index]
	rows.index++
	rows.mu.Unlock()
	copy(destination, current)
	return nil
}

func (rows *scriptedRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < 0 || index >= len(rows.types) {
		return ""
	}
	return rows.types[index]
}

func (rows *scriptedRows) isClosed() bool {
	rows.mu.Lock()
	defer rows.mu.Unlock()
	return rows.closed
}

func newScriptedServer(t *testing.T, behavior *scriptedBehavior) *server {
	t.Helper()
	driverName := fmt.Sprintf("dbx-hive-scripted-%d", scriptedDriverSequence.Add(1))
	sql.Register(driverName, &scriptedDriver{behavior: behavior})
	database, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.Conn(context.Background())
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	server := &server{
		config:        connectionConfig{Database: defaultHiveDatabase, ConnectTimeout: time.Second},
		database:      database,
		connection:    connection,
		querySessions: map[string]*querySession{},
	}
	t.Cleanup(func() { _ = server.disconnect() })
	return server
}

func rawParams(values map[string]any) map[string]json.RawMessage {
	result := make(map[string]json.RawMessage, len(values))
	for key, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			panic(err)
		}
		result[key] = encoded
	}
	return result
}

func TestExecuteQueryUsesHiveServerResultSetSignal(t *testing.T) {
	behavior := &scriptedBehavior{}
	behavior.query = func(ctx context.Context, query string) (driver.Rows, error) {
		switch {
		case strings.HasPrefix(query, "WITH source AS"):
			return nil, &gohive.NonQueryResult{AffectedRows: 4}
		case strings.HasPrefix(query, "SET "):
			return newScriptedRows(ctx, []string{"set"}, []string{"STRING"}, [][]driver.Value{{"hive.exec.dynamic.partition=true"}}), nil
		default:
			return nil, fmt.Errorf("unexpected SQL: %s", query)
		}
	}
	server := newScriptedServer(t, behavior)

	insertResult, err := server.executeQuery(queryOptions{
		SQL: "WITH source AS (SELECT 1) INSERT INTO target SELECT * FROM source",
	})
	if err != nil {
		t.Fatal(err)
	}
	if insertResult.AffectedRows != 4 || len(insertResult.Columns) != 0 {
		t.Fatalf("unexpected non-query result: %#v", insertResult)
	}

	setResult, err := server.executeQuery(queryOptions{SQL: "SET hive.exec.dynamic.partition"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(setResult.Rows, [][]any{{"hive.exec.dynamic.partition=true"}}) {
		t.Fatalf("unexpected SET result: %#v", setResult.Rows)
	}
	queries, executions, _, _ := behavior.snapshot()
	if len(queries) != 2 || len(executions) != 0 {
		t.Fatalf("statements must use HS2 result-set signaling, queries=%v executions=%v", queries, executions)
	}
}

func TestPagedQueryTruncatesAndPreservesLegacyJDBCValueSemantics(t *testing.T) {
	largeValue := strings.Repeat("x", 256*1024)
	createdAt := time.Date(2026, time.August, 11, 10, 11, 12, 345000000, time.UTC)
	var sourceRows *scriptedRows
	behavior := &scriptedBehavior{}
	behavior.query = func(ctx context.Context, _ string) (driver.Rows, error) {
		sourceRows = newScriptedRows(
			ctx,
			[]string{"id", "enabled", "payload", "created_at", "complex_value"},
			[]string{"BIGINT", "BOOLEAN", "BINARY", "TIMESTAMP", "ARRAY"},
			[][]driver.Value{
				{int64(1), true, []byte{0x00, 0xff}, createdAt, largeValue},
				{int64(2), false, []byte{0x10}, createdAt, "[1,2]"},
				{int64(3), true, []byte{}, createdAt, "map('a',1)"},
				{int64(4), true, []byte{0x01}, createdAt, "extra"},
			},
		)
		return sourceRows, nil
	}
	server := newScriptedServer(t, behavior)

	first, err := server.executeQueryPage(queryOptions{SQL: "SELECT * FROM values", MaxRows: 3, FetchSize: 2}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !first.HasMore || first.SessionID == nil || len(first.Rows) != 2 {
		t.Fatalf("unexpected first page: %#v", first)
	}
	if !reflect.DeepEqual(first.ColumnTypes, []string{"bigint", "boolean", "binary", "timestamp", "array"}) {
		t.Fatalf("unexpected column types: %#v", first.ColumnTypes)
	}
	if first.Rows[0][0] != "1" || first.Rows[0][1] != "true" || first.Rows[0][2] != "0x00ff" {
		t.Fatalf("primitive value types changed: %#v", first.Rows[0])
	}
	if first.Rows[0][3] != "2026-08-11 10:11:12.345" || first.Rows[0][4] != largeValue {
		t.Fatalf("timestamp or large value changed: %#v", first.Rows[0])
	}

	second, err := server.fetchQueryPage(*first.SessionID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if second.HasMore || second.SessionID != nil || !second.Truncated || len(second.Rows) != 1 {
		t.Fatalf("unexpected final page: %#v", second)
	}
	if len(server.querySessions) != 0 || sourceRows == nil || !sourceRows.isClosed() {
		t.Fatalf("query session was not closed: sessions=%d rows=%#v", len(server.querySessions), sourceRows)
	}
}

func TestCancelPagedFetchQuarantinesWithoutReplayingSQL(t *testing.T) {
	blocked := make(chan struct{})
	behavior := &scriptedBehavior{}
	behavior.query = func(ctx context.Context, _ string) (driver.Rows, error) {
		rows := newScriptedRows(ctx, []string{"id"}, []string{"BIGINT"}, [][]driver.Value{{int64(1)}, {int64(2)}, {int64(3)}})
		rows.blockAfter = 2
		rows.blocked = blocked
		return rows, nil
	}
	server := newScriptedServer(t, behavior)
	first, err := server.executeQueryPage(queryOptions{SQL: "SELECT id FROM slow_table", MaxRows: 10}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.SessionID == nil {
		t.Fatal("expected a paged query session")
	}

	result := make(chan error, 1)
	go func() {
		_, fetchErr := server.fetchQueryPage(*first.SessionID, 1)
		result <- fetchErr
	}()
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("fetch did not reach the blocking row")
	}
	server.cancelActiveQuery()
	fetchErr := <-result
	if !errors.Is(fetchErr, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", fetchErr)
	}
	rpcErr := classifyRPCError("fetch_query_page", "session-a", fetchErr)
	if rpcErr.Data.Category != "canceled" || rpcErr.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected cancellation classification: %#v", rpcErr)
	}
	queries, _, _, _ := behavior.snapshot()
	if len(queries) != 1 {
		t.Fatalf("SQL must never be replayed after cancellation: %v", queries)
	}
	if len(server.querySessions) != 0 {
		t.Fatalf("canceled query session was retained: %#v", server.querySessions)
	}
}

func TestPagedFetchHonorsOriginalStatementTimeout(t *testing.T) {
	blocked := make(chan struct{})
	behavior := &scriptedBehavior{}
	behavior.query = func(ctx context.Context, _ string) (driver.Rows, error) {
		rows := newScriptedRows(ctx, []string{"id"}, []string{"BIGINT"}, [][]driver.Value{{int64(1)}, {int64(2)}, {int64(3)}})
		rows.blockAfter = 2
		rows.blocked = blocked
		return rows, nil
	}
	server := newScriptedServer(t, behavior)
	first, err := server.executeQueryPage(queryOptions{SQL: "SELECT id FROM slow_table", MaxRows: 10, TimeoutSecs: 1}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.SessionID == nil {
		t.Fatal("expected a paged query session")
	}

	started := time.Now()
	_, fetchErr := server.fetchQueryPage(*first.SessionID, 1)
	if !errors.Is(fetchErr, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", fetchErr)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("statement timeout was not enforced promptly: %s", elapsed)
	}
	if len(server.querySessions) != 0 {
		t.Fatalf("timed out query session was retained: %#v", server.querySessions)
	}
}

func TestRuntimeSessionsRemainIsolated(t *testing.T) {
	behaviorA := &scriptedBehavior{query: func(ctx context.Context, _ string) (driver.Rows, error) {
		return newScriptedRows(ctx, []string{"owner"}, []string{"STRING"}, [][]driver.Value{{"a"}}), nil
	}}
	behaviorB := &scriptedBehavior{query: func(ctx context.Context, _ string) (driver.Rows, error) {
		return newScriptedRows(ctx, []string{"owner"}, []string{"STRING"}, [][]driver.Value{{"b"}}), nil
	}}
	serverA := newScriptedServer(t, behaviorA)
	serverB := newScriptedServer(t, behaviorB)
	runtimeServer := newRuntimeServer()
	runtimeServer.sessions["a"] = &agentSession{server: serverA}
	runtimeServer.sessions["b"] = &agentSession{server: serverB}

	resultA, _, err := runtimeServer.dispatch("execute_query", rawParams(map[string]any{
		"agentSessionId": "a",
		"sql":            "SELECT owner",
	}))
	if err != nil {
		t.Fatal(err)
	}
	resultB, _, err := runtimeServer.dispatch("execute_query", rawParams(map[string]any{
		"agentSessionId": "b",
		"sql":            "SELECT owner",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resultA.(queryResult).Rows[0][0] != "a" || resultB.(queryResult).Rows[0][0] != "b" {
		t.Fatalf("session results crossed: a=%#v b=%#v", resultA, resultB)
	}
	if err := runtimeServer.closeSession("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := runtimeServer.session("a"); err == nil {
		t.Fatal("closed session a is still registered")
	}
	if _, err := runtimeServer.session("b"); err != nil {
		t.Fatalf("closing session a affected session b: %v", err)
	}
}

func TestTransactionFallbackDoesNotReplayFailedStatements(t *testing.T) {
	behavior := &scriptedBehavior{}
	behavior.exec = func(_ context.Context, query string) (driver.Result, error) {
		if strings.Contains(query, "second") {
			return nil, io.EOF
		}
		return driver.RowsAffected(1), nil
	}
	server := newScriptedServer(t, behavior)
	_, err := server.executeStatements(rawParams(map[string]any{
		"statements": []string{"INSERT first", "INSERT second", "INSERT third"},
	}), true)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("expected connection failure, got %v", err)
	}
	_, executions, beginCalls, _ := behavior.snapshot()
	if !reflect.DeepEqual(executions, []string{"INSERT first", "INSERT second"}) {
		t.Fatalf("failed transaction was replayed or continued: %v", executions)
	}
	if beginCalls == 0 {
		t.Fatal("transaction capability was not attempted before fallback")
	}
	rpcErr := classifyRPCError("execute_transaction", "session-a", err)
	if rpcErr.Data.Category != "connection" || rpcErr.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected connection failure classification: %#v", rpcErr)
	}
}

func TestTransactionDoesNotFallbackAfterOperationalBeginFailure(t *testing.T) {
	behavior := &scriptedBehavior{
		beginErr: errors.New("connection reset while beginning transaction"),
		exec: func(context.Context, string) (driver.Result, error) {
			return driver.RowsAffected(1), nil
		},
	}
	server := newScriptedServer(t, behavior)
	defer server.disconnect()
	params := map[string]json.RawMessage{
		"statements": json.RawMessage(`["INSERT INTO sample VALUES (1)"]`),
	}
	if _, err := server.executeStatements(params, true); err == nil || !strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("expected begin failure, got %v", err)
	}
	_, executions, _, _ := behavior.snapshot()
	if len(executions) != 0 {
		t.Fatalf("statements must not execute after begin failure: %#v", executions)
	}
}

func TestExpireIdleQuerySessions(t *testing.T) {
	behavior := &scriptedBehavior{query: func(ctx context.Context, _ string) (driver.Rows, error) {
		return newScriptedRows(ctx, []string{"id"}, []string{"BIGINT"}, [][]driver.Value{{int64(1)}, {int64(2)}}), nil
	}}
	server := newScriptedServer(t, behavior)
	first, err := server.executeQueryPage(queryOptions{SQL: "SELECT id", MaxRows: 10}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.SessionID == nil {
		t.Fatal("expected a query session")
	}
	server.querySessions[*first.SessionID].lastAccessed = time.Now().Add(-querySessionIdleTime - time.Second)
	if expired := server.expireIdleQuerySessions(time.Now()); expired != 1 {
		t.Fatalf("unexpected expired session count: %d", expired)
	}
	if len(server.querySessions) != 0 {
		t.Fatalf("idle session was retained: %#v", server.querySessions)
	}
}

func TestStructuredHiveErrorIncludesServerDiagnostics(t *testing.T) {
	err := &gohive.Error{
		Err:       errors.New("compile failed"),
		Message:   "SemanticException",
		ErrorCode: 40000,
		SQLState:  "42000",
	}
	rpcErr := classifyRPCError("execute_query", "session-a", err)
	if rpcErr.Data.Category != "sql" || rpcErr.Data.SQLState != "42000" || rpcErr.Data.VendorCode != 40000 {
		t.Fatalf("unexpected Hive diagnostics: %#v", rpcErr)
	}
	if rpcErr.Data.SessionDisposition != "keep" || rpcErr.Data.OperationOutcome != "unknown" {
		t.Fatalf("unexpected SQL failure recovery hints: %#v", rpcErr)
	}
}
