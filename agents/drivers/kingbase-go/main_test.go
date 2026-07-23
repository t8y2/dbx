package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gitea.com/kingbase/gokb"
)

var registerTestDriver sync.Once
var testDriverState atomic.Pointer[fakeDriverState]
var registerExpressionFallbackDriver sync.Once
var expressionFallbackState atomic.Pointer[fallbackDriverState]
var registerModeDetectionDriver sync.Once
var modeDetectionState atomic.Pointer[modeDetectionDriverState]

type fakeDriverState struct {
	queryArgs int
	queryCtx  context.Context
	rowCount  int
}

type fakeDriver struct{}

type fakeConn struct{}

type fakeRows struct {
	current int
	count   int
}

type fallbackDriverState struct {
	mu      sync.Mutex
	queries []string
}

type fallbackDriver struct{}

type fallbackConn struct {
	state *fallbackDriverState
}

type modeDetectionDriverState struct {
	mu            sync.Mutex
	queries       []string
	databaseMode  *string
	sqlModeExists bool
	databaseErr   error
}

type modeDetectionDriver struct{}

type modeDetectionConn struct {
	state *modeDetectionDriverState
}

type valueRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (fakeDriver) Open(string) (driver.Conn, error) { return fakeConn{}, nil }

func (fakeConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (fakeConn) Close() error { return nil }

func (fakeConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (fakeConn) QueryContext(ctx context.Context, _ string, args []driver.NamedValue) (driver.Rows, error) {
	state := testDriverState.Load()
	state.queryArgs = len(args)
	state.queryCtx = ctx
	return &fakeRows{count: state.rowCount}, nil
}

func (fakeConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}

func (fakeRows) Columns() []string { return []string{"value"} }

func (fakeRows) Close() error { return nil }

func (rows *fakeRows) Next(values []driver.Value) error {
	if rows.current >= rows.count {
		return io.EOF
	}
	rows.current++
	values[0] = int64(rows.current)
	return nil
}

func (fallbackDriver) Open(string) (driver.Conn, error) {
	return &fallbackConn{state: expressionFallbackState.Load()}, nil
}

func (*fallbackConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (*fallbackConn) Close() error { return nil }

func (*fallbackConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (connection *fallbackConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	connection.state.mu.Lock()
	connection.state.queries = append(connection.state.queries, query)
	connection.state.mu.Unlock()
	if strings.Contains(query, "information_schema.table_constraints") {
		return &valueRows{columns: []string{"column_name"}}, nil
	}
	if strings.Contains(query, "CASE c.relkind") && strings.Contains(query, "obj_description(c.oid)") {
		return &valueRows{
			columns: []string{"table_name", "table_type", "table_comment"},
			rows:    [][]driver.Value{{"orders", "BASE TABLE", "orders table"}},
		}, nil
	}
	if strings.Contains(query, "SELECT obj_description(c.oid)") {
		return &valueRows{
			columns: []string{"table_comment"},
			rows:    [][]driver.Value{{"orders table"}},
		}, nil
	}
	if strings.Contains(query, "FROM information_schema.columns c") {
		return &valueRows{
			columns: []string{"column_name", "data_type", "is_nullable", "column_default", "column_comment", "numeric_precision", "numeric_scale", "character_maximum_length"},
			rows:    [][]driver.Value{{"id", "integer", "NO", nil, "primary key", int64(32), int64(0), nil}},
		}, nil
	}
	if strings.Contains(query, "sys_get_expr(") {
		return nil, &gokb.Error{Code: gokb.ErrorCode("42883"), Message: "function sys_get_expr(pg_node_tree, oid) does not exist"}
	}
	if strings.Contains(query, "pg_get_expr(") {
		return &valueRows{
			columns: []string{"column_name", "data_type", "is_nullable", "column_default", "column_comment", "numeric_precision", "numeric_scale", "character_maximum_length", "attidentity"},
			rows:    [][]driver.Value{{"id", "integer", false, nil, nil, int64(32), int64(0), nil, "d"}},
		}, nil
	}
	return nil, errors.New("unexpected query: " + query)
}

func (modeDetectionDriver) Open(string) (driver.Conn, error) {
	return &modeDetectionConn{state: modeDetectionState.Load()}, nil
}

func (*modeDetectionConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (*modeDetectionConn) Close() error { return nil }

func (*modeDetectionConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (connection *modeDetectionConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	connection.state.mu.Lock()
	connection.state.queries = append(connection.state.queries, query)
	connection.state.mu.Unlock()

	switch {
	case strings.Contains(query, "SELECT current_database()"):
		return &valueRows{
			columns: []string{"current_database", "current_user", "version", "current_schema"},
			rows:    [][]driver.Value{{"test", "system", "KingbaseES", "public"}},
		}, nil
	case strings.Contains(query, "LOWER(name) = 'database_mode'"):
		if connection.state.databaseErr != nil {
			return nil, connection.state.databaseErr
		}
		rows := [][]driver.Value{}
		if connection.state.databaseMode != nil {
			rows = append(rows, []driver.Value{*connection.state.databaseMode})
		}
		return &valueRows{columns: []string{"setting"}, rows: rows}, nil
	case strings.Contains(query, "LOWER(name) = 'sql_mode'"):
		rows := [][]driver.Value{}
		if connection.state.sqlModeExists {
			rows = append(rows, []driver.Value{int64(1)})
		}
		return &valueRows{columns: []string{"value"}, rows: rows}, nil
	default:
		return nil, errors.New("unexpected query: " + query)
	}
}

func (rows *valueRows) Columns() []string { return rows.columns }

func (*valueRows) Close() error { return nil }

func (rows *valueRows) Next(values []driver.Value) error {
	if rows.index >= len(rows.rows) {
		return io.EOF
	}
	copy(values, rows.rows[rows.index])
	rows.index++
	return nil
}

func openFakeDB(t *testing.T, rowCount int) (*sql.DB, *fakeDriverState) {
	t.Helper()
	registerTestDriver.Do(func() { sql.Register("kingbase-agent-test", fakeDriver{}) })
	state := &fakeDriverState{rowCount: rowCount}
	testDriverState.Store(state)
	db, err := sql.Open("kingbase-agent-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db, state
}

func openModeDetectionDB(t *testing.T, state *modeDetectionDriverState) *sql.DB {
	t.Helper()
	registerModeDetectionDriver.Do(func() { sql.Register("kingbase-mode-detection-test", modeDetectionDriver{}) })
	modeDetectionState.Store(state)
	db, err := sql.Open("kingbase-mode-detection-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestHandshakeAdvertisesMultiSession(t *testing.T) {
	runtime := &runtimeServer{sessions: map[string]*agentSession{}}
	result, shutdown, err := runtime.dispatch("handshake", nil)
	if err != nil || shutdown {
		t.Fatalf("handshake failed: shutdown=%v err=%v", shutdown, err)
	}
	values := result.(map[string]any)
	if values["protocolVersion"] != protocolVersion {
		t.Fatalf("unexpected protocol version: %#v", values["protocolVersion"])
	}
	capabilities := values["capabilities"].([]string)
	if !containsString(capabilities, "multi_session") || !containsString(capabilities, "paged_query") {
		t.Fatalf("missing capabilities: %v", capabilities)
	}
}

func TestBuildDSNQuotesCredentialsAndFiltersKeys(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:      "db host",
		Port:      54321,
		Database:  "test'db",
		Username:  "system",
		Password:  `p'ass\\word`,
		URLParams: "application_name=dbx&bad-key=ignored",
	})
	for _, expected := range []string{
		`host='db host'`, `dbname='test\'db'`, `password='p\'ass\\\\word'`, `application_name='dbx'`,
	} {
		if !strings.Contains(dsn, expected) {
			t.Fatalf("DSN missing %q: %s", expected, dsn)
		}
	}
	if strings.Contains(dsn, "bad-key") {
		t.Fatalf("unsafe parameter key was accepted: %s", dsn)
	}
}

func TestBuildDSNConvertsDBXJDBCURL(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:             "127.0.0.1",
		Port:             54321,
		Database:         "test",
		Username:         "system",
		Password:         "secret",
		URLParams:        "application_name=dbx",
		ConnectionString: "jdbc:kingbase8://127.0.0.1:54321/test?application_name=dbx",
	})
	if strings.HasPrefix(dsn, "jdbc:") || !strings.Contains(dsn, "host='127.0.0.1'") || !strings.Contains(dsn, "dbname='test'") {
		t.Fatalf("JDBC URL was not converted to a gokb DSN: %s", dsn)
	}
}

func TestKingbaseListIndexesQuerySupportsSQLServerMode(t *testing.T) {
	query := kingbaseListIndexesQuery("sys_catalog", "sys", "public", "orders")
	if !strings.Contains(query, "unnest(ix.indkey) WITH ORDINALITY") {
		t.Fatalf("index query should preserve index column order without array subscripts: %s", query)
	}
	if strings.Contains(query, "[pos.n]") {
		t.Fatalf("index query should not use dynamic array subscripts in SQL Server mode: %s", query)
	}
}

func TestMySQLCompatSchemaQueryKeepsUserSchemasWithSystemLikeNames(t *testing.T) {
	query := kingbaseMySQLCompatListSchemasSQL
	for _, prefix := range []string{"SYS", "XLOG"} {
		expected := "NOT LIKE '" + prefix + `\_%' ESCAPE '\'`
		if !strings.Contains(query, expected) {
			t.Fatalf("schema query must only hide the internal %s_ prefix: %s", prefix, query)
		}
		if strings.Contains(query, "NOT LIKE '"+prefix+"%'") {
			t.Fatalf("schema query must preserve user schemas such as %sLOG: %s", prefix, query)
		}
	}
}

func TestMetadataNormalizationHelpers(t *testing.T) {
	if normalizeTableType("BASE TABLE") != "TABLE" {
		t.Fatal("BASE TABLE was not normalized")
	}
	if decodeTriggerTiming(1<<6) != "INSTEAD OF" || decodeTriggerTiming(1<<1) != "BEFORE" || decodeTriggerTiming(0) != "AFTER" {
		t.Fatal("trigger timing decoding is incorrect")
	}
	length := boundedVarcharLength("character varying ( 128 )")
	if length == nil || *length != 128 {
		t.Fatalf("bounded varchar length not parsed: %v", length)
	}
	if boundedVarcharLength("text") != nil {
		t.Fatal("unbounded type returned a length")
	}
}

func TestColumnsFallbackToPgGetExprAndCacheChoice(t *testing.T) {
	registerExpressionFallbackDriver.Do(func() { sql.Register("kingbase-expression-fallback-test", fallbackDriver{}) })
	state := &fallbackDriverState{}
	expressionFallbackState.Store(state)
	db, err := sql.Open("kingbase-expression-fallback-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	server := newServer()
	server.db = db

	for call := 0; call < 2; call++ {
		columns, err := server.getColumns("public", "orders")
		if err != nil {
			t.Fatal(err)
		}
		if len(columns) != 1 || columns[0].Extra == nil || *columns[0].Extra != "GENERATED BY DEFAULT AS IDENTITY" {
			t.Fatalf("unexpected columns: %#v", columns)
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	var sysCalls, pgCalls int
	for _, query := range state.queries {
		if strings.Contains(query, "sys_get_expr(") {
			sysCalls++
		}
		if strings.Contains(query, "pg_get_expr(") {
			pgCalls++
		}
		if (strings.Contains(query, "sys_get_expr(") || strings.Contains(query, "pg_get_expr(")) &&
			!strings.Contains(query, "col_description(a.attrelid, a.attnum)") {
			t.Fatalf("catalog columns must use PostgreSQL column comments: %s", query)
		}
		if strings.Contains(query, "pg_get_expr(") && !strings.Contains(query, "a.attidentity") {
			t.Fatalf("catalog columns must include identity metadata: %s", query)
		}
	}
	if sysCalls != 1 || pgCalls != 2 {
		t.Fatalf("fallback choice was not cached: sys=%d pg=%d queries=%v", sysCalls, pgCalls, state.queries)
	}
}

func TestKingbaseIdentityClausesAreExposedAndRendered(t *testing.T) {
	tests := []struct {
		name     string
		code     string
		expected string
	}{
		{name: "always", code: "a", expected: "GENERATED ALWAYS AS IDENTITY"},
		{name: "by default", code: "d", expected: "GENERATED BY DEFAULT AS IDENTITY"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			extra := kingbaseIdentityClause(test.code)
			if extra == nil || *extra != test.expected {
				t.Fatalf("unexpected identity clause for %q: %#v", test.code, extra)
			}
			definition := columnDDLDefinition(columnInfo{Name: "id", DataType: "integer", IsNullable: false, Extra: extra})
			expected := `"id" integer ` + test.expected + " NOT NULL"
			if definition != expected {
				t.Fatalf("unexpected column DDL: %s", definition)
			}
			payload, err := json.Marshal(columnInfo{Name: "id", DataType: "integer", Extra: extra})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(payload), `"extra":"`+test.expected+`"`) {
				t.Fatalf("identity clause missing from protocol payload: %s", payload)
			}
		})
	}
}

func TestTableDDLIncludesCatalogIdentityClause(t *testing.T) {
	registerExpressionFallbackDriver.Do(func() { sql.Register("kingbase-expression-fallback-test", fallbackDriver{}) })
	expressionFallbackState.Store(&fallbackDriverState{})
	db, err := sql.Open("kingbase-expression-fallback-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	server := newServer()
	server.db = db

	ddl, err := server.getTableDDL("public", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, `"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL`) {
		t.Fatalf("identity clause missing from table DDL: %s", ddl)
	}
}

func TestColumnDDLDefinitionPreservesCompatibilityExtras(t *testing.T) {
	identity := "IDENTITY(1,1)"
	defaultValue := "0"
	if definition := columnDDLDefinition(columnInfo{Name: "id", DataType: "integer", IsNullable: false, Extra: &identity}); definition != `"id" integer IDENTITY(1,1) NOT NULL` {
		t.Fatalf("unexpected SQL Server-compatible DDL: %s", definition)
	}
	if definition := columnDDLDefinition(columnInfo{Name: "count", DataType: "integer", IsNullable: true, ColumnDefault: &defaultValue}); definition != `"count" integer DEFAULT 0` {
		t.Fatalf("unexpected regular column DDL: %s", definition)
	}
	if extra := kingbaseIdentityClause(""); extra != nil {
		t.Fatalf("non-identity column must not expose an extra clause: %#v", extra)
	}
}

func TestMySQLCompatColumnsUsePostgresColumnComments(t *testing.T) {
	registerExpressionFallbackDriver.Do(func() { sql.Register("kingbase-expression-fallback-test", fallbackDriver{}) })
	state := &fallbackDriverState{}
	expressionFallbackState.Store(state)
	db, err := sql.Open("kingbase-expression-fallback-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	server := newServer()
	server.db = db
	server.mode.mysqlCompat = true

	columns, err := server.getColumns("public", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if len(columns) != 1 || columns[0].Comment == nil || *columns[0].Comment != "primary key" {
		t.Fatalf("unexpected columns: %#v", columns)
	}
	if columns[0].Extra != nil {
		t.Fatalf("MySQL-compatible metadata must not infer PostgreSQL identity: %#v", columns[0].Extra)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 2 || !strings.Contains(state.queries[1], "col_description(a.attrelid, a.attnum)") {
		t.Fatalf("MySQL-compatible columns must use PostgreSQL column comments: %v", state.queries)
	}
}

func TestAllCompatibilityModesUsePostgresTableComments(t *testing.T) {
	registerExpressionFallbackDriver.Do(func() { sql.Register("kingbase-expression-fallback-test", fallbackDriver{}) })
	state := &fallbackDriverState{}
	expressionFallbackState.Store(state)
	db, err := sql.Open("kingbase-expression-fallback-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	server := newServer()
	server.db = db
	for _, mysqlCompat := range []bool{false, true} {
		state.mu.Lock()
		state.queries = nil
		state.mu.Unlock()
		server.mode.mysqlCompat = mysqlCompat

		tables, err := server.listTables("public", metadataListConstraints{})
		if err != nil {
			t.Fatal(err)
		}
		if len(tables) != 1 || tables[0].Comment == nil || *tables[0].Comment != "orders table" {
			t.Fatalf("mysqlCompat=%v: unexpected tables: %#v", mysqlCompat, tables)
		}

		state.mu.Lock()
		queries := append([]string(nil), state.queries...)
		state.mu.Unlock()
		if len(queries) != 1 || !strings.Contains(queries[0], "obj_description(c.oid)") ||
			!strings.Contains(queries[0], "FROM sys_catalog.sys_class c") {
			t.Fatalf("mysqlCompat=%v: table comments must share the PostgreSQL-compatible query: %v", mysqlCompat, queries)
		}
	}
}

func TestGetTableCommentUsesPostgresCatalogComment(t *testing.T) {
	registerExpressionFallbackDriver.Do(func() { sql.Register("kingbase-expression-fallback-test", fallbackDriver{}) })
	state := &fallbackDriverState{}
	expressionFallbackState.Store(state)
	db, err := sql.Open("kingbase-expression-fallback-test", "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	server := newServer()
	server.db = db
	server.mode.mysqlCompat = true

	comment, err := server.getTableComment("public", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if comment == nil || *comment != "orders table" {
		t.Fatalf("unexpected table comment: %#v", comment)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 1 || !strings.Contains(state.queries[0], "FROM sys_catalog.sys_class c") ||
		!strings.Contains(state.queries[0], "n.nspname = 'public'") || !strings.Contains(state.queries[0], "c.relname = 'orders'") {
		t.Fatalf("table comment must use the PostgreSQL-compatible catalog query: %v", state.queries)
	}
}

func TestDetectMySQLCompatModePrefersDatabaseModeOverSQLModePresence(t *testing.T) {
	oracle := "oracle"
	state := &modeDetectionDriverState{
		databaseMode:  &oracle,
		sqlModeExists: true,
	}
	db := openModeDetectionDB(t, state)

	if detectMySQLCompatMode(db) {
		t.Fatal("oracle-compatible server with sql_mode should not be treated as MySQL-compatible")
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 1 || !strings.Contains(state.queries[0], "database_mode") {
		t.Fatalf("database_mode should be authoritative when present: %v", state.queries)
	}
}

func TestConnectionInfoReportsCompatibilityIdentifierQuote(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		mysqlCompat bool
		expected    string
	}{
		{name: "postgres compatible", expected: `"`},
		{name: "mysql compatible", mysqlCompat: true, expected: "`"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			db := openModeDetectionDB(t, &modeDetectionDriverState{})
			server := newServer()
			server.db = db
			server.mode.mysqlCompat = testCase.mysqlCompat

			info, err := server.connectionInfo()
			if err != nil {
				t.Fatal(err)
			}
			if info["identifierQuote"] != testCase.expected {
				t.Fatalf("unexpected identifier quote: %#v", info["identifierQuote"])
			}
		})
	}
}

func TestDetectMySQLCompatModeFallsBackToSQLModeWhenDatabaseModeMissing(t *testing.T) {
	state := &modeDetectionDriverState{sqlModeExists: true}
	db := openModeDetectionDB(t, state)

	if !detectMySQLCompatMode(db) {
		t.Fatal("legacy server with sql_mode but no database_mode should still use MySQL compatibility")
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 2 {
		t.Fatalf("expected database_mode probe followed by sql_mode fallback, got: %v", state.queries)
	}
}

func TestQuoteLiteralEscapesMetadataValues(t *testing.T) {
	if got := quoteLiteral("a'b"); got != "'a''b'" {
		t.Fatalf("unexpected literal: %s", got)
	}
	constraints := metadataListConstraints{Filter: "CHILD", ObjectTypes: []string{"table"}}
	if !constraintsMatch(constraints, "dbx_child", "TABLE") || constraintsMatch(constraints, "dbx_parent", "TABLE") {
		t.Fatal("metadata constraints were not applied")
	}
}

func TestCompletionNameMatching(t *testing.T) {
	request := completionAssistantRequest{Mask: "DBX_", MatchMode: "prefix"}
	if !completionNameMatches("dbx_child", request) || completionNameMatches("other_dbx_child", request) {
		t.Fatal("case-insensitive prefix matching failed")
	}
	request.MatchMode = "contains"
	if !completionNameMatches("other_dbx_child", request) {
		t.Fatal("contains matching failed")
	}
}

func TestExecuteQueryUsesSimpleProtocolAndReleasesContext(t *testing.T) {
	db, state := openFakeDB(t, 1)
	server := newServer()
	server.db = db
	result, err := server.executeQuery(queryOptions{SQL: "SELECT 1", MaxRows: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || state.queryArgs != 0 {
		t.Fatalf("unexpected result or bound arguments: rows=%v args=%d", result.Rows, state.queryArgs)
	}
	assertContextCanceled(t, state.queryCtx)
}

func TestPagedQueryKeepsContextUntilSessionCloses(t *testing.T) {
	db, state := openFakeDB(t, 3)
	server := newServer()
	server.db = db
	result, err := server.executeQueryPage(queryOptions{SQL: "SELECT value", MaxRows: 10}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !result.HasMore || result.SessionID == nil {
		t.Fatalf("expected an open query session: %#v", result)
	}
	select {
	case <-state.queryCtx.Done():
		t.Fatal("paged query context was canceled before session close")
	default:
	}
	if !server.closeQuerySession(*result.SessionID) {
		t.Fatal("query session was not closed")
	}
	assertContextCanceled(t, state.queryCtx)
}

func TestRuntimeCloseSessionWaitsForActiveRequestAndClosesTarget(t *testing.T) {
	db, _ := openFakeDB(t, 0)
	target := &agentSession{server: newServer()}
	target.server.db = db
	other := &agentSession{server: newServer()}
	runtime := &runtimeServer{sessions: map[string]*agentSession{"target": target, "other": other}}

	target.mu.Lock()
	closed := make(chan error, 1)
	go func() { closed <- runtime.closeSession("target") }()
	time.Sleep(20 * time.Millisecond)
	select {
	case err := <-closed:
		t.Fatalf("close_session returned before the active request completed: %v", err)
	default:
	}
	if _, err := runtime.session("target"); err == nil {
		t.Fatal("draining session remained available for new requests")
	}
	if _, err := runtime.session("other"); err != nil {
		t.Fatalf("unrelated session was removed: %v", err)
	}

	target.mu.Unlock()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("close_session did not finish after the active request released the session")
	}
	if target.server.db != nil {
		t.Fatal("target database connection was not closed")
	}
}

func assertContextCanceled(t *testing.T, ctx context.Context) {
	t.Helper()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("query context was not canceled")
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
